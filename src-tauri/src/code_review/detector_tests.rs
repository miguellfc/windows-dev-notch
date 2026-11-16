//! Port of `tests/unit/main/code-review-detector.test.ts` (10 cases), plus the uncertain-item
//! merge of `runPoll` (`code-review-integration.test.ts`, GitLab per-MR failure rounds) as pure
//! functions.

use std::collections::HashSet;

use super::*;
use crate::code_review::client::snapshot;
use crate::code_review::client::ClientItem;
use crate::contract::code_review::{ReviewItem, COUNT_CAP};

use ReviewState::{Approved, Changes, Commented, None as Unreviewed};

fn own(entries: &[(&str, ReviewState)]) -> Vec<OwnReview> {
    entries
        .iter()
        .map(|(id, review)| OwnReview {
            id: (*id).to_owned(),
            review: *review,
        })
        .collect()
}

fn alert(id: &str, kind: ReviewKind) -> Alert {
    Alert {
        id: id.to_owned(),
        kind,
    }
}

#[test]
fn only_records_the_reference_on_the_first_observation() {
    let mut detector = ReviewDetector::new();
    assert_eq!(
        detector.observe(&own(&[("a", Approved), ("b", Unreviewed)])),
        []
    );
}

#[test]
fn reports_none_to_approved_changes_and_commented_with_their_kind() {
    for (review, kind) in [
        (Approved, ReviewKind::Approved),
        (Changes, ReviewKind::Changes),
        (Commented, ReviewKind::Commented),
    ] {
        let mut detector = ReviewDetector::new();
        detector.observe(&own(&[("a", Unreviewed)]));
        assert_eq!(
            detector.observe(&own(&[("a", review)])),
            [alert("a", kind)],
            "{kind:?}"
        );
    }
}

#[test]
fn reports_a_transition_once() {
    let mut detector = ReviewDetector::new();
    detector.observe(&own(&[("a", Unreviewed)]));
    assert_eq!(
        detector.observe(&own(&[("a", Approved)])),
        [alert("a", ReviewKind::Approved)]
    );
    assert_eq!(detector.observe(&own(&[("a", Approved)])), []);
}

#[test]
fn does_not_report_an_already_reviewed_item_that_changes_kind() {
    let mut detector = ReviewDetector::new();
    detector.observe(&own(&[("a", Commented)]));
    assert_eq!(detector.observe(&own(&[("a", Approved)])), []);
    assert_eq!(detector.observe(&own(&[("a", Changes)])), []);
}

#[test]
fn does_not_report_items_that_disappear_closed_or_merged() {
    let mut detector = ReviewDetector::new();
    detector.observe(&own(&[("a", Unreviewed), ("b", Unreviewed)]));
    assert_eq!(detector.observe(&own(&[("b", Unreviewed)])), []);
}

#[test]
fn does_not_report_a_new_item_that_is_already_reviewed() {
    let mut detector = ReviewDetector::new();
    detector.observe(&own(&[("a", Unreviewed)]));
    assert_eq!(
        detector.observe(&own(&[("a", Unreviewed), ("b", Approved)])),
        []
    );
}

#[test]
fn reports_a_new_item_only_after_it_was_seen_unreviewed() {
    let mut detector = ReviewDetector::new();
    detector.observe(&own(&[]));
    assert_eq!(detector.observe(&own(&[("b", Unreviewed)])), []);
    assert_eq!(
        detector.observe(&own(&[("b", Changes)])),
        [alert("b", ReviewKind::Changes)]
    );
}

#[test]
fn reports_several_at_once_in_list_order() {
    let mut detector = ReviewDetector::new();
    detector.observe(&own(&[
        ("a", Unreviewed),
        ("b", Unreviewed),
        ("c", Unreviewed),
        ("d", Approved),
    ]));
    assert_eq!(
        detector.observe(&own(&[
            ("c", Commented),
            ("a", Approved),
            ("b", Unreviewed),
            ("d", Approved),
        ])),
        [
            alert("c", ReviewKind::Commented),
            alert("a", ReviewKind::Approved)
        ]
    );
}

#[test]
fn reset_makes_the_next_observation_a_baseline_again() {
    let mut detector = ReviewDetector::new();
    detector.observe(&own(&[("a", Unreviewed)]));
    detector.reset();
    assert_eq!(detector.observe(&own(&[("a", Approved)])), []);
    assert_eq!(detector.observe(&own(&[("a", Approved)])), []);
}

#[test]
fn a_reopened_item_that_comes_back_reviewed_does_not_alert() {
    let mut detector = ReviewDetector::new();
    detector.observe(&own(&[("a", Unreviewed)]));
    detector.observe(&own(&[]));
    assert_eq!(detector.observe(&own(&[("a", Approved)])), []);
}

// --- Rust port: the pure diff and `new Map` semantics -----------------------------------------

#[test]
fn detect_first_reviews_is_the_pure_diff() {
    let states = |entries: &[(&str, ReviewState)]| -> ReviewStates {
        entries
            .iter()
            .map(|(id, review)| ((*id).to_owned(), *review))
            .collect()
    };
    let current = states(&[("a", Approved), ("b", Unreviewed)]);
    assert_eq!(detect_first_reviews(None, &current), []);
    let previous = states(&[("a", Unreviewed), ("b", Unreviewed)]);
    assert_eq!(
        detect_first_reviews(Some(&previous), &current),
        [alert("a", ReviewKind::Approved)]
    );
}

/// `new Map(own.map(...))`: a repeated id keeps its first position and its last state.
#[test]
fn a_repeated_id_keeps_its_first_position_and_last_state() {
    let mut detector = ReviewDetector::new();
    detector.observe(&own(&[("a", Unreviewed), ("b", Unreviewed)]));
    assert_eq!(
        detector.observe(&own(&[("a", Unreviewed), ("b", Approved), ("a", Changes)])),
        [
            alert("a", ReviewKind::Changes),
            alert("b", ReviewKind::Approved)
        ]
    );
    // The reference kept `a` as `changes` (its last state), so nothing more.
    assert_eq!(detector.observe(&own(&[("a", Changes)])), []);
}

// --- runPoll's uncertain items (integration "GitLab:" cases, as pure rounds) ------------------

fn item(id: &str, review: ReviewState, draft: bool) -> ClientItem {
    ClientItem {
        item: ReviewItem {
            id: id.to_owned(),
            reference: format!("grp/proj!{id}"),
            title: format!("MR {id}"),
            author: "me".into(),
            updated_at: "2026-11-12T10:00:00Z".into(),
            draft,
            review,
            checks: None,
            conflicts: false,
        },
        url: format!("https://gitlab.example.test/grp/proj/-/merge_requests/{id}"),
    }
}

/// Like the clients build it: `uncertain` ids are left out of `own_review`, and their degraded
/// `none` is in the count.
fn snap(mine: &[(&str, ReviewState)], uncertain: &[&str]) -> CodeReviewSnapshot {
    let mine = mine
        .iter()
        .map(|(id, review)| item(id, *review, false))
        .collect();
    let uncertain: HashSet<String> = uncertain.iter().map(|id| (*id).to_owned()).collect();
    snapshot(Vec::new(), mine, &uncertain)
}

/// One `runPoll` round: merge, then observe; returns the alerts and the count.
fn round(
    detector: &mut ReviewDetector,
    remembered: &mut HashMap<String, ReviewState>,
    snapshot: &CodeReviewSnapshot,
) -> (Vec<Alert>, u32) {
    let observation = merge_uncertain(snapshot, remembered);
    *remembered = observation.remembered;
    (
        detector.observe(&observation.observed),
        observation.unreviewed,
    )
}

// GitLab: an MR reviewed during a transient per-MR failure still alerts once the data returns.
#[test]
fn an_mr_reviewed_during_a_transient_per_mr_failure_still_alerts_once_the_data_returns() {
    let mut detector = ReviewDetector::new();
    let mut remembered = HashMap::new();
    let r1 = round(
        &mut detector,
        &mut remembered,
        &snap(&[("7", Unreviewed), ("8", Unreviewed)], &[]),
    );
    assert_eq!(r1, (vec![], 2));
    // Reviewed meanwhile, but the per-MR calls failed: degraded to `none`, uncertain.
    let r2 = round(
        &mut detector,
        &mut remembered,
        &snap(&[("7", Unreviewed), ("8", Unreviewed)], &["7"]),
    );
    assert_eq!(r2, (vec![], 2));
    let r3 = round(
        &mut detector,
        &mut remembered,
        &snap(&[("7", Approved), ("8", Unreviewed)], &[]),
    );
    assert_eq!(r3, (vec![alert("7", ReviewKind::Approved)], 1));
}

// GitLab: an uncertain MR keeps its previous state in the count (no jump).
#[test]
fn an_uncertain_mr_keeps_its_previous_state_in_the_count_no_jump() {
    let mut detector = ReviewDetector::new();
    let mut remembered = HashMap::new();
    // Round 1: 7 approved, 8 unreviewed -> 1.
    let r = round(
        &mut detector,
        &mut remembered,
        &snap(&[("7", Approved), ("8", Unreviewed)], &[]),
    );
    assert_eq!(r.1, 1);
    // Round 2: 7's calls fail and it degrades to `none` -> the client counts 2; the merge keeps 1.
    let degraded = snap(&[("7", Unreviewed), ("8", Unreviewed)], &["7"]);
    assert_eq!(degraded.unreviewed, 2);
    let r = round(&mut detector, &mut remembered, &degraded);
    assert_eq!(r.1, 1);
    assert_eq!(remembered.get("7"), Some(&Approved));
    // Round 3: an unknown MR (never seen) is uncertain: left out of the count and the detector.
    let r = round(
        &mut detector,
        &mut remembered,
        &snap(
            &[("7", Approved), ("8", Unreviewed), ("9", Unreviewed)],
            &["9"],
        ),
    );
    assert_eq!(r.1, 1);
    assert!(!remembered.contains_key("9"));
    // Round 4: 9 shows up reviewed; it was never known as `none`, so no first review.
    let r = round(
        &mut detector,
        &mut remembered,
        &snap(&[("7", Approved), ("8", Unreviewed), ("9", Approved)], &[]),
    );
    assert_eq!(r, (vec![], 1));
}

#[test]
fn an_uncertain_item_remembered_as_none_stays_counted_and_observed() {
    let remembered: HashMap<String, ReviewState> = [("5".to_owned(), Unreviewed)].into();
    let observation = merge_uncertain(&snap(&[("5", Unreviewed)], &["5"]), &remembered);
    assert_eq!(observation.unreviewed, 1);
    assert_eq!(observation.observed, own(&[("5", Unreviewed)]));
    assert_eq!(observation.remembered, remembered);
}

#[test]
fn drafts_are_skipped_and_the_count_is_clamped() {
    // A draft is neither observed nor remembered.
    let mut mine: Vec<ClientItem> = vec![item("d", Unreviewed, true)];
    mine.push(item("1", Approved, false));
    let snapshot = snapshot(Vec::new(), mine, &HashSet::new());
    let observation = merge_uncertain(&snapshot, &HashMap::new());
    assert_eq!(observation.observed, own(&[("1", Approved)]));
    assert!(!observation.remembered.contains_key("d"));
    assert_eq!(observation.unreviewed, 0);

    // Remembered `none` items lift the count, never past the cap.
    let mut capped = snap(&[("u", Unreviewed)], &["u"]);
    capped.unreviewed = COUNT_CAP + 5;
    let remembered: HashMap<String, ReviewState> = [("u".to_owned(), Unreviewed)].into();
    assert_eq!(merge_uncertain(&capped, &remembered).unreviewed, COUNT_CAP);
    // A degraded `none` taken off a count of 0 never goes below 0.
    let mut floor = snap(&[("u", Unreviewed)], &["u"]);
    floor.unreviewed = 0;
    assert_eq!(merge_uncertain(&floor, &HashMap::new()).unreviewed, 0);
}
