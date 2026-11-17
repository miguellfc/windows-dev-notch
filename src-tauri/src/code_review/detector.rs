//! First-review detection (0.1.0's `review-detector.ts`) by diffing the review state
//! of the own open PR/MRs between queries (no extra requests; in memory only, so a restart is a
//! new baseline), plus the integration's handling of uncertain items (`runPoll`): own items whose
//! per-MR calls failed this round keep their last known state, for both the detector and the
//! unreviewed count.

use std::collections::HashMap;

use super::client::{CodeReviewSnapshot, OwnReview};
use crate::contract::code_review::{ReviewKind, ReviewState, COUNT_CAP};

/// One own PR/MR that went from `none` to reviewed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Alert {
    pub id: String,
    pub kind: ReviewKind,
}

/// The review state of each own item by id, in list order (`new Map(own.map(...))`: a repeated
/// id keeps its first position and its last state).
pub type ReviewStates = Vec<(String, ReviewState)>;

/// `observe`'s diff: the items of `current` (list order) that were `none` in `previous` and are
/// reviewed now. With no `previous` (first observation) nothing is reported. Disappeared items,
/// new items already reviewed and reviewed items that change kind are not reported.
pub fn detect_first_reviews(previous: Option<&ReviewStates>, current: &ReviewStates) -> Vec<Alert> {
    let Some(before) = previous else {
        return Vec::new();
    };
    current
        .iter()
        .filter(|(id, _)| state_of(before, id) == Some(ReviewState::None))
        .filter_map(|(id, review)| {
            reviewed_kind(*review).map(|kind| Alert {
                id: id.clone(),
                kind,
            })
        })
        .collect()
}

fn state_of(states: &ReviewStates, id: &str) -> Option<ReviewState> {
    states
        .iter()
        .find(|(known, _)| known == id)
        .map(|(_, review)| *review)
}

/// The kind of a reviewed state (`none` is no review).
fn reviewed_kind(review: ReviewState) -> Option<ReviewKind> {
    match review {
        ReviewState::None => None,
        ReviewState::Approved => Some(ReviewKind::Approved),
        ReviewState::Changes => Some(ReviewKind::Changes),
        ReviewState::Commented => Some(ReviewKind::Commented),
    }
}

/// `new Map(own.map(({id, review}) => [id, review]))`.
fn states_of(own: &[OwnReview]) -> ReviewStates {
    let mut states: ReviewStates = Vec::with_capacity(own.len());
    for OwnReview { id, review } in own {
        match states.iter_mut().find(|(known, _)| known == id) {
            Some(entry) => entry.1 = *review,
            None => states.push((id.clone(), *review)),
        }
    }
    states
}

/// `createReviewDetector()`.
#[derive(Debug, Default)]
pub struct ReviewDetector {
    previous: Option<ReviewStates>,
}

impl ReviewDetector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records `own` as the new reference and returns the first reviews since the previous one.
    pub fn observe(&mut self, own: &[OwnReview]) -> Vec<Alert> {
        let current = states_of(own);
        let alerts = detect_first_reviews(self.previous.as_ref(), &current);
        self.previous = Some(current);
        alerts
    }

    /// Forgets the reference: the next observation is a baseline again (token or URL change).
    pub fn reset(&mut self) {
        self.previous = None;
    }
}

/// What `runPoll` takes from a snapshot once the uncertain items are merged.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Observation {
    /// What the detector observes this round.
    pub observed: Vec<OwnReview>,
    /// The known state of each own open item, for the next round.
    pub remembered: HashMap<String, ReviewState>,
    /// Own open items without review, `0..=COUNT_CAP`.
    pub unreviewed: u32,
}

/// `runPoll`'s merge: an own open item missing from `own_review` (a per-MR call failed) is
/// uncertain. Its degraded `none` is taken off the client's count; with a remembered state it is
/// observed and counted with that state, never seen before it is left out of both.
pub fn merge_uncertain(
    snapshot: &CodeReviewSnapshot,
    remembered: &HashMap<String, ReviewState>,
) -> Observation {
    let certain: HashMap<&str, ReviewState> = snapshot
        .own_review
        .iter()
        .map(|own| (own.id.as_str(), own.review))
        .collect();
    let mut observation = Observation::default();
    let mut unreviewed = i64::from(snapshot.unreviewed);
    for own in snapshot.mine.iter().map(|client| &client.item) {
        if own.draft {
            continue;
        }
        if let Some(&known) = certain.get(own.id.as_str()) {
            observation.observed.push(OwnReview {
                id: own.id.clone(),
                review: known,
            });
            observation.remembered.insert(own.id.clone(), known);
            continue;
        }
        if own.review == ReviewState::None {
            unreviewed -= 1; // counted from degraded data by the client
        }
        let Some(&previous) = remembered.get(&own.id) else {
            continue;
        };
        observation.observed.push(OwnReview {
            id: own.id.clone(),
            review: previous,
        });
        observation.remembered.insert(own.id.clone(), previous);
        if previous == ReviewState::None {
            unreviewed += 1;
        }
    }
    observation.unreviewed =
        u32::try_from(unreviewed.clamp(0, i64::from(COUNT_CAP))).unwrap_or(COUNT_CAP);
    observation
}

#[cfg(test)]
#[path = "detector_tests.rs"]
mod tests;
