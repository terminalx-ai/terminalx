//! Claude Code, PTY-first: the real interactive CLI is the tab.
//!
//! There is no wire protocol to read, so the three things the app needs come
//! from three places:
//! - **what was said** from the CLI's own transcript file (`transcript.rs`),
//!   followed as it is appended;
//! - **what is happening** from the CLI's hooks, which reach the app over the
//!   hook socket (`crate::hooks`);
//! - **what the reader types** goes back in as keystrokes on the PTY.
//!
//! Every fact below about flags, hook names, hook payloads and hook decision
//! shapes was read out of the installed CLI (2.1.258): `claude --help` and the
//! zod schemas embedded in the binary.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::events::Payload;

use super::transcript::Streamer;

/// The hook events a tab registers, with the matcher each one takes. A tool
/// event without a matcher is never called, so `*` is explicit.
///
/// `PreCompact` is deliberately absent: it fires before a compaction is known
/// to have happened, and the transcript's own `compact_boundary` record is the
/// honest signal.
pub const HOOK_EVENTS: &[(&str, Option<&str>)] = &[
    ("SessionStart", None),
    ("UserPromptSubmit", None),
    ("PermissionRequest", Some("*")),
    ("PreToolUse", Some("*")),
    ("PostToolUse", Some("*")),
    ("Notification", None),
    ("Stop", None),
    ("SubagentStop", None),
    ("SessionEnd", None),
];

/// How long the CLI waits for a hook. A permission card is answered by a
/// person, so that one is given the CLI's own default ceiling; the rest only
/// report and must never hold a turn up.
const PERMISSION_TIMEOUT_SECS: u64 = 600;
const REPORT_TIMEOUT_SECS: u64 = 10;
/// The app-side wait must match the CLI's, or a card would go on offering
/// buttons for a request the CLI has already given up on.
pub const PERMISSION_WAIT: Duration = Duration::from_secs(PERMISSION_TIMEOUT_SECS);

fn timeout_for(event: &str) -> u64 {
    if event == "PermissionRequest" {
        PERMISSION_TIMEOUT_SECS
    } else {
        REPORT_TIMEOUT_SECS
    }
}

/// The `--settings` payload: every hook runs this same binary as
/// `raccoon hook <Event>`, which forwards the hook's stdin over the socket.
///
/// Passing settings per launch rather than writing the reader's
/// `~/.claude/settings.json` means Raccoon never edits a file it does not own,
/// and a CLI started outside Raccoon is untouched.
pub fn settings_json(exe: &Path) -> Value {
    let mut hooks = serde_json::Map::new();
    for (event, matcher) in HOOK_EVENTS {
        let mut group = json!({ "hooks": [{
            "type": "command",
            "command": crate::hooks::hook_command(exe, event),
            "timeout": timeout_for(event),
        }]});
        if let Some(m) = matcher {
            group["matcher"] = json!(m);
        }
        hooks.insert((*event).to_string(), json!([group]));
    }
    json!({ "hooks": hooks })
}

pub struct LaunchOptions<'a> {
    pub provider_session_id: &'a str,
    /// True once the conversation exists; the CLI then picks the file up by id
    /// instead of being told to create one.
    pub resume: bool,
    /// A conversation to branch from, for a forked tab: the CLI reopens the
    /// parent and writes on under the id minted here.
    pub fork_from: Option<&'a str>,
    pub model: &'a str,
    pub effort: Option<&'a str>,
    pub permission_mode: &'a str,
    /// Shown in the CLI's own title and picker, so a tab is recognisable.
    pub title: Option<&'a str>,
    pub settings: &'a Value,
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The shell command line the pane runs. `Terminals::spawn` execs it from a
/// login shell, so it is one string rather than an argv.
pub fn launch_command(opts: LaunchOptions<'_>) -> Option<String> {
    let program = crate::binpath::resolve("claude")?;
    let mut c = quote(&program.to_string_lossy());
    match (opts.fork_from, opts.resume) {
        (Some(parent), _) => c.push_str(&format!(" --resume {} --fork-session --session-id {}", quote(parent), quote(opts.provider_session_id))),
        (None, true) => c.push_str(&format!(" --resume {}", quote(opts.provider_session_id))),
        (None, false) => c.push_str(&format!(" --session-id {}", quote(opts.provider_session_id))),
    }
    if !opts.model.is_empty() {
        c.push_str(&format!(" --model {}", quote(opts.model)));
    }
    if let Some(e) = opts.effort.filter(|e| !e.is_empty()) {
        c.push_str(&format!(" --effort {}", quote(e)));
    }
    c.push_str(&format!(" --permission-mode {}", super::normalize_mode(opts.permission_mode)));
    if let Some(t) = opts.title.filter(|t| !t.is_empty()) {
        c.push_str(&format!(" --name {}", quote(t)));
    }
    c.push_str(&format!(" --settings {}", quote(&opts.settings.to_string())));
    Some(c)
}

/// The reply a `PermissionRequest` hook prints. Its shape differs from
/// `PreToolUse`'s `permissionDecision`: this event carries a decision object,
/// and it ignores exit code 2, so a denial has to be said in JSON.
pub fn permission_decision(allow: bool, updated_input: Option<Value>, updated_permissions: Vec<Value>) -> Value {
    let decision = if allow {
        let mut d = json!({ "behavior": "allow" });
        if let Some(i) = updated_input {
            d["updatedInput"] = i;
        }
        if !updated_permissions.is_empty() {
            d["updatedPermissions"] = Value::Array(updated_permissions);
        }
        d
    } else {
        json!({ "behavior": "deny", "message": "The user declined this action." })
    };
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
}

// ------------------------------------------------------------------ keystrokes

/// Clears whatever is in the CLI's composer (Ctrl+U) before a prompt lands, so
/// a half-typed line in the terminal view is not glued to the front of it.
pub const CLEAR_LINE: &[u8] = b"\x15";
pub const BRACKETED_PASTE_START: &str = "\x1b[200~";
pub const BRACKETED_PASTE_END: &str = "\x1b[201~";
/// Interrupt: the TUI reads a bare Escape as "stop what you are doing".
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

/// A TUI drops keystrokes while it is still painting its first frame, and it
/// has no way to say when it is ready. The sign is that it has drawn something
/// and then stopped.
///
/// A second, not less: the CLI's startup here paints at 0.3 s, pauses 0.7 s,
/// paints again at 1.0 s and settles at 2.0 s, and a prompt typed into the gap
/// is swallowed without a trace. The timeout is the give-up, after which
/// typing anyway beats never sending.
pub const READY_QUIET: Duration = Duration::from_millis(1000);
pub const READY_TIMEOUT: Duration = Duration::from_secs(20);

/// An image the CLI should attach: the path, bracketed-pasted on its own. A
/// typed path is read as prose; only a paste becomes an attachment.
pub fn attachment_bytes(path: &str) -> Vec<u8> {
    format!("{BRACKETED_PASTE_START}{}{BRACKETED_PASTE_END}", path.replace('\u{1b}', "")).into_bytes()
}

// ------------------------------------------------------------------ transcript

/// Follows one transcript file. Polling is the authority: the CLI appends
/// without any signal the app could subscribe to, and a watch on a file that
/// may not exist yet is more machinery than a 200 ms stat.
pub struct Tail {
    path: std::sync::Mutex<PathBuf>,
    /// The cursor, held across polls. Also serialises the two callers — the
    /// poll thread and a `Stop` hook flushing before it closes the turn — so
    /// payloads are published in file order whichever gets there first.
    ///
    stream: std::sync::Mutex<Streamer>,
}

pub const POLL_INTERVAL: Duration = Duration::from_millis(200);

impl Tail {
    /// Follow from the file's length now: whatever it already holds is either
    /// history the app has logged or a conversation it is resuming. `carried`
    /// names records a fork will copy in later, which are history too.
    pub fn opening(path: PathBuf, carried: std::collections::HashSet<String>) -> Self {
        let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Self { path: std::sync::Mutex::new(path), stream: std::sync::Mutex::new(Streamer::skipping(len, carried)) }
    }

    /// Point at the file the CLI actually opened. Hooks carry
    /// `transcript_path`, which is authoritative; the path derived from the
    /// session id is only a guess made before the CLI had started.
    pub fn retarget(&self, path: &Path) {
        let mut current = self.path.lock().unwrap();
        if *current == path {
            return;
        }
        *current = path.to_path_buf();
        let len = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let mut stream = self.stream.lock().unwrap();
        *stream = Streamer::skipping(len, stream.carried().clone());
    }

    /// Read whatever has been appended since the last call.
    pub fn drain(&self) -> Vec<Payload> {
        use std::io::{Read, Seek, SeekFrom};

        let path = self.path.lock().unwrap().clone();
        let mut stream = self.stream.lock().unwrap();
        let Ok(meta) = std::fs::metadata(&path) else { return Vec::new() };
        let size = meta.len();
        let offset = stream.offset();
        if size == offset {
            return Vec::new();
        }
        if size < offset {
            // The CLI only appends, so a shorter file means it was replaced.
            // Skipping to the new end loses a little; replaying from zero
            // would duplicate the whole conversation in the log.
            log::warn!("transcript {} shrank; skipping to its end", path.display());
            *stream = Streamer::skipping(size, stream.carried().clone());
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

    #[test]
    fn settings_point_every_hook_at_this_binary() {
        let v = settings_json(Path::new("/opt/raccoon"));
        let hooks = v["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), HOOK_EVENTS.len());
        for (event, matcher) in HOOK_EVENTS {
            let group = &hooks[*event][0];
            assert_eq!(group["matcher"].as_str(), *matcher);
            let h = &group["hooks"][0];
            assert_eq!(h["type"], "command");
            assert_eq!(h["command"], format!("'/opt/raccoon' hook {event}"));
        }
        // A person answers the permission card; the rest only report.
        assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["timeout"], 600);
        assert_eq!(hooks["Stop"][0]["hooks"][0]["timeout"], 10);
    }

    #[test]
    fn permission_replies_carry_the_events_own_decision_shape() {
        let allow = permission_decision(true, Some(json!({"command": "ls"})), vec![json!({"type": "addRules"})]);
        let d = &allow["hookSpecificOutput"];
        assert_eq!(d["hookEventName"], "PermissionRequest");
        assert_eq!(d["decision"]["behavior"], "allow");
        assert_eq!(d["decision"]["updatedInput"]["command"], "ls");
        assert_eq!(d["decision"]["updatedPermissions"][0]["type"], "addRules");
        let deny = permission_decision(false, None, vec![]);
        assert_eq!(deny["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert!(deny["hookSpecificOutput"]["decision"]["message"].is_string());
    }

    #[test]
    fn a_new_tab_names_its_session_and_a_resumed_one_reopens_it() {
        if crate::binpath::resolve("claude").is_none() {
            return;
        }
        let settings = json!({});
        let fresh = launch_command(LaunchOptions {
            provider_session_id: "abc",
            resume: false,
            fork_from: None,
            model: "opus",
            effort: Some("high"),
            permission_mode: "ask",
            title: Some("fix login"),
            settings: &settings,
        })
        .unwrap();
        assert!(fresh.contains("--session-id 'abc'"));
        assert!(fresh.contains("--model 'opus'"));
        assert!(fresh.contains("--effort 'high'"));
        assert!(fresh.contains("--permission-mode manual"));
        assert!(fresh.contains("--name 'fix login'"));
        assert!(fresh.contains("--settings '{}'"));

        let back = launch_command(LaunchOptions {
            provider_session_id: "abc",
            resume: true,
            fork_from: None,
            model: "",
            effort: None,
            permission_mode: "plan",
            title: None,
            settings: &settings,
        })
        .unwrap();
        assert!(back.contains("--resume 'abc'"));
        assert!(!back.contains("--model"));
        assert!(back.contains("--permission-mode plan"));

        let forked = launch_command(LaunchOptions {
            provider_session_id: "new",
            resume: false,
            fork_from: Some("parent"),
            model: "",
            effort: None,
            permission_mode: "auto",
            title: None,
            settings: &settings,
        })
        .unwrap();
        assert!(forked.contains("--resume 'parent' --fork-session --session-id 'new'"));
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
        std::fs::write(&path, "{\"type\":\"user\",\"message\":{\"content\":\"old\"}}\n").unwrap();
        let tail = Tail::opening(path.clone(), Default::default());
        assert!(tail.drain().is_empty());

        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        use std::io::Write;
        // A record split across two appends is only decoded once complete.
        f.write_all(b"{\"type\":\"user\",\"message\":{\"content\":\"new\"}").unwrap();
        assert!(tail.drain().is_empty());
        f.write_all(b"}\n").unwrap();
        let p = tail.drain();
        assert_eq!(p.len(), 1);
        assert!(matches!(&p[0], Payload::UserMessage { text, .. } if text == "new"));
        assert!(tail.drain().is_empty());
    }

    #[test]
    fn retargeting_follows_the_file_the_cli_actually_opened() {
        let dir = tempfile::tempdir().unwrap();
        let guessed = dir.path().join("guess.jsonl");
        let real = dir.path().join("real.jsonl");
        std::fs::write(&guessed, "").unwrap();
        std::fs::write(&real, "{\"type\":\"user\",\"message\":{\"content\":\"before\"}}\n").unwrap();
        let tail = Tail::opening(guessed, Default::default());
        tail.retarget(&real);
        // What the file already held is history, not something to replay.
        assert!(tail.drain().is_empty());
        let mut f = std::fs::OpenOptions::new().append(true).open(&real).unwrap();
        use std::io::Write;
        f.write_all(b"{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n").unwrap();
        assert!(matches!(&tail.drain()[0], Payload::AssistantText { text, .. } if text == "hi"));
    }
}
