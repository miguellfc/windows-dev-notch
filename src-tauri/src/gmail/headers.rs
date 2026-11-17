//! Mail header and snippet helpers (port of `src/shared/gmail/headers.ts`). Pure.
//!
//! `clip` is the shared [`crate::http::clip`] (UTF-16 units, a surrogate pair never split).

use crate::contract::text::{is_js_whitespace, js_trim};
pub use crate::http::clip;

/// `displaySender(from)`: the display name (without quotes) before `<address>`, or the address
/// when there is no name. Empty or missing gives `""`.
pub fn display_sender(from: Option<&str>) -> String {
    let value = js_trim(from.unwrap_or(""));
    if value.is_empty() {
        return String::new();
    }
    // `/^(.*?)\s*<([^<>]*)>\s*$/`: `.` stops at line terminators.
    let Some((name, address)) =
        angle_address(value).filter(|(name, _)| !name.chars().any(is_line_terminator))
    else {
        return unquote(value);
    };
    let name = unquote(js_trim(name));
    if name.is_empty() {
        js_trim(address).to_owned()
    } else {
        name
    }
}

/// `senderAddress(from)`: what sits between `<` and `>` at the end, or the whole value; trimmed.
pub fn sender_address(from: Option<&str>) -> String {
    let value = js_trim(from.unwrap_or(""));
    // `/<([^<>]*)>\s*$/`.
    match angle_address(value) {
        Some((_, address)) => js_trim(address).to_owned(),
        None => value.to_owned(),
    }
}

/// `<([^<>]*)>\s*$` on a JS-trimmed value: the text before the `<` (its trailing whitespace
/// left out, as the lazy `(.*?)\s*` does) and the address between the brackets.
fn angle_address(value: &str) -> Option<(&str, &str)> {
    // Trimmed, so the closing `>` must be the last character...
    let inner = value.strip_suffix('>')?;
    // ...and the address runs back to the last `<`, with no `>` in between.
    let open = inner.rfind('<')?;
    let address = &inner[open + 1..];
    if address.contains('>') {
        return None;
    }
    Some((inner[..open].trim_end_matches(is_js_whitespace), address))
}

/// JS line terminators: what `.` does not match.
fn is_line_terminator(character: char) -> bool {
    matches!(character, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `unquote`: a `"quoted"` value loses its quotes and backslash escapes (`\\(.)` → `$1`) and is
/// trimmed; anything else is kept as is.
fn unquote(value: &str) -> String {
    let Some(inner) = value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    else {
        return value.to_owned();
    };
    let mut out = String::with_capacity(inner.len());
    let mut characters = inner.chars().peekable();
    while let Some(character) = characters.next() {
        match characters.peek() {
            Some(&next) if character == '\\' && !is_line_terminator(next) => {
                out.push(next);
                characters.next();
            }
            _ => out.push(character),
        }
    }
    js_trim(&out).to_owned()
}

/// `decodeSnippet(snippet)`: Gmail returns snippets HTML-escaped (`It&#39;s`). Decodes numeric
/// entities and `amp`, `lt`, `gt`, `quot`, `apos` and `nbsp` (a plain space, not U+00A0); the
/// result is still shown as text. Unknown entities stay as written.
///
/// Deviations:
/// - a numeric entity of a surrogate code point (`&#xD800;`) gives a lone surrogate in JS; a
///   Rust string cannot hold one, so the entity stays as written;
/// - `&constructor;` (any case) stays as written. TS looks names up in a plain object, so it
///   finds the inherited `Object.prototype.constructor` and prints the function's source
///   (`function Object() { [native code] }`). It is the only lower-case name that object
///   inherits.
pub fn decode_snippet(snippet: &str) -> String {
    // `/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi`, scanned left to right without overlaps.
    let mut out = String::with_capacity(snippet.len());
    let mut rest = snippet;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let candidate = &rest[at..];
        match entity(candidate) {
            Some((length, decoded)) => {
                out.push_str(&decoded);
                rest = &candidate[length..];
            }
            None => {
                out.push('&');
                rest = &candidate[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The entity at the start of `text` (which starts with `&`): its length in bytes and what it
/// decodes to (the entity itself when it is not one decodeSnippet knows).
fn entity(text: &str) -> Option<(usize, String)> {
    let body = &text[1..];
    let run = |from: &str, accept: fn(&u8) -> bool| from.bytes().take_while(accept).count();
    let (decoded, length) = if let Some(hex) = body
        .strip_prefix("#x")
        .or_else(|| body.strip_prefix("#X"))
        .filter(|hex| run(hex, u8::is_ascii_hexdigit) > 0)
    {
        let digits = run(hex, u8::is_ascii_hexdigit);
        (code_point(&hex[..digits], 16), 2 + digits)
    } else if let Some(decimal) = body
        .strip_prefix('#')
        .filter(|decimal| run(decimal, u8::is_ascii_digit) > 0)
    {
        let digits = run(decimal, u8::is_ascii_digit);
        (code_point(&decimal[..digits], 10), 1 + digits)
    } else {
        let letters = run(body, u8::is_ascii_alphabetic);
        if letters == 0 {
            return None;
        }
        (named(&body[..letters]), letters)
    };
    // The run must end with `;` (a shorter run cannot: its next character is not `;`).
    if body.as_bytes().get(length) != Some(&b';') {
        return None;
    }
    let whole = 1 + length + 1;
    Some((
        whole,
        decoded.map_or_else(|| text[..whole].to_owned(), String::from),
    ))
}

/// `String.fromCodePoint(code)` for `0 < code <= 0x10FFFF`; `None` outside it (or a surrogate).
fn code_point(digits: &str, radix: u32) -> Option<char> {
    // Too many digits overflow `u32` and are above the range anyway.
    let code = u32::from_str_radix(digits, radix).ok()?;
    if code == 0 {
        return None;
    }
    char::from_u32(code)
}

/// `NAMED_ENTITIES[body.toLowerCase()]`.
fn named(body: &str) -> Option<char> {
    match body.to_ascii_lowercase().as_str() {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        // A plain space, as headers.ts maps it (not U+00A0).
        "nbsp" => Some(' '),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    //! Port of `tests/unit/shared/gmail-headers.test.ts` (12 cases), plus the Rust-only edges.

    use super::*;

    // --- displaySender ---

    #[test]
    fn display_sender_keeps_the_quoted_name_without_quotes_even_with_a_comma() {
        assert_eq!(display_sender(Some("\"Doe, John\" <j@x.com>")), "Doe, John");
    }

    #[test]
    fn display_sender_keeps_a_bare_name_before_the_address() {
        assert_eq!(display_sender(Some("Ana <a@x>")), "Ana");
    }

    #[test]
    fn display_sender_falls_back_to_the_address_when_there_is_no_name() {
        assert_eq!(display_sender(Some("a@x")), "a@x");
        assert_eq!(display_sender(Some("<a@x>")), "a@x");
        assert_eq!(display_sender(Some("\"\" <a@x>")), "a@x");
    }

    #[test]
    fn display_sender_unescapes_quotes_inside_a_quoted_name() {
        assert_eq!(
            display_sender(Some(r#""The \"Best\" Shop" <s@x>"#)),
            "The \"Best\" Shop"
        );
    }

    #[test]
    fn display_sender_gives_an_empty_string_for_empty_or_missing_headers() {
        assert_eq!(display_sender(Some("")), "");
        assert_eq!(display_sender(Some("   ")), "");
        assert_eq!(display_sender(None), "");
    }

    // --- senderAddress ---

    #[test]
    fn sender_address_takes_the_address_between_angle_brackets() {
        assert_eq!(
            sender_address(Some("\"Doe, John\" <j@example.com>")),
            "j@example.com"
        );
        assert_eq!(sender_address(Some("<a@example.com>")), "a@example.com");
    }

    #[test]
    fn sender_address_takes_the_whole_value_when_there_are_no_brackets() {
        assert_eq!(sender_address(Some(" a@example.com ")), "a@example.com");
    }

    #[test]
    fn sender_address_gives_an_empty_string_for_empty_or_missing_headers() {
        assert_eq!(sender_address(Some("")), "");
        assert_eq!(sender_address(None), "");
    }

    // --- decodeSnippet ---

    #[test]
    fn decode_snippet_decodes_the_html_entities_gmail_puts_in_snippets_as_plain_text() {
        assert_eq!(
            decode_snippet("It&#39;s &quot;ok&quot; &amp; &lt;b&gt; &#x41;"),
            "It's \"ok\" & <b> A"
        );
    }

    #[test]
    fn decode_snippet_leaves_unknown_entities_and_plain_text_alone() {
        // `&nbsp;` is a plain space (U+0020), not U+00A0.
        assert_eq!(decode_snippet("a &nbsp; b &bogus; c"), "a   b &bogus; c");
        assert_eq!(decode_snippet("&#99999999;"), "&#99999999;");
        // Deviation: TS finds the inherited `constructor` of its lookup object.
        assert_eq!(
            decode_snippet("a &constructor; &CONSTRUCTOR; b"),
            "a &constructor; &CONSTRUCTOR; b"
        );
    }

    // --- clip ---

    #[test]
    fn clip_keeps_short_text_and_cuts_long_text_to_the_bound() {
        assert_eq!(clip("hola", 10), "hola");
        assert_eq!(clip("abcdef", 3), "abc");
    }

    #[test]
    fn clip_never_splits_a_surrogate_pair() {
        assert_eq!(clip("ab😀c", 3), "ab");
        assert_eq!(clip("ab😀c", 4), "ab😀");
    }

    // --- Rust-only edges of the JS regexes ---

    #[test]
    fn display_sender_follows_the_js_regex_edges() {
        // Whitespace (JS `\s`) between the name and `<`, and around the whole value.
        assert_eq!(display_sender(Some("\u{3000}Ana \t <a@x>\u{FEFF}")), "Ana");
        // A `>` after the last `<`: no `<address>` at the end, the whole value (unquoted).
        assert_eq!(display_sender(Some("Ana <a@x> >")), "Ana <a@x> >");
        // Only the last `<...>` is the address.
        assert_eq!(display_sender(Some("A <b> <c@x>")), "A <b>");
        // `.` does not cross a line break in the name: no match, the value as written.
        assert_eq!(display_sender(Some("An\na <a@x>")), "An\na <a@x>");
        // ...but whitespace before `<` may hold one.
        assert_eq!(display_sender(Some("Ana\n<a@x>")), "Ana");
        // A quoted value without an address is unquoted; a lone `"` is not.
        assert_eq!(display_sender(Some("\" Ana \"")), "Ana");
        assert_eq!(display_sender(Some("\"")), "\"");
        // `\\(.)`: a backslash before a line break stays; a trailing one too.
        assert_eq!(display_sender(Some("\"a\\\nb\"")), "a\\\nb");
        assert_eq!(display_sender(Some(r#""a\\b" <x>"#)), "a\\b");
        // An empty name and empty brackets: the (empty) address.
        assert_eq!(display_sender(Some("<>")), "");
    }

    #[test]
    fn sender_address_follows_the_js_regex_edges() {
        assert_eq!(sender_address(Some("Ana < a@x >")), "a@x");
        assert_eq!(sender_address(Some("a <b> <c@x>")), "c@x");
        assert_eq!(sender_address(Some("Ana <a@x> x")), "Ana <a@x> x");
        assert_eq!(sender_address(Some("<a\n@x>")), "a\n@x");
    }

    #[test]
    fn decode_snippet_follows_the_js_regex_edges() {
        assert_eq!(decode_snippet("&AMP;&Lt;&#X41;&#x6a;"), "&<Aj");
        assert_eq!(decode_snippet("&#0;&#x0;&#x110000;"), "&#0;&#x0;&#x110000;");
        assert_eq!(decode_snippet("&#x10FFFF;"), "\u{10FFFF}");
        assert_eq!(decode_snippet("&#128512;&#x1F600;"), "😀😀");
        // Huge numbers never overflow.
        assert_eq!(
            decode_snippet("&#99999999999999999999999;"),
            "&#99999999999999999999999;"
        );
        // JS yields a lone surrogate; a Rust string cannot hold one: the entity stays.
        assert_eq!(decode_snippet("&#xD800;"), "&#xD800;");
        // Not entities: no `;`, an empty body, a mixed body, a non-ASCII letter.
        assert_eq!(
            decode_snippet("&amp &; &#x; &#12a; &é;"),
            "&amp &; &#x; &#12a; &é;"
        );
        // The scan restarts after a failed `&`.
        assert_eq!(decode_snippet("&&amp;"), "&&");
        assert_eq!(decode_snippet("&#&#39;"), "&#'");
        assert_eq!(decode_snippet(""), "");
    }
}
