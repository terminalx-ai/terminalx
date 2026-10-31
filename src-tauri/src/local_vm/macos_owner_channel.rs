//! Candidate restricted-Lume client. Real bounded socket authentication and
//! receipt admission; no production constructor, launch/profile or trust promotion.
use super::macos_helper_fs as fs;
use super::{journal, macos_bootstrap_helper};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use fs::{Directory, Node};
use super::person_approval::Presented;
use hmac::{Hmac, Mac};
use rand_core::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::Sha256;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::{FileTypeExt, MetadataExt},
            net::UnixStream,
        },
    },
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Pin {
    path: PathBuf,
    device: u64,
    inode: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    version: u32,
    macos_major: u32,
    bootstrap_id: String,
    owner_epoch: String,
    nonce: String,
    environment_id: String,
    generation: String,
    vm_fingerprint: String,
    restore_sha256: String,
    runtime_sha256: String,
    helper_manifest_sha256: String,
    executable_sha256: String,
    parent_session: String,
    parent_tab: String,
    parent_conversation: String,
    input_share_id: String,
    output_share_id: String,
    config_sha256: String,
    paths: BTreeMap<String, Pin>,
    // Version 3 only: the offline seed this VM was enrolled from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seed_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seed_receipt_sha256: Option<String>,
}
/// Guest root in the VM behind this owner holds the seeded key: helper
/// authentication only. Built solely from a verified owner enrollment receipt;
/// it confers no account consent, trust or readiness.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Enrolled {
    pub(super) binding_digest: String,
    pub(super) challenge_sha256: String,
    pub(super) claims_sha256: String,
}
/// What the person confirmed in TerminalX: one observed account, shown from
/// the exact observation digest, in the original parent conversation.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AccountConfirmation {
    pub(super) confirm: bool,
    pub(super) observation_sha256: String,
    pub(super) account: Value,
    pub(super) parent_session: String,
    pub(super) parent_tab: String,
    pub(super) parent_conversation: String,
}
/// What the person confirmed after reviewing the guest's host key: the exact
/// fingerprint shown from one observation, in the original parent conversation.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HostKeyConfirmation {
    pub(super) confirm: bool,
    pub(super) observation_sha256: String,
    pub(super) fingerprint: String,
    pub(super) parent_session: String,
    pub(super) parent_tab: String,
    pub(super) parent_conversation: String,
}
fn operation(params: &Value) -> Result<Reference> {
    let key = params["idempotencyKey"].as_str().context("Original bootstrap operation required")?;
    journal::validate_id(key)?;
    Reference::reopen(&super::host::root()?.join("bo").join(key))
}
/// Read-only: the accounts the enrolled helper reported, for the person to
/// choose from, and any answer to an earlier confirmation.
pub(super) fn guest_accounts(params: &Value) -> Result<Value> {
    account_status(&super::host::root()?, &operation(params)?)
}
/// Read-only: this conversation's version-3 bootstraps and where each account
/// confirmation stands. Only bootstraps whose original parent is exactly this
/// session, tab and conversation are listed; nothing is chosen or relayed.
pub(super) fn guest_account_confirmations(params: &Value) -> Result<Value> {
    confirmations_in(&super::host::root()?.join("bo"), params)
}
fn confirmations_in(root: &Path, params: &Value) -> Result<Value> {
    let text = |name: &str| params[name].as_str().context("Original parent session, tab and conversation required");
    let (session, tab, conversation) = (text("parentSession")?, text("parentTab")?, text("parentConversation")?);
    let mut bootstraps = Vec::new();
    if root.try_exists()? {
        for entry in std::fs::read_dir(root)? {
            let entry = entry?;
            let key = entry.file_name().to_string_lossy().into_owned();
            if journal::validate_id(&key).is_err() {
                continue;
            }
            let Ok(reference) = Reference::reopen(&entry.path()) else { continue };
            let b = &reference.binding;
            if b.version != 3 || b.parent_session != session || b.parent_tab != tab || b.parent_conversation != conversation {
                continue;
            }
            let data = root.parent().context("Local VM data root missing")?;
            let mut status = account_status(data, &reference).unwrap_or_else(|error| {
                json!({"observationSha256": null, "accounts": [], "detail": format!("{error:#}"), "accountAuthenticated": false,
                    "trustAccepted": false, "ready": false})
            });
            status["idempotencyKey"] = json!(key);
            bootstraps.push(status);
        }
    }
    bootstraps.sort_by(|a, b| a["idempotencyKey"].as_str().cmp(&b["idempotencyKey"].as_str()));
    Ok(json!({"bootstraps": bootstraps, "personApproval": super::person_approval::availability()}))
}
/// `data` is the Local VM data root, where the transport's journal, ledger
/// and first-connection evidence live.
fn account_status(data: &Path, reference: &Reference) -> Result<Value> {
    let (bytes, observation) = reference.account_observation()?;
    let answer = reference.account_answer().ok();
    let authenticated = answer.as_ref().is_some_and(|a| a["accountAuthenticated"] == true);
    // Read-only: nothing is produced or granted here. A grant's result is
    // reported exactly as the helper gave it.
    let key = match reference.key_result() {
        Ok(result) => result,
        Err(_) if reference.root.exists("key-grant.json")? => json!({"stage": "grantPending"}),
        Err(_) if reference.root.exists("key-intent.json")? => json!({"stage": "keyPending"}),
        Err(_) if authenticated => json!({"stage": "notGranted"}),
        Err(_) => Value::Null,
    };
    let (host_key, retirement) = match key["stage"].as_str() {
        Some("publicKeyInstalled") => (
            reference.host_key_status(data)?,
            // The helper retires only after the owner observed its host key.
            match reference.host_key_observation() {
                Ok((observed, observation)) => reference.retirement_status(&observed, &observation),
                Err(_) => Value::Null,
            },
        ),
        _ => (Value::Null, Value::Null),
    };
    let chosen = match reference.root.exists("account-confirmation.json")? {
        true => serde_json::from_slice::<Value>(&reference.root.read("account-confirmation.json", 32 * 1024, true)?)?["account"].clone(),
        false => Value::Null,
    };
    Ok(json!({"observationSha256": journal::digest(&bytes), "accounts": observation["accounts"], "helperAuthenticated": true,
        "accountAuthenticated": authenticated, "chosen": chosen, "answer": answer, "key": key, "hostKey": host_key,
        "retirement": retirement, "personApproval": super::person_approval::availability(), "trustAccepted": false,
        "ready": false}))
}
/// The approval the request carries, verified first. This build has no
/// approver, so every person-only action is refused here, before any lookup
/// or effect, whatever the caller sends.
fn person_approval(params: &Value) -> Result<Presented> {
    super::person_approval::presented(&super::person_approval::Unavailable, &params["approval"])
}
pub(super) const CONFIRM_ACCOUNT: &str = "environment.confirmGuestAccount";
pub(super) const GRANT_KEY: &str = "environment.grantGuestKey";
pub(super) const PIN_HOST_KEY: &str = "environment.confirmGuestHostKey";
/// The person's explicit confirmation of one reported account.
pub(super) fn confirm_guest_account(params: &Value) -> Result<Value> {
    let approval = person_approval(params)?;
    let reference = operation(params)?;
    let confirmation: AccountConfirmation = serde_json::from_value(json!({"confirm": params["confirm"],
        "observationSha256": params["observationSha256"], "account": params["account"],
        "parentSession": params["parentSession"], "parentTab": params["parentTab"],
        "parentConversation": params["parentConversation"]}))?;
    let relay = reference.confirm_account(&confirmation, &approval)?;
    Ok(json!({"relay": relay, "accountAuthenticated": false, "trustAccepted": false, "ready": false}))
}
/// The person's request, from the original parent, to install this VM's SSH
/// key in the account the helper acknowledged. No key material is accepted:
/// the host produces or recovers the VM's one original key and grants only its
/// public half. An install is never host trust, SSH success or readiness.
pub(super) fn grant_guest_key(params: &Value) -> Result<Value> {
    if ["publicKey", "privateKey", "keyReference"].iter().any(|name| !params[*name].is_null()) {
        bail!("Key material or references are never accepted from a caller")
    }
    let approval = person_approval(params)?;
    let reference = operation(params)?;
    let b = &reference.binding;
    if params["parentSession"] != b.parent_session.as_str()
        || params["parentTab"] != b.parent_tab.as_str()
        || params["parentConversation"] != b.parent_conversation.as_str()
    {
        bail!("Only the original parent conversation can install this VM's key")
    }
    let relay = reference.grant_guest_key_using(&super::host::root()?, Path::new("/usr/bin/ssh-keygen"), Duration::from_secs(15), &approval)?;
    Ok(json!({"relay": relay, "installed": false, "trustAccepted": false, "ready": false}))
}
/// The person's confirmation of the guest's SSH host key after reviewing its
/// fingerprint, from the original parent. No key is accepted from the caller;
/// only the owner's observation is pinned. It makes no SSH connection, and the
/// first connection, not this, verifies the pin.
pub(super) fn confirm_guest_host_key(params: &Value) -> Result<Value> {
    if ["hostKey", "publicKey", "knownHosts"].iter().any(|name| !params[*name].is_null()) {
        bail!("Host keys are never accepted from a caller")
    }
    let approval = person_approval(params)?;
    let reference = operation(params)?;
    let confirmation: HostKeyConfirmation = serde_json::from_value(json!({"confirm": params["confirm"],
        "observationSha256": params["observationSha256"], "fingerprint": params["fingerprint"],
        "parentSession": params["parentSession"], "parentTab": params["parentTab"],
        "parentConversation": params["parentConversation"]}))?;
    reference.confirm_host_key(&super::host::root()?, &confirmation, &approval)
}
/// This VM's one original SSH key: `planned`, the reference its provisioning
/// intent minted, published in `key-intent.json` and produced under exactly
/// `binding`. The reference is reserved before the intent is published
/// exclusively, so a lost reply, a concurrent claim or a crash at any point never
/// generates a second key. A changed binding, or missing or corrupt history,
/// refuses and stays fenced. Returns the reference and its verified public key;
/// the private key stays in its owner-only reference.
fn original_key(journal_dir: &Directory, keys_root: &Path, planned: &str, binding: &Value, utility: &Path, budget: Duration) -> Result<(String, String)> {
    journal::validate_id(planned)?;
    let published = || -> Result<Option<String>> {
        if !journal_dir.exists("key-intent.json")? {
            return Ok(None);
        }
        let intent: Value = serde_json::from_slice(&journal_dir.read("key-intent.json", 32 * 1024, true)?)
            .context("This VM's original key intent is corrupt; no key is created or replaced")?;
        let reference = intent["keyReference"].as_str().context("This VM's original key intent is corrupt")?;
        if intent.as_object().map(|o| o.len()) != Some(2) || intent["binding"] != *binding || reference != planned {
            bail!("This VM's original key belongs to another enrollment, account or parent; no key is created or replaced")
        }
        journal::validate_id(reference)?;
        Ok(Some(reference.to_string()))
    };
    let bound = |reference: &str| {
        let mut bound = binding.clone();
        bound["keyReference"] = json!(reference);
        super::macos_keys::Bound::of(&bound)
    };
    let reference = match published()? {
        Some(reference) => reference,
        None => {
            super::macos_keys::reserve(keys_root, planned, &bound(planned)?)?;
            match journal_dir.write_new("key-intent.json", &canonical(&json!({"binding": binding, "keyReference": planned}))?) {
                Ok(()) => planned.to_string(),
                // A concurrent claim published first; it is used only if identical.
                Err(error) => published()?.ok_or(error)?,
            }
        }
    };
    let record = super::macos_keys::produce_in(keys_root, &reference, &bound(&reference)?, utility, true, || Ok(()))?;
    if record["state"] != "ready" {
        bail!("This VM's original key creation has an unknown outcome; it is never repeated or replaced")
    }
    let (_guard, record) = super::macos_keys::resolve_in(keys_root, &reference, &bound(&reference)?, utility, budget)?;
    let public = record["receipt"]["publicKey"].as_str().context("This VM's original key receipt is incomplete")?;
    Ok((reference, public.to_string()))
}
pub(super) fn canonical(value: &Value) -> Result<Vec<u8>> {
    fn encode(value: &Value) -> Result<String> {
        Ok(match value {
            Value::Object(map) => {
                let ordered: BTreeMap<_, _> = map.iter().collect();
                format!(
                    "{{{}}}",
                    ordered
                        .into_iter()
                        .map(|(k, v)| Ok(format!("{}:{}", serde_json::to_string(k)?, encode(v)?)))
                        .collect::<Result<Vec<_>>>()?
                        .join(",")
                )
            }
            Value::Array(values) => format!(
                "[{}]",
                values
                    .iter()
                    .map(encode)
                    .collect::<Result<Vec<_>>>()?
                    .join(",")
            ),
            _ => serde_json::to_string(value)?,
        })
    }
    Ok(encode(value)?.into_bytes())
}
fn mac(secret: &[u8], domain: &str, parts: &[&str]) -> Result<Hmac<Sha256>> {
    let mut mac = Hmac::<Sha256>::new_from_slice(secret)?;
    for part in ["terminalx-lume-owner-v1", domain]
        .into_iter()
        .chain(parts.iter().copied())
    {
        mac.update(&(part.len() as u32).to_be_bytes());
        mac.update(part.as_bytes());
    }
    Ok(mac)
}
fn tag(secret: &[u8], domain: &str, parts: &[&str]) -> Result<String> {
    Ok(encode_hex(
        &mac(secret, domain, parts)?.finalize().into_bytes(),
    ))
}
fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn verify(secret: &[u8], domain: &str, parts: &[&str], value: &str) -> Result<()> {
    super::transport::validate_runtime_sha(value)?;
    let bytes = (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    mac(secret, domain, parts)?
        .verify_slice(&bytes)
        .context("Owner channel authentication refused")
}
fn wait(stream: &UnixStream, event: i16, deadline: Instant) -> Result<()> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .context("Owner frame deadline elapsed")?;
        let mut descriptor = libc::pollfd {
            fd: stream.as_raw_fd(),
            events: event,
            revents: 0,
        };
        // SAFETY: one initialized writable pollfd, owned socket, bounded timeout.
        let n = unsafe {
            libc::poll(
                &mut descriptor,
                1,
                remaining.as_millis().clamp(1, 4000) as i32,
            )
        };
        if n < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
        if n == 0 {
            bail!("Owner frame deadline elapsed")
        }
        if descriptor.revents & (event | libc::POLLHUP | libc::POLLERR) == 0 {
            bail!("Original owner socket unavailable")
        }
        return Ok(());
    }
}
fn read(stream: &mut UnixStream) -> Result<Vec<u8>> {
    // Darwin refuses SO_RCVTIMEO changes after peer close even while a complete
    // reply remains buffered. Poll plus nonblocking reads preserves that reply
    // while enforcing an absolute frame deadline, without treating exit as proof.
    stream.set_nonblocking(true)?;
    fn exact(stream: &mut UnixStream, mut bytes: &mut [u8], deadline: Instant) -> Result<()> {
        while !bytes.is_empty() {
            wait(stream, libc::POLLIN, deadline)?;
            match stream.read(bytes) {
                Ok(0) => bail!("Original owner closed the channel"),
                Ok(n) => bytes = &mut bytes[n..],
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    continue
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    }
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut prefix = [0; 4];
    exact(stream, &mut prefix, deadline)?;
    let count = u32::from_be_bytes(prefix) as usize;
    if count == 0 || count > 256 * 1024 {
        bail!("Owner frame exceeds bound")
    }
    let mut data = vec![0; count];
    exact(stream, &mut data, deadline)?;
    Ok(data)
}
fn send(stream: &mut UnixStream, value: &Value) -> Result<()> {
    stream.set_nonblocking(true)?;
    let data = canonical(value)?;
    if data.len() > 256 * 1024 {
        bail!("Owner frame exceeds bound")
    }
    let mut frame = (data.len() as u32).to_be_bytes().to_vec();
    frame.extend(data);
    let mut bytes = frame.as_slice();
    let deadline = Instant::now() + Duration::from_secs(4);
    while !bytes.is_empty() {
        wait(stream, libc::POLLOUT, deadline)?;
        match stream.write(bytes) {
            Ok(0) => bail!("Original owner closed the channel"),
            Ok(n) => bytes = &bytes[n..],
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) =>
            {
                continue
            }
            Err(e) => return Err(e.into()),
        }
    }
    Ok(())
}
fn configure(stream: &UnixStream, expected_pid: u32) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let (mut uid, mut gid, mut pid) = (0, 0, 0_i32);
        let mut length = std::mem::size_of::<i32>() as libc::socklen_t;
        // SAFETY: live owned socket and correctly sized writable OS outputs.
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0
            || uid != unsafe { libc::geteuid() }
            || unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_LOCAL,
                    libc::LOCAL_PEERPID,
                    (&mut pid as *mut i32).cast(),
                    &mut length,
                )
            } != 0
            || pid <= 0
            || pid as u32 != expected_pid
        {
            bail!("Original owner peer differs")
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (stream, expected_pid);
        bail!("Candidate requires native macOS peer identity")
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    payload: String,
    mac: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Handshake {
    binding_digest: String,
    epoch: String,
    socket_device: u64,
    socket_inode: u64,
    owner_pid: u32,
    console_available: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Challenge {
    server_nonce: String,
    epoch: String,
    mac: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Response {
    binding_digest: String,
    epoch: String,
    request_id: String,
    action: String,
    receipt: String,
    receipt_sha256: String,
    console_available: bool,
    ready: bool,
}

// No Deserialize or public factory. Reopen metadata locates the original owner;
// every observation still requires a fresh mutually authenticated challenge.
struct Reference {
    root: Directory,
    binding: Binding,
    raw: Vec<u8>,
    secret: Vec<u8>,
    manifest: Value,
}
impl Reference {
    fn acquire_production() -> Result<Self> {
        bail!("Restricted Lume candidate has no approved artifact/profile or production launcher; no channel or credential path was accessed")
    }
    fn reopen(path: &Path) -> Result<Self> {
        // SAFETY: geteuid has no memory preconditions.
        let root = Directory::open(path, unsafe { libc::geteuid() }, true)?;
        let raw = root.read("owner-intent.json", 32 * 1024, true)?;
        let binding: Binding = serde_json::from_slice(&raw)?;
        if canonical(&serde_json::to_value(&binding)?)? != raw {
            bail!("Original owner intent is not canonical")
        }
        let manifest_bytes = root.read("expected-helper.json", 32 * 1024, true)?;
        if journal::digest(&manifest_bytes) != binding.helper_manifest_sha256 {
            bail!("Original helper manifest changed")
        }
        let secret = root.read("control.capability", 32, true)?;
        if secret.len() != 32 {
            bail!("Original private control reference is incomplete")
        }
        let reference = Self {
            root,
            binding,
            raw,
            secret,
            manifest: serde_json::from_slice(&manifest_bytes)?,
        };
        reference.check(path)?;
        Ok(reference)
    }
    fn check(&self, path: &Path) -> Result<()> {
        self.root.check()?;
        if self.root.read("owner-intent.json", 32 * 1024, true)? != self.raw
            || self.root.read("control.capability", 32, true)? != self.secret
            || journal::digest(&self.root.read("expected-helper.json", 32 * 1024, true)?)
                != self.binding.helper_manifest_sha256
        {
            bail!("Original private channel reference changed")
        }
        let b = &self.binding;
        let roles = [
            "config",
            "disk",
            "input",
            "nvram",
            "operation",
            "output",
            "storage",
            "vm",
        ];
        // Version 3 exactly when the seed binding is present, as the owner decodes it.
        let seeded = match (&b.seed_id, &b.seed_receipt_sha256) {
            (None, None) => false,
            (Some(id), Some(receipt)) => {
                id.len() == 32 && id.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
                    && super::transport::validate_runtime_sha(receipt).is_ok()
            }
            _ => bail!("Original owner seed binding is partial"),
        };
        if !(if seeded { b.version == 3 } else { [1, 2].contains(&b.version) })
            || (b.seed_id.is_some() && !seeded)
            || b.macos_major != 26
            || b.paths.keys().map(String::as_str).collect::<Vec<_>>() != roles
            || b.paths["operation"].path != path
            || self.root.node()?
                != (Node {
                    device: b.paths["operation"].device,
                    inode: b.paths["operation"].inode,
                })
        {
            bail!("Original owner operation binding differs")
        }
        for id in [
            &b.bootstrap_id,
            &b.owner_epoch,
            &b.environment_id,
            &b.generation,
            &b.parent_session,
            &b.parent_tab,
            &b.input_share_id,
            &b.output_share_id,
        ] {
            journal::validate_id(id)?;
        }
        for digest in [
            &b.nonce,
            &b.vm_fingerprint,
            &b.restore_sha256,
            &b.runtime_sha256,
            &b.helper_manifest_sha256,
            &b.executable_sha256,
            &b.config_sha256,
        ] {
            super::transport::validate_runtime_sha(digest)?;
        }
        if b.parent_conversation.is_empty()
            || b.parent_conversation.len() > 256
            || !b
                .parent_conversation
                .bytes()
                .all(|c| (32..127).contains(&c))
        {
            bail!("Invalid parent conversation")
        }
        if b.version == 2 {
            plan::validate(&self.manifest)?;
        }
        let h = &self.manifest["binding"];
        if h["bootstrapId"] != b.bootstrap_id
            || h["ownerEpoch"] != b.owner_epoch
            || h["nonce"] != b.nonce
            || h["parentSession"] != b.parent_session
            || h["parentTab"] != b.parent_tab
            || h["parentConversation"] != b.parent_conversation
            || h["target"]["environmentId"] != b.environment_id
            || h["target"]["generation"] != b.generation
            || h["target"]["vmFingerprint"] != b.vm_fingerprint
            || h["target"]["restoreSha256"] != b.restore_sha256
            || h["target"]["macosMajor"] != 26
            || self.manifest["runtimeSha256"] != b.runtime_sha256
        {
            bail!("Helper manifest belongs to another owner/VM/parent")
        }
        for (role, name, id, readonly) in [
            ("input", "input", &b.input_share_id, true),
            ("output", "output", &b.output_share_id, false),
        ] {
            if h[name]["id"] != *id
                || h[name]["readOnly"] != readonly
                || h[name]["host"]
                    != json!({"device":b.paths[role].device,"inode":b.paths[role].inode})
            {
                bail!("Original helper share binding differs")
            }
        }
        Ok(())
    }
    fn launch_packet(&self) -> Value {
        json!({"binding":STANDARD.encode(&self.raw),"capability":STANDARD.encode(&self.secret)})
    }
    fn accept_launch(&self, stream: &mut UnixStream, child_pid: u32) -> Result<()> {
        self.accept_launch_using(stream, child_pid, || Ok(()))
    }
    fn accept_launch_using(
        &self,
        stream: &mut UnixStream,
        child_pid: u32,
        before_publish: impl FnOnce() -> Result<()>,
    ) -> Result<()> {
        // The inherited socketpair peer credential is the launching process;
        // child identity comes from its retained spawn handle plus the MAC.
        let envelope: Envelope = serde_json::from_slice(&read(stream)?)?;
        let bytes = STANDARD.decode(envelope.payload)?;
        verify(
            &self.secret,
            "launch",
            &[&journal::digest(&bytes)],
            &envelope.mac,
        )?;
        let handshake: Handshake = serde_json::from_slice(&bytes)?;
        if handshake.owner_pid != child_pid
            || handshake.epoch != self.binding.owner_epoch
            || handshake.binding_digest != journal::digest(&self.raw)
            || handshake.console_available
        {
            bail!("Original launch handshake differs")
        }
        self.socket(&handshake)?;
        before_publish()?;
        self.root.publish("owner-handshake.json", &bytes)
    }
    fn recover_launch(&self, original_child_pid: u32) -> Result<()> {
        if self.root.exists("owner-handshake.json")? {
            self.observe("observe", &journal::new_id())?;
            return Ok(());
        }
        let started: Value = fs::json(&self.root, "owner-started.json", 32 * 1024)?;
        let digest = journal::digest(&self.raw);
        if started
            != json!({"bindingDigest":digest,"epoch":self.binding.owner_epoch,"ownerPid":original_child_pid})
        {
            bail!("Original owner start history differs")
        }
        let meta =
            std::fs::symlink_metadata(self.binding.paths["operation"].path.join("owner.sock"))?;
        let handshake = Handshake {
            binding_digest: digest,
            epoch: self.binding.owner_epoch.clone(),
            socket_device: meta.dev(),
            socket_inode: meta.ino(),
            owner_pid: original_child_pid,
            console_available: false,
        };
        // Metadata only locates the original peer. A fresh mutual challenge on
        // this exact socket must succeed before the recovered pin is retained.
        self.observe_using(&handshake, "observe", &journal::new_id(), None)?;
        self.root.publish(
            "owner-handshake.json",
            &canonical(&serde_json::to_value(handshake)?)?,
        )
    }
    fn socket(&self, h: &Handshake) -> Result<PathBuf> {
        self.check(&self.binding.paths["operation"].path)?;
        let path = self.binding.paths["operation"].path.join("owner.sock");
        let meta = std::fs::symlink_metadata(&path)?;
        if !meta.file_type().is_socket()
            || meta.nlink() != 1
            || meta.mode() & 0o077 != 0
            || meta.uid() != self.root.uid()?
            || meta.dev() != h.socket_device
            || meta.ino() != h.socket_inode
            || h.binding_digest != journal::digest(&self.raw)
            || h.epoch != self.binding.owner_epoch
            || h.console_available
        {
            bail!("Original socket/owner binding changed; no replacement")
        }
        Ok(path)
    }
    fn observe(&self, action: &str, request_id: &str) -> Result<AuthenticatedReceipt> {
        if ![
            "observe",
            "accountReceipt",
            "keyReceipt",
            "guestObservation",
            "enrollment",
            "stop",
            "accountObservation",
            "accountAnswer",
            "keyAnswer",
            "hostKeyObservation",
            "retirementAcknowledgement",
            "retirementReport",
        ]
        .contains(&action)
        {
            bail!("Unsupported owner operation")
        }
        journal::validate_id(request_id)?;
        let handshake: Handshake = fs::json(&self.root, "owner-handshake.json", 32 * 1024)?;
        self.observe_using(&handshake, action, request_id, None)
    }
    fn observe_using(
        &self,
        handshake: &Handshake,
        action: &str,
        request_id: &str,
        payload: Option<&[u8]>,
    ) -> Result<AuthenticatedReceipt> {
        let mut stream = UnixStream::connect(self.socket(handshake)?)
            .context("Connect original private owner socket")?;
        configure(&stream, handshake.owner_pid).context("Verify original native socket peer")?;
        let mut nonce = [0; 32];
        rand_core::OsRng.fill_bytes(&mut nonce);
        let client_nonce = encode_hex(&nonce);
        let binding_digest = journal::digest(&self.raw);
        let mut request = json!({"action":action,"bindingDigest":binding_digest,"clientNonce":client_nonce,"requestId":request_id});
        if let Some(payload) = payload {
            request["payload"] = json!(STANDARD.encode(payload));
        }
        send(&mut stream, &request)?;
        let challenge: Challenge =
            serde_json::from_slice(&read(&mut stream).context("Read owner challenge")?)?;
        super::transport::validate_runtime_sha(&challenge.server_nonce)?;
        if challenge.epoch != self.binding.owner_epoch {
            bail!("Owner epoch changed")
        }
        // A payload's digest joins every MAC, so it cannot be swapped in transit.
        let payload_digest = payload.map(journal::digest);
        let mut parts = vec![
            binding_digest.as_str(),
            self.binding.owner_epoch.as_str(),
            action,
            request_id,
            client_nonce.as_str(),
            challenge.server_nonce.as_str(),
        ];
        parts.extend(payload_digest.as_deref());
        verify(&self.secret, "owner", &parts, &challenge.mac)?;
        self.socket(handshake)?;
        send(
            &mut stream,
            &json!({"mac":tag(&self.secret,"host",&parts)?}),
        )?;
        let envelope: Envelope = serde_json::from_slice(
            &read(&mut stream).context("Read authenticated owner receipt")?,
        )?;
        let bytes = STANDARD.decode(envelope.payload)?;
        let hash = journal::digest(&bytes);
        let mut signed = parts.to_vec();
        signed.push(&hash);
        verify(&self.secret, "receipt", &signed, &envelope.mac)?;
        let response: Response = serde_json::from_slice(&bytes)?;
        let receipt = STANDARD.decode(&response.receipt)?;
        if response.binding_digest != binding_digest
            || response.epoch != self.binding.owner_epoch
            || response.request_id != request_id
            || response.action != action
            || response.console_available
            || response.ready
            || receipt.len() > 64 * 1024
            || journal::digest(&receipt) != response.receipt_sha256
        {
            bail!("Authenticated owner returned a changed request or receipt")
        }
        self.socket(handshake)?;
        Ok(AuthenticatedReceipt { bytes: receipt })
    }
    /// Version 3: the owner's durable enrollment receipt over the MAC'd owner
    /// channel. Accepted only as exactly helper authentication for this binding
    /// and seed; account authentication, trust and readiness must stay false.
    fn enrollment(&self) -> Result<Enrolled> {
        if self.binding.version != 3 {
            bail!("Seeded-key enrollment requires a version-3 owner binding")
        }
        let receipt = self.observe("enrollment", &journal::new_id())?;
        let value: Value = serde_json::from_slice(&receipt.bytes)?;
        let keys = [
            "accountAuthenticated", "attempt", "bindingDigest", "bootstrapId", "challengeSha256", "claimsSha256",
            "helperAuthenticated", "ownerEpoch", "ready", "seedId", "seedReceiptSha256", "trustAccepted", "version",
        ];
        let hex64 = |v: &Value| v.as_str().is_some_and(|s| super::transport::validate_runtime_sha(s).is_ok());
        let mut found: Vec<&str> = value.as_object().map(|v| v.keys().map(String::as_str).collect()).unwrap_or_default();
        found.sort_unstable();
        if found != keys
            || value["version"] != 2
            || value["bindingDigest"] != journal::digest(&self.raw)
            || value["ownerEpoch"] != self.binding.owner_epoch
            || value["bootstrapId"] != self.binding.bootstrap_id
            || value["seedId"].as_str() != self.binding.seed_id.as_deref()
            || value["seedReceiptSha256"].as_str() != self.binding.seed_receipt_sha256.as_deref()
            || value["helperAuthenticated"] != true
            || ["accountAuthenticated", "trustAccepted", "ready"].iter().any(|k| value[*k] != false)
            || !hex64(&value["challengeSha256"])
            || !hex64(&value["claimsSha256"])
            || value["attempt"].as_u64().is_none_or(|n| n > 8)
        {
            bail!("Owner enrollment receipt changed or promoted trust")
        }
        Ok(Enrolled {
            binding_digest: journal::digest(&self.raw),
            challenge_sha256: value["challengeSha256"].as_str().unwrap_or_default().into(),
            claims_sha256: value["claimsSha256"].as_str().unwrap_or_default().into(),
        })
    }
    /// Version 3: asks the owner to stop its VM. The owner journals the request
    /// once and never claims an exit; exit evidence is only the original
    /// child-wait record. Returns the exact stop record.
    fn stop(&self) -> Result<Value> {
        if self.binding.version != 3 {
            bail!("Owner-mediated stop requires a version-3 owner binding")
        }
        let receipt = self.observe("stop", &journal::new_id())?;
        let value: Value = serde_json::from_slice(&receipt.bytes)?;
        let expected = json!({"version": 1, "bindingDigest": journal::digest(&self.raw), "ownerEpoch": self.binding.owner_epoch,
            "stopRequested": true, "exitConfirmed": false, "ready": false});
        if value != expected {
            bail!("Owner stop record changed or claimed an exit")
        }
        Ok(value)
    }
    /// Version 3: the helper's account observation, exactly as the owner
    /// journaled it, and its digest. Observation only; nothing is chosen.
    fn account_observation(&self) -> Result<(Vec<u8>, Value)> {
        if self.binding.version != 3 {
            bail!("Account confirmation requires a version-3 owner binding")
        }
        let receipt = self.observe("accountObservation", &journal::new_id())?;
        let value: Value = serde_json::from_slice(&receipt.bytes)?;
        let mut keys: Vec<&str> = value.as_object().map(|v| v.keys().map(String::as_str).collect()).unwrap_or_default();
        keys.sort_unstable();
        if keys != ["accountAuthenticated", "accounts", "bindingDigest", "challengeSha256", "helperAuthenticated", "ownerEpoch", "ready", "trustAccepted", "version"]
            || value["version"] != 1
            || value["bindingDigest"] != journal::digest(&self.raw)
            || value["ownerEpoch"] != self.binding.owner_epoch
            || value["helperAuthenticated"] != true
            || ["accountAuthenticated", "trustAccepted", "ready"].iter().any(|k| value[*k] != false)
            || !value["accounts"].is_array()
        {
            bail!("Owner account observation changed or promoted trust")
        }
        Ok((receipt.bytes, value))
    }
    /// The person's confirmation of one observed account, from the original
    /// parent session, tab and conversation. Recorded once, exclusively, before
    /// it is relayed: a retry re-presents the same choice, and a different
    /// account is refused for good. Relaying authenticates nothing by itself.
    /// The inputs a person approves for confirming `account` from the observation
    /// with digest `observation_sha256`, from this VM's original parent.
    fn account_approval_inputs(&self, observation_sha256: &str, account: &Value) -> Value {
        let b = &self.binding;
        json!({"bootstrapId": b.bootstrap_id, "bindingDigest": journal::digest(&self.raw), "ownerEpoch": b.owner_epoch,
            "observationSha256": observation_sha256, "account": account, "parentSession": b.parent_session,
            "parentTab": b.parent_tab, "parentConversation": b.parent_conversation})
    }
    fn confirm_account(&self, confirmation: &AccountConfirmation, approval: &Presented) -> Result<Value> {
        let (bytes, observation) = self.account_observation()?;
        if !confirmation.confirm
            || confirmation.observation_sha256 != journal::digest(&bytes)
            || !observation["accounts"].as_array().is_some_and(|a| a.contains(&confirmation.account))
            || confirmation.parent_session != self.binding.parent_session
            || confirmation.parent_tab != self.binding.parent_tab
            || confirmation.parent_conversation != self.binding.parent_conversation
        {
            bail!("Confirm exactly one observed account from the original parent conversation")
        }
        let inputs = self.account_approval_inputs(&journal::digest(&bytes), &confirmation.account);
        approval.consume(&self.root, CONFIRM_ACCOUNT, &inputs, std::time::SystemTime::now())?;
        let record = canonical(&json!({"version": 1, "bindingDigest": journal::digest(&self.raw),
            "ownerEpoch": self.binding.owner_epoch, "observationSha256": confirmation.observation_sha256,
            "account": confirmation.account, "parentSession": self.binding.parent_session,
            "parentTab": self.binding.parent_tab, "parentConversation": self.binding.parent_conversation,
            "confirmationId": journal::new_id()}))?;
        if !self.root.exists("account-confirmation.json")? {
            self.root.write_new("account-confirmation.json", &record)?;
        }
        let recorded = self.root.read("account-confirmation.json", 32 * 1024, true)?;
        let retained: Value = serde_json::from_slice(&recorded)?;
        if retained["account"] != confirmation.account || retained["observationSha256"] != confirmation.observation_sha256 {
            bail!("A different account was already confirmed for this VM; it is never re-chosen")
        }
        let handshake: Handshake = fs::json(&self.root, "owner-handshake.json", 32 * 1024)?;
        let receipt = self.observe_using(&handshake, "confirmAccount", &journal::new_id(), Some(&recorded))?;
        let relay: Value = serde_json::from_slice(&receipt.bytes)?;
        if relay != json!({"version": 1, "bindingDigest": journal::digest(&self.raw), "ownerEpoch": self.binding.owner_epoch,
            "confirmationSha256": journal::digest(&recorded), "account": confirmation.account, "relayed": true,
            "accountAuthenticated": false, "trustAccepted": false, "ready": false})
        {
            bail!("Owner relay record changed or promoted trust")
        }
        Ok(relay)
    }
    /// The helper's answer to the relayed confirmation. Only an exact
    /// acknowledgement authenticates that one account; trust and readiness stay false.
    fn account_answer(&self) -> Result<Value> {
        Ok(self.account_answer_bytes()?.1)
    }
    fn account_answer_bytes(&self) -> Result<(Vec<u8>, Value)> {
        if self.binding.version != 3 {
            bail!("Account confirmation requires a version-3 owner binding")
        }
        let recorded = self.root.read("account-confirmation.json", 32 * 1024, true)?;
        let retained: Value = serde_json::from_slice(&recorded)?;
        let receipt = self.observe("accountAnswer", &journal::new_id())?;
        let answer: Value = serde_json::from_slice(&receipt.bytes)?;
        let confirmed = answer["outcome"] == "confirmed";
        if answer != json!({"version": 1, "bindingDigest": journal::digest(&self.raw), "ownerEpoch": self.binding.owner_epoch,
            "confirmationSha256": journal::digest(&recorded), "account": retained["account"],
            "outcome": if confirmed { "confirmed" } else { "refused" }, "accountAuthenticated": confirmed,
            "trustAccepted": false, "ready": false})
        {
            bail!("Owner account answer changed or promoted trust")
        }
        Ok((receipt.bytes, answer))
    }
    /// Version 3: the immutable identities this VM's key is bound to, each
    /// verified through the owner: VM, owner epoch, seed, the helper's
    /// enrollment, the person's confirmation, the helper's exact acknowledgement
    /// of that one account, and the original parent. Before that
    /// acknowledgement nothing is bound, reserved or generated.
    fn key_binding(&self) -> Result<Value> {
        let (answer_bytes, answer) = self.account_answer_bytes()?;
        if answer["outcome"] != "confirmed" || answer["accountAuthenticated"] != true {
            bail!("The person's account choice was not acknowledged by the helper; no key is created or granted")
        }
        let enrolled = self.enrollment()?;
        let confirmation = self.root.read("account-confirmation.json", 32 * 1024, true)?;
        let b = &self.binding;
        Ok(json!({"version": 3, "bootstrapId": b.bootstrap_id, "bindingDigest": journal::digest(&self.raw),
            "ownerEpoch": b.owner_epoch, "environmentId": b.environment_id, "generation": b.generation,
            "vmFingerprint": b.vm_fingerprint, "seedId": b.seed_id, "seedReceiptSha256": b.seed_receipt_sha256,
            "enrollment": {"bindingDigest": enrolled.binding_digest, "challengeSha256": enrolled.challenge_sha256,
                "claimsSha256": enrolled.claims_sha256},
            "confirmationSha256": journal::digest(&confirmation), "answerSha256": journal::digest(&answer_bytes),
            "account": answer["account"], "parentSession": b.parent_session, "parentTab": b.parent_tab,
            "parentConversation": b.parent_conversation}))
    }
    /// Produces or recovers this VM's one original key, then grants its public
    /// half to the acknowledged account. `utility` is the fixed OpenSSH producer
    /// in production and a synthetic one in fixtures.
    fn grant_guest_key_using(&self, keys_root: &Path, utility: &Path, budget: Duration, approval: &Presented) -> Result<Value> {
        let (mut binding, inputs) = self.key_approval_inputs(keys_root)?;
        approval.consume(&self.root, GRANT_KEY, &inputs, std::time::SystemTime::now())?;
        let (planned, intent_digest) = self.planned_key(keys_root)?;
        binding["accountIntentDigest"] = json!(intent_digest);
        let (key_reference, public_key) = original_key(&self.root, keys_root, &planned, &binding, utility, budget)?;
        self.relay_grant(&key_reference, &public_key)
    }
    /// The key binding, and the inputs a person approves for granting this VM's
    /// key: the helper's exact acknowledgement, the account and the planned
    /// reference. Fails, binding nothing, before that acknowledgement.
    fn key_approval_inputs(&self, keys_root: &Path) -> Result<(Value, Value)> {
        let binding = self.key_binding()?;
        let (planned, _) = self.planned_key(keys_root)?;
        let b = &self.binding;
        let inputs = json!({"bootstrapId": b.bootstrap_id, "bindingDigest": journal::digest(&self.raw), "ownerEpoch": b.owner_epoch,
            "answerSha256": binding["answerSha256"], "account": {"name": binding["account"]["name"], "uid": binding["account"]["uid"]},
            "keyReference": planned, "parentSession": b.parent_session, "parentTab": b.parent_tab,
            "parentConversation": b.parent_conversation});
        Ok((binding, inputs))
    }
    /// The SSH key reference this bootstrap's provisioning intent minted before
    /// the VM existed, and that intent's digest. The post-trust transport uses
    /// the same reference; no other is ever minted for this VM.
    fn planned_key(&self, root: &Path) -> Result<(String, String)> {
        let (plan, digest) = self.plan(root)?;
        Ok((plan.ssh_key_reference, digest))
    }
    /// The account plan this bootstrap's provisioning intent recorded before the
    /// VM existed, checked against this owner's VM, and the intent's digest.
    fn plan(&self, root: &Path) -> Result<(super::macos_personalization::AccountPlan, String)> {
        // SAFETY: geteuid has no memory preconditions.
        let dir = Directory::open(&root.join("macos-personalization").join(&self.binding.bootstrap_id), unsafe { libc::geteuid() }, true)?;
        let record: Value = fs::json(&dir, "record.json", 64 * 1024)?;
        let digest = journal::digest(&serde_json::to_vec(&record["intent"])?);
        let target = &record["intent"]["target"];
        let b = &self.binding;
        if record["inputDigest"] != digest.as_str()
            || target["environmentId"] != b.environment_id.as_str()
            || target["generation"] != b.generation.as_str()
            || target["vmFingerprint"] != b.vm_fingerprint.as_str()
            || target["restoreSha256"] != b.restore_sha256.as_str()
        {
            bail!("Original account preparation changed; no key is created")
        }
        let plan: super::macos_personalization::AccountPlan = serde_json::from_value(record["intent"]["account"].clone())?;
        journal::validate_id(&plan.ssh_key_reference)?;
        Ok((plan, digest))
    }
    /// The SSH public key grant for the account the helper confirmed: recorded
    /// once, exclusively, then relayed. Bound to that confirmation, the exact
    /// answer, the account and the original parent. A retry re-presents the same
    /// grant; a different key or reference is refused for good. Only
    /// `grant_guest_key_using` calls this, with the VM's original produced key.
    fn relay_grant(&self, key_reference: &str, public_key: &str) -> Result<Value> {
        let (answer_bytes, answer) = self.account_answer_bytes()?;
        if answer["outcome"] != "confirmed" || answer["accountAuthenticated"] != true {
            bail!("The person's account choice was not acknowledged by the helper; no key is granted")
        }
        journal::validate_id(key_reference)?;
        super::macos_personalization::public_key(public_key)?;
        let confirmation = self.root.read("account-confirmation.json", 32 * 1024, true)?;
        let account = json!({"name": answer["account"]["name"], "uid": answer["account"]["uid"]});
        let grant = canonical(&json!({"version": 1, "bindingDigest": journal::digest(&self.raw),
            "ownerEpoch": self.binding.owner_epoch, "confirmationSha256": journal::digest(&confirmation),
            "answerSha256": journal::digest(&answer_bytes), "account": account, "keyReference": key_reference,
            "publicKey": public_key, "parentSession": self.binding.parent_session, "parentTab": self.binding.parent_tab,
            "parentConversation": self.binding.parent_conversation}))?;
        if !self.root.exists("key-grant.json")? {
            self.root.write_new("key-grant.json", &grant)?;
        }
        let recorded = self.root.read("key-grant.json", 32 * 1024, true)?;
        let retained: Value = serde_json::from_slice(&recorded)?;
        if retained["keyReference"] != key_reference || retained["publicKey"] != public_key || retained["account"] != account {
            bail!("A different key was already granted for this VM; it is never replaced or regenerated")
        }
        let handshake: Handshake = fs::json(&self.root, "owner-handshake.json", 32 * 1024)?;
        let receipt = self.observe_using(&handshake, "grantKey", &journal::new_id(), Some(&recorded))?;
        let relay: Value = serde_json::from_slice(&receipt.bytes)?;
        if relay != json!({"version": 1, "bindingDigest": journal::digest(&self.raw), "ownerEpoch": self.binding.owner_epoch,
            "grantSha256": journal::digest(&recorded), "keyReference": key_reference, "publicKey": public_key,
            "account": account, "relayed": true, "installed": false, "trustAccepted": false, "ready": false})
        {
            bail!("Owner key grant record changed or claimed an install")
        }
        Ok(relay)
    }
    /// The helper's install result for the recorded grant. Only its own
    /// `publicKeyInstalled` counts; unknown and refused never become success.
    fn key_result(&self) -> Result<Value> {
        Ok(self.key_result_bytes()?.1)
    }
    fn key_result_bytes(&self) -> Result<(Vec<u8>, Value)> {
        let recorded = self.root.read("key-grant.json", 32 * 1024, true)?;
        let retained: Value = serde_json::from_slice(&recorded)?;
        let receipt = self.observe("keyAnswer", &journal::new_id())?;
        let result: Value = serde_json::from_slice(&receipt.bytes)?;
        let stage = result["stage"].as_str().unwrap_or_default();
        if !["publicKeyInstalled", "outcomeUnknown", "refused"].contains(&stage)
            || result != json!({"version": 1, "bindingDigest": journal::digest(&self.raw), "ownerEpoch": self.binding.owner_epoch,
                "grantSha256": journal::digest(&recorded), "keyReference": retained["keyReference"], "stage": stage,
                "installed": stage == "publicKeyInstalled", "trustAccepted": false, "ready": false})
        {
            bail!("Owner key install result changed or claimed trust")
        }
        Ok((receipt.bytes, result))
    }
    /// Version 3: the guest's existing public host key, exactly as the owner
    /// journaled the helper's report after the helper's own `publicKeyInstalled`
    /// for this grant. Evidence for the person's review; never trust by itself.
    fn host_key_observation(&self) -> Result<(Vec<u8>, Value)> {
        let (result_bytes, result) = self.key_result_bytes()?;
        if result["stage"] != "publicKeyInstalled" {
            bail!("The host key is reported only after the helper installed TerminalX's key")
        }
        let grant = self.root.read("key-grant.json", 32 * 1024, true)?;
        let receipt = self.observe("hostKeyObservation", &journal::new_id())?;
        let value: Value = serde_json::from_slice(&receipt.bytes)?;
        let host_key = value["hostKey"].as_str().unwrap_or_default();
        if super::macos_personalization::public_key(host_key).is_err()
            || value != json!({"version": 1, "bindingDigest": journal::digest(&self.raw), "ownerEpoch": self.binding.owner_epoch,
                "grantSha256": journal::digest(&grant), "keyResultSha256": journal::digest(&result_bytes),
                "keyReference": result["keyReference"], "hostKey": host_key, "observed": true, "trustAccepted": false, "ready": false})
        {
            bail!("Owner host-key observation changed or claimed trust")
        }
        Ok((receipt.bytes, value))
    }
    /// Version 3: the owner's acknowledgement of the helper's final report, as
    /// journaled before it was sent. It must name this enrollment's challenge,
    /// the digest of the exact `{hostKey: …}` report behind `observation` and
    /// the digest of `observed` itself. Returns the acknowledgement's digest.
    fn retirement_acknowledgement(&self, bytes: &[u8], observed: &[u8], observation: &Value) -> Result<String> {
        let enrolled = self.enrollment()?;
        let report = canonical(&json!({"hostKey": {"keyReference": observation["keyReference"],
            "publicKey": observation["hostKey"]}}))?;
        let body = json!({"retire": {"challengeSha256": enrolled.challenge_sha256,
            "hostKeySha256": journal::digest(&report), "observationSha256": journal::digest(observed)}});
        let digest = journal::digest(&canonical(&body)?);
        let value: Value = serde_json::from_slice(bytes)?;
        if value != json!({"version": 1, "bindingDigest": journal::digest(&self.raw), "ownerEpoch": self.binding.owner_epoch,
            "challengeSha256": body["retire"]["challengeSha256"], "hostKeySha256": body["retire"]["hostKeySha256"],
            "observationSha256": body["retire"]["observationSha256"], "acknowledgementSha256": digest,
            "trustAccepted": false, "ready": false})
        {
            bail!("The owner's retirement acknowledgement is not for this session, report and observation")
        }
        Ok(digest)
    }
    /// Version 3: the helper's report of its retirement for exactly the
    /// acknowledgement with digest `acknowledgement`. Returns the stage it
    /// reported. It stays the helper's claim: the owner journals it unverified.
    fn retirement_report(&self, bytes: &[u8], acknowledgement: &str) -> Result<String> {
        let value: Value = serde_json::from_slice(bytes)?;
        let stage = value["stage"].as_str().unwrap_or_default();
        if !["retired", "refused", "outcomeUnknown"].contains(&stage)
            || value != json!({"version": 1, "bindingDigest": journal::digest(&self.raw), "ownerEpoch": self.binding.owner_epoch,
                "acknowledgementSha256": acknowledgement, "stage": stage, "helperReported": true, "verified": false,
                "trustAccepted": false, "ready": false})
        {
            bail!("The helper's retirement report is not for this acknowledgement or claims more than its own report")
        }
        Ok(stage.into())
    }
    /// Read-only: where retirement (design stage 9) stands after the owner
    /// observed the host key in `observed`. Reading records nothing. A record
    /// the owner cannot serve is still awaited; one that does not match this
    /// session is `invalid…` and never counts. A report is the helper's claim,
    /// so `verified` stays false, and none of this is cleanup evidence, trust
    /// or readiness.
    fn retirement_status(&self, observed: &[u8], observation: &Value) -> Value {
        let status = |mut value: Value| {
            value["verified"] = json!(false);
            value["trustAccepted"] = json!(false);
            value["ready"] = json!(false);
            value
        };
        let Ok(acknowledgement) = self.observe("retirementAcknowledgement", &journal::new_id()) else {
            return status(json!({"stage": "awaitingAcknowledgement"}));
        };
        let digest = match self.retirement_acknowledgement(&acknowledgement.bytes, observed, observation) {
            Ok(digest) => digest,
            Err(error) => return status(json!({"stage": "invalidAcknowledgement", "detail": format!("{error:#}")})),
        };
        let Ok(report) = self.observe("retirementReport", &journal::new_id()) else {
            return status(json!({"stage": "acknowledged", "acknowledgementSha256": digest}));
        };
        match self.retirement_report(&report.bytes, &digest) {
            Ok(stage) => status(json!({"stage": "helperReported", "acknowledgementSha256": digest,
                "reportedOutcome": stage, "helperReported": true})),
            Err(error) => status(json!({"stage": "invalidReport", "acknowledgementSha256": digest,
                "detail": format!("{error:#}")})),
        }
    }
    /// Read-only: where the host-key review stands. A recorded confirmation
    /// whose observation no longer matches is `changed` and is never re-pinned.
    /// For a pinned key, `firstConnection` is the separate, read-only status of
    /// the first strict SSH connection (see `macos_first_connection::status`),
    /// and only its verified evidence sets `sshVerified`. A pin alone never does.
    fn host_key_status(&self, data: &Path) -> Result<Value> {
        let observed = self.host_key_observation().ok();
        if !self.root.exists("host-key-confirmation.json")? {
            return Ok(match observed {
                Some((bytes, observation)) => json!({"stage": "awaitingReview", "observationSha256": journal::digest(&bytes),
                    "hostKey": observation["hostKey"], "fingerprint": super::macos_personalization::public_key(observation["hostKey"].as_str().unwrap_or_default())?,
                    "sshVerified": false, "ready": false}),
                None => json!({"stage": "awaitingHostKey", "sshVerified": false, "ready": false}),
            });
        }
        let retained: Value = serde_json::from_slice(&self.root.read("host-key-confirmation.json", 32 * 1024, true)?)?;
        let changed = observed.is_some_and(|(bytes, _)| retained["observationSha256"] != journal::digest(&bytes).as_str());
        if changed {
            return Ok(json!({"stage": "changed", "hostKey": retained["hostKey"], "fingerprint": retained["fingerprint"],
                "sshVerified": false, "ready": false}));
        }
        let first = super::macos_first_connection::status(data, &self.binding.bootstrap_id,
            retained["hostKey"].as_str().unwrap_or_default());
        Ok(json!({"stage": "confirmed", "hostKey": retained["hostKey"], "fingerprint": retained["fingerprint"],
            "sshVerified": first["sshVerified"] == true, "firstConnection": first, "ready": false}))
    }
    /// The person's confirmation of the exact fingerprint shown from the
    /// owner's observation, from the original parent. Recorded once; a different
    /// key or observation is refused for good and never re-pinned. Then the
    /// existing ledger records the acknowledged account and this host key, which
    /// the strict SSH plan pins. No SSH connection is made here.
    /// The inputs a person approves for pinning the host key in the owner's
    /// observation with digest `observation_sha256`.
    fn host_key_approval_inputs(&self, observation_sha256: &str, observation: &Value, fingerprint: &str, account: &Value) -> Value {
        let b = &self.binding;
        json!({"bootstrapId": b.bootstrap_id, "bindingDigest": journal::digest(&self.raw), "ownerEpoch": b.owner_epoch,
            "observationSha256": observation_sha256, "fingerprint": fingerprint, "keyReference": observation["keyReference"],
            "account": {"name": account["name"], "uid": account["uid"]}, "parentSession": b.parent_session,
            "parentTab": b.parent_tab, "parentConversation": b.parent_conversation})
    }
    fn confirm_host_key(&self, root: &Path, confirmation: &HostKeyConfirmation, approval: &Presented) -> Result<Value> {
        let (bytes, observation) = self.host_key_observation()?;
        let host_key = observation["hostKey"].as_str().unwrap_or_default();
        let fingerprint = super::macos_personalization::public_key(host_key)?;
        let b = &self.binding;
        if !confirmation.confirm
            || confirmation.observation_sha256 != journal::digest(&bytes)
            || confirmation.fingerprint != fingerprint
            || confirmation.parent_session != b.parent_session
            || confirmation.parent_tab != b.parent_tab
            || confirmation.parent_conversation != b.parent_conversation
        {
            bail!("Confirm the exact host key fingerprint shown, from the original parent conversation")
        }
        let (answer_bytes, answer) = self.account_answer_bytes()?;
        let a = &answer["account"];
        let (plan, _) = self.plan(root)?;
        if answer["outcome"] != "confirmed" || a["name"] != plan.short_name.as_str() || a["home"] != plan.home().as_str() {
            bail!("The confirmed account is not the account planned for this VM; its host key is not pinned")
        }
        let account = super::macos_account::Account {
            short_name: plan.short_name.clone(),
            uid: a["uid"].as_u64().and_then(|n| u32::try_from(n).ok()).context("Confirmed account uid missing")?,
            gid: a["gid"].as_u64().and_then(|n| u32::try_from(n).ok()).context("Confirmed account gid missing")?,
            home: plan.home(),
            home_device: a["homeDevice"].as_u64().context("Confirmed account home device missing")?,
            home_inode: a["homeInode"].as_u64().context("Confirmed account home inode missing")?,
        };
        let inputs = self.host_key_approval_inputs(&journal::digest(&bytes), &observation, &fingerprint, a);
        approval.consume(&self.root, PIN_HOST_KEY, &inputs, std::time::SystemTime::now())?;
        let record = canonical(&json!({"version": 1, "bindingDigest": journal::digest(&self.raw), "ownerEpoch": b.owner_epoch,
            "observationSha256": journal::digest(&bytes), "keyResultSha256": observation["keyResultSha256"],
            "grantSha256": observation["grantSha256"], "keyReference": observation["keyReference"],
            "account": {"name": a["name"], "uid": a["uid"]}, "hostKey": host_key, "fingerprint": fingerprint,
            "parentSession": b.parent_session, "parentTab": b.parent_tab, "parentConversation": b.parent_conversation,
            "confirmationId": journal::new_id()}))?;
        if !self.root.exists("host-key-confirmation.json")? {
            self.root.write_new("host-key-confirmation.json", &record)?;
        }
        let retained: Value = serde_json::from_slice(&self.root.read("host-key-confirmation.json", 32 * 1024, true)?)?;
        if retained["observationSha256"] != journal::digest(&bytes).as_str() || retained["hostKey"] != host_key {
            bail!("A different host key was already confirmed for this VM; it is never replaced")
        }
        let ledger = super::macos_personalization::retain_confirmed_trust(root, &b.bootstrap_id, account,
            &journal::digest(&answer_bytes), host_key, &journal::digest(&bytes))?;
        Ok(json!({"confirmation": retained, "ledgerStatus": ledger["status"], "hostKeyConfirmed": true,
            "sshVerified": false, "ready": false}))
    }
    fn guest_observation(&self) -> Result<Value> {
        if self.binding.version != 2 {
            bail!("Host-only plan required")
        }
        let receipt = self.observe("guestObservation", &journal::new_id())?;
        let value: Value = serde_json::from_slice(&receipt.bytes)?;
        let keys = [
            "accountAuthenticated",
            "bindingDigest",
            "challengeSha256",
            "claims",
            "helperAuthenticated",
            "ownerEpoch",
            "ready",
            "shareRoundTripObserved",
            "trustAccepted",
            "version",
            "vmRouteObserved",
        ];
        if value
            .as_object()
            .map(|v| v.keys().map(String::as_str).collect::<Vec<_>>())
            != Some(keys.to_vec())
            || value["version"] != 1
            || value["bindingDigest"] != journal::digest(&self.raw)
            || value["ownerEpoch"] != self.binding.owner_epoch
            || [
                "accountAuthenticated",
                "helperAuthenticated",
                "ready",
                "trustAccepted",
            ]
            .iter()
            .any(|k| value[k] != false)
            || value["vmRouteObserved"] != true
            || value["shareRoundTripObserved"] != true
            || value["claims"]["accountName"] != self.manifest["accountName"]
            || value["claims"]["accountHome"] != self.manifest["accountHome"]
            || value["claims"]["helperSha256"] != self.manifest["helperSha256"]
        {
            bail!("Original owner observation changed or incorrectly asserted account trust")
        }
        super::transport::validate_runtime_sha(
            value["challengeSha256"]
                .as_str()
                .context("Original challenge missing")?,
        )?;
        self.root
            .publish("retained-guest-observation.json", &receipt.bytes)?;
        // Owner authentication describes the source of these claims. It cannot
        // create the helper Channel or the post-acquisition account manifest.
        Ok(value)
    }
    fn admit(&self, action: &str) -> Result<Value> {
        if self.binding.version == 2 {
            bail!("VM-scoped observations cannot authenticate a helper/account; signed acquisition and launch evidence required")
        }
        if !["accountReceipt", "keyReceipt"].contains(&action) {
            bail!("Fixed helper receipt operation required")
        }
        let existed = self.root.exists(action)?;
        let dir = self.root.child(action, !existed)?;
        let _lock = dir.lock("operation.lock", !existed)?;
        let intent = if dir.exists("intent.json")? {
            fs::json::<Value>(&dir, "intent.json", 32 * 1024)?
        } else {
            if existed {
                bail!("Original admission history missing")
            }
            let v = json!({"bindingDigest":journal::digest(&self.raw),"action":action,"requestId":journal::new_id()});
            dir.write_new("intent.json", &serde_json::to_vec(&v)?)?;
            v
        };
        if intent["bindingDigest"] != journal::digest(&self.raw) || intent["action"] != action {
            bail!("Original admission intent changed")
        }
        let receipt = self.observe(
            action,
            intent["requestId"]
                .as_str()
                .context("Missing original receipt request")?,
        )?;
        if dir.exists("receipt.json")? && !dir.exists("authenticated-receipt.json")? {
            bail!("Original authenticated receipt history missing")
        }
        // Retain even a rejected authenticated guest payload. Later reads may
        // not silently substitute a different receipt for this original request.
        dir.publish("authenticated-receipt.json", &receipt.bytes)
            .context("Retain original authenticated guest payload")?;
        let account = if action == "keyReceipt" {
            Some(
                fs::json::<Value>(
                    &self.root.child("accountReceipt", false)?,
                    "receipt.json",
                    128 * 1024,
                )?["guestReceipt"]
                    .clone(),
            )
        } else {
            None
        };
        let key = if action == "keyReceipt" {
            Some(fs::json::<Value>(
                &self.root,
                "expected-key.json",
                32 * 1024,
            )?)
        } else {
            None
        };
        let validated = macos_bootstrap_helper::validate_owner_receipt(
            &receipt.bytes,
            &self.manifest,
            account.as_ref(),
            key.as_ref(),
        )?;
        let result = json!({"stage":"candidateReceiptAdmitted","action":action,"bindingDigest":journal::digest(&self.raw),"ownerEpoch":self.binding.owner_epoch,
            "receiptSha256":journal::digest(&receipt.bytes),"guestReceipt":validated,"ready":false,"trustAccepted":false});
        dir.publish("receipt.json", &serde_json::to_vec(&result)?)?;
        Ok(result)
    }
}
// Only the MAC-verified channel creates this type. No Deserialize/proof setter.
struct AuthenticatedReceipt {
    bytes: Vec<u8>,
}

#[path = "macos_owner_plan.rs"]
pub(super) mod plan;

#[path = "macos_owner_launch.rs"]
pub(super) mod launch;

#[cfg(test)]
#[path = "macos_owner_channel_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "macos_owner_key_tests.rs"]
mod key_tests;
