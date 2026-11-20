//! Typed session adapter for an attached desktop. Reads are fallible too: a
//! disconnected owner is never represented as an idle tab or an empty queue.
//! The client pins one owner and never retries a mutation after a disconnect.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use super::client::Client;
use crate::events::AgentEvent;
use crate::session::{HandoffInfo, ImageInput, PendingPermission, QueuedMessage, RunningTab, SendOutcome, TabPtyEvent};
use crate::store::index::TabStatus;

#[derive(Clone)]
pub struct Sessions(Arc<Client>);

impl Sessions {
    pub fn new(client: Arc<Client>) -> Self { Self(client) }

    pub fn create(&self, req: &crate::session_ops::NewSession) -> Result<crate::store::index::SessionEntry> {
        self.call("runtime.session.create", json!({"req": req}))
    }

    /// [`Self::create`], its first tab on agent account `account` (#980).
    /// The account rides in the request, where a runtime that does not know
    /// accounts reads past it; when the runtime says it cannot honour it,
    /// the tab is marked in the reply ([`crate::session_ops::TAB_ACCOUNT_FALLBACK`]):
    /// it starts on This Mac's login, and the window says so.
    pub fn create_on(&self, req: &crate::session_ops::NewSession, account: Option<&str>) -> Result<crate::store::index::SessionEntry> {
        let Some(account) = account else { return self.create(req) };
        let supported = self.supports_accounts()?;
        let mut params = serde_json::to_value(req)?;
        if supported { params["account"] = json!(account); }
        let mut entry: crate::store::index::SessionEntry = self.call("runtime.session.create", json!({"req": params}))?;
        if !supported {
            for tab in &mut entry.tabs { mark_fallback(tab); }
        }
        Ok(entry)
    }

    /// Whether the runtime starts tabs on the account they ask for (#980).
    /// One from before accounts answers that it has no such operation.
    pub fn supports_accounts(&self) -> Result<bool> {
        match self.quick::<bool>("runtime.session.accountSupport", json!({})) {
            Ok(supported) => Ok(supported),
            Err(error) if unsupported(&error) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// Restart a tab's agent on agent account `account` and resume its
    /// conversation (#980). A runtime from before accounts cannot.
    /// `true` when a running agent was restarted on it, `false` when the
    /// account was only recorded for the tab's next start.
    pub fn switch_account(&self, session: &str, tab: &str, account: &str) -> Result<bool> {
        match self.tab::<bool>("switchAccount", session, tab, json!({"account": account})) {
            Ok(restarted) => Ok(restarted),
            Err(error) if unsupported(&error) => anyhow::bail!("{OLDER_RUNTIME}"),
            Err(error) => Err(error),
        }
    }

    pub fn workspace_setup(&self, operation: &str, session: Option<&str>, pane: Option<&str>) -> Result<Value> {
        self.call("runtime.session.workspaceSetup", json!({"operation": operation, "sessionId": session, "paneId": pane}))
    }

    fn call<T: DeserializeOwned>(&self, command: &str, params: Value) -> Result<T> {
        self.0.call(command,params)
    }

    /// A read the window shows or a quick control. A wedged owner fails it
    /// as unresponsive in seconds rather than holding the window for minutes.
    fn quick<T: DeserializeOwned>(&self, command: &str, params: Value) -> Result<T> {
        self.0.quick(command,params)
    }

    fn tab<T: DeserializeOwned>(&self, method: &str, session: &str, tab: &str, params: Value) -> Result<T> {
        self.call(&format!("runtime.session.{method}"), Self::addressed(session, tab, params))
    }

    fn quick_tab<T: DeserializeOwned>(&self, method: &str, session: &str, tab: &str, params: Value) -> Result<T> {
        self.quick(&format!("runtime.session.{method}"), Self::addressed(session, tab, params))
    }

    fn addressed(session: &str, tab: &str, mut params: Value) -> Value {
        params["sessionId"] = json!(session);
        params["tabId"] = json!(tab);
        params
    }

    pub fn local_vm(&self, method: &str, params: Value) -> Result<Value> {
        self.0.require_local_vm()?;
        if method=="environment.create" || method.starts_with("environment.setup") {self.0.require_vm_onboarding()?;}
        if matches!(method,"environment.reconcileProvision"|"environment.delete")
            || method == "environment.inspect" && matches!(params["purpose"].as_str(),Some("provisionRecovery"|"deletion")) {
            self.0.require_vm_reconciliation()?;
        }
        self.call("local_vm.request", json!({"method":method,"params":params}))
    }

    pub fn pipeline<T: DeserializeOwned>(&self, operation: &str, params: Value) -> Result<T> {
        self.0.network_call("runtime.session.pipeline", operation, params, crate::github_process::ticket())
    }

    /// Orchestration runs (`orchestration`): the runtime owns the workers.
    pub fn orchestration<T: DeserializeOwned>(&self, operation: &str, params: Value) -> Result<T> {
        self.call("runtime.session.orchestration", json!({"operation": operation, "params": params}))
    }

    /// An older owner ignores unknown project fields; it must not silently
    /// remove a workspace whose new desktop saved an archive script.
    pub fn require_archive_support(&self) -> Result<()> {
        let supported: bool = self.quick("runtime.session.workspace", json!({"operation":"archiveSupport","params":{}}))
            .context("Restart the local runtime before using archive scripts; older runtimes can discard saved scripts when updating projects")?;
        anyhow::ensure!(supported, "Restart the local runtime before using archive scripts; older runtimes can discard saved scripts when updating projects");
        Ok(())
    }

    pub fn workspace<T: DeserializeOwned>(&self, operation: &str, params: Value) -> Result<T> {
        let origin = crate::github_process::ticket();
        // Archive hooks may take five minutes each. Keep the caller waiting
        // for the result rather than reporting a timeout while removal runs.
        let seconds = match operation {
            "removeWorkspace" => 480,
            "remove" => 120 + 360 * params["items"].as_array().map_or(1, |items| items.len() as u64),
            "removeLeftovers" => 120 + 360 * params["ids"].as_array().map_or(1, |items| items.len() as u64),
            "mergedSweep" => 3600 + 360 * crate::merged_cleanup::ARCHIVES_PER_PASS as u64,
            _ => return self.0.workspace(operation, params, origin),
        };
        self.0.workspace_within(operation, params, origin, std::time::Duration::from_secs(seconds))
    }

    pub fn save_terminal_selection(&self, session: &str, tab: &str, text: &str) -> Result<String> {
        self.tab("saveTerminalSelection", session, tab, json!({"text":text}))
    }

    pub fn delete_session(&self, session: &str) -> Result<()> {
        self.call("runtime.session.deleteSession", json!({"sessionId":session}))
    }

    pub fn set_manual_status(&self, session: &str, status: crate::store::index::ManualStatus) -> Result<()> {
        self.call("runtime.session.manualStatus", json!({"sessionId":session,"status":status}))
    }

    /// Bots (`bots`, PRO-466). A read fails fast on a wedged owner; a change waits for its answer.
    pub fn bots<T: DeserializeOwned>(&self, operation: &str, params: Value) -> Result<T> {
        let request = json!({"operation": operation, "params": params});
        if matches!(operation, "list" | "get" | "templates" | "roleRead") {
            self.quick("runtime.session.bots", request)
        } else {
            self.call("runtime.session.bots", request)
        }
    }

    pub fn automations(&self) -> Result<Vec<crate::automations::Automation>> {
        self.quick("runtime.session.automations", json!({}))
    }

    pub fn automation_runs(&self, id: &str) -> Result<Vec<crate::automations::AutomationRun>> {
        self.quick("runtime.session.automationRuns", json!({"id":id}))
    }

    pub fn automation_issues(&self) -> Result<Vec<crate::automations::AutomationIssueState>> {
        self.quick("runtime.session.automationIssues", json!({}))
    }

    pub fn save_automation(&self, id: Option<&str>, input: crate::automations::AutomationInput) -> Result<crate::automations::Automation> {
        self.call("runtime.session.automationSave", json!({"id":id,"input":input}))
    }

    pub fn delete_automation(&self, id: &str) -> Result<()> {
        self.call("runtime.session.automationDelete", json!({"id":id}))
    }

    pub fn run_automation(&self, id: &str) -> Result<crate::automations::AutomationRun> {
        self.call("runtime.session.automationRun", json!({"id":id}))
    }

    pub fn resource_overview(&self) -> Result<Value> {
        self.quick("runtime.session.resourceOverview", json!({}))
    }

    pub fn resource_sample(&self) -> Result<Value> {
        self.call("runtime.session.resourceSample", json!({}))
    }

    pub fn resource_kill(&self, pane: &str, confirmed: bool) -> Result<Value> {
        self.call("runtime.session.resourceKill", json!({"paneId":pane,"confirmed":confirmed}))
    }

    pub fn usage_snapshot(&self) -> Result<crate::status::usage::UsageSnapshot> {
        crate::status::usage::UsageSnapshot::from_runtime(self.quick("runtime.session.usage", json!({}))?)
    }

    /// The account a new session of `harness` in `project` starts on when
    /// automatic switching moves it off `account` (#981). `None` with the
    /// setting off, the account not full, or a runtime from before it.
    pub fn launch_account_choice(&self, harness: &str, project: Option<&str>, account: Option<&str>) -> Result<Option<crate::session::account_switch::LaunchChoice>> {
        match self.quick::<Value>("runtime.session.accountChoice", json!({"harness": harness, "project": project, "account": account})) {
            Ok(Value::Null) => Ok(None),
            Ok(value) => Ok(Some(serde_json::from_value(value)?)),
            Err(error) if unsupported(&error) => Ok(None),
            Err(error) => Err(error),
        }
    }

    /// The person is typing in a tab's composer (#981). Older runtimes have no use for it.
    pub fn note_typing(&self, session: &str, tab: &str) -> Result<()> {
        match self.quick_tab::<Value>("noteTyping", session, tab, json!({})) {
            Ok(_) => Ok(()),
            Err(error) if unsupported(&error) => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub fn refresh_usage(&self, manual: bool) -> Result<crate::status::usage::UsageSnapshot> {
        crate::status::usage::UsageSnapshot::from_runtime(self.call("runtime.session.refreshUsage", json!({"manual":manual}))?)
    }

    pub fn reset_codex_usage(&self) -> Result<crate::status::usage::UsageSnapshot> {
        crate::status::usage::UsageSnapshot::from_runtime(self.call("runtime.session.resetCodexUsage", json!({}))?)
    }

    pub fn activity_summary(&self) -> Result<crate::store::activity::Summary> {
        self.quick("runtime.session.activity", json!({}))
    }

    pub fn add_tab(&self, session: &str, tab: &crate::session_ops::NewTab) -> Result<crate::store::index::TabEntry> {
        self.call("runtime.session.addTab", add_tab_params(session, tab))
    }

    /// [`Self::add_tab`] on agent account `account` (#980); see [`Self::create_on`].
    pub fn add_tab_on(&self, session: &str, tab: &crate::session_ops::NewTab, account: Option<&str>) -> Result<crate::store::index::TabEntry> {
        let Some(account) = account else { return self.add_tab(session, tab) };
        let supported = self.supports_accounts()?;
        let mut params = add_tab_params(session, tab);
        if supported { params["account"] = json!(account); }
        let mut added: crate::store::index::TabEntry = self.call("runtime.session.addTab", params)?;
        if !supported { mark_fallback(&mut added); }
        Ok(added)
    }

    pub fn pane_agents(&self) -> Result<Vec<crate::session::follow::PaneAgent>> {
        self.quick("runtime.session.paneAgents", json!({}))
    }

    pub fn resume_conversation(&self, session: &str, tab: &str, harness: &str, provider_session_id: &str) -> Result<()> {
        self.tab("resumeConversation", session, tab, json!({"harness":harness,"providerSessionId":provider_session_id}))
    }

    pub fn row_statuses(&self, ids: Vec<String>) -> Result<Value> {
        self.quick("runtime.session.rowStatuses", json!({"ids":ids}))
    }

    pub fn running_tabs(&self) -> Result<Vec<RunningTab>> {
        self.quick("runtime.session.running", json!({}))
    }

    pub fn pending_permissions(&self) -> Result<Vec<PendingPermission>> {
        self.quick("runtime.session.permissions", json!({}))
    }

    pub fn load_events(&self, session: &str, tab: &str) -> Result<Vec<AgentEvent>> {
        use base64::Engine as _;
        let opened: super::history::Opened = match self.tab("eventsOpen", session, tab, json!({})) {
            Ok(opened) => opened,
            // A previously running helper is never killed merely to update the
            // window. Retain its legacy read until that owner naturally exits.
            Err(error) if error.to_string().contains("unsupported local session operation") => return self.tab("events", session, tab, json!({})),
            Err(error) => return Err(error),
        };
        let result = (|| {
            let mut bytes = Vec::new();
            while (bytes.len() as u64) < opened.size {
                let offset = bytes.len() as u64;
                let chunk: super::history::Chunk = self.tab("eventsChunk", session, tab, json!({"token":opened.token,"offset":offset}))?;
                anyhow::ensure!(chunk.offset == offset, "History chunk has an unexpected offset.");
                let data = base64::engine::general_purpose::STANDARD.decode(chunk.data)?;
                anyhow::ensure!(!data.is_empty() && offset.checked_add(data.len() as u64).is_some_and(|end| end <= opened.size), "History chunk exceeds its snapshot.");
                bytes.extend(data);
            }
            Ok(serde_json::from_slice(&bytes)?)
        })();
        let _: Result<()> = self.tab("eventsClose", session, tab, json!({"token":opened.token}));
        result
    }

    pub fn status_of(&self, session: &str, tab: &str) -> Result<TabStatus> {
        self.quick_tab("status", session, tab, json!({}))
    }

    pub fn pane_of(&self, session: &str, tab: &str) -> Result<Option<TabPtyEvent>> {
        self.quick_tab("pane", session, tab, json!({}))
    }

    pub fn queued(&self, session: &str, tab: &str) -> Result<Vec<QueuedMessage>> {
        self.quick_tab("queued", session, tab, json!({}))
    }

    pub fn ensure_started(&self, session: &str, tab: &str) -> Result<()> {
        self.tab("ensureStarted", session, tab, json!({}))
    }

    /// The window showed the tab (`SessionManager::start_on_open`).
    pub fn start_on_open(&self, session: &str, tab: &str) -> Result<()> {
        self.tab("ensureStarted", session, tab, json!({"opened": true}))
    }

    pub fn send(&self, session: &str, tab: &str, text: String, images: Vec<ImageInput>) -> Result<SendOutcome> {
        self.send_pressed(session, tab, text, images, None, Vec::new(), None)
    }

    /// A composer's send, with when Send was pressed (`SessionManager::send_pressed`).
    /// `files`: stored attachments (PRO-290), sent only when there are any,
    /// so an older runtime is never handed a parameter it does not know.
    /// `prompt_request_id`: the Create preview's identity, when there is one.
    #[allow(clippy::too_many_arguments)]
    pub fn send_pressed(&self, session: &str, tab: &str, text: String, images: Vec<ImageInput>, pressed_at: Option<i64>, files: Vec<crate::events::FileRef>, prompt_request_id: Option<uuid::Uuid>) -> Result<SendOutcome> {
        let mut params = json!({"text":text,"images":images,"pressedAt":pressed_at});
        if !files.is_empty() { params["files"] = json!(files); }
        if let Some(id) = prompt_request_id { params["promptRequestId"] = json!(id); }
        self.tab("send", session, tab, params)
    }

    /// The window drew a sent message (`SessionManager::note_shown`).
    pub fn note_shown(&self, session: &str, tab: &str, seq: u64, timings: &crate::session::SendShown) -> Result<()> {
        self.quick_tab("sendShown", session, tab, json!({"seq":seq,"timings":{
            "pressedAt":timings.pressed_at,"drawnAt":timings.drawn_at,"answeredAt":timings.answered_at,"shownAt":timings.shown_at}}))
    }

    pub fn note_terminal_view(&self, session: &str, tab: &str, report: &crate::session::TerminalViewReport) -> Result<()> {
        self.quick_tab("terminalViewReport", session, tab, json!({"report":report}))
    }

    /// A window's report of a tab's warning (`SessionManager::note_incident_ui`).
    pub fn note_incident_ui(&self, session: &str, tab: &str, report: &crate::recovery_log::UiReport) -> Result<()> {
        self.quick_tab("incidentUi", session, tab, json!({"report": report}))
    }

    pub fn send_confirmed(&self, session: &str, tab: &str, text: String) -> Result<SendOutcome> {
        self.tab("sendConfirmed", session, tab, json!({"text":text}))
    }

    pub fn resend_unsent(&self, session: &str, tab: &str) -> Result<SendOutcome> {
        self.tab("resendUnsent", session, tab, json!({}))
    }

    pub fn resend_message(&self, session: &str, tab: &str, seq: u64) -> Result<SendOutcome> {
        self.tab("resendMessage", session, tab, json!({"seq":seq}))
    }

    pub fn submit_waiting(&self, session: &str, tab: &str, seq: u64) -> Result<bool> {
        self.tab("submitWaiting", session, tab, json!({"seq":seq}))
    }

    /// `portable`: for another computer (PRO-348), with no path of this one in it.
    pub fn prepare_continuation(&self, session: &str, tab: &str, portable: bool) -> Result<crate::continuation::Context> {
        self.tab("prepareContinuation", session, tab, if portable { json!({ "portable": true }) } else { json!({}) })
    }

    pub fn interrupt(&self, session: &str, tab: &str) -> Result<bool> {
        self.quick_tab("interrupt", session, tab, json!({}))
    }

    pub fn reset_chat(&self, session: &str, tab: &str, end_seq: Option<u64>, reset_files: bool, confirm: Option<&str>) -> Result<Option<String>> {
        self.tab("resetChat", session, tab, json!({"endSeq":end_seq,"resetFiles":reset_files,"confirm":confirm}))
    }

    pub fn stop(&self, session: &str, tab: &str) -> Result<()> {
        self.tab("stop", session, tab, json!({}))
    }

    pub fn close_tab(&self, session: &str, tab: &str) -> Result<()> {
        self.tab("closeTab", session, tab, json!({}))
    }


    pub fn change_held(&self, session: &str, tab: &str, change: crate::session::held::Change) -> Result<SendOutcome> {
        self.tab("heldQueue", session, tab, json!({"change":change}))
    }

    pub fn send_queued_now(&self, session: &str, tab: &str, seq: u64) -> Result<()> {
        self.quick_tab("sendQueuedNow", session, tab, json!({"seq":seq}))
    }

    pub fn cancel_queued(&self, session: &str, tab: &str, message: &str) -> Result<Option<QueuedMessage>> {
        self.quick_tab("cancelQueued", session, tab, json!({"messageId":message}))
    }

    pub fn respond_permission(&self, session: &str, tab: &str, request: &str, option: &str) -> Result<()> {
        self.quick_tab("permission", session, tab, json!({"requestId":request,"optionId":option}))
    }

    pub fn answer_questions(&self, session: &str, tab: &str, request: &str, answers: HashMap<String, String>) -> Result<()> {
        self.quick_tab("questions", session, tab, json!({"requestId":request,"answers":answers}))
    }

    /// A question the CLI drew in its own terminal (PRO-460). Not a quick
    /// call: the keys go in with the pauses the CLI needs between them.
    pub fn answer_terminal_prompt(&self, session: &str, tab: &str, prompt: &str, choice: Option<usize>) -> Result<()> {
        self.tab("terminalPrompt", session, tab, json!({"promptId":prompt,"choice":choice}))
    }

    pub fn set_model(&self, session: &str, tab: &str, model: &str) -> Result<()> {
        self.tab("model", session, tab, json!({"model":model}))
    }

    pub fn set_permission_mode(&self, session: &str, tab: &str, mode: &str) -> Result<()> {
        self.tab("mode", session, tab, json!({"mode":mode}))
    }

    pub fn set_effort(&self, session: &str, tab: &str, effort: Option<&str>) -> Result<()> {
        self.tab("effort", session, tab, json!({"effort":effort}))
    }

    pub fn set_tab_unread(&self, session: &str, tab: &str, unread: bool) -> Result<()> {
        self.quick_tab("setUnread", session, tab, json!({"unread": unread}))
    }

    pub fn mark_read(&self, session: &str, tab: &str) -> Result<()> {
        self.quick_tab("markRead", session, tab, json!({}))
    }

    pub fn handoff(&self, session: &str, tab: &str) -> Result<HandoffInfo> {
        self.tab("handoff", session, tab, json!({}))
    }

    pub fn to_terminal(&self, session: &str, tab: &str, transition_id: Option<uuid::Uuid>) -> Result<bool> {
        // Older local runtimes returned null for a completed handoff.
        let ready: Option<bool> = self.tab("toTerminal", session, tab, json!({"transitionId":transition_id,"deferUntilIdle":true}))?;
        Ok(ready.unwrap_or(true))
    }
}

/// The tab as the runtime makes it, transport included: a native Codex tab
/// chosen on the desktop side must not arrive as a terminal one.
/// What the window is told when the runtime it runs on predates accounts.
pub const OLDER_RUNTIME: &str = "The background runtime is older than this app and starts every tab on This Mac's login. Quit and reopen TerminalX to update it, then choose the account again.";

/// The runtime has no such operation: one from before it was added.
fn unsupported(error: &anyhow::Error) -> bool {
    let text = format!("{error:#}");
    text.contains("unsupported local session operation") || text.contains("unsupported local runtime operation")
}

/// A tab that asked for an account its runtime could not honour (#980).
fn mark_fallback(tab: &mut crate::store::index::TabEntry) {
    tab.unknown.insert(crate::session_ops::TAB_ACCOUNT_FALLBACK.into(), json!("olderRuntime"));
}

fn add_tab_params(session: &str, tab: &crate::session_ops::NewTab) -> Value {
    json!({"sessionId":session, "tab":{
        "harness":tab.harness,"model":tab.model,"effort":tab.effort,"permissionMode":tab.permission_mode,
        "transport":tab.transport
    }})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_tab_reaches_the_runtime_with_its_transport() {
        let tab = crate::session_ops::NewTab { transport: crate::store::index::AgentTransport::ExperimentalCodexStdio, harness: "codex".into(), model: String::new(), effort: None, permission_mode: Some("auto".into()) };
        let params = add_tab_params("s", &tab);
        let decoded: crate::session_ops::NewTab = serde_json::from_value(params["tab"].clone()).unwrap();
        assert_eq!(decoded.transport, crate::store::index::AgentTransport::ExperimentalCodexStdio);
        assert_eq!(params["tab"]["transport"], "experimentalCodexStdio");
    }
}
