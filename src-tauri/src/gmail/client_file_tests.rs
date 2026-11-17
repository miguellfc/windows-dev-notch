//! Port of 0.1.0's `gmail-client-file.test.ts` (8 cases: 4 `it` blocks plus the 4 rows
//! of the `it.each`, each its own test) against a fake dialog and fake files. Plus the Rust-only
//! cases: the real file reader's cap, the dev/E2E override switch and the fixed picker.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::json;

use super::*;
use crate::ipc::IpcErrorCode;

fn valid() -> String {
    json!({ "installed": { "client_id": "id.apps.googleusercontent.com", "client_secret": "GOCSPX-test" } })
        .to_string()
}

/// `showOpenDialog`: answers the configured choice and records the filters it was asked for.
struct FakeDialog {
    choice: Option<PathBuf>,
    asked: Mutex<Vec<FileFilter>>,
}

impl FilePicker for FakeDialog {
    fn pick_file(&self, filter: FileFilter) -> BoxFuture<'_, Option<PathBuf>> {
        self.asked.lock().unwrap().push(filter);
        let choice = self.choice.clone();
        Box::pin(async move { choice })
    }
}

/// `stat` and `readFile`, recording each call.
struct FakeFiles {
    size: Option<u64>,
    content: Vec<u8>,
    sizes: Mutex<Vec<PathBuf>>,
    reads: Mutex<Vec<PathBuf>>,
}

impl ClientFileSource for FakeFiles {
    fn size(&self, path: &Path) -> io::Result<u64> {
        self.sizes.lock().unwrap().push(path.to_owned());
        self.size
            .ok_or_else(|| io::Error::from(io::ErrorKind::PermissionDenied))
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        self.reads.lock().unwrap().push(path.to_owned());
        Ok(self.content.clone())
    }
}

#[derive(Default)]
struct Options {
    canceled: bool,
    size: Option<u64>,
    unreadable: bool,
    content: Option<Vec<u8>>,
}

struct Harness {
    dialog: Arc<FakeDialog>,
    files: Arc<FakeFiles>,
    picker: ClientFilePicker,
}

fn setup(options: Options) -> Harness {
    let content = options.content.unwrap_or_else(|| valid().into_bytes());
    let dialog = Arc::new(FakeDialog {
        choice: (!options.canceled).then(|| PathBuf::from("/x/client.json")),
        asked: Mutex::new(Vec::new()),
    });
    let files = Arc::new(FakeFiles {
        size: if options.unreadable {
            None
        } else {
            Some(options.size.unwrap_or(content.len() as u64))
        },
        content,
        sizes: Mutex::new(Vec::new()),
        reads: Mutex::new(Vec::new()),
    });
    let picker = ClientFilePicker::new(
        Arc::clone(&dialog) as Arc<dyn FilePicker>,
        Arc::clone(&files) as Arc<dyn ClientFileSource>,
    );
    Harness {
        dialog,
        files,
        picker,
    }
}

impl Harness {
    async fn pick(&self) -> Result<Option<GmailClientFile>, ExposedError> {
        self.picker.pick_client_file().await
    }

    fn reads(&self) -> usize {
        self.files.reads.lock().unwrap().len()
    }
}

/// INVALID_INPUT with the fixed message, which never quotes the file.
fn assert_invalid(result: Result<Option<GmailClientFile>, ExposedError>) {
    let error = result.expect_err("refused");
    assert_eq!(error.code(), IpcErrorCode::InvalidInput);
    assert_eq!(error.message(), "Not a Google desktop client file");
    assert!(!error.message().contains("GOCSPX"));
    assert!(!error.message().contains("client_secret"));
}

// ---------------------------------------------------------------------------------------------
// gmail client file picker

#[tokio::test]
async fn asks_for_a_single_json_file() {
    let t = setup(Options::default());
    t.pick().await.unwrap();
    // One file (the picker answers a single path or none) through the JSON filter.
    assert_eq!(
        *t.dialog.asked.lock().unwrap(),
        [FileFilter {
            name: "JSON",
            extensions: &["json"]
        }]
    );
}

#[tokio::test]
async fn returns_the_credentials_of_a_desktop_client_file() {
    let t = setup(Options::default());
    let client = t.pick().await.unwrap().expect("credentials");
    assert_eq!(client.client_id, "id.apps.googleusercontent.com");
    assert_eq!(client.client_secret, "GOCSPX-test");
    assert_eq!(
        *t.files.reads.lock().unwrap(),
        [PathBuf::from("/x/client.json")]
    );
}

#[tokio::test]
async fn returns_null_on_cancel_without_reading_anything() {
    // `{ canceled: true }` and `{ filePaths: [] }` are one case here: the dialog answers no path.
    let t = setup(Options {
        canceled: true,
        ..Options::default()
    });
    assert_eq!(t.pick().await.unwrap(), None);
    assert_eq!(t.reads(), 0);
    assert!(t.files.sizes.lock().unwrap().is_empty());
}

#[tokio::test]
async fn rejects_not_json_with_invalid_input_never_echoing_the_content() {
    let t = setup(Options {
        content: Some(b"nope {".to_vec()),
        ..Options::default()
    });
    assert_invalid(t.pick().await);
}

#[tokio::test]
async fn rejects_a_web_client_with_invalid_input_never_echoing_the_content() {
    let t = setup(Options {
        content: Some(
            json!({ "web": { "client_id": "a", "client_secret": "b" } })
                .to_string()
                .into_bytes(),
        ),
        ..Options::default()
    });
    assert_invalid(t.pick().await);
}

#[tokio::test]
async fn rejects_too_big_with_invalid_input_never_echoing_the_content() {
    let t = setup(Options {
        size: Some(CLIENT_FILE_MAX_BYTES + 1),
        ..Options::default()
    });
    assert_invalid(t.pick().await);
    // Refused on its size alone: never read.
    assert_eq!(t.reads(), 0);
}

#[tokio::test]
async fn rejects_an_oversize_secret_with_invalid_input_never_echoing_the_content() {
    let secret = format!("GOCSPX-{}", "x".repeat(300));
    let t = setup(Options {
        content: Some(
            json!({ "installed": { "client_id": "a", "client_secret": secret } })
                .to_string()
                .into_bytes(),
        ),
        ..Options::default()
    });
    assert_invalid(t.pick().await);
}

#[tokio::test]
async fn treats_an_unreadable_file_as_invalid_too() {
    let t = setup(Options {
        unreadable: true,
        ..Options::default()
    });
    assert_invalid(t.pick().await);
    assert_eq!(t.reads(), 0);
}

// ---------------------------------------------------------------------------------------------
// Rust additions

#[tokio::test]
async fn reads_as_lossy_utf8_and_refuses_a_bom_like_json_parse() {
    // `readFile(path, 'utf8')` keeps a BOM, which `JSON.parse` refuses.
    let mut bom = vec![0xEF, 0xBB, 0xBF];
    bom.extend_from_slice(valid().as_bytes());
    assert_invalid(
        setup(Options {
            content: Some(bom),
            ..Options::default()
        })
        .pick()
        .await,
    );
    // A byte that is not UTF-8 becomes U+FFFD, as Node decodes it.
    let mut lossy = br#"{"installed":{"client_id":"a"#.to_vec();
    lossy.push(0xFF);
    lossy.extend_from_slice(br#"","client_secret":"s"}}"#);
    let client = setup(Options {
        content: Some(lossy),
        ..Options::default()
    })
    .pick()
    .await
    .unwrap()
    .unwrap();
    assert_eq!(client.client_id, "a\u{FFFD}");
}

#[tokio::test]
async fn the_cap_is_inclusive() {
    let t = setup(Options {
        size: Some(CLIENT_FILE_MAX_BYTES),
        ..Options::default()
    });
    assert!(t.pick().await.unwrap().is_some());
}

/// A scratch file under the system temp folder, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str, content: &[u8]) -> Self {
        let path = std::env::temp_dir().join(format!(
            "notch-gmail-client-file-{}-{name}",
            std::process::id()
        ));
        std::fs::write(&path, content).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[test]
fn disk_files_report_the_size_and_never_read_past_the_cap() {
    let small = Scratch::new("small.json", valid().as_bytes());
    assert_eq!(DiskFiles.size(&small.0).unwrap(), valid().len() as u64);
    assert_eq!(DiskFiles.read(&small.0).unwrap(), valid().into_bytes());
    // A file that grew past the cap after its size was read is refused, not read whole.
    let big = Scratch::new("big.json", &vec![b' '; 3 * 64 * 1024]);
    assert!(DiskFiles.read(&big.0).is_err());
    let exact = Scratch::new("exact.json", &vec![b' '; 64 * 1024]);
    assert_eq!(DiskFiles.read(&exact.0).unwrap().len(), 64 * 1024);
    assert!(DiskFiles.size(Path::new("Z:/no/such/client.json")).is_err());
}

#[tokio::test]
async fn a_real_file_through_the_disk_reader() {
    let file = Scratch::new("real.json", valid().as_bytes());
    let picker = ClientFilePicker::new(
        Arc::new(FixedPicker(PickerOverride::Path(file.0.clone()))),
        Arc::new(DiskFiles),
    );
    let client = picker.pick_client_file().await.unwrap().unwrap();
    assert_eq!(client.client_id, "id.apps.googleusercontent.com");
    // Never copied: the file is still the only one, unchanged.
    assert_eq!(std::fs::read(&file.0).unwrap(), valid().into_bytes());
}

#[test]
fn the_override_needs_dev_overrides_and_an_explicit_value() {
    let path = OsStr::new("C:/tmp/client.json");
    assert_eq!(picker_override_from(false, Some(path)), None);
    assert_eq!(picker_override_from(true, None), None);
    assert_eq!(
        picker_override_from(true, Some(path)),
        Some(PickerOverride::Path(PathBuf::from("C:/tmp/client.json")))
    );
    // Empty: the dialog answers "cancelled".
    assert_eq!(
        picker_override_from(true, Some(OsStr::new(""))),
        Some(PickerOverride::Cancel)
    );
    assert_eq!(CLIENT_FILE_ENV, "NOTCH_GMAIL_CLIENT_FILE");
}

#[tokio::test]
async fn the_fixed_picker_answers_without_a_dialog() {
    let path = PathBuf::from("C:/tmp/client.json");
    assert_eq!(
        FixedPicker(PickerOverride::Path(path.clone()))
            .pick_file(JSON_FILTER)
            .await,
        Some(path)
    );
    assert_eq!(
        FixedPicker(PickerOverride::Cancel)
            .pick_file(JSON_FILTER)
            .await,
        None
    );
}

#[test]
fn reuses_the_contract_parser() {
    let parsed = parse_client_file(&serde_json::from_str(&valid()).unwrap()).unwrap();
    assert_eq!(parsed.client_secret, "GOCSPX-test");
    assert!(parse_client_file(&json!({ "installed": ["a", "b"] })).is_none());
}

#[test]
fn the_dialog_offers_json_files_only() {
    let spec: Vec<u16> = filter_spec(JSON_FILTER);
    assert_eq!(
        String::from_utf16(&spec).unwrap(),
        "JSON (*.json)\0*.json\0\0"
    );
}
