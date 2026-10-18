//! What a work claim says, worked out from the session index alone (#441).
//!
//! A claim names an issue, the session working on it, the session's title,
//! branch and a coarse state, and how long ago it was last active. That is
//! all that leaves the machine: [`Claim`] has exactly the fields of the
//! contract (terminalx-saas `apps/api/docs/work-claims.md`), and the server
//! refuses any other. No prompt, transcript, path, diff or code is in it.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::store::index::{IssueRef, SessionEntry, TabStatus};

/// The most claims one device sends.
pub const MAX_CLAIMS: usize = 100;
const MAX_TITLE_CHARS: usize = 200;
const MAX_BRANCH_CHARS: usize = 255;
const MAX_SESSION_ID_CHARS: usize = 160;
const MAX_IDLE_SECONDS: u64 = 30 * 24 * 60 * 60;
/// A session idle this long is not working on anything as far as anyone
/// else can tell: the server would not show it, so it is not sent.
pub const FORGET_AFTER_SECONDS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimState {
    /// An agent turn is running.
    Working,
    /// An agent is waiting on the person (a permission or a question).
    Waiting,
    Idle,
    /// Idle, with an open pull request.
    PullRequest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimIssue {
    pub provider: String,
    pub id: String,
    pub identifier: String,
}

/// One claim as it is sent: every field the contract lists, and no other.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    pub session_id: String,
    pub scope: String,
    pub repository: Option<String>,
    pub issue: ClaimIssue,
    pub title: String,
    pub branch: Option<String>,
    pub state: ClaimState,
    pub cloud: bool,
    pub share_with_team: bool,
    pub idle_seconds: u64,
}

impl Claim {
    /// The claim with its idle time as a moment, so two reads a second apart
    /// of a session that did nothing in between compare equal.
    pub fn shape(&self, now: DateTime<Utc>) -> (Claim, i64) {
        let idle = i64::try_from(self.idle_seconds).unwrap_or(i64::MAX);
        let since = now.timestamp().saturating_sub(idle) / 60;
        (Claim { idle_seconds: 0, ..self.clone() }, if self.idle_seconds == 0 { 0 } else { since })
    }
}

/// The state of the pull request a session's branch is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PullRequestState {
    Open,
    Merged,
    Closed,
}

impl PullRequestState {
    pub fn parse(state: &str) -> Option<Self> {
        match state {
            "OPEN" => Some(Self::Open),
            "MERGED" => Some(Self::Merged),
            "CLOSED" => Some(Self::Closed),
            _ => None,
        }
    }
}

/// What a claim needs besides the session.
pub struct Inputs<'a> {
    pub now: DateTime<Utc>,
    /// Settings → Account: teammates may see it.
    pub share_with_team: bool,
    /// The normalised remote of a project, by its path.
    pub remote: &'a dyn Fn(&str) -> Option<String>,
    /// The pull request of a session's branch, by the session's id.
    pub pull_request: &'a dyn Fn(&str) -> Option<PullRequestState>,
}

/// A cloud session the window knows about, as it hands it over. Its issue is
/// found from its branch, since a cloud session carries no issue reference.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudSession {
    pub org_id: String,
    pub workspace_id: String,
    pub session_id: String,
    /// The user who created the workspace. Only one's own are published.
    #[serde(default)]
    pub created_by: Option<String>,
    /// The workspace's primary repository, `owner/name`.
    #[serde(default)]
    pub repository: Option<String>,
    pub title: String,
    #[serde(default)]
    pub branch: Option<String>,
    #[serde(default)]
    pub worktree_name: Option<String>,
    pub status: TabStatus,
    #[serde(default)]
    pub archived: bool,
    /// RFC 3339.
    pub modified: String,
}

impl CloudSession {
    /// The id its claim is sent under: unique across workspaces.
    pub fn claim_id(&self) -> String {
        format!("cloud:{}:{}", self.workspace_id, self.session_id)
    }
}

/// The repository a remote URL names, as every machine spells it:
/// `github.com/acme/widgets` for `git@github.com:Acme/Widgets.git` and
/// `https://user@github.com/acme/widgets` alike. `None` for a local path or
/// anything that is not a hosted repository.
pub fn normalize_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let (host, path) = if let Some((scheme, rest)) = url.split_once("://") {
        if !matches!(scheme.to_ascii_lowercase().as_str(), "https" | "http" | "ssh" | "git" | "git+ssh" | "ssh+git") {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        (authority.rsplit('@').next()?.split(':').next()?, path)
    } else {
        // `[user@]host:path`, as scp writes it. A local path has no colon
        // before its first slash.
        let (left, path) = url.split_once(':')?;
        if left.contains('/') || left.contains('\\') {
            return None;
        }
        (left.rsplit('@').next()?, path)
    };
    let host = host.to_ascii_lowercase();
    if host.is_empty() || host.len() > 253 || !host.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-') || !host.contains('.') {
        return None;
    }
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let segments: Vec<String> = path.split('/').filter(|part| !part.is_empty()).map(str::to_ascii_lowercase).collect();
    let valid = |part: &String| part.len() <= 100 && part != "." && part != ".." && part.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '~' | '-'));
    if segments.is_empty() || segments.len() > 8 || !segments.iter().all(valid) {
        return None;
    }
    let normalized = format!("{host}/{}", segments.join("/"));
    (normalized.len() <= 300).then_some(normalized)
}

fn name_part(part: &str, max: usize, extra: &[char]) -> bool {
    !part.is_empty() && part.len() <= max && part.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || extra.contains(&ch))
}

/// Where an issue lives, from its URL: `github.com/<owner>/<repo>` or
/// `linear.app/<workspace>`, lower case. Readers ask for claims by it.
pub fn issue_scope(provider: &str, url: &str) -> Option<String> {
    let (_, rest) = url.trim().split_once("://")?;
    let mut parts = rest.split(['/', '?', '#']);
    let host = parts.next()?.to_ascii_lowercase();
    match provider {
        "github" => {
            let (owner, repo, kind) = (parts.next()?.to_ascii_lowercase(), parts.next()?.to_ascii_lowercase(), parts.next()?);
            (host == "github.com" && kind == "issues" && name_part(&owner, 39, &[]) && name_part(&repo, 100, &['.', '_'])).then(|| format!("github.com/{owner}/{repo}"))
        }
        "linear" => {
            let workspace = parts.next()?.to_ascii_lowercase();
            (host == "linear.app" && parts.next()? == "issue" && name_part(&workspace, 64, &[])).then(|| format!("linear.app/{workspace}"))
        }
        _ => None,
    }
}

/// An issue's identifier as claims spell it: `#441`, `ENG-42`.
pub fn claim_identifier(provider: &str, identifier: &str) -> Option<String> {
    let identifier = identifier.trim();
    match provider {
        "github" => {
            let number = identifier.strip_prefix('#').unwrap_or(identifier);
            (!number.is_empty() && number.len() <= 10 && number.chars().all(|ch| ch.is_ascii_digit())).then(|| format!("#{number}"))
        }
        "linear" => {
            let upper = identifier.to_ascii_uppercase();
            let (team, number) = upper.split_once('-')?;
            let team_ok = team.len() <= 10 && team.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic()) && team.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_');
            let number_ok = !number.is_empty() && number.len() <= 10 && number.chars().all(|ch| ch.is_ascii_digit());
            (team_ok && number_ok).then_some(upper)
        }
        _ => None,
    }
}

fn claim_issue(issue: &IssueRef) -> Option<(String, ClaimIssue)> {
    let scope = issue_scope(&issue.provider, &issue.url)?;
    let identifier = claim_identifier(&issue.provider, &issue.identifier)?;
    let id = issue.id.trim();
    if id.is_empty() || id.len() > 128 || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
        return None;
    }
    Some((scope, ClaimIssue { provider: issue.provider.clone(), id: id.into(), identifier }))
}

fn clean_title(title: &str, fallback: &str) -> String {
    let title: String = title.chars().map(|ch| if ch.is_control() { ' ' } else { ch }).collect();
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let title = if title.is_empty() { fallback.to_string() } else { title };
    title.chars().take(MAX_TITLE_CHARS).collect()
}

fn clean_branch(branch: Option<&str>) -> Option<String> {
    let branch = branch?.trim();
    (!branch.is_empty() && branch.chars().count() <= MAX_BRANCH_CHARS && !branch.chars().any(|ch| ch.is_whitespace() || ch.is_control())).then(|| branch.to_string())
}

fn session_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_SESSION_ID_CHARS && id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | ':' | '/' | '-'))
}

fn parse_time(text: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(text).ok().map(|time| time.with_timezone(&Utc))
}

fn idle_seconds(now: DateTime<Utc>, last: Option<DateTime<Utc>>) -> u64 {
    last.map(|last| u64::try_from((now - last).num_seconds()).unwrap_or(0)).unwrap_or(MAX_IDLE_SECONDS).min(MAX_IDLE_SECONDS)
}

fn state_of(statuses: impl Iterator<Item = TabStatus>, pull_request: Option<PullRequestState>) -> ClaimState {
    let statuses: Vec<_> = statuses.collect();
    if statuses.contains(&TabStatus::Waiting) {
        ClaimState::Waiting
    } else if statuses.contains(&TabStatus::InProgress) {
        ClaimState::Working
    } else if pull_request == Some(PullRequestState::Open) {
        ClaimState::PullRequest
    } else {
        ClaimState::Idle
    }
}

/// The claim a session makes, if it makes one: linked to an issue, not
/// archived, not private, its pull request not merged, and active in the
/// last day (or working now).
pub fn session_claim(session: &SessionEntry, inputs: &Inputs<'_>) -> Option<Claim> {
    if session.archived || session.is_quick() || session.issue_work.private || !session_id_ok(&session.id) {
        return None;
    }
    let (scope, issue) = claim_issue(session.issue.as_ref()?)?;
    let pull_request = (inputs.pull_request)(&session.id);
    if pull_request == Some(PullRequestState::Merged) {
        return None;
    }
    let state = state_of(session.tabs.iter().map(|tab| tab.status), pull_request);
    let last = std::iter::once(&session.modified).chain(session.tabs.iter().map(|tab| &tab.modified)).filter_map(|time| parse_time(time)).max();
    let idle = if matches!(state, ClaimState::Working | ClaimState::Waiting) { 0 } else { idle_seconds(inputs.now, last) };
    if idle >= FORGET_AFTER_SECONDS {
        return None;
    }
    Some(Claim {
        session_id: session.id.clone(),
        scope,
        repository: (inputs.remote)(&session.project_path),
        title: clean_title(&session.title, &issue.identifier),
        issue,
        branch: clean_branch(session.branch.as_deref()),
        state,
        cloud: false,
        share_with_team: inputs.share_with_team,
        idle_seconds: idle,
    })
}

/// The claim a cloud session makes, once its branch was found to name `issue`.
pub fn cloud_claim(session: &CloudSession, issue: &IssueRef, inputs: &Inputs<'_>) -> Option<Claim> {
    let id = session.claim_id();
    if session.archived || !session_id_ok(&id) {
        return None;
    }
    let (scope, claimed) = claim_issue(issue)?;
    let state = state_of(std::iter::once(session.status), None);
    let idle = if matches!(state, ClaimState::Working | ClaimState::Waiting) { 0 } else { idle_seconds(inputs.now, parse_time(&session.modified)) };
    if idle >= FORGET_AFTER_SECONDS {
        return None;
    }
    let repository = session.repository.as_deref().and_then(|full| normalize_remote(&format!("https://github.com/{full}")));
    Some(Claim {
        session_id: id,
        scope,
        repository,
        title: clean_title(&session.title, &claimed.identifier),
        issue: claimed,
        branch: clean_branch(session.branch.as_deref()),
        state,
        cloud: true,
        share_with_team: inputs.share_with_team,
        idle_seconds: idle,
    })
}

/// Every claim this device makes, the most recently active first.
pub fn claims(sessions: &[SessionEntry], cloud: &[(CloudSession, IssueRef)], inputs: &Inputs<'_>) -> Vec<Claim> {
    let mut claims: Vec<Claim> = sessions
        .iter()
        .filter_map(|session| session_claim(session, inputs))
        .chain(cloud.iter().filter_map(|(session, issue)| cloud_claim(session, issue, inputs)))
        .collect();
    claims.sort_by(|a, b| a.idle_seconds.cmp(&b.idle_seconds).then_with(|| a.session_id.cmp(&b.session_id)));
    claims.dedup_by(|a, b| a.session_id == b.session_id);
    claims.truncate(MAX_CLAIMS);
    claims
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn now() -> DateTime<Utc> {
        parse_time("2026-10-18T12:00:00Z").unwrap()
    }

    fn session(value: serde_json::Value) -> SessionEntry {
        let mut base = json!({
            "id": "s1", "projectPath": "/work/widgets", "cwd": "/work/widgets/.raccoon/worktrees/441-show",
            "branch": "raccoon/441-show", "title": "#441 Show who is working",
            "created": "2026-10-18T11:00:00Z", "modified": "2026-10-18T11:55:00Z",
            "issue": {"provider": "github", "id": "441", "identifier": "#441", "title": "Show who is working", "url": "https://github.com/Acme/Widgets/issues/441"},
            "tabs": [{"id": "t1", "harness": "claude", "created": "2026-10-18T11:00:00Z", "modified": "2026-10-18T11:50:00Z", "status": "idle"}]
        });
        for (key, value) in value.as_object().unwrap() {
            base[key] = value.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    fn inputs<'a>(remote: &'a dyn Fn(&str) -> Option<String>, pr: &'a dyn Fn(&str) -> Option<PullRequestState>) -> Inputs<'a> {
        Inputs { now: now(), share_with_team: true, remote, pull_request: pr }
    }

    fn widgets(_: &str) -> Option<String> {
        Some("github.com/acme/widgets".into())
    }

    fn no_pr(_: &str) -> Option<PullRequestState> {
        None
    }

    #[test]
    fn remotes_are_spelled_the_same_on_every_machine() {
        for url in [
            "git@github.com:Acme/Widgets.git",
            "https://github.com/acme/widgets",
            "https://user:token@github.com/acme/widgets.git/",
            "ssh://git@github.com:22/acme/widgets.git",
            "git+ssh://git@GitHub.com/Acme/Widgets",
        ] {
            assert_eq!(normalize_remote(url).as_deref(), Some("github.com/acme/widgets"), "{url}");
        }
        assert_eq!(normalize_remote("https://gitlab.example.com/group/sub/repo.git").as_deref(), Some("gitlab.example.com/group/sub/repo"));
        for url in ["/Users/me/repo.git", "file:///Users/me/repo", "C:\\repo", "", "https://github.com/", "https://github.com/a/../b", "localhost:repo"] {
            assert_eq!(normalize_remote(url), None, "{url}");
        }
    }

    #[test]
    fn an_issue_is_scoped_by_where_it_lives() {
        assert_eq!(issue_scope("github", "https://github.com/Acme/Widgets/issues/441").as_deref(), Some("github.com/acme/widgets"));
        assert_eq!(issue_scope("linear", "https://linear.app/Acme/issue/ENG-42/fix-login").as_deref(), Some("linear.app/acme"));
        assert_eq!(issue_scope("github", "https://github.com/acme/widgets/pull/12"), None);
        assert_eq!(issue_scope("github", "https://ghe.example.com/acme/widgets/issues/1"), None);
        assert_eq!(issue_scope("linear", "https://github.com/acme/widgets/issues/1"), None);
        assert_eq!(claim_identifier("github", "441").as_deref(), Some("#441"));
        assert_eq!(claim_identifier("linear", "eng-42").as_deref(), Some("ENG-42"));
        assert_eq!(claim_identifier("linear", "42"), None);
        assert_eq!(claim_identifier("github", "#4x"), None);
    }

    #[test]
    fn a_linked_session_claims_its_issue_with_only_the_shared_fields() {
        let claim = session_claim(&session(json!({})), &inputs(&widgets, &no_pr)).unwrap();
        assert_eq!(claim.scope, "github.com/acme/widgets");
        assert_eq!(claim.issue, ClaimIssue { provider: "github".into(), id: "441".into(), identifier: "#441".into() });
        assert_eq!(claim.state, ClaimState::Idle);
        assert_eq!(claim.idle_seconds, 5 * 60);
        assert_eq!(claim.branch.as_deref(), Some("raccoon/441-show"));
        let sent = serde_json::to_value(&claim).unwrap();
        let keys: Vec<_> = sent.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["branch", "cloud", "idleSeconds", "issue", "repository", "scope", "sessionId", "shareWithTeam", "state", "title"]);
        let issue_keys: Vec<_> = sent["issue"].as_object().unwrap().keys().cloned().collect();
        assert_eq!(issue_keys, ["id", "identifier", "provider"]);
    }

    #[test]
    fn no_prompt_transcript_or_path_is_ever_sent() {
        let secret = "SECRET-PROMPT-TEXT";
        let mut entry = session(json!({
            "title": "#441 Show who is working",
            "tabs": [{"id": "t1", "harness": "claude", "created": "2026-10-18T11:00:00Z", "modified": "2026-10-18T11:50:00Z", "status": "in_progress", "title": secret, "providerSessionId": secret}],
            "link": {"path": "/Users/me/secret-path", "branch": "main"}
        }));
        entry.unknown.insert("firstPrompt".into(), json!(secret));
        let claims = claims(&[entry], &[], &inputs(&widgets, &no_pr));
        let sent = serde_json::to_string(&claims).unwrap();
        assert!(!sent.contains(secret), "{sent}");
        assert!(!sent.contains("/Users/me"), "{sent}");
        assert!(!sent.contains("/work/widgets"), "{sent}");
        assert_eq!(claims[0].state, ClaimState::Working);
        assert_eq!(claims[0].idle_seconds, 0);
    }

    #[test]
    fn archived_private_quick_merged_and_stale_sessions_claim_nothing() {
        let merged = |_: &str| Some(PullRequestState::Merged);
        assert!(session_claim(&session(json!({"archived": true})), &inputs(&widgets, &no_pr)).is_none());
        assert!(session_claim(&session(json!({"issueWork": {"private": true}})), &inputs(&widgets, &no_pr)).is_none());
        assert!(session_claim(&session(json!({"kind": "quick"})), &inputs(&widgets, &no_pr)).is_none());
        assert!(session_claim(&session(json!({"issue": null})), &inputs(&widgets, &no_pr)).is_none());
        assert!(session_claim(&session(json!({})), &inputs(&widgets, &merged)).is_none());
        let stale = session(json!({"modified": "2026-10-17T11:00:00Z", "tabs": []}));
        assert!(session_claim(&stale, &inputs(&widgets, &no_pr)).is_none());
    }

    #[test]
    fn the_state_follows_the_tabs_and_the_pull_request() {
        let open = |_: &str| Some(PullRequestState::Open);
        assert_eq!(session_claim(&session(json!({})), &inputs(&widgets, &open)).unwrap().state, ClaimState::PullRequest);
        let waiting = session(json!({"tabs": [
            {"id": "a", "harness": "claude", "created": "x", "modified": "x", "status": "in_progress"},
            {"id": "b", "harness": "codex", "created": "x", "modified": "x", "status": "waiting"}
        ]}));
        assert_eq!(session_claim(&waiting, &inputs(&widgets, &open)).unwrap().state, ClaimState::Waiting);
    }

    #[test]
    fn the_person_setting_and_the_project_remote_go_with_each_claim() {
        let none = |_: &str| None;
        let mut private = inputs(&none, &no_pr);
        private.share_with_team = false;
        let claim = session_claim(&session(json!({})), &private).unwrap();
        assert!(!claim.share_with_team);
        assert_eq!(claim.repository, None);
    }

    #[test]
    fn titles_and_branches_are_bounded() {
        let long = "x".repeat(500);
        let claim = session_claim(&session(json!({"title": format!("a\u{0007}b\n{long}"), "branch": "has space"})), &inputs(&widgets, &no_pr)).unwrap();
        assert!(claim.title.starts_with("a b "));
        assert_eq!(claim.title.chars().count(), 200);
        assert_eq!(claim.branch, None);
        let blank = session_claim(&session(json!({"title": "  "})), &inputs(&widgets, &no_pr)).unwrap();
        assert_eq!(blank.title, "#441");
    }

    #[test]
    fn a_cloud_session_claims_under_its_workspace() {
        let cloud = CloudSession {
            org_id: "org".into(),
            workspace_id: "ws1".into(),
            session_id: "c1".into(),
            created_by: Some("user".into()),
            repository: Some("Acme/Widgets".into()),
            title: "Fix it".into(),
            branch: Some("441-fix".into()),
            worktree_name: None,
            status: TabStatus::InProgress,
            archived: false,
            modified: "2026-10-18T11:00:00Z".into(),
        };
        let issue = IssueRef { provider: "github".into(), id: "441".into(), identifier: "#441".into(), title: "t".into(), url: "https://github.com/acme/widgets/issues/441".into() };
        let all = claims(&[session(json!({}))], &[(cloud, issue)], &inputs(&widgets, &no_pr));
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].session_id, "cloud:ws1:c1");
        assert!(all[0].cloud);
        assert_eq!(all[0].repository.as_deref(), Some("github.com/acme/widgets"));
        assert!(!all[1].cloud);
    }

    #[test]
    fn the_shape_ignores_the_passing_of_time() {
        let claim = session_claim(&session(json!({})), &inputs(&widgets, &no_pr)).unwrap();
        let later = Claim { idle_seconds: claim.idle_seconds + 30, ..claim.clone() };
        assert_eq!(claim.shape(now()).0, later.shape(now() + chrono::Duration::seconds(30)).0);
        assert_eq!(claim.shape(now()).1, later.shape(now() + chrono::Duration::seconds(30)).1);
    }
}
