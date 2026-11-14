//! Explicit adoption of an existing VM after interrupted initial provisioning.
//! No creation, stop, deletion, provider or desktop effects are permitted here.
use super::{
    host,
    journal::{self, Environment, Journal, State},
};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

const PROBE_BUDGET: Duration = Duration::from_secs(15);
const KIND: &str = "adoptExisting";
/// Independent of persisted guest identity and the basic Local VM namespace.
pub const PROTOCOL: u64 = 1;

fn bound(state: &State, env: &Environment) -> Result<()> {
    let current = state
        .environments
        .get(&env.id)
        .context("Environment unavailable")?;
    if current.deleted_at.is_some()
        || current.generation != env.generation
        || current.sandbox != env.sandbox
        || current.provision != env.provision
    {
        bail!("Environment or provisioning history changed; inspect again");
    }
    // V1 cannot reconcile task history or a desktop reservation. In particular,
    // missing guest records can never erase a dispatched host target.
    if current.manual_control
        || state
            .tasks
            .values()
            .any(|t| t.target.environment_id == env.id)
    {
        bail!("Return manual control and reconcile retained tasks separately; initial-provision adoption requires no task history");
    }
    if env.provision.as_ref().and_then(|p| p["status"].as_str()) != Some("outcomeUnknown") {
        bail!("Only interrupted provisioning with an unknown outcome can be adopted");
    }
    Ok(())
}

fn boot(value: &Value) -> Result<&str> {
    let value = value.as_str().context("Kernel boot proof is unavailable")?;
    journal::validate_id(value).context("Invalid kernel boot proof")?;
    Ok(value)
}

pub(super) fn unused_guest(env: &Environment, guest: &Value) -> Result<()> {
    let inventory = &guest["retainedData"];
    if inventory["complete"] != true
        || !inventory["sessionIndexHasData"].is_boolean()
        || !inventory["unaccountedData"].is_boolean()
        || !inventory["sessionIndexDigest"]
            .as_str()
            .is_some_and(valid_digest)
        || ["workspaceEntries", "artifactEntries", "sessionEntries"]
            .iter()
            .any(|key| {
                !inventory[key]
                    .as_array()
                    .is_some_and(|items| items.iter().all(Value::is_string))
            })
    {
        bail!("Fresh complete retained-data inventory is missing");
    }
    if guest["evidenceVersion"] != 1
        || guest["environmentId"] != env.id
        || guest["generation"] != env.generation
        || guest["manualControl"] != false
        || guest["activeOwnedGroups"].as_u64() != Some(0)
        || !guest["tasks"].as_array().is_some_and(Vec::is_empty)
        || !guest["canceledTargets"]
            .as_object()
            .is_some_and(serde_json::Map::is_empty)
    {
        bail!(
            "The bound guest has no complete unused-runtime proof, or retains tasks/manual control"
        );
    }
    journal::validate_id(
        guest["initializedTimeline"]["timelineId"]
            .as_str()
            .context("Initialized guest timeline is missing")?,
    )?;
    let previous = boot(&guest["initializedTimeline"]["bootIdentity"])?;
    let current = boot(&guest["currentBootIdentity"])?;
    let no_execution = guest["noExecutionSinceInitialization"]
        .as_bool()
        .context("No-execution proof is missing")?;
    if guest["initializedTimeline"]["noExecution"].as_bool() != Some(no_execution) {
        bail!("Initialized no-execution receipt is inconsistent");
    }
    if !no_execution && previous == current {
        bail!("A different guest OS boot from the durable initialization baseline is required; daemon restart or empty history cannot prove earlier workers exited. No reboot was requested");
    }
    if !guest["historyDigest"].as_str().is_some_and(valid_digest) {
        bail!("Retained guest history proof is missing");
    }
    Ok(())
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn probe(env: &Environment) -> Result<Value> {
    let vm: Value = serde_json::from_slice(&host::cua(
        &["sb", "info", &env.sandbox, "--json"],
        b"",
        PROBE_BUDGET,
    )?)?;
    if vm["id"] != env.sandbox
        || vm["kind"] != "vm"
        || vm["runtime"] != "lume"
        || vm["image"] != host::IMAGE
        || vm["state"] != "running"
        || vm["status"] != "ready"
    {
        bail!("The exact pinned local macOS VM is not authoritatively running and ready; provisioning remains unknown");
    }
    let guest = host::guest_rpc_ready(
        env,
        "environment.provisionEvidence",
        json!({}),
        &vm,
        PROBE_BUDGET,
    )?;
    Ok(
        json!({"vm":{"id":vm["id"],"kind":vm["kind"],"runtime":vm["runtime"],
        "image":vm["image"],"state":vm["state"],"status":vm["status"]},"guest":guest}),
    )
}

fn evidence(env: &Environment, snapshot: Value) -> Result<Value> {
    let vm = &snapshot["vm"];
    // Validate in the pure path too: tests and future probes cannot accidentally
    // weaken the authoritative Cua projection.
    if vm["id"] != env.sandbox
        || vm["kind"] != "vm"
        || vm["runtime"] != "lume"
        || vm["image"] != host::IMAGE
        || vm["state"] != "running"
        || vm["status"] != "ready"
    {
        bail!("Pinned VM identity/readiness evidence is incomplete");
    }
    unused_guest(env, &snapshot["guest"])?;
    let guest = &snapshot["guest"];
    let guest = json!({"evidenceVersion":guest["evidenceVersion"],"environmentId":guest["environmentId"],
        "generation":guest["generation"],"manualControl":guest["manualControl"],
        "currentBootIdentity":guest["currentBootIdentity"],"initializedTimeline":{
            "timelineId":guest["initializedTimeline"]["timelineId"],"bootIdentity":guest["initializedTimeline"]["bootIdentity"],
            "noExecution":guest["initializedTimeline"]["noExecution"]},
        "activeOwnedGroups":guest["activeOwnedGroups"],"tasks":guest["tasks"],"canceledTargets":guest["canceledTargets"],
        "historyDigest":guest["historyDigest"],"noExecutionSinceInitialization":guest["noExecutionSinceInitialization"]});
    let mut guest = guest;
    guest["retainedData"] = snapshot["guest"]["retainedData"].clone();
    Ok(
        json!({"version":1,"disposition":KIND,"environmentId":env.id,
        "generation":env.generation,"sandbox":env.sandbox,"originalProvision":env.provision,
        "hostTasks":[],"vm":{"id":vm["id"],"kind":vm["kind"],"runtime":vm["runtime"],
            "image":vm["image"],"state":vm["state"],"status":vm["status"]},"guest":guest}),
    )
}

#[cfg(test)]
mod tests {
    use super::super::journal::{TaskInput, TaskStatus};
    use super::*;

    fn setup() -> (tempfile::TempDir, Journal, Environment, Value) {
        let temp = tempfile::tempdir().unwrap();
        let journal = Journal::open(temp.path()).unwrap();
        let mut env = journal.enroll("Interrupted", "local:interrupted").unwrap();
        env.provision = Some(host::progress(
            "outcomeUnknown",
            "Cua client interrupted; VM outcome unknown",
        ));
        journal
            .transaction(|s| {
                s.environments.insert(env.id.clone(), env.clone());
                Ok(())
            })
            .unwrap();
        let boot = journal::new_id();
        let snapshot = json!({"vm":{"id":env.sandbox,"kind":"vm","runtime":"lume","image":host::IMAGE,
            "state":"running","status":"ready"},"guest":{"evidenceVersion":1,"environmentId":env.id,
            "generation":env.generation,"manualControl":false,"activeOwnedGroups":0,"tasks":[],"canceledTargets":{},
            "currentBootIdentity":boot,"initializedTimeline":{"timelineId":journal::new_id(),"bootIdentity":boot,"noExecution":true},
            "noExecutionSinceInitialization":true,"historyDigest":"a".repeat(64)}});
        let mut snapshot = snapshot;
        snapshot["guest"]["retainedData"] = json!({"complete":true,"workspaceEntries":[],"artifactEntries":[],
            "sessionEntries":[],"sessionIndexHasData":false,"unaccountedData":false,"sessionIndexDigest":"c".repeat(64)});
        (temp, journal, env, snapshot)
    }
    fn confirm(env: &Environment, digest: &Value) -> Value {
        json!({"environmentId":env.id,"generation":env.generation,"sandbox":env.sandbox,
            "disposition":KIND,"confirm":true,"evidenceDigest":digest})
    }
    #[test]
    fn adoption_is_reviewed_reprobed_durable_and_exactly_idempotent_after_reload() {
        let (temp, journal, env, snapshot) = setup();
        let before = std::fs::read(temp.path().join("journal.json")).unwrap();
        let preview = preview_with(&journal, &env, |_| Ok(snapshot.clone()));
        assert_eq!(preview["available"], true);
        assert_eq!(
            std::fs::read(temp.path().join("journal.json")).unwrap(),
            before
        );
        let params = confirm(&env, &preview["proposal"]["evidenceDigest"]);
        let receipt = reconcile_with(&journal, params.clone(), |_| Ok(snapshot)).unwrap();
        let retained = journal.read().unwrap().environments[&env.id].clone();
        assert!(adopted(&retained));
        assert!(!super::super::supervisor::state_busy(
            &journal.read().unwrap()
        ));
        assert_eq!(
            receipt["evidence"]["originalProvision"],
            env.provision.unwrap()
        );
        assert_eq!(receipt["priorOutcomeUnknown"], true);
        let loaded = Journal::open_existing(temp.path()).unwrap();
        assert_eq!(
            reconcile_with(&loaded, params, |_| panic!(
                "Lost reply must not re-probe or replay any effect"
            ))
            .unwrap(),
            receipt
        );
        let mut altered = retained;
        altered.provision.as_mut().unwrap()["reconciliationReceipt"]["evidence"]["guest"]
            ["historyDigest"] = json!("b".repeat(64));
        assert!(!adopted(&altered));
        journal
            .transaction(|s| {
                s.environments.insert(altered.id.clone(), altered);
                Ok(())
            })
            .unwrap();
        assert!(super::super::supervisor::state_busy(
            &journal.read().unwrap()
        ));
    }
    #[test]
    fn missing_ack_stopped_vm_wrong_binding_manual_and_incomplete_history_never_qualify() {
        let (_temp, journal, env, snapshot) = setup();
        for (path, value) in [
            ("/vm/id", json!("local:other")),
            ("/vm/image", json!("macos")),
            ("/vm/state", json!("stopped")),
            ("/vm/status", Value::Null),
            ("/guest/environmentId", json!(journal::new_id())),
            ("/guest/generation", json!(journal::new_id())),
            ("/guest/manualControl", json!(true)),
            ("/guest/manualControl", Value::Null),
            ("/guest/activeOwnedGroups", json!(1)),
            ("/guest/activeOwnedGroups", Value::Null),
            ("/guest/tasks", Value::Null),
            ("/guest/tasks", json!([{"status":"completed"}])),
            ("/guest/canceledTargets", json!({"retained":"target"})),
            ("/guest/currentBootIdentity", Value::Null),
            ("/guest/initializedTimeline", Value::Null),
            ("/guest/noExecutionSinceInitialization", json!(false)),
            ("/guest/historyDigest", Value::Null),
        ] {
            let mut changed = snapshot.clone();
            *changed.pointer_mut(path).unwrap() = value;
            assert_eq!(
                preview_with(&journal, &env, |_| Ok(changed))["available"],
                false,
                "{path}"
            );
        }
        assert_eq!(
            preview_with(&journal, &env, |_| Ok(json!({"ok":true})))["available"],
            false
        );
        assert_eq!(
            preview_with(&journal, &env, |_| bail!("VM not found"))["available"],
            false
        );
        assert_eq!(journal.read().unwrap().environments[&env.id], env);
    }
    #[test]
    fn legacy_empty_runtime_requires_changed_kernel_boot_never_daemon_epoch() {
        let (_temp, journal, env, mut snapshot) = setup();
        snapshot["guest"]["noExecutionSinceInitialization"] = json!(false);
        snapshot["guest"]["initializedTimeline"]["noExecution"] = json!(false);
        assert_eq!(
            preview_with(&journal, &env, |_| Ok(snapshot.clone()))["available"],
            false
        );
        snapshot["guest"]["currentBootIdentity"] = json!(journal::new_id());
        assert_eq!(
            preview_with(&journal, &env, |_| Ok(snapshot))["available"],
            true
        );
    }
    #[test]
    fn confirmation_rechecks_evidence_and_original_history_and_never_trusts_ui_proof() {
        let (_temp, journal, env, snapshot) = setup();
        let preview = preview_with(&journal, &env, |_| Ok(snapshot.clone()));
        let params = confirm(&env, &preview["proposal"]["evidenceDigest"]);
        let mut changed = snapshot.clone();
        changed["guest"]["historyDigest"] = json!("b".repeat(64));
        assert!(reconcile_with(&journal, params.clone(), |_| Ok(changed)).is_err());
        let mut supplied = params.clone();
        supplied["evidence"] = snapshot.clone();
        assert!(reconcile_with(&journal, supplied, |_| panic!(
            "UI evidence must be rejected"
        ))
        .is_err());
        let mut unconfirmed = params.clone();
        unconfirmed["confirm"] = json!(false);
        assert!(
            reconcile_with(&journal, unconfirmed, |_| panic!("Confirmation required")).is_err()
        );
        assert!(reconcile_with(&journal, params, |_| {
            journal.transaction(|s| {
                s.environments
                    .get_mut(&env.id)
                    .unwrap()
                    .provision
                    .as_mut()
                    .unwrap()["detail"] = json!("New retained evidence");
                Ok(())
            })?;
            Ok(snapshot)
        })
        .is_err());
        assert!(!adopted(&journal.read().unwrap().environments[&env.id]));
    }
    #[test]
    fn canonical_projection_excludes_probe_metadata_but_binds_full_timeline() {
        let (_temp, _journal, env, snapshot) = setup();
        let expected = digest(&evidence(&env, snapshot.clone()).unwrap()).unwrap();
        let mut changed = snapshot;
        changed["vm"]["heartbeat"] = json!(journal::now());
        changed["guest"]["pid"] = json!(1234);
        assert_eq!(
            digest(&evidence(&env, changed.clone()).unwrap()).unwrap(),
            expected
        );
        changed["guest"]["initializedTimeline"]["timelineId"] = json!(journal::new_id());
        assert_ne!(digest(&evidence(&env, changed).unwrap()).unwrap(), expected);
    }
    #[test]
    fn all_host_task_history_including_terminal_old_generations_blocks_adoption() {
        let (_temp, journal, env, snapshot) = setup();
        let task = journal
            .submit(
                "retained",
                TaskInput {
                    parent_session_id: journal::new_id(),
                    parent_tab_id: journal::new_id(),
                    parent_message_id: "message".into(),
                    environment_id: env.id.clone(),
                    prompt: "Never replay".into(),
                    harness: "codex".into(),
                    model: "".into(),
                    effort: None,
                    permission_mode: "manual".into(),
                    files: vec![],
                    desktop: true,
                },
            )
            .unwrap();
        journal
            .transaction(|s| {
                let t = s.tasks.get_mut(&task.target.task_id).unwrap();
                t.status = TaskStatus::Canceled;
                t.target.generation = journal::new_id();
                Ok(())
            })
            .unwrap();
        assert_eq!(
            preview_with(&journal, &env, |_| panic!(
                "Retained task must block before probe"
            ))["available"],
            false
        );
        assert_eq!(journal.read().unwrap().environments[&env.id], env);
        assert!(evidence(&env, snapshot).is_ok());
    }
    #[test]
    fn lost_or_unwritable_journal_never_returns_a_disposition_receipt() {
        use std::os::unix::fs::PermissionsExt;
        let (temp, journal, env, snapshot) = setup();
        let preview = preview_with(&journal, &env, |_| Ok(snapshot.clone()));
        let params = confirm(&env, &preview["proposal"]["evidenceDigest"]);
        let result = reconcile_with(&journal, params, |_| {
            std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o500))?;
            Ok(snapshot)
        });
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(result.is_err());
        assert_eq!(journal.read().unwrap().environments[&env.id], env);
    }
}

fn digest(value: &Value) -> Result<String> {
    Ok(journal::digest(&serde_json::to_vec(value)?))
}

pub fn preview(journal: &Journal, env: &Environment) -> Value {
    preview_with(journal, env, probe)
}

fn preview_with(
    journal: &Journal,
    env: &Environment,
    probe: impl FnOnce(&Environment) -> Result<Value>,
) -> Value {
    let result = (|| -> Result<Value> {
        bound(&journal.read()?, env)?;
        let evidence = evidence(env, probe(env)?)?;
        bound(&journal.read()?, env)?;
        Ok(
            json!({"available":true,"reason":null,"evidence":evidence,"proposal":{
            "environmentId":env.id,"generation":env.generation,"sandbox":env.sandbox,
            "evidenceDigest":digest(&evidence)?,"observedAt":journal::now()}}),
        )
    })();
    result.unwrap_or_else(|error| json!({"available":false,"reason":crate::remote::protocol::redact(&format!("{error:#}")),"proposal":null}))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Confirmation {
    environment_id: String,
    generation: String,
    sandbox: String,
    disposition: String,
    evidence_digest: String,
    confirm: bool,
}

pub fn reconcile(journal: &Journal, params: Value) -> Result<Value> {
    reconcile_with(journal, params, probe)
}

fn reconcile_with(
    journal: &Journal,
    params: Value,
    probe: impl FnOnce(&Environment) -> Result<Value>,
) -> Result<Value> {
    let request: Confirmation = serde_json::from_value(params)?;
    if !request.confirm || request.disposition != KIND || !valid_digest(&request.evidence_digest) {
        bail!("Explicit adoption confirmation and the reviewed evidence digest are required");
    }
    let env = journal
        .read()?
        .environments
        .get(&request.environment_id)
        .cloned()
        .context("Environment unavailable")?;
    if env.deleted_at.is_some()
        || env.generation != request.generation
        || env.sandbox != request.sandbox
    {
        bail!("Environment identity changed; no disposition was recorded");
    }
    if adopted(&env) {
        let receipt = &env.provision.as_ref().unwrap()["reconciliationReceipt"];
        if receipt["evidenceDigest"] == request.evidence_digest {
            return Ok(receipt.clone()); // Exact durable receipt after a lost reply.
        }
        bail!("A different disposition is already durable; inspect retained history");
    }
    bound(&journal.read()?, &env)?;
    let evidence = evidence(&env, probe(&env)?)?;
    if digest(&evidence)? != request.evidence_digest {
        bail!("Fresh authoritative evidence differs from the review; inspect and confirm again");
    }
    let receipt = json!({"version":1,"disposition":KIND,"environmentId":env.id,
        "generation":env.generation,"sandbox":env.sandbox,"evidenceDigest":request.evidence_digest,
        "confirmedAt":journal::now(),"priorOutcomeUnknown":true,"evidence":evidence});
    journal.transaction(|state| {
        bound(state, &env)?;
        let current = state.environments.get_mut(&env.id).unwrap();
        let mut disposition = host::progress("adopted", "Existing bound VM adopted after inspection. The earlier provisioning outcome remains unknown; provider and desktop readiness are unverified.");
        disposition["reconciliationReceipt"] = receipt.clone();
        current.provision = Some(disposition);
        Ok(())
    })?;
    Ok(receipt)
}

/// An arbitrary `adopted` string cannot make a retained unknown record idle.
pub fn adopted(env: &Environment) -> bool {
    let Some(provision) = &env.provision else {
        return false;
    };
    let receipt = &provision["reconciliationReceipt"];
    let proof = &receipt["evidence"];
    let mut original = env.clone();
    original.provision = Some(proof["originalProvision"].clone());
    provision["status"] == "adopted"
        && receipt["version"] == 1
        && receipt["disposition"] == KIND
        && receipt["environmentId"] == env.id
        && receipt["generation"] == env.generation
        && receipt["sandbox"] == env.sandbox
        && receipt["priorOutcomeUnknown"] == true
        && proof["originalProvision"]["status"] == "outcomeUnknown"
        && evidence(&original, json!({"vm":proof["vm"],"guest":proof["guest"]}))
            .ok()
            .as_ref()
            == Some(proof)
        && digest(proof).ok().as_deref() == receipt["evidenceDigest"].as_str()
}
