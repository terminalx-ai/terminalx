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
//! What no check here can tell from a person: a process of the same user that
//! detaches and opens a new pseudo-terminal of its own to run `pair` in. And on
//! a runtime the desktop launched, where the window (which has no terminal)
//! must be let through, a process that detaches with `setsid` and asks with no
//! terminal at all: the runtime cannot yet tell the window from it, because it
//! does not know which process is the window. Recognising the window is
//! PRO-369; before this guard, nothing was refused on any runtime.

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use crate::control::ControlError;
use crate::machine_wire;

/// The parameter a guarded request names its witness in. The runtime takes
/// it out before the machine host reads the rest.
pub const PARAM: &str = "consent";

/// The runtime IPC commands only a person may send.
pub const GUARDED: [&str; 2] = [machine_wire::CREATE_CODE, machine_wire::APPROVE];

/// How long the runtime waits for a witness to answer.
const ANSWER_WITHIN: Duration = Duration::from_secs(5);

/// The longest nonce line a witness may answer with.
const MAX_NONCE: u64 = 256;

/// Whether `command` needs a person's consent.
pub fn guards(command: &str) -> bool {
    GUARDED.contains(&command)
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
}

impl Refusal {
    fn says(self) -> &'static str {
        match self {
            Self::Runtime => "the runtime itself asked",
            Self::Descendant => "it was asked by a process this runtime started (an agent, or a terminal it runs)",
            Self::RuntimeTerminal => "it was asked from a terminal this runtime runs",
            Self::NoTerminal => "it was asked by a process with no terminal, on a server with no window",
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

/// For a runtime with no window (`headless`), a caller with no controlling
/// terminal is refused: the window is the only person without one.
pub fn terminal_rule(headless: bool, has_terminal: bool) -> Option<Refusal> {
    (headless && !has_terminal).then_some(Refusal::NoTerminal)
}

/// Whether this runtime has no window: one the desktop started says so in
/// `TERMINALX_LOCAL_DESKTOP`.
fn headless() -> bool {
    std::env::var("TERMINALX_LOCAL_DESKTOP").as_deref() != Ok("1")
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
/// needs one; `None` for one that does not.
pub fn witness_for(command: &str, run: &Path, params: &mut Value) -> Result<Option<Witness>> {
    if !guards(command) {
        return Ok(None);
    }
    let witness = Witness::open(run)?;
    let object = params.as_object_mut().context("the request's parameters must be an object")?;
    object.insert(PARAM.into(), witness.param());
    Ok(Some(witness))
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
    let consent = params
        .as_object_mut()
        .and_then(|object| object.remove(PARAM))
        .ok_or_else(|| refused("This request does not say who sent it, so it is refused. Update TerminalX on both ends."))?;
    let socket = consent["socket"].as_str().map(PathBuf::from).ok_or_else(|| ControlError::invalid("consent.socket is required"))?;
    let nonce = consent["nonce"].as_str().filter(|nonce| !nonce.is_empty()).ok_or_else(|| ControlError::invalid("consent.nonce is required"))?;
    let peer = witness_pid(run, &socket, nonce).map_err(|error| refused(format!("Could not tell who sent this request ({error:#}), so it is refused.")))?;
    // SAFETY: getpid has no preconditions.
    let runtime = unsafe { libc::getpid() };
    let refusal = judge(peer, runtime, &runtime_terminals(runtime)).or_else(|| terminal_rule(headless(), controlling_terminal(peer).is_some()));
    if let Some(refusal) = refusal {
        log::warn!("machine host: refused a pairing request from process {peer}: {}", refusal.says());
        return Err(refused(format!("Only a person may do this, and {}.", refusal.says())));
    }
    Ok(())
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
    let run = std::fs::canonicalize(run)?;
    let parent = socket.parent().context("the witness has no directory")?;
    if std::fs::canonicalize(parent)? != run {
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
        (tty != 0).then(|| (((tty >> 8) & 0xfff) as u32, ((tty & 0xff) | ((tty >> 12) & 0xfff00)) as u32))
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
mod tests {
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
    fn a_headless_runtime_refuses_a_caller_with_no_terminal() {
        assert_eq!(terminal_rule(true, false), Some(Refusal::NoTerminal), "a detached agent on a server");
        assert_eq!(terminal_rule(true, true), None, "pair in a person's terminal");
        assert_eq!(terminal_rule(false, false), None, "the window, beside a runtime it started");
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
