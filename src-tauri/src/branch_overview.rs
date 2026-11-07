//! Where a checkout's branch stands against the branch it will merge into:
//! the commits only it has, how far the base moved since it forked, who wrote
//! either, and whether the two would merge cleanly. Read from refs already
//! here; `fetch` brings them up to date first.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::git::{self, CommitInfo};

/// A fetch the panel starts on its own is given up after this long.
const FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Brings the remote's branches up to date, so what others pushed shows as
/// incoming before anyone pulls. Only remote-tracking refs move: never a
/// local branch or the checkout. The remote is the branch's upstream's, or
/// `origin`; false when there is none or the fetch failed (offline, no
/// credentials: nothing is ever asked).
pub fn fetch(cwd: &Path) -> bool {
    let branch = git::run(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok().map(|s| s.trim().to_string());
    let remote = branch
        .and_then(|b| git::run(cwd, &["config", "--get", &format!("branch.{b}.remote")]).ok())
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty() && r != ".")
        .unwrap_or_else(|| "origin".into());
    if git::run(cwd, &["remote", "get-url", &remote]).is_err() {
        return false;
    }
    git::run_within(cwd, &["-c", "credential.interactive=false", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", &remote], FETCH_TIMEOUT, &|| false).is_ok()
}

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
    /// The main checkout, read from Git rather than inferred from a worktree path.
    pub main_checkout: Option<String>,
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
    /// The upstream's commits not pulled yet, newest first: someone else's work.
    pub incoming: Vec<CommitInfo>,
    pub dirty: bool,
    /// Files changed and not committed (staged, unstaged or new).
    pub changed: u32,
    /// The repository has a remote at all: without one there is nothing to
    /// push to and no pull request, and the work ends by merging it here.
    pub has_remote: bool,
    pub merge: MergeCheck,
}

/// `recorded` is the ref the worktree was made from, when the app made it:
/// the branch is read against that rather than the default branch, so one
/// started from `develop` is not said to be behind `main`. A recorded ref that
/// is gone, or is only `HEAD`, falls back to the default branch.
pub fn overview(cwd: &Path, recorded: Option<&str>, local_only: bool) -> BranchOverview {
    let status = git::work_status(cwd);
    if !status.is_repo {
        return BranchOverview::default();
    }
    let default = status.default_branch.as_deref().map(|d| {
        if git::run(cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{d}")]).is_ok() {
            format!("origin/{d}")
        } else {
            d.to_string()
        }
    });
    let recorded = recorded
        .map(str::trim)
        .filter(|r| !r.is_empty() && *r != "HEAD" && status.branch.as_deref() != Some(*r))
        .filter(|r| git::run(cwd, &["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")]).is_ok())
        .map(String::from);
    let base = recorded.or(default);
    // A remote-tracking ref can lag behind a local merge. Local actions and
    // their cleanup must be checked against the actual local target branch.
    let base = if local_only { base.and_then(|base| local_base(cwd, &base)) } else { base };
    let on_base = status.branch.is_some() && (status.branch == base || (!local_only && status.branch == status.default_branch));
    let main_checkout = git::run(cwd, &["worktree", "list", "--porcelain", "-z"]).ok()
        .and_then(|list| list.split('\0').next()?.strip_prefix("worktree ").map(String::from));
    let mut out = BranchOverview {
        branch: status.branch.clone(),
        main_checkout,
        on_base,
        upstream: status.upstream.clone(),
        unpushed: status.ahead,
        unpulled: status.behind,
        dirty: status.dirty,
        changed: if status.dirty { git::run(cwd, &["status", "--porcelain", "--untracked-files=normal", "--"]).map(|s| s.lines().count() as u32).unwrap_or(0) } else { 0 },
        has_remote: git::run(cwd, &["remote"]).map(|s| !s.trim().is_empty()).unwrap_or(false),
        merge: MergeCheck { state: "unknown".into(), conflicted: vec![] },
        ..Default::default()
    };
    if out.unpulled > 0 {
        out.incoming = git::log_commits(cwd, Some("HEAD..@{upstream}"), LISTED).unwrap_or_default();
    }
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
    out.merge = if out.ahead == 0 && (!local_only || git::run(cwd, &["merge-base", "--is-ancestor", "HEAD", &base]).is_ok()) { MergeCheck { state: "merged".into(), conflicted: vec![] } } else { merge_check(cwd, &base) };
    out.base = Some(base);
    out
}

/// Only a branch is a local merge target, never a tag or an arbitrary commit.
fn local_base(cwd: &Path, base: &str) -> Option<String> {
    let full = git::run(cwd, &["rev-parse", "--symbolic-full-name", base]).ok()?;
    let full = full.trim();
    let branch = full.strip_prefix("refs/heads/").or_else(|| full.strip_prefix("refs/remotes/")?.split_once('/').map(|(_, branch)| branch))?;
    git::run(cwd, &["show-ref", "--verify", &format!("refs/heads/{branch}")]).ok()?;
    Some(branch.to_string())
}

/// Merges the checked-out branch into the local branch `into`, for a project
/// with nowhere to open a pull request. Nothing is left half done: where
/// `into` is checked out (the project's own folder, usually) the merge runs
/// there only if that checkout is clean, and is undone if it conflicts;
/// where it is checked out nowhere, the merge is made without a checkout
/// (`merge-tree`), and a conflict changes nothing.
pub fn merge_into(cwd: &Path, into: &str) -> anyhow::Result<String> {
    use anyhow::{anyhow, bail};
    let branch = git::run(cwd, &["symbolic-ref", "--quiet", "--short", "HEAD"]).map_err(|_| anyhow!("Not on a branch"))?.trim().to_string();
    if branch == into {
        bail!("Already on {into}");
    }
    if git::run(cwd, &["status", "--porcelain", "--untracked-files=normal", "--"]).is_ok_and(|s| !s.trim().is_empty()) {
        bail!("Commit your changes first");
    }
    let target = format!("refs/heads/{into}");
    let old = git::run(cwd, &["rev-parse", "--verify", "--quiet", &target]).map_err(|_| anyhow!("There is no local {into} branch"))?.trim().to_string();
    let head = git::run(cwd, &["rev-parse", "HEAD"])?.trim().to_string();
    if git::run(cwd, &["merge-base", "--is-ancestor", &head, &old]).is_ok() {
        return Ok(format!("{into} already has this work"));
    }
    if let Some(checkout) = checked_out_at(cwd, &target) {
        if git::run(&checkout, &["status", "--porcelain", "--untracked-files=no", "--"]).is_ok_and(|s| !s.trim().is_empty()) {
            bail!("{into} has uncommitted changes in {}; commit or stash them there first", checkout.display());
        }
        if git::run(&checkout, &["merge", "--no-edit", &branch]).is_err() {
            let _ = git::run(&checkout, &["merge", "--abort"]);
            bail!("{branch} conflicts with {into}; nothing was merged");
        }
        return Ok(format!("Merged into {into}"));
    }
    let new = if git::run(cwd, &["merge-base", "--is-ancestor", &old, &head]).is_ok() {
        head
    } else {
        let tree = match git::raw(cwd, &["merge-tree", "--write-tree", &old, &head]) {
            Some((0, out)) => out.lines().next().unwrap_or_default().trim().to_string(),
            Some((1, _)) => bail!("{branch} conflicts with {into}; nothing was merged"),
            _ => bail!("Could not merge {branch} into {into}"),
        };
        git::run(cwd, &["commit-tree", &tree, "-p", &old, "-p", &head, "-m", &format!("Merge branch '{branch}'")])?.trim().to_string()
    };
    git::run(cwd, &["update-ref", &target, &new, &old])?;
    Ok(format!("Merged into {into}"))
}

/// The worktree with `refname` checked out, if any.
fn checked_out_at(cwd: &Path, refname: &str) -> Option<std::path::PathBuf> {
    let list = git::run(cwd, &["worktree", "list", "--porcelain"]).ok()?;
    let mut path = None;
    for line in list.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(std::path::PathBuf::from(p));
        } else if line.strip_prefix("branch ") == Some(refname) {
            return path;
        }
    }
    None
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
    fn local_merges_follow_the_local_base_and_report_the_main_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main's checkout");
        let worktree = dir.path().join("worktree");
        std::fs::create_dir(&main).unwrap();
        sh(&main, &["init", "-q", "-b", "main"]);
        commit(&main, "base.txt", "base", "Ann");
        sh(&main, &["branch", "develop"]);
        sh(&main, &["update-ref", "refs/remotes/upstream/develop", "HEAD"]);
        sh(&main, &["worktree", "add", "-qb", "feature", worktree.to_str().unwrap(), "develop"]);
        commit(&worktree, "feature.txt", "feature", "Ann");
        let before = overview(&worktree, Some("upstream/develop"), true);
        assert_eq!(before.base.as_deref(), Some("develop"));
        assert_eq!(before.main_checkout.as_deref().map(std::path::PathBuf::from), Some(std::fs::canonicalize(&main).unwrap()));
        assert_eq!(before.ahead, 1);
        assert!(!before.on_base);
        sh(&main, &["switch", "-q", "develop"]);
        sh(&main, &["merge", "--ff-only", "feature"]);
        let after = overview(&worktree, Some("upstream/develop"), true);
        assert_eq!(after.ahead, 0);
        assert_eq!(after.merge.state, "merged");
        assert_eq!(overview(&worktree, Some("upstream/develop"), false).ahead, 1, "the remote-tracking ref has not moved");
        sh(&main, &["tag", "release"]);
        assert_eq!(local_base(&main, "release"), None);
        sh(&main, &["update-ref", "refs/remotes/upstream/missing", "HEAD"]);
        assert_eq!(local_base(&main, "upstream/missing"), None);
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

        let o = overview(d, None, false);
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
        let o = overview(d, None, false);
        assert_eq!(o.merge.state, "conflicts");
        assert_eq!(o.merge.conflicted, vec!["b.txt"]);

        // A clone of the branch someone else pushed to: their commit is listed until it is pulled.
        let other = tempfile::tempdir().unwrap();
        let o = other.path().join("c");
        sh(other.path(), &["clone", "-q", "-b", "feature", d.to_str().unwrap(), "c"]);
        commit(d, "e.txt", "theirs too\n", "Di");
        assert_eq!(overview(&o, None, false).unpulled, 0, "not seen before a fetch");
        assert!(fetch(&o));
        let mine = overview(&o, None, false);
        assert_eq!(mine.unpulled, 1);
        assert_eq!(mine.incoming.iter().map(|c| c.author.as_str()).collect::<Vec<_>>(), vec!["Di"]);

        // Nowhere to fetch from.
        assert!(!fetch(d));

        // Started from another branch: read against that one, not the default.
        sh(d, &["checkout", "-qb", "develop", "main"]);
        commit(d, "f.txt", "develop\n", "Cy");
        sh(d, &["checkout", "-qb", "from-develop"]);
        commit(d, "g.txt", "mine\n", "Ann");
        let o = overview(d, Some("develop"), false);
        assert_eq!(o.base.as_deref(), Some("develop"));
        assert_eq!((o.ahead, o.behind), (1, 0));
        // Gone, or only HEAD: the default branch.
        assert_eq!(overview(d, Some("no-such-branch"), false).base.as_deref(), Some("main"));
        assert_eq!(overview(d, Some("HEAD"), false).base.as_deref(), Some("main"));

        // Nowhere to open a pull request: merged here, into the branch's own checkout or none.
        assert!(!o.has_remote);
        std::fs::write(d.join("dirt.txt"), "x").unwrap();
        assert_eq!(overview(d, Some("develop"), false).changed, 1);
        assert!(merge_into(d, "develop").unwrap_err().to_string().contains("Commit your changes first"));
        std::fs::remove_file(d.join("dirt.txt")).unwrap();
        assert_eq!(merge_into(d, "develop").unwrap(), "Merged into develop");
        assert_eq!(overview(d, Some("develop"), false).ahead, 0);
        assert_eq!(merge_into(d, "develop").unwrap(), "develop already has this work");
        // Into a branch checked out elsewhere, and that has moved on: a merge commit made there.
        let wt = tempfile::tempdir().unwrap();
        let at = wt.path().join("main");
        sh(d, &["checkout", "-q", "from-develop"]);
        sh(d, &["-c", "user.name=T", "-c", "user.email=t@x.io", "worktree", "add", "-q", "-b", "trunk", at.to_str().unwrap(), "main"]);
        // The merge commit is made by whoever the repository says.
        sh(d, &["config", "user.name", "Ann"]);
        sh(d, &["config", "user.email", "ann@example.com"]);
        commit(&at, "h.txt", "trunk\n", "Cy");
        commit(d, "i.txt", "mine\n", "Ann");
        assert_eq!(merge_into(d, "trunk").unwrap(), "Merged into trunk");
        assert!(at.join("i.txt").exists(), "merged into the checkout itself");
        // A conflict is undone, there and here.
        commit(&at, "i.txt", "theirs\n", "Cy");
        commit(d, "i.txt", "mine again\n", "Ann");
        assert!(merge_into(d, "trunk").unwrap_err().to_string().contains("conflicts"));
        assert_eq!(std::fs::read_to_string(at.join("i.txt")).unwrap(), "theirs\n");
        sh(d, &["worktree", "remove", "--force", at.to_str().unwrap()]);

        // On the base itself there is nothing of a branch to merge.
        sh(d, &["checkout", "-q", "main"]);
        let o = overview(d, None, false);
        assert!(o.on_base);
        assert_eq!(o.ahead, 0);
        assert_eq!(o.merge.state, "merged");
    }
}
