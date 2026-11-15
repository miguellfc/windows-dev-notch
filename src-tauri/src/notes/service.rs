//! Notes rules (`src/main/notes/notes-service.ts` and `sortNotes` from
//! `src/shared/notes/search.ts`): create, edit, pin, delete with a 10 s in-memory undo, and the
//! list order. Every mutation runs as one exclusive turn (snapshot, compute, validate, write), so
//! concurrent calls never build on a stale list. Never logs note text.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use chrono::{DateTime, SecondsFormat};

use crate::contract::notes::{
    Note, NoteText, NotesFile, INVALID_NOTE_MESSAGE, INVALID_NOTE_TEXT_MESSAGE, NOTES_MAX,
    NOTE_LIMIT_MESSAGE, NOTE_NOT_FOUND_MESSAGE,
};
use crate::contract::Validate;
use crate::ipc::{BoxFuture, ExposedError, IpcErrorCode};
use crate::services::clock::WallClock;
use crate::services::json_store::JsonStore;

/// How long a deleted note stays restorable.
pub const RESTORE_WINDOW_MS: i64 = 10_000;

/// What the service needs from the notes file (`Pick<NotesStore, 'all' | 'write'>`).
pub trait NoteStore: Send + Sync {
    /// The notes as last loaded or saved.
    fn all(&self) -> Vec<Note>;
    /// Saves `next` (after any write already queued) and makes it the current list.
    fn write(&self, next: Vec<Note>) -> BoxFuture<'_, Result<(), ExposedError>>;
}

impl NoteStore for JsonStore<NotesFile> {
    fn all(&self) -> Vec<Note> {
        self.get().notes
    }

    fn write(&self, next: Vec<Note>) -> BoxFuture<'_, Result<(), ExposedError>> {
        Box::pin(JsonStore::write(self, NotesFile::new(next)))
    }
}

fn invalid(message: &str) -> ExposedError {
    ExposedError::new(IpcErrorCode::InvalidInput, message)
}

fn not_found() -> ExposedError {
    ExposedError::new(IpcErrorCode::NotFound, NOTE_NOT_FOUND_MESSAGE)
}

fn parse_text(text: &str) -> Result<NoteText, ExposedError> {
    NoteText::new(text).map_err(|_| invalid(INVALID_NOTE_TEXT_MESSAGE))
}

/// `Date#getTime()` of an ISO timestamp; `None` (NaN) never decides an order.
fn time(iso: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .map(|at| at.timestamp_millis())
}

/// Newest first; a timestamp that does not parse compares equal (`NaN || next` in the TS).
fn newest_first(a: &str, b: &str) -> Ordering {
    match (time(a), time(b)) {
        (Some(a), Some(b)) => b.cmp(&a),
        _ => Ordering::Equal,
    }
}

/// `sortNotes`: pinned first, then most recently updated, then newest created, then id, so the
/// order never depends on the input order. Returns a new list.
pub fn sort_notes(notes: &[Note]) -> Vec<Note> {
    let mut sorted = notes.to_vec();
    sorted.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| newest_first(&a.updated_at, &b.updated_at))
            .then_with(|| newest_first(&a.created_at, &b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    sorted
}

/// What a mutation does to the restore buffer once its write succeeded.
enum AfterWrite {
    Nothing,
    Deleted(Note),
    Restored(String),
}

struct Plan {
    next: Vec<Note>,
    changed: Vec<String>,
    result: Option<Note>,
    after: AfterWrite,
}

impl Plan {
    fn replace(all: &[Note], updated: Note) -> Self {
        let id = updated.id.clone();
        let next = all
            .iter()
            .map(|note| {
                if note.id == id {
                    updated.clone()
                } else {
                    note.clone()
                }
            })
            .collect();
        Self {
            next,
            changed: vec![id],
            result: None,
            after: AfterWrite::Nothing,
        }
    }
}

struct Deleted {
    note: Note,
    deleted_at: i64,
}

pub struct NotesService {
    store: Arc<dyn NoteStore>,
    clock: Arc<WallClock>,
    new_id: Box<dyn Fn() -> String + Send + Sync>,
    /// Told after every saved mutation; a panic here never fails the mutation.
    on_change: Box<dyn Fn() + Send + Sync>,
    /// One mutation at a time, in call order (tokio's mutex is FIFO).
    chain: tokio::sync::Mutex<()>,
    deleted: Mutex<HashMap<String, Deleted>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn find_in<'a>(all: &'a [Note], id: &str) -> Result<&'a Note, ExposedError> {
    all.iter().find(|note| note.id == id).ok_or_else(not_found)
}

impl NotesService {
    pub fn new(
        store: Arc<dyn NoteStore>,
        clock: Arc<WallClock>,
        new_id: Box<dyn Fn() -> String + Send + Sync>,
        on_change: Box<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            store,
            clock,
            new_id,
            on_change,
            chain: tokio::sync::Mutex::new(()),
            deleted: Mutex::new(HashMap::new()),
        }
    }

    fn now_ms(&self) -> i64 {
        self.clock.now().timestamp_millis()
    }

    /// `toISOString()`: milliseconds and `Z`.
    fn now_iso(&self) -> String {
        self.clock
            .now()
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    /// Drops deleted entries older than the restore window.
    fn prune(&self) {
        let cutoff = self.now_ms() - RESTORE_WINDOW_MS;
        lock(&self.deleted).retain(|_, entry| entry.deleted_at >= cutoff);
    }

    /// Runs one mutation as an exclusive unit. Every touched note passes `noteSchema`; the
    /// restore buffer changes only once the write succeeded. A failed mutation never blocks the
    /// ones queued after it.
    async fn mutate(
        &self,
        plan: impl FnOnce(&[Note]) -> Result<Plan, ExposedError>,
    ) -> Result<Note, ExposedError> {
        let _turn = self.chain.lock().await;
        self.prune();
        let planned = plan(&self.store.all())?;
        for note in &planned.next {
            if planned.changed.contains(&note.id) && note.validate().is_err() {
                return Err(invalid(INVALID_NOTE_MESSAGE));
            }
        }
        let result = planned.result.clone().or_else(|| {
            planned
                .next
                .iter()
                .find(|note| planned.changed.contains(&note.id))
                .cloned()
        });
        self.store.write(planned.next).await?;
        match planned.after {
            AfterWrite::Nothing => {}
            AfterWrite::Deleted(note) => {
                let deleted_at = self.now_ms();
                lock(&self.deleted).insert(note.id.clone(), Deleted { note, deleted_at });
            }
            AfterWrite::Restored(id) => {
                lock(&self.deleted).remove(&id);
            }
        }
        // The note is saved: a failing listener must not turn that into an error.
        if catch_unwind(AssertUnwindSafe(|| (self.on_change)())).is_err() {
            // No detail: the snapshot that failed to go out carries note text.
            log::warn!("Notes change listener failed");
        }
        result.ok_or_else(|| ExposedError::internal("mutation touched no note"))
    }

    /// Pinned first, then most recently updated.
    pub fn list(&self) -> Vec<Note> {
        sort_notes(&self.store.all())
    }

    pub async fn create(&self, text: &str) -> Result<Note, ExposedError> {
        let clean = parse_text(text)?;
        self.mutate(|all| {
            if all.len() >= NOTES_MAX {
                return Err(invalid(NOTE_LIMIT_MESSAGE));
            }
            let at = self.now_iso();
            let fresh = Note {
                id: (self.new_id)(),
                text: clean,
                pinned: false,
                created_at: at.clone(),
                updated_at: at,
            };
            let mut next = all.to_vec();
            next.push(fresh.clone());
            Ok(Plan {
                next,
                changed: vec![fresh.id],
                result: None,
                after: AfterWrite::Nothing,
            })
        })
        .await
    }

    pub async fn update(&self, id: &str, text: &str) -> Result<Note, ExposedError> {
        let clean = parse_text(text)?;
        self.mutate(|all| {
            let current = find_in(all, id)?;
            let updated = Note {
                text: clean,
                updated_at: self.now_iso(),
                ..current.clone()
            };
            Ok(Plan::replace(all, updated))
        })
        .await
    }

    /// Pinning never touches `updatedAt`.
    pub async fn set_pinned(&self, id: &str, pinned: bool) -> Result<Note, ExposedError> {
        self.mutate(|all| {
            let updated = Note {
                pinned,
                ..find_in(all, id)?.clone()
            };
            Ok(Plan::replace(all, updated))
        })
        .await
    }

    /// Removes a note and keeps it restorable for [`RESTORE_WINDOW_MS`]; returns a copy of it.
    pub async fn remove(&self, id: &str) -> Result<Note, ExposedError> {
        self.mutate(|all| {
            let current = find_in(all, id)?.clone();
            Ok(Plan {
                next: all.iter().filter(|note| note.id != id).cloned().collect(),
                changed: Vec::new(),
                result: Some(current.clone()),
                after: AfterWrite::Deleted(current),
            })
        })
        .await
    }

    /// Puts back a note deleted less than [`RESTORE_WINDOW_MS`] ago, unchanged (same id and
    /// dates).
    pub async fn restore(&self, id: &str) -> Result<Note, ExposedError> {
        self.mutate(|all| {
            let note = {
                let deleted = lock(&self.deleted);
                let entry = deleted.get(id).ok_or_else(not_found)?;
                if self.now_ms() - entry.deleted_at > RESTORE_WINDOW_MS {
                    return Err(not_found());
                }
                entry.note.clone()
            };
            if all.iter().any(|existing| existing.id == id) {
                return Err(not_found());
            }
            if all.len() >= NOTES_MAX {
                return Err(invalid(NOTE_LIMIT_MESSAGE));
            }
            let mut next = all.to_vec();
            next.push(note);
            Ok(Plan {
                next,
                changed: vec![id.to_owned()],
                result: None,
                after: AfterWrite::Restored(id.to_owned()),
            })
        })
        .await
    }

    /// Current text of a note (for the clipboard); NOT_FOUND when it does not exist.
    pub fn text(&self, id: &str) -> Result<String, ExposedError> {
        let all = self.store.all();
        find_in(&all, id).map(|note| note.text.as_str().to_owned())
    }

    /// Settles once every mutation queued so far has finished (saved or failed).
    pub async fn idle(&self) {
        drop(self.chain.lock().await);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering as AtomicOrdering};
    use std::time::Duration;

    use chrono::{TimeZone, Utc};
    use tauri::async_runtime::block_on;
    use tokio::sync::oneshot;

    use super::*;

    fn uuid(n: usize) -> String {
        format!("00000000-0000-4000-8000-{n:012}")
    }

    fn t0() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 11, 12, 0, 0).unwrap()
    }

    fn iso(at: DateTime<Utc>) -> String {
        at.to_rfc3339_opts(SecondsFormat::Millis, true)
    }

    fn text(value: &str) -> NoteText {
        NoteText::new(value).unwrap()
    }

    fn note(n: usize) -> Note {
        Note {
            id: uuid(n),
            text: text(&format!("n{n}")),
            pinned: false,
            created_at: "2026-11-01T09:00:00.000Z".into(),
            updated_at: "2026-11-02T09:00:00.000Z".into(),
        }
    }

    enum WriteStep {
        Fail,
        Gate(oneshot::Receiver<()>),
    }

    #[derive(Default)]
    struct FakeStore {
        items: Mutex<Vec<Note>>,
        writes: AtomicUsize,
        steps: Mutex<VecDeque<WriteStep>>,
    }

    impl NoteStore for FakeStore {
        fn all(&self) -> Vec<Note> {
            lock(&self.items).clone()
        }

        fn write(&self, next: Vec<Note>) -> BoxFuture<'_, Result<(), ExposedError>> {
            Box::pin(async move {
                self.writes.fetch_add(1, AtomicOrdering::SeqCst);
                let step = lock(&self.steps).pop_front();
                match step {
                    Some(WriteStep::Fail) => return Err(ExposedError::internal("EIO")),
                    Some(WriteStep::Gate(gate)) => {
                        let _ = gate.await;
                    }
                    None => {}
                }
                *lock(&self.items) = next;
                Ok(())
            })
        }
    }

    struct Fx {
        service: Arc<NotesService>,
        store: Arc<FakeStore>,
        clock: Arc<WallClock>,
        changes: Arc<AtomicUsize>,
        listener_panics: Arc<AtomicBool>,
    }

    impl Fx {
        fn new() -> Self {
            let store = Arc::new(FakeStore::default());
            let clock = Arc::new(WallClock::fixed(t0()));
            let changes = Arc::new(AtomicUsize::new(0));
            let listener_panics = Arc::new(AtomicBool::new(false));
            let seq = AtomicUsize::new(0);
            let service = {
                let changes = Arc::clone(&changes);
                let listener_panics = Arc::clone(&listener_panics);
                NotesService::new(
                    Arc::clone(&store) as Arc<dyn NoteStore>,
                    Arc::clone(&clock),
                    Box::new(move || uuid(seq.fetch_add(1, AtomicOrdering::SeqCst) + 1)),
                    Box::new(move || {
                        changes.fetch_add(1, AtomicOrdering::SeqCst);
                        if listener_panics.load(AtomicOrdering::SeqCst) {
                            panic!("listener broke");
                        }
                    }),
                )
            };
            Self {
                service: Arc::new(service),
                store,
                clock,
                changes,
                listener_panics,
            }
        }

        fn seed(&self, notes: Vec<Note>) {
            *lock(&self.store.items) = notes;
        }

        fn items(&self) -> Vec<Note> {
            self.store.all()
        }

        fn writes(&self) -> usize {
            self.store.writes.load(AtomicOrdering::SeqCst)
        }

        fn changes(&self) -> usize {
            self.changes.load(AtomicOrdering::SeqCst)
        }

        fn step(&self, step: WriteStep) {
            lock(&self.store.steps).push_back(step);
        }

        fn advance(&self, ms: i64) {
            self.clock.advance(ms);
        }
    }

    fn code<T: std::fmt::Debug>(result: Result<T, ExposedError>) -> IpcErrorCode {
        result.unwrap_err().code()
    }

    #[test]
    fn creates_a_trimmed_note_with_id_dates_and_unpinned() {
        let fx = Fx::new();
        let created = block_on(fx.service.create("  hello\nworld  ")).unwrap();
        assert_eq!(
            created,
            Note {
                id: uuid(1),
                text: text("hello\nworld"),
                pinned: false,
                created_at: iso(t0()),
                updated_at: iso(t0()),
            }
        );
        assert_eq!(created.created_at, "2026-11-11T12:00:00.000Z");
        assert_eq!(fx.items(), [created]);
        assert_eq!(fx.changes(), 1);
    }

    #[test]
    fn rejects_invalid_text_with_invalid_input_and_writes_nothing() {
        let fx = Fx::new();
        for bad in ["   ".to_owned(), "a".repeat(2001)] {
            let error = block_on(fx.service.create(&bad)).unwrap_err();
            assert_eq!(error.code(), IpcErrorCode::InvalidInput);
            assert_eq!(error.message(), "Invalid note text");
        }
        assert_eq!(fx.writes(), 0);
    }

    #[test]
    fn rejects_the_501st_note_with_invalid_input() {
        let fx = Fx::new();
        fx.seed((1..=NOTES_MAX).map(note).collect());
        let error = block_on(fx.service.create("one more")).unwrap_err();
        assert_eq!(error.code(), IpcErrorCode::InvalidInput);
        assert_eq!(error.message(), "Note limit reached (500)");
    }

    #[test]
    fn list_returns_pinned_first_then_by_updated_at_desc() {
        let fx = Fx::new();
        fx.seed(vec![
            Note {
                updated_at: "2026-11-03T00:00:00.000Z".into(),
                ..note(1)
            },
            Note {
                updated_at: "2026-11-05T00:00:00.000Z".into(),
                ..note(2)
            },
            Note {
                pinned: true,
                updated_at: "2026-11-01T00:00:00.000Z".into(),
                ..note(3)
            },
        ]);
        let ids: Vec<String> = fx.service.list().into_iter().map(|n| n.id).collect();
        assert_eq!(ids, [uuid(3), uuid(2), uuid(1)]);
    }

    #[test]
    fn sort_falls_back_to_created_at_then_id() {
        let same = |n: usize, created: &str| Note {
            created_at: created.into(),
            ..note(n)
        };
        let sorted = sort_notes(&[
            same(3, "2026-11-01T09:00:00.000Z"),
            same(2, "2026-11-01T09:00:00.000Z"),
            same(1, "2026-11-01T08:00:00.000Z"),
            same(4, "2026-11-01T10:00:00.000Z"),
        ]);
        let ids: Vec<String> = sorted.into_iter().map(|n| n.id).collect();
        assert_eq!(ids, [uuid(4), uuid(2), uuid(3), uuid(1)]);
    }

    #[test]
    fn update_changes_text_and_updated_at_keeps_created_at_and_pinned() {
        let fx = Fx::new();
        fx.seed(vec![Note {
            pinned: true,
            ..note(1)
        }]);
        fx.advance(5000);
        let updated = block_on(fx.service.update(&uuid(1), "  new text ")).unwrap();
        assert_eq!(
            updated,
            Note {
                pinned: true,
                text: text("new text"),
                updated_at: iso(t0() + chrono::Duration::milliseconds(5000)),
                ..note(1)
            }
        );
    }

    #[test]
    fn update_rejects_invalid_text() {
        let fx = Fx::new();
        fx.seed(vec![note(1)]);
        assert_eq!(
            code(block_on(fx.service.update(&uuid(1), ""))),
            IpcErrorCode::InvalidInput
        );
    }

    #[test]
    fn set_pinned_does_not_change_updated_at() {
        let fx = Fx::new();
        fx.seed(vec![note(1)]);
        fx.advance(5000);
        let pinned = block_on(fx.service.set_pinned(&uuid(1), true)).unwrap();
        assert_eq!(
            pinned,
            Note {
                pinned: true,
                ..note(1)
            }
        );
        assert!(
            !block_on(fx.service.set_pinned(&uuid(1), false))
                .unwrap()
                .pinned
        );
    }

    #[test]
    fn throws_not_found_for_unknown_ids() {
        let fx = Fx::new();
        let id = uuid(9);
        assert_eq!(
            code(block_on(fx.service.update(&id, "x"))),
            IpcErrorCode::NotFound
        );
        assert_eq!(
            code(block_on(fx.service.set_pinned(&id, true))),
            IpcErrorCode::NotFound
        );
        assert_eq!(
            code(block_on(fx.service.remove(&id))),
            IpcErrorCode::NotFound
        );
        let error = block_on(fx.service.restore(&id)).unwrap_err();
        assert_eq!(error.code(), IpcErrorCode::NotFound);
        assert_eq!(error.message(), "Note not found");
        assert_eq!(code(fx.service.text(&id)), IpcErrorCode::NotFound);
    }

    #[test]
    fn remove_returns_a_copy_of_the_removed_note_and_drops_it() {
        let fx = Fx::new();
        let original = note(1);
        fx.seed(vec![original.clone(), note(2)]);
        let removed = block_on(fx.service.remove(&uuid(1))).unwrap();
        assert_eq!(removed, original);
        let ids: Vec<String> = fx.items().into_iter().map(|n| n.id).collect();
        assert_eq!(ids, [uuid(2)]);
    }

    #[test]
    fn restore_within_10_s_reinserts_the_note_with_its_original_dates_and_pinned() {
        let fx = Fx::new();
        let original = Note {
            pinned: true,
            ..note(1)
        };
        fx.seed(vec![original.clone()]);
        block_on(fx.service.remove(&uuid(1))).unwrap();
        fx.advance(10_000);
        let restored = block_on(fx.service.restore(&uuid(1))).unwrap();
        assert_eq!(restored, original);
        assert_eq!(fx.items(), [original]);
    }

    #[test]
    fn restore_after_10_001_ms_is_not_found() {
        let fx = Fx::new();
        fx.seed(vec![note(1)]);
        block_on(fx.service.remove(&uuid(1))).unwrap();
        fx.advance(10_001);
        assert_eq!(
            code(block_on(fx.service.restore(&uuid(1)))),
            IpcErrorCode::NotFound
        );
    }

    #[test]
    fn restore_of_an_id_that_exists_again_is_not_found() {
        let fx = Fx::new();
        fx.seed(vec![note(1)]);
        block_on(fx.service.remove(&uuid(1))).unwrap();
        fx.seed(vec![Note {
            text: text("reborn"),
            ..note(1)
        }]);
        assert_eq!(
            code(block_on(fx.service.restore(&uuid(1)))),
            IpcErrorCode::NotFound
        );
    }

    #[test]
    fn restore_consumes_the_buffer_entry() {
        let fx = Fx::new();
        fx.seed(vec![note(1)]);
        block_on(fx.service.remove(&uuid(1))).unwrap();
        block_on(fx.service.restore(&uuid(1))).unwrap();
        // Gone again from the list, but the entry was consumed.
        block_on(fx.service.remove(&uuid(1))).unwrap();
        block_on(fx.service.restore(&uuid(1))).unwrap();
        assert_eq!(
            code(block_on(fx.service.restore(&uuid(1)))),
            IpcErrorCode::NotFound
        );
    }

    #[test]
    fn two_consecutive_deletions_are_restorable_separately() {
        let fx = Fx::new();
        fx.seed(vec![note(1), note(2)]);
        block_on(fx.service.remove(&uuid(1))).unwrap();
        block_on(fx.service.remove(&uuid(2))).unwrap();
        assert!(fx.items().is_empty());
        block_on(fx.service.restore(&uuid(2))).unwrap();
        block_on(fx.service.restore(&uuid(1))).unwrap();
        let mut ids: Vec<String> = fx.items().into_iter().map(|n| n.id).collect();
        ids.sort();
        assert_eq!(ids, [uuid(1), uuid(2)]);
    }

    #[test]
    fn prunes_entries_older_than_10_s_on_each_mutation() {
        let fx = Fx::new();
        fx.seed(vec![note(1), note(2)]);
        block_on(fx.service.remove(&uuid(1))).unwrap();
        fx.advance(10_001);
        block_on(fx.service.remove(&uuid(2))).unwrap();
        assert_eq!(
            code(block_on(fx.service.restore(&uuid(1)))),
            IpcErrorCode::NotFound
        );
        block_on(fx.service.restore(&uuid(2))).unwrap();
    }

    #[test]
    fn a_failed_write_does_not_leave_a_restore_entry() {
        let fx = Fx::new();
        fx.seed(vec![note(1)]);
        fx.step(WriteStep::Fail);
        assert_eq!(
            code(block_on(fx.service.remove(&uuid(1)))),
            IpcErrorCode::Internal
        );
        assert_eq!(
            code(block_on(fx.service.restore(&uuid(1)))),
            IpcErrorCode::NotFound
        );
    }

    #[test]
    fn does_not_lose_notes_under_concurrent_creates() {
        let fx = Fx::new();
        block_on(async {
            let tasks: Vec<_> = (0..20)
                .map(|i| {
                    let service = Arc::clone(&fx.service);
                    tauri::async_runtime::spawn(async move {
                        service.create(&format!("note {i}")).await
                    })
                })
                .collect();
            for task in tasks {
                task.await.unwrap().unwrap();
            }
        });
        let items = fx.items();
        assert_eq!(items.len(), 20);
        let ids: std::collections::HashSet<String> = items.into_iter().map(|n| n.id).collect();
        assert_eq!(ids.len(), 20);
    }

    #[test]
    fn text_returns_the_current_text_synchronously() {
        let fx = Fx::new();
        fx.seed(vec![Note {
            text: text("copy me"),
            ..note(1)
        }]);
        assert_eq!(fx.service.text(&uuid(1)).unwrap(), "copy me");
    }

    #[test]
    fn a_panicking_change_listener_never_fails_a_mutation_that_was_saved() {
        let fx = Fx::new();
        fx.listener_panics.store(true, AtomicOrdering::SeqCst);
        let created = block_on(fx.service.create("kept")).unwrap();
        assert_eq!(fx.items(), std::slice::from_ref(&created));
        // Later mutations still run.
        assert!(
            block_on(fx.service.set_pinned(&created.id, true))
                .unwrap()
                .pinned
        );
        assert_eq!(fx.changes(), 2);
    }

    #[test]
    fn idle_settles_once_every_queued_mutation_has_finished() {
        let fx = Fx::new();
        let (release, gate) = oneshot::channel();
        fx.step(WriteStep::Gate(gate));
        block_on(async {
            let create = fx.service.create("slow");
            tokio::pin!(create);
            // Let the create take its turn and reach the held write.
            assert!(tokio::time::timeout(Duration::from_millis(20), &mut create)
                .await
                .is_err());
            let idle = fx.service.idle();
            tokio::pin!(idle);
            assert!(tokio::time::timeout(Duration::from_millis(20), &mut idle)
                .await
                .is_err());
            release.send(()).unwrap();
            create.await.unwrap();
            idle.await;
        });
        assert_eq!(fx.items().len(), 1);
    }

    #[test]
    fn idle_resolves_even_when_the_last_mutation_failed() {
        let fx = Fx::new();
        fx.step(WriteStep::Fail);
        block_on(async {
            // `join!` polls the create first, so it is queued before the idle.
            let (failing, ()) = tokio::join!(fx.service.create("x"), fx.service.idle());
            assert_eq!(failing.unwrap_err().code(), IpcErrorCode::Internal);
        });
    }

    #[test]
    fn json_store_read_only_message_is_the_notes_one() {
        use crate::contract::notes::{NOTES_READ_ONLY_MESSAGE, NOTES_STORE_NAME};
        use crate::services::test_dir::TestDir;
        let dir = TestDir::new("notes-ro");
        let path = dir.join("notes.json");
        std::fs::write(&path, r#"{"version":2,"notes":[]}"#).unwrap();
        let store =
            JsonStore::<NotesFile>::new(path, NOTES_STORE_NAME, Arc::new(WallClock::real()));
        block_on(store.load());
        let error = block_on(NoteStore::write(&store, vec![note(1)])).unwrap_err();
        assert_eq!(error.code(), IpcErrorCode::ReadOnly);
        assert_eq!(error.message(), NOTES_READ_ONLY_MESSAGE);
    }
}
