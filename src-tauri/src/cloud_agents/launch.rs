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
//!
//! A workspace with no Environment image has nothing checked out, so its
//! claim marks every repository `clone` (§19.3, `launch-clone-v1`): the
//! runtime clones `https://github.com/<owner>/<name>.git` into the given
//! path first. The claim carries no URL and no credential. Git gets a token
//! from the credential helper `cloud_github` installs at boot, which asks
//! the API for a short-lived one scoped to this workspace's repositories;
//! this module never sees a token, and none is put in the URL, the remote,
//! the Git config, the environment or a log line.
//!
//! When there is no first prompt to deliver (a workspace created without
//! one, as the console does; a launch that settled without its clone; a
//! replaced disk), the claim carries a `checkout` plan instead: the same
//! repositories and the workspace's own branch. The runtime sets each one up
//! once and remembers it in `checkout.json`, so a later boot never switches
//! a person's branch back or clones again what they removed. No agent is
//! started. What became of each repository is reported to the server (its
//! path, `ready` or `failed`, and the failure's category; never Git's
//! output), so a failed clone reaches the person; and while one failed for
//! a reason that may pass, the runtime claims and tries again by itself.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::api::{CallError, HttpMailboxApi};

const FILE: &str = "launch.json";
const CHECKOUT_FILE: &str = "checkout.json";
/// Contract §19.1 limits, shared with the desktop's create checks.
pub const MAX_PROMPT_BYTES: usize = 32 * 1024;
pub const MAX_REPOSITORIES: usize = 5;
/// Sent with the claim (the header `cloud_bootstrap` uses on refresh): this
/// runtime clones the repositories of a workspace that has no Environment
/// image. A server that does not know it answers as before.
///
/// `launch-checkout-v1`: this runtime also sets up the `checkout` plan (the
/// repositories without a first prompt) and reports on it. It is its own
/// token because runtimes released with only `launch-clone-v1` ignore that
/// plan, and the server must be able to tell.
pub const CLAIM_CAPABILITIES: &str = "launch-clone-v1,launch-checkout-v1";
/// A checkout that failed is tried again after these waits, the last one
/// repeating: access granted later is picked up without a restart.
const CHECKOUT_RETRY: [Duration; 4] = [Duration::from_secs(60), Duration::from_secs(5 * 60), Duration::from_secs(15 * 60), Duration::from_secs(30 * 60)];
/// Failures that waiting cannot mend: the person has to act in the workspace.
const CHECKOUT_FINAL: [&str; 3] = [PATH_OCCUPIED, REPOSITORY_EMPTY, "payload-invalid"];
const CAPABILITIES_HEADER: &str = "x-terminalx-cloud-workspace-runtime-capabilities";
const GITHUB: &str = "https://github.com";
const GITHUB_PROVIDER: &str = "github";
/// Where a clone lands until it is complete, next to its final directory.
const STAGING_PREFIX: &str = ".terminalx-clone-";
/// All of a launch's clones together get this long. The clone is a full one
/// (history and every branch, as a local checkout has), so it is capped by
/// time, not by depth: what has not finished by then fails the launch.
pub const CLONE_BUDGET: Duration = Duration::from_secs(30 * 60);
/// A transfer slower than this many bytes a second for this many seconds is
/// given up, so a stalled clone fails the launch long before the budget.
const LOW_SPEED_LIMIT: &str = "http.lowSpeedLimit=1000";
const LOW_SPEED_TIME: &str = "http.lowSpeedTime=60";
/// How often a running clone asks the server whether its create was canceled.
pub const CANCEL_POLL: Duration = Duration::from_secs(10);

/// Why a clone was not made. Each failure has its own category, so the
/// person is told what actually went wrong (§19.5).
#[derive(Debug)]
pub enum CloneError {
    /// The create was canceled while Git ran; Git was killed.
    Canceled,
    Failed { category: &'static str, detail: String },
}

impl CloneError {
    fn failed(category: &'static str, detail: impl Into<String>) -> Self {
        Self::Failed { category, detail: detail.into() }
    }

    fn io(error: std::io::Error) -> Self {
        Self::failed(if is_disk_full(&error) { DISK_FULL } else { CLONE_FAILED }, error.to_string())
    }
}

const CLONE_FAILED: &str = "repository-clone-failed";
const ACCESS_DENIED: &str = "repository-access-denied";
const BRANCH_NOT_FOUND: &str = "repository-branch-not-found";
const CLONE_TIMED_OUT: &str = "repository-clone-timed-out";
const PATH_OCCUPIED: &str = "repository-path-occupied";
const REPOSITORY_EMPTY: &str = "repository-empty";
const DISK_FULL: &str = "workspace-disk-full";

fn is_disk_full(error: &std::io::Error) -> bool {
    // ENOSPC and EDQUOT.
    matches!(error.raw_os_error(), Some(28) | Some(122)) || error.kind() == std::io::ErrorKind::StorageFull
}

/// The category for what Git wrote when a clone failed (it runs with
/// `LC_ALL=C`). The disk is checked first: a full disk also breaks the
/// transfer, and that is the reason worth telling.
pub fn clone_failure_category(stderr: &str) -> &'static str {
    let has = |needles: &[&str]| needles.iter().any(|needle| stderr.contains(needle));
    if has(&["No space left on device", "Disk quota exceeded"]) {
        DISK_FULL
    } else if stderr.contains("Remote branch") && stderr.contains("not found") {
        BRANCH_NOT_FOUND
    } else if has(&["Operation too slow", "Operation timed out", "Connection timed out"]) {
        CLONE_TIMED_OUT
    } else if has(&["Authentication failed", "could not read Username", "could not read Password", "Repository not found", "returned error: 401", "returned error: 403", "returned error: 404", "terminal prompts disabled"]) {
        ACCESS_DENIED
    } else {
        CLONE_FAILED
    }
}

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
    /// Set when `path` is not a checkout yet and the runtime clones it.
    #[serde(default)]
    pub clone: Option<CloneSource>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloneSource {
    pub provider: String,
}

/// The repositories and work branch of a workspace with no first prompt to
/// deliver (§19.3 `checkout`).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutPlan {
    pub work_branch: String,
    #[serde(default)]
    pub repositories: Vec<Repository>,
}

/// What became of one repository of a checkout plan, as reported to the server.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutResult {
    pub path: String,
    /// `ready` or `failed`.
    pub state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

impl CheckoutResult {
    fn ready(repository: &Repository) -> Self {
        Self { path: repository.path.clone(), state: "ready", category: None }
    }

    fn failed(repository: &Repository, category: &str) -> Self {
        Self { path: repository.path.clone(), state: "failed", category: Some(category.into()) }
    }
}

/// What one claim answered.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Claimed {
    pub launch: Option<Claim>,
    pub checkout: Option<CheckoutPlan>,
}

/// The tab a claimed launch starts. A launch that names no mode (or a blank
/// one) starts in the default launch mode, bypass, like any other session.
pub(crate) fn new_tab(claim: &Claim) -> crate::session_ops::NewTab {
    crate::session_ops::NewTab {
        harness: claim.agent.clone(),
        model: claim.model.clone().unwrap_or_default(),
        effort: claim.effort.clone(),
        permission_mode: crate::store::index::requested_mode(claim.mode.clone()),
    }
}

/// `launch` of a claim response.
#[derive(Debug, Clone, Deserialize, PartialEq)]
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
    fn claim(&self, storage_incarnation_id: &str) -> Result<Claimed, CallError>;
    /// `Some(state)` when the intent is no longer claimed (canceled, expired
    /// or settled by the server): the launch must stop.
    fn phase(&self, launch_id: &str, phase: &str) -> Result<Option<String>, CallError>;
    fn complete(&self, launch_id: &str, outcome: &Outcome) -> Result<Completed, CallError>;
    /// Tell the server what became of each repository of a checkout plan,
    /// so a failure reaches the person. The default says nothing.
    fn report_checkout(&self, _results: &[CheckoutResult]) -> Result<(), CallError> {
        Ok(())
    }
}

impl LaunchApi for HttpMailboxApi {
    fn claim(&self, storage_incarnation_id: &str) -> Result<Claimed, CallError> {
        let body = json!({ "v": 1, "storageIncarnationId": storage_incarnation_id });
        match self.call_with("POST", "/v1/cloud-workspace-bootstrap/launch-intent/claim", Some(body), &[(CAPABILITIES_HEADER, CLAIM_CAPABILITIES)])? {
            (200, body) => {
                let launch = match body.get("launch") {
                    None | Some(Value::Null) => None,
                    Some(launch) => Some(serde_json::from_value(launch.clone()).map_err(|error| CallError::Transient(anyhow!("launch claim: unreadable response: {error}")))?),
                };
                // A plan this runtime cannot read is no plan: the launch still counts.
                let checkout = body.get("checkout").filter(|plan| !plan.is_null()).and_then(|plan| {
                    serde_json::from_value(plan.clone()).map_err(|error| log::warn!("launch claim: unreadable checkout plan: {error}")).ok()
                });
                Ok(Claimed { launch, checkout })
            }
            // A server without launch intents (§19 is additive).
            (404, _) => Ok(Claimed::default()),
            (status, body) => Err(CallError::Transient(anyhow!("launch claim: HTTP {status} {}", error_code(&body)))),
        }
    }

    fn report_checkout(&self, results: &[CheckoutResult]) -> Result<(), CallError> {
        let body = json!({ "v": 1, "repositories": results });
        match self.call("POST", "/v1/cloud-workspace-bootstrap/launch-intent/checkout", Some(body))? {
            // A server from before the report has no such route.
            (200, _) | (404, _) => Ok(()),
            (status, body) => Err(CallError::Transient(anyhow!("checkout report: HTTP {status} {}", error_code(&body)))),
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
    /// Whether `agent` would start with no way to sign in (PRO-78).
    fn sign_in_required(&self, _agent: &str) -> bool {
        false
    }
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
    /// Clone a repository marked `clone` whose path is not a checkout yet,
    /// giving up after `within` or as soon as `canceled` says so. The
    /// default does nothing.
    fn clone_missing(&self, _repository: &Repository, _within: Duration, _canceled: &dyn Fn() -> bool) -> std::result::Result<(), CloneError> {
        Ok(())
    }
    fn prepare(&self, repository: &Repository, work_branch: &str) -> Result<Branch>;
    /// A launch with no repository (a blank project): make its folder a Git
    /// repository on the work branch, so changes can be tracked. The default
    /// does nothing.
    fn prepare_blank(&self, _root: &Path, _work_branch: &str) -> Result<()> {
        Ok(())
    }
}

/// `launch.json` on the workspace machine. Its fields stay snake_case on
/// purpose (`{"stage":"applying","launch_id":…}`): runtimes in the field
/// have already written this file, and it is the exactly-once guard for the
/// first prompt. Renaming `launch_id` would make an upgraded runtime fail to
/// read its own record, treat the launch as new and could send the prompt a
/// second time. Only this module reads the file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "stage", rename_all = "camelCase", rename_all_fields = "snake_case")]
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

/// `checkout.json`: the repository paths this runtime has set up, each once.
#[derive(Debug, Default, Serialize, Deserialize)]
struct SetUp {
    v: u8,
    #[serde(default)]
    paths: Vec<String>,
}

/// `launch.json`: one launch per workspace, so one record. `checkout.json`
/// next to it lists the repositories already set up.
pub struct Store {
    path: PathBuf,
    checkout_path: PathBuf,
}

impl Store {
    pub fn open(dir: &Path) -> Self {
        Self { path: dir.join(FILE), checkout_path: dir.join(CHECKOUT_FILE) }
    }

    fn set_up(&self) -> Vec<String> {
        std::fs::read(&self.checkout_path).ok().and_then(|bytes| serde_json::from_slice::<SetUp>(&bytes).ok()).map(|record| record.paths).unwrap_or_default()
    }

    /// Remember `paths` as set up, for good.
    fn mark_set_up(&self, paths: &[String]) -> Result<()> {
        let mut known = self.set_up();
        let before = known.len();
        for path in paths {
            if !known.contains(path) {
                known.push(path.clone());
            }
        }
        if known.len() == before {
            return Ok(());
        }
        crate::cloud_bootstrap::write_durable(&self.checkout_path, &serde_json::to_vec(&SetUp { v: 1, paths: known })?)
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
    /// How often a running clone asks whether its create was canceled.
    pub cancel_poll: Duration,
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
        let mut retries = 0usize;
        loop {
            match self.pass_once() {
                // A repository could not be set up for a reason that may
                // pass (access not granted yet, the network): claim and try
                // again later. Nothing runs in between, so the workspace is
                // free to go idle.
                Ok((pass, true)) => {
                    if let Pass::Settled(state) = pass {
                        log::info!("launch intent settled: {state}");
                    }
                    std::thread::sleep(checkout_retry_delay(retries));
                    retries += 1;
                    failures = 0;
                }
                Ok((Pass::None, false)) => return,
                Ok((Pass::Settled(state), false)) => {
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
        self.pass_once().map(|(pass, _)| pass)
    }

    /// One pass, and whether a checkout failed in a way worth trying again.
    pub(crate) fn pass_once(&self) -> Result<(Pass, bool), CallError> {
        match self.attempt() {
            Err(CallError::Settled(state)) => Ok((Pass::Settled(state), false)),
            other => other,
        }
    }

    fn attempt(&self) -> Result<(Pass, bool), CallError> {
        let claimed = self.api.claim(&self.incarnation)?;
        let mut retry = false;
        // Sent only when there is no prompt to deliver; a launch being
        // delivered sets its repositories up itself.
        if let Some(plan) = claimed.checkout.as_ref().filter(|_| claimed.launch.as_ref().is_none_or(|claim| claim.state != "deliver")) {
            let results = self.ensure_checkout(plan);
            retry = results.iter().any(|result| result.state == "failed" && !result.category.as_deref().is_some_and(|category| CHECKOUT_FINAL.contains(&category)));
            if !results.is_empty() {
                // The report is for the person; failing to send it changes nothing here.
                if let Err(error) = self.api.report_checkout(&results) {
                    log::warn!("checkout report: {error}");
                }
            }
        }
        let Some(claim) = claimed.launch else { return Ok((Pass::None, retry)) };
        if claim.state != "deliver" {
            return Ok((Pass::Settled(claim.state), retry));
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
            Completed::Settled(state) | Completed::Conflict(state) => Ok((Pass::Settled(state), false)),
            Completed::NotFound => Ok((Pass::Settled("not-found".into()), false)),
        }
    }

    /// Set up every repository of `plan` that is not set up yet: clone it,
    /// then cut the workspace's work branch. One that fails is logged and
    /// left for the next boot; the others are still done.
    fn ensure_checkout(&self, plan: &CheckoutPlan) -> Vec<CheckoutResult> {
        let known = self.store.set_up();
        let pending: Vec<&Repository> = plan.repositories.iter().filter(|repository| repository.clone.is_some() && !known.contains(&repository.path)).collect();
        if pending.is_empty() {
            return Vec::new();
        }
        if !valid_branch(&plan.work_branch) || plan.repositories.len() > MAX_REPOSITORIES {
            log::warn!("checkout plan refused: invalid work branch or too many repositories");
            return pending.iter().take(MAX_REPOSITORIES).map(|repository| CheckoutResult::failed(repository, "payload-invalid")).collect();
        }
        // Work, like a launch: a clone must not be cut short by idle suspend.
        let _launching = crate::cloud_activity::launching();
        let deadline = std::time::Instant::now() + CLONE_BUDGET;
        let mut results = Vec::new();
        for repository in pending {
            if let Err(error) = validate_repository(repository, &self.root) {
                log::warn!("checkout plan: {}/{} refused: {error:#}", repository.owner, repository.name);
                results.push(CheckoutResult::failed(repository, "payload-invalid"));
                continue;
            }
            // A checkout from before this runtime kept a record (or made by
            // a launch on an older runtime) is adopted as it is: its branch
            // is the person's by now.
            if !Path::new(&repository.path).join(".git").exists() {
                let within = deadline.saturating_duration_since(std::time::Instant::now());
                match self.checkout.clone_missing(repository, within, &|| false) {
                    Ok(()) => {}
                    Err(CloneError::Canceled) => continue,
                    Err(CloneError::Failed { category, detail }) => {
                        // Git's own words stay in this log; the server gets the category.
                        log::warn!("checkout {}/{}: {category}: {detail}", repository.owner, repository.name);
                        results.push(CheckoutResult::failed(repository, category));
                        continue;
                    }
                }
                if let Err(error) = self.checkout.prepare(repository, &plan.work_branch) {
                    log::warn!("checkout {}/{}: work branch: {error:#}", repository.owner, repository.name);
                    results.push(CheckoutResult::failed(repository, "branch-create-failed"));
                    continue;
                }
            }
            if let Err(error) = self.store.mark_set_up(std::slice::from_ref(&repository.path)) {
                log::warn!("record the checkout of {}: {error:#}", repository.path);
            }
            results.push(CheckoutResult::ready(repository));
        }
        results
    }

    fn launch(&self, claim: &Claim) -> Result<Outcome, CallError> {
        // Counted as work until it returns: a clone can outlast the idle
        // window with nobody attached, and a suspend in the middle would
        // leave the launch `outcome-unknown` with nothing cloned.
        let _launching = crate::cloud_activity::launching();
        if let Err(error) = validate(claim, &self.root) {
            log::warn!("launch intent {}: {error:#}", claim.launch_id);
            return Ok(self.finish(claim, Outcome::failed("payload-invalid", Vec::new())));
        }
        if let Err(error) = crate::harness::claude::models::validate(&claim.agent, claim.model.as_deref().unwrap_or_default()) {
            log::warn!("launch intent {}: {error:#}", claim.launch_id);
            return Ok(self.finish(claim, Outcome::failed("agent-model-unavailable", Vec::new())));
        }
        if let Some(state) = self.api.phase(&claim.launch_id, "syncing-repository")? {
            return Err(CallError::Settled(state));
        }
        if claim.repositories.is_empty() {
            // A blank project: an empty folder, made a Git repository so the
            // Changes and Git panels work. Not being able to is no reason to
            // withhold the agent; it is not reported as a branch either.
            if let Err(error) = self.checkout.prepare_blank(&self.root, &claim.work_branch) {
                log::warn!("prepare the blank project folder: {error:#}");
            }
        }
        let mut branches = Vec::new();
        let clone_deadline = std::time::Instant::now() + CLONE_BUDGET;
        // A create canceled while Git runs: asked every `CANCEL_POLL`, so Git
        // is killed instead of running on for a workspace nobody wants. An
        // unreachable API is not a cancel.
        let settled: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
        let asked = std::sync::Mutex::new(std::time::Instant::now());
        let canceled = || {
            let mut asked = asked.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if asked.elapsed() < self.cancel_poll {
                return false;
            }
            *asked = std::time::Instant::now();
            match self.api.phase(&claim.launch_id, "syncing-repository") {
                Ok(Some(state)) => {
                    *settled.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(state);
                    true
                }
                _ => false,
            }
        };
        for repository in claim.repositories.iter().filter(|repository| repository.clone.is_some()) {
            let within = clone_deadline.saturating_duration_since(std::time::Instant::now());
            match self.checkout.clone_missing(repository, within, &canceled) {
                Ok(()) => {}
                Err(CloneError::Canceled) => {
                    let state = settled.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
                    return Err(CallError::Settled(state.unwrap_or_else(|| "canceled".into())));
                }
                Err(CloneError::Failed { category, detail }) => {
                    log::warn!("clone {}/{}: {category}: {detail}", repository.owner, repository.name);
                    return Ok(self.finish(claim, Outcome::failed(category, branches)));
                }
            }
        }
        for repository in &claim.repositories {
            match self.checkout.prepare(repository, &claim.work_branch) {
                Ok(branch) => branches.push(branch),
                Err(error) => {
                    log::warn!("prepare {}/{}: {error:#}", repository.owner, repository.name);
                    return Ok(self.finish(claim, Outcome::failed("repository-sync-failed", branches)));
                }
            }
        }
        // Set up by this launch: a later checkout plan leaves them alone.
        let cloned: Vec<String> = claim.repositories.iter().filter(|repository| repository.clone.is_some()).map(|repository| repository.path.clone()).collect();
        if let Err(error) = self.store.mark_set_up(&cloned) {
            log::warn!("record the launch's checkouts: {error:#}");
        }
        // Checked again right before the agent is touched: a create canceled
        // while the repositories were prepared is never delivered.
        if let Some(state) = self.api.phase(&claim.launch_id, "starting-agent")? {
            return Err(CallError::Settled(state));
        }
        if !self.starter.available(&claim.agent) {
            return Ok(self.finish(claim, Outcome::failed("agent-unavailable", branches)));
        }
        // A prompt sent to an agent at its sign-in screen is never read: fail
        // now, with the reason, instead of leaving a tab that looks busy.
        if claim.prompt.is_some() && self.starter.sign_in_required(&claim.agent) {
            return Ok(self.finish(claim, Outcome::failed("agent-sign-in-required", branches)));
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

/// How long to wait before trying a failed checkout the `attempt`-th time again.
fn checkout_retry_delay(attempt: usize) -> Duration {
    CHECKOUT_RETRY[attempt.min(CHECKOUT_RETRY.len() - 1)]
}

fn validate(claim: &Claim, root: &Path) -> Result<()> {
    if !valid_branch(&claim.work_branch) {
        bail!("invalid work branch");
    }
    if claim.repositories.len() > MAX_REPOSITORIES {
        bail!("too many repositories");
    }
    for repository in &claim.repositories {
        validate_repository(repository, root)?;
    }
    if claim.prompt.as_ref().is_some_and(|prompt| prompt.len() > MAX_PROMPT_BYTES || prompt.contains('\0')) {
        bail!("invalid prompt");
    }
    if !valid_agent(&claim.agent) {
        bail!("invalid agent");
    }
    Ok(())
}

fn validate_repository(repository: &Repository, root: &Path) -> Result<()> {
    if repository.base_ref.as_deref().is_some_and(|base| !valid_branch(base)) {
        bail!("invalid base ref");
    }
    if !valid_repository_path(&repository.path) {
        bail!("invalid repository path");
    }
    if let Some(source) = &repository.clone {
        if source.provider != GITHUB_PROVIDER || !valid_github_name(&repository.owner) || !valid_github_name(&repository.name) {
            bail!("invalid clone source");
        }
        // Only ever a new directory directly in the project root.
        if Path::new(&repository.path).parent() != Some(root) {
            bail!("clone path outside the project root");
        }
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

/// One segment of `owner/name` as it goes into the clone URL.
fn valid_github_name(name: &str) -> bool {
    (1..=100).contains(&name.len()) && name != "." && name != ".." && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-'))
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
///
/// A repository marked `clone` is cloned first, from `<remote>/<owner>/<name>.git`
/// with no credential in the URL: Git asks its configured credential helper.
pub struct GitCheckout {
    remote: String,
}

impl Default for GitCheckout {
    fn default() -> Self {
        Self { remote: GITHUB.into() }
    }
}

impl GitCheckout {
    /// Clones from `remote` instead of github.com, for tests.
    #[cfg(test)]
    pub(crate) fn from_remote(remote: &str) -> Self {
        Self { remote: remote.into() }
    }

    fn clone_url(&self, repository: &Repository) -> String {
        format!("{}/{}/{}.git", self.remote, repository.owner, repository.name)
    }
}

fn is_empty_dir(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
}

impl Checkout for GitCheckout {
    fn clone_missing(&self, repository: &Repository, within: Duration, canceled: &dyn Fn() -> bool) -> std::result::Result<(), CloneError> {
        let path = Path::new(&repository.path);
        let url = self.clone_url(repository);
        if path.join(".git").exists() {
            // This workspace's clone from an earlier attempt: kept as it is.
            let origin = crate::git::run(path, &["remote", "get-url", "origin"]).unwrap_or_default();
            if origin.trim() != url {
                return Err(CloneError::failed(PATH_OCCUPIED, format!("{} is a checkout of another repository", repository.path)));
            }
            return Ok(());
        }
        if path.exists() && !is_empty_dir(path) {
            // Never deleted: it may be someone's work.
            return Err(CloneError::failed(PATH_OCCUPIED, format!("{} exists and is not a checkout", repository.path)));
        }
        let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
            return Err(CloneError::failed(CLONE_FAILED, "no directory to clone into"));
        };
        std::fs::create_dir_all(parent).map_err(CloneError::io)?;
        // Cloned next to its place and moved in whole, so a clone that died
        // halfway is never mistaken for a checkout. A leftover is our own.
        let staging = parent.join(format!("{STAGING_PREFIX}{}", name.to_string_lossy()));
        if staging.exists() {
            std::fs::remove_dir_all(&staging).map_err(CloneError::io)?;
        }
        let staging_arg = staging.to_string_lossy().into_owned();
        let mut args = vec!["-c", LOW_SPEED_LIMIT, "-c", LOW_SPEED_TIME, "clone", "--quiet"];
        if let Some(base) = repository.base_ref.as_deref() {
            args.extend(["--branch", base]);
        }
        args.extend(["--", &url, &staging_arg]);
        use crate::git::RunError;
        let cloned = match crate::git::run_within(parent, &args, within, canceled) {
            Ok(()) if crate::git::head_commit(&staging).is_none() => Err(CloneError::failed(REPOSITORY_EMPTY, "the repository has no commits")),
            Ok(()) => Ok(()),
            Err(RunError::Stopped) => Err(CloneError::Canceled),
            Err(RunError::TimedOut) => Err(CloneError::failed(CLONE_TIMED_OUT, format!("not finished after {} s", within.as_secs()))),
            Err(RunError::Failed(stderr)) => Err(CloneError::failed(clone_failure_category(&stderr), stderr)),
            Err(RunError::Spawn(error)) => Err(CloneError::io(error)),
        };
        if let Err(error) = cloned {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
        if path.exists() {
            std::fs::remove_dir(path).map_err(CloneError::io)?;
        }
        std::fs::rename(&staging, path).map_err(CloneError::io)
    }

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

    fn prepare_blank(&self, root: &Path, work_branch: &str) -> Result<()> {
        init_blank_repository(root, work_branch).map(|_| ())
    }
}

/// Directories never searched for repositories (as `git.repositories` skips them).
const SKIPPED_DIRS: &[&str] = &["node_modules", "target", "vendor", "dist", "build"];

/// A Git repository at `root` or up to two levels below it.
fn contains_repository(root: &Path) -> bool {
    let mut frontier = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = frontier.pop() {
        if dir.join(".git").exists() {
            return true;
        }
        if depth >= 2 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || SKIPPED_DIRS.contains(&name.as_str()) {
                continue;
            }
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                frontier.push((entry.path(), depth + 1));
            }
        }
    }
    false
}

/// Make a folder with no repository a Git repository on `branch`, with an
/// empty first commit so worktrees can be cut from it. A folder that is, or
/// holds, a repository (an environment image's checkouts) is left alone.
/// Returns whether it initialised one.
pub fn init_blank_repository(root: &Path, branch: &str) -> Result<bool> {
    std::fs::create_dir_all(root)?;
    if crate::git::is_repo(root) || contains_repository(root) {
        return Ok(false);
    }
    if !valid_branch(branch) {
        bail!("invalid branch name");
    }
    crate::git::run(root, &["init", "-q"])?;
    crate::git::run(root, &["symbolic-ref", "HEAD", &format!("refs/heads/{branch}")])?;
    // The runtime has no Git identity of its own; this commit only anchors the branch.
    crate::git::run(root, &["-c", "user.name=TerminalX", "-c", "user.email=runtime@terminalx.invalid", "commit", "--allow-empty", "-q", "-m", "Start the project"])?;
    Ok(true)
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

    fn sign_in_required(&self, agent: &str) -> bool {
        crate::cloud_grants::sign_in_required_at_launch(agent).is_some()
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
                tab: Some(new_tab(claim)),
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
