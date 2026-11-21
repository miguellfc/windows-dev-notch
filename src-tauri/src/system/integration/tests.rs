//! The integration's start behaviour (`system-integration.ts`: current mode, unavailable,
//! dispose). The channels it used to register went with the System view.

use std::sync::atomic::AtomicU64;

use super::*;
use crate::contract::system::{SystemMetrics, Unavailable};
use crate::services::timers::TestTimers;
use crate::settings::default_settings;
use crate::system::fake::FakeSystemApi;
use crate::system::monitor::LIGHT_INTERVAL_MS;

type Sent = Arc<Mutex<Vec<SystemMetrics>>>;

fn options(api: Option<Arc<dyn SystemApi>>, timers: Arc<TestTimers>, sent: &Sent) -> StartOptions {
    let clock = Arc::new(AtomicU64::new(0));
    StartOptions {
        api,
        timers,
        now: Arc::new(move || clock.load(Ordering::SeqCst)),
        executor: Arc::new(|job| job()),
        alert_settings: Box::new(|| default_settings("en").system_alerts),
        on_metrics: {
            let sent = Arc::clone(sent);
            Box::new(move |metrics| sent.lock().unwrap().push(metrics.clone()))
        },
    }
}

#[test]
fn start_applies_the_current_mode_and_dispose_stops_sampling() {
    let api = Arc::new(FakeSystemApi::new());
    let timers = Arc::new(TestTimers::new());
    let sent: Sent = Arc::default();
    let system = SystemIntegration::new();
    // Before start: the mode is ignored and nothing is sampled.
    system.set_mode(NotchMode::Compact);
    system.resync();
    assert!(sent.lock().unwrap().is_empty());
    system.start(
        options(Some(api as Arc<dyn SystemApi>), Arc::clone(&timers), &sent),
        || NotchMode::Compact,
    );
    let first = sent.lock().unwrap().clone();
    assert_eq!(first.len(), 1);
    assert!(matches!(first[0], SystemMetrics::Light(_)));
    // Every panel samples on the light rhythm too: the panel header shows the same metrics.
    system.set_mode(NotchMode::Expanded);
    timers.advance(LIGHT_INTERVAL_MS);
    assert_eq!(sent.lock().unwrap().len(), 2);
    assert!(sent
        .lock()
        .unwrap()
        .iter()
        .all(|metrics| matches!(metrics, SystemMetrics::Light(_))));
    system.dispose();
    timers.advance(10 * LIGHT_INTERVAL_MS);
    assert_eq!(sent.lock().unwrap().len(), 2);
}

#[test]
fn start_without_the_win32_api_reports_unavailable_and_again_on_resync() {
    let timers = Arc::new(TestTimers::new());
    let sent: Sent = Arc::default();
    let system = SystemIntegration::new();
    system.start(options(None, timers, &sent), || NotchMode::Compact);
    let unavailable = SystemMetrics::Unavailable(Unavailable {});
    assert_eq!(*sent.lock().unwrap(), std::slice::from_ref(&unavailable));
    system.resync();
    assert_eq!(*sent.lock().unwrap(), [unavailable.clone(), unavailable]);
}

#[test]
fn a_start_after_dispose_does_nothing() {
    let sent: Sent = Arc::default();
    let system = SystemIntegration::new();
    system.dispose();
    system.start(options(None, Arc::new(TestTimers::new()), &sent), || {
        NotchMode::Compact
    });
    assert!(sent.lock().unwrap().is_empty());
}
