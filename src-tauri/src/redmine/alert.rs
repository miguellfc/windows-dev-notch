//! The end-of-day alert wired to the app (port of the `createEndOfDayScheduler` call in
//! `src/main/index.ts`): the readings it takes from the Redmine integration, how the alert
//! reaches the capsule, and the power hook (resume or unlock runs a check, like Electron's
//! `powerMonitor.on('resume' | 'unlock-screen', check)`).

use std::sync::{Arc, Weak};

use chrono::TimeZone;

use super::end_of_day::{EndOfDay, EndOfDayOptions, EndOfDaySettings};
use super::integration::RedmineIntegration;
use crate::contract::redmine::{RedmineAlert, RedmineStatus};
use crate::notch::controller::NotchController;
use crate::notch::state::{NotchEvent, NotchMode, PANEL_MODES};
use crate::platform::power::{PowerEvents, PowerListener};
use crate::services::clock::WallClock;
use crate::services::timers::Timers;

/// The capsule as far as the end-of-day alert goes.
pub trait AlertNotch: Send + Sync {
    /// The notch's mode, `None` while its window does not exist (`notchWindow.isDestroyed()`).
    fn mode(&self) -> Option<NotchMode>;
    /// `redmine:alert` with its payload, to the notch only.
    fn emit(&self, alert: &RedmineAlert);
    fn dispatch(&self, event: NotchEvent);
}

/// `onAlert`: refused (`false`) without a notch or with a panel open, where the controller
/// would drop the alert; the scheduler then offers it again on its next check. Otherwise the
/// payload goes first, so the capsule already knows what to show (and the renderer whether to
/// chime) when the mode turns to alert, then the alert itself (ended after 6 s).
pub fn offer(notch: &dyn AlertNotch, alert: RedmineAlert) -> bool {
    match notch.mode() {
        Some(mode) if !PANEL_MODES.contains(&mode) => {
            notch.emit(&alert);
            notch.dispatch(NotchEvent::Redmine { on: true });
            true
        }
        _ => false,
    }
}

/// The real capsule: the notch window of `app` and its controller. `dispatch` runs window
/// effects, which Tauri marshals to the main thread; no lock is held while window effects run,
/// so any thread may offer the alert.
pub struct AppAlertNotch {
    pub app: tauri::AppHandle,
    pub controller: Arc<NotchController>,
}

impl AlertNotch for AppAlertNotch {
    fn mode(&self) -> Option<NotchMode> {
        use tauri::Manager;
        self.app
            .get_webview_window(crate::ipc::NOTCH)
            .map(|_| self.controller.mode())
    }

    fn emit(&self, alert: &RedmineAlert) {
        crate::ipc::emit_event(&self.app, &[crate::ipc::NOTCH], "redmine:alert", alert);
    }

    fn dispatch(&self, event: NotchEvent) {
        self.controller.dispatch(event);
    }
}

/// What the end of day reads from the integration.
pub trait Readings: Send + Sync {
    /// Hours logged today, `None` before the first reading (or once the day changed).
    fn today_hours(&self) -> Option<f64>;
    fn status(&self) -> RedmineStatus;
}

impl<Tz> Readings for RedmineIntegration<Tz>
where
    Tz: TimeZone + Send + Sync + 'static,
    Tz::Offset: Send + Sync,
{
    fn today_hours(&self) -> Option<f64> {
        RedmineIntegration::today_hours(self)
    }

    fn status(&self) -> RedmineStatus {
        self.state().status
    }
}

/// Where resume and unlock come from (`PowerEvents`; a fake in tests).
pub trait PowerSource {
    fn subscribe(&self, listener: PowerListener);
}

impl PowerSource for PowerEvents {
    fn subscribe(&self, listener: PowerListener) {
        PowerEvents::subscribe(self, listener);
    }
}

/// The inputs of [`install_end_of_day`].
pub struct EndOfDayWiring {
    pub settings: Arc<dyn EndOfDaySettings>,
    pub clock: Arc<WallClock>,
    pub timers: Arc<dyn Timers>,
    /// Weak: the integration is owned by the app; once gone there is nothing to alert about.
    pub redmine: Weak<dyn Readings>,
    pub notch: Arc<dyn AlertNotch>,
}

/// Creates the scheduler (not started: `start()` comes after the channels, as in Electron) and
/// subscribes it to resume and unlock. A late power event after `dispose` is a no-op.
pub fn install_end_of_day<Tz>(
    wiring: EndOfDayWiring,
    tz: Tz,
    power: &dyn PowerSource,
) -> Arc<EndOfDay<Tz>>
where
    Tz: TimeZone + Send + Sync + 'static,
    Tz::Offset: Send + Sync,
{
    let EndOfDayWiring {
        settings,
        clock,
        timers,
        redmine,
        notch,
    } = wiring;
    let today_hours = {
        let redmine = Weak::clone(&redmine);
        Box::new(move || redmine.upgrade().and_then(|r| r.today_hours()))
    };
    let is_connected = Box::new(move || {
        redmine
            .upgrade()
            .is_some_and(|r| matches!(r.status(), RedmineStatus::Ok | RedmineStatus::Offline))
    });
    let end_of_day = EndOfDay::new(
        EndOfDayOptions {
            settings,
            clock,
            timers,
            today_hours,
            is_connected,
            on_alert: Box::new(move |alert| offer(notch.as_ref(), alert)),
        },
        tz,
    );
    power.subscribe(end_of_day.power_listener());
    end_of_day
}

#[cfg(test)]
#[path = "alert_tests.rs"]
mod tests;
