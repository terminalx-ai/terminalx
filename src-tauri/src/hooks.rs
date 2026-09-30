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

use std::io::{Read, Write};
#[cfg(unix)]
use std::io::{BufRead, BufReader};
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
/// The control socket and per-launch app token injected into agent tabs. The
/// socket path is shared with hooks; the token authenticates command requests.
pub const CONTROL_SOCKET_ENV: &str = "TERMINALX_NEXT_SOCKET";
pub const CONTROL_TOKEN_ENV: &str = "TERMINALX_NEXT_TOKEN";
/// How long a reporting hook waits for the app. The CLI kills those after its
/// own short timeout anyway; this only bounds a hook whose app has hung.
const REPLY_TIMEOUT: Duration = Duration::from_secs(30);
/// Beyond the app's own wait for a decision, so the app's answer — or its
/// "lapsed" — is always what the hook prints.
const DECISION_SLACK: Duration = Duration::from_secs(15);

/// How long the hook for `event` waits for the app's reply.
///
/// A decision is made by a person, possibly on another device through the
/// relay and a polled mailbox, so its hook has to wait as long as the app
/// keeps the card open. It used to give up after 30 s like any other hook: a
/// slower click then printed nothing, the CLI fell back to its own TUI prompt
/// that nobody could see, and the app went on to show "Allowed" for an answer
/// that had nowhere left to go — the tool never ran. The CLI's own timeout for
/// these hooks (`PERMISSION_WAIT`) still ends a hook the app never answers.
fn reply_timeout(event: &str) -> Duration {
    match event {
        // Claude's permission gate and both of Codex's.
        "PermissionRequest" | "PreToolUse" => {
            crate::harness::claude::pty::PERMISSION_WAIT.max(crate::harness::codex::pty::PERMISSION_WAIT) + DECISION_SLACK
        }
        _ => REPLY_TIMEOUT,
    }
}

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
    /// `$TERMINALX_HOME/codex/sessions`.
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

/// One app launch's authenticated control endpoint. Clones stay inside the
/// app and are used only to configure the listener and child environments.
#[derive(Clone)]
pub struct ControlEndpoint {
    /// Where this launch listens, and what its tabs are told to dial.
    pub socket: PathBuf,
    pub token: String,
    /// Held while this launch is the one a shell reaches through the home's
    /// published socket and `run/control.token`. `None` when another live
    /// launch already holds the home: this one then listens on a socket of
    /// its own and publishes nothing, so it cannot cut that launch's tabs off.
    claim: Option<std::sync::Arc<std::fs::File>>,
}

impl ControlEndpoint {
    /// Whether this launch owns the home's published socket and token.
    pub fn publishes(&self) -> bool {
        self.claim.is_some()
    }
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
    /// Why the app would not act on the frame. The hook still prints nothing
    /// for the CLI to act on; it writes this to its stderr, which the CLI
    /// keeps in its hook log, so a frame lost to the wrong app or a stale
    /// launch is visible where it happened, not only in the app's log.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

impl HookReply {
    pub fn refused(reason: impl Into<String>) -> Self {
        Self { output: None, refused: Some(reason.into()) }
    }
}

/// The home's published socket: where a shell with no app environment finds
/// whichever launch holds the home. Agent tabs are told their own launch's
/// socket instead (`ControlEndpoint::socket`), so they never depend on which
/// launch that is.
pub fn socket_path() -> anyhow::Result<PathBuf> {
    #[cfg(unix)]
    { Ok(run_dir()?.join("hooks.sock")) }
    #[cfg(windows)]
    { Ok(crate::pipe_transport::path_for_home(&crate::store::root()?)) }
}

/// The socket a launch listens on while another launch holds the home.
fn own_socket_path(pid: u32) -> anyhow::Result<PathBuf> {
    #[cfg(unix)]
    { Ok(run_dir()?.join(format!("hooks-{pid}.sock"))) }
    #[cfg(windows)]
    {
        let shared = crate::pipe_transport::path_for_home(&crate::store::root()?);
        Ok(PathBuf::from(format!("{}-{pid}", shared.display())))
    }
}

fn run_dir() -> anyhow::Result<PathBuf> {
    crate::store::ensure_dir(crate::store::root()?.join("run"))
}

pub fn control_token_path() -> anyhow::Result<PathBuf> {
    Ok(run_dir()?.join("control.token"))
}

/// Decide where this launch listens and mint its token, before any agent
/// process is launched.
///
/// The installed app and a dev build both default to `~/.raccoon`, so two
/// launches on one home is ordinary. The first to take `run/hooks.lock` owns
/// the published socket and token; the lock is the OS's, so a crashed owner
/// releases it without anyone deciding the owner is dead. A launch that finds
/// it held gets a socket of its own. It used to delete the owner's socket and
/// overwrite its token, and every hook from the owner's tabs then reached an
/// app that did not know them: the Terminal view kept streaming while the
/// Chat view never saw a reply (#202).
pub fn prepare_control() -> anyhow::Result<ControlEndpoint> {
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(run_dir()?.join("hooks.lock"))?;
    let claim = match lock.try_lock() {
        Ok(()) => Some(std::sync::Arc::new(lock)),
        Err(std::fs::TryLockError::WouldBlock) => None,
        Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
    };
    let socket = if claim.is_some() { socket_path()? } else { own_socket_path(std::process::id())? };
    #[cfg(unix)]
    sweep_stale_sockets(&socket);
    Ok(ControlEndpoint { socket, token: mint_token(), claim })
}

/// Remove `hooks-<pid>.sock` files that no launch answers any more, so a
/// crashed second launch does not leave its socket behind for good.
#[cfg(unix)]
fn sweep_stale_sockets(keep: &Path) {
    let Ok(dir) = run_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path == keep || !(name.starts_with("hooks-") && name.ends_with(".sock")) {
            continue;
        }
        if let Err(error) = std::os::unix::net::UnixStream::connect(&path) {
            if error.kind() == std::io::ErrorKind::ConnectionRefused {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

/// The command a hook definition runs: this binary, quoted, plus the event.
/// `current_exe` is right for `cargo run` and for the bundle alike.
pub fn hook_command(exe: &Path, event: &str) -> String {
    let quoted = format!("'{}'", exe.to_string_lossy().replace('\'', "'\\''"));
    format!("{quoted} hook {event}")
}

/// The status-line command is the same authenticated forwarder, but it prints
/// no line back into the TUI.
pub fn statusline_command(exe: &Path) -> String {
    let quoted = format!("'{}'", exe.to_string_lossy().replace('\'', "'\\''"));
    format!("{quoted} statusline")
}

// ---------------------------------------------------------------- the app end

#[cfg(unix)]
pub fn serve<F, C>(endpoint: ControlEndpoint, hook_handler: F, control_handler: C) -> anyhow::Result<PathBuf>
where
    F: Fn(HookFrame) -> HookReply + Send + Sync + 'static,
    C: Fn(crate::control::ControlRequest) -> crate::control::ControlResponse + Send + Sync + 'static,
{
    use std::os::unix::net::UnixListener;

    let path = endpoint.socket.clone();
    // Whatever file is at this path belongs to no live launch: the published
    // socket is ours while we hold the home's lock, and a per-launch one is
    // named for this process. Left behind by a crash, it would refuse the bind.
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    // Only once the socket answers, and only by the launch that holds the
    // home: a shell that reads the token must find the app it belongs to.
    if endpoint.publishes() {
        crate::store::write_atomic(&control_token_path()?, endpoint.token.as_bytes())?;
    } else {
        log::warn!(
            "another TerminalX already uses {}; this launch's tabs use {} and shells without an app environment reach the other launch",
            crate::store::root()?.display(),
            path.display()
        );
    }
    let hook_handler = std::sync::Arc::new(hook_handler);
    let control_handler = std::sync::Arc::new(control_handler);
    let control_token = endpoint.token;
    // The listener keeps the home for as long as it listens, whatever the
    // caller does with its own copies of the endpoint.
    let claim = endpoint.claim;
    std::thread::Builder::new().name("hook-socket".into()).spawn(move || {
        let _claim = claim;
        for stream in listener.incoming() {
            let Ok(stream) = stream else { continue };
            let hook_handler = hook_handler.clone();
            let control_handler = control_handler.clone();
            let control_token = control_token.clone();
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
                let reply = dispatch_line(&line, &control_token, &*hook_handler, &*control_handler);
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

#[cfg(windows)]
pub fn serve<F, C>(endpoint: ControlEndpoint, hook_handler: F, control_handler: C) -> anyhow::Result<PathBuf>
where
    F: Fn(HookFrame) -> HookReply + Send + Sync + 'static,
    C: Fn(crate::control::ControlRequest) -> crate::control::ControlResponse + Send + Sync + 'static,
{
    let path = endpoint.socket.clone();
    let token = endpoint.token.clone();
    let publishes = endpoint.publishes();
    crate::pipe_transport::serve(path.clone(), move |line| {
        let reply = dispatch_line(&line, &endpoint.token, &hook_handler, &control_handler);
        format!("{reply}\n")
    })?;
    // Publish only after successfully owning the pipe, and only from the
    // launch that holds the home: a second app using the same home must not
    // replace the running instance's discovery token.
    if publishes {
        crate::store::write_atomic(&control_token_path()?, token.as_bytes())?;
    } else {
        log::warn!("another TerminalX already uses {}; this launch's tabs use {}", crate::store::root()?.display(), path.display());
    }
    Ok(path)
}

fn dispatch_line<F, C>(line: &str, control_token: &str, hook_handler: &F, control_handler: &C) -> Value
where
    F: Fn(HookFrame) -> HookReply + ?Sized,
    C: Fn(crate::control::ControlRequest) -> crate::control::ControlResponse + ?Sized,
{
    let value: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(error) => {
            log::warn!("socket frame: {error}");
            return serde_json::to_value(HookReply::default()).unwrap_or_default();
        }
    };
    if value.get("command").is_some() {
        let request_id = value.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
        let request: crate::control::ControlRequest = match serde_json::from_value(value) {
            Ok(request) => request,
            Err(error) => {
                let response = crate::control::ControlResponse::failure(
                    request_id,
                    crate::control::ControlError::new(
                        "protocol_error",
                        format!("Invalid control request: {error}"),
                        Some("Update the app and CLI together, then retry status.".into()),
                    ),
                );
                return serde_json::to_value(response).unwrap_or_default();
            }
        };
        if !token_matches(control_token, &request.token) {
            let response = crate::control::ControlResponse::failure(
                request.id,
                crate::control::ControlError::new(
                    "unauthorized",
                    "The control token is missing or does not match this app launch.",
                    Some("Restart an app-launched tab, or let a human shell read TERMINALX_HOME/run/control.token.".into()),
                ),
            );
            return serde_json::to_value(response).unwrap_or_default();
        }
        serde_json::to_value(control_handler(request)).unwrap_or_default()
    } else {
        match serde_json::from_value::<HookFrame>(value) {
            Ok(frame) => serde_json::to_value(hook_handler(frame)).unwrap_or_default(),
            Err(error) => {
                log::warn!("hook frame: {error}");
                serde_json::to_value(HookReply::default()).unwrap_or_default()
            }
        }
    }
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

/// The `statusline` subcommand. Claude sends its ordinary status JSON on
/// stdin; the app takes only `rate_limits`, and silence keeps the CLI's own
/// terminal view free of a second status line.
pub fn run_statusline_cli() -> bool {
    if std::env::args().nth(1).as_deref() != Some("statusline") {
        return false;
    }
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);
    if let Ok(mut payload) = serde_json::from_str::<Value>(&stdin) {
        if let Some(object) = payload.as_object_mut() {
            object.insert("_raccoon_usage_account".into(), serde_json::json!(crate::status::usage::claude_account_identity()));
            let _ = ask_app("StatusLine", &payload.to_string());
        }
    }
    true
}

/// Send one frame and wait for the reply. `None` on any failure, so the CLI
/// carries on exactly as it would with no hook installed.
fn ask_app(event: &str, stdin: &str) -> Option<Value> {
    #[cfg(unix)]
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
    let timeout = reply_timeout(&frame.event);
    let mut bytes = serde_json::to_vec(&frame).ok()?;
    bytes.push(b'\n');
    #[cfg(unix)]
    let line = {
        let mut stream = UnixStream::connect(&path).ok()?;
        stream.set_read_timeout(Some(timeout)).ok()?;
        stream.set_write_timeout(Some(Duration::from_secs(5))).ok()?;
        stream.write_all(&bytes).ok()?;
        stream.flush().ok()?;
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).ok()?;
        line
    };
    #[cfg(windows)]
    let line = crate::pipe_transport::exchange(Path::new(&path), bytes, timeout).ok()?;
    let reply = serde_json::from_str::<HookReply>(&line).ok()?;
    if let Some(reason) = &reply.refused {
        let _ = writeln!(std::io::stderr(), "TerminalX at {path} refused hook {}: {reason}", frame.event);
    }
    reply.output
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_hook_command_is_this_binary_with_the_event() {
        let c = hook_command(Path::new("/Applications/TerminalX.app/Contents/MacOS/raccoon"), "PreToolUse");
        assert_eq!(c, "'/Applications/TerminalX.app/Contents/MacOS/raccoon' hook PreToolUse");
        // A quote in the path would otherwise end the quoting early.
        let c = hook_command(Path::new("/tmp/it's here/raccoon"), "Stop");
        assert_eq!(c, r#"'/tmp/it'\''s here/raccoon' hook Stop"#);
        assert_eq!(statusline_command(Path::new("/opt/raccoon")), "'/opt/raccoon' statusline");
    }

    #[cfg(windows)]
    #[test]
    fn named_pipe_serves_authenticated_control_and_hook_frames() {
        let _home = crate::store::temp_home();
        let endpoint = prepare_control().unwrap();
        serve(endpoint.clone(), |frame| HookReply { output: Some(json!({"event": frame.event})), refused: None },
            |request| crate::control::ControlResponse::success(request.id, json!({"called": request.command}))).unwrap();
        let response = crate::control::call("status", json!({}), Duration::from_secs(2)).unwrap();
        assert!(response.ok);
        assert_eq!(response.result.unwrap()["called"], "status");
        let bad = json!({"id": "bad", "command": "status", "token": "wrong"});
        let response = crate::pipe_transport::exchange(&endpoint.socket, format!("{bad}\n").into_bytes(), Duration::from_secs(2)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&response).unwrap()["error"]["code"], "unauthorized");
        let hook = HookFrame { tab: "t".into(), session: "s".into(), token: "token".into(), event: "Stop".into(), payload: Value::Null };
        let response = crate::pipe_transport::exchange(&endpoint.socket, format!("{}\n", serde_json::to_string(&hook).unwrap()).into_bytes(), Duration::from_secs(2)).unwrap();
        assert_eq!(serde_json::from_str::<HookReply>(&response).unwrap().output.unwrap()["event"], "Stop");
    }

    #[test]
    fn a_decision_hook_waits_as_long_as_the_app_keeps_the_card_open() {
        // The app parks a permission card for PERMISSION_WAIT; a hook that
        // stopped listening sooner would drop the reader's answer on the floor.
        for event in ["PermissionRequest", "PreToolUse"] {
            assert!(reply_timeout(event) > crate::harness::claude::pty::PERMISSION_WAIT, "{event}");
            assert!(reply_timeout(event) > crate::harness::codex::pty::PERMISSION_WAIT, "{event}");
        }
        // Reporting hooks keep the short bound.
        for event in ["SessionStart", "Stop", "PostToolUse", "Notification", "StatusLine"] {
            assert_eq!(reply_timeout(event), REPLY_TIMEOUT, "{event}");
        }
    }

    #[test]
    fn frames_and_replies_round_trip_as_one_line_each() {
        let f = HookFrame { tab: "t1".into(), session: "s1".into(), token: "tok".into(), event: "PreToolUse".into(), payload: json!({"tool_name": "Bash"}) };
        let line = serde_json::to_string(&f).unwrap();
        assert!(!line.contains('\n'));
        assert_eq!(serde_json::from_str::<HookFrame>(&line).unwrap(), f);

        let empty = serde_json::to_string(&HookReply::default()).unwrap();
        assert_eq!(empty, "{}");
        let r = HookReply { output: Some(json!({"decision": "approve"})), refused: None };
        assert_eq!(serde_json::from_str::<HookReply>(&serde_json::to_string(&r).unwrap()).unwrap(), r);
    }

    #[test]
    fn control_frames_require_the_current_launch_token() {
        use crate::control::{ControlRequest, ControlResponse};

        let request = ControlRequest {
            id: "r1".into(),
            token: "wrong".into(),
            command: "status".into(),
            params: json!({}),
        };
        let line = serde_json::to_string(&request).unwrap();
        let reply = dispatch_line(
            &line,
            "right",
            &|_| HookReply::default(),
            &|request| ControlResponse::success(request.id, json!({"shouldNotRun": true})),
        );
        let reply: ControlResponse = serde_json::from_value(reply).unwrap();
        assert!(!reply.ok);
        assert_eq!(reply.error.unwrap().code, "unauthorized");
    }

    #[cfg(unix)]
    #[test]
    fn the_app_token_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let _home = crate::store::temp_home();
        let (endpoint, _) = launch("only");
        let token_path = control_token_path().unwrap();
        assert_eq!(std::fs::read_to_string(token_path).unwrap(), endpoint.token);
        assert_eq!(std::fs::metadata(control_token_path().unwrap()).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn the_home_passes_to_the_next_launch_once_its_holder_is_gone() {
        let _home = crate::store::temp_home();
        let holder = prepare_control().unwrap();
        assert!(holder.publishes());
        assert_eq!(holder.socket, socket_path().unwrap());

        let second = prepare_control().unwrap();
        assert!(!second.publishes(), "the home is held");
        assert_eq!(second.socket, own_socket_path(std::process::id()).unwrap());

        // The lock is the OS's: when the holder goes, crash included, the
        // home is free again without anyone judging the holder dead.
        drop(holder);
        let third = prepare_control().unwrap();
        assert!(third.publishes());
        assert_eq!(third.socket, socket_path().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_crashed_launch_s_own_socket_is_swept_and_a_live_one_is_kept() {
        use std::os::unix::net::UnixListener;

        let _home = crate::store::temp_home();
        let dead = own_socket_path(1_000_001).unwrap();
        drop(UnixListener::bind(&dead).unwrap());
        assert!(dead.exists(), "a listener that goes away leaves its file");
        let live_path = own_socket_path(1_000_002).unwrap();
        let _live = UnixListener::bind(&live_path).unwrap();

        let _endpoint = prepare_control().unwrap();
        assert!(!dead.exists());
        assert!(live_path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_refused_frame_says_why_and_still_leaves_the_cli_alone() {
        let reply = HookReply::refused("this TerminalX has no such tab");
        let line = serde_json::to_string(&reply).unwrap();
        assert_eq!(serde_json::from_str::<HookReply>(&line).unwrap(), reply);
        // Nothing for the CLI to act on: the hook prints `{}` as before.
        assert_eq!(reply.output, None);
        // A reply from an older app, with no reason, still parses.
        assert_eq!(serde_json::from_str::<HookReply>("{}").unwrap(), HookReply::default());
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
            let reply = HookReply { output: Some(json!({"saw": frame.event})), refused: None };
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

    /// Launch one "instance" on the current home: its endpoint, listening,
    /// with every hook frame it receives recorded by tab.
    #[cfg(unix)]
    fn launch(name: &'static str) -> (ControlEndpoint, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let endpoint = prepare_control().unwrap();
        let recorded = seen.clone();
        serve(
            endpoint.clone(),
            move |frame| {
                recorded.lock().unwrap().push(frame.tab.clone());
                HookReply { output: Some(json!({"instance": name})), refused: None }
            },
            move |request| crate::control::ControlResponse::success(request.id, json!({"instance": name})),
        )
        .unwrap();
        (endpoint, seen)
    }

    #[cfg(unix)]
    fn send(socket: &Path, line: &Value) -> Value {
        use std::os::unix::net::UnixStream;
        let mut stream = UnixStream::connect(socket).unwrap();
        stream.write_all(format!("{line}\n").as_bytes()).unwrap();
        let mut reply = String::new();
        BufReader::new(stream).read_line(&mut reply).unwrap();
        serde_json::from_str(&reply).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn a_second_instance_on_the_same_home_leaves_the_first_one_s_tabs_connected() {
        // Issue #202: the installed app and a dev build on one home. The
        // second launch used to delete the socket the first one's tabs were
        // given and overwrite its control token, so every hook from the first
        // instance's CLIs reached an app that had never heard of them.
        let _home = crate::store::temp_home();
        let (first, first_seen) = launch("first");
        let (second, second_seen) = launch("second");

        let hook = |tab: &str| json!({"tab": tab, "session": "s", "token": "t", "event": "Stop", "payload": {}});
        assert_eq!(send(&first.socket, &hook("first-tab"))["output"]["instance"], "first");
        assert_eq!(send(&second.socket, &hook("second-tab"))["output"]["instance"], "second");
        assert_eq!(*first_seen.lock().unwrap(), ["first-tab"]);
        assert_eq!(*second_seen.lock().unwrap(), ["second-tab"]);

        // A shell with no app environment still reaches the first instance
        // through the home's published socket and token.
        let token = std::fs::read_to_string(control_token_path().unwrap()).unwrap();
        assert_eq!(token, first.token);
        let status = json!({"id": "r", "command": "status", "token": token, "params": {}});
        assert_eq!(send(&socket_path().unwrap(), &status)["result"]["instance"], "first");
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

    #[cfg(unix)]
    #[test]
    fn a_symlinked_root_still_holds_its_own_transcripts() {
        // `$TERMINALX_HOME` under /tmp is /private/tmp once resolved, so the
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
