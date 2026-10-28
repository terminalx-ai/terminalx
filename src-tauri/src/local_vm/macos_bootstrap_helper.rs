//! Independent first-account observation and authorized-key installation.
//! The source performs real bounded filesystem work, but has no production
//! channel constructor/CLI/RPC. Only disposable tests can construct a channel.
//! Receipts are local observations, not authenticated owner/share trust proofs.
use super::macos_helper_fs as fs;
use super::{
    journal,
    macos_account::{Account, User},
    macos_personalization::{self, Target},
};
use anyhow::{bail, Context, Result};
use fs::{Directory, Node};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{Seek, SeekFrom, Write},
    os::unix::fs::MetadataExt,
    path::Path,
    time::Duration,
};

const MANIFEST_LIMIT: u64 = 32 * 1024;
const KEYS_LIMIT: u64 = 64 * 1024;
const STATE: &str = ".terminalx-bootstrap-helper";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Share {
    id: String,
    host: Node,
    mounted: Node,
    read_only: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    bootstrap_id: String,
    target: Target,
    owner_epoch: String,
    nonce: String,
    parent_session: String,
    parent_tab: String,
    parent_conversation: String,
    input: Share,
    output: Share,
}
impl Binding {
    fn validate(&self) -> Result<()> {
        self.target.validate()?;
        for id in [
            &self.bootstrap_id,
            &self.owner_epoch,
            &self.parent_session,
            &self.parent_tab,
            &self.input.id,
            &self.output.id,
        ] {
            journal::validate_id(id)?;
        }
        super::transport::validate_runtime_sha(&self.nonce)?;
        if !self.input.read_only
            || self.output.read_only
            || self.input.id == self.output.id
            || self.input.host == self.output.host
            || self.input.mounted == self.output.mounted
            || [
                self.input.host.inode,
                self.output.host.inode,
                self.input.mounted.inode,
                self.output.mounted.inode,
            ]
            .contains(&0)
            || self.parent_conversation.is_empty()
            || self.parent_conversation.len() > 256
            || self.parent_conversation.chars().any(char::is_control)
        {
            bail!("Invalid original bootstrap owner/share binding")
        }
        Ok(())
    }
}
/// Intentionally not Deserialize/Clone and no public/request-supplied factory.
/// A future backend must authenticate a live original owner and actual mount
/// mapping/read-only properties before producing these descriptor capabilities.
struct Channel {
    binding: Binding,
    input: Directory,
    output: Directory,
    home: Directory,
}
impl Channel {
    fn acquire() -> Result<Self> {
        bail!("Authenticated original VM-owner/share broker is unavailable; no account, host-key or authorized_keys path was accessed")
    }
    fn check(&self) -> Result<()> {
        self.binding.validate()?;
        self.input.check()?;
        self.output.check()?;
        self.home.check()?;
        if self.input.node()? != self.binding.input.mounted
            || self.output.node()? != self.binding.output.mounted
            || self.home.node()? == self.input.node()?
            || self.home.node()? == self.output.node()?
        {
            bail!("Original mounted share/home changed")
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    binding: Binding,
    account_name: String,
    account_home: String,
    os_version: String,
    os_build: String,
    helper_sha256: String,
    runtime_sha256: String,
}
impl Manifest {
    fn read(channel: &Channel) -> Result<Self> {
        channel.check()?;
        let value: Self = fs::json(&channel.input, "account-manifest.json", MANIFEST_LIMIT)?;
        macos_account_name(&value.account_name, &value.account_home)?;
        validate_os(&value.os_version, &value.os_build)?;
        for hash in [&value.helper_sha256, &value.runtime_sha256] {
            super::transport::validate_runtime_sha(hash)?;
        }
        if value.version != 1 || value.binding != channel.binding {
            bail!("Manifest is not the original authenticated channel binding")
        }
        Ok(value)
    }
}
fn macos_account_name(name: &str, home: &str) -> Result<()> {
    super::macos_account::validate_name(name)?;
    if home != format!("/Users/{name}") {
        bail!("Expected personalized account home")
    }
    Ok(())
}
fn validate_os(version: &str, build: &str) -> Result<()> {
    let parts = version.split('.').collect::<Vec<_>>();
    if parts.is_empty()
        || parts.len() > 3
        || parts[0] != "26"
        || parts
            .iter()
            .any(|p| p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()))
        || build.is_empty()
        || build.len() > 32
        || !build.bytes().all(|b| b.is_ascii_alphanumeric())
    {
        bail!("Exact macOS26 version/build required")
    }
    Ok(())
}
struct Source {
    user: User,
    os_version: String,
    os_build: String,
    host_keys: Directory,
    helper: Directory,
}
impl Source {
    fn system(channel: &Channel) -> Result<Self> {
        channel.check()?;
        if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
            bail!("macOS arm64 guest required")
        }
        let user = super::macos_account::current_user()?;
        let uid = user.uid;
        let executable = std::env::current_exe()?;
        if executable.file_name().and_then(|name| name.to_str())
            != Some("terminalx-bootstrap-helper")
        {
            bail!("Dedicated pinned bootstrap helper required")
        }
        let home = Directory::open(Path::new(&user.home), user.uid, false)?;
        if home.node()? != channel.home.node()? {
            bail!("OS account is not the owned guest home")
        }
        fn version(flag: &str) -> Result<String> {
            let result = super::process::run(
                std::process::Command::new("/usr/bin/sw_vers")
                    .env_clear()
                    .arg(flag),
                b"",
                Duration::from_secs(5),
            )?;
            if result.len() > 128 {
                bail!("OS observation exceeds bound")
            }
            Ok(std::str::from_utf8(&result)?.trim().into())
        }
        // These paths contain public OS/host-key data only; never open a private
        // SSH host key, personal credential, password database field or agent.
        Ok(Self {
            user,
            os_version: version("-productVersion")?,
            os_build: version("-buildVersion")?,
            host_keys: Directory::open(Path::new("/private/etc/ssh"), 0, false)?,
            helper: Directory::open(
                executable.parent().context("Helper parent missing")?,
                uid,
                false,
            )?,
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Observation {
    manifest: Manifest,
    account: Account,
    host_public_key: String,
    host_fingerprint: String,
    host_key_node: Node,
    host_key_file_sha256: String,
    helper_node: Node,
}
fn observe(channel: &Channel, source: &Source, manifest: &Manifest) -> Result<Observation> {
    channel.check()?;
    validate_os(&source.os_version, &source.os_build)?;
    if source.user.short_name != manifest.account_name
        || source.user.home != manifest.account_home
        || source.os_version != manifest.os_version
        || source.os_build != manifest.os_build
    {
        bail!("Original account/home/OS differs")
    }
    let home = channel.home.node()?;
    let account = Account {
        short_name: source.user.short_name.clone(),
        uid: source.user.uid,
        gid: source.user.gid,
        home: source.user.home.clone(),
        home_device: home.device,
        home_inode: home.inode,
    };
    account.validate()?;
    // Directory capability's UID also must equal the observed real account.
    if channel.home.uid()? != account.uid {
        bail!("Observed account does not own its original home")
    }
    let mut key = source
        .host_keys
        .open_file("ssh_host_ed25519_key.pub", false, false, false)?;
    let bytes = fs::read_file(&mut key, 4096)?;
    let text = std::str::from_utf8(&bytes)?;
    let parts = text.split_whitespace().collect::<Vec<_>>();
    if !(2..=3).contains(&parts.len()) || text.trim().contains('\n') || text.trim().contains('\r') {
        bail!("One existing public host key required")
    }
    let public = format!("{} {}", parts[0], parts[1]);
    let fingerprint = macos_personalization::public_key(&public)?;
    source
        .host_keys
        .check_file("ssh_host_ed25519_key.pub", &key, false)?;
    let mut helper = source
        .helper
        .open_file("terminalx-bootstrap-helper", false, false, false)?;
    let helper_bytes = fs::read_file(&mut helper, 512 * 1024 * 1024)?;
    if helper.metadata()?.mode() & 0o100 == 0
        || journal::digest(&helper_bytes) != manifest.helper_sha256
    {
        bail!("Original pinned helper differs")
    }
    source
        .helper
        .check_file("terminalx-bootstrap-helper", &helper, false)?;
    Ok(Observation {
        manifest: manifest.clone(),
        account,
        host_public_key: public,
        host_fingerprint: fingerprint,
        host_key_node: Node::of(&key.metadata()?),
        host_key_file_sha256: journal::digest(&bytes),
        helper_node: Node::of(&helper.metadata()?),
    })
}
fn digest<T: Serialize>(value: &T) -> Result<String> {
    Ok(journal::digest(&serde_json::to_vec(value)?))
}
fn ledger(channel: &Channel, manifest: &Manifest) -> Result<(Directory, std::fs::File)> {
    let existed = channel.home.exists(STATE)?;
    let root = channel.home.child(STATE, !existed)?;
    let lock = root.lock("operation.lock", !existed)?;
    if existed {
        let original: Manifest = fs::json(&root, "manifest.json", MANIFEST_LIMIT)?;
        if original != *manifest {
            bail!("Home already belongs to another bootstrap/owner/share timeline")
        }
    } else {
        root.write_new("manifest.json", &serde_json::to_vec(manifest)?)?;
    }
    Ok((root, lock))
}
fn observation_receipt(observation: &Observation) -> Result<Value> {
    Ok(
        json!({"version":1,"stage":"accountObserved","observation":observation,"observationDigest":digest(observation)?,"ready":false,"trustAccepted":false}),
    )
}
fn retain_observation(
    channel: &Channel,
    source: &Source,
    manifest: &Manifest,
    root: &Directory,
) -> Result<Observation> {
    let observed = observe(channel, source, manifest)?;
    if root.exists("observation.json")? {
        if fs::json::<Observation>(root, "observation.json", 64 * 1024)? != observed {
            bail!("Original account/OS/host-key/helper observation changed")
        }
    } else {
        if root.exists("key-intent.json")?
            || root.exists("write-intent.json")?
            || root.exists("key-receipt.json")?
        {
            bail!("Original observation history is missing; no replacement")
        }
        root.write_new("observation.json", &serde_json::to_vec(&observed)?)?;
    }
    channel.check()?;
    channel.output.publish(
        "account-receipt.json",
        &serde_json::to_vec(&observation_receipt(&observed)?)?,
    )?;
    Ok(observed)
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeyManifest {
    version: u32,
    binding: Binding,
    observation_digest: String,
    key_reference: String,
    public_key: String,
}
impl KeyManifest {
    fn read(channel: &Channel, observation: &Observation) -> Result<Self> {
        let value: Self = fs::json(&channel.input, "public-key-manifest.json", MANIFEST_LIMIT)?;
        journal::validate_id(&value.key_reference)?;
        macos_personalization::public_key(&value.public_key)?;
        if value.version != 1
            || value.binding != channel.binding
            || value.observation_digest != digest(observation)?
            || value.public_key == observation.host_public_key
        {
            bail!("Public key is not bound to the original account/owner observation")
        }
        Ok(value)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteIntent {
    key: KeyManifest,
    ssh: Node,
    file: Node,
    before: Vec<u8>,
    after_sha256: String,
}
fn appended(before: &[u8], key: &KeyManifest) -> Result<Vec<u8>> {
    if before.len() as u64 > KEYS_LIMIT || before.contains(&0) {
        bail!("Unsupported original authorized_keys")
    }
    let text = std::str::from_utf8(before)?;
    let blob = key
        .public_key
        .split_once(' ')
        .context("Public key missing")?
        .1;
    if text.contains("terminalx-bootstrap:") || text.split_whitespace().any(|part| part == blob) {
        bail!("Existing bootstrap key/marker cannot be adopted or duplicated")
    }
    let mut after = before.to_vec();
    if !after.is_empty() && after.last() != Some(&b'\n') {
        after.push(b'\n');
    }
    after.extend(
        format!(
            "restrict {} terminalx-bootstrap:{}\n",
            key.public_key, key.binding.bootstrap_id
        )
        .as_bytes(),
    );
    if after.len() as u64 > KEYS_LIMIT {
        bail!("Authorized keys would exceed bound")
    }
    Ok(after)
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Step {
    Prepared,
    Intent,
    Appended,
    Receipt,
}
fn install(
    channel: &Channel,
    source: &Source,
    manifest: &Manifest,
    root: &Directory,
    observation: &Observation,
    reconcile: bool,
    mut step: impl FnMut(Step) -> Result<()>,
) -> Result<Value> {
    let key = KeyManifest::read(channel, observation)?;
    let existed = root.exists("key-intent.json")?;
    if !existed
        && (reconcile || root.exists("write-intent.json")? || root.exists("key-receipt.json")?)
    {
        bail!("Original key installation intent is missing")
    }
    if existed {
        if fs::json::<KeyManifest>(root, "key-intent.json", MANIFEST_LIMIT)? != key {
            bail!("Original public key intent changed; no replacement")
        }
    } else {
        // Persist intent before creating .ssh, an empty file or appending bytes.
        root.write_new("key-intent.json", &serde_json::to_vec(&key)?)?;
        step(Step::Prepared)?;
    }
    if existed && !root.exists("write-intent.json")? {
        bail!("Original preparation outcome unknown; no directory/file creation replay")
    }
    let ssh = channel
        .home
        .child(".ssh", !existed && !channel.home.exists(".ssh")?)?;
    let new_file = !existed && !ssh.exists("authorized_keys")?;
    let mut file = ssh.open_file("authorized_keys", true, new_file, true)?;
    fs::lock_file(&file)?;
    let intent = if existed {
        let intent: WriteIntent = fs::json(root, "write-intent.json", 512 * 1024)?;
        if intent.key != key
            || intent.ssh != ssh.node()?
            || intent.file != Node::of(&file.metadata()?)
        {
            bail!("Original key file/directory changed")
        }
        intent
    } else {
        let before = fs::read_file(&mut file, KEYS_LIMIT)?;
        let after = appended(&before, &key)?;
        let intent = WriteIntent {
            key: key.clone(),
            ssh: ssh.node()?,
            file: Node::of(&file.metadata()?),
            before,
            after_sha256: journal::digest(&after),
        };
        root.write_new("write-intent.json", &serde_json::to_vec(&intent)?)?;
        step(Step::Intent)?;
        channel.check()?;
        ssh.check_file("authorized_keys", &file, true)?;
        if Manifest::read(channel)? != *manifest
            || KeyManifest::read(channel, observation)? != key
            || observe(channel, source, manifest)? != *observation
            || fs::read_file(&mut file, KEYS_LIMIT)? != intent.before
        {
            bail!("Original identity or key file changed before write")
        }
        file.seek(SeekFrom::End(0))?;
        file.write_all(&after[intent.before.len()..])?;
        file.sync_all()?;
        step(Step::Appended)?;
        intent
    };
    let after = appended(&intent.before, &key)?;
    if journal::digest(&after) != intent.after_sha256 {
        bail!("Original write intent is inconsistent")
    }
    channel.check()?;
    ssh.check_file("authorized_keys", &file, true)?;
    if Manifest::read(channel)? != *manifest
        || KeyManifest::read(channel, observation)? != key
        || observe(channel, source, manifest)? != *observation
    {
        bail!("Original observation changed after installation")
    }
    if fs::read_file(&mut file, KEYS_LIMIT)? != after {
        return Ok(
            json!({"stage":"outcomeUnknown","detail":"Original key write is incomplete or changed; no append, replacement or regeneration was attempted","inputDigest":digest(&key)?,"ready":false,"trustAccepted":false}),
        );
    }
    // An earlier sync may have failed after the complete append. Reconciliation
    // can flush these proven original bytes, but must never repeat the append.
    file.sync_all()?;
    ssh.check_file("authorized_keys", &file, true)?;
    let receipt = json!({"version":1,"stage":"publicKeyInstalled","binding":channel.binding,"account":observation.account,
        "observationDigest":digest(observation)?,"keyReference":key.key_reference,"publicKey":key.public_key,
        "hostPublicKey":observation.host_public_key,"hostFingerprint":observation.host_fingerprint,
        "inputDigest":digest(&key)?,"file":intent.file,"ssh":intent.ssh,"beforeSha256":journal::digest(&intent.before),"afterSha256":intent.after_sha256,
        "effectEvidence":"originalFileAtExpectedBytesUnderLock","ready":false,"trustAccepted":false});
    root.publish("key-receipt.json", &serde_json::to_vec(&receipt)?)?;
    step(Step::Receipt)?;
    channel.check()?;
    channel
        .output
        .publish("public-key-receipt.json", &serde_json::to_vec(&receipt)?)?;
    Ok(receipt)
}
fn execute(
    channel: &Channel,
    source: &Source,
    action: &str,
    step: impl FnMut(Step) -> Result<()>,
) -> Result<Value> {
    if !matches!(
        action,
        "observe" | "installPublicKey" | "reconcilePublicKey"
    ) {
        bail!("Unknown bootstrap helper action")
    }
    let manifest = Manifest::read(channel)?;
    // Account/OS/key checks precede even creation of a guest-local ledger.
    observe(channel, source, &manifest)?;
    let (root, _lock) = ledger(channel, &manifest)?;
    if action != "observe" && !root.exists("observation.json")? {
        bail!("Original account observation must precede key installation")
    }
    let observation = retain_observation(channel, source, &manifest, &root)?;
    if action == "observe" {
        return observation_receipt(&observation);
    }
    install(
        channel,
        source,
        &manifest,
        &root,
        &observation,
        action == "reconcilePublicKey",
        step,
    )
}
/// Deliberately not wired to any existing production/legacy CLI or RPC.
pub(super) fn run(action: &str) -> Result<Value> {
    let channel = Channel::acquire()?;
    let source = Source::system(&channel)?;
    execute(&channel, &source, action, |_| Ok(()))
}

/// Strict local-content validation only. The candidate owner client must first
/// authenticate the original process/share channel; this function grants no
/// trust capability and is never exposed as a production receipt constructor.
pub(super) fn validate_owner_receipt(
    bytes: &[u8],
    manifest: &Value,
    original_account: Option<&Value>,
    original_key: Option<&Value>,
) -> Result<Value> {
    if bytes.len() > 64 * 1024 {
        bail!("Helper receipt exceeds bound")
    }
    validate_manifest_content(manifest)?;
    let expected: Manifest = serde_json::from_value(manifest.clone())?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct AccountReceipt {
        version: u32,
        stage: String,
        observation: Observation,
        observation_digest: String,
        ready: bool,
        trust_accepted: bool,
    }
    if original_account.is_none() {
        let receipt: AccountReceipt = serde_json::from_slice(bytes)?;
        let observation = &receipt.observation;
        observation.account.validate()?;
        if receipt.version != 1
            || receipt.stage != "accountObserved"
            || receipt.ready
            || receipt.trust_accepted
            || observation.manifest != expected
            || receipt.observation_digest != digest(observation)?
            || observation.account.short_name != expected.account_name
            || observation.account.home != expected.account_home
            || macos_personalization::public_key(&observation.host_public_key)?
                != observation.host_fingerprint
            || observation.host_key_node.inode == 0
            || observation.helper_node.inode == 0
        {
            bail!("Original helper account observation differs")
        }
        super::transport::validate_runtime_sha(&observation.host_key_file_sha256)?;
    } else {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct KeyReceipt {
            version: u32,
            stage: String,
            binding: Binding,
            account: Account,
            observation_digest: String,
            key_reference: String,
            public_key: String,
            host_public_key: String,
            host_fingerprint: String,
            input_digest: String,
            file: Node,
            ssh: Node,
            before_sha256: String,
            after_sha256: String,
            effect_evidence: String,
            ready: bool,
            trust_accepted: bool,
        }
        let account = original_account.context("Original account receipt missing")?;
        validate_owner_receipt(&serde_json::to_vec(account)?, manifest, None, None)?;
        let receipt: KeyReceipt = serde_json::from_slice(bytes)?;
        let key: KeyManifest = serde_json::from_value(
            original_key
                .context("Original public key intent missing")?
                .clone(),
        )?;
        let observed: Observation = serde_json::from_value(account["observation"].clone())?;
        journal::validate_id(&key.key_reference)?;
        macos_personalization::public_key(&key.public_key)?;
        if key.version != 1
            || key.binding != expected.binding
            || key.observation_digest != digest(&observed)?
            || key.public_key == observed.host_public_key
            || receipt.version != 1
            || receipt.stage != "publicKeyInstalled"
            || receipt.binding != expected.binding
            || receipt.account != observed.account
            || receipt.observation_digest != digest(&observed)?
            || receipt.key_reference != key.key_reference
            || receipt.public_key != key.public_key
            || receipt.host_public_key != observed.host_public_key
            || receipt.host_fingerprint != observed.host_fingerprint
            || receipt.input_digest != digest(&key)?
            || receipt.file.inode == 0
            || receipt.ssh.inode == 0
            || receipt.effect_evidence != "originalFileAtExpectedBytesUnderLock"
            || receipt.ready
            || receipt.trust_accepted
        {
            bail!("Original helper key installation observation differs")
        }
        for hash in [&receipt.before_sha256, &receipt.after_sha256] {
            super::transport::validate_runtime_sha(hash)?;
        }
    }
    Ok(serde_json::from_slice(bytes)?)
}

#[cfg(test)]
pub(super) fn owner_test_receipts(
    input: (u64, u64),
    output: (u64, u64),
) -> (Value, Value, Value, Value) {
    tests::owner_receipts(input, output)
}

#[cfg(test)]
#[path = "macos_bootstrap_helper_tests.rs"]
mod tests;

/// Content validation only; it cannot authenticate a mount or create a channel.
pub(super) fn validate_manifest_content(manifest: &Value) -> Result<()> {
    let expected: Manifest = serde_json::from_value(manifest.clone())?;
    expected.binding.validate()?;
    macos_account_name(&expected.account_name, &expected.account_home)?;
    validate_os(&expected.os_version, &expected.os_build)?;
    if expected.version != 1 {
        bail!("Unsupported helper manifest")
    }
    for hash in [&expected.helper_sha256, &expected.runtime_sha256] {
        super::transport::validate_runtime_sha(hash)?;
    }
    Ok(())
}
