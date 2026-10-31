//! The first strict SSH connection (design "Final trust confirmation"). After
//! the person pinned the guest's host key and the helper installed this VM's
//! original key, one connection made exactly as the transport plan says
//! (`StrictHostKeyChecking=yes` against the single pinned `known_hosts` line,
//! the produced key as the only identity, no agent, config or forwarding)
//! runs a fixed, effect-free check in the guest. The check covers the same
//! account, its home, the one key line the helper installed for this bootstrap,
//! and the guest's own public host key, and it echoes a fresh nonce. Only that
//! exact reply records `first-connection.json`, and delivery requires it before
//! the first upload. Admission stays closed: the production entry refuses
//! before any process, key access or network effect. A recorded check is
//! evidence for delivery, never readiness.
use super::{
    authorized_keys_text,
    journal::{self, Environment},
    macos_delivery::shell_quote,
    macos_keys, macos_personalization,
    macos_transport::{self, Binding, Endpoint, Programs},
    process,
};
use anyhow::{bail, Context, Result};
use rand_core::RngCore;
use serde_json::{json, Value};
use std::{path::Path, time::Duration};

const RECEIPT: &str = "first-connection.json";
const EVIDENCE: &str = "strictPinnedHostKeyAccountHomeAndInstalledKey";
/// The reply is one short JSON object.
const REPLY_LIMIT: usize = 4096;
const BUDGET: Duration = Duration::from_secs(30);

/// The fixed guest check: base-system tools only and no effect. It reads the
/// nonce from stdin last, so a reply proves every check above it passed.
fn remote(binding: &Binding, public_key: &str, host_key: &str) -> String {
    let a = &binding.account;
    let home = shell_quote(&a.home);
    let ssh = shell_quote(&format!("{}/.ssh", a.home));
    let keys = shell_quote(&format!("{}/.ssh/authorized_keys", a.home));
    let line = shell_quote(&authorized_keys_text::line(public_key, &binding.bootstrap_id));
    let script = format!(
        "set -eu; umask 077; \
test \"$(/usr/bin/id -u)\" = {uid}; test \"$(/usr/bin/id -g)\" = {gid}; test \"$(/usr/bin/id -un)\" = {name}; \
test \"$(/usr/bin/dscl . -read /Users/{name} NFSHomeDirectory)\" = 'NFSHomeDirectory: {raw_home}'; \
test ! -L {home}; test -d {home}; test \"$(/usr/bin/stat -f %u {home})\" = {uid}; \
test \"$(/usr/bin/stat -f %d {home})\" = {device}; test \"$(/usr/bin/stat -f %i {home})\" = {inode}; \
for f in {ssh} {keys}; do test ! -L \"$f\"; test \"$(/usr/bin/stat -f %u \"$f\")\" = {uid}; \
test $(( 0$(/usr/bin/stat -f %Lp \"$f\") & 077 )) = 0; done; \
test -d {ssh}; test -f {keys}; test \"$(/usr/bin/stat -f %l {keys})\" = 1; \
test \"$(/usr/bin/grep -c -x -F -e {line} {keys})\" = 1; \
test \"$(/usr/bin/stat -f %u /etc/ssh/ssh_host_ed25519_key.pub)\" = 0; \
test \"$(/usr/bin/cut -d ' ' -f 1,2 /etc/ssh/ssh_host_ed25519_key.pub)\" = {host}; \
IFS= read -r nonce; case \"$nonce\" in ''|*[!0-9a-f]*) exit 1;; esac; test ${{#nonce}} = 64; \
printf '{{\"ok\":true,\"result\":{{\"bootstrapId\":\"{id}\",\"nonce\":\"%s\",\"stage\":\"firstConnectionVerified\",\"uid\":{uid}}}}}' \"$nonce\"",
        uid = a.uid,
        gid = a.gid,
        name = a.short_name,
        raw_home = a.home,
        device = a.home_device,
        inode = a.home_inode,
        host = shell_quote(host_key),
        id = binding.bootstrap_id,
    );
    format!("/bin/sh -c {}", shell_quote(&script))
}

fn directory(root: &Path, binding: &Binding) -> std::path::PathBuf {
    root.join("macos-personalization").join(&binding.bootstrap_id)
}

/// The receipt's fields that must still describe this binding, its trust and
/// its retained `known_hosts` pin.
fn expected(root: &Path, binding: &Binding) -> Result<Value> {
    let known = macos_keys::private_read(&directory(root, binding).join("known_hosts"), 4096)?;
    Ok(json!({"version": 1, "bootstrapId": binding.bootstrap_id, "target": binding.target,
        "account": binding.account, "trustDigest": binding.trust_digest, "keyReference": binding.key_reference,
        "knownHostsSha256": journal::digest(&known), "evidence": EVIDENCE, "ready": false}))
}

/// The recorded first connection, or `None` before there is one. A receipt
/// that no longer matches this binding, trust or pin stays fenced and is never
/// replaced.
fn recorded(root: &Path, binding: &Binding) -> Result<Option<Value>> {
    let path = directory(root, binding).join(RECEIPT);
    if !path.try_exists()? {
        return Ok(None);
    }
    let receipt: Value = serde_json::from_slice(&macos_keys::private_read(&path, 16 * 1024)?)?;
    let mut fixed = receipt.clone();
    let mut free = Vec::new();
    for field in ["nonce", "publicKeySha256", "remoteSha256"] {
        free.push(fixed.as_object_mut().and_then(|o| o.remove(field)).unwrap_or(Value::Null));
    }
    let hex64 = |v: &Value| v.as_str().is_some_and(|s| super::transport::validate_runtime_sha(s).is_ok());
    if fixed != expected(root, binding)? || !free.iter().all(hex64) {
        bail!("The recorded first SSH connection no longer matches this VM's binding, trust or pin; it is never replaced")
    }
    Ok(Some(receipt))
}

/// Delivery's precondition: the first strict connection was recorded for
/// exactly this binding.
pub(super) fn verified(root: &Path, binding: &Binding) -> Result<Value> {
    recorded(root, binding)?.context("The first strict SSH connection to this VM has not been verified")
}

/// Runs the check once over `endpoint` with `programs`, or returns the
/// recorded receipt while it still matches. A failed, timed-out, oversized or
/// different reply records nothing; the check has no effect, so it may run
/// again. Fixtures supply the programs; production enters through `verify`.
pub(super) fn verify_using(
    root: &Path,
    env: &Environment,
    endpoint: &Endpoint,
    programs: &Programs<'_>,
    budget: Duration,
) -> Result<Value> {
    let pinned = macos_transport::binding(env)?;
    pinned.check_retained(root)?;
    if let Some(receipt) = recorded(root, pinned)? {
        return Ok(receipt);
    }
    let trust = macos_personalization::retained(root, &pinned.bootstrap_id, &pinned.target)?.trust;
    let mut bytes = [0u8; 32];
    rand_core::OsRng.fill_bytes(&mut bytes);
    let nonce: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let mut sent = None;
    let (mut command, _keys) = macos_transport::command_for(
        root,
        env,
        endpoint,
        programs,
        |public| {
            let script = remote(pinned, public, &trust.host_key);
            sent = Some((journal::digest(public.as_bytes()), journal::digest(script.as_bytes())));
            Ok(script)
        },
        budget,
    )?;
    let (public_sha256, remote_sha256) = sent.context("First connection command was not built")?;
    let output = process::run(&mut command, format!("{nonce}\n").as_bytes(), budget)?;
    if output.len() > REPLY_LIMIT {
        bail!("The first SSH connection's reply exceeds its bound; nothing was recorded")
    }
    let reply = super::transport::decode(&output)?;
    if reply != json!({"stage": "firstConnectionVerified", "bootstrapId": pinned.bootstrap_id,
        "uid": pinned.account.uid, "nonce": nonce})
    {
        bail!("The guest's first-connection reply is not the exact check for this account and request; nothing was recorded")
    }
    pinned.check_retained(root)?;
    let mut receipt = expected(root, pinned)?;
    receipt["nonce"] = json!(nonce);
    receipt["publicKeySha256"] = json!(public_sha256);
    receipt["remoteSha256"] = json!(remote_sha256);
    let path = directory(root, pinned).join(RECEIPT);
    if let Err(error) = macos_keys::write_new(&path, &serde_json::to_vec(&receipt)?) {
        // A concurrent check recorded first; only an exact receipt counts.
        return recorded(root, pinned)?.context(error);
    }
    Ok(receipt)
}

/// What the read-only status found for a bootstrap's first connection.
enum Evidence {
    /// No current environment carries this bootstrap's transport binding.
    NoTransport,
    /// The binding is current, and nothing has been recorded for it.
    NotRecorded,
    /// The canonical receipt for exactly this binding, pin and key.
    Recorded,
}

/// The receipt for the one current environment bound to `bootstrap_id`,
/// checked exactly as delivery checks it, plus two links status needs: the
/// transport's trusted host key must be the one the person pinned, and the
/// receipt's key must be the reference's retained public key.
fn evidence(root: &Path, bootstrap_id: &str, pinned: &str) -> Result<Evidence> {
    let state = journal::Journal::snapshot(root)?;
    let mut bound = state.environments.values().filter(|env| {
        env.deleted_at.is_none()
            && matches!(&env.transport, super::transport::Transport::MacosPersonalized { binding }
                if binding.bootstrap_id == bootstrap_id)
    });
    let Some(env) = bound.next() else {
        return Ok(Evidence::NoTransport);
    };
    if bound.next().is_some() {
        bail!("More than one environment claims this bootstrap's transport")
    }
    let binding = macos_transport::binding(env)?;
    binding.check_retained(root)?;
    let trust = macos_personalization::retained(root, bootstrap_id, &binding.target)?.trust;
    if trust.host_key != pinned {
        bail!("The transport's trusted host key is not the one the person pinned")
    }
    let Some(receipt) = recorded(root, binding)? else {
        return Ok(Evidence::NotRecorded);
    };
    let public = macos_keys::retained_public(root, binding)?;
    if receipt["publicKeySha256"] != journal::digest(public.as_bytes()).as_str() {
        bail!("The recorded first connection used another key")
    }
    Ok(Evidence::Recorded)
}

/// Read-only status of the first strict connection to `bootstrap_id`, whose
/// host key the person pinned as `pinned`. While transport admission is closed
/// it says only that, before reading anything. Otherwise it reports the
/// canonical evidence. It never runs SSH, opens a private key, writes,
/// fences or repairs anything, and never claims readiness.
pub(super) fn status(root: &Path, bootstrap_id: &str, pinned: &str) -> Value {
    status_using(root, bootstrap_id, pinned, macos_transport::require_available)
}

fn status_using(root: &Path, bootstrap_id: &str, pinned: &str, admission: impl Fn() -> Result<()>) -> Value {
    let (stage, verified, detail) = if admission().is_err() {
        ("admissionClosed", false, None)
    } else {
        match evidence(root, bootstrap_id, pinned) {
            Ok(Evidence::NoTransport) => ("awaitingTransport", false, None),
            Ok(Evidence::NotRecorded) => ("notVerified", false, None),
            Ok(Evidence::Recorded) => ("verified", true, None),
            Err(error) => ("invalid", false, Some(format!("{error:#}"))),
        }
    };
    let mut value = json!({"stage": stage, "sshVerified": verified, "ready": false});
    if let Some(detail) = detail {
        value["detail"] = json!(detail);
    }
    value
}

/// Production entry. Admission refuses first, before any process, key access
/// or network effect.
pub(super) fn verify(env: &Environment) -> Result<Value> {
    macos_transport::binding(env)?;
    macos_transport::require_available()?;
    let root = super::host::root()?;
    let endpoint = super::macos_endpoint::observe(&root, env)?;
    verify_using(
        &root,
        env,
        &endpoint,
        &Programs {
            ssh: Path::new("/usr/bin/ssh"),
            keygen: Path::new("/usr/bin/ssh-keygen"),
        },
        BUDGET,
    )
}

#[cfg(test)]
#[path = "macos_first_connection_tests.rs"]
pub(in crate::local_vm) mod tests;
