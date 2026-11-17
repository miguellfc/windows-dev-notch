//! Port of 0.1.0's `message-text.ts`: the text, links and attachment count of a
//! `format=full` message. Pure: no I/O, nothing logged.

use crate::contract::gmail::google::MessagePart;
use crate::contract::gmail::{GmailLink, BODY_MAX, LINKS_MAX, LINK_TEXT_MAX, URL_MAX};
use crate::contract::redacted_debug;
use crate::contract::text::{is_js_whitespace, js_trim, utf16_len, utf16_prefix};

/// MIME nesting deeper than this is not read (real mail stays within a handful of levels).
const MIME_MAX_DEPTH: usize = 50;
/// At most this many MIME parts are visited.
const MIME_MAX_PARTS: usize = 500;

/// `ExtractedMessage`: what the notch shows of a message. `Debug` never prints mail data.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct MessageText {
    /// Plain text, at most `BODY_MAX` UTF-16 units.
    pub body: String,
    pub truncated: bool,
    /// Unique `http`/`https` links in reading order, at most `LINKS_MAX`.
    pub links: Vec<GmailLink>,
    /// Parts with a non-blank file name.
    pub attachments: u64,
}

/// `webUrl`: a link worth offering (`http`/`https` only, normalised by the WHATWG URL parser, at
/// most `URL_MAX` UTF-16 units); anything else gives `None`.
pub(crate) fn web_url(raw: &str) -> Option<String> {
    let trimmed = js_trim(raw);
    // `/^https?:/i` without `u` folds ASCII only.
    let bytes = trimmed.as_bytes();
    let starts = |prefix: &[u8]| {
        bytes.len() >= prefix.len() && bytes[..prefix.len()].eq_ignore_ascii_case(prefix)
    };
    if !starts(b"http:") && !starts(b"https:") {
        return None;
    }
    let url = url::Url::parse(trimmed).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    let href = url.as_str();
    (utf16_len(href) <= URL_MAX).then(|| href.to_owned())
}

/// `createLinkList`: unique links up to the cap. `Debug` prints only the count.
#[derive(Default)]
pub(crate) struct LinkList {
    links: Vec<GmailLink>,
}

redacted_debug!(LinkList, |this| { "links": this.links.len() });
redacted_debug!(MessageText, |this| {
    "truncated": this.truncated,
    "links": this.links.len(),
    "attachments": this.attachments,
});

impl LinkList {
    /// `add`: the 1-based number of the link, or `None` when the list is full.
    pub(crate) fn add(&mut self, url: &str, text: &str) -> Option<usize> {
        if let Some(known) = self.links.iter().position(|link| link.url == url) {
            return Some(known + 1);
        }
        if self.links.len() >= LINKS_MAX {
            return None;
        }
        let text = if text.is_empty() { url } else { text };
        self.links.push(GmailLink {
            text: utf16_prefix(text, LINK_TEXT_MAX).to_owned(),
            url: url.to_owned(),
        });
        Some(self.links.len())
    }
}

/// `charsetOf`: `/charset\s*=\s*"?([^";\s]+)/i` over the part's own Content-Type, lowercased;
/// `utf-8` without one.
fn charset_of(part: &MessagePart) -> String {
    let content_type = part
        .headers
        .iter()
        .find(|header| header.name.to_lowercase() == "content-type")
        .map_or("", |header| header.value.as_str());
    find_charset(content_type).map_or_else(|| "utf-8".to_owned(), |charset| charset.to_lowercase())
}

fn find_charset(value: &str) -> Option<&str> {
    const KEY: &[u8] = b"charset";
    let bytes = value.as_bytes();
    // Every match of the regex starts at an ASCII `charset` (the `/i` flag folds ASCII only).
    (0..bytes.len())
        .filter(|&start| {
            bytes[start..].len() >= KEY.len()
                && bytes[start..start + KEY.len()].eq_ignore_ascii_case(KEY)
        })
        .find_map(|start| {
            let rest = value[start + KEY.len()..].trim_start_matches(is_js_whitespace);
            let rest = rest.strip_prefix('=')?.trim_start_matches(is_js_whitespace);
            let rest = rest.strip_prefix('"').unwrap_or(rest);
            let end = rest
                .find(|c: char| c == '"' || c == ';' || is_js_whitespace(c))
                .unwrap_or(rest.len());
            (end > 0).then(|| &rest[..end])
        })
}

/// `decoderLabel`: the WHATWG `TextDecoder` behind the charset. The latin1 labels ARE
/// windows-1252 in WHATWG, so both single-byte branches decode windows-1252.
fn is_windows_1252(charset: &str) -> bool {
    matches!(
        charset,
        "iso-8859-1"
            | "iso8859-1"
            | "latin1"
            | "latin-1"
            | "l1"
            | "us-ascii"
            | "ascii"
            | "windows-1252"
            | "cp1252"
            | "x-cp1252"
    )
}

/// WHATWG windows-1252 for 0x80..=0x9F; the undefined bytes (81, 8D, 8F, 90, 9D) map to the
/// same code point, every other byte is its own code point.
const WINDOWS_1252_HIGH: [char; 32] = [
    '\u{20AC}', '\u{0081}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{008D}', '\u{017D}', '\u{008F}',
    '\u{0090}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{009D}', '\u{017E}', '\u{0178}',
];

/// `new TextDecoder(decoderLabel(charset)).decode(bytes)`.
fn decode_text(bytes: &[u8], charset: &str) -> String {
    if is_windows_1252(charset) {
        return bytes
            .iter()
            .map(|&byte| match byte {
                0x80..=0x9F => WINDOWS_1252_HIGH[usize::from(byte - 0x80)],
                _ => char::from(byte),
            })
            .collect();
    }
    // UTF-8 with the WHATWG replacement policy (maximal subparts), minus one leading BOM.
    let text = String::from_utf8_lossy(bytes);
    match text.strip_prefix('\u{FEFF}') {
        Some(rest) => rest.to_owned(),
        None => text.into_owned(),
    }
}

/// `Buffer.from(data, 'base64url')`: Node's lenient decoder. Both alphabets are accepted, any
/// other ASCII character (whitespace included) is skipped, `=` stops decoding, and leftover bits
/// after the last whole byte are dropped. Node first truncates each UTF-16 unit above U+00FF to
/// its low byte (`Ł`, U+0141, reads as `A`); here every non-ASCII character is skipped. Gmail
/// sends `data` as ASCII base64url, so the difference never shows.
fn decode_base64url(data: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() / 4 * 3 + 2);
    let mut bits: u32 = 0;
    let mut count = 0;
    for byte in data.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        bits = (bits << 6) | u32::from(value);
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    out
}

/// `decodePart`: Gmail returns each part's content (transfer encoding already undone) as
/// base64url bytes.
fn decode_part(part: &MessagePart) -> String {
    match part.body.data.as_deref() {
        None | Some("") => String::new(),
        Some(data) => decode_text(&decode_base64url(data), &charset_of(part)),
    }
}

fn is_attachment(part: &MessagePart) -> bool {
    !js_trim(part.filename.as_deref().unwrap_or("")).is_empty()
}

#[derive(Default)]
struct Found<'a> {
    plain: Option<&'a MessagePart>,
    html: Option<&'a MessagePart>,
    attachments: u64,
    visited: usize,
}

/// `walkParts`, with an explicit stack in the same pre-order.
fn walk_parts(root: &MessagePart) -> Found<'_> {
    let mut found = Found::default();
    let mut stack = vec![(root, 0)];
    while let Some((part, depth)) = stack.pop() {
        if depth > MIME_MAX_DEPTH || found.visited >= MIME_MAX_PARTS {
            continue;
        }
        found.visited += 1;
        if is_attachment(part) {
            found.attachments += 1;
        } else {
            let has_data = part
                .body
                .data
                .as_deref()
                .is_some_and(|data| !data.is_empty());
            match part.mime_type.to_lowercase().as_str() {
                "text/plain" if found.plain.is_none() && has_data => found.plain = Some(part),
                "text/html" if found.html.is_none() && has_data => found.html = Some(part),
                _ => {}
            }
        }
        if let Some(children) = &part.parts {
            stack.extend(children.iter().rev().map(|child| (child, depth + 1)));
        }
    }
    found
}

/// `TEXT_URL` (`/\bhttps?:\/\/[^\s<>"'()[\]{}]+/gi`) followed by dropping trailing `.,;:!?`.
fn plain_links(text: &str, links: &mut LinkList) {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let Some(found) = text_url_at(text, index) else {
            index += 1;
            continue;
        };
        let candidate = text[index..found].trim_end_matches(['.', ',', ';', ':', '!', '?']);
        if let Some(url) = web_url(candidate) {
            links.add(&url, &url);
        }
        index = found;
    }
}

/// The end of a `TEXT_URL` match starting at byte `start`, if there is one.
fn text_url_at(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    // `\b` before the ASCII word character `h`.
    if start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b'_') {
        return None;
    }
    let rest = &bytes[start..];
    let scheme_end = if rest.len() >= 8 && rest[..8].eq_ignore_ascii_case(b"https://") {
        8
    } else if rest.len() >= 7 && rest[..7].eq_ignore_ascii_case(b"http://") {
        7
    } else {
        return None;
    };
    let tail = &text[start + scheme_end..];
    let length = tail
        .find(|c: char| {
            is_js_whitespace(c)
                || matches!(
                    c,
                    '<' | '>' | '"' | '\'' | '(' | ')' | '[' | ']' | '{' | '}'
                )
        })
        .unwrap_or(tail.len());
    (length > 0).then_some(start + scheme_end + length)
}

/// `cut`: at most `BODY_MAX` UTF-16 units, never splitting a surrogate pair.
fn cut(text: &str) -> (String, bool) {
    if utf16_len(text) <= BODY_MAX {
        return (text.to_owned(), false);
    }
    (utf16_prefix(text, BODY_MAX).to_owned(), true)
}

/// `extractMessage`: turns a `format=full` payload into what the notch shows: the `text/plain`
/// part (or the `text/html` part converted to text, never rendered), its `http`/`https` links and
/// the number of attachments.
pub fn extract_message(payload: &MessagePart) -> MessageText {
    let found = walk_parts(payload);
    let mut links = LinkList::default();
    let text = if let Some(plain) = found.plain {
        let text = decode_part(plain).replace("\r\n", "\n").replace('\r', "\n");
        plain_links(&text, &mut links);
        text
    } else if let Some(html) = found.html {
        super::html_text::html_to_plain(&decode_part(html), &mut links)
    } else {
        String::new()
    };
    let (body, truncated) = cut(js_trim(&text));
    MessageText {
        body,
        truncated,
        links: links.links,
        attachments: found.attachments,
    }
}

#[cfg(test)]
#[path = "message_text_tests.rs"]
mod tests;
