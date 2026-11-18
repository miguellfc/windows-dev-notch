//! The `app:*` and `settings:*` channels (handlers in 0.1.0's `index.ts`). They reach the
//! services through the app handle's managed state; without it (unit tests) they answer
//! UNAVAILABLE once the input has been validated.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::contract::app::{AppInfo, OpenControlCenterInput, Runtime};
use crate::contract::parse_input;
use crate::contract::settings::SettingsPatch;
use crate::control_center::open_control_center;
use crate::ipc::{no_input, BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry};
use crate::notch::runtime::NotchRuntime;
use crate::notch::state::NotchEvent;
use crate::platform::shortcut::{ShortcutControl, ShortcutService};
use crate::settings::update::update_settings;
use crate::settings::SettingsStore;

/// `app.getName()` in the Electron build.
pub const APP_NAME: &str = "Developer Notch";

fn unavailable() -> ExposedError {
    ExposedError::new(IpcErrorCode::Unavailable, "Not available yet")
}

fn app(ctx: &Ctx) -> Result<&AppHandle, ExposedError> {
    ctx.app().ok_or_else(unavailable)
}

fn to_value(value: impl Serialize) -> Result<Value, ExposedError> {
    serde_json::to_value(value).map_err(ExposedError::internal)
}

type Handler = fn(&Ctx, Value) -> Result<Value, ExposedError>;

struct SyncChannel(Handler);

impl Channel for SyncChannel {
    fn handle<'a>(
        &'a self,
        ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        let result = (self.0)(ctx, input);
        Box::pin(async move { result })
    }
}

fn get_info(ctx: &Ctx, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    let version = app(ctx)?.package_info().version.to_string();
    to_value(AppInfo {
        name: APP_NAME.into(),
        version,
        platform: "win32".into(),
    })
}

fn get_runtime(ctx: &Ctx, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    let shortcut = app(ctx)?
        .try_state::<Arc<ShortcutService>>()
        .ok_or_else(unavailable)?;
    to_value(Runtime {
        is_packaged: !cfg!(debug_assertions),
        shortcut_registered: shortcut.current().is_some(),
    })
}

/// The whole input is optional; the live path turns "not sent" into `null`.
fn open_cc(ctx: &Ctx, input: Value) -> Result<Value, ExposedError> {
    let page = if input.is_null() {
        None
    } else {
        Some(parse_input::<OpenControlCenterInput>(input)?.page)
    };
    open_control_center(app(ctx)?, page);
    Ok(Value::Null)
}

fn hide_notch(ctx: &Ctx, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    let notch = app(ctx)?
        .try_state::<Arc<NotchRuntime>>()
        .ok_or_else(unavailable)?;
    notch
        .controller
        .dispatch(NotchEvent::UserVisibility { hidden: true });
    Ok(Value::Null)
}

fn get_settings(ctx: &Ctx, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    let store = app(ctx)?
        .try_state::<SettingsStore>()
        .ok_or_else(unavailable)?;
    to_value(store.get())
}

struct UpdateSettings;

impl Channel for UpdateSettings {
    fn handle<'a>(
        &'a self,
        ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async move {
            let patch: SettingsPatch = parse_input(input)?;
            let saved = update_settings(app(ctx)?, patch).await?;
            to_value(saved)
        })
    }
}

pub fn register(registry: &mut Registry) {
    let channels: [(&str, Handler); 5] = [
        ("app:get-info", get_info),
        ("app:get-runtime", get_runtime),
        ("app:open-control-center", open_cc),
        ("app:hide-notch", hide_notch),
        ("settings:get", get_settings),
    ];
    for (name, handler) in channels {
        registry.register(name, SyncChannel(handler));
    }
    registry.register("settings:update", UpdateSettings);
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tauri::async_runtime::block_on;

    use super::*;
    use crate::ipc::{Sender, CONTROL_CENTER};

    fn registry() -> Registry {
        let mut registry = Registry::with_dev_origin(false);
        register(&mut registry);
        registry
    }

    fn call(channel: &str, input: Option<Value>) -> Value {
        let ctx = Ctx::for_test(Sender {
            label: CONTROL_CENTER.into(),
            url: "http://tauri.localhost/control-center/index.html"
                .parse()
                .unwrap(),
        });
        block_on(registry().dispatch(&ctx, channel, input))
    }

    fn code(response: &Value) -> &str {
        response["error"]["code"].as_str().unwrap_or("none")
    }

    #[test]
    fn inputs_are_checked_before_anything_else() {
        for channel in [
            "app:get-info",
            "app:get-runtime",
            "app:hide-notch",
            "settings:get",
        ] {
            assert_eq!(
                code(&call(channel, Some(json!({ "x": 1 })))),
                "INVALID_INPUT",
                "{channel}"
            );
            // Not sent (null on the live path): valid, then no app in a unit test.
            assert_eq!(code(&call(channel, None)), "UNAVAILABLE", "{channel}");
        }
        assert_eq!(
            code(&call(
                "app:open-control-center",
                Some(json!({ "page": "settings" }))
            )),
            "INVALID_INPUT"
        );
        assert_eq!(
            code(&call(
                "app:open-control-center",
                Some(json!({ "page": "gmail" }))
            )),
            "UNAVAILABLE"
        );
        assert_eq!(code(&call("app:open-control-center", None)), "UNAVAILABLE");
        assert_eq!(
            code(&call("settings:update", Some(json!({ "version": 8 })))),
            "INVALID_INPUT"
        );
        assert_eq!(code(&call("settings:update", None)), "INVALID_INPUT");
        assert_eq!(
            code(&call("settings:update", Some(json!({ "language": "en" })))),
            "UNAVAILABLE"
        );
    }
}
