//! Launch intents (PRO-21, terminalx-saas contract §19): the repositories,
//! work branch and first prompt a workspace was created with, consumed once.
//!
//! The runtime claims the intent, prepares every repository (base ref, then
//! the workspace's own work branch), starts the agent tab in the primary
//! repository and sends the prompt, then reports the outcome. The prompt is
//! sent at most once: `launch.json` records `applying` durably before the
//! agent is touched and the outcome after, next to the mailbox receipts whose
//! `storageIncarnationId` the claim carries. A redelivery with a stored
//! outcome reports it again; one that died mid-apply is `outcome-unknown`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::api::{CallError, HttpMailboxApi};

const FILE: &str = "launch.json";
/// Contract §19.1 limits, shared with the desktop's create checks.
pub const MAX_PROMPT_BYTES: usize = 32 * 1024;
pub const MAX_REPOSITORIES: usize = 5;

/// `[a-z0-9-]{1,32}`, the agent ids a launch may name.
pub fn valid_agent(agent: &str) -> bool {
    (1..=32).contains(&agent.len()) && agent.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub owner: String,
    pub name: String,
    pub path: String,
    #[serde(default, rename = "ref")]
    pub base_ref: Option<String>,
}

/// `launch` of a claim response.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub launch_id: String,
    /// `deliver`, or the settled state (`started`, `failed`,
    /// `outcome-unknown`, `canceled`, `expired`).
    pub state: String,
    #[serde(default)]
    pub redelivery: bool,
    pub work_branch: String,
    #[serde(default)]
    pub title: Option<String>,
    pub agent: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub prompt: Option<String>,
    #[serde(default)]
    pub repositories: Vec<Repository>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub path: String,
    pub branch: String,
    pub head: String,
}

/// What the runtime reports, and keeps in `launch.json` to report again.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default)]
    pub branches: Vec<Branch>,
}

impl Outcome {
    fn failed(category: &str, branches: Vec<Branch>) -> Self {
        Self { outcome: "failed".into(), category: Some(category.into()), session_id: None, tab_id: None, branches }
    }
}

#[derive(Debug, PartialEq)]
pub enum Completed {
    Settled(String),
    /// Already settled differently (`409`); nothing more to do.
    Conflict(String),
    NotFound,
}

pub trait LaunchApi: Send + Sync {
    fn claim(&self, storage_incarnation_id: &str) -> Result<Option<Claim>, CallError>;
    /// `Some(state)` when the intent is no longer claimed (canceled, expired
    /// or settled by the server): the launch must stop.
    fn phase(&self, launch_id: &str, phase: &str) -> Result<Option<String>, CallError>;
    fn complete(&self, launch_id: &str, outcome: &Outcome) -> Result<Completed, CallError>;
}

impl LaunchApi for HttpMailboxApi {
    fn claim(&self, storage_incarnation_id: &str) -> Result<Option<Claim>, CallError> {
        let body = json!({ "v": 1, "storageIncarnationId": storage_incarnation_id });
        match self.call("POST", "/v1/cloud-workspace-bootstrap/launch-intent/claim", Some(body))? {
            (200, body) => match body.get("launch") {
                None | Some(Value::Null) => Ok(None),
                Some(launch) => serde_json::from_value(launch.clone())
                    .map(Some)
                    .map_err(|error| CallError::Transient(anyhow!("launch claim: unreadable response: {error}"))),
            },
            // A server without launch intents (§19 is additive).
            (404, _) => Ok(None),
            (status, body) => Err(CallError::Transient(anyhow!("launch claim: HTTP {status} {}", error_code(&body)))),
        }
    }

    fn phase(&self, launch_id: &str, phase: &str) -> Result<Option<String>, CallError> {
        let body = json!({ "v": 1, "launchId": launch_id, "phase": phase });
        match self.call("POST", "/v1/cloud-workspace-bootstrap/launch-intent/phase", Some(body))? {
            (200, _) => Ok(None),
            (409, body) => Ok(Some(body.get("state").and_then(Value::as_str).unwrap_or("settled").to_string())),
            (404, _) => Ok(Some("not-found".into())),
            (status, body) => Err(CallError::Transient(anyhow!("launch phase: HTTP {status} {}", error_code(&body)))),
        }
    }

    fn complete(&self, launch_id: &str, outcome: &Outcome) -> Result<Completed, CallError> {
        let mut body = json!({ "v": 1, "launchId": launch_id, "outcome": outcome.outcome });
        if let Some(category) = &outcome.category {
            body["category"] = json!(category);
        }
        if let (Some(session_id), Some(tab_id)) = (&outcome.session_id, &outcome.tab_id) {
            body["sessionId"] = json!(session_id);
            body["tabId"] = json!(tab_id);
        }
        if !outcome.branches.is_empty() {
            body["branches"] = json!(outcome.branches);
        }
        let state = |body: &Value| body.get("state").and_then(Value::as_str).unwrap_or("").to_string();
        match self.call("POST", "/v1/cloud-workspace-bootstrap/launch-intent/complete", Some(body))? {
            (200, body) => Ok(Completed::Settled(state(&body))),
            (409, body) => Ok(Completed::Conflict(state(&body))),
            (404, _) => Ok(Completed::NotFound),
            (status, body) => Err(CallError::Transient(anyhow!("launch complete: HTTP {status} {}", error_code(&body)))),
        }
    }
}

fn error_code(body: &Value) -> &str {
    body.get("error").and_then(Value::as_str).unwrap_or("")
}

/// Starts the agent tab. The real one is [`ManagerStarter`]; tests stand in.
pub trait Starter: Send + Sync {
    /// Whether `agent` is offered and installed here.
    fn available(&self, agent: &str) -> bool;
    /// Create the session and tab in `cwd` and send `prompt` (when any).
    /// Returns `(session id, tab id)`.
    fn start(&self, cwd: &Path, claim: &Claim, title: &str) -> Result<(String, String), StartError>;
}

#[derive(Debug)]
pub enum StartError {
    /// Nothing was created; the prompt definitely did not reach an agent.
    NotStarted(anyhow::Error),
    /// The tab exists but sending the prompt failed partway: it may or may
    /// not have reached the agent.
    SendFailed { session_id: String, tab_id: String, error: anyhow::Error },
}

/// Prepares one repository; the real one runs git.
pub trait Checkout: Send + Sync {
    fn prepare(&self, repository: &Repository, work_branch: &str) -> Result<Branch>;
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "stage", rename_all = "camelCase")]
enum Record {
    Applying { launch_id: String },
    Done { launch_id: String, outcome: Outcome },
}

impl Record {
    fn launch_id(&self) -> &str {
        match self {
            Self::Applying { launch_id } | Self::Done { launch_id, .. } => launch_id,
        }
    }
}

/// `launch.json`: one launch per workspace, so one record.
pub struct Store {
    path: PathBuf,
}

impl Store {
    pub fn open(dir: &Path) -> Self {
        Self { path: dir.join(FILE) }
    }

    fn get(&self, launch_id: &str) -> Option<Record> {
        let bytes = std::fs::read(&self.path).ok()?;
        serde_json::from_slice::<Record>(&bytes).ok().filter(|record| record.launch_id() == launch_id)
    }

    fn put(&self, record: &Record) -> Result<()> {
        crate::cloud_bootstrap::write_durable(&self.path, &serde_json::to_vec(record)?)
    }
}

pub struct Launcher {
    pub api: Arc<dyn LaunchApi>,
    pub starter: Arc<dyn Starter>,
    pub checkout: Arc<dyn Checkout>,
    pub store: Store,
    pub incarnation: String,
    /// Where an intent without repositories starts its agent.
    pub root: PathBuf,
}

/// What one pass did, for the loop and tests.
#[derive(Debug, PartialEq)]
pub enum Pass {
    /// No intent for this workspace.
    None,
    /// Reported (or found already settled): `state`.
    Settled(String),
}

impl Launcher {
    /// Claim, launch and report until the server has the outcome. Transient
    /// failures are retried with backoff; a claim with nothing to do ends it.
    pub fn run(&self) {
        let mut failures = 0u32;
        loop {
            match self.pass() {
                Ok(Pass::None) => return,
                Ok(Pass::Settled(state)) => {
                    log::info!("launch intent settled: {state}");
                    return;
                }
                Err(error) => {
                    failures = failures.saturating_add(1);
                    log::warn!("launch intent: {error}");
                    std::thread::sleep(crate::remote::protocol::backoff(failures, 0.5).max(Duration::from_secs(1)));
                }
            }
        }
    }

    pub fn pass(&self) -> Result<Pass, CallError> {
        match self.attempt() {
            Err(CallError::Settled(state)) => Ok(Pass::Settled(state)),
            other => other,
        }
    }

    fn attempt(&self) -> Result<Pass, CallError> {
        let Some(claim) = self.api.claim(&self.incarnation)? else { return Ok(Pass::None) };
        if claim.state != "deliver" {
            return Ok(Pass::Settled(claim.state));
        }
        let outcome = match self.store.get(&claim.launch_id) {
            // Ran before this restart: report the same outcome again.
            Some(Record::Done { outcome, .. }) => outcome,
            // Died after `applying`: the prompt may have reached the agent.
            Some(Record::Applying { .. }) => {
                let outcome = Outcome { outcome: "outcome-unknown".into(), ..Outcome::failed("runtime-interrupted", Vec::new()) };
                self.finish(&claim, outcome)
            }
            None => self.launch(&claim)?,
        };
        match self.api.complete(&claim.launch_id, &outcome)? {
            Completed::Settled(state) | Completed::Conflict(state) => Ok(Pass::Settled(state)),
            Completed::NotFound => Ok(Pass::Settled("not-found".into())),
        }
    }

    fn launch(&self, claim: &Claim) -> Result<Outcome, CallError> {
        if let Err(error) = validate(claim) {
            log::warn!("launch intent {}: {error:#}", claim.launch_id);
            return Ok(self.finish(claim, Outcome::failed("payload-invalid", Vec::new())));
        }
        if let Some(state) = self.api.phase(&claim.launch_id, "syncing-repository")? {
            return Err(CallError::Settled(state));
        }
        let mut branches = Vec::new();
        for repository in &claim.repositories {
            match self.checkout.prepare(repository, &claim.work_branch) {
                Ok(branch) => branches.push(branch),
                Err(error) => {
                    log::warn!("prepare {}/{}: {error:#}", repository.owner, repository.name);
                    return Ok(self.finish(claim, Outcome::failed("repository-sync-failed", branches)));
                }
            }
        }
        // Checked again right before the agent is touched: a create canceled
        // while the repositories were prepared is never delivered.
        if let Some(state) = self.api.phase(&claim.launch_id, "starting-agent")? {
            return Err(CallError::Settled(state));
        }
        if !self.starter.available(&claim.agent) {
            return Ok(self.finish(claim, Outcome::failed("agent-unavailable", branches)));
        }
        let cwd = claim.repositories.first().map(|repository| PathBuf::from(&repository.path)).unwrap_or_else(|| self.root.clone());
        if let Err(error) = self.store.put(&Record::Applying { launch_id: claim.launch_id.clone() }) {
            // Without the durable mark a restart could send the prompt again,
            // so the agent is not touched.
            log::error!("record launch applying: {error:#}");
            return Err(CallError::Transient(anyhow!("record launch applying: {error:#}")));
        }
        let title = title_of(claim);
        let outcome = match self.starter.start(&cwd, claim, &title) {
            Ok((session_id, tab_id)) => {
                Outcome { outcome: "started".into(), category: None, session_id: Some(session_id), tab_id: Some(tab_id), branches }
            }
            Err(StartError::NotStarted(error)) => {
                log::warn!("start the launch agent: {error:#}");
                Outcome::failed("agent-start-failed", branches)
            }
            Err(StartError::SendFailed { session_id, tab_id, error }) => {
                log::warn!("send the launch prompt: {error:#}");
                Outcome {
                    outcome: "outcome-unknown".into(),
                    category: Some("prompt-send-failed".into()),
                    session_id: Some(session_id),
                    tab_id: Some(tab_id),
                    branches,
                }
            }
        };
        Ok(self.finish(claim, outcome))
    }

    /// Record the outcome durably, then return it for reporting.
    fn finish(&self, claim: &Claim, outcome: Outcome) -> Outcome {
        if let Err(error) = self.store.put(&Record::Done { launch_id: claim.launch_id.clone(), outcome: outcome.clone() }) {
            // `applying` (if written) stays, so a redelivery is still never
            // applied twice.
            log::error!("record launch outcome: {error:#}");
        }
        outcome
    }
}

fn validate(claim: &Claim) -> Result<()> {
    if !valid_branch(&claim.work_branch) {
        bail!("invalid work branch");
    }
    if claim.repositories.len() > MAX_REPOSITORIES {
        bail!("too many repositories");
    }
    for repository in &claim.repositories {
        if repository.base_ref.as_deref().is_some_and(|base| !valid_branch(base)) {
            bail!("invalid base ref");
        }
        if !valid_repository_path(&repository.path) {
            bail!("invalid repository path");
        }
    }
    if claim.prompt.as_ref().is_some_and(|prompt| prompt.len() > MAX_PROMPT_BYTES || prompt.contains('\0')) {
        bail!("invalid prompt");
    }
    if !valid_agent(&claim.agent) {
        bail!("invalid agent");
    }
    Ok(())
}

/// The same rules as `git check-ref-format --branch` for the names the server
/// hands out, checked before any of them reaches git; at most 200 characters,
/// the server's cap (contract §19.1).
pub fn valid_branch(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with(['-', '/', '.'])
        && !name.ends_with(['/', '.'])
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("@{")
        && !name.contains("//")
        && name != "@"
        && !name.split('/').any(|part| part.is_empty() || part.starts_with('.') || part.ends_with(".lock"))
        && name.bytes().all(|b| b > 0x20 && b != 0x7f && !matches!(b, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\'))
}

fn valid_repository_path(path: &str) -> bool {
    let path = Path::new(path);
    path.is_absolute() && path.components().all(|part| matches!(part, std::path::Component::RootDir | std::path::Component::Normal(_)))
}

fn title_of(claim: &Claim) -> String {
    let line = claim.title.as_deref().or(claim.prompt.as_deref()).unwrap_or("").lines().next().unwrap_or("").trim();
    if line.chars().count() > 80 {
        format!("{}…", line.chars().take(79).collect::<String>())
    } else if line.is_empty() {
        claim.work_branch.clone()
    } else {
        line.to_string()
    }
}

/// Repositories prepared with git: the base ref first (fetched only when the
/// checkout does not have it), then the workspace's own work branch. A work
/// branch that already exists here is this workspace's from an earlier
/// attempt: switched to, never recreated or reset.
pub struct GitCheckout;

impl Checkout for GitCheckout {
    fn prepare(&self, repository: &Repository, work_branch: &str) -> Result<Branch> {
        let path = Path::new(&repository.path);
        if !crate::git::is_repo(path) {
            bail!("{} is not a git checkout", repository.path);
        }
        let exists = |name: &str| crate::git::run(path, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_ok();
        if exists(work_branch) {
            if crate::git::current_branch(path).as_deref() != Some(work_branch) {
                crate::git::run(path, &["switch", work_branch])?;
            }
        } else {
            if let Some(base) = repository.base_ref.as_deref() {
                if crate::git::current_branch(path).as_deref() != Some(base) {
                    if exists(base) {
                        crate::git::run(path, &["switch", base])?;
                    } else {
                        let remote = format!("refs/remotes/origin/{base}");
                        if crate::git::run(path, &["rev-parse", "--verify", "--quiet", &remote]).is_err() {
                            crate::git::run(path, &["fetch", "--no-tags", "origin", &format!("+refs/heads/{base}:{remote}")])?;
                        }
                        crate::git::run(path, &["switch", "--create", base, "--track", &format!("origin/{base}")])?;
                    }
                }
            }
            crate::git::run(path, &["switch", "--create", work_branch])?;
        }
        let head = crate::git::head_commit(path).ok_or_else(|| anyhow!("no commit at HEAD"))?;
        Ok(Branch { path: repository.path.clone(), branch: work_branch.to_string(), head })
    }
}

/// The agent tab, created the way `session.create` creates one.
pub struct ManagerStarter {
    pub manager: crate::session::SessionManager,
    pub sink: Arc<dyn crate::sink::EventSink>,
    pub root: String,
    pub agents: std::sync::Weak<super::CloudAgents>,
}

impl Starter for ManagerStarter {
    fn available(&self, agent: &str) -> bool {
        crate::harness::offered().into_iter().any(|harness| harness.id == agent && harness.available)
    }

    fn start(&self, cwd: &Path, claim: &Claim, title: &str) -> Result<(String, String), StartError> {
        let entry = crate::session_ops::create_session_blocking(
            &*self.sink,
            crate::session_ops::NewSession {
                project_path: self.root.clone(),
                title: Some(title.to_string()),
                use_worktree: false,
                on_main: true,
                base_ref: None,
                worktree_name: None,
                issue: None,
                automation: None,
                cwd: (cwd != Path::new(&self.root)).then(|| cwd.to_string_lossy().into_owned()),
                tab: Some(crate::session_ops::NewTab {
                    harness: claim.agent.clone(),
                    model: claim.model.clone().unwrap_or_default(),
                    effort: claim.effort.clone(),
                    permission_mode: claim.mode.clone(),
                }),
            },
        )
        .map_err(|error| StartError::NotStarted(anyhow!("{error}")))?;
        let tab = entry.tabs.first().cloned().ok_or_else(|| StartError::NotStarted(anyhow!("the new session has no tab")))?;
        if let Some(prompt) = claim.prompt.as_ref().filter(|prompt| !prompt.trim().is_empty()) {
            if let Err(error) = self.manager.send(&entry.id, &tab.id, prompt.to_string(), Vec::new()) {
                return Err(StartError::SendFailed { session_id: entry.id, tab_id: tab.id, error });
            }
        }
        if let Some(agents) = self.agents.upgrade() {
            agents.changed(Some(&tab.id), true);
        }
        Ok((entry.id, tab.id))
    }
}

#[cfg(test)]
#[path = "launch_tests.rs"]
mod tests;
