//! Only explicit localhost ports from printed text. Terminal control strings
//! (including OSC hyperlink targets) are not text and never become destinations.
use std::sync::LazyLock;

fn printed_text(bytes: &[u8]) -> String {
    enum State { Text, Escape, Csi, String, StringEscape }
    let mut state = State::Text;
    let mut text = Vec::with_capacity(bytes.len());
    for &byte in bytes {
        match state {
            State::Text => match byte {
                0x1b => state = State::Escape,
                0..=0x1f | 0x7f => text.push(b' '),
                _ => text.push(byte),
            },
            State::Escape => state = match byte {
                b'[' => State::Csi,
                b']' | b'P' | b'X' | b'^' | b'_' => State::String,
                _ => { text.push(b' '); State::Text },
            },
            State::Csi if (0x40..=0x7e).contains(&byte) => {
                if byte != b'm' { text.push(b' '); }
                state = State::Text;
            }
            State::String if byte == 7 => state = State::Text,
            State::String if byte == 0x1b => state = State::StringEscape,
            State::StringEscape => state = if byte == b'\\' { State::Text } else { State::String },
            _ => {}
        }
    }
    String::from_utf8_lossy(&text).into_owned()
}

pub(super) fn detect(bytes: &[u8]) -> Vec<String> {
    static URL: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(
        r#"(?i)(?:https?://)?localhost:[0-9]+(?:[/?#][^\s<>"'`\\]*)?"#,
    ).expect("valid localhost URL pattern"));
    let text = printed_text(bytes);
    let mut urls = Vec::new();
    for found in URL.find_iter(&text) {
        // Reject domains containing localhost, userinfo and unsupported schemes.
        let attached = |c: char| c.is_alphanumeric() || matches!(c, '_' | '-' | '.' | '@' | ':' | '/' | '\\' | '%');
        if text[..found.start()].chars().next_back().is_some_and(attached) { continue; }
        if text[found.end()..].chars().next().is_some_and(attached) { continue; }
        let candidate = found.as_str().trim_end_matches(['.', ',', ';', ')', ']', '}']);
        let candidate = if candidate.to_ascii_lowercase().starts_with("http") { candidate.to_owned() } else { format!("http://{candidate}") };
        let Ok(url) = url::Url::parse(&candidate) else { continue; };
        if url.host_str() != Some("localhost") || !url.username().is_empty() || url.password().is_some()
            || url.port_or_known_default().is_none_or(|port| port == 0) { continue; }
        let url = url.to_string();
        if !urls.contains(&url) { urls.push(url); }
        if urls.len() == 8 { break; }
    }
    urls
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_bare_http_https_and_coloured_urls_with_paths() {
        assert_eq!(detect(b"Local: \x1b[32mhttp://localhost:\x1b[1m5173/\x1b[0m\r\nlocalhost:3000\n(https://localhost:4443/app?q=1#ready)\nhttp://localhost:5173/"),
            ["http://localhost:5173/", "http://localhost:3000/", "https://localhost:4443/app?q=1#ready"]);
    }

    #[test]
    fn rejects_invalid_ports_and_remote_or_credential_destinations() {
        assert!(detect(b"localhost:0 localhost:65536 localhost:1234567 localhost:3000evil localhost:3000.evil localhost:3000@evil.test https://evil.test/localhost:3000 https://user@localhost:3000 file://localhost:3000 evil-localhost:3000 notlocalhost:3000").is_empty());
        assert_eq!(detect(b"localhost:1 localhost:65535"), ["http://localhost:1/", "http://localhost:65535/"]);
    }

    #[test]
    fn ignores_control_string_urls_but_keeps_printed_link_labels() {
        assert_eq!(detect(b"\x1b]8;;http://localhost:1111\x1b\\localhost:2222\x1b]8;;\x1b\\ \x1b]0;localhost:3333\x07 \x1bPlocalhost:4444\x1b\\ \x1b]unterminated localhost:5555"), ["http://localhost:2222/"]);
    }

    #[test]
    fn reading_a_tail_spanning_chunks_finds_the_complete_url() {
        let chunks: &[&[u8]] = &[b"\x1b[3", b"2mhttp://local", b"host:51", b"73/path\x1b[0m\r\n"];
        assert_eq!(detect(&chunks.concat()), ["http://localhost:5173/path"]);
        let many = (3000..3030).map(|port| format!("localhost:{port}\n")).collect::<String>();
        assert_eq!(detect(many.as_bytes()).len(), 8);
    }
}
