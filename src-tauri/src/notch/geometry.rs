//! Port of `src/shared/notch/geometry.ts`: capsule sizes, window bounds and resize order, in DIP.
//! `tests/parity/geometry.json` keeps both sides equal.

use super::state::NotchMode;

/// A rectangle in DIP.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A size in DIP.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

const fn size(width: f64, height: f64) -> Size {
    Size { width, height }
}

/// Every mode but `hidden` (`VisibleMode` in TS).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum VisibleMode {
    Compact,
    Peek,
    Alert,
    Expanded,
    Permission,
    Question,
    Reminders,
    System,
    Notes,
    Gmail,
    Reviews,
    Redmine,
    Mini,
}

impl VisibleMode {
    pub const ALL: [Self; 13] = [
        Self::Compact,
        Self::Peek,
        Self::Alert,
        Self::Expanded,
        Self::Permission,
        Self::Question,
        Self::Reminders,
        Self::System,
        Self::Notes,
        Self::Gmail,
        Self::Reviews,
        Self::Redmine,
        Self::Mini,
    ];

    /// The same string as the matching `NotchMode`.
    pub fn as_str(self) -> &'static str {
        self.notch_mode().as_str()
    }

    pub fn notch_mode(self) -> NotchMode {
        match self {
            Self::Compact => NotchMode::Compact,
            Self::Peek => NotchMode::Peek,
            Self::Alert => NotchMode::Alert,
            Self::Expanded => NotchMode::Expanded,
            Self::Permission => NotchMode::Permission,
            Self::Question => NotchMode::Question,
            Self::Reminders => NotchMode::Reminders,
            Self::System => NotchMode::System,
            Self::Notes => NotchMode::Notes,
            Self::Gmail => NotchMode::Gmail,
            Self::Reviews => NotchMode::Reviews,
            Self::Redmine => NotchMode::Redmine,
            Self::Mini => NotchMode::Mini,
        }
    }

    /// `None` for `hidden`, which has no capsule.
    pub fn from_notch_mode(mode: NotchMode) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|visible| visible.notch_mode() == mode)
    }
}

/// The home panel, one size whatever it lists (`EXPANDED_SIZE`).
pub const EXPANDED_SIZE: Size = size(712.0, 300.0);

/// The Gmail panel: the list, and the reader of one message (the window is sized for the reader).
pub const GMAIL_LIST_SIZE: Size = size(420.0, 382.0);
pub const GMAIL_READER_SIZE: Size = size(520.0, 440.0);

/// Size of the Gmail panel: the reader while a message is open, else the list.
pub fn gmail_size_for(reading: bool) -> Size {
    if reading {
        GMAIL_READER_SIZE
    } else {
        GMAIL_LIST_SIZE
    }
}

pub const QUESTION_SIZE: Size = size(520.0, 504.0);
pub const REVIEWS_SIZE: Size = size(520.0, 560.0);
pub const REDMINE_SIZE: Size = size(520.0, 560.0);

/// Size of the visible capsule per mode, in DIP (`CAPSULE_SIZES`).
pub const CAPSULE_SIZES: [(VisibleMode, Size); 13] = [
    (VisibleMode::Compact, size(491.0, 36.0)),
    (VisibleMode::Peek, size(177.0, 36.0)),
    (VisibleMode::Alert, size(320.0, 44.0)),
    (VisibleMode::Expanded, EXPANDED_SIZE),
    (VisibleMode::Permission, size(480.0, 300.0)),
    (VisibleMode::Question, QUESTION_SIZE),
    (VisibleMode::Reminders, size(420.0, 320.0)),
    (VisibleMode::System, size(520.0, 280.0)),
    (VisibleMode::Notes, size(420.0, 320.0)),
    (VisibleMode::Gmail, GMAIL_READER_SIZE),
    (VisibleMode::Reviews, REVIEWS_SIZE),
    (VisibleMode::Redmine, REDMINE_SIZE),
    (VisibleMode::Mini, size(96.0, 4.0)),
];

/// The capsule size of a mode.
pub fn capsule_size(mode: VisibleMode) -> Size {
    CAPSULE_SIZES
        .iter()
        .find(|(candidate, _)| *candidate == mode)
        .map(|(_, size)| *size)
        .expect("every visible mode has a size")
}

/// The zones of the compact capsule, in px (`COMPACT_ZONE`).
/// The horizontal padding and the capsule's border.
const ZONE_PADDING: f64 = 30.0;
/// The 1 px line and the room around it.
const ZONE_DIVIDER: f64 = 15.0;
/// Time and date.
const ZONE_LEFT: f64 = 147.0;
/// CPU, RAM, storage and connection, without the battery.
const ZONE_SYSTEM: f64 = 235.0;
/// What the battery adds.
const ZONE_BATTERY: f64 = 63.5;

/// Each integration block of the compact capsule with its gap (`CAPSULE_BLOCK`).
const BLOCK_CLAUDE: f64 = 97.0;
const BLOCK_MAIL: f64 = 48.5;
const BLOCK_REVIEW: f64 = 48.5;
const BLOCK_REDMINE: f64 = 71.0;

/// The system zone of the compact capsule (`system` in `CompactContent`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SystemZone {
    pub battery: bool,
}

/// The integration blocks of the compact capsule (`blocks` in `CompactContent`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapsuleBlocks {
    pub claude: bool,
    pub mail: bool,
    pub reviews: i64,
    pub redmine: bool,
}

fn block(shown: bool, width: f64) -> f64 {
    if shown {
        width
    } else {
        0.0
    }
}

/// Width of the compact capsule: time and date always; the integration blocks after a divider when
/// there is one; the system zone after another divider while there is a sample.
pub fn compact_width_for(system: Option<SystemZone>, blocks: CapsuleBlocks) -> f64 {
    let mut width = ZONE_PADDING + ZONE_LEFT;
    let middle = block(blocks.claude, BLOCK_CLAUDE)
        + block(blocks.mail, BLOCK_MAIL)
        + blocks.reviews.clamp(0, 2) as f64 * BLOCK_REVIEW
        + block(blocks.redmine, BLOCK_REDMINE);
    if middle > 0.0 {
        width += ZONE_DIVIDER + middle;
    }
    if let Some(system) = system {
        width += ZONE_DIVIDER + ZONE_SYSTEM + block(system.battery, ZONE_BATTERY);
    }
    width.ceil()
}

/// Transparent room around the capsule so its shadow is not clipped by the window edge.
pub const SHADOW_MARGIN_SIDE: f64 = 56.0;
pub const SHADOW_MARGIN_TOP: f64 = 6.0;
pub const SHADOW_MARGIN_BOTTOM: f64 = 72.0;

/// Constant window width: the widest capsule plus its shadow, rounded up to an even number. The
/// widest compact capsule (every block, the system zone and the battery) is 819 wide; the
/// widest panel is 712. A test recomputes it from the formula, so it cannot drift.
pub const WINDOW_WIDTH: f64 = 932.0;

#[cfg(test)]
fn computed_window_width() -> f64 {
    let widest_compact = compact_width_for(
        Some(SystemZone { battery: true }),
        CapsuleBlocks {
            claude: true,
            mail: true,
            reviews: 2,
            redmine: true,
        },
    );
    let widest = CAPSULE_SIZES
        .iter()
        .map(|(_, size)| size.width)
        .fold(widest_compact, f64::max);
    ((widest + SHADOW_MARGIN_SIDE * 2.0) / 2.0).ceil() * 2.0
}

/// Distance from the window's top to the capsule: the shadow room above it, except for the
/// pinned mini, which sits flush against the top edge of the screen.
pub fn capsule_top_for(mode: VisibleMode) -> f64 {
    if mode == VisibleMode::Mini {
        0.0
    } else {
        SHADOW_MARGIN_TOP
    }
}

/// Window height for a mode: the capsule plus the shadow room above and below it.
pub fn window_height_for(mode: VisibleMode) -> f64 {
    capsule_top_for(mode) + capsule_size(mode).height + SHADOW_MARGIN_BOTTOM
}

/// JavaScript's `Math.round`: halves go toward +infinity (Rust's `round` goes away from zero).
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// Window bounds for a mode: fixed width, horizontally centred at the top of the given work area.
pub fn window_bounds_for(mode: VisibleMode, work_area: Rect) -> Rect {
    let width = WINDOW_WIDTH;
    Rect {
        x: js_round(work_area.x + (work_area.width - width) / 2.0),
        y: js_round(work_area.y),
        width,
        height: window_height_for(mode),
    }
}

/// Whether a change grows the window (only the height changes between modes).
pub fn grows_window(from: VisibleMode, to: VisibleMode) -> bool {
    window_height_for(to) >= window_height_for(from)
}

/// The order of the window resize and the animation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResizeOrder {
    ResizeFirst,
    AnimateFirst,
}

impl ResizeOrder {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ResizeFirst => "resize-first",
            Self::AnimateFirst => "animate-first",
        }
    }
}

/// Growing: enlarge the transparent window first, then animate inside it. Shrinking: animate
/// first, then shrink the window.
pub fn resize_order(from: VisibleMode, to: VisibleMode) -> ResizeOrder {
    if grows_window(from, to) {
        ResizeOrder::ResizeFirst
    } else {
        ResizeOrder::AnimateFirst
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_width_constant_matches_its_formula() {
        assert_eq!(WINDOW_WIDTH, computed_window_width());
    }

    #[test]
    fn js_round_rounds_halves_up() {
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.4), -2.0);
    }
}
