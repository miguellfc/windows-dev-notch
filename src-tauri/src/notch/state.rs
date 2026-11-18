//! Port of `src/shared/notch/state.ts`: the pure mode state machine. The rules and the order of
//! the checks are the TS ones; `tests/parity/notch-traces.json` keeps both sides equal.

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

pub use crate::contract::notch::{IntegrationId, NotchMode};

/// Modes that show the panel and therefore own the keyboard focus.
pub const PANEL_MODES: [NotchMode; 9] = [
    NotchMode::Expanded,
    NotchMode::Permission,
    NotchMode::Question,
    NotchMode::Reminders,
    NotchMode::System,
    NotchMode::Notes,
    NotchMode::Gmail,
    NotchMode::Reviews,
    NotchMode::Redmine,
];

/// How long the new-mail alert stays in the capsule (main owns the timer).
pub const MAIL_ALERT_MS: u64 = 6_000;
/// How long compact stays after a left click on the pill if the pointer never enters it.
pub const STICKY_COMPACT_MS: u64 = 3_000;
/// How long the first-review alert stays.
pub const REVIEW_ALERT_MS: u64 = 6_000;
/// How long the end-of-day Redmine alert stays.
pub const REDMINE_ALERT_MS: u64 = 6_000;

/// The two kinds of pending Claude item: a permission request and an `AskUserQuestion` question.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClaudeItem {
    Permission,
    Question,
}

/// How the capsule yields to the window in front: nothing, or disappear (fullscreen).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Yielding {
    None,
    Hidden,
}

/// What the open panel shows: the integrations row, a Claude item or one integration. It is the
/// same plain string as in TS (`'home' | 'permission' | 'question' | IntegrationId`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotchView {
    Home,
    Permission,
    Question,
    Integration(IntegrationId),
}

impl NotchView {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Permission => "permission",
            Self::Question => "question",
            Self::Integration(id) => id.as_str(),
        }
    }
}

impl From<ClaudeItem> for NotchView {
    fn from(item: ClaudeItem) -> Self {
        match item {
            ClaudeItem::Permission => Self::Permission,
            ClaudeItem::Question => Self::Question,
        }
    }
}

impl Serialize for NotchView {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for NotchView {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        match text.as_str() {
            "home" => Ok(Self::Home),
            "permission" => Ok(Self::Permission),
            "question" => Ok(Self::Question),
            other => IntegrationId::ALL
                .iter()
                .find(|id| id.as_str() == other)
                .map(|id| Self::Integration(*id))
                .ok_or_else(|| D::Error::custom(format!("unknown notch view `{other}`"))),
        }
    }
}

/// `NotchState`: field names are the TS ones (camelCase on the wire).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotchState {
    pub expanded: bool,
    pub yielding: Yielding,
    pub user_hidden: bool,
    pub pointer_inside: bool,
    /// The user pinned the thin pill (right click on the compact capsule). Never persisted.
    pub pinned_mini: bool,
    /// Compact right after a left click on the pill, wherever the pointer is.
    pub sticky_compact: bool,
    /// A Claude permission request is waiting for the user.
    pub attention: bool,
    /// At least one Claude question is waiting for an answer.
    pub question: bool,
    /// Which pending Claude item arrived first.
    pub claude_first: ClaudeItem,
    /// At least one reminder is due and not yet dismissed.
    pub reminder_due: bool,
    /// New mail arrived: the lowest-priority alert.
    pub mail_alert: bool,
    /// Own PR/MRs got their first review (never together with mail: the newer replaces the older).
    pub review_alert: bool,
    /// Hours logged today are under the daily target at the end of the day.
    pub redmine_alert: bool,
    pub view: NotchView,
}

impl Default for NotchState {
    /// `initialNotchState`.
    fn default() -> Self {
        Self {
            expanded: false,
            yielding: Yielding::None,
            user_hidden: false,
            pointer_inside: false,
            pinned_mini: false,
            sticky_compact: false,
            attention: false,
            question: false,
            claude_first: ClaudeItem::Permission,
            reminder_due: false,
            mail_alert: false,
            review_alert: false,
            redmine_alert: false,
            view: NotchView::Home,
        }
    }
}

/// `NotchEvent`: `{ "type": "pointer", "inside": true }` and so on.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum NotchEvent {
    Pointer { inside: bool },
    PinMini,
    UnpinMini,
    StickyEnd,
    Expand,
    Show,
    Toggle,
    Dismiss,
    Foreground { verdict: Yielding },
    UserVisibility { hidden: bool },
    OpenIntegration { id: IntegrationId },
    Back,
    Attention { on: bool },
    Reminders { due: bool },
    Mail { on: bool },
    Review { on: bool },
    Redmine { on: bool },
    Question { on: bool },
    ClaudeFirst { kind: ClaudeItem },
    Next,
    OpenPending,
}

/// The mode of an integration's view (same names).
fn integration_mode(id: IntegrationId) -> NotchMode {
    match id {
        IntegrationId::Reminders => NotchMode::Reminders,
        IntegrationId::System => NotchMode::System,
        IntegrationId::Notes => NotchMode::Notes,
        IntegrationId::Gmail => NotchMode::Gmail,
        IntegrationId::Reviews => NotchMode::Reviews,
        IntegrationId::Redmine => NotchMode::Redmine,
    }
}

/// Explicit user intent (expand) beats alerts; a pending alert shows even over a hidden capsule;
/// hiding beats the pinned mini, the pinned mini beats hover, and hover turns peek into compact.
pub fn notch_mode(state: &NotchState) -> NotchMode {
    if state.expanded {
        return match state.view {
            NotchView::Home => NotchMode::Expanded,
            NotchView::Permission => NotchMode::Permission,
            NotchView::Question => NotchMode::Question,
            NotchView::Integration(id) => integration_mode(id),
        };
    }
    if state.attention
        || state.question
        || state.reminder_due
        || state.mail_alert
        || state.review_alert
        || state.redmine_alert
    {
        return NotchMode::Alert;
    }
    if is_capsule_hidden(state) {
        return NotchMode::Hidden;
    }
    if state.pinned_mini {
        return NotchMode::Mini;
    }
    if state.pointer_inside || state.sticky_compact {
        NotchMode::Compact
    } else {
        NotchMode::Peek
    }
}

/// The capsule is off screen apart from alerts: hidden by the user or yielding, no panel open.
pub fn is_capsule_hidden(state: &NotchState) -> bool {
    !state.expanded && (state.user_hidden || state.yielding == Yielding::Hidden)
}

/// Opening a panel shows the capsule again, except when it opens from an alert over a hidden
/// capsule: closing that panel goes back to hidden.
fn user_hidden_on_open(state: &NotchState) -> bool {
    state.user_hidden && (state.expanded || notch_mode(state) == NotchMode::Alert)
}

/// The capsule is in `alert` and no permission, question or due reminder owns it.
fn low_alert_owns_capsule(state: &NotchState) -> bool {
    notch_mode(state) == NotchMode::Alert
        && !state.attention
        && !state.question
        && !state.reminder_due
}

/// Whether the alert capsule shows the new-mail alert.
pub fn mail_alert_shown(state: &NotchState) -> bool {
    state.mail_alert && low_alert_owns_capsule(state)
}

/// Whether the alert capsule shows the first-review alert.
pub fn review_alert_shown(state: &NotchState) -> bool {
    state.review_alert && low_alert_owns_capsule(state)
}

/// Whether the alert capsule shows the end-of-day Redmine alert.
pub fn redmine_alert_shown(state: &NotchState) -> bool {
    state.redmine_alert && low_alert_owns_capsule(state)
}

/// The pending Claude item the panel shows first: a permission or a question, whichever arrived first.
pub fn first_claude_item(state: &NotchState) -> Option<ClaudeItem> {
    if state.attention && state.question {
        return Some(state.claude_first);
    }
    if state.attention {
        return Some(ClaudeItem::Permission);
    }
    state.question.then_some(ClaudeItem::Question)
}

/// A panel opened while something is pending lands on it.
fn opening_view(state: &NotchState) -> NotchView {
    if state.expanded {
        return state.view;
    }
    if let Some(claude) = first_claude_item(state) {
        return claude.into();
    }
    if state.reminder_due {
        return NotchView::Integration(IntegrationId::Reminders);
    }
    if state.mail_alert {
        return NotchView::Integration(IntegrationId::Gmail);
    }
    if state.review_alert {
        return NotchView::Integration(IntegrationId::Reviews);
    }
    if state.redmine_alert {
        NotchView::Integration(IntegrationId::Redmine)
    } else {
        NotchView::Home
    }
}

/// Opening a panel spends the low-priority alerts: they are never shown with a panel open.
fn spend_alerts(state: &mut NotchState) {
    state.mail_alert = false;
    state.review_alert = false;
    state.redmine_alert = false;
}

/// Pure transition function. The state is a value, so "nothing changed" is `result == *state`.
pub fn reduce_notch(state: &NotchState, event: &NotchEvent) -> NotchState {
    let mut next = apply_event(state, event);
    // A hidden window never receives pointerleave, so forget the pointer when the capsule disappears.
    if next.pointer_inside && notch_mode(&next) == NotchMode::Hidden {
        next.pointer_inside = false;
    }
    // The sticky compact only bridges the click on the pill and the pointer reaching compact.
    if next.sticky_compact && (next.expanded || next.pinned_mini || is_capsule_hidden(&next)) {
        next.sticky_compact = false;
    }
    next
}

/// Applies a change to the Claude flags. An open permission card moves at once to the Claude item
/// that now comes first, or back to the integrations row when none is left.
fn with_permission_card(state: &NotchState, change: impl FnOnce(&mut NotchState)) -> NotchState {
    let mut changed = *state;
    change(&mut changed);
    if changed == *state || !state.expanded || state.view != NotchView::Permission {
        return changed;
    }
    let claude = first_claude_item(&changed);
    if claude == Some(ClaudeItem::Permission) {
        return changed;
    }
    changed.view = claude.map_or(NotchView::Home, NotchView::from);
    changed
}

fn apply_event(state: &NotchState, event: &NotchEvent) -> NotchState {
    let mut next = *state;
    match *event {
        NotchEvent::Pointer { inside } => {
            // Entering ends the sticky compact: from then on, leaving rests in peek.
            next.pointer_inside = inside;
            if inside {
                next.sticky_compact = false;
            }
        }
        NotchEvent::StickyEnd => next.sticky_compact = false,
        NotchEvent::PinMini => {
            // Only the resting or hovered capsule takes a right click.
            if matches!(notch_mode(state), NotchMode::Peek | NotchMode::Compact) {
                next.pinned_mini = true;
            }
        }
        NotchEvent::UnpinMini => {
            // The click came from the pill, above compact: compact sticks until the pointer has been on it.
            if state.pinned_mini {
                next.pinned_mini = false;
                next.sticky_compact = true;
            }
        }
        NotchEvent::Expand => {
            next.expanded = true;
            next.user_hidden = user_hidden_on_open(state);
            spend_alerts(&mut next);
            next.view = opening_view(state);
        }
        NotchEvent::Show => {
            next.expanded = true;
            next.user_hidden = false;
            spend_alerts(&mut next);
            next.view = opening_view(state);
        }
        NotchEvent::Toggle => {
            if state.expanded {
                next.expanded = false;
                next.view = NotchView::Home;
            } else {
                next.expanded = true;
                next.user_hidden = user_hidden_on_open(state);
                spend_alerts(&mut next);
                next.view = opening_view(state);
            }
        }
        NotchEvent::Dismiss => {
            // Closing always forgets the view: the panel reopens on the integrations row.
            next.expanded = false;
            next.view = NotchView::Home;
        }
        NotchEvent::Foreground { verdict } => next.yielding = verdict,
        NotchEvent::UserVisibility { hidden } => {
            next.user_hidden = hidden;
            if hidden {
                next.expanded = false;
                next.view = NotchView::Home;
            }
        }
        NotchEvent::OpenIntegration { id } => {
            next.expanded = true;
            next.user_hidden = user_hidden_on_open(state);
            spend_alerts(&mut next);
            next.view = NotchView::Integration(id);
        }
        // Attention never opens or closes the panel; an open permission card moves on to what waits next.
        NotchEvent::Attention { on } => {
            return with_permission_card(state, |changed| changed.attention = on)
        }
        NotchEvent::ClaudeFirst { kind } => {
            return with_permission_card(state, |changed| changed.claude_first = kind)
        }
        // Like attention, a due reminder never opens or closes the panel.
        NotchEvent::Reminders { due } => next.reminder_due = due,
        // The lowest-priority alerts: with a panel open they are dropped, not queued, and the
        // newest of mail, review and Redmine replaces the others.
        NotchEvent::Mail { on } => {
            if !on {
                next.mail_alert = false;
            } else if !state.expanded {
                next.mail_alert = true;
                next.review_alert = false;
                next.redmine_alert = false;
            }
        }
        NotchEvent::Review { on } => {
            if !on {
                next.review_alert = false;
            } else if !state.expanded {
                next.review_alert = true;
                next.mail_alert = false;
                next.redmine_alert = false;
            }
        }
        NotchEvent::Redmine { on } => {
            if !on {
                next.redmine_alert = false;
            } else if !state.expanded {
                next.redmine_alert = true;
                next.mail_alert = false;
                next.review_alert = false;
            }
        }
        // Never opens or closes the panel: an open question card asks for the next item itself (`next`).
        NotchEvent::Question { on } => {
            return with_permission_card(state, |changed| changed.question = on)
        }
        NotchEvent::Next => {
            if !state.expanded || !matches!(state.view, NotchView::Question | NotchView::Permission)
            {
                return *state;
            }
            match first_claude_item(state) {
                Some(claude) => next.view = claude.into(),
                None => {
                    next.expanded = false;
                    next.view = NotchView::Home;
                }
            }
        }
        // Only from the integrations row, and only Claude items: a late click never moves another view.
        NotchEvent::OpenPending => {
            if state.expanded && state.view == NotchView::Home {
                if let Some(claude) = first_claude_item(state) {
                    next.view = claude.into();
                }
            }
        }
        NotchEvent::Back => {
            if state.expanded {
                next.view = NotchView::Home;
            }
        }
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(events: &[NotchEvent]) -> NotchState {
        events.iter().fold(NotchState::default(), |state, event| {
            reduce_notch(&state, event)
        })
    }

    const ATTENTION: NotchEvent = NotchEvent::Attention { on: true };
    const QUESTION: NotchEvent = NotchEvent::Question { on: true };

    #[test]
    fn open_pending_goes_from_home_to_a_pending_permission() {
        let state = run(&[NotchEvent::Expand, ATTENTION, NotchEvent::OpenPending]);
        assert_eq!(state.view, NotchView::Permission);
        assert_eq!(notch_mode(&state), NotchMode::Permission);
    }

    #[test]
    fn open_pending_goes_from_home_to_a_pending_question() {
        let state = run(&[NotchEvent::Expand, QUESTION, NotchEvent::OpenPending]);
        assert_eq!(state.view, NotchView::Question);
        assert_eq!(notch_mode(&state), NotchMode::Question);
    }

    #[test]
    fn open_pending_lands_on_the_oldest_item() {
        for (kind, view) in [
            (ClaudeItem::Question, NotchView::Question),
            (ClaudeItem::Permission, NotchView::Permission),
        ] {
            let state = run(&[
                NotchEvent::Expand,
                ATTENTION,
                QUESTION,
                NotchEvent::ClaudeFirst { kind },
                NotchEvent::OpenPending,
            ]);
            assert_eq!(state.view, view);
        }
    }

    #[test]
    fn open_pending_changes_nothing_with_no_claude_item_pending() {
        let idle = run(&[NotchEvent::Expand]);
        assert_eq!(reduce_notch(&idle, &NotchEvent::OpenPending), idle);
        // Only Claude items count: the card never jumps to a due reminder.
        let reminder = run(&[NotchEvent::Expand, NotchEvent::Reminders { due: true }]);
        assert_eq!(reduce_notch(&reminder, &NotchEvent::OpenPending), reminder);
    }

    #[test]
    fn open_pending_changes_nothing_outside_the_open_home_view() {
        let peek = NotchState::default();
        assert_eq!(reduce_notch(&peek, &NotchEvent::OpenPending), peek);
        let alert = run(&[ATTENTION]);
        assert_eq!(reduce_notch(&alert, &NotchEvent::OpenPending), alert);
        let integration = run(&[
            NotchEvent::OpenIntegration {
                id: IntegrationId::Notes,
            },
            ATTENTION,
        ]);
        assert_eq!(
            reduce_notch(&integration, &NotchEvent::OpenPending),
            integration
        );
    }
}
