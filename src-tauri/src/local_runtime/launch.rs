//! Install an immutable helper outside the replaceable app bundle, then
//! discover or launch it. A window's Child handle never owns runtime lifetime.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};

use super::client::Client;

fn private_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    let meta = std::fs::symlink_metadata(path)?;
    // SAFETY: geteuid has no preconditions.
    if !meta.is_dir() || meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o077 != 0 {
        bail!("runtime installation directory is not private");
    }
    Ok(())
}

fn digest(file: &mut File) -> Result<String> {
    let mut sha = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 { break; }
        sha.update(&buffer[..count]);
    }
    Ok(format!("{:x}", sha.finalize()))
}

fn open_binary(path: &Path) -> Result<File> {
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(path)?;
    if !file.metadata()?.is_file() { bail!("runtime executable is not a regular file"); }
    Ok(file)
}

/// Copy only the bundled helper supplied by the native launcher. Hashing the
/// whole executable makes versions coexist even when their app version matches.
pub fn install(source: &Path, home: &Path) -> Result<PathBuf> {
    use std::io::{Seek, SeekFrom};
    let mut input = open_binary(source).context("open bundled terminalx-serve")?;
    let hash = digest(&mut input)?;
    input.seek(SeekFrom::Start(0))?;
    private_dir(&home.join("runtime"))?;
    let directory = home.join("runtime").join(&hash);
    private_dir(&directory)?;
    let target = directory.join("terminalx-serve");
    if target.symlink_metadata().is_ok() {
        let mut existing = open_binary(&target)?;
        let meta = existing.metadata()?;
        // SAFETY: geteuid has no preconditions.
        if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 || meta.mode() & 0o100 == 0
            || digest(&mut existing)? != hash {
            bail!("installed runtime does not match its immutable version");
        }
        return Ok(target);
    }
    let mut staged = tempfile::NamedTempFile::new_in(&directory)?;
    std::io::copy(&mut input, &mut staged)?;
    staged.flush()?;
    staged.as_file_mut().seek(SeekFrom::Start(0))?;
    if digest(staged.as_file_mut())? != hash { bail!("bundled runtime changed while it was installed"); }
    staged.as_file().set_permissions(std::fs::Permissions::from_mode(0o700))?;
    staged.as_file().sync_all()?;
    match staged.persist_noclobber(&target) {
        Ok(_) => { File::open(&directory)?.sync_all()?; }
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if digest(&mut open_binary(&target)?)? != hash { bail!("another install wrote an unexpected runtime"); }
        }
        Err(error) => return Err(error.error.into()),
    }
    Ok(target)
}

pub fn connect_or_start(source: &Path, home: &Path) -> Result<Arc<Client>> {
    launch(source,home,None,None)
}

/// `log` is where a runtime started here keeps its log, rotated by the
/// runtime itself. Discarding it left a wedged runtime with no account (#661).
pub fn connect_desktop(source: &Path, home: &Path, application: &str, log: Option<&Path>) -> Result<Arc<Client>> {
    let client = launch(source,home,Some(application),log)?;
    let status = client.liveness(super::client::LIFECYCLE_TIMEOUT)?;
    if cfg!(target_os = "macos") && status["localRuntime"]["nativeTray"] != true {
        return Err(super::client::Blocked("The running local owner does not support the desktop tray. Its work was left running; attach with a compatible build after it finishes.".into()).into());
    }
    Ok(client)
}

/// Hold the home's launch lock, which serializes launchers, not runtimes:
/// the runtime owns its separate lock. Released when the file is dropped.
fn launch_lock(home: &Path, deadline: Instant) -> Result<File> {
    use std::os::fd::AsRawFd;
    let launch = OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC).open(home.join("run/local-launch.lock"))?;
    let metadata = launch.metadata()?;
    // SAFETY: geteuid has no preconditions.
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 || metadata.nlink() != 1 {
        bail!("local launch lock is not private");
    }
    loop {
        // SAFETY: descriptor remains owned by `launch` until it is returned.
        if unsafe { libc::flock(launch.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 { return Ok(launch); }
        if Instant::now() >= deadline { bail!("another desktop is starting the local runtime"); }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn launch(source: &Path, home: &Path, application: Option<&str>, log: Option<&Path>) -> Result<Arc<Client>> {
    let home = std::fs::canonicalize(home)?;
    private_dir(&home.join("run"))?;
    let deadline = Instant::now() + Duration::from_secs(30);
    let _launch = launch_lock(&home, deadline)?;
    // A live but incompatible owner is an error, never permission to start a
    // competing process or terminate the running owner's work.
    if std::os::unix::net::UnixStream::connect(home.join("run/hooks.sock")).is_ok() {
        return Client::connect(&home);
    }
    let executable = install(source, &home)?;
    #[cfg(target_os = "macos")]
    {
        let verified = Command::new("/usr/bin/codesign").args(["--verify", "--strict"]).arg(&executable).output()?;
        if !verified.status.success() { bail!("the installed runtime's code signature could not be verified"); }
    }
    let mut command = Command::new(executable);
    if let Some(application) = application {
        command.env("TERMINALX_LOCAL_DESKTOP","1").env("TERMINALX_LOCAL_APPLICATION",application);
    } else {
        command.env_remove("TERMINALX_LOCAL_DESKTOP").env_remove("TERMINALX_LOCAL_APPLICATION");
    }
    command.args(["--runtime-kind", "local", "--data-dir"]).arg(&home).stdin(Stdio::null());
    // The runtime takes the log over once it starts; until then, whatever it
    // prints (an argument it refuses) goes there too.
    match log.map(|log| -> Result<(File, File)> {
        if let Some(parent) = log.parent() { std::fs::create_dir_all(parent)?; }
        let file = super::log_file::open(log)?;
        Ok((file.try_clone()?, file))
    }) {
        Some(Ok((stdout, stderr))) => { command.arg("--log-file").arg(log.expect("opened")).stdout(stdout).stderr(stderr); }
        Some(Err(error)) => {
            log::warn!("local runtime log: {error:#}");
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        None => { command.stdout(Stdio::null()).stderr(Stdio::null()); }
    }
    // SAFETY: setsid is async-signal-safe and this hook only creates an OS
    // session. No allocator, lock or inherited window pipe is used after fork.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 { return Err(std::io::Error::last_os_error()); }
            Ok(())
        });
    }
    let mut child = command.spawn().context("start local runtime")?;
    loop {
        if let Ok(client) = Client::connect(&home) {
            std::thread::spawn(move || { let _ = child.wait(); });
            return Ok(client);
        }
        if let Some(status) = child.try_wait()? { bail!("local runtime exited before attachment: {status}"); }
        if Instant::now() >= deadline {
            // Do not kill on timeout: the runtime may already own accepted
            // work. With no attachments or work it exits by its idle policy.
            std::thread::spawn(move || { let _ = child.wait(); });
            bail!("local runtime did not become ready; it was not stopped");
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Stop the runtime that holds `home` without asking it, for one that has
/// stopped answering (#661). Only a process running a runtime installed in
/// this home is signalled, and with it the processes it started: their
/// terminals close with it, and an agent left running would hold on to the
/// conversation the next runtime resumes. `false` when no runtime was running.
pub fn kill_owner(home: &Path) -> Result<bool> {
    let home = std::fs::canonicalize(home)?;
    let _launch = launch_lock(&home, Instant::now() + Duration::from_secs(30))?;
    let socket = home.join("run/hooks.sock");
    let Some(pid) = listener(&socket) else { return Ok(false) };
    let executable = executable(pid).context("identify the process holding the runtime socket")?;
    if executable.parent().and_then(Path::parent) != Some(home.join("runtime").as_path())
        || executable.file_name() != Some(std::ffi::OsStr::new("terminalx-serve")) {
        bail!("The process holding the runtime socket ({}) is not a TerminalX runtime of this home; it was left running.", executable.display());
    }
    log::warn!("stopping the unresponsive local runtime (pid {pid})");
    let children = children(pid);
    // The runtime leads its own group (it calls setsid), which holds every
    // helper it started without a terminal of its own.
    // SAFETY: getpgid only reads the process table.
    let group = unsafe { libc::getpgid(pid) } == pid;
    let signal = |sig| {
        // SAFETY: the pid was just identified as this home's runtime.
        unsafe { libc::kill(if group { -pid } else { pid }, sig) };
    };
    signal(libc::SIGTERM);
    if !exited(pid, &socket, Duration::from_secs(3)) {
        signal(libc::SIGKILL);
        if !exited(pid, &socket, Duration::from_secs(5)) { bail!("The local runtime (pid {pid}) did not exit."); }
    }
    // Each terminal leads a session of its own. Its program had the terminal
    // hung up on it; one that ignored that is ended here.
    // SAFETY: a negative pid names the group that child leads, if it leads one.
    for child in &children { unsafe { libc::kill(-child, libc::SIGTERM) }; }
    let deadline = Instant::now() + Duration::from_secs(1);
    // SAFETY: signal zero only checks that the group still exists.
    while Instant::now() < deadline && children.iter().any(|child| unsafe { libc::kill(-child, 0) } == 0) {
        std::thread::sleep(Duration::from_millis(50));
    }
    // SAFETY: as above.
    for child in &children { unsafe { libc::kill(-child, libc::SIGKILL) }; }
    Ok(true)
}

/// Whether the runtime has gone: its pid no longer exists, or nothing
/// listens on its socket any more (it may be exiting, or not yet reaped).
fn exited(pid: libc::pid_t, socket: &Path, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    loop {
        // SAFETY: signal zero only checks that the process exists.
        let gone = unsafe { libc::kill(pid, 0) } != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        if gone || listener(socket).is_none_or(|holder| holder != pid) { return true; }
        if Instant::now() >= deadline { return false; }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// The process listening on `socket`, as the kernel records it.
fn listener(socket: &Path) -> Option<libc::pid_t> {
    use std::os::fd::AsRawFd;
    let stream = std::os::unix::net::UnixStream::connect(socket).ok()?;
    #[cfg(target_os = "macos")]
    {
        let mut pid: libc::pid_t = 0;
        let mut size = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
        // SAFETY: LOCAL_PEERPID writes one pid_t into the buffer it is given.
        let read = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_LOCAL, libc::LOCAL_PEERPID, (&mut pid as *mut libc::pid_t).cast(), &mut size) };
        (read == 0 && pid > 0).then_some(pid)
    }
    #[cfg(target_os = "linux")]
    {
        // SAFETY: an all-zero ucred is valid, and SO_PEERCRED fills exactly one.
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: as above.
        let read = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut credentials as *mut libc::ucred).cast(), &mut size) };
        (read == 0 && credentials.pid > 0).then_some(credentials.pid)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = stream.as_raw_fd();
        None
    }
}

/// The executable a process is running.
fn executable(pid: libc::pid_t) -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
        // SAFETY: proc_pidpath writes at most the buffer's size.
        let length = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
        if length <= 0 { return Err(std::io::Error::last_os_error().into()); }
        path.truncate(length as usize);
        Ok(PathBuf::from(<std::ffi::OsString as std::os::unix::ffi::OsStringExt>::from_vec(path)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(std::fs::read_link(format!("/proc/{pid}/exe"))?)
    }
}

/// The processes `pid` started that are still its children.
fn children(pid: libc::pid_t) -> Vec<libc::pid_t> {
    #[cfg(target_os = "macos")]
    {
        let mut pids = vec![0 as libc::pid_t; 4096];
        // SAFETY: the buffer's byte size is passed; the count returned fits it.
        let count = unsafe { libc::proc_listchildpids(pid, pids.as_mut_ptr().cast(), (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int) };
        pids.truncate(count.clamp(0, 4096) as usize);
        pids.retain(|child| *child > 0);
        pids
    }
    #[cfg(not(target_os = "macos"))]
    {
        let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
        entries.flatten().filter_map(|entry| {
            let child: libc::pid_t = entry.file_name().to_str()?.parse().ok()?;
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            // The parent is the second field after the parenthesised name.
            let parent: libc::pid_t = stat.rsplit_once(')')?.1.split_whitespace().nth(1)?.parse().ok()?;
            (parent == pid).then_some(child)
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_versions_survive_bundle_replacement_and_reject_tampering() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let source = fixture.path().join("bundled-helper");
        std::fs::write(&source, b"first helper image").unwrap();
        let first = install(&source, &home).unwrap();
        assert_eq!(install(&source, &home).unwrap(), first);
        std::fs::write(&source, b"updated helper image").unwrap();
        let second = install(&source, &home).unwrap();
        assert_ne!(first, second);
        std::fs::remove_file(&source).unwrap();
        assert_eq!(std::fs::read(&first).unwrap(), b"first helper image");
        assert_eq!(std::fs::read(&second).unwrap(), b"updated helper image");
        assert_eq!(std::fs::metadata(&first).unwrap().mode() & 0o777, 0o700);
        std::fs::write(&source, b"first helper image").unwrap();
        std::fs::write(&first, b"tampered helper").unwrap();
        assert!(install(&source, &home).is_err());
    }

    #[test]
    fn installer_refuses_symlinks_and_shared_directories() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let source = fixture.path().join("helper");
        std::fs::write(&source, b"helper image").unwrap();
        let linked = fixture.path().join("linked-helper");
        std::os::unix::fs::symlink(&source, &linked).unwrap();
        assert!(install(&linked, &home).is_err());
        let outside = fixture.path().join("outside");
        std::fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, home.join("runtime")).unwrap();
        assert!(install(&source, &home).is_err());
        std::fs::remove_file(home.join("runtime")).unwrap();
        std::fs::create_dir(home.join("runtime")).unwrap();
        std::fs::set_permissions(home.join("runtime"), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(install(&source, &home).is_err());
    }

    const OWNER_HOME: &str = "TERMINALX_TEST_UNRESPONSIVE_OWNER_HOME";

    /// A runtime that holds its socket and never answers, as one wedged
    /// behind a lock does, with a terminal of its own in its own session.
    #[test]
    fn unresponsive_owner_child() {
        use std::os::unix::net::UnixListener;
        let Some(home) = std::env::var_os(OWNER_HOME).map(PathBuf::from) else { return };
        let _listener = UnixListener::bind(home.join("run/hooks.sock")).unwrap();
        let mut terminal = Command::new("/bin/sleep");
        terminal.arg("600");
        // SAFETY: setsid is async-signal-safe.
        unsafe { terminal.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }); }
        let mut terminal = terminal.spawn().unwrap();
        std::fs::write(home.join("terminal.pid"), terminal.id().to_string()).unwrap();
        std::thread::sleep(Duration::from_secs(600));
        let _ = terminal.kill();
        let _ = terminal.wait();
    }

    /// Start `executable` as the wedged owner of a fresh home, and wait until
    /// it holds the socket. Returns the home, the owner and its terminal's pid.
    fn wedged_owner(fixture: &Path, executable: impl Fn(&Path) -> PathBuf) -> (PathBuf, std::process::Child, libc::pid_t) {
        let home = fixture.join("home");
        std::fs::create_dir(&home).unwrap();
        private_dir(&home.join("run")).unwrap();
        let mut owner = Command::new(executable(&home));
        owner.args(["--exact", "local_runtime::launch::tests::unresponsive_owner_child", "--nocapture"])
            .env(OWNER_HOME, &home).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        // SAFETY: as the launcher does: the owner leads a session of its own.
        unsafe { owner.pre_exec(|| if libc::setsid() < 0 { Err(std::io::Error::last_os_error()) } else { Ok(()) }); }
        let mut owner = owner.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(30);
        let terminal = loop {
            if let Ok(pid) = std::fs::read_to_string(home.join("terminal.pid")) { break pid.parse().unwrap(); }
            if Instant::now() >= deadline || owner.try_wait().unwrap().is_some() {
                let _ = owner.kill();
                panic!("the fixture owner never held its socket");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        (std::fs::canonicalize(home).unwrap(), owner, terminal)
    }

    fn running(pid: libc::pid_t) -> bool {
        // SAFETY: signal zero only checks that the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    #[test]
    fn an_unresponsive_owner_is_stopped_with_the_terminals_it_started() {
        let fixture = tempfile::tempdir().unwrap();
        let (home, mut owner, terminal) = wedged_owner(fixture.path(), |home| {
            // Installed as the launcher installs a runtime, so it is one of this home's.
            let installed = home.join("runtime/fixture");
            std::fs::create_dir_all(&installed).unwrap();
            let installed = installed.join("terminalx-serve");
            std::fs::copy(std::env::current_exe().unwrap(), &installed).unwrap();
            installed
        });
        assert_eq!(listener(&home.join("run/hooks.sock")), Some(owner.id() as libc::pid_t));
        assert!(kill_owner(&home).unwrap());
        let deadline = Instant::now() + Duration::from_secs(10);
        while owner.try_wait().unwrap().is_none() || running(terminal) {
            assert!(Instant::now() < deadline, "the owner or its terminal outlived the restart");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!kill_owner(&home).unwrap(), "nothing is left to stop");
    }

    #[test]
    fn a_socket_held_by_anything_but_this_homes_runtime_is_left_alone() {
        let fixture = tempfile::tempdir().unwrap();
        let (home, mut owner, terminal) = wedged_owner(fixture.path(), |_| std::env::current_exe().unwrap());
        let error = kill_owner(&home).unwrap_err();
        assert!(error.to_string().contains("not a TerminalX runtime"), "{error:#}");
        assert!(owner.try_wait().unwrap().is_none() && running(terminal));
        owner.kill().unwrap();
        owner.wait().unwrap();
        // SAFETY: the fixture's own terminal session.
        unsafe { libc::kill(-terminal, libc::SIGKILL) };
    }
}
