//! Person-only Local VM actions (docs/LOCAL-VM-HELPER-DELIVERY.md, "Person
//! approval for person-only actions"). The runtime control token is shared
//! with app-launched agent tabs, so nothing a caller sends — a `confirm`
//! boolean, parent IDs, the token itself — shows that a person agreed. A
//! person-only action needs a one-time approval whose proof an `Approver`
//! verifies, bound to the exact action and to inputs the host computes itself
//! from current evidence. This build has no approver: every person-only action
//! fails closed before any effect, whatever the caller sends.
use super::{journal, macos_helper_fs::Directory, macos_owner_channel::canonical};
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The longest an approval may be valid for, on every use.
pub(super) const LIFETIME: Duration = Duration::from_secs(120);

pub(super) const UNAVAILABLE: &str = "TerminalX cannot yet verify that a person approved this action, so it was refused. Nothing was chosen, granted or pinned.";

/// Verifies an approval proof over the exact document bytes. Only a primitive
/// that needs a person's presence and that agents cannot use may implement it.
pub(super) trait Approver {
    fn verify(&self, document: &[u8], proof: &str) -> Result<()>;
}

/// This build: no human-presence primitive exists, so nothing is approved.
pub(super) struct Unavailable;
impl Approver for Unavailable {
    fn verify(&self, _: &[u8], _: &str) -> Result<()> {
        bail!("{UNAVAILABLE}")
    }
}

/// What status reports so the UI disables person-only actions with the reason.
pub(super) fn availability() -> Value {
    json!({"available": false, "reason": UNAVAILABLE})
}

/// An approval whose proof verified. It authorizes nothing until `consume`
/// checks it against the inputs the host computed for the action.
pub(super) struct Presented {
    document: Value,
    bytes: Vec<u8>,
}

/// The approval sent with a request: `{document: <base64 canonical JSON>,
/// proof}`. The proof is verified before the document is trusted at all.
pub(super) fn presented(approver: &dyn Approver, approval: &Value) -> Result<Presented> {
    let encoded = approval["document"].as_str().context(UNAVAILABLE)?;
    let proof = approval["proof"].as_str().context(UNAVAILABLE)?;
    let bytes = STANDARD.decode(encoded).context("Approval document is not base64")?;
    if bytes.len() > 4096 {
        bail!("Approval document exceeds its bound")
    }
    approver.verify(&bytes, proof)?;
    let document: Value = serde_json::from_slice(&bytes)?;
    let mut keys: Vec<&str> = document.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default();
    keys.sort_unstable();
    if canonical(&document)? != bytes
        || keys
            != ["action", "approvalId", "bootstrapId", "expiresAt", "inputsSha256", "issuedAt", "parentConversation",
                "parentSession", "parentTab", "version"]
        || document["version"] != 1
    {
        bail!("Approval document is not the canonical approval form")
    }
    journal::validate_id(document["approvalId"].as_str().unwrap_or_default())?;
    Ok(Presented { document, bytes })
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn record_name(approval_id: &str) -> String {
    format!("approval-{approval_id}.json")
}

impl Presented {
    /// One use, for exactly `action` and the host-computed `inputs`, recorded
    /// in the bootstrap journal before any effect. Retrying the identical
    /// approval within its lifetime proceeds (the actions are idempotent);
    /// another action or other inputs under a used id, a cancelled approval,
    /// or an expired one is refused.
    pub(super) fn consume(&self, journal_dir: &Directory, action: &str, inputs: &Value, now: SystemTime) -> Result<()> {
        let d = &self.document;
        let (issued, expires, now) = (d["issuedAt"].as_u64(), d["expiresAt"].as_u64(), millis(now));
        if d["action"] != action
            || d["bootstrapId"] != inputs["bootstrapId"]
            || ["parentSession", "parentTab", "parentConversation"].iter().any(|k| d[*k] != inputs[*k] || !d[*k].is_string())
            || d["inputsSha256"] != journal::digest(&canonical(inputs)?).as_str()
        {
            bail!("The approval is for another action, VM, account, key, evidence or parent")
        }
        match (issued, expires) {
            (Some(issued), Some(expires))
                if issued <= now && now < expires && expires - issued <= LIFETIME.as_millis() as u64 => {}
            _ => bail!("The approval expired or is not yet valid; a person must approve again"),
        }
        let id = d["approvalId"].as_str().unwrap_or_default();
        let record = canonical(&json!({"version": 1, "approvalId": id, "state": "consumed", "action": action,
            "documentSha256": journal::digest(&self.bytes), "inputsSha256": d["inputsSha256"]}))?;
        if !journal_dir.exists(&record_name(id))? {
            // A concurrent use of the same approval loses this race and is
            // judged by the record that won.
            let _ = journal_dir.write_new(&record_name(id), &record);
        }
        let retained: Value = serde_json::from_slice(&journal_dir.read(&record_name(id), 4096, true)?)?;
        if retained["state"] == "cancelled" {
            bail!("The approval was cancelled before it was used")
        }
        if retained["documentSha256"] != journal::digest(&self.bytes).as_str() || retained["action"] != action {
            bail!("The approval was already used for something else; it is never replayed")
        }
        Ok(())
    }
}

/// Makes an unused approval unusable. A used one stays used.
pub(super) fn cancel(journal_dir: &Directory, approval_id: &str) -> Result<()> {
    journal::validate_id(approval_id)?;
    let record = canonical(&json!({"version": 1, "approvalId": approval_id, "state": "cancelled"}))?;
    if !journal_dir.exists(&record_name(approval_id))? {
        let _ = journal_dir.write_new(&record_name(approval_id), &record);
    }
    let retained: Value = serde_json::from_slice(&journal_dir.read(&record_name(approval_id), 4096, true)?)?;
    if retained["state"] != "cancelled" {
        bail!("The approval was already used; it cannot be cancelled")
    }
    Ok(())
}

/// Test-only approver: an HMAC key standing in for the human-presence
/// primitive, so the contract can be exercised. Never compiled into a build.
#[cfg(test)]
pub(super) mod fixture {
    use super::*;
    use hmac::{Hmac, Mac};

    pub(in crate::local_vm) struct TestApprover(pub [u8; 32]);
    impl Approver for TestApprover {
        fn verify(&self, document: &[u8], proof: &str) -> Result<()> {
            let mut mac = Hmac::<sha2::Sha256>::new_from_slice(&self.0)?;
            mac.update(document);
            let expected: String = mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect();
            if expected != proof {
                bail!("Approval proof does not verify")
            }
            Ok(())
        }
    }

    /// An approval signed with `key` for `action` and `inputs`, valid from
    /// `issued` for `lifetime`.
    pub(in crate::local_vm) fn approve(key: [u8; 32], action: &str, inputs: &Value, issued: SystemTime, lifetime: Duration) -> Value {
        let document = canonical(&json!({"version": 1, "approvalId": journal::new_id(), "action": action,
            "bootstrapId": inputs["bootstrapId"], "inputsSha256": journal::digest(&canonical(inputs).unwrap()),
            "parentSession": inputs["parentSession"], "parentTab": inputs["parentTab"],
            "parentConversation": inputs["parentConversation"], "issuedAt": millis(issued),
            "expiresAt": millis(issued + lifetime)}))
        .unwrap();
        let mut mac = Hmac::<sha2::Sha256>::new_from_slice(&key).unwrap();
        mac.update(&document);
        let proof: String = mac.finalize().into_bytes().iter().map(|b| format!("{b:02x}")).collect();
        json!({"document": STANDARD.encode(document), "proof": proof})
    }
}

#[cfg(test)]
mod tests {
    use super::{fixture::*, *};
    use std::os::unix::fs::PermissionsExt;

    const KEY: [u8; 32] = [0x5a; 32];
    fn inputs(account: &str) -> Value {
        json!({"bootstrapId": "boot", "bindingDigest": "a".repeat(64), "ownerEpoch": "epoch", "account": account,
            "parentSession": "session", "parentTab": "tab", "parentConversation": "original"})
    }
    fn journal_dir() -> (tempfile::TempDir, Directory) {
        let temp = tempfile::Builder::new().prefix("txa").tempdir_in("/private/tmp").unwrap();
        let path = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        // SAFETY: geteuid has no preconditions.
        let dir = Directory::open(&path, unsafe { libc::geteuid() }, true).unwrap();
        (temp, dir)
    }
    fn records(temp: &tempfile::TempDir) -> usize {
        std::fs::read_dir(temp.path()).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("approval-")).count()
    }
    fn use_approval(dir: &Directory, approval: &Value, action: &str, inputs: &Value, now: SystemTime) -> Result<()> {
        presented(&TestApprover(KEY), approval)?.consume(dir, action, inputs, now)
    }

    #[test]
    fn this_build_refuses_every_approval_whatever_the_caller_sends() {
        let now = SystemTime::now();
        for approval in [Value::Null, json!({"confirm": true}), approve(KEY, "a", &inputs("personal"), now, LIFETIME),
            json!({"document": "e30=", "proof": "00"})]
        {
            let error = presented(&Unavailable, &approval).err().map(|e| format!("{e:#}")).unwrap_or_default();
            assert!(error.contains("cannot yet verify that a person approved"), "{error}");
        }
        assert_eq!(availability()["available"], false);
    }

    #[test]
    fn a_forged_malformed_or_non_canonical_approval_is_refused_before_use() {
        let now = SystemTime::now();
        assert!(presented(&TestApprover([0x11; 32]), &approve(KEY, "a", &inputs("personal"), now, LIFETIME)).is_err(), "another key");
        let mut tampered = approve(KEY, "a", &inputs("personal"), now, LIFETIME);
        let mut document: Value = serde_json::from_slice(&STANDARD.decode(tampered["document"].as_str().unwrap()).unwrap()).unwrap();
        document["action"] = json!("b");
        tampered["document"] = json!(STANDARD.encode(canonical(&document).unwrap()));
        assert!(presented(&TestApprover(KEY), &tampered).is_err(), "changed after signing");
        let spaced = json!({"document": STANDARD.encode(b"{ \"version\": 1 }"), "proof": "00"});
        assert!(presented(&TestApprover(KEY), &spaced).is_err());
    }

    #[test]
    fn an_approval_binds_one_action_and_the_hosts_own_inputs_and_parent() {
        let (temp, dir) = journal_dir();
        let now = SystemTime::now();
        let approval = approve(KEY, "confirm", &inputs("personal"), now, LIFETIME);
        let mut cross_parent = inputs("personal");
        cross_parent["parentTab"] = json!("another-tab");
        for (action, inputs) in [("grant", inputs("personal")), ("confirm", inputs("other")), ("confirm", cross_parent)] {
            assert!(use_approval(&dir, &approval, action, &inputs, now).is_err(), "{action} {inputs}");
        }
        assert_eq!(records(&temp), 0, "a mismatch records nothing");
        use_approval(&dir, &approval, "confirm", &inputs("personal"), now).unwrap();
    }

    #[test]
    fn one_use_only_a_lost_reply_retry_proceeds_and_replay_cancel_or_expiry_refuse() {
        let (_temp, dir) = journal_dir();
        let now = SystemTime::now();
        let approval = approve(KEY, "confirm", &inputs("personal"), now, LIFETIME);
        use_approval(&dir, &approval, "confirm", &inputs("personal"), now).unwrap();
        use_approval(&dir, &approval, "confirm", &inputs("personal"), now + Duration::from_secs(5)).unwrap();
        assert!(use_approval(&dir, &approval, "confirm", &inputs("personal"), now + LIFETIME).is_err(), "expired retry");
        let late = approve(KEY, "confirm", &inputs("personal"), now - LIFETIME - Duration::from_secs(1), LIFETIME);
        assert!(use_approval(&dir, &late, "confirm", &inputs("personal"), now).is_err());
        let early = approve(KEY, "confirm", &inputs("personal"), now + Duration::from_secs(60), LIFETIME);
        assert!(use_approval(&dir, &early, "confirm", &inputs("personal"), now).is_err(), "not yet valid");
        let long = approve(KEY, "confirm", &inputs("personal"), now, LIFETIME * 2);
        assert!(use_approval(&dir, &long, "confirm", &inputs("personal"), now).is_err(), "too long a lifetime");
        let cancelled = approve(KEY, "confirm", &inputs("personal"), now, LIFETIME);
        let id = serde_json::from_slice::<Value>(&STANDARD.decode(cancelled["document"].as_str().unwrap()).unwrap()).unwrap()["approvalId"]
            .as_str().unwrap().to_string();
        cancel(&dir, &id).unwrap();
        assert!(use_approval(&dir, &cancelled, "confirm", &inputs("personal"), now).is_err(), "cancelled");
        let used = serde_json::from_slice::<Value>(&STANDARD.decode(approval["document"].as_str().unwrap()).unwrap()).unwrap()["approvalId"]
            .as_str().unwrap().to_string();
        assert!(cancel(&dir, &used).is_err(), "a used approval stays used");
        // A second approval for the same inputs is a replacement, not a replay.
        use_approval(&dir, &approve(KEY, "confirm", &inputs("personal"), now, LIFETIME), "confirm", &inputs("personal"), now).unwrap();
    }

    #[test]
    fn concurrent_uses_of_one_approval_are_judged_by_one_record() {
        let (temp, dir) = journal_dir();
        let now = SystemTime::now();
        let approval = approve(KEY, "confirm", &inputs("personal"), now, LIFETIME);
        let results: Vec<bool> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..6)
                .map(|_| scope.spawn(|| use_approval(&dir, &approval, "confirm", &inputs("personal"), now).is_ok()))
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert!(results.iter().all(|ok| *ok), "identical uses of one approval are one consent");
        assert_eq!(records(&temp), 1);
    }
}
