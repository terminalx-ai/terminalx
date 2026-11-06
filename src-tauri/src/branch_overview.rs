//! Where a checkout's branch stands against the branch it will merge into:
//! the commits only it has, how far the base moved since it forked, who wrote
//! either, and whether the two would merge cleanly. Read from refs already
//! here; nothing is fetched.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::git::{self, CommitInfo};

/// Commits listed on either side; the counts cover all of them.
const LISTED: u32 = 30;
/// Authors are counted over at most this many commits a side.
const COUNTED: &str = "-n500";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Contributor {
    pub name: String,
    pub email: String,
    pub commits: u32,
    /// Their newest commit's author date (ISO 8601).
    pub last: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeCheck {
    /// `clean`, `conflicts`, `merged` (nothing of the branch left to merge) or `unknown`.
    pub state: String,
    pub conflicted: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchOverview {
    pub branch: Option<String>,
    /// The ref merged into: `origin/main`, else the local default branch.
    pub base: Option<String>,
    /// The checkout is on the base branch itself.
    pub on_base: bool,
    pub fork_point: Option<CommitInfo>,
    /// Commits only on the branch, and on the base since the fork.
    pub ahead: u32,
    pub behind: u32,
    pub commits: Vec<CommitInfo>,
    pub base_commits: Vec<CommitInfo>,
    /// Who wrote the branch's own commits, most commits first.
    pub contributors: Vec<Contributor>,
    /// Who moved the base since the fork.
    pub base_contributors: Vec<Contributor>,
    pub upstream: Option<String>,
    /// Against the upstream: commits not pushed, and not pulled.
    pub unpushed: u32,
    pub unpulled: u32,
    pub dirty: bool,
    pub merge: MergeCheck,
}

pub fn overview(cwd: &Path) -> BranchOverview {
    let status = git::work_status(cwd);
    if !status.is_repo {
        return BranchOverview::default();
    }
    let base = status.default_branch.as_deref().map(|d| {
        if git::run(cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{d}")]).is_ok() {
            format!("origin/{d}")
        } else {
            d.to_string()
        }
    });
    let on_base = status.branch.is_some() && status.branch == status.default_branch;
    let mut out = BranchOverview {
        branch: status.branch.clone(),
        on_base,
        upstream: status.upstream.clone(),
        unpushed: status.ahead,
        unpulled: status.behind,
        dirty: status.dirty,
        merge: MergeCheck { state: "unknown".into(), conflicted: vec![] },
        ..Default::default()
    };
    let Some(base) = base else { return out };
    let fork = git::run(cwd, &["merge-base", &base, "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let mine = format!("{base}..HEAD");
    let theirs = format!("HEAD..{base}");
    out.ahead = count(cwd, &mine);
    out.behind = count(cwd, &theirs);
    out.commits = git::log_commits(cwd, Some(&mine), LISTED).unwrap_or_default();
    out.base_commits = git::log_commits(cwd, Some(&theirs), LISTED).unwrap_or_default();
    out.contributors = contributors(cwd, &mine);
    out.base_contributors = contributors(cwd, &theirs);
    out.fork_point = fork.as_deref().and_then(|sha| git::log_commits(cwd, Some(sha), 1).ok()).and_then(|mut v| v.pop());
    out.merge = if out.ahead == 0 { MergeCheck { state: "merged".into(), conflicted: vec![] } } else { merge_check(cwd, &base) };
    out.base = Some(base);
    out
}

fn count(cwd: &Path, range: &str) -> u32 {
    git::run(cwd, &["rev-list", "--count", range]).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

fn contributors(cwd: &Path, range: &str) -> Vec<Contributor> {
    let out = git::run(cwd, &["log", COUNTED, "--format=%an%x1f%ae%x1f%aI", range, "--"]).unwrap_or_default();
    tally(&out)
}

/// Authors in `git log --format=%an%x1f%ae%x1f%aI` output (newest first), one
/// per email, the most commits first.
pub fn tally(log: &str) -> Vec<Contributor> {
    let mut people: Vec<Contributor> = Vec::new();
    for line in log.lines() {
        let mut f = line.split('\x1f');
        let (Some(name), Some(email), Some(date)) = (f.next(), f.next(), f.next()) else { continue };
        let key = email.trim().to_ascii_lowercase();
        match people.iter_mut().find(|p| p.email.to_ascii_lowercase() == key) {
            Some(person) => person.commits += 1,
            None => people.push(Contributor { name: name.trim().into(), email: email.trim().into(), commits: 1, last: date.trim().into() }),
        }
    }
    people.sort_by_key(|p| std::cmp::Reverse(p.commits));
    people
}

/// Would `HEAD` merge into `base` as it stands? `git merge-tree --write-tree`
/// answers without touching the checkout: exit 0 clean, exit 1 conflicts.
fn merge_check(cwd: &Path, base: &str) -> MergeCheck {
    let out = git::raw(cwd, &["merge-tree", "--write-tree", "--name-only", "--no-messages", base, "HEAD"]);
    match out {
        Some((0, _)) => MergeCheck { state: "clean".into(), conflicted: vec![] },
        Some((1, stdout)) => MergeCheck { state: "conflicts".into(), conflicted: conflicted_in(&stdout) },
        _ => MergeCheck { state: "unknown".into(), conflicted: vec![] },
    }
}

/// The paths after the tree id in `merge-tree --name-only --no-messages` output.
pub fn conflicted_in(stdout: &str) -> Vec<String> {
    let mut paths: Vec<String> = stdout.lines().skip(1).map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect();
    paths.dedup();
    paths
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git").current_dir(dir).args(args).env("GIT_AUTHOR_DATE", "2026-10-01T00:00:00Z").env("GIT_COMMITTER_DATE", "2026-10-01T00:00:00Z").status().unwrap().success();
        assert!(ok, "git {args:?}");
    }

    fn commit(dir: &Path, file: &str, text: &str, who: &str) {
        std::fs::write(dir.join(file), text).unwrap();
        sh(dir, &["add", "."]);
        sh(dir, &["-c", &format!("user.name={who}"), "-c", &format!("user.email={}@example.com", who.to_lowercase()), "commit", "-qm", &format!("{who}: {file}")]);
    }

    #[test]
    fn authors_are_counted_once_per_email_most_commits_first() {
        let log = "Ann\x1fann@x.io\x1f2026-10-03\nBo\x1fbo@x.io\x1f2026-10-02\nAnn\x1fANN@x.io\x1f2026-10-01\n";
        let people = tally(log);
        assert_eq!(people.iter().map(|p| (p.name.as_str(), p.commits, p.last.as_str())).collect::<Vec<_>>(), vec![("Ann", 2, "2026-10-03"), ("Bo", 1, "2026-10-02")]);
    }

    #[test]
    fn conflicted_paths_follow_the_tree_id() {
        assert_eq!(conflicted_in("abc123\nsrc/a.ts\nsrc/b.ts\n"), vec!["src/a.ts", "src/b.ts"]);
        assert!(conflicted_in("abc123\n").is_empty());
    }

    #[test]
    fn a_branch_is_placed_against_its_base_with_its_authors_and_its_merge() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        sh(d, &["init", "-q", "-b", "main"]);
        commit(d, "a.txt", "one\n", "Ann");
        sh(d, &["checkout", "-qb", "feature"]);
        commit(d, "b.txt", "mine\n", "Ann");
        commit(d, "c.txt", "mine too\n", "Bo");
        sh(d, &["checkout", "-q", "main"]);
        commit(d, "d.txt", "theirs\n", "Cy");
        sh(d, &["checkout", "-q", "feature"]);

        let o = overview(d);
        assert_eq!(o.branch.as_deref(), Some("feature"));
        assert_eq!(o.base.as_deref(), Some("main"));
        assert!(!o.on_base);
        assert_eq!((o.ahead, o.behind), (2, 1));
        assert_eq!(o.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(), vec!["Bo: c.txt", "Ann: b.txt"]);
        assert_eq!(o.base_commits.len(), 1);
        assert_eq!(o.contributors.iter().map(|p| p.name.as_str()).collect::<Vec<_>>().len(), 2);
        assert_eq!(o.base_contributors[0].name, "Cy");
        assert_eq!(o.fork_point.as_ref().map(|c| c.subject.as_str()), Some("Ann: a.txt"));
        assert_eq!(o.merge.state, "clean");

        // The base changes a line the branch changed too: they no longer merge.
        sh(d, &["checkout", "-q", "main"]);
        commit(d, "b.txt", "not yours\n", "Cy");
        sh(d, &["checkout", "-q", "feature"]);
        let o = overview(d);
        assert_eq!(o.merge.state, "conflicts");
        assert_eq!(o.merge.conflicted, vec!["b.txt"]);

        // On the base itself there is nothing of a branch to merge.
        sh(d, &["checkout", "-q", "main"]);
        let o = overview(d);
        assert!(o.on_base);
        assert_eq!(o.ahead, 0);
        assert_eq!(o.merge.state, "merged");
    }
}
