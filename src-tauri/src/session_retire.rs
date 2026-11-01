//! What stopping this runtime now would cut short (#730).
//!
//! A desktop newer than this runtime replaces it with its own, and does so by
//! itself only when nothing would be cut short. That is the runtime's own
//! idle rule (`SessionManager::idle_process_roots`, `local_runtime::idle`):
//! only a managed agent that has settled, with no process of its own running,
//! may be stopped without asking. Everything else is named here, so the
//! desktop can wait for it or say what restarting now would stop.

use serde::{Deserialize, Serialize};

use super::{Engine, SessionManager, TabRuntime, TabStatus};

/// One thing stopping the runtime would cut short.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    pub kind: WorkKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    /// A terminal's own title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkKind {
    /// An agent in the middle of a turn, or waiting on the reader.
    Turn,
    /// An agent with a prompt not yet delivered, queued for after its turn
    /// or held back, or one still starting or stopping.
    Prompt,
    /// An agent started by hand in a tab's terminal.
    ByHand,
    /// A terminal whose shell or program is running.
    Terminal,
    /// Processes an agent started, or that outlived what started them.
    Processes,
    /// An issue pipeline step under way, or waiting on checks.
    Pipeline,
}

impl Work {
    fn of(kind: WorkKind, tab: &TabRuntime) -> Self {
        Self { kind, session_id: Some(tab.session_id.clone()), tab_id: Some(tab.tab_id.clone()), harness: Some(tab.harness.clone()), title: None }
    }

    fn unnamed(kind: WorkKind) -> Self {
        Self { kind, session_id: None, tab_id: None, harness: None, title: None }
    }
}

impl SessionManager {
    /// Everything stopping this runtime now would cut short; empty when only
    /// settled managed agents run, each of which picks up its conversation
    /// again when its tab next starts. Checks the process table, as the idle
    /// exit's last check does.
    pub(crate) fn retire_work(&self) -> Vec<Work> {
        let mut work = Vec::new();
        // The agent each settled CLI pane, or headless agent process, belongs to.
        let mut settled_panes = std::collections::HashMap::new();
        let mut roots: Vec<(u32, Work)> = Vec::new();
        let mut agent_panes = std::collections::HashSet::new();
        // The processes something running here leads: every running pane and
        // headless agent. An owned group led by none of them outlived it.
        let mut led = std::collections::HashSet::new();
        let tabs: Vec<_> = self.tabs.lock().unwrap().values().cloned().collect();
        for tab in tabs {
            let tab = tab.lock().unwrap();
            led.extend(tab.child_pid);
            let cli = match &tab.engine { Engine::Cli(cli) => Some(cli), _ => None };
            if let Some(cli) = cli { agent_panes.insert(cli.pane_id.clone()); }
            if tab.turn_open || matches!(tab.status, TabStatus::InProgress | TabStatus::Waiting) {
                work.push(Work::of(WorkKind::Turn, &tab));
                continue;
            }
            if cli.is_some_and(|cli| cli.by_hand.is_some()) {
                work.push(Work::of(WorkKind::ByHand, &tab));
                continue;
            }
            let prompt = !tab.pending.is_empty() || !tab.queued.is_empty() || tab.stop_in_flight || tab.stopping
                || tab.restart_claim.is_some() || tab.stdio_starting
                || cli.is_some_and(|cli| !cli.ready.settled() || cli.awaiting_delivery.is_some() || cli.resend_after_abort.is_some() || !cli.held.is_empty());
            if prompt {
                work.push(Work::of(WorkKind::Prompt, &tab));
                continue;
            }
            match &tab.engine {
                Engine::Cli(cli) => { settled_panes.insert(cli.pane_id.clone(), Work::of(WorkKind::Processes, &tab)); }
                Engine::CodexStdio(_) | Engine::Acp(_) | Engine::OpenCode(_) => {
                    if let Some(pid) = tab.child_pid { roots.push((pid, Work::of(WorkKind::Processes, &tab))); }
                }
                Engine::None => {}
            }
        }
        if self.mobile.has_pending() { work.push(Work::unnamed(WorkKind::Prompt)); }
        for pane in self.terminals.panes().into_iter().filter(|pane| pane.running) {
            led.extend(pane.pid);
            if let Some(agent) = settled_panes.remove(&pane.id) {
                match pane.pid {
                    Some(pid) => roots.push((pid, agent)),
                    None => work.push(agent),
                }
                continue;
            }
            // An agent's pane already named above, mid-turn, by hand or with a prompt.
            if agent_panes.contains(&pane.id) { continue; }
            let shell = self.terminals.shell(&pane.id);
            work.push(Work {
                kind: WorkKind::Terminal,
                session_id: shell.as_ref().map(|shell| shell.session_id.clone()).or_else(|| crate::pty::shell_session(&pane.id).map(str::to_owned)),
                tab_id: pane.id.strip_prefix("tab:").map(str::to_owned),
                harness: None,
                title: shell.and_then(|shell| shell.title),
            });
        }
        let pids: Vec<u32> = roots.iter().map(|(pid, _)| *pid).collect();
        // Groups that outlived what started them, including closed or replaced panes.
        if self.terminals.owned_groups().iter().any(|group| !led.contains(group)) || !self.session_stop_pids.lock().unwrap().is_empty() {
            work.push(Work::unnamed(WorkKind::Processes));
        }
        match crate::local_runtime::idle::busy(&pids) {
            Ok(busy) => work.extend(roots.into_iter().filter(|(pid, _)| busy.contains(pid)).map(|(_, agent)| agent)),
            Err(error) => {
                log::warn!("read the process table for the runtime's work: {error:#}");
                work.push(Work::unnamed(WorkKind::Processes));
            }
        }
        if crate::issue_pipeline::engine::holding() != 0 { work.push(Work::unnamed(WorkKind::Pipeline)); }
        work
    }
}
