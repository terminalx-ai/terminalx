//! Isolated OpenSSH inetd sessions. Only this module owns a listening socket;
//! sshd gets an already accepted loopback socket and never listens or changes
//! the machine's SSH service/config. Key refreshes fence existing sessions.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

use super::collab::{Access, Members};

const LEASE: Duration = Duration::from_secs(90);

struct Grants {
    keys: BTreeMap<String, Grant>,
    cancel: CancellationToken,
}

#[derive(Clone)]
struct Grant {
    absolute_ms: u64,
    deadline: Instant,
}

fn wall_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct Ssh {
    directory: PathBuf,
    port: u16,
    user: String,
    host_public_key: String,
    grants: Mutex<Grants>,
    changed: tokio::sync::Notify,
}

impl Ssh {
    /// Only called by the bootstrapped Linux cloud runtime, never the desktop
    /// or its local runtime. Paths are injectable for disposable acceptance.
    #[cfg(unix)]
    pub async fn start(directory: &Path, sshd: &Path, user: &str) -> Result<Arc<Self>> {
        if user.is_empty()
            || !user
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
        {
            bail!("invalid workspace user");
        }
        crate::workspace_ssh::private_directory(directory)?;
        let key = directory.join("host_ed25519");
        let host_public_key = crate::workspace_ssh::public_key(&key, true)?;
        crate::workspace_ssh::atomic_write(&directory.join("authorized_keys"), b"")?;
        let config = format!(
            "HostKey {}\nAuthorizedKeysFile {}\nStrictModes yes\nPubkeyAuthentication yes\nAuthenticationMethods publickey\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nPermitRootLogin prohibit-password\nAllowUsers {user}\nAllowAgentForwarding no\nDisableForwarding yes\nPermitTunnel no\nPermitUserEnvironment no\nPermitUserRC no\nPrintMotd no\nLogLevel QUIET\nLoginGraceTime 20\nMaxAuthTries 3\n",
            crate::workspace_ssh::config_quote(&key.to_string_lossy())?,
            crate::workspace_ssh::config_quote(&directory.join("authorized_keys").to_string_lossy())?
        );
        let config_path = directory.join("sshd_config");
        crate::workspace_ssh::atomic_write(&config_path, config.as_bytes())?;
        // Run the actual private executable/config before exposing ssh.info.
        // This catches missing executables, dynamic libraries, host keys and
        // invalid prerequisites without ever starting a daemon/listener.
        let check = tokio::process::Command::new(sshd)
            .arg("-t")
            .arg("-f")
            .arg(&config_path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .status();
        if !tokio::time::timeout(Duration::from_secs(5), check)
            .await
            .context("workspace SSH prerequisite check timed out")??
            .success()
        {
            bail!("workspace SSH prerequisites unavailable");
        }
        // No wildcard, environment bind address, inherited daemon or system config.
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let service = Arc::new(Self {
            directory: directory.to_owned(),
            port: listener.local_addr()?.port(),
            user: user.into(),
            host_public_key,
            grants: Mutex::new(Grants {
                keys: BTreeMap::new(),
                cancel: CancellationToken::new(),
            }),
            changed: tokio::sync::Notify::new(),
        });
        let weak = Arc::downgrade(&service);
        let sshd = sshd.to_owned();
        tokio::spawn(async move {
            let slots = Arc::new(tokio::sync::Semaphore::new(16));
            loop {
                let Some(service) = weak.upgrade() else { break };
                let deadline = service
                    .grants
                    .lock()
                    .unwrap()
                    .keys
                    .values()
                    .map(|grant| grant.deadline)
                    .min()
                    .unwrap_or_else(|| Instant::now() + Duration::from_secs(1));
                let accepted = tokio::select! {
                    accepted = listener.accept() => accepted,
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                        service.expire();
                        continue;
                    }
                    _ = service.changed.notified() => continue,
                };
                let Ok((socket, address)) = accepted else {
                    break;
                };
                let Some(service) = weak.upgrade() else { break };
                if !address.ip().is_loopback() {
                    continue;
                }
                service.expire();
                let Ok(slot) = slots.clone().try_acquire_owned() else {
                    continue;
                };
                let grants = service.grants.lock().unwrap();
                if grants.keys.is_empty() {
                    continue;
                }
                if grants
                    .keys
                    .values()
                    .any(|grant| wall_ms() >= grant.absolute_ms || Instant::now() >= grant.deadline)
                {
                    grants.cancel.cancel();
                    continue;
                }
                let cancel = grants.cancel.clone();
                // Spawn while holding the grant lock: refresh either precedes
                // admission or cancels this exact session's epoch.
                let spawned = (|| -> Result<tokio::process::Child> {
                    let socket = socket.into_std()?;
                    socket.set_nonblocking(false)?;
                    let input: std::os::fd::OwnedFd = socket.try_clone()?.into();
                    let output: std::os::fd::OwnedFd = socket.into();
                    let mut command = tokio::process::Command::new(&sshd);
                    command
                        .args(["-i", "-f"])
                        .arg(&config_path)
                        .stdin(std::process::Stdio::from(input))
                        .stdout(std::process::Stdio::from(output))
                        .stderr(std::process::Stdio::null())
                        .kill_on_drop(true);
                    command.process_group(0);
                    command.spawn().context("start workspace SSH session")
                })();
                drop(grants);
                if let Ok(mut child) = spawned {
                    tokio::spawn(async move {
                        let _slot = slot;
                        tokio::select! {
                            _ = child.wait() => {},
                            _ = cancel.cancelled() => {
                                if let Some(pid) = child.id() {
                                    // This child's new group only; no host service.
                                    unsafe { libc::kill(-(pid as i32), libc::SIGTERM); }
                                }
                                let _ = child.kill().await;
                                let _ = child.wait().await;
                            }
                        }
                    });
                }
            }
        });
        Ok(service)
    }

    pub fn update(&self, members: Option<&Members>) {
        self.update_at(members, wall_ms(), Instant::now());
    }

    fn update_at(&self, members: Option<&Members>, wall: u64, now: Instant) {
        self.expire_at(wall, now);
        let allowed = allowed_keys(members, wall);
        let mut grants = self.grants.lock().unwrap();
        let mut keys = BTreeMap::new();
        for (key, absolute_ms) in allowed {
            let mut deadline = now + Duration::from_millis(absolute_ms - wall).min(LEASE);
            // Replaying the same grant cannot move either clock's deadline.
            if let Some(old) = grants
                .keys
                .get(&key)
                .filter(|old| old.absolute_ms == absolute_ms)
            {
                deadline = deadline.min(old.deadline);
            }
            keys.insert(
                key,
                Grant {
                    absolute_ms,
                    deadline,
                },
            );
        }
        if !grants.keys.keys().eq(keys.keys()) {
            grants.cancel.cancel();
            grants.cancel = CancellationToken::new();
            grants.keys.clear();
            let text = keys
                .keys()
                .map(|key| format!("restrict,pty {key}\n"))
                .collect::<String>();
            if crate::workspace_ssh::atomic_write(
                &self.directory.join("authorized_keys"),
                text.as_bytes(),
            )
            .is_err()
            {
                keys.clear();
            }
        }
        grants.keys = keys;
        self.changed.notify_one();
    }

    fn expire(&self) {
        self.expire_at(wall_ms(), Instant::now());
    }

    fn expire_at(&self, wall: u64, now: Instant) {
        let mut grants = self.grants.lock().unwrap();
        if grants
            .keys
            .values()
            .any(|grant| wall >= grant.absolute_ms || now >= grant.deadline)
        {
            // OpenSSH owns authentication: expire the whole file/session epoch
            // at the earliest grant deadline. A fresh member update may restore
            // still-valid keys, but can never resurrect a cancelled session.
            grants.cancel.cancel();
            grants.keys.clear();
            let _ =
                crate::workspace_ssh::atomic_write(&self.directory.join("authorized_keys"), b"");
        }
    }

    pub fn info(&self) -> Value {
        json!({ "port": self.port, "user": self.user, "hostPublicKey": self.host_public_key })
    }
}

impl Drop for Ssh {
    fn drop(&mut self) {
        self.grants.lock().unwrap().cancel.cancel();
    }
}

fn allowed_keys(members: Option<&Members>, now: u64) -> BTreeMap<String, u64> {
    let Some(members) =
        members.filter(|m| m.v == 1 && m.members.len() <= super::collab::MAX_MEMBERS)
    else {
        return BTreeMap::new();
    };
    let mut keys = BTreeMap::new();
    for person in &members.members {
        let Some(until) = person.ssh_expires_at.filter(|until| *until > now) else {
            continue;
        };
        if person.user_id.is_empty()
            || !(Access {
                role: person.role,
                can_approve: person.can_approve,
            })
            .can_configure()
        {
            continue;
        }
        for key in person
            .ssh_public_keys
            .iter()
            .take(1)
            .filter_map(|key| crate::workspace_ssh::parse_public_key(key))
        {
            keys.entry(key)
                .and_modify(|old: &mut u64| *old = (*old).min(until))
                .or_insert(until);
        }
    }
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Ssh) {
        let directory = tempfile::tempdir().unwrap();
        let service = Ssh {
            directory: directory.path().into(),
            port: 1,
            user: "worker".into(),
            host_public_key: String::new(),
            grants: Mutex::new(Grants {
                keys: BTreeMap::new(),
                cancel: CancellationToken::new(),
            }),
            changed: tokio::sync::Notify::new(),
        };
        (directory, service)
    }

    fn grant(byte: u8, until: u64) -> Members {
        use base64::Engine;
        let mut blob = vec![0, 0, 0, 11];
        blob.extend(b"ssh-ed25519");
        blob.extend([0, 0, 0, 32]);
        blob.extend([byte; 32]);
        let key = format!(
            "ssh-ed25519 {}",
            base64::engine::general_purpose::STANDARD.encode(blob)
        );
        serde_json::from_value(json!({"v":1,"members":[{"userId":"person","role":"manager","canApprove":true,"sshPublicKeys":[key],"sshExpiresAt":until}]})).unwrap()
    }

    #[test]
    fn absolute_deadline_cancels_live_epoch_and_refuses_admission_without_refresh() {
        let (_dir, service) = fixture();
        let now = Instant::now();
        service.update_at(Some(&grant(1, 1_050)), 1_000, now);
        let epoch = service.grants.lock().unwrap().cancel.clone();
        service.expire_at(1_049, now + Duration::from_millis(49));
        assert!(!epoch.is_cancelled());
        service.expire_at(1_050, now + Duration::from_millis(50));
        assert!(epoch.is_cancelled());
        assert!(service.grants.lock().unwrap().keys.is_empty());
        service.update_at(
            Some(&grant(1, 1_050)),
            1_050,
            now + Duration::from_millis(50),
        );
        assert!(service.grants.lock().unwrap().keys.is_empty());
    }

    #[test]
    fn cached_replay_near_expiry_and_wall_clock_rollback_never_extend_deadline() {
        let (_dir, service) = fixture();
        let now = Instant::now();
        service.update_at(Some(&grant(1, 1_060)), 1_000, now);
        let epoch = service.grants.lock().unwrap().cancel.clone();
        service.update_at(
            Some(&grant(1, 1_060)),
            1_059,
            now + Duration::from_millis(59),
        );
        service.update_at(Some(&grant(1, 1_060)), 900, now + Duration::from_millis(59));
        service.expire_at(901, now + Duration::from_millis(60));
        assert!(epoch.is_cancelled());
        assert!(service.grants.lock().unwrap().keys.is_empty());
    }

    #[test]
    fn rotation_cancels_old_sessions_and_renewed_grant_can_extend_only_valid_epoch() {
        let (_dir, service) = fixture();
        let now = Instant::now();
        service.update_at(Some(&grant(1, 1_050)), 1_000, now);
        let old = service.grants.lock().unwrap().cancel.clone();
        service.update_at(
            Some(&grant(2, 1_060)),
            1_010,
            now + Duration::from_millis(10),
        );
        assert!(old.is_cancelled());
        let renewed = service.grants.lock().unwrap().cancel.clone();
        service.update_at(
            Some(&grant(2, 1_100)),
            1_050,
            now + Duration::from_millis(50),
        );
        service.expire_at(1_060, now + Duration::from_millis(60));
        assert!(!renewed.is_cancelled());
        service.expire_at(1_100, now + Duration::from_millis(100));
        assert!(renewed.is_cancelled());
        service.update_at(
            Some(&grant(2, 1_200)),
            1_100,
            now + Duration::from_millis(100),
        );
        assert!(!service.grants.lock().unwrap().keys.is_empty());
        assert!(
            renewed.is_cancelled(),
            "renewal never revives an expired session"
        );
    }

    #[test]
    fn local_liveness_can_shorten_long_server_grant() {
        let (_dir, service) = fixture();
        let now = Instant::now();
        service.update_at(Some(&grant(1, 1_000_000)), 1_000, now);
        let epoch = service.grants.lock().unwrap().cancel.clone();
        service.update_at(
            Some(&grant(1, 1_000_000)),
            90_999,
            now + LEASE - Duration::from_millis(1),
        );
        service.expire_at(91_000, now + LEASE);
        assert!(epoch.is_cancelled());
    }

    #[test]
    fn viewer_and_unapproved_driver_never_authorize_a_key_and_removal_clears_it() {
        use base64::Engine;
        let mut blob = vec![0, 0, 0, 11];
        blob.extend(b"ssh-ed25519");
        blob.extend([0, 0, 0, 32]);
        blob.extend([7; 32]);
        let key = format!(
            "ssh-ed25519 {}",
            base64::engine::general_purpose::STANDARD.encode(blob)
        );
        let list = |role, approve| {
            serde_json::from_value::<Members>(json!({"v":1,"members":[{"userId":"person","role":role,"canApprove":approve,"sshPublicKeys":[key],"sshExpiresAt":u64::MAX}]})).unwrap()
        };
        assert!(allowed_keys(Some(&list("viewer", true)), wall_ms()).is_empty());
        assert!(allowed_keys(Some(&list("driver", false)), wall_ms()).is_empty());
        assert_eq!(
            allowed_keys(Some(&list("driver", true)), wall_ms()).len(),
            1
        );
        assert_eq!(
            allowed_keys(Some(&list("manager", false)), wall_ms()).len(),
            1
        );
        assert!(allowed_keys(None, wall_ms()).is_empty());
        let dir = tempfile::tempdir().unwrap();
        let service = Ssh {
            directory: dir.path().into(),
            port: 1,
            user: "worker".into(),
            host_public_key: key.clone(),
            grants: Mutex::new(Grants {
                keys: BTreeMap::new(),
                cancel: CancellationToken::new(),
            }),
            changed: tokio::sync::Notify::new(),
        };
        service.update(Some(&list("manager", false)));
        let epoch = service.grants.lock().unwrap().cancel.clone();
        service.update(Some(&list("viewer", true)));
        assert!(epoch.is_cancelled());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("authorized_keys")).unwrap(),
            ""
        );
    }
}

/// Run only inside an existing disposable Linux workspace with OpenSSH. This
/// starts no system service; it exercises the product's exact inetd listener.
#[cfg(all(test, target_os = "linux"))]
mod acceptance {
    use super::*;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires a controlled disposable Linux workspace with OpenSSH"]
    async fn real_ssh_shell_bind_viewer_and_removal() {
        assert_eq!(
            std::env::var("TERMINALX_DISPOSABLE_SSH_ACCEPTANCE").as_deref(),
            Ok("1")
        );
        let temp = tempfile::tempdir().unwrap();
        let identity = temp.path().join("person");
        let public = crate::workspace_ssh::public_key(&identity, true).unwrap();
        let user = "terminalx-runtime".to_string();
        let actual = std::process::Command::new("id")
            .arg("-un")
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(actual.stdout).unwrap().trim(), user,
            "run this acceptance as the bootstrapped product service user, never root or an arbitrary test user");
        let binary = std::env::var_os("TERMINALX_TEST_SSHD")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/opt/terminalx/openssh/usr/sbin/sshd"));
        let service = Ssh::start(&temp.path().join("runtime"), &binary, &user)
            .await
            .unwrap();
        let list = |role| {
            serde_json::from_value::<Members>(json!({"v":1,"members":[{"userId":"person","role":role,"canApprove":true,"sshPublicKeys":[public],"sshExpiresAt":u64::MAX}]})).unwrap()
        };
        let run = || {
            let mut ssh = tokio::process::Command::new("ssh");
            ssh.args([
                "-F",
                "/dev/null",
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "IdentityAgent=none",
                "-o",
                "ConnectTimeout=3",
                "-o",
            ])
            .arg(format!(
                "UserKnownHostsFile={}",
                temp.path().join("known_hosts").display()
            ))
            .arg("-i")
            .arg(&identity)
            .arg("-p")
            .arg(service.port.to_string())
            .arg(format!("{user}@127.0.0.1"))
            .arg("id -un")
            .kill_on_drop(true);
            ssh
        };
        std::fs::write(
            temp.path().join("known_hosts"),
            format!("[127.0.0.1]:{} {}\n", service.port, service.host_public_key),
        )
        .unwrap();
        service.update(Some(&list("manager")));
        let output = tokio::time::timeout(Duration::from_secs(10), run().output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "isolated OpenSSH shell did not open"
        );
        assert_eq!(String::from_utf8(output.stdout).unwrap().trim(), user);
        for interface in if_addrs::get_if_addrs()
            .unwrap()
            .into_iter()
            .filter(|i| !i.ip().is_loopback() && i.ip().is_ipv4())
        {
            assert!(!matches!(
                tokio::time::timeout(
                    Duration::from_secs(1),
                    tokio::net::TcpStream::connect((interface.ip(), service.port))
                )
                .await,
                Ok(Ok(_))
            ));
        }
        service.update(Some(&list("viewer")));
        assert!(!run().status().await.unwrap().success());
        service.update(Some(&list("manager")));
        service.update(Some(&Members {
            v: 1,
            members: vec![],
        }));
        assert!(!run().status().await.unwrap().success());
    }
}
