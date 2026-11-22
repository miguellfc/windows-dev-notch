//! The pure parts of the account folder picker: the wide-string conversions, the dev/E2E switch
//! and its fixed answers. The native dialog is modal, so no test opens it.

use std::ffi::{OsStr, OsString};

use super::*;

#[test]
fn a_path_is_read_up_to_its_nul() {
    let buffer: Vec<u16> = "C:\\Users\\ana\\.claude-work\0junk"
        .encode_utf16()
        .collect();
    assert_eq!(
        path_from_wide(&buffer),
        Some(PathBuf::from("C:\\Users\\ana\\.claude-work"))
    );
}

#[test]
fn an_empty_or_unterminated_buffer_is_read_as_such() {
    assert_eq!(path_from_wide(&[0, 0]), None);
    assert_eq!(path_from_wide(&[]), None);
    let unterminated: Vec<u16> = "D:\\x".encode_utf16().collect();
    assert_eq!(path_from_wide(&unterminated), Some(PathBuf::from("D:\\x")));
}

#[test]
fn non_ascii_paths_survive_the_round_trip() {
    let wide = wide(OsStr::new("C:\\Usuarios\\Ñandú\\.claude"));
    assert_eq!(wide.last(), Some(&0));
    assert_eq!(
        path_from_wide(&wide),
        Some(PathBuf::from("C:\\Usuarios\\Ñandú\\.claude"))
    );
}

#[test]
fn the_switch_is_ignored_without_dev_overrides() {
    let raw = OsString::from("C:\\x");
    assert_eq!(picker_override_from(false, Some(raw.as_os_str())), None);
}

#[test]
fn the_switch_answers_a_path_or_cancel() {
    let raw = OsString::from("C:\\Profiles\\Claude");
    assert_eq!(
        picker_override_from(true, Some(raw.as_os_str())),
        Some(PickerOverride::Path(PathBuf::from("C:\\Profiles\\Claude")))
    );
    assert_eq!(
        picker_override_from(true, Some(OsStr::new(""))),
        Some(PickerOverride::Cancel)
    );
    assert_eq!(picker_override_from(true, None), None);
}

#[tokio::test]
async fn the_fixed_dialog_answers_without_showing_anything() {
    let path = PathBuf::from("C:\\Profiles\\Claude");
    assert_eq!(
        FixedFolder(PickerOverride::Path(path.clone()))
            .pick_folder()
            .await,
        Some(path)
    );
    assert_eq!(
        FixedFolder(PickerOverride::Cancel).pick_folder().await,
        None
    );
}
