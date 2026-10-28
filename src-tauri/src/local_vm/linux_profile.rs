//! Trusted Linux artifact preparation and installer receipt lifecycle.
//! The compiled catalog is intentionally empty until native build evidence is
//! reviewed. Host staging never executes an artifact. The container adapter
//! delivers only catalog-verified bytes and reconciles durable guest receipts.
use super::journal::{self, Journal};
use crate::computer_targets::{Capability, Target};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Read, os::unix::fs::OpenOptionsExt, path::Path};

const CATALOG: &str = include_str!("fixtures/linux-runtime-catalog.json");
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Architecture {
    X64,
    Arm64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Profile {
    id: String,
    source_commit: String,
    protocol: u32,
    architecture: Architecture,
    sha256: String,
    bytes: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    version: u64,
    profiles: Vec<Profile>,
}

/// Cannot be constructed/deserialized from a caller-supplied digest.
pub struct VerifiedArtifact {
    profile: Profile,
    bytes: Vec<u8>,
}

pub fn capability() -> Value {
    let catalog: Catalog = serde_json::from_str(CATALOG).expect("compiled Linux profile catalog");
    json!({"protocol":1,"available":!catalog.profiles.is_empty(),"profiles":catalog.profiles.iter().map(|p|json!({"id":p.id,"architecture":p.architecture,"sourceCommit":p.source_commit})).collect::<Vec<_>>(),
        "reason":"No verified native Linux artifact is available in this build. Runtime preparation is separate from guest account authorization and desktop readiness."})
}
pub fn verify(
    profile_id: &str,
    path: &Path,
    architecture: Architecture,
) -> Result<VerifiedArtifact> {
    verify_using(CATALOG, profile_id, path, architecture)
}
pub(super) fn read(path: &Path, maximum: u64) -> Result<Vec<u8>> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        bail!("A regular artifact/receipt file is required");
    }
    let mut bytes = Vec::new();
    file.take(maximum + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > maximum {
        bail!("Artifact/receipt exceeds its bound");
    }
    Ok(bytes)
}
fn verify_using(
    catalog: &str,
    id: &str,
    path: &Path,
    architecture: Architecture,
) -> Result<VerifiedArtifact> {
    let catalog: Catalog = serde_json::from_str(catalog)?;
    if catalog.version != 1 {
        bail!("Unsupported Linux profile catalog");
    }
    let mut profiles = catalog.profiles.into_iter().filter(|p| p.id == id);
    let profile = profiles.next().context(
        "No trusted Linux artifact profile is available; native build evidence is required",
    )?;
    if profiles.next().is_some()
        || profile.protocol != journal::PROTOCOL
        || profile.architecture != architecture
        || profile.source_commit.len() != 40
        || !profile.source_commit.bytes().all(|c| c.is_ascii_hexdigit())
        || profile.bytes < 64
        || profile.bytes > 512 * 1024 * 1024
    {
        bail!("Invalid or incompatible trusted Linux profile");
    }
    super::transport::validate_runtime_sha(&profile.sha256)?;
    let bytes = read(path, profile.bytes)?;
    if bytes.len() as u64 != profile.bytes || journal::digest(&bytes) != profile.sha256 {
        bail!("Linux artifact size or digest differs from the trusted catalog");
    }
    // ELF64 little endian executable/PIE, exact CPU and ABI. Digest is the
    // authority for the full native release; a plausible ELF header alone is not.
    let machine = match architecture {
        Architecture::X64 => 62_u16,
        Architecture::Arm64 => 183_u16,
    };
    if &bytes[..4] != b"\x7fELF"
        || bytes[4] != 2
        || bytes[5] != 1
        || bytes[6] != 1
        || !matches!(bytes[7], 0 | 3)
        || !matches!(u16::from_le_bytes([bytes[16], bytes[17]]), 2 | 3)
        || u16::from_le_bytes([bytes[18], bytes[19]]) != machine
        || u32::from_le_bytes(bytes[20..24].try_into().unwrap()) != 1
        || u16::from_le_bytes([bytes[52], bytes[53]]) != 64
    {
        bail!("Expected the exact Linux ELF64 architecture, not a host executable");
    }
    Ok(VerifiedArtifact { profile, bytes })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Account {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub home: String,
    pub home_device: u64,
    pub home_inode: u64,
    pub architecture: Architecture,
}
impl Account {
    pub(super) fn check_current(&self) -> Result<()> {
        use std::os::unix::fs::MetadataExt;
        self.validate()?;
        if !cfg!(target_os = "linux") {
            bail!("Linux account binding cannot be used by a host/macOS runtime");
        }
        let passwd = std::fs::read_to_string("/etc/passwd")?;
        let fields: Vec<_> = passwd
            .lines()
            .find(|line| line.starts_with("cua:"))
            .context("Dedicated account is unavailable")?
            .split(':')
            .collect();
        if fields.len() != 7
            || fields[2].parse::<u32>()? != self.uid
            || fields[3].parse::<u32>()? != self.gid
            || fields[5] != self.home
        {
            bail!("Dedicated account identity changed");
        }
        let metadata = std::fs::symlink_metadata(&self.home)?;
        // SAFETY: identity accessors take no pointers or memory preconditions.
        if unsafe {
            libc::getuid() != self.uid
                || libc::geteuid() != self.uid
                || libc::getgid() != self.gid
                || libc::getegid() != self.gid
        } || !metadata.is_dir()
            || metadata.uid() != self.uid
            || metadata.mode() & 0o022 != 0
            || metadata.dev() != self.home_device
            || metadata.ino() != self.home_inode
        {
            bail!("Dedicated account/home binding changed");
        }
        Ok(())
    }
    pub(super) fn validate(&self) -> Result<()> {
        if self.name != "cua"
            || self.home != "/home/cua"
            || self.uid == 0
            || self.gid == 0
            || self.home_inode == 0
        {
            bail!("Dedicated nonroot Linux account identity is required");
        }
        Ok(())
    }
}
/// The path comes from the compiled digest, never a UI-selected executable.
pub(super) fn cached(
    root: &Path,
    id: &str,
    architecture: Architecture,
) -> Result<VerifiedArtifact> {
    let catalog: Catalog = serde_json::from_str(CATALOG)?;
    let profile = catalog
        .profiles
        .iter()
        .find(|p| p.id == id)
        .context("No verified native Linux profile is available")?;
    verify(
        id,
        &root.join("linux-artifacts").join(&profile.sha256),
        architecture,
    )
}
pub(super) fn trusted_record(root: &Path, key: &str) -> Result<Value> {
    let record = inspect(root, key)?;
    let binding: InstallBinding = serde_json::from_value(record["intent"]["binding"].clone())?;
    validate_binding(&binding)?;
    binding
        .account
        .as_ref()
        .context("Legacy staging has no dedicated account binding")?
        .validate()?;
    let artifact = verify(
        record["intent"]["profileId"]
            .as_str()
            .context("Profile ID missing")?,
        &directory(root, key)?.join("runtime.elf"),
        binding.architecture,
    )?;
    let expected = intent(&binding, &artifact);
    if record["intent"] != expected
        || record["inputDigest"] != journal::digest(&serde_json::to_vec(&expected)?)
    {
        bail!("Retained artifact provenance or binding changed");
    }
    Ok(record)
}
fn intent(binding: &InstallBinding, artifact: &VerifiedArtifact) -> Value {
    json!({"binding":binding,"profileId":artifact.profile.id,"sourceCommit":artifact.profile.source_commit,
        "runtimeSha256":artifact.profile.sha256,"protocol":artifact.profile.protocol,"bytes":artifact.profile.bytes})
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstallBinding {
    pub target: Target,
    pub environment_id: String,
    pub generation: String,
    pub architecture: Architecture,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<Account>,
}
pub(super) fn directory(root: &Path, key: &str) -> Result<std::path::PathBuf> {
    if key.is_empty() || key.len() > 200 {
        bail!("Bounded installation request identity is required");
    }
    Ok(root
        .join("linux-runtime-preparation")
        .join(journal::digest(key.as_bytes())))
}
fn validate_binding(binding: &InstallBinding) -> Result<()> {
    if !matches!(binding.target, Target::LinuxContainer { .. }) {
        bail!("Linux installer requires an exact container target");
    }
    binding.target.require(Capability::AttachedDesktop)?;
    if let Some(account) = &binding.account {
        account.validate()?;
        if account.architecture != binding.architecture {
            bail!("Account architecture changed");
        }
    }
    journal::validate_id(&binding.environment_id)?;
    journal::validate_id(&binding.generation)
}
/// Stages bytes in a private host directory, without installing or executing.
pub fn prepare(
    root: &Path,
    key: &str,
    binding: &InstallBinding,
    artifact: &VerifiedArtifact,
) -> Result<Value> {
    validate_binding(binding)?;
    if binding.architecture != artifact.profile.architecture {
        bail!("Artifact architecture differs from the selected guest");
    }
    let dir = directory(root, key)?;
    let receipt = dir.join("receipt.json");
    let intent = intent(binding, artifact);
    let digest = journal::digest(&serde_json::to_vec(&intent)?);
    // Reuse the target admission lock: replacement must not race desktop/task work.
    let _guard = super::admission::Guard::acquire(root, &binding.target)?;
    if receipt.try_exists()? {
        let previous: Value = serde_json::from_slice(&read(&receipt, 64 * 1024)?)?;
        if previous["inputDigest"] != digest {
            bail!("Install request already names a different artifact or target");
        }
        if previous["intent"] != intent {
            bail!("Retained installation intent changed");
        }
        // No executor can run from staging. A matching sealed artifact may
        // finish a host-only interrupted write; delivered requests never replay.
        if previous["status"] != "staging" {
            return Ok(previous);
        }
    }
    journal::private_directory(&dir)?;
    let prepared = json!({"requestKey":key,"intent":intent,"inputDigest":digest,"status":"staging","ready":false});
    journal::atomic_private_write(&receipt, &serde_json::to_vec(&prepared)?)?;
    journal::atomic_private_write(&dir.join("runtime.elf"), &artifact.bytes)?;
    let mut prepared = prepared;
    prepared["status"] = json!("prepared");
    journal::atomic_private_write(&receipt, &serde_json::to_vec(&prepared)?)?;
    Ok(prepared)
}
pub fn inspect(root: &Path, key: &str) -> Result<Value> {
    serde_json::from_slice(&read(
        &directory(root, key)?.join("receipt.json"),
        64 * 1024,
    )?)
    .map_err(Into::into)
}

/// TerminalX-owned executor seam, not an invented Docker/Podman install API.
/// The production adapter verifies the catalog before using this seam. It
/// reads the original terminal receipt under the guest installer lock.
pub(super) fn execute_prepared(
    root: &Path,
    journal: &Journal,
    key: &str,
    executor: impl FnOnce(&InstallBinding, &Path, &Value) -> Result<Value>,
) -> Result<Value> {
    let mut record = inspect(root, key)?;
    if record["status"] != "prepared" {
        return Ok(record);
    } // Never replay an interrupted delivery.
    let binding: InstallBinding = serde_json::from_value(record["intent"]["binding"].clone())?;
    validate_binding(&binding)?;
    let guard = super::admission::Guard::acquire(root, &binding.target)?;
    record = inspect(root, key)?;
    if record["status"] != "prepared" {
        return Ok(record);
    }
    if journal.read()?.environments.values().any(|env| {
        env.transport.container().as_ref() == Some(&binding.target)
            || env.id == binding.environment_id
    }) {
        bail!("Existing guest history prevents fresh runtime installation; no replacement was attempted");
    }
    for entry in std::fs::read_dir(root.join("linux-runtime-preparation"))? {
        let receipt = entry?.path().join("receipt.json");
        let prior: Value = serde_json::from_slice(&read(&receipt, 64 * 1024)?)?;
        if prior["intent"]["binding"]["target"] == json!(binding.target)
            && !matches!(prior["status"].as_str(), Some("prepared" | "staging"))
        {
            bail!("A retained installation already owns this container timeline; inspect its receipt before any fresh installation");
        }
    }
    let dir = directory(root, key)?;
    let binary = dir.join("runtime.elf");
    let bytes = read(
        &binary,
        record["intent"]["bytes"]
            .as_u64()
            .context("Artifact size missing")?,
    )?;
    if journal::digest(&bytes)
        != record["intent"]["runtimeSha256"]
            .as_str()
            .context("Artifact digest missing")?
    {
        bail!("Staged Linux artifact changed");
    }
    record["status"] = json!("outcomeUnknown");
    journal::atomic_private_write(&dir.join("receipt.json"), &serde_json::to_vec(&record)?)?;
    journal::atomic_private_write(
        &guard.marker,
        &serde_json::to_vec(
            &json!({"kind":"linuxRuntimeInstall","target":binding.target,"binding":binding,"requestDigest":journal::digest(key.as_bytes()),"inputDigest":record["inputDigest"],"status":"awaitingInstallReceipt"}),
        )?,
    )?;
    match executor(&binding, &binary, &record["intent"]) {
        Ok(receipt) => {
            if finish(root, key, &mut record, &receipt).is_ok() {
                guard.completed()?;
            }
        }
        Err(error) => {
            record["detail"] = json!(error.to_string());
            journal::atomic_private_write(
                &dir.join("receipt.json"),
                &serde_json::to_vec(&record)?,
            )?;
        }
    }
    Ok(record)
}
fn finish(root: &Path, key: &str, record: &mut Value, observed: &Value) -> Result<()> {
    let intent = &record["intent"];
    let receipt = &observed["receipt"];
    let request = journal::digest(key.as_bytes());
    let binding = &intent["binding"];
    if receipt["version"] != 1
        || receipt["status"] != "installed"
        || receipt["intent"] != *intent
        || receipt["requestDigest"] != request
        || receipt["inputDigest"] != record["inputDigest"]
        || observed["account"] != binding["account"]
        || observed["runtimeSha256"] != intent["runtimeSha256"]
        || observed["protocol"] != journal::PROTOCOL
        || observed["identity"]
            != json!({"environmentId":binding["environmentId"],"generation":binding["generation"],"protocol":journal::PROTOCOL,"account":binding["account"]})
        || observed["exitProof"]
            != json!({"kind":"terminalReceiptUnderExclusiveLock","requestDigest":request,"inputDigest":record["inputDigest"]})
    {
        bail!("Fresh original installer completion/account/identity receipt is unconfirmed");
    }
    let mut next = record.clone();
    next["status"] = json!("installed");
    next["receipt"] = observed.clone();
    next["ready"] = json!(false);
    next["detail"]=json!("Runtime files installed and installer completion confirmed. Runtime activation, guest Codex authorization and task readiness are separate.");
    journal::atomic_private_write(
        &directory(root, key)?.join("receipt.json"),
        &serde_json::to_vec(&next)?,
    )?;
    *record = next;
    Ok(())
}
pub(super) fn reconcile_prepared(
    root: &Path,
    key: &str,
    confirm: bool,
    observe: impl FnOnce(&InstallBinding, &Value) -> Result<Value>,
) -> Result<Value> {
    if !confirm {
        bail!("Confirm recovery of the displayed original installation");
    }
    let mut record = inspect(root, key)?;
    let binding: InstallBinding = serde_json::from_value(record["intent"]["binding"].clone())?;
    validate_binding(&binding)?;
    let guard = super::admission::Guard::lock(root, &binding.target)?;
    if !guard.marker.try_exists()? {
        if record["status"] == "installed" {
            return Ok(record);
        }
        bail!("Original installer reservation is unavailable");
    }
    let marker: Value = serde_json::from_slice(&super::admission::read_marker(&guard.marker)?)?;
    if marker["kind"] != "linuxRuntimeInstall"
        || marker["binding"] != json!(binding)
        || marker["requestDigest"] != journal::digest(key.as_bytes())
        || marker["inputDigest"] != record["inputDigest"]
    {
        bail!("Original installer reservation changed");
    }
    let observed = observe(&binding, &record["intent"])?;
    finish(root, key, &mut record, &observed)?;
    guard.completed()?;
    Ok(record)
}

#[cfg(test)]
pub(super) fn fixture(
    catalog: &str,
    path: &Path,
    architecture: Architecture,
) -> Result<VerifiedArtifact> {
    verify_using(catalog, "fixture", path, architecture)
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(super) fn completion(key: &str, intent: &Value) -> Value {
        let request = journal::digest(key.as_bytes());
        let input = journal::digest(&serde_json::to_vec(intent).unwrap());
        json!({"receipt":{"version":1,"status":"installed","intent":intent,"requestDigest":request,"inputDigest":input},
            "account":intent["binding"]["account"],"runtimeSha256":intent["runtimeSha256"],"protocol":1,
            "identity":{"environmentId":intent["binding"]["environmentId"],"generation":intent["binding"]["generation"],"protocol":1,"account":intent["binding"]["account"]},
            "exitProof":{"kind":"terminalReceiptUnderExclusiveLock","requestDigest":request,"inputDigest":input}})
    }
    fn artifact(dir: &Path, architecture: Architecture) -> (String, std::path::PathBuf) {
        let mut bytes = vec![0_u8; 64];
        bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        bytes[16] = 3;
        let machine = match architecture {
            Architecture::X64 => 62_u16,
            Architecture::Arm64 => 183_u16,
        };
        bytes[18..20].copy_from_slice(&machine.to_le_bytes());
        bytes[20] = 1;
        bytes[52] = 64;
        let path = dir.join("fixture.elf");
        std::fs::write(&path, &bytes).unwrap();
        (json!({"version":1,"profiles":[{"id":"fixture","sourceCommit":"a".repeat(40),"protocol":1,"architecture":architecture,"sha256":journal::digest(&bytes),"bytes":64}]}).to_string(),path)
    }
    fn binding() -> InstallBinding {
        InstallBinding {
            target: Target::LinuxContainer {
                runtime: crate::computer_targets::Runtime::Docker,
                id: "b".repeat(64),
            },
            environment_id: journal::new_id(),
            generation: journal::new_id(),
            architecture: Architecture::Arm64,
            account: Some(Account {
                name: "cua".into(),
                uid: 1000,
                gid: 1000,
                home: "/home/cua".into(),
                home_device: 1,
                home_inode: 2,
                architecture: Architecture::Arm64,
            }),
        }
    }
    #[test]
    fn trusted_catalog_verifies_architecture_digest_and_refuses_host_or_symlink_artifacts() {
        let dir = tempfile::tempdir().unwrap();
        let (catalog, path) = artifact(dir.path(), Architecture::Arm64);
        assert!(verify("fixture", &path, Architecture::Arm64).is_err());
        assert_eq!(capability()["available"], false);
        verify_using(&catalog, "fixture", &path, Architecture::Arm64).unwrap();
        assert!(verify_using(&catalog, "fixture", &path, Architecture::X64).is_err());
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(verify_using(&catalog, "fixture", &link, Architecture::Arm64).is_err());
        std::fs::write(&path, b"host Mach-O or changed bytes").unwrap();
        assert!(verify_using(&catalog, "fixture", &path, Architecture::Arm64).is_err());
        let mut host = vec![0_u8; 64];
        host[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        std::fs::write(&path, &host).unwrap();
        let mut catalog: Value = serde_json::from_str(&catalog).unwrap();
        catalog["profiles"][0]["sha256"] = json!(journal::digest(&host));
        assert!(verify_using(&catalog.to_string(), "fixture", &path, Architecture::Arm64).is_err());
    }
    #[test]
    fn staged_installation_retains_unknown_outcome_and_rejects_changed_identity_without_replay() {
        let dir = tempfile::tempdir().unwrap();
        let (catalog, path) = artifact(dir.path(), Architecture::Arm64);
        let artifact = verify_using(&catalog, "fixture", &path, Architecture::Arm64).unwrap();
        let binding = binding();
        let journal = Journal::open(dir.path()).unwrap();
        let prepared = prepare(dir.path(), "request", &binding, &artifact).unwrap();
        assert_eq!(prepared["status"], "prepared");
        let staging = directory(dir.path(), "request").unwrap();
        let mut interrupted = prepared.clone();
        interrupted["status"] = json!("staging");
        journal::atomic_private_write(
            &staging.join("receipt.json"),
            &serde_json::to_vec(&interrupted).unwrap(),
        )
        .unwrap();
        std::fs::write(staging.join("runtime.elf"), b"partial host-only copy").unwrap();
        let resumed = prepare(dir.path(), "request", &binding, &artifact).unwrap();
        assert_eq!(resumed, prepared);
        assert_eq!(
            journal::digest(&std::fs::read(staging.join("runtime.elf")).unwrap()),
            artifact.profile.sha256
        );
        // A matching digest field cannot authorize a modified retained intent.
        let mut corrupt = interrupted;
        corrupt["intent"]["binding"]["generation"] = json!(journal::new_id());
        journal::atomic_private_write(
            &staging.join("receipt.json"),
            &serde_json::to_vec(&corrupt).unwrap(),
        )
        .unwrap();
        assert!(prepare(dir.path(), "request", &binding, &artifact).is_err());
        journal::atomic_private_write(
            &staging.join("receipt.json"),
            &serde_json::to_vec(&prepared).unwrap(),
        )
        .unwrap();
        let mut replaced = binding.clone();
        replaced.generation = journal::new_id();
        assert!(prepare(dir.path(), "request", &replaced, &artifact).is_err());
        let unknown = execute_prepared(dir.path(), &journal, "request", |actual, _, _| {
            assert_eq!(actual.target, binding.target);
            bail!("fixture lost delivery");
        })
        .unwrap();
        assert_eq!(unknown["status"], "outcomeUnknown");
        assert_eq!(
            execute_prepared(dir.path(), &journal, "request", |_, _, _| panic!(
                "replayed installer"
            ))
            .unwrap(),
            unknown
        );
        assert!(prepare(dir.path(), "different-request", &binding, &artifact).is_err());
        assert!(super::super::admission::inspect(dir.path(), &binding.target).is_err());
        let mut binding = binding.clone();
        binding.target = Target::LinuxContainer {
            runtime: crate::computer_targets::Runtime::Docker,
            id: "c".repeat(64),
        };
        binding.environment_id = journal::new_id();
        prepare(dir.path(), "completed", &binding, &artifact).unwrap();
        let complete = execute_prepared(dir.path(), &journal, "completed", |_, _, intent| {
            Ok(completion("completed", intent))
        })
        .unwrap();
        assert_eq!(complete["status"], "installed");
        assert_eq!(complete["ready"], false);
        let mut binding = binding.clone();
        binding.target = Target::LinuxContainer {
            runtime: crate::computer_targets::Runtime::Docker,
            id: "d".repeat(64),
        };
        binding.environment_id = journal::new_id();
        prepare(dir.path(), "changed-stage", &binding, &artifact).unwrap();
        std::fs::write(
            directory(dir.path(), "changed-stage")
                .unwrap()
                .join("runtime.elf"),
            b"modified",
        )
        .unwrap();
        assert!(
            execute_prepared(dir.path(), &journal, "changed-stage", |_, _, _| panic!(
                "unverified binary"
            ))
            .is_err()
        );
    }
}
