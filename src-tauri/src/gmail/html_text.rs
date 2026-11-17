//! `htmlToPlain`: the part of html-to-text 10 (over htmlparser2 10) that `message-text.ts` uses,
//! with its options: no word wrap, `maxDepth` 100, `maxChildNodes` 10 000, the Gmail anchor
//! formatter (` [n]` after a numbered http(s) link), `img`/`script`/`style`/`head`/`title`
//! skipped, headings as written (2/2 line breaks) and `td`/`th` as 1/1 blocks.
//!
//! Three stages, none recursive (mail can nest thousands of levels):
//! 1. html5ever's tokenizer (no tree builder) feeds a forgiving tree built with htmlparser2's
//!    rules: implied closes, void elements, close-by-name, `</p>` and `</br>` without an opening
//!    tag, self-closing tags only in svg/math, and raw text in script, style, title, textarea and
//!    xmp (no entities there, as htmlparser2 decodes them in `<title>` only).
//! 2. The base elements (`body`, else the whole document).
//! 3. A walk with an explicit task stack over a port of html-to-text's `BlockTextBuilder`.
//!
//! Tokenizer deviations: html5ever tokenizes as the WHATWG spec says, and htmlparser2 reads a
//! few malformed constructs otherwise, so the text around them can differ from Electron's:
//! - `</ x>` (a space after `</`) is a bogus comment up to the next `>`, not an end tag;
//! - `<![CDATA[...]]>` is a bogus comment that ends at the first `>`, not at `]]>`;
//! - `--!>` closes a comment, where htmlparser2 waits for `-->`;
//! - `<!>` is an empty comment, and `</>` is dropped;
//! - a NUL character becomes U+FFFD where the WHATWG tokenizer replaces it (names, attribute
//!   values, raw text), where htmlparser2 keeps it.
//!
//! Well-formed mail never uses them; differential runs against the TS formatter matched on
//! everything else.

use std::cell::RefCell;
use std::collections::HashMap;

use html5ever::tendril::StrTendril;
use html5ever::tokenizer::states::RawKind;
use html5ever::tokenizer::{
    BufferQueue, TagKind, Token, TokenSink, TokenSinkResult, Tokenizer, TokenizerOpts,
};

use super::message_text::{web_url, LinkList};
use crate::contract::gmail::LINK_TEXT_MAX;
use crate::contract::text::{is_js_whitespace, js_trim, utf16_len, utf16_prefix};

/// `limits.maxDepth`: deeper markup is replaced by the ellipsis.
const HTML_MAX_DEPTH: i32 = 100;
/// `limits.maxChildNodes`: further children are replaced by the ellipsis.
const MAX_CHILD_NODES: usize = 10_000;
/// `limits.ellipsis`.
const ELLIPSIS: &str = "...";
/// `limits.maxInputLength` (UTF-16 units).
const MAX_INPUT_LENGTH: usize = 1 << 24;
/// `linkText` stops collecting once the raw text reaches this many UTF-16 units.
const LINK_TEXT_RAW_MAX: usize = LINK_TEXT_MAX * 4;
/// `hr` without `wordwrap`: `'-'.repeat(formatOptions.length || options.wordwrap || 40)`.
const HR_LENGTH: usize = 40;

/// Elements whose content htmlparser2 reads as raw text up to the matching end tag.
const RAW_TEXT: [&str; 5] = ["script", "style", "title", "textarea", "xmp"];
/// `linkText` never looks inside these.
const HIDDEN_TAGS: [&str; 5] = ["script", "style", "img", "head", "title"];

// ---------------------------------------------------------------------------------------------
// The tree (htmlparser2 + domhandler)

const ROOT: usize = 0;

enum Kind {
    /// The document.
    Root,
    Text(String),
    /// `is_tag` is false for `script` and `style`, which domhandler types apart.
    Element {
        name: String,
        attrs: Vec<(String, String)>,
        is_tag: bool,
    },
    /// Comments, doctypes and processing instructions.
    Other,
}

struct Node {
    kind: Kind,
    parent: usize,
    children: Vec<usize>,
}

struct Tree {
    nodes: Vec<Node>,
    /// Open elements, innermost last.
    stack: Vec<(String, usize)>,
    /// How many open elements carry each name (spares a scan for unmatched end tags).
    open: HashMap<String, usize>,
    /// htmlparser2's `foreignContext`, innermost last; `<x/>` closes only in svg/math.
    foreign: Vec<bool>,
}

fn is_void(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "basefont"
            | "br"
            | "col"
            | "command"
            | "embed"
            | "frame"
            | "hr"
            | "img"
            | "input"
            | "isindex"
            | "keygen"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

/// htmlparser2's `openImpliesClose`.
fn implies_close(name: &str) -> &'static [&'static str] {
    const P: &[&str] = &["p"];
    const FORM: &[&str] = &[
        "input", "option", "optgroup", "select", "button", "datalist", "textarea",
    ];
    match name {
        "tr" => &["tr", "th", "td"],
        "th" => &["th"],
        "td" => &["thead", "th", "td"],
        "body" => &["head", "link", "script"],
        "li" => &["li"],
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => P,
        "select" | "input" | "output" | "button" | "datalist" | "textarea" => FORM,
        "option" => &["option"],
        "optgroup" => &["optgroup", "option"],
        "dd" | "dt" => &["dd", "dt"],
        "address" | "article" | "aside" | "blockquote" | "details" | "div" | "dl" | "fieldset"
        | "figcaption" | "figure" | "footer" | "form" | "header" | "hr" | "main" | "nav" | "ol"
        | "pre" | "section" | "table" | "ul" => P,
        "rt" | "rp" => &["rt", "rp"],
        "tbody" | "tfoot" => &["thead", "tbody"],
        _ => &[],
    }
}

fn is_foreign(name: &str) -> bool {
    matches!(name, "math" | "svg")
}

fn is_html_integration(name: &str) -> bool {
    matches!(
        name,
        "mi" | "mo" | "mn" | "ms" | "mtext" | "annotation-xml" | "foreignobject" | "desc" | "title"
    )
}

impl Tree {
    fn new() -> Self {
        Tree {
            nodes: vec![Node {
                kind: Kind::Root,
                parent: ROOT,
                children: Vec::new(),
            }],
            stack: Vec::new(),
            open: HashMap::new(),
            foreign: vec![false],
        }
    }

    fn current(&self) -> usize {
        self.stack.last().map_or(ROOT, |(_, id)| *id)
    }

    fn append(&mut self, kind: Kind) -> usize {
        let parent = self.current();
        let id = self.nodes.len();
        self.nodes.push(Node {
            kind,
            parent,
            children: Vec::new(),
        });
        self.nodes[parent].children.push(id);
        id
    }

    fn pop(&mut self) {
        if let Some((name, _)) = self.stack.pop() {
            if let Some(count) = self.open.get_mut(&name) {
                *count -= 1;
            }
        }
    }

    /// `ontext`: adjacent text joins the previous text node, as domhandler does.
    fn text(&mut self, text: &str) {
        let parent = self.current();
        if let Some(&last) = self.nodes[parent].children.last() {
            if let Kind::Text(existing) = &mut self.nodes[last].kind {
                existing.push_str(text);
                return;
            }
        }
        self.append(Kind::Text(text.to_owned()));
    }

    /// `emitOpenTag` (+ `onselfclosingtag`).
    fn open(&mut self, name: String, attrs: Vec<(String, String)>, self_closing: bool) {
        let closes = implies_close(&name);
        while self
            .stack
            .last()
            .is_some_and(|(top, _)| closes.contains(&top.as_str()))
        {
            self.pop();
        }
        let is_tag = name != "script" && name != "style";
        let id = self.append(Kind::Element {
            name: name.clone(),
            attrs,
            is_tag,
        });
        if is_void(&name) {
            return;
        }
        if is_foreign(&name) {
            self.foreign.push(true);
        } else if is_html_integration(&name) {
            self.foreign.push(false);
        }
        *self.open.entry(name.clone()).or_default() += 1;
        self.stack.push((name, id));
        // `closeCurrentTag`: `<x/>` closes only in a foreign context. The element is on top of
        // the stack; its `foreignContext` entry stays, as in htmlparser2.
        if self_closing && self.in_foreign() {
            self.pop();
        }
    }

    fn in_foreign(&self) -> bool {
        self.foreign.last().copied().unwrap_or(false)
    }

    /// `onclosetag`.
    fn close(&mut self, name: &str) {
        if is_foreign(name) || is_html_integration(name) {
            self.foreign.pop();
        }
        if !is_void(name) {
            if self.open.get(name).copied().unwrap_or(0) > 0 {
                while let Some((top, _)) = self.stack.last() {
                    let done = top == name;
                    self.pop();
                    if done {
                        break;
                    }
                }
            } else if name == "p" {
                // An implicit `<p>` before a stray `</p>`.
                self.open("p".to_owned(), Vec::new(), false);
                self.pop();
            }
        } else if name == "br" {
            self.append(Kind::Element {
                name: "br".to_owned(),
                attrs: Vec::new(),
                is_tag: true,
            });
        }
    }

    fn attr(&self, id: usize, wanted: &str) -> Option<&str> {
        match &self.nodes[id].kind {
            Kind::Element { attrs, .. } => attrs
                .iter()
                .find(|(name, _)| name == wanted)
                .map(|(_, value)| value.as_str()),
            _ => None,
        }
    }

    /// A tag element's name (`script` and `style` are not tags for html-to-text).
    fn tag_name(&self, id: usize) -> Option<&str> {
        match &self.nodes[id].kind {
            Kind::Element {
                name, is_tag: true, ..
            } => Some(name),
            _ => None,
        }
    }
}

struct Sink {
    tree: RefCell<Tree>,
}

impl TokenSink for Sink {
    type Handle = ();

    fn process_token(&self, token: Token, _line_number: u64) -> TokenSinkResult<()> {
        let mut tree = self.tree.borrow_mut();
        match token {
            Token::TagToken(tag) => {
                let name = tag.name.to_string();
                match tag.kind {
                    TagKind::StartTag => {
                        let raw = !tag.self_closing && RAW_TEXT.contains(&name.as_str());
                        let attrs = tag
                            .attrs
                            .into_iter()
                            .map(|attribute| {
                                (
                                    attribute.name.local.to_string(),
                                    attribute.value.to_string(),
                                )
                            })
                            .collect();
                        tree.open(name, attrs, tag.self_closing);
                        if raw {
                            return TokenSinkResult::RawData(RawKind::Rawtext);
                        }
                    }
                    TagKind::EndTag => tree.close(&name),
                }
            }
            Token::CharacterTokens(text) => tree.text(&text),
            Token::NullCharacterToken => tree.text("\0"),
            Token::CommentToken(_) | Token::DoctypeToken(_) => {
                tree.append(Kind::Other);
            }
            Token::EOFToken | Token::ParseError(_) => {}
        }
        TokenSinkResult::Continue
    }
}

fn parse(markup: &str) -> Tree {
    let tokenizer = Tokenizer::new(
        Sink {
            tree: RefCell::new(Tree::new()),
        },
        // htmlparser2 keeps a U+FEFF (TextDecoder already dropped the BOM).
        TokenizerOpts {
            discard_bom: false,
            ..TokenizerOpts::default()
        },
    );
    let input = BufferQueue::default();
    input.push_back(StrTendril::from_slice(markup));
    while !matches!(tokenizer.feed(&input), html5ever::TokenizerResult::Done) {}
    tokenizer.end();
    tokenizer.sink.tree.into_inner()
}

// ---------------------------------------------------------------------------------------------
// BlockTextBuilder

/// `whitespaceCharacters`: `' \t\r\n\f​'` (not NBSP).
fn is_html_space(character: char) -> bool {
    matches!(character, ' ' | '\t' | '\r' | '\n' | '\u{c}' | '\u{200b}')
}

/// `InlineTextBuilder` without word wrap.
#[derive(Default)]
struct Inline {
    lines: Vec<Vec<String>>,
    next_line: Vec<String>,
    stashed_space: bool,
}

impl Inline {
    fn concat_word(&mut self, word: &str) {
        match self.next_line.last_mut() {
            Some(last) => last.push_str(word),
            None => self.next_line.push(word.to_owned()),
        }
    }

    fn start_new_line(&mut self, count: usize) {
        self.lines.push(std::mem::take(&mut self.next_line));
        for _ in 1..count {
            self.lines.push(Vec::new());
        }
    }

    fn is_empty(&self) -> bool {
        self.lines.is_empty() && self.next_line.is_empty()
    }

    fn clear(&mut self) {
        self.lines.clear();
        self.next_line.clear();
    }

    fn render(&self) -> String {
        self.lines
            .iter()
            .chain(std::iter::once(&self.next_line))
            .map(|words| words.join(" "))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// `WhitespaceProcessor.shrinkWrapAdd` (no `preserveNewlines`).
    fn shrink_wrap_add(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let previously_stashed = self.stashed_space;
        let mut any = false;
        for (index, word) in text
            .split(is_html_space)
            .filter(|word| !word.is_empty())
            .enumerate()
        {
            any = true;
            if index == 0 && !previously_stashed && !text.starts_with(is_html_space) {
                self.concat_word(word);
            } else {
                self.next_line.push(word.to_owned());
            }
        }
        self.stashed_space = (previously_stashed && !any) || text.ends_with(is_html_space);
    }
}

enum ItemKind {
    Block,
    List {
        max_prefix_length: usize,
        inter_row_line_breaks: usize,
    },
    ListItem {
        prefix: String,
    },
}

/// `BlockStackItem`, `ListStackItem` and `ListItemStackItem` (no data tables are configured).
struct Item {
    kind: ItemKind,
    leading_line_breaks: usize,
    inline: Inline,
    raw_text: String,
    stashed_line_breaks: usize,
    is_pre: bool,
}

impl Item {
    fn new(kind: ItemKind, leading_line_breaks: usize, is_pre: bool) -> Self {
        Item {
            kind,
            leading_line_breaks,
            inline: Inline::default(),
            raw_text: String::new(),
            stashed_line_breaks: 0,
            is_pre,
        }
    }

    /// Moves the inline text into `raw_text`: `getText` is only ever read right before the inline
    /// builder is cleared or the item is dropped, so appending in place gives the same text
    /// without copying the whole block for every child (html-to-text's strings are ropes).
    fn flush(&mut self) {
        if !self.inline.is_empty() {
            let rendered = self.inline.render();
            self.raw_text.push_str(&rendered);
            self.inline.clear();
        }
    }

    /// `getText` of an item that is done.
    fn into_text(mut self) -> String {
        self.flush();
        self.raw_text
    }

    /// `addText`.
    fn add_text(&mut self, text: String, leading_line_breaks: usize, trailing_line_breaks: usize) {
        self.flush();
        let line_breaks = self.stashed_line_breaks.max(leading_line_breaks);
        if self.raw_text.is_empty() {
            self.raw_text = text;
            self.leading_line_breaks = line_breaks;
        } else {
            self.raw_text.extend(std::iter::repeat_n('\n', line_breaks));
            self.raw_text.push_str(&text);
        }
        self.stashed_line_breaks = trailing_line_breaks;
    }
}

struct Builder {
    /// Never empty: the root block stays at the bottom.
    stack: Vec<Item>,
}

impl Builder {
    fn new() -> Self {
        Builder {
            stack: vec![Item::new(ItemKind::Block, 1, false)],
        }
    }

    fn top(&mut self) -> &mut Item {
        self.stack
            .last_mut()
            .expect("the root block is never popped")
    }

    fn pop(&mut self) -> Item {
        debug_assert!(self.stack.len() > 1);
        self.stack.pop().expect("an open item")
    }

    fn add_line_break(&mut self) {
        let top = self.top();
        if top.is_pre {
            top.raw_text.push('\n');
        } else {
            top.inline.start_new_line(1);
        }
    }

    fn add_inline(&mut self, text: &str) {
        let top = self.top();
        if top.is_pre {
            top.raw_text.push_str(text);
            return;
        }
        if text.is_empty() || (top.stashed_line_breaks > 0 && text.chars().all(is_html_space)) {
            return;
        }
        if top.stashed_line_breaks > 0 {
            let count = top.stashed_line_breaks;
            top.inline.start_new_line(count);
        }
        top.inline.shrink_wrap_add(text);
        top.stashed_line_breaks = 0;
    }

    fn open_block(&mut self, leading_line_breaks: usize, is_pre: bool) {
        let is_pre = is_pre || self.top().is_pre;
        self.stack
            .push(Item::new(ItemKind::Block, leading_line_breaks, is_pre));
    }

    fn close_block(&mut self, trailing_line_breaks: usize, quote: bool) {
        let block = self.pop();
        let leading = block.leading_line_breaks;
        let trailing = block.stashed_line_breaks.max(trailing_line_breaks);
        let mut text = block.into_text();
        if quote {
            text = text
                .trim_matches('\n')
                .split('\n')
                .map(|line| format!("> {line}"))
                .collect::<Vec<_>>()
                .join("\n");
        }
        self.top().add_text(text, leading, trailing);
    }

    fn open_list(&mut self, leading_line_breaks: usize, max_prefix_length: usize) {
        let is_pre = self.top().is_pre;
        let kind = ItemKind::List {
            max_prefix_length,
            inter_row_line_breaks: 1,
        };
        self.stack
            .push(Item::new(kind, leading_line_breaks, is_pre));
    }

    fn open_list_item(&mut self, prefix: String) {
        let list = self.top();
        let leading = match list.kind {
            ItemKind::List {
                inter_row_line_breaks,
                ..
            } => inter_row_line_breaks,
            _ => 1,
        };
        let is_pre = list.is_pre;
        self.stack
            .push(Item::new(ItemKind::ListItem { prefix }, leading, is_pre));
    }

    fn close_list_item(&mut self) {
        let item = self.pop();
        let list = self.top();
        let (max_prefix_length, inter_row) = match list.kind {
            ItemKind::List {
                max_prefix_length,
                inter_row_line_breaks,
            } => (max_prefix_length, inter_row_line_breaks),
            _ => (0, 1),
        };
        let leading = item.leading_line_breaks;
        let trailing = item.stashed_line_breaks.max(inter_row);
        let prefix = match &item.kind {
            ItemKind::ListItem { prefix } => prefix.clone(),
            _ => String::new(),
        };
        let prefix_length = utf16_len(&prefix).max(max_prefix_length);
        let padding = " ".repeat(prefix_length - utf16_len(&prefix));
        let spacing = format!("\n{}", " ".repeat(prefix_length));
        let text = format!(
            "{prefix}{padding}{}",
            item.into_text().replace('\n', &spacing)
        );
        list.add_text(text, leading, trailing);
    }

    fn close_list(&mut self, trailing_line_breaks: usize) {
        let list = self.pop();
        let leading = list.leading_line_breaks;
        let text = list.into_text();
        if !text.is_empty() {
            self.top().add_text(text, leading, trailing_line_breaks);
        }
    }

    fn finish(mut self) -> String {
        self.stack.swap_remove(0).into_text()
    }
}

// ---------------------------------------------------------------------------------------------
// Ordered list markers

/// JS `Number(string)`.
fn js_number(text: &str) -> f64 {
    let text = js_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    let radix = |prefix: &str| {
        text.get(..2)
            .filter(|head| head.eq_ignore_ascii_case(prefix))
            .map(|_| &text[2..])
    };
    for (prefix, base) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = radix(prefix) {
            return if !digits.is_empty() && digits.chars().all(|c| c.is_digit(base)) {
                digits.chars().fold(0.0, |value, c| {
                    value * f64::from(base) + f64::from(c.to_digit(base).unwrap_or(0))
                })
            } else {
                f64::NAN
            };
        }
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    // Rust also reads `inf` and `nan`, which JS refuses.
    if text
        .chars()
        .any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E')
    {
        return f64::NAN;
    }
    text.parse().unwrap_or(f64::NAN)
}

/// JS `String(number)` for the values a list index takes (`-0` prints as `0`, as in JS).
fn js_number_string(value: f64) -> String {
    if value == 0.0 {
        "0".to_owned()
    } else if value.is_nan() {
        "NaN".to_owned()
    } else if value.is_infinite() {
        (if value > 0.0 { "Infinity" } else { "-Infinity" }).to_owned()
    } else if value == value.trunc() && value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        format!("{value}")
    }
}

/// JS `ToInt32`.
fn js_to_int32(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    let wrapped = value.trunc().rem_euclid(4_294_967_296.0);
    if wrapped >= 2_147_483_648.0 {
        wrapped - 4_294_967_296.0
    } else {
        wrapped
    }
}

/// `numberToLetterSequence`.
fn letters(mut number: f64, base_char: u8) -> String {
    let mut digits = Vec::new();
    loop {
        number -= 1.0;
        digits.push(number % 26.0);
        // `(num / base) >> 0` is never NaN.
        number = js_to_int32(number / 26.0);
        if number <= 0.0 {
            break;
        }
    }
    digits
        .iter()
        .rev()
        .map(|digit| {
            let code = f64::from(base_char) + digit;
            // `String.fromCharCode`: ToUint16; a lone surrogate cannot live in a Rust string.
            let unit = if code.is_finite() {
                code.trunc().rem_euclid(65_536.0) as u32
            } else {
                0
            };
            char::from_u32(unit).unwrap_or('\u{FFFD}')
        })
        .collect()
}

/// `numberToRoman`, exact for 1..=3999 (its documented range); other values fall back to the
/// decimal marker. There html-to-text differs: for 0 it gives an empty marker, and elsewhere
/// it prints `undefined` pieces or throws.
fn roman(number: f64) -> String {
    const ONES: [&str; 4] = ["I", "X", "C", "M"];
    const FIVES: [&str; 3] = ["V", "L", "D"];
    if !(1.0..=3999.0).contains(&number) || number != number.trunc() {
        return js_number_string(number);
    }
    let digits = js_number_string(number);
    let count = digits.len();
    digits
        .chars()
        .enumerate()
        .map(|(position, digit)| {
            let value = digit.to_digit(10).unwrap_or(0) as usize;
            let place = count - 1 - position;
            if value % 5 < 4 {
                (if value < 5 { "" } else { FIVES[place] }).to_owned()
                    + &ONES[place].repeat(value % 5)
            } else {
                ONES[place].to_owned()
                    + if value < 5 {
                        FIVES[place]
                    } else {
                        ONES[place + 1]
                    }
            }
        })
        .collect()
}

/// `getOrderedListIndexFunction`.
fn ordered_marker(list_type: Option<&str>, index: f64) -> String {
    match list_type {
        Some("a") => letters(index, b'a'),
        Some("A") => letters(index, b'A'),
        Some("i") => roman(index).to_lowercase(),
        Some("I") => roman(index),
        _ => js_number_string(index),
    }
}

// ---------------------------------------------------------------------------------------------
// The walk

enum Task<'t> {
    /// `recursiveWalk` over `nodes` at depth `depth`; `ellipsis` when children were cut.
    Nodes {
        nodes: &'t [usize],
        position: usize,
        depth: i32,
        ellipsis: bool,
    },
    /// `limitedDepthRecursive`'s fallback below the depth limit.
    Ellipsis,
    CloseBlock {
        trailing: usize,
        quote: bool,
    },
    OpenListItem(String),
    CloseListItem,
    CloseList {
        trailing: usize,
    },
    /// `gmailAnchor`: the link number after the anchor text.
    AnchorEnd(Option<usize>),
}

/// The walk callback a formatter receives: children one level deeper, or the ellipsis.
fn walk(nodes: &[usize], depth: i32) -> Task<'_> {
    if depth < 0 {
        return Task::Ellipsis;
    }
    let ellipsis = nodes.len() > MAX_CHILD_NODES;
    Task::Nodes {
        nodes: &nodes[..nodes.len().min(MAX_CHILD_NODES)],
        position: 0,
        depth,
        ellipsis,
    }
}

/// `findBases`: every `body` in document order (not looking inside one, nor below the depth
/// limit), else the whole document.
fn find_bases(tree: &Tree) -> Vec<usize> {
    let mut found = Vec::new();
    let top = &tree.nodes[ROOT].children;
    let mut stack: Vec<(&[usize], i32)> =
        vec![(&top[..top.len().min(MAX_CHILD_NODES)], HTML_MAX_DEPTH)];
    while let Some((nodes, depth)) = stack.pop() {
        let Some((&first, rest)) = nodes.split_first() else {
            continue;
        };
        stack.push((rest, depth));
        match tree.tag_name(first) {
            Some("body") => found.push(first),
            Some(_) if depth > 0 => {
                let children = &tree.nodes[first].children;
                stack.push((&children[..children.len().min(MAX_CHILD_NODES)], depth - 1));
            }
            _ => {}
        }
    }
    if found.is_empty() {
        top.clone()
    } else {
        found
    }
}

/// `linkText`: the visible text of an anchor from the raw tree (no depth limit), without
/// script, style, image, head or title content, whitespace collapsed, at most `LINK_TEXT_MAX`.
fn link_text(tree: &Tree, anchor: usize) -> String {
    let mut raw = String::new();
    let mut raw_length = 0;
    let mut stack: Vec<usize> = tree.nodes[anchor].children.iter().rev().copied().collect();
    while raw_length < LINK_TEXT_RAW_MAX {
        let Some(current) = stack.pop() else { break };
        match &tree.nodes[current].kind {
            Kind::Text(text) => {
                raw.push_str(text);
                raw_length += utf16_len(text);
            }
            Kind::Element {
                name, is_tag: true, ..
            } if !HIDDEN_TAGS.contains(&name.to_lowercase().as_str()) => {
                stack.extend(tree.nodes[current].children.iter().rev());
            }
            _ => {}
        }
    }
    let collapsed = raw
        .split(is_js_whitespace)
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    utf16_prefix(&collapsed, LINK_TEXT_MAX).to_owned()
}

/// `htmlToPlain`: html-to-text's `convert` with the options of `message-text.ts`. Links are
/// numbered through `links` in reading order.
pub(crate) fn html_to_plain(markup: &str, links: &mut LinkList) -> String {
    let tree = parse(utf16_prefix(markup, MAX_INPUT_LENGTH));
    let bases = find_bases(&tree);
    let mut builder = Builder::new();
    let mut tasks = vec![walk(&bases, HTML_MAX_DEPTH)];
    while let Some(task) = tasks.pop() {
        match task {
            Task::Nodes {
                nodes,
                position,
                depth,
                ellipsis,
            } => {
                let Some(&node) = nodes.get(position) else {
                    if ellipsis {
                        builder.add_inline(ELLIPSIS);
                    }
                    continue;
                };
                tasks.push(Task::Nodes {
                    nodes,
                    position: position + 1,
                    depth,
                    ellipsis,
                });
                format_node(&tree, node, depth, &mut builder, &mut tasks, links);
            }
            Task::Ellipsis => builder.add_inline(ELLIPSIS),
            Task::CloseBlock { trailing, quote } => builder.close_block(trailing, quote),
            Task::OpenListItem(prefix) => builder.open_list_item(prefix),
            Task::CloseListItem => builder.close_list_item(),
            Task::CloseList { trailing } => builder.close_list(trailing),
            Task::AnchorEnd(number) => {
                if let Some(number) = number {
                    builder.add_inline(&format!(" [{number}]"));
                }
            }
        }
    }
    builder.finish()
}

/// One node of `recursiveWalk`: text goes inline, a tag goes to its formatter. A formatter's
/// work after its children is pushed first, so it runs once they are done.
fn format_node<'t>(
    tree: &'t Tree,
    node: usize,
    depth: i32,
    builder: &mut Builder,
    tasks: &mut Vec<Task<'t>>,
    links: &mut LinkList,
) {
    let name = match &tree.nodes[node].kind {
        Kind::Text(text) => return builder.add_inline(text),
        Kind::Element {
            name, is_tag: true, ..
        } => name.as_str(),
        _ => return,
    };
    let children = &tree.nodes[node].children;
    let mut block =
        |builder: &mut Builder, leading: usize, trailing: usize, is_pre: bool, quote: bool| {
            builder.open_block(leading, is_pre);
            tasks.push(Task::CloseBlock { trailing, quote });
            tasks.push(walk(children, depth - 1));
        };
    match name {
        "a" => {
            let number = tree
                .attr(node, "href")
                .and_then(web_url)
                .and_then(|url| links.add(&url, &link_text(tree, node)));
            tasks.push(Task::AnchorEnd(number));
            tasks.push(walk(children, depth - 1));
        }
        "img" | "head" | "title" => {}
        "br" => builder.add_line_break(),
        // A word break opportunity only matters with word wrap.
        "wbr" => {}
        "hr" => {
            builder.open_block(2, false);
            builder.add_inline(&"-".repeat(HR_LENGTH));
            builder.close_block(2, false);
        }
        "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "table" => {
            block(builder, 2, 2, false, false)
        }
        "pre" => block(builder, 2, 2, true, false),
        "blockquote" => block(builder, 2, 2, false, true),
        "article" | "aside" | "div" | "footer" | "form" | "header" | "main" | "nav" | "section"
        | "td" | "th" => block(builder, 1, 1, false, false),
        "ul" | "ol" => format_list(tree, node, depth, builder, tasks),
        _ => tasks.push(walk(children, depth - 1)),
    }
}

/// `formatList` (`formatUnorderedList` / `formatOrderedList`).
fn format_list<'t>(
    tree: &'t Tree,
    node: usize,
    depth: i32,
    builder: &mut Builder,
    tasks: &mut Vec<Task<'t>>,
) {
    let is_nested = tree.tag_name(tree.nodes[node].parent) == Some("li");
    let ordered = tree.tag_name(node) == Some("ol");
    let mut next_index = js_number(
        tree.attr(node, "start")
            .filter(|start| !start.is_empty())
            .unwrap_or("1"),
    );
    let list_type = tree.attr(node, "type");
    let mut next_prefix = || {
        if ordered {
            let marker = ordered_marker(list_type, next_index);
            next_index += 1.0;
            format!(" {marker}. ")
        } else {
            " * ".to_owned()
        }
    };
    let children = &tree.nodes[node].children;
    let mut items = Vec::new();
    let mut max_prefix_length = 0;
    for child in children {
        if let Kind::Text(text) = &tree.nodes[*child].kind {
            if text.chars().all(is_js_whitespace) {
                continue;
            }
        }
        let prefix = if tree.tag_name(*child) == Some("li") {
            let prefix = next_prefix();
            if is_nested {
                prefix.trim_start_matches(is_js_whitespace).to_owned()
            } else {
                prefix
            }
        } else {
            String::new()
        };
        max_prefix_length = max_prefix_length.max(utf16_len(&prefix));
        items.push((child, prefix));
    }
    if items.is_empty() {
        return;
    }
    let (leading, trailing) = if is_nested { (1, 1) } else { (2, 2) };
    builder.open_list(leading, max_prefix_length);
    tasks.push(Task::CloseList { trailing });
    for (child, prefix) in items.into_iter().rev() {
        tasks.push(Task::CloseListItem);
        tasks.push(walk(std::slice::from_ref(child), depth - 1));
        tasks.push(Task::OpenListItem(prefix));
    }
}

#[cfg(test)]
mod tests {
    use super::{js_number_string, ordered_marker};

    #[test]
    fn list_numbers_print_as_js_string_does_negative_zero_included() {
        assert_eq!(js_number_string(-0.0), "0");
        assert_eq!(js_number_string(0.0), "0");
        assert_eq!(js_number_string(-3.0), "-3");
        assert_eq!(js_number_string(2.5), "2.5");
        assert_eq!(js_number_string(f64::NAN), "NaN");
        assert_eq!(js_number_string(f64::NEG_INFINITY), "-Infinity");
        assert_eq!(ordered_marker(None, -0.0), "0");
        assert_eq!(ordered_marker(Some("I"), 4.0), "IV");
    }
}
