//! Exact local computer identities shared by desktop attachment and guest tasks.
//! Capability support is a route contract, never evidence of guest readiness.
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use crate::store::index::TabEntry;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum Target {
    LinuxContainer { runtime: Runtime, id: String },
    LinuxGuest { runtime: Runtime, id: String, environment_id: String, generation: String },
    MacosGuest { environment_id: String, generation: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Runtime { Docker, Podman }
impl Runtime {
    pub fn name(self) -> &'static str { match self { Self::Docker => "docker", Self::Podman => "podman" } }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability { AttachedDesktop, GuestTask }

impl Target {
    pub fn require(&self, capability: Capability) -> Result<()> {
        match self {
            Self::LinuxContainer { id, .. } if id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()) => {},
            Self::LinuxGuest { id, environment_id, generation, .. } if id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()) && !environment_id.is_empty() && !generation.is_empty() => {},
            Self::MacosGuest { environment_id, generation } if !environment_id.is_empty() && !generation.is_empty() => {},
            _ => bail!("Invalid computer identity; select an existing environment again"),
        }
        if !matches!((self, capability), (Self::LinuxContainer { .. } | Self::MacosGuest { .. }, Capability::AttachedDesktop) | (Self::MacosGuest { .. } | Self::LinuxGuest { .. }, Capability::GuestTask)) {
            bail!("This environment does not support the requested agent route; no operation was routed");
        }
        Ok(())
    }
    pub fn guest(&self, environment_id: &str, generation: &str) -> Result<()> {
        self.require(Capability::GuestTask)?;
        let (actual_env, actual_generation) = match self {
            Self::MacosGuest { environment_id, generation } | Self::LinuxGuest { environment_id, generation, .. } => (environment_id, generation),
            _ => unreachable!(),
        };
        if actual_env != environment_id || actual_generation != generation {
            bail!("The selected environment was replaced or changed; select it again. No host fallback");
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub target: Target,
    pub name: String,
    pub capabilities: Vec<Capability>,
    pub state: String,
}

#[derive(Debug, Serialize)]
pub struct Inventory { pub entries: Vec<Entry>, pub notices: Vec<String> }

pub fn inventory() -> Result<Inventory> {
    let mut entries = Vec::new();
    let mut notices = Vec::new();
    for runtime in [Runtime::Docker, Runtime::Podman] {
        if let Some(path) = crate::binpath::resolve(runtime.name()) {
            match crate::container_vm::identity(&path, runtime) {
                Ok((target, running)) => entries.push(Entry { target, name: format!("Linux · {}", runtime.name()), capabilities: vec![Capability::AttachedDesktop], state: if running { "running" } else { "stopped" }.into() }),
                Err(error) => notices.push(format!("{}: {error:#}", runtime.name())),
            }
        }
    }
    #[cfg(unix)]
    {
        let state = crate::local_vm::host::journal()?.read()?;
        for env in state.environments.values().filter(|env| env.deleted_at.is_none()) {
            entries.push(Entry {
                target: env.transport.target(&env.id, &env.generation),
                name: format!("{} · {}", if env.transport.container().is_some() { "Linux tasks" } else { "macOS" }, env.name), capabilities: if env.transport.is_personalized() {vec![]} else if env.transport.is_macos() {vec![Capability::GuestTask,Capability::AttachedDesktop]} else {vec![Capability::GuestTask]},
                state: if env.transport.is_personalized() { "bootstrapUnavailable" } else if state.enabled { "requiresCapabilityCheck" } else { "disabled" }.into(),
            });
        }
    }
    Ok(Inventory { entries, notices })
}

const SELECTION: &str = "computerSelection";
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    pub version: u8,
    pub conversation: Option<String>,
    pub target: Option<Target>,
}

/// Absence means no attachment. Corrupt or old-conversation data is never
/// interpreted as permission to attach whichever environment happens to run.
pub fn selected(tab: &TabEntry) -> Result<Selection> {
    let Some(value) = tab.unknown.get(SELECTION) else {
        return Ok(Selection { version: 1, conversation: tab.follow.conversation.clone(), target: None });
    };
    let selection: Selection = serde_json::from_value(value.clone()).context("Unreadable computer selection; select again")?;
    if selection.version != 1 || selection.conversation != tab.follow.conversation {
        bail!("Computer selection belongs to another conversation or version; select again");
    }
    Ok(selection)
}

pub fn save(tab: &mut TabEntry, conversation: Option<String>, target: Option<Target>) -> Result<Selection> {
    if tab.follow.conversation != conversation { bail!("Conversation changed; refresh before selecting a computer"); }
    if let Some(target) = &target {
        target.require(Capability::AttachedDesktop)?;
        if !matches!(tab.harness.as_str(), "codex" | "claude") { bail!("This agent does not support attached desktop tools"); }
    }
    let selection = Selection { version: 1, conversation, target };
    tab.unknown.insert(SELECTION.into(), serde_json::to_value(&selection)?);
    Ok(selection)
}

pub fn launch_args(session_id:&str, tab: &TabEntry, appends_prompt: bool) -> Result<String> {
    match selected(tab)?.target {
        Some(target @ Target::MacosGuest {..}) => crate::local_vm::attachment::launch_args(session_id,tab,&target,appends_prompt),
        Some(target) => crate::container_vm::launch_selected(&target, &tab.harness, appends_prompt),
        None => Ok(String::new()),
    }
}

pub fn validate_attachment(target:&Target, session_id:&str, tab_id:&str, conversation:Option<String>)->Result<()> {
    match target { Target::MacosGuest {..}=>crate::local_vm::attachment::check(target,session_id,tab_id,conversation).map(|_|()),
        _=>crate::container_vm::selected_runtime(target).map(|_|()) }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectionRequest { session_id: String, tab_id: String, conversation: Option<String>, target: Option<Target> }

pub fn request(manager: &crate::session::SessionManager, method: &str, params: serde_json::Value) -> Result<serde_json::Value> {
    use serde_json::to_value;
    match method {
        "computer.activateLinuxRuntime" | "computer.reconcileLinuxActivation" | "computer.cancelLinuxActivation" => crate::local_vm::linux_activation::request(method,params),
        "computer.linuxInstaller" | "computer.prepareLinuxRuntime" | "computer.deliverLinuxRuntime" | "computer.reconcileLinuxRuntime" | "computer.enrollInstalledLinuxRuntime" => crate::local_vm::linux_install::request(method,params),
        "computer.inventory" => to_value(inventory()?).map_err(Into::into),
        "computer.checkAttachment" => {
            let target:Target=serde_json::from_value(params["target"].clone())?;
            crate::local_vm::attachment::check(&target,params["sessionId"].as_str().context("Parent session required")?,params["tabId"].as_str().context("Parent tab required")?,serde_json::from_value(params["conversation"].clone())?)
        }
        "computer.attachment" | "computer.reconcileAttachment" => {
            let target: Target = serde_json::from_value(params["target"].clone())?;
            if matches!(target,Target::MacosGuest {..}) {
                if method=="computer.attachment" {return crate::local_vm::attachment::inspect(&target);}
                return crate::local_vm::attachment::reconcile(&target,serde_json::from_value(params["binding"].clone())?,params["confirm"]==true);
            }
            let root = crate::local_vm::host::root()?;
            if method == "computer.attachment" { return crate::local_vm::admission::inspect(&root, &target); }
            crate::local_vm::admission::reconcile(&root, &target,
                params["markerDigest"].as_str().context("Exact inspected receipt is required")?, params["confirm"] == true)
        }
        "computer.viewer" => {
            let target: Target = serde_json::from_value(params["target"].clone())?;
            to_value(crate::container_vm::selected_status(&target)?).map_err(Into::into)
        }
        "computer.selection" | "computer.select" => {
            if method == "computer.select" && params.get("target").is_none() {
                bail!("An explicit target or null to clear the attachment is required");
            }
            let req: SelectionRequest = serde_json::from_value(params)?;
            if method == "computer.select" {
                return to_value(manager.select_computer(&req.session_id, &req.tab_id, req.conversation, req.target)?).map_err(Into::into);
            }
            let entry = crate::store::index::get(&req.session_id)?;
            let tab = entry.tab(&req.tab_id).context("Tab no longer exists")?;
            if tab.follow.conversation != req.conversation { bail!("Conversation changed; refresh before selecting a computer"); }
            to_value(selected(tab)?).map_err(Into::into)
        }
        _ => bail!("Unknown computer selection request"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn selection_reopens_exact_identity_and_refuses_corruption_or_conversation_change() {
        let mut tab: TabEntry = serde_json::from_value(json!({"id":"tab","harness":"codex","created":"now","unrelated":"kept"})).unwrap();
        assert!(launch_args("session", &tab, false).unwrap().is_empty());
        let target = Target::LinuxContainer { runtime: Runtime::Podman, id: "a".repeat(64) };
        save(&mut tab, None, Some(target.clone())).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("tab.json");
        std::fs::write(&path, serde_json::to_vec(&tab).unwrap()).unwrap();
        let mut reopened: TabEntry = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(selected(&reopened).unwrap().target, Some(target));
        assert_eq!(reopened.unknown["unrelated"], "kept");
        reopened.follow.conversation = Some("next".into());
        assert!(launch_args("session", &reopened, false).is_err());
        assert!(save(&mut reopened, None, None).is_err());
        save(&mut reopened, Some("next".into()), None).unwrap();
        assert!(launch_args("session", &reopened, false).unwrap().is_empty());
        reopened.unknown.insert(SELECTION.into(), json!({"version":999,"target":null,"conversation":"next"}));
        assert!(launch_args("session", &reopened, false).is_err());
    }

    #[test]
    fn routes_are_exclusive_and_unknown_targets_fail_closed() {
        let mac = Target::MacosGuest { environment_id: "env".into(), generation: "generation".into() };
        let linux = Target::LinuxContainer { runtime: Runtime::Docker, id: "a".repeat(64) };
        assert!(mac.require(Capability::AttachedDesktop).is_ok());
        assert!(crate::container_vm::selected_runtime(&mac).is_err());
        assert!(linux.require(Capability::GuestTask).is_err());
        assert!(mac.guest("env", "replacement").is_err());
        assert!(serde_json::from_value::<Target>(json!({"kind":"linuxContainer","runtime":"docker","id":"a".repeat(64),"fallback":"host"})).is_err());
        assert!(serde_json::from_value::<Target>(json!({"kind":"linuxContainer","runtime":"auto","id":"a".repeat(64)})).is_err());
    }
}
