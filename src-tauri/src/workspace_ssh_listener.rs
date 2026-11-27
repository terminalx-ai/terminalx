//! Private per-connection OpenSSH listener lifecycle.
use crate::workspace_ssh::parse_public_key;
use crate::workspace_ssh_payload::{remove_private_tree, InstallLock, StagedVersion, Version};
use anyhow::{bail, ensure, Context, Result};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::os::fd::OwnedFd;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};

const DEADLINE: Duration = Duration::from_secs(5);

pub(super) struct Daemon {
    pub(super) directory: PathBuf,
    pub(super) configuration: PathBuf,
    uncertain_session_exit: AtomicBool,
    fresh_in_this_runtime: bool,
}

impl Daemon {
    pub(super) fn staged(version: StagedVersion, configuration: PathBuf) -> Self {
        Self {
            directory: version.directory().to_owned(),
            configuration,
            uncertain_session_exit: AtomicBool::new(false),
            fresh_in_this_runtime: true,
        }
    }

    fn installed(install: &InstallLock, configuration: PathBuf) -> Result<Self> {
        let daemon = install.active_daemon()?;
        let directory = daemon
            .ancestors()
            .nth(3)
            .context("invalid installed OpenSSH path")?;
        Ok(Self {
            directory: directory.to_owned(),
            configuration,
            uncertain_session_exit: AtomicBool::new(false),
            fresh_in_this_runtime: false,
        })
    }

    fn command(&self) -> Command {
        let mut command = Command::new(self.directory.join("usr/sbin/sshd"));
        command.arg("-f").arg(&self.configuration);
        command
    }

    fn serve(&self, connection: TcpStream, keys: Option<&Path>) -> Result<OwnedChild> {
        ensure!(
            connection.peer_addr()?.ip().is_loopback(),
            "non-loopback SSH connection"
        );
        let stdout: OwnedFd = connection.try_clone()?.into();
        let stdin: OwnedFd = connection.into();
        let mut command = self.command();
        if let Some(keys) = keys {
            let mut option = std::ffi::OsString::from("AuthorizedKeysFile=");
            option.push(keys);
            command.arg("-o").arg(option);
        }
        Ok(OwnedChild(
            command
                .arg("-i")
                .stdin(Stdio::from(stdin))
                .stdout(Stdio::from(stdout))
                .stderr(Stdio::null())
                .spawn()?,
        ))
    }

    /// Test the exact candidate configuration and complete SSH key exchange
    /// with a strict host pin. Authentication is deliberately disabled on the
    /// probe client, which needs no session key and cannot start a command.
    pub(super) fn check(&self, host_key: &str) -> Result<()> {
        let public_key = parse_public_key(host_key).context("invalid pinned SSH host key")?;
        let mut config = OwnedChild(
            self.command()
                .arg("-t")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?,
        );
        ensure!(
            config.wait_until(Instant::now() + DEADLINE)?.success(),
            "candidate sshd rejected its configuration"
        );

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        listener.set_nonblocking(true)?;
        let endpoint = listener.local_addr()?;
        let scratch = tempfile::tempdir()?;
        let known = scratch.path().join("known_hosts");
        let output = scratch.path().join("probe.log");
        fs::write(
            &known,
            format!("[127.0.0.1]:{} {public_key}\n", endpoint.port()),
        )?;
        let mut client = OwnedChild(
            Command::new("/usr/bin/ssh")
                .env_remove("SSH_AUTH_SOCK")
                .env("LC_ALL", "C")
                .args(["-F", "/dev/null", "-v", "-T", "-p"])
                .arg(endpoint.port().to_string())
                .args([
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "GlobalKnownHostsFile=/dev/null",
                    "-o",
                    "UpdateHostKeys=no",
                    "-o",
                    "HostKeyAlgorithms=ssh-ed25519",
                    "-o",
                    "PreferredAuthentications=none",
                    "-o",
                    "ProxyCommand=none",
                    "-o",
                    "ConnectTimeout=3",
                    "-o",
                ])
                .arg(format!("UserKnownHostsFile={}", known.display()))
                .arg("terminalx-runtime@127.0.0.1")
                .arg("exit")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(File::create(&output)?)
                .spawn()?,
        );
        let deadline = Instant::now() + DEADLINE;
        let connection = loop {
            match listener.accept() {
                Ok((socket, _)) => break socket,
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    ensure!(
                        client.0.try_wait()?.is_none(),
                        "SSH probe exited before connecting"
                    );
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error.into()),
            }
        };
        let _candidate = self.serve(connection, None)?;
        let status = client.wait_until(deadline)?;
        let mut log = String::new();
        File::open(output)?
            .take(64 * 1024)
            .read_to_string(&mut log)?;
        ensure!(
            status.code() == Some(255)
                && log
                    .lines()
                    .any(|line| line == "debug1: SSH2_MSG_NEWKEYS received")
                && log
                    .lines()
                    .any(|line| line.starts_with("terminalx-runtime@127.0.0.1: Permission denied")),
            "SSH probe did not finish a pinned key exchange"
        );
        Ok(())
    }
}

struct OwnedChild(Child);

impl OwnedChild {
    fn wait_until(&mut self, deadline: Instant) -> Result<ExitStatus> {
        loop {
            if let Some(status) = self.0.try_wait()? {
                return Ok(status);
            }
            ensure!(Instant::now() < deadline, "private SSH process timed out");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        // This handle owns the direct process. Never signal a process group
        // or a PID after its child has been reaped.
        if matches!(self.0.try_wait(), Ok(None)) {
            let _ = self.0.kill();
        }
        let _ = self.0.wait();
    }
}

pub(super) struct Session {
    process: OwnedChild,
    daemon: Arc<Daemon>,
    _authorized_key: Option<tempfile::NamedTempFile>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if !matches!(self.process.0.try_wait(), Ok(Some(status)) if status.success()) {
            self.daemon
                .uncertain_session_exit
                .store(true, Ordering::Relaxed);
        }
    }
}

#[derive(Default)]
struct Routing {
    active: Option<Arc<Daemon>>,
    retired: BTreeMap<PathBuf, Arc<Daemon>>,
}

/// Existing connections own their daemon by reference. The routed version
/// determines which private sshd handles the next admitted connection.
#[derive(Default)]
pub(super) struct Listener {
    routing: Mutex<Routing>,
}

impl Listener {
    #[cfg(test)]
    fn admit(&self, socket: TcpStream, authorized: impl FnOnce() -> bool) -> Result<Session> {
        let routing = self.routing.lock().unwrap();
        let daemon = routing
            .active
            .clone()
            .context("workspace SSH listener held")?;
        ensure!(authorized(), "workspace SSH grant unavailable");
        let process = daemon.serve(socket, None)?;
        Ok(Session {
            process,
            daemon,
            _authorized_key: None,
        })
    }

    /// Admit one attachment using only its verified public key. Each child
    /// keeps its own file alive through authentication and command execution.
    pub(super) fn admit_key(
        &self,
        socket: TcpStream,
        verified_key: impl FnOnce() -> Option<String>,
    ) -> Result<Session> {
        let routing = self.routing.lock().unwrap();
        let daemon = routing
            .active
            .clone()
            .context("workspace SSH listener held")?;
        let key = verified_key()
            .and_then(|key| parse_public_key(&key))
            .context("workspace SSH grant unavailable")?;
        let directory = daemon
            .configuration
            .parent()
            .context("missing private SSH state")?;
        let mut keys = tempfile::NamedTempFile::new_in(directory)?;
        writeln!(keys, "{key}")?;
        let process = daemon.serve(socket, Some(keys.path()))?;
        Ok(Session {
            process,
            daemon,
            _authorized_key: Some(keys),
        })
    }

    /// Resume new admissions after runtime start. The caller owns the
    /// install lock, so current cannot change between lookup and route pin.
    pub(super) fn restore(
        &self,
        install: &InstallLock,
        configuration: PathBuf,
        host_key: &str,
        ready: impl Fn() -> bool,
    ) -> Result<()> {
        ensure!(ready(), "SSH readiness is held");
        let daemon = Daemon::installed(install, configuration)?;
        daemon.check(host_key)?;
        let mut routing = self.routing.lock().unwrap();
        ensure!(
            routing.active.is_none(),
            "SSH listener is already initialized"
        );
        ensure!(ready(), "SSH readiness was withdrawn");
        routing.active = Some(Arc::new(daemon));
        Ok(())
    }

    pub(super) fn activate(
        &self,
        install: &InstallLock,
        candidate: Daemon,
        host_key: &str,
        ready: impl Fn() -> bool,
    ) -> Result<()> {
        self.switch(
            install,
            candidate,
            ready,
            |daemon| daemon.check(host_key),
            |root| File::open(root)?.sync_all(),
        )
    }

    fn switch(
        &self,
        install: &InstallLock,
        candidate: Daemon,
        ready: impl Fn() -> bool,
        check: impl FnOnce(&Daemon) -> Result<()>,
        sync: impl FnOnce(&Path) -> io::Result<()>,
    ) -> Result<()> {
        ensure!(ready(), "SSH readiness is held");
        let candidate_name = version_name(&install.root, &candidate.directory)?;
        check(&candidate)?;
        let mut routing = self.routing.lock().unwrap();
        ensure!(
            !routing
                .active
                .as_ref()
                .is_some_and(|daemon| daemon.directory == candidate.directory),
            "SSH version is already active"
        );
        let current = install.root.join("current");
        let previous = match fs::read_link(&current) {
            Ok(name) => {
                let prior = version_name(&install.root, &install.root.join(&name))?;
                ensure!(name == Path::new(&prior), "invalid SSH current link");
                ensure!(
                    Version::parse(&prior)? <= Version::parse(&candidate_name)?,
                    "SSH activation downgrade refused"
                );
                Some(name)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        // Prepare both symlinks before replacing current. Keep admissions
        // fenced until the on-disk pointer and in-memory route agree.
        let scratch = tempfile::tempdir_in(&install.root)?;
        let next = scratch.path().join("next");
        let rollback = scratch.path().join("rollback");
        symlink(&candidate_name, &next)?;
        if let Some(previous) = &previous {
            symlink(previous, &rollback)?;
        }
        ensure!(ready(), "SSH readiness was withdrawn");
        fs::rename(next, &current)?;
        if sync(&install.root).is_err() {
            let restored = if previous.is_some() {
                fs::rename(rollback, &current)
            } else {
                fs::remove_file(&current)
            };
            if restored
                .and_then(|()| File::open(&install.root)?.sync_all())
                .is_err()
            {
                routing.active = None;
                bail!("SSH activation and rollback failed; listener held");
            }
            bail!("SSH activation rolled back");
        }

        let candidate = Arc::new(candidate);
        if let Some(previous) = routing.active.replace(Arc::clone(&candidate)) {
            if previous.directory != candidate.directory {
                routing.retired.insert(previous.directory.clone(), previous);
            }
        }
        Ok(())
    }

    pub(super) fn cleanup(&self, install: &InstallLock, ready: impl Fn() -> bool) -> Result<()> {
        let mut routing = self.routing.lock().unwrap();
        ensure!(ready(), "SSH readiness is held");
        let current = fs::read_link(install.root.join("current"))?;
        let retired: Vec<_> = routing
            .retired
            .iter()
            .filter(|(path, daemon)| {
                path.file_name() != Some(current.as_os_str())
                    && daemon.fresh_in_this_runtime
                    && Arc::strong_count(daemon) == 1
                    && !daemon.uncertain_session_exit.load(Ordering::Relaxed)
            })
            .map(|(path, _)| path.clone())
            .collect();
        for path in retired {
            version_name(&install.root, &path)?;
            remove_private_tree(&path)?;
            routing.retired.remove(&path);
        }
        File::open(&install.root)?.sync_all()?;
        Ok(())
    }
}

/// The listener and host identity shared by this runtime's attachments.
pub(crate) struct Runtime {
    listener: Listener,
    host_key: String,
}

impl Runtime {
    pub(crate) fn restore(root: &Path) -> Result<Self> {
        use crate::workspace_ssh::{atomic_write, private_directory, public_key, LoginShell};

        ensure!(
            LoginShell::current_account() == LoginShell::Usable,
            crate::workspace_ssh::LOGIN_SHELL_HELD
        );
        let install = InstallLock::acquire(root)?;
        install.active_daemon()?;
        let state = root.join("listener");
        private_directory(&state)?;
        let host = state.join("host");
        let host_key = public_key(&host, true)?;
        let configuration = state.join("sshd_config");
        let path = host
            .to_str()
            .context("private host key path is not UTF-8")?;
        ensure!(
            !path.contains(['\n', '\r', '"', '\\']),
            "invalid private host key path"
        );
        atomic_write(&configuration, format!(
            "HostKey \"{path}\"\nAuthorizedKeysFile none\nAllowUsers terminalx-runtime\nAuthenticationMethods publickey\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nDisableForwarding yes\nPermitUserRC no\nPermitUserEnvironment no\nPrintMotd no\n"
        ).as_bytes())?;
        let listener = Listener::default();
        listener.restore(&install, configuration, &host_key, || true)?;
        Ok(Self { listener, host_key })
    }

    pub(crate) fn host_key(&self) -> &str {
        &self.host_key
    }

    pub(crate) fn open(
        &self,
        verified_key: impl FnOnce() -> Option<String>,
    ) -> Result<(tokio::net::TcpStream, Session)> {
        let pair = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let client = TcpStream::connect(pair.local_addr()?)?;
        let (socket, _) = pair.accept()?;
        client.set_nonblocking(true)?;
        let session = self.listener.admit_key(socket, verified_key)?;
        Ok((tokio::net::TcpStream::from_std(client)?, session))
    }
}

fn version_name(root: &Path, directory: &Path) -> Result<String> {
    ensure!(
        directory.parent() == Some(root),
        "candidate is outside the private SSH install"
    );
    let name = name_str(directory)?;
    Version::parse(&name)?;
    ensure!(
        fs::symlink_metadata(directory)?.is_dir(),
        "SSH version is not a real directory"
    );
    Ok(name)
}

fn name_str(path: &Path) -> Result<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .context("invalid OpenSSH version path")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn candidate(root: &Path, version: &str) -> Daemon {
        let directory = root.join(version);
        fs::create_dir(&directory).unwrap();
        Daemon {
            directory,
            configuration: root.join("sshd_config"),
            uncertain_session_exit: AtomicBool::new(false),
            fresh_in_this_runtime: true,
        }
    }

    #[test]
    fn workspace_ssh_listener_restored_route_stays_pinned_to_its_version() {
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path();
        let install = InstallLock::acquire(root).unwrap();
        let current = root.join("current");
        for version in ["9.6p1", "9.7p1"] {
            let daemon = root.join(version).join("usr/sbin/sshd");
            fs::create_dir_all(daemon.parent().unwrap()).unwrap();
            fs::write(&daemon, version).unwrap();
            fs::set_permissions(daemon, fs::Permissions::from_mode(0o555)).unwrap();
        }
        symlink("9.6p1", &current).unwrap();
        let original = Daemon::installed(&install, root.join("sshd_config")).unwrap();
        fs::remove_file(&current).unwrap();
        symlink("9.7p1", &current).unwrap();
        assert_eq!(
            original.command().get_program(),
            root.join("9.6p1/usr/sbin/sshd")
        );
        let updated = Daemon::installed(&install, root.join("sshd_config")).unwrap();
        assert_eq!(
            updated.command().get_program(),
            root.join("9.7p1/usr/sbin/sshd")
        );
        assert!(!original.fresh_in_this_runtime);
    }

    #[test]
    fn workspace_ssh_listener_rolls_back_and_fences_readiness() {
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path();
        let install = InstallLock::acquire(root).unwrap();
        let listener = Listener::default();
        fn sync(_: &Path) -> io::Result<()> {
            Ok(())
        }
        listener
            .switch(
                &install,
                candidate(root, "9.6p1"),
                || true,
                |_| Ok(()),
                sync,
            )
            .unwrap();
        assert!(listener
            .switch(
                &install,
                candidate(root, "9.7p1"),
                || false,
                |_| panic!("held candidate must not launch"),
                sync,
            )
            .is_err());
        let rejected = listener.switch(
            &install,
            candidate(root, "9.8p1"),
            || true,
            |_| Err(anyhow::anyhow!("candidate failed")),
            sync,
        );
        assert!(rejected.is_err());
        let rolled_back = listener.switch(
            &install,
            candidate(root, "9.9p1"),
            || true,
            |_| Ok(()),
            |_| Err(io::Error::other("simulated sync failure")),
        );
        assert!(rolled_back.is_err());
        assert_eq!(
            fs::read_link(root.join("current")).unwrap(),
            Path::new("9.6p1")
        );
        assert_eq!(
            listener
                .routing
                .lock()
                .unwrap()
                .active
                .as_ref()
                .unwrap()
                .directory,
            root.join("9.6p1")
        );
    }

    #[test]
    fn workspace_ssh_listener_keeps_the_old_version_while_a_session_pins_it() {
        let scratch = tempfile::tempdir().unwrap();
        let root = scratch.path();
        let install = InstallLock::acquire(root).unwrap();
        let listener = Listener::default();
        listener
            .switch(
                &install,
                candidate(root, "9.6p1"),
                || true,
                |_| Ok(()),
                |_| Ok(()),
            )
            .unwrap();
        let session = listener.routing.lock().unwrap().active.clone().unwrap();
        listener
            .switch(
                &install,
                candidate(root, "9.7p1"),
                || true,
                |_| Ok(()),
                |_| Ok(()),
            )
            .unwrap();
        listener.cleanup(&install, || true).unwrap();
        assert!(root.join("9.6p1").exists());
        drop(session);
        assert!(listener.cleanup(&install, || false).is_err());
        assert!(root.join("9.6p1").exists());
        listener.cleanup(&install, || true).unwrap();
        assert!(!root.join("9.6p1").exists());
        assert!(root.join("9.7p1").exists());
    }
    #[test]
    fn workspace_ssh_listener_handover_preserves_the_existing_socket_and_child() {
        use std::io::{BufRead, BufReader, Write};

        fn daemon(root: &Path, version: &str) -> Daemon {
            let daemon = candidate(root, version);
            let executable = daemon.directory.join("usr/sbin/sshd");
            fs::create_dir_all(executable.parent().unwrap()).unwrap();
            fs::write(&executable, format!(
                "#!/bin/sh\nwhile IFS= read -r line; do printf '%s:%s\\n' '{version}' \"$line\"; done\n"
            )).unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
            daemon
        }

        fn open(listener: &Listener) -> (BufReader<TcpStream>, Session) {
            let loopback = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let client = TcpStream::connect(loopback.local_addr().unwrap()).unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let (accepted, _) = loopback.accept().unwrap();
            (
                BufReader::new(client),
                listener.admit(accepted, || true).unwrap(),
            )
        }

        fn exchange(stream: &mut BufReader<TcpStream>, version: &str) {
            stream.get_mut().write_all(b"hello\n").unwrap();
            let mut response = String::new();
            stream.read_line(&mut response).unwrap();
            assert_eq!(response, format!("{version}:hello\n"));
        }

        let root = tempfile::tempdir().unwrap();
        let install = InstallLock::acquire(root.path()).unwrap();
        let listener = Listener::default();
        listener
            .switch(
                &install,
                daemon(root.path(), "9.6p1"),
                || true,
                |_| Ok(()),
                |_| Ok(()),
            )
            .unwrap();
        let (mut old, old_child) = open(&listener);
        exchange(&mut old, "9.6p1");

        listener
            .switch(
                &install,
                daemon(root.path(), "9.7p1"),
                || true,
                |_| Ok(()),
                |_| Ok(()),
            )
            .unwrap();
        let (mut new, new_child) = open(&listener);
        exchange(&mut new, "9.7p1");
        exchange(&mut old, "9.6p1");
        listener.cleanup(&install, || true).unwrap();
        assert!(root.path().join("9.6p1").is_dir());

        for (client, mut session) in [(old, old_child), (new, new_child)] {
            drop(client);
            assert!(session
                .process
                .wait_until(Instant::now() + DEADLINE)
                .unwrap()
                .success());
        }
        listener.cleanup(&install, || true).unwrap();
        assert!(!root.path().join("9.6p1").exists());
    }
}

#[cfg(test)]
mod real_sshd_tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    fn generate_key(path: &Path) {
        assert!(Command::new("/usr/bin/ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-f"])
            .arg(path)
            .status()
            .unwrap()
            .success());
    }

    fn open(
        listener: &Listener,
        root: &Path,
        host_key: &str,
        identity: &str,
    ) -> (OwnedChild, BufReader<std::process::ChildStdout>, Session) {
        let loopback = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = loopback.local_addr().unwrap().port();
        let known = root.join(format!("known_hosts-{port}"));
        fs::write(&known, format!("[127.0.0.1]:{port} {host_key}\n")).unwrap();
        let mut child = OwnedChild(
            Command::new("/usr/bin/ssh")
                .args(["-F", "/dev/null", "-T", "-p"])
                .arg(port.to_string())
                .args([
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "IdentitiesOnly=yes",
                    "-o",
                    "IdentityAgent=none",
                    "-o",
                    "StrictHostKeyChecking=yes",
                    "-o",
                    "GlobalKnownHostsFile=/dev/null",
                    "-o",
                    "UpdateHostKeys=no",
                    "-o",
                ])
                .arg(format!("UserKnownHostsFile={}", known.display()))
                .arg("-i")
                .arg(root.join(identity))
                .arg("terminalx-runtime@127.0.0.1")
                .arg("while IFS= read -r line; do printf '%s:%s\\n' \"$(id -un)\" \"$line\"; done")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + DEADLINE;
        loopback.set_nonblocking(true).unwrap();
        let connection = loop {
            match loopback.accept() {
                Ok((socket, _)) => break socket,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "ssh client did not connect");
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("accept SSH client: {error}"),
            }
        };
        let client_key = fs::read_to_string(root.join("client.pub")).unwrap();
        let key = client_key
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ");
        let session = listener.admit_key(connection, || Some(key)).unwrap();
        let output = BufReader::new(child.0.stdout.take().unwrap());
        (child, output, session)
    }

    fn exchange(
        child: &mut OwnedChild,
        output: &mut BufReader<std::process::ChildStdout>,
        value: &str,
    ) {
        writeln!(child.0.stdin.as_mut().unwrap(), "{value}").unwrap();
        let mut line = String::new();
        output.read_line(&mut line).unwrap();
        assert_eq!(line, format!("terminalx-runtime:{value}\n"));
    }

    #[test]
    #[ignore = "requires a disposable Linux runtime account and private OpenSSH binary"]
    fn real_private_sshd_handover_preserves_authenticated_command() {
        let binary = std::env::var_os("TERMINALX_TEST_SSHD").expect("supply private sshd");
        assert_ne!(unsafe { libc::geteuid() }, 0);
        assert_eq!(
            crate::workspace_ssh::LoginShell::current_account().hold_reason(),
            None
        );
        let home = std::env::var_os("HOME").expect("disposable runtime home");
        let scratch = tempfile::tempdir_in(home).unwrap();
        let root = scratch.path();
        let host = root.join("host");
        generate_key(&host);
        generate_key(&root.join("client"));
        generate_key(&root.join("other-client"));
        let host_key = parse_public_key(
            &fs::read_to_string(root.join("host.pub"))
                .unwrap()
                .split_whitespace()
                .take(2)
                .collect::<Vec<_>>()
                .join(" "),
        )
        .unwrap();
        let configuration = root.join("sshd_config");
        fs::write(&configuration, format!(
            "HostKey {}\nAuthorizedKeysFile none\nAllowUsers terminalx-runtime\nAuthenticationMethods publickey\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nDisableForwarding yes\nPrintMotd no\n",
            host.display()
        )).unwrap();
        let install = InstallLock::acquire(root).unwrap();
        let listener = Listener::default();
        let activate = |version| {
            let directory = root.join(version);
            let executable = directory.join("usr/sbin/sshd");
            fs::create_dir_all(executable.parent().unwrap()).unwrap();
            fs::copy(&binary, executable).unwrap();
            listener
                .activate(
                    &install,
                    Daemon {
                        directory,
                        configuration: configuration.clone(),
                        uncertain_session_exit: AtomicBool::new(false),
                        fresh_in_this_runtime: true,
                    },
                    &host_key,
                    || true,
                )
                .unwrap();
        };
        activate("9.6p1");
        let (mut old, mut old_output, mut old_session) = open(&listener, root, &host_key, "client");
        exchange(&mut old, &mut old_output, "before");
        activate("9.6p1-terminalx.1");
        let (mut new, mut new_output, new_session) = open(&listener, root, &host_key, "client");
        assert_ne!(old_session.daemon.directory, new_session.daemon.directory);
        let (mut wrong, _, wrong_session) = open(&listener, root, &host_key, "other-client");
        drop(wrong.0.stdin.take());
        assert_eq!(
            wrong.wait_until(Instant::now() + DEADLINE).unwrap().code(),
            Some(255)
        );
        drop(wrong_session);
        exchange(&mut new, &mut new_output, "new");
        exchange(&mut old, &mut old_output, "after");
        listener.cleanup(&install, || true).unwrap();
        assert!(root.join("9.6p1").is_dir());
        drop(old.0.stdin.take());
        assert!(old.wait_until(Instant::now() + DEADLINE).unwrap().success());
        let daemon_exited_cleanly = old_session
            .process
            .wait_until(Instant::now() + DEADLINE)
            .unwrap()
            .success();
        drop(old_session);
        listener.cleanup(&install, || true).unwrap();
        assert_eq!(root.join("9.6p1").exists(), !daemon_exited_cleanly);
    }
}
