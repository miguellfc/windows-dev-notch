//! Background-task helpers the integrations share (code review, Redmine, Gmail).

use std::sync::Arc;

use tokio::sync::watch;

use crate::ipc::BoxFuture;

/// Runs a task in the background (`tauri::async_runtime::spawn`; `tokio::spawn` in tests).
pub type Spawner = Arc<dyn Fn(BoxFuture<'static, ()>) + Send + Sync>;

/// Waits until `signal` turns `true`. `None` (nothing in flight) returns at once.
pub async fn finished(signal: Option<watch::Receiver<bool>>) {
    if let Some(mut signal) = signal {
        // A dropped sender (the task ended without signalling) counts as finished.
        let _ = signal.wait_for(|done| *done).await;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    #[tokio::test]
    async fn nothing_in_flight_is_finished_at_once() {
        finished(None).await;
    }

    #[tokio::test]
    async fn waits_until_the_signal_turns_true() {
        let (done, signal) = watch::channel(false);
        let waiter = tokio::spawn(finished(Some(signal)));
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!waiter.is_finished());
        done.send_replace(true);
        waiter.await.unwrap();
    }

    #[tokio::test]
    async fn a_dropped_sender_counts_as_finished() {
        let (done, signal) = watch::channel(false);
        drop(done);
        finished(Some(signal)).await;
    }

    #[tokio::test]
    async fn the_spawner_runs_the_task() {
        let spawn: Spawner = Arc::new(|task| {
            tokio::spawn(task);
        });
        let (done, mut signal) = watch::channel(false);
        spawn(Box::pin(async move {
            done.send_replace(true);
        }));
        signal.wait_for(|done| *done).await.unwrap();
    }
}
