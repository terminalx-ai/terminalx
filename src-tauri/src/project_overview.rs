//! A project at a glance, for its overview page: its branches, who works on
//! it and how much lately, the newest commits on its default branch and its
//! pull requests.
//!
//! Git answers everything but the pull requests, without a fetch, so the page
//! shows what this checkout knows. The pull requests come from `gh`; without
//! it (or a GitHub remote) the page goes without them and says why.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, Local, NaiveDate};
use serde::Serialize;

use crate::git;

/// How far back "lately" reaches: the tiles and the contributors' counts.
const RECENT_DAYS: i64 = 30;
/// Days in a contributor's activity strip, today last.
const STRIP_DAYS: usize = 14;
const FIELD: char = '\u{1f}';

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectOverview {
    /// The default branch, as named on the remote (`main`), when it can be told.
    pub default_branch: Option<String>,
    /// Commits on the default branch in the last [`RECENT_DAYS`] days.
    pub recent_commits: u32,
    /// Local branches, the most recently committed to first.
    pub branches: Vec<BranchInfo>,
    pub contributors: Vec<Contributor>,
    /// The newest commits on the default branch.
    pub latest: Vec<CommitInfo>,
    /// `None` when they could not be read; `pull_request_note` says why.
    pub pull_requests: Option<PullRequests>,
    pub pull_request_note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub committed_at: String,
    pub author: String,
    pub subject: String,
    /// Commits it has that the default branch does not, and the reverse.
    pub ahead: u32,
    pub behind: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributor {
    pub name: String,
    pub email: String,
    /// Their GitHub login, when their commit email gives it away.
    pub login: Option<String>,
    /// Commits in the last [`RECENT_DAYS`] days, on any branch.
    pub commits: u32,
    /// Commits per day over the last [`STRIP_DAYS`] days, oldest first.
    pub days: Vec<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub author: String,
    pub email: String,
    pub at: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequests {
    pub open: u32,
    /// Merged in the last [`RECENT_DAYS`] days.
    pub merged: u32,
    /// The newest, opened or merged, newest first.
    pub recent: Vec<PullRequestItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestItem {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// `OPEN`, `MERGED` or `CLOSED`.
    pub state: String,
    pub is_draft: bool,
    pub author: String,
    /// When it was opened, or merged for a merged one: what puts it in the list.
    pub at: String,
}

pub fn overview(project: &Path) -> ProjectOverview {
    let _request = crate::github_process::scope();
    if !git::is_repo(project) {
        return ProjectOverview { pull_request_note: Some("Not a Git repository.".into()), ..Default::default() };
    }
    let context = crate::landed::list_context(project);
    let base = context.base().map(String::from);
    let today = Local::now().date_naive();
    let recent_since = format!("--since={RECENT_DAYS}.days");
    let (pull_requests, pull_request_note) = match pull_requests(project, today) {
        Ok(prs) => (Some(prs), None),
        Err(error) => (None, Some(gh_note(&format!("{error:#}")))),
    };
    ProjectOverview {
        default_branch: base.as_deref().map(|b| b.strip_prefix("origin/").unwrap_or(b).to_string()),
        recent_commits: base
            .as_deref()
            .and_then(|b| git::run(project, &["rev-list", "--count", &recent_since, b]).ok())
            .and_then(|n| n.trim().parse().ok())
            .unwrap_or(0),
        branches: branches(project, base.as_deref()),
        contributors: contributors(&git::run(project, &["log", "--all", "--no-merges", &recent_since, "--format=%an%x1f%ae%x1f%aI"]).unwrap_or_default(), today),
        latest: base
            .as_deref()
            .map(|b| commits(&git::run(project, &["log", "-n", "8", "--no-merges", "--format=%h%x1f%an%x1f%ae%x1f%aI%x1f%s", b]).unwrap_or_default()))
            .unwrap_or_default(),
        pull_requests,
        pull_request_note,
    }
}

fn branches(project: &Path, base: Option<&str>) -> Vec<BranchInfo> {
    let out = git::run(project, &["for-each-ref", "refs/heads", "--sort=-committerdate", "--count=12", "--format=%(refname:short)%1f%(committerdate:iso-strict)%1f%(authorname)%1f%(subject)"]).unwrap_or_default();
    out.lines()
        .filter_map(|line| {
            let mut parts = line.split(FIELD);
            let name = parts.next()?.to_string();
            let committed_at = parts.next()?.to_string();
            let author = parts.next().unwrap_or("").to_string();
            let subject = parts.next().unwrap_or("").to_string();
            let (ahead, behind) = base.map(|base| ahead_behind(project, base, &name)).unwrap_or((0, 0));
            Some(BranchInfo { name, committed_at, author, subject, ahead, behind })
        })
        .collect()
}

fn ahead_behind(project: &Path, base: &str, branch: &str) -> (u32, u32) {
    let out = git::run(project, &["rev-list", "--left-right", "--count", &format!("{branch}...{base}")]).unwrap_or_default();
    let mut counts = out.split_whitespace().map(|n| n.parse().unwrap_or(0));
    (counts.next().unwrap_or(0), counts.next().unwrap_or(0))
}

/// Who committed in the log given (`%an %ae %aI` per line), busiest first:
/// one entry a person, by email, with their commits a day for the strip.
fn contributors(log: &str, today: NaiveDate) -> Vec<Contributor> {
    let mut people: HashMap<String, Contributor> = HashMap::new();
    for line in log.lines() {
        let mut parts = line.split(FIELD);
        let (Some(name), Some(email), Some(at)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let key = email.to_ascii_lowercase();
        let person = people.entry(key).or_insert_with(|| Contributor {
            name: name.to_string(),
            email: email.to_string(),
            login: github_login(email),
            commits: 0,
            days: vec![0; STRIP_DAYS],
        });
        person.commits += 1;
        if let Ok(at) = DateTime::parse_from_rfc3339(at) {
            let ago = (today - at.with_timezone(&Local).date_naive()).num_days();
            if (0..STRIP_DAYS as i64).contains(&ago) {
                person.days[STRIP_DAYS - 1 - ago as usize] += 1;
            }
        }
    }
    let mut people: Vec<Contributor> = people.into_values().collect();
    people.sort_by(|a, b| b.commits.cmp(&a.commits).then(a.name.cmp(&b.name)));
    people.truncate(6);
    people
}

/// The login in a GitHub no-reply address (`1234+octocat@users.noreply.github.com`).
fn github_login(email: &str) -> Option<String> {
    let local = email.strip_suffix("@users.noreply.github.com")?;
    let login = local.split_once('+').map(|(_, login)| login).unwrap_or(local);
    (!login.is_empty()).then(|| login.to_string())
}

fn commits(log: &str) -> Vec<CommitInfo> {
    log.lines()
        .filter_map(|line| {
            let mut parts = line.split(FIELD);
            Some(CommitInfo {
                sha: parts.next()?.to_string(),
                author: parts.next()?.to_string(),
                email: parts.next()?.to_string(),
                at: parts.next()?.to_string(),
                subject: parts.next().unwrap_or("").to_string(),
            })
        })
        .collect()
}

fn pull_requests(project: &Path, today: NaiveDate) -> anyhow::Result<PullRequests> {
    const FIELDS: &str = "number,title,url,state,isDraft,author,createdAt,mergedAt";
    let since = (today - chrono::Duration::days(RECENT_DAYS)).format("%Y-%m-%d").to_string();
    let open = crate::github::list_prs(project, &["--state", "open", "--limit", "100", "--json", FIELDS])?;
    let merged = crate::github::list_prs(project, &["--state", "merged", "--search", &format!("merged:>={since}"), "--limit", "100", "--json", FIELDS])?;
    let item = |v: &serde_json::Value| PullRequestItem {
        number: v["number"].as_u64().unwrap_or(0),
        title: v["title"].as_str().unwrap_or("").into(),
        url: v["url"].as_str().unwrap_or("").into(),
        state: v["state"].as_str().unwrap_or("OPEN").into(),
        is_draft: v["isDraft"].as_bool().unwrap_or(false),
        author: v["author"]["login"].as_str().unwrap_or("").into(),
        at: v["mergedAt"].as_str().filter(|s| !s.is_empty()).or_else(|| v["createdAt"].as_str()).unwrap_or("").into(),
    };
    let mut recent: Vec<PullRequestItem> = open.iter().chain(merged.iter()).map(item).collect();
    recent.sort_by(|a, b| b.at.cmp(&a.at));
    recent.truncate(6);
    Ok(PullRequests { open: open.len() as u32, merged: merged.len() as u32, recent })
}

/// Why there are no pull requests, in a line for the page.
fn gh_note(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if error.contains(crate::data_privacy::MESSAGE) {
        crate::data_privacy::MESSAGE.into()
    } else if lower.contains("not found") && lower.contains("gh") || lower.contains("no such file") {
        "Install the GitHub CLI (gh) to see pull requests.".into()
    } else if lower.contains("auth") || lower.contains("login") {
        "Sign in to the GitHub CLI (gh auth login) to see pull requests.".into()
    } else if lower.contains("no git remotes") || lower.contains("none of the git remotes") || lower.contains("not a github") {
        "No GitHub remote, so no pull requests.".into()
    } else {
        "Pull requests could not be read from GitHub.".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contributors_are_counted_by_email_busiest_first_with_a_strip_of_days() {
        let today = NaiveDate::from_ymd_opt(2026, 10, 21).unwrap();
        let at = |day: u32| format!("2026-10-{day:02}T12:00:00+00:00");
        let log = [
            format!("Ada\u{1f}ada@x.dev\u{1f}{}", at(21)),
            format!("Ada\u{1f}ADA@x.dev\u{1f}{}", at(21)),
            format!("Ada\u{1f}ada@x.dev\u{1f}{}", at(1)),
            format!("Bo\u{1f}9+bo@users.noreply.github.com\u{1f}{}", at(20)),
        ]
        .join("\n");
        let people = contributors(&log, today);
        assert_eq!(people.iter().map(|p| (p.name.as_str(), p.commits)).collect::<Vec<_>>(), [("Ada", 3), ("Bo", 1)]);
        assert_eq!(people[0].days[STRIP_DAYS - 1], 2, "two today; the one three weeks back is off the strip");
        assert_eq!(people[0].days.iter().sum::<u32>(), 2);
        assert_eq!(people[1].login.as_deref(), Some("bo"));
        assert_eq!(people[1].days[STRIP_DAYS - 2], 1);
    }

    #[test]
    fn branches_say_how_far_they_are_from_the_default_branch() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let sh = |args: &[&str]| assert!(std::process::Command::new("git").args(args).current_dir(p).output().unwrap().status.success(), "{args:?}");
        sh(&["init", "-q", "-b", "main"]);
        std::fs::write(p.join("a"), "1").unwrap();
        sh(&["add", "a"]);
        sh(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "one"]);
        sh(&["checkout", "-qb", "feature"]);
        std::fs::write(p.join("a"), "2").unwrap();
        sh(&["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "two"]);
        let listed = branches(p, Some("main"));
        let feature = listed.iter().find(|b| b.name == "feature").unwrap();
        assert_eq!((feature.ahead, feature.behind, feature.subject.as_str()), (1, 0, "two"));
        assert_eq!(commits(&git::run(p, &["log", "--format=%h%x1f%an%x1f%ae%x1f%aI%x1f%s", "main"]).unwrap())[0].subject, "one");
    }
}
