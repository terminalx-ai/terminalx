//! Durable setup owned by the persistent host, never by a Settings view.
//! Inspection is passive. Every installer/action intent precedes its effect;
//! an interrupted external operation is retained and is never replayed.
use super::{
    bootstrap, host,
    journal::{self, Environment, Journal},
};
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};

pub const PROTOCOL: u64 = 1;
const ACTIONS: &[&str] = &[
    "driver.start",
    "driver.requestPermissions",
    "provider.codexDeviceLogin.start",
    "provider.codexDeviceLogin.cancel",
    "provider.codexAccount.verify",
    "desktop.verify",
];

pub fn initial(env: &Environment, harness: &str, key: &str) -> Result<Value> {
    validate_harness(harness)?;
    validate_key(key)?;
    Ok(
        json!({"protocol":PROTOCOL,"environmentId":env.id,"generation":env.generation,
        "harness":harness,"idempotencyKey":key,"status":"queued","lastCheckedAt":null,
        "detail":"Preparing the disclosed tool/runtime profile; permissions and account consent remain yours",
        "steps":[
            {"id":"tools","label":"Prepare verified local VM tools","state":"pending"},
            {"id":"vm","label":"Boot the selected macOS VM","state":"pending"},
            {"id":"transport","label":"Connect to the guest","state":"pending"},
            {"id":"runtime","label":"Install the bound TerminalX guest runtime","state":"pending"},
            {"id":"driver","label":"Prepare signed guest desktop tools","state":"pending"},
            {"id":"accessibility","label":"Allow guest Accessibility","state":"pending"},
            {"id":"screenRecording","label":"Allow guest Screen Recording","state":"pending"},
            {"id":"provider","label":"Connect your guest provider account","state":"pending"},
            {"id":"desktop","label":"Verify a usable guest desktop","state":"pending"}]}),
    )
}

fn validate_harness(harness: &str) -> Result<()> {
    if !matches!(harness, "codex" | "claude") {
        bail!("Unsupported guest provider");
    }
    Ok(())
}
fn validate_key(key: &str) -> Result<()> {
    if key.trim().is_empty() || key.len() > 200 {
        bail!("A bounded setup idempotency key is required");
    }
    Ok(())
}
pub fn validate_request(harness: &str, key: &str) -> Result<()> {
    validate_harness(harness)?;
    validate_key(key)
}
fn env(journal: &Journal, params: &Value) -> Result<Environment> {
    let id = host::field(params, "environmentId")?;
    let generation = host::field(params, "generation")?;
    journal
        .read()?
        .environments
        .get(id)
        .filter(|e| e.generation == generation && e.deleted_at.is_none())
        .cloned()
        .context("Environment/generation changed; no setup operation was routed")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetupRequest {
    environment_id: String,
    generation: String,
    harness: String,
    idempotency_key: String,
    confirm: bool,
}
pub fn queue(journal: &Journal, params: Value) -> Result<Value> {
    let request: SetupRequest = serde_json::from_value(params.clone())?;
    if !request.confirm {
        bail!("Explicit setup confirmation is required");
    }
    validate_harness(&request.harness)?;
    validate_key(&request.idempotency_key)?;
    let current = env(journal, &params)?;
    // Keep typed identity fields part of the immutable request, even though
    // the environment lookup has already checked them.
    if current.id != request.environment_id || current.generation != request.generation {
        bail!("Setup binding changed");
    }
    journal.transaction(|state| {
        let unfinished=state.tasks.values().any(|t|t.target.environment_id==current.id && !t.status.terminal());
        let env=state.environments.get_mut(&current.id).filter(|e|e.generation==current.generation && e.setup==current.setup && e.deleted_at.is_none()).context("Setup history changed; inspect again")?;
        if let Some(prior)=&env.setup {
            if prior["idempotencyKey"]==request.idempotency_key && prior["harness"]==request.harness { return Ok(prior.clone()); }
        }
        if env.manual_control || unfinished {bail!("Return desktop control and resolve unfinished tasks before changing guest setup");}
        if let Some(prior)=&env.setup {
            if !matches!(prior["status"].as_str(),Some("failed"|"outcomeUnknown")) {bail!("This environment already has active setup history; inspect its current operation");}
            let mut history=prior["history"].as_array().cloned().unwrap_or_default();
            let mut previous=prior.clone();previous.as_object_mut().context("Damaged setup history")?.remove("history");history.push(previous);
            let mut report=initial(env,&request.harness,&request.idempotency_key)?;
            report["history"]=json!(history);report["operations"]=prior["operations"].clone();
            report["reconcileExistingProvision"]=json!(env.provision.as_ref().is_some_and(|p|p["status"]=="outcomeUnknown"));
            env.setup=Some(report.clone());return Ok(report);
        }
        let report=initial(env,&request.harness,&request.idempotency_key)?;env.setup=Some(report.clone());Ok(report)
    })
}

pub fn set_step(
    journal: &Journal,
    target: &Environment,
    id: &str,
    state_name: &str,
    detail: &str,
) -> Result<()> {
    journal.transaction(|state| {
        let env = state
            .environments
            .get_mut(&target.id)
            .filter(|e| e.generation == target.generation && e.deleted_at.is_none())
            .context("Setup timeline changed")?;
        let setup = env.setup.as_mut().context("Setup request missing")?;
        let step = setup["steps"]
            .as_array_mut()
            .context("Setup steps damaged")?
            .iter_mut()
            .find(|s| s["id"] == id)
            .context("Unknown setup step")?;
        step["state"] = json!(state_name);
        step["detail"] = json!(detail);
        setup["detail"] = json!(detail);
        setup["status"] = json!(match state_name {
            "failed" => "failed",
            "unknown" => "outcomeUnknown",
            "waiting" => "needsAttention",
            _ => "working",
        });
        Ok(())
    })
}

fn check_binding(env: &Environment, harness: &str, value: &Value) -> Result<()> {
    if value["protocol"] != 1
        || value["environmentId"] != env.id
        || value["generation"] != env.generation
        || value["runtime"]["identity"]["environmentId"] != env.id
        || value["runtime"]["identity"]["generation"] != env.generation
        || value["runtime"]["identity"]["protocol"] != journal::PROTOCOL
        || value["provider"]["harness"] != harness
    {
        bail!(
            "Guest setup readiness differs from the installed identity/provider; no host fallback"
        );
    }
    Ok(())
}

pub fn inspect(journal: &Journal, params: Value) -> Result<Value> {
    let current = env(journal, &params)?;
    let harness = host::field(&params, "harness")?;
    validate_harness(harness)?;
    let readiness = host::guest_rpc(
        &current,
        "environment.setupReadiness",
        json!({"harness":harness}),
    )?;
    check_binding(&current, harness, &readiness)?;
    record_readiness(journal, &current, harness, &readiness)?;
    Ok(readiness)
}

fn record_readiness(
    journal: &Journal,
    target: &Environment,
    harness: &str,
    readiness: &Value,
) -> Result<()> {
    check_binding(target, harness, readiness)?;
    journal.transaction(|state| {
        let env=state.environments.get_mut(&target.id).filter(|e|e.generation==target.generation && e.deleted_at.is_none()).context("Setup timeline changed")?;
        let Some(report)=env.setup.as_mut() else { return Ok(()) };
        if report["harness"]!=harness { bail!("Setup provider differs from the retained request"); }
        report["readiness"]=readiness.clone();report["lastCheckedAt"]=json!(journal::now());
        if !matches!(report["status"].as_str(),Some("outcomeUnknown"|"failed")) {
            report["status"]=json!("needsAttention");
        }
        for (id,check) in [("runtime",&readiness["runtime"]),("driver",&readiness["driver"]),
            ("accessibility",&readiness["accessibility"]),("screenRecording",&readiness["screenRecording"]),
            ("provider",&readiness["provider"]),("desktop",&readiness["capture"])] {
            if let Some(step)=report["steps"].as_array_mut().and_then(|steps|steps.iter_mut().find(|s|s["id"]==id)) {
                let prepared_driver=id=="driver" && check["state"]=="running"
                    && check["installedVersion"]==super::desktop::DRIVER_VERSION
                    && check["installedExecutableSha256"]==bootstrap::DRIVER.executable_sha256;
                step["state"]=json!(if prepared_driver || matches!(check["state"].as_str(),Some("ready"|"granted"|"authenticated"|"usable"|"verified")) {"complete"} else {"waiting"});
                step["detail"]=check["reasonCode"].clone();step["actionCode"]=check["actionCode"].clone();
            }
        }
        report["detail"]=json!("Follow the contextual guest approval/account steps. Passive checks never request permissions, log in, or claim live capture.");
        let proof=report["operations"].as_object().and_then(|ops|ops.values().filter_map(|op| {
            let receipt=&op["receipt"]; let proof=&receipt["verification"];
            (receipt["action"]=="desktop.verify" && receipt["status"]=="complete" && proof["desktopUsable"]==true
                && proof["captureVerified"]==true && proof["bootIdentity"].is_string()
                && proof["bootIdentity"]==readiness["runtime"]["bootIdentity"]
                && proof["driverExecutableSha256"].as_str().is_some_and(|s|s.len()==64)
                && proof["verifiedAt"].as_str().is_some_and(|s|chrono::DateTime::parse_from_rfc3339(s).is_ok()))
                .then(||proof.clone())
        }).next_back());
        if let Some(proof)=proof {
            if !matches!(readiness["desktop"]["state"].as_str(),Some("blocked"|"locked"|"unavailable")) {
                if let Some(step)=report["steps"].as_array_mut().and_then(|steps|steps.iter_mut().find(|s|s["id"]=="desktop")) {
                    step["state"]=json!("complete");step["detail"]=json!("Explicit desktop/capture verification retained for this guest boot; automatic checks do not capture the screen");step["actionCode"]=Value::Null;
                }
                report["desktopVerification"]=proof;
            }
        }
        if !matches!(report["status"].as_str(),Some("outcomeUnknown"|"failed")) && readiness["manualControl"]==false
            && readiness["activeTaskTargets"].as_array().is_some_and(Vec::is_empty)
            && readiness["actionAdmission"]["state"]=="ready"
            && report["steps"].as_array().is_some_and(|steps|steps.iter().all(|s|s["state"]=="complete")) {
            report["status"]=json!("ready");report["detail"]=json!("Setup checks and explicit guest desktop verification are complete. Provider delivery and host-lock acceptance are recorded separately.");
            if !ready(target,report) {
                report["status"]=json!("needsAttention");report["detail"]=json!("Serving runtime identity or current-boot desktop verification is incomplete; a running VM alone is not Ready.");
            }
        }
        Ok(())
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActionRequest {
    environment_id: String,
    generation: String,
    action: String,
    idempotency_key: String,
    confirm: bool,
    login_id: Option<String>,
}
pub fn action(journal: &Journal, params: Value) -> Result<Value> {
    action_using(journal, params, |env, params| {
        host::guest_rpc(env, "environment.setupAction", params)
    })
}

fn action_using(
    journal: &Journal,
    params: Value,
    send: impl FnOnce(&Environment, Value) -> Result<Value>,
) -> Result<Value> {
    let request: ActionRequest = serde_json::from_value(params.clone())?;
    if !request.confirm || !ACTIONS.contains(&request.action.as_str()) {
        bail!("Explicit confirmation of a supported setup action is required");
    }
    validate_key(&request.idempotency_key)?;
    if (request.action == "provider.codexDeviceLogin.cancel") != request.login_id.is_some() {
        bail!("Only cancellation requires the exact live loginId");
    }
    let current = env(journal, &params)?;
    if current.id != request.environment_id || current.generation != request.generation {
        bail!("Setup action binding changed");
    }
    let digest = journal::digest(&serde_json::to_vec(&params)?);
    let prior=journal.transaction(|state| {
        let unfinished=state.tasks.values().any(|t|t.target.environment_id==current.id && !t.status.terminal());
        let env=state.environments.get_mut(&current.id).filter(|e|e.generation==current.generation && e.deleted_at.is_none()).context("Setup timeline changed")?;
        let blocked=env.manual_control || unfinished;
        let report=env.setup.as_mut().context("Confirm guest setup before requesting an action")?;
        if let Some(prior)=report["operations"].get(&request.idempotency_key) {
            if prior["digest"]!=digest { bail!("Setup key already names different input"); }
            return Ok(Some(prior["receipt"].clone()));
        }
        if blocked {bail!("Return desktop control and resolve unfinished tasks before changing guest setup");}
        let cancel_current=request.action=="provider.codexDeviceLogin.cancel" && report["action"]["action"]=="provider.codexDeviceLogin.start"
            && matches!(report["action"]["status"].as_str(),Some("working"|"needsAttention"));
        if request.action.starts_with("provider.codex") && report["harness"]!="codex" {bail!("Setup provider differs from the action");}
        if !cancel_current && report["action"]["status"].as_str().is_some_and(|s|matches!(s,"working"|"needsAttention"|"outcomeUnknown")) {
            bail!("Inspect the retained setup action before requesting another operation");
        }
        let receipt=json!({"action":request.action,"idempotencyKey":request.idempotency_key,"status":"working","detail":"Request durably retained before delivery"});
        if !report["operations"].is_object() { report["operations"]=json!({}); }
        report["operations"][&request.idempotency_key]=json!({"digest":digest,"receipt":receipt});
        report["action"]=receipt;report["status"]=json!("working");Ok(None)
    })?;
    if let Some(receipt) = prior {
        return Ok(receipt);
    }
    let result = send(&current, params);
    let receipt = match result {
        Ok(receipt)
            if receipt["action"] == request.action
                && receipt["idempotencyKey"] == request.idempotency_key
                && matches!(
                    receipt["status"].as_str(),
                    Some("working" | "needsAttention" | "complete" | "outcomeUnknown" | "failed")
                ) =>
        {
            safe_receipt(&receipt)
        }
        _ => {
            json!({"action":request.action,"idempotencyKey":request.idempotency_key,"status":"outcomeUnknown",
            "detail":"The action receipt is unavailable. Recheck the existing guest; this operation was not replayed."})
        }
    };
    journal.transaction(|state| {
        let report = state
            .environments
            .get_mut(&current.id)
            .filter(|e| e.generation == current.generation && e.deleted_at.is_none())
            .and_then(|e| e.setup.as_mut())
            .context("Setup timeline changed")?;
        report["operations"][&request.idempotency_key]["receipt"] = receipt.clone();
        report["action"] = receipt.clone();
        report["status"] = json!(if receipt["status"] == "outcomeUnknown" {
            "outcomeUnknown"
        } else {
            "needsAttention"
        });
        Ok(())
    })?;
    Ok(receipt)
}

fn safe_receipt(receipt: &Value) -> Value {
    let mut result = json!({"action":receipt["action"],"idempotencyKey":receipt["idempotencyKey"],"status":receipt["status"],
        "detail":match receipt["status"].as_str() {Some("complete")=>"Guest action receipt retained. Readiness is checked independently.",Some("working"|"needsAttention")=>"The original guest operation is still owned; no new request is needed.",_=>"Inspect the original guest operation; its external outcome is unproven."}});
    if let Some(proof) = receipt.get("verification").filter(|proof| {
        proof["bootIdentity"]
            .as_str()
            .is_some_and(|s| journal::validate_id(s).is_ok())
            && proof["verifiedAt"]
                .as_str()
                .is_some_and(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
            && proof["driverExecutableSha256"]
                .as_str()
                .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            && proof["desktopUsable"].as_bool().is_some()
            && proof["captureVerified"].as_bool().is_some()
    }) {
        result["verification"] = json!({"bootIdentity":proof["bootIdentity"],"verifiedAt":proof["verifiedAt"],
            "driverExecutableSha256":proof["driverExecutableSha256"],"desktopUsable":proof["desktopUsable"],"captureVerified":proof["captureVerified"]});
    }
    result["detail"]=json!(match receipt["detail"].as_str() {
        Some("device_login_awaiting_user")=>"Open the displayed Codex device sign-in link and enter its one-time code. TerminalX never opens or approves it automatically.",
        Some("guest_provider_already_authenticated_no_login_started")=>"The guest is already signed in. No new sign-in was started.",
        Some("guest_provider_account_missing_no_login_started")=>"The guest account check found no local sign-in. No new sign-in was started; choose Sign in to Codex when ready.",
        Some("guest_account_binding_changed_check_again_no_login_started")=>"The guest account configuration or executable changed during inspection. No sign-in was started. Review the current guest settings, then check the existing account again.",
        Some("guest_native_desktop_check_incomplete_inspect_document")=>"The guest document check did not confirm input, saved readback and closure. Inspect the TerminalX check document in guest TextEdit before recovering setup. No input or shortcut was replayed.",
        Some("guest_native_desktop_document_open_unverified")=>"The private check document could not be opened in guest TextEdit. Inspect the guest desktop before recovering setup.",
        Some("guest_native_desktop_document_window_unverified")=>"The check document's unique guest TextEdit window could not be confirmed. Inspect the guest desktop before recovering setup; no text was typed.",
        Some("guest_native_desktop_initial_snapshot_unverified")=>"The check document's initial native editor could not be confirmed. Inspect the guest desktop before recovering setup; no text was typed.",
        Some("guest_native_desktop_cleanup_unverified")=>"Native input, saved file readback and document closure passed, but the private check file could not be removed. Inspect its retained file before recovering setup.",
        Some("guest_native_desktop_input_unverified")=>"Guest TextEdit did not accept the check's native input. Inspect the retained check document; typing was not replayed.",
        Some("guest_native_desktop_readback_unverified")=>"Guest TextEdit did not return the exact typed check text through native readback. Inspect the retained check document; typing was not replayed.",
        Some("guest_native_desktop_save_unverified")=>"Native text readback passed, but the application save was not independently verified. Inspect the retained check document; Save was not replayed.",
        Some("guest_native_desktop_saved_file_unreadable")=>"Native text readback passed, but the saved check file could not be read independently. Inspect the retained check document; Save was not replayed.",
        Some("guest_native_desktop_save_menu_missing")=>"Native text readback passed, but the expected File → Save menu item was unavailable in guest TextEdit. Inspect the retained check document; no alternate command was tried.",
        Some("guest_native_desktop_save_menu_disabled")=>"Native text readback passed, but guest TextEdit's Save menu item was disabled. Inspect the retained check document; Save was not replayed.",
        Some("guest_native_desktop_save_menu_focus_unverified")=>"Native text readback passed, but the exact check document could not become the active guest window for Save. Inspect the guest desktop; input was not redirected.",
        Some("guest_native_desktop_save_request_interrupted")=>"Native text readback passed, but the Save helper timed out or was interrupted before its result was confirmed. Inspect the retained check document; Save was not replayed.",
        Some("guest_native_desktop_save_response_invalid")=>"Native text readback passed, but the Save response could not be verified. Inspect the retained check document; Save was not replayed.",
        Some("guest_native_desktop_save_request_unverified")=>"Native text readback passed, but the Save request did not return a successful receipt. Inspect the retained check document; Save was not replayed.",
        Some("guest_native_desktop_close_unverified")=>"Native text readback and saved file verification passed, but closing the check document was not confirmed. Inspect it in guest TextEdit; Close was not replayed.",
        Some("explicit_guest_desktop_input_readback_verified")=>"Guest capture, exact-window native input and saved application readback were verified. The disposable check document was closed and removed.",
        Some("existing_provider_auth_selection_requires_review_no_login_started")=>"The existing guest provider home/account configuration needs review. No sign-in or credential-store change was started.",
        Some("prior_login_outcome_unknown_explicit_reconciliation_required")=>"The earlier sign-in process is unavailable. Its outcome remains unknown; inspect the guest account before authorizing another sign-in.",
        Some("guest_codex_missing_no_login_started")=>"The verified Codex guest tool is missing. Finish tool preparation before signing in.",
        _=>result["detail"].as_str().unwrap_or("Inspect the retained guest action before continuing"),
    });
    result
}

pub fn auth(journal: &Journal, params: Value) -> Result<Value> {
    let current = env(journal, &params)?;
    validate_key(host::field(&params, "idempotencyKey")?)?;
    // Intentionally never checkpoint this reply: the one-time challenge lives
    // only in the same guest process and the requesting UI's memory.
    let response = host::guest_rpc(&current, "environment.setupAuth", params.clone())?;
    if response["protocol"] != 1
        || response["environmentId"] != current.id
        || response["generation"] != current.generation
        || response["idempotencyKey"] != params["idempotencyKey"]
    {
        bail!("Guest sign-in actor binding changed");
    }
    if !matches!(
        response["status"].as_str(),
        Some("pending" | "awaitingUser" | "complete" | "outcomeUnknown" | "failed" | "none")
    ) {
        bail!("Guest sign-in status is invalid");
    }
    let mut safe = json!({"protocol":1,"environmentId":current.id,"generation":current.generation,"idempotencyKey":params["idempotencyKey"],"status":response["status"]});
    if let Some(challenge) = response.get("challenge").filter(|v| !v.is_null()) {
        let login = host::field(challenge, "loginId")?;
        journal::validate_id(login)?;
        let code = host::field(challenge, "userCode")?;
        if challenge["verificationUrl"] != "https://auth.openai.com/codex/device"
            || code.len() > 32
            || code.is_empty()
            || !code
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'-')
        {
            bail!("Guest device challenge was invalid; no browser was opened");
        }
        safe["challenge"] = json!({"loginId":login,"verificationUrl":"https://auth.openai.com/codex/device","userCode":code,"expiresAt":challenge.get("expiresAt").filter(|v|v.as_str().is_some_and(|s|chrono::DateTime::parse_from_rfc3339(s).is_ok()))});
    }
    Ok(safe)
}

/// Called only by the admitted owner controller. Installer steps are recorded
/// before effects; the supervisor's startup reconciliation never requeues them.
pub fn advance(journal: &Journal, target: &Environment) -> Result<()> {
    refresh_actions(journal, target)?;
    let state = journal.read()?;
    let current = state
        .environments
        .get(&target.id)
        .cloned()
        .context("Setup environment missing")?;
    let Some(report) = &current.setup else {
        return Ok(());
    };
    if current.manual_control
        || state
            .tasks
            .values()
            .any(|t| t.target.environment_id == current.id && !t.status.terminal())
    {
        return Ok(());
    }
    if matches!(report["status"].as_str(), Some("outcomeUnknown" | "failed")) {
        return Ok(());
    }
    if report["lastCheckedAt"]
        .as_str()
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| chrono::Utc::now().signed_duration_since(at).num_seconds() < 5)
    {
        return Ok(());
    }
    if report["status"] == "queued" {
        set_step(
            journal,
            &current,
            "tools",
            "working",
            "Downloading/checking the disclosed signed tool profile",
        )?;
        for tool in [&bootstrap::CUA, &bootstrap::LUME] {
            bootstrap::prepare(tool)?;
        }
        set_step(
            journal,
            &current,
            "tools",
            "complete",
            "Pinned Cua and Lume verified; no host enrollment or global tool changes",
        )?;
        return Ok(());
    }
    let provision = current
        .provision
        .as_ref()
        .and_then(|p| p["status"].as_str());
    if matches!(provision, Some("queued" | "running" | "canceling")) {
        return Ok(());
    }
    if provision == Some("outcomeUnknown") {
        if report["reconcileExistingProvision"] != true {
            return Ok(());
        }
        host::check_setup_vm(&current)?;
        set_step(journal,&current,"runtime","working","Verifying the existing guest runtime without recreating or clearing the unknown VM operation")?;
        host::install_current_guest(&current)?;
        set_step(
            journal,
            &current,
            "runtime",
            "complete",
            "Existing runtime identity and checksum verified",
        )?;
        set_step(journal,&current,"vm","unknown","The existing VM can now be inspected by Resolve interrupted provisioning. Confirm that separate disposition before continuing setup; creation was not replayed")?;
        return Ok(());
    }
    if provision == Some("failed") {
        bail!("VM provisioning failed; retained storage requires inspection before setup");
    }
    if report["steps"].as_array().is_some_and(|steps| {
        steps
            .iter()
            .any(|s| s["id"] == "runtime" && s["state"] == "pending")
    }) {
        host::check_setup_vm(&current)?;
        set_step(
            journal,
            &current,
            "vm",
            "complete",
            "The exact selected VM is running and its image/transport identity was checked",
        )?;
        set_step(
            journal,
            &current,
            "transport",
            "complete",
            "Using only this environment's authenticated Cua guest transport",
        )?;
        set_step(
            journal,
            &current,
            "runtime",
            "working",
            "Installing the owner's signed/checksummed guest runtime automatically",
        )?;
        host::install_current_guest(&current)?;
        set_step(
            journal,
            &current,
            "runtime",
            "complete",
            "Guest runtime checksum and immutable identity verified",
        )?;
        set_step(
            journal,
            &current,
            "driver",
            "working",
            "Preparing the signed guest desktop bundle without TCC or daemon replacement",
        )?;
        host::prepare_guest_driver(&current)?;
        set_step(journal,&current,"driver","complete","Signed Driver installed or matching existing installation retained; no permissions requested")?;
        host::prepare_guest_provider(&current, host::field(report, "harness")?)?;
    }
    let fresh = journal.read()?.environments[&current.id].clone();
    let harness = host::field(fresh.setup.as_ref().context("Setup missing")?, "harness")?;
    let readiness = host::guest_rpc(
        &fresh,
        "environment.setupReadiness",
        json!({"harness":harness}),
    )?;
    record_readiness(journal, &fresh, harness, &readiness)
}

fn refresh_actions(journal: &Journal, target: &Environment) -> Result<()> {
    let current = journal
        .read()?
        .environments
        .get(&target.id)
        .cloned()
        .context("Setup environment missing")?;
    let Some(report) = &current.setup else {
        return Ok(());
    };
    let mut pending: Vec<_> = report["operations"]
        .as_object()
        .into_iter()
        .flat_map(|ops| ops.iter())
        .filter(|(_, op)| {
            matches!(
                op["receipt"]["status"].as_str(),
                Some("working" | "needsAttention" | "outcomeUnknown")
            )
        })
        .map(|(key, op)| (key.clone(), op["receipt"]["action"].clone()))
        .collect();
    // Historical unknown receipts stay retained, but must not starve the
    // current cancellation or other owned operation's read-only status.
    pending.sort_by_key(|(key, _)| report["action"]["idempotencyKey"] != *key);
    for (key, action) in pending.into_iter().take(2) {
        let Ok(receipt) = host::guest_rpc(
            &current,
            "environment.setupActionStatus",
            json!({"idempotencyKey":key}),
        ) else {
            continue;
        };
        if receipt["idempotencyKey"] != key
            || receipt["action"] != action
            || !matches!(
                receipt["status"].as_str(),
                Some("working" | "needsAttention" | "complete" | "outcomeUnknown" | "failed")
            )
        {
            continue;
        }
        let receipt = safe_receipt(&receipt);
        journal.transaction(|state| {
            let report = state
                .environments
                .get_mut(&current.id)
                .filter(|e| e.generation == current.generation && e.deleted_at.is_none())
                .and_then(|e| e.setup.as_mut())
                .context("Setup timeline changed")?;
            let op = &mut report["operations"][&key];
            if op["receipt"]["status"] == "outcomeUnknown"
                && op["receipt"] != receipt
                && op.get("priorUnknownReceipt").is_none()
            {
                op["priorUnknownReceipt"] = op["receipt"].clone();
            }
            op["receipt"] = receipt.clone();
            if report["action"]["idempotencyKey"] == key {
                report["action"] = receipt.clone();
                if receipt["status"] == "outcomeUnknown" {
                    report["status"] = json!("outcomeUnknown");
                } else if receipt["status"] == "complete" {
                    report["status"] = json!("needsAttention");
                }
            }
            Ok(())
        })?;
    }
    Ok(())
}

pub fn interrupted(journal: &Journal, target: &Environment, error: &anyhow::Error) -> Result<()> {
    journal.transaction(|state| {
        let report=state.environments.get_mut(&target.id).filter(|e|e.generation==target.generation).and_then(|e|e.setup.as_mut()).context("Setup history missing")?;
        report["status"]=json!("outcomeUnknown");report["detail"]=json!(crate::remote::protocol::redact(&format!("Setup interrupted: {error:#}. Inspect retained progress; installers were not replayed.")));Ok(())
    })
}

pub fn busy(env: &Environment) -> bool {
    let Some(report) = &env.setup else {
        return false;
    };
    if report["protocol"] != PROTOCOL
        || report["environmentId"] != env.id
        || report["generation"] != env.generation
    {
        return true;
    }
    !ready(env, report)
}

pub fn ready(env: &Environment, report: &Value) -> bool {
    let read = &report["readiness"];
    let proof = &report["desktopVerification"];
    let ids = [
        "tools",
        "vm",
        "transport",
        "runtime",
        "driver",
        "accessibility",
        "screenRecording",
        "provider",
        "desktop",
    ];
    report["status"] == "ready"
        && report["environmentId"] == env.id
        && report["generation"] == env.generation
        && report["steps"].as_array().is_some_and(|steps| {
            steps.len() == ids.len()
                && ids.iter().all(|id| {
                    steps
                        .iter()
                        .filter(|s| s["id"] == *id && s["state"] == "complete")
                        .count()
                        == 1
                })
        })
        && check_binding(env, report["harness"].as_str().unwrap_or(""), read).is_ok()
        && read["runtime"]["executableSha256"].as_str()
            == bootstrap::owner_runtime_sha256().ok().as_deref()
        && read["runtime"]["executableSha256"].is_string()
        && matches!(read["driver"]["state"].as_str(), Some("ready" | "running"))
        && read["driver"]["installedVersion"] == super::desktop::DRIVER_VERSION
        && read["driver"]["installedExecutableSha256"] == bootstrap::DRIVER.executable_sha256
        && read["accessibility"]["state"] == "granted"
        && read["screenRecording"]["state"] == "granted"
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
        && proof["captureVerified"] == true
        && proof["desktopUsable"] == true
        && proof["bootIdentity"]
            .as_str()
            .is_some_and(|s| journal::validate_id(s).is_ok())
        && proof["bootIdentity"] == read["runtime"]["bootIdentity"]
        && proof["driverExecutableSha256"]
            .as_str()
            .is_some_and(|s| s.len() == 64)
        && proof["driverExecutableSha256"] == read["driver"]["installedExecutableSha256"]
        && proof["verifiedAt"]
            .as_str()
            .is_some_and(|at| chrono::DateTime::parse_from_rfc3339(at).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Journal, Environment, Value) {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let env = journal.enroll("Guest", "local:test").unwrap();
        let params = json!({"environmentId":env.id,"generation":env.generation,"harness":"codex","idempotencyKey":"setup-1","confirm":true});
        (dir, journal, env, params)
    }

    #[test]
    fn queue_retry_recovers_receipt_without_new_work_and_recovery_preserves_unknown() {
        let (_dir, journal, env, params) = fixture();
        let original = queue(&journal, params.clone()).unwrap();
        journal
            .transaction(|state| {
                state.environments.get_mut(&env.id).unwrap().manual_control = true;
                Ok(())
            })
            .unwrap();
        assert_eq!(queue(&journal, params.clone()).unwrap(), original);
        let mut changed = params.clone();
        changed["idempotencyKey"] = json!("setup-2");
        assert!(queue(&journal, changed.clone()).is_err());
        journal
            .transaction(|state| {
                let env = state.environments.get_mut(&env.id).unwrap();
                env.manual_control = false;
                env.provision = Some(json!({"status":"outcomeUnknown","original":"retained"}));
                let report = env.setup.as_mut().unwrap();
                report["status"] = json!("outcomeUnknown");
                report["operations"] =
                    json!({"old-action":{"receipt":{"status":"outcomeUnknown"}}});
                Ok(())
            })
            .unwrap();
        let prior = journal.read().unwrap().environments[&env.id].clone();
        let recovery = queue(&journal, changed).unwrap();
        assert_eq!(recovery["history"][0], prior.setup.unwrap());
        assert_eq!(
            recovery["operations"]["old-action"]["receipt"]["status"],
            "outcomeUnknown"
        );
        assert_eq!(recovery["reconcileExistingProvision"], true);
        assert_eq!(
            journal.read().unwrap().environments[&env.id].provision,
            prior.provision
        );
        let mut wrong = params;
        wrong["generation"] = json!(journal::new_id());
        assert!(queue(&journal, wrong).is_err());
    }

    fn action_params(env: &Environment, key: &str) -> Value {
        json!({"environmentId":env.id,"generation":env.generation,"action":"driver.start","idempotencyKey":key,"confirm":true})
    }

    #[test]
    fn action_intent_precedes_effect_and_lost_reply_never_replays() {
        let (_dir, journal, env, params) = fixture();
        queue(&journal, params).unwrap();
        let request = action_params(&env, "action-1");
        let receipt = action_using(&journal, request.clone(), |_, _| {
            let state = journal.read()?;
            assert_eq!(
                state.environments[&env.id].setup.as_ref().unwrap()["operations"]["action-1"]
                    ["receipt"]["status"],
                "working"
            );
            bail!("lost acknowledgement")
        })
        .unwrap();
        assert_eq!(receipt["status"], "outcomeUnknown");
        journal
            .transaction(|state| {
                state.environments.get_mut(&env.id).unwrap().manual_control = true;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            action_using(&journal, request.clone(), |_, _| panic!("must not replay")).unwrap(),
            receipt
        );
        let mut changed = request;
        changed["action"] = json!("desktop.verify");
        assert!(action_using(&journal, changed, |_, _| panic!(
            "changed key must not send"
        ))
        .is_err());
    }

    #[test]
    fn action_failure_to_persist_intent_prevents_delivery() {
        let (dir, journal, env, params) = fixture();
        queue(&journal, params).unwrap();
        std::fs::write(dir.path().join("journal.json"), b"corrupt").unwrap();
        assert!(
            action_using(&journal, action_params(&env, "action-1"), |_, _| panic!(
                "no durable intent"
            ))
            .is_err()
        );
    }

    #[test]
    fn malformed_reply_and_sensitive_extra_fields_cannot_become_durable_success() {
        let (_dir, journal, env, params) = fixture();
        queue(&journal, params).unwrap();
        let receipt=action_using(&journal,action_params(&env,"action-1"),|_,_|Ok(json!({"action":"driver.start","idempotencyKey":"wrong","status":"complete","challenge":{"userCode":"SECRET"}}))).unwrap();
        assert_eq!(receipt["status"], "outcomeUnknown");
        let safe = safe_receipt(
            &json!({"action":"desktop.verify","idempotencyKey":"key","status":"complete","detail":"SECRET","challenge":{"userCode":"SECRET"},"verification":{"bootIdentity":{"userCode":"SECRET"}}}),
        );
        assert!(safe.get("verification").is_none());
        assert!(!serde_json::to_string(&safe).unwrap().contains("SECRET"));
        assert!(!serde_json::to_string(&journal.read().unwrap())
            .unwrap()
            .contains("SECRET"));
    }

    #[test]
    fn only_exact_live_cancel_can_follow_owned_login_start() {
        let (_dir, journal, env, params) = fixture();
        queue(&journal, params).unwrap();
        let mut start = action_params(&env, "login-start");
        start["action"] = json!("provider.codexDeviceLogin.start");
        action_using(&journal,start.clone(),|_,_|Ok(json!({"action":"provider.codexDeviceLogin.start","idempotencyKey":"login-start","status":"needsAttention"}))).unwrap();
        assert!(
            action_using(&journal, action_params(&env, "another"), |_, _| panic!(
                "busy"
            ))
            .is_err()
        );
        let cancel = json!({"environmentId":env.id,"generation":env.generation,"action":"provider.codexDeviceLogin.cancel","idempotencyKey":"cancel-new","confirm":true,"loginId":journal::new_id()});
        let receipt=action_using(&journal,cancel,|_,params|Ok(json!({"action":params["action"],"idempotencyKey":params["idempotencyKey"],"status":"complete"}))).unwrap();
        assert_eq!(receipt["status"], "complete");
        let saved = serde_json::to_string(&journal.read().unwrap()).unwrap();
        assert!(!saved.contains("loginId"));
    }

    #[test]
    fn ready_requires_bound_current_boot_capture_and_serving_executable() {
        let (_dir, _journal, env, _) = fixture();
        let mut report = initial(&env, "codex", "key").unwrap();
        report["status"] = json!("ready");
        for step in report["steps"].as_array_mut().unwrap() {
            step["state"] = json!("complete");
        }
        let boot = journal::new_id();
        let sha = bootstrap::DRIVER.executable_sha256;
        report["readiness"] = json!({"protocol":1,"environmentId":env.id,"generation":env.generation,
            "runtime":{"identity":{"protocol":journal::PROTOCOL,"environmentId":env.id,"generation":env.generation},"executableSha256":bootstrap::owner_runtime_sha256().unwrap(),"bootIdentity":boot},
            "driver":{"state":"ready","installedVersion":super::super::desktop::DRIVER_VERSION,"installedExecutableSha256":sha},
            "accessibility":{"state":"granted"},"screenRecording":{"state":"granted"},"provider":{"harness":"codex","state":"authenticated"},
            "manualControl":false,"activeTaskTargets":[],"actionAdmission":{"state":"ready"}});
        report["desktopVerification"] = json!({"bootIdentity":boot,"driverExecutableSha256":sha,"verifiedAt":journal::now(),"captureVerified":true,"desktopUsable":true});
        assert!(ready(&env, &report));
        report["readiness"]["driver"]["state"] = json!("running");
        assert!(ready(&env, &report));
        let mut explicit = report.clone();
        explicit["readiness"]["provider"]["evidence"] = json!("recentExplicitLocalAccountReceipt");
        assert!(!ready(&env, &explicit));
        explicit["readiness"]["provider"]["validUntil"] =
            json!((chrono::Utc::now() + chrono::Duration::minutes(1)).to_rfc3339());
        assert!(ready(&env, &explicit));
        explicit["readiness"]["provider"]["validUntil"] =
            json!((chrono::Utc::now() - chrono::Duration::seconds(1)).to_rfc3339());
        assert!(!ready(&env, &explicit));
        for (path, value) in [
            ("/runtime/executableSha256", json!("b".repeat(64))),
            ("/runtime/bootIdentity", json!(journal::new_id())),
            ("/manualControl", json!(true)),
            ("/activeTaskTargets", json!([{}])),
            ("/driver/installedExecutableSha256", json!("b".repeat(64))),
        ] {
            let mut changed = report.clone();
            *changed["readiness"].pointer_mut(path).unwrap() = value;
            assert!(!ready(&env, &changed), "{path}");
        }
        report["desktopVerification"]["verifiedAt"] = Value::Null;
        assert!(!ready(&env, &report));
    }
}
