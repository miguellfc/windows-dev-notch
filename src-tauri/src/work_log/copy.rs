//! The plain text Copiar puts on the clipboard, ready to paste into Redmine:
//!
//! ```text
//! Tarea: Integrar la pasarela Cashela en ms-pay (Claude 3h 10m · Total 5h 45m)
//! Subtareas:
//! 1 - Analizar la API Pay-In de Cashela (Claude 25m · Total 50m)
//! 2 - Validar la firma con el vector oficial (pendiente)
//! ```

use super::assign::{rounded_subtask_times, shown_subtasks};
use super::duration::duration_text;
use super::service::{entry_times, title_of, StoredEntry, StoredSubtask};
use crate::contract::settings::Language;
use crate::contract::work_log::WorkLogSubtaskStatus;

struct Words {
    task: &'static str,
    subtasks: &'static str,
    pending: &'static str,
}

fn words(language: Language) -> Words {
    match language {
        Language::Es => Words {
            task: "Tarea",
            subtasks: "Subtareas",
            pending: "pendiente",
        },
        Language::En => Words {
            task: "Task",
            subtasks: "Subtasks",
            pending: "pending",
        },
    }
}

fn times(claude: i64, total: i64) -> String {
    format!(
        "(Claude {} · Total {})",
        duration_text(claude),
        duration_text(total)
    )
}

fn subtask_line(
    subtask: &StoredSubtask,
    (claude, total): (Option<i64>, Option<i64>),
    words: &Words,
) -> String {
    let title = subtask.title.trim();
    match subtask.status {
        WorkLogSubtaskStatus::Done => {
            format!("{title} {}", times(claude.unwrap_or(0), total.unwrap_or(0)))
        }
        WorkLogSubtaskStatus::Pending => format!("{title} ({})", words.pending),
    }
}

/// The whole entry, or with `subtask = Some(i)` only the `i`-th subtask's line (0-based, without
/// its number; empty if there is no such subtask). The subtasks are those the view shows
/// ([`shown_subtasks`]), their times in whole minutes that add up to the task's. An entry without
/// a summary copies only its provisional title and times.
pub fn copy_text(entry: &StoredEntry, language: Language, subtask: Option<usize>) -> String {
    let words = words(language);
    let (claude, total) = entry_times(entry);
    let subtasks = entry
        .summary
        .as_ref()
        .map(|summary| shown_subtasks(summary, &entry.session, language))
        .unwrap_or_default();
    let subtask_times = rounded_subtask_times(&subtasks, &entry.session, (claude, total));
    if let Some(index) = subtask {
        return subtasks
            .get(index)
            .map(|subtask| subtask_line(subtask, subtask_times[index], &words))
            .unwrap_or_default();
    }
    let mut lines = vec![format!(
        "{}: {} {}",
        words.task,
        title_of(entry, language).trim(),
        times(claude, total)
    )];
    if !subtasks.is_empty() {
        lines.push(format!("{}:", words.subtasks));
        for (i, (subtask, times)) in subtasks.iter().zip(subtask_times).enumerate() {
            lines.push(format!(
                "{} - {}",
                i + 1,
                subtask_line(subtask, times, &words)
            ));
        }
    }
    lines.join("\n")
}
