//! Driving an interactive CLI that lives in a PTY.
//!
//! A PTY-first tab has no wire protocol: the app types at a TUI and reads the
//! transcript that TUI writes. Both halves are the same for every such agent,
//! so they live here rather than in one harness:
//!
//! - **keystrokes** — bracketed paste, the delayed carriage return that
//!   actually submits it, and the quiet-for rule that says the TUI has
//!   finished painting and is listening;
//! - **the tail** — a byte-level cursor into a transcript file that is being
//!   appended to, with the per-harness decoder passed in.
//!
//! Everything harness-specific — the launch line, the hook definitions, the
//! record shapes — stays in that harness's own module.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::events::Payload;

// ------------------------------------------------------------------ keystrokes

/// Clears whatever is in the CLI's composer (Ctrl+U) before a prompt lands, so
/// a half-typed line in the terminal view is not glued to the front of it.
pub const CLEAR_LINE: &[u8] = b"\x15";
pub const BRACKETED_PASTE_START: &str = "\x1b[200~";
pub const BRACKETED_PASTE_END: &str = "\x1b[201~";
/// Interrupt: both TUIs read a bare Escape as "stop what you are doing".
pub const ESCAPE: &[u8] = b"\x1b";
pub const SUBMIT: &[u8] = b"\r";

/// The prompt body as bytes for the PTY.
///
/// Bracketed paste is what makes the TUI take the text as one paste instead of
/// a burst of keystrokes — without it an `@` or a `#` opens a picker that then
/// swallows the Enter. A slash command is the exception: pasted text is
/// classified as prose and never opens the command palette, so a single-line
/// prompt starting with `/` is sent as plain keystrokes.
///
/// An embedded Escape would close the frame early and run the rest as
/// keystrokes, so escapes are replaced with the printable symbol for one.
pub fn body_bytes(text: &str) -> Vec<u8> {
    let sanitized = text.replace('\u{1b}', "\u{241b}").replace("\r\n", "\r").replace('\n', "\r");
    if is_slash_command(text) {
        return sanitized.into_bytes();
    }
    format!("{BRACKETED_PASTE_START}{sanitized}{BRACKETED_PASTE_END}").into_bytes()
}

fn is_slash_command(text: &str) -> bool {
    text.starts_with('/') && !text.contains('\n') && !text.contains('\r')
}

/// An image the CLI should attach: the path, bracketed-pasted on its own. A
/// typed path is read as prose; only a paste becomes an attachment.
pub fn attachment_bytes(path: &str) -> Vec<u8> {
    format!("{BRACKETED_PASTE_START}{}{BRACKETED_PASTE_END}", path.replace('\u{1b}', "")).into_bytes()
}

/// How long to wait between the body and the Enter that submits it.
///
/// A carriage return inside the same write is read as part of the paste, so
/// the text lands in the composer and never sends: the two writes have to be
/// separated in time as well as in call. The floor is the TUI's own settle;
/// the slope is how fast a pty ingests a paste, so a long prompt still gets
/// its Enter after the last character has arrived.
pub fn submit_delay(body_len: usize) -> Duration {
    Duration::from_millis(250 + (body_len / 4096) as u64)
}

/// How long a TUI has to have been quiet before it is taken to be listening,
/// and how long to wait for that before typing anyway.
///
/// A TUI drops keystrokes while it is still painting its first frame and has
/// no way to say when it is ready, so the sign is that it has drawn something
/// and then stopped. Measured, not guessed, against both installed CLIs:
/// Claude Code paints at 0.3 s, pauses 0.7 s, paints again at 1.0 s and
/// settles at 2.0 s; Codex paints in a burst to 0.3 s and settles somewhere
/// between 1.8 s (a resumed session) and 3.5 s (a cold start, while the model
/// and directory lines resolve). One second of quiet clears both, and a
/// prompt typed into the gap before it vanishes without a trace.
pub const READY_QUIET: Duration = Duration::from_millis(1000);
pub const READY_TIMEOUT: Duration = Duration::from_secs(20);

// ------------------------------------------------------------------ the tail

/// Turns one transcript record into the app's payloads. Unknown records
/// yield nothing.
pub type Decoder = fn(&str, &mut Vec<Payload>);

/// A cursor into one transcript file: how far it has been read, and the bytes
/// after the last newline, which are a record still being written.
///
/// It works in bytes, not text: a read can land in the middle of a record and
/// therefore in the middle of a multi-byte character, so nothing is decoded
/// until its newline has arrived.
pub struct Streamer {
    offset: u64,
    partial: Vec<u8>,
    decode: Decoder,
}

impl Streamer {
    /// Start reading at `offset` — the file's length when the CLI was spawned,
    /// so a resumed conversation is not replayed into the log twice.
    pub fn at(offset: u64, decode: Decoder) -> Self {
        Self { offset, partial: Vec::new(), decode }
    }

    pub fn offset(&self) -> u64 {
        self.offset
    }

    /// Feed the bytes read after `offset()`. Complete lines are decoded; the
    /// tail after the last newline is kept for the next chunk.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Payload> {
        self.offset += chunk.len() as u64;
        self.partial.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nl) = self.partial.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = self.partial.drain(..=nl).collect();
            if let Ok(text) = std::str::from_utf8(&line) {
                let line = text.trim_end_matches(['\n', '\r']);
                if !line.trim().is_empty() {
                    (self.decode)(line, &mut out);
                }
            }
        }
        out
    }
}

/// How often the transcript is looked at. Polling is the authority: a CLI
/// appends without any signal the app could subscribe to, and a watch on a
/// file that may not exist yet is more machinery than a 200 ms stat.
pub const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Follows one transcript file.
pub struct Tail {
    path: Mutex<PathBuf>,
    /// The cursor, held across polls. Also serialises the two callers — the
    /// poll thread and a `Stop` hook flushing before it closes the turn — so
    /// payloads are published in file order whichever gets there first.
    stream: Mutex<Streamer>,
    decode: Decoder,
}

impl Tail {
    /// Start at the file's current length: everything already in it is either
    /// history the app has logged or a conversation it is resuming.
    pub fn opening(path: PathBuf, decode: Decoder) -> Self {
        let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Self { path: Mutex::new(path), stream: Mutex::new(Streamer::at(len, decode)), decode }
    }

    /// Point at the file the CLI actually opened. Hooks carry
    /// `transcript_path`, which is authoritative; anything derived before the
    /// CLI started is only a guess.
    pub fn retarget(&self, path: &Path) {
        let mut current = self.path.lock().unwrap();
        if *current == path {
            return;
        }
        let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        *current = path.to_path_buf();
        *self.stream.lock().unwrap() = Streamer::at(len, self.decode);
    }

    /// Read whatever has been appended since the last call.
    pub fn drain(&self) -> Vec<Payload> {
        use std::io::{Read, Seek, SeekFrom};

        let path = self.path.lock().unwrap().clone();
        if path.as_os_str().is_empty() {
            return Vec::new();
        }
        let mut stream = self.stream.lock().unwrap();
        let Ok(meta) = std::fs::metadata(&path) else { return Vec::new() };
        let size = meta.len();
        let offset = stream.offset();
        if size == offset {
            return Vec::new();
        }
        if size < offset {
            // A CLI only appends, so a shorter file means it was replaced.
            // Skipping to the new end loses a little; replaying from zero
            // would duplicate the whole conversation in the log.
            log::warn!("transcript {} shrank; skipping to its end", path.display());
            *stream = Streamer::at(size, self.decode);
            return Vec::new();
        }
        let mut file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(e) => {
                log::warn!("transcript {}: {e}", path.display());
                return Vec::new();
            }
        };
        if file.seek(SeekFrom::Start(offset)).is_err() {
            return Vec::new();
        }
        let mut buf = Vec::with_capacity((size - offset) as usize);
        if file.take(size - offset).read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        stream.push(&buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo(line: &str, out: &mut Vec<Payload>) {
        out.push(Payload::Status { text: line.to_string() });
    }

    #[test]
    fn a_prompt_is_pasted_and_submitted_separately() {
        let body = body_bytes("hello @src/main.rs");
        assert_eq!(String::from_utf8(body.clone()).unwrap(), "\x1b[200~hello @src/main.rs\x1b[201~");
        assert!(!body.ends_with(SUBMIT));
        assert!(submit_delay(body.len()) >= Duration::from_millis(250));
        // A long paste gets longer to arrive, so its Enter waits longer.
        assert!(submit_delay(200_000) > submit_delay(10));
    }

    #[test]
    fn newlines_become_carriage_returns_and_escapes_lose_their_bite() {
        let s = String::from_utf8(body_bytes("one\ntwo\r\nthree\u{1b}[31m")).unwrap();
        assert_eq!(s, "\x1b[200~one\rtwo\rthree\u{241b}[31m\x1b[201~");
    }

    #[test]
    fn a_slash_command_is_typed_so_the_palette_opens() {
        assert_eq!(String::from_utf8(body_bytes("/model opus")).unwrap(), "/model opus");
        // Only a lone line counts; prose that happens to start with a slash
        // and carries on is still a paste.
        assert!(String::from_utf8(body_bytes("/tmp/x\nand more")).unwrap().starts_with(BRACKETED_PASTE_START));
    }

    #[test]
    fn the_tail_reads_only_what_was_appended() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        std::fs::write(&path, "old\n").unwrap();
        let tail = Tail::opening(path.clone(), echo);
        assert!(tail.drain().is_empty());

        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        use std::io::Write;
        // A record split across two appends is only decoded once complete.
        f.write_all(b"ne").unwrap();
        assert!(tail.drain().is_empty());
        f.write_all(b"w\n").unwrap();
        let p = tail.drain();
        assert_eq!(p.len(), 1);
        assert!(matches!(&p[0], Payload::Status { text } if text == "new"));
        assert!(tail.drain().is_empty());
    }


    #[test]
    fn a_split_multibyte_character_is_not_decoded_until_it_is_whole() {
        let mut s = Streamer::at(0, echo);
        let text = "café\n".as_bytes();
        assert!(s.push(&text[..4]).is_empty());
        let out = s.push(&text[4..]);
        assert!(matches!(&out[0], Payload::Status { text } if text == "café"));
    }
}
