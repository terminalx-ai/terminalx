//! Unactivated macOS26 personalization boundary. The ledger and SSH request
//! planner are usable by a future VM-bound bootstrap executor, which is not yet
//! implemented. No production route accepts these receipts or runs these plans.
//! The legacy Lume/Cua transport remains unchanged.
use super::journal;
use anyhow::{bail, Context, Result};
use base64::{
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
    Engine as _,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::Read,
    net::Ipv4Addr,
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub environment_id: String,
    pub generation: String,
    pub vm_fingerprint: String,
    pub restore_sha256: String,
    pub macos_major: u32,
}
impl Target {
    pub(super) fn validate(&self) -> Result<()> {
        journal::validate_id(&self.environment_id)?;
        journal::validate_id(&self.generation)?;
        super::transport::validate_runtime_sha(&self.vm_fingerprint)?;
        super::transport::validate_runtime_sha(&self.restore_sha256)?;
        if self.macos_major != 26 {
            bail!("This personalization profile requires macOS26");
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountPlan {
    pub short_name: String,
    /// Opaque references only: no password/private key bytes enter the ledger.
    pub password_reference: String,
    pub ssh_key_reference: String,
}
impl AccountPlan {
    fn validate(&self) -> Result<()> {
        super::macos_account::validate_name(&self.short_name)?;
        journal::validate_id(&self.password_reference)?;
        journal::validate_id(&self.ssh_key_reference)?;
        if self.password_reference == self.ssh_key_reference {
            bail!("Account and transport secret references must be distinct");
        }
        Ok(())
    }
    fn home(&self) -> String {
        format!("/Users/{}", self.short_name)
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AccountReceipt {
    pub target: Target,
    pub account: super::macos_account::Account,
    pub bootstrap_observation_digest: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustReceipt {
    pub target: Target,
    pub account_receipt_digest: String,
    pub host_key: String,
    pub host_key_fingerprint: String,
    pub bootstrap_observation_digest: String,
}

pub fn capability() -> Value {
    json!({"profile":"macos26-personalized-v1","available":false,
    "reason":"A verified macOS26 restore manifest, VM-bound background first-account executor and trust ceremony are required. A journal or SSH request plan is not completed onboarding."})
}

fn directory(root: &Path, key: &str) -> Result<PathBuf> {
    journal::validate_id(key)?;
    Ok(root.join("macos-personalization").join(key))
}
fn locked(root: &Path, key: &str) -> Result<(PathBuf, std::fs::File)> {
    let dir = directory(root, key)?;
    journal::private_directory(&dir)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir.join("operation.lock"))?;
    // SAFETY: file owns this descriptor for the ledger transaction lifetime.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!("Bootstrap operation is already owned");
    }
    Ok((dir, file))
}
fn read(dir: &Path) -> Result<Value> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(dir.join("record.json"))?;
    let mut bytes = Vec::new();
    file.take(64 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 {
        bail!("Bootstrap history exceeds its bound");
    }
    let record: Value = serde_json::from_slice(&bytes)?;
    if record["inputDigest"] != journal::digest(&serde_json::to_vec(&record["intent"])?) {
        bail!("Retained bootstrap intent changed");
    }
    Ok(record)
}
fn retain(dir: &Path, value: &Value) -> Result<()> {
    journal::atomic_private_write(&dir.join("record.json"), &serde_json::to_vec(value)?)
}
pub fn begin(root: &Path, key: &str, target: &Target, account: &AccountPlan) -> Result<Value> {
    target.validate()?;
    account.validate()?;
    let parent = root.join("macos-personalization");
    journal::private_directory(&parent)?;
    let timeline = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(parent.join(format!("timeline-{}.lock", target.vm_fingerprint)))?;
    // SAFETY: timeline owns the descriptor until the immutable plan is retained.
    if unsafe { libc::flock(timeline.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        bail!("This VM bootstrap timeline is already owned");
    }
    let dir = directory(root, key)?;
    let existed = dir.try_exists()?;
    if existed && !dir.join("record.json").try_exists()? {
        bail!("Bootstrap history disappeared; no account operation can be recreated");
    }
    for entry in std::fs::read_dir(&parent)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() && entry.path() != dir {
            let previous = read(&entry.path())?;
            if previous["intent"]["target"]["vmFingerprint"] == target.vm_fingerprint
                || previous["intent"]["target"]["environmentId"] == target.environment_id
            {
                bail!(
                    "This VM already has retained bootstrap history; recover its original request"
                );
            }
        }
    }
    let (dir, _lock) = locked(root, key)?;
    let intent = json!({"target":target,"account":account});
    let digest = journal::digest(&serde_json::to_vec(&intent)?);
    if dir.join("record.json").try_exists()? {
        let old = read(&dir)?;
        if old["intent"] != intent || old["inputDigest"] != digest {
            bail!("Bootstrap key already names another VM/account");
        }
        return Ok(old);
    }
    let record = json!({"intent":intent,"inputDigest":digest,"status":"planned","ready":false});
    retain(&dir, &record)?;
    Ok(record)
}
/// Internal executor seam: the future caller must already own the exact VM's
/// authenticated bootstrap channel. No UI/control RPC currently exposes it.
pub fn create_account_using(
    root: &Path,
    key: &str,
    expected_digest: &str,
    effect: impl FnOnce(&Target, &AccountPlan) -> Result<AccountReceipt>,
) -> Result<Value> {
    let (dir, _lock) = locked(root, key)?;
    let mut record = read(&dir)?;
    if record["inputDigest"] != expected_digest {
        bail!("Bootstrap intent changed");
    }
    let target: Target = serde_json::from_value(record["intent"]["target"].clone())?;
    target.validate()?;
    let account: AccountPlan = serde_json::from_value(record["intent"]["account"].clone())?;
    account.validate()?;
    if record["status"] != "planned" {
        return Ok(record);
    }
    record["status"] = json!("accountOutcomeUnknown");
    retain(&dir, &record)?;
    if let Ok(receipt) = effect(&target, &account) {
        confirm_account(&target, &account, &receipt)?;
        record["accountReceipt"] = serde_json::to_value(receipt)?;
        record["status"] = json!("accountObserved");
        retain(&dir, &record)?;
    }
    Ok(record)
}
fn confirm_account(target: &Target, account: &AccountPlan, receipt: &AccountReceipt) -> Result<()> {
    target.validate()?;
    account.validate()?;
    super::transport::validate_runtime_sha(&receipt.bootstrap_observation_digest)?;
    receipt.account.validate()?;
    if receipt.target != *target
        || receipt.account.short_name != account.short_name
        || receipt.account.home != account.home()
    {
        bail!("VM-bound account observation differs from the planned identity");
    }
    Ok(())
}
/// Observes the original operation; never invokes the account-creation effect.
pub fn reconcile_account_using(
    root: &Path,
    key: &str,
    expected_digest: &str,
    observe: impl FnOnce(&Target, &AccountPlan) -> Result<AccountReceipt>,
) -> Result<Value> {
    let (dir, _lock) = locked(root, key)?;
    let mut record = read(&dir)?;
    if record["inputDigest"] != expected_digest || record["status"] != "accountOutcomeUnknown" {
        bail!("Original unknown bootstrap operation required");
    }
    let target: Target = serde_json::from_value(record["intent"]["target"].clone())?;
    let account: AccountPlan = serde_json::from_value(record["intent"]["account"].clone())?;
    let receipt = observe(&target, &account)?;
    confirm_account(&target, &account, &receipt)?;
    record["accountReceipt"] = json!(receipt);
    record["recoveredOriginalIntent"] = json!(true);
    record["status"] = json!("accountObserved");
    retain(&dir, &record)?;
    Ok(record)
}
pub(super) fn public_key(key: &str) -> Result<String> {
    let parts: Vec<_> = key.split(' ').collect();
    if parts.len() != 2 || parts[0] != "ssh-ed25519" {
        bail!("Pinned Ed25519 host key required");
    }
    let bytes = STANDARD.decode(parts[1])?;
    if bytes.len() != 51
        || &bytes[..4] != 11_u32.to_be_bytes().as_slice()
        || &bytes[4..15] != b"ssh-ed25519"
        || &bytes[15..19] != 32_u32.to_be_bytes().as_slice()
    {
        bail!("Invalid SSH host key encoding");
    }
    use sha2::{Digest, Sha256};
    let fingerprint = format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&bytes)));
    Ok(fingerprint)
}
fn host_key(receipt: &TrustReceipt) -> Result<()> {
    if receipt.host_key_fingerprint != public_key(&receipt.host_key)? {
        bail!("Bootstrap host-key fingerprint mismatch");
    }
    super::transport::validate_runtime_sha(&receipt.bootstrap_observation_digest)
}
pub fn retain_trust(root: &Path, key: &str, receipt: &TrustReceipt) -> Result<Value> {
    let (dir, _lock) = locked(root, key)?;
    let mut record = read(&dir)?;
    host_key(receipt)?;
    if record["status"] != "accountObserved"
        || record["intent"]["target"] != json!(receipt.target)
        || journal::digest(&serde_json::to_vec(&record["accountReceipt"])?)
            != receipt.account_receipt_digest
    {
        bail!("Trust observation must bind the original personalized account receipt");
    }
    record["trustReceipt"] = json!(receipt);
    record["status"] = json!("trustObserved");
    retain(&dir, &record)?;
    Ok(record)
}

pub struct SshPlan {
    pub args: Vec<String>,
    pub known_hosts: String,
    pub request: Vec<u8>,
}
pub(super) struct Retained {
    pub plan: AccountPlan,
    pub account: AccountReceipt,
    pub trust: TrustReceipt,
}
pub(super) fn retained(root: &Path, key: &str, target: &Target) -> Result<Retained> {
    target.validate()?;
    let dir = directory(root, key)?;
    super::macos_keys::check_directory(&root.join("macos-personalization"))?;
    super::macos_keys::check_directory(&dir)?;
    let record: Value = serde_json::from_slice(&super::macos_keys::private_read(
        &dir.join("record.json"),
        64 * 1024,
    )?)?;
    if record["inputDigest"] != journal::digest(&serde_json::to_vec(&record["intent"])?)
        || record["status"] != "trustObserved"
        || record["intent"]["target"] != json!(target)
    {
        bail!("Verified bootstrap binding is unavailable or replaced");
    }
    let plan: AccountPlan = serde_json::from_value(record["intent"]["account"].clone())?;
    let account: AccountReceipt = serde_json::from_value(record["accountReceipt"].clone())?;
    confirm_account(target, &plan, &account)?;
    let trust: TrustReceipt = serde_json::from_value(record["trustReceipt"].clone())?;
    host_key(&trust)?;
    if trust.target != *target
        || trust.account_receipt_digest
            != journal::digest(&serde_json::to_vec(&record["accountReceipt"])?)
    {
        bail!("Transport trust receipt changed");
    }
    Ok(Retained {
        plan,
        account,
        trust,
    })
}
/// Builds, but never executes, the proposed account-bound transport. Private
/// key creation and VM-bound trust capture are separate unimplemented gates.
pub fn ssh_plan(
    root: &Path,
    key: &str,
    current_target: &Target,
    current_ip: Ipv4Addr,
    runtime_sha: &str,
    method: &str,
    params: Value,
) -> Result<SshPlan> {
    current_target.validate()?;
    super::transport::validate_runtime_sha(runtime_sha)?;
    if !current_ip.is_private() || current_ip.is_loopback() || method.is_empty() {
        bail!("Exact VM endpoint and guest RPC method required");
    }
    let Retained {
        plan: account,
        account: observed,
        trust,
    } = retained(root, key, current_target)?;
    let identity = root
        .join("macos-personalization-keys")
        .join(&account.ssh_key_reference)
        .join("private_key");
    let known = directory(root, key)?.join("known_hosts");
    for path in [&identity, &known] {
        if !path.is_absolute()
            || path
                .to_string_lossy()
                .chars()
                .any(|c| c.is_control() || matches!(c, '%' | '$' | '"' | '\\'))
        {
            bail!("Unsupported private transport reference path");
        }
    }
    let alias = format!(
        "terminalx-{}-{}",
        current_target.environment_id, current_target.generation
    );
    let mut args = vec![
        "-F".into(),
        "none".into(),
        "-T".into(),
        "-i".into(),
        identity.to_string_lossy().into_owned(),
    ];
    for option in [
        "BatchMode=yes",
        "StrictHostKeyChecking=yes",
        "IdentitiesOnly=yes",
        "IdentityAgent=none",
        "ForwardAgent=no",
        "ForwardX11=no",
        "ClearAllForwardings=yes",
        "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no",
        "HostbasedAuthentication=no",
        "GSSAPIAuthentication=no",
        "UpdateHostKeys=no",
        "VerifyHostKeyDNS=no",
        "CanonicalizeHostname=no",
        "ProxyCommand=none",
        "ProxyJump=none",
        "ControlMaster=no",
        "ControlPath=none",
        "ControlPersist=no",
        "PermitLocalCommand=no",
        "RequestTTY=no",
        "GlobalKnownHostsFile=/dev/null",
        "HostKeyAlgorithms=ssh-ed25519",
        "PubkeyAcceptedAlgorithms=ssh-ed25519",
        "PKCS11Provider=none",
        "AddKeysToAgent=no",
        "ConnectTimeout=10",
    ] {
        args.extend(["-o".into(), option.into()]);
    }
    args.extend([
        "-o".into(),
        format!("UserKnownHostsFile=\"{}\"", known.display()),
        "-o".into(),
        format!("HostKeyAlias={alias}"),
        "-o".into(),
        format!("Hostname={current_ip}"),
        "-l".into(),
        account.short_name.clone(),
        alias.clone(),
        format!(
            "{}/.terminalx-local/bin/terminalx-serve local-vm-rpc -",
            account.home()
        ),
    ]);
    let mut params = params;
    let object = params
        .as_object_mut()
        .context("Guest request object required")?;
    object.insert("environmentId".into(), json!(current_target.environment_id));
    object.insert("generation".into(), json!(current_target.generation));
    let request = serde_json::to_vec(
        &json!({"method":method,"params":params,"expectedRuntimeSha256":runtime_sha,"expectedMacosAccount":observed.account}),
    )?;
    if request.len() > super::guest::MAX_RPC_BYTES {
        bail!("Guest request exceeds its bound");
    }
    Ok(SshPlan {
        args,
        known_hosts: format!("{alias} {}\n", trust.host_key),
        request,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan() -> (Target, AccountPlan) {
        (
            Target {
                environment_id: journal::new_id(),
                generation: journal::new_id(),
                vm_fingerprint: "a".repeat(64),
                restore_sha256: "b".repeat(64),
                macos_major: 26,
            },
            AccountPlan {
                short_name: "personal".into(),
                password_reference: journal::new_id(),
                ssh_key_reference: journal::new_id(),
            },
        )
    }
    fn observation(target: &Target, account: &AccountPlan) -> AccountReceipt {
        AccountReceipt {
            target: target.clone(),
            account: super::super::macos_account::Account {
                short_name: account.short_name.clone(),
                uid: 501,
                gid: 20,
                home: account.home(),
                home_device: 1,
                home_inode: 42,
            },
            bootstrap_observation_digest: "c".repeat(64),
        }
    }
    #[test]
    fn interrupted_first_account_retains_original_identity_and_never_replays() {
        let root = tempfile::tempdir().unwrap();
        let key = journal::new_id();
        let (target, account) = plan();
        let record = begin(root.path(), &key, &target, &account).unwrap();
        let digest = record["inputDigest"].as_str().unwrap();
        let unknown = create_account_using(root.path(), &key, digest, |_, _| {
            bail!("fixture lost response")
        })
        .unwrap();
        assert_eq!(unknown["status"], "accountOutcomeUnknown");
        assert!(begin(root.path(), &journal::new_id(), &target, &account).is_err());
        assert_eq!(
            begin(root.path(), &key, &target, &account).unwrap(),
            unknown
        );
        let path = directory(root.path(), &key).unwrap().join("record.json");
        let bytes = std::fs::read(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(begin(root.path(), &key, &target, &account).is_err());
        journal::atomic_private_write(&path, &bytes).unwrap();
        assert_eq!(
            create_account_using(root.path(), &key, digest, |_, _| panic!(
                "replayed account creation"
            ))
            .unwrap(),
            unknown
        );
        assert!(
            reconcile_account_using(root.path(), &key, digest, |target, account| {
                let mut value = observation(target, account);
                value.target.generation = journal::new_id();
                Ok(value)
            })
            .is_err()
        );
        let observed = reconcile_account_using(root.path(), &key, digest, |target, account| {
            Ok(observation(target, account))
        })
        .unwrap();
        assert_eq!(observed["status"], "accountObserved");
        assert_eq!(observed["ready"], false);
        let mut replaced = target;
        replaced.vm_fingerprint = "d".repeat(64);
        assert!(begin(root.path(), &key, &replaced, &account).is_err());
        assert_eq!(capability()["available"], false);
    }
    #[test]
    fn ssh_plan_pins_guest_host_key_account_and_target_without_inherited_authentication() {
        let root = tempfile::tempdir().unwrap();
        let key = journal::new_id();
        let (target, account) = plan();
        let planned = begin(root.path(), &key, &target, &account).unwrap();
        let observed = create_account_using(
            root.path(),
            &key,
            planned["inputDigest"].as_str().unwrap(),
            |target, account| Ok(observation(target, account)),
        )
        .unwrap();
        let mut bytes = Vec::new();
        bytes.extend(11_u32.to_be_bytes());
        bytes.extend(b"ssh-ed25519");
        bytes.extend(32_u32.to_be_bytes());
        bytes.extend([7_u8; 32]);
        use sha2::{Digest, Sha256};
        let mut receipt = TrustReceipt {
            target: target.clone(),
            account_receipt_digest: journal::digest(
                &serde_json::to_vec(&observed["accountReceipt"]).unwrap(),
            ),
            host_key: format!("ssh-ed25519 {}", STANDARD.encode(&bytes)),
            host_key_fingerprint: "wrong".into(),
            bootstrap_observation_digest: "d".repeat(64),
        };
        assert!(retain_trust(root.path(), &key, &receipt).is_err());
        receipt.host_key_fingerprint =
            format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&bytes)));
        retain_trust(root.path(), &key, &receipt).unwrap();
        let plan = ssh_plan(
            root.path(),
            &key,
            &target,
            Ipv4Addr::new(192, 168, 64, 2),
            &"e".repeat(64),
            "describe",
            json!({}),
        )
        .unwrap();
        for flag in [
            "StrictHostKeyChecking=yes",
            "IdentityAgent=none",
            "PasswordAuthentication=no",
            "ClearAllForwardings=yes",
            "ControlPath=none",
        ] {
            assert!(plan.args.iter().any(|arg| arg == flag));
        }
        assert_eq!(&plan.args[..2], ["-F", "none"]);
        assert!(plan.known_hosts.contains(&receipt.host_key));
        assert_eq!(
            serde_json::from_slice::<Value>(&plan.request).unwrap()["params"]["generation"],
            target.generation
        );
        let rpc: super::super::guest::Request = serde_json::from_slice(&plan.request).unwrap();
        assert_eq!(
            rpc.expected_macos_account,
            Some(observation(&target, &account).account)
        );
        assert!(plan.args.last().unwrap().starts_with("/Users/personal/"));
        assert!(!plan
            .args
            .iter()
            .any(|arg| arg.contains("password_reference")));
        let mut replaced = target;
        replaced.generation = journal::new_id();
        assert!(ssh_plan(
            root.path(),
            &key,
            &replaced,
            Ipv4Addr::new(192, 168, 64, 2),
            &"e".repeat(64),
            "describe",
            json!({})
        )
        .is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1); // Ledger only; no key/config creation or SSH execution.
    }
}
