//! NetEase Cloud Music (网易云音乐) as the current source. What may be read from it or sent to it
//! is listed in AGENTS.md, each with the date the owner allowed it.
//!
//! `data` reads what NetEase saved on this PC, each only after its switch is on: the play
//! queue (`playingList`, display fields only) and the playlists the user created
//! (`webdb.dat`, opened read-only). `connector` talks to the running NetEase: its local
//! debugging port (127.0.0.1:9233: a fixed set of fields and two of its own actions).
pub mod connector;
pub mod data;

/// The `player` a NetEase source carries in the media snapshot.
pub const PLAYER: &str = "netease";
/// NetEase's name in the list of players (the owner, 2026-10-06: "show 网易云音乐 instead").
/// Windows knows its media session only by the app id (`cloudmusic.exe`), as it does QQ Music's.
pub const NAME: &str = "网易云音乐";

/// JSON text with every lone UTF-16 surrogate escape (a `\uD800`–`\uDFFF` that is not one half of a
/// pair) written as U+FFFD's. JavaScript writes one so for a string cut inside a character or for
/// broken text, and serde_json refuses the whole text for it: one odd character then cost the whole
/// queue file or debugging-port reply. Used only once a text failed to parse.
pub(crate) fn mend_surrogates(json: &[u8]) -> Vec<u8> {
    let unit = |at: usize| {
        let escape = json.get(at..at + 6)?;
        (escape.starts_with(b"\\u") && escape[2..].iter().all(u8::is_ascii_hexdigit))
            .then(|| u16::from_str_radix(std::str::from_utf8(&escape[2..]).ok()?, 16).ok())
            .flatten()
    };
    let mut mended = Vec::with_capacity(json.len());
    let mut index = 0;
    while index < json.len() {
        if json[index] != b'\\' {
            mended.push(json[index]);
            index += 1;
            continue;
        }
        match unit(index) {
            Some(0xD800..=0xDBFF) if matches!(unit(index + 6), Some(0xDC00..=0xDFFF)) => {
                mended.extend_from_slice(&json[index..index + 12]);
                index += 12;
            }
            Some(0xD800..=0xDFFF) => {
                mended.extend_from_slice(b"\\ufffd");
                index += 6;
            }
            // Any other escape (an escaped backslash too) as it is.
            _ => {
                mended.extend_from_slice(&json[index..json.len().min(index + 2)]);
                index += 2;
            }
        }
    }
    mended
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lone_surrogate_escapes_become_replacement_characters_and_nothing_else_changes() {
        let mend = |text: &str| String::from_utf8(mend_surrogates(text.as_bytes())).unwrap();
        assert_eq!(mend(r#"["a\ud83d", "\ude00b", "\uD83D\uDE00", "\u4e00"]"#), r#"["a\ufffd", "\ufffdb", "\uD83D\uDE00", "\u4e00"]"#);
        assert_eq!(mend(r#""\ud800\ud800\udc00""#), r#""\ufffd\ud800\udc00""#, "a high half, then a pair");
        assert_eq!(mend(r#""x\\ud800 \"\\" "#), r#""x\\ud800 \"\\" "#, "an escaped backslash before text is text");
        assert_eq!(mend(r#""\ud8"#), r#""\ud8"#, "a cut escape is left for the parser to refuse");
        assert_eq!(mend("\"字\\"), "\"字\\");
        let value: serde_json::Value = serde_json::from_slice(&mend_surrogates(br#"{"line": "a\ud83d"}"#)).unwrap();
        assert_eq!(value["line"], "a\u{FFFD}");
    }
}
