//! The hook bridge.
//!
//! A PTY-first agent tab runs the real CLI, so the app cannot see the wire:
//! what it needs to know — a prompt was submitted, a tool wants permission,
//! the turn ended — comes from the CLI's own hooks. Every hook command is
//! *this binary* invoked as `raccoon hook <Event>`; it reads the hook payload
//! from stdin, hands it to the running app over a unix socket, waits for a
//! reply, prints whatever the app wants the CLI to see, and exits 0.
//!
//! Two rules keep the CLI safe from us:
//! - the hook never blocks forever (a bounded read timeout), and
//! - anything that goes wrong — no socket, no app, bad frame — exits 0 with
//!   empty output, which the CLI reads as "this hook had nothing to say".

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Env var naming the socket, set on the CLI's PTY and inherited by hooks.
pub const SOCKET_ENV: &str = "RACCOON_HOOK_SOCKET";
/// Env var carrying the secret minted for one CLI launch. The socket is
/// owner-only, but every process this user runs is that owner — including the
/// agent's own children, which are handed the socket path. The token is what
/// says a frame came from the CLI a tab started rather than from something
/// that merely read the environment of one.
pub const TOKEN_ENV: &str = "RACCOON_HOOK_TOKEN";
/// How long a hook waits for the app. A permission card is answered by a
/// person, so this has to outlast a moment's thought without outlasting the
/// CLI's own hook timeout.
const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

/// One hook occurrence, as the hook process sends it to the app.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HookFrame {
    /// The tab whose CLI fired the hook, from `RACCOON_TAB_ID`.
    pub tab: String,
    pub session: String,
    /// The secret this launch's CLI was given, from `RACCOON_HOOK_TOKEN`.
    /// A frame without it is not from that CLI. Defaulted so a frame from an
    /// older build parses and is then refused for an empty token, rather than
    /// failing to parse and being refused for the wrong reason.
    #[serde(default)]
    pub token: String,
    /// `PreToolUse`, `Stop`, … exactly as the CLI names it.
    pub event: String,
    /// The hook's stdin JSON, verbatim.
    pub payload: Value,
}

/// A tab's standing instructions for the frames its own CLI sends: the secret
/// handed to that launch, and the one directory that launch could be writing
/// its transcript into.
#[derive(Debug, Clone)]
pub struct Origin {
    pub token: String,
    /// Claude: `~/.claude/projects/<encoded cwd>`. Codex: the managed
    /// `$RACCOON_HOME/codex/sessions`.
    pub transcript_root: PathBuf,
}

impl Origin {
    /// Whether the frame came from the process this tab started.
    pub fn accepts(&self, frame: &HookFrame) -> bool {
        token_matches(&self.token, &frame.token)
    }

    /// The transcript the frame names, when it is one this tab's CLI could
    /// have opened. Anything else is read as if the frame had named no file
    /// at all: the tail stays where it is rather than following a frame to
    /// some other reader's private notes.
    pub fn transcript<'f>(&self, frame: &'f HookFrame) -> Option<&'f Path> {
        let named = Path::new(frame.payload["transcript_path"].as_str()?);
        under_root(&self.transcript_root, named).then_some(named)
    }
}

/// A secret for one CLI launch. Two v4 UUIDs is 244 bits from the platform's
/// CSPRNG, which is what `uuid` draws them from.
pub fn mint_token() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

/// Equality that takes the same time whatever the mismatch, so a token cannot
/// be found a byte at a time. An unset expectation matches nothing.
pub fn token_matches(expected: &str, given: &str) -> bool {
    let (a, b) = (expected.as_bytes(), given.as_bytes());
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Whether `candidate` names a file inside `root`.
///
/// The file is often one the CLI has yet to create, so there is nothing to
/// canonicalise and the first answer is lexical; `..` is refused outright
/// rather than resolved. A symlink on the way to either — `/tmp` under
/// `/private` on macOS is the usual one — would fail that lexical check for a
/// path that really is inside the root, so a second answer resolves as much
/// of both as exists on disk.
pub fn under_root(root: &Path, candidate: &Path) -> bool {
    if !candidate.is_absolute() || candidate.components().any(|c| c == Component::ParentDir) {
        return false;
    }
    if lexically_under(root, candidate) {
        return true;
    }
    match (root.canonicalize(), resolve_existing(candidate)) {
        (Ok(root), Some(candidate)) => lexically_under(&root, &candidate),
        _ => false,
    }
}

fn lexically_under(root: &Path, candidate: &Path) -> bool {
    let tidy = |p: &Path| p.components().filter(|c| *c != Component::CurDir).collect::<PathBuf>();
    let (root, candidate) = (tidy(root), tidy(candidate));
    candidate != root && candidate.starts_with(&root)
}

/// The deepest ancestor that exists, canonicalised, with the rest put back on.
fn resolve_existing(path: &Path) -> Option<PathBuf> {
    let mut tail = Vec::new();
    let mut here = path;
    loop {
        if let Ok(real) = here.canonicalize() {
            return Some(tail.iter().rev().fold(real, |acc, part| acc.join(part)));
        }
        tail.push(here.file_name()?.to_owned());
        here = here.parent()?;
    }
}

/// What the app wants the hook to print. `None` prints nothing, which leaves
/// the CLI's own behaviour untouched.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct HookReply {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<Value>,
}

/// Where this app instance listens. One socket per Raccoon home, so a second
/// instance on the same home takes the socket over rather than racing for it.
pub fn socket_path() -> anyhow::Result<PathBuf> {
    Ok(crate::store::ensure_dir(crate::store::root()?.join("run"))?.join("hooks.sock"))
}

/// The command a hook definition runs: this binary, quoted, plus the event.
/// `current_exe` is right for `cargo run` and for the bundle alike.
pub fn hook_command(exe: &Path, event: &str) -> String {
    let quoted = format!("'{}'", exe.to_string_lossy().replace('\'', "'\\''"));
    format!("{quoted} hook {event}")
}

// ---------------------------------------------------------------- the app end

#[cfg(unix)]
pub fn serve<F>(handler: F) -> anyhow::Result<PathBuf>
where
    F: Fn(HookFrame) -> HookReply + Send + Sync + 'static,
{
    use std::os::unix::net::UnixListener;

    let path = socket_path()?;
    // A socket file left by a crashed instance would refuse every bind.
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    let handler = std::sync::Arc::new(handler);
    std::thread::Builder::new().name("hook-socket".into()).spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let handler = handler.clone();
            // One thread per hook: a permission frame parks until it is
            // answered, and the next hook must not queue behind it.
            let _ = std::thread::Builder::new().name("hook-frame".into()).spawn(move || {
                let mut reader = BufReader::new(match stream.try_clone() {
                    Ok(s) => s,
                    Err(_) => return,
                });
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                    return;
                }
                let reply = match serde_json::from_str::<HookFrame>(&line) {
                    Ok(frame) => handler(frame),
                    Err(e) => {
                        log::warn!("hook frame: {e}");
                        HookReply::default()
                    }
                };
                let mut stream = stream;
                if let Ok(mut bytes) = serde_json::to_vec(&reply) {
                    bytes.push(b'\n');
                    let _ = stream.write_all(&bytes);
                    let _ = stream.flush();
                }
            });
        }
    })?;
    Ok(path)
}

#[cfg(not(unix))]
pub fn serve<F>(_handler: F) -> anyhow::Result<PathBuf>
where
    F: Fn(HookFrame) -> HookReply + Send + Sync + 'static,
{
    anyhow::bail!("hooks need a unix socket")
}

// ------------------------------------------------------------- the hook end

/// The `hook` subcommand. Returns false when this process is the app itself.
pub fn run_hook_cli() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("hook") {
        return false;
    }
    let event = args.next().unwrap_or_default();
    // Read stdin first, always: the CLI closes the pipe once the hook has
    // taken it, and exiting mid-write surfaces to the CLI as a broken pipe.
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);
    // Never nothing: a permission hook that prints an empty stdout is read as
    // a refusal, so silence has to be spelt out as an empty object.
    let out = ask_app(&event, &stdin).unwrap_or_else(|| serde_json::json!({}));
    let _ = std::io::stdout().write_all(out.to_string().as_bytes());
    let _ = std::io::stdout().write_all(b"\n");
    true
}

/// Send one frame and wait for the reply. `None` on any failure, so the CLI
/// carries on exactly as it would with no hook installed.
#[cfg(unix)]
fn ask_app(event: &str, stdin: &str) -> Option<Value> {
    use std::os::unix::net::UnixStream;

    let payload: Value = serde_json::from_str(stdin).unwrap_or(Value::Null);
    let frame = HookFrame {
        tab: std::env::var("RACCOON_TAB_ID").ok()?,
        session: std::env::var("RACCOON_SESSION_ID").unwrap_or_default(),
        token: std::env::var(TOKEN_ENV).unwrap_or_default(),
        event: if event.is_empty() { payload["hook_event_name"].as_str().unwrap_or_default().to_string() } else { event.to_string() },
        payload,
    };
    let path = std::env::var(SOCKET_ENV).ok()?;
    let mut stream = UnixStream::connect(path).ok()?;
    stream.set_read_timeout(Some(REPLY_TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut bytes = serde_json::to_vec(&frame).ok()?;
    bytes.push(b'\n');
    stream.write_all(&bytes).ok()?;
    stream.flush().ok()?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).ok()?;
    serde_json::from_str::<HookReply>(&line).ok()?.output
}

#[cfg(not(unix))]
fn ask_app(_event: &str, _stdin: &str) -> Option<Value> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_hook_command_is_this_binary_with_the_event() {
        let c = hook_command(Path::new("/Applications/TerminalX Next.app/Contents/MacOS/raccoon"), "PreToolUse");
        assert_eq!(c, "'/Applications/TerminalX Next.app/Contents/MacOS/raccoon' hook PreToolUse");
        // A quote in the path would otherwise end the quoting early.
        let c = hook_command(Path::new("/tmp/it's here/raccoon"), "Stop");
        assert_eq!(c, r#"'/tmp/it'\''s here/raccoon' hook Stop"#);
    }

    #[test]
    fn frames_and_replies_round_trip_as_one_line_each() {
        let f = HookFrame { tab: "t1".into(), session: "s1".into(), token: "tok".into(), event: "PreToolUse".into(), payload: json!({"tool_name": "Bash"}) };
        let line = serde_json::to_string(&f).unwrap();
        assert!(!line.contains('\n'));
        assert_eq!(serde_json::from_str::<HookFrame>(&line).unwrap(), f);

        let empty = serde_json::to_string(&HookReply::default()).unwrap();
        assert_eq!(empty, "{}");
        let r = HookReply { output: Some(json!({"decision": "approve"})) };
        assert_eq!(serde_json::from_str::<HookReply>(&serde_json::to_string(&r).unwrap()).unwrap(), r);
    }

    #[cfg(unix)]
    #[test]
    fn a_served_frame_gets_the_handler_s_reply() {
        use std::os::unix::net::{UnixListener, UnixStream};

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("h.sock");
        let listener = UnixListener::bind(&path).unwrap();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let frame: HookFrame = serde_json::from_str(&line).unwrap();
            let reply = HookReply { output: Some(json!({"saw": frame.event})) };
            let mut stream = stream;
            stream.write_all(format!("{}\n", serde_json::to_string(&reply).unwrap()).as_bytes()).unwrap();
        });

        let mut client = UnixStream::connect(&path).unwrap();
        let frame = HookFrame { tab: "t".into(), session: "s".into(), token: "tok".into(), event: "Stop".into(), payload: Value::Null };
        client.write_all(format!("{}\n", serde_json::to_string(&frame).unwrap()).as_bytes()).unwrap();
        let mut line = String::new();
        BufReader::new(client).read_line(&mut line).unwrap();
        let reply: HookReply = serde_json::from_str(&line).unwrap();
        assert_eq!(reply.output.unwrap()["saw"], "Stop");
    }

    fn frame(token: &str, transcript: &str) -> HookFrame {
        HookFrame {
            tab: "t".into(),
            session: "s".into(),
            token: token.into(),
            event: "SessionStart".into(),
            payload: json!({"transcript_path": transcript}),
        }
    }

    #[test]
    fn only_the_token_this_launch_was_given_is_this_tab_s() {
        let origin = Origin { token: mint_token(), transcript_root: PathBuf::from("/nowhere") };
        assert!(origin.accepts(&frame(&origin.token, "")));
        assert!(!origin.accepts(&frame(&mint_token(), "")), "another tab's token is not this tab's");
        assert!(!origin.accepts(&frame("", "")), "a frame from a build with no token is refused");
        // Same length, one byte out: the compare is not a prefix compare.
        let mut nearly = origin.token.clone();
        nearly.pop();
        nearly.push(if origin.token.ends_with('f') { '0' } else { 'f' });
        assert!(!origin.accepts(&frame(&nearly, "")));

        // A tab that never got a token accepts nothing, empty frames included.
        let unset = Origin { token: String::new(), transcript_root: PathBuf::from("/nowhere") };
        assert!(!unset.accepts(&frame("", "")));
    }

    #[test]
    fn a_frame_can_only_retarget_the_tail_inside_this_tab_s_own_directory() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".claude/projects/-Users-me-work");
        std::fs::create_dir_all(&root).unwrap();
        let origin = Origin { token: mint_token(), transcript_root: root.clone() };

        // The file the CLI opened, which it has yet to create.
        let mine = root.join("2f1c.jsonl");
        assert_eq!(origin.transcript(&frame("", mine.to_str().unwrap())), Some(mine.as_path()));

        // Another project's transcript, the reader's ssh key, a traversal out
        // of the root, and a relative path are all read as naming nothing.
        for outside in [
            home.path().join(".claude/projects/-Users-me-secrets/a.jsonl"),
            home.path().join(".ssh/id_ed25519"),
            root.join("../-Users-me-secrets/a.jsonl"),
            PathBuf::from("relative.jsonl"),
        ] {
            assert_eq!(origin.transcript(&frame("", outside.to_str().unwrap())), None, "{}", outside.display());
        }
        // The root itself is a directory, not a transcript.
        assert_eq!(origin.transcript(&frame("", root.to_str().unwrap())), None);
        // A frame that names no file at all leaves the tail alone.
        assert_eq!(origin.transcript(&HookFrame { payload: json!({}), ..frame("", "") }), None);
    }

    #[test]
    fn a_symlinked_root_still_holds_its_own_transcripts() {
        // `$RACCOON_HOME` under /tmp is /private/tmp once resolved, so the
        // path Codex reports would fail a purely lexical check.
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real/sessions");
        std::fs::create_dir_all(&real).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(dir.path().join("real"), &link).unwrap();

        let origin = Origin { token: mint_token(), transcript_root: link.join("sessions") };
        let named = real.join("2026/09/rollout.jsonl");
        assert_eq!(origin.transcript(&frame("", named.to_str().unwrap())), Some(named.as_path()));
        let elsewhere = dir.path().join("real/elsewhere.jsonl");
        assert_eq!(origin.transcript(&frame("", elsewhere.to_str().unwrap())), None);
    }
}
