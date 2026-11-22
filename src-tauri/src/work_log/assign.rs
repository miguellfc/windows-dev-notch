//! From Claude's answer to the stored summary: Claude only says which measured turns go in each
//! subtask; the notch checks that and computes every time itself.

use std::collections::HashSet;

use super::rounding::round_to_minutes;
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

fn is_other_title(title: &str) -> bool {
    [Language::Es, Language::En]
        .into_iter()
        .any(|language| other_title(language) == title.trim())
}

/// The subtasks the view shows and Copiar copies: the stored ones, plus the turns no `done` one
/// takes (those measured after a `--resume`, which the old summary does not know) in a last
/// «Otros» / «Other» — the stored one when the summary already ends with it — so the subtasks
/// always add up to the session's total.
pub fn shown_subtasks(
    summary: &Summary,
    session: &Session,
    language: Language,
) -> Vec<StoredSubtask> {
    let mut subtasks = summary.subtasks.clone();
    let left: Vec<String> = {
        let taken: HashSet<&str> = subtasks
            .iter()
            .filter(|subtask| subtask.status == WorkLogSubtaskStatus::Done)
            .flat_map(|subtask| subtask.turn_ids.iter().map(String::as_str))
            .collect();
        session
            .turns
            .iter()
            .filter(|turn| !taken.contains(turn.id.as_str()))
            .map(|turn| turn.id.clone())
            .collect()
    };
    if left.is_empty() {
        return subtasks;
    }
    match subtasks
        .last_mut()
        .filter(|last| last.status == WorkLogSubtaskStatus::Done && is_other_title(&last.title))
    {
        Some(other) => other.turn_ids.extend(left),
        None => subtasks.push(StoredSubtask {
            title: other_title(language).to_owned(),
            status: WorkLogSubtaskStatus::Done,
            turn_ids: left,
        }),
    }
    subtasks
}

/// Claude's and the total time of each subtask: the sums over the turns of a `done` one (its
/// share of the total, see [`Session::turn_totals`]); `None` for a pending one. With the turns
/// of [`assign`] or [`shown_subtasks`], the totals of the `done` subtasks add up to
/// [`Session::total_ms`].
pub fn subtask_times(
    subtasks: &[StoredSubtask],
    session: &Session,
) -> Vec<(Option<i64>, Option<i64>)> {
    let totals = session.turn_totals();
    subtasks
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

/// [`subtask_times`] in whole minutes that add up to the session's (`claude_ms`, `total_ms`), as
/// the view shows them ([`super::rounding::round_to_minutes`]): what Copiar writes.
pub fn rounded_subtask_times(
    subtasks: &[StoredSubtask],
    session: &Session,
    (claude_ms, total_ms): (i64, i64),
) -> Vec<(Option<i64>, Option<i64>)> {
    let times = subtask_times(subtasks, session);
    let done: Vec<(i64, i64)> = times
        .iter()
        .filter_map(|(claude, total)| claude.zip(*total))
        .collect();
    let claude = round_to_minutes(&done.iter().map(|t| t.0).collect::<Vec<_>>(), claude_ms);
    let total = round_to_minutes(&done.iter().map(|t| t.1).collect::<Vec<_>>(), total_ms);
    let mut rounded = claude.into_iter().zip(total);
    times
        .into_iter()
        .map(|(claude, total)| match (claude, total) {
            (Some(_), Some(_)) => rounded
                .next()
                .map_or((None, None), |(c, t)| (Some(c), Some(t))),
            _ => (None, None),
        })
        .collect()
}
