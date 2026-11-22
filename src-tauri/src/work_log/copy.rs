//! The plain text Copiar puts on the clipboard, ready to paste into Redmine:
//!
//! ```text
//! Tarea: Integrar la pasarela Cashela en ms-pay (Claude 3h 10m · Total 5h 45m)
//! Subtareas:
//! 1 - Analizar la API Pay-In de Cashela (Claude 25m · Total 50m)
//! 2 - Validar la firma con el vector oficial (pendiente)
//! ```

use super::duration::duration_text;
use super::service::{entry_times, subtask_times, title_of, StoredEntry, StoredSubtask};
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

fn subtask_line(entry: &StoredEntry, subtask: &StoredSubtask, words: &Words) -> String {
    let title = subtask.title.trim();
    match subtask.status {
        WorkLogSubtaskStatus::Done => {
            let (claude, total) = subtask_times(entry, subtask);
            format!("{title} {}", times(claude, total))
        }
        WorkLogSubtaskStatus::Pending => format!("{title} ({})", words.pending),
    }
}

/// The whole entry, or with `subtask = Some(i)` only the `i`-th subtask's line (0-based, without
/// its number; empty if there is no such subtask). An entry without a summary copies only its
/// provisional title and times.
pub fn copy_text(entry: &StoredEntry, language: Language, subtask: Option<usize>) -> String {
    let words = words(language);
    let subtasks = entry
        .summary
        .as_ref()
        .map_or(&[][..], |summary| &summary.subtasks[..]);
    if let Some(index) = subtask {
        return subtasks
            .get(index)
            .map(|subtask| subtask_line(entry, subtask, &words))
            .unwrap_or_default();
    }
    let (claude, total) = entry_times(entry);
    let mut lines = vec![format!(
        "{}: {} {}",
        words.task,
        title_of(entry, language).trim(),
        times(claude, total)
    )];
    if !subtasks.is_empty() {
        lines.push(format!("{}:", words.subtasks));
        for (i, subtask) in subtasks.iter().enumerate() {
            lines.push(format!(
                "{} - {}",
                i + 1,
                subtask_line(entry, subtask, &words)
            ));
        }
    }
    lines.join("\n")
}
