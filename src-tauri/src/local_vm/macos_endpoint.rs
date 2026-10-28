//! Endpoint observation for the pinned Lume 0.6.1 NAT/config contract.
//! No Lume `get`: upstream may clear session markers and probe SSH. Read only
//! the retained private VM/config inodes, its run lease and unexpired vmnet
//! DHCP entries. This locates a candidate; pinned SSH trust still authenticates
//! the guest before any RPC. It never proves exit, account setup or readiness.
use super::{
    journal::{self, Environment},
    macos_personalization::Target,
    macos_transport::{self, Endpoint},
};
use anyhow::{bail, Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::Read,
    net::Ipv4Addr,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pin {
    version: u32,
    target: Target,
    sandbox: String,
    storage: PathBuf,
    name: String,
    snapshot: Value,
}
fn metadata(path: &Path, directory: bool) -> Result<Value> {
    let m = std::fs::symlink_metadata(path)?;
    // SAFETY: geteuid has no memory preconditions.
    if (if directory {
        !m.is_dir()
    } else {
        !m.is_file() || m.nlink() != 1
    }) || m.uid() != unsafe { libc::geteuid() }
        || m.mode() & (if directory { 0o077 } else { 0o022 }) != 0
        || path.canonicalize()? != path
    {
        bail!("Pinned VM path must be owned, unaliased and not writable by another account")
    }
    Ok(json!({"device":m.dev(),"inode":m.ino()}))
}
fn read(path: &Path, bound: u64) -> Result<Vec<u8>> {
    let f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let m = f.metadata()?;
    if !m.is_file() || m.nlink() != 1 || m.mode() & 0o022 != 0 {
        bail!("Unsafe endpoint evidence file")
    }
    let mut bytes = Vec::new();
    f.take(bound + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > bound {
        bail!("Endpoint evidence exceeds bound")
    }
    Ok(bytes)
}
fn mac(value: &str) -> Result<String> {
    let components = value
        .split(':')
        .map(|part| {
            if part.is_empty() || part.len() > 2 {
                bail!("Invalid VM MAC")
            }
            Ok(format!("{:02x}", u8::from_str_radix(part, 16)?))
        })
        .collect::<Result<Vec<_>>>()?;
    if components.len() != 6 {
        bail!("Invalid VM MAC")
    }
    Ok(components.join(":"))
}
fn snapshot(storage: &Path, name: &str) -> Result<Value> {
    if !storage.is_absolute()
        || name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c))
    {
        bail!("Explicit VM storage and name required")
    }
    let storage_identity = metadata(storage, true)?;
    let vm = storage.join(name);
    let directory = metadata(&vm, true)?;
    let config_identity = metadata(&vm.join("config.json"), false)?;
    let config: Value = serde_json::from_slice(&read(&vm.join("config.json"), 64 * 1024)?)?;
    if config["os"] != "macOS" || config["networkMode"] != "nat" {
        bail!("Personalized endpoint requires explicit macOS NAT config")
    }
    for field in ["hardwareModel", "machineIdentifier"] {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(config[field].as_str().context("VM identity data missing")?)?;
        if bytes.is_empty() || bytes.len() > 16 * 1024 {
            bail!("Invalid VM hardware identity")
        }
    }
    mac(config["macAddress"].as_str().context("VM MAC missing")?)?;
    Ok(
        json!({"storage":storage,"name":name,"storageIdentity":storage_identity,"directory":directory,
        "configIdentity":config_identity,"config":config,"disk":metadata(&vm.join("disk.img"),false)?,
        "nvram":metadata(&vm.join("nvram.bin"),false)?}),
    )
}
fn fingerprint(value: &Value) -> Result<String> {
    Ok(journal::digest(&serde_json::to_vec(value)?))
}
fn lease_ip(text: &str, expected_mac: &str, now: u64) -> Result<Ipv4Addr> {
    let expected_mac = mac(expected_mac)?;
    let mut entry = None::<BTreeMap<&str, &str>>;
    let mut candidates = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        match line {
            "{" => {
                if entry.is_some() {
                    bail!("Malformed DHCP lease block")
                }
                entry = Some(BTreeMap::new());
            }
            "}" => {
                let fields = entry.take().context("Unpaired DHCP lease block")?;
                let Some((kind, address)) =
                    fields.get("hw_address").and_then(|v| v.split_once(','))
                else {
                    continue;
                };
                if kind != "1" || mac(address)? != expected_mac {
                    continue;
                }
                let expires = u64::from_str_radix(
                    fields
                        .get("lease")
                        .context("VM lease expiry missing")?
                        .trim_start_matches("0x"),
                    16,
                )?;
                if expires <= now {
                    continue;
                }
                let ip: Ipv4Addr = fields.get("ip_address").context("VM IP missing")?.parse()?;
                if !ip.is_private() || ip.is_loopback() || ip.is_unspecified() {
                    bail!("Unsafe VM endpoint")
                }
                candidates.push(ip);
            }
            _ => {
                let (k, v) = line.split_once('=').context("Invalid DHCP field")?;
                if entry
                    .as_mut()
                    .context("DHCP field outside block")?
                    .insert(k.trim(), v.trim())
                    .is_some()
                {
                    bail!("Duplicate DHCP field")
                }
            }
        }
    }
    if entry.is_some() || candidates.len() != 1 {
        bail!("One unexpired exact-MAC lease is required; no cached IP or ARP fallback")
    }
    Ok(candidates[0])
}
fn held_config(pin: &Pin) -> Result<File> {
    let path = pin.storage.join(&pin.name).join("config.json");
    let f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let m = f.metadata()?;
    if json!({"device":m.dev(),"inode":m.ino()}) != pin.snapshot["configIdentity"] {
        bail!("VM config inode replaced")
    }
    // SAFETY: f owns the descriptor. A successful probe means no Lume run
    // lease; drop releases it immediately. Contention is never exit proof.
    if unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        bail!("Pinned VM has no observed run lease")
    }
    if std::io::Error::last_os_error().kind() != std::io::ErrorKind::WouldBlock {
        bail!("VM run lease observation failed")
    }
    Ok(f)
}
fn observe_using(
    pin: &Pin,
    target: &Target,
    sandbox: &str,
    leases: impl FnOnce() -> Result<String>,
    now: u64,
) -> Result<Endpoint> {
    target.validate()?;
    if pin.version != 1
        || &pin.target != target
        || pin.sandbox != sandbox
        || fingerprint(&pin.snapshot)? != target.vm_fingerprint
    {
        bail!("Retained VM/config binding changed")
    }
    if snapshot(&pin.storage, &pin.name)? != pin.snapshot {
        bail!("Pinned VM files/config changed")
    }
    let _config = held_config(pin)?;
    let ip = lease_ip(
        &leases()?,
        pin.snapshot["config"]["macAddress"]
            .as_str()
            .context("MAC missing")?,
        now,
    )?;
    if snapshot(&pin.storage, &pin.name)? != pin.snapshot {
        bail!("VM changed during endpoint observation")
    }
    let _fresh = held_config(pin)?;
    Ok(Endpoint {
        target: target.clone(),
        sandbox: sandbox.into(),
        ip,
        running: true,
    })
}
/// Future provisioning must retain this binding before account/trust capture.
/// No control RPC, caller-supplied pin or production provisioner invokes it yet.
#[allow(dead_code)]
pub(super) fn retain(
    root: &Path,
    bootstrap_id: &str,
    target: &Target,
    sandbox: &str,
    storage: &Path,
    name: &str,
) -> Result<()> {
    journal::validate_id(bootstrap_id)?;
    journal::validate_sandbox(sandbox)?;
    target.validate()?;
    let snapshot = snapshot(storage, name)?;
    if fingerprint(&snapshot)? != target.vm_fingerprint {
        bail!("Provisioned VM fingerprint differs")
    }
    let pin = Pin {
        version: 1,
        target: target.clone(),
        sandbox: sandbox.into(),
        storage: storage.into(),
        name: name.into(),
        snapshot,
    };
    let directory = root.join("macos-endpoints");
    journal::private_directory(&directory)?;
    let path = directory.join(format!("{bootstrap_id}.json"));
    let bytes = serde_json::to_vec(&pin)?;
    // A complete original receipt is idempotent; interrupted/changed bytes
    // remain fenced. Never overwrite a pin or infer completion from its name.
    if path.try_exists()? {
        metadata(&path, false)?;
        if read(&path, 96 * 1024)? != bytes {
            bail!("Retained provisioning pin is changed or incomplete")
        }
        return Ok(());
    }
    // First write only. No replacement/rebinding of a retained provisioning pin.
    use std::io::Write;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    File::open(directory)?.sync_all()?;
    Ok(())
}
pub(super) fn observe(root: &Path, env: &Environment) -> Result<Endpoint> {
    let binding = macos_transport::binding(env)?;
    binding.check_retained(root)?;
    let path = root
        .join("macos-endpoints")
        .join(format!("{}.json", binding.bootstrap_id));
    metadata(path.parent().context("Endpoint directory missing")?, true)?;
    metadata(&path, false)?;
    let pin: Pin = serde_json::from_slice(&read(&path, 96 * 1024)?)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    observe_using(
        &pin,
        &binding.target,
        &env.sandbox,
        || {
            let path = Path::new("/var/db/dhcpd_leases");
            if std::fs::symlink_metadata(path)?.uid() != 0 {
                bail!("System vmnet lease ownership changed")
            }
            Ok(String::from_utf8(read(path, 1024 * 1024)?)?)
        },
        now,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    fn fixture() -> (tempfile::TempDir, Pin, File) {
        let dir = tempfile::tempdir().unwrap();
        let storage = dir.path().canonicalize().unwrap();
        std::fs::set_permissions(&storage, std::fs::Permissions::from_mode(0o700)).unwrap();
        let vm = storage.join("fixture");
        std::fs::create_dir(&vm).unwrap();
        std::fs::set_permissions(&vm, std::fs::Permissions::from_mode(0o700)).unwrap();
        let config = json!({"os":"macOS","networkMode":"nat","macAddress":"02:00:00:00:00:01","machineIdentifier":"YWJj","hardwareModel":"ZGVm","cpuCount":4,"display":"1024x768"});
        for (name, bytes) in [
            ("config.json", config.to_string()),
            ("disk.img", "disposable".into()),
            ("nvram.bin", "disposable".into()),
        ] {
            std::fs::write(vm.join(name), bytes).unwrap();
            std::fs::set_permissions(vm.join(name), std::fs::Permissions::from_mode(0o600))
                .unwrap();
        }
        let snapshot = snapshot(&storage, "fixture").unwrap();
        let target = Target {
            environment_id: journal::new_id(),
            generation: journal::new_id(),
            vm_fingerprint: fingerprint(&snapshot).unwrap(),
            restore_sha256: "a".repeat(64),
            macos_major: 26,
        };
        let file = File::open(vm.join("config.json")).unwrap();
        // SAFETY: the disposable file owns its descriptor for the fixture.
        assert_eq!(
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        (
            dir,
            Pin {
                version: 1,
                target,
                sandbox: "local:fixture".into(),
                storage,
                name: "fixture".into(),
                snapshot,
            },
            file,
        )
    }
    fn leases() -> String {
        "{\nhw_address=1,2:0:0:0:0:1\nip_address=192.168.64.2\nlease=0xffffffff\n}\n".into()
    }
    #[test]
    fn exact_config_and_live_lease_locate_only_pinned_nat_candidate() {
        let (_dir, pin, lock) = fixture();
        let endpoint =
            observe_using(&pin, &pin.target, &pin.sandbox, || Ok(leases()), 100).unwrap();
        assert_eq!(endpoint.ip.to_string(), "192.168.64.2");
        assert_eq!(endpoint.target, pin.target);
        assert!(observe_using(
            &pin,
            &pin.target,
            "local:other",
            || panic!("wrong VM observed"),
            100
        )
        .is_err());
        assert!(observe_using(
            &pin,
            &pin.target,
            &pin.sandbox,
            || Ok(leases().repeat(2)),
            100
        )
        .is_err());
        assert!(observe_using(
            &pin,
            &pin.target,
            &pin.sandbox,
            || Ok(leases()),
            u32::MAX as u64
        )
        .is_err());
        drop(lock);
        assert!(observe_using(
            &pin,
            &pin.target,
            &pin.sandbox,
            || panic!("stopped VM routed"),
            100
        )
        .is_err());
    }
    #[test]
    fn replaced_config_files_or_generation_and_mid_observation_changes_refuse() {
        let (_dir, pin, _lock) = fixture();
        let mut changed = pin.target.clone();
        changed.generation = journal::new_id();
        assert!(observe_using(
            &pin,
            &changed,
            &pin.sandbox,
            || panic!("changed generation"),
            100
        )
        .is_err());
        let disk = pin.storage.join(&pin.name).join("disk.img");
        assert!(observe_using(
            &pin,
            &pin.target,
            &pin.sandbox,
            || {
                std::fs::rename(&disk, disk.with_extension("retained"))?;
                std::fs::write(&disk, b"replacement")?;
                Ok(leases())
            },
            100
        )
        .is_err());
        assert!(observe_using(
            &pin,
            &pin.target,
            &pin.sandbox,
            || panic!("changed VM"),
            100
        )
        .is_err());
    }
    #[test]
    fn provisioning_pin_precedes_account_binding_and_reopens_without_rebinding() {
        let (_dir, pin, _lock) = fixture();
        let root = pin.storage.join("host-ledger");
        let bootstrap_id = journal::new_id();
        retain(
            &root,
            &bootstrap_id,
            &pin.target,
            &pin.sandbox,
            &pin.storage,
            &pin.name,
        )
        .unwrap();
        let path = root
            .join("macos-endpoints")
            .join(format!("{bootstrap_id}.json"));
        let original = read(&path, 96 * 1024).unwrap();
        let inode = metadata(&path, false).unwrap();
        retain(
            &root,
            &bootstrap_id,
            &pin.target,
            &pin.sandbox,
            &pin.storage,
            &pin.name,
        )
        .unwrap();
        assert_eq!(metadata(&path, false).unwrap(), inode);
        let mut changed = pin.target.clone();
        changed.restore_sha256 = "b".repeat(64);
        assert!(retain(
            &root,
            &bootstrap_id,
            &changed,
            &pin.sandbox,
            &pin.storage,
            &pin.name
        )
        .is_err());
        assert_eq!(read(&path, 96 * 1024).unwrap(), original);
        std::fs::write(&path, b"partial original receipt").unwrap();
        assert!(retain(
            &root,
            &bootstrap_id,
            &pin.target,
            &pin.sandbox,
            &pin.storage,
            &pin.name
        )
        .is_err());
        assert_eq!(read(&path, 96 * 1024).unwrap(), b"partial original receipt");
    }
    #[test]
    fn malformed_ambiguous_and_unsafe_dhcp_entries_never_fall_back() {
        for input in [
            leases().replace("192.168.64.2", "127.0.0.1"),
            leases().replace("lease=", "ip_address=192.168.64.3\nlease="),
            leases() + "{",
            leases().replace("2:0:0:0:0:1", "2:0:0:0:0:2"),
        ] {
            assert!(lease_ip(&input, "02:00:00:00:00:01", 100).is_err());
        }
    }
}
