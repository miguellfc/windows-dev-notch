//! `notch:*` channels and events (`src/shared/ipc/contract.ts`, `src/shared/integrations/registry.ts`).

use serde::{Deserialize, Serialize};

use super::Validate;

string_enum! {
    /// `notchModeSchema`.
    pub enum NotchMode {
        Compact = "compact",
        Peek = "peek",
        Alert = "alert",
        Expanded = "expanded",
        Permission = "permission",
        Question = "question",
        Reminders = "reminders",
        Notes = "notes",
        Gmail = "gmail",
        Reviews = "reviews",
        Redmine = "redmine",
        Mini = "mini",
        Hidden = "hidden",
    }
}

string_enum! {
    /// What the renderer asks the notch to do (`notch:request`).
    pub enum Intent {
        Expand = "expand",
        Dismiss = "dismiss",
        Toggle = "toggle",
        Next = "next",
        PinMini = "pin-mini",
        UnpinMini = "unpin-mini",
        OpenPending = "open-pending",
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RequestInput {
    pub intent: Intent,
}

impl Validate for RequestInput {}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PointerInput {
    pub inside: bool,
}

impl Validate for PointerInput {}

string_enum! {
    /// `viewIntegrationIds`: integrations with a view of their own in the notch.
    pub enum IntegrationId {
        Reminders = "reminders",
        Notes = "notes",
        Gmail = "gmail",
        Reviews = "reviews",
        Redmine = "redmine",
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OpenIntegrationInput {
    pub id: IntegrationId,
}

impl Validate for OpenIntegrationInput {}

/// `notch:capsule-rect`: the painted capsule's box in the window, in DIP.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CapsuleRectInput {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Validate for CapsuleRectInput {
    fn validate(&self) -> Result<(), String> {
        // `!(a >= b)` also refuses NaN, like zod.
        if !(self.x >= 0.0 && self.y >= 0.0) {
            return Err("x and y must not be negative".into());
        }
        if !(self.width > 0.0 && self.height > 0.0) {
            return Err("width and height must be positive".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn enums_deserialize_from_a_string_only() {
        assert_eq!(
            serde_json::from_value::<NotchMode>(json!("compact")).ok(),
            Some(NotchMode::Compact)
        );
        assert_eq!(
            serde_json::from_value::<Intent>(json!("pin-mini")).ok(),
            Some(Intent::PinMini)
        );
        assert!(serde_json::from_value::<NotchMode>(json!({ "compact": null })).is_err());
        assert!(serde_json::from_value::<Intent>(json!({ "expand": null })).is_err());
        assert!(serde_json::from_value::<NotchMode>(json!("Compact")).is_err());
        for mode in NotchMode::ALL {
            assert_eq!(serde_json::to_value(mode).ok(), Some(json!(mode.as_str())));
        }
    }
}
