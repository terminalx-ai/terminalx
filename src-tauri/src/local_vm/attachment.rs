//! Host MCP adapter for one exact macOS guest and parent conversation.
//! The marker fences task/setup admission; the retained record outlives the
//! proxy. Only a bound guest release receipt removes that marker.
use super::{
    admission::{read_marker, Guard},
    host,
    journal::{self, Environment, Journal},
};
use crate::computer_targets::Target;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Read, Write},
    path::{Path, PathBuf},
};

type Rpc<'a> = dyn FnMut(&Environment, &str, Value) -> Result<Value> + 'a;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Binding {
    pub environment_id: String,
    pub generation: String,
    pub lease_id: String,
    pub session_id: String,
    pub tab_id: String,
    pub conversation: Option<String>,
}
impl Binding {
    fn target(&self) -> Target {
        Target::MacosGuest {
            environment_id: self.environment_id.clone(),
            generation: self.generation.clone(),
        }
    }
    fn validate(&self) -> Result<()> {
        for id in [
            &self.environment_id,
            &self.generation,
            &self.lease_id,
            &self.session_id,
            &self.tab_id,
        ] {
            journal::validate_id(id)?;
        }
        if self.conversation.as_ref().is_some_and(|s| s.len() > 512) {
            bail!("Conversation identity exceeds its bound");
        }
        Ok(())
    }
}

fn environment(journal: &Journal, target: &Target) -> Result<Environment> {
    let Target::MacosGuest {
        environment_id,
        generation,
    } = target
    else {
        bail!("macOS attachment requires an exact macOS target");
    };
    let state = journal.read()?;
    if !state.enabled {
        bail!("Local VM controller is disabled");
    }
    let env = state
        .environments
        .get(environment_id)
        .filter(|env| env.generation == *generation && env.deleted_at.is_none())
        .context("Selected macOS environment was replaced or removed; no fallback")?;
    env.transport.require_macos()?;
    Ok(env.clone())
}
fn quiescent(journal: &Journal, env: &Environment) -> Result<()> {
    let state = journal.read()?;
    if env.manual_control
        || super::setup::busy(env)
        || state
            .tasks
            .values()
            .any(|task| task.target.environment_id == env.id && !task.status.terminal())
        || env.provision.as_ref().is_some_and(|p| {
            !matches!(
                p["status"].as_str(),
                Some("completed" | "canceled" | "failed")
            )
        })
    {
        bail!("This environment has unfinished task, setup or manual work");
    }
    Ok(())
}
fn validate_catalog(value: &Value) -> Result<()> {
    let tools = value.as_array().context("Guest desktop catalog missing")?;
    if tools.is_empty() {
        bail!("Guest desktop catalog is empty");
    }
    let mut names = std::collections::BTreeSet::new();
    for tool in tools {
        let name = tool["name"].as_str().context("Guest tool name missing")?;
        if !names.insert(name) || tool["inputSchema"]["type"] != "object" {
            bail!("Guest tool schema is invalid");
        }
        super::desktop::check_capability_request(
            &json!({"method":"tools/call","params":{"name":name,"arguments":{}}}),
        )?;
    }
    Ok(())
}
fn check_using(journal: &Journal, target: &Target, rpc: &mut Rpc<'_>) -> Result<Value> {
    let env = environment(journal, target)?;
    quiescent(journal, &env)?;
    let response = rpc(&env, "desktop.attachmentCapabilities", json!({}))?;
    if response["attachmentProtocol"] != 1
        || response["platform"] != "macos"
        || response["environmentId"] != env.id
        || response["generation"] != env.generation
        || response["available"] != true
    {
        bail!("Guest does not support the exact macOS attachment contract");
    }
    super::transport::validate_runtime_sha(
        response["runtimeSha256"]
            .as_str()
            .context("Guest runtime digest missing")?,
    )?;
    Ok(
        json!({"target":target,"available":true,"runtimeSha256":response["runtimeSha256"],
        "detail":"Guest desktop route is available. Tool permissions and application attestation are checked by the guest; live acceptance is separate."}),
    )
}
/// Discovery opens a temporary, fully retained lease. An uncertain helper exit
/// leaves the same recovery marker as an uncertain attached call.
pub fn check(
    target: &Target,
    session_id: &str,
    tab_id: &str,
    conversation: Option<String>,
) -> Result<Value> {
    let Target::MacosGuest {
        environment_id,
        generation,
    } = target
    else {
        bail!("Exact macOS target required");
    };
    let binding = Binding {
        environment_id: environment_id.clone(),
        generation: generation.clone(),
        lease_id: journal::new_id(),
        session_id: session_id.into(),
        tab_id: tab_id.into(),
        conversation,
    };
    binding.validate()?;
    let entry = crate::store::index::get(session_id)?;
    let tab = entry
        .tab(tab_id)
        .context("Discovery parent tab is unavailable")?;
    if tab.follow.conversation != binding.conversation {
        bail!("Discovery parent conversation changed");
    }
    probe_using(
        &host::root()?,
        &host::journal()?,
        binding,
        &mut host::guest_rpc,
    )
}
pub(super) fn probe_using(
    root: &Path,
    journal: &Journal,
    binding: Binding,
    rpc: &mut Rpc<'_>,
) -> Result<Value> {
    let mut adapter = Adapter::begin(root, journal, binding, rpc)?;
    let tools = adapter.tools(rpc);
    let response = json!({"target":adapter.binding.target(),"available":true,"runtimeSha256":adapter.record["runtimeSha256"],
        "tools":tools.as_ref().ok().map(|value|value["tools"].clone()),
        "detail":"Guest desktop tools and discovery exit verified. Application permissions and live acceptance remain separate."});
    let closed = adapter.close(rpc);
    tools?;
    closed?;
    Ok(response)
}
fn parent(binding: &Binding) -> Result<()> {
    let entry = crate::store::index::get(&binding.session_id)?;
    let tab = entry
        .tab(&binding.tab_id)
        .context("Attachment parent tab is unavailable")?;
    parent_selection(binding, tab)
}
fn parent_selection(binding: &Binding, tab: &crate::store::index::TabEntry) -> Result<()> {
    let selection = crate::computer_targets::selected(tab)?;
    if selection.conversation != binding.conversation || selection.target != Some(binding.target())
    {
        bail!("Parent conversation or selected computer changed; no input was routed");
    }
    Ok(())
}
fn path(root: &Path, binding: &Binding) -> PathBuf {
    root.join("macos-attachments")
        .join(format!("{}.json", binding.lease_id))
}
fn retain(root: &Path, binding: &Binding, record: &Value) -> Result<()> {
    journal::private_directory(&root.join("macos-attachments"))?;
    let bytes = serde_json::to_vec(record)?;
    if bytes.len() > 128 * 1024 * 1024 {
        bail!("Attachment retention limit reached; ownership remains fenced");
    }
    journal::atomic_private_write(&path(root, binding), &bytes)
}
fn load(root: &Path, binding: &Binding) -> Result<Value> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut bytes = Vec::new();
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path(root, binding))?
        .take(128 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 128 * 1024 * 1024 {
        bail!("Attachment history exceeds its bound");
    }
    let value: Value = serde_json::from_slice(&bytes)?;
    if value["binding"] != json!(binding) {
        bail!("Attachment history identity changed");
    }
    Ok(value)
}
fn receipt(binding: &Binding, value: &Value) -> Result<()> {
    if value["binding"] != json!(binding) {
        bail!("Guest attachment receipt has a different identity");
    }
    Ok(())
}

pub(super) struct Adapter<'a> {
    root: &'a Path,
    journal: &'a Journal,
    binding: Binding,
    record: Value,
    guard: Guard,
}
impl<'a> Adapter<'a> {
    pub(super) fn begin(
        root: &'a Path,
        journal: &'a Journal,
        binding: Binding,
        rpc: &mut Rpc<'_>,
    ) -> Result<Self> {
        binding.validate()?;
        let target = binding.target();
        let guard = Guard::acquire(root, &target)?;
        let checked = check_using(journal, &target, rpc)?;
        let env = environment(journal, &target)?;
        if path(root, &binding).try_exists()? {
            bail!("Attachment ID already has retained history; inspect it before reopening");
        }
        let mut record = json!({"binding":binding,"target":target,"sandbox":env.sandbox,"runtimeSha256":checked["runtimeSha256"],"status":"acquiring","calls":{},"createdAt":journal::now()});
        retain(root, &binding, &record)?;
        journal::atomic_private_write(
            &guard.marker,
            &serde_json::to_vec(
                &json!({"target":target,"binding":binding,"status":"awaitingGuestRelease"}),
            )?,
        )?;
        let acquired = rpc(&env, "desktop.attachmentAcquire", json!(binding))?;
        receipt(&binding, &acquired)?;
        if !acquired["releasedAt"].is_null() || !acquired["calls"].is_object() {
            bail!("Guest lease is already released or invalid");
        }
        record["status"] = json!("held");
        record["guestLease"] = acquired;
        retain(root, &binding, &record)?;
        Ok(Self {
            root,
            journal,
            binding,
            record,
            guard,
        })
    }
    fn env(&self) -> Result<Environment> {
        let env = environment(self.journal, &self.binding.target())?;
        if self.record["sandbox"] != env.sandbox {
            bail!("Selected VM transport changed");
        }
        Ok(env)
    }
    pub(super) fn tools(&mut self, rpc: &mut Rpc<'_>) -> Result<Value> {
        let value = rpc(&self.env()?, "desktop.attachmentTools", json!(self.binding))?;
        receipt(&self.binding, &value)?;
        validate_catalog(&value["tools"])?;
        Ok(json!({"tools":value["tools"]}))
    }
    pub(super) fn call(&mut self, request: &Value, rpc: &mut Rpc<'_>) -> Result<Value> {
        super::desktop::check_capability_request(request)?;
        let id = request
            .get("id")
            .filter(|id| id.is_string() || id.is_i64() || id.is_u64())
            .context("MCP call ID required")?;
        let key = format!("mcp-{}", journal::digest(&serde_json::to_vec(id)?));
        let input_digest = journal::digest(&serde_json::to_vec(request)?);
        if let Some(prior) = self.record["calls"].get(&key) {
            if prior["inputDigest"] != input_digest {
                bail!("MCP call ID already names different input");
            }
            if prior["status"] != "complete" {
                bail!("Original call outcome is unknown; inspect retained receipts, never replay input");
            }
            return Ok(prior["result"].clone());
        }
        if self.record["calls"]
            .as_object()
            .context("Damaged call history")?
            .values()
            .any(|call| call["status"] != "complete")
        {
            bail!("Unknown desktop outcome fences new input");
        }
        let env = self.env()?;
        let mut params = json!(self.binding);
        params["idempotencyKey"] = json!(key);
        params["tool"] = request["params"]["name"].clone();
        params["arguments"] = request["params"]
            .get("arguments")
            .cloned()
            .unwrap_or(json!({}));
        let guest_digest = journal::digest(&serde_json::to_vec(&params)?);
        self.record["calls"][&key] = json!({"inputDigest":input_digest,"guestInputDigest":guest_digest,"status":"outcomeUnknown","request":request});
        retain(self.root, &self.binding, &self.record)?;
        let result = rpc(&env, "desktop.attachmentCall", params)?;
        if result["idempotencyKey"] != key
            || result["inputDigest"] != guest_digest
            || result["status"] != "complete"
            || !result["result"]["content"].is_array()
        {
            bail!("Guest call receipt is unavailable or unknown; input remains fenced");
        }
        self.record["calls"][&key]["status"] = json!("complete");
        self.record["calls"][&key]["result"] = result["result"].clone();
        retain(self.root, &self.binding, &self.record)?;
        Ok(result["result"].clone())
    }
    fn close(mut self, rpc: &mut Rpc<'_>) -> Result<()> {
        let value = rpc(&self.env()?, "desktop.attachmentClose", json!(self.binding))?;
        self.release(value)
    }
    fn release(&mut self, value: Value) -> Result<()> {
        receipt(&self.binding, &value)?;
        if !value["releasedAt"]
            .as_str()
            .is_some_and(|at| chrono::DateTime::parse_from_rfc3339(at).is_ok())
            || !matches!(
                value["releaseProof"]["kind"].as_str(),
                Some("allCallsReceipted" | "laterKernelBoot" | "neverAcquiredTombstone")
            )
        {
            bail!("Guest release receipt is unconfirmed");
        }
        self.record["status"] = json!("released");
        self.record["guestLease"] = value;
        retain(self.root, &self.binding, &self.record)?;
        // Keep the complete record; only remove the admission pointer.
        std::fs::remove_file(&self.guard.marker)?;
        std::fs::File::open(self.guard.marker.parent().context("Admission root")?)?.sync_all()?;
        Ok(())
    }
}

pub fn inspect(target: &Target) -> Result<Value> {
    recover_using(
        &host::root()?,
        &host::journal()?,
        target,
        None,
        &mut host::guest_rpc,
    )
}
pub fn reconcile(target: &Target, binding: Binding, confirm: bool) -> Result<Value> {
    if !confirm {
        bail!("Confirm release of this exact retained guest attachment");
    }
    recover_using(
        &host::root()?,
        &host::journal()?,
        target,
        Some(binding),
        &mut host::guest_rpc,
    )
}
pub(super) fn recover_using(
    root: &Path,
    journal: &Journal,
    target: &Target,
    confirmed: Option<Binding>,
    rpc: &mut Rpc<'_>,
) -> Result<Value> {
    let guard = Guard::lock(root, target)?;
    if !guard.marker.try_exists()? {
        return Ok(json!({"target":target,"status":"unreserved"}));
    }
    let marker: Value = serde_json::from_slice(&read_marker(&guard.marker)?)?;
    let binding: Binding = serde_json::from_value(marker["binding"].clone())?;
    binding.validate()?;
    if binding.target() != *target || marker["target"] != json!(target) {
        bail!("Retained attachment target changed");
    }
    if confirmed
        .as_ref()
        .is_some_and(|expected| expected != &binding)
    {
        bail!("Attachment identity changed; inspect again");
    }
    let record = load(root, &binding)?;
    let mut adapter = Adapter {
        root,
        journal,
        binding: binding.clone(),
        record,
        guard,
    };
    let env = adapter.env()?;
    let method = if confirmed.is_some() {
        "desktop.attachmentRelease"
    } else {
        "desktop.attachmentRead"
    };
    let mut params = json!(binding);
    if confirmed.is_some() {
        params["confirm"] = json!(true);
    }
    let value = rpc(&env, method, params)?;
    receipt(&binding, &value)?;
    if confirmed.is_some() {
        adapter.release(value)?;
        return Ok(
            json!({"target":target,"binding":binding,"status":"released","detail":"Guest release confirmed. Retained calls and any unknown outcomes remain in history; no input was replayed."}),
        );
    }
    adapter.record["guestObservation"] = value.clone();
    retain(root, &binding, &adapter.record)?;
    Ok(
        json!({"target":target,"binding":binding,"status":if value["releaseAvailable"]==true {"releaseAvailable"} else {"fenced"},
        "calls":adapter.record["calls"],"guestLease":value,"detail":"Inspect the original guest attachment. Only a current guest release receipt can clear its reservation."}),
    )
}

pub fn launch_args(
    session_id: &str,
    tab: &crate::store::index::TabEntry,
    target: &Target,
    appends_prompt: bool,
) -> Result<String> {
    let Target::MacosGuest {
        environment_id,
        generation,
    } = target
    else {
        bail!("macOS target required");
    };
    if !matches!(tab.harness.as_str(), "codex" | "claude") {
        bail!("This agent does not support attached desktop tools");
    }
    let binding = Binding {
        environment_id: environment_id.clone(),
        generation: generation.clone(),
        lease_id: journal::new_id(),
        session_id: session_id.into(),
        tab_id: tab.id.clone(),
        conversation: tab.follow.conversation.clone(),
    };
    binding.validate()?;
    let executable = std::env::current_exe()?;
    let home = crate::store::root()?;
    Ok(crate::container_vm::mcp_args(
        &tab.harness,
        &executable.to_string_lossy(),
        &[
            "macos-computer-stdio",
            &serde_json::to_string(&binding)?,
            &home.to_string_lossy(),
        ],
        appends_prompt,
        "The computer MCP tools act only in the selected macOS guest, in the background. The parent agent shell and project files stay in their current environment. Run task in VM is a separate action. Respect guest ownership, permissions and application attestation; never switch targets or replay unknown input.",
    ))
}

fn serve(binding: Binding, input: &mut impl BufRead, output: &mut impl Write) -> Result<()> {
    let root = host::root()?;
    let journal = host::journal()?;
    serve_using(
        &root,
        &journal,
        binding,
        input,
        output,
        &mut host::guest_rpc,
        &mut parent,
    )
}
pub(super) fn serve_using(
    root: &Path,
    journal: &Journal,
    binding: Binding,
    input: &mut impl BufRead,
    output: &mut impl Write,
    rpc: &mut Rpc<'_>,
    check_parent: &mut dyn FnMut(&Binding) -> Result<()>,
) -> Result<()> {
    check_parent(&binding)?;
    let mut adapter = Adapter::begin(root, journal, binding, rpc)?;
    let mut initialized = false;
    let mut announced = false;
    loop {
        let mut line = String::new();
        let count = input.take(1024 * 1024 + 1).read_line(&mut line)?;
        if count == 0 {
            break;
        }
        if count > 1024 * 1024 || !line.ends_with('\n') {
            bail!("MCP input exceeds its bound");
        }
        let request: Value = serde_json::from_str(&line)?;
        check_parent(&adapter.binding)?;
        if request["jsonrpc"] != "2.0" {
            bail!("JSON-RPC 2.0 is required");
        }
        let method = request["method"].as_str().context("MCP method required")?;
        if method == "notifications/initialized" && initialized && request.get("id").is_none() {
            announced = true;
            continue;
        }
        if !request
            .get("id")
            .is_some_and(|id| id.is_string() || id.is_i64() || id.is_u64())
        {
            bail!("A string or integer MCP request ID is required");
        }
        let result = match method {
            "initialize" if !initialized && request["params"]["protocolVersion"].is_string() => {
                initialized = true;
                Ok(
                    json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"terminalx-macos-attachment","version":"1"},"instructions":"Desktop tools act only in the selected guest. Shell and project files remain in the parent. Run task in VM is a separate action."}),
                )
            }
            "ping" => Ok(json!({})),
            "tools/list" if announced && request["params"].get("cursor").is_none() => {
                adapter.tools(rpc)
            }
            "tools/call" if announced => adapter.call(&request, rpc),
            _ => Err(anyhow::anyhow!("Unsupported MCP method or lifecycle state")),
        };
        let response = match result {
            Ok(result) => json!({"jsonrpc":"2.0","id":request["id"],"result":result}),
            Err(error) => {
                json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":error.to_string()}})
            }
        };
        writeln!(output, "{}", response)?;
        output.flush()?;
    }
    adapter.close(rpc)
}

pub fn run_stdio_cli() -> Option<i32> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("macos-computer-stdio") {
        return None;
    }
    let result = (|| {
        if args.len() != 3 || !Path::new(&args[2]).is_absolute() {
            bail!("Exact macOS binding and owner home required");
        }
        std::env::set_var("TERMINALX_HOME", &args[2]);
        let binding: Binding = serde_json::from_str(&args[1])?;
        serve(
            binding,
            &mut std::io::stdin().lock(),
            &mut std::io::stdout().lock(),
        )
    })();
    if let Err(error) = &result {
        eprintln!("macOS attachment: {error:#}");
    }
    Some(if result.is_ok() { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parent_generation_and_installed_capability_are_required_without_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let env = journal.enroll("Mac fixture", "local:fixture").unwrap();
        journal
            .transaction(|s| {
                s.enabled = true;
                Ok(())
            })
            .unwrap();
        let binding = Binding {
            environment_id: env.id.clone(),
            generation: env.generation.clone(),
            lease_id: journal::new_id(),
            session_id: journal::new_id(),
            tab_id: journal::new_id(),
            conversation: Some("old".into()),
        };
        let mut tab: crate::store::index::TabEntry =
            serde_json::from_value(json!({"id":binding.tab_id,"harness":"codex","created":"now"}))
                .unwrap();
        tab.follow.conversation = binding.conversation.clone();
        crate::computer_targets::save(
            &mut tab,
            binding.conversation.clone(),
            Some(binding.target()),
        )
        .unwrap();
        parent_selection(&binding, &tab).unwrap();
        tab.follow.conversation = Some("replacement".into());
        assert!(parent_selection(&binding, &tab).is_err());
        let valid = json!({"attachmentProtocol":1,"platform":"macos","environmentId":env.id,"generation":env.generation,"available":true,"runtimeSha256":"b".repeat(64),"tools":[{"name":"list_windows","inputSchema":{"type":"object"}}]});
        check_using(
            &journal,
            &binding.target(),
            &mut |_, _, _| Ok(valid.clone()),
        )
        .unwrap();
        for (key, value) in [
            ("generation", json!(journal::new_id())),
            ("platform", json!("linux")),
            ("attachmentProtocol", json!(0)),
        ] {
            let mut bad = valid.clone();
            bad[key] = value;
            assert!(
                check_using(&journal, &binding.target(), &mut |_, _, _| Ok(bad.clone())).is_err(),
                "{key}"
            );
        }
        assert!(
            validate_catalog(&json!([{ "name":"shell","inputSchema":{"type":"object"}}])).is_err()
        );
        assert!(validate_catalog(&json!([])).is_err());
        let mut changed = binding.clone();
        changed.generation = journal::new_id();
        assert!(
            check_using(&journal, &changed.target(), &mut |_, _, _| panic!(
                "routed replaced target"
            ))
            .is_err()
        );
    }
}
