//! Real OpenSSH clients and isolated loopback/stdio sshd. No OS service, installed
//! ssh config, shared socket, host key or developer credential is modified.
use super::*;
use std::process::{Child, Stdio};

struct Server {
    port: u16,
    stop: Arc<std::sync::atomic::AtomicBool>,
    thread: Option<std::thread::JoinHandle<Vec<Child>>>,
}

impl Server {
    fn new(config: PathBuf, connections: PathBuf) -> Self {
        use std::os::fd::OwnedFd;
        use std::sync::atomic::{AtomicBool, Ordering};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            use std::io::Write;
            let mut children = Vec::new();
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((socket, _)) => {
                        socket.set_nonblocking(false).unwrap();
                        let input: OwnedFd = socket.try_clone().unwrap().into();
                        let output: OwnedFd = socket.into();
                        let child = Command::new("/usr/sbin/sshd").args(["-i", "-e", "-f"]).arg(&config)
                            .stdin(Stdio::from(input)).stdout(Stdio::from(output)).stderr(Stdio::null()).spawn().unwrap();
                        writeln!(std::fs::OpenOptions::new().create(true).append(true).open(&connections).unwrap(), "{}", child.id()).unwrap();
                        children.push(child);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
                    Err(error) => panic!("fixture SSH listener: {error}"),
                }
            }
            children
        });
        Self { port, stop, thread: Some(thread) }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        for mut child in self.thread.take().unwrap().join().unwrap() { let _ = child.kill(); let _ = child.wait(); }
    }
}

struct Ssh {
    config: PathBuf,
    socket: PathBuf,
    connections: PathBuf,
    clients: PathBuf,
    entered: PathBuf,
    hold: PathBuf,
    master: Option<Child>,
    master_host: &'static str,
    _server: Server,
    _socket_dir: tempfile::TempDir,
}

fn checked(command: &mut Command) {
    let out = command.output().unwrap();
    assert!(out.status.success(), "{command:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn config_path(path: &Path) -> String { format!("\"{}\"", path.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"")) }

impl Ssh {
    fn new(f: &Fixture) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let dir = f.cwd.parent().unwrap();
        let host = dir.join("host-key");
        let identity = dir.join("identity");
        for key in [&host, &identity] {
            checked(Command::new("/usr/bin/ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(key));
        }
        let user = Command::new("/usr/bin/id").arg("-un").output().unwrap();
        assert!(user.status.success());
        let user = String::from_utf8(user.stdout).unwrap().trim().to_string();
        let socket_dir = tempfile::tempdir_in("/tmp").unwrap();
        let socket = socket_dir.path().join("master.sock");
        let connections = dir.join("connections");
        let clients = dir.join("ssh-clients");
        let entered = dir.join("ssh-object-entered");
        let hold = dir.join("ssh-hold");
        let first = dir.join("ssh-first");
        let serve = dir.join("serve-git");
        let daemon = dir.join("sshd.conf");
        let ssh = dir.join("observed-openssh");
        let config = dir.join("ssh.conf");
        std::fs::write(&serve, format!(r#"#!/bin/sh
case "$SSH_ORIGINAL_COMMAND" in git-upload-pack*) ;; *) exit 95 ;; esac
if [ ! -f {first} ]; then : > {first};
elif [ -f {hold} ]; then
 printf '%s\n' "$$" > {entered}
 # Withhold upload-pack's greeting until the client is cancelled. Closing
 # the SSH channel closes this stdin too; no orphaned timed sleep remains.
 exec /bin/cat > /dev/null
fi
exec /usr/bin/git upload-pack {origin}
"#, first=quote(&first), hold=quote(&hold), entered=quote(&entered), origin=quote(&f.origin))).unwrap();
        std::fs::write(&daemon, format!("HostKey {}\nAuthorizedKeysFile {}\nStrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin yes\nLogLevel ERROR\nForceCommand /bin/sh {}\n", config_path(&host), config_path(&identity.with_extension("pub")), quote(&serve))).unwrap();
        // A loopback listener gives each connection to a fresh stdio sshd.
        // No ProxyCommand is needed; an app transport never owns this server.
        let server = Server::new(daemon, connections.clone());
        std::fs::write(&ssh, format!("#!/bin/sh\nprintf '%s\\n' \"$$\" >> {}\nexec /usr/bin/ssh \"$@\"\n", quote(&clients))).unwrap();
        for file in [&serve, &ssh] { std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap(); }
        std::fs::write(&config, format!("Host *\n HostName 127.0.0.1\n Port {}\n User {user}\n IdentityFile {}\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking no\n UserKnownHostsFile /dev/null\n LogLevel ERROR\n ControlMaster auto\n ControlPersist 60\n ControlPath {}\n", server.port, config_path(&identity), config_path(&socket))).unwrap();
        git(&f.cwd, &["config", "core.sshCommand", &format!("{} -F {}", quote(&ssh), quote(&config))]);
        git(&f.cwd, &["config", "ssh.variant", "auto"]);
        Self { config, socket, connections, clients, entered, hold, master: None, master_host: "privacy-pull", _server: server, _socket_dir: socket_dir }
    }

    fn connections(&self) -> usize { std::fs::read_to_string(&self.connections).unwrap_or_default().lines().count() }

    fn master(&mut self) {
        use std::os::unix::process::CommandExt;
        let child = Command::new("/usr/bin/ssh").arg("-F").arg(&self.config).args(["-o", "ControlPersist=no", "-M", "-N", self.master_host])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0).spawn().unwrap();
        self.master = Some(child);
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.socket.exists() {
            assert!(self.master.as_mut().unwrap().try_wait().unwrap().is_none(), "real test master failed to start");
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        self.master_alive();
    }

    fn master_alive(&self) {
        if let Some(master) = &self.master {
            assert_eq!(unsafe { libc::kill(master.id() as i32, 0) }, 0, "unrelated master was killed");
            checked(Command::new("/usr/bin/ssh").arg("-F").arg(&self.config).args(["-O", "check", self.master_host]));
        }
    }

    fn clients_dead(&self) {
        for line in std::fs::read_to_string(&self.clients).unwrap_or_default().lines() {
            let pid: i32 = line.parse().unwrap();
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "app SSH client remains after drain");
        }
        if self.master.is_none() { assert!(!self.socket.exists(), "app created a persistent master"); }
        self.master_alive();
    }
}

impl Drop for Ssh {
    fn drop(&mut self) {
        // This fixture owns this exact socket and optional master. Never issue
        // an unqualified exit or kill another user's master/SSH process.
        if self.socket.exists() {
            let _ = Command::new("/usr/bin/ssh").arg("-F").arg(&self.config).args(["-O", "exit", self.master_host])
                .stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        if let Some(mut child) = self.master.take() { let _ = child.kill(); let _ = child.wait(); }
    }
}

pub(super) fn run(root: &Path, managed: bool, runtime: Option<&tokio::runtime::Runtime>) {
    proxy_refusal(root, managed, runtime);
    for master in [false, true] {
        println!("privacy real OpenSSH: managed={managed}/existing-master={master}/desktop={}", runtime.is_some());
        let _environment = Environment::new(root);
        policy(false, managed);
        let f = Fixture::new(root, &format!("openssh-{master}-{}", runtime.is_some()));
        let mut ssh = Ssh::new(&f);
        if master { ssh.master(); }
        let pull = || {
            #[cfg(feature = "desktop")]
            if let Some(runtime) = runtime { return runtime.block_on(f.ipc("git.pull")); }
            f.workspace("git.pull")
        };
        let before = ssh.connections();
        policy(true, managed); denied(pull());
        policy(false, managed);
        let stale = crate::github_process::queued(pull);
        policy(true, managed); policy(false, managed);
        denied(stale());
        assert_eq!(ssh.connections(), before);
        ssh.master_alive();
        std::fs::write(&ssh.hold, "").unwrap();
        std::thread::scope(|scope| {
            let worker = scope.spawn(crate::github_process::queued(pull));
            let deadline = Instant::now() + Duration::from_secs(12);
            while !ssh.entered.exists() {
                assert!(Instant::now() < deadline && !worker.is_finished(), "actual sshd did not reach demanded-object fetch");
                std::thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(ssh.connections(), before + 2, "must not reuse the unrelated master");
            assert_eq!(git(&f.cwd, &["rev-parse", "origin/main"]), f.after);
            f.missing();
            let started = Instant::now(); policy(true, managed);
            assert!(started.elapsed() < Duration::from_secs(5));
            ssh.clients_dead();
            denied(worker.join().unwrap());
        });
        f.unchanged(); f.missing();
        let after = ssh.connections();
        policy(false, managed);
        assert_eq!(ssh.connections(), after, "no replay or post-ack transfer");
        std::fs::remove_file(&ssh.hold).unwrap();
        pull().unwrap();
        assert_eq!(git(&f.cwd, &["rev-parse", "HEAD"]), f.after);
        assert_eq!(std::fs::read(f.cwd.join(FILE)).unwrap(), NEW);
        assert!(ssh.connections() >= after + 2);
        ssh.clients_dead();
    }
}

fn proxy_refusal(root: &Path, managed: bool, runtime: Option<&tokio::runtime::Runtime>) {
    for route in ["ProxyJump", "ProxyCommand"] {
        for existing_master in [false, true] {
            let _environment = Environment::new(root);
            policy(false, managed);
            let f = Fixture::new(root, &format!("proxy-{route}-{existing_master}-{}", runtime.is_some()));
            let mut ssh = Ssh::new(&f);
            let direct = std::fs::read_to_string(&ssh.config).unwrap();
            let proxy = if route == "ProxyJump" { "ProxyJump privacy-jump".to_string() }
                else { format!("ProxyCommand /usr/bin/ssh -F {} -W %h:%p privacy-jump", quote(&ssh.config)) };
            std::fs::write(&ssh.config, format!("Host privacy-pull\n {proxy}\n ControlPath none\n{direct}")).unwrap();
            ssh.master_host = "privacy-jump";
            if existing_master { ssh.master(); }

            // Ordinary Git is a discriminating positive control: this really
            // routes through nested OpenSSH and reuses/creates a jump master.
            let before = ssh.connections();
            let out = Command::new("/usr/bin/git").current_dir(&f.cwd).args(["fetch", "origin"])
                .env_remove("GIT_NO_LAZY_FETCH").output().unwrap();
            assert!(out.status.success(), "real {route} control failed: {}", String::from_utf8_lossy(&out.stderr));
            assert!(ssh.connections() > before);
            assert!(ssh.socket.exists(), "control must actually use a persistent jump master");
            if !existing_master {
                checked(Command::new("/usr/bin/ssh").arg("-F").arg(&ssh.config).args(["-O", "exit", "privacy-jump"]));
                let until = Instant::now() + Duration::from_secs(5);
                while ssh.socket.exists() { assert!(Instant::now() < until); std::thread::sleep(Duration::from_millis(5)); }
            }
            let pull = || {
                #[cfg(feature = "desktop")]
                if let Some(runtime) = runtime { return runtime.block_on(f.ipc("git.pull")); }
                f.workspace("git.pull")
            };
            let before = ssh.connections();
            policy(true, managed); denied(pull());
            policy(false, managed);
            let stale = crate::github_process::queued(pull);
            policy(true, managed); policy(false, managed); denied(stale());
            let error = pull().unwrap_err();
            assert!(error.contains("cannot safely contain") && error.to_ascii_lowercase().contains(&route.to_ascii_lowercase()), "{error}");
            let error = crate::git::fetch_admitted(&f.cwd, "main", Duration::from_secs(10)).unwrap_err();
            assert!(error.to_string().contains("cannot safely contain"), "verification fetch must share refusal: {error}");
            assert_eq!(ssh.connections(), before, "refusal must precede any primary/jump connection");
            ssh.clients_dead(); f.unchanged(); f.missing();

            // An explicit direct configuration restores transfers; the app
            // never removes a proxy silently or kills an unrelated master.
            std::fs::write(&ssh.config, direct).unwrap();
            pull().unwrap();
            assert_eq!(git(&f.cwd, &["rev-parse", "HEAD"]), f.after);
            assert_eq!(std::fs::read(f.cwd.join(FILE)).unwrap(), NEW);
            assert!(ssh.connections() > before);
            ssh.clients_dead();
        }
    }
}
