//! Real OpenSSH clients and an isolated stdio sshd. No OS service, installed
//! ssh config, shared socket, host key or developer credential is modified.
use super::*;
use std::process::{Child, Stdio};

struct Ssh {
    config: PathBuf,
    socket: PathBuf,
    connections: PathBuf,
    clients: PathBuf,
    entered: PathBuf,
    hold: PathBuf,
    master: Option<Child>,
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
        let proxy = dir.join("stdio-server");
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
        // Every real encrypted SSH connection must run a new proxy/server.
        // A mux reuse bypasses this observer and therefore fails the counts.
        std::fs::write(&proxy, format!("#!/bin/sh\nprintf '%s %s\\n' \"$$\" \"$PPID\" >> {}\nexec /usr/sbin/sshd -i -e -f {}\n", quote(&connections), quote(&daemon))).unwrap();
        std::fs::write(&ssh, format!("#!/bin/sh\nprintf '%s\\n' \"$$\" >> {}\nexec /usr/bin/ssh \"$@\"\n", quote(&clients))).unwrap();
        for file in [&serve, &proxy, &ssh] { std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o755)).unwrap(); }
        std::fs::write(&config, format!("Host *\n HostName privacy-stdio\n User {user}\n IdentityFile {}\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking no\n UserKnownHostsFile /dev/null\n LogLevel ERROR\n ProxyCommand /bin/sh {}\n ControlMaster auto\n ControlPersist 60\n ControlPath {}\n", config_path(&identity), quote(&proxy), config_path(&socket))).unwrap();
        git(&f.cwd, &["config", "core.sshCommand", &format!("{} -F {}", quote(&ssh), quote(&config))]);
        git(&f.cwd, &["config", "ssh.variant", "auto"]);
        Self { config, socket, connections, clients, entered, hold, master: None, _socket_dir: socket_dir }
    }

    fn connections(&self) -> usize { std::fs::read_to_string(&self.connections).unwrap_or_default().lines().count() }

    fn master(&mut self) {
        use std::os::unix::process::CommandExt;
        let child = Command::new("/usr/bin/ssh").arg("-F").arg(&self.config).args(["-o", "ControlPersist=no", "-M", "-N", "privacy-pull"])
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
            checked(Command::new("/usr/bin/ssh").arg("-F").arg(&self.config).args(["-O", "check", "privacy-pull"]));
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
            let _ = Command::new("/usr/bin/ssh").arg("-F").arg(&self.config).args(["-O", "exit", "privacy-pull"])
                .stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
        if let Some(mut child) = self.master.take() { let _ = child.kill(); let _ = child.wait(); }
    }
}

pub(super) fn run(root: &Path, managed: bool, runtime: Option<&tokio::runtime::Runtime>) {
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
