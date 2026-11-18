//! Usage of each agent account (#980, docs/AGENT-ACCOUNTS.md).
//!
//! The top-level windows stay This Mac's login (`local`), polled and judged as
//! before. Every added subscription account is polled here with its own
//! credential: a Claude account with the token in the Keychain item Claude
//! Code keys to its directory, else the directory's `.credentials.json`; a
//! Codex account through an app-server whose `CODEX_HOME` is its own
//! directory. Nothing here refreshes, writes or copies a token, and none
//! reaches a log: logs name an account by its opaque id only.
//!
//! Each account has its own gates and backoff, so one account's failure
//! marks that account alone unavailable. Accounts with running tabs poll at
//! the automatic interval; idle ones at most every fifteen minutes.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde_json::Value;

use super::claude_oauth::{self, CredentialError};
use super::{background_floor, AccountUsage, expired, merge_claude_windows, parse_codex_windows, UsageWindow, Verdict, BACKGROUND_REFRESH_MS, CLAUDE_MAX_BACKOFF_MS, MAX_BACKOFF_MS, STALE_MS};
use crate::agent_accounts::{AgentAccountUsage, Kind, LOCAL};

/// How long an account with no running tab reuses its last answer.
const IDLE_REFRESH_MS: i64 = BACKGROUND_REFRESH_MS;
/// How long an account near its switching threshold reuses its last answer
/// (#981): every minute, less the slack the timer is given.
pub(super) const HOT_REFRESH_MS: i64 = 60_000 - super::REFRESH_SLACK_MS;

/// One listed account of one agent, as the index names it.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct Listed {
    pub agent: &'static str,
    pub id: String,
    pub label: String,
    pub kind: Kind,
    /// An added subscription's directory: `CLAUDE_CONFIG_DIR` or `CODEX_HOME`.
    pub dir: Option<PathBuf>,
    /// Its directory was deleted outside the app.
    pub missing: bool,
}

impl Listed {
    /// Polled here: an added subscription. `local` is the top-level windows;
    /// an API key has no subscription windows.
    fn polled(&self) -> bool {
        self.id != LOCAL && self.kind == Kind::Subscription && self.dir.is_some()
    }
}

/// The accounts the index lists for `agent`, in Settings' order.
pub(super) fn listed(agent: &'static str) -> Result<Vec<Listed>> {
    let store = crate::agent_keys::store()?;
    let which = crate::agent_keys::agent_of(agent)?;
    let view = crate::agent_accounts::list_in(&store, which)?;
    Ok(view.accounts.into_iter().map(|account| {
        let added = !account.local && account.kind == Kind::Subscription;
        Listed {
            agent,
            dir: added.then(|| crate::agent_accounts::account_dir(&store.root, which, &account.id)),
            id: account.id,
            label: account.label,
            kind: account.kind,
            missing: account.missing,
        }
    }).collect())
}

/// The accounts of `agent` that have a running tab, from the launch registry.
pub(super) fn running(agent: &str) -> HashSet<String> {
    crate::agent_keys::running(agent).into_iter().filter_map(|tab| tab.account).collect()
}

/// Where an account's usage is read. The real one asks the Keychain, the
/// usage endpoint and Codex; tests answer for each account by its token.
pub(super) trait Reader: Sync {
    /// The access token in Keychain item `service`.
    fn keychain(&self, service: &str) -> Result<String, CredentialError>;
    /// Claude's usage windows, read with `token`.
    fn claude(&self, token: &str, at: i64) -> Result<Vec<UsageWindow>>;
    /// Codex's `account/rateLimits/read` answer from the home `codex_home`.
    fn codex(&self, codex_home: &Path) -> Result<Value>;
}

pub(super) struct Live;

impl Reader for Live {
    fn keychain(&self, service: &str) -> Result<String, CredentialError> {
        claude_oauth::read_keychain_service(service)
    }

    fn claude(&self, token: &str, at: i64) -> Result<Vec<UsageWindow>> {
        claude_oauth::fetch(token, at)
    }

    fn codex(&self, codex_home: &Path) -> Result<Value> {
        use anyhow::Context;
        crate::harness::codex::appserver::ask(
            crate::harness::codex::appserver::Where { codex_home: Some(codex_home), cwd: None },
            "account/rateLimits/read",
            serde_json::json!({}),
        )
        .context("read Codex rate limits")
    }
}

#[derive(Default)]
struct Poll {
    last_attempt: Option<i64>,
    last_success: Option<i64>,
    retry_at: Option<i64>,
    /// The pause follows a failure on this machine (reading the login), so
    /// the button may clear it, as for `local`.
    local_failure: bool,
    failures: u32,
    in_flight: bool,
    error: Option<String>,
}

#[derive(Default)]
struct State {
    /// By window key.
    windows: HashMap<String, UsageWindow>,
    poll: Poll,
}

/// Every agent's listed accounts and each polled account's usage.
#[derive(Default)]
pub(super) struct Accounts {
    listed: HashMap<&'static str, Vec<Listed>>,
    state: HashMap<(&'static str, String), State>,
    /// Accounts automatic switching watches closely (#981), by agent.
    hot: HashMap<&'static str, HashSet<String>>,
}

/// One account's request, decided under the store's lock and made outside it.
pub(super) struct Job {
    agent: &'static str,
    id: String,
    dir: PathBuf,
    started_at: i64,
}

impl Accounts {
    /// Take the index's list for `agent`; an account no longer listed loses
    /// its usage, so a removed and re-added account starts afresh.
    pub(super) fn set_listed(&mut self, agent: &'static str, listed: Vec<Listed>) {
        self.state.retain(|(of, id), _| *of != agent || listed.iter().any(|account| account.polled() && &account.id == id));
        self.listed.insert(agent, listed);
    }

    /// The accounts of `agent` polled every minute, near their switching threshold (#981).
    pub(super) fn set_hot(&mut self, agent: &'static str, hot: HashSet<String>) {
        self.hot.insert(agent, hot);
    }

    /// Whether `agent`'s account `id` is polled every minute.
    pub(super) fn is_hot(&self, agent: &str, id: &str) -> bool {
        self.hot.get(agent).is_some_and(|hot| hot.contains(id))
    }

    /// The requests due for `agent`'s accounts now, each marked in flight.
    pub(super) fn begin(&mut self, agent: &'static str, running: &HashSet<String>, now: i64, manual: bool, cadence: Option<i64>) -> Vec<Job> {
        let Some(listed) = self.listed.get(agent) else { return Vec::new() };
        let mut jobs = Vec::new();
        for account in listed.iter().filter(|account| account.polled()) {
            let state = self.state.entry((agent, account.id.clone())).or_default();
            if account.missing {
                state.poll.error = Some("Sign in again: this account's folder is gone".into());
                continue;
            }
            let floor = if self.hot.get(agent).is_some_and(|hot| hot.contains(&account.id)) {
                background_floor(cadence).min(HOT_REFRESH_MS)
            } else if running.contains(&account.id) {
                background_floor(cadence)
            } else {
                background_floor(cadence).max(IDLE_REFRESH_MS)
            };
            let poll = &mut state.poll;
            if manual && poll.local_failure && !poll.in_flight {
                poll.retry_at = None;
                poll.failures = 0;
                poll.local_failure = false;
            }
            // A window whose deadline has passed since the last request is
            // asked again at once, as `local`'s reset check is.
            let reset_due = state.windows.values().any(|window| expired(window, now)
                && poll.last_attempt.is_none_or(|at| window.resets_at.is_some_and(|reset| at < reset)));
            let recent = poll.last_attempt.is_some_and(|at| now.saturating_sub(at) < floor);
            if poll.in_flight || poll.retry_at.is_some_and(|at| now < at) || (recent && !manual && !reset_due) {
                continue;
            }
            poll.in_flight = true;
            poll.last_attempt = Some(now);
            jobs.push(Job { agent, id: account.id.clone(), dir: account.dir.clone().expect("a polled account has a directory"), started_at: now });
        }
        jobs
    }

    /// Put one request's answer in its account's place, and only there.
    pub(super) fn finish(&mut self, job: &Job, answer: Result<Vec<UsageWindow>>, completed_at: i64) {
        let Some(state) = self.state.get_mut(&(job.agent, job.id.clone())) else {
            // Removed while the request was out.
            return;
        };
        state.poll.in_flight = false;
        match answer {
            Ok(received) => {
                if job.agent == "claude" {
                    // As for `local`: windows the reply omits stay, and an
                    // earlier window never replaces a later one.
                    let decisions = merge_claude_windows(received, &mut state.windows);
                    let taken = decisions.iter().filter(|decision| matches!(decision.verdict, Verdict::Take(_))).count();
                    log::info!("Claude usage of account {}: updated {taken} of {}", job.id, decisions.len());
                } else {
                    // Codex answers with the account's whole state.
                    log::info!("Codex usage of account {}: received {} windows; replaced all", job.id, received.len());
                    state.windows = received.into_iter().map(|window| (window.key.clone(), window)).collect();
                }
                state.poll.last_success = Some(job.started_at);
                state.poll.retry_at = None;
                state.poll.local_failure = false;
                state.poll.failures = 0;
                state.poll.error = None;
            }
            Err(error) => {
                let poll = &mut state.poll;
                poll.failures = poll.failures.saturating_add(1);
                let (base, ceiling) = if job.agent == "claude" { (60_000_i64, CLAUDE_MAX_BACKOFF_MS) } else { (30_000, MAX_BACKOFF_MS) };
                let backoff = base.saturating_mul(1_i64 << poll.failures.saturating_sub(1).min(8)).min(ceiling);
                let provider = error.downcast_ref::<claude_oauth::RetryAfter>().map_or(0, |retry| retry.0);
                poll.retry_at = Some(completed_at.saturating_add(backoff).max(provider));
                poll.local_failure = error.is::<CredentialError>();
                poll.error = Some(format!("{error:#}"));
                log::warn!("{} usage of account {} failed: {error:#}; retry in {} s", job.agent, job.id, backoff / 1000);
            }
        }
    }

    /// Each account of every agent that has more than one, under its label.
    /// `local` shows the top-level windows and their refresh's error.
    pub(super) fn usage(&self, local: impl Fn(&str) -> (Vec<UsageWindow>, Option<String>), now: i64) -> Vec<AccountUsage> {
        let mut agents: Vec<_> = self.listed.iter().filter(|(_, listed)| listed.len() > 1).collect();
        agents.sort_by_key(|(agent, _)| **agent);
        agents.into_iter().flat_map(|(agent, listed)| listed.iter().map(|account| AccountUsage { agent: agent.to_string(), usage: self.one(agent, account, &local, now) }).collect::<Vec<_>>()).collect()
    }

    fn one(&self, agent: &'static str, account: &Listed, local: &impl Fn(&str) -> (Vec<UsageWindow>, Option<String>), now: i64) -> AgentAccountUsage {
        if account.id == LOCAL {
            let (windows, error) = local(agent);
            return AgentAccountUsage { account_id: account.id.clone(), label: account.label.clone(), unavailable: windows.is_empty() && error.is_some(), windows, error };
        }
        if !account.polled() {
            // An API key: no subscription windows to show.
            return AgentAccountUsage { account_id: account.id.clone(), label: account.label.clone(), windows: Vec::new(), error: None, unavailable: true };
        }
        let state = self.state.get(&(agent, account.id.clone()));
        let mut windows: Vec<UsageWindow> = state.map(|state| state.windows.values().map(|window| {
            let mut window = window.clone();
            window.stale = now.saturating_sub(window.updated_at) >= STALE_MS || expired(&window, now);
            window
        }).collect()).unwrap_or_default();
        windows.sort_by(|a, b| b.used_percent.total_cmp(&a.used_percent).then_with(|| a.key.cmp(&b.key)));
        let error = state.and_then(|state| state.poll.error.clone());
        AgentAccountUsage { account_id: account.id.clone(), label: account.label.clone(), unavailable: windows.is_empty() && error.is_some(), windows, error }
    }
}

/// Make each request, every account at once, each with its own credential.
pub(super) fn run(jobs: &[Job], reader: &dyn Reader) -> Vec<Result<Vec<UsageWindow>>> {
    std::thread::scope(|scope| {
        let handles: Vec<_> = jobs.iter().map(|job| scope.spawn(move || read_one(job, reader))).collect();
        handles.into_iter().map(|handle| handle.join().unwrap_or_else(|_| Err(anyhow::anyhow!("the usage read stopped unexpectedly")))).collect()
    })
}

fn read_one(job: &Job, reader: &dyn Reader) -> Result<Vec<UsageWindow>> {
    if job.agent == "claude" {
        let token = claude_oauth::read_account_token(&job.dir, |service| reader.keychain(service))?;
        return reader.claude(&token, job.started_at);
    }
    let result = reader.codex(&job.dir)?;
    let windows = parse_codex_windows(&result, job.started_at);
    anyhow::ensure!(!windows.is_empty(), "Codex reported no usage windows for this account");
    Ok(windows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::usage::UsageStore;
    use serde_json::json;
    use std::sync::Mutex;

    const MINUTE: i64 = 60_000;
    const NOW: i64 = 1_788_000_000_000;

    /// Answers as the Keychain, the usage endpoint and Codex would, each by
    /// the credential it is given, and records what it was asked.
    #[derive(Default)]
    struct Fake {
        /// Keychain service → token.
        keychain: HashMap<String, String>,
        /// Token → five-hour percentage; a token not here is refused.
        usage: HashMap<String, f32>,
        /// Codex home → weekly percentage; a home not here fails.
        codex: HashMap<PathBuf, f32>,
        asked_keychain: Mutex<Vec<String>>,
        asked_tokens: Mutex<Vec<String>>,
    }

    impl Reader for Fake {
        fn keychain(&self, service: &str) -> Result<String, CredentialError> {
            self.asked_keychain.lock().unwrap().push(service.into());
            self.keychain.get(service).cloned().ok_or(CredentialError::NotFound)
        }

        fn claude(&self, token: &str, at: i64) -> Result<Vec<UsageWindow>> {
            self.asked_tokens.lock().unwrap().push(token.into());
            let Some(percent) = self.usage.get(token) else { anyhow::bail!("Claude OAuth usage request failed with HTTP 401") };
            Ok(claude_oauth::parse_response(&json!({"five_hour": {"utilization": percent, "resets_at": (NOW + 120 * MINUTE) / 1000}}), at))
        }

        fn codex(&self, codex_home: &Path) -> Result<Value> {
            let Some(percent) = self.codex.get(codex_home) else { anyhow::bail!("codex app-server exited") };
            Ok(json!({"rateLimits": {"primary": {"usedPercent": percent, "windowDurationMins": 10_080, "resetsAt": (NOW + 600 * MINUTE) / 1000}}}))
        }
    }

    fn account(agent: &'static str, root: &Path, id: &str, label: &str) -> Listed {
        let dir = root.join(agent).join(id);
        std::fs::create_dir_all(&dir).unwrap();
        Listed { agent, id: id.into(), label: label.into(), kind: Kind::Subscription, dir: Some(dir), missing: false }
    }

    fn local(agent: &'static str) -> Listed {
        Listed { agent, id: LOCAL.into(), label: "This Mac's login".into(), kind: Kind::Subscription, dir: None, missing: false }
    }

    fn key(agent: &'static str) -> Listed {
        Listed { agent, id: crate::agent_accounts::SAVED_KEY.into(), label: "API key".into(), kind: Kind::ApiKey, dir: None, missing: false }
    }

    fn service(listed: &Listed) -> String {
        crate::agent_accounts::claude_dir::keychain_service(listed.dir.as_ref().unwrap()).unwrap()
    }

    fn write_credentials(listed: &Listed, token: &str) {
        let body = json!({"claudeAiOauth": {"accessToken": token, "refreshToken": "never-used"}});
        std::fs::write(listed.dir.as_ref().unwrap().join(".credentials.json"), body.to_string()).unwrap();
    }

    fn refresh(store: &UsageStore, agent: &'static str, listed: &[Listed], running: &[&str], manual: bool, reader: &Fake, at: i64) {
        let running = running.iter().map(|id| id.to_string()).collect();
        store.refresh_accounts_with(agent, Some(listed.to_vec()), &running, manual, Some(MINUTE), reader, || at);
    }

    fn usage_of<'a>(snapshot: &'a crate::status::usage::UsageSnapshot, id: &str) -> &'a AgentAccountUsage {
        &snapshot.accounts.iter().find(|account| account.usage.account_id == id).unwrap().usage
    }

    fn percents(usage: &AgentAccountUsage) -> Vec<f32> {
        usage.windows.iter().map(|window| window.used_percent).collect()
    }

    /// Two Claude accounts, two tokens, two sets of windows: one token from
    /// its own Keychain item, the other, with no item, from its directory's
    /// file. The person's own item is never asked for.
    #[test]
    fn two_claude_accounts_are_each_read_with_their_own_token() {
        let root = tempfile::tempdir().unwrap();
        let work = account("claude", root.path(), "aaaa1111bbbb2222", "Work");
        let home = account("claude", root.path(), "cccc3333dddd4444", "Home");
        write_credentials(&home, "token-home");
        let before = std::fs::read(home.dir.as_ref().unwrap().join(".credentials.json")).unwrap();
        let fake = Fake {
            keychain: HashMap::from([(service(&work), "token-work".to_string())]),
            usage: HashMap::from([("token-work".to_string(), 12.0), ("token-home".to_string(), 81.0)]),
            ..Fake::default()
        };
        let store = UsageStore::default();
        let listed = vec![local("claude"), work.clone(), home.clone()];
        refresh(&store, "claude", &listed, &[], false, &fake, NOW);

        let snapshot = store.snapshot_at(&HashSet::new(), NOW);
        assert_eq!(snapshot.accounts.iter().map(|account| account.usage.label.as_str()).collect::<Vec<_>>(), ["This Mac's login", "Work", "Home"]);
        assert_eq!(percents(usage_of(&snapshot, &work.id)), [12.0]);
        assert_eq!(percents(usage_of(&snapshot, &home.id)), [81.0]);
        // The top-level windows stay This Mac's login's.
        assert!(snapshot.windows.is_empty());
        let mut tokens = fake.asked_tokens.lock().unwrap().clone();
        tokens.sort();
        assert_eq!(tokens, ["token-home", "token-work"]);
        let mut asked = fake.asked_keychain.lock().unwrap().clone();
        asked.sort();
        let mut expected = vec![service(&work), service(&home)];
        expected.sort();
        assert_eq!(asked, expected);
        assert!(asked.iter().all(|service| service != "Claude Code-credentials" && service.starts_with("Claude Code-credentials-")));
        // Read, never written: the file is as Claude Code left it.
        assert_eq!(std::fs::read(home.dir.as_ref().unwrap().join(".credentials.json")).unwrap(), before);
        // No token reaches the webview.
        let sent = serde_json::to_string(&snapshot).unwrap();
        assert!(!sent.contains("token-") && !sent.contains("never-used"), "{sent}");
    }

    /// A missing Keychain entry falls back to the directory's file; a
    /// Keychain item, when there is one, wins over the file.
    #[test]
    fn a_missing_keychain_entry_falls_back_to_the_directory_file() {
        let root = tempfile::tempdir().unwrap();
        let listed = account("claude", root.path(), "aaaa1111bbbb2222", "Work");
        let dir = listed.dir.clone().unwrap();
        write_credentials(&listed, "file-token");
        let asked = Mutex::new(Vec::new());
        let token = claude_oauth::read_account_token(&dir, |service| {
            asked.lock().unwrap().push(service.to_string());
            Err(CredentialError::NotFound)
        });
        assert_eq!(token.unwrap(), "file-token");
        assert_eq!(*asked.lock().unwrap(), [service(&listed)]);
        assert_eq!(claude_oauth::read_account_token(&dir, |_| Ok("keychain-token".into())).unwrap(), "keychain-token");
        // Neither: the login is not found, and nothing else is read.
        std::fs::remove_file(dir.join(".credentials.json")).unwrap();
        assert!(matches!(claude_oauth::read_account_token(&dir, |_| Err(CredentialError::NotFound)), Err(CredentialError::NotFound)));
    }

    /// One account's failure marks it alone unavailable; the other's usage,
    /// and This Mac's login's, stay shown.
    #[test]
    fn one_accounts_failure_does_not_hide_the_others_usage() {
        let root = tempfile::tempdir().unwrap();
        let work = account("claude", root.path(), "aaaa1111bbbb2222", "Work");
        let home = account("claude", root.path(), "cccc3333dddd4444", "Home");
        write_credentials(&work, "token-work");
        write_credentials(&home, "token-revoked");
        let fake = Fake { usage: HashMap::from([("token-work".to_string(), 40.0)]), ..Fake::default() };
        let store = UsageStore::default();
        let listed = vec![local("claude"), work.clone(), home.clone()];
        refresh(&store, "claude", &listed, &[], false, &fake, NOW);

        let snapshot = store.snapshot_at(&HashSet::new(), NOW);
        let shown = usage_of(&snapshot, &work.id);
        assert_eq!((percents(shown), shown.error.as_deref(), shown.unavailable), (vec![40.0], None, false));
        let failed = usage_of(&snapshot, &home.id);
        assert!(failed.unavailable && failed.windows.is_empty());
        assert!(failed.error.as_deref().unwrap().contains("HTTP 401"), "{:?}", failed.error);
        assert!(!usage_of(&snapshot, LOCAL).unavailable);

        // The failed account backs off on its own; the other polls on.
        let fake = Fake { usage: HashMap::from([("token-work".to_string(), 55.0), ("token-revoked".to_string(), 1.0)]), ..fake };
        fake.asked_tokens.lock().unwrap().clear();
        // Even the button: the provider refused that account, so it waits.
        refresh(&store, "claude", &listed, &[&work.id], true, &fake, NOW + 30_000);
        assert_eq!(*fake.asked_tokens.lock().unwrap(), ["token-work"]);
        let snapshot = store.snapshot_at(&HashSet::new(), NOW + 30_000);
        assert_eq!(percents(usage_of(&snapshot, &work.id)), [55.0]);
        assert!(usage_of(&snapshot, &home.id).unavailable);
    }

    #[test]
    fn a_missing_login_marks_only_that_account() {
        let root = tempfile::tempdir().unwrap();
        let work = account("claude", root.path(), "aaaa1111bbbb2222", "Work");
        let empty = account("claude", root.path(), "cccc3333dddd4444", "Signed out");
        write_credentials(&work, "token-work");
        let fake = Fake { usage: HashMap::from([("token-work".to_string(), 3.0)]), ..Fake::default() };
        let store = UsageStore::default();
        refresh(&store, "claude", &[local("claude"), work.clone(), empty.clone()], &[], false, &fake, NOW);
        let snapshot = store.snapshot_at(&HashSet::new(), NOW);
        assert_eq!(percents(usage_of(&snapshot, &work.id)), [3.0]);
        let missing = usage_of(&snapshot, &empty.id);
        assert!(missing.unavailable);
        assert_eq!(missing.error.as_deref(), Some("Claude Code OAuth credentials were not found"));
        // The endpoint was never asked without a token.
        assert_eq!(*fake.asked_tokens.lock().unwrap(), ["token-work"]);
    }

    /// Each Codex account is read from its own home.
    #[test]
    fn two_codex_accounts_are_each_read_from_their_own_home() {
        let root = tempfile::tempdir().unwrap();
        let work = account("codex", root.path(), "aaaa1111bbbb2222", "Work");
        let home = account("codex", root.path(), "cccc3333dddd4444", "Home");
        let fake = Fake { codex: HashMap::from([(work.dir.clone().unwrap(), 20.0), (home.dir.clone().unwrap(), 90.0)]), ..Fake::default() };
        let store = UsageStore::default();
        refresh(&store, "codex", &[local("codex"), work.clone(), home.clone()], &[], false, &fake, NOW);
        let snapshot = store.snapshot_at(&HashSet::new(), NOW);
        assert_eq!(percents(usage_of(&snapshot, &work.id)), [20.0]);
        assert_eq!(percents(usage_of(&snapshot, &home.id)), [90.0]);
        assert!(usage_of(&snapshot, &work.id).windows.iter().all(|window| window.agent == "codex" && window.key == "weekly"));
    }

    /// An API key has no subscription windows; This Mac's login shows the
    /// top-level windows; with one account nothing is listed at all.
    #[test]
    fn api_keys_show_no_windows_and_one_account_lists_nothing() {
        let store = UsageStore::default();
        store.ingest_claude_at(&json!({"rate_limits": {"five_hour": {"used_percentage": 33, "resets_at": (NOW + MINUTE) / 1000}}}), NOW);
        refresh(&store, "claude", &[local("claude")], &[], false, &Fake::default(), NOW);
        refresh(&store, "codex", &[local("codex")], &[], false, &Fake::default(), NOW);
        let alone = store.snapshot_at(&HashSet::new(), NOW);
        assert!(alone.accounts.is_empty());
        assert!(serde_json::to_value(&alone).unwrap().get("accounts").is_none(), "with one account the snapshot is as before");

        refresh(&store, "claude", &[local("claude"), key("claude")], &[], false, &Fake::default(), NOW);
        let snapshot = store.snapshot_at(&HashSet::new(), NOW);
        let saved = usage_of(&snapshot, crate::agent_accounts::SAVED_KEY);
        assert_eq!((saved.windows.len(), saved.error.as_deref(), saved.unavailable), (0, None, true));
        assert_eq!(percents(usage_of(&snapshot, LOCAL)), [33.0]);
        assert_eq!(usage_of(&snapshot, LOCAL).windows, snapshot.windows);
        // Sent flat, as the core's contract plus the agent, and read back
        // from a runtime the same way.
        let sent = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(sent["accounts"][1], json!({"agent": "claude", "accountId": "api-key", "label": "API key", "windows": [], "error": null, "unavailable": true}));
        assert_eq!(crate::status::usage::UsageSnapshot::from_runtime(sent).unwrap().accounts, snapshot.accounts);
    }

    /// An account with a running tab polls at the automatic interval; an
    /// idle one waits fifteen minutes; the button asks both.
    #[test]
    fn accounts_with_running_tabs_poll_more_often() {
        let root = tempfile::tempdir().unwrap();
        let busy = account("claude", root.path(), "aaaa1111bbbb2222", "Busy");
        let idle = account("claude", root.path(), "cccc3333dddd4444", "Idle");
        write_credentials(&busy, "token-busy");
        write_credentials(&idle, "token-idle");
        let fake = Fake { usage: HashMap::from([("token-busy".to_string(), 1.0), ("token-idle".to_string(), 2.0)]), ..Fake::default() };
        let store = UsageStore::default();
        let listed = [local("claude"), busy.clone(), idle.clone()];
        let asked = |at: i64, manual: bool| {
            fake.asked_tokens.lock().unwrap().clear();
            refresh(&store, "claude", &listed, &[&busy.id], manual, &fake, at);
            let mut tokens = fake.asked_tokens.lock().unwrap().clone();
            tokens.sort();
            tokens
        };
        assert_eq!(asked(NOW, false), ["token-busy", "token-idle"]);
        assert!(asked(NOW + 30_000, false).is_empty());
        assert_eq!(asked(NOW + MINUTE, false), ["token-busy"]);
        assert_eq!(asked(NOW + 15 * MINUTE, false), ["token-busy", "token-idle"]);
        assert_eq!(asked(NOW + 15 * MINUTE + 1_000, true), ["token-busy", "token-idle"]);
    }

    /// An account removed from the index loses its usage; a removed account
    /// whose request was out is not brought back by the answer.
    #[test]
    fn a_removed_account_is_dropped_with_its_usage() {
        let root = tempfile::tempdir().unwrap();
        let work = account("claude", root.path(), "aaaa1111bbbb2222", "Work");
        let mut accounts = Accounts::default();
        accounts.set_listed("claude", vec![local("claude"), work.clone()]);
        let jobs = accounts.begin("claude", &HashSet::new(), NOW, false, None);
        assert_eq!(jobs.len(), 1);
        accounts.set_listed("claude", vec![local("claude")]);
        accounts.finish(&jobs[0], Ok(Vec::new()), NOW);
        assert!(accounts.state.is_empty());
        assert!(accounts.usage(|_| (Vec::new(), None), NOW).is_empty());
    }
}
