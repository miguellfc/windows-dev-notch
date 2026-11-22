//! Measures the work of one Claude Code session from its hook events: turns (one per prompt)
//! and two times, Claude's and the total, where idle gaps between turns are capped.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::claude::hook_events::{HookEvent, HookEventName, ASK_USER_QUESTION_TOOL};

/// One prompt and what Claude did until it stopped. Times are epoch milliseconds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub prompt_id: Option<String>,
    pub prompt: String,
    pub reply: Option<String>,
    pub tools: BTreeMap<String, u32>,
    pub started_at: i64,
    /// `None` while the turn is open.
    pub ended_at: Option<i64>,
    pub last_event_at: i64,
    /// Time Claude waited for the user (permissions, questions).
    pub wait_ms: i64,
    pub wait_since: Option<i64>,
    /// Idle time over the cap right after this turn, not counted in the total.
    pub excess_after_ms: i64,
    /// Closed by [`Session::close_stalled`] while it may still be running (a long tool call): its
    /// next in-turn event reopens it.
    #[serde(default)]
    pub stalled: bool,
}

impl Turn {
    /// Claude's time in this turn: its span without the waits (0 while open). A stalled turn's
    /// pending wait is a wait too.
    pub fn claude_ms(&self) -> i64 {
        self.ended_at.map_or(0, |end| {
            let pending = match self.wait_since {
                Some(since) if self.stalled => (end - since).max(0),
                _ => 0,
            };
            (end - self.started_at - self.wait_ms - pending).max(0)
        })
    }

    /// A stalled turn becomes closed for good: its pending wait is counted as a wait.
    fn settle(&mut self) {
        if !self.stalled {
            return;
        }
        self.stalled = false;
        if let (Some(since), Some(end)) = (self.wait_since.take(), self.ended_at) {
            self.wait_ms += (end - since).max(0);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub started_at: i64,
    pub last_event_at: i64,
    /// Idle time over the cap before the first turn.
    pub excess_before_ms: i64,
    pub turns: Vec<Turn>,
}

/// Notifications that come while Claude waits inside a turn (a permission, an MCP dialog): they
/// leave the turn open.
const WAITING_NOTIFICATIONS: [&str; 2] = ["permission_prompt", "elicitation_dialog"];

/// `SessionStart.source` of an auto or manual compaction: it can fire mid-turn and Claude keeps
/// working.
const COMPACT_SOURCE: &str = "compact";

fn is_waiting_notification(event: &HookEvent) -> bool {
    event.name == HookEventName::Notification
        && event
            .notification_type
            .as_deref()
            .is_some_and(|kind| WAITING_NOTIFICATIONS.contains(&kind))
}

/// `SessionEnd`, `SessionStart` (but a compaction) and an idle `Notification` never belong to a
/// turn: one still open then stalled (Claude Code may send no `Stop` after Esc).
fn ends_a_stalled_turn(event: &HookEvent) -> bool {
    match event.name {
        HookEventName::SessionEnd => true,
        HookEventName::SessionStart => event.source.as_deref() != Some(COMPACT_SOURCE),
        HookEventName::Notification => !is_waiting_notification(event),
        _ => false,
    }
}

/// Events Claude sends while working (or waiting) inside a turn.
fn continues_a_turn(event: &HookEvent) -> bool {
    use HookEventName::*;
    is_waiting_notification(event)
        || matches!(
            event.name,
            PreToolUse
                | PostToolUse
                | PostToolUseFailure
                | PermissionRequest
                | PermissionDenied
                | SubagentStart
                | SubagentStop
                | Stop
                | StopFailure
        )
}

impl Session {
    pub fn start(at: i64) -> Self {
        Self {
            started_at: at,
            last_event_at: at,
            excess_before_ms: 0,
            turns: Vec::new(),
        }
    }

    fn open_turn(&mut self) -> Option<&mut Turn> {
        self.turns.last_mut().filter(|turn| turn.ended_at.is_none())
    }

    pub fn apply(&mut self, event: &HookEvent, at: i64, cap_ms: i64) {
        use HookEventName::*;
        // Time never runs backwards: a late event counts as arriving with the last one.
        let at = at.max(self.last_event_at);
        // A turn closed as stalled was only quiet (one long tool call): Claude's next in-turn event
        // reopens it as if it had never closed. Anything else settles it as closed.
        if let Some(last) = self.turns.last_mut().filter(|turn| turn.stalled) {
            if continues_a_turn(event) {
                last.ended_at = None;
                last.stalled = false;
            } else {
                last.settle();
            }
        }
        // A new prompt closes a turn left open (Esc gives no Stop) where it last showed signs of
        // life; so do the events that say Claude is not working on it, so a stalled turn never
        // absorbs the idle time before them.
        if event.name == UserPromptSubmit || ends_a_stalled_turn(event) {
            self.close(at);
        }
        let gap = at - self.last_event_at;
        if self.open_turn().is_none() && gap > cap_ms {
            let excess = gap - cap_ms;
            match self.turns.last_mut() {
                Some(last) => last.excess_after_ms += excess,
                None => self.excess_before_ms += excess,
            }
        }
        self.last_event_at = at;

        if event.name == UserPromptSubmit {
            let work = event.work.as_ref();
            let prompt_id = work.and_then(|w| w.prompt_id.clone());
            self.turns.push(Turn {
                id: prompt_id
                    .clone()
                    .unwrap_or_else(|| format!("t{}", self.turns.len() + 1)),
                prompt_id,
                prompt: work.and_then(|w| w.prompt.clone()).unwrap_or_default(),
                reply: None,
                tools: BTreeMap::new(),
                started_at: at,
                ended_at: None,
                last_event_at: at,
                wait_ms: 0,
                wait_since: None,
                excess_after_ms: 0,
                stalled: false,
            });
            return;
        }

        let Some(turn) = self.open_turn() else {
            return;
        };
        turn.last_event_at = at;
        match event.name {
            PreToolUse | PostToolUse | PostToolUseFailure => {
                if event.name == PreToolUse {
                    if let Some(name) = &event.tool_name {
                        *turn.tools.entry(name.clone()).or_insert(0) += 1;
                    }
                }
                if let Some(since) = turn.wait_since.take() {
                    turn.wait_ms += at - since;
                }
                // The question is the user's to answer: Claude waits from here.
                if event.name == PreToolUse
                    && event.tool_name.as_deref() == Some(ASK_USER_QUESTION_TOOL)
                {
                    turn.wait_since = Some(at);
                }
            }
            PermissionRequest => turn.wait_since = Some(at),
            Stop | StopFailure => {
                turn.ended_at = Some(at);
                // A request never answered (a denied permission) is still waiting, not Claude.
                if let Some(since) = turn.wait_since.take() {
                    turn.wait_ms += at - since;
                }
                if event.name == Stop {
                    turn.reply = event.work.as_ref().and_then(|w| w.reply.clone());
                }
            }
            _ => {}
        }
    }

    /// Closes the open turn at its last event (the session is over or went quiet).
    pub fn close(&mut self, _at: i64) {
        if let Some(last) = self.turns.last_mut() {
            last.settle();
        }
        if let Some(turn) = self.open_turn() {
            turn.ended_at = Some(turn.last_event_at);
            if let Some(since) = turn.wait_since.take() {
                turn.wait_ms += (turn.last_event_at - since).max(0);
            }
        }
    }

    /// [`Self::close`] for a turn that went quiet longer than the cap: it may still be running
    /// (a long build), so its next in-turn event reopens it.
    pub fn close_stalled(&mut self) {
        // A pending wait stays pending: if the turn reopens, it ends with the next tool event.
        if let Some(turn) = self.open_turn() {
            turn.ended_at = Some(turn.last_event_at);
            turn.stalled = true;
        }
    }

    pub fn claude_ms(&self) -> i64 {
        self.turns.iter().map(Turn::claude_ms).sum()
    }

    pub fn total_ms(&self) -> i64 {
        let excess: i64 =
            self.excess_before_ms + self.turns.iter().map(|t| t.excess_after_ms).sum::<i64>();
        self.last_event_at - self.started_at - excess
    }

    /// Each turn's share of the total: its own time plus the gap that follows it (the first also
    /// takes the time before it). The shares add up to [`Self::total_ms`].
    pub fn turn_totals(&self) -> Vec<i64> {
        self.turns
            .iter()
            .enumerate()
            .map(|(i, turn)| {
                let end = self
                    .turns
                    .get(i + 1)
                    .map_or(self.last_event_at, |next| next.started_at);
                let mut total = end - turn.started_at - turn.excess_after_ms;
                if i == 0 {
                    total += turn.started_at - self.started_at - self.excess_before_ms;
                }
                total
            })
            .collect()
    }

    /// The total as of `now`: time since the last event counts, with idle time capped unless a
    /// turn is open.
    pub fn live_total_ms(&self, now: i64, cap_ms: i64) -> i64 {
        let since = (now - self.last_event_at).max(0);
        let open = self.turns.last().is_some_and(|t| t.ended_at.is_none());
        let idle = if open { 0 } else { (since - cap_ms).max(0) };
        self.total_ms() + since - idle
    }
}

#[cfg(test)]
#[path = "timing_tests.rs"]
mod tests;
