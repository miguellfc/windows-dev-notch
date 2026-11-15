//! `apps:open` (`src/shared/ipc/contract.ts`, `appIds` in `src/shared/integrations/registry.ts`).

use serde::{Deserialize, Serialize};

use super::Validate;

string_enum! {
    /// `appIds`: tiles that launch a real app outside the notch.
    pub enum AppId {
        Terminal = "terminal",
        Claude = "claude",
    }
}

/// Input of `apps:open`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OpenAppInput {
    pub app: AppId,
}

impl Validate for OpenAppInput {}

/// Output of `apps:open`: `ok` is false only when nothing could be launched.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OpenAppResult {
    pub ok: bool,
}

impl Validate for OpenAppResult {}

input_entry!(OpenAppInput);
