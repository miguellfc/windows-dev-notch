//! `app:*` channels (`src/shared/ipc/contract.ts`, `src/shared/app-info.ts`).

use serde::{Deserialize, Serialize};

use super::{length, Validate};

/// `appInfoSchema`: every field non-empty.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub platform: String,
}

impl Validate for AppInfo {
    fn validate(&self) -> Result<(), String> {
        if [&self.name, &self.version, &self.platform]
            .iter()
            .any(|field| length(field) == 0)
        {
            return Err("app info fields must not be empty".into());
        }
        Ok(())
    }
}

/// `runtimeSchema`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Runtime {
    pub is_packaged: bool,
    pub shortcut_registered: bool,
}

impl Validate for Runtime {}

string_enum! {
    /// `controlCenterPageSchema`: Control Center pages the notch may open directly.
    pub enum ControlCenterPage {
        Gmail = "gmail",
        CodeReview = "code-review",
        Redmine = "redmine",
    }
}

/// Input of `app:open-control-center` when sent (the whole input is optional).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OpenControlCenterInput {
    pub page: ControlCenterPage,
}

impl Validate for OpenControlCenterInput {}
