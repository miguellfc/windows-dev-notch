//! Held Claude Code permission requests (port of 0.1.0's `permission-broker.ts`).
//!
//! Concurrency: the broker locks itself. Its state sits behind one internal `Mutex`, so a
//! `PendingReply::on_close` callback arriving on a tokio worker can drop its entry at any time.
//! Every method takes `&self`; the injected callbacks (`new_id`, `session_name`, `on_change`)
//! and `PendingReply::{send, on_close}` always run with that lock released, so `on_change` may
//! read the broker again or drive the notch. Each settle removes the entry first (under the
//! lock), then sends, then calls `on_change`: whichever of a decision, a release or a disconnect
//! takes the entry is the only one that acts.

use std::collections::{HashMap, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use super::bridge::PendingReply;
use super::hook_events::{permission_body, HookEvent, HookEventName};
use crate::contract::claude::{Decision, PendingPermission};

/// Bounds the per-session memory of unfinished tool calls (a lost PostToolUse must not grow it
/// forever).
pub const MAX_OPEN_CALLS: usize = 256;

pub type NewId = Arc<dyn Fn() -> String + Send + Sync>;
/// Wall clock in ms since the epoch (`Date.now()`).
pub type Now = Arc<dyn Fn() -> u64 + Send + Sync>;
pub type OnChange = Arc<dyn Fn() + Send + Sync>;

/// `PermissionBrokerOptions`.
#[derive(Clone)]
pub struct PermissionBrokerOptions {
    pub new_id: NewId,
    pub now: Now,
    pub session_name: Arc<dyn Fn(&str) -> String + Send + Sync>,
    pub on_change: OnChange,
}

/// The end of a tool call: releases the request bound to that call (or, unbound, one of the
/// same tool).
fn is_tool_end(name: HookEventName) -> bool {
    matches!(
        name,
        HookEventName::PostToolUse
            | HookEventName::PostToolUseFailure
            | HookEventName::PermissionDenied
    )
}

/// The turn is over (or was interrupted): nothing of the session can still be waiting on us.
/// Notification is excluded on purpose: permission_prompt arrives ~6 s after the request for the
/// same prompt.
pub(crate) fn is_session_end(name: HookEventName) -> bool {
    matches!(
        name,
        HookEventName::Stop
            | HookEventName::StopFailure
            | HookEventName::UserPromptSubmit
            | HookEventName::SessionEnd
    )
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A send that panics (it never should) must not stop the bookkeeping or the other releases.
/// False when it did; logs only which broker it was (`what`), never the body.
pub(crate) fn safe_send(reply: &dyn PendingReply, body: Option<String>, what: &str) -> bool {
    let sent = catch_unwind(AssertUnwindSafe(|| reply.send(body))).is_ok();
    if !sent {
        log::warn!("Claude {what} reply could not be sent");
    }
    sent
}

struct Entry {
    info: PendingPermission,
    reply: Arc<dyn PendingReply>,
    /// tool_use_id of the PreToolUse this request belongs to, when one could be found.
    tool_use_id: Option<String>,
}

/// A PreToolUse whose PostToolUse / PostToolUseFailure / PermissionDenied has not arrived yet.
struct OpenCall {
    tool_use_id: String,
    tool_name: Option<String>,
    agent_id: Option<String>,
}

#[derive(Default)]
struct Inner {
    /// In arrival order.
    entries: Vec<Entry>,
    open_calls: HashMap<String, VecDeque<OpenCall>>,
}

impl Inner {
    fn take(&mut self, id: &str) -> Option<Entry> {
        let index = self.entries.iter().position(|entry| entry.info.id == id)?;
        Some(self.entries.remove(index))
    }

    /// The most recent unfinished call of the same tool (and agent, for a subagent request).
    fn bind_tool_call(&self, e: &HookEvent) -> Option<String> {
        self.open_calls
            .get(&e.session_id)?
            .iter()
            .rev()
            .find(|call| {
                call.tool_name == e.tool_name
                    && (e.agent_id.is_none() || call.agent_id == e.agent_id)
            })
            .map(|call| call.tool_use_id.clone())
    }

    fn track_tool_calls(&mut self, e: &HookEvent) {
        match (e.name, &e.tool_use_id) {
            (HookEventName::PreToolUse, Some(tool_use_id)) => {
                let calls = self.open_calls.entry(e.session_id.clone()).or_default();
                calls.push_back(OpenCall {
                    tool_use_id: tool_use_id.clone(),
                    tool_name: e.tool_name.clone(),
                    agent_id: e.agent_id.clone(),
                });
                if calls.len() > MAX_OPEN_CALLS {
                    calls.pop_front();
                }
            }
            (name, Some(tool_use_id)) if is_tool_end(name) => {
                if let Some(calls) = self.open_calls.get_mut(&e.session_id) {
                    if let Some(index) = calls
                        .iter()
                        .position(|call| &call.tool_use_id == tool_use_id)
                    {
                        calls.remove(index);
                    }
                }
            }
            (name, _) if is_session_end(name) => {
                self.open_calls.remove(&e.session_id);
            }
            _ => {}
        }
    }

    fn ids_where(&self, matches: impl Fn(&Entry) -> bool) -> Vec<String> {
        self.entries
            .iter()
            .filter(|entry| matches(entry))
            .map(|entry| entry.info.id.clone())
            .collect()
    }
}

/// `createPermissionBroker`.
pub struct PermissionBroker {
    options: PermissionBrokerOptions,
    inner: Arc<Mutex<Inner>>,
}

impl PermissionBroker {
    pub fn new(options: PermissionBrokerOptions) -> Self {
        Self {
            options,
            inner: Arc::default(),
        }
    }

    /// Removing before sending makes a later `on_close` for the same reply a no-op. False when
    /// the id is unknown (already settled or dropped).
    fn settle(&self, id: &str, body: Option<String>) -> bool {
        let Some(entry) = lock(&self.inner).take(id) else {
            return false;
        };
        safe_send(entry.reply.as_ref(), body, "permission");
        (self.options.on_change)();
        true
    }

    fn release_ids(&self, ids: Vec<String>) {
        for id in ids {
            self.settle(&id, None);
        }
    }

    /// Holds `reply` until the user decides, the request stops being pending or Claude hangs up.
    pub fn hold(&self, e: &HookEvent, reply: Arc<dyn PendingReply>) {
        let id = (self.options.new_id)();
        let session_name = (self.options.session_name)(&e.session_id);
        let received_at = reply.arrived_at().unwrap_or_else(|| (self.options.now)());
        let (preview, preview_truncated, preview_length) = match &e.preview {
            Some(preview) => (
                preview.preview.clone(),
                preview.preview_truncated,
                preview.preview_length,
            ),
            None => (String::new(), false, 0),
        };
        {
            let mut inner = lock(&self.inner);
            let tool_use_id = inner.bind_tool_call(e);
            inner.entries.push(Entry {
                info: PendingPermission {
                    id: id.clone(),
                    session_id: e.session_id.clone(),
                    session_name,
                    tool_name: e.tool_name.clone().unwrap_or_default(),
                    preview,
                    preview_truncated,
                    preview_length: preview_length as f64,
                    received_at: received_at as f64,
                },
                reply: Arc::clone(&reply),
                tool_use_id,
            });
        }
        let weak: Weak<Mutex<Inner>> = Arc::downgrade(&self.inner);
        let on_change = Arc::clone(&self.options.on_change);
        reply.on_close(Box::new(move || {
            let Some(inner) = weak.upgrade() else { return };
            let removed = lock(&inner).take(&id).is_some();
            if removed {
                on_change();
            }
        }));
        (self.options.on_change)();
    }

    /// Sends the decision. False for an unknown (or already settled) id.
    pub fn decide(&self, id: &str, decision: Decision) -> bool {
        self.settle(id, Some(permission_body(decision)))
    }

    /// Called for every `/hook` event that is not itself held.
    pub fn observe(&self, e: &HookEvent) {
        let ids = {
            let mut inner = lock(&self.inner);
            inner.track_tool_calls(e);
            if is_session_end(e.name) {
                inner.ids_where(|entry| entry.info.session_id == e.session_id)
            } else if is_tool_end(e.name) {
                inner.ids_where(|entry| match &entry.tool_use_id {
                    Some(bound) => {
                        e.tool_use_id.as_ref() == Some(bound)
                            && entry.info.session_id == e.session_id
                    }
                    None => {
                        entry.info.session_id == e.session_id
                            && e.tool_name.as_ref() == Some(&entry.info.tool_name)
                    }
                })
            } else {
                // PreToolUse, Notification, Subagent*, PermissionRequest: never release.
                Vec::new()
            }
        };
        self.release_ids(ids);
    }

    /// Answers every held request with an empty 200 (Claude asks in its own window).
    pub fn release_all(&self) {
        let ids = lock(&self.inner).ids_where(|_| true);
        self.release_ids(ids);
    }

    /// Copies of the held requests, oldest first.
    pub fn pending(&self) -> Vec<PendingPermission> {
        lock(&self.inner)
            .entries
            .iter()
            .map(|entry| entry.info.clone())
            .collect()
    }
}

/// Fakes shared by the broker tests.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::{Arc, Mutex};

    use super::{lock, PendingReply};
    use crate::claude::hook_events::{HookEvent, HookEventName};

    type CloseCallback = Box<dyn FnOnce() + Send>;

    /// `makeReply`: records every send; `close()` runs the last `on_close` callback.
    #[derive(Default)]
    pub struct FakeReply {
        pub arrived_at: Option<u64>,
        pub panics: bool,
        sends: Mutex<Vec<Option<String>>>,
        close_callback: Mutex<Option<CloseCallback>>,
    }

    impl FakeReply {
        pub fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        pub fn arriving_at(arrived_at: u64) -> Arc<Self> {
            Arc::new(Self {
                arrived_at: Some(arrived_at),
                ..Self::default()
            })
        }

        pub fn panicking() -> Arc<Self> {
            Arc::new(Self {
                panics: true,
                ..Self::default()
            })
        }

        pub fn sends(&self) -> Vec<Option<String>> {
            lock(&self.sends).clone()
        }

        pub fn close(&self) {
            let callback = lock(&self.close_callback).take();
            if let Some(callback) = callback {
                callback();
            }
        }
    }

    impl PendingReply for FakeReply {
        fn arrived_at(&self) -> Option<u64> {
            self.arrived_at
        }

        fn send(&self, body: Option<String>) {
            lock(&self.sends).push(body);
            if self.panics {
                panic!("socket gone");
            }
        }

        fn on_close(&self, callback: Box<dyn FnOnce() + Send>) {
            *lock(&self.close_callback) = Some(callback);
        }
    }

    pub fn ev(name: HookEventName, session_id: &str) -> HookEvent {
        HookEvent {
            name,
            session_id: session_id.into(),
            cwd: None,
            tool_name: None,
            tool_use_id: None,
            agent_id: None,
            notification_type: None,
            preview: None,
            reason: None,
            ask_user_question: None,
            ask_user_question_raw: None,
        }
    }

    /// `ev(name, session, { toolName, toolUseId, agentId })`.
    pub fn tool(
        name: HookEventName,
        session_id: &str,
        tool_name: Option<&str>,
        tool_use_id: Option<&str>,
        agent_id: Option<&str>,
    ) -> HookEvent {
        HookEvent {
            tool_name: tool_name.map(Into::into),
            tool_use_id: tool_use_id.map(Into::into),
            agent_id: agent_id.map(Into::into),
            ..ev(name, session_id)
        }
    }

    /// Counts `on_change` calls.
    #[derive(Default)]
    pub struct Counter(Mutex<usize>);

    impl Counter {
        pub fn bump(&self) {
            *lock(&self.0) += 1;
        }

        pub fn get(&self) -> usize {
            *lock(&self.0)
        }

        pub fn clear(&self) {
            *lock(&self.0) = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::test_support::{ev, tool, Counter, FakeReply};
    use super::*;
    use crate::claude::hook_events::Preview;
    use HookEventName::*;

    const ALLOW: &str = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#;
    const DENY: &str = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}"#;

    fn setup() -> (PermissionBroker, Arc<Counter>) {
        let n = Arc::new(AtomicU64::new(0));
        let t = Arc::new(AtomicU64::new(1000));
        let changes = Arc::new(Counter::default());
        let counter = Arc::clone(&changes);
        let broker = PermissionBroker::new(PermissionBrokerOptions {
            new_id: Arc::new(move || format!("id{}", n.fetch_add(1, Ordering::SeqCst) + 1)),
            now: Arc::new(move || t.fetch_add(10, Ordering::SeqCst) + 10),
            session_name: Arc::new(|id| format!("name-{id}")),
            on_change: Arc::new(move || counter.bump()),
        });
        (broker, changes)
    }

    fn request_with(session_id: &str, tool_name: &str, preview: &str) -> HookEvent {
        HookEvent {
            preview: Some(Preview {
                preview: preview.into(),
                preview_truncated: false,
                preview_length: preview.chars().map(char::len_utf16).sum(),
            }),
            ..tool(PermissionRequest, session_id, Some(tool_name), None, None)
        }
    }

    fn request(session_id: &str) -> HookEvent {
        request_with(session_id, "Bash", "ls")
    }

    fn hold(broker: &PermissionBroker, e: &HookEvent) -> Arc<FakeReply> {
        let reply = FakeReply::new();
        broker.hold(e, reply.clone());
        reply
    }

    fn ids(broker: &PermissionBroker) -> Vec<String> {
        broker.pending().into_iter().map(|p| p.id).collect()
    }

    fn released(reply: &FakeReply) -> bool {
        reply.sends() == vec![None]
    }

    #[test]
    fn queues_holds_in_arrival_order_without_exposing_the_reply() {
        let (broker, _) = setup();
        hold(&broker, &request_with("s1", "Bash", "ls"));
        hold(&broker, &request_with("s2", "Edit", "a.ts"));
        let mut list = broker.pending();
        let expected =
            |id: &str, s: &str, tool: &str, preview: &str, len: f64, at: f64| PendingPermission {
                id: id.into(),
                session_id: s.into(),
                session_name: format!("name-{s}"),
                tool_name: tool.into(),
                preview: preview.into(),
                preview_truncated: false,
                preview_length: len,
                received_at: at,
            };
        assert_eq!(
            list,
            vec![
                expected("id1", "s1", "Bash", "ls", 2.0, 1010.0),
                expected("id2", "s2", "Edit", "a.ts", 4.0, 1020.0),
            ]
        );
        assert!(!serde_json::to_string(&list).unwrap().contains("reply"));
        list[0].preview = "mutated".into();
        assert_eq!(broker.pending()[0].preview, "ls");
    }

    #[test]
    fn carries_the_truncation_flag_and_the_full_preview_length() {
        let (broker, _) = setup();
        let e = HookEvent {
            preview: Some(Preview {
                preview: "x".repeat(2000),
                preview_truncated: true,
                preview_length: 2400,
            }),
            ..tool(PermissionRequest, "s1", Some("Bash"), None, None)
        };
        hold(&broker, &e);
        let first = &broker.pending()[0];
        assert!(first.preview_truncated);
        assert_eq!(first.preview_length, 2400.0);
    }

    #[test]
    fn decide_sends_the_exact_allow_deny_json_and_removes_the_entry() {
        let (broker, _) = setup();
        let a = hold(&broker, &request("s1"));
        let b = hold(&broker, &request("s1"));
        assert!(broker.decide("id1", Decision::Allow));
        assert_eq!(a.sends(), vec![Some(ALLOW.to_string())]);
        assert!(broker.decide("id2", Decision::Deny));
        assert_eq!(b.sends(), vec![Some(DENY.to_string())]);
        assert!(broker.pending().is_empty());
    }

    #[test]
    fn returns_false_and_sends_nothing_for_an_unknown_id() {
        let (broker, changes) = setup();
        let a = hold(&broker, &request("s1"));
        changes.clear();
        assert!(!broker.decide("nope", Decision::Allow));
        assert!(a.sends().is_empty());
        assert_eq!(changes.get(), 0);
    }

    #[test]
    fn deciding_the_same_id_twice_sends_once() {
        let (broker, _) = setup();
        let a = hold(&broker, &request("s1"));
        assert!(broker.decide("id1", Decision::Allow));
        assert!(!broker.decide("id1", Decision::Deny));
        assert_eq!(a.sends().len(), 1);
    }

    #[test]
    fn observe_of_a_session_level_end_from_the_same_session_releases_with_null() {
        for name in [Stop, StopFailure, UserPromptSubmit, SessionEnd] {
            let (broker, _) = setup();
            broker.observe(&tool(PreToolUse, "s1", Some("Bash"), Some("tu1"), None));
            let a = hold(&broker, &request("s1"));
            let other = hold(&broker, &request("s2"));
            broker.observe(&ev(name, "s1"));
            assert!(released(&a), "{name:?}");
            assert!(other.sends().is_empty(), "{name:?}");
            assert_eq!(ids(&broker), vec!["id2"], "{name:?}");
        }
    }

    #[test]
    fn a_tool_end_with_the_bound_tool_use_id_releases_the_request() {
        for name in [PostToolUse, PostToolUseFailure, PermissionDenied] {
            let (broker, _) = setup();
            broker.observe(&tool(PreToolUse, "s1", Some("Bash"), Some("tu1"), None));
            let a = hold(&broker, &request("s1"));
            broker.observe(&tool(name, "s1", Some("Bash"), Some("tu-other"), None));
            assert!(a.sends().is_empty(), "{name:?}");
            broker.observe(&tool(name, "s1", Some("Bash"), Some("tu1"), None));
            assert!(released(&a), "{name:?}");
            assert!(broker.pending().is_empty(), "{name:?}");
        }
    }

    #[test]
    fn a_pre_tool_use_never_releases_anything() {
        let (broker, _) = setup();
        let a = hold(&broker, &request("s1"));
        broker.observe(&tool(PreToolUse, "s1", Some("Bash"), Some("tu9"), None));
        assert!(a.sends().is_empty());
    }

    #[test]
    fn without_a_bound_id_a_tool_end_of_the_same_session_and_tool_releases() {
        for name in [PostToolUse, PostToolUseFailure, PermissionDenied] {
            let (broker, _) = setup();
            let a = hold(&broker, &request_with("s1", "Bash", "ls"));
            broker.observe(&tool(name, "s1", Some("Edit"), Some("x1"), None));
            broker.observe(&tool(name, "s2", Some("Bash"), Some("x2"), None));
            assert!(a.sends().is_empty(), "{name:?}");
            broker.observe(&tool(name, "s1", Some("Bash"), Some("x3"), None));
            assert!(released(&a), "{name:?}");
        }
    }

    #[test]
    fn binds_to_the_most_recent_unfinished_pre_tool_use_of_the_same_tool() {
        let (broker, _) = setup();
        broker.observe(&tool(PreToolUse, "s1", Some("Bash"), Some("tu1"), None));
        broker.observe(&tool(PreToolUse, "s1", Some("Bash"), Some("tu2"), None));
        broker.observe(&tool(PostToolUse, "s1", Some("Bash"), Some("tu2"), None));
        broker.observe(&tool(PreToolUse, "s1", Some("Read"), Some("tu3"), None));
        let a = hold(&broker, &request_with("s1", "Bash", "ls"));
        // tu2 already finished and tu3 is another tool: the request belongs to tu1.
        broker.observe(&tool(PostToolUse, "s1", Some("Read"), Some("tu3"), None));
        assert!(a.sends().is_empty());
        broker.observe(&tool(PostToolUse, "s1", Some("Bash"), Some("tu1"), None));
        assert!(released(&a));
    }

    #[test]
    fn two_parallel_subagents_in_one_session_b_never_releases_a() {
        let (broker, _) = setup();
        broker.observe(&tool(
            PreToolUse,
            "s1",
            Some("Bash"),
            Some("a1"),
            Some("agent-a"),
        ));
        let e = HookEvent {
            preview: Some(Preview {
                preview: "npm test".into(),
                preview_truncated: false,
                preview_length: 8,
            }),
            ..tool(PermissionRequest, "s1", Some("Bash"), None, Some("agent-a"))
        };
        let a = hold(&broker, &e);
        broker.observe(&tool(
            PreToolUse,
            "s1",
            Some("Bash"),
            Some("b1"),
            Some("agent-b"),
        ));
        broker.observe(&tool(
            PostToolUse,
            "s1",
            Some("Bash"),
            Some("b1"),
            Some("agent-b"),
        ));
        broker.observe(&tool(
            PostToolUseFailure,
            "s1",
            Some("Bash"),
            Some("b2"),
            Some("agent-b"),
        ));
        broker.observe(&tool(SubagentStop, "s1", None, None, Some("agent-b")));
        assert!(a.sends().is_empty());
        assert_eq!(broker.pending().len(), 1);
        broker.observe(&tool(
            PostToolUse,
            "s1",
            Some("Bash"),
            Some("a1"),
            Some("agent-a"),
        ));
        assert!(released(&a));
    }

    #[test]
    fn binds_a_subagent_request_only_to_a_pre_tool_use_of_the_same_agent() {
        let (broker, _) = setup();
        broker.observe(&tool(
            PreToolUse,
            "s1",
            Some("Bash"),
            Some("a1"),
            Some("agent-a"),
        ));
        broker.observe(&tool(
            PreToolUse,
            "s1",
            Some("Bash"),
            Some("b1"),
            Some("agent-b"),
        ));
        let a = hold(
            &broker,
            &tool(PermissionRequest, "s1", Some("Bash"), None, Some("agent-a")),
        );
        broker.observe(&tool(
            PostToolUse,
            "s1",
            Some("Bash"),
            Some("b1"),
            Some("agent-b"),
        ));
        assert!(a.sends().is_empty());
        broker.observe(&tool(
            PostToolUse,
            "s1",
            Some("Bash"),
            Some("a1"),
            Some("agent-a"),
        ));
        assert!(released(&a));
    }

    #[test]
    fn the_spike_sequence_releases_on_the_post_tool_use() {
        let (broker, _) = setup();
        broker.observe(&tool(PreToolUse, "s1", Some("Read"), Some("tu1"), None));
        broker.observe(&tool(PreToolUse, "s1", Some("Grep"), Some("tu2"), None));
        broker.observe(&tool(PreToolUse, "s1", Some("Bash"), Some("tu3"), None));
        let a = hold(&broker, &request_with("s1", "Bash", "ls"));
        broker.observe(&HookEvent {
            notification_type: Some("permission_prompt".into()),
            ..ev(Notification, "s1")
        });
        assert!(a.sends().is_empty());
        broker.observe(&tool(PostToolUse, "s1", Some("Bash"), Some("tu3"), None));
        assert!(released(&a));
    }

    #[test]
    fn observe_of_notification_or_a_new_permission_request_does_not_release() {
        let (broker, _) = setup();
        let a = hold(&broker, &request("s1"));
        broker.observe(&HookEvent {
            notification_type: Some("permission_prompt".into()),
            ..ev(Notification, "s1")
        });
        broker.observe(&request("s1"));
        assert!(a.sends().is_empty());
        assert_eq!(broker.pending().len(), 1);
    }

    #[test]
    fn observe_releases_every_queued_entry_of_the_session() {
        let (broker, _) = setup();
        let a = hold(&broker, &request("s1"));
        let b = hold(&broker, &request("s1"));
        broker.observe(&ev(Stop, "s1"));
        assert!(released(&a));
        assert!(released(&b));
        assert!(broker.pending().is_empty());
    }

    #[test]
    fn on_close_removes_the_entry_without_sending() {
        let (broker, changes) = setup();
        let a = hold(&broker, &request("s1"));
        changes.clear();
        a.close();
        assert!(a.sends().is_empty());
        assert!(broker.pending().is_empty());
        assert_eq!(changes.get(), 1);
    }

    #[test]
    fn ignores_on_close_after_a_send() {
        let (broker, changes) = setup();
        let a = hold(&broker, &request("s1"));
        broker.decide("id1", Decision::Allow);
        changes.clear();
        a.close();
        assert_eq!(changes.get(), 0);
        assert_eq!(a.sends().len(), 1);
    }

    #[test]
    fn release_all_sends_null_to_all_and_clears() {
        let (broker, _) = setup();
        let a = hold(&broker, &request("s1"));
        let b = hold(&broker, &request("s2"));
        broker.release_all();
        assert!(released(&a));
        assert!(released(&b));
        assert!(broker.pending().is_empty());
        a.close();
        assert_eq!(a.sends().len(), 1);
    }

    #[test]
    fn calls_on_change_on_each_change() {
        let (broker, changes) = setup();
        hold(&broker, &request("s1"));
        assert_eq!(changes.get(), 1);
        hold(&broker, &request("s2"));
        assert_eq!(changes.get(), 2);
        broker.decide("id1", Decision::Allow);
        assert_eq!(changes.get(), 3);
        broker.observe(&ev(Stop, "s2"));
        assert_eq!(changes.get(), 4);
        broker.observe(&ev(Stop, "s2"));
        assert_eq!(changes.get(), 4);
        hold(&broker, &request("s3"));
        broker.release_all();
        assert_eq!(changes.get(), 6);
    }

    // Extra (Rust port): no event of another session ever releases a held request.
    #[test]
    fn another_sessions_events_never_release() {
        let (broker, changes) = setup();
        broker.observe(&tool(PreToolUse, "s1", Some("Bash"), Some("tu1"), None));
        let bound = hold(&broker, &request("s1"));
        let unbound = hold(&broker, &request_with("s1", "Edit", "a.ts"));
        changes.clear();
        for name in HookEventName::ALL.iter().copied() {
            broker.observe(&tool(name, "s2", Some("Bash"), Some("tu1"), None));
            broker.observe(&tool(name, "s2", Some("Edit"), Some("tu2"), None));
        }
        assert!(bound.sends().is_empty());
        assert!(unbound.sends().is_empty());
        assert_eq!(ids(&broker), vec!["id1", "id2"]);
        assert_eq!(changes.get(), 0);
    }

    // Extra (Rust port): Claude hanging up empties the list (the service turns attention off)
    // with one change per disconnect, and a later decision finds nothing.
    #[test]
    fn disconnect_clears_attention() {
        let (broker, changes) = setup();
        let a = hold(&broker, &request("s1"));
        let b = hold(&broker, &request("s2"));
        changes.clear();
        a.close();
        assert_eq!(ids(&broker), vec!["id2"]);
        b.close();
        assert!(broker.pending().is_empty());
        assert_eq!(changes.get(), 2);
        assert!(!broker.decide("id1", Decision::Allow));
        assert!(a.sends().is_empty() && b.sends().is_empty());
        assert_eq!(changes.get(), 2);
    }

    // Extra (Rust port): a decision racing a disconnect on another thread acts once.
    #[test]
    fn a_decision_racing_a_disconnect_settles_once() {
        for _ in 0..200 {
            let (broker, changes) = setup();
            let broker = Arc::new(broker);
            let a = hold(&broker, &request("s1"));
            changes.clear();
            let closer = {
                let a = Arc::clone(&a);
                std::thread::spawn(move || a.close())
            };
            let decided = broker.decide("id1", Decision::Allow);
            closer.join().unwrap();
            assert!(broker.pending().is_empty());
            assert_eq!(changes.get(), 1);
            assert_eq!(a.sends().len(), usize::from(decided));
        }
    }

    // `on_change` may read the broker again: no lock is held while it runs.
    #[test]
    fn on_change_runs_without_the_broker_lock() {
        let slot: Arc<Mutex<Option<Weak<PermissionBroker>>>> = Arc::default();
        let seen: Arc<Mutex<Vec<usize>>> = Arc::default();
        let (slot2, seen2) = (Arc::clone(&slot), Arc::clone(&seen));
        let broker = Arc::new(PermissionBroker::new(PermissionBrokerOptions {
            new_id: Arc::new(|| "id1".into()),
            now: Arc::new(|| 1),
            session_name: Arc::new(|id| id.into()),
            on_change: Arc::new(move || {
                let broker = lock(&slot2).as_ref().and_then(Weak::upgrade);
                if let Some(broker) = broker {
                    lock(&seen2).push(broker.pending().len());
                }
            }),
        }));
        *lock(&slot) = Some(Arc::downgrade(&broker));
        let a = hold(&broker, &request("s1"));
        a.close();
        assert_eq!(*lock(&seen), vec![1, 0]);
    }

    #[test]
    fn caps_the_open_calls_of_a_session() {
        // `reads` calls of another tool after the Bash one: with `reads` = MAX_OPEN_CALLS - 1
        // the session holds exactly the cap and the Bash call still binds; one more drops it.
        let setup_with = |reads: usize| {
            let (broker, _) = setup();
            broker.observe(&tool(PreToolUse, "s1", Some("Bash"), Some("first"), None));
            for index in 0..reads {
                broker.observe(&tool(
                    PreToolUse,
                    "s1",
                    Some("Read"),
                    Some(&format!("r{index}")),
                    None,
                ));
            }
            let a = hold(&broker, &request("s1"));
            (broker, a)
        };

        // Exactly 256 open calls: the oldest still binds, so only its own end releases.
        let (broker, a) = setup_with(MAX_OPEN_CALLS - 1);
        broker.observe(&tool(PostToolUse, "s1", Some("Bash"), Some("other"), None));
        assert!(a.sends().is_empty());
        broker.observe(&tool(PostToolUse, "s1", Some("Bash"), Some("first"), None));
        assert!(released(&a));

        // 257: the oldest call fell out; the request stays unbound and any Bash end releases.
        let (broker, a) = setup_with(MAX_OPEN_CALLS);
        broker.observe(&tool(PostToolUse, "s1", Some("Bash"), Some("other"), None));
        assert!(released(&a));
    }
}
