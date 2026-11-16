//! Claude Code sessions seen through the hooks (port of `src/main/claude/session-registry.ts`).
//!
//! A plain struct (`&mut self`): no callback of its own and nothing reaches it from another
//! thread, so the service keeps it behind its own lock. `now` is the real wall clock
//! (`Date.now()` in Electron), never the e2e test clock.

use std::collections::HashSet;
use std::sync::Arc;

use super::hook_events::{HookEvent, HookEventName};
use crate::contract::claude::{ClaudeSession, ClaudeSessionStatus};
use crate::contract::text::utf16_prefix;

/// A session with no event for this long goes idle (30 min).
pub const DEFAULT_IDLE_AFTER_MS: u64 = 1_800_000;

/// `SessionRegistryOptions`.
#[derive(Clone)]
pub struct SessionRegistryOptions {
    /// Wall clock in ms since the epoch.
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub idle_after_ms: Option<u64>,
}

#[derive(Clone)]
struct Entry {
    id: String,
    name: String,
    status: ClaudeSessionStatus,
    updated_at: u64,
    resume_status: ClaudeSessionStatus,
}

/// `id.slice(0, 8)`.
fn fallback_name(id: &str) -> String {
    utf16_prefix(id, 8).to_string()
}

/// The last non-empty segment of `cwd`, split on `\` and `/`.
fn name_from_cwd(cwd: Option<&str>) -> Option<String> {
    cwd?.split(['\\', '/'])
        .rfind(|part| !part.is_empty())
        .map(str::to_string)
}

fn next_status(event: &HookEvent, current: Option<ClaudeSessionStatus>) -> ClaudeSessionStatus {
    use ClaudeSessionStatus::*;
    match event.name {
        HookEventName::PermissionRequest => Waiting,
        HookEventName::Notification => {
            if event.notification_type.as_deref() == Some("permission_prompt") {
                Waiting
            } else {
                current.unwrap_or(Working)
            }
        }
        HookEventName::Stop => Done,
        HookEventName::SubagentStop => {
            if current == Some(Done) {
                Done
            } else {
                Working
            }
        }
        HookEventName::StopFailure => Error,
        // UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart,
        // PermissionDenied (SessionEnd never gets here).
        _ => Working,
    }
}

/// `createSessionRegistry`.
pub struct SessionRegistry {
    now: Arc<dyn Fn() -> u64 + Send + Sync>,
    idle_after_ms: u64,
    /// In first-seen order (the sort by `updatedAt` is stable over it).
    entries: Vec<Entry>,
}

impl SessionRegistry {
    pub fn new(options: SessionRegistryOptions) -> Self {
        Self {
            now: options.now,
            idle_after_ms: options.idle_after_ms.unwrap_or(DEFAULT_IDLE_AFTER_MS),
            entries: Vec::new(),
        }
    }

    fn get(&self, id: &str) -> Option<&Entry> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    fn get_mut(&mut self, id: &str) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|entry| entry.id == id)
    }

    /// `Map.set`: replaces in place, or appends a new session.
    fn set(&mut self, entry: Entry) {
        match self.get_mut(&entry.id) {
            Some(existing) => *existing = entry,
            None => self.entries.push(entry),
        }
    }

    fn remove(&mut self, id: &str) {
        self.entries.retain(|entry| entry.id != id);
    }

    pub fn apply(&mut self, event: &HookEvent) {
        if event.name == HookEventName::SessionEnd {
            self.remove(&event.session_id);
            return;
        }
        let existing = self.get(&event.session_id);
        // Any event revives an idle session to the status it had before going idle.
        let current = existing.map(|entry| {
            if entry.status == ClaudeSessionStatus::Idle {
                entry.resume_status
            } else {
                entry.status
            }
        });
        let status = next_status(event, current);
        let name = name_from_cwd(event.cwd.as_deref())
            .or_else(|| existing.map(|entry| entry.name.clone()))
            .unwrap_or_else(|| fallback_name(&event.session_id));
        let updated_at = (self.now)();
        self.set(Entry {
            id: event.session_id.clone(),
            name,
            status,
            updated_at,
            resume_status: status,
        });
    }

    /// Most recently updated first; public fields only.
    pub fn sessions(&self) -> Vec<ClaudeSession> {
        let mut entries: Vec<&Entry> = self.entries.iter().collect();
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.updated_at));
        entries
            .into_iter()
            .map(|entry| ClaudeSession {
                id: entry.id.clone(),
                name: entry.name.clone(),
                status: entry.status,
                updated_at: entry.updated_at as f64,
            })
            .collect()
    }

    /// Idle after the quiet window; only sessions in `held_sessions` (a request held by a
    /// broker) are exempt. True when some session changed.
    pub fn tick(&mut self, held_sessions: &HashSet<String>) -> bool {
        let now = (self.now)();
        let idle_after_ms = self.idle_after_ms;
        let mut changed = false;
        for entry in &mut self.entries {
            // A held permission can legitimately outlast the idle window (hook timeout 3600 s);
            // a `waiting` with nothing held (e.g. only a permission_prompt notification) cannot.
            // A clock that went back never idles (JS: a negative difference).
            if entry.status != ClaudeSessionStatus::Idle
                && !held_sessions.contains(&entry.id)
                && now
                    .checked_sub(entry.updated_at)
                    .is_some_and(|quiet| quiet >= idle_after_ms)
            {
                entry.resume_status = entry.status;
                entry.status = ClaudeSessionStatus::Idle;
                changed = true;
            }
        }
        changed
    }

    /// Removes an idle session; any other (or an unknown id) stays and returns false.
    pub fn dismiss(&mut self, id: &str) -> bool {
        if self.get(id).map(|entry| entry.status) != Some(ClaudeSessionStatus::Idle) {
            return false;
        }
        self.remove(id);
        true
    }

    /// The session's name; for one not seen yet, the last segment of `cwd` (else the id prefix).
    pub fn name_of(&self, id: &str, cwd: Option<&str>) -> String {
        self.get(id)
            .map(|entry| entry.name.clone())
            .or_else(|| name_from_cwd(cwd))
            .unwrap_or_else(|| fallback_name(id))
    }

    /// Something is held for the user (permission or question): `waiting`, creating the session
    /// if new. True if it changed.
    pub fn mark_waiting(&mut self, id: &str, cwd: Option<&str>) -> bool {
        let existing = self.get(id);
        if existing.map(|entry| entry.status) == Some(ClaudeSessionStatus::Waiting) {
            return false;
        }
        let name = existing
            .map(|entry| entry.name.clone())
            .or_else(|| name_from_cwd(cwd))
            .unwrap_or_else(|| fallback_name(id));
        let updated_at = (self.now)();
        self.set(Entry {
            id: id.to_string(),
            name,
            status: ClaudeSessionStatus::Waiting,
            updated_at,
            resume_status: ClaudeSessionStatus::Waiting,
        });
        true
    }

    /// A pending item went away (decided, dropped or released): leave `waiting`.
    pub fn resolve_waiting(&mut self, id: &str) -> bool {
        let now = (self.now)();
        match self.get_mut(id) {
            Some(entry) if entry.status == ClaudeSessionStatus::Waiting => {
                entry.status = ClaudeSessionStatus::Working;
                entry.resume_status = ClaudeSessionStatus::Working;
                entry.updated_at = now;
                true
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::claude::permission_broker::test_support::ev;
    use ClaudeSessionStatus::*;
    use HookEventName::*;

    const ID: &str = "abcdef123456";

    struct Setup {
        registry: SessionRegistry,
        t: Arc<AtomicU64>,
    }

    impl Setup {
        fn new() -> Self {
            let t = Arc::new(AtomicU64::new(1_000));
            let clock = Arc::clone(&t);
            Self {
                registry: SessionRegistry::new(SessionRegistryOptions {
                    now: Arc::new(move || clock.load(Ordering::SeqCst)),
                    idle_after_ms: None,
                }),
                t,
            }
        }

        fn advance(&self, ms: u64) {
            self.t.fetch_add(ms, Ordering::SeqCst);
        }

        /// `send(name, extra, sessionId)`: applies with the default cwd, then advances 10 ms.
        fn send_with(&mut self, event: HookEvent) {
            self.registry.apply(&event);
            self.advance(10);
        }

        fn send(&mut self, name: HookEventName) {
            self.send_with(event(name, ID));
        }

        fn status_of(&self, id: &str) -> Option<ClaudeSessionStatus> {
            self.registry
                .sessions()
                .into_iter()
                .find(|s| s.id == id)
                .map(|s| s.status)
        }

        fn status(&self) -> Option<ClaudeSessionStatus> {
            self.status_of(ID)
        }

        fn tick(&mut self) -> bool {
            self.registry.tick(&HashSet::new())
        }
    }

    fn event(name: HookEventName, session_id: &str) -> HookEvent {
        HookEvent {
            cwd: Some("C:\\work\\my-project".into()),
            ..ev(name, session_id)
        }
    }

    fn notification(kind: &str) -> HookEvent {
        HookEvent {
            notification_type: Some(kind.into()),
            ..event(Notification, ID)
        }
    }

    fn held(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn walks_the_default_mode_sequence() {
        let mut s = Setup::new();
        s.send(UserPromptSubmit);
        assert_eq!(s.status(), Some(Working));
        s.send(PreToolUse);
        assert_eq!(s.status(), Some(Working));
        s.send(PermissionRequest);
        assert_eq!(s.status(), Some(Waiting));
        s.send_with(notification("permission_prompt"));
        assert_eq!(s.status(), Some(Waiting));
        s.send(PostToolUse);
        assert_eq!(s.status(), Some(Working));
        s.send(Stop);
        assert_eq!(s.status(), Some(Done));
    }

    #[test]
    fn treats_a_permission_prompt_notification_without_permission_request_as_waiting() {
        let mut s = Setup::new();
        s.send_with(notification("permission_prompt"));
        assert_eq!(s.status(), Some(Waiting));
    }

    #[test]
    fn other_notifications_only_refresh_updated_at() {
        let mut s = Setup::new();
        s.send(Stop);
        let before = s.registry.sessions()[0].updated_at;
        s.send_with(notification("idle_prompt"));
        assert_eq!(s.status(), Some(Done));
        assert!(s.registry.sessions()[0].updated_at > before);
    }

    #[test]
    fn stop_failure_sets_error_and_permission_denied_returns_to_working() {
        let mut s = Setup::new();
        s.send(PermissionRequest);
        s.send(PermissionDenied);
        assert_eq!(s.status(), Some(Working));
        s.send(StopFailure);
        assert_eq!(s.status(), Some(Error));
    }

    #[test]
    fn session_end_removes_the_session() {
        let mut s = Setup::new();
        s.send(UserPromptSubmit);
        s.send(SessionEnd);
        assert!(s.registry.sessions().is_empty());
    }

    #[test]
    fn subagent_stop_after_stop_keeps_done_otherwise_working() {
        let mut s = Setup::new();
        s.send(SubagentStart);
        assert_eq!(s.status(), Some(Working));
        s.send(SubagentStop);
        assert_eq!(s.status(), Some(Working));
        s.send(Stop);
        s.send(SubagentStop);
        assert_eq!(s.status(), Some(Done));
    }

    #[test]
    fn goes_idle_after_30_minutes_without_events_tick_reports_changes_only() {
        let mut s = Setup::new();
        s.send(Stop);
        assert!(!s.tick());
        s.advance(1_800_000);
        assert!(s.tick());
        assert_eq!(s.status(), Some(Idle));
        assert!(!s.tick());
    }

    #[test]
    fn any_event_revives_an_idle_session() {
        let mut s = Setup::new();
        s.send(Stop);
        s.advance(1_800_000);
        s.tick();
        s.send_with(notification("idle_prompt"));
        assert_eq!(s.status(), Some(Done));
        s.send(PreToolUse);
        assert_eq!(s.status(), Some(Working));
    }

    #[test]
    fn dismiss_only_works_on_idle_sessions() {
        let mut s = Setup::new();
        s.send(Stop);
        assert!(!s.registry.dismiss(ID));
        s.advance(1_800_000);
        s.tick();
        assert!(s.registry.dismiss(ID));
        assert!(s.registry.sessions().is_empty());
        assert!(!s.registry.dismiss(ID));
    }

    #[test]
    fn name_is_the_last_cwd_segment_falling_back_to_the_first_8_id_chars() {
        let mut s = Setup::new();
        s.send(Stop);
        s.registry.apply(&ev(Stop, "zzzzzzzz9999"));
        s.send_with(HookEvent {
            cwd: Some("C:\\a\\b\\".into()),
            ..ev(Stop, "trailing-1")
        });
        let name = |id: &str| {
            s.registry
                .sessions()
                .into_iter()
                .find(|session| session.id == id)
                .map(|session| session.name)
        };
        assert_eq!(name(ID).as_deref(), Some("my-project"));
        assert_eq!(name("zzzzzzzz9999").as_deref(), Some("zzzzzzzz"));
        assert_eq!(name("trailing-1").as_deref(), Some("b"));
        assert_eq!(s.registry.name_of(ID, None), "my-project");
        assert_eq!(s.registry.name_of("unknown-session", None), "unknown-");
    }

    #[test]
    fn never_moves_a_waiting_session_with_a_held_request_to_idle() {
        let mut s = Setup::new();
        s.send(PermissionRequest);
        s.advance(31 * 60_000);
        assert!(!s.registry.tick(&held(&[ID])));
        assert_eq!(s.status(), Some(Waiting));
        assert!(!s.registry.dismiss(ID));
    }

    #[test]
    fn a_waiting_session_without_a_held_request_goes_idle_after_30_minutes() {
        let mut s = Setup::new();
        s.send_with(notification("permission_prompt"));
        s.advance(29 * 60_000);
        assert!(!s.registry.tick(&held(&[])));
        s.advance(2 * 60_000);
        assert!(s.registry.tick(&held(&["other-session"])));
        assert_eq!(s.status(), Some(Idle));
    }

    #[test]
    fn post_tool_use_failure_counts_as_activity() {
        let mut s = Setup::new();
        s.send_with(HookEvent {
            tool_name: Some("Bash".into()),
            ..event(PermissionRequest, ID)
        });
        s.send_with(HookEvent {
            tool_name: Some("Bash".into()),
            tool_use_id: Some("tu1".into()),
            ..event(PostToolUseFailure, ID)
        });
        assert_eq!(s.status(), Some(Working));
    }

    #[test]
    fn an_unusable_cwd_does_not_overwrite_an_existing_name() {
        let mut s = Setup::new();
        s.send(Stop);
        s.send_with(HookEvent {
            cwd: Some(String::new()),
            ..ev(PreToolUse, ID)
        });
        s.send_with(HookEvent {
            cwd: Some("/".into()),
            ..ev(PreToolUse, ID)
        });
        assert_eq!(s.registry.name_of(ID, None), "my-project");
        s.registry.apply(&HookEvent {
            cwd: Some("/".into()),
            ..ev(Stop, "newsession1")
        });
        assert_eq!(s.registry.name_of("newsession1", None), "newsessi");
    }

    #[test]
    fn resolve_waiting_moves_only_a_waiting_session_back_to_working() {
        let mut s = Setup::new();
        s.send(PermissionRequest);
        let before = s.registry.sessions()[0].updated_at;
        assert!(s.registry.resolve_waiting(ID));
        assert_eq!(s.status(), Some(Working));
        assert!(s.registry.sessions()[0].updated_at >= before);

        s.send(Stop);
        assert!(!s.registry.resolve_waiting(ID));
        assert_eq!(s.status(), Some(Done));
        assert!(!s.registry.resolve_waiting("missing-session"));
    }

    #[test]
    fn orders_by_updated_at_descending() {
        let mut s = Setup::new();
        s.send_with(event(Stop, "a-session-1"));
        s.send_with(event(Stop, "b-session-2"));
        s.send_with(event(PreToolUse, "a-session-1"));
        let ids: Vec<String> = s.registry.sessions().into_iter().map(|x| x.id).collect();
        assert_eq!(ids, vec!["a-session-1", "b-session-2"]);
    }

    #[test]
    fn marks_a_known_session_waiting_and_reports_whether_it_changed() {
        let mut s = Setup::new();
        s.send_with(HookEvent {
            tool_name: Some("Bash".into()),
            ..event(PreToolUse, ID)
        });
        assert!(s.registry.mark_waiting(ID, None));
        assert_eq!(s.status(), Some(Waiting));
        let at = s.registry.sessions()[0].updated_at;
        s.advance(100);
        assert!(!s.registry.mark_waiting(ID, None));
        assert_eq!(s.registry.sessions()[0].updated_at, at);
        // Resume status is waiting too: an idle session comes back waiting.
        s.advance(31 * 60_000);
        s.tick();
        assert_eq!(s.status(), Some(Idle));
        s.registry.apply(&HookEvent {
            notification_type: Some("idle_prompt".into()),
            ..ev(Notification, ID)
        });
        assert_eq!(s.status(), Some(Waiting));
        assert!(s.registry.resolve_waiting(ID));
        assert_eq!(s.status(), Some(Working));
    }

    #[test]
    fn creates_a_session_first_seen_waiting_named_from_its_cwd() {
        let mut s = Setup::new();
        assert!(s
            .registry
            .mark_waiting("newsession99", Some("C:\\work\\fresh-project\\")));
        assert_eq!(
            s.registry.sessions(),
            vec![ClaudeSession {
                id: "newsession99".into(),
                name: "fresh-project".into(),
                status: Waiting,
                updated_at: 1_000.0,
            }]
        );
        assert_eq!(s.status_of("newsession99"), Some(Waiting));
        assert!(s.registry.mark_waiting("nocwd-session", None));
        assert_eq!(s.registry.name_of("nocwd-session", None), "nocwd-se");
    }

    #[test]
    fn name_of_falls_back_to_the_cwd_before_the_id_prefix_for_an_unknown_session() {
        let mut s = Setup::new();
        s.send(UserPromptSubmit);
        assert_eq!(
            s.registry.name_of(ID, Some("C:\\work\\other")),
            "my-project"
        );
        assert_eq!(
            s.registry
                .name_of("unknown-session", Some("C:\\work\\from-cwd")),
            "from-cwd"
        );
        assert_eq!(s.registry.name_of("unknown-session", None), "unknown-");
    }
}
