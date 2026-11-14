//! Guided setup for an already bound Linux task runtime. Installing a native
//! Linux artifact is a separate profile gate, never a macOS binary fallback.
use super::{
    journal::{Environment, Journal},
    transport::Transport,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

pub(super) fn initial(env: &Environment, harness: &str, key: &str) -> Result<Value> {
    if harness != "codex" {
        bail!("Linux task setup currently supports the guest-owned Codex account only");
    }
    Ok(
        json!({"protocol":1,"environmentId":env.id,"generation":env.generation,
        "computer":env.transport.target(&env.id,&env.generation),"taskMode":"shellFiles",
        "harness":harness,"idempotencyKey":key,"status":"needsAttention","lastCheckedAt":null,
        "detail":"Check this exact Linux runtime, then connect Codex inside its dedicated guest account. Desktop attachment remains a separate route.",
        "steps":[
            {"id":"runtime","label":"Verify the bound Linux runtime profile","state":"pending"},
            {"id":"provider","label":"Connect the guest-owned Codex account","state":"pending"},
            {"id":"admission","label":"Check exclusive task ownership","state":"pending"}]}),
    )
}

fn matches_runtime(env: &Environment, read: &Value) -> bool {
    let Transport::LinuxContainer { runtime_sha256, .. } = &env.transport else {
        return false;
    };
    read["runtime"]["state"] == "ready"
        && read["runtime"]["executableSha256"].as_str() == Some(runtime_sha256)
}

pub(super) fn record(journal: &Journal, target: &Environment, read: &Value) -> Result<()> {
    super::setup::check_binding(target, "codex", read)?;
    journal.transaction(|state| {
        let env = state.environments.get_mut(&target.id)
            .filter(|env| env.generation == target.generation && env.transport == target.transport && env.deleted_at.is_none())
            .context("Linux setup binding changed")?;
        let Some(report) = env.setup.as_mut() else { return Ok(()); };
        if report["taskMode"] != "shellFiles" || report["computer"] != serde_json::to_value(target.transport.target(&target.id,&target.generation))? {
            bail!("Linux setup history differs from the selected container");
        }
        report["readiness"] = read.clone();
        report["lastCheckedAt"] = json!(super::journal::now());
        for step in report["steps"].as_array_mut().context("Damaged Linux setup steps")? {
            let (complete, detail, action) = match step["id"].as_str() {
                Some("runtime") => (matches_runtime(target, read), json!("The serving Linux artifact must match the enrolled profile digest"), Value::Null),
                Some("provider") => (read["provider"]["state"] == "authenticated", read["provider"]["reasonCode"].clone(), read["provider"]["actionCode"].clone()),
                Some("admission") => (read["actionAdmission"]["state"] == "ready" && read["manualControl"] == false
                    && read["activeTaskTargets"].as_array().is_some_and(Vec::is_empty), read["actionAdmission"]["reasonCode"].clone(), Value::Null),
                _ => bail!("Unknown Linux setup step"),
            };
            step["state"] = json!(if complete { "complete" } else { "waiting" });
            step["detail"] = detail;
            step["actionCode"] = action;
        }
        // Inspection never clears an unknown delivery or starts a new login.
        if !matches!(report["status"].as_str(), Some("outcomeUnknown" | "failed")) {
            report["status"] = json!("ready");
            if !ready(target, report) { report["status"] = json!("needsAttention"); }
        }
        report["detail"] = json!(if report["status"] == "ready" {
            "Linux shell/files setup checks passed. Each task rechecks its exact target and account. Desktop attachment and live acceptance are separate."
        } else { "Follow the guest account and ownership steps below. No host account is copied and no sign-in or installation runs during inspection." });
        Ok(())
    })
}

pub(super) fn ready(env: &Environment, report: &Value) -> bool {
    let read = &report["readiness"];
    report["protocol"] == 1
        && report["taskMode"] == "shellFiles"
        && report["status"] == "ready"
        && report["computer"] == json!(env.transport.target(&env.id, &env.generation))
        && report["environmentId"] == env.id
        && report["generation"] == env.generation
        && report["harness"] == "codex"
        && super::setup::check_binding(env, "codex", read).is_ok()
        && matches_runtime(env, read)
        && read["provider"]["state"] == "authenticated"
        && (read["provider"]["evidence"] != "recentExplicitLocalAccountReceipt"
            || read["provider"]["validUntil"]
                .as_str()
                .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
                .is_some_and(|at| at > chrono::Utc::now()))
        && read["manualControl"] == false
        && read["activeTaskTargets"]
            .as_array()
            .is_some_and(Vec::is_empty)
        && read["actionAdmission"]["state"] == "ready"
        && (report["action"].is_null()
            || matches!(
                report["action"]["status"].as_str(),
                Some("complete" | "failed")
            ))
        && report["steps"].as_array().is_some_and(|steps| {
            steps.len() == 3
                && ["runtime", "provider", "admission"].iter().all(|id| {
                    steps
                        .iter()
                        .filter(|s| s["id"] == *id && s["state"] == "complete")
                        .count()
                        == 1
                })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer_targets::{Runtime, Target};
    #[test]
    fn guided_linux_setup_binds_profile_account_and_ownership_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let target = Target::LinuxGuest {
            runtime: Runtime::Docker,
            id: "a".repeat(64),
            environment_id: super::super::journal::new_id(),
            generation: super::super::journal::new_id(),
        };
        let env = journal
            .enroll_container("Linux", &target, &"b".repeat(64))
            .unwrap();
        let params = json!({"environmentId":env.id,"generation":env.generation,"harness":"codex","idempotencyKey":"setup-one","confirm":true});
        let container = env.transport.container().unwrap();
        let owner =
            super::super::admission::Guard::attach(dir.path(), &container, &journal).unwrap();
        assert!(super::super::setup::queue(&journal, params.clone()).is_err());
        owner.completed().unwrap();
        let queued = super::super::setup::queue(&journal, params.clone()).unwrap();
        assert_eq!(queued["taskMode"], "shellFiles");
        assert_eq!(
            super::super::setup::queue(&journal, params).unwrap(),
            queued
        );
        assert!(initial(&env, "claude", "wrong-provider").is_err());
        assert!(super::super::admission::Guard::attach(dir.path(), &container, &journal).is_err());
        let read = json!({"protocol":1,"environmentId":env.id,"generation":env.generation,
            "runtime":{"identity":{"protocol":1,"environmentId":env.id,"generation":env.generation},"state":"ready","executableSha256":"b".repeat(64)},
            "provider":{"harness":"codex","state":"unauthenticated","reasonCode":"guest_sign_in_required","actionCode":"provider.codexDeviceLogin.start"},
            "manualControl":false,"activeTaskTargets":[],"actionAdmission":{"state":"ready","reasonCode":"guest_setup_actions_admitted"}});
        record(&journal, &env, &read).unwrap();
        let report = journal.read().unwrap().environments[&env.id]
            .setup
            .clone()
            .unwrap();
        assert!(!ready(&env, &report));
        assert_eq!(
            report["steps"][1]["actionCode"],
            "provider.codexDeviceLogin.start"
        );
        let mut signed_in = read.clone();
        signed_in["provider"]["state"] = json!("authenticated");
        record(&journal, &env, &signed_in).unwrap();
        let reopened = Journal::open_existing(dir.path()).unwrap();
        let ready_report = reopened.read().unwrap().environments[&env.id]
            .setup
            .clone()
            .unwrap();
        assert!(ready(&env, &ready_report));
        super::super::admission::Guard::attach(dir.path(), &container, &reopened)
            .unwrap()
            .completed()
            .unwrap();
        for (path, value) in [
            ("/runtime/executableSha256", json!("c".repeat(64))),
            ("/manualControl", json!(true)),
            ("/actionAdmission/state", json!("blocked")),
            ("/activeTaskTargets", json!([{"taskId":"unresolved"}])),
        ] {
            let mut changed = signed_in.clone();
            *changed.pointer_mut(path).unwrap() = value;
            record(&reopened, &env, &changed).unwrap();
            assert!(
                !ready(
                    &env,
                    reopened.read().unwrap().environments[&env.id]
                        .setup
                        .as_ref()
                        .unwrap()
                ),
                "{path}"
            );
        }
        let mut replaced = env.clone();
        replaced.generation = super::super::journal::new_id();
        assert!(!ready(&replaced, &ready_report));
        let mut stale = signed_in.clone();
        stale["generation"] = json!(replaced.generation);
        assert!(record(&reopened, &env, &stale).is_err());
        reopened
            .transaction(|state| {
                state
                    .environments
                    .get_mut(&env.id)
                    .unwrap()
                    .setup
                    .as_mut()
                    .unwrap()["status"] = json!("outcomeUnknown");
                Ok(())
            })
            .unwrap();
        record(&reopened, &env, &signed_in).unwrap();
        assert_eq!(
            reopened.read().unwrap().environments[&env.id]
                .setup
                .as_ref()
                .unwrap()["status"],
            "outcomeUnknown"
        );
    }
}
