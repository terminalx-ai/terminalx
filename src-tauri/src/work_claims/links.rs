//! Linking a session to the issue it works on when it was not started from
//! one (#441), so that its work status can say so:
//!
//! - its branch or worktree name carries the issue's number (`441-fix`,
//!   `fix/issue-441`) or a Linear identifier of a team the key can see
//!   (`me/eng-42-login`);
//! - a pull request its branch opened closes the issue (GitHub's own link,
//!   or a Linear identifier in its title, or after a closing word in its body);
//! - its first prompt names the issue: its URL, `fixes #441`, or `ENG-42`.
//!
//! A candidate becomes a link only once the tracker confirms the issue exists
//! (on GitHub, as an issue and not a pull request). An issue unlinked by hand
//! is never linked again. Everything here is read on this machine; nothing
//! of a branch, a prompt or a pull request is sent anywhere.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::hash::Hash;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;

use super::claims::PullRequestState;
use crate::store::index::{IssueLinkSource, IssueRef, SessionEntry};

/// How often a session's pull request is read again.
pub const PULL_REQUEST_EVERY: Duration = Duration::from_secs(5 * 60);
/// How long a tracker that could not answer (offline, `gh` not ready, Linear
/// down) is left before it is asked again.
const RETRY_FAILED: Duration = Duration::from_secs(2 * 60);
/// How long the Linear team keys, or that Linear could not say them, and a
/// project's repository, are kept.
const TEAMS_FOR: Duration = Duration::from_secs(60 * 60);
const REPO_FOR: Duration = Duration::from_secs(10 * 60);
/// The most candidates tried for one session in one pass.
const MAX_TRIES: usize = 3;
/// Older sessions are not linked: nobody would be told they work on it.
const RECENT_DAYS: i64 = 7;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Candidate {
    /// An issue number in the project's GitHub repository.
    GitHub(String),
    /// A Linear identifier, upper case.
    Linear(String),
}

static LEADING_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{1,7})(?:[-_.]|$)").unwrap());
static KEYWORD_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[-_./])(?:issues?|gh|fix(?:es)?|bug|feat(?:ure)?|closes?)[-_]?(\d{1,7})(?:[-_./]|$)").unwrap());
static HASH_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#(\d{1,7})(?:\D|$)").unwrap());
static LINEAR_IN_NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|[-_./])([a-z][a-z0-9_]{0,9}-\d{1,7})(?:[-_./]|$)").unwrap());
static GITHUB_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://github\.com/([A-Za-z0-9-]+)/([A-Za-z0-9._-]+)/issues/(\d{1,7})").unwrap());
static LINEAR_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://linear\.app/[A-Za-z0-9-]+/issue/([A-Za-z][A-Za-z0-9_]{0,9}-\d{1,7})").unwrap());
static NAMED_NUMBER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:^|[^\w#])(?:issues?|fix(?:es|ed)?|close[sd]?|resolve[sd]?|implement|address|work(?:ing)? on)\s+#(\d{1,7})\b").unwrap()
});
static LEADING_HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*#(\d{1,7})\b").unwrap());
static LINEAR_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b([A-Z][A-Z0-9_]{0,9}-\d{1,7})\b").unwrap());
static CLOSING_LINEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+([A-Za-z][A-Za-z0-9_]{0,9}-\d{1,7})\b").unwrap());

fn push(found: &mut Vec<Candidate>, candidate: Candidate) {
    if !found.contains(&candidate) {
        found.push(candidate);
    }
}

/// Each value once, in the order first seen; a long prompt can name thousands.
fn distinct<T: Eq + Hash + Clone>(values: impl Iterator<Item = T>) -> Vec<T> {
    let mut seen = HashSet::new();
    values.filter(|value| seen.insert(value.clone())).collect()
}

fn team_of(identifier: &str) -> &str {
    identifier.split_once('-').map(|(team, _)| team).unwrap_or("")
}

/// What a branch or worktree name says about its issue. `github` is whether
/// the project's issues are on GitHub; `teams` are the Linear team keys.
pub fn name_candidates(names: &[&str], github: bool, teams: &BTreeSet<String>) -> Vec<Candidate> {
    let mut found = Vec::new();
    for name in names {
        let name = name.trim().to_ascii_lowercase();
        if name.is_empty() {
            continue;
        }
        for capture in LINEAR_IN_NAME.captures_iter(&name) {
            let identifier = capture[1].to_ascii_uppercase();
            if teams.contains(team_of(&identifier)) {
                push(&mut found, Candidate::Linear(identifier));
            }
        }
        if !github {
            continue;
        }
        let last = name.rsplit('/').next().unwrap_or(&name);
        for capture in LEADING_NUMBER.captures_iter(last).chain(KEYWORD_NUMBER.captures_iter(&name)).chain(HASH_NUMBER.captures_iter(&name)) {
            push(&mut found, Candidate::GitHub(capture[1].trim_start_matches('0').to_string()));
        }
    }
    found.retain(|candidate| !matches!(candidate, Candidate::GitHub(number) if number.is_empty()));
    found
}

/// Everything a first prompt could name, read from it once: which of it is a
/// candidate depends on the project's repository and the Linear teams, which
/// are asked again later, and the transcript is not read again for them.
#[derive(Clone)]
struct PromptRefs {
    /// `(owner/name, number)` of each GitHub issue URL.
    github_urls: Vec<(String, String)>,
    /// The identifier of each Linear issue URL, upper case.
    linear_urls: Vec<String>,
    /// `#N` leading the prompt or after a word such as "fixes".
    numbers: Vec<String>,
    /// Every word shaped like a Linear identifier.
    identifiers: Vec<String>,
}

impl PromptRefs {
    fn read(text: &str) -> Self {
        Self {
            github_urls: distinct(GITHUB_URL.captures_iter(text).map(|capture| (format!("{}/{}", &capture[1], &capture[2]), capture[3].to_string()))),
            linear_urls: distinct(LINEAR_URL.captures_iter(text).map(|capture| capture[1].to_ascii_uppercase())),
            numbers: distinct(LEADING_HASH.captures_iter(text).chain(NAMED_NUMBER.captures_iter(text)).map(|capture| capture[1].to_string())),
            identifiers: distinct(LINEAR_ID.captures_iter(text).map(|capture| capture[1].to_string())),
        }
    }

    /// What the first prompt says about its issue. `repo` is the project's GitHub
    /// `owner/name`: a URL into another repository is not this project's issue.
    fn candidates(&self, repo: Option<&str>, teams: &BTreeSet<String>) -> Vec<Candidate> {
        let urls = self.github_urls.iter().filter(|(owner_name, _)| repo.is_some_and(|repo| repo.eq_ignore_ascii_case(owner_name))).map(|(_, number)| Candidate::GitHub(number.clone()));
        let linear_urls = self.linear_urls.iter().map(|identifier| Candidate::Linear(identifier.clone()));
        let numbers = self.numbers.iter().filter(|_| repo.is_some()).map(|number| Candidate::GitHub(number.clone()));
        let identifiers = self.identifiers.iter().filter(|identifier| teams.contains(team_of(identifier))).map(|identifier| Candidate::Linear(identifier.clone()));
        distinct(urls.chain(linear_urls).chain(numbers).chain(identifiers))
    }
}

/// What a branch's pull request says about the issue it closes.
pub fn pull_request_candidates(pr: &BranchPull, repo: Option<&str>, teams: &BTreeSet<String>) -> Vec<Candidate> {
    let mut found = Vec::new();
    for (owner_name, number) in &pr.closes {
        if repo.is_some_and(|repo| repo.eq_ignore_ascii_case(owner_name)) {
            push(&mut found, Candidate::GitHub(number.to_string()));
        }
    }
    let named = LINEAR_ID.captures_iter(&pr.title).map(|capture| capture[1].to_string());
    let closing = CLOSING_LINEAR.captures_iter(&pr.body).map(|capture| capture[1].to_ascii_uppercase());
    for identifier in named.chain(closing) {
        if teams.contains(team_of(&identifier)) {
            push(&mut found, Candidate::Linear(identifier));
        }
    }
    found
}

/// A branch's pull request, as the linker reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchPull {
    pub state: PullRequestState,
    pub title: String,
    pub body: String,
    /// `(owner/name, number)` of each issue GitHub says it closes.
    pub closes: Vec<(String, u64)>,
}

/// What the linker asks of the trackers and the checkouts.
pub trait Lookup {
    /// The project's GitHub repository, `owner/name`.
    fn github_repo(&self, project_path: &str) -> Option<String>;
    /// The issue of this number in the project's repository; `Ok(None)` when
    /// there is none (or it is a pull request), `Err` when it could not be read.
    fn github_issue(&self, project_path: &str, number: &str) -> Result<Option<IssueRef>, String>;
    /// The issue of this number in `owner/name`, for a cloud workspace's repository.
    fn github_issue_in(&self, repo: &str, number: &str) -> Result<Option<IssueRef>, String>;
    /// The Linear issue with this identifier; `Err` also when Linear is not connected.
    fn linear_issue(&self, identifier: &str) -> Result<Option<IssueRef>, String>;
    /// The keys of the Linear teams the key can see: empty when Linear is not
    /// connected, `None` when it could not be asked.
    fn linear_teams(&self) -> Option<BTreeSet<String>>;
    /// The pull request of each branch in the checkout at `cwd`.
    fn branch_pulls(&self, cwd: &str, branches: &[String]) -> Option<HashMap<String, BranchPull>>;
    /// The first request of the session, read on this machine.
    fn first_request(&self, session: &SessionEntry) -> Option<String>;
}

/// What was settled of a session: the names its branch candidates were
/// answered for, and whether its first prompt's were, each under the Linear
/// teams answer of the time ([`Linker::teams_answer`]). Only an answer the
/// trackers gave settles anything; a failed lookup is tried again, and both
/// are looked at again under a new teams answer.
#[derive(Default)]
struct Checked {
    names: Option<(Vec<String>, u64)>,
    /// What its first request names, once there is one.
    prompt: Option<PromptRefs>,
    /// The teams answer its first prompt's candidates were answered under.
    prompt_settled: Option<u64>,
}

/// What a tracker said of a candidate.
#[derive(Clone)]
enum Verified {
    Found(IssueRef),
    /// No such issue (or a pull request's number).
    Missing,
    /// The tracker could not say; asked again after [`RETRY_FAILED`].
    Failed(Instant),
}

/// What a pass found: the links to write.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Pass {
    pub links: Vec<(String, IssueRef, IssueLinkSource)>,
}

/// The linker's memory between passes. It lives as long as the app.
#[derive(Default)]
pub struct Linker {
    checked: HashMap<String, Checked>,
    verified: HashMap<(String, Candidate), Verified>,
    /// The Linear team keys, or `None` when Linear could not be asked.
    teams: Option<(Instant, Option<BTreeSet<String>>)>,
    /// Counts the different teams answers read: what was settled under one is
    /// looked at again under the next.
    teams_answer: u64,
    repos: HashMap<String, (Instant, Option<String>)>,
    pulls: HashMap<String, (Instant, Option<BranchPull>)>,
}

/// Branches that are a project's own line, never one piece of work.
fn shared_branch(branch: &str) -> bool {
    matches!(branch, "main" | "master" | "develop" | "development" | "trunk" | "staging" | "production")
}

fn recent(session: &SessionEntry) -> bool {
    chrono::DateTime::parse_from_rfc3339(&session.modified).is_ok_and(|modified| chrono::Utc::now().signed_duration_since(modified) < chrono::Duration::days(RECENT_DAYS))
}

impl Linker {
    /// The Linear team keys, read at most every [`TEAMS_FOR`]; `None` while
    /// Linear cannot be asked, which is not asked again any sooner: a key that
    /// keeps failing would otherwise be asked every pass.
    fn teams(&mut self, lookup: &dyn Lookup) -> Option<BTreeSet<String>> {
        if let Some((at, teams)) = &self.teams {
            if at.elapsed() < TEAMS_FOR {
                return teams.clone();
            }
        }
        let teams = lookup.linear_teams();
        if self.teams.as_ref().is_none_or(|(_, before)| *before != teams) {
            self.teams_answer += 1;
        }
        self.teams = Some((Instant::now(), teams.clone()));
        teams
    }

    /// Which teams answer is the latest, read again first when it is due: an
    /// answer settled under another one is to be looked for again. Asked
    /// before reusing a settled answer, so that one is never kept under a
    /// stale teams answer only because nothing else read the teams since.
    pub fn teams_answer(&mut self, lookup: &dyn Lookup) -> u64 {
        self.teams(lookup);
        self.teams_answer
    }

    /// Tests: let the teams answer run out, as if [`TEAMS_FOR`] had passed.
    #[cfg(test)]
    pub(super) fn age_teams(&mut self) {
        if let Some((at, _)) = &mut self.teams {
            *at = Instant::now().checked_sub(TEAMS_FOR + Duration::from_secs(1)).unwrap();
        }
    }

    /// A project's GitHub repository, asked of its checkout at most every [`REPO_FOR`].
    fn repo(&mut self, lookup: &dyn Lookup, project_path: &str) -> Option<String> {
        if let Some((at, repo)) = self.repos.get(project_path) {
            if at.elapsed() < REPO_FOR {
                return repo.clone();
            }
        }
        let repo = lookup.github_repo(project_path);
        self.repos.insert(project_path.to_string(), (Instant::now(), repo.clone()));
        repo
    }

    /// The issue a candidate names: `Some(Some(issue))` once confirmed,
    /// `Some(None)` when there is no such issue, `None` while the tracker
    /// cannot say. `place` is the project path, or `repo:owner/name` for a
    /// cloud workspace's repository.
    fn verify(&mut self, lookup: &dyn Lookup, place: &str, candidate: &Candidate) -> Option<Option<IssueRef>> {
        let key = (place.to_string(), candidate.clone());
        match self.verified.get(&key) {
            Some(Verified::Found(issue)) => return Some(Some(issue.clone())),
            Some(Verified::Missing) => return Some(None),
            Some(Verified::Failed(at)) if at.elapsed() < RETRY_FAILED => return None,
            _ => {}
        }
        let found = match (candidate, place.strip_prefix("repo:")) {
            (Candidate::GitHub(number), Some(repo)) => lookup.github_issue_in(repo, number),
            (Candidate::GitHub(number), None) => lookup.github_issue(place, number),
            (Candidate::Linear(identifier), _) => lookup.linear_issue(identifier),
        };
        let (verified, answer) = match found {
            Ok(Some(issue)) => (Verified::Found(issue.clone()), Some(Some(issue))),
            Ok(None) => (Verified::Missing, Some(None)),
            Err(error) => {
                log::debug!("issue link candidate could not be read: {error}");
                (Verified::Failed(Instant::now()), None)
            }
        };
        self.verified.insert(key, verified);
        answer
    }

    /// The first candidate the tracker confirms that was not unlinked by
    /// hand, and whether that is final: not while a tracker could not say
    /// and nothing was found.
    fn first_issue(&mut self, lookup: &dyn Lookup, place: &str, candidates: &[Candidate], unlinked: &[String]) -> (Option<IssueRef>, bool) {
        let mut settled = true;
        for candidate in candidates.iter().take(MAX_TRIES) {
            match self.verify(lookup, place, candidate) {
                Some(Some(issue)) if !unlinked.contains(&issue.url) => return (Some(issue), true),
                Some(_) => {}
                None => settled = false,
            }
        }
        (None, settled)
    }

    /// The pull request of every recent session with a branch of its own,
    /// read at most every [`PULL_REQUEST_EVERY`], one request per checkout.
    fn pull_requests(&mut self, lookup: &dyn Lookup, sessions: &[SessionEntry]) {
        let mut due: HashMap<&str, Vec<String>> = HashMap::new();
        for session in sessions {
            let Some(branch) = session.branch.as_deref().filter(|branch| !shared_branch(branch)) else { continue };
            if session.archived || session.is_quick() || !recent(session) {
                continue;
            }
            if self.pulls.get(&session.id).is_some_and(|(at, _)| at.elapsed() < PULL_REQUEST_EVERY) {
                continue;
            }
            due.entry(session.project_path.as_str()).or_default().push(branch.to_string());
        }
        for (project, branches) in due {
            let Some(found) = lookup.branch_pulls(project, &branches) else { continue };
            for session in sessions.iter().filter(|session| session.project_path == project) {
                if let Some(branch) = session.branch.as_ref().filter(|branch| branches.contains(branch)) {
                    self.pulls.insert(session.id.clone(), (Instant::now(), found.get(branch).cloned()));
                }
            }
        }
    }

    /// The state of a session's pull request as last read.
    pub fn pull_request(&self, session_id: &str) -> Option<PullRequestState> {
        self.pulls.get(session_id).and_then(|(_, pull)| pull.as_ref()).map(|pull| pull.state)
    }

    /// One pass over the index: the pull requests that are due, and a link
    /// for each recent unlinked session whose branch, pull request or first
    /// prompt names an issue.
    pub fn pass(&mut self, lookup: &dyn Lookup, sessions: &[SessionEntry]) -> Pass {
        self.checked.retain(|id, _| sessions.iter().any(|session| &session.id == id));
        self.pulls.retain(|id, _| sessions.iter().any(|session| &session.id == id));
        self.pull_requests(lookup, sessions);
        let mut pass = Pass::default();
        let mut asked: Option<Option<BTreeSet<String>>> = None;
        for session in sessions {
            if session.issue.is_some() || session.archived || session.is_quick() || !recent(session) {
                continue;
            }
            let repo = self.repo(lookup, &session.project_path);
            // Without the team keys no Linear candidate is told apart: what is settled
            // meanwhile is looked at again once they are known.
            let teams = asked.get_or_insert_with(|| self.teams(lookup)).clone().unwrap_or_default();
            let answer = self.teams_answer;
            let unlinked = &session.issue_work.unlinked;
            let names: Vec<String> = [session.branch.as_deref(), session.worktree_name.as_deref()].into_iter().flatten().filter(|name| !shared_branch(name)).map(String::from).collect();
            let (names_new, prompt_new) = {
                let checked = self.checked.entry(session.id.clone()).or_default();
                (!checked.names.as_ref().is_some_and(|(seen, under)| *seen == names && *under == answer), checked.prompt_settled != Some(answer))
            };
            let mut found = None;
            if names_new {
                let refs: Vec<&str> = names.iter().map(String::as_str).collect();
                let candidates = name_candidates(&refs, repo.is_some(), &teams);
                let (issue, settled) = self.first_issue(lookup, &session.project_path, &candidates, unlinked);
                if settled {
                    self.checked.get_mut(&session.id).expect("checked above").names = Some((names.clone(), answer));
                }
                found = issue.map(|issue| (issue, IssueLinkSource::Branch));
            }
            if found.is_none() {
                if let Some(pull) = self.pulls.get(&session.id).and_then(|(_, pull)| pull.clone()) {
                    let candidates = pull_request_candidates(&pull, repo.as_deref(), &teams);
                    found = self.first_issue(lookup, &session.project_path, &candidates, unlinked).0.map(|issue| (issue, IssueLinkSource::PullRequest));
                }
            }
            if found.is_none() && prompt_new {
                // Read once there is a first request; a session not yet
                // prompted is looked at again in the next pass.
                let checked = self.checked.get_mut(&session.id).expect("checked above");
                if checked.prompt.is_none() {
                    checked.prompt = lookup.first_request(session).map(|text| PromptRefs::read(&text));
                }
                if let Some(prompt) = checked.prompt.clone() {
                    let candidates = prompt.candidates(repo.as_deref(), &teams);
                    let (issue, settled) = self.first_issue(lookup, &session.project_path, &candidates, unlinked);
                    if settled {
                        self.checked.get_mut(&session.id).expect("checked above").prompt_settled = Some(answer);
                    }
                    found = issue.map(|issue| (issue, IssueLinkSource::Prompt));
                }
            }
            if let Some((issue, source)) = found {
                pass.links.push((session.id.clone(), issue, source));
            }
        }
        pass
    }

    /// The issue a cloud session's branch names, in its workspace's
    /// repository, and whether that answer is final (as [`Self::first_issue`])
    /// under the teams answer it was looked for under ([`Self::teams_answer`]).
    pub fn cloud_issue(&mut self, lookup: &dyn Lookup, repo: Option<&str>, names: &[&str]) -> (Option<IssueRef>, bool) {
        let teams = self.teams(lookup).unwrap_or_default();
        let names: Vec<&str> = names.iter().copied().filter(|name| !shared_branch(name)).collect();
        let candidates = name_candidates(&names, repo.is_some(), &teams);
        let place = repo.map(|repo| format!("repo:{repo}")).unwrap_or_default();
        self.first_issue(lookup, &place, &candidates, &[])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn teams(keys: &[&str]) -> BTreeSet<String> {
        keys.iter().map(|key| key.to_string()).collect()
    }

    fn gh(number: &str) -> Candidate {
        Candidate::GitHub(number.into())
    }

    fn linear(identifier: &str) -> Candidate {
        Candidate::Linear(identifier.into())
    }

    #[test]
    fn a_branch_or_worktree_name_names_its_issue() {
        let none = teams(&[]);
        assert_eq!(name_candidates(&["raccoon/441-show-who-is-working"], true, &none), vec![gh("441")]);
        assert_eq!(name_candidates(&["fix/issue-12-crash"], true, &none), vec![gh("12")]);
        assert_eq!(name_candidates(&["gh-7"], true, &none), vec![gh("7")]);
        assert_eq!(name_candidates(&["feature/#88"], true, &none), vec![gh("88")]);
        assert_eq!(name_candidates(&["me/pro-93-comment-thread"], true, &teams(&["PRO"])), vec![linear("PRO-93")]);
        // A Linear key the reader has no team for is not one.
        assert_eq!(name_candidates(&["me/pro-93-comment-thread"], true, &none), Vec::<Candidate>::new());
        // No GitHub repository: a number is nothing.
        assert_eq!(name_candidates(&["441-fix"], false, &none), Vec::<Candidate>::new());
        for name in ["main", "2fa-login", "v2-upgrade", "release-2024", "update-deps"] {
            assert_eq!(name_candidates(&[name], true, &none), Vec::<Candidate>::new(), "{name}");
        }
        assert_eq!(name_candidates(&["raccoon/441-x", "441-x"], true, &none), vec![gh("441")]);
    }

    fn prompt_candidates(text: &str, repo: Option<&str>, teams: &BTreeSet<String>) -> Vec<Candidate> {
        PromptRefs::read(text).candidates(repo, teams)
    }

    #[test]
    fn a_first_prompt_names_its_issue() {
        let keys = teams(&["ENG"]);
        let repo = Some("acme/widgets");
        assert_eq!(prompt_candidates("Look at https://github.com/Acme/Widgets/issues/441 please", repo, &keys), vec![gh("441")]);
        assert_eq!(prompt_candidates("See https://github.com/other/repo/issues/5", repo, &keys), Vec::<Candidate>::new());
        assert_eq!(prompt_candidates("Fixes #12 and step #1", repo, &keys), vec![gh("12")]);
        assert_eq!(prompt_candidates("#441 Show who is working", repo, &keys), vec![gh("441")]);
        assert_eq!(prompt_candidates("work on ENG-42, not FOO-1", repo, &keys), vec![linear("ENG-42")]);
        assert_eq!(prompt_candidates("https://linear.app/acme/issue/abc-9/title", None, &keys), vec![linear("ABC-9")]);
        assert_eq!(prompt_candidates("fixes #12", None, &keys), Vec::<Candidate>::new());
    }

    #[test]
    fn a_pull_request_names_the_issue_it_closes() {
        let pr = BranchPull { state: PullRequestState::Open, title: "Login timeout (ENG-42)".into(), body: "Closes: eng-7\nFixes #3".into(), closes: vec![("acme/widgets".into(), 3), ("other/repo".into(), 9)] };
        assert_eq!(pull_request_candidates(&pr, Some("acme/widgets"), &teams(&["ENG"])), vec![gh("3"), linear("ENG-42"), linear("ENG-7")]);
    }

    fn issue(provider: &str, id: &str, identifier: &str) -> IssueRef {
        let url = if provider == "github" { format!("https://github.com/acme/widgets/issues/{id}") } else { format!("https://linear.app/acme/issue/{identifier}") };
        IssueRef { provider: provider.into(), id: id.into(), identifier: identifier.into(), title: "T".into(), url }
    }

    #[derive(Default)]
    struct Fake {
        issues: Vec<IssueRef>,
        pulls: HashMap<String, BranchPull>,
        prompt: Option<String>,
        asked: RefCell<Vec<String>>,
        /// The trackers cannot be reached.
        offline: Cell<bool>,
        /// Linear could not be asked for its teams.
        no_teams: Cell<bool>,
        /// How often Linear was asked for its teams, and a first request read.
        teams_asked: Cell<usize>,
        prompts_read: Cell<usize>,
    }

    impl Lookup for Fake {
        fn github_repo(&self, _: &str) -> Option<String> {
            Some("acme/widgets".into())
        }
        fn github_issue(&self, _: &str, number: &str) -> Result<Option<IssueRef>, String> {
            self.asked.borrow_mut().push(format!("gh:{number}"));
            if self.offline.get() {
                return Err("error connecting to api.github.com".into());
            }
            Ok(self.issues.iter().find(|issue| issue.provider == "github" && issue.id == number).cloned())
        }
        fn github_issue_in(&self, repo: &str, number: &str) -> Result<Option<IssueRef>, String> {
            self.asked.borrow_mut().push(format!("{repo}:{number}"));
            self.github_issue("", number)
        }
        fn linear_issue(&self, identifier: &str) -> Result<Option<IssueRef>, String> {
            self.asked.borrow_mut().push(format!("linear:{identifier}"));
            if self.offline.get() {
                return Err("Linear could not be reached".into());
            }
            Ok(self.issues.iter().find(|issue| issue.identifier == identifier).cloned())
        }
        fn linear_teams(&self) -> Option<BTreeSet<String>> {
            self.teams_asked.set(self.teams_asked.get() + 1);
            (!self.no_teams.get()).then(|| teams(&["ENG"]))
        }
        fn branch_pulls(&self, _: &str, branches: &[String]) -> Option<HashMap<String, BranchPull>> {
            self.asked.borrow_mut().push(format!("pulls:{}", branches.join(",")));
            Some(self.pulls.clone())
        }
        fn first_request(&self, _: &SessionEntry) -> Option<String> {
            self.prompts_read.set(self.prompts_read.get() + 1);
            self.prompt.clone()
        }
    }

    fn session(id: &str, branch: Option<&str>) -> SessionEntry {
        serde_json::from_value(serde_json::json!({
            "id": id, "projectPath": "/work/widgets", "cwd": "/work/widgets", "branch": branch,
            "title": "t", "created": crate::store::index::now(), "modified": crate::store::index::now(),
        }))
        .unwrap()
    }

    #[test]
    fn a_branch_link_is_confirmed_by_the_tracker_and_asked_once() {
        let fake = Fake { issues: vec![issue("github", "441", "#441")], ..Default::default() };
        let mut linker = Linker::default();
        let sessions = [session("s1", Some("raccoon/441-work")), session("s2", Some("raccoon/999-none"))];
        let pass = linker.pass(&fake, &sessions);
        assert_eq!(pass.links, vec![("s1".to_string(), issue("github", "441", "#441"), IssueLinkSource::Branch)]);
        let asked = fake.asked.borrow().len();
        // The same names are not looked at again.
        assert!(linker.pass(&fake, &sessions).links.iter().all(|(id, ..)| id == "s1"));
        assert!(fake.asked.borrow()[asked..].iter().all(|asked| !asked.starts_with("gh:")), "{:?}", fake.asked.borrow());
    }

    /// Let every failed lookup's wait run out, as if [`RETRY_FAILED`] had passed.
    fn age_failures(linker: &mut Linker) {
        let long_ago = Instant::now().checked_sub(RETRY_FAILED + Duration::from_secs(1)).unwrap();
        for verified in linker.verified.values_mut() {
            if let Verified::Failed(at) = verified {
                *at = long_ago;
            }
        }
    }


    #[test]
    fn a_lookup_that_failed_is_tried_again_and_links_once_the_tracker_answers() {
        let fake = Fake { issues: vec![issue("github", "441", "#441"), issue("linear", "uuid-42", "ENG-42")], prompt: Some("Please fix ENG-42".into()), ..Default::default() };
        fake.offline.set(true);
        let mut linker = Linker::default();
        let sessions = [session("s1", Some("raccoon/441-work")), session("s2", Some("raccoon/other"))];
        assert_eq!(linker.pass(&fake, &sessions).links, vec![]);
        let asked = fake.asked.borrow().len();
        // Within the wait, nobody is asked again.
        assert_eq!(linker.pass(&fake, &sessions).links, vec![]);
        assert_eq!(fake.asked.borrow().len(), asked);
        // Back online, after the wait: the branch and the prompt are looked at again.
        fake.offline.set(false);
        age_failures(&mut linker);
        assert_eq!(linker.pass(&fake, &sessions).links, vec![
            ("s1".to_string(), issue("github", "441", "#441"), IssueLinkSource::Branch),
            ("s2".to_string(), issue("linear", "uuid-42", "ENG-42"), IssueLinkSource::Prompt),
        ]);
    }

    #[test]
    fn linear_teams_that_cannot_be_read_settle_each_session_until_they_can() {
        // A Linear key that is set but keeps failing (revoked, invalid): the team keys stay unknown.
        let fake = Fake { issues: vec![issue("linear", "uuid-42", "ENG-42")], prompt: Some("Please fix ENG-42".into()), ..Default::default() };
        fake.no_teams.set(true);
        let mut linker = Linker::default();
        let sessions = [session("s1", Some("me/eng-42-login")), session("s2", Some("raccoon/other"))];
        assert_eq!(linker.pass(&fake, &sessions).links, vec![]);
        assert_eq!((fake.prompts_read.get(), fake.teams_asked.get()), (2, 1));
        // Pass after pass, no first request is read again and Linear is not asked again within the hour.
        for _ in 0..5 {
            age_failures(&mut linker);
            assert_eq!(linker.pass(&fake, &sessions).links, vec![]);
        }
        assert_eq!((fake.prompts_read.get(), fake.teams_asked.get()), (2, 1));
        // Once Linear answers, both are looked at again: the branch, and the prompt as it was read.
        fake.no_teams.set(false);
        linker.age_teams();
        assert_eq!(linker.pass(&fake, &sessions).links, vec![
            ("s1".to_string(), issue("linear", "uuid-42", "ENG-42"), IssueLinkSource::Branch),
            ("s2".to_string(), issue("linear", "uuid-42", "ENG-42"), IssueLinkSource::Prompt),
        ]);
        assert_eq!((fake.prompts_read.get(), fake.teams_asked.get()), (2, 2));
    }

    #[test]
    fn a_cloud_session_is_settled_under_the_teams_answer_it_was_looked_for_under() {
        let fake = Fake { issues: vec![issue("linear", "uuid-42", "ENG-42")], ..Default::default() };
        fake.no_teams.set(true);
        let mut linker = Linker::default();
        assert_eq!(linker.cloud_issue(&fake, Some("acme/widgets"), &["eng-42-login"]), (None, true));
        let unknown = linker.teams_answer(&fake);
        // The same answer read again an hour on: what was settled under it stands.
        linker.age_teams();
        assert_eq!(linker.teams_answer(&fake), unknown);
        assert_eq!(fake.teams_asked.get(), 2);
        // Linear answers: asking for the latest answer reads it, before any cloud session is looked at again.
        fake.no_teams.set(false);
        linker.age_teams();
        assert_ne!(linker.teams_answer(&fake), unknown);
        assert_eq!(linker.cloud_issue(&fake, Some("acme/widgets"), &["eng-42-login"]), (Some(issue("linear", "uuid-42", "ENG-42")), true));
        assert_eq!(fake.teams_asked.get(), 3);
    }

    #[test]
    fn an_issue_unlinked_by_hand_is_never_linked_again() {
        let fake = Fake { issues: vec![issue("github", "441", "#441")], ..Default::default() };
        let mut unlinked = session("s1", Some("441-work"));
        unlinked.issue_work.unlinked.push("https://github.com/acme/widgets/issues/441".into());
        assert_eq!(Linker::default().pass(&fake, &[unlinked]).links, vec![]);
    }

    #[test]
    fn a_pull_request_or_the_first_prompt_links_when_the_branch_does_not() {
        let mut pulls = HashMap::new();
        pulls.insert("raccoon/login".to_string(), BranchPull { state: PullRequestState::Open, title: "Login".into(), body: String::new(), closes: vec![("acme/widgets".into(), 12)] });
        let fake = Fake { issues: vec![issue("github", "12", "#12"), issue("linear", "uuid-42", "ENG-42")], pulls, prompt: Some("Please fix ENG-42".into()), ..Default::default() };
        let mut linker = Linker::default();
        let pass = linker.pass(&fake, &[session("s1", Some("raccoon/login")), session("s2", Some("raccoon/other"))]);
        assert_eq!(pass.links, vec![
            ("s1".to_string(), issue("github", "12", "#12"), IssueLinkSource::PullRequest),
            ("s2".to_string(), issue("linear", "uuid-42", "ENG-42"), IssueLinkSource::Prompt),
        ]);
        assert_eq!(linker.pull_request("s1"), Some(PullRequestState::Open));
        assert_eq!(linker.pull_request("s2"), None);
        // One request for the checkout's branches, not one per session.
        assert_eq!(fake.asked.borrow().iter().filter(|asked| asked.starts_with("pulls:")).count(), 1);
    }

    #[test]
    fn a_linked_session_gets_only_its_pull_request_read() {
        let mut pulls = HashMap::new();
        pulls.insert("441-work".to_string(), BranchPull { state: PullRequestState::Merged, title: String::new(), body: String::new(), closes: vec![] });
        let fake = Fake { pulls, ..Default::default() };
        let mut linked = session("s1", Some("441-work"));
        linked.issue = Some(issue("github", "441", "#441"));
        let mut linker = Linker::default();
        assert_eq!(linker.pass(&fake, &[linked]).links, vec![]);
        assert_eq!(linker.pull_request("s1"), Some(PullRequestState::Merged));
        assert!(fake.asked.borrow().iter().all(|asked| asked.starts_with("pulls:")));
    }

    #[test]
    fn a_cloud_session_branch_is_confirmed_in_its_workspace_repository() {
        let fake = Fake { issues: vec![issue("github", "7", "#7")], ..Default::default() };
        let mut linker = Linker::default();
        assert_eq!(linker.cloud_issue(&fake, Some("acme/widgets"), &["7-fix"]), (Some(issue("github", "7", "#7")), true));
        assert_eq!(fake.asked.borrow().as_slice(), ["acme/widgets:7", "gh:7"]);
        assert_eq!(linker.cloud_issue(&fake, None, &["7-fix"]), (None, true));
        // A failed lookup is not an answer: the cloud session is looked at again.
        fake.offline.set(true);
        assert_eq!(linker.cloud_issue(&fake, Some("acme/widgets"), &["8-fix"]), (None, false));
    }
}
