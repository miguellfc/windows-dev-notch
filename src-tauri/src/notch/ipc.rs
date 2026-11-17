//! The `notch:*` channels (handlers in 0.1.0's `index.ts`).
//!
//! The registry is built before the window and its controller exist, so the handlers read them
//! from a [`NotchSlot`] filled in `setup`; until then they answer UNAVAILABLE.

use std::sync::{Arc, OnceLock};

use serde_json::Value;

use super::controller::NotchController;
use super::cursor::CapsuleRectStore;
use super::geometry::Rect;
use super::state::NotchEvent;
use crate::contract::notch::{
    CapsuleRectInput, Intent, OpenIntegrationInput, PointerInput, RequestInput,
};
use crate::contract::parse_input;
use crate::ipc::{no_input, BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry};

/// What the notch handlers act on.
pub struct NotchHandles {
    pub controller: Arc<NotchController>,
    pub rects: Arc<CapsuleRectStore>,
}

pub type NotchSlot = OnceLock<NotchHandles>;

type Handler = fn(&NotchHandles, Value) -> Result<Value, ExposedError>;

struct NotchChannel {
    slot: Arc<NotchSlot>,
    handler: Handler,
}

impl Channel for NotchChannel {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        let result = match self.slot.get() {
            Some(handles) => (self.handler)(handles, input),
            None => Err(ExposedError::new(
                IpcErrorCode::Unavailable,
                "Not available yet",
            )),
        };
        Box::pin(async move { result })
    }
}

fn intent_event(intent: Intent) -> NotchEvent {
    match intent {
        Intent::Expand => NotchEvent::Expand,
        Intent::Dismiss => NotchEvent::Dismiss,
        Intent::Toggle => NotchEvent::Toggle,
        Intent::Next => NotchEvent::Next,
        Intent::PinMini => NotchEvent::PinMini,
        Intent::UnpinMini => NotchEvent::UnpinMini,
    }
}

fn get_mode(notch: &NotchHandles, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    Ok(Value::from(notch.controller.mode().as_str()))
}

fn request(notch: &NotchHandles, input: Value) -> Result<Value, ExposedError> {
    let RequestInput { intent } = parse_input(input)?;
    notch.controller.dispatch(intent_event(intent));
    Ok(Value::Null)
}

/// Tauri's hover comes from the cursor poller (`cursor.rs`), not the renderer: the call is
/// validated and ignored. The `e2e` build lets tests drive hover without moving the real cursor.
fn pointer(notch: &NotchHandles, input: Value) -> Result<Value, ExposedError> {
    let PointerInput { inside } = parse_input(input)?;
    if cfg!(feature = "e2e") {
        notch.controller.dispatch(NotchEvent::Pointer { inside });
    }
    Ok(Value::Null)
}

fn settled(notch: &NotchHandles, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    notch.controller.settled();
    Ok(Value::Null)
}

fn open_integration(notch: &NotchHandles, input: Value) -> Result<Value, ExposedError> {
    let OpenIntegrationInput { id } = parse_input(input)?;
    notch
        .controller
        .dispatch(NotchEvent::OpenIntegration { id });
    Ok(Value::Null)
}

fn back(notch: &NotchHandles, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    notch.controller.dispatch(NotchEvent::Back);
    Ok(Value::Null)
}

fn capsule_rect(notch: &NotchHandles, input: Value) -> Result<Value, ExposedError> {
    let CapsuleRectInput {
        x,
        y,
        width,
        height,
    } = parse_input(input)?;
    notch.rects.set(Rect {
        x,
        y,
        width,
        height,
    });
    Ok(Value::Null)
}

pub fn register(registry: &mut Registry, slot: &Arc<NotchSlot>) {
    let channels: [(&str, Handler); 7] = [
        ("notch:get-mode", get_mode),
        ("notch:request", request),
        ("notch:pointer", pointer),
        ("notch:settled", settled),
        ("notch:open-integration", open_integration),
        ("notch:back", back),
        ("notch:capsule-rect", capsule_rect),
    ];
    for (name, handler) in channels {
        registry.register(
            name,
            NotchChannel {
                slot: Arc::clone(slot),
                handler,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tauri::async_runtime::block_on;

    use super::*;
    use crate::ipc::{Sender, CONTROL_CENTER, NOTCH};
    use crate::notch::controller::NotchSurface;
    use crate::notch::state::NotchMode;
    use crate::services::timers::TestTimers;

    struct NoSurface;

    impl NotchSurface for NoSurface {
        fn set_bounds(&self, _rect: Rect) {}
        fn show(&self) {}
        fn hide(&self) {}
        fn focus(&self) {}
        fn blur(&self) {}
        fn set_ignore_mouse(&self, _ignore: bool) {}
        fn send_mode(&self, _mode: NotchMode) {}
        fn send_mail_alert(&self, _on: bool) {}
        fn send_review_alert(&self, _on: bool) {}
        fn send_redmine_alert(&self, _on: bool) {}
    }

    struct Setup {
        registry: Registry,
        slot: Arc<NotchSlot>,
    }

    fn setup(filled: bool) -> Setup {
        let slot = Arc::new(NotchSlot::new());
        let mut registry = Registry::with_dev_origin(false);
        register(&mut registry, &slot);
        if filled {
            let controller = NotchController::new(
                Arc::new(NoSurface),
                Arc::new(TestTimers::new()),
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1920.0,
                    height: 1032.0,
                },
                400,
            );
            controller.start();
            let handles = NotchHandles {
                controller,
                rects: Arc::new(CapsuleRectStore::new()),
            };
            assert!(slot.set(handles).is_ok());
        }
        Setup { registry, slot }
    }

    fn from(label: &str) -> Ctx {
        let page = if label == NOTCH {
            "notch"
        } else {
            "control-center"
        };
        Ctx::for_test(Sender {
            label: label.into(),
            url: format!("http://tauri.localhost/{page}/index.html")
                .parse()
                .unwrap(),
        })
    }

    impl Setup {
        fn call(&self, label: &str, channel: &str, input: Option<Value>) -> Value {
            block_on(self.registry.dispatch(&from(label), channel, input))
        }

        fn mode(&self) -> NotchMode {
            self.slot.get().unwrap().controller.mode()
        }
    }

    fn ok(data: Value) -> Value {
        json!({ "ok": true, "data": data })
    }

    fn code(response: &Value) -> &str {
        response["error"]["code"].as_str().unwrap_or("none")
    }

    #[test]
    fn requests_drive_the_controller() {
        let s = setup(true);
        assert_eq!(s.call(NOTCH, "notch:get-mode", None), ok(json!("peek")));
        assert_eq!(
            s.call(NOTCH, "notch:request", Some(json!({ "intent": "toggle" }))),
            ok(Value::Null)
        );
        assert_eq!(s.mode(), NotchMode::Expanded);
        assert_eq!(
            s.call(
                NOTCH,
                "notch:open-integration",
                Some(json!({ "id": "notes" }))
            ),
            ok(Value::Null)
        );
        assert_eq!(s.mode(), NotchMode::Notes);
        assert_eq!(s.call(NOTCH, "notch:back", None), ok(Value::Null));
        assert_eq!(s.mode(), NotchMode::Expanded);
        assert_eq!(s.call(NOTCH, "notch:settled", None), ok(Value::Null));
        // Any trusted window may use them, as in Electron.
        assert_eq!(
            s.call(CONTROL_CENTER, "notch:get-mode", None),
            ok(json!("expanded"))
        );
    }

    #[test]
    fn invalid_inputs_are_refused() {
        let s = setup(true);
        let bad = [
            ("notch:get-mode", json!({})),
            ("notch:settled", json!(false)),
            ("notch:back", json!({})),
            ("notch:request", json!({ "intent": "explode" })),
            ("notch:pointer", json!({ "inside": "yes" })),
            ("notch:open-integration", json!({ "id": "terminal" })),
            (
                "notch:capsule-rect",
                json!({ "x": -1, "y": 0, "width": 1, "height": 1 }),
            ),
        ];
        for (channel, input) in bad {
            assert_eq!(
                code(&s.call(NOTCH, channel, Some(input))),
                "INVALID_INPUT",
                "{channel}"
            );
        }
        assert_eq!(code(&s.call(NOTCH, "notch:request", None)), "INVALID_INPUT");
        assert_eq!(s.mode(), NotchMode::Peek);
    }

    #[test]
    fn pointer_is_accepted_and_ignored_without_e2e() {
        let s = setup(true);
        let response = s.call(NOTCH, "notch:pointer", Some(json!({ "inside": true })));
        assert_eq!(response, ok(Value::Null));
        let expected = if cfg!(feature = "e2e") {
            NotchMode::Compact
        } else {
            NotchMode::Peek
        };
        assert_eq!(s.mode(), expected);
    }

    #[test]
    fn capsule_rect_is_kept_and_only_the_notch_may_send_it() {
        let s = setup(true);
        let rect = json!({ "x": 201, "y": 6, "width": 358.5, "height": 36 });
        assert_eq!(
            s.call(NOTCH, "notch:capsule-rect", Some(rect.clone())),
            ok(Value::Null)
        );
        assert_eq!(
            s.slot.get().unwrap().rects.last(),
            Some(Rect {
                x: 201.0,
                y: 6.0,
                width: 358.5,
                height: 36.0
            })
        );
        let other = json!({ "x": 0, "y": 0, "width": 10, "height": 10 });
        assert_eq!(
            code(&s.call(CONTROL_CENTER, "notch:capsule-rect", Some(other))),
            "FORBIDDEN"
        );
        assert_eq!(s.slot.get().unwrap().rects.last().unwrap().x, 201.0);
    }

    #[test]
    fn unavailable_until_the_window_exists() {
        let s = setup(false);
        assert_eq!(code(&s.call(NOTCH, "notch:get-mode", None)), "UNAVAILABLE");
    }
}
