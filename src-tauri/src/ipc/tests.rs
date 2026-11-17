use super::*;
use serde_json::json;
use tauri::async_runtime::block_on;

fn sender(label: &str, url: &str) -> Sender {
    Sender {
        label: label.to_owned(),
        url: url.parse().expect("valid test url"),
    }
}

fn notch() -> Sender {
    sender(NOTCH, "http://tauri.localhost/notch/index.html")
}

fn control_center() -> Sender {
    sender(
        CONTROL_CENTER,
        "http://tauri.localhost/control-center/index.html",
    )
}

fn call(registry: &Registry, from: Sender, channel: &str) -> Value {
    block_on(registry.dispatch(&Ctx::for_test(from), channel, None))
}

fn error_code(response: &Value) -> &str {
    assert_eq!(
        response["ok"],
        json!(false),
        "expected an error, got {response}"
    );
    response["error"]["code"].as_str().expect("error code")
}

struct Fixed(Result<Value, ExposedError>);

impl Channel for Fixed {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        _input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        let result = self.0.clone();
        Box::pin(async move { result })
    }
}

struct Panics;

impl Channel for Panics {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        _input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async move { panic!("handler bug") })
    }
}

struct Echo;

impl Channel for Echo {
    fn handle<'a>(
        &'a self,
        ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async move { Ok(json!({ "label": ctx.sender().label, "input": input })) })
    }
}

#[test]
fn error_codes_serialize_like_result_ts() {
    let codes = [
        (IpcErrorCode::InvalidInput, "INVALID_INPUT"),
        (IpcErrorCode::Forbidden, "FORBIDDEN"),
        (IpcErrorCode::ReadOnly, "READ_ONLY"),
        (IpcErrorCode::Unavailable, "UNAVAILABLE"),
        (IpcErrorCode::NotFound, "NOT_FOUND"),
        (IpcErrorCode::Internal, "INTERNAL"),
    ];
    for (code, name) in codes {
        assert_eq!(serde_json::to_value(code).unwrap(), json!(name));
    }
    assert_eq!(ok(json!([1])), json!({ "ok": true, "data": [1] }));
    assert_eq!(
        err(IpcErrorCode::NotFound, "Missing"),
        json!({ "ok": false, "error": { "code": "NOT_FOUND", "message": "Missing" } })
    );
}

#[test]
fn unknown_channel_is_invalid_input() {
    let registry = Registry::new();
    let response = call(&registry, notch(), "settings:explode");
    assert_eq!(error_code(&response), "INVALID_INPUT");
}

#[test]
fn untrusted_url_is_forbidden() {
    let registry = Registry::new();
    for url in [
        "https://evil.example/",
        "http://tauri.localhost.evil.example/",
        "https://tauri.localhost/",
        "http://tauri.localhost:8080/",
        "http://user@tauri.localhost/",
        "http://localhost:5175/",
        "file:///C:/Users/x/index.html",
        "tauri://localhost/",
    ] {
        let response = call(&registry, sender(NOTCH, url), "settings:get");
        assert_eq!(error_code(&response), "FORBIDDEN", "{url}");
    }

    // An unknown window label is refused even on our own origin.
    let response = call(
        &registry,
        sender("main", "http://tauri.localhost/"),
        "settings:get",
    );
    assert_eq!(error_code(&response), "FORBIDDEN");

    // The dev server origin is only trusted when dev overrides are on.
    let dev = sender(NOTCH, "http://localhost:5174/notch/index.html");
    assert_eq!(
        error_code(&call(
            &Registry::with_dev_origin(false),
            dev.clone(),
            "settings:get"
        )),
        "FORBIDDEN"
    );
    assert_eq!(
        error_code(&call(&Registry::with_dev_origin(true), dev, "settings:get")),
        "UNAVAILABLE"
    );
}

#[test]
fn notch_only_channel_from_control_center_is_forbidden() {
    let registry = Registry::new();
    assert_eq!(
        error_code(&call(&registry, control_center(), "notes:list")),
        "FORBIDDEN"
    );
    assert_eq!(
        error_code(&call(&registry, notch(), "notes:list")),
        "UNAVAILABLE"
    );

    assert_eq!(
        error_code(&call(&registry, notch(), "usage:summary")),
        "FORBIDDEN"
    );
    assert_eq!(
        error_code(&call(&registry, control_center(), "usage:summary")),
        "UNAVAILABLE"
    );

    // Channels open to both windows.
    assert_eq!(
        error_code(&call(&registry, control_center(), "gmail:get-state")),
        "UNAVAILABLE"
    );
    assert_eq!(
        error_code(&call(&registry, notch(), "reminders:create")),
        "UNAVAILABLE"
    );
}

#[test]
fn guard_table_matches_electron() {
    assert_eq!(guard_for("apps:open"), Guard::NotchOnly);
    assert_eq!(guard_for("claude:get-state"), Guard::Any);
    assert_eq!(guard_for("claude:hooks-install"), Guard::ControlCenterOnly);
    assert_eq!(guard_for("reminders:update"), Guard::ControlCenterOnly);
    assert_eq!(guard_for("redmine:set-key"), Guard::ControlCenterOnly);
    assert_eq!(guard_for("code-review:list"), Guard::NotchOnly);
    // Channels without an Electron guard accept any trusted window.
    assert_eq!(guard_for("settings:update"), Guard::Any);
    assert_eq!(guard_for("notch:pointer"), Guard::Any);
    assert_eq!(guard_for("notch:capsule-rect"), Guard::NotchOnly);

    for (channel, _) in GUARDS {
        assert!(
            known_channels().contains(channel),
            "guard for unknown channel {channel}"
        );
    }
}

#[test]
fn unmigrated_channel_is_unavailable() {
    let registry = Registry::new();
    let channels = known_channels();
    assert!(channels.len() >= 70, "channels.json looks truncated");
    for channel in channels {
        let from = match guard_for(channel) {
            Guard::ControlCenterOnly => control_center(),
            Guard::Any | Guard::NotchOnly => notch(),
        };
        let response = call(&registry, from, channel);
        assert_eq!(error_code(&response), "UNAVAILABLE", "{channel}");
    }
}

#[test]
fn registry_covers_every_known_channel() {
    let registry = Registry::new();
    let mut registered = registry.channel_names();
    registered.sort_unstable();
    let mut known = known_channels().to_vec();
    known.sort_unstable();
    assert_eq!(registered, known);
}

/// R5: the `__e2e:*` test channels are never part of the contract, and the app's registry has
/// them only in the `e2e` build (a release build cannot even call `register_test_channel`).
#[test]
fn test_channels_exist_only_in_the_e2e_build() {
    assert!(known_channels()
        .iter()
        .all(|name| !name.starts_with(TEST_CHANNEL_PREFIX)));

    let registry = crate::build_registry(&crate::Slots::default());
    let mut test_channels: Vec<&str> = registry
        .channel_names()
        .into_iter()
        .filter(|name| name.starts_with(TEST_CHANNEL_PREFIX))
        .collect();
    test_channels.sort_unstable();
    #[cfg(not(feature = "e2e"))]
    assert!(test_channels.is_empty(), "{test_channels:?}");
    #[cfg(feature = "e2e")]
    {
        let mut expected: Vec<&str> = crate::e2e::CHANNELS.iter().map(|(name, _)| *name).collect();
        expected.sort_unstable();
        assert_eq!(test_channels, expected);
    }
    assert_eq!(
        registry.channel_names().len() - test_channels.len(),
        known_channels().len()
    );
}

#[test]
fn registered_handler_receives_input_and_sender() {
    let mut registry = Registry::new();
    registry.register("settings:update", Echo);
    let response = block_on(registry.dispatch(
        &Ctx::for_test(control_center()),
        "settings:update",
        Some(json!({ "a": 1 })),
    ));
    assert_eq!(
        response,
        json!({ "ok": true, "data": { "label": "control-center", "input": { "a": 1 } } })
    );
}

#[test]
#[should_panic(expected = "unknown channel")]
fn registering_an_unknown_channel_panics() {
    Registry::new().register("settings:explode", Echo);
}

#[test]
fn exposed_error_keeps_code_and_message() {
    let mut registry = Registry::new();
    registry.register(
        "settings:update",
        Fixed(Err(ExposedError::new(
            IpcErrorCode::ReadOnly,
            "Settings are locked",
        ))),
    );
    let response = call(&registry, notch(), "settings:update");
    assert_eq!(
        response,
        json!({ "ok": false, "error": { "code": "READ_ONLY", "message": "Settings are locked" } })
    );
}

#[test]
fn internal_error_is_generic_internal() {
    let generic =
        json!({ "ok": false, "error": { "code": "INTERNAL", "message": "Unexpected error" } });

    let mut registry = Registry::new();
    registry.register(
        "settings:get",
        Fixed(Err(ExposedError::internal("disk full at C:\\secret"))),
    );
    registry.register(
        "settings:update",
        Fixed(Err(ExposedError::new(
            IpcErrorCode::Internal,
            "leaky detail",
        ))),
    );
    registry.register("app:get-info", Panics);

    assert_eq!(call(&registry, notch(), "settings:get"), generic);
    assert_eq!(call(&registry, notch(), "settings:update"), generic);
    assert_eq!(call(&registry, notch(), "app:get-info"), generic);
}

#[test]
fn known_events_come_from_channels_json() {
    assert!(is_known_event("settings:changed"));
    assert!(is_known_event("redmine:alert"));
    assert!(!is_known_event("settings:get"));
}

#[test]
fn bridge_script_is_embedded() {
    assert!(BRIDGE_SCRIPT.contains("notch_ipc"));
}

#[test]
fn only_known_channels_are_logged_as_is() {
    let registry = Registry::new();
    assert_eq!(registry.channel_for_log("settings:get"), "settings:get");
    assert_eq!(
        registry.channel_for_log("token=abc\nforged log line"),
        "unknown"
    );
    assert_eq!(registry.channel_for_log(""), "unknown");
}

#[test]
fn internal_errors_keep_only_a_coarse_kind() {
    let secret = String::from("GET https://host/api?key=s3cr3t failed");
    let error = ExposedError::internal(&secret);
    assert_eq!(error.code(), IpcErrorCode::Internal);
    assert_eq!(error.message(), "Unexpected error");
    assert_eq!(error.kind(), std::any::type_name::<&String>());
    for shown in [error.to_string(), format!("{error:?}")] {
        assert!(!shown.contains("s3cr3t"), "cause leaked: {shown}");
    }
    let io = std::io::Error::other(r"C:\Users\someone\token.txt");
    let kind = ExposedError::internal(io).kind();
    assert_eq!(kind, std::any::type_name::<std::io::Error>());
    assert!(!kind.contains("token"));
    // An INTERNAL built with `new` never prints its message either.
    let detailed = ExposedError::new(IpcErrorCode::Internal, "leaky detail");
    assert_eq!(detailed.kind(), UNSPECIFIED_KIND);
    assert!(!detailed.to_string().contains("leaky"));
    // Other codes keep their user-facing message.
    assert_eq!(
        ExposedError::new(IpcErrorCode::ReadOnly, "Settings are locked").to_string(),
        "ReadOnly: Settings are locked"
    );
}
