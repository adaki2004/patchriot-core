//! Long-running settlement worker. It has no wallet key: it records provider
//! receipts and delivers saved funding/cancellation events to the dispatcher.

use super::*;
use std::future::Future;

#[derive(Default, Serialize)]
pub struct Tick {
    cancellations: Option<cancellation::CancellationSummary>,
    reconciliation: Option<PollSummary>,
    funding: Option<funding::DeliverySummary>,
    errors: Vec<&'static str>,
}

impl Tick {
    fn has_activity(&self) -> bool {
        !self.errors.is_empty()
            || self.cancellations.as_ref().is_some_and(|s| s.checked > 0)
            || self.reconciliation.as_ref().is_some_and(|s| s.checked > 0)
            || self.funding.as_ref().is_some_and(|s| s.checked > 0)
    }
}

/// Each stage uses committed database claims and can recover after restart.
/// One failed stage must not prevent cancellation or previously funded work.
pub async fn tick(state: &AppState, provider: &OneClick) -> Tick {
    let mut result = Tick::default();
    match cancellation::deliver_once(state).await {
        Ok(summary) => result.cancellations = Some(summary),
        Err(_) => result.errors.push("cancellation_unavailable"),
    }
    match reconcile_once(&state.pool, provider).await {
        Ok(summary) => result.reconciliation = Some(summary),
        Err(_) => result.errors.push("reconciliation_unavailable"),
    }
    match funding::deliver_once(state).await {
        Ok(summary) => result.funding = Some(summary),
        Err(_) => result.errors.push("funding_unavailable"),
    }
    result
}

pub async fn run(state: &AppState, provider: &OneClick, stop: impl Future<Output = ()>) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(10));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let work = async {
        loop {
            interval.tick().await;
            let result = tick(state, provider).await;
            if result.has_activity() {
                // Counts and fixed error codes only. Never log provider bodies,
                // customer IDs, deposit addresses, credentials or private work.
                if let Ok(line) = serde_json::to_string(&result) {
                    eprintln!("{line}");
                }
            }
        }
    };
    tokio::select! {
        biased;
        _ = stop => {},
        _ = work => {},
    }
    // An interrupted request may have reached its peer. Saved claims expire;
    // the next worker reads the existing receipt before repeating activation.
}
