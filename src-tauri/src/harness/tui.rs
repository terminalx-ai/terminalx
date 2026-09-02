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

use std::collections::{HashSet, VecDeque};
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

/// A TUI drops keystrokes while it is still painting its first frame, and the
/// screen cannot be asked whether it is listening. Claude Code can be asked:
/// its `SessionStart` hook runs once its session is up, for a fresh start and
/// a `--resume` alike, and a short settle after it covers the last of the
/// paint.
pub const READY_SETTLE: Duration = Duration::from_millis(300);
/// Codex has no such moment — its session, and so its `SessionStart`, does not
/// exist until a prompt creates one — so for Codex, and for any CLI whose
/// hooks never reach us, readiness is the screen: it has drawn something and
/// then stopped. Three seconds, because a resumed Claude Code replays the
/// conversation and pauses 2.7 s in the middle of doing it, and a cold Codex
/// settles at 3.5 s with gaps of 1.6 s before that. It cannot be the rule for
/// a CLI that announces itself, because a busy TUI redraws a spinner forever
/// and never goes quiet at all.
pub const READY_QUIET: Duration = Duration::from_millis(3000);
/// The give-up. Long, because it is only reached when every signal failed, and
/// what follows is typing anyway and saying so — never dropping the prompt.
pub const READY_TIMEOUT: Duration = Duration::from_secs(60);

/// When a pane's CLI said it was up. Shared with the thread that types into
/// the pane, which is the only thing that has to wait for it.
pub struct Ready {
    at: Mutex<Option<std::time::Instant>>,
    announces_start: bool,
}

impl Ready {
    /// `announces_start` is whether this CLI runs its `SessionStart` hook when
    /// it starts, or only when a first prompt creates a session. Probed both
    /// ways, fresh and resumed, with no prompt sent: Claude Code does the
    /// former, Codex the latter. Waiting on a hook that cannot arrive until
    /// after the thing it is gating would wait for ever.
    pub fn new(announces_start: bool) -> Self {
        Self { at: Mutex::new(None), announces_start }
    }

    pub fn announces_start(&self) -> bool {
        self.announces_start
    }

    /// The `SessionStart` hook arrived. Only the first one counts: a CLI fires
    /// it again after a `/clear` or a compaction, and by then it is long since
    /// listening.
    pub fn mark(&self) {
        let mut at = self.at.lock().unwrap();
        if at.is_none() {
            *at = Some(std::time::Instant::now());
        }
    }

    /// Whether the CLI has been up long enough to have finished drawing.
    pub fn settled(&self) -> bool {
        self.at.lock().unwrap().is_some_and(|at| at.elapsed() >= READY_SETTLE)
    }
}

// ------------------------------------------------------------------ the tail

/// Turns one transcript record into the app's payloads. Unknown records
/// yield nothing. The set is records the app has already logged under
/// another id, which the decoder recognises and drops.
pub type Decoder = fn(&str, &HashSet<String>, &mut Vec<Payload>);

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
    /// Records the app has already logged under another id. A forked Claude
    /// conversation is copied into its new file record for record, and the
    /// copies keep their original uuids.
    skip: HashSet<String>,
}

impl Streamer {
    /// Start reading at `offset` — the file's length when the CLI was spawned,
    /// so a resumed conversation is not replayed into the log twice. `skip`
    /// names records already logged elsewhere, which is how a fork's copy of
    /// its parent is left out.
    pub fn skipping(offset: u64, decode: Decoder, skip: HashSet<String>) -> Self {
        Self { offset, partial: Vec::new(), decode, skip }
    }

    pub fn at(offset: u64, decode: Decoder) -> Self {
        Self::skipping(offset, decode, HashSet::new())
    }

    /// The records this cursor will drop, so a re-opened cursor keeps them.
    pub fn carried(&self) -> &HashSet<String> {
        &self.skip
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
                    (self.decode)(line, &self.skip, &mut out);
                }
            }
        }
        out
    }
}

/// How long a `Stop` hook waits for the transcript to catch up with the reply
/// the hook is already holding. Well inside the hook's own 10 s.
pub const STOP_SETTLE: Duration = Duration::from_secs(2);

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
    /// Follow from the file's length now: whatever it already holds is either
    /// history the app has logged or a conversation it is resuming. `carried`
    /// names records a fork will copy in later, which are history too.
    pub fn opening(path: PathBuf, decode: Decoder, carried: HashSet<String>) -> Self {
        let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Self { path: Mutex::new(path), stream: Mutex::new(Streamer::skipping(len, decode, carried)), decode }
    }

    /// Follow a file whose name is not known yet. A Codex tab is like this
    /// until its first `SessionStart` hook: Codex mints the conversation id
    /// itself, so there is nothing to derive the path from beforehand.
    pub fn unknown(decode: Decoder) -> Self {
        Self { path: Mutex::new(PathBuf::new()), stream: Mutex::new(Streamer::at(0, decode)), decode }
    }


    /// Point at the file the CLI actually opened. Hooks carry
    /// `transcript_path`, which is authoritative; anything derived before the
    /// CLI started is only a guess.
    pub fn retarget(&self, path: &Path) {
        let mut current = self.path.lock().unwrap();
        if *current == path {
            return;
        }
        *current = path.to_path_buf();
        let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let mut stream = self.stream.lock().unwrap();
        *stream = Streamer::skipping(len, self.decode, stream.carried().clone());
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
            *stream = Streamer::skipping(size, self.decode, stream.carried().clone());
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

/// One turn's bookkeeping: what it has said, and whether it has been closed.
///
/// Both facts exist because a turn ends over two channels at once. The CLI's
/// `Stop` hook fires the moment the model stops; the record of what it said,
/// and in some transcripts a record that the turn ended, are file writes the
/// tailer has yet to see. Either can arrive first, and both used to be
/// believed:
///
/// - the hook winning the race published `turn_completed` before the reply,
///   so the reply landed outside its own turn and was drawn again under it;
/// - both closers publishing left a second `turn_completed` with no prompt in
///   front of it — a turn out of nowhere whose final text was drawn as another
///   bubble, reading as "delta / Worked for 10s / delta / Worked for 2s".
///
/// So a turn is opened once by the prompt that starts it, closed once by
/// whichever closer gets there first, and its reply is drawn once.
pub struct TurnTail {
    /// The last assistant text published for the turn in progress.
    said: Option<String>,
    /// Text the app published from a `Stop` hook because the transcript had
    /// not caught up; its record is skipped when it finally lands.
    anticipated: VecDeque<String>,
    /// Whether the turn in progress has already had its boundary published.
    /// A tab that has not been prompted starts closed, so a stray boundary
    /// before the first prompt is not a turn either.
    closed: bool,
}

impl Default for TurnTail {
    fn default() -> Self {
        Self { said: None, anticipated: VecDeque::new(), closed: true }
    }
}

impl TurnTail {
    /// Note an assistant message from the transcript. `false` means this is a
    /// record the app has already published and the caller must drop it.
    pub fn observe(&mut self, text: &str) -> bool {
        if self.anticipated.front().is_some_and(|a| a == text.trim()) {
            self.anticipated.pop_front();
            return false;
        }
        self.said = Some(text.trim().to_string());
        true
    }

    /// Whether the transcript has already delivered what the hook is holding.
    pub fn saw(&self, want: &str) -> bool {
        self.said.as_deref() == Some(want.trim())
    }

    /// Say it on the transcript's behalf, and skip its record when it lands.
    pub fn anticipate(&mut self, want: &str) {
        let want = want.trim().to_string();
        self.said = Some(want.clone());
        self.anticipated.push_back(want);
    }

    /// A prompt was published: a turn is open and its close is due again.
    /// What the new turn says is judged on its own, so the same reply twice
    /// running is not mistaken for one already seen.
    pub fn opened(&mut self) {
        self.said = None;
        self.closed = false;
    }

    /// Take the right to close the turn. `false` means it is already closed
    /// and the caller is the second of the two racing closers, whose boundary
    /// would land as a turn with no prompt in it.
    ///
    /// The reply is deliberately *not* forgotten here: a `Stop` hook settles
    /// against it after the transcript's own records have been read, and the
    /// next `opened` is what clears it.
    pub fn closing(&mut self) -> bool {
        if self.closed {
            return false;
        }
        self.closed = true;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo(line: &str, skip: &HashSet<String>, out: &mut Vec<Payload>) {
        if skip.contains(line) {
            return;
        }
        out.push(Payload::Status { text: line.to_string() });
    }

    /// The `Stop` hook and the assistant record race, and the reply must be
    /// drawn exactly once whichever wins.
    /// The composer waits for this before typing. It used to wait for the
    /// pane to fall quiet instead, which a resumed TUI drawing a spinner never
    /// does, and the prompt was dropped when the wait timed out.
    #[test]
    fn readiness_flips_when_the_session_starts_and_not_before() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;

        let ready = Arc::new(Ready::new(true));
        assert!(!ready.settled());

        let typed = Arc::new(AtomicBool::new(false));
        let (r, t) = (ready.clone(), typed.clone());
        let waiter = std::thread::spawn(move || {
            while !r.settled() {
                std::thread::sleep(Duration::from_millis(5));
            }
            t.store(true, Ordering::SeqCst);
        });

        std::thread::sleep(READY_SETTLE * 2);
        assert!(!typed.load(Ordering::SeqCst), "nothing is typed before SessionStart");

        ready.mark();
        assert!(!ready.settled(), "nor in the instant it arrives");
        waiter.join().unwrap();
        assert!(typed.load(Ordering::SeqCst), "the prompt held back goes in once the CLI is up");
    }

    /// Codex never fires the hook before the prompt that would create its
    /// session, so waiting on it would wait for ever. That tab is told to
    /// read the screen instead.
    #[test]
    fn a_cli_that_does_not_announce_its_start_is_never_waited_on_for_one() {
        let ready = Ready::new(false);
        assert!(!ready.announces_start());
        ready.mark();
        std::thread::sleep(READY_SETTLE + Duration::from_millis(50));
        // `settled` still answers honestly if a hook does turn up; what
        // changes is that the caller does not treat quiet as a failure.
        assert!(ready.settled());
        assert!(Ready::new(true).announces_start());
    }

    #[test]
    fn only_the_first_session_start_counts() {
        let ready = Ready::new(true);
        ready.mark();
        std::thread::sleep(READY_SETTLE + Duration::from_millis(50));
        assert!(ready.settled());
        // A CLI fires it again after a /clear; by then it is long since up.
        ready.mark();
        assert!(ready.settled());
    }

    #[test]
    fn a_reply_is_published_once_whichever_of_stop_and_the_record_lands_first() {
        // Record first: the hook has nothing to add.
        let mut t = TurnTail::default();
        assert!(t.observe("demo"));
        assert!(t.saw("demo"));

        // Stop first: the app says it, and drops the record when it lands.
        let mut t = TurnTail::default();
        assert!(!t.saw("demo"));
        t.anticipate("demo");
        assert!(t.saw("demo"));
        assert!(!t.observe("demo"), "the record the app pre-empted is dropped");
        assert!(t.observe("demo"), "a genuine second one is not");
    }

    #[test]
    fn the_same_reply_in_the_next_turn_is_not_mistaken_for_one_already_seen() {
        let mut t = TurnTail::default();
        t.opened();
        t.observe("demo");
        t.closing();
        // The hook settles against the reply after the close is taken, so it
        // survives it; the next prompt is what forgets it.
        assert!(t.saw("demo"));
        t.opened();
        assert!(!t.saw("demo"));
    }

    /// A turn ends over two channels at once: the CLI's `Stop` hook and, in a
    /// transcript that records one, the turn-end record. Either can arrive
    /// first. Only the first publishes the boundary — the second used to land
    /// as a turn with no prompt in front of it, drawing the reply again under
    /// a second "worked for" line.
    #[test]
    fn a_turn_is_closed_once_whichever_closer_arrives_first() {
        // The hook first, the record second.
        let mut t = TurnTail::default();
        t.opened();
        t.observe("delta");
        assert!(t.saw("delta"), "the reply landed before the hook");
        assert!(t.closing(), "the Stop hook closes the turn");
        assert!(!t.closing(), "the record that follows it does not close it again");

        // The record first, the hook second.
        let mut t = TurnTail::default();
        t.opened();
        t.observe("delta");
        assert!(t.closing(), "the turn-end record closes the turn");
        assert!(!t.closing(), "the Stop hook that follows it does not");
        // And the hook can still settle against what the turn said.
        assert!(t.saw("delta"));

        // The next prompt is a new turn, which closes on its own account.
        t.opened();
        assert!(t.closing());
    }

    #[test]
    fn a_boundary_with_no_prompt_behind_it_is_not_a_turn() {
        // A tab that has not been prompted — one just opened on a resumed
        // conversation, say — starts closed.
        let mut t = TurnTail::default();
        assert!(!t.closing());
    }

    #[test]
    fn trailing_whitespace_does_not_make_a_reply_look_new() {
        let mut t = TurnTail::default();
        t.observe("demo\n");
        assert!(t.saw("demo"));
        let mut t = TurnTail::default();
        t.anticipate("demo");
        assert!(!t.observe(" demo "));
    }

    #[test]
    fn records_already_logged_elsewhere_are_left_out() {
        let mut s = Streamer::skipping(0, echo, HashSet::from(["copied".to_string()]));
        let out = s.push(b"copied\nfresh\n");
        assert_eq!(out.len(), 1);
        assert!(matches!(&out[0], Payload::Status { text } if text == "fresh"));
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
        let tail = Tail::opening(path.clone(), echo, HashSet::new());
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
    fn a_tail_with_no_file_yet_reads_nothing_until_it_is_named() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("later.jsonl");
        let tail = Tail::unknown(echo);
        assert!(tail.drain().is_empty());
        std::fs::write(&path, "first\n").unwrap();
        tail.retarget(&path);
        // What the file already held when it was named is history.
        assert!(tail.drain().is_empty());
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"second\n").unwrap();
        assert!(matches!(&tail.drain()[0], Payload::Status { text } if text == "second"));
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
