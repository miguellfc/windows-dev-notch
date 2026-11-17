//! What the GitHub and GitLab clients share (`src/main/code-review/client-common.ts`): the
//! snapshot built from the mapped lists and the code review texts. The generic half (error codes,
//! status mapping, requests, JSON bodies, `clip`, the pool) lives in [`crate::http::common`] and
//! is re-exported here under its part 4 names.

use std::collections::HashSet;

use chrono::{DateTime, Utc};

use crate::contract::code_review::{
    ContributionSummary, ReviewItem, ReviewState, LIST_LIMIT, TEXT_MAX,
};
pub use crate::http::common::{
    clip, is_redirect, map_pool, read_json, send, send_ok, send_raw, status_error,
    ApiError as CodeReviewError,
};
use crate::ipc::BoxFuture;

/// `ClientItem`: an item plus the URL main opens in the browser (never sent to the renderer).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientItem {
    pub item: ReviewItem,
    pub url: String,
}

/// Review state of one own open, non-draft PR/MR (what the first-review detector observes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnReview {
    pub id: String,
    pub review: ReviewState,
}

/// `CodeReviewSnapshot`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CodeReviewSnapshot {
    /// PR/MRs that wait for the user's review (at most `LIST_LIMIT`).
    pub to_review: Vec<ClientItem>,
    /// The user's open PR/MRs (at most `LIST_LIMIT`).
    pub mine: Vec<ClientItem>,
    /// Own open, non-draft PR/MRs without any review.
    pub unreviewed: u32,
    pub own_review: Vec<OwnReview>,
}

/// `CodeReviewClient`: one platform's API with one token.
pub trait CodeReviewClient: Send + Sync {
    /// Login (GitHub) or username (GitLab) of the token's account.
    fn viewer(&self) -> BoxFuture<'_, Result<String, CodeReviewError>>;
    fn fetch(&self) -> BoxFuture<'_, Result<CodeReviewSnapshot, CodeReviewError>>;
    /// The current month's contributions (local time of `now`).
    fn contributions(
        &self,
        now: DateTime<Utc>,
    ) -> BoxFuture<'_, Result<ContributionSummary, CodeReviewError>>;
}

/// `toReviewItem`: drops the URL, what may cross IPC to the notch.
pub fn to_review_item(item: &ClientItem) -> ReviewItem {
    item.item.clone()
}

/// `clip(text)` with the default `CODE_REVIEW_TEXT_MAX`.
pub fn clip_text(text: &str) -> String {
    clip(text, TEXT_MAX)
}

/// `snapshot`: limits, the unreviewed count and the own review states. `uncertain` own items (a
/// per-item call failed) are left out of `own_review`.
pub fn snapshot(
    to_review: Vec<ClientItem>,
    mine: Vec<ClientItem>,
    uncertain: &HashSet<String>,
) -> CodeReviewSnapshot {
    let own: Vec<ClientItem> = mine.into_iter().take(LIST_LIMIT).collect();
    let open = || own.iter().filter(|client| !client.item.draft);
    let unreviewed = open()
        .filter(|client| client.item.review == ReviewState::None)
        .count();
    let own_review = open()
        .filter(|client| !uncertain.contains(&client.item.id))
        .map(|client| OwnReview {
            id: client.item.id.clone(),
            review: client.item.review,
        })
        .collect();
    CodeReviewSnapshot {
        to_review: to_review.into_iter().take(LIST_LIMIT).collect(),
        unreviewed: u32::try_from(unreviewed).unwrap_or(u32::MAX),
        own_review,
        mine: own,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_counts_utf16_units_and_never_splits_a_pair() {
        assert_eq!(clip("abcdef", 3), "abc");
        assert_eq!(clip("abc", 3), "abc");
        assert_eq!(clip("ab\u{1F600}cd", 3), "ab");
        assert_eq!(clip("ab\u{1F600}cd", 4), "ab\u{1F600}");
        assert_eq!(clip_text(&"t".repeat(1500)).len(), 1000);
        assert_eq!(clip_text(&"\u{1F600}".repeat(600)).chars().count(), 500);
    }

    fn item(id: &str, draft: bool, review: ReviewState) -> ClientItem {
        ClientItem {
            item: ReviewItem {
                id: id.into(),
                reference: format!("o/r#{id}"),
                title: "t".into(),
                author: "a".into(),
                updated_at: "2026-11-12T10:00:00Z".into(),
                draft,
                review,
                checks: None,
                conflicts: false,
            },
            url: format!("https://github.com/o/r/pull/{id}"),
        }
    }

    #[test]
    fn to_review_item_drops_the_url() {
        let client = item("1", false, ReviewState::None);
        let value = serde_json::to_value(to_review_item(&client)).unwrap();
        assert!(value.get("url").is_none());
        assert!(crate::contract::parse::<ReviewItem>(value).is_ok());
    }

    #[test]
    fn snapshot_limits_counts_and_leaves_uncertain_items_out() {
        let to_review: Vec<ClientItem> = (0..25)
            .map(|i| item(&format!("r{i}"), false, ReviewState::None))
            .collect();
        let mut mine = vec![
            item("a", false, ReviewState::None),
            item("b", true, ReviewState::None),
            item("c", false, ReviewState::Approved),
            item("d", false, ReviewState::None),
            item("e", false, ReviewState::Commented),
        ];
        mine.extend((0..20).map(|i| item(&format!("m{i}"), false, ReviewState::None)));
        let uncertain: HashSet<String> = ["d".to_owned(), "e".to_owned()].into();
        let result = snapshot(to_review, mine, &uncertain);
        assert_eq!(result.to_review.len(), 20);
        assert_eq!(result.mine.len(), 20);
        // a, d and m0..m14 (the first 20 own items minus the draft b and the approved c).
        assert_eq!(result.unreviewed, 17);
        let own: Vec<&str> = result
            .own_review
            .iter()
            .map(|own| own.id.as_str())
            .collect();
        assert_eq!(own[..2], ["a", "c"]);
        assert_eq!(own.len(), 17);
        assert!(!own.contains(&"b") && !own.contains(&"d") && !own.contains(&"e"));
        assert_eq!(result.own_review[1].review, ReviewState::Approved);
    }

    #[test]
    fn snapshot_without_uncertain_items_reports_every_open_one() {
        let mine = vec![
            item("a", false, ReviewState::Changes),
            item("b", true, ReviewState::Approved),
        ];
        let result = snapshot(Vec::new(), mine, &HashSet::new());
        assert_eq!(result.unreviewed, 0);
        assert_eq!(
            result.own_review,
            vec![OwnReview {
                id: "a".into(),
                review: ReviewState::Changes
            }]
        );
    }
}
