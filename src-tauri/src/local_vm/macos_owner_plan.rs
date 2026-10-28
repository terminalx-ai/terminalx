//! Host expectations are intent, never evidence of a guest account or mount.
//! Version two deliberately cannot be admitted as a helper execution manifest.
use super::*;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HostIntent {
    pub parent_session: String,
    pub parent_tab: String,
    pub parent_conversation: String,
    pub helper_sha256: String,
    pub runtime_sha256: String,
}
impl HostIntent {
    pub fn validate(&self) -> Result<()> {
        journal::validate_id(&self.parent_session)?;
        journal::validate_id(&self.parent_tab)?;
        for sha in [&self.helper_sha256, &self.runtime_sha256] {
            super::super::transport::validate_runtime_sha(sha)?;
        }
        if self.parent_conversation.is_empty()
            || self.parent_conversation.len() > 256
            || !self
                .parent_conversation
                .bytes()
                .all(|c| (32..127).contains(&c))
        {
            bail!("Original parent context missing")
        }
        Ok(())
    }
}

// Internal writer, not an RPC or a proof constructor. Production still needs
// the authenticated parent/human-approved intent path and trusted helper catalog.
// No guest facts, password/key bytes or owner capability can enter this record.
pub(super) fn retain_host_intent(dir: &Directory, intent: &HostIntent) -> Result<()> {
    intent.validate()?;
    dir.publish("owner-host-intent.json", &canonical(&json!(intent))?)
}

pub(super) fn create(
    key: &str,
    target: &Value,
    account: &super::super::macos_personalization::AccountPlan,
    account_digest: &str,
    context: &HostIntent,
) -> Result<Value> {
    context.validate()?;
    let target: super::super::macos_personalization::Target =
        serde_json::from_value(target.clone())?;
    target.validate()?;
    journal::validate_id(key)?;
    super::super::macos_account::validate_name(&account.short_name)?;
    super::super::transport::validate_runtime_sha(account_digest)?;
    // One original set, persisted before launch. Reopen never calls this writer.
    let mut nonce = [0; 32];
    rand_core::OsRng.fill_bytes(&mut nonce);
    Ok(json!({"version":2,"accountName":account.short_name,
        "accountHome":format!("/Users/{}",account.short_name),"macosMajor":26,
        "helperSha256":context.helper_sha256,"runtimeSha256":context.runtime_sha256,
        "accountIntentDigest":account_digest,
        "binding":{"bootstrapId":key,"target":target,"ownerEpoch":journal::new_id(),
            "nonce":encode_hex(&nonce),"parentSession":context.parent_session,
            "parentTab":context.parent_tab,"parentConversation":context.parent_conversation,
            "input":{"id":journal::new_id(),"readOnly":true},
            "output":{"id":journal::new_id(),"readOnly":false}}}))
}

pub(in crate::local_vm) fn validate(value: &Value) -> Result<()> {
    // Exact typed shape excludes caller-supplied mounted/UID/OS-build/proof data.
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Plan {
        version: u32,
        account_name: String,
        account_home: String,
        macos_major: u32,
        helper_sha256: String,
        runtime_sha256: String,
        account_intent_digest: String,
        binding: PlanBinding,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Share {
        id: String,
        host: Node,
        read_only: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PlanBinding {
        bootstrap_id: String,
        target: super::super::macos_personalization::Target,
        owner_epoch: String,
        nonce: String,
        parent_session: String,
        parent_tab: String,
        parent_conversation: String,
        input: Share,
        output: Share,
    }
    let p: Plan = serde_json::from_value(value.clone())?;
    super::super::macos_account::validate_name(&p.account_name)?;
    p.binding.target.validate()?;
    HostIntent {
        parent_session: p.binding.parent_session,
        parent_tab: p.binding.parent_tab,
        parent_conversation: p.binding.parent_conversation,
        helper_sha256: p.helper_sha256,
        runtime_sha256: p.runtime_sha256,
    }
    .validate()?;
    for id in [
        &p.binding.bootstrap_id,
        &p.binding.owner_epoch,
        &p.binding.input.id,
        &p.binding.output.id,
    ] {
        journal::validate_id(id)?;
    }
    for sha in [&p.binding.nonce, &p.account_intent_digest] {
        super::super::transport::validate_runtime_sha(sha)?;
    }
    if p.version != 2
        || p.macos_major != 26
        || p.account_home != format!("/Users/{}", p.account_name)
        || !p.binding.input.read_only
        || p.binding.output.read_only
        || p.binding.input.id == p.binding.output.id
        || p.binding.input.host == p.binding.output.host
        || p.binding.input.host.inode == 0
        || p.binding.output.host.inode == 0
    {
        bail!("Invalid host-only bootstrap plan")
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_plan_writer_has_no_guest_observations_and_never_replaces_intent() {
        let temp = tempfile::tempdir_in("/private/tmp").unwrap();
        let path = temp.path().canonicalize().unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let dir = Directory::open(&path, unsafe { libc::geteuid() }, true).unwrap();
        let mut context = HostIntent {
            parent_session: journal::new_id(),
            parent_tab: journal::new_id(),
            parent_conversation: "original".into(),
            helper_sha256: "a".repeat(64),
            runtime_sha256: "b".repeat(64),
        };
        retain_host_intent(&dir, &context).unwrap();
        retain_host_intent(&dir, &context).unwrap();
        let original = dir.read("owner-host-intent.json", 8192, true).unwrap();
        context.parent_tab = journal::new_id();
        assert!(retain_host_intent(&dir, &context).is_err());
        assert_eq!(
            dir.read("owner-host-intent.json", 8192, true).unwrap(),
            original
        );
        let account = super::super::super::macos_personalization::AccountPlan {
            short_name: "personal".into(),
            password_reference: journal::new_id(),
            ssh_key_reference: journal::new_id(),
        };
        let target = json!({"environmentId":journal::new_id(),"generation":journal::new_id(),"vmFingerprint":"a".repeat(64),"restoreSha256":"b".repeat(64),"macosMajor":26});
        let mut plan = create(
            &journal::new_id(),
            &target,
            &account,
            &"c".repeat(64),
            &context,
        )
        .unwrap();
        assert!(plan.get("osBuild").is_none());
        assert!(plan["binding"]["input"].get("mounted").is_none());
        plan["binding"]["input"]["host"] = json!({"device":1,"inode":2});
        plan["binding"]["output"]["host"] = json!({"device":1,"inode":3});
        validate(&plan).unwrap();
        for key in ["mounted", "proof", "uid"] {
            let mut forged = plan.clone();
            forged["binding"]["input"][key] = json!(true);
            assert!(validate(&forged).is_err());
        }
        assert!(
            super::super::super::macos_bootstrap_helper::validate_manifest_content(&plan).is_err()
        );
    }
}
