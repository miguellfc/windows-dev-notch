//! `gmail:*` channels and events (`src/shared/gmail/schema.ts`), plus the Google responses the
//! client reads ([`google`]) and `parseClientFile` ([`parse_client_file`]).
//!
//! Every IPC object is a `z.strictObject` (`deny_unknown_fields`). Lengths are zod's (code
//! points, see `contract::length`); the producers cut texts by UTF-16 units (`http::clip`), never
//! past these. No token, client secret or Google URL ever crosses IPC except the links of an
//! opened mail, which are refined to `http`/`https`: the strict outputs refuse any other field.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::text::js_trim;
use super::{at_most, int_in, len_in, max_len, nullable, present, safe_int_min, Validate};

/// `GMAIL_RECENT_LIMIT`: `gmail:recent` answers at most this many mails.
pub const RECENT_LIMIT: usize = 5;
/// `GMAIL_UNREAD_CAP`: unread counts are capped here (the UI shows 100 as "99+").
pub const UNREAD_CAP: u32 = 100;
/// `GMAIL_BODY_MAX`: a mail body is cut to this many characters (`truncated: true`).
pub const BODY_MAX: usize = 50_000;
/// `GMAIL_LINKS_MAX`: at most this many links of a mail (opened by index `0..LINKS_MAX`).
pub const LINKS_MAX: usize = 50;
/// `GMAIL_LINK_TEXT_MAX`: link text is cut to this many characters.
pub const LINK_TEXT_MAX: usize = 200;
/// `GMAIL_URL_MAX`: longer link URLs are left out of a mail's links.
pub const URL_MAX: usize = 2048;
/// `GMAIL_HEADER_MAX`: sender name, sender address and subject of an opened mail.
pub const HEADER_MAX: usize = 1000;
/// `gmailIdSchema` (and the new-mail id): Gmail ids are short hex strings.
pub const ID_MAX: usize = 64;
/// The client id and secret of a client file, bounded like the settings fields they end in.
pub const CLIENT_MAX: usize = crate::settings::validate::GMAIL_CLIENT_MAX;

string_enum! {
    /// `gmailStatusSchema`.
    pub enum GmailStatus {
        Unconfigured = "unconfigured",
        SignedOut = "signed-out",
        SigningIn = "signing-in",
        Ok = "ok",
        Offline = "offline",
        Expired = "expired",
    }
}

string_enum! {
    /// `z.literal('scope')`: why the session is `expired` (it lacks the full-mail permission).
    pub enum GmailExpiredReason {
        Scope = "scope",
    }
}

string_enum! {
    /// Output of `gmail:sign-in`.
    pub enum GmailSignInResult {
        Ok = "ok",
        Cancelled = "cancelled",
        Error = "error",
    }
}

/// `isWebUrl`: `/^https?:\/\//i` on the JS-trimmed URL. Only `http`/`https` links are offered.
pub fn is_web_url(url: &str) -> bool {
    // `/i` without `u` folds ASCII only: a byte-wise ASCII comparison is exact.
    let url = js_trim(url).as_bytes();
    let starts = |prefix: &[u8]| {
        url.len() >= prefix.len() && url[..prefix.len()].eq_ignore_ascii_case(prefix)
    };
    starts(b"http://") || starts(b"https://")
}

/// `z.string().min(1).max(64)`: a Gmail id.
fn gmail_id(name: &str, value: &str) -> Result<(), String> {
    len_in(name, value, 1, ID_MAX)
}

/// `gmailStateSchema`: output of `gmail:get-state`, payload of `gmail:state`. `Debug` never
/// prints the account.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GmailState {
    pub status: GmailStatus,
    /// Address of the connected account.
    #[serde(deserialize_with = "nullable")]
    pub account: Option<String>,
    /// `z.int().min(0).max(100)`, `None` until the first count.
    #[serde(deserialize_with = "nullable")]
    pub unread: Option<u32>,
    /// ISO time (UTC, with milliseconds and `Z`) of the last successful query.
    #[serde(deserialize_with = "nullable")]
    pub updated_at: Option<String>,
    /// False when the session lives only in memory and will not survive a restart.
    pub persistent: bool,
    /// Why the session is `expired`; `None` otherwise.
    #[serde(deserialize_with = "nullable")]
    pub reason: Option<GmailExpiredReason>,
}

redacted_debug!(GmailState, |this| {
    "status": this.status,
    "has_account": this.account.is_some(),
    "unread": this.unread,
    "has_updated_at": this.updated_at.is_some(),
    "persistent": this.persistent,
    "reason": this.reason,
});

impl Validate for GmailState {
    fn validate(&self) -> Result<(), String> {
        match self.unread {
            Some(unread) => int_in("unread", unread, 0, UNREAD_CAP),
            None => Ok(()),
        }
    }
}

/// `gmailMessageSchema`: one row of `gmail:recent` (plain strings, no bounds). `Debug` never
/// prints mail data.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GmailMessage {
    pub id: String,
    pub thread_id: String,
    pub from: String,
    pub subject: String,
    pub snippet: String,
    /// ISO time.
    pub date: String,
    pub unread: bool,
}

redacted_debug!(GmailMessage, |this| { "unread": this.unread });

impl Validate for GmailMessage {}

/// Output of `gmail:recent`: `z.array(gmailMessageSchema).max(GMAIL_RECENT_LIMIT)`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(transparent)]
pub struct GmailRecent(pub Vec<GmailMessage>);

impl Validate for GmailRecent {
    fn validate(&self) -> Result<(), String> {
        at_most("recent", self.0.len(), RECENT_LIMIT)?;
        self.0.validate()
    }
}

/// `gmailLinkSchema`: a link of an opened mail, opened by index (never by URL from the renderer).
/// `Debug` never prints the text or the URL.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GmailLink {
    pub text: String,
    pub url: String,
}

redacted_debug!(GmailLink);

impl Validate for GmailLink {
    fn validate(&self) -> Result<(), String> {
        max_len("text", &self.text, LINK_TEXT_MAX)?;
        max_len("url", &self.url, URL_MAX)?;
        if is_web_url(&self.url) {
            Ok(())
        } else {
            Err("Only http/https links".into())
        }
    }
}

/// `gmailMessageDetailSchema`: output of `gmail:message`, a mail as plain text. `Debug` never
/// prints mail data.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GmailMessageDetail {
    pub id: String,
    pub thread_id: String,
    /// Display name of the sender.
    pub from: String,
    pub from_address: String,
    pub subject: String,
    /// ISO time.
    pub date: String,
    pub unread: bool,
    pub body: String,
    pub truncated: bool,
    pub links: Vec<GmailLink>,
    /// `z.int().min(0)`.
    pub attachments: u64,
}

redacted_debug!(GmailMessageDetail, |this| {
    "unread": this.unread,
    "truncated": this.truncated,
    "links": this.links.len(),
    "attachments": this.attachments,
});

impl Validate for GmailMessageDetail {
    fn validate(&self) -> Result<(), String> {
        max_len("from", &self.from, HEADER_MAX)?;
        max_len("fromAddress", &self.from_address, HEADER_MAX)?;
        max_len("subject", &self.subject, HEADER_MAX)?;
        max_len("body", &self.body, BODY_MAX)?;
        at_most("links", self.links.len(), LINKS_MAX)?;
        self.links.validate()?;
        safe_int_min("attachments", self.attachments, 0)
    }
}

/// `gmailNewMailSchema`: payload of `gmail:new-mail`. `from` and `subject` are optional, never
/// `null`, and left out when the user hides the content. `Debug` never prints mail data.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GmailNewMail {
    /// `z.int().min(1)`.
    pub count: u64,
    pub id: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub from: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub subject: Option<String>,
}

redacted_debug!(GmailNewMail, |this| {
    "count": this.count,
    "has_from": this.from.is_some(),
    "has_subject": this.subject.is_some(),
});

impl Validate for GmailNewMail {
    fn validate(&self) -> Result<(), String> {
        safe_int_min("count", self.count, 1)?;
        gmail_id("id", &self.id)
    }
}

/// `gmailOpenInputSchema`: `gmail:open` with an optional id (none: the inbox).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GmailOpenInput {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
}

impl Validate for GmailOpenInput {
    fn validate(&self) -> Result<(), String> {
        self.id.as_deref().map_or(Ok(()), |id| gmail_id("id", id))
    }
}

/// `gmailIdInputSchema`: `gmail:message`, `gmail:mark-read` and `gmail:delete`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GmailIdInput {
    pub id: String,
}

impl Validate for GmailIdInput {
    fn validate(&self) -> Result<(), String> {
        gmail_id("id", &self.id)
    }
}

/// `gmailOpenLinkInputSchema`: a link named by its index, never by URL.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GmailOpenLinkInput {
    pub id: String,
    /// `z.int().min(0).max(GMAIL_LINKS_MAX - 1)`.
    pub index: u32,
}

impl Validate for GmailOpenLinkInput {
    fn validate(&self) -> Result<(), String> {
        gmail_id("id", &self.id)?;
        // LINKS_MAX is 50: the cast cannot truncate.
        int_in("index", self.index, 0, LINKS_MAX as u32 - 1)
    }
}

/// `gmail:view`: the Gmail view opened or closed.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GmailViewInput {
    pub open: bool,
}

impl Validate for GmailViewInput {}

/// `gmailClientFileSchema`: the credentials read from a client file (`gmail:pick-client-file`
/// answers it or `null`). `Debug` never prints the secret.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GmailClientFile {
    pub client_id: String,
    pub client_secret: String,
}

impl fmt::Debug for GmailClientFile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GmailClientFile").finish_non_exhaustive()
    }
}

impl Validate for GmailClientFile {
    fn validate(&self) -> Result<(), String> {
        len_in("clientId", &self.client_id, 1, CLIENT_MAX)?;
        len_in("clientSecret", &self.client_secret, 1, CLIENT_MAX)
    }
}

/// `parseClientFile`: the credentials of Google's "Desktop app" client JSON
/// (`{installed: {client_id, client_secret}}`, extra fields ignored, each 1..=256). Any other
/// shape, a `web` client included, gives `None`.
pub fn parse_client_file(json: &Value) -> Option<GmailClientFile> {
    // Read through `Value` rather than serde structs: serde would also take an array for a
    // struct (`{"installed": ["id", "secret"]}`), which zod refuses.
    let installed = json.as_object()?.get("installed")?.as_object()?;
    let field = |name: &str| {
        let value = installed.get(name)?.as_str()?;
        len_in(name, value, 1, CLIENT_MAX).ok()?;
        Some(value.to_owned())
    };
    Some(GmailClientFile {
        client_id: field("client_id")?,
        client_secret: field("client_secret")?,
    })
}

input_entry!(
    GmailOpenInput,
    GmailIdInput,
    GmailOpenLinkInput,
    GmailViewInput
);

/// The Google responses the client reads (schema.ts "Gmail / OAuth responses"). Not strict:
/// Google adds fields, which are ignored. A `.optional()` field may be missing but not `null`.
///
/// These types stay lenient on shape too: they are read with serde alone, not through
/// [`crate::contract::parse`] and its shape walk, so a JSON array where an object is expected
/// (`["m1", "t1"]` for a message ref) is read as serde reads it. Only Google writes these
/// answers, over TLS; the renderer never sends them. `Debug` never prints mail data, ids or
/// tokens.
pub mod google {
    use std::fmt;

    use serde::Deserialize;

    use crate::contract::present;

    /// One `{id, threadId}` of `messages.list`.
    #[derive(Deserialize, Clone, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    pub struct MessageRef {
        pub id: String,
        pub thread_id: String,
    }

    /// `messageListSchema`: no `messages` key when the query matches nothing.
    #[derive(Deserialize, Clone, Default, PartialEq, Eq)]
    pub struct MessageList {
        #[serde(default, deserialize_with = "present")]
        pub messages: Option<Vec<MessageRef>>,
    }

    /// One MIME header.
    #[derive(Deserialize, Clone, PartialEq, Eq)]
    pub struct Header {
        pub name: String,
        pub value: String,
    }

    /// The `payload` of a `format=metadata` message.
    #[derive(Deserialize, Clone, PartialEq, Eq)]
    pub struct MetadataPayload {
        pub headers: Vec<Header>,
    }

    /// `messageMetadataSchema`.
    #[derive(Deserialize, Clone, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    pub struct MessageMetadata {
        pub id: String,
        pub thread_id: String,
        pub snippet: String,
        #[serde(default, deserialize_with = "present")]
        pub label_ids: Option<Vec<String>>,
        /// Epoch milliseconds as a string.
        pub internal_date: String,
        pub payload: MetadataPayload,
    }

    /// The `body` of a MIME part: inline base64url `data`, or only a `size` (attachments).
    #[derive(Deserialize, Clone, PartialEq)]
    pub struct PartBody {
        #[serde(default, deserialize_with = "present")]
        pub data: Option<String>,
        pub size: f64,
    }

    /// `MessagePayload`: one MIME part of a `format=full` message; `parts` nest for multipart
    /// types. `headers` defaults to `[]` when missing (never when `null`).
    #[derive(Deserialize, Clone, PartialEq)]
    #[serde(rename_all = "camelCase")]
    pub struct MessagePart {
        pub mime_type: String,
        #[serde(default, deserialize_with = "present")]
        pub filename: Option<String>,
        #[serde(default)]
        pub headers: Vec<Header>,
        pub body: PartBody,
        #[serde(default, deserialize_with = "present")]
        pub parts: Option<Vec<MessagePart>>,
    }

    /// `messageFullSchema`.
    #[derive(Deserialize, Clone, PartialEq)]
    #[serde(rename_all = "camelCase")]
    pub struct MessageFull {
        pub id: String,
        pub thread_id: String,
        #[serde(default, deserialize_with = "present")]
        pub label_ids: Option<Vec<String>>,
        pub internal_date: String,
        pub payload: MessagePart,
    }

    redacted_debug!(MessageRef);
    redacted_debug!(MessageList, |this| {
        "messages": this.messages.as_ref().map(Vec::len),
    });
    redacted_debug!(Header);
    redacted_debug!(MetadataPayload, |this| { "headers": this.headers.len() });
    redacted_debug!(MessageMetadata, |this| {
        "labels": this.label_ids.as_ref().map(Vec::len),
        "headers": this.payload.headers.len(),
    });
    redacted_debug!(PartBody, |this| {
        "has_data": this.data.is_some(),
        "size": this.size,
    });
    redacted_debug!(MessagePart, |this| {
        "has_filename": this.filename.is_some(),
        "headers": this.headers.len(),
        "body": this.body,
        "parts": this.parts.as_ref().map(Vec::len),
    });
    redacted_debug!(MessageFull, |this| {
        "labels": this.label_ids.as_ref().map(Vec::len),
        "payload": this.payload,
    });

    /// `profileSchema`. `Debug` never prints the account.
    #[derive(Deserialize, Clone, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    pub struct Profile {
        pub email_address: String,
    }

    impl fmt::Debug for Profile {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("Profile").finish_non_exhaustive()
        }
    }

    /// `tokenResponseSchema` (`/token`). `token_type` is required. `Debug` never prints the
    /// tokens.
    #[derive(Deserialize, Clone, PartialEq)]
    pub struct TokenResponse {
        pub access_token: String,
        pub expires_in: f64,
        #[serde(default, deserialize_with = "present")]
        pub refresh_token: Option<String>,
        #[serde(default, deserialize_with = "present")]
        pub scope: Option<String>,
        pub token_type: String,
    }

    impl fmt::Debug for TokenResponse {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.debug_struct("TokenResponse")
                .field("expires_in", &self.expires_in)
                .field("has_refresh_token", &self.refresh_token.is_some())
                .field("scope", &self.scope)
                .finish_non_exhaustive()
        }
    }
}

#[cfg(test)]
#[path = "gmail_tests.rs"]
mod tests;
