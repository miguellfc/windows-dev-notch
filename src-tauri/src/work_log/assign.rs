//! From Claude's answer to the stored summary: Claude only says which measured turns go in each
//! subtask; the notch checks that and computes every time itself.

use std::collections::HashSet;

use super::service::{StoredSubtask, Summary};
use super::summarizer::SummaryOut;
use super::timing::Session;
use crate::contract::settings::Language;
use crate::contract::work_log::{WorkLogSubtaskStatus, WORK_LOG_SUBTASK_TITLE_MAX};

/// The cap on the macro task's title (the parser rejects longer ones).
pub const SUMMARY_TITLE_MAX: usize = 300;

fn cut(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

/// The subtask that takes the turns Claude left out.
fn other_title(language: Language) -> &'static str {
    match language {
        Language::Es => "Otros",
        Language::En => "Other",
    }
}

/// Keeps only the session's turns, each in the first `done` subtask that names it (a `done` one
/// left without turns stays, with no time); pending subtasks carry none. The turns no subtask
/// took go to a last `done` subtask «Otros» / «Other», so the subtasks always add up to the
/// session's total. Subtasks without a title are dropped (their turns go to «Otros»).
pub fn assign(summary: SummaryOut, session: &Session, language: Language) -> Summary {
    let known: HashSet<&str> = session.turns.iter().map(|turn| turn.id.as_str()).collect();
    let mut taken: HashSet<String> = HashSet::new();
    let mut subtasks: Vec<StoredSubtask> = summary
        .subtasks
        .into_iter()
        .filter_map(|subtask| {
            let title = cut(&subtask.title, WORK_LOG_SUBTASK_TITLE_MAX);
            if title.is_empty() {
                return None;
            }
            let turn_ids = match subtask.status {
                WorkLogSubtaskStatus::Pending => Vec::new(),
                WorkLogSubtaskStatus::Done => subtask
                    .turn_ids
                    .into_iter()
                    .filter(|id| known.contains(id.as_str()) && taken.insert(id.clone()))
                    .collect(),
            };
            Some(StoredSubtask {
                title,
                status: subtask.status,
                turn_ids,
            })
        })
        .collect();
    let left: Vec<String> = session
        .turns
        .iter()
        .filter(|turn| !taken.contains(&turn.id))
        .map(|turn| turn.id.clone())
        .collect();
    if !left.is_empty() {
        subtasks.push(StoredSubtask {
            title: other_title(language).to_owned(),
            status: WorkLogSubtaskStatus::Done,
            turn_ids: left,
        });
    }
    Summary {
        title: cut(&summary.title, SUMMARY_TITLE_MAX),
        subtasks,
    }
}

/// Claude's and the total time of each subtask: the sums over the turns of a `done` one (its
/// share of the total, see [`Session::turn_totals`]); `None` for a pending one. With the turns
/// of [`assign`], the totals of the `done` subtasks add up to [`Session::total_ms`].
pub fn subtask_times(summary: &Summary, session: &Session) -> Vec<(Option<i64>, Option<i64>)> {
    let totals = session.turn_totals();
    summary
        .subtasks
        .iter()
        .map(|subtask| match subtask.status {
            WorkLogSubtaskStatus::Pending => (None, None),
            WorkLogSubtaskStatus::Done => {
                let (claude, total) = session
                    .turns
                    .iter()
                    .zip(&totals)
                    .filter(|(turn, _)| subtask.turn_ids.contains(&turn.id))
                    .fold((0, 0), |(claude, total), (turn, turn_total)| {
                        (claude + turn.claude_ms(), total + turn_total.max(&0))
                    });
                (Some(claude), Some(total))
            }
        })
        .collect()
}
