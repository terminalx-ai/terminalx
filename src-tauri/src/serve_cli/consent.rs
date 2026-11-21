//! Only a person may let another computer operate this machine
//! (docs/MACHINES.md, "Pairing through the account", "Who may answer"). An
//! agent on the machine has a shell and could run `terminalx-serve pair`
//! itself, so the runtime refuses to make a pairing code or approve a
//! computer for any process it started, or one whose controlling terminal is
//! one of its terminals.
//!
//! The control socket hands a request to the runtime without its connection,
//! so the runtime learns who asks another way, from the kernel: the caller
//! binds a private socket in the runtime's `run` directory (a [`Witness`])
//! and names it, with a secret nonce, in the request's `consent` parameter.
//! The runtime connects to that socket, reads the listening process's pid as
//! the kernel records it (`LOCAL_PEERPID` on macOS, `SO_PEERCRED` on Linux),
//! and sends the request's nonce; the witness answers `ok` only to its own
//! nonce, once. The witness never tells anyone the nonce, so a process that
//! connects to another's witness learns nothing, and a request that names
//! another process's witness cannot answer its challenge. The window's client
//! ([`crate::local_runtime::client`]) and `terminalx-serve pair` both send
//! one; the window is not the runtime's descendant, so it keeps working.
//!
//! A process that detaches itself from the runtime (double fork and
//! `setsid`) is no longer its descendant, and has no terminal. A headless
//! runtime, which has no window, therefore also refuses a caller with no
//! controlling terminal: there, only `pair` in a person's terminal answers.
//!
//! The window has no terminal either, so on a runtime the desktop launched
//! the window proves it is the window (PRO-369). The desktop keeps a
//! signing key in its Keychain and gives the runtime its public key at
//! launch. A caller with no terminal must sign its witness socket and nonce.
//! The pairing host key and its adoption over IPC cannot change this trust.
//!
//! What no check here can tell from a person: a process of the same user that
//! detaches and opens a new pseudo-terminal of its own to run `pair` in. A
//! desktop runtime without a pinned consent key cannot identify its window, so
//! guarded pairing actions are unavailable there, including when macOS app
//! identification fails.
//!
//! The key is pinned only in the environment of a runtime the window itself
//! launches, and a handover execs the newer runtime in the same environment,
//! so a runtime first launched without the window's key (by a build before
//! PRO-369, before the key was saved, or by another build) keeps none for
//! good. The window repairs that by launching a fresh runtime
//! (`local_runtime::window_consent`, PRO-486); nothing pins a key over IPC.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ring::signature::{self, Ed25519KeyPair};
#[cfg(any(test, all(feature = "desktop", target_os = "macos")))]
use ring::signature::KeyPair as _;
use serde_json::{json, Value};

use crate::control::ControlError;
use crate::machine_wire;

/// The parameter a guarded request names its witness in. The runtime takes
/// it out before the machine host reads the rest.
pub const PARAM: &str = "consent";

/// The runtime IPC commands only a person may send.
/// Letting a disconnected computer back is an approval too (PRO-357).
/// A phone's code and its Allow are a person's to give too (PRO-359).
pub const GUARDED: [&str; 5] = [machine_wire::CREATE_CODE, machine_wire::APPROVE, machine_wire::LET_BACK, machine_wire::PHONE_CODE, machine_wire::PHONE_APPROVE];

/// How long the runtime waits for a witness to answer.
const ANSWER_WITHIN: Duration = Duration::from_secs(5);

/// The longest nonce line a witness may answer with.
const MAX_NONCE: u64 = 256;

/// Whether `command` needs a person's consent.
pub fn guards(command: &str) -> bool {
    GUARDED.contains(&command)
}

/// The bots operations of `runtime.session.bots` that give a bot more than
/// it has (PRO-468): only the window, a person, sends them. An `update` is
/// witnessed always; the runtime asks for the proof only when it gives the
/// bot more (`bots::enforce::needs_person`), or turns its memory back on.
/// The owner's writes to a bot's role and memory (PRO-470) are a person's
/// too: what a bot is told comes from them. Starting a suggestion (PRO-477)
/// gives the bot work as the owner's message.
pub const BOTS_COMMAND: &str = "runtime.session.bots";
pub const GUARDED_BOTS: [&str; 21] = ["resume", "resumeAll", "dismissResume", "create", "delete", "update", "roleWrite", "roleRestore", "memoryUndo", "memoryAdd", "memoryForget", "dutySave", "dutySwitch", "dutyDelete", "dutyDuplicate", "dutyRun", "dutyTryCheck", "quietHours", "itemHand", "briefWrite", "suggestionStart"];

/// The field of a bots request where the window says an `update` gives the
/// bot nothing more (less access, the same reporting line), so it sends no
/// proof. The runtime judges that again itself (`bots::update_as`).
pub const GIVES_MORE: &str = "givesMore";

/// A window registering itself proves it is the window (PRO-489): the
/// runtime recognises the registrant's process as the window, the only one
/// that may then change sessions and terminals through the runtime directly
/// while Bots is on (`control::refuse_bot_runtime_call`).
pub const WINDOW_REGISTER: &str = "runtime.window.register";

/// The fields of an `update` that can give a bot more (`bots::gives_more`).
pub const UPDATE_GIVES: [&str; 9] = ["access", "reportsTo", "worksIn", "whoCanAsk", "harness", "model", "effort", "name", "runsOn"];

/// Whether this request needs a person's consent: a guarded command, the
/// window's registration, or a guarded bots operation; an `update` only when
/// it sets a field that can give more ([`UPDATE_GIVES`]), and the window did
/// not find it gives nothing more.
pub fn guards_request(command: &str, params: &Value) -> bool {
    if guards(command) || command == WINDOW_REGISTER {
        return true;
    }
    if command != BOTS_COMMAND {
        return false;
    }
    match params["operation"].as_str() {
        Some("update") => {
            let patch = &params["params"]["patch"];
            // `effort: null` is a change too: back to the agent's default.
            let widens = UPDATE_GIVES.iter().any(|field| patch.get(field).is_some_and(|value| !value.is_null() || *field == "effort"));
            // Memory turned back on: a conversation is given notes again.
            let memory_on = patch.get("memoryOff").and_then(Value::as_bool) == Some(false);
            memory_on || (widens && params[GIVES_MORE].as_bool() != Some(false))
        }
        // Switching a duty off gives its bot nothing (PRO-471).
        Some("dutySwitch") => params["params"]["on"].as_bool() != Some(false),
        // A chosen answer may approve a bot's run (PRO-476): witnessed always, as the runtime judges whether it
        // does under the item list's lock (`bots::items::answer_as`). Typed words never approve.
        Some("itemAnswer") => !params["params"]["answer"].is_null(),
        Some(operation) => GUARDED_BOTS.contains(&operation),
        None => false,
    }
}

/// Why a process that asks may not: it is this runtime, descends from it, or
/// sits in one of its terminals. `None` lets it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The runtime itself.
    Runtime,
    /// A process the runtime started: an agent, a shell in one of its
    /// terminals, or anything they started.
    Descendant,
    /// A process whose controlling terminal is one of the runtime's
    /// terminals, or whose session one of them leads.
    RuntimeTerminal,
    /// A process with no controlling terminal, asking a runtime with no
    /// window: on a headless server a person answers only in a terminal.
    NoTerminal,
    /// A process with no controlling terminal that did not prove it is the
    /// window, asking a runtime the desktop launched.
    NotWindow,
    /// A desktop runtime cannot establish window provenance.
    UnsupportedDesktop,
    /// A registration as the window that did not prove it with the
    /// window's key, whatever terminal it has ([`verify_window_for`]).
    Unproven,
}

impl Refusal {
    pub(crate) fn says(self) -> &'static str {
        match self {
            Self::Runtime => "the runtime itself asked",
            Self::Descendant => "it was asked by a process this runtime started (an agent, or a terminal it runs)",
            Self::RuntimeTerminal => "it was asked from a terminal this runtime runs",
            Self::NoTerminal => "it was asked by a process with no terminal, on a server with no window",
            Self::NotWindow => "it was asked by a process with no terminal that is not the TerminalX window",
            Self::UnsupportedDesktop => "this desktop cannot verify its window's identity; pairing is unavailable",
            Self::Unproven => "it did not prove with the window's key that it is the TerminalX window",
        }
    }
}

/// Whether `peer` may create a code or approve a computer for the runtime
/// whose pid is `runtime`. `ptys` are the runtime's terminals, as
/// [`runtime_terminals`] finds them.
pub fn judge(peer: libc::pid_t, runtime: libc::pid_t, ptys: &HashSet<Device>) -> Option<Refusal> {
    if peer == runtime {
        return Some(Refusal::Runtime);
    }
    if descends_from(peer, runtime) {
        return Some(Refusal::Descendant);
    }
    if let Some(session) = session_of(peer) {
        // A shell the runtime opened leads its own session; whatever runs in
        // that terminal stays in the session after it detaches from the
        // shell, until it calls `setsid`.
        if session == runtime || (session != peer && descends_from(session, runtime)) {
            return Some(Refusal::RuntimeTerminal);
        }
    }
    if controlling_terminal(peer).is_some_and(|tty| ptys.contains(&tty)) {
        return Some(Refusal::RuntimeTerminal);
    }
    None
}

/// Who the runtime may let through with no controlling terminal.
pub enum Window {
    /// None: a runtime with no window (`TERMINALX_LOCAL_DESKTOP` unset).
    Headless,
    /// The public key pinned by the desktop when it launched this runtime.
    Keyed([u8; 32]),
    /// A desktop launch without a pinned consent key.
    Unrecognisable,
}

impl Window {
    /// Whether this window can prove it is the window: its key is pinned.
    pub fn keyed(&self) -> bool {
        matches!(self, Self::Keyed(_))
    }
}

pub(crate) const WINDOW_PUBLIC_KEY_ENV: &str = "TERMINALX_LOCAL_WINDOW_CONSENT_KEY";

impl Window {
    pub fn current() -> Self {
        if headless() {
            return Self::Headless;
        }
        Self::desktop(std::env::var(WINDOW_PUBLIC_KEY_ENV).ok().as_deref())
    }

    fn desktop(encoded_key: Option<&str>) -> Self {
        let key = encoded_key
            .and_then(|encoded| STANDARD.decode(encoded).ok())
            .and_then(|bytes| bytes.try_into().ok());
        key.map_or(Self::Unrecognisable, Self::Keyed)
    }

    fn proven(&self, proof: Option<&str>, socket: &Path, nonce: &str) -> bool {
        let (Self::Keyed(public), Some(proof)) = (self, proof) else { return false };
        let Ok(signature) = STANDARD.decode(proof) else { return false };
        signature::UnparsedPublicKey::new(&signature::ED25519, public)
            .verify(&window_message(socket, nonce), &signature)
            .is_ok()
    }
}

/// Whether a caller with a terminal (`has_terminal`) or none may ask a
/// runtime whose window is `window`; `proven` says the caller proved it is
/// the window.
pub fn terminal_rule(window: &Window, has_terminal: bool, proven: bool) -> Option<Refusal> {
    if matches!(window, Window::Unrecognisable) {
        return Some(Refusal::UnsupportedDesktop);
    }
    if has_terminal {
        return None;
    }
    match window {
        Window::Headless => Some(Refusal::NoTerminal),
        Window::Keyed(_) => (!proven).then_some(Refusal::NotWindow),
        Window::Unrecognisable => Some(Refusal::UnsupportedDesktop),
    }
}

/// Whether this runtime has no window: one the desktop started says so in
/// `TERMINALX_LOCAL_DESKTOP`.
fn headless() -> bool {
    std::env::var("TERMINALX_LOCAL_DESKTOP").as_deref() != Ok("1")
}

/// The field of the `consent` parameter that carries the window's proof.
const WINDOW_FIELD: &str = "window";

fn window_message(socket: &Path, nonce: &str) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    [
        b"terminalx consent window v2\0",
        socket.as_os_str().as_bytes(),
        b"\0",
        nonce.as_bytes(),
    ].concat()
}

/// The public key a runtime launch pins: while a relaunch waits for its
/// fresh runtime, the one it provisioned (`provision_launch_key`), so every
/// launch it waits for pins it, however Keychain answers by then; otherwise
/// the window's key, read or created now.
#[cfg(all(feature = "desktop", target_os = "macos"))]
pub(crate) fn launch_public_key() -> Result<Option<String>> {
    if let Some(key) = PROVISIONED.lock().unwrap().clone() {
        return Ok(Some(key));
    }
    read_launch_key()
}

#[cfg(all(feature = "desktop", target_os = "macos"))]
fn read_launch_key() -> Result<Option<String>> {
    WINDOW_KEY.get().map(|load| load(true).map(|key| STANDARD.encode(key.public_key()))).transpose()
}

/// A key read or saved before stopping a runtime so that the launch that
/// replaces it pins it (PRO-486): that launch does not depend on reading
/// Keychain again. Kept until the relaunch ends ([`forget_launch_key`]).
#[cfg(all(feature = "desktop", target_os = "macos"))]
static PROVISIONED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Read the window's key, or create and save it, for the next runtime
/// launch to pin as it is.
#[cfg(all(feature = "desktop", target_os = "macos"))]
pub(crate) fn provision_launch_key() -> Result<Option<String>> {
    let key = read_launch_key()?;
    *PROVISIONED.lock().unwrap() = key.clone();
    Ok(key)
}

/// The relaunch is over, whether a launch followed or not: a later launch
/// reads Keychain again (PRO-489).
#[cfg(all(feature = "desktop", target_os = "macos"))]
pub(crate) fn forget_launch_key() {
    PROVISIONED.lock().unwrap().take();
}

/// What to do when the window cannot prove itself, for a refusal the runtime
/// gives any caller (`control::window_only`).
pub(crate) const KEYCHAIN_DENIED_SHORT: &str = "unlock your login Keychain and allow TerminalX access if asked.";

/// The window's consent key is in a Keychain it cannot read or write.
pub(crate) const KEYCHAIN_DENIED: &str = "TerminalX couldn’t access the window consent key in Keychain. Unlock your login Keychain, allow TerminalX access if prompted, then try again.";

/// This window's consent key is not in its Keychain: a runtime launch saves
/// one, so the runtime attached was not launched by this window with it.
#[derive(Debug)]
pub struct WindowKeyMissing;

impl std::fmt::Display for WindowKeyMissing {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("The window consent key is missing from Keychain. In TerminalX, open Settings → Machines and choose Create pairing code: TerminalX restarts its runtime so it can verify the window, or offers Restart runtime there.")
    }
}

impl std::error::Error for WindowKeyMissing {}

/// Loads the window's signing key. Only runtime launch may request creation.
pub type WindowKey = Box<dyn Fn(bool) -> Result<Ed25519KeyPair> + Send + Sync>;

static WINDOW_KEY: std::sync::OnceLock<WindowKey> = std::sync::OnceLock::new();

/// Make every guarded request this process sends prove it is the window.
#[cfg(all(feature = "desktop", target_os = "macos"))]
pub fn speak_as_window(key: WindowKey) {
    if WINDOW_KEY.set(key).is_err() {
        log::warn!("the window's consent key was installed twice");
    }
}

/// The caller's side: a private socket in the runtime's `run` directory that
/// answers `ok` to the first connection that sends this request's nonce, and
/// nothing to any other, until dropped.
pub struct Witness {
    path: PathBuf,
    nonce: zeroize::Zeroizing<String>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Witness {
    /// Listen in `run`, the runtime's private directory.
    pub fn open(run: &Path) -> Result<Self> {
        use std::os::unix::fs::PermissionsExt;
        // As short as the runtime's own `hooks-<pid>.sock`, which the data
        // directory is checked to have room for.
        let name = format!("cw-{}.sock", &uuid::Uuid::new_v4().simple().to_string()[..10]);
        let path = run.join(name);
        let listener = UnixListener::bind(&path).with_context(|| format!("listen on {}", path.display()))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        listener.set_nonblocking(true)?;
        let nonce = zeroize::Zeroizing::new(crate::relay_e2ee::random_token());
        let stop = Arc::new(AtomicBool::new(false));
        let expected = Arc::new(zeroize::Zeroizing::new(nonce.as_str().to_owned()));
        let stopping = stop.clone();
        let thread = std::thread::Builder::new().name("consent-witness".into()).spawn(move || {
            while !stopping.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        // Each on its own thread: a connection that sends
                        // nothing must not keep the runtime's waiting.
                        let (expected, answered) = (expected.clone(), stopping.clone());
                        let _ = std::thread::Builder::new().name("consent-challenge".into()).spawn(move || {
                            if challenge(stream, &expected) {
                                answered.store(true, Ordering::Relaxed);
                            }
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(10)),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        })?;
        Ok(Self { path, nonce, stop, thread: Some(thread) })
    }

    /// Whether the runtime has asked, and been answered.
    pub fn answered(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    /// The request's `consent` parameter.
    pub fn param(&self) -> Value {
        json!({ "socket": self.path, "nonce": self.nonce.as_str() })
    }
}

impl Drop for Witness {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Answer one challenge on `stream`: `ok` if it sends `expected`, nothing
/// otherwise. Whether it did.
fn challenge(mut stream: UnixStream, expected: &str) -> bool {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(ANSWER_WITHIN));
    let _ = stream.set_write_timeout(Some(ANSWER_WITHIN));
    let Ok(reader) = stream.try_clone() else { return false };
    let mut line = zeroize::Zeroizing::new(String::new());
    if BufReader::new(reader).take(MAX_NONCE).read_line(&mut line).is_err() {
        return false;
    }
    let sent = line.trim_end_matches('\n');
    if !bool::from(subtle::ConstantTimeEq::ct_eq(sent.as_bytes(), expected.as_bytes())) {
        return false;
    }
    stream.write_all(b"ok\n").is_ok()
}

/// `params` with a witness's `consent` parameter added, for a command that
/// needs one; `None` for one that does not. In the window's process the
/// parameter carries the window's proof too ([`speak_as_window`]).
pub fn witness_for(command: &str, run: &Path, params: &mut Value) -> Result<Option<Witness>> {
    witness_with_window_key(command, run, params, WINDOW_KEY.get())
}

fn witness_with_window_key(
    command: &str,
    run: &Path,
    params: &mut Value,
    provider: Option<&WindowKey>,
) -> Result<Option<Witness>> {
    if !guards_request(command, params) {
        return Ok(None);
    }
    // Fail locally if this window cannot read its key. A caller without a
    // provider still sends an ordinary witness for the runtime to judge.
    let key = provider.map(|key| key(false)).transpose()?;
    witness_proving(command, run, params, key.as_ref())
}

fn witness_proving(command: &str, run: &Path, params: &mut Value, key: Option<&Ed25519KeyPair>) -> Result<Option<Witness>> {
    if !guards_request(command, params) {
        return Ok(None);
    }
    let witness = Witness::open(run)?;
    let mut consent = witness.param();
    if let Some(key) = key {
        consent[WINDOW_FIELD] = json!(sign_witness(key, &witness.path, &witness.nonce));
    }
    let object = params.as_object_mut().context("the request's parameters must be an object")?;
    object.insert(PARAM.into(), consent);
    Ok(Some(witness))
}

/// A window keyed with `seed`, and a witness for `command` signed with it
/// (or with none), as the window's client sends one: for other modules' tests.
#[cfg(test)]
pub(crate) fn window_for_test(seed: &[u8; 32]) -> Window {
    Window::Keyed(Ed25519KeyPair::from_seed_unchecked(seed).unwrap().public_key().as_ref().try_into().unwrap())
}

#[cfg(test)]
pub(crate) fn witness_for_test(command: &str, run: &Path, params: &mut Value, seed: Option<&[u8; 32]>) -> Result<Option<Witness>> {
    let key = seed.map(|seed| Ed25519KeyPair::from_seed_unchecked(seed).unwrap());
    witness_proving(command, run, params, key.as_ref())
}

fn sign_witness(key: &Ed25519KeyPair, socket: &Path, nonce: &str) -> String {
    STANDARD.encode(key.sign(&window_message(socket, nonce)))
}

fn refused(message: impl Into<String>) -> ControlError {
    ControlError::new(
        "person_required",
        message,
        Some("Only a person may let another computer operate this machine: in Settings → Machines, or with `terminalx-serve pair` in a terminal of their own.".into()),
    )
}

/// The runtime's side, for a guarded command: take the `consent` parameter
/// out of `params`, ask its witness, and refuse unless a person may have sent
/// it. `run` is the runtime's private directory.
pub fn verify(run: &Path, params: &mut Value) -> Result<(), ControlError> {
    verify_for(run, params, &Window::current())
}

/// [`verify`], for a runtime whose window is `window`.
pub fn verify_for(run: &Path, params: &mut Value, window: &Window) -> Result<(), ControlError> {
    verify_peer_for(run, params, window).map(drop)
}

/// [`verify_for`], answering the process that proved it: the witness's, as
/// the kernel says, for the caller to bind to the connection that asked.
pub fn verify_peer_for(run: &Path, params: &mut Value, window: &Window) -> Result<libc::pid_t, ControlError> {
    verify_peer(run, params, window, false)
}

/// The window's registration ([`WINDOW_REGISTER`]) on a runtime whose
/// window's key is pinned: proved with that key whatever the registrant's
/// terminal (PRO-489). A person's terminal may pair, but no process is
/// taken for the window on a terminal alone: one that holds the control
/// token and opens a pseudo-terminal of its own outside the runtime's tree
/// would otherwise be, and then pass every guard the window passes.
/// Answers the process that proved it, as [`verify_peer_for`] does.
pub fn verify_window_for(run: &Path, params: &mut Value, window: &Window) -> Result<libc::pid_t, ControlError> {
    verify_peer(run, params, window, true)
}

fn verify_peer(run: &Path, params: &mut Value, window: &Window, registering: bool) -> Result<libc::pid_t, ControlError> {
    let consent = params
        .as_object_mut()
        .and_then(|object| object.remove(PARAM))
        .ok_or_else(|| refused("This request does not say who sent it, so it is refused. Update TerminalX on both ends."))?;
    let socket = consent["socket"].as_str().map(PathBuf::from).ok_or_else(|| ControlError::invalid("consent.socket is required"))?;
    let nonce = consent["nonce"].as_str().filter(|nonce| !nonce.is_empty()).ok_or_else(|| ControlError::invalid("consent.nonce is required"))?;
    let peer = witness_pid(run, &socket, nonce).map_err(|error| refused(format!("Could not tell who sent this request ({error:#}), so it is refused.")))?;
    // SAFETY: getpid has no preconditions.
    let runtime = unsafe { libc::getpid() };
    let refusal = judge(peer, runtime, &runtime_terminals(runtime)).or_else(|| {
        let proven = window.proven(consent[WINDOW_FIELD].as_str(), &socket, nonce);
        if registering {
            return (!(window.keyed() && proven)).then_some(Refusal::Unproven);
        }
        terminal_rule(window, controlling_terminal(peer).is_some(), proven)
    });
    if let Some(refusal) = refusal {
        log::warn!("refused a request that needs a person or the window from process {peer}: {}", refusal.says());
        if refusal == Refusal::UnsupportedDesktop {
            return Err(ControlError::new("pairing_unavailable", refusal.says(), Some("In TerminalX on a supported desktop, open Settings → Machines and choose Create pairing code: TerminalX restarts its runtime so it can verify the window, or offers Restart runtime there. On a headless server, use `terminalx-serve pair` in your own terminal.".into())));
        }
        if registering {
            return Err(refused(format!("Only the TerminalX window registers as the window, and {}.", refusal.says())));
        }
        return Err(refused(format!("Only a person may do this, and {}.", refusal.says())));
    }
    Ok(peer)
}

/// The pid of the process listening on `socket`, a private socket in `run`
/// that confirms `nonce` is its request's.
fn witness_pid(run: &Path, socket: &Path, nonce: &str) -> Result<libc::pid_t> {
    private_socket(run, socket)?;
    let mut stream = UnixStream::connect(socket).context("the witness does not answer")?;
    let pid = peer_pid(&stream)?;
    stream.set_read_timeout(Some(ANSWER_WITHIN))?;
    stream.set_write_timeout(Some(ANSWER_WITHIN))?;
    stream.write_all(format!("{nonce}\n").as_bytes()).context("the witness does not answer")?;
    let mut line = String::new();
    BufReader::new(stream).take(16).read_line(&mut line).context("the witness does not answer")?;
    if line != "ok\n" {
        bail!("the witness is not this request's");
    }
    Ok(pid)
}

/// A Unix socket this user owns, private, directly in `run`.
fn private_socket(run: &Path, socket: &Path) -> Result<()> {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let run = crate::paths::canonicalize(run)?;
    let parent = socket.parent().context("the witness has no directory")?;
    if crate::paths::canonicalize(parent)? != run {
        bail!("the witness must be in this runtime's private directory");
    }
    let metadata = std::fs::symlink_metadata(socket)?;
    // SAFETY: geteuid has no preconditions.
    if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        bail!("the witness must be a private socket");
    }
    Ok(())
}

/// The process at the other end of `stream`, as the kernel recorded it: for
/// a connection this process made, the process that listens.
pub fn peer_pid(stream: &UnixStream) -> Result<libc::pid_t> {
    use std::os::fd::AsRawFd;
    #[cfg(target_os = "macos")]
    {
        let mut pid: libc::pid_t = 0;
        let mut size = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
        // SAFETY: LOCAL_PEERPID writes one pid_t into the buffer it is given.
        let read = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&mut pid as *mut libc::pid_t).cast(), &mut size) };
        if read != 0 || pid <= 0 {
            bail!("the kernel does not say who listens: {}", std::io::Error::last_os_error());
        }
        Ok(pid)
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: an all-zero ucred is valid, and SO_PEERCRED fills exactly one.
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: as above.
        let read = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut credentials as *mut libc::ucred).cast(), &mut size) };
        if read != 0 || credentials.pid <= 0 {
            bail!("the kernel does not say who listens: {}", std::io::Error::last_os_error());
        }
        Ok(credentials.pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = stream.as_raw_fd();
        bail!("this system does not say who is at the other end of a socket")
    }
}

/// A terminal device: its major and minor numbers.
pub type Device = (u32, u32);

/// The parent of `pid`, while it runs.
pub fn parent_of(pid: libc::pid_t) -> Option<libc::pid_t> {
    #[cfg(target_os = "macos")]
    {
        bsd_info(pid).map(|info| info.pbi_ppid as libc::pid_t)
    }
    #[cfg(not(target_os = "macos"))]
    {
        stat_field(pid, 1)?.parse().ok()
    }
}

/// Whether `ancestor` started `pid`, or started what did.
pub fn descends_from(pid: libc::pid_t, ancestor: libc::pid_t) -> bool {
    let mut current = pid;
    // A cycle is impossible, but a bound costs nothing.
    for _ in 0..4096 {
        match parent_of(current) {
            Some(parent) if parent == ancestor => return true,
            Some(parent) if parent > 1 && parent != current => current = parent,
            _ => return false,
        }
    }
    false
}

/// Whether `pid` still runs: not gone, and not a zombie waiting to be reaped.
pub fn alive(pid: libc::pid_t) -> bool {
    #[cfg(target_os = "macos")]
    {
        // SZOMB, from <sys/proc.h>.
        bsd_info(pid).is_some_and(|info| info.pbi_status != 5)
    }
    #[cfg(not(target_os = "macos"))]
    {
        stat_field(pid, 0).is_some_and(|state| !matches!(state.as_str(), "Z" | "X" | "x"))
    }
}

/// When `pid` started, in the kernel's own units: with its pid, what tells a
/// process from a later one given the same pid.
pub fn started_at(pid: libc::pid_t) -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        bsd_info(pid).map(|info| info.pbi_start_tvsec.saturating_mul(1_000_000).saturating_add(info.pbi_start_tvusec))
    }
    #[cfg(not(target_os = "macos"))]
    {
        stat_field(pid, 19)?.parse().ok()
    }
}

/// The session `pid` is in: the pid of its leader.
pub fn session_of(pid: libc::pid_t) -> Option<libc::pid_t> {
    // SAFETY: getsid has no preconditions; it fails for a pid it cannot see.
    let session = unsafe { libc::getsid(pid) };
    (session > 0).then_some(session)
}

/// The controlling terminal of `pid`, if it has one.
pub fn controlling_terminal(pid: libc::pid_t) -> Option<Device> {
    #[cfg(target_os = "macos")]
    {
        let tdev = bsd_info(pid)?.e_tdev;
        // NODEV: no controlling terminal.
        (tdev != u32::MAX).then(|| split_device(u64::from(tdev)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        // The kernel's own encoding, not the C library's.
        let tty: u64 = stat_field(pid, 4)?.parse().ok()?;
        (tty != 0).then_some((((tty >> 8) & 0xfff) as u32, ((tty & 0xff) | ((tty >> 12) & 0xfff00)) as u32))
    }
}

/// A device number as `stat` reports it, split.
fn split_device(device: u64) -> Device {
    #[cfg(target_os = "macos")]
    {
        (((device >> 24) & 0xff) as u32, (device & 0xff_ffff) as u32)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let major = ((device >> 32) & 0xffff_f000) | ((device >> 8) & 0xfff);
        let minor = ((device >> 12) & 0xffff_ff00) | (device & 0xff);
        (major as u32, minor as u32)
    }
}

/// The terminal device at `path`.
fn device_of(path: &Path) -> Option<Device> {
    use std::os::unix::fs::MetadataExt;
    Some(split_device(std::fs::metadata(path).ok()?.rdev()))
}

#[cfg(target_os = "macos")]
fn bsd_info(pid: libc::pid_t) -> Option<libc::proc_bsdinfo> {
    // SAFETY: an all-zero proc_bsdinfo is valid; proc_pidinfo fills at most its size.
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    // SAFETY: as above.
    let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
    (read == size).then_some(info)
}

/// Field `index` of `/proc/<pid>/stat` after the parenthesised name: 0 is
/// the state, 1 the parent, 3 the session, 4 the controlling terminal.
#[cfg(not(target_os = "macos"))]
fn stat_field(pid: libc::pid_t, index: usize) -> Option<String> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')?.1.split_whitespace().nth(index).map(str::to_owned)
}

/// The terminals `runtime` runs: the far ends of the pseudo-terminals whose
/// controlling side it holds, or (on Linux) its descendants hold.
pub fn runtime_terminals(runtime: libc::pid_t) -> HashSet<Device> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: getpid has no preconditions.
        if runtime != unsafe { libc::getpid() } {
            return HashSet::new();
        }
        own_masters()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut terminals = HashSet::new();
        let mut pending = vec![runtime];
        let mut seen = HashSet::new();
        while let Some(pid) = pending.pop() {
            if !seen.insert(pid) || seen.len() > 4096 {
                continue;
            }
            terminals.extend(masters_of(pid));
            pending.extend(crate::local_runtime::launch::children(pid));
        }
        terminals
    }
}

/// The far ends of the pseudo-terminals this process holds the controlling
/// side of.
#[cfg(target_os = "macos")]
fn own_masters() -> HashSet<Device> {
    // _IOC(IOC_OUT, 't', 83, 128): the name of a master's far end.
    const TIOCPTYGNAME: libc::c_ulong = 0x4080_7453;
    let Ok(entries) = std::fs::read_dir("/dev/fd") else { return HashSet::new() };
    entries
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse::<libc::c_int>().ok())
        .filter_map(|fd| {
            let mut name = [0 as libc::c_char; 128];
            // SAFETY: TIOCPTYGNAME writes at most 128 bytes, NUL included,
            // and fails on anything that is not a pseudo-terminal master.
            if unsafe { libc::ioctl(fd, TIOCPTYGNAME, name.as_mut_ptr()) } != 0 {
                return None;
            }
            // SAFETY: the kernel wrote a NUL-terminated name.
            let name = unsafe { std::ffi::CStr::from_ptr(name.as_ptr()) };
            device_of(Path::new(<std::ffi::OsStr as std::os::unix::ffi::OsStrExt>::from_bytes(name.to_bytes())))
        })
        .collect()
}

/// The far ends of the pseudo-terminals `pid` holds the controlling side of:
/// each `/dev/ptmx` descriptor's `tty-index`.
#[cfg(not(target_os = "macos"))]
fn masters_of(pid: libc::pid_t) -> HashSet<Device> {
    let Ok(entries) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { return HashSet::new() };
    entries
        .flatten()
        .filter(|entry| std::fs::read_link(entry.path()).is_ok_and(|target| target.file_name().is_some_and(|name| name == "ptmx")))
        .filter_map(|entry| {
            let info = std::fs::read_to_string(format!("/proc/{pid}/fdinfo/{}", entry.file_name().to_str()?)).ok()?;
            let index = info.lines().find_map(|line| line.strip_prefix("tty-index:"))?.trim().to_owned();
            device_of(&Path::new("/dev/pts").join(index))
        })
        .collect()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn me() -> libc::pid_t {
        // SAFETY: getpid has no preconditions.
        unsafe { libc::getpid() }
    }

    #[test]
    fn a_process_this_one_started_descends_from_it_and_not_the_other_way() {
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id() as libc::pid_t;
        assert_eq!(parent_of(pid), Some(me()));
        assert!(descends_from(pid, me()));
        assert!(!descends_from(me(), pid));
        assert_eq!(judge(pid, me(), &HashSet::new()), Some(Refusal::Descendant));
        assert_eq!(judge(me(), me(), &HashSet::new()), Some(Refusal::Runtime));
        // This test's process did not start its own parent.
        let parent = parent_of(me()).unwrap();
        assert_eq!(judge(parent, me(), &HashSet::new()), None, "a process the runtime did not start may ask");
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn a_process_in_one_of_the_runtimes_terminals_is_refused_after_it_leaves() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut shell = pair.slave.spawn_command({
            let mut command = CommandBuilder::new("sh");
            command.args(["-c", "sleep 30"]);
            command
        }).unwrap();
        let pid = shell.process_id().unwrap() as libc::pid_t;
        let terminals = runtime_terminals(me());
        let tty = wait_for(|| controlling_terminal(pid)).expect("the shell has the terminal");
        assert!(terminals.contains(&tty), "{tty:?} is one of {terminals:?}");
        assert_eq!(session_of(pid), Some(pid), "the shell leads its own session");

        // A process whose ancestry no longer leads to the runtime, as an
        // agent's detached command would be, in that terminal: judged
        // against a "runtime" that did not start it (a sibling), only the
        // terminal gives it away.
        let mut sibling = Command::new("sleep").arg("30").spawn().unwrap();
        let unrelated = sibling.id() as libc::pid_t;
        assert_eq!(judge(pid, unrelated, &terminals), Some(Refusal::RuntimeTerminal));
        assert_eq!(judge(pid, unrelated, &HashSet::new()), None, "without its terminal it would pass");
        sibling.kill().unwrap();
        sibling.wait().unwrap();
        // And the runtime's own judgement, from its ancestry.
        assert_eq!(judge(pid, me(), &terminals), Some(Refusal::Descendant));
        shell.kill().unwrap();
        let _ = shell.wait();
    }

    #[test]
    fn a_process_with_no_terminal_has_none() {
        let mut child = Command::new("sleep").arg("30").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        // `setsid` would take the terminal; a plain child keeps this test's,
        // which may or may not exist, so only compare the two.
        assert_eq!(controlling_terminal(child.id() as libc::pid_t), controlling_terminal(me()));
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn the_runtime_learns_who_listens_and_refuses_a_borrowed_witness() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path().join("run");
        std::fs::create_dir(&run).unwrap();
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();

        // A stranger who connects to a witness learns nothing: it is told
        // nothing until it sends the nonce, and nothing after a wrong one.
        let mut params = json!({ "epoch": "e", "lease": "l" });
        let witness = witness_for(machine_wire::APPROVE, &run, &mut params).unwrap().expect("approve is guarded");
        let socket = PathBuf::from(params[PARAM]["socket"].as_str().unwrap());
        let nonce = params[PARAM]["nonce"].as_str().unwrap().to_string();
        assert!(socket.file_name().unwrap().len() <= "hooks-4194304.sock".len(), "fits where the runtime's sockets fit");
        let mut stranger = UnixStream::connect(&socket).unwrap();
        stranger.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        let mut heard = Vec::new();
        assert!(stranger.read_to_end(&mut heard).is_err() || heard.is_empty(), "a witness says nothing first");
        stranger.write_all(b"guess\n").unwrap();
        stranger.set_read_timeout(Some(ANSWER_WITHIN * 2)).unwrap();
        let mut heard = Vec::new();
        let _ = stranger.read_to_end(&mut heard);
        assert!(heard.is_empty(), "nothing after a wrong nonce: {heard:?}");
        assert!(!String::from_utf8_lossy(&heard).contains(&nonce));
        // A request that names this witness without its nonce is refused,
        // and does not use the witness up.
        assert!(witness_pid(&run, &socket, "another-nonce").is_err());
        assert!(!witness.answered());
        // The runtime, with the nonce: the pid is this process's.
        assert_eq!(witness_pid(&run, &socket, &nonce).unwrap(), me());
        wait_for(|| witness.answered().then_some(())).expect("the witness knows it was answered");
        drop(witness);
        assert!(!socket.exists(), "a witness removes its socket");

        // Through `verify`: this process is the "runtime" too, refused as itself.
        let mut params = json!({ "epoch": "e", "lease": "l" });
        let witness = witness_for(machine_wire::APPROVE, &run, &mut params).unwrap().unwrap();
        let error = verify(&run, &mut params).unwrap_err();
        assert_eq!(error.code, "person_required", "{error:?}");
        assert!(error.message.contains("the runtime itself"), "{}", error.message);
        assert!(params.get(PARAM).is_none(), "the machine host never sees a field it does not know");
        drop(witness);

        // Nor name a socket outside the runtime's directory.
        let outside = dir.path().join("cw-outside.sock");
        let _listener = UnixListener::bind(&outside).unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(private_socket(&run, &outside).is_err());
        // Nor leave it out.
        let error = verify(&run, &mut json!({ "epoch": "e", "lease": "l", "requestId": "r" })).unwrap_err();
        assert_eq!(error.code, "person_required");
        assert!(witness_for(machine_wire::DECLINE, &run, &mut json!({})).unwrap().is_none(), "anyone may decline");
        assert!(witness_for(machine_wire::REVOKE, &run, &mut json!({})).unwrap().is_none());
    }

    #[test]
    fn window_key_failure_stops_guarded_requests_before_a_witness_is_created() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::Builder::new().prefix("cw").tempdir_in("/tmp").unwrap();
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let unavailable: WindowKey = Box::new(|_| anyhow::bail!("window key unavailable"));
        let available: WindowKey = Box::new(|_| Ok(signing_key(&[7; 32])));
        for command in GUARDED {
            let mut params = json!({});
            let error = witness_with_window_key(command, dir.path(), &mut params, Some(&unavailable))
                .err().expect("a key read error stops the request locally");
            assert_eq!(error.to_string(), "window key unavailable");
            assert!(params.get(PARAM).is_none());
            assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());

            let _witness = witness_with_window_key(command, dir.path(), &mut params, Some(&available))
                .unwrap().expect("a readable key produces a witness");
            assert!(params[PARAM][WINDOW_FIELD].is_string());
            let window = keyed(&signing_key(&[7; 32]));
            let refused = verify_for(dir.path(), &mut params, &window).unwrap_err();
            assert_eq!(refused.code, "person_required");
            assert!(refused.message.contains("the runtime itself"));
        }

        assert!(witness_with_window_key(machine_wire::DECLINE, dir.path(), &mut json!({}), Some(&unavailable))
            .unwrap().is_none());
    }

    #[test]
    fn a_headless_runtime_refuses_a_caller_with_no_terminal() {
        let headless = Window::Headless;
        assert_eq!(terminal_rule(&headless, false, false), Some(Refusal::NoTerminal), "a detached agent on a server");
        assert_eq!(terminal_rule(&headless, false, true), Some(Refusal::NoTerminal), "a server has no window to prove");
        assert_eq!(terminal_rule(&headless, true, false), None, "pair in a person's terminal");
    }

    #[test]
    fn a_desktop_runtime_lets_through_only_the_window_with_no_terminal() {
        let keyed = keyed(&signing_key(&[7; 32]));
        assert_eq!(terminal_rule(&keyed, false, true), None, "the window");
        assert_eq!(terminal_rule(&keyed, false, false), Some(Refusal::NotWindow), "a detached agent");
        assert_eq!(terminal_rule(&keyed, true, false), None, "pair in a person's terminal");

    }

    #[test]
    fn a_desktop_requires_a_valid_launch_key() {
        let key = signing_key(&[7; 32]);
        let public = STANDARD.encode(key.public_key());
        let socket = Path::new("/run/cw-a.sock");
        let proof = sign_witness(&key, socket, "nonce");
        assert!(Window::desktop(Some(&public)).proven(Some(&proof), socket, "nonce"));
        for invalid in [None, Some("invalid base64"), Some("AA==")] {
            assert!(matches!(Window::desktop(invalid), Window::Unrecognisable));
        }
    }

    fn signing_key(seed: &[u8; 32]) -> Ed25519KeyPair {
        Ed25519KeyPair::from_seed_unchecked(seed).unwrap()
    }

    fn keyed(key: &Ed25519KeyPair) -> Window {
        Window::Keyed(key.public_key().as_ref().try_into().unwrap())
    }

    #[test]
    fn an_unrecognisable_desktop_refuses_pairing_even_with_a_terminal_or_proof() {
        for terminal in [false, true] {
            for proof in [false, true] {
                assert_eq!(terminal_rule(&Window::Unrecognisable, terminal, proof), Some(Refusal::UnsupportedDesktop));
            }
        }
    }

    #[test]
    fn a_window_proof_holds_for_one_key_one_witness_and_one_nonce() {
        let keyed = keyed(&signing_key(&[7; 32]));
        let socket = Path::new("/run/cw-a.sock");
        let proof = sign_witness(&signing_key(&[7; 32]), socket, "nonce");
        assert!(keyed.proven(Some(&proof), socket, "nonce"));
        assert!(!keyed.proven(None, socket, "nonce"));
        assert!(!keyed.proven(Some(&sign_witness(&signing_key(&[8; 32]), socket, "nonce")), socket, "nonce"), "another key");
        assert!(!keyed.proven(Some(&proof), Path::new("/run/cw-b.sock"), "nonce"), "another witness");
        assert!(!keyed.proven(Some(&proof), socket, "other"), "another request");
        assert!(!keyed.proven(Some(&STANDARD.encode([0; 64])), socket, "nonce"));
    }

    /// The detached process of
    /// [`a_detached_process_with_no_terminal_is_refused_unless_it_proves_it_is_the_window`];
    /// a no-op when the harness runs it as a test.
    #[test]
    fn detached_helper() {
        const STAGE: &str = "TERMINALX_CONSENT_HELPER_STAGE";
        match std::env::var(STAGE).as_deref() {
            // The first stage starts the second in a new session, and exits:
            // the second is no longer the test's descendant, and has no terminal.
            Ok("1") => {
                use std::os::unix::process::CommandExt;
                let mut next = Command::new(std::env::current_exe().unwrap());
                next.args(helper_args()).env(STAGE, "2").stdin(Stdio::null());
                // With a pseudo-terminal of its own (PRO-489): opened here, and
                // made the new session's controlling terminal. The second
                // stage inherits both ends, so the terminal outlives this one.
                let tty = std::env::var_os("TERMINALX_CONSENT_HELPER_TTY").is_some().then(|| {
                    let (mut master, mut slave) = (-1, -1);
                    // SAFETY: two out-pointers to ints; no name, termios or size.
                    let opened = unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()) };
                    assert_eq!(opened, 0, "openpty: {}", std::io::Error::last_os_error());
                    slave
                });
                // SAFETY: setsid and ioctl are async-signal-safe.
                unsafe {
                    next.pre_exec(move || {
                        if libc::setsid() < 0 {
                            return Err(std::io::Error::last_os_error());
                        }
                        if let Some(slave) = tty {
                            if libc::ioctl(slave, libc::TIOCSCTTY as _, 0) < 0 {
                                return Err(std::io::Error::last_os_error());
                            }
                        }
                        Ok(())
                    });
                }
                next.spawn().unwrap();
                std::process::exit(0);
            }
            // The second listens, says what it would send, and waits to be told it is done.
            Ok("2") => {
                let run = PathBuf::from(std::env::var("TERMINALX_CONSENT_HELPER_RUN").unwrap());
                let command = std::env::var("TERMINALX_CONSENT_HELPER_COMMAND").unwrap();
                let secret = std::env::var("TERMINALX_CONSENT_HELPER_KEY").ok().map(|hex| -> [u8; 32] {
                    (0..32).map(|index| u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap()).collect::<Vec<_>>().try_into().unwrap()
                });
                let mut params = json!({ "epoch": "e", "lease": "l" });
                let witness = witness_proving(&command, &run, &mut params, secret.as_ref().map(signing_key).as_ref()).unwrap().unwrap();
                let report = json!({ "pid": me(), "terminal": controlling_terminal(me()).is_some(), "params": params });
                // libtest can write the test name without a trailing newline.
                println!("\nCONSENT {report}");
                for _ in 0..600 {
                    if run.join("done").exists() {
                        break;
                    }
                    if witness.answered() {
                        // Alive while the runtime judges it.
                        std::thread::sleep(Duration::from_secs(2));
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                std::process::exit(0);
            }
            _ => {}
        }
    }

    fn helper_args() -> [&'static str; 4] {
        ["--exact", "serve_cli::consent::tests::detached_helper", "--nocapture", "--test-threads=1"]
    }

    /// What a process detached from this test (the "runtime") sends for
    /// `command`, proving `key` if given: its pid, whether it has a terminal,
    /// and its parameters.
    fn detached_request(run: &Path, command: &str, key: Option<&[u8; 32]>) -> (libc::pid_t, bool, Value) {
        detached_request_with(run, command, key, false)
    }

    /// [`detached_request`] from a process in a new session that has a
    /// pseudo-terminal of its own (`tty`), as `script` gives one.
    pub(crate) fn detached_request_with(run: &Path, command: &str, key: Option<&[u8; 32]>, tty: bool) -> (libc::pid_t, bool, Value) {
        let mut first = Command::new(std::env::current_exe().unwrap());
        if tty {
            first.env("TERMINALX_CONSENT_HELPER_TTY", "1");
        } else {
            first.env_remove("TERMINALX_CONSENT_HELPER_TTY");
        }
        first
            .args(helper_args())
            .env("TERMINALX_CONSENT_HELPER_STAGE", "1")
            .env("TERMINALX_CONSENT_HELPER_RUN", run)
            .env("TERMINALX_CONSENT_HELPER_COMMAND", command)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        match key {
            Some(key) => first.env("TERMINALX_CONSENT_HELPER_KEY", key.iter().map(|byte| format!("{byte:02x}")).collect::<String>()),
            None => first.env_remove("TERMINALX_CONSENT_HELPER_KEY"),
        };
        let mut first = first.spawn().unwrap();
        let stdout = first.stdout.take().unwrap();
        assert!(first.wait().unwrap().success());
        let line = BufReader::new(stdout).lines().map(Result::unwrap).find_map(|line| line.strip_prefix("CONSENT ").map(str::to_owned)).expect("the detached process reports");
        let report: Value = serde_json::from_str(&line).unwrap();
        (report["pid"].as_i64().unwrap() as libc::pid_t, report["terminal"].as_bool().unwrap(), report["params"].clone())
    }

    #[test]
    fn a_detached_process_with_no_terminal_is_refused_unless_it_proves_it_is_the_window() {
        use std::os::unix::fs::PermissionsExt;
        // Short: the witness's socket path must fit in sun_path.
        let dir = tempfile::Builder::new().prefix("cw").tempdir_in("/tmp").unwrap();
        let run = dir.path().join("run");
        std::fs::create_dir(&run).unwrap();
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
        let key = [42u8; 32];
        let desktop = keyed(&signing_key(&key));

        // Each request asks a fresh process: a witness answers once.
        let not_window = |result: Result<(), ControlError>, case: &str| {
            let error = result.expect_err(case);
            assert_eq!(error.code, "person_required", "{case}: {error:?}");
            assert!(error.message.contains("not the TerminalX window"), "{case}: {}", error.message);
        };
        for command in GUARDED {
            // The agent: detached with `setsid`, no terminal, no key.
            let (pid, terminal, mut params) = detached_request(&run, command, None);
            assert!(!terminal, "a process in a new session has no terminal");
            assert!(!descends_from(pid, me()), "{command}: the agent no longer descends from the runtime");
            not_window(verify_for(&run, &mut params, &desktop), &format!("{command}: a detached agent"));
            // A desktop that keeps its own key cannot identify its window.
            let (_, _, mut params) = detached_request(&run, command, None);
            let error = verify_for(&run, &mut params, &Window::Unrecognisable).unwrap_err();
            assert_eq!(error.code, "pairing_unavailable", "{command}");

            // The window, which holds the key: the same kind of process, with its proof.
            let (_, _, mut params) = detached_request(&run, command, Some(&key));
            assert!(verify_for(&run, &mut params, &desktop).is_ok(), "{command}: the window is let through");
            let (_, _, mut params) = detached_request(&run, command, Some(&key));
            not_window(verify_for(&run, &mut params, &keyed(&signing_key(&[1; 32]))), &format!("{command}: another key"));
            let (_, _, mut params) = detached_request(&run, command, Some(&key));
            let error = verify_for(&run, &mut params, &Window::Headless).unwrap_err();
            assert!(error.message.contains("no window"), "{command}: a server has no window: {}", error.message);

            // A request that copies the window's proof onto its own witness.
            let (_, _, window) = detached_request(&run, command, Some(&key));
            let (_, _, mut agent) = detached_request(&run, command, None);
            agent[PARAM][WINDOW_FIELD] = window[PARAM][WINDOW_FIELD].clone();
            not_window(verify_for(&run, &mut agent, &desktop), &format!("{command}: a borrowed proof"));
        }
        std::fs::write(run.join("done"), b"").unwrap();
    }

    /// The window's registration is witnessed like pairing (PRO-489): with
    /// the window's key it passes and names the process that proved it, the
    /// one the runtime then recognises; a detached process without it does not.
    #[test]
    fn a_window_registering_proves_it_and_is_named_by_its_witness() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::Builder::new().prefix("cw").tempdir_in("/tmp").unwrap();
        let run = dir.path().join("run");
        std::fs::create_dir(&run).unwrap();
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
        let key = [43u8; 32];
        let desktop = keyed(&signing_key(&key));
        assert!(guards_request(WINDOW_REGISTER, &json!({})), "the window's client always witnesses its registration");
        let (pid, _, mut params) = detached_request(&run, WINDOW_REGISTER, Some(&key));
        assert_eq!(verify_window_for(&run, &mut params, &desktop).unwrap(), pid);
        assert!(params.get(PARAM).is_none(), "taken out before the registration is read");
        let (_, _, mut params) = detached_request(&run, WINDOW_REGISTER, None);
        assert_eq!(verify_window_for(&run, &mut params, &desktop).unwrap_err().code, "person_required");
        // M1: a process with a pseudo-terminal of its own, outside the
        // runtime's tree, pairs as a person would, but is no window without
        // the key's proof; with it, it is.
        let (_, terminal, mut pairing) = detached_request_with(&run, WINDOW_REGISTER, None, true);
        assert!(terminal, "the helper has a terminal of its own");
        assert!(verify_peer_for(&run, &mut pairing, &desktop).is_ok(), "a terminal of its own passes where a person's would");
        let (_, _, mut params) = detached_request_with(&run, WINDOW_REGISTER, None, true);
        let error = verify_window_for(&run, &mut params, &desktop).unwrap_err();
        assert_eq!(error.code, "person_required");
        assert!(error.message.contains("window's key"), "{}", error.message);
        let (pid, _, mut params) = detached_request_with(&run, WINDOW_REGISTER, Some(&key), true);
        assert_eq!(verify_window_for(&run, &mut params, &desktop).unwrap(), pid);
        // Where no key is pinned, nothing proves the window.
        let (_, _, mut params) = detached_request_with(&run, WINDOW_REGISTER, Some(&key), true);
        assert!(verify_window_for(&run, &mut params, &Window::Headless).is_err());
        assert!(desktop.keyed() && !Window::Headless.keyed() && !Window::Unrecognisable.keyed());
        std::fs::write(run.join("done"), b"").unwrap();
    }

    #[test]
    fn a_person_in_a_terminal_of_their_own_is_let_through() {
        // A process in another session, with no tie to the "runtime": this
        // test's parent stands for the person's shell.
        let parent = parent_of(me()).unwrap();
        let unrelated = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = unrelated.id() as libc::pid_t;
        // Judged against a "runtime" that is the sleeping process: the test
        // process did not descend from it.
        assert_eq!(judge(me(), pid, &HashSet::new()), None);
        assert_eq!(judge(parent, pid, &HashSet::new()), None);
        let mut unrelated = unrelated;
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
    }

    fn wait_for<T>(mut check: impl FnMut() -> Option<T>) -> Option<T> {
        for _ in 0..100 {
            if let Some(value) = check() {
                return Some(value);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        None
    }
}
