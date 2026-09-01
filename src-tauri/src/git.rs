#![allow(dead_code)] // consumers land in later checkpoints; audited at C16

//! Git, by shelling out. The only other thing this module shells out to is
//! nothing: `gh` lives in `github.rs`.
//!
//! Every diff invocation ends in `--`, or a working-tree file named like a sha
//! makes git die with "ambiguous argument".

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn git() -> Command {
    let mut c = Command::new(crate::binpath::resolve("git").unwrap_or_else(|| PathBuf::from("git")));
    c.env("PATH", crate::binpath::login_path());
    c.env("GIT_TERMINAL_PROMPT", "0");
    c.env("LC_ALL", "C");
    c
}

pub fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = git().current_dir(cwd).args(args).output().with_context(|| format!("git {}", args.join(" ")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!("git {}: {}", args.join(" "), if err.is_empty() { format!("exit {}", out.status) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_ok(cwd: &Path, args: &[&str]) -> bool {
    git().current_dir(cwd).args(args).output().map(|o| o.status.success()).unwrap_or(false)
}

pub fn is_repo(cwd: &Path) -> bool {
    run_ok(cwd, &["rev-parse", "--is-inside-work-tree"])
}

/// The repository's main worktree root, wherever `cwd` is inside it. Linked
/// worktrees answer their own tree to `--show-toplevel`, so the first record of
/// `worktree list` is used instead.
pub fn main_worktree(cwd: &Path) -> Result<PathBuf> {
    let out = run(cwd, &["worktree", "list", "--porcelain"])?;
    out.lines()
        .find_map(|l| l.strip_prefix("worktree "))
        .map(PathBuf::from)
        .ok_or_else(|| anyhow!("not a git repository"))
}

pub fn current_branch(cwd: &Path) -> Option<String> {
    run(cwd, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn default_branch(cwd: &Path) -> Option<String> {
    if let Ok(s) = run(cwd, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]) {
        let s = s.trim();
        return Some(s.strip_prefix("origin/").unwrap_or(s).to_string());
    }
    for cand in ["main", "master"] {
        if run_ok(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{cand}")]) {
            return Some(cand.to_string());
        }
    }
    current_branch(cwd)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub remote: bool,
}

pub fn list_branches(cwd: &Path) -> Result<Vec<BranchInfo>> {
    let cur = current_branch(cwd);
    let out = run(cwd, &["for-each-ref", "--format=%(refname:short)%09%(refname)", "refs/heads", "refs/remotes"])?;
    let mut v = Vec::new();
    for line in out.lines() {
        let (short, full) = line.split_once('\t').unwrap_or((line, ""));
        if short.ends_with("/HEAD") {
            continue;
        }
        v.push(BranchInfo {
            name: short.to_string(),
            current: cur.as_deref() == Some(short),
            remote: full.starts_with("refs/remotes/"),
        });
    }
    Ok(v)
}

/// Tree id of the working tree right now, via a temp index so the real index,
/// working tree and stash are untouched. Copying the index rather than starting
/// empty keeps this fast: the copy carries git's stat cache.
pub fn snapshot_tree(cwd: &Path) -> Result<String> {
    let index = run(cwd, &["rev-parse", "--git-path", "index"])?.trim().to_string();
    let index_path = if Path::new(&index).is_absolute() { PathBuf::from(&index) } else { cwd.join(&index) };
    let tmp = std::env::temp_dir().join(format!("raccoon-index-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
    if index_path.exists() {
        std::fs::copy(&index_path, &tmp)?;
    }
    let result = (|| {
        let mut c = git();
        c.current_dir(cwd).env("GIT_INDEX_FILE", &tmp).args(["add", "-A", "--", "."]);
        let o = c.output()?;
        if !o.status.success() {
            bail!("snapshot add: {}", String::from_utf8_lossy(&o.stderr));
        }
        let mut c = git();
        c.current_dir(cwd).env("GIT_INDEX_FILE", &tmp).args(["write-tree"]);
        let o = c.output()?;
        if !o.status.success() {
            bail!("write-tree: {}", String::from_utf8_lossy(&o.stderr));
        }
        Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

pub fn head_tree(cwd: &Path) -> Result<String> {
    match run(cwd, &["rev-parse", "HEAD^{tree}"]) {
        Ok(s) => Ok(s.trim().to_string()),
        Err(_) if is_repo(cwd) => Ok(EMPTY_TREE.into()),
        Err(e) => Err(e),
    }
}

pub fn head_commit(cwd: &Path) -> Option<String> {
    run(cwd, &["rev-parse", "HEAD"]).ok().map(|s| s.trim().to_string())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: ChangeStatus,
    pub additions: u32,
    pub deletions: u32,
}

fn is_tree_id(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Changed files between two trees (or a tree and the working tree when
/// `head` is `None`), with per-file line counts.
pub fn changes_between(cwd: &Path, base: &str, head: Option<&str>) -> Result<Vec<ChangedFile>> {
    if !is_tree_id(base) {
        bail!("bad base tree id");
    }
    if let Some(h) = head {
        if !is_tree_id(h) {
            bail!("bad head tree id");
        }
    }
    let mut args = vec!["diff", "--numstat", "-M", "--name-status", "-z", base];
    if let Some(h) = head {
        args.push(h);
    }
    args.push("--");
    // --numstat and --name-status can't be combined in one call; run both.
    let status_out = run(cwd, &args.iter().filter(|a| **a != "--numstat").cloned().collect::<Vec<_>>())?;
    let num_out = run(cwd, &args.iter().filter(|a| **a != "--name-status").cloned().collect::<Vec<_>>())?;

    let mut counts = std::collections::HashMap::new();
    for rec in num_out.split('\0').filter(|s| !s.is_empty()) {
        // "adds\tdels\tpath" — renames put the two paths as following NUL fields.
        let mut it = rec.splitn(3, '\t');
        let a = it.next().unwrap_or("0");
        let d = it.next().unwrap_or("0");
        let p = it.next().unwrap_or("");
        counts.insert(p.to_string(), (a.parse().unwrap_or(0), d.parse().unwrap_or(0)));
    }
    let mut out = Vec::new();
    let fields: Vec<&str> = status_out.split('\0').collect();
    let mut i = 0;
    while i < fields.len() {
        let st = fields[i];
        if st.is_empty() {
            i += 1;
            continue;
        }
        let code = st.chars().next().unwrap_or('M');
        match code {
            'R' | 'C' => {
                let old = fields.get(i + 1).copied().unwrap_or("").to_string();
                let new = fields.get(i + 2).copied().unwrap_or("").to_string();
                let (a, d) = counts.get(&new).copied().unwrap_or((0, 0));
                out.push(ChangedFile { path: new, old_path: Some(old), status: ChangeStatus::Renamed, additions: a, deletions: d });
                i += 3;
            }
            _ => {
                let p = fields.get(i + 1).copied().unwrap_or("").to_string();
                let (a, d) = counts.get(&p).copied().unwrap_or((0, 0));
                let status = match code {
                    'A' => ChangeStatus::Added,
                    'D' => ChangeStatus::Deleted,
                    _ => ChangeStatus::Modified,
                };
                out.push(ChangedFile { path: p, old_path: None, status, additions: a, deletions: d });
                i += 2;
            }
        }
    }
    Ok(out)
}

/// Contents of `path` at `tree`, or `None` if it doesn't exist there.
pub fn blob_at(cwd: &Path, tree: &str, path: &str) -> Result<Option<String>> {
    if !is_tree_id(tree) {
        bail!("bad tree id");
    }
    let spec = format!("{tree}:{path}");
    let out = git().current_dir(cwd).args(["cat-file", "-p", &spec]).output()?;
    if !out.status.success() {
        return Ok(None);
    }
    if out.stdout.len() > 4 * 1024 * 1024 {
        return Ok(Some(String::from("<file too large to show>")));
    }
    Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
}

pub fn working_file(cwd: &Path, path: &str) -> Option<String> {
    let p = cwd.join(path);
    let meta = std::fs::metadata(&p).ok()?;
    if meta.len() > 4 * 1024 * 1024 {
        return Some("<file too large to show>".into());
    }
    std::fs::read(&p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkStatus {
    pub is_repo: bool,
    pub dirty: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub default_branch: Option<String>,
    /// Commits on this branch that `origin/<default>` doesn't have.
    pub ahead_of_base: Option<u32>,
    pub head: Option<String>,
}

/// One command answering everything the header and handoff row need, so no
/// button is drawn from one snapshot beside another from a different one.
/// Infallible: a non-repo answers defaults.
pub fn work_status(cwd: &Path) -> WorkStatus {
    if !is_repo(cwd) {
        return WorkStatus::default();
    }
    let branch = current_branch(cwd);
    let dirty = run(cwd, &["status", "--porcelain", "--untracked-files=normal", "--"]).map(|s| !s.trim().is_empty()).unwrap_or(false);
    let upstream = run(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).ok().map(|s| s.trim().to_string());
    let (ahead, behind) = upstream
        .as_ref()
        .and_then(|_| run(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]).ok())
        .and_then(|s| {
            let mut it = s.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        })
        .unwrap_or((0, 0));
    let default = default_branch(cwd);
    let ahead_of_base = default.as_ref().and_then(|d| {
        let base = if run_ok(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/remotes/origin/{d}")]) {
            format!("origin/{d}")
        } else {
            d.clone()
        };
        run(cwd, &["rev-list", "--count", &format!("{base}..HEAD")]).ok().and_then(|s| s.trim().parse().ok())
    });
    WorkStatus { is_repo: true, dirty, branch, upstream, ahead, behind, default_branch: default, ahead_of_base, head: head_commit(cwd) }
}

// ---------------------------------------------------------------- worktrees

pub fn worktree_root(project: &Path) -> PathBuf {
    project.join(crate::store::settings::load().worktree_dir)
}

pub fn worktree_path(project: &Path, name: &str) -> PathBuf {
    worktree_root(project).join(name)
}

pub fn worktree_branch(name: &str) -> String {
    format!("{}{}", crate::store::settings::load().branch_prefix, name)
}

/// Every `raccoon/*` branch, local and remote-tracking, so a name whose PR
/// already landed is never redrawn.
pub fn worktree_branch_names(project: &Path) -> Vec<String> {
    let prefix = crate::store::settings::load().branch_prefix;
    run(project, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
        .map(|s| {
            s.lines()
                .filter_map(|l| {
                    let l = l.trim();
                    let l = l.split_once('/').filter(|(r, _)| *r == "origin").map(|(_, rest)| rest).unwrap_or(l);
                    l.strip_prefix(&prefix).map(|n| n.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Names taken on disk, in branches, or in the index.
pub fn taken_worktree_names(project: &Path, index_names: &[String]) -> Vec<String> {
    let mut v: Vec<String> = index_names.to_vec();
    v.extend(worktree_branch_names(project));
    if let Ok(rd) = std::fs::read_dir(worktree_root(project)) {
        v.extend(rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()));
    }
    v
}

/// Base ref for a new worktree: `origin/<default>` when it exists, else the
/// local default branch, else HEAD.
pub fn resolve_base(project: &Path, requested: Option<&str>) -> Result<String> {
    if let Some(r) = requested.filter(|r| !r.is_empty()) {
        if !run_ok(project, &["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")]) {
            bail!("unknown base ref {r}");
        }
        return Ok(r.to_string());
    }
    if let Some(d) = default_branch(project) {
        let remote = format!("origin/{d}");
        if run_ok(project, &["rev-parse", "--verify", "--quiet", &format!("{remote}^{{commit}}")]) {
            return Ok(remote);
        }
        if run_ok(project, &["rev-parse", "--verify", "--quiet", &format!("{d}^{{commit}}")]) {
            return Ok(d);
        }
    }
    Ok("HEAD".into())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorktree {
    pub name: String,
    pub path: String,
    pub branch: String,
    pub base: String,
    /// Tree id of the base commit, the first turn's changes baseline.
    pub base_tree: String,
}

pub fn create_worktree(project: &Path, name: &str, base: Option<&str>) -> Result<CreatedWorktree> {
    if !crate::names::is_worktree_name(name) && name.contains(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_') {
        bail!("bad worktree name");
    }
    let base = resolve_base(project, base)?;
    let path = worktree_path(project, name);
    std::fs::create_dir_all(worktree_root(project))?;
    let branch = worktree_branch(name);
    run(project, &["worktree", "add", "--no-track", "-B", &branch, path.to_str().unwrap(), &base])?;
    ensure_worktree_dir_ignored(project);
    let base_tree = run(&path, &["rev-parse", "HEAD^{tree}"])?.trim().to_string();
    Ok(CreatedWorktree { name: name.to_string(), path: path.to_string_lossy().into_owned(), branch, base, base_tree })
}

/// Keep the worktree directory out of the project's own status without
/// touching `.gitignore`: `.git/info/exclude` is local to this clone.
fn ensure_worktree_dir_ignored(project: &Path) {
    let dir = crate::store::settings::load().worktree_dir;
    let top = dir.split('/').next().unwrap_or(".raccoon").to_string();
    if let Ok(git_dir) = run(project, &["rev-parse", "--git-common-dir"]) {
        let git_dir = git_dir.trim();
        let git_dir = if Path::new(git_dir).is_absolute() { PathBuf::from(git_dir) } else { project.join(git_dir) };
        let exclude = git_dir.join("info").join("exclude");
        let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
        let line = format!("/{top}/");
        if !existing.lines().any(|l| l.trim() == line) {
            let _ = std::fs::create_dir_all(exclude.parent().unwrap());
            let mut s = existing;
            if !s.is_empty() && !s.ends_with('\n') {
                s.push('\n');
            }
            s.push_str(&line);
            s.push('\n');
            let _ = std::fs::write(&exclude, s);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDisposition {
    pub exists: bool,
    pub uncommitted: u32,
    /// Commits no other ref holds. Over-warning is the safe direction.
    pub unpushed: u32,
    pub branch: Option<String>,
}

pub fn worktree_disposition(project: &Path, name: &str) -> WorktreeDisposition {
    let path = worktree_path(project, name);
    if !path.exists() {
        return WorktreeDisposition::default();
    }
    let branch = worktree_branch(name);
    let uncommitted = run(&path, &["status", "--porcelain", "--"]).map(|s| s.lines().count() as u32).unwrap_or(0);
    let unpushed = run(
        &path,
        &["rev-list", "--count", "HEAD", "--not", &format!("--exclude={branch}"), "--branches", "--remotes", "--tags"],
    )
    .ok()
    .and_then(|s| s.trim().parse().ok())
    .unwrap_or(0);
    WorktreeDisposition { exists: true, uncommitted, unpushed, branch: Some(branch) }
}

/// Remove a worktree and its branch. The path guard keys on shape: a direct
/// child of the worktree root or nothing, so an empty name can never resolve
/// to the project itself.
pub fn remove_worktree(project: &Path, name: &str) -> Result<()> {
    if name.is_empty() || name.contains('/') || name == "." || name == ".." {
        bail!("refusing to remove: bad worktree name");
    }
    let path = worktree_path(project, name);
    let root = worktree_root(project);
    if path.parent() != Some(root.as_path()) {
        bail!("refusing to remove: not under the worktree directory");
    }
    if path.exists() {
        let _ = run(project, &["worktree", "unlock", path.to_str().unwrap()]);
        run(project, &["worktree", "remove", "--force", path.to_str().unwrap()])?;
    }
    let _ = run(project, &["worktree", "prune"]);
    let branch = worktree_branch(name);
    let _ = run(project, &["branch", "-D", &branch]);
    Ok(())
}

pub fn list_worktrees(project: &Path) -> Result<Vec<(String, Option<String>)>> {
    let out = run(project, &["worktree", "list", "--porcelain"])?;
    let mut v = Vec::new();
    let mut cur: Option<String> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(c) = cur.take() {
                v.push((c, None));
            }
            cur = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(c) = cur.take() {
                v.push((c, Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string())));
            }
        }
    }
    if let Some(c) = cur {
        v.push((c, None));
    }
    Ok(v)
}

// ---------------------------------------------------------------- history & commits

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub parent: Option<String>,
    pub tree: String,
}

pub fn log_commits(cwd: &Path, range: Option<&str>, limit: u32) -> Result<Vec<CommitInfo>> {
    let fmt = "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%T%x1e";
    let limit = format!("-n{limit}");
    let mut args = vec!["log", fmt, &limit];
    if let Some(r) = range {
        args.push(r);
    }
    args.push("--");
    let out = run(cwd, &args)?;
    Ok(out
        .split('\x1e')
        .filter(|r| !r.trim().is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            if f.len() < 9 {
                return None;
            }
            Some(CommitInfo {
                sha: f[0].into(),
                short_sha: f[1].into(),
                subject: f[2].into(),
                body: f[3].trim().into(),
                author: f[4].into(),
                email: f[5].into(),
                date: f[6].into(),
                parent: f[7].split_whitespace().next().map(String::from),
                tree: f[8].into(),
            })
        })
        .collect())
}

pub fn commit_all(cwd: &Path, message: &str, paths: Option<&[String]>) -> Result<String> {
    match paths {
        Some(ps) if !ps.is_empty() => {
            let mut args = vec!["add", "-A", "--"];
            args.extend(ps.iter().map(|s| s.as_str()));
            run(cwd, &args)?;
            let mut args = vec!["commit", "-m", message, "--"];
            args.extend(ps.iter().map(|s| s.as_str()));
            run(cwd, &args)?;
        }
        _ => {
            run(cwd, &["add", "-A", "--", "."])?;
            run(cwd, &["commit", "-m", message])?;
        }
    }
    Ok(head_commit(cwd).unwrap_or_default())
}

pub fn push(cwd: &Path) -> Result<String> {
    let branch = current_branch(cwd).ok_or_else(|| anyhow!("detached HEAD"))?;
    let has_upstream = run_ok(cwd, &["rev-parse", "--abbrev-ref", "@{upstream}"]);
    if has_upstream {
        run(cwd, &["push"])
    } else {
        run(cwd, &["push", "-u", "origin", &branch])
    }
}

pub fn pull(cwd: &Path) -> Result<String> {
    run(cwd, &["pull", "--ff-only"])
}

pub fn discard_file(cwd: &Path, path: &str) -> Result<()> {
    // Tracked: restore from HEAD. Untracked: delete.
    if run_ok(cwd, &["ls-files", "--error-unmatch", "--", path]) {
        run(cwd, &["checkout", "HEAD", "--", path])?;
    } else {
        let p = cwd.join(path);
        if p.is_dir() {
            std::fs::remove_dir_all(p)?;
        } else if p.exists() {
            std::fs::remove_file(p)?;
        }
    }
    Ok(())
}

pub fn checkout_branch(cwd: &Path, name: &str, create: bool) -> Result<()> {
    if name.starts_with('-') {
        bail!("bad branch name");
    }
    if create {
        run(cwd, &["checkout", "-b", name])?;
    } else {
        run(cwd, &["checkout", name])?;
    }
    Ok(())
}

pub fn stash(cwd: &Path, message: &str) -> Result<()> {
    run(cwd, &["stash", "push", "-u", "-m", message])?;
    Ok(())
}

pub fn remote_url(cwd: &Path) -> Option<String> {
    run(cwd, &["remote", "get-url", "origin"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        run(p, &["init", "-q", "-b", "main"]).unwrap();
        run(p, &["config", "user.email", "t@example.com"]).unwrap();
        run(p, &["config", "user.name", "T"]).unwrap();
        std::fs::write(p.join("a.txt"), "hello\n").unwrap();
        run(p, &["add", "."]).unwrap();
        run(p, &["commit", "-q", "-m", "init"]).unwrap();
        dir
    }

    #[test]
    fn snapshot_and_changes() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let base = snapshot_tree(p).unwrap();
        assert_eq!(base, head_tree(p).unwrap());
        std::fs::write(p.join("a.txt"), "hello\nworld\n").unwrap();
        std::fs::write(p.join("b.txt"), "new\n").unwrap();
        let head = snapshot_tree(p).unwrap();
        assert_ne!(base, head);
        // The real index is untouched.
        assert!(run(p, &["diff", "--cached", "--name-only", "--"]).unwrap().trim().is_empty());
        let mut ch = changes_between(p, &base, Some(&head)).unwrap();
        ch.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(ch.len(), 2);
        assert_eq!(ch[0].path, "a.txt");
        assert_eq!(ch[0].status, ChangeStatus::Modified);
        assert_eq!(ch[0].additions, 1);
        assert_eq!(ch[1].status, ChangeStatus::Added);
        assert_eq!(blob_at(p, &head, "b.txt").unwrap().unwrap(), "new\n");
        assert!(blob_at(p, &base, "b.txt").unwrap().is_none());
        let ws = work_status(p);
        assert!(ws.is_repo && ws.dirty);
        assert_eq!(ws.branch.as_deref(), Some("main"));
    }

    #[test]
    fn worktree_lifecycle() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        assert!(Path::new(&wt.path).join("a.txt").exists());
        assert_eq!(wt.branch, "raccoon/quiet-amber-fox");
        assert!(worktree_branch_names(p).contains(&"quiet-amber-fox".to_string()));
        assert!(taken_worktree_names(p, &[]).contains(&"quiet-amber-fox".to_string()));
        // The project's own status doesn't list the worktree directory.
        assert!(!work_status(p).dirty);
        std::fs::write(Path::new(&wt.path).join("c.txt"), "x").unwrap();
        let d = worktree_disposition(p, "quiet-amber-fox");
        assert!(d.exists && d.uncommitted == 1 && d.unpushed == 0);
        assert!(remove_worktree(p, "").is_err());
        assert!(remove_worktree(p, "../x").is_err());
        remove_worktree(p, "quiet-amber-fox").unwrap();
        assert!(!Path::new(&wt.path).exists());
        assert!(!worktree_branch_names(p).contains(&"quiet-amber-fox".to_string()));
        assert_eq!(main_worktree(p).unwrap().canonicalize().unwrap(), p.canonicalize().unwrap());
    }

    #[test]
    fn log_and_commit() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        std::fs::write(p.join("a.txt"), "changed\n").unwrap();
        let sha = commit_all(p, "second\n\nbody here", None).unwrap();
        let log = log_commits(p, None, 10).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].sha, sha);
        assert_eq!(log[0].subject, "second");
        assert_eq!(log[0].body, "body here");
        assert!(log[1].parent.is_none());
    }
}
