//! Port of 0.1.0's `gmail-message-text.test.ts` (28 cases), plus the Rust-only checks.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde_json::json;

use super::*;
use crate::contract::gmail::google::{Header, MessageFull, PartBody};
use crate::contract::gmail::{BODY_MAX, LINKS_MAX, URL_MAX};

/// `bytes.toString('base64url')`: no padding.
fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn utf8(text: &str) -> String {
    encode(text.as_bytes())
}

/// `Buffer.from(data, 'base64url').length` for the test data (always valid base64url).
fn decoded_len(data: &str) -> f64 {
    URL_SAFE_NO_PAD.decode(data).map_or(0, |bytes| bytes.len()) as f64
}

fn part(
    mime_type: &str,
    data: Option<String>,
    charset: Option<&str>,
    filename: Option<&str>,
) -> MessagePart {
    let content_type = match charset {
        Some(charset) => format!("{mime_type}; charset=\"{charset}\""),
        None => mime_type.to_owned(),
    };
    let size = data.as_deref().map_or(0.0, decoded_len);
    MessagePart {
        mime_type: mime_type.to_owned(),
        filename: Some(filename.unwrap_or("").to_owned()),
        headers: vec![Header {
            name: "Content-Type".into(),
            value: content_type,
        }],
        body: PartBody { data, size },
        parts: None,
    }
}

fn multipart(mime_type: &str, parts: Vec<MessagePart>) -> MessagePart {
    MessagePart {
        mime_type: mime_type.to_owned(),
        filename: Some(String::new()),
        headers: vec![Header {
            name: "Content-Type".into(),
            value: format!("{mime_type}; boundary=\"b\""),
        }],
        body: PartBody {
            data: None,
            size: 0.0,
        },
        parts: Some(parts),
    }
}

fn html(markup: &str) -> MessagePart {
    part("text/html", Some(utf8(markup)), Some("UTF-8"), None)
}

fn plain(text: &str) -> MessagePart {
    part("text/plain", Some(utf8(text)), Some("utf-8"), None)
}

fn link(text: &str, url: &str) -> GmailLink {
    GmailLink {
        text: text.to_owned(),
        url: url.to_owned(),
    }
}

fn lines(body: &str) -> Vec<&str> {
    body.split('\n').collect()
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

// ---------------------------------------------------------------------------------------------
// describe('extractMessage body')

#[test]
fn reads_a_text_plain_message() {
    assert_eq!(
        extract_message(&plain("Hola Ana,\r\n\r\nNos vemos mañana.\r\n")),
        MessageText {
            body: "Hola Ana,\n\nNos vemos mañana.".into(),
            truncated: false,
            links: vec![],
            attachments: 0
        }
    );
}

#[test]
fn converts_a_text_html_message_with_paragraphs_breaks_and_lists_as_line_breaks() {
    let body = extract_message(&html(
        "<p>Uno</p><p>Dos<br>Tres</p><ul><li>alfa</li><li>beta</li></ul>",
    ))
    .body;
    assert!(body.starts_with("Uno\n"), "{body:?}");
    assert_eq!(
        lines(&body),
        ["Uno", "", "Dos", "Tres", "", " * alfa", " * beta"]
    );
}

#[test]
fn keeps_headings_as_written_and_puts_table_cells_on_their_own_lines() {
    let body = extract_message(&html(
        "<h1>Título</h1><h3>Sub</h3><table><tr><th>Mes</th><th>Total</th></tr><tr><td>enero</td><td>3</td></tr></table>",
    ))
    .body;
    assert_eq!(
        lines(&body),
        ["Título", "", "Sub", "", "Mes", "Total", "enero", "3"]
    );
}

#[test]
fn prefers_text_plain_in_multipart_alternative() {
    let payload = multipart(
        "multipart/alternative",
        vec![plain("Texto plano"), html("<p>Versión <b>HTML</b></p>")],
    );
    assert_eq!(extract_message(&payload).body, "Texto plano");
    let html_first = multipart(
        "multipart/alternative",
        vec![html("<p>Versión HTML</p>"), plain("Texto plano")],
    );
    assert_eq!(extract_message(&html_first).body, "Texto plano");
}

#[test]
fn finds_the_text_in_a_nested_multipart_mixed_and_counts_the_attachment() {
    let mut pdf = part("application/pdf", None, None, Some("informe.pdf"));
    pdf.body = PartBody {
        data: None,
        size: 2048.0,
    };
    let payload = multipart(
        "multipart/mixed",
        vec![
            multipart(
                "multipart/alternative",
                vec![
                    plain("Adjunto el informe."),
                    html("<p>Adjunto el informe.</p>"),
                ],
            ),
            pdf,
        ],
    );
    assert_eq!(
        extract_message(&payload),
        MessageText {
            body: "Adjunto el informe.".into(),
            truncated: false,
            links: vec![],
            attachments: 1
        }
    );
}

#[test]
fn never_takes_a_text_attachment_as_the_body() {
    let payload = multipart(
        "multipart/mixed",
        vec![
            html("<p>Cuerpo</p>"),
            part("text/plain", Some(utf8("notas")), None, Some("notas.txt")),
        ],
    );
    let result = extract_message(&payload);
    assert_eq!(result.body, "Cuerpo");
    assert_eq!(result.attachments, 1);
}

#[test]
fn decodes_base64url_with_dash_and_underscore_and_without_padding() {
    let text = "a>>>b???¿ok?";
    let data = utf8(text);
    assert!(data.contains('-') || data.contains('_'), "{data}");
    assert!(!data.contains('='));
    assert_eq!(extract_message(&plain(text)).body, text);
}

#[test]
fn decodes_iso_8859_1_and_windows_1252_parts() {
    let latin1 = part(
        "text/plain",
        Some(encode(&[0x61, 0xf1, 0x6f])),
        Some("iso-8859-1"),
        None,
    );
    assert_eq!(extract_message(&latin1).body, "año");
    let cp1252 = part(
        "text/plain",
        Some(encode(&[0x31, 0x30, 0x20, 0x80, 0x20, 0xf1])),
        Some("windows-1252"),
        None,
    );
    assert_eq!(extract_message(&cp1252).body, "10 € ñ");
    let html1252 = part(
        "text/html",
        Some(encode(&[
            0x3c, 0x70, 0x3e, 0x80, 0xf1, 0x3c, 0x2f, 0x70, 0x3e,
        ])),
        Some("Windows-1252"),
        None,
    );
    assert_eq!(extract_message(&html1252).body, "€ñ");
}

#[test]
fn reads_unknown_charsets_as_utf_8_with_replacement_characters() {
    assert_eq!(
        extract_message(&part(
            "text/plain",
            Some(utf8("mañana")),
            Some("x-unknown"),
            None
        ))
        .body,
        "mañana"
    );
    assert_eq!(
        extract_message(&part(
            "text/plain",
            Some(encode(&[0x61, 0xff, 0x62])),
            Some("x-unknown"),
            None
        ))
        .body,
        "a\u{FFFD}b"
    );
    assert_eq!(
        extract_message(&part("text/plain", Some(utf8("sin charset")), None, None)).body,
        "sin charset"
    );
}

#[test]
fn drops_script_style_and_images() {
    let body = extract_message(&html(
        "<style>.a{color:red}</style><script>alert(\"x\")</script><p>Hola</p><img src=\"https://example.com/t.png\" alt=\"pixel\"><noscript></noscript>",
    ))
    .body;
    assert_eq!(body, "Hola");
}

#[test]
fn cuts_a_long_body_to_50_000_characters() {
    let result = extract_message(&plain(&"x".repeat(60_000)));
    assert_eq!(utf16_len(&result.body), BODY_MAX);
    assert!(result.truncated);
    assert!(!extract_message(&plain(&"x".repeat(BODY_MAX))).truncated);
}

#[test]
fn does_not_split_a_surrogate_pair_when_cutting() {
    let result = extract_message(&plain(&("x".repeat(BODY_MAX - 1) + &"😀".repeat(10))));
    assert!(result.truncated);
    assert_eq!(result.body, "x".repeat(BODY_MAX - 1));
}

#[test]
fn gives_an_empty_body_when_there_is_no_text_part() {
    assert_eq!(
        extract_message(&part("text/plain", None, None, None)),
        MessageText::default()
    );
    assert_eq!(
        extract_message(&multipart(
            "multipart/mixed",
            vec![part("image/png", None, None, Some("a.png"))]
        )),
        MessageText {
            body: String::new(),
            truncated: false,
            links: vec![],
            attachments: 1
        }
    );
}

#[test]
fn accepts_a_payload_parsed_from_a_format_full_response() {
    let response: MessageFull = serde_json::from_value(json!({
        "id": "m1",
        "threadId": "t1",
        "internalDate": "1731319200000",
        "payload": { "mimeType": "text/plain", "body": { "data": utf8("Hola"), "size": 4 } },
    }))
    .unwrap();
    assert_eq!(extract_message(&response.payload).body, "Hola");
}

// ---------------------------------------------------------------------------------------------
// describe('extractMessage hostile input')

fn nested(inner: &str, depth: usize) -> String {
    "<div>".repeat(depth) + inner + &"</div>".repeat(depth)
}

#[test]
fn converts_5_000_nested_divs_without_throwing() {
    let _ = extract_message(&html(&nested("hondo", 5000)));
    let body = extract_message(&html(&format!("<p>Arriba</p>{}", nested("hondo", 5000)))).body;
    assert!(body.contains("Arriba"), "{body:?}");
}

#[test]
fn converts_5_000_nested_divs_wrapped_in_an_anchor_without_throwing() {
    let markup = format!(
        "<a href=\"https://example.com/deep\">{}</a>",
        nested("hondo", 5000)
    );
    let result = extract_message(&html(&markup));
    assert_eq!(result.links.len(), 1);
    assert_eq!(result.links[0].url, "https://example.com/deep");
    assert!(utf16_len(&result.links[0].text) <= 200);
}

#[test]
fn keeps_script_style_and_image_content_out_of_the_link_text_and_caps_it_at_200_characters() {
    let result = extract_message(&html(
        "<a href=\"https://example.com/a\">t<script>SECRET</script><style>.x{}</style><img alt=\"ALT\">ext</a>",
    ));
    assert_eq!(result.links, [link("text", "https://example.com/a")]);
    let long = extract_message(&html(&format!(
        "<a href=\"https://example.com/b\">{}</a>",
        "y".repeat(500)
    )));
    assert_eq!(long.links[0].text, "y".repeat(200));
}

#[test]
fn leaves_out_the_title_and_head_of_a_bare_html_document() {
    assert_eq!(
        extract_message(&html("<title>Boletín secreto</title><p>Hola</p>")).body,
        "Hola"
    );
    assert_eq!(
        extract_message(&html(
            "<html><head><title>T</title><meta charset=\"utf-8\"></head><p>Hola</p></html>"
        ))
        .body,
        "Hola"
    );
}

#[test]
fn stops_walking_mime_parts_below_50_levels() {
    let mut payload = plain("demasiado hondo");
    for _ in 0..60 {
        payload = multipart("multipart/mixed", vec![payload]);
    }
    assert_eq!(extract_message(&payload).body, "");
    let mut shallow = plain("a mano");
    for _ in 0..10 {
        shallow = multipart("multipart/mixed", vec![shallow]);
    }
    assert_eq!(extract_message(&shallow).body, "a mano");
}

#[test]
fn visits_at_most_500_mime_parts() {
    let mut parts = vec![plain("cuerpo")];
    parts.extend((0..1000).map(|n| part("image/png", None, None, Some(&format!("{n}.png")))));
    let result = extract_message(&multipart("multipart/mixed", parts));
    assert_eq!(result.body, "cuerpo");
    assert!(result.attachments < 500, "{}", result.attachments);
    assert!(result.attachments > 400, "{}", result.attachments);
}

// ---------------------------------------------------------------------------------------------
// describe('extractMessage links')

#[test]
fn renders_anchors_as_text_n_and_returns_the_links_apart() {
    let result = extract_message(&html(
        "<p>Lee la <a href=\"https://example.com/docs\">guía</a> y el <a href=\"http://example.com/faq\">FAQ</a>.</p>",
    ));
    assert_eq!(result.body, "Lee la guía [1] y el FAQ [2].");
    assert_eq!(
        result.links,
        [
            link("guía", "https://example.com/docs"),
            link("FAQ", "http://example.com/faq")
        ]
    );
}

#[test]
fn keeps_only_http_and_https_hrefs() {
    let markup = [
        "<a href=\"javascript:alert(1)\">a</a>",
        "<a href=\" JavaScript:alert(1)\">b</a>",
        "<a href=\"data:text/html,hola\">c</a>",
        "<a href=\"vbscript:x\">d</a>",
        "<a href=\"mailto:ana@example.com\">e</a>",
        "<a href=\"/relative\">f</a>",
        "<a>g</a>",
        "<a href=\"  HTTPS://Example.com/ok  \">ok</a>",
    ]
    .join(" ");
    let result = extract_message(&html(&markup));
    assert_eq!(result.links, [link("ok", "https://example.com/ok")]);
    assert_eq!(result.body, "a b c d e f g ok [1]");
}

#[test]
fn lists_a_repeated_link_once_and_reuses_its_number() {
    let result = extract_message(&html(
        "<a href=\"https://example.com/x\">uno</a> <a href=\"https://example.com/x\">dos</a>",
    ));
    assert_eq!(result.links, [link("uno", "https://example.com/x")]);
    assert_eq!(result.body, "uno [1] dos [1]");
}

#[test]
fn uses_the_url_as_text_for_an_anchor_without_text() {
    let result = extract_message(&html(
        "<a href=\"https://example.com/img\"><img src=\"https://example.com/i.png\"></a>",
    ));
    assert_eq!(
        result.links,
        [link("https://example.com/img", "https://example.com/img")]
    );
}

#[test]
fn keeps_at_most_50_links() {
    let anchors = (0..60)
        .map(|n| format!("<a href=\"https://example.com/{n}\">l{n}</a>"))
        .collect::<Vec<_>>()
        .join(" ");
    let result = extract_message(&html(&anchors));
    assert_eq!(result.links.len(), LINKS_MAX);
    assert_eq!(
        result.links.last(),
        Some(&link("l49", "https://example.com/49"))
    );
    assert!(result.body.contains("l49 [50]"), "{}", result.body);
    assert!(result.body.contains("l50 l51"), "{}", result.body);
}

#[test]
fn finds_http_s_urls_in_plain_text() {
    let result = extract_message(&plain(
        "Mira https://example.com/a?b=1, y (http://example.com/c). Repite https://example.com/a?b=1 javascript:alert(1) ftp://example.com/f",
    ));
    assert_eq!(
        result.links,
        [
            link("https://example.com/a?b=1", "https://example.com/a?b=1"),
            link("http://example.com/c", "http://example.com/c"),
        ]
    );
}

#[test]
fn leaves_out_links_longer_than_2048_characters_in_html_and_in_plain_text() {
    let long = format!("https://example.com/{}", "a".repeat(URL_MAX));
    let edge = format!(
        "https://example.com/{}",
        "b".repeat(URL_MAX - "https://example.com/".len())
    );
    let from_html = extract_message(&html(&format!(
        "<a href=\"{long}\">larga</a> <a href=\"{edge}\">justa</a>"
    )));
    assert_eq!(from_html.links, [link("justa", &edge)]);
    assert_eq!(from_html.body, "larga justa [1]");
    assert_eq!(
        extract_message(&plain(&format!("{long} {edge}"))).links,
        [link(&edge[..200], &edge)]
    );
}

#[test]
fn keeps_at_most_50_plain_text_links() {
    let text = (0..60)
        .map(|n| format!("https://example.com/{n}"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(extract_message(&plain(&text)).links.len(), LINKS_MAX);
}

// ---------------------------------------------------------------------------------------------
// Rust-only

/// The formatter and the link text walk never recurse: 5 000 levels convert on a 256 KiB stack
/// (a recursive walk would need several MiB).
#[test]
fn deeply_nested_html_does_not_overflow() {
    let worker = std::thread::Builder::new()
        .stack_size(256 * 1024)
        .spawn(|| {
            let plain_deep =
                extract_message(&html(&format!("<p>Arriba</p>{}", nested("hondo", 5000))));
            let anchor_deep = extract_message(&html(&format!(
                "<a href=\"https://example.com/deep\">{}</a><ul>{}</ul>",
                nested("hondo", 5000),
                "<li><ul>".repeat(5000)
            )));
            (plain_deep, anchor_deep)
        })
        .unwrap();
    let (plain_deep, anchor_deep) = worker.join().expect("no stack overflow");
    assert!(
        plain_deep.body.starts_with("Arriba"),
        "{:?}",
        plain_deep.body
    );
    // html-to-text replaces what lies below 100 levels with an ellipsis.
    assert!(plain_deep.body.contains("..."), "{:?}", plain_deep.body);
    assert!(!plain_deep.body.contains("hondo"));
    assert_eq!(
        anchor_deep.links,
        [link("hondo", "https://example.com/deep")]
    );
}

#[test]
fn decodes_base64_leniently_like_node() {
    // Padding, `+` and `/` are accepted; whitespace and other invalid characters are skipped;
    // `=` stops decoding; leftover bits after the last whole byte are dropped.
    let text = "a>>>b???¿ok?";
    let standard = base64::engine::general_purpose::STANDARD.encode(text);
    assert!(
        standard.contains('+') || standard.contains('/'),
        "{standard}"
    );
    assert_eq!(decode_base64url(&standard), text.as_bytes());
    let spaced = utf8("Hola mundo")
        .chars()
        .flat_map(|c| [c, ' ', '\n', '*'])
        .collect::<String>();
    assert_eq!(decode_base64url(&spaced), b"Hola mundo");
    assert_eq!(
        decode_base64url(&format!("{}={}", utf8("uno"), utf8("dos"))),
        b"uno"
    );
    assert_eq!(decode_base64url("S G\n9*s=YQ"), b"Hol");
    assert_eq!(decode_base64url("SG9sYQ"), b"Hola");
    assert_eq!(decode_base64url("SG9sYQB"), b"Hola\0");
    assert_eq!(decode_base64url("S"), b"");
    let plain_part = part("text/plain", Some(standard), None, None);
    assert_eq!(extract_message(&plain_part).body, text);
}

#[test]
fn decodes_charsets_like_text_decoder() {
    // The latin1 labels are windows-1252 in WHATWG; its undefined bytes map to the C1 controls.
    let bytes = [0x80, 0x81, 0x8d, 0x9f, 0xa0, 0xff];
    for label in [
        "latin1",
        "iso-8859-1",
        "us-ascii",
        "l1",
        "cp1252",
        "x-cp1252",
        "windows-1252",
    ] {
        assert_eq!(
            decode_text(&bytes, label),
            "€\u{81}\u{8d}Ÿ\u{a0}ÿ",
            "{label}"
        );
    }
    // UTF-8 strips one BOM; windows-1252 keeps the bytes; unknown labels are UTF-8.
    assert_eq!(
        decode_text(b"\xEF\xBB\xBF\xEF\xBB\xBFhola", "utf-8"),
        "\u{FEFF}hola"
    );
    assert_eq!(decode_text(b"\xEF\xBB\xBFhola", "windows-1252"), "ï»¿hola");
    assert_eq!(
        decode_text(b"a\xFFb\xE2\x82", "koi8-r"),
        "a\u{FFFD}b\u{FFFD}"
    );
    // `charset` is found case-insensitively, unquoted, with spaces around `=`, up to `;`.
    let mut unquoted = part("text/plain", Some(encode(&[0xf1])), None, None);
    unquoted.headers = vec![Header {
        name: "content-TYPE".into(),
        value: "text/plain; CHARSET = Latin1 ; x=y".into(),
    }];
    assert_eq!(extract_message(&unquoted).body, "ñ");
    // Without a Content-Type header the part is UTF-8.
    let mut headerless = part("text/plain", Some(utf8("mañana")), None, None);
    headerless.headers.clear();
    assert_eq!(extract_message(&headerless).body, "mañana");
}

#[test]
fn plain_text_links_follow_the_js_regex() {
    let result = extract_message(&plain(
        "xhttps://example.com/no _https://example.com/no2 HTTPS://Example.com/Yes!?. <http://example.com/b>c 'https://example.com/q' https://",
    ));
    assert_eq!(
        result.links,
        [
            link("https://example.com/Yes", "https://example.com/Yes"),
            link("http://example.com/b", "http://example.com/b"),
            link("https://example.com/q", "https://example.com/q"),
        ]
    );
}

/// Each expected body is what `extractMessage` (html-to-text 10.0.1, htmlparser2 10.1.0) gives
/// for the same markup, captured by running the TypeScript.
#[test]
fn html_formatting_matches_html_to_text() {
    let hr = format!("a\n\n{}\n\nb", "-".repeat(40));
    let cases: Vec<(&str, &str)> = vec![
        (
            "<ol><li>uno</li><li>dos</li></ol><p>fin</p>",
            "1. uno\n 2. dos\n\nfin",
        ),
        (
            "<ol start=\"9\" type=\"i\"><li>a</li><li>b</li></ol>",
            "ix. a\n x.  b",
        ),
        (
            "<ol type=\"a\" start=\"26\"><li>z</li><li>aa</li></ol>",
            "z.  z\n aa. aa",
        ),
        ("<ol start=\"x\"><li>z</li></ol>", "NaN. z"),
        ("<ul><li>a<ul><li>b</li></ul></li></ul>", "* a\n   * b"),
        ("<ul><li></li><li>b</li></ul>", "* \n * b"),
        ("<ul> <!-- c --> <li>x</li></ul>", "* x"),
        ("<ul>\u{a0}<li>x</li></ul>", "* x"),
        (
            "<blockquote><p>cita</p>dos</blockquote>after",
            "> cita\n> \n> dos\n\nafter",
        ),
        ("<pre>  a\n   b</pre>x", "a\n   b\n\nx"),
        ("<pre>a<br>b<p>c</p>d</pre>", "a\nb\n\ncd"),
        ("a<hr>b", &hr),
        ("<div>a</div><div>b</div>c<span>d</span>", "a\nb\ncd"),
        ("<div><br>x<br></div>", "x"),
        ("<h2>A</h2>texto<h4>B</h4>", "A\n\ntexto\n\nB"),
        ("<P>Hola</P><DIV>Mundo</DIV>", "Hola\n\nMundo"),
        ("<p>a<p>b<div>c</div>", "a\n\nb\n\nc"),
        ("<table><tr><td>a<td>b<tr><td>c</table>d", "a\nb\nc\n\nd"),
        ("<p>a</p></p><br></br>b", "a\n\n\n\n\n\nb"),
        (
            "uno&nbsp;dos &amp; &lt;tres&gt; &eacute; &#x1F600;",
            "uno\u{a0}dos & <tres> é 😀",
        ),
        (
            "&amp &copy; &notanentity; &#0; &#x110000;",
            "& © ¬anentity; \u{FFFD} \u{FFFD}",
        ),
        ("<p>  muchos   \n\t espacios  </p>", "muchos espacios"),
        ("<p>a\u{200b}b c\u{c}d</p>", "a b c d"),
        ("<body><p>a</p></body><p>fuera</p>", "a"),
        ("<p>x</p><body>a</body><body>b</body>", "ab"),
        (
            "<!DOCTYPE html><html><body>Hola <b>mundo</b></body></html>",
            "Hola mundo",
        ),
        ("<svg><p/>x</svg>y<div/>z", "xy\nz"),
        (
            "<textarea>a &amp; <b>b</b></textarea><xmp>&amp;<i>i</i></xmp>",
            "a &amp; <b>b</b>&amp;<i>i</i>",
        ),
        ("<script/>hidden</script>shown", "shown"),
        ("<wbr>a<wbr>b", "ab"),
        ("<img alt=x>z<img>", "z"),
        (
            "<a href=\"https://example.com/\"><div>bloque</div></a>z",
            "bloque\n[1]z",
        ),
        (
            "<a href='https://e.com/'><p>p</p></a><p>q</p>",
            "p\n\n[1]\n\nq",
        ),
        ("<a href='https://e.com/'>\u{a0}</a>", "[1]"),
    ];
    for (markup, expected) in cases {
        assert_eq!(extract_message(&html(markup)).body, expected, "{markup}");
    }
    let nested_anchors = extract_message(&html(
        "<a href=\"https://e.com/a\">x<a href=\"https://e.com/b\">y</a>z</a>",
    ));
    assert_eq!(nested_anchors.body, "xy [2]z [1]");
    assert_eq!(
        nested_anchors.links,
        [link("xyz", "https://e.com/a"), link("y", "https://e.com/b")]
    );
    let blank_anchor = extract_message(&html("<a href='https://e.com/'>\u{a0}</a>"));
    assert_eq!(
        blank_anchor.links,
        [link("https://e.com/", "https://e.com/")]
    );
}

/// `limits` at their edges, as html-to-text gives them: 100 nested elements still print, the
/// 101st level becomes the ellipsis; 10 000 children print, more are cut with the ellipsis.
#[test]
fn html_limits_match_html_to_text() {
    assert_eq!(extract_message(&html(&nested("x", 100))).body, "x");
    assert_eq!(extract_message(&html(&nested("x", 101))).body, "...");
    assert_eq!(
        extract_message(&html(&"<b>x</b>".repeat(10_000))).body,
        "x".repeat(10_000)
    );
    assert_eq!(
        extract_message(&html(&"<b>x</b>".repeat(10_001))).body,
        "x".repeat(10_000) + "..."
    );
    // linkText collapses and trims first, then caps at 200 (a trailing space can stay).
    let long_text = extract_message(&html(&format!(
        "<a href=\"https://e.com/\">{}</a>",
        "w ".repeat(500)
    )));
    assert_eq!(long_text.links[0].text, "w ".repeat(100));
}

/// html5ever traces every character run it tokenizes; mail text must never reach a log line
/// (map §10), in the app logger or the test capture.
#[test]
fn converting_html_writes_no_mail_text_to_the_log() {
    let capture = crate::services::test_log::capture().expect("the test logger");
    let marker = "SecretMailBody7f3a";
    let result = extract_message(&html(&format!(
        "<p>{marker}</p><a href=\"https://example.com/{marker}\">{marker} link</a><script>{marker}</script>"
    )));
    assert!(result.body.contains(marker));
    assert!(capture.lines().iter().all(|line| !line.contains(marker)));
    assert!(!crate::services::logger::target_enabled(
        "html5ever::tokenizer",
        log::Level::Trace
    ));
}
