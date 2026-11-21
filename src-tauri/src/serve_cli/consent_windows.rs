//! Only a person may let another computer operate this machine: the Windows
//! side of `consent.rs`, which explains the design. The same rules apply,
//! with Windows' own records of who is who:
//!
//! - The witness is a named pipe of this home, owner-only like every
//!   TerminalX pipe (`win::pipe`), in place of a `0o600` socket in `run/`.
//! - The runtime connects to it and asks the kernel which process serves it
//!   (`GetNamedPipeServerProcessId`), in place of `SO_PEERCRED`.
//! - "Descends from the runtime" follows each process's recorded parent, and
//!   stops where a "parent" started after its child: Windows reuses pids and
//!   keeps the pid of a parent that has exited.
//! - A process's "controlling terminal" is the console host it is attached
//!   to. Windows names the program that made a pseudo-console (ConPTY) as the
//!   host of what runs in it, so a process whose console is hosted by the
//!   runtime or one of its descendants sits in one of the runtime's terminals
//!   and is refused even once it no longer descends from the runtime, as on
//!   Unix.
//!
//! - A caller with no terminal is one with no console a person can see and
//!   type into: none, a hidden one (`CREATE_NO_WINDOW`), or a pseudo-console
//!   another program hosts. Only a visible console window or a Windows
//!   Terminal tab counts.
//!
//! What no check here can tell from a person, as on Unix: a process of the
//! same user that detaches (Windows keeps no parent once `cmd /c start` has
//! exited) and opens a *visible* console of its own to run `pair` in. The
//! person then sees that window, and `pair` asks them there; a process of
//! the same user that also injects keystrokes into it is past any check here.
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use ring::signature::{self, Ed25519KeyPair};
#[cfg(any(test, feature = "desktop"))]
use ring::signature::KeyPair as _;
use serde_json::{json, Value};

use crate::control::ControlError;
use crate::machine_wire;

pub const PARAM: &str = "consent";

/// The runtime's Bots command (PRO-468). No window signs for a Bots action
/// on Windows (`consent.rs` witnesses them only from the window on a Mac), so
/// the runtime refuses those that need a person (`control::bots_without_a_window`).
pub const BOTS_COMMAND: &str = "runtime.session.bots";

pub const GUARDED: [&str; 5] = [machine_wire::CREATE_CODE, machine_wire::APPROVE, machine_wire::LET_BACK, machine_wire::PHONE_CODE, machine_wire::PHONE_APPROVE];

const ANSWER_WITHIN: Duration = Duration::from_secs(5);
const MAX_NONCE: u64 = 256;

pub fn guards(command: &str) -> bool {
    GUARDED.contains(&command)
}

/// A process id.
pub type Pid = u32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Runtime,
    Descendant,
    RuntimeTerminal,
    NoTerminal,
    NotWindow,
    UnsupportedDesktop,
}

impl Refusal {
    fn says(self) -> &'static str {
        match self {
            Self::Runtime => "the runtime itself asked",
            Self::Descendant => "it was asked by a process this runtime started (an agent, or a terminal it runs)",
            Self::RuntimeTerminal => "it was asked from a terminal this runtime runs",
            Self::NoTerminal => "it was asked by a process with no terminal, on a server with no window",
            Self::NotWindow => "it was asked by a process with no terminal that is not the TerminalX window",
            Self::UnsupportedDesktop => "this desktop cannot verify its window's identity; pairing is unavailable",
        }
    }
}

/// A terminal: the pid of the process that hosts the console: conhost for a
/// console window, the program that made it for a pseudo-console.
pub type Device = u32;

pub fn judge(peer: Pid, runtime: Pid, terminals: &HashSet<Device>) -> Option<Refusal> {
    if peer == runtime {
        return Some(Refusal::Runtime);
    }
    if descends_from(peer, runtime) {
        return Some(Refusal::Descendant);
    }
    // Unreadable is not "none": a process whose console cannot be told is
    // judged as if it sat in one of the runtime's.
    match crate::win::process::console_host(peer) {
        Ok(Some(host)) if terminals.contains(&host) => return Some(Refusal::RuntimeTerminal),
        Ok(_) => {}
        Err(_) => return Some(Refusal::RuntimeTerminal),
    }
    None
}

/// Who the runtime may let through with no terminal; as on Unix.
pub enum Window {
    /// None: a runtime with no window (`TERMINALX_LOCAL_DESKTOP` unset).
    Headless,
    /// The public key pinned by the desktop when it launched this runtime.
    Keyed([u8; 32]),
    /// A desktop launch without a pinned consent key.
    Unrecognisable,
}

pub(crate) const WINDOW_PUBLIC_KEY_ENV: &str = "TERMINALX_LOCAL_WINDOW_CONSENT_KEY";

impl Window {
    fn current() -> Self {
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

/// As on Unix: a desktop that cannot name its window refuses every guarded
/// request; otherwise a caller with no terminal must prove it is the window.
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

fn headless() -> bool {
    std::env::var("TERMINALX_LOCAL_DESKTOP").as_deref() != Ok("1")
}

const WINDOW_FIELD: &str = "window";

/// What the window signs for the request whose witness listens on `socket`
/// and answers `nonce`, as on Unix. The witness's name is taken as UTF-16,
/// the form Windows names pipes in.
fn window_message(socket: &Path, nonce: &str) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    let mut message = b"terminalx consent window v2\0".to_vec();
    for unit in socket.as_os_str().encode_wide() {
        message.extend_from_slice(&unit.to_le_bytes());
    }
    message.push(0);
    message.extend_from_slice(nonce.as_bytes());
    message
}

/// The public half of the window's key, for the runtime it launches.
#[cfg(feature = "desktop")]
pub(crate) fn launch_public_key() -> Result<Option<String>> {
    WINDOW_KEY.get().map(|load| load(true).map(|key| STANDARD.encode(key.public_key()))).transpose()
}

/// Loads the window's signing key. Only runtime launch may request creation.
pub type WindowKey = Box<dyn Fn(bool) -> Result<Ed25519KeyPair> + Send + Sync>;

static WINDOW_KEY: std::sync::OnceLock<WindowKey> = std::sync::OnceLock::new();

/// Make every guarded request this process sends prove it is the window.
#[cfg(feature = "desktop")]
pub fn speak_as_window(key: WindowKey) {
    if WINDOW_KEY.set(key).is_err() {
        log::warn!("the window's consent key was installed twice");
    }
}

/// The home a `run` directory belongs to.
fn home_of(run: &Path) -> Result<PathBuf> {
    Ok(run.parent().context("the runtime's directory has no home")?.to_owned())
}

/// The caller's side: a pipe of this home that answers `ok` to the first
/// connection that sends this request's nonce, and nothing to any other.
pub struct Witness {
    path: PathBuf,
    nonce: zeroize::Zeroizing<String>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Witness {
    pub fn open(run: &Path) -> Result<Self> {
        let name = format!("cw-{}", &uuid::Uuid::new_v4().simple().to_string()[..10]);
        let path = crate::ipc::endpoint(&home_of(run)?, &name);
        let nonce = zeroize::Zeroizing::new(crate::relay_e2ee::random_token());
        let stop = Arc::new(AtomicBool::new(false));
        let expected = Arc::new(zeroize::Zeroizing::new(nonce.as_str().to_owned()));
        let (ready, started) = std::sync::mpsc::sync_channel(1);
        let stopping = stop.clone();
        let listening = path.clone();
        let thread = std::thread::Builder::new().name("consent-witness".into()).spawn(move || {
            let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build() else {
                let _ = ready.send(Err(anyhow::anyhow!("start the consent witness")));
                return;
            };
            runtime.block_on(async move {
                let mut server = match crate::win::pipe::server(&listening, true) {
                    Ok(server) => server,
                    Err(error) => {
                        let _ = ready.send(Err(anyhow::Error::new(error).context(format!("listen on {}", listening.display()))));
                        return;
                    }
                };
                let _ = ready.send(Ok(()));
                while !stopping.load(Ordering::Relaxed) {
                    // `accept` is cancel-safe, so the timeout only polls `stopping`.
                    let connection = match tokio::time::timeout(Duration::from_millis(50), crate::win::pipe::accept(&mut server, &listening)).await {
                        Err(_) => continue,
                        Ok(Err(_)) => break,
                        Ok(Ok(connection)) => connection,
                    };
                    let (expected, answered) = (expected.clone(), stopping.clone());
                    tokio::spawn(async move {
                        if challenge(connection, &expected).await {
                            answered.store(true, Ordering::Relaxed);
                        }
                    });
                }
            });
        })?;
        started.recv().context("the consent witness did not start")??;
        Ok(Self { path, nonce, stop, thread: Some(thread) })
    }

    pub fn answered(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

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
    }
}

async fn challenge(connection: tokio::net::windows::named_pipe::NamedPipeServer, expected: &str) -> bool {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
    let (read, mut write) = tokio::io::split(connection);
    let mut line = zeroize::Zeroizing::new(String::new());
    let read = async { tokio::io::BufReader::new(read).take(MAX_NONCE).read_line(&mut line).await };
    if !matches!(tokio::time::timeout(ANSWER_WITHIN, read).await, Ok(Ok(_))) {
        return false;
    }
    let sent = line.trim_end_matches('\n');
    if !bool::from(subtle::ConstantTimeEq::ct_eq(sent.as_bytes(), expected.as_bytes())) {
        return false;
    }
    matches!(tokio::time::timeout(ANSWER_WITHIN, write.write_all(b"ok\n")).await, Ok(Ok(())))
}

pub fn witness_for(command: &str, run: &Path, params: &mut Value) -> Result<Option<Witness>> {
    if !guards(command) {
        return Ok(None);
    }
    // Fail locally if this window cannot read its key. A caller without a
    // provider still sends an ordinary witness for the runtime to judge.
    let key = WINDOW_KEY.get().map(|key| key(false)).transpose()?;
    witness_proving(command, run, params, key.as_ref())
}

pub fn witness_proving(command: &str, run: &Path, params: &mut Value, key: Option<&Ed25519KeyPair>) -> Result<Option<Witness>> {
    if !guards(command) {
        return Ok(None);
    }
    let witness = Witness::open(run)?;
    let mut consent = witness.param();
    if let Some(key) = key {
        consent[WINDOW_FIELD] = json!(STANDARD.encode(key.sign(&window_message(&witness.path, &witness.nonce))));
    }
    let object = params.as_object_mut().context("the request's parameters must be an object")?;
    object.insert(PARAM.into(), consent);
    Ok(Some(witness))
}

fn refused(message: impl Into<String>) -> ControlError {
    ControlError::new(
        "person_required",
        message,
        Some("Only a person may let another computer operate this machine: in Settings → Machines, or with `terminalx-serve pair` in a terminal of their own.".into()),
    )
}

pub fn verify(run: &Path, params: &mut Value) -> Result<(), ControlError> {
    verify_for(run, params, &Window::current())
}

pub fn verify_for(run: &Path, params: &mut Value, window: &Window) -> Result<(), ControlError> {
    let consent = params
        .as_object_mut()
        .and_then(|object| object.remove(PARAM))
        .ok_or_else(|| refused("This request does not say who sent it, so it is refused. Update TerminalX on both ends."))?;
    let socket = consent["socket"].as_str().map(PathBuf::from).ok_or_else(|| ControlError::invalid("consent.socket is required"))?;
    let nonce = consent["nonce"].as_str().filter(|nonce| !nonce.is_empty()).ok_or_else(|| ControlError::invalid("consent.nonce is required"))?;
    let peer = witness_pid(run, &socket, nonce).map_err(|error| refused(format!("Could not tell who sent this request ({error:#}), so it is refused.")))?;
    let runtime = std::process::id();
    let refusal = judge(peer, runtime, &runtime_terminals(runtime)).or_else(|| {
        let proven = window.proven(consent[WINDOW_FIELD].as_str(), &socket, nonce);
        // A console a person can see and type into: a hidden one, or a
        // pseudo-console, is not a person's terminal.
        let has_terminal = crate::win::process::interactive_console(peer);
        terminal_rule(window, has_terminal, proven)
    });
    if let Some(refusal) = refusal {
        log::warn!("machine host: refused a pairing request from process {peer}: {}", refusal.says());
        if refusal == Refusal::UnsupportedDesktop {
            return Err(ControlError::new("pairing_unavailable", refusal.says(), Some("Restart the local runtime from TerminalX on a supported desktop. On a headless server, use `terminalx-serve pair` in your own terminal.".into())));
        }
        return Err(refused(format!("Only a person may do this, and {}.", refusal.says())));
    }
    Ok(())
}

/// The pid of the process serving the witness pipe `socket`, a pipe of the
/// home `run` belongs to, which confirms `nonce` is its request's.
fn witness_pid(run: &Path, socket: &Path, nonce: &str) -> Result<Pid> {
    if !crate::ipc::in_home(&home_of(run)?, socket) {
        bail!("the witness must be one of this runtime's own endpoints");
    }
    // Refuses a pipe that another account owns or serves.
    let mut stream = crate::ipc::connect(socket).context("the witness does not answer")?;
    use std::os::windows::io::AsRawHandle;
    let pid = crate::win::process::pipe_server_pid(stream.as_raw_handle() as _)?;
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

/// Whether `ancestor` started `pid`, or started what did. A recorded parent
/// that started after its child is a later process with a reused pid, and
/// ends the chain.
pub fn descends_from(pid: Pid, ancestor: Pid) -> bool {
    let Ok(table) = crate::win::process::processes() else { return false };
    let parent_of = |pid: Pid| table.iter().find(|entry| entry.pid == pid).map(|entry| entry.parent);
    let mut current = pid;
    let mut started = crate::win::process::started(pid);
    for _ in 0..4096 {
        let Some(parent) = parent_of(current) else { return false };
        if parent == 0 || parent == current {
            return false;
        }
        let parent_started = crate::win::process::started(parent);
        if let (Some(child), Some(parent)) = (started, parent_started) {
            if parent > child {
                return false;
            }
        }
        if parent == ancestor {
            return true;
        }
        current = parent;
        started = parent_started;
    }
    false
}

/// What a console a process sits in can be hosted by when it is one of the
/// runtime's terminals: the runtime and every process it started. Windows
/// names the program that made a pseudo-console as the console host of what
/// runs in it, so a terminal the runtime (or a helper of its) made has one
/// of these as its host.
pub fn runtime_terminals(runtime: Pid) -> HashSet<Device> {
    let descendants = crate::win::process::descendants(runtime).unwrap_or_default();
    std::iter::once(runtime).chain(descendants.into_iter().map(|(entry, _)| entry.pid)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn me() -> Pid {
        std::process::id()
    }

    fn private_run() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let run = dir.path().join("run");
        crate::private_fs::create_dir(&run, "run").unwrap();
        (dir, run)
    }

    #[test]
    fn a_process_this_one_started_descends_from_it_and_not_the_other_way() {
        let mut child = Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(Stdio::null()).spawn().unwrap();
        let pid = child.id();
        assert!(descends_from(pid, me()));
        assert!(!descends_from(me(), pid));
        assert_eq!(judge(pid, me(), &HashSet::new()), Some(Refusal::Descendant));
        assert_eq!(judge(me(), me(), &HashSet::new()), Some(Refusal::Runtime));
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn a_process_in_one_of_the_runtimes_consoles_is_refused_without_its_ancestry() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut command = CommandBuilder::new("ping");
        command.args(["-n", "30", "127.0.0.1"]);
        let mut shell = pair.slave.spawn_command(command).unwrap();
        let pid = shell.process_id().unwrap();
        let terminals = runtime_terminals(me());
        let host = crate::win::process::console_host(pid).unwrap().expect("a ConPTY child has a console");
        assert!(terminals.contains(&host), "{host} is one of {terminals:?}");
        // Judged against an unrelated "runtime", only the console gives it away.
        let mut sibling = Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(Stdio::null()).spawn().unwrap();
        assert_eq!(judge(pid, sibling.id(), &terminals), Some(Refusal::RuntimeTerminal));
        assert_eq!(judge(pid, sibling.id(), &HashSet::new()), None);
        sibling.kill().unwrap();
        sibling.wait().unwrap();
        assert_eq!(judge(pid, me(), &terminals), Some(Refusal::Descendant));
        shell.kill().unwrap();
        let _ = shell.wait();
    }

    #[test]
    fn a_hidden_console_or_a_pseudo_console_is_no_persons_terminal() {
        use std::os::windows::process::CommandExt;
        let mut hidden = Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(Stdio::null())
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW).spawn().unwrap();
        assert!(crate::win::process::console_host(hidden.id()).unwrap().is_some(), "it has a console, though no window");
        assert!(!crate::win::process::interactive_console(hidden.id()));
        assert_eq!(terminal_rule(&Window::Headless, crate::win::process::interactive_console(hidden.id()), false), Some(Refusal::NoTerminal));
        hidden.kill().unwrap();
        hidden.wait().unwrap();

        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut command = CommandBuilder::new("ping");
        command.args(["-n", "30", "127.0.0.1"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        assert!(!crate::win::process::interactive_console(child.process_id().unwrap()), "a pseudo-console this process hosts");
        child.kill().unwrap();
        let _ = child.wait();
    }

    #[test]
    fn the_runtime_learns_who_listens_and_refuses_a_borrowed_witness() {
        let (_dir, run) = private_run();
        let mut params = json!({ "epoch": "e", "lease": "l" });
        let witness = witness_for(machine_wire::APPROVE, &run, &mut params).unwrap().expect("approve is guarded");
        let socket = PathBuf::from(params[PARAM]["socket"].as_str().unwrap());
        let nonce = params[PARAM]["nonce"].as_str().unwrap().to_string();
        // A stranger hears nothing first, and nothing after a wrong nonce.
        let mut stranger = crate::ipc::connect(&socket).unwrap();
        stranger.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
        let mut heard = [0u8; 8];
        assert!(stranger.read(&mut heard).is_err(), "a witness says nothing first");
        stranger.write_all(b"guess\n").unwrap();
        stranger.set_read_timeout(Some(ANSWER_WITHIN * 2)).unwrap();
        let mut heard = Vec::new();
        let _ = stranger.read_to_end(&mut heard);
        assert!(heard.is_empty(), "nothing after a wrong nonce: {heard:?}");
        assert!(witness_pid(&run, &socket, "another-nonce").is_err());
        assert!(!witness.answered());
        assert_eq!(witness_pid(&run, &socket, &nonce).unwrap(), me());
        for _ in 0..100 {
            if witness.answered() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(witness.answered());
        drop(witness);

        let mut params = json!({ "epoch": "e", "lease": "l" });
        let witness = witness_for(machine_wire::APPROVE, &run, &mut params).unwrap().unwrap();
        let error = verify(&run, &mut params).unwrap_err();
        assert_eq!(error.code, "person_required", "{error:?}");
        assert!(error.message.contains("the runtime itself"), "{}", error.message);
        assert!(params.get(PARAM).is_none());
        drop(witness);

        // A witness of another home is refused before it is dialled.
        let (_other_dir, other_run) = private_run();
        let mut params = json!({});
        let other = witness_for(machine_wire::APPROVE, &other_run, &mut params).unwrap().unwrap();
        let foreign = PathBuf::from(params[PARAM]["socket"].as_str().unwrap());
        assert!(witness_pid(&run, &foreign, "n").is_err());
        drop(other);
        let error = verify(&run, &mut json!({ "epoch": "e" })).unwrap_err();
        assert_eq!(error.code, "person_required");
        assert!(witness_for(machine_wire::DECLINE, &run, &mut json!({})).unwrap().is_none());
    }

    #[test]
    fn a_window_proof_holds_for_one_key_one_witness_and_one_nonce() {
        let key = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
        let other = Ed25519KeyPair::from_seed_unchecked(&[8; 32]).unwrap();
        let keyed = Window::desktop(Some(&STANDARD.encode(key.public_key())));
        let socket = Path::new(r"\\.\pipe\terminalx-a-cw-1");
        let sign = |key: &Ed25519KeyPair, socket: &Path, nonce: &str| STANDARD.encode(key.sign(&window_message(socket, nonce)));
        let proof = sign(&key, socket, "nonce");
        assert!(keyed.proven(Some(&proof), socket, "nonce"));
        assert!(!keyed.proven(Some(&proof), Path::new(r"\\.\pipe\terminalx-a-cw-2"), "nonce"));
        assert!(!keyed.proven(Some(&proof), socket, "other"));
        assert!(!keyed.proven(Some(&sign(&other, socket, "nonce")), socket, "nonce"));
        assert!(matches!(Window::desktop(Some("not a key")), Window::Unrecognisable));
        assert_eq!(terminal_rule(&Window::Unrecognisable, true, false), Some(Refusal::UnsupportedDesktop));
    }
}
