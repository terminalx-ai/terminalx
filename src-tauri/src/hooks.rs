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
//!
//! Local-owner deciding hooks instead return an explicit denial on failure; a
//! lost owner must never authorize a tool through an empty hook response.

use crate::paths::Canonical;
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
    /// Claude only: this conversation's own file, wherever the CLI keeps it.
    pub conversation: Option<ConversationFile>,
}

/// One conversation's transcript, named without saying which folder it is
/// in. Claude Code files a transcript under the directory the conversation
/// was started in and keeps writing there when it is resumed from another:
/// after a workspace is renamed, the file is not under the folder derived
/// from where the checkout is now (#250).
///
/// The folder it is really in is *adopted* — a second place this tab's
/// frames may name, beside the derived one — but only on evidence: a file
/// named for this conversation has to exist there. A frame cannot adopt a
/// folder by naming a file that is not there, so it cannot walk the tail
/// into some other checkout's conversations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationFile {
    /// `~/.claude/projects`: the file is in a folder directly inside it.
    projects: PathBuf,
    /// `<conversation id>.jsonl`.
    name: String,
    /// Folders, canonical, in which this conversation's file was found.
    folders: Vec<PathBuf>,
    /// Files the CLI opened after this one in an adopted folder: a `/clear`
    /// starts a new conversation under a new id, and says so at
    /// `SessionStart`.
    successors: Vec<String>,
}

impl ConversationFile {
    pub fn new(projects: PathBuf, name: String) -> Self {
        Self { projects, name, folders: Vec::new(), successors: Vec::new() }
    }

    /// Take `named`'s folder as one of this conversation's, if `named` is
    /// this conversation's file and is really there: a regular file, not a
    /// link to somewhere else, directly inside a folder of the projects
    /// directory. Compared after resolving links, so `..` and a linked
    /// folder cannot make another place look like that one.
    pub fn adopt(&mut self, named: &Path) -> bool {
        if named.file_name().and_then(|n| n.to_str()) != Some(self.name.as_str()) || !regular_file(named) {
            return false;
        }
        let Some(folder) = named.parent().and_then(|f| f.canonical().ok()) else { return false };
        let Ok(projects) = self.projects.canonical() else { return false };
        if folder.parent() != Some(projects.as_path()) {
            return false;
        }
        if !self.folders.contains(&folder) {
            self.folders.push(folder);
        }
        true
    }

    /// Whether `named` is this tab's to follow: its own conversation in a
    /// folder that holds it, or a file its CLI opened there afterwards.
    /// `announcing` is a `SessionStart`, the one frame in which the CLI
    /// says it has opened a new file.
    fn holds(&mut self, named: &Path, announcing: bool) -> bool {
        if !named.is_absolute() || named.components().any(|c| c == Component::ParentDir) {
            return false;
        }
        if self.adopt(named) {
            return true;
        }
        let Some(folder) = named.parent().and_then(|f| f.canonical().ok()) else { return false };
        let Some(file) = named.file_name().and_then(|n| n.to_str()) else { return false };
        if !self.folders.contains(&folder) || named.is_symlink() || named.is_dir() {
            return false;
        }
        if self.successors.iter().any(|s| s == file) {
            return true;
        }
        if announcing && file.ends_with(".jsonl") && file != self.name {
            self.successors.push(file.to_string());
            return true;
        }
        false
    }
}

fn regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_file())
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
    ///
    /// For Claude that is any file in the folder derived from the checkout,
    /// as it always was, and — in a folder the conversation was found in —
    /// this conversation's own file or one the CLI announced after it. The
    /// derived folder stays allowed when another is adopted.
    pub fn transcript<'f>(&mut self, frame: &'f HookFrame) -> Option<&'f Path> {
        let named = Path::new(frame.payload["transcript_path"].as_str()?);
        let announcing = frame.event == "SessionStart";
        (under_root(&self.transcript_root, named) || self.conversation.as_mut().is_some_and(|own| own.holds(named, announcing))).then_some(named)
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
    /// Where this launch always listens, and what its tabs are told to dial:
    /// a socket named for this process, which no other launch binds, replaces
    /// or removes while the process lives.
    pub socket: PathBuf,
    pub token: String,
    /// Set while this launch also answers on the home's published socket and
    /// its token is the one in `run/control.token`: it is then the launch a
    /// shell with no app environment reaches.
    published: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl ControlEndpoint {
    /// The endpoint the runtime this process was served on, handed over with
    /// it (#765): the same socket path and token its agents were given.
    #[cfg(any(unix, test))]
    pub fn adopted(socket: PathBuf, token: String) -> Self {
        Self { socket, token, published: Default::default() }
    }

    /// Whether this launch currently owns the home's published socket and
    /// token. It changes over a launch's life: a launch that started beside
    /// another takes the home over when that one goes.
    pub fn publishes(&self) -> bool {
        self.published.load(std::sync::atomic::Ordering::Relaxed)
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

/// Scoped per-tab capability token payload injected into agent tab subprocesses
/// in place of the app-wide master control token (S-01).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TabCapability {
    pub session_id: String,
    pub tab_id: String,
    pub launch_id: String,
    pub permission_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bot_access: Option<String>,
    /// `"standard"`, `"lead"`, `"worker"`, or `"verifier"`.
    pub orchestration_role: String,
}

const TAB_TOKEN_PREFIX: &str = "txcap1.";
const TAB_TOKEN_DOMAIN: &[u8] = b"terminalx-tab-cap-v1:";

/// Mint an HMAC-SHA256-authenticated capability token bound to one tab launch.
/// The master `control_token` acts only as the MAC key and is never exposed in
/// the returned string.
pub fn mint_tab_token(master_token: &str, capability: &TabCapability) -> String {
    use base64::Engine as _;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    let payload = serde_json::to_vec(capability).expect("TabCapability serializes");
    let encoded_payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload);
    let mut mac = Hmac::<Sha256>::new_from_slice(master_token.as_bytes()).expect("HMAC accepts any key length");
    mac.update(TAB_TOKEN_DOMAIN);
    mac.update(encoded_payload.as_bytes());
    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    format!("{TAB_TOKEN_PREFIX}{encoded_payload}.{sig}")
}

/// Verify a scoped tab capability token against `master_token` in constant time.
pub fn verify_tab_token(master_token: &str, token: &str) -> Option<TabCapability> {
    use base64::Engine as _;
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    if master_token.is_empty() {
        return None;
    }
    let rest = token.strip_prefix(TAB_TOKEN_PREFIX)?;
    let (encoded_payload, encoded_sig) = rest.split_once('.')?;
    if encoded_payload.is_empty() || encoded_sig.is_empty() || encoded_sig.contains('.') {
        return None;
    }
    let sig = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded_sig).ok()?;
    let mut mac = Hmac::<Sha256>::new_from_slice(master_token.as_bytes()).ok()?;
    mac.update(TAB_TOKEN_DOMAIN);
    mac.update(encoded_payload.as_bytes());
    mac.verify_slice(&sig).ok()?;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded_payload).ok()?;
    let cap: TabCapability = serde_json::from_slice(&payload).ok()?;
    if cap.session_id.is_empty() || cap.tab_id.is_empty() || cap.launch_id.is_empty() {
        return None;
    }
    Some(cap)
}

thread_local! {
    static CALLER_CAPABILITY: std::cell::RefCell<Option<TabCapability>> = const { std::cell::RefCell::new(None) };
}

/// The verified scoped tab capability of the current control request, or `None`
/// when authenticated with the master control token / in-process.
pub(crate) fn caller_capability() -> Option<TabCapability> {
    CALLER_CAPABILITY.with(|cap| cap.borrow().clone())
}

/// Run `f` with `capability` installed as the active control caller capability.
pub(crate) fn with_caller_capability<T>(capability: Option<TabCapability>, f: impl FnOnce() -> T) -> T {
    struct Reset(Option<TabCapability>);
    impl Drop for Reset {
        fn drop(&mut self) {
            CALLER_CAPABILITY.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let previous = CALLER_CAPABILITY.with(|slot| slot.replace(capability));
    let _reset = Reset(previous);
    f()
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
    match (root.canonical(), resolve_existing(candidate)) {
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
        if let Ok(real) = here.canonical() {
            return Some(tail.iter().rev().fold(real, |acc, part| acc.join(part)));
        }
        tail.push(here.file_name()?.to_owned());
        here = here.parent()?;
    }
}

/// What the app wants the hook to print. Reporting hooks may omit output;
/// local-owner decision hooks fail closed on missing output. A successfully
/// handled report at a decision gate must explicitly return `Some({})` to
/// leave the CLI's own approval policy untouched.
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

/// The socket one launch serves its own tabs on: `hooks-<pid>.sock`. A
/// process that prepares more than one endpoint (the tests do) numbers the
/// later ones, so no two launches ever share a path.
fn own_socket_path(pid: u32, nth: u32) -> anyhow::Result<PathBuf> {
    let suffix = if nth == 0 { pid.to_string() } else { format!("{pid}-{nth}") };
    #[cfg(unix)]
    {
        let path = run_dir()?.join(format!("hooks-{suffix}.sock"));
        if fits_socket_address(&path) {
            return Ok(path);
        }
        // A long home leaves no room for the pid in a socket address. The
        // launch then listens in a private directory of the temp dir (0700,
        // freshly made, so nothing else can be waiting at the path), which
        // the OS's own temp cleaning removes.
        for base in [std::env::temp_dir(), PathBuf::from("/tmp")] {
            let Ok(dir) = tempfile::Builder::new().prefix(&format!("terminalx-{suffix}-")).tempdir_in(&base) else { continue };
            let short = dir.path().join("hooks.sock");
            if fits_socket_address(&short) {
                log::warn!("{} is too long for a socket address; this launch listens at {}", path.display(), short.display());
                let _ = dir.keep();
                return Ok(short);
            }
        }
        // Nowhere short enough: the bind reports it, and the app runs on
        // without the hook bridge as it does for any other bind failure.
        Ok(path)
    }
    #[cfg(windows)]
    {
        let shared = crate::pipe_transport::path_for_home(&crate::store::root()?);
        Ok(PathBuf::from(format!("{}-{suffix}", shared.display())))
    }
}

/// Whether `path` fits a unix socket address: `sun_path` less its NUL, which
/// is 104 bytes on macOS and the BSDs and 108 on Linux.
#[cfg(unix)]
fn fits_socket_address(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    const SUN_PATH: usize = if cfg!(any(target_os = "linux", target_os = "android")) { 108 } else { 104 };
    path.as_os_str().as_bytes().len() < SUN_PATH
}

fn run_dir() -> anyhow::Result<PathBuf> {
    crate::store::ensure_dir(crate::store::root()?.join("run"))
}

pub fn control_token_path() -> anyhow::Result<PathBuf> {
    Ok(run_dir()?.join("control.token"))
}

/// Name this launch's own socket and mint its token, before any agent
/// process is launched.
///
/// The installed app and a dev build both default to `~/.raccoon`, so two
/// launches on one home is ordinary. Every launch serves its own tabs on a
/// socket of its own, and one of them additionally answers on the home's
/// published socket for shells (`serve` decides which). A launch used to
/// delete the published socket and overwrite its token on the way up, and
/// every hook from the first launch's tabs then reached an app that did not
/// know them: the Terminal view kept streaming while the Chat view never saw
/// a reply (#202). Nothing here touches the published socket or token, and
/// nothing here can fail for what another launch is doing.
pub fn prepare_control() -> anyhow::Result<ControlEndpoint> {
    static PREPARED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let nth = PREPARED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let socket = own_socket_path(std::process::id(), nth)?;
    #[cfg(unix)]
    sweep_stale_sockets();
    Ok(ControlEndpoint { socket, token: mint_token(), published: Default::default() })
}

/// The pid in a launch's own socket name, `hooks-<pid>.sock` or
/// `hooks-<pid>-<n>.sock`.
#[cfg(unix)]
fn launch_pid(name: &str) -> Option<u32> {
    name.strip_prefix("hooks-")?.strip_suffix(".sock")?.split('-').next()?.parse().ok()
}

/// Remove the sockets of launches that are gone, so a crashed launch does not
/// leave its socket behind for good.
///
/// A refused connection alone does not say the launch is gone: a socket
/// exists from `bind` but answers only from `listen`, and one caught between
/// the two belongs to a launch that is just starting. So the process named in
/// the file must be dead as well.
#[cfg(unix)]
fn sweep_stale_sockets() {
    let Ok(dir) = run_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let Some(pid) = launch_pid(&entry.file_name().to_string_lossy()) else { continue };
        if pid == std::process::id() || crate::harness::host::is_alive(pid) {
            continue;
        }
        let path = entry.path();
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

/// The extra argument changes wait/failure handling only. It grants no authority:
/// the owner still validates the launch token, session, tab and transcript.
pub(crate) fn decision_hook_command(exe: &Path, event: &str, local_owner: bool) -> String {
    let mut command = hook_command(exe, event);
    if local_owner { command.push_str(" --local-owner-decision"); }
    command
}

#[cfg(unix)]
thread_local! {
    static CALLER: std::cell::RefCell<Option<std::sync::Arc<std::os::unix::net::UnixStream>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(windows)]
thread_local! {
    /// The process whose frame this thread is answering, as the pipe names it.
    static CALLER: std::cell::Cell<Option<u32>> = const { std::cell::Cell::new(None) };
}

/// Answer one frame from process `client` with what `answer` makes of it.
/// The thread is one of a pool: the sender is known on it only while its
/// frame is answered, however the answering ends.
#[cfg(windows)]
fn answer_frame_from(client: u32, answer: impl FnOnce() -> Value) -> Value {
    struct Answering;
    impl Drop for Answering {
        fn drop(&mut self) {
            CALLER.with(|caller| caller.set(None));
        }
    }
    CALLER.with(|caller| caller.set(Some(client)));
    let _answering = Answering;
    answer()
}

#[cfg(test)]
thread_local! {
    /// The caller a test's in-process control request stands for.
    pub(crate) static TEST_CALLER_PID: std::cell::Cell<Option<i32>> = const { std::cell::Cell::new(None) };
}

/// Who sent the frame being answered on this thread, as the kernel says (PRO-468).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Peer {
    /// No transport: a direct call inside this process.
    InProcess,
    /// The process at the other end, whatever it claims.
    Pid(i32),
    /// A transport whose other end cannot be read: on macOS, one the client
    /// closed after sending. Who sent it cannot be told. A Windows pipe
    /// that cannot name its client is never answered at all
    /// (`pipe_transport::serve`).
    Unreadable,
}

/// The sender of the frame being answered on this thread.
pub(crate) fn caller() -> Peer {
    #[cfg(test)]
    if let Some(pid) = TEST_CALLER_PID.with(std::cell::Cell::get) {
        return Peer::Pid(pid);
    }
    #[cfg(unix)]
    {
        let Some(stream) = CALLER.with(|caller| caller.borrow().clone()) else { return Peer::InProcess };
        match crate::serve_cli::consent::peer_pid(&stream) {
            Ok(pid) => Peer::Pid(pid),
            Err(_) => Peer::Unreadable,
        }
    }
    #[cfg(windows)]
    {
        match CALLER.with(std::cell::Cell::get) {
            None => Peer::InProcess,
            Some(pid) => i32::try_from(pid).map_or(Peer::Unreadable, Peer::Pid),
        }
    }
    #[cfg(not(any(unix, windows)))]
    Peer::InProcess
}

/// [`caller`]'s process, when the kernel names one.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn caller_pid() -> Option<i32> {
    match caller() {
        Peer::Pid(pid) => Some(pid),
        Peer::InProcess | Peer::Unreadable => None,
    }
}

/// Inspect the hook transport without consuming bytes or spawning a watcher.
/// No transport is installed for direct in-process calls and unit tests.
#[derive(Clone, Default)]
pub(crate) struct Caller {
    #[cfg(unix)]
    stream: Option<std::sync::Arc<std::os::unix::net::UnixStream>>,
    #[cfg(windows)]
    pipe: Option<crate::pipe_transport::PipeClient>,
}

impl Caller {
    /// The connection a handed-over frame waits on (#765).
    #[cfg(unix)]
    pub(crate) fn of(stream: std::sync::Arc<std::os::unix::net::UnixStream>) -> Self {
        Self { stream: Some(stream) }
    }

    pub(crate) fn current() -> Self {
        #[cfg(unix)]
        return Self { stream: CALLER.with(|caller| caller.borrow().clone()) };
        #[cfg(windows)]
        return Self { pipe: crate::pipe_transport::current_client() };
        #[cfg(not(any(unix, windows)))]
        Self::default()
    }

    pub(crate) fn connected(&self) -> bool {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let Some(stream) = self.stream.as_ref() else { return true };
            let mut byte = 0u8;
            // SAFETY: the descriptor is held by the thread-local stream and `byte`
            // is writable for one byte. PEEK never consumes protocol data.
            let read = unsafe { libc::recv(stream.as_raw_fd(), (&mut byte as *mut u8).cast(), 1, libc::MSG_PEEK | libc::MSG_DONTWAIT) };
            // A hook sends exactly one frame. Extra bytes cannot extend a
            // disconnected caller's lifetime by keeping unread input queued.
            read < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::WouldBlock
        }
        // A hook that gave up on its pipe has left; one without a pipe is in-process.
        #[cfg(windows)]
        return self.pipe.as_ref().is_none_or(crate::pipe_transport::PipeClient::connected);
        #[cfg(not(any(unix, windows)))]
        true
    }
}

pub(crate) fn caller_connected() -> bool { Caller::current().connected() }

/// The status-line command is the same authenticated forwarder, but it prints
/// no line back into the TUI.
pub fn statusline_command(exe: &Path) -> String {
    let quoted = format!("'{}'", exe.to_string_lossy().replace('\'', "'\\''"));
    format!("{quoted} statusline")
}

// ---------------------------------------------------------------- the app end

/// How often a launch looks at the home's published socket: to take it over
/// when the launch that held it has gone, or to put it back when something
/// replaced it.
const PUBLISH_RETRY: Duration = Duration::from_secs(2);

/// One line in, one reply out: what every listener of a launch runs.
type Dispatch = std::sync::Arc<dyn Fn(&str) -> Value + Send + Sync>;

/// Listen for this launch's hook and control frames.
///
/// The launch's own socket comes first and is all its tabs depend on. The
/// home's published socket is a second listener over the same handlers, held
/// by one launch at a time and passed on when its holder goes, so a shell
/// always has a launch to reach while any is running.
pub fn serve<F, C>(endpoint: ControlEndpoint, hook_handler: F, control_handler: C) -> anyhow::Result<(PathBuf, std::sync::Arc<Bridge>)>
where
    F: Fn(HookFrame) -> HookReply + Send + Sync + 'static,
    C: Fn(crate::control::ControlRequest) -> crate::control::ControlResponse + Send + Sync + 'static,
{
    serve_from(endpoint, None, hook_handler, control_handler)
}

/// [`serve`], on the sockets the runtime this one replaced listened on and
/// handed over with its process (#765). It starts frozen: what was queued
/// on them meanwhile, and the frames that were read and never answered, are
/// answered once [`Bridge::thaw`] says this runtime is ready to.
#[cfg(unix)]
pub fn serve_adopted<F, C>(endpoint: ControlEndpoint, adopted: Adopted, hook_handler: F, control_handler: C) -> anyhow::Result<(PathBuf, std::sync::Arc<Bridge>)>
where
    F: Fn(HookFrame) -> HookReply + Send + Sync + 'static,
    C: Fn(crate::control::ControlRequest) -> crate::control::ControlResponse + Send + Sync + 'static,
{
    serve_from(endpoint, Some(adopted), hook_handler, control_handler)
}

#[cfg(unix)]
type Inherited = Option<Adopted>;
#[cfg(not(unix))]
type Inherited = Option<std::convert::Infallible>;

fn serve_from<F, C>(endpoint: ControlEndpoint, adopted: Inherited, hook_handler: F, control_handler: C) -> anyhow::Result<(PathBuf, std::sync::Arc<Bridge>)>
where
    F: Fn(HookFrame) -> HookReply + Send + Sync + 'static,
    C: Fn(crate::control::ControlRequest) -> crate::control::ControlResponse + Send + Sync + 'static,
{
    let socket = endpoint.socket.clone();
    let mut publisher = listen_from(endpoint, adopted, hook_handler, control_handler)?;
    // Once before returning, so a launch alone on its home is reachable by a
    // shell as soon as it says it is up.
    publisher.tick();
    let publisher = std::sync::Arc::new(std::sync::Mutex::new(publisher));
    let ticking = publisher.clone();
    std::thread::Builder::new().name("hook-socket-publish".into()).spawn(move || loop {
        std::thread::sleep(PUBLISH_RETRY);
        ticking.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).tick();
    })?;
    #[cfg(unix)]
    let gate = publisher.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).frames.gate.clone();
    Ok((socket, std::sync::Arc::new(Bridge {
        publisher,
        #[cfg(unix)]
        gate,
    })))
}

/// Serve window-only services without ever competing for home discovery.
/// Dropping the unused publisher leaves the private listener running, but
/// cannot acquire the home lock or replace its socket/token after owner loss.
pub fn serve_private<F, C>(endpoint: ControlEndpoint, hook_handler: F, control_handler: C) -> anyhow::Result<PathBuf>
where
    F: Fn(HookFrame) -> HookReply + Send + Sync + 'static,
    C: Fn(crate::control::ControlRequest) -> crate::control::ControlResponse + Send + Sync + 'static,
{
    let socket = endpoint.socket.clone();
    drop(listen_from(endpoint, None, hook_handler, control_handler)?);
    Ok(socket)
}

/// Listen on the launch's own socket, and hand back what keeps the published
/// one. Nothing is published until the publisher is asked to look: `serve`
/// asks once and then on a timer, and that timer is the only clock in any of
/// this, so everything a look does can be had by asking for one.
#[cfg(all(test, unix))]
fn listen<F, C>(endpoint: ControlEndpoint, hook_handler: F, control_handler: C) -> anyhow::Result<Publisher>
where
    F: Fn(HookFrame) -> HookReply + Send + Sync + 'static,
    C: Fn(crate::control::ControlRequest) -> crate::control::ControlResponse + Send + Sync + 'static,
{
    listen_from(endpoint, None, hook_handler, control_handler)
}

/// [`listen`], on the sockets handed over by the runtime this one replaced
/// when `adopted` names them.
fn listen_from<F, C>(endpoint: ControlEndpoint, adopted: Inherited, hook_handler: F, control_handler: C) -> anyhow::Result<Publisher>
where
    F: Fn(HookFrame) -> HookReply + Send + Sync + 'static,
    C: Fn(crate::control::ControlRequest) -> crate::control::ControlResponse + Send + Sync + 'static,
{
    let control_token = endpoint.token.clone();
    let dispatch: Dispatch = std::sync::Arc::new(move |line: &str| dispatch_line(line, &control_token, &hook_handler, &control_handler));
    #[cfg(unix)]
    let frames = Frames::new(MAX_FRAMES)?;
    #[cfg(unix)]
    let (own, claim) = match adopted {
        Some(Adopted { own, published, held }) => {
            {
                let mut gate = frames.gate.lock();
                gate.frozen = true;
                gate.held = held.into_iter().map(|(stream, line, queued)| HeldFrame { stream, line, queued }).collect();
            }
            let claim = match published {
                Some((listener, lock)) => {
                    let listener = std::os::unix::net::UnixListener::from(listener);
                    let socket = socket_path()?;
                    let identity = file_identity(&socket)?;
                    accept(listener.try_clone()?, dispatch.clone(), frames.clone())?;
                    endpoint.published.store(true, std::sync::atomic::Ordering::Relaxed);
                    Some(Claim { _lock: std::fs::File::from(lock), identity, listener })
                }
                None => None,
            };
            (std::os::unix::net::UnixListener::from(own), claim)
        }
        None => {
            // The file at this path is named for this process, so whatever is
            // there was left by a dead one and would only refuse the bind.
            let _ = std::fs::remove_file(&endpoint.socket);
            (bind(&endpoint.socket)?, None)
        }
    };
    #[cfg(unix)]
    let own = {
        let kept = own.try_clone()?;
        accept(own, dispatch.clone(), frames.clone())?;
        kept
    };
    #[cfg(windows)]
    {
        let _ = adopted;
        let dispatch = dispatch.clone();
        crate::pipe_transport::serve(endpoint.socket.clone(), move |line, client| format!("{}\n", answer_frame_from(client, || dispatch(&line))))?;
    }
    // Resolved once: the publisher outlives whatever the caller does to the
    // environment that names the home.
    Ok(Publisher {
        socket: socket_path()?,
        lock: run_dir()?.join("hooks.lock"),
        token_file: control_token_path()?,
        own: endpoint.socket.clone(),
        token: endpoint.token,
        dispatch,
        #[cfg(unix)]
        frames,
        published: endpoint.published,
        #[cfg(unix)]
        held: claim,
        #[cfg(windows)]
        held: None,
        waiting_on: None,
        #[cfg(unix)]
        listener: own,
        #[cfg(windows)]
        pipe_up: false,
    })
}

#[cfg(unix)]
fn bind(path: &Path) -> std::io::Result<std::os::unix::net::UnixListener> {
    use std::os::unix::fs::PermissionsExt;

    let listener = std::os::unix::net::UnixListener::bind(path)?;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    Ok(listener)
}

/// How many frames a launch handles at once, on all its sockets together.
/// Each has a thread, and a frame
/// held up behind a wedged owner may never return, so without a bound one
/// stuck dispatch gathers hundreds of threads (#661). Past it a frame is
/// refused with [`busy_reply`].
#[cfg(unix)]
const MAX_FRAMES: usize = 256;

/// A launch's frame places, shared by its own socket and the published one,
/// and where frames past them go to be refused.
#[cfg(unix)]
#[derive(Clone)]
struct Frames {
    count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    limit: usize,
    refuse: std::sync::mpsc::SyncSender<std::os::unix::net::UnixStream>,
    gate: std::sync::Arc<Gate>,
}

#[cfg(unix)]
impl Frames {
    fn new(limit: usize) -> std::io::Result<Self> {
        Ok(Self { count: Default::default(), limit, refuse: refuser()?, gate: Default::default() })
    }

    fn take(&self) -> Option<FrameSlot> {
        crate::local_runtime::permissions::increment_bounded(&self.count, self.limit).then(|| FrameSlot(self.count.clone()))
    }
}

/// One frame place, given back when the frame's thread ends.
#[cfg(unix)]
struct FrameSlot(std::sync::Arc<std::sync::atomic::AtomicUsize>);

#[cfg(unix)]
impl Drop for FrameSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// What a frame refused for want of a place is told: a control request that
/// the owner is busy, a hook nothing to act on (so a deciding hook fails
/// closed) and why, for its CLI's hook log.
#[cfg(unix)]
fn busy_reply(line: &str) -> Value {
    const BUSY: &str = "TerminalX is handling too many requests at once, so this one was refused.";
    match serde_json::from_str::<Value>(line) {
        Ok(value) if value.get("command").is_some() => {
            let id = value.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            serde_json::to_value(crate::control::ControlResponse::failure(id, crate::control::ControlError::new(
                "busy", BUSY, Some("Retry shortly. If it keeps happening, restart the TerminalX runtime from the app.".into()),
            ))).unwrap_or_default()
        }
        _ => serde_json::to_value(HookReply::refused(BUSY)).unwrap_or_default(),
    }
}

/// Answer refused frames on one thread of their own, never the accepting one:
/// reading a refused caller's line must not hold up the next connection.
#[cfg(unix)]
fn refuser() -> std::io::Result<std::sync::mpsc::SyncSender<std::os::unix::net::UnixStream>> {
    let (refuse, refused) = std::sync::mpsc::sync_channel::<std::os::unix::net::UnixStream>(32);
    std::thread::Builder::new().name("hook-refuse".into()).spawn(move || {
        for stream in refused {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
            let mut line = String::new();
            let Ok(reader) = stream.try_clone() else { continue };
            if BufReader::new(reader).take(1024 * 1024).read_line(&mut line).is_err() || line.trim().is_empty() {
                continue;
            }
            if let Ok(mut bytes) = serde_json::to_vec(&busy_reply(&line)) {
                bytes.push(b'\n');
                let mut stream = stream;
                let _ = stream.write_all(&bytes);
            }
        }
    })?;
    Ok(refuse)
}

#[cfg(unix)]
fn accept(listener: std::os::unix::net::UnixListener, dispatch: Dispatch, frames: Frames) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    // Accepted and read while the bridge is frozen too, and held for whoever
    // answers it (#765, PRO-589): a frame left unread in the socket's queue
    // blocks a hook that writes more than the queue holds (8 KiB on macOS),
    // and its write times out. Only once the handover takes the bridge does
    // a connection wait in the queue, which goes over with the socket, for
    // the runtime that takes it to accept.
    // A hook that could not reach this socket left a note beside it.
    let failed_sends = listener.local_addr().ok().and_then(|address| address.as_pathname().map(failed_sends_beside));
    listener.set_nonblocking(true)?;
    std::thread::Builder::new().name("hook-socket".into()).spawn(move || {
        let mut refusing = false;
        loop {
            let accepted = {
                let mut gate = frames.gate.unsealed();
                match listener.accept() {
                    Ok((stream, _)) => {
                        let id = gate.open("a frame not read yet", Phase::Reading);
                        Some((stream, id))
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => None,
                    Err(error) => {
                        drop(gate);
                        // Out of descriptors, say: the queue keeps the caller.
                        log::warn!("accept on the hook socket: {error}");
                        std::thread::sleep(Duration::from_millis(100));
                        continue;
                    }
                }
            };
            let Some((stream, id)) = accepted else {
                if !readable(listener.as_raw_fd()) {
                    std::thread::sleep(Duration::from_millis(100));
                }
                continue;
            };
            // A socket accepted from a non-blocking listener is non-blocking
            // itself on macOS; each frame thread reads and writes plainly.
            let _ = stream.set_nonblocking(false);
            let busy = Busy { gate: frames.gate.clone(), id };
            let Some(slot) = frames.take() else {
                if !refusing {
                    log::warn!("{} socket frames are already in progress; refusing new ones until some finish", frames.limit);
                    refusing = true;
                }
                // A full refusal queue closes the connection unanswered.
                let _ = frames.refuse.try_send(stream);
                drop(busy);
                continue;
            };
            if refusing {
                log::info!("socket frames are being accepted again");
                refusing = false;
            }
            let dispatch = dispatch.clone();
            let failed_sends = failed_sends.clone();
            // One thread per hook: a permission frame parks until it is
            // answered, and the next hook must not queue behind it.
            let _ = std::thread::Builder::new().name("hook-frame".into()).spawn(crate::github_process::queued(move || {
                let _slot = slot;
                // A hook writes its frame as soon as it connects.
                let _ = stream.set_read_timeout(Some(FRAME_READ));
                let mut reader = BufReader::new(match stream.try_clone() {
                    Ok(s) => s,
                    Err(_) => return,
                });
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
                    return;
                }
                let _ = stream.set_read_timeout(None);
                if let Some(path) = &failed_sends { report_failed_sends(path); }
                // Read while frozen, it is held as the queue would have held it.
                let Some(stream) = busy.read(stream, &line) else { return };
                answer_frame(stream, busy, |_| dispatch(&line), Some(line.clone()));
            }));
        }
    })?;
    Ok(())
}

/// How long a connection has to send its frame. A hook writes it at once.
#[cfg(unix)]
const FRAME_READ: Duration = Duration::from_secs(5);

/// How long a hook's frame may take to be written (PRO-589). The bridge
/// reads frames while it is frozen for a handover, but not once the handover
/// has taken it: a frame larger than the socket's queue holds (8 KiB on
/// macOS) then waits for the runtime taking over to accept it, after the
/// handover's reply (5 s at most) and the exec. Well beyond both, so that
/// such a frame is never dropped on the way.
#[cfg(unix)]
pub(crate) const FRAME_WRITE: Duration = Duration::from_secs(30);

/// Where a hook that could not reach the runtime leaves a note, one JSON
/// line each, beside the socket it dialled (PRO-589). The runtime serving
/// that socket logs them and removes the file.
#[cfg(unix)]
const FAILED_SENDS: &str = "hook-failures.jsonl";
/// Past this size no more notes are added until the runtime has read them.
#[cfg(unix)]
const FAILED_SENDS_LIMIT: u64 = 256 * 1024;

#[cfg(unix)]
fn failed_sends_beside(socket: &Path) -> PathBuf {
    socket.with_file_name(FAILED_SENDS)
}

/// Leave a note beside `socket` that `frame` could not be delivered: at
/// which `stage`, why, its size and how long it was tried. Nothing of what
/// the frame carried is noted, only what names it.
#[cfg(unix)]
fn note_failed_send(socket: &Path, frame: &HookFrame, stage: &str, error: &str, bytes: usize, elapsed: Duration) {
    use std::os::unix::fs::OpenOptionsExt;
    let path = failed_sends_beside(socket);
    if std::fs::metadata(&path).is_ok_and(|metadata| metadata.len() > FAILED_SENDS_LIMIT) {
        return;
    }
    let note = serde_json::json!({
        "at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "event": frame.event, "tab": frame.tab, "session": frame.session,
        "stage": stage, "error": error, "bytes": bytes, "elapsedMs": u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX),
    });
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).mode(0o600).open(&path) else { return };
    // One write, so that notes appended at once by several hooks stay whole.
    let _ = file.write_all(format!("{note}\n").as_bytes());
}

/// Log at WARN the notes left at `path` by hooks that could not reach this
/// runtime, and remove them. Claimed by renaming, so each note is logged once
/// whichever frame thread comes first, and a hook writing meanwhile starts a
/// file of its own.
#[cfg(unix)]
fn report_failed_sends(path: &Path) {
    static CLAIMS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let claim = CLAIMS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let claimed = path.with_file_name(format!("{FAILED_SENDS}.{}-{claim}", std::process::id()));
    if std::fs::rename(path, &claimed).is_err() {
        return;
    }
    let notes = std::fs::read_to_string(&claimed).unwrap_or_default();
    let _ = std::fs::remove_file(&claimed);
    for note in notes.lines().filter(|note| !note.trim().is_empty()) {
        log::warn!("{}", failed_send_line(note));
    }
}

/// How a note left by a hook that could not reach the runtime is logged.
#[cfg(unix)]
fn failed_send_line(note: &str) -> String {
    let Ok(note) = serde_json::from_str::<Value>(note) else { return format!("a hook could not reach the runtime: {note}") };
    let text = |key: &str| note[key].as_str().unwrap_or("?").to_string();
    format!("a hook could not reach the runtime: {} for tab {} at {}, {} bytes, gave up at \"{}\" after {} ms: {}",
        text("event"), text("tab"), text("at"), note["bytes"], text("stage"), note["elapsedMs"], text("error"))
}

/// Whether `fd` became readable; false when it could not be asked.
#[cfg(unix)]
fn readable(fd: std::os::fd::RawFd) -> bool {
    let mut poll = libc::pollfd { fd, events: libc::POLLIN, revents: 0 };
    loop {
        // SAFETY: one pollfd that lives across the call.
        match unsafe { libc::poll(&mut poll, 1, -1) } {
            count if count >= 0 => return true,
            _ if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted => {}
            _ => return false,
        }
    }
}

/// Answer one frame on `stream` with what `answer` makes of it, `line`
/// being the frame as read. A frame read while the bridge is being handed
/// over is held for the runtime that takes it, unanswered (#765).
#[cfg(unix)]
fn answer_frame(stream: std::os::unix::net::UnixStream, busy: Busy, answer: impl FnOnce(&std::os::unix::net::UnixStream) -> Value, line: Option<String>) {
    if let Some(line) = &line {
        let mut gate = busy.gate.lock();
        if gate.frozen {
            gate.held.push(HeldFrame { stream, line: line.clone(), queued: false });
            return;
        }
    }
    let Ok(connection) = stream.try_clone() else { return };
    CALLER.with(|caller| *caller.borrow_mut() = Some(std::sync::Arc::new(connection)));
    FRAME.with(|frame| *frame.borrow_mut() = Some(Answering { gate: busy.gate.clone(), line, id: busy.id }));
    let reply = answer(&stream);
    CALLER.with(|caller| *caller.borrow_mut() = None);
    FRAME.with(|frame| *frame.borrow_mut() = None);
    let then = AFTER_REPLY.with(|after| after.borrow_mut().take());
    let mobile = MOBILE_REPLY.with(|guard| guard.borrow_mut().take());
    let mut stream = stream;
    if let Some(MobileReply { denied, deliver }) = mobile {
        deliver(&mut |authorized| write_frame_reply(&mut stream, if authorized { &reply } else { &denied }, true));
        drop(busy);
    } else {
        drop(busy);
        write_frame_reply(&mut stream, &reply, false);
    }
    if let Some(then) = then {
        then();
    }
}

#[cfg(unix)]
fn write_frame_reply(stream: &mut std::os::unix::net::UnixStream, reply: &Value, bounded: bool) -> bool {
    let Ok(mut bytes) = serde_json::to_vec(reply) else { return false };
    bytes.push(b'\n');
    if !bounded {
        return stream.write_all(&bytes).and_then(|()| stream.flush()).is_ok();
    }
    // Use one deadline across partial writes while revocation waits for the
    // grant, including when a hook caller keeps draining only a few bytes.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut remaining = bytes.as_slice();
    while !remaining.is_empty() {
        let budget = deadline.saturating_duration_since(std::time::Instant::now());
        if budget.is_zero() || stream.set_write_timeout(Some(budget)).is_err() { return false; }
        match stream.write(remaining) {
            Ok(0) => return false,
            Ok(written) => remaining = &remaining[written..],
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return false,
        }
    }
    stream.flush().is_ok()
}

#[cfg(unix)]
type MobileDelivery = Box<dyn FnOnce(&mut dyn FnMut(bool) -> bool)>;

#[cfg(unix)]
struct MobileReply {
    denied: Value,
    deliver: MobileDelivery,
}

#[cfg(unix)]
thread_local! {
    static MOBILE_REPLY: std::cell::RefCell<Option<MobileReply>> = const { std::cell::RefCell::new(None) };
}

/// Carry mobile authority to the hook transport's actual reply write.
pub(crate) fn guard_mobile_reply(denied: HookReply,
    deliver: impl FnOnce(&mut dyn FnMut(bool) -> bool) + 'static) -> bool {
    #[cfg(unix)]
    if FRAME.with(|frame| frame.borrow().is_some()) {
        MOBILE_REPLY.with(|guard| *guard.borrow_mut() = Some(MobileReply {
            denied: serde_json::to_value(denied).unwrap_or_default(), deliver: Box::new(deliver),
        }));
        return true;
    }
    let _ = denied;
    deliver(&mut |_| false);
    false
}

/// What the hook bridge holds off on while the runtime is handed over (#765).
#[cfg(unix)]
#[derive(Default)]
struct Gate {
    state: std::sync::Mutex<GateState>,
    changed: std::sync::Condvar,
}

#[cfg(unix)]
#[derive(Default)]
struct GateState {
    frozen: bool,
    /// A handover is waiting for a quiet moment that did not come by itself
    /// ([`Bridge::drain`]): a control command read now is held as one read
    /// while frozen is, so that those under way end and none takes their
    /// place. Hook events, and what the desktop itself asks (`runtime.*`),
    /// are answered as ever.
    draining: bool,
    /// Every frame on the bridge, by its ticket: what it is, since when, and
    /// whether a handover waits for it (PRO-589).
    open: std::collections::HashMap<u64, Open>,
    next_open: u64,
    /// No connection is accepted: the handover is taking the bridge, and
    /// one still in the socket's queue goes over with the socket.
    sealed: bool,
    /// Frames read while frozen and not answered: the next owner answers them.
    held: Vec<HeldFrame>,
    /// Frames waiting on a person's decision, by that decision's request id.
    parked: std::collections::HashMap<String, std::os::unix::net::UnixStream>,
    /// Frames that only wait and read, which the next owner answers afresh.
    resumable: std::collections::HashMap<u64, (std::os::unix::net::UnixStream, String)>,
    next: u64,
    /// What is frozen has been handed over ([`Bridge::take`]): a waiting
    /// frame that wakes now has gone over too, and waits for the handover to
    /// be called off.
    taken: bool,
}

/// A frame read and not yet answered, held for whichever runtime answers it.
#[cfg(unix)]
struct HeldFrame {
    stream: std::os::unix::net::UnixStream,
    line: String,
    /// Read while the bridge was frozen: until then it would have waited in
    /// the socket's queue, so it is answered as one accepted afresh is.
    queued: bool,
}

/// One frame on the bridge, for saying what holds a handover up (PRO-589).
#[cfg(unix)]
struct Open {
    /// What it is: the hook event or the control command, once it is read.
    what: String,
    since: std::time::Instant,
    phase: Phase,
}

#[cfg(unix)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    /// Accepted, its line not read yet. A freeze does not wait for it: read
    /// while frozen, it is held. Only taking the bridge waits for it.
    Reading,
    /// Being answered: a freeze waits for it.
    Busy,
    /// Waiting on a person or only reading ([`park`], [`resumable`]), or the
    /// handover itself ([`step_aside`]): a freeze does not wait for it.
    Waiting,
}

/// Name the frames in `phase`, the longest open first, for a refusal.
#[cfg(unix)]
fn named(state: &GateState, phase: Phase) -> String {
    const SHOWN: usize = 3;
    let now = std::time::Instant::now();
    let mut open: Vec<&Open> = state.open.values().filter(|open| open.phase == phase).collect();
    open.sort_by_key(|open| open.since);
    let mut named = open.iter().take(SHOWN)
        .map(|open| format!("{}, open for {} s", open.what, now.saturating_duration_since(open.since).as_secs()))
        .collect::<Vec<_>>().join("; ");
    if open.len() > SHOWN { named.push_str(&format!("; and {} more", open.len() - SHOWN)); }
    named
}

/// What a frame is, by its line: a hook's event or a control command.
#[cfg(unix)]
fn describe(line: &str) -> String {
    #[derive(Deserialize)]
    struct Head { command: Option<String>, event: Option<String> }
    match serde_json::from_str::<Head>(line) {
        Ok(Head { command: Some(command), .. }) => format!("control command {command}"),
        Ok(Head { event: Some(event), .. }) => format!("hook {event}"),
        _ => "a frame that does not parse".into(),
    }
}

/// Whether a frame read while the bridge drains is held: a control command
/// from a CLI, an agent or an automation. Not a hook's event, which its CLI
/// gives ten seconds; and not what the desktop asks for its windows
/// (`runtime.*`), the handover itself among it, which nobody would see held.
#[cfg(unix)]
fn held_while_draining(line: &str) -> bool {
    #[derive(Deserialize)]
    struct Head { command: Option<String> }
    matches!(serde_json::from_str::<Head>(line), Ok(Head { command: Some(command) }) if !command.starts_with("runtime."))
}

/// Whether the other end of `stream` has closed it: nothing more to read,
/// and no one to read a reply. A caller writes its one frame and waits, so
/// an end of stream here is one that stopped waiting.
#[cfg(unix)]
fn hung_up(stream: &std::os::unix::net::UnixStream) -> bool {
    use std::os::fd::AsRawFd;
    let mut byte = 0u8;
    // SAFETY: a one-byte buffer that outlives the call, on an open socket.
    let read = unsafe { libc::recv(stream.as_raw_fd(), std::ptr::addr_of_mut!(byte).cast(), 1, libc::MSG_PEEK | libc::MSG_DONTWAIT) };
    read == 0
}

#[cfg(unix)]
impl GateState {
    /// A frame comes onto the bridge.
    fn open(&mut self, what: impl Into<String>, phase: Phase) -> u64 {
        self.next_open += 1;
        let id = self.next_open;
        self.open.insert(id, Open { what: what.into(), since: std::time::Instant::now(), phase });
        id
    }

    fn count(&self, phase: Phase) -> usize {
        self.open.values().filter(|open| open.phase == phase).count()
    }

    /// Frames being answered, which a freeze waits for.
    fn busy(&self) -> usize { self.count(Phase::Busy) }

    fn set(&mut self, id: u64, phase: Phase) {
        if let Some(open) = self.open.get_mut(&id) { open.phase = phase; }
    }
}

#[cfg(unix)]
impl Gate {
    fn lock(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The state once connections are accepted: not while a handover takes
    /// the bridge.
    fn unsealed(&self) -> std::sync::MutexGuard<'_, GateState> {
        let mut state = self.lock();
        while state.sealed {
            state = self.changed.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        state
    }

    /// The state once no handover holds what is frozen as taken.
    fn untaken(&self) -> std::sync::MutexGuard<'_, GateState> {
        let mut state = self.lock();
        while state.taken {
            state = self.changed.wait(state).unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        state
    }
}

/// One frame being read or answered, by its ticket in [`GateState::open`];
/// given back when it is done or held.
#[cfg(unix)]
struct Busy {
    gate: std::sync::Arc<Gate>,
    id: u64,
}

#[cfg(unix)]
impl Busy {
    /// A frame to answer at once.
    fn begin(gate: &std::sync::Arc<Gate>, what: impl Into<String>) -> Self {
        let id = gate.lock().open(what, Phase::Busy);
        Self { gate: gate.clone(), id }
    }

    /// Its `line` has been read from `stream`: it is answered now, or, the
    /// bridge frozen, held as a frame that waited in the queue, and `None`.
    fn read(&self, stream: std::os::unix::net::UnixStream, line: &str) -> Option<std::os::unix::net::UnixStream> {
        let what = describe(line);
        let mut state = self.gate.lock();
        if state.frozen || (state.draining && held_while_draining(line)) {
            state.held.push(HeldFrame { stream, line: line.to_string(), queued: true });
            return None;
        }
        if let Some(open) = state.open.get_mut(&self.id) {
            open.what = what;
            open.phase = Phase::Busy;
        }
        Some(stream)
    }
}

#[cfg(unix)]
impl Drop for Busy {
    fn drop(&mut self) {
        self.gate.lock().open.remove(&self.id);
        self.gate.changed.notify_all();
    }
}

/// The frame a thread is answering: the bridge it came in on, the frame as
/// it was read, and its ticket there.
#[cfg(unix)]
#[derive(Clone)]
struct Answering {
    gate: std::sync::Arc<Gate>,
    line: Option<String>,
    id: u64,
}

#[cfg(unix)]
thread_local! {
    static FRAME: std::cell::RefCell<Option<Answering>> = const { std::cell::RefCell::new(None) };
}

thread_local! {
    /// What to do once this thread's reply has been written.
    static AFTER_REPLY: std::cell::RefCell<Option<Box<dyn FnOnce() + Send>>> = const { std::cell::RefCell::new(None) };
}

/// Do `then` once the reply to the frame this thread is answering has been
/// written: at once, for a direct call that has no frame.
#[cfg(unix)]
pub(crate) fn after_reply(then: Box<dyn FnOnce() + Send>) {
    #[cfg(unix)]
    if FRAME.with(|frame| frame.borrow().is_some()) {
        AFTER_REPLY.with(|after| *after.borrow_mut() = Some(then));
        return;
    }
    then();
}

/// The frame this thread is answering may be answered again from the start
/// by the runtime that replaces this one (#765): it only waits and reads,
/// like `terminalx wait`. Until this is dropped it is no frame a handover
/// waits for, and it goes over unanswered with what was read; dropped during
/// a handover, it waits for the handover to be called off.
pub(crate) struct Resumable {
    #[cfg(unix)]
    gate: Option<(std::sync::Arc<Gate>, u64, u64)>,
}

pub(crate) fn resumable() -> Resumable {
    #[cfg(unix)]
    {
        let frame = FRAME.with(|frame| frame.borrow().clone());
        let stream = CALLER.with(|caller| caller.borrow().as_ref().and_then(|stream| stream.try_clone().ok()));
        let (Some(Answering { gate, line: Some(line), id }), Some(stream)) = (frame, stream) else { return Resumable { gate: None } };
        let ticket = {
            let mut state = gate.lock();
            state.set(id, Phase::Waiting);
            state.next += 1;
            let ticket = state.next;
            state.resumable.insert(ticket, (stream, line));
            ticket
        };
        gate.changed.notify_all();
        Resumable { gate: Some((gate, ticket, id)) }
    }
    #[cfg(not(unix))]
    Resumable {}
}

#[cfg(unix)]
impl Drop for Resumable {
    fn drop(&mut self) {
        let Some((gate, ticket, id)) = self.gate.take() else { return };
        let mut state = gate.untaken();
        state.resumable.remove(&ticket);
        state.set(id, Phase::Busy);
    }
}

/// The frame this thread is answering is the handover itself: a freeze does
/// not wait for it, and it is answered while frozen (#765).
#[cfg(unix)]
pub(crate) struct Aside {
    #[cfg(unix)]
    gate: Option<(std::sync::Arc<Gate>, u64)>,
}

#[cfg(unix)]
pub(crate) fn step_aside() -> Aside {
    #[cfg(unix)]
    {
        let gate = FRAME.with(|frame| frame.borrow().as_ref().map(|frame| (frame.gate.clone(), frame.id)));
        if let Some((gate, id)) = &gate {
            gate.lock().set(*id, Phase::Waiting);
            gate.changed.notify_all();
        }
        Aside { gate }
    }
    #[cfg(not(unix))]
    Aside {}
}

#[cfg(unix)]
impl Drop for Aside {
    fn drop(&mut self) {
        if let Some((gate, id)) = self.gate.take() {
            gate.lock().set(id, Phase::Busy);
        }
    }
}

/// The frame this thread is answering waits on a person's decision, filed
/// under `request_id`, until this is dropped. Waiting, it is no frame a
/// handover waits for: it goes over with the runtime, and the runtime that
/// takes it waits on for the decision (#765). Dropped while a handover is
/// under way, it waits for the handover to be called off.
pub(crate) struct Parked {
    #[cfg(unix)]
    gate: Option<(std::sync::Arc<Gate>, String, u64)>,
}

/// Park the frame this thread is answering; nothing for a direct call.
pub(crate) fn park(request_id: &str) -> Parked {
    #[cfg(unix)]
    {
        let gate = FRAME.with(|frame| frame.borrow().as_ref().map(|frame| (frame.gate.clone(), frame.id)));
        let stream = CALLER.with(|caller| caller.borrow().as_ref().and_then(|stream| stream.try_clone().ok()));
        let (Some((gate, id)), Some(stream)) = (gate, stream) else { return Parked { gate: None } };
        {
            let mut state = gate.lock();
            state.set(id, Phase::Waiting);
            state.parked.insert(request_id.to_string(), stream);
        }
        gate.changed.notify_all();
        Parked { gate: Some((gate, request_id.to_string(), id)) }
    }
    #[cfg(not(unix))]
    {
        let _ = request_id;
        Parked {}
    }
}

#[cfg(unix)]
impl Drop for Parked {
    fn drop(&mut self) {
        let Some((gate, request_id, id)) = self.gate.take() else { return };
        // Answered before the handover took the bridge: the frame is answered
        // here, and counts as under way again, which the handover waits for
        // or is called off for; still parked, its card is one no tab waits
        // on, which calls the handover off too (`Bridge::take`). Once taken
        // it went over with the runtime.
        let mut state = gate.untaken();
        state.parked.remove(&request_id);
        state.set(id, Phase::Busy);
    }
}

/// A launch's hook and control sockets, as `serve` left them listening.
#[cfg_attr(not(unix), allow(dead_code))]
pub struct Bridge {
    publisher: std::sync::Arc<std::sync::Mutex<Publisher>>,
    /// The publisher's gate, held here so that nothing takes the gate and
    /// then the publisher: the publisher's tick takes them the other way.
    #[cfg(unix)]
    gate: std::sync::Arc<Gate>,
}

/// The hook bridge as it is handed over: its sockets, and the frames on
/// them that have yet to be answered (#765).
#[cfg(unix)]
pub(crate) struct Frozen {
    /// The launch's own socket, which its tabs dial.
    pub own: std::os::fd::OwnedFd,
    /// The home's published socket and its lock, while this launch holds them.
    pub published: Option<(std::os::fd::OwnedFd, std::os::fd::OwnedFd)>,
    /// Frames read and not yet answered, with what was read, and whether
    /// each was read while frozen, from what would have waited in the queue.
    pub held: Vec<(std::os::fd::OwnedFd, String, bool)>,
    /// Frames waiting on a decision, by its request id.
    pub parked: Vec<(String, std::os::fd::OwnedFd)>,
}

/// What a runtime takes over of its predecessor's hook bridge.
#[cfg(unix)]
pub struct Adopted {
    pub own: std::os::fd::OwnedFd,
    pub published: Option<(std::os::fd::OwnedFd, std::os::fd::OwnedFd)>,
    /// As [`Frozen::held`].
    pub held: Vec<(std::os::unix::net::UnixStream, String, bool)>,
}

#[cfg(unix)]
impl Bridge {
    /// Stop answering frames, once every frame under way has been answered,
    /// has parked on a decision or only waits ([`Resumable`]): a new one
    /// waits in its socket's queue, or, read already, is held. A frame still
    /// under way after `within` calls the freeze off. What is frozen is
    /// taken with [`Self::take`].
    pub(crate) fn freeze(&self, within: Duration) -> anyhow::Result<()> {
        let deadline = std::time::Instant::now() + within;
        let mut state = self.gate.lock();
        state.frozen = true;
        while state.busy() > 0 {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                // Named, so that a handover refused again and again says
                // what keeps it waiting (PRO-589).
                let open = named(&state, Phase::Busy);
                drop(state);
                self.thaw();
                anyhow::bail!("A hook or control request did not finish in time: {open}");
            }
            state = self.gate.changed.wait_timeout(state, left).unwrap_or_else(|poisoned| poisoned.into_inner()).0;
        }
        Ok(())
    }

    /// Hand over what is frozen: the sockets, and the frames not yet
    /// answered. Taken once every tab is held, when no waiting frame can be
    /// answered any more: an answer is given under its tab's lock, by taking
    /// the card's sender from the tab. `awaited` says whether a held tab
    /// still waits on a card. A frame answered before the tabs were held
    /// calls this off, to be answered here and the handover tried again:
    /// one under way again, and one whose thread has yet to wake, which is
    /// still parked on a card no tab waits on. Taken with the handover, the
    /// runtime that takes over would find no card for it.
    pub(crate) fn take(&self, awaited: impl Fn(&str) -> bool) -> anyhow::Result<Frozen> {
        use anyhow::Context;
        use std::os::fd::OwnedFd;
        // The publisher first, and let go: its tick takes the gate under it.
        // Nothing changes its claim meanwhile, as a tick does nothing frozen.
        let (own, published) = {
            let publisher = self.publisher.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            let own = OwnedFd::from(publisher.listener.try_clone().context("duplicate the hook socket")?);
            let published = match &publisher.held {
                Some(claim) => Some((OwnedFd::from(claim.listener.try_clone()?), OwnedFd::from(claim._lock.try_clone()?))),
                None => None,
            };
            (own, published)
        };
        let mut state = self.gate.lock();
        anyhow::ensure!(state.frozen, "the hook bridge is not frozen");
        // No connection is accepted from here on: one still in the queue goes
        // over with the socket. One accepted and still being read is, once
        // read, held; its hook wrote it at once, so that is no wait.
        state.sealed = true;
        let deadline = std::time::Instant::now() + FRAME_READ;
        while state.count(Phase::Reading) > 0 {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                anyhow::bail!("A hook or control frame was still being read as the runtime came to rest: {}", named(&state, Phase::Reading));
            }
            state = self.gate.changed.wait_timeout(state, left).unwrap_or_else(|poisoned| poisoned.into_inner()).0;
        }
        if state.busy() > 0 || state.parked.keys().any(|request_id| !awaited(request_id)) {
            let open = if state.busy() > 0 { format!(" ({})", named(&state, Phase::Busy)) } else { String::new() };
            anyhow::bail!("A permission was answered as the runtime came to rest{open}.");
        }
        let held = state.held.iter().map(|frame| (&frame.stream, &frame.line, frame.queued))
            .chain(state.resumable.values().map(|(stream, line)| (stream, line, false)))
            .map(|(stream, line, queued)| Ok((OwnedFd::from(stream.try_clone()?), line.clone(), queued))).collect::<std::io::Result<_>>()?;
        let parked = state.parked.iter().map(|(id, stream)| Ok((id.clone(), OwnedFd::from(stream.try_clone()?)))).collect::<std::io::Result<_>>()?;
        state.taken = true;
        Ok(Frozen { own, published, held, parked })
    }

    /// Answer frames again: the handover was called off. Frames held
    /// meanwhile are answered now.
    pub(crate) fn thaw(&self) {
        let held = {
            let mut state = self.gate.lock();
            state.frozen = false;
            state.taken = false;
            state.sealed = false;
            // Still draining, a command goes on being held: only what a
            // drain does not hold is answered now.
            let draining = state.draining;
            let (kept, answered): (Vec<_>, Vec<_>) = std::mem::take(&mut state.held).into_iter()
                .partition(|frame| draining && frame.queued && held_while_draining(&frame.line));
            state.held = kept;
            answered
        };
        self.gate.changed.notify_all();
        for frame in held {
            self.dispatch(frame);
        }
    }

    /// Wait, freezing nothing, until no frame is being answered, or until
    /// `deadline`: whether none is. A handover that begins then finds the
    /// bridge at rest at once, where one begun at any other moment waits on
    /// whatever happens to be under way, with every hook held meanwhile.
    pub(crate) fn quiet_by(&self, deadline: std::time::Instant) -> bool {
        let mut state = self.gate.lock();
        while state.busy() > 0 {
            let left = deadline.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() { return false; }
            state = self.gate.changed.wait_timeout(state, left).unwrap_or_else(|poisoned| poisoned.into_inner()).0;
        }
        true
    }

    /// The frames being answered, the longest open first, for saying what a
    /// handover is waiting for; nothing when none is.
    pub(crate) fn busy_named(&self) -> Option<String> {
        let state = self.gate.lock();
        (state.busy() > 0).then(|| named(&state, Phase::Busy))
    }

    /// Hold every control command read from here on, as one read while
    /// frozen is held, until [`Self::undrain`] or the handover: those under
    /// way come to an end and none takes their place, so a quiet moment
    /// comes however many agents are at work. Hook events and the desktop's
    /// own requests are answered meanwhile.
    pub(crate) fn drain(&self) {
        self.gate.lock().draining = true;
    }

    /// Answer control commands again, those held while draining first.
    pub(crate) fn undrain(&self) {
        let held = {
            let mut state = self.gate.lock();
            if !state.draining { return; }
            state.draining = false;
            // Frozen, they stay held with the rest, for the thaw or the handover.
            if state.frozen { Vec::new() } else { std::mem::take(&mut state.held) }
        };
        self.gate.changed.notify_all();
        for frame in held {
            self.dispatch(frame);
        }
    }

    /// Answer a held frame as any frame is answered.
    fn dispatch(&self, HeldFrame { stream, line, queued }: HeldFrame) {
        // A command whose caller gave up while it was held is not carried
        // out behind their back: told it failed, they send it again, and a
        // prompt would arrive twice. A hook's event is taken in regardless.
        if held_while_draining(&line) && hung_up(&stream) {
            log::info!("a held {} was dropped: whoever sent it stopped waiting", describe(&line));
            return;
        }
        let dispatch = self.publisher.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).dispatch.clone();
        let busy = Busy::begin(&self.gate, describe(&line));
        // A frame held across handover has no surviving positive network
        // authority. Keep its local work usable, without renewing old fetches.
        // One read while frozen would have waited in the socket's queue
        // otherwise, for whichever runtime accepted it now: it is answered
        // with the authority such a frame gets, as of now (PRO-589).
        let ticket = if queued { crate::data_privacy::Ticket::default() } else { crate::data_privacy::Ticket::denied() };
        let spawned = std::thread::Builder::new().name("hook-frame".into()).spawn(move || {
            crate::github_process::with_ticket(ticket, || {
                answer_frame(stream, busy, |_| dispatch(&line), Some(line.clone()));
            });
        });
        if let Err(error) = spawned { log::warn!("answer a held hook frame: {error}"); }
    }

    /// Answer a frame the runtime this one replaced had parked on a
    /// decision: `answer` waits on for it, as the frame's own thread did.
    pub(crate) fn resume(&self, stream: std::os::unix::net::UnixStream, answer: impl FnOnce() -> HookReply + Send + 'static) {
        let busy = Busy::begin(&self.gate, "a decision handed over by the runtime this one replaced");
        let spawned = std::thread::Builder::new().name("hook-frame".into()).spawn(move || {
            answer_frame(stream, busy, |_| serde_json::to_value(answer()).unwrap_or_default(), None);
        });
        if let Err(error) = spawned { log::warn!("wait on a handed-over decision: {error}"); }
    }
}

/// Whether a live listener holds the socket at `path`.
///
/// This is what protects a launch that holds no lock, which is every build
/// from before the lock existed: its socket answers, so it is left alone. A
/// refusal is asked again before it is believed, because a listener that is
/// momentarily behind refuses too; and anything that is neither an answer nor
/// a plain "nobody here" is read as an answer, since the cost of being wrong
/// that way is only that this launch publishes later.
#[cfg(unix)]
fn answers(path: &Path) -> bool {
    use std::io::ErrorKind;
    use std::os::unix::fs::FileTypeExt;

    match std::fs::symlink_metadata(path) {
        // Not a socket at all, so nothing can be listening on it.
        Ok(meta) if !meta.file_type().is_socket() => return false,
        Err(error) if error.kind() == ErrorKind::NotFound => return false,
        _ => {}
    }
    for attempt in 0..3 {
        match std::os::unix::net::UnixStream::connect(path) {
            Ok(_) => return true,
            Err(error) if error.kind() == ErrorKind::NotFound => return false,
            Err(error) if error.kind() == ErrorKind::ConnectionRefused => {
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
            Err(_) => return true,
        }
    }
    false
}

/// Which file is at `path`, to tell this launch's socket from one that
/// replaced it.
#[cfg(unix)]
fn file_identity(path: &Path) -> std::io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(path)?;
    Ok((meta.dev(), meta.ino()))
}

/// This launch's hold on the home's published socket.
struct Claim {
    /// `run/hooks.lock`, locked. The lock is the OS's, so a crashed holder
    /// releases it without anyone deciding the holder is dead.
    _lock: std::fs::File,
    #[cfg(unix)]
    identity: (u64, u64),
    /// The published socket's listener, as a handover passes it on (#765).
    #[cfg(unix)]
    listener: std::os::unix::net::UnixListener,
}

/// Keeps one launch on the home's published socket.
///
/// A launch publishes when it holds `run/hooks.lock` and nothing live is
/// already answering on the published socket. Otherwise it serves its own
/// tabs on its own socket and asks again later, so the home passes on when
/// its holder exits, and is put back if a build that predates the lock
/// replaced the published socket and then went.
struct Publisher {
    socket: PathBuf,
    lock: PathBuf,
    token_file: PathBuf,
    own: PathBuf,
    token: String,
    dispatch: Dispatch,
    #[cfg(unix)]
    frames: Frames,
    published: std::sync::Arc<std::sync::atomic::AtomicBool>,
    held: Option<Claim>,
    /// Why the last attempt did not publish, so a standing reason is logged
    /// once and not every few seconds.
    waiting_on: Option<String>,
    /// The launch's own socket's listener, as a handover passes it on (#765).
    #[cfg(unix)]
    listener: std::os::unix::net::UnixListener,
    /// A named pipe cannot be taken from the process serving it, so once this
    /// launch serves the shared pipe it does for good.
    #[cfg(windows)]
    pipe_up: bool,
}

impl Publisher {
    fn tick(&mut self) {
        // The home's socket and lock go over with a handover as they are.
        #[cfg(unix)]
        if self.frames.gate.lock().frozen {
            return;
        }
        if self.held.as_ref().is_some_and(|claim| self.still_ours(claim)) {
            return;
        }
        // Dropping the claim releases the lock. The listener on a socket that
        // was replaced stays behind on a file nobody can dial any more.
        if self.held.take().is_some() {
            self.published.store(false, std::sync::atomic::Ordering::Relaxed);
            log::warn!("{} was replaced by another process; this launch's tabs are unaffected on {}", self.socket.display(), self.own.display());
        }
        match self.claim() {
            Ok(claim) => {
                self.held = Some(claim);
                self.waiting_on = None;
                self.published.store(true, std::sync::atomic::Ordering::Relaxed);
                log::info!("published socket at {}", self.socket.display());
            }
            Err(error) => {
                let reason = format!("{error:#}");
                if self.waiting_on.as_deref() != Some(&reason) {
                    log::warn!(
                        "not publishing {}: {reason}; this launch's tabs use {} and shells without an app environment reach the other launch",
                        self.socket.display(),
                        self.own.display()
                    );
                    self.waiting_on = Some(reason);
                }
            }
        }
    }

    #[cfg(unix)]
    fn still_ours(&self, claim: &Claim) -> bool {
        file_identity(&self.socket).is_ok_and(|identity| identity == claim.identity)
    }

    #[cfg(windows)]
    fn still_ours(&self, _claim: &Claim) -> bool {
        true
    }

    /// Take the home: the lock, then the published socket, then the token.
    /// Any failure gives back whatever was taken, so a launch never holds the
    /// lock without also being the one a shell reaches.
    fn claim(&mut self) -> anyhow::Result<Claim> {
        use anyhow::Context;

        let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&self.lock).context("open the home's lock")?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => anyhow::bail!("another TerminalX holds this data directory"),
            Err(std::fs::TryLockError::Error(error)) => return Err(anyhow::Error::new(error).context("lock the data directory")),
        }
        #[cfg(unix)]
        {
            if answers(&self.socket) {
                anyhow::bail!("a TerminalX that holds no lock (an older build) is listening there");
            }
            let _ = std::fs::remove_file(&self.socket);
            let listener = bind(&self.socket).context("bind the published socket")?;
            let identity = file_identity(&self.socket)?;
            // Only once the socket answers: a shell that reads the token must
            // find the app it belongs to.
            if let Err(error) = crate::store::write_atomic(&self.token_file, self.token.as_bytes()) {
                drop(listener);
                let _ = std::fs::remove_file(&self.socket);
                return Err(error.context("write the control token"));
            }
            let kept = listener.try_clone()?;
            accept(listener, self.dispatch.clone(), self.frames.clone())?;
            Ok(Claim { _lock: lock, identity, listener: kept })
        }
        #[cfg(windows)]
        {
            // Creating the first instance of the pipe fails while any other
            // launch serves it, so a live launch is never replaced here.
            if !self.pipe_up {
                let dispatch = self.dispatch.clone();
                crate::pipe_transport::serve(self.socket.clone(), move |line, client| format!("{}\n", answer_frame_from(client, || dispatch(&line)))).context("serve the published pipe")?;
                self.pipe_up = true;
            }
            crate::store::write_atomic(&self.token_file, self.token.as_bytes()).context("write the control token")?;
            Ok(Claim { _lock: lock })
        }
    }
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
        let capability = if token_matches(control_token, &request.token) {
            None
        } else if let Some(cap) = verify_tab_token(control_token, &request.token) {
            Some(cap)
        } else {
            let response = crate::control::ControlResponse::failure(
                request.id,
                crate::control::ControlError::new(
                    "unauthorized",
                    "The control token is missing or does not match this app launch.",
                    Some("Restart an app-launched tab, or let a human shell read TERMINALX_HOME/run/control.token.".into()),
                ),
            );
            return serde_json::to_value(response).unwrap_or_default();
        };
        serde_json::to_value(with_caller_capability(capability, || control_handler(request))).unwrap_or_default()
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
    let local_decision = args.next().as_deref() == Some("--local-owner-decision")
        && matches!(event.as_str(), "PermissionRequest" | "PreToolUse");
    // Read stdin first, always: the CLI closes the pipe once the hook has
    // taken it, and exiting mid-write surfaces to the CLI as a broken pipe.
    let mut stdin = String::new();
    let _ = std::io::stdin().read_to_string(&mut stdin);
    // Never nothing: a permission hook that prints an empty stdout is read as
    // a refusal, so silence has to be spelt out as an empty object.
    let out = ask_app_with_policy(&event, &stdin, local_decision).unwrap_or_else(|| {
        if local_decision { denied_hook(&event) } else { serde_json::json!({}) }
    });
    let _ = std::io::stdout().write_all(out.to_string().as_bytes());
    let _ = std::io::stdout().write_all(b"\n");
    true
}

/// The `statusline` subcommand. Claude sends its ordinary status JSON on
/// stdin; the app takes `rate_limits` and the model and effort in force
/// (#404), and silence keeps the CLI's own terminal view free of a second
/// status line.
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
    ask_app_with_policy(event, stdin, false)
}

fn denied_hook(event: &str) -> Value {
    // There was no authenticated answer from the owner. Stay fail-closed,
    // but do not attribute a disconnected or stale launch to a human denial.
    let reason = "TerminalX could not verify this session's permissions. The action was blocked because the session owner is unavailable or no longer recognizes this launch.";
    if event == "PreToolUse" {
        serde_json::json!({ "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }})
    } else {
        serde_json::json!({ "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": { "behavior": "deny", "message": reason },
        }})
    }
}

fn ask_app_with_policy(event: &str, stdin: &str, local_decision: bool) -> Option<Value> {
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
    let timeout = if local_decision { crate::local_runtime::permissions::BRIDGE_WAIT } else { reply_timeout(&frame.event) };
    let mut bytes = serde_json::to_vec(&frame).ok()?;
    bytes.push(b'\n');
    #[cfg(unix)]
    let line = {
        let started = std::time::Instant::now();
        let exchanged = (|| -> Result<String, (&'static str, String)> {
            let failed = |stage: &'static str| move |error: std::io::Error| (stage, error.to_string());
            let mut stream = UnixStream::connect(&path).map_err(failed("connect"))?;
            stream.set_read_timeout(Some(timeout)).map_err(failed("connect"))?;
            stream.set_write_timeout(Some(FRAME_WRITE)).map_err(failed("connect"))?;
            stream.write_all(&bytes).and_then(|()| stream.flush()).map_err(failed("write"))?;
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).map_err(failed("read the reply"))?;
            if line.trim().is_empty() {
                return Err(("read the reply", "the connection closed without a reply".into()));
            }
            Ok(line)
        })();
        // Never silently: the runtime logs what could not be delivered.
        match exchanged {
            Ok(line) => line,
            Err((stage, error)) => {
                note_failed_send(Path::new(&path), &frame, stage, &error, bytes.len(), started.elapsed());
                return None;
            }
        }
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

    #[cfg(unix)]
    #[test]
    fn permission_wait_observes_hook_disconnect_without_consuming_bytes() {
        let (owner, mut hook) = std::os::unix::net::UnixStream::pair().unwrap();
        CALLER.with(|caller| *caller.borrow_mut() = Some(std::sync::Arc::new(owner)));
        assert!(caller_connected());
        hook.write_all(b"x").unwrap();
        assert!(!caller_connected());
        let mut byte = [0];
        CALLER.with(|caller| caller.borrow().as_ref().unwrap().as_ref().read_exact(&mut byte)).unwrap();
        assert_eq!(byte, [b'x']);
        drop(hook);
        assert!(!caller_connected());
        CALLER.with(|caller| *caller.borrow_mut() = None);
    }

    #[test]
    fn owner_hook_transport_failure_is_a_denial_for_both_gates() {
        assert_eq!(denied_hook("PermissionRequest")["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert_eq!(denied_hook("PreToolUse")["hookSpecificOutput"]["permissionDecision"], "deny");
    }

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

    /// A frame over the pipe is answered as its client's, by the process the
    /// pipe names; a call made inside this process has no sender.
    #[cfg(windows)]
    #[test]
    fn a_frame_over_the_named_pipe_is_its_clients() {
        let _home = crate::store::temp_home();
        let endpoint = prepare_control().unwrap();
        let said = |peer: Peer| match peer {
            Peer::Pid(pid) => json!({"pid": pid}),
            Peer::InProcess => json!({"pid": "in-process"}),
            Peer::Unreadable => json!({"pid": "unreadable"}),
        };
        serve(endpoint.clone(), move |_frame| HookReply { output: Some(said(caller())), refused: None },
            move |request| crate::control::ControlResponse::success(request.id, said(caller()))).unwrap();
        let me = std::process::id() as i32;
        for _ in 0..3 {
            let response = crate::control::call("status", json!({}), Duration::from_secs(2)).unwrap();
            assert_eq!(response.result.unwrap()["pid"], me);
        }
        let hook = HookFrame { tab: "t".into(), session: "s".into(), token: "token".into(), event: "Stop".into(), payload: Value::Null };
        let response = crate::pipe_transport::exchange(&endpoint.socket, format!("{}\n", serde_json::to_string(&hook).unwrap()).into_bytes(), Duration::from_secs(2)).unwrap();
        assert_eq!(serde_json::from_str::<HookReply>(&response).unwrap().output.unwrap()["pid"], me);
        assert_eq!(caller(), Peer::InProcess);
        assert_eq!(caller_pid(), None);
        // The thread that answered keeps no sender once its frame is answered.
        assert_eq!(answer_frame_from(7, || json!(caller_pid())), json!(7));
        assert_eq!(caller(), Peer::InProcess);
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
        let (endpoint, _, _publisher) = launch("only");
        let token_path = control_token_path().unwrap();
        assert_eq!(std::fs::read_to_string(token_path).unwrap(), endpoint.token);
        assert_eq!(std::fs::metadata(control_token_path().unwrap()).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn private_window_authenticates_without_taking_home_after_owner_loss() {
        use std::os::unix::net::UnixListener;
        let _home = crate::store::temp_home();
        let published = socket_path().unwrap();
        let token = control_token_path().unwrap();
        let lock_path = run_dir().unwrap().join("hooks.lock");
        let window = prepare_control().unwrap();
        serve_private(window.clone(), |_| HookReply::default(), |request| {
            crate::control::ControlResponse::success(request.id, json!({"window": true}))
        }).unwrap();
        assert!(!published.exists());
        assert!(!token.exists());
        assert!(!lock_path.exists());
        let call = |credential: &str| send(&window.socket, &json!({"id":"window", "command":"status", "token":credential}));
        assert_eq!(call("wrong")["error"]["code"], "unauthorized");
        assert_eq!(call(&window.token)["result"]["window"], true);

        let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&lock_path).unwrap();
        lock.try_lock().unwrap();
        let owner = UnixListener::bind(&published).unwrap();
        std::fs::write(&token, "owner-credential").unwrap();
        let socket_identity = file_identity(&published).unwrap();
        let lock_identity = file_identity(&lock_path).unwrap();
        assert_eq!(call(&window.token)["result"]["window"], true);
        drop(owner);
        drop(lock);
        // Longer than the ordinary publication retry: a private window must
        // never begin publishing when its background owner disappears.
        std::thread::sleep(PUBLISH_RETRY + Duration::from_millis(100));
        assert!(!window.publishes());
        assert_eq!(file_identity(&published).unwrap(), socket_identity);
        assert_eq!(file_identity(&lock_path).unwrap(), lock_identity);
        assert_eq!(std::fs::read_to_string(&token).unwrap(), "owner-credential");
        assert_eq!(call("wrong")["error"]["code"], "unauthorized");
        assert_eq!(call(&window.token)["result"]["window"], true);

        let (restarted, _, _publisher) = launch("restarted-owner");
        assert!(restarted.publishes());
        assert_eq!(shell_reaches(), "restarted-owner");
        assert_eq!(std::fs::read_to_string(&token).unwrap(), restarted.token);
        assert!(!window.publishes());
        assert_eq!(call(&window.token)["result"]["window"], true);
    }

    #[cfg(unix)]
    #[test]
    fn every_launch_gets_a_socket_of_its_own_and_touches_nothing_published() {
        let _home = crate::store::temp_home();
        let first = prepare_control().unwrap();
        let second = prepare_control().unwrap();
        assert_ne!(first.socket, second.socket);
        for endpoint in [&first, &second] {
            assert_ne!(endpoint.socket, socket_path().unwrap());
            let name = endpoint.socket.file_name().unwrap().to_string_lossy().into_owned();
            assert_eq!(launch_pid(&name), Some(std::process::id()), "{name}");
            assert!(!endpoint.publishes(), "nothing is published before the launch listens");
        }
        assert!(!socket_path().unwrap().exists());
        assert!(!control_token_path().unwrap().exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_crashed_launch_s_own_socket_is_swept_and_a_live_one_is_kept() {
        use std::os::unix::net::UnixListener;

        let _home = crate::store::temp_home();
        // No process has these pids: macOS stops at 99999, and Linux would
        // need its largest pid_max and a million processes behind it.
        let dead = own_socket_path(1_000_001, 0).unwrap();
        drop(UnixListener::bind(&dead).unwrap());
        assert!(dead.exists(), "a listener that goes away leaves its file");
        let numbered = own_socket_path(1_000_001, 3).unwrap();
        drop(UnixListener::bind(&numbered).unwrap());
        let live_path = own_socket_path(1_000_002, 0).unwrap();
        let _live = UnixListener::bind(&live_path).unwrap();
        // A socket between `bind` and `listen` refuses a connection exactly
        // as a dead one does. Its process is alive, and that is what keeps it.
        let starting = own_socket_path(std::os::unix::process::parent_id(), 0).unwrap();
        drop(UnixListener::bind(&starting).unwrap());

        let _endpoint = prepare_control().unwrap();
        until("the dead launches' sockets are swept", sweep_stale_sockets, || !dead.exists() && !numbered.exists());
        assert!(live_path.exists());
        assert!(starting.exists(), "a refused connection is not enough while the process lives");
    }

    #[cfg(unix)]
    #[test]
    fn a_home_too_long_for_a_socket_address_still_gets_a_working_socket() {
        let home = crate::store::temp_home();
        let _ = &home;
        let long = std::env::temp_dir().join(format!("terminalx-long-{}", std::process::id())).join("h".repeat(90));
        std::fs::create_dir_all(&long).unwrap();
        std::env::set_var("TERMINALX_HOME", &long);
        assert!(!fits_socket_address(&run_dir().unwrap().join(format!("hooks-{}.sock", std::process::id()))));

        let (endpoint, _, mut publisher) = launch("long");
        assert!(fits_socket_address(&endpoint.socket), "{}", endpoint.socket.display());
        let hook = json!({"tab": "t", "session": "s", "token": "t", "event": "Stop", "payload": {}});
        assert_eq!(send(&endpoint.socket, &hook)["output"]["instance"], "long");
        // The published socket does not fit either, and that costs the launch
        // nothing but the shell's way in.
        assert!(!endpoint.publishes());
        publisher.tick();
        assert!(!endpoint.publishes());
        let _ = std::fs::remove_dir_all(long.parent().unwrap());
        let _ = std::fs::remove_dir_all(endpoint.socket.parent().unwrap());
    }

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

    /// Launch one "instance" on the current home, as `serve` does less its
    /// timer: the endpoint, listening on its own socket, with every hook
    /// frame it receives recorded by tab, and the publisher after its first
    /// look at the published socket. Every later look is the test's to ask
    /// for, so nothing here depends on when a thread gets to run.
    #[cfg(unix)]
    fn launch(name: &'static str) -> (ControlEndpoint, std::sync::Arc<std::sync::Mutex<Vec<String>>>, Publisher) {
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let endpoint = prepare_control().unwrap();
        let recorded = seen.clone();
        let mut publisher = listen(
            endpoint.clone(),
            move |frame| {
                recorded.lock().unwrap().push(frame.tab.clone());
                HookReply { output: Some(json!({"instance": name})), refused: None }
            },
            move |request| crate::control::ControlResponse::success(request.id, json!({"instance": name})),
        )
        .unwrap();
        publisher.tick();
        (endpoint, seen, publisher)
    }

    /// Do `step` until `done`, for something that is free a moment after the
    /// line that freed it.
    ///
    /// A lock or a listener is released when its last descriptor closes, and
    /// this test process is not the only holder of its descriptors: other
    /// tests start child processes, and a child carries a copy of every
    /// descriptor that was open when it was forked until it execs. So a lock
    /// just dropped here can stay held, and a socket just closed can go on
    /// answering, until some other test's child gets as far as its `exec`.
    /// Nothing is slept through and no amount of time is expected: each step
    /// is asked for outright, and the deadline is one only a hung machine
    /// reaches.
    #[cfg(unix)]
    fn until(what: &str, mut step: impl FnMut(), done: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(120);
        loop {
            step();
            if done() {
                return;
            }
            assert!(std::time::Instant::now() < deadline, "never came true: {what}");
            std::thread::yield_now();
        }
    }

    /// What a shell with no app environment reaches: the published socket,
    /// with the published token.
    #[cfg(unix)]
    fn shell_reaches() -> Value {
        let token = std::fs::read_to_string(control_token_path().unwrap()).unwrap();
        let status = json!({"id": "r", "command": "status", "token": token, "params": {}});
        send(&socket_path().unwrap(), &status)["result"]["instance"].clone()
    }

    #[cfg(unix)]
    fn stop_hook(tab: &str) -> Value {
        json!({"tab": tab, "session": "s", "token": "t", "event": "Stop", "payload": {}})
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

    /// Frames held up behind a wedged owner take every place; the next ones
    /// are answered at once instead of each getting a thread that never
    /// returns (#661). A deciding hook gets nothing to act on.
    #[cfg(unix)]
    #[test]
    fn frames_past_the_limit_are_refused_without_a_thread_each() {
        use std::os::unix::net::UnixStream;
        use std::sync::{mpsc, Arc, Condvar, Mutex};
        let dir = tempfile::Builder::new().prefix("tx").tempdir().unwrap();
        let socket = dir.path().join("s.sock");
        let held = Arc::new((Mutex::new(true), Condvar::new()));
        let (entered, inside) = mpsc::channel::<()>();
        let entered = Mutex::new(entered);
        let gate = held.clone();
        let dispatch: Dispatch = Arc::new(move |line: &str| {
            if line.contains("\"command\"") {
                return json!({"ok": true});
            }
            entered.lock().unwrap().send(()).unwrap();
            let (lock, released) = &*gate;
            // A regression must fail rather than hang the test runner.
            let _ = released.wait_timeout_while(lock.lock().unwrap(), Duration::from_secs(10), |held| *held).unwrap();
            json!({"output": {"answered": true}})
        });
        accept(bind(&socket).unwrap(), dispatch, Frames::new(2).unwrap()).unwrap();
        let hook = json!({"tab": "t", "session": "s", "token": "t", "event": "PreToolUse", "payload": {}});
        let parked: Vec<_> = (0..2).map(|_| {
            let mut stream = UnixStream::connect(&socket).unwrap();
            stream.write_all(format!("{hook}\n").as_bytes()).unwrap();
            inside.recv_timeout(Duration::from_secs(5)).unwrap();
            stream
        }).collect();

        let control = send(&socket, &json!({"id": "busy-check", "command": "status", "token": "x", "params": {}}));
        assert_eq!(control["ok"], false, "{control}");
        assert_eq!(control["id"], "busy-check");
        assert_eq!(control["error"]["code"], "busy");
        let refused = send(&socket, &hook);
        assert!(refused.get("output").is_none(), "a refused deciding hook must not authorize anything: {refused}");
        assert!(refused["refused"].as_str().is_some_and(|reason| reason.contains("too many requests")), "{refused}");

        *held.0.lock().unwrap() = false;
        held.1.notify_all();
        for stream in parked {
            let mut reply = String::new();
            BufReader::new(stream).read_line(&mut reply).unwrap();
            assert!(reply.contains("answered"), "{reply}");
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while send(&socket, &json!({"id": "again", "command": "status", "token": "x", "params": {}}))["ok"] != true {
            assert!(std::time::Instant::now() < deadline, "finished frames did not give their places back");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_second_instance_on_the_same_home_leaves_the_first_one_s_tabs_connected() {
        // Issue #202: the installed app and a dev build on one home. The
        // second launch used to delete the socket the first one's tabs were
        // given and overwrite its control token, so every hook from the first
        // instance's CLIs reached an app that had never heard of them.
        let _home = crate::store::temp_home();
        let (first, first_seen, mut first_publisher) = launch("first");
        let (second, second_seen, mut second_publisher) = launch("second");

        let hook = |tab: &str| json!({"tab": tab, "session": "s", "token": "t", "event": "Stop", "payload": {}});
        assert_eq!(send(&first.socket, &hook("first-tab"))["output"]["instance"], "first");
        assert_eq!(send(&second.socket, &hook("second-tab"))["output"]["instance"], "second");
        assert_eq!(*first_seen.lock().unwrap(), ["first-tab"]);
        assert_eq!(*second_seen.lock().unwrap(), ["second-tab"]);

        // A shell with no app environment still reaches the first instance
        // through the home's published socket and token.
        // However often either looks again, and in whichever order.
        for _ in 0..3 {
            second_publisher.tick();
            first_publisher.tick();
        }
        assert!(first.publishes());
        assert!(!second.publishes());
        assert_eq!(std::fs::read_to_string(control_token_path().unwrap()).unwrap(), first.token);
        assert_eq!(shell_reaches(), "first");
        // Neither launch's tabs dial the published socket, so nothing done to
        // that socket can cut them off.
        assert_ne!(first.socket, socket_path().unwrap());
        assert_ne!(second.socket, socket_path().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_live_listener_that_holds_no_lock_is_never_replaced() {
        use std::os::unix::net::{UnixListener, UnixStream};

        // The 2026-09-30 incident: an app from a build that takes no lock is
        // running, and a newer build starts on the same home. The lock is
        // free, so only the socket itself says somebody is there.
        let _home = crate::store::temp_home();
        let published = socket_path().unwrap();
        let older = UnixListener::bind(&published).unwrap();
        std::fs::write(control_token_path().unwrap(), "the-older-build-s-token").unwrap();
        let before = file_identity(&published).unwrap();

        let (newer, _, mut publisher) = launch("newer");
        assert!(!newer.publishes());
        assert_ne!(newer.socket, published);
        // Several more looks at it change nothing while it lives.
        for _ in 0..6 {
            publisher.tick();
        }
        assert!(!newer.publishes());
        assert_eq!(file_identity(&published).unwrap(), before, "the older build's socket file is the one still there");
        assert_eq!(std::fs::read_to_string(control_token_path().unwrap()).unwrap(), "the-older-build-s-token");
        // It is still the one that hears whoever dials the published path.
        // A connection is in the listener's queue by the time `connect`
        // returns, so the caller's is there, behind the looks taken above;
        // those were closed without a word and read as empty.
        let mut caller = UnixStream::connect(&published).unwrap();
        caller.write_all(b"is anyone there\n").unwrap();
        caller.shutdown(std::net::Shutdown::Write).unwrap();
        older.set_nonblocking(true).unwrap();
        let mut heard = Vec::new();
        while let Ok((mut stream, _)) = older.accept() {
            stream.set_nonblocking(false).unwrap();
            let mut said = String::new();
            stream.read_to_string(&mut said).unwrap();
            heard.push(said);
        }
        assert_eq!(heard.last().map(String::as_str), Some("is anyone there\n"));
        assert!(heard[..heard.len() - 1].iter().all(String::is_empty), "{heard:?}");
        // The newer launch serves its own tabs on its own socket meanwhile.
        assert_eq!(send(&newer.socket, &stop_hook("newer-tab"))["output"]["instance"], "newer");

        // Once the older app has gone, the newer one takes the home over.
        drop(older);
        until("the newer launch publishes", || publisher.tick(), || newer.publishes());
        assert_eq!(shell_reaches(), "newer");
    }

    #[cfg(unix)]
    #[test]
    fn the_home_passes_to_a_running_launch_when_its_owner_exits() {
        use std::os::unix::net::UnixListener;

        // The owner, as another process would hold the home: the lock, the
        // published socket and the token.
        let _home = crate::store::temp_home();
        let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(run_dir().unwrap().join("hooks.lock")).unwrap();
        lock.try_lock().unwrap();
        let owner = UnixListener::bind(socket_path().unwrap()).unwrap();
        std::fs::write(control_token_path().unwrap(), "the-owner-s-token").unwrap();

        let (second, _, mut publisher) = launch("second");
        for _ in 0..4 {
            publisher.tick();
        }
        assert!(!second.publishes(), "the home is held");
        assert_eq!(std::fs::read_to_string(control_token_path().unwrap()).unwrap(), "the-owner-s-token");

        // The owner exits, or crashes: either way the OS closes both.
        drop(owner);
        drop(lock);
        until("the second launch takes the home", || publisher.tick(), || second.publishes());
        assert_eq!(std::fs::read_to_string(control_token_path().unwrap()).unwrap(), second.token);
        assert_eq!(shell_reaches(), "second");
        // Its tabs never noticed: they were on its own socket throughout.
        assert_eq!(send(&second.socket, &stop_hook("second-tab"))["output"]["instance"], "second");
    }

    #[cfg(unix)]
    #[test]
    fn a_stale_published_socket_is_rebound_by_the_next_launch() {
        use std::os::unix::net::UnixListener;

        // A crashed owner leaves its socket file and its token behind.
        let _home = crate::store::temp_home();
        drop(UnixListener::bind(socket_path().unwrap()).unwrap());
        std::fs::write(control_token_path().unwrap(), "a-dead-launch-s-token").unwrap();

        let (next, _, mut publisher) = launch("next");
        until("the next launch publishes", || publisher.tick(), || next.publishes());
        assert_eq!(shell_reaches(), "next");
    }

    #[cfg(unix)]
    #[test]
    fn a_published_socket_replaced_under_its_owner_is_put_back_once_the_usurper_goes() {
        use std::os::unix::net::UnixListener;

        // An older build started after this one: it deletes the published
        // socket and binds its own, as every build before the lock did.
        let _home = crate::store::temp_home();
        let (owner, _, mut publisher) = launch("owner");
        assert!(owner.publishes());
        std::fs::remove_file(socket_path().unwrap()).unwrap();
        let older = UnixListener::bind(socket_path().unwrap()).unwrap();
        std::fs::write(control_token_path().unwrap(), "the-older-build-s-token").unwrap();

        publisher.tick();
        assert!(!owner.publishes(), "the owner sees it no longer publishes");
        // Its tabs are untouched: nothing replaced the socket they dial.
        assert_eq!(send(&owner.socket, &stop_hook("owner-tab"))["output"]["instance"], "owner");
        assert_eq!(std::fs::read_to_string(control_token_path().unwrap()).unwrap(), "the-older-build-s-token");

        drop(older);
        until("the owner publishes again", || publisher.tick(), || owner.publishes());
        assert_eq!(shell_reaches(), "owner");
    }

    #[cfg(unix)]
    #[test]
    fn a_token_that_cannot_be_written_gives_the_lock_and_the_socket_back() {
        let _home = crate::store::temp_home();
        // A directory where the token file goes: the write cannot land.
        std::fs::create_dir(control_token_path().unwrap()).unwrap();
        std::fs::write(control_token_path().unwrap().join("in-the-way"), "").unwrap();

        let (endpoint, _, mut publisher) = launch("unpublished");
        assert!(!endpoint.publishes());
        assert!(!socket_path().unwrap().exists(), "no published socket without a token a shell can read");
        let lock = std::fs::OpenOptions::new().write(true).open(run_dir().unwrap().join("hooks.lock")).unwrap();
        let held = std::cell::Cell::new(true);
        until("the lock is not left held", || held.set(lock.try_lock().is_err()), || !held.get());
        drop(lock);
        // The launch itself is fine.
        assert_eq!(send(&endpoint.socket, &stop_hook("tab"))["output"]["instance"], "unpublished");

        // And it publishes as soon as it can.
        std::fs::remove_dir_all(control_token_path().unwrap()).unwrap();
        until("the launch publishes", || publisher.tick(), || endpoint.publishes());
        assert_eq!(shell_reaches(), "unpublished");
    }

    #[cfg(unix)]
    #[test]
    fn a_lock_that_cannot_be_taken_does_not_stop_the_launch() {
        let _home = crate::store::temp_home();
        // Not "held by another launch", but an error of its own.
        std::fs::create_dir(run_dir().unwrap().join("hooks.lock")).unwrap();

        let (endpoint, seen, mut publisher) = launch("lockless");
        publisher.tick();
        assert!(!endpoint.publishes());
        assert!(!socket_path().unwrap().exists());
        assert_eq!(send(&endpoint.socket, &stop_hook("tab"))["output"]["instance"], "lockless");
        assert_eq!(*seen.lock().unwrap(), ["tab"]);
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
        let origin = Origin { token: mint_token(), transcript_root: PathBuf::from("/nowhere"), conversation: None };
        assert!(origin.accepts(&frame(&origin.token, "")));
        assert!(!origin.accepts(&frame(&mint_token(), "")), "another tab's token is not this tab's");
        assert!(!origin.accepts(&frame("", "")), "a frame from a build with no token is refused");
        // Same length, one byte out: the compare is not a prefix compare.
        let mut nearly = origin.token.clone();
        nearly.pop();
        nearly.push(if origin.token.ends_with('f') { '0' } else { 'f' });
        assert!(!origin.accepts(&frame(&nearly, "")));

        // A tab that never got a token accepts nothing, empty frames included.
        let unset = Origin { token: String::new(), transcript_root: PathBuf::from("/nowhere"), conversation: None };
        assert!(!unset.accepts(&frame("", "")));
    }

    #[test]
    fn a_frame_can_only_retarget_the_tail_inside_this_tab_s_own_directory() {
        let home = tempfile::tempdir().unwrap();
        let root = home.path().join(".claude/projects/-Users-me-work");
        std::fs::create_dir_all(&root).unwrap();
        let mut origin = Origin { token: mint_token(), transcript_root: root.clone(), conversation: None };

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

    fn named(event: &str, transcript: &Path) -> HookFrame {
        HookFrame { event: event.into(), ..frame("", transcript.to_str().unwrap()) }
    }

    /// #250: a workspace was renamed, the tab resumed its conversation from
    /// the new folder, and the CLI went on writing the transcript where the
    /// conversation began. Every hook named that file and every one was
    /// refused, so the chat heard nothing the transcript said.
    #[test]
    fn a_frame_may_name_this_tab_s_own_conversation_in_another_checkout_s_folder() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join(".claude/projects");
        let (now, began) = (projects.join("-Users-me-work-renamed"), projects.join("-Users-me-work-original"));
        std::fs::create_dir_all(&now).unwrap();
        std::fs::create_dir_all(&began).unwrap();
        let mine = began.join("2f1c.jsonl");
        std::fs::write(&mine, "{}\n").unwrap();
        std::fs::write(began.join("another.jsonl"), "{}\n").unwrap();
        let own = ConversationFile::new(projects.clone(), "2f1c.jsonl".into());
        let mut origin = Origin { token: mint_token(), transcript_root: now.clone(), conversation: Some(own) };

        assert_eq!(origin.transcript(&named("Stop", &mine)), Some(mine.as_path()));
        // Still only this conversation: not its neighbours in that folder,
        // not a file of the same name deeper down or outside the projects
        // folder, and not a traversal back in.
        std::fs::create_dir_all(began.join("nested")).unwrap();
        std::fs::create_dir_all(home.path().join("notes")).unwrap();
        for outside in [began.join("nested/2f1c.jsonl"), projects.join("2f1c.jsonl"), home.path().join("notes/2f1c.jsonl")] {
            std::fs::write(&outside, "{}\n").unwrap();
        }
        for outside in [
            began.join("another.jsonl"),
            began.join("nested/2f1c.jsonl"),
            projects.join("2f1c.jsonl"),
            home.path().join("notes/2f1c.jsonl"),
            projects.join("-Users-me-work-original/../../../notes/2f1c.jsonl"),
            projects.join("-Users-me-work-renamed/../-Users-me-work-original/2f1c.jsonl"),
        ] {
            assert_eq!(origin.transcript(&named("Stop", &outside)), None, "{}", outside.display());
        }
        // The folder derived from the checkout is still this tab's as well:
        // the CLI may open its next file in either.
        let fresh = now.join("after-clear.jsonl");
        assert_eq!(origin.transcript(&named("Stop", &fresh)), Some(fresh.as_path()));
        // A tab with no conversation of its own (Codex) keeps to its root.
        let mut rooted = Origin { conversation: None, ..origin.clone() };
        assert_eq!(rooted.transcript(&named("Stop", &mine)), None);
    }

    /// Naming a file is not evidence that it is there. A frame that names
    /// this conversation's id in some other checkout's folder, where no such
    /// file exists, adopts nothing — it used to hand over the whole folder,
    /// and a second frame could then name anyone's conversation in it.
    #[test]
    fn a_folder_is_adopted_only_for_a_conversation_that_is_really_in_it() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join(".claude/projects");
        let (mine, victim) = (projects.join("-w-mine"), projects.join("-w-victim"));
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::create_dir_all(&victim).unwrap();
        let theirs = victim.join("their-conversation.jsonl");
        std::fs::write(&theirs, "{}\n").unwrap();
        let mut origin = Origin { token: mint_token(), transcript_root: mine.clone(), conversation: Some(ConversationFile::new(projects.clone(), "my-id.jsonl".into())) };

        // Not there: refused, and the folder is not this tab's afterwards.
        assert_eq!(origin.transcript(&named("SessionStart", &victim.join("my-id.jsonl"))), None);
        assert_eq!(origin.transcript(&named("SessionStart", &theirs)), None);
        assert_eq!(origin.transcript(&named("Stop", &theirs)), None);

        // A link of the right name to their file is not this tab's file.
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&theirs, victim.join("my-id.jsonl")).unwrap();
            assert_eq!(origin.transcript(&named("SessionStart", &victim.join("my-id.jsonl"))), None);
            assert_eq!(origin.transcript(&named("SessionStart", &theirs)), None);
            std::fs::remove_file(victim.join("my-id.jsonl")).unwrap();
        }
        // Nor is a folder of that name.
        std::fs::create_dir_all(victim.join("my-id.jsonl")).unwrap();
        assert_eq!(origin.transcript(&named("SessionStart", &victim.join("my-id.jsonl"))), None);
        assert_eq!(origin.transcript(&named("SessionStart", &theirs)), None);
    }

    /// In a folder the conversation really is in, the tab follows that
    /// conversation, and a file the CLI announces after it (`/clear` starts a
    /// new one). Its neighbours stay out: a later frame cannot name one, and
    /// only the CLI's `SessionStart` can announce a file at all.
    #[test]
    fn an_adopted_folder_holds_this_conversation_and_what_the_cli_announces_after_it() {
        let home = tempfile::tempdir().unwrap();
        let projects = home.path().join(".claude/projects");
        let (derived, began) = (projects.join("-w-renamed"), projects.join("-w-original"));
        std::fs::create_dir_all(&derived).unwrap();
        std::fs::create_dir_all(&began).unwrap();
        let mine = began.join("my-id.jsonl");
        std::fs::write(&mine, "{}\n").unwrap();
        let neighbour = began.join("neighbour.jsonl");
        std::fs::write(&neighbour, "{}\n").unwrap();
        let mut origin = Origin { token: mint_token(), transcript_root: derived.clone(), conversation: Some(ConversationFile::new(projects.clone(), "my-id.jsonl".into())) };

        assert_eq!(origin.transcript(&named("UserPromptSubmit", &neighbour)), None, "before the folder is adopted");
        assert_eq!(origin.transcript(&named("UserPromptSubmit", &mine)), Some(mine.as_path()));
        assert_eq!(origin.transcript(&named("UserPromptSubmit", &neighbour)), None, "and after: a neighbour is not this conversation");
        assert_eq!(origin.transcript(&named("Stop", &neighbour)), None);

        // The CLI opens a new file and says so; from then on it is the tab's.
        let cleared = began.join("after-clear.jsonl");
        assert_eq!(origin.transcript(&named("Stop", &cleared)), None, "not until it is announced");
        assert_eq!(origin.transcript(&named("SessionStart", &cleared)), Some(cleared.as_path()));
        assert_eq!(origin.transcript(&named("Stop", &cleared)), Some(cleared.as_path()));
        assert_eq!(origin.transcript(&named("Stop", &mine)), Some(mine.as_path()));
        // Not a file elsewhere, and not something that is no transcript.
        assert_eq!(origin.transcript(&named("SessionStart", &projects.join("-w-other/x.jsonl"))), None);
        assert_eq!(origin.transcript(&named("SessionStart", &began.join("notes.txt"))), None);
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

        let mut origin = Origin { token: mint_token(), transcript_root: link.join("sessions"), conversation: None };
        let named = real.join("2026/09/rollout.jsonl");
        assert_eq!(origin.transcript(&frame("", named.to_str().unwrap())), Some(named.as_path()));
        let elsewhere = dir.path().join("real/elsewhere.jsonl");
        assert_eq!(origin.transcript(&frame("", elsewhere.to_str().unwrap())), None);
    }

    /// PRO-489: a control frame read and held as a handover begins is
    /// answered by the runtime that takes over, once it thaws, and that
    /// runtime sees its sender as the kernel says: what lets the window's
    /// frames through there (`window::Registry::handed_over`).
    #[cfg(unix)]
    #[test]
    fn a_control_frame_held_across_a_handover_is_answered_there_as_its_senders() {
        let _home = crate::store::temp_home();
        let endpoint = prepare_control().unwrap();
        let (own, token) = (endpoint.socket.clone(), endpoint.token.clone());
        let (_socket, bridge) = serve(endpoint, |_| HookReply::default(), |request| crate::control::ControlResponse::success(request.id, json!({"by": "old"}))).unwrap();
        // Accepted before the freeze, which does not wait for a frame not
        // read yet: the frame it sends once the bridge is frozen is read and
        // held, not left in the queue.
        let mut stream = std::os::unix::net::UnixStream::connect(&own).unwrap();
        let wait = |what: &str, done: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !done() {
                assert!(std::time::Instant::now() < deadline, "{what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        wait("the connection is accepted", &|| bridge.gate.lock().count(Phase::Reading) > 0);
        let freezing = { let bridge = bridge.clone(); std::thread::spawn(move || bridge.freeze(Duration::from_secs(5))) };
        wait("the bridge freezes", &|| bridge.gate.lock().frozen);
        let request = json!({"id": "held", "token": token, "command": "probe", "params": {}});
        stream.write_all(format!("{request}\n").as_bytes()).unwrap();
        freezing.join().unwrap().expect("frozen once the frame is held");
        let sender = std::thread::spawn(move || {
            let mut reply = String::new();
            BufReader::new(stream).read_line(&mut reply).unwrap();
            serde_json::from_str::<Value>(&reply).unwrap()
        });
        wait("the frame is read and held", &|| !bridge.gate.lock().held.is_empty());
        let frozen = bridge.take(|_| false).unwrap();
        assert_eq!(frozen.held.len(), 1);
        let adopted = Adopted { own: frozen.own, published: frozen.published, held: frozen.held.into_iter().map(|(fd, line, queued)| (std::os::unix::net::UnixStream::from(fd), line, queued)).collect() };
        let (_socket, replacement) = serve_adopted(ControlEndpoint::adopted(own, token), adopted, |_| HookReply::default(), |request| {
            crate::control::ControlResponse::success(request.id, json!({"by": "new", "pid": caller_pid()}))
        }).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(!sender.is_finished(), "not answered before the new runtime thaws");
        replacement.thaw();
        let reply = sender.join().unwrap();
        assert_eq!(reply["result"]["by"], "new", "{reply}");
        assert_eq!(reply["result"]["pid"], json!(std::process::id()), "its sender, as the kernel says: {reply}");
    }

    /// #765 review: a hook parked on a card answered after the bridge froze,
    /// before it was taken, gets its answer here, and the handover is called
    /// off for it: whether its thread is under way again, or has yet to wake
    /// and is still parked on a card no tab waits on. One still waiting when
    /// taken goes over with the handover, and is not answered here unless
    /// the handover is called off.
    #[cfg(unix)]
    #[test]
    fn a_waiting_hook_answered_as_a_handover_begins_is_answered_and_one_taken_goes_over() {
        use std::sync::{mpsc, Mutex};
        let _home = crate::store::temp_home();
        let (answer, answered) = mpsc::channel::<&'static str>();
        let (written, wrote) = mpsc::channel::<()>();
        let answered = Mutex::new(answered);
        let wrote = Mutex::new(wrote);
        let endpoint = prepare_control().unwrap();
        let (socket, bridge) = serve(endpoint, move |frame| {
            let parked = park(&frame.tab);
            let decision = answered.lock().unwrap().recv().unwrap();
            drop(parked);
            // The reply is still being made: the frame is under way.
            if decision == "slow" { wrote.lock().unwrap().recv().unwrap(); }
            HookReply { output: Some(json!({ "answered": frame.tab })), refused: None }
        }, |request| crate::control::ControlResponse::success(request.id, json!({}))).unwrap();
        let parked = |id: &str| bridge.gate.lock().parked.contains_key(id);
        let ask = |tab: &'static str| {
            let socket = socket.clone();
            std::thread::spawn(move || send(&socket, &stop_hook(tab)))
        };
        let wait = |what: &str, done: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !done() {
                assert!(std::time::Instant::now() < deadline, "{what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        };

        let first = ask("answered");
        wait("the first hook parks", &|| parked("answered"));
        bridge.freeze(Duration::from_secs(5)).expect("a parked hook does not hold a freeze up");
        // Answered now, as a person's click lands just as the handover begins.
        answer.send("slow").unwrap();
        wait("the answered hook to be under way again", &|| !parked("answered"));
        let refused = bridge.take(|_| true).err().expect("a hook under way calls the handover off");
        assert!(format!("{refused:#}").contains("answered as the runtime came to rest"), "{refused:#}");
        written.send(()).unwrap();
        assert_eq!(first.join().unwrap()["output"]["answered"], "answered", "the answer reaches the agent");
        bridge.thaw();

        // Answered just before the tabs were held, its thread not woken yet:
        // still parked, on a card no held tab waits on any more.
        let unwoken = ask("unwoken");
        wait("the unwoken hook parks", &|| parked("unwoken"));
        bridge.freeze(Duration::from_secs(5)).unwrap();
        let refused = bridge.take(|request_id| request_id != "unwoken").err().expect("a hook whose card was answered calls the handover off");
        assert!(format!("{refused:#}").contains("answered as the runtime came to rest"), "{refused:#}");
        assert!(!bridge.gate.lock().taken, "nothing was taken");
        // It wakes, and nothing holds it up: the answer reaches the agent
        // from here, while the bridge is still frozen.
        answer.send("quick").unwrap();
        assert_eq!(unwoken.join().unwrap()["output"]["answered"], "unwoken", "the answer reaches the agent");
        bridge.thaw();

        let second = ask("waiting");
        wait("the second hook parks", &|| parked("waiting"));
        bridge.freeze(Duration::from_secs(5)).unwrap();
        let taken = bridge.take(|request_id| request_id == "waiting").expect("nothing is under way, and its card is still waited on");
        assert_eq!(taken.parked.iter().map(|(id, _)| id.as_str()).collect::<Vec<_>>(), ["waiting"], "it goes over with the handover");
        answer.send("quick").unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(!second.is_finished(), "once taken, it is the next runtime's to answer");
        bridge.thaw();
        assert_eq!(second.join().unwrap()["output"]["answered"], "waiting", "called off, it is answered here after all");
    }

    /// PRO-589: a hook frame larger than the socket's queue (8 KiB on macOS)
    /// sent while the bridge is frozen is read whole and held, within the
    /// 5 s the old hook client gave its write, and answered once the bridge
    /// thaws; one sent once a handover has taken the bridge waits in the
    /// queue, the client's write outlasting the wait, and reaches the
    /// runtime that takes over whole.
    #[cfg(unix)]
    #[test]
    fn a_frame_larger_than_the_socket_queue_sent_while_frozen_arrives_whole() {
        use std::os::unix::net::UnixStream;
        use std::sync::{mpsc, Mutex};
        const LARGE: usize = 64 * 1024;
        let _home = crate::store::temp_home();
        let wait = |what: &str, done: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !done() {
                assert!(std::time::Instant::now() < deadline, "{what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        let large = |tab: &str| json!({"tab": tab, "session": "s", "token": "t", "event": "PermissionRequest",
            "payload": {"tool_name": "Bash", "tool_input": {"command": "x".repeat(LARGE)}}});
        let ask = |socket: &Path, frame: Value, write_within: Duration| {
            let socket = socket.to_path_buf();
            std::thread::spawn(move || {
                let mut stream = UnixStream::connect(&socket).unwrap();
                stream.set_write_timeout(Some(write_within)).unwrap();
                stream.write_all(format!("{frame}\n").as_bytes()).expect("the frame is written whole");
                let mut reply = String::new();
                BufReader::new(stream).read_line(&mut reply).unwrap();
                serde_json::from_str::<Value>(&reply).unwrap()
            })
        };
        let answering = |by: &'static str, seen: mpsc::Sender<(String, usize)>| {
            let seen = Mutex::new(seen);
            move |frame: HookFrame| {
                let command = frame.payload["tool_input"]["command"].as_str().unwrap_or_default().len();
                seen.lock().unwrap().send((frame.tab.clone(), command)).unwrap();
                HookReply { output: Some(json!({ "by": by })), refused: None }
            }
        };
        let (seen, answered) = mpsc::channel();
        let endpoint = prepare_control().unwrap();
        let (own, token) = (endpoint.socket.clone(), endpoint.token.clone());
        let (_socket, bridge) = serve(endpoint, answering("old", seen.clone()), |request| crate::control::ControlResponse::success(request.id, json!({}))).unwrap();

        bridge.freeze(Duration::from_secs(5)).unwrap();
        let first = ask(&own, large("frozen"), Duration::from_secs(5));
        wait("the large frame is read whole and held", &|| bridge.gate.lock().held.len() == 1);
        {
            let state = bridge.gate.lock();
            let held = &state.held[0];
            assert!(held.queued, "read from what would have waited in the queue");
            let frame: HookFrame = serde_json::from_str(&held.line).expect("held whole");
            assert_eq!(frame.payload["tool_input"]["command"].as_str().unwrap().len(), LARGE);
        }
        std::thread::sleep(Duration::from_millis(200));
        assert!(answered.try_recv().is_err(), "not answered while frozen");
        bridge.thaw();
        assert_eq!(answered.recv_timeout(Duration::from_secs(10)).unwrap(), ("frozen".to_string(), LARGE));
        assert_eq!(first.join().unwrap()["output"]["by"], "old");

        // Taken by a handover: a frame waits in the queue for the runtime
        // taking over, which comes up a while later.
        bridge.freeze(Duration::from_secs(5)).unwrap();
        let frozen = bridge.take(|_| false).unwrap();
        let second = ask(&own, large("taken"), FRAME_WRITE);
        std::thread::sleep(Duration::from_millis(200));
        assert!(!second.is_finished() && answered.try_recv().is_err(), "nothing answers a taken bridge");
        let adopted = Adopted { own: frozen.own, published: frozen.published, held: frozen.held.into_iter().map(|(fd, line, queued)| (UnixStream::from(fd), line, queued)).collect() };
        let (seen_there, answered_there) = mpsc::channel();
        let (_socket, replacement) = serve_adopted(ControlEndpoint::adopted(own, token), adopted, answering("new", seen_there),
            |request| crate::control::ControlResponse::success(request.id, json!({}))).unwrap();
        replacement.thaw();
        assert_eq!(answered_there.recv_timeout(Duration::from_secs(10)).unwrap(), ("taken".to_string(), LARGE));
        assert_eq!(second.join().unwrap()["output"]["by"], "new");
        assert!(answered.try_recv().is_err(), "the runtime handed over answers nothing of it");
    }

    /// A handover that finds no quiet moment holds control commands back,
    /// so that those under way end and none takes their place: a command
    /// read meanwhile is held and answered later, by this runtime or the
    /// next, while hooks and the desktop's own requests are answered as
    /// ever. An attempt called off meanwhile does not let the held ones in.
    #[cfg(unix)]
    #[test]
    fn a_draining_bridge_holds_commands_back_and_answers_hooks_and_the_desktop() {
        use std::os::unix::net::UnixStream;
        use std::sync::{mpsc, Mutex};
        let _home = crate::store::temp_home();
        let wait = |what: &str, done: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !done() {
                assert!(std::time::Instant::now() < deadline, "{what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        let soon = || std::time::Instant::now() + Duration::from_millis(100);
        let (release, released) = mpsc::channel::<()>();
        let released = Mutex::new(released);
        let carried_out = std::sync::Arc::new(Mutex::new(Vec::<String>::new()));
        let log = carried_out.clone();
        let endpoint = prepare_control().unwrap();
        let (own, token) = (endpoint.socket.clone(), endpoint.token.clone());
        let (_socket, bridge) = serve(endpoint,
            |_frame: HookFrame| HookReply { output: Some(json!({ "hook": true })), refused: None },
            move |request| {
                if request.command == "browser.snapshot" { released.lock().unwrap().recv().unwrap(); }
                log.lock().unwrap().push(request.command.clone());
                crate::control::ControlResponse::success(request.id, json!({ "did": request.command }))
            }).unwrap();
        let ask = |frame: Value| {
            let socket = own.clone();
            std::thread::spawn(move || {
                let mut stream = UnixStream::connect(&socket).unwrap();
                stream.write_all(format!("{frame}\n").as_bytes()).unwrap();
                let mut reply = String::new();
                BufReader::new(stream).read_line(&mut reply).unwrap();
                serde_json::from_str::<Value>(&reply).unwrap()
            })
        };
        let command = |command: &str| json!({"id": command, "token": token, "command": command, "params": {}});

        assert!(bridge.quiet_by(soon()), "nothing is under way");
        let slow = ask(command("browser.snapshot"));
        wait("the slow command is under way", &|| bridge.busy_named().is_some());
        assert!(!bridge.quiet_by(soon()));
        assert!(bridge.busy_named().unwrap().contains("browser.snapshot"), "{:?}", bridge.busy_named());

        bridge.drain();
        let held = ask(command("sessions.list"));
        wait("a command read while draining is held", &|| bridge.gate.lock().held.len() == 1);
        let hook = ask(json!({"tab": "t", "session": "s", "token": "t", "event": "Stop", "payload": {}}));
        assert_eq!(hook.join().unwrap()["output"]["hook"], true, "a hook is answered while draining");
        let desktop = ask(command("runtime.ping"));
        assert_eq!(desktop.join().unwrap()["result"]["did"], "runtime.ping", "so is what the desktop asks");
        assert!(!held.is_finished() && !slow.is_finished());

        // The one under way ends, and none took its place: quiet, with a
        // command waiting its turn.
        release.send(()).unwrap();
        assert_eq!(slow.join().unwrap()["result"]["did"], "browser.snapshot");
        assert!(bridge.quiet_by(std::time::Instant::now() + Duration::from_secs(10)));
        assert_eq!(bridge.gate.lock().held.len(), 1);

        // An attempt called off: still draining, the command stays held.
        bridge.freeze(Duration::from_secs(5)).unwrap();
        bridge.thaw();
        std::thread::sleep(Duration::from_millis(200));
        assert!(!held.is_finished(), "held until the draining ends");
        assert_eq!(bridge.gate.lock().held.len(), 1);

        // One whose caller gives up meanwhile is not carried out later.
        let mut gone = UnixStream::connect(&own).unwrap();
        gone.write_all(format!("{}\n", command("tabs.close")).as_bytes()).unwrap();
        wait("the second command is held", &|| bridge.gate.lock().held.len() == 2);
        drop(gone);

        bridge.undrain();
        assert_eq!(held.join().unwrap()["result"]["did"], "sessions.list", "answered once commands are let in again");
        assert!(bridge.gate.lock().held.is_empty());
        wait("everything held is done with", &|| bridge.busy_named().is_none());
        assert_eq!(*carried_out.lock().unwrap(), ["runtime.ping", "browser.snapshot", "sessions.list"], "not the one nobody waited for");
    }

    /// PRO-589: a freeze that a frame under way outlasts says which frame,
    /// and for how long it has been open; one waiting on a person does not
    /// hold it up, nor is it named.
    #[cfg(unix)]
    #[test]
    fn a_freeze_that_times_out_names_the_frame_holding_it_up() {
        use std::sync::{mpsc, Mutex};
        let _home = crate::store::temp_home();
        let (release, released) = mpsc::channel::<()>();
        let released = Mutex::new(released);
        let (decide, decided) = mpsc::channel::<()>();
        let decided = Mutex::new(decided);
        let endpoint = prepare_control().unwrap();
        let token = endpoint.token.clone();
        let (socket, bridge) = serve(endpoint, move |frame| {
            let _parked = park(&frame.tab);
            decided.lock().unwrap().recv().unwrap();
            HookReply::default()
        }, move |request| {
            released.lock().unwrap().recv().unwrap();
            crate::control::ControlResponse::success(request.id, json!({}))
        }).unwrap();
        let wait = |what: &str, done: &dyn Fn() -> bool| {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !done() {
                assert!(std::time::Instant::now() < deadline, "{what}");
                std::thread::sleep(Duration::from_millis(10));
            }
        };
        let parked = { let socket = socket.clone(); std::thread::spawn(move || send(&socket, &stop_hook("waiting"))) };
        wait("the hook parks", &|| bridge.gate.lock().parked.contains_key("waiting"));
        let slow = { let socket = socket.clone(); std::thread::spawn(move || send(&socket, &json!({"id": "slow", "token": token, "command": "pipelines.merge", "params": {}}))) };
        wait("the control command is under way", &|| bridge.gate.lock().busy() == 1);
        std::thread::sleep(Duration::from_millis(1100));
        let refused = bridge.freeze(Duration::from_millis(200)).expect_err("the command holds the freeze up");
        let refused = format!("{refused:#}");
        assert!(refused.starts_with("A hook or control request did not finish in time: control command pipelines.merge, open for "), "{refused}");
        assert!(!refused.contains("open for 0 s") && !refused.contains("Stop"), "{refused}");
        assert!(!bridge.gate.lock().frozen, "called off");
        release.send(()).unwrap();
        assert_eq!(slow.join().unwrap()["id"], "slow");
        decide.send(()).unwrap();
        parked.join().unwrap();
        wait("every frame is done", &|| bridge.gate.lock().open.is_empty());
    }

    /// PRO-589: a hook that cannot deliver its frame leaves a note beside the
    /// socket, naming the frame but carrying none of it, which the runtime
    /// serving that socket logs once and removes as the next frame arrives.
    #[cfg(unix)]
    #[test]
    fn a_hook_that_could_not_deliver_its_frame_leaves_a_note_the_runtime_reports() {
        let _home = crate::store::temp_home();
        let endpoint = prepare_control().unwrap();
        let own = endpoint.socket.clone();
        let (_socket, _bridge) = serve(endpoint, |_| HookReply::default(), |request| crate::control::ControlResponse::success(request.id, json!({}))).unwrap();
        let frame: HookFrame = serde_json::from_value(json!({"tab": "t1", "session": "s1", "token": "secret", "event": "PreToolUse", "payload": {"command": "private"}})).unwrap();
        note_failed_send(&own, &frame, "write", "Resource temporarily unavailable (os error 35)", 20_000, Duration::from_millis(5_002));
        let path = failed_sends_beside(&own);
        let notes = std::fs::read_to_string(&path).unwrap();
        assert!(!notes.contains("private") && !notes.contains("secret"), "nothing of what it carried: {notes}");
        let line = failed_send_line(notes.lines().next().unwrap());
        assert!(line.starts_with("a hook could not reach the runtime: PreToolUse for tab t1 at "), "{line}");
        assert!(line.ends_with(", 20000 bytes, gave up at \"write\" after 5002 ms: Resource temporarily unavailable (os error 35)"), "{line}");
        // The next frame on the socket has it reported, and removed.
        send(&own, &stop_hook("t1"));
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while path.exists() {
            assert!(std::time::Instant::now() < deadline, "the note is reported and removed");
            std::thread::sleep(Duration::from_millis(10));
        }
        let leftovers: Vec<_> = std::fs::read_dir(own.parent().unwrap()).unwrap().flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(FAILED_SENDS)).collect();
        assert!(leftovers.is_empty(), "no claimed copy is left behind");
    }

    #[test]
    fn scoped_tab_capability_tokens_verify_and_reject_tampering_s01() {
        let master = mint_token();
        let cap = TabCapability {
            session_id: "sess-1".into(),
            tab_id: "tab-1".into(),
            launch_id: "launch-1".into(),
            permission_mode: "plan".into(),
            bot_id: Some("bot-1".into()),
            bot_access: Some("readReport".into()),
            orchestration_role: "worker".into(),
        };
        let scoped = mint_tab_token(&master, &cap);
        assert!(scoped.starts_with(TAB_TOKEN_PREFIX));
        assert!(!scoped.contains(&master), "scoped token must never expose master control token");
        assert_eq!(verify_tab_token(&master, &scoped), Some(cap.clone()));

        // Wrong master key must fail.
        assert_eq!(verify_tab_token(&mint_token(), &scoped), None);

        // Tampered payload (trying to escalate `plan` -> `bypassPermissions`) must fail.
        let mut escalated = cap.clone();
        escalated.permission_mode = "bypassPermissions".into();
        use base64::Engine as _;
        let forged_payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&escalated).unwrap());
        let orig_sig = scoped.rsplit_once('.').unwrap().1;
        let forged = format!("{TAB_TOKEN_PREFIX}{forged_payload}.{orig_sig}");
        assert_eq!(verify_tab_token(&master, &forged), None);

        // Tampered signature must fail.
        let mut bad_sig = scoped.clone();
        bad_sig.push('A');
        assert_eq!(verify_tab_token(&master, &bad_sig), None);

        // `dispatch_line` installs `caller_capability()` for scoped tokens and `None` for master.
        let seen_scoped = std::sync::Mutex::new(None);
        let req = serde_json::to_string(&crate::control::ControlRequest {
            id: "r1".into(),
            token: scoped.clone(),
            command: "status".into(),
            params: json!({}),
        })
        .unwrap();
        let reply = dispatch_line(&req, &master, &|_| HookReply::default(), &|r| {
            *seen_scoped.lock().unwrap() = caller_capability();
            crate::control::ControlResponse::success(r.id, json!({"ok": true}))
        });
        assert_eq!(reply["ok"], true);
        assert_eq!(*seen_scoped.lock().unwrap(), Some(cap));
        assert!(caller_capability().is_none(), "thread-local capability must reset after dispatch");

        // Master token authenticates with `caller_capability() == None`.
        let seen_master = std::sync::Mutex::new(Some("sentinel".to_string()));
        let req_master = serde_json::to_string(&crate::control::ControlRequest {
            id: "r2".into(),
            token: master.clone(),
            command: "status".into(),
            params: json!({}),
        })
        .unwrap();
        let reply_master = dispatch_line(&req_master, &master, &|_| HookReply::default(), &|r| {
            *seen_master.lock().unwrap() = caller_capability().map(|c| c.tab_id);
            crate::control::ControlResponse::success(r.id, json!({"ok": true}))
        });
        assert_eq!(reply_master["ok"], true);
        assert_eq!(*seen_master.lock().unwrap(), None);

        // Forged token is rejected as `unauthorized`.
        let req_forged = serde_json::to_string(&crate::control::ControlRequest {
            id: "r3".into(),
            token: forged,
            command: "status".into(),
            params: json!({}),
        })
        .unwrap();
        let reply_forged = dispatch_line(&req_forged, &master, &|_| HookReply::default(), &|r| {
            crate::control::ControlResponse::success(r.id, json!({}))
        });
        assert_eq!(reply_forged["ok"], false);
        assert_eq!(reply_forged["error"]["code"], "unauthorized");
    }
}
