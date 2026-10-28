//! Ordinary pinned Lume restore/run commands. No offline account patcher,
//! default account, viewer, permission changes or inferred trust ceremony.
use super::{journal, macos_endpoint, macos_keys, macos_transport, process};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    time::Duration,
};

struct Restore {
    path: PathBuf,
    sha256: String,
    bytes: u64,
}
impl Restore {
    fn verify(&self) -> Result<()> {
        let metadata = std::fs::symlink_metadata(&self.path)?;
        if !self.path.is_absolute()
            || !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.len() != self.bytes
            || self.bytes == 0
        {
            bail!("Original verified restore artifact missing/replaced")
        }
        use sha2::{Digest, Sha256};
        use std::io::Read;
        let mut file = std::fs::File::open(&self.path)?;
        let mut hash = Sha256::new();
        let mut bytes = [0; 65536];
        loop {
            let read = file.read(&mut bytes)?;
            if read == 0 {
                break;
            }
            hash.update(&bytes[..read]);
        }
        if format!("{:x}", hash.finalize()) != self.sha256 {
            bail!("Restore artifact digest changed")
        }
        Ok(())
    }
}
fn restore_from_catalog(root: &Path, catalog: &str) -> Result<Restore> {
    let catalog: Value = serde_json::from_str(catalog)?;
    if catalog["version"] != 1 {
        bail!("Unsupported restore catalog")
    }
    let images = catalog["images"]
        .as_array()
        .context("Restore catalog entries missing")?;
    let matches = images
        .iter()
        .filter(|entry| entry["id"] == "macos26-personalized-v1")
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        bail!("No unique verified Apple macOS26 restore-image manifest/hash is in the trusted profile. No request-supplied restore path or latest image is accepted")
    }
    let image = matches[0];
    let url = image["url"]
        .as_str()
        .context("Verified restore URL missing")?;
    if image["macosMajor"] != 26
        || image["build"].as_str().is_none_or(str::is_empty)
        || !(url.starts_with("https://updates.cdn-apple.com/")
            || url.starts_with("https://appldnld.apple.com/"))
    {
        bail!("Restore manifest must pin an Apple macOS26 image/build")
    }
    let sha = image["sha256"].as_str().context("Restore SHA missing")?;
    super::transport::validate_runtime_sha(sha)?;
    let restore = Restore {
        path: root.join("restore-images").join(format!("{sha}.ipsw")),
        sha256: sha.into(),
        bytes: image["bytes"].as_u64().context("Restore size missing")?,
    };
    restore.verify()?;
    Ok(restore)
}
fn verified_restore(root: &Path) -> Result<Restore> {
    restore_from_catalog(root, include_str!("fixtures/macos-restore-catalog.json"))
}

pub(super) fn account_capability() -> Value {
    json!({"available":false,"reason":"Pinned Lume 0.6.1 exposes ordinary restore/background run, but no public personalized Setup Assistant/account/public-key/host-key capture command. Its offline setup changes the fixed account/security settings and is excluded. The internal VNC helper is not a durable authenticated account receipt interface."})
}
fn directory(root: &Path, key: &str) -> Result<PathBuf> {
    journal::validate_id(key)?;
    Ok(root.join("macos-provision-operations").join(key))
}
fn save(dir: &Path, record: &Value) -> Result<()> {
    journal::atomic_private_write(&dir.join("record.json"), &serde_json::to_vec(record)?)
}
fn execute_using(
    root: &Path,
    key: &str,
    restore: &Restore,
    lume: &Path,
    action: &str,
    after_receipt: impl FnOnce() -> Result<()>,
) -> Result<Value> {
    let canonical_root = root.canonicalize()?;
    let root = canonical_root.as_path();
    let dir = directory(root, key)?;
    let existed = dir.try_exists()?;
    if !existed && action != "create" {
        bail!("Original provisioning intent missing")
    }
    if !existed {
        journal::private_directory(&dir)?;
    }
    macos_keys::check_directory(&dir)?;
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir.join("operation.lock"))?;
    // SAFETY: lock owns its descriptor for the original command's lifetime.
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!("Original provisioning actor is owned")
    }
    if action == "run" && dir.join("restricted-owner-intent.json").try_exists()? {
        bail!("Original restricted bootstrap launch exists; legacy run cannot replace it")
    }
    let storage = root.join("macos-vms").join(key);
    let name = format!("terminalx-{key}");
    let expected = json!({"requestId":key,"storage":storage,"name":name,"restoreSha256":restore.sha256,"restoreBytes":restore.bytes,"macosMajor":26,"lumeVersion":super::bootstrap::LUME.version,"lumeSha256":super::bootstrap::LUME.executable_sha256,"cpu":4,"memory":"8GB","disk":"160GB"});
    let mut record = if existed {
        let record: Value = serde_json::from_slice(&macos_keys::private_read(
            &dir.join("record.json"),
            128 * 1024,
        )?)?;
        if record["intent"] != expected
            || record["inputDigest"] != journal::digest(&serde_json::to_vec(&expected)?)
        {
            bail!("Original provisioning target/profile changed")
        }
        record
    } else {
        restore.verify()?;
        journal::private_directory(&storage)?;
        if storage.join(&name).try_exists()? {
            bail!("Existing VM cannot be provisioned over")
        }
        let record = json!({"intent":expected,"inputDigest":journal::digest(&serde_json::to_vec(&expected)?),"environmentId":journal::new_id(),"generation":journal::new_id(),"status":"createOutcomeUnknown","ready":false});
        save(&dir, &record)?;
        record
    };
    if action == "inspect" || (existed && action == "create") {
        return Ok(record);
    }
    let mut command = macos_transport::isolated(lume, &dir);
    match action {
        "create" if !existed => {
            restore.verify()?;
            command
                .args([
                    "create",
                    &name,
                    "--os",
                    "macOS",
                    "--cpu",
                    "4",
                    "--memory",
                    "8GB",
                    "--disk-size",
                    "160GB",
                    "--display",
                    "1024x768",
                    "--network",
                    "nat",
                    "--no-display",
                    "--ipsw",
                ])
                .arg(&restore.path)
                .arg("--storage")
                .arg(&storage);
        }
        "run" if record["status"] == "created" => {
            let target = serde_json::from_value(record["target"].clone())?;
            macos_endpoint::verify_retained_pin(root, key, &target)?;
            record["status"] = json!("runOutcomeUnknown");
            save(&dir, &record)?;
            command
                .args([
                    "run",
                    &name,
                    "--display",
                    "none",
                    "--detach",
                    "--vnc",
                    "enabled",
                    "--storage",
                ])
                .arg(&storage);
        }
        "run" => return Ok(record),
        _ => bail!("Unknown provisioning operation"),
    }
    // A command timeout/lost reply never authorizes another create/run. Only
    // an original retained terminal receipt is an inspectable completion.
    if let Err(error) = process::run(&mut command, b"", Duration::from_secs(1800)) {
        record["detail"] = json!(format!(
            "Original {action} outcome unknown; no replay: {error:#}"
        ));
        save(&dir, &record)?;
        return Ok(record);
    }
    if action == "create" {
        let vm = storage.join(&name);
        let metadata = std::fs::symlink_metadata(&vm)?;
        // Tighten only this newly created, original operation-owned directory.
        // SAFETY: geteuid has no preconditions.
        if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() } {
            bail!("Created VM directory ownership differs")
        }
        std::fs::set_permissions(&vm, std::fs::Permissions::from_mode(0o700))?;
        let target = macos_endpoint::capture_created(
            root,
            key,
            record["environmentId"]
                .as_str()
                .context("Environment missing")?,
            record["generation"]
                .as_str()
                .context("Generation missing")?,
            &restore.sha256,
            &storage,
            &name,
        )?;
        record["target"] = json!(target);
        record["status"] = json!("created");
    } else {
        let target = serde_json::from_value(record["target"].clone())?;
        macos_endpoint::verify_retained_pin(root, key, &target)?;
        record["status"] = json!("runAcknowledged");
        record["accountSetup"] = account_capability();
    }
    record[format!("{action}Receipt")] =
        json!({"kind":"originalChildSuccess","inputDigest":record["inputDigest"],"ready":false});
    save(&dir, &record)?;
    after_receipt()?;
    Ok(record)
}
pub(super) fn request(method: &str, params: &Value) -> Result<Value> {
    if method == "environment.runPersonalizedProvision" {
        return super::macos_owner_channel::launch::request(params);
    }
    // Source route is wired, but missing manifest and account/trust evidence
    // prevent any production tool/path discovery or process creation today.
    super::macos_transport::require_available()?;
    let root = super::host::root()?;
    let restore = verified_restore(&root)?;
    let lume = super::bootstrap::installed("lume")?.context("Pinned Lume profile unavailable")?;
    let action = match method {
        "environment.createPersonalized" => "create",
        "environment.runPersonalizedProvision" => "run",
        _ => bail!("Unknown personalized provision action"),
    };
    execute_using(
        &root,
        params["idempotencyKey"]
            .as_str()
            .context("Original provisioning request required")?,
        &restore,
        &lume,
        action,
        || Ok(()),
    )
}

/// Source admission for the restricted owner. It reuses the completed original
/// restore and retained VM pin, never a caller-selected VM or executable.
pub(super) fn created_for_bootstrap(root: &Path, key: &str) -> Result<Value> {
    let dir = directory(root, key)?;
    let record: Value = serde_json::from_slice(&macos_keys::private_read(
        &dir.join("record.json"),
        128 * 1024,
    )?)?;
    let intent = &record["intent"];
    let input_digest = journal::digest(&serde_json::to_vec(intent)?);
    if record["status"] != "created"
        || record["ready"] != false
        || record["inputDigest"] != input_digest
        || intent["requestId"] != key
        || intent["storage"] != json!(root.join("macos-vms").join(key))
        || intent["name"] != format!("terminalx-{key}")
        || intent["macosMajor"] != 26
        || intent["lumeVersion"] != super::bootstrap::LUME.version
        || intent["lumeSha256"] != super::bootstrap::LUME.executable_sha256
        || intent["cpu"] != 4
        || intent["memory"] != "8GB"
        || intent["disk"] != "160GB"
        || intent["restoreBytes"]
            .as_u64()
            .is_none_or(|bytes| bytes == 0)
        || record["createReceipt"]
            != json!({"kind":"originalChildSuccess","inputDigest":input_digest,"ready":false})
        || record.get("runReceipt").is_some()
    {
        bail!("Original completed restore is required; no legacy or unknown run may be replaced")
    }
    let target: super::macos_personalization::Target =
        serde_json::from_value(record["target"].clone())?;
    if target.environment_id != record["environmentId"]
        || target.generation != record["generation"]
        || target.restore_sha256 != intent["restoreSha256"]
    {
        bail!("Original restore target changed")
    }
    macos_endpoint::verify_retained_pin(root, key, &target)?;
    Ok(record)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Restore, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("synthetic.ipsw");
        std::fs::write(&file, b"synthetic restore fixture").unwrap();
        let restore = Restore {
            path: file,
            sha256: journal::digest(b"synthetic restore fixture"),
            bytes: 25,
        };
        let binary = dir.path().join("fake-lume");
        std::fs::write(&binary,r#"#!/usr/bin/python3
import sys,pathlib,json,os
root=pathlib.Path(__file__).parent;a=sys.argv[1:]
assert not any(k in os.environ for k in ['SSH_AUTH_SOCK','TERMINALX_NEXT_TOKEN','OPENAI_API_KEY'])
assert '--unattended' not in a and 'setup' not in a and '--shared-dir' not in a
with (root/'calls').open('a') as out:out.write(a[0]+'\n')
p=pathlib.Path(a[a.index('--storage')+1])/a[1]
if a[0]=='create':
 assert a[2:17]==['--os','macOS','--cpu','4','--memory','8GB','--disk-size','160GB','--display','1024x768','--network','nat','--no-display','--ipsw',str(root/'synthetic.ipsw')]
 p.mkdir(mode=0o700)
 (p/'config.json').write_text(json.dumps({'os':'macOS','networkMode':'nat','macAddress':'02:00:00:00:00:01','hardwareModel':'YWJj','machineIdentifier':'ZGVm'}))
 for name in ['disk.img','nvram.bin']:(p/name).write_bytes(b'disposable fake VM file')
else:assert a[:6]==['run',a[1],'--display','none','--detach','--vnc'] and a[6]=='enabled'
if (root/'lose').exists():sys.exit(72)
"#).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        (dir, restore, binary)
    }
    #[test]
    fn empty_or_changed_restore_catalog_cannot_enable_fixture_production() {
        let (root, restore, _) = fixture();
        assert!(verified_restore(root.path()).is_err());
        let dir = root.path().join("restore-images");
        journal::private_directory(&dir).unwrap();
        std::fs::copy(&restore.path, dir.join(format!("{}.ipsw", restore.sha256))).unwrap();
        let catalog = json!({"version":1,"images":[{"id":"macos26-personalized-v1","macosMajor":26,"build":"fixture","url":"https://updates.cdn-apple.com/fixture.ipsw","sha256":restore.sha256,"bytes":restore.bytes}]});
        restore_from_catalog(root.path(), &catalog.to_string()).unwrap();
        for field in ["macosMajor", "sha256", "url"] {
            let mut bad = catalog.clone();
            bad["images"][0][field] = json!("replaced");
            assert!(restore_from_catalog(root.path(), &bad.to_string()).is_err());
        }
        assert!(verified_restore(root.path()).is_err());
    }
    #[test]
    fn supported_restore_and_background_run_are_once_and_pin_original_files() {
        let (root, restore, lume) = fixture();
        let key = journal::new_id();
        assert!(
            execute_using(root.path(), &key, &restore, &lume, "create", || bail!(
                "lost host reply"
            ))
            .is_err()
        );
        let record = execute_using(root.path(), &key, &restore, &lume, "create", || {
            panic!("restore replay")
        })
        .unwrap();
        assert_eq!(record["status"], "created");
        assert_eq!(record["target"]["macosMajor"], 26);
        let run = execute_using(root.path(), &key, &restore, &lume, "run", || Ok(())).unwrap();
        assert_eq!(run["status"], "runAcknowledged");
        assert_eq!(run["ready"], false);
        assert_eq!(run["accountSetup"]["available"], false);
        assert_eq!(
            execute_using(root.path(), &key, &restore, &lume, "run", || panic!(
                "run replay"
            ))
            .unwrap(),
            run
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("calls")).unwrap(),
            "create\nrun\n"
        );
        assert!(request(
            "environment.createPersonalized",
            &json!({"idempotencyKey":key})
        )
        .is_err());
    }
    #[test]
    fn restricted_owner_intent_fences_legacy_run_even_when_partial() {
        let (root, restore, lume) = fixture();
        let key = journal::new_id();
        execute_using(root.path(), &key, &restore, &lume, "create", || Ok(())).unwrap();
        created_for_bootstrap(&root.path().canonicalize().unwrap(), &key).unwrap();
        let original = directory(root.path(), &key).unwrap();
        std::fs::write(
            original.join("restricted-owner-intent.json"),
            b"partial original launch",
        )
        .unwrap();
        assert!(
            execute_using(root.path(), &key, &restore, &lume, "run", || panic!(
                "legacy replacement"
            ))
            .unwrap_err()
            .to_string()
            .contains("cannot replace")
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("calls")).unwrap(),
            "create\n"
        );
    }
    #[test]
    fn lost_command_or_replaced_vm_never_recreate_or_rebind() {
        let (root, restore, lume) = fixture();
        let key = journal::new_id();
        std::fs::write(root.path().join("lose"), b"fixture").unwrap();
        let record =
            execute_using(root.path(), &key, &restore, &lume, "create", || Ok(())).unwrap();
        assert_eq!(record["status"], "createOutcomeUnknown");
        assert_eq!(
            execute_using(root.path(), &key, &restore, &lume, "create", || panic!(
                "replayed"
            ))
            .unwrap(),
            record
        );
        assert_eq!(
            execute_using(root.path(), &key, &restore, &lume, "run", || panic!(
                "unproven VM run"
            ))
            .unwrap(),
            record
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("calls")).unwrap(),
            "create\n"
        );
        let (other, restore, lume) = fixture();
        let key = journal::new_id();
        execute_using(other.path(), &key, &restore, &lume, "create", || Ok(())).unwrap();
        std::fs::write(
            other
                .path()
                .join("macos-vms")
                .join(&key)
                .join(format!("terminalx-{key}/config.json")),
            b"replaced",
        )
        .unwrap();
        assert!(
            execute_using(other.path(), &key, &restore, &lume, "run", || panic!(
                "changed VM"
            ))
            .is_err()
        );
        assert_eq!(
            std::fs::read_to_string(other.path().join("calls")).unwrap(),
            "create\n"
        );
    }
}
