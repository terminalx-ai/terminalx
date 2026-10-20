//! Who is working on an issue, across this person's machines and their team
//! (#441, docs/ISSUE-WORK-STATUS.md).
//!
//! This Mac publishes a *work claim* for each of its sessions linked to an
//! issue: the issue, the session's title and branch, a coarse state and how
//! long ago it was last active. The Issues list on any machine reads the
//! claims its reader may see. The account service decides who that is: the
//! same person on every machine, and teammates in an organization that
//! connected the repository. Nothing else about a session leaves the machine
//! (`claims.rs`).
//!
//! Publishing follows the session index: a change (a new link, a status
//! transition, an archive, a delete) is sent a few seconds after it settles,
//! and the whole set again every couple of minutes as a heartbeat. A machine
//! that stops refreshing keeps its last state, aged, on the others.
//! Withdrawal is publishing without the claim; signing out withdraws them all.

pub mod claims;
pub mod client;
pub mod links;

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use url::Url;

use crate::account::AccountManager;
use crate::store::index::{self, IssueLinkSource, IssueRef, SessionEntry};
use claims::{Claim, CloudSession, Inputs, PullRequestState};
use client::{Client, OrganizationWorkStatus, OrganizationWorkStatusPatch, RemoteClaim, WorkClaimsError};
use links::{BranchPull, Linker, Lookup};

/// The server's capability flag for these routes.
pub const CAPABILITY: &str = "account.work-claims.v1";
/// How long a change settles before it is sent.
const DEBOUNCE: Duration = Duration::from_secs(3);
/// The server takes one publish per device this often; a change that comes
/// sooner waits for it.
const MIN_GAP: Duration = Duration::from_secs(2);
/// How often the loop looks at the index.
const TICK: Duration = Duration::from_secs(1);
/// The heartbeat when the server names none, and its bounds.
const DEFAULT_REFRESH: Duration = Duration::from_secs(120);
const MIN_REFRESH: Duration = Duration::from_secs(30);
const MAX_REFRESH: Duration = Duration::from_secs(600);
/// The longest wait after failed publishes.
const MAX_BACKOFF: Duration = Duration::from_secs(5 * 60);
/// How long a project's remote is believed.
const REMOTE_FOR: Duration = Duration::from_secs(10 * 60);
/// The most issue scopes one read asks about.
const MAX_SCOPES: usize = 10;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// Signing out waits this long at most for the withdrawal.
const SIGN_OUT_TIMEOUT: Duration = Duration::from_secs(5);

/// What the Issues list is told: the claims, or why there are none to show.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkClaimsAnswer {
    /// False when only this machine's sessions can be shown.
    pub available: bool,
    /// `signed_out`, `unsupported`, `offline` or `unavailable`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The server's clock, epoch milliseconds: ages are measured from it.
    pub now: i64,
    pub live_for_seconds: u64,
    /// Every claim but this machine's own local ones, which the window
    /// knows better from its own sessions.
    pub claims: Vec<RemoteClaim>,
}

impl WorkClaimsAnswer {
    fn unavailable(reason: &str) -> Self {
        Self { available: false, reason: Some(reason.into()), now: chrono::Utc::now().timestamp_millis(), live_for_seconds: 300, claims: vec![] }
    }
}

struct Sent {
    user_id: String,
    device_id: String,
    label: String,
    shape: Vec<(Claim, i64)>,
    at: Instant,
    refresh_after: Duration,
}

#[derive(Clone)]
struct CloudIssue {
    names: Vec<String>,
    issue: Option<IssueRef>,
    /// False while a tracker could not say: looked for again in the next pass.
    settled: bool,
    /// The Linear teams answer it was looked for under ([`Linker::teams_answer`]).
    teams: u64,
}

#[derive(Default)]
struct State {
    nudged: bool,
    stopped: bool,
    /// The cloud sessions the window last handed over.
    cloud: Vec<CloudSession>,
    /// The issue each cloud session's branch names, by its claim id, with the
    /// names it was looked for under and whether the trackers' answer was final.
    cloud_issues: HashMap<String, CloudIssue>,
    sent: Option<Sent>,
    /// When the last publish was sent, answered or not.
    last_put: Option<Instant>,
    failures: u32,
    retry_at: Option<Instant>,
    remotes: HashMap<String, (Instant, Option<String>)>,
}

pub struct WorkClaims {
    account: Arc<AccountManager>,
    host_id: Box<dyn Fn() -> Option<String> + Send + Sync>,
    /// The host id once read: it does not change while the app runs.
    device: Mutex<Option<String>>,
    client: Client,
    sign_out_client: Client,
    state: Mutex<State>,
    wake: Condvar,
    app: OnceLock<AppHandle>,
}

fn backoff(failures: u32) -> Duration {
    Duration::from_secs(15u64.saturating_mul(1 << failures.min(5))).min(MAX_BACKOFF)
}

impl WorkClaims {
    pub fn new(account: Arc<AccountManager>, host_id: impl Fn() -> Option<String> + Send + Sync + 'static) -> Self {
        let base = Url::parse(&crate::account::api_base_url()).expect("valid account service URL");
        Self::with_base(account, host_id, base)
    }

    fn with_base(account: Arc<AccountManager>, host_id: impl Fn() -> Option<String> + Send + Sync + 'static, base: Url) -> Self {
        Self {
            account,
            host_id: Box::new(host_id),
            device: Mutex::new(None),
            client: Client::new(base.clone(), REQUEST_TIMEOUT),
            sign_out_client: Client::new(base, SIGN_OUT_TIMEOUT),
            state: Mutex::new(State::default()),
            wake: Condvar::new(),
            app: OnceLock::new(),
        }
    }

    /// Start publishing. Links the loop finds are announced to the window.
    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let _ = self.app.set(app);
        let service = self.clone();
        std::thread::Builder::new().name("work-claims".into()).spawn(move || service.run(&Desktop)).expect("start the work status publisher");
    }

    /// Something the index does not show changed (a setting, the cloud
    /// sessions, the account): publish again soon.
    pub fn nudge(&self) {
        self.state.lock().unwrap().nudged = true;
        self.wake.notify_all();
    }

    pub fn stop(&self) {
        self.state.lock().unwrap().stopped = true;
        self.wake.notify_all();
    }

    fn device_id(&self) -> Option<String> {
        let mut device = self.device.lock().unwrap();
        if device.is_none() {
            *device = (self.host_id)();
        }
        device.clone()
    }

    fn run(&self, lookup: &dyn Lookup) {
        let mut linker = Linker::default();
        let mut seen = u64::MAX;
        let mut account = None;
        let mut dirty_since: Option<Instant> = None;
        let mut linked: Option<(Instant, u64)> = None;
        loop {
            let nudged = {
                let state = self.state.lock().unwrap();
                let (mut state, _) = self.wake.wait_timeout_while(state, TICK, |state| !state.nudged && !state.stopped).unwrap();
                if state.stopped {
                    return;
                }
                std::mem::take(&mut state.nudged)
            };
            let revision = index::revision();
            // A sign-in, or another account, is published to at once.
            let signed_in = self.account.current_account_key();
            if nudged || revision != seen || signed_in != account {
                seen = revision;
                account = signed_in;
                dirty_since.get_or_insert_with(Instant::now);
            }
            let settled = dirty_since.is_some_and(|since| since.elapsed() >= DEBOUNCE);
            let link_due = linked.is_none_or(|(at, revision)| at.elapsed() >= links::PULL_REQUEST_EVERY || (settled && revision != seen));
            if link_due {
                self.link_pass(&mut linker, lookup);
                // Its own writes are not a change to look at again.
                seen = index::revision();
                linked = Some((Instant::now(), seen));
            }
            let (heartbeat, retry) = {
                let state = self.state.lock().unwrap();
                (state.sent.as_ref().is_some_and(|sent| sent.at.elapsed() >= sent.refresh_after), state.retry_at.is_some_and(|at| Instant::now() >= at))
            };
            if (settled || heartbeat || retry || link_due) && self.publish(&linker) {
                dirty_since = None;
            }
        }
    }

    /// Link what the linker finds, and find the issues of the cloud sessions.
    fn link_pass(&self, linker: &mut Linker, lookup: &dyn Lookup) {
        let sessions = index::load().unwrap_or_default();
        for (session_id, issue, source) in linker.pass(lookup, &sessions).links {
            match write_link(&session_id, issue, source) {
                Ok(Some(session)) => self.announce(&session),
                Ok(None) => {}
                Err(error) => log::warn!("link a session to its issue: {error:#}"),
            }
        }
        let cloud = self.state.lock().unwrap().cloud.clone();
        let mut found = HashMap::new();
        for session in &cloud {
            let names: Vec<String> = [session.branch.as_deref(), session.worktree_name.as_deref()].into_iter().flatten().map(String::from).collect();
            let teams = linker.teams_answer(lookup);
            let known = self.state.lock().unwrap().cloud_issues.get(&session.claim_id()).filter(|known| known.settled && known.names == names && known.teams == teams).cloned();
            let looked = match known {
                Some(known) => known,
                None => {
                    let (issue, settled) = linker.cloud_issue(lookup, session.repository.as_deref(), &names.iter().map(String::as_str).collect::<Vec<_>>());
                    CloudIssue { names, issue, settled, teams }
                }
            };
            found.insert(session.claim_id(), looked);
        }
        self.state.lock().unwrap().cloud_issues = found;
    }

    fn announce(&self, session: &SessionEntry) {
        if let Some(app) = self.app.get() {
            let _ = app.emit("session_updated", session);
        }
    }

    fn remote(&self, project_path: &str) -> Option<String> {
        if let Some((at, remote)) = self.state.lock().unwrap().remotes.get(project_path) {
            if at.elapsed() < REMOTE_FOR {
                return remote.clone();
            }
        }
        let remote = crate::git::remote_url(std::path::Path::new(project_path)).and_then(|url| claims::normalize_remote(&url));
        self.state.lock().unwrap().remotes.insert(project_path.to_string(), (Instant::now(), remote.clone()));
        remote
    }

    /// Send this device's claims if they changed or the heartbeat is due.
    /// False when a change has to wait for [`MIN_GAP`]: call again soon.
    fn publish(&self, linker: &Linker) -> bool {
        let Some(context) = self.account.context() else {
            // The token is gone with the session; sign-out withdrew what it could.
            self.state.lock().unwrap().sent = None;
            return true;
        };
        if !self.account.has_capability(CAPABILITY) {
            return true;
        }
        let Some(device_id) = self.device_id() else { return true };
        let label = crate::pairing::PairingManager::host_name(&context.user_id);
        let sessions = index::load().unwrap_or_default();
        let settings = crate::store::settings::load();
        let now = chrono::Utc::now();
        let cloud: Vec<(CloudSession, IssueRef)> = {
            let state = self.state.lock().unwrap();
            state
                .cloud
                .iter()
                .filter(|session| session.created_by.as_deref() == Some(context.user_id.as_str()))
                .filter_map(|session| Some((session.clone(), state.cloud_issues.get(&session.claim_id())?.issue.clone()?)))
                .collect()
        };
        let remote = |path: &str| self.remote(path);
        let pull_request = |session_id: &str| linker.pull_request(session_id);
        let inputs = Inputs { now, share_with_team: settings.work_status.share_with_team, remote: &remote, pull_request: &pull_request };
        let claims = claims::claims(&sessions, &cloud, &inputs);
        let shape: Vec<(Claim, i64)> = claims.iter().map(|claim| claim.shape(now)).collect();
        {
            let state = self.state.lock().unwrap();
            let unchanged = state.sent.as_ref().is_some_and(|sent| sent.user_id == context.user_id && sent.device_id == device_id && sent.label == label && sent.shape == shape && sent.at.elapsed() < sent.refresh_after);
            if unchanged && state.retry_at.is_none() {
                return true;
            }
            if state.retry_at.is_some_and(|at| Instant::now() < at) {
                return true;
            }
            if state.last_put.is_some_and(|at| at.elapsed() < MIN_GAP) {
                return false;
            }
        }
        self.state.lock().unwrap().last_put = Some(Instant::now());
        let result = self.client.publish(&context.access_token, &device_id, &label, &claims);
        let mut state = self.state.lock().unwrap();
        match result {
            Ok(published) if self.account.scope_if_same_account(&context).is_some() => {
                let refresh_after = published.refresh_after_seconds.map(Duration::from_secs).unwrap_or(DEFAULT_REFRESH).clamp(MIN_REFRESH, MAX_REFRESH);
                state.sent = Some(Sent { user_id: context.user_id, device_id, label, shape, at: Instant::now(), refresh_after });
                state.failures = 0;
                state.retry_at = None;
            }
            Ok(_) => {}
            Err(error) => {
                if !error.is_offline() {
                    log::warn!("publish work status: {} ({:?})", error.code, error.status);
                }
                state.failures = state.failures.saturating_add(1);
                // A server that asked for a wait (too many publishes) gets at least that.
                let asked = Duration::from_secs(error.retry_after_seconds.unwrap_or(0));
                state.retry_at = Some(Instant::now() + backoff(state.failures).max(asked));
            }
        }
        true
    }

    /// Withdraw this Mac's claims before the account's token goes.
    pub fn sign_out(&self) {
        let sent = self.state.lock().unwrap().sent.take();
        let (Some(sent), Some(context)) = (sent, self.account.context()) else { return };
        if sent.user_id == context.user_id {
            if let Err(error) = self.sign_out_client.withdraw(&context.access_token, &sent.device_id) {
                log::info!("withdraw work status at sign-out: {}", error.code);
            }
        }
    }

    /// Hand over the cloud sessions the window knows about.
    pub fn set_cloud(&self, sessions: Vec<CloudSession>) {
        let mut state = self.state.lock().unwrap();
        if state.cloud == sessions {
            return;
        }
        state.cloud = sessions;
        state.nudged = true;
        drop(state);
        self.wake.notify_all();
    }

    /// The claims the reader may see on these issues: for GitHub, those of
    /// the project's repository; for Linear, those of the issues' workspaces.
    pub fn list(&self, project_path: &str, provider: &str, issue_urls: &[String]) -> WorkClaimsAnswer {
        let Some(context) = self.account.context() else { return WorkClaimsAnswer::unavailable("signed_out") };
        if !self.account.has_capability(CAPABILITY) {
            return WorkClaimsAnswer::unavailable("unsupported");
        }
        if !matches!(provider, "github" | "linear") {
            return WorkClaimsAnswer::unavailable("unavailable");
        }
        let mut scopes = BTreeSet::new();
        if provider == "github" {
            if let Some(remote) = self.remote(project_path).filter(|remote| remote.starts_with("github.com/") && remote.matches('/').count() == 2) {
                scopes.insert(remote);
            }
        }
        scopes.extend(issue_urls.iter().filter_map(|url| claims::issue_scope(provider, url)));
        let scopes: Vec<String> = scopes.into_iter().take(MAX_SCOPES).collect();
        if scopes.is_empty() {
            return WorkClaimsAnswer { available: true, reason: None, now: chrono::Utc::now().timestamp_millis(), live_for_seconds: 300, claims: vec![] };
        }
        let result = self.client.list(&context.access_token, provider, &scopes);
        if self.account.scope_if_same_account(&context).is_none() {
            return WorkClaimsAnswer::unavailable("signed_out");
        }
        let device = self.device_id();
        match result {
            Ok(listed) => WorkClaimsAnswer {
                available: true,
                reason: None,
                now: listed.now,
                live_for_seconds: listed.live_for_seconds,
                claims: listed.claims.into_iter().filter(|claim| !(claim.person.you && !claim.cloud && claim.device.as_ref().map(|d| &d.id) == device.as_ref())).collect(),
            },
            Err(error) => WorkClaimsAnswer::unavailable(if error.is_offline() { "offline" } else { "unavailable" }),
        }
    }

    fn organization_token(&self, organization_id: &str) -> Result<String, WorkClaimsError> {
        let valid = !organization_id.is_empty() && organization_id.len() <= 128 && organization_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b':' | b'-'));
        if !valid {
            return Err(WorkClaimsError::local("invalid_request"));
        }
        let context = self.account.context().ok_or_else(|| WorkClaimsError::local("account_signed_out"))?;
        let scope = self.account.current_scope().ok_or_else(|| WorkClaimsError::local("account_signed_out"))?;
        if !scope.kept_orgs().contains(organization_id) {
            return Err(WorkClaimsError::local("cloud_organization_unavailable"));
        }
        if !self.account.has_capability(CAPABILITY) {
            return Err(WorkClaimsError::local("work_claims_unsupported"));
        }
        Ok(context.access_token)
    }

    pub fn organization(&self, organization_id: &str) -> Result<OrganizationWorkStatus, WorkClaimsError> {
        let token = self.organization_token(organization_id)?;
        self.client.organization(&token, organization_id)
    }

    pub fn set_organization(&self, organization_id: &str, patch: &OrganizationWorkStatusPatch) -> Result<OrganizationWorkStatus, WorkClaimsError> {
        let token = self.organization_token(organization_id)?;
        self.client.set_organization(&token, organization_id, patch)
    }
}

/// Link a session the linker found, unless it got an issue meanwhile or the
/// reader unlinked this one. Linking is not activity: `modified` stays.
fn write_link(session_id: &str, issue: IssueRef, source: IssueLinkSource) -> Result<Option<SessionEntry>> {
    index::update(|sessions| {
        let Some(session) = sessions.iter_mut().find(|session| session.id == session_id) else { return Ok(None) };
        if session.issue.is_some() || session.issue_work.unlinked.contains(&issue.url) {
            return Ok(None);
        }
        session.issue = Some(issue);
        session.issue_work.link = Some(source);
        Ok(Some(session.clone()))
    })
}

fn valid_issue(issue: &IssueRef) -> Result<()> {
    let web = issue.url.starts_with("https://") || issue.url.starts_with("http://");
    if !matches!(issue.provider.as_str(), "github" | "linear") || issue.id.trim().is_empty() || issue.identifier.trim().is_empty() || !web {
        bail!("That is not an issue to link to.");
    }
    Ok(())
}

/// "Link to issue…": the session works on `issue` from now on.
pub fn link_issue(session_id: &str, issue: IssueRef) -> Result<SessionEntry> {
    valid_issue(&issue)?;
    index::update(|sessions| {
        let session = sessions.iter_mut().find(|session| session.id == session_id).ok_or_else(|| anyhow!("session {session_id} not found"))?;
        if session.is_quick() {
            bail!("A quick chat has no project, so it cannot work on an issue.");
        }
        session.issue_work.unlinked.retain(|url| *url != issue.url);
        session.issue = Some(issue);
        session.issue_work.link = Some(IssueLinkSource::Manual);
        Ok(session.clone())
    })
}

/// "Unlink": the session works on no issue, and this one is never linked
/// to it again automatically. Its claim goes with the next publish.
pub fn unlink_issue(session_id: &str) -> Result<SessionEntry> {
    index::update(|sessions| {
        let session = sessions.iter_mut().find(|session| session.id == session_id).ok_or_else(|| anyhow!("session {session_id} not found"))?;
        if let Some(issue) = session.issue.take() {
            if !session.issue_work.unlinked.contains(&issue.url) {
                session.issue_work.unlinked.push(issue.url);
            }
        }
        session.issue_work.link = None;
        Ok(session.clone())
    })
}

/// "Don't share this session": its work status stays on this machine.
pub fn set_private(session_id: &str, private: bool) -> Result<SessionEntry> {
    index::update(|sessions| {
        let session = sessions.iter_mut().find(|session| session.id == session_id).ok_or_else(|| anyhow!("session {session_id} not found"))?;
        session.issue_work.private = private;
        Ok(session.clone())
    })
}

/// The trackers and checkouts, as the running app reaches them.
struct Desktop;

fn issue_ref(issue: crate::issues::Issue) -> IssueRef {
    IssueRef { provider: issue.provider, id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url }
}

/// Whether a failed read said there is no such issue, rather than that it
/// could not ask.
fn not_found(error: &anyhow::Error) -> bool {
    let text = format!("{error:#}").to_ascii_lowercase();
    ["could not resolve", "not found", "is a pull request", "did not return that issue", "entity not found"].iter().any(|said| text.contains(said))
}

fn read_issue(result: Result<crate::issues::Issue>) -> Result<Option<IssueRef>, String> {
    match result {
        Ok(issue) if issue.url.contains("/pull/") => Ok(None),
        Ok(issue) => Ok(Some(issue_ref(issue))),
        Err(error) if not_found(&error) => Ok(None),
        Err(error) => Err(format!("{error:#}")),
    }
}

fn linear_key() -> Option<String> {
    crate::store::settings::load().linear_api_key.filter(|key| !key.trim().is_empty())
}

impl Lookup for Desktop {
    fn github_repo(&self, project_path: &str) -> Option<String> {
        crate::issues::github_repo(std::path::Path::new(project_path))
    }

    fn github_issue(&self, project_path: &str, number: &str) -> Result<Option<IssueRef>, String> {
        read_issue(crate::issues::github_details(std::path::Path::new(project_path), number))
    }

    fn github_issue_in(&self, repo: &str, number: &str) -> Result<Option<IssueRef>, String> {
        read_issue(crate::issues::github_details_in(repo, number))
    }

    fn linear_issue(&self, identifier: &str) -> Result<Option<IssueRef>, String> {
        let key = linear_key().ok_or_else(|| "Linear is not connected".to_string())?;
        read_issue(crate::issues::linear_details(&key, identifier))
    }

    fn linear_teams(&self) -> Option<BTreeSet<String>> {
        // Not connected is an answer: there are no Linear candidates.
        let Some(key) = linear_key() else { return Some(BTreeSet::new()) };
        crate::issues::linear_teams(&key).ok().map(|teams| teams.into_iter().map(|team| team.key.to_ascii_uppercase()).collect())
    }

    fn branch_pulls(&self, project_path: &str, branches: &[String]) -> Option<HashMap<String, BranchPull>> {
        let found = crate::github::branch_pr_issues(std::path::Path::new(project_path), branches).map_err(|error| log::debug!("read the pull requests of session branches: {error:#}")).ok()?;
        Some(
            found
                .into_iter()
                .filter_map(|(branch, pr)| Some((branch, BranchPull { state: PullRequestState::parse(&pr.state)?, title: pr.title, body: pr.body, closes: pr.closes })))
                .collect(),
        )
    }

    fn first_request(&self, session: &SessionEntry) -> Option<String> {
        crate::store::conversation_titles::first_request(session)
    }
}

#[cfg(test)]
mod tests;
