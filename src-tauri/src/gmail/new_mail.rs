//! New-mail detection by diffing the unread ids between queries (port of
//! 0.1.0's `new-mail.ts`): no extra requests. Pure, in memory.
//!
//! The baseline is reset only with the session (sign-in, sign-out, client change, new token):
//! never by the notch mode, mini, hidden or a long hidden stretch.

use std::collections::HashSet;

/// `createNewMailDetector()`. `Debug` prints only how many ids it holds.
#[derive(Default)]
pub struct NewMailDetector {
    /// The unread ids of the previous query; `None` until the first one (or after a reset).
    previous: Option<HashSet<String>>,
}

crate::contract::redacted_debug!(NewMailDetector, |this| {
    "previous": this.previous.as_ref().map(HashSet::len),
});

impl NewMailDetector {
    pub fn new() -> Self {
        Self::default()
    }

    /// `observe(unreadIds)`: the ids that were not in the previous query, in list order (newest
    /// first), each once. The first call after creation or [`Self::reset`] only records the
    /// reference and returns nothing.
    pub fn observe<S: AsRef<str>>(&mut self, unread_ids: &[S]) -> Vec<String> {
        let mut current = HashSet::with_capacity(unread_ids.len());
        // `[...new Set(ids)]`: insertion order, duplicates once.
        let ordered: Vec<&str> = unread_ids
            .iter()
            .map(AsRef::as_ref)
            .filter(|id| current.insert((*id).to_owned()))
            .collect();
        let Some(before) = self.previous.replace(current) else {
            return Vec::new();
        };
        ordered
            .into_iter()
            .filter(|id| !before.contains(*id))
            .map(str::to_owned)
            .collect()
    }

    /// `reset()`: the next observation is a baseline again.
    pub fn reset(&mut self) {
        self.previous = None;
    }
}

#[cfg(test)]
mod tests {
    //! Port of 0.1.0's `gmail-new-mail.test.ts` (9 cases).

    use super::*;

    const NONE: [&str; 0] = [];

    #[test]
    fn only_records_the_first_observation_as_the_reference() {
        let mut detector = NewMailDetector::new();
        assert!(detector.observe(&["a", "b"]).is_empty());
        assert!(detector.observe(&["a", "b"]).is_empty());
    }

    #[test]
    fn treats_an_empty_first_observation_as_a_reference_too() {
        let mut detector = NewMailDetector::new();
        assert!(detector.observe(&NONE).is_empty());
        assert_eq!(detector.observe(&["a"]), ["a"]);
    }

    #[test]
    fn reports_a_new_id() {
        let mut detector = NewMailDetector::new();
        detector.observe(&["a", "b"]);
        assert_eq!(detector.observe(&["c", "a", "b"]), ["c"]);
    }

    #[test]
    fn reports_several_new_ids_in_list_order_newest_first() {
        let mut detector = NewMailDetector::new();
        detector.observe(&["a"]);
        assert_eq!(detector.observe(&["e", "d", "a", "c"]), ["e", "d", "c"]);
    }

    #[test]
    fn does_not_count_ids_that_disappear() {
        let mut detector = NewMailDetector::new();
        detector.observe(&["a", "b", "c"]);
        assert!(detector.observe(&["b"]).is_empty());
        assert!(detector.observe(&NONE).is_empty());
    }

    #[test]
    fn counts_an_id_that_comes_back_after_disappearing_as_new() {
        let mut detector = NewMailDetector::new();
        detector.observe(&["a", "b"]);
        assert!(detector.observe(&["b"]).is_empty());
        assert_eq!(detector.observe(&["a", "b"]), ["a"]);
    }

    #[test]
    fn reports_a_repeated_id_in_one_observation_once() {
        let mut detector = NewMailDetector::new();
        detector.observe(&NONE);
        assert_eq!(detector.observe(&["a", "a", "b"]), ["a", "b"]);
    }

    #[test]
    fn makes_the_next_observation_a_reference_again_after_reset() {
        let mut detector = NewMailDetector::new();
        detector.observe(&["a"]);
        detector.reset();
        assert!(detector.observe(&["x", "y", "a"]).is_empty());
        assert_eq!(detector.observe(&["z", "x", "y", "a"]), ["z"]);
    }

    #[test]
    fn does_not_keep_a_reference_to_the_caller_array() {
        let mut detector = NewMailDetector::new();
        let mut ids = vec![String::from("a")];
        detector.observe(&ids);
        ids.push(String::from("b"));
        assert_eq!(detector.observe(&["b", "a"]), ["b"]);
    }
}
