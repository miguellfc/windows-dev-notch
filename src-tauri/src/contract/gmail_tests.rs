//! Port of `tests/unit/shared/gmail-schema.test.ts` (22 cases), plus the Rust-only checks.

use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use super::google::{MessageFull, MessageList, MessageMetadata, Profile, TokenResponse};
use super::*;
use crate::contract::parse;

fn accepts<T: DeserializeOwned + serde::Serialize + Validate>(value: Value) -> bool {
    parse::<T>(value).is_ok()
}

/// `{...base, key: value}`; `Value::Null` stays a `null`.
fn with(base: &Value, key: &str, value: Value) -> Value {
    let mut out = base.clone();
    out[key] = value;
    out
}

/// `{...base, key: undefined}`: the key left out.
fn without(base: &Value, key: &str) -> Value {
    let mut out = base.clone();
    out.as_object_mut().unwrap().shift_remove(key);
    out
}

fn state() -> Value {
    json!({
        "status": "ok", "account": "a@b.c", "unread": 3,
        "updatedAt": "2026-11-11T10:00:00.000Z", "persistent": true, "reason": null,
    })
}

// --- gmail state ---

#[test]
fn state_has_the_documented_limits() {
    assert_eq!(RECENT_LIMIT, 5);
    assert_eq!(UNREAD_CAP, 100);
}

#[test]
fn state_accepts_the_six_statuses_and_rejects_others() {
    for status in [
        "unconfigured",
        "signed-out",
        "signing-in",
        "ok",
        "offline",
        "expired",
    ] {
        assert!(accepts::<GmailStatus>(json!(status)), "{status}");
        assert!(
            accepts::<GmailState>(with(&state(), "status", json!(status))),
            "{status}"
        );
    }
    assert_eq!(GmailStatus::ALL.len(), 6);
    assert!(!accepts::<GmailStatus>(json!("error")));
    assert!(!accepts::<GmailState>(with(
        &state(),
        "status",
        json!("nope")
    )));
}

#[test]
fn state_bounds_unread_to_0_100_or_null() {
    for unread in [json!(0), json!(100), Value::Null] {
        assert!(
            accepts::<GmailState>(with(&state(), "unread", unread.clone())),
            "{unread}"
        );
    }
    for unread in [json!(-1), json!(101), json!(1.5)] {
        assert!(
            !accepts::<GmailState>(with(&state(), "unread", unread.clone())),
            "{unread}"
        );
    }
}

#[test]
fn state_has_a_nullable_scope_reason() {
    let expired = with(&state(), "status", json!("expired"));
    assert!(accepts::<GmailState>(with(
        &expired,
        "reason",
        json!("scope")
    )));
    assert!(!accepts::<GmailState>(with(
        &state(),
        "reason",
        json!("other")
    )));
    assert!(!accepts::<GmailState>(without(&state(), "reason")));
}

#[test]
fn state_requires_persistent_and_rejects_unknown_keys() {
    assert!(!accepts::<GmailState>(without(&state(), "persistent")));
    assert!(!accepts::<GmailState>(with(&state(), "extra", json!(1))));
}

// --- gmail message ---

fn message() -> Value {
    json!({
        "id": "m1", "threadId": "t1", "from": "Ann", "subject": "s", "snippet": "x",
        "date": "2026-11-11T10:00:00.000Z", "unread": true,
    })
}

#[test]
fn message_is_strict() {
    let parsed: GmailMessage = parse(message()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), message());
    assert!(!accepts::<GmailMessage>(with(
        &message(),
        "extra",
        json!(1)
    )));
    assert!(!accepts::<GmailMessage>(with(
        &message(),
        "unread",
        json!("yes")
    )));
}

#[test]
fn open_input_has_an_optional_id() {
    let empty: GmailOpenInput = parse(json!({})).unwrap();
    assert_eq!(empty, GmailOpenInput { id: None });
    assert_eq!(serde_json::to_value(&empty).unwrap(), json!({}));
    let one: GmailOpenInput = parse(json!({"id": "m1"})).unwrap();
    assert_eq!(serde_json::to_value(&one).unwrap(), json!({"id": "m1"}));
    assert!(!accepts::<GmailOpenInput>(json!({"id": "m1", "url": "x"})));
    // Optional, not nullable; and bounded like every Gmail id.
    assert!(!accepts::<GmailOpenInput>(json!({"id": null})));
    assert!(!accepts::<GmailOpenInput>(json!({"id": ""})));
    assert!(accepts::<GmailOpenInput>(json!({"id": "x".repeat(64)})));
    assert!(!accepts::<GmailOpenInput>(json!({"id": "x".repeat(65)})));
}

// --- parseClientFile ---

#[test]
fn parse_client_file_reads_a_desktop_client_file() {
    let file = json!({"installed": {"client_id": "id.apps", "client_secret": "sec", "project_id": "p", "auth_uri": "u"}});
    assert_eq!(
        parse_client_file(&file),
        Some(GmailClientFile {
            client_id: "id.apps".into(),
            client_secret: "sec".into(),
        })
    );
}

#[test]
fn parse_client_file_rejects_web_clients_and_garbage() {
    assert_eq!(
        parse_client_file(&json!({"web": {"client_id": "a", "client_secret": "b"}})),
        None
    );
    assert_eq!(
        parse_client_file(&json!({"installed": {"client_id": "", "client_secret": "b"}})),
        None
    );
    assert_eq!(
        parse_client_file(&json!({"installed": {"client_id": "a"}})),
        None
    );
    // `undefined` has no JSON form: `null` and the others stand for it.
    for junk in [
        Value::Null,
        json!(5),
        json!("x"),
        json!([]),
        json!({}),
        // A struct-shaped array is still not an object.
        json!({"installed": ["a", "b"]}),
        json!({"installed": {"client_id": 1, "client_secret": "b"}}),
    ] {
        assert_eq!(parse_client_file(&junk), None, "{junk}");
    }
}

#[test]
fn parse_client_file_rejects_ids_or_secrets_longer_than_the_settings_allow() {
    let long = "x".repeat(257);
    assert!(parse_client_file(
        &json!({"installed": {"client_id": "a".repeat(256), "client_secret": "b".repeat(256)}})
    )
    .is_some());
    assert_eq!(
        parse_client_file(&json!({"installed": {"client_id": long, "client_secret": "b"}})),
        None
    );
    assert_eq!(
        parse_client_file(&json!({"installed": {"client_id": "a", "client_secret": long}})),
        None
    );
}

// --- api response schemas ---

#[test]
fn api_response_schemas_parse_and_tolerate_extra_fields() {
    let list: MessageList = serde_json::from_value(json!({})).unwrap();
    assert_eq!(list.messages, None);
    let list: MessageList = serde_json::from_value(
        json!({"messages": [{"id": "a", "threadId": "b", "x": 1}], "nextPageToken": "n"}),
    )
    .unwrap();
    assert_eq!(list.messages.unwrap().len(), 1);

    let meta = json!({
        "id": "a", "threadId": "b", "snippet": "s", "internalDate": "1731319200000", "extra": 1,
        "payload": {"headers": [{"name": "From", "value": "x"}], "mimeType": "text/plain"},
    });
    let parsed: MessageMetadata = serde_json::from_value(meta.clone()).unwrap();
    assert_eq!(parsed.label_ids, None);
    assert_eq!(parsed.payload.headers[0].name, "From");
    assert!(serde_json::from_value::<MessageMetadata>(with(&meta, "payload", json!({}))).is_err());

    let profile: Profile =
        serde_json::from_value(json!({"emailAddress": "a@b.c", "messagesTotal": 4})).unwrap();
    assert_eq!(profile.email_address, "a@b.c");

    let token: TokenResponse = serde_json::from_value(
        json!({"access_token": "t", "expires_in": 3599, "token_type": "Bearer", "id_token": "z"}),
    )
    .unwrap();
    assert_eq!(token.refresh_token, None);
    assert!(serde_json::from_value::<TokenResponse>(
        json!({"expires_in": 1, "token_type": "Bearer"})
    )
    .is_err());
    // `token_type` is required; `refresh_token` is optional but never `null`.
    assert!(
        serde_json::from_value::<TokenResponse>(json!({"access_token": "t", "expires_in": 1}))
            .is_err()
    );
    assert!(serde_json::from_value::<TokenResponse>(
        json!({"access_token": "t", "expires_in": 1, "token_type": "Bearer", "refresh_token": null})
    )
    .is_err());
}

// --- gmail message detail ---

fn detail() -> Value {
    json!({
        "id": "m1",
        "threadId": "t1",
        "from": "Ana",
        "fromAddress": "ana@example.com",
        "subject": "Hola",
        "date": "2026-11-11T10:00:00.000Z",
        "unread": true,
        "body": "texto",
        "truncated": false,
        "links": [{"text": "Docs", "url": "https://example.com/docs"}],
        "attachments": 0,
    })
}

fn one_link(text: &str, url: &str) -> Value {
    with(&detail(), "links", json!([{"text": text, "url": url}]))
}

#[test]
fn detail_has_the_documented_limits() {
    assert_eq!(BODY_MAX, 50_000);
    assert_eq!(LINKS_MAX, 50);
}

#[test]
fn detail_is_strict() {
    let parsed: GmailMessageDetail = parse(detail()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), detail());
    assert!(!accepts::<GmailMessageDetail>(with(
        &detail(),
        "extra",
        json!(1)
    )));
    assert!(!accepts::<GmailMessageDetail>(with(
        &detail(),
        "links",
        json!([{"text": "a", "url": "https://example.com", "x": 1}])
    )));
    assert!(!accepts::<GmailMessageDetail>(with(
        &detail(),
        "attachments",
        json!(-1)
    )));
    assert!(!accepts::<GmailMessageDetail>(with(
        &detail(),
        "attachments",
        json!(1.5)
    )));
}

#[test]
fn detail_bounds_the_body_to_50_000_characters_and_the_links_to_50() {
    assert!(accepts::<GmailMessageDetail>(with(
        &detail(),
        "body",
        json!("x".repeat(50_000))
    )));
    assert!(!accepts::<GmailMessageDetail>(with(
        &detail(),
        "body",
        json!("x".repeat(50_001))
    )));
    let links = |count: usize| {
        Value::Array(
            (0..count)
                .map(
                    |n| json!({"text": format!("l{n}"), "url": format!("https://example.com/{n}")}),
                )
                .collect(),
        )
    };
    assert!(accepts::<GmailMessageDetail>(with(
        &detail(),
        "links",
        links(50)
    )));
    assert!(!accepts::<GmailMessageDetail>(with(
        &detail(),
        "links",
        links(51)
    )));
}

#[test]
fn detail_caps_link_text_at_200_characters() {
    assert!(accepts::<GmailMessageDetail>(one_link(
        &"a".repeat(200),
        "https://example.com"
    )));
    assert!(!accepts::<GmailMessageDetail>(one_link(
        &"a".repeat(201),
        "https://example.com"
    )));
}

#[test]
fn detail_bounds_link_urls_to_2048_characters_and_sender_and_subject_to_1000() {
    assert_eq!(URL_MAX, 2048);
    assert_eq!(HEADER_MAX, 1000);
    let prefix = "https://example.com/";
    let url = |length: usize| format!("{prefix}{}", "a".repeat(length - prefix.len()));
    assert!(accepts::<GmailMessageDetail>(one_link("a", &url(2048))));
    assert!(!accepts::<GmailMessageDetail>(one_link("a", &url(2049))));
    for key in ["from", "fromAddress", "subject"] {
        assert!(
            accepts::<GmailMessageDetail>(with(&detail(), key, json!("x".repeat(1000)))),
            "{key}"
        );
        assert!(
            !accepts::<GmailMessageDetail>(with(&detail(), key, json!("x".repeat(1001)))),
            "{key}"
        );
    }
}

#[test]
fn detail_only_carries_http_and_https_links() {
    for url in ["http://example.com", "HTTPS://example.com/a"] {
        assert!(accepts::<GmailMessageDetail>(one_link("a", url)), "{url}");
    }
    for url in [
        "javascript:alert(1)",
        "data:text/html,x",
        "mailto:a@example.com",
        "file:///c:/x",
    ] {
        assert!(!accepts::<GmailMessageDetail>(one_link("a", url)), "{url}");
    }
}

// --- gmail new mail ---

#[test]
fn new_mail_has_optional_sender_and_subject() {
    let bare: GmailNewMail = parse(json!({"count": 1, "id": "m1"})).unwrap();
    assert_eq!(
        serde_json::to_value(&bare).unwrap(),
        json!({"count": 1, "id": "m1"})
    );
    let full = json!({"count": 3, "id": "m1", "from": "Ana", "subject": "Hola"});
    let parsed: GmailNewMail = parse(full.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), full);
    assert!(!accepts::<GmailNewMail>(json!({"count": 0, "id": "m1"})));
    assert!(!accepts::<GmailNewMail>(json!({"count": 1, "id": ""})));
    assert!(!accepts::<GmailNewMail>(
        json!({"count": 1, "id": "m1", "snippet": "x"})
    ));
    // Optional, not nullable.
    assert!(!accepts::<GmailNewMail>(
        json!({"count": 1, "id": "m1", "from": null})
    ));
    assert!(!accepts::<GmailNewMail>(
        json!({"count": 1, "id": "m1", "subject": null})
    ));
}

// --- gmail action inputs ---

#[test]
fn id_input_takes_a_1_to_64_character_id_only() {
    let parsed: GmailIdInput = parse(json!({"id": "m1"})).unwrap();
    assert_eq!(parsed.id, "m1");
    assert!(accepts::<GmailIdInput>(json!({"id": "x".repeat(64)})));
    assert!(!accepts::<GmailIdInput>(json!({"id": "x".repeat(65)})));
    assert!(!accepts::<GmailIdInput>(json!({"id": ""})));
    assert!(!accepts::<GmailIdInput>(json!({})));
    assert!(!accepts::<GmailIdInput>(json!({"id": "m1", "url": "x"})));
}

#[test]
fn open_link_input_takes_an_id_and_an_integer_index_0_to_49() {
    for index in [0, 49] {
        assert!(
            accepts::<GmailOpenLinkInput>(json!({"id": "m1", "index": index})),
            "{index}"
        );
    }
    for index in [json!(-1), json!(50), json!(1.5), json!("1")] {
        assert!(
            !accepts::<GmailOpenLinkInput>(json!({"id": "m1", "index": index})),
            "{index}"
        );
    }
    assert!(!accepts::<GmailOpenLinkInput>(
        json!({"id": "", "index": 0})
    ));
    assert!(!accepts::<GmailOpenLinkInput>(
        json!({"id": "m1", "index": 0, "url": "https://example.com"})
    ));
}

// --- messageFullSchema ---

fn full() -> Value {
    json!({
        "id": "m1",
        "threadId": "t1",
        "snippet": "s",
        "labelIds": ["INBOX", "UNREAD"],
        "internalDate": "1731319200000",
        "historyId": "9",
        "payload": {
            "mimeType": "multipart/mixed",
            "filename": "",
            "headers": [{"name": "From", "value": "Ana <ana@example.com>"}],
            "body": {"size": 0},
            "parts": [
                {
                    "mimeType": "multipart/alternative",
                    "headers": [],
                    "body": {"size": 0},
                    "parts": [{"partId": "0.0", "mimeType": "text/plain", "filename": "", "headers": [], "body": {"data": "aG9sYQ", "size": 4}}],
                },
                {"mimeType": "application/pdf", "filename": "a.pdf", "headers": [], "body": {"attachmentId": "att", "size": 10}},
            ],
        },
    })
}

#[test]
fn message_full_parses_nested_parts_and_tolerates_extra_fields() {
    let parsed: MessageFull = serde_json::from_value(full()).unwrap();
    let parts = parsed.payload.parts.as_ref().unwrap();
    let inner = parts[0].parts.as_ref().unwrap();
    assert_eq!(inner[0].body.data.as_deref(), Some("aG9sYQ"));
    assert_eq!(parts[1].filename.as_deref(), Some("a.pdf"));
    // `headers` defaults to `[]` when missing.
    let mut no_headers = full();
    no_headers["payload"]
        .as_object_mut()
        .unwrap()
        .shift_remove("headers");
    let parsed: MessageFull = serde_json::from_value(no_headers).unwrap();
    assert!(parsed.payload.headers.is_empty());
}

#[test]
fn message_full_rejects_a_payload_without_a_mime_type_or_body() {
    let payload = full()["payload"].clone();
    assert!(serde_json::from_value::<MessageFull>(with(
        &full(),
        "payload",
        without(&payload, "mimeType")
    ))
    .is_err());
    assert!(serde_json::from_value::<MessageFull>(with(
        &full(),
        "payload",
        without(&payload, "body")
    ))
    .is_err());
    assert!(serde_json::from_value::<MessageFull>(with(
        &full(),
        "payload",
        with(&payload, "parts", json!([{"mimeType": "text/plain"}]))
    ))
    .is_err());
}

// --- Rust-only ---

#[test]
fn is_web_url_matches_http_and_https_after_a_js_trim() {
    for url in [
        "http://a",
        "https://a",
        "HtTpS://a",
        "  https://a  ",
        "\u{FEFF}https://a",
    ] {
        assert!(is_web_url(url), "{url:?}");
    }
    for url in [
        "",
        "https:/a",
        "ftp://a",
        "xhttps://a",
        "\u{85}https://a",
        // No Unicode case folding: U+017F (long s) is not an `s` for `/i` without `u`.
        "http\u{17F}://a",
    ] {
        assert!(!is_web_url(url), "{url:?}");
    }
}

#[test]
fn secrets_never_reach_debug() {
    let file = GmailClientFile {
        client_id: "id.apps".into(),
        client_secret: "s3cr3t".into(),
    };
    assert!(!format!("{file:?}").contains("s3cr3t"));
    let token: TokenResponse = serde_json::from_value(json!({
        "access_token": "ya29.AAA", "expires_in": 1, "token_type": "Bearer", "refresh_token": "1//RRR",
    }))
    .unwrap();
    let debug = format!("{token:?}");
    assert!(
        !debug.contains("ya29.AAA") && !debug.contains("1//RRR"),
        "{debug}"
    );
    let profile: Profile = serde_json::from_value(json!({"emailAddress": "a@b.c"})).unwrap();
    assert!(!format!("{profile:?}").contains("a@b.c"));
}

#[test]
fn recent_holds_at_most_5_messages_and_sign_in_has_three_outcomes() {
    let list = |count: usize| Value::Array((0..count).map(|_| message()).collect());
    assert!(accepts::<GmailRecent>(list(0)));
    assert!(accepts::<GmailRecent>(list(5)));
    assert!(!accepts::<GmailRecent>(list(6)));
    for outcome in ["ok", "cancelled", "error"] {
        assert!(accepts::<GmailSignInResult>(json!(outcome)), "{outcome}");
    }
    assert!(!accepts::<GmailSignInResult>(json!("signed-in")));
}

#[test]
fn debug_never_prints_secrets_or_mail_data() {
    use crate::contract::settings::{GmailAlertSettings, GmailSettings};
    use crate::http::HttpResponse;

    const SECRETS: [&str; 9] = [
        "ana@example.com",
        "Ana Secret",
        "Private subject",
        "private body",
        "https://example.com/private",
        "msg-123",
        "thread-456",
        "client-id-789",
        "client-secret-xyz",
    ];
    let detail: GmailMessageDetail = serde_json::from_value(json!({
        "id": "msg-123", "threadId": "thread-456", "from": "Ana Secret",
        "fromAddress": "ana@example.com", "subject": "Private subject",
        "date": "2026-11-11T10:00:00.000Z", "unread": true, "body": "private body",
        "truncated": false, "attachments": 1,
        "links": [{ "text": "Private subject", "url": "https://example.com/private" }]
    }))
    .unwrap();
    let message: GmailMessage = serde_json::from_value(json!({
        "id": "msg-123", "threadId": "thread-456", "from": "Ana Secret",
        "subject": "Private subject", "snippet": "private body",
        "date": "2026-11-11T10:00:00.000Z", "unread": false
    }))
    .unwrap();
    let new_mail: GmailNewMail = serde_json::from_value(json!({
        "count": 2, "id": "msg-123", "from": "Ana Secret", "subject": "Private subject"
    }))
    .unwrap();
    let state: GmailState = serde_json::from_value(json!({
        "status": "ok", "account": "ana@example.com", "unread": 3,
        "updatedAt": "2026-11-11T10:00:00.000Z", "persistent": true, "reason": null
    }))
    .unwrap();
    let full: MessageFull = serde_json::from_value(json!({
        "id": "msg-123", "threadId": "thread-456", "labelIds": ["UNREAD"],
        "internalDate": "1762851600000",
        "payload": {
            "mimeType": "text/plain", "filename": "",
            "headers": [{ "name": "Subject", "value": "Private subject" }],
            "body": { "data": "cHJpdmF0ZSBib2R5", "size": 12 }
        }
    }))
    .unwrap();
    let settings = GmailSettings {
        client_id: "client-id-789".into(),
        client_secret: "client-secret-xyz".into(),
        alerts: GmailAlertSettings {
            enabled: true,
            hide_content: false,
            sound: true,
        },
    };
    let response = HttpResponse {
        status: 200,
        headers: Vec::new(),
        body: b"{\"emailAddress\":\"ana@example.com\"}".to_vec(),
    };
    let printed = [
        format!("{detail:?}"),
        format!("{message:?}"),
        format!("{new_mail:?}"),
        format!("{state:?}"),
        format!("{full:?}"),
        format!("{settings:?}"),
        format!("{response:?}"),
    ];
    for text in &printed {
        for secret in SECRETS {
            assert!(!text.contains(secret), "{text} shows {secret}");
        }
    }
    // Status, counts and booleans stay visible.
    assert!(printed[0].contains("links: 1"), "{}", printed[0]);
    assert!(printed[3].contains("has_account: true"), "{}", printed[3]);
    assert!(
        printed[5].contains("has_client_secret: true"),
        "{}",
        printed[5]
    );
    assert!(printed[6].contains("body_len: 34"), "{}", printed[6]);
}
