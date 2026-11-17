//! The settings.json line diff shown before installing or removing the hooks (`diffLines` in
//! 0.1.0's `hook-installer.ts`) and the token masking applied to it before it reaches a
//! renderer (`mask` in 0.1.0's `claude-service.ts`).

use crate::contract::claude::{DiffKind, DiffLine};
use crate::contract::text::is_js_whitespace;

/// Shown instead of the bridge token (6 x U+2022).
pub const MASK: &str = "••••••";

const TOKEN_FIELD: &str = "\"x-notch-token\"";

/// `text.split(/\r?\n/)` without one trailing empty line. Only a `\r` right before a `\n` is
/// part of the separator: a lone `\r` at the very end stays in the last line, as in JS.
fn split_lines(text: &str) -> Vec<&str> {
    let mut lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len() - 1;
    for line in &mut lines[..last] {
        *line = line.strip_suffix('\r').unwrap_or(line);
    }
    if lines.last() == Some(&"") {
        lines.pop();
    }
    lines
}

fn line(kind: DiffKind, text: &str) -> DiffLine {
    DiffLine {
        kind,
        text: text.to_owned(),
    }
}

/// Plain LCS line diff of the whole file (unchanged lines included as `same`); settings files are
/// small, so O(n*m) is fine. On a tie the added line comes before the removed one, as in Electron.
pub fn diff_lines(before: &str, after: &str) -> Vec<DiffLine> {
    let a = split_lines(before);
    let b = split_lines(after);
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let mut end_a = a.len();
    let mut end_b = b.len();
    while end_a > start && end_b > start && a[end_a - 1] == b[end_b - 1] {
        end_a -= 1;
        end_b -= 1;
    }
    let mid_a = &a[start..end_a];
    let mid_b = &b[start..end_b];
    let mut table = vec![vec![0usize; mid_b.len() + 1]; mid_a.len() + 1];
    for i in (0..mid_a.len()).rev() {
        for j in (0..mid_b.len()).rev() {
            table[i][j] = if mid_a[i] == mid_b[j] {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    let mut out: Vec<DiffLine> = a[..start]
        .iter()
        .map(|text| line(DiffKind::Same, text))
        .collect();
    let (mut i, mut j) = (0, 0);
    while i < mid_a.len() || j < mid_b.len() {
        if i < mid_a.len() && j < mid_b.len() && mid_a[i] == mid_b[j] {
            out.push(line(DiffKind::Same, mid_a[i]));
            i += 1;
            j += 1;
        } else if j < mid_b.len() && (i == mid_a.len() || table[i][j + 1] >= table[i + 1][j]) {
            out.push(line(DiffKind::Add, mid_b[j]));
            j += 1;
        } else {
            out.push(line(DiffKind::Remove, mid_a[i]));
            i += 1;
        }
    }
    out.extend(a[end_a..].iter().map(|text| line(DiffKind::Same, text)));
    out
}

/// Every line with `/("x-notch-token"\s*:\s*")[^"]*(")/g` replaced by `$1••••••$2`, then every
/// occurrence of `token` (when known) replaced by the mask. An empty token is skipped (JS
/// `replaceAll('')` would insert the mask between every character; the bridge token never is).
pub fn mask_diff(diff: &[DiffLine], token: Option<&str>) -> Vec<DiffLine> {
    diff.iter()
        .map(|entry| {
            let mut text = mask_token_field(&entry.text);
            if let Some(token) = token.filter(|token| !token.is_empty()) {
                text = text.replace(token, MASK);
            }
            DiffLine {
                kind: entry.kind,
                text,
            }
        })
        .collect()
}

fn mask_token_field(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(found) = rest.find(TOKEN_FIELD) {
        let after_name = found + TOKEN_FIELD.len();
        match field_value(&rest[after_name..]) {
            Some((value_start, value_end)) => {
                // `$1` (through the opening quote), the mask, `$2` (the closing quote).
                out.push_str(&rest[..after_name + value_start]);
                out.push_str(MASK);
                out.push('"');
                rest = &rest[after_name + value_end + 1..];
            }
            None => {
                // No match at this position: the regex retries one character later.
                let next = found + rest[found..].chars().next().map_or(1, char::len_utf8);
                out.push_str(&rest[..next]);
                rest = &rest[next..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Matches `\s*:\s*"[^"]*"` at the start of `text`: the byte range of the value between quotes.
fn field_value(text: &str) -> Option<(usize, usize)> {
    let skip_space = |from: usize| {
        text[from..]
            .char_indices()
            .find(|&(_, character)| !is_js_whitespace(character))
            .map_or(text.len(), |(offset, _)| from + offset)
    };
    let colon = skip_space(0);
    if !text[colon..].starts_with(':') {
        return None;
    }
    let quote = skip_space(colon + 1);
    if !text[quote..].starts_with('"') {
        return None;
    }
    let value_start = quote + 1;
    let value_end = value_start + text[value_start..].find('"')?;
    Some((value_start, value_end))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_lines_keeps_a_trailing_lone_carriage_return_like_js() {
        // JS: "a\r\nb\r".split(/\r?\n/) is ["a", "b\r"].
        assert_eq!(split_lines("a\r\nb\r"), ["a", "b\r"]);
        assert_eq!(split_lines("a\r"), ["a\r"]);
        assert_eq!(split_lines("\r"), ["\r"]);
        // A \r inside a line is not a separator either.
        assert_eq!(split_lines("a\rb\r\nc"), ["a\rb", "c"]);
        // CRLF endings, and one trailing empty line dropped.
        assert_eq!(split_lines("a\r\nb\r\n"), ["a", "b"]);
        assert_eq!(split_lines("a\r\n\r\n"), ["a", ""]);
        assert_eq!(split_lines(""), Vec::<&str>::new());
        // So a file that only gained a trailing \r differs from the one without it.
        assert_eq!(
            diff_lines("a\nb", "a\nb\r")
                .iter()
                .map(|l| l.kind)
                .collect::<Vec<_>>(),
            [DiffKind::Same, DiffKind::Add, DiffKind::Remove]
        );
    }
}
