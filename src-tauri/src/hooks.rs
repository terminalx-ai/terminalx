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
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Env var naming the socket, set on the CLI's PTY and inherited by hooks.
pub const SOCKET_ENV: &str = "RACCOON_HOOK_SOCKET";
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
    /// `PreToolUse`, `Stop`, … exactly as the CLI names it.
    pub event: String,
    /// The hook's stdin JSON, verbatim.
    pub payload: Value,
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
        let c = hook_command(Path::new("/Applications/Raccoon.app/Contents/MacOS/raccoon"), "PreToolUse");
        assert_eq!(c, "'/Applications/Raccoon.app/Contents/MacOS/raccoon' hook PreToolUse");
        // A quote in the path would otherwise end the quoting early.
        let c = hook_command(Path::new("/tmp/it's here/raccoon"), "Stop");
        assert_eq!(c, r#"'/tmp/it'\''s here/raccoon' hook Stop"#);
    }

    #[test]
    fn frames_and_replies_round_trip_as_one_line_each() {
        let f = HookFrame { tab: "t1".into(), session: "s1".into(), event: "PreToolUse".into(), payload: json!({"tool_name": "Bash"}) };
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
        let frame = HookFrame { tab: "t".into(), session: "s".into(), event: "Stop".into(), payload: Value::Null };
        client.write_all(format!("{}\n", serde_json::to_string(&frame).unwrap()).as_bytes()).unwrap();
        let mut line = String::new();
        BufReader::new(client).read_line(&mut line).unwrap();
        let reply: HookReply = serde_json::from_str(&line).unwrap();
        assert_eq!(reply.output.unwrap()["saw"], "Stop");
    }
}
