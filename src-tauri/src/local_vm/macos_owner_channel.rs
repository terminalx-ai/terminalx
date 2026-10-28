//! Candidate restricted-Lume client. Real bounded socket authentication and
//! receipt admission; no production constructor, launch/profile or trust promotion.
use super::macos_helper_fs as fs;
use super::{journal, macos_bootstrap_helper};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use fs::{Directory, Node};
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
}
fn canonical(value: &Value) -> Result<Vec<u8>> {
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
        if b.version != 1
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
        self.observe_using(&handshake, "observe", &journal::new_id())?;
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
        if !["observe", "accountReceipt", "keyReceipt"].contains(&action) {
            bail!("Unsupported owner operation")
        }
        journal::validate_id(request_id)?;
        let handshake: Handshake = fs::json(&self.root, "owner-handshake.json", 32 * 1024)?;
        self.observe_using(&handshake, action, request_id)
    }
    fn observe_using(
        &self,
        handshake: &Handshake,
        action: &str,
        request_id: &str,
    ) -> Result<AuthenticatedReceipt> {
        let mut stream = UnixStream::connect(self.socket(handshake)?)
            .context("Connect original private owner socket")?;
        configure(&stream, handshake.owner_pid).context("Verify original native socket peer")?;
        let mut nonce = [0; 32];
        rand_core::OsRng.fill_bytes(&mut nonce);
        let client_nonce = encode_hex(&nonce);
        let binding_digest = journal::digest(&self.raw);
        send(
            &mut stream,
            &json!({"action":action,"bindingDigest":binding_digest,"clientNonce":client_nonce,"requestId":request_id}),
        )?;
        let challenge: Challenge =
            serde_json::from_slice(&read(&mut stream).context("Read owner challenge")?)?;
        super::transport::validate_runtime_sha(&challenge.server_nonce)?;
        if challenge.epoch != self.binding.owner_epoch {
            bail!("Owner epoch changed")
        }
        let parts = [
            binding_digest.as_str(),
            self.binding.owner_epoch.as_str(),
            action,
            request_id,
            client_nonce.as_str(),
            challenge.server_nonce.as_str(),
        ];
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
    fn admit(&self, action: &str) -> Result<Value> {
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

#[path = "macos_owner_launch.rs"]
pub(super) mod launch;

#[cfg(test)]
#[path = "macos_owner_channel_tests.rs"]
mod tests;
