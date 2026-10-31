//! Retained guest transport identity. Names are display metadata, never routing
//! selectors. Existing journals deserialize to the original macOS transport.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

use crate::computer_targets::{Capability, Runtime, Target};
use super::{journal::Environment, process};

pub const LINUX_INSTALL: &str = "/home/cua/.terminalx-local";

pub(super) fn validate_runtime_sha(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("Verified Linux runtime SHA256 required");
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Enrollment { name: String, target: Target, runtime_sha256: String }

/// Bind an already installed runtime. A running XFCE container alone does not
/// qualify, and this operation never installs tools or signs into a provider.
pub(super) fn enroll(journal: &super::journal::Journal, params: Value) -> Result<Value> {
    let request: Enrollment = serde_json::from_value(params)?;
    validate_runtime_sha(&request.runtime_sha256)?;
    request.target.require(Capability::GuestTask)?;
    let Target::LinuxGuest { runtime, id, environment_id, generation } = &request.target else { bail!("Linux guest target required"); };
    super::journal::validate_id(environment_id)?;
    super::journal::validate_id(generation)?;
    let root = super::host::root()?;
    let _guard = super::admission::Guard::acquire(&root, &request.target)?;
    let env = Environment {
        transport: Transport::LinuxContainer { runtime: *runtime, id: id.clone(), runtime_sha256: request.runtime_sha256.clone() },
        id: environment_id.clone(), name: request.name.clone(), sandbox: format!("container:{}:{id}", runtime.name()),
        generation: generation.clone(), created_at: super::journal::now(), deleted_at: None,
        keep_awake: false, owned: false, provision: None, manual_control: false, setup: None,
    };
    let description = linux_rpc(&env, "describe", json!({}), Duration::from_secs(45))?;
    validate_description(&env, &description)?;
    let env = journal.enroll_container(&request.name, &request.target, &request.runtime_sha256)?;
    super::host::record_manual_control(journal, &env, &description)?;
    serde_json::to_value(env).map_err(Into::into)
}

pub(super) fn validate_description(env: &Environment, description: &Value) -> Result<()> {
    let Transport::LinuxContainer { runtime_sha256, .. } = &env.transport else { bail!("Linux binding required"); };
    if description["environmentId"] != env.id || description["generation"] != env.generation
        || description["protocol"] != super::journal::PROTOCOL || description["platform"] != "linux"
        || description["runtimeSha256"] != *runtime_sha256 || description["taskMode"] != "shellFiles" || !description["manualControl"].is_boolean()
    { bail!("Container does not have the expected Linux task runtime/account binding; no enrollment was recorded"); }
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Transport {
    #[default]
    MacosLume,
    MacosPersonalized { binding: Box<super::macos_transport::Binding> },
    LinuxContainer { runtime: Runtime, id: String, #[serde(rename = "runtimeSha256")] runtime_sha256: String },
}

impl Transport {
    pub fn is_legacy_macos(&self) -> bool { matches!(self, Self::MacosLume) }
    pub fn is_macos(&self) -> bool { matches!(self, Self::MacosLume | Self::MacosPersonalized { .. }) }
    pub fn is_personalized(&self) -> bool { matches!(self, Self::MacosPersonalized { .. }) }
    pub fn installation(&self) -> Result<String> {
        Ok(match self {
            Self::MacosLume => super::host::GUEST_HOME.into(),
            Self::MacosPersonalized { binding } => binding.account.installation()?.to_string_lossy().into_owned(),
            Self::LinuxContainer { .. } => LINUX_INSTALL.into(),
        })
    }

    pub fn target(&self, environment_id: &str, generation: &str) -> Target {
        match self {
            Self::MacosLume | Self::MacosPersonalized { .. } => Target::MacosGuest {
                environment_id: environment_id.into(), generation: generation.into(),
            },
            Self::LinuxContainer { runtime, id, .. } => Target::LinuxGuest {
                runtime: *runtime, id: id.clone(), environment_id: environment_id.into(),
                generation: generation.into(),
            },
        }
    }

    pub fn container(&self) -> Option<Target> {
        match self {
            Self::MacosLume | Self::MacosPersonalized { .. } => None,
            Self::LinuxContainer { runtime, id, .. } => Some(Target::LinuxContainer { runtime: *runtime, id: id.clone() }),
        }
    }

    pub fn require_macos(&self) -> Result<()> {
        if !self.is_macos() {
            bail!("This operation requires a macOS Lume environment; no operation was routed");
        }
        Ok(())
    }
    pub fn require_legacy(&self) -> Result<()> {
        if !self.is_legacy_macos() { bail!("This legacy operation cannot use a personalized or Linux transport"); }
        Ok(())
    }
}

pub fn linux_rpc(env: &Environment, method: &str, params: Value, budget: Duration) -> Result<Value> {
    let Transport::LinuxContainer { runtime_sha256, .. } = &env.transport else { bail!("Linux binding required"); };
    validate_runtime_sha(runtime_sha256)?;
    let target = env.transport.container().context("Linux container binding required")?;
    let path = crate::container_vm::selected_runtime(&target)?;
    linux_rpc_at(&path, env, method, params, budget)
}

fn linux_rpc_at(path: &Path, env: &Environment, method: &str, mut params: Value, budget: Duration) -> Result<Value> {
    let Transport::LinuxContainer { runtime_sha256, .. } = &env.transport else { bail!("Linux binding required"); };
    validate_runtime_sha(runtime_sha256)?;
    let target = env.transport.container().context("Linux container binding required")?;
    target.require(Capability::AttachedDesktop)?;
    // Revalidate immediately before execution. An inspect/name race cannot
    // redirect exec: both inspect and exec use the immutable full container ID.
    crate::container_vm::validate_at(path, &target, budget)?;
    let Target::LinuxContainer { id, .. } = target else { unreachable!() };
    let object = params.as_object_mut().context("Guest RPC parameters must be an object")?;
    object.insert("environmentId".into(), json!(env.id));
    object.insert("generation".into(), json!(env.generation));
    let input = serde_json::to_vec(&json!({"method":method,"params":params,"expectedRuntimeSha256":runtime_sha256}))?;
    if input.len() > super::guest::MAX_RPC_BYTES { bail!("Guest RPC exceeds the request limit"); }
    let mut command = std::process::Command::new(path);
    // No -e NAME, env-file, mounts, shell interpolation, root or host tokens.
    // Docker/Podman exec -i carries only this bounded request to the helper.
    command.args(["exec", "-i", "--user", "cua", "--workdir", "/home/cua", &id,
        "/home/cua/.terminalx-local/bin/terminalx-serve", "local-vm-rpc", "-"]);
    process::remove_control_credentials(&mut command);
    decode(&process::run(&mut command, &input, budget)?)
}

pub(super) fn decode(bytes: &[u8]) -> Result<Value> {
    let response: Value = serde_json::from_slice(bytes).context("Invalid guest response")?;
    if response.get("ok") == Some(&Value::Bool(false)) {
        bail!("Guest request refused: {}", response.get("error").unwrap_or(&Value::Null));
    }
    if response.get("ok") != Some(&Value::Bool(true)) {
        bail!("Guest response did not acknowledge the authenticated RPC");
    }
    response.get("result").cloned().context("Guest response has no result")
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::journal::{new_id, Journal, TaskInput, TaskStatus};
    use std::os::unix::fs::PermissionsExt;

    fn input(environment_id: &str) -> TaskInput {
        TaskInput { parent_session_id: new_id(), parent_tab_id: new_id(), parent_message_id: "selected".into(),
            environment_id: environment_id.into(), prompt: "Only this selected task".into(), harness: "codex".into(),
            model: "gpt-6-astra".into(), effort: Some("xhigh".into()), permission_mode: "manual".into(), files: vec![], desktop: false }
    }

    #[test]
    fn actual_linux_rpc_routes_exact_id_and_retains_receipts_across_replacement() {
        for runtime in [Runtime::Docker, Runtime::Podman] {
            let dir = tempfile::tempdir().unwrap();
            let journal = Journal::open(&dir.path().join("journal")).unwrap();
            let target = Target::LinuxGuest { runtime, id: "a".repeat(64), environment_id: new_id(), generation: new_id() };
            let env = journal.enroll_container("Linux fixture", &target, &"e".repeat(64)).unwrap();
            let task = journal.submit_selected("once", input(&env.id), Some(&target)).unwrap();
            assert!(task.guest_cwd.starts_with("/home/cua/.terminalx-local/workspaces/"));
            assert_eq!(task.computer.as_ref(), Some(&target));
            let executable = dir.path().join("runtime-fixture");
            let script = r#"#!/usr/bin/env python3
import json,sys,pathlib
p=pathlib.Path(__file__).parent
a=sys.argv[1:]
if a[0]=='inspect':
 assert a==['inspect','--format','{{json .}}','a'*64]
 print((p/'inspection.json').read_text())
elif a[0]=='exec':
 assert a==['exec','-i','--user','cua','--workdir','/home/cua','a'*64,'/home/cua/.terminalx-local/bin/terminalx-serve','local-vm-rpc','-']
 req=json.load(sys.stdin)
 (p/'request.json').write_text(json.dumps(req))
 print((p/'reply.json').read_text())
else: sys.exit(72)
"#;
            std::fs::write(&executable, script).unwrap();
            std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
            let inspect = |id: &str, running: bool, label: &str| std::fs::write(dir.path().join("inspection.json"),
                json!({"Id":id,"State":{"Running":running},"Config":{"Labels":{"ai.terminalx.computer":label}}}).to_string()).unwrap();
            inspect(&"a".repeat(64), true, "1");
            std::fs::write(dir.path().join("reply.json"), json!({"ok":true,"result":task}).to_string()).unwrap();
            let result = linux_rpc_at(&executable, &env, "task.start", json!({"environmentId":"wrong","generation":"wrong","task":task,"files":[]}), Duration::from_secs(30)).unwrap();
            assert_eq!(result, serde_json::to_value(&task).unwrap());
            let request: Value = serde_json::from_slice(&std::fs::read(dir.path().join("request.json")).unwrap()).unwrap();
            assert_eq!(request["expectedRuntimeSha256"], "e".repeat(64));
            assert_eq!(request["params"]["environmentId"], env.id);
            assert_eq!(request["params"]["generation"], env.generation);
            assert_eq!(request["params"]["task"]["computer"], serde_json::to_value(&target).unwrap());
            for (id, running, label) in [("b".repeat(64), true, "1"), ("a".repeat(64), false, "1"), ("a".repeat(64), true, "0")] {
                std::fs::remove_file(dir.path().join("request.json")).unwrap();
                inspect(&id, running, label);
                assert!(linux_rpc_at(&executable, &env, "task.start", json!({"task":task,"files":[]}), Duration::from_secs(30)).is_err());
                assert!(!dir.path().join("request.json").exists());
                // Reset the sentinel only for the next fixture iteration.
                std::fs::write(dir.path().join("request.json"), "{}").unwrap();
            }
            journal.transaction(|state| { state.environments.get_mut(&env.id).unwrap().transport = Transport::LinuxContainer { runtime, id: "b".repeat(64), runtime_sha256: "e".repeat(64) }; Ok(()) }).unwrap();
            let reopened = Journal::open_existing(&dir.path().join("journal")).unwrap();
            assert_eq!(reopened.submit_selected("once", task.input.clone(), Some(&target)).unwrap(), task);
            assert!(reopened.submit_selected("different", task.input.clone(), Some(&target)).is_err());
            assert!(reopened.claim(&task.target).is_err());
            assert_eq!(reopened.read().unwrap().tasks.len(), 1);
        }
    }

    #[test]
    fn task_and_attached_desktop_admission_survive_waiting_unknown_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let target = Target::LinuxGuest { runtime: Runtime::Podman, id: "c".repeat(64), environment_id: new_id(), generation: new_id() };
        let env = journal.enroll_container("Guest", &target, &"e".repeat(64)).unwrap();
        let desktop = env.transport.container().unwrap();
        let attached = super::super::admission::Guard::attach(dir.path(), &desktop, &journal).unwrap();
        assert!(journal.submit_selected("task", input(&env.id), Some(&target)).is_err());
        attached.completed().unwrap();
        let task = journal.submit_selected("task", input(&env.id), Some(&target)).unwrap();
        for status in [TaskStatus::Queued, TaskStatus::Starting, TaskStatus::Waiting, TaskStatus::OutcomeUnknown, TaskStatus::Canceling] {
            journal.transaction(|s| { s.tasks.get_mut(&task.target.task_id).unwrap().status = status; Ok(()) }).unwrap();
            let reopened = Journal::open_existing(dir.path()).unwrap();
            assert!(super::super::admission::Guard::attach(dir.path(), &desktop, &reopened).is_err());
            assert_eq!(reopened.submit_selected("task", task.input.clone(), Some(&target)).unwrap().target, task.target);
        }
        journal.transaction(|s| { s.tasks.get_mut(&task.target.task_id).unwrap().status = TaskStatus::Completed; Ok(()) }).unwrap();
        super::super::admission::Guard::attach(dir.path(), &desktop, &journal).unwrap().completed().unwrap();
        assert_eq!(journal.read().unwrap().tasks.len(), 1);
    }

    #[test]
    fn guest_identity_platform_protocol_and_acknowledgment_are_required() {
        assert!(decode(br#"{"available":true}"#).is_err());
        assert!(decode(br#"{"ok":false,"error":{"message":"denied"}}"#).is_err());
        assert!(decode(br#"{"ok":true}"#).is_err());
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path()).unwrap();
        let target = Target::LinuxGuest { runtime: Runtime::Docker, id: "d".repeat(64), environment_id: new_id(), generation: new_id() };
        let env = journal.enroll_container("Guest", &target, &"e".repeat(64)).unwrap();
        let valid = json!({"environmentId":env.id,"generation":env.generation,"protocol":1,"platform":"linux","taskMode":"shellFiles","manualControl":false,"runtimeSha256":"e".repeat(64)});
        validate_description(&env, &valid).unwrap();
        for (key, value) in [("environmentId", json!(new_id())), ("generation", json!(new_id())), ("runtimeSha256", json!("f".repeat(64))), ("protocol", json!(99)), ("platform", json!("macos")), ("taskMode", json!("desktop")), ("manualControl", Value::Null)] {
            let mut changed = valid.clone(); changed[key] = value;
            assert!(validate_description(&env, &changed).is_err(), "{key}");
        }
    }
}
