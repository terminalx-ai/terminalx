//! A merge that was started in a checkout and neither committed nor aborted.
//!
//! While `MERGE_HEAD` is set, every file the merge brought in is uncommitted,
//! so the other side's work looks like this branch's own: a merge of `main`
//! that changes 23 files reads as 23 files of work that a removal would lose,
//! although `main` still has 22 of them. This tells them apart.
//!
//! What Git merged by itself is worked out again with
//! `git merge-tree --write-tree HEAD MERGE_HEAD`, which writes nothing to the
//! checkout or its index. Each uncommitted file (untracked ones included) is
//! then one of three:
//!
//! - **conflicted**: still unmerged in the index;
//! - **from the base**: exactly as Git merged it, so the other side still
//!   has what it holds;
//! - **changed here**: anything else, such as a conflict resolved by hand, an
//!   edit made while merging, or an untracked file.
//!
//! A file is only said to come from the base on that evidence. A merge of
//! more than one commit (an octopus) cannot be worked out again this way, so
//! none of its files is.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Serialize;

use crate::git;

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(10)]
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnfinishedMerge {
    /// The commit HEAD is at, which the merge goes on top of.
    pub head: String,
    /// The commit being merged: the first, for an octopus merge.
    pub merge_head: String,
    /// Branches that point at it, remote ones first (`origin/main`); empty
    /// when none does.
    pub names: Vec<String>,
    /// Commits it brings in that HEAD does not have.
    pub incoming: u32,
    /// Paths still unmerged in the index.
    pub conflicted: Vec<String>,
    /// Uncommitted paths that differ from what Git merged by itself.
    pub changed_here: Vec<String>,
    /// Uncommitted paths exactly as Git merged them.
    pub from_base: Vec<String>,
}

impl UnfinishedMerge {
    /// What is being merged, in a few words: `origin/main`, or
    /// `commit 1a2b3c4d5e` when no branch points at it.
    pub fn what(&self) -> String {
        self.names.first().cloned().unwrap_or_else(|| format!("commit {}", short(&self.merge_head)))
    }
}

/// The commits `MERGE_HEAD` names; empty when no merge is in progress.
pub fn merge_heads(cwd: &Path) -> Result<Vec<String>> {
    // Per worktree: a linked worktree keeps its own under `.git/worktrees/`.
    let path = git::run(cwd, &["rev-parse", "--git-path", "MERGE_HEAD"])?;
    let path = PathBuf::from(path.trim());
    let path = if path.is_absolute() { path } else { cwd.join(path) };
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text.lines().map(str::trim).filter(|line| !line.is_empty()).map(String::from).collect()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
    }
}

/// Paths with entries still unmerged in the index (stages 1 to 3).
fn unmerged(cwd: &Path) -> Result<Vec<String>> {
    let out = git::run(cwd, &["ls-files", "--unmerged", "-z"])?;
    // `<mode> <object> <stage>\t<path>`, once per stage.
    let paths: BTreeSet<String> = out.split('\0').filter_map(|record| record.split_once('\t')).map(|(_, path)| path.to_string()).collect();
    Ok(paths.into_iter().collect())
}

/// The paths whose contents differ between two trees.
fn differing(cwd: &Path, a: &str, b: &str) -> Result<BTreeSet<String>> {
    let out = git::run(cwd, &["diff", "--name-only", "--no-renames", "-z", a, b, "--"])?;
    Ok(out.split('\0').filter(|path| !path.is_empty()).map(String::from).collect())
}

/// Branches that point at `commit`, remote-tracking ones first: those are
/// what a base usually is.
fn names_of(cwd: &Path, commit: &str) -> Result<Vec<String>> {
    let out = git::run(cwd, &["for-each-ref", &format!("--points-at={commit}"), "--format=%(refname)", "refs/remotes", "refs/heads"])?;
    let (mut remote, mut local) = (Vec::new(), Vec::new());
    for name in out.lines().map(str::trim) {
        if let Some(short) = name.strip_prefix("refs/remotes/").filter(|short| !short.ends_with("/HEAD")) {
            remote.push(short.to_string());
        } else if let Some(short) = name.strip_prefix("refs/heads/") {
            local.push(short.to_string());
        }
    }
    remote.extend(local);
    Ok(remote)
}

/// The merge in progress in the checkout, with what each of its
/// uncommitted files is. `None` when there is no merge in progress.
pub fn read(cwd: &Path) -> Result<Option<UnfinishedMerge>> {
    let heads = merge_heads(cwd)?;
    let Some(merge_head) = heads.first().cloned() else { return Ok(None) };
    let head = git::head_commit(cwd).context("the checkout has no commit to merge into")?;
    let conflicted = unmerged(cwd)?;
    let head_tree = git::head_tree(cwd)?;
    // The working tree as a tree, untracked files included, without touching the index.
    let snapshot = git::snapshot_tree(cwd)?;
    let uncommitted = if head_tree == snapshot { Vec::new() } else { git::changes_between(cwd, &head_tree, Some(&snapshot))? };
    let changed = match heads.as_slice() {
        [_] => {
            let (merged, _) = git::merge_tree(cwd, &head, &merge_head)?;
            Some(differing(cwd, &merged, &snapshot)?)
        }
        _ => None,
    };
    let (mut changed_here, mut from_base) = (Vec::new(), Vec::new());
    for file in uncommitted.iter().filter(|file| !conflicted.contains(&file.path)) {
        let as_merged = changed.as_ref().is_some_and(|changed| !changed.contains(&file.path) && file.old_path.as_ref().is_none_or(|old| !changed.contains(old)));
        if as_merged { from_base.push(file.path.clone()) } else { changed_here.push(file.path.clone()) }
    }
    let incoming = git::run(cwd, &["rev-list", "--count", &format!("{head}..{merge_head}")])?.trim().parse().unwrap_or(0);
    Ok(Some(UnfinishedMerge { names: names_of(cwd, &merge_head)?, head, merge_head, incoming, conflicted, changed_here, from_base }))
}

/// That the checkout still holds exactly the merge someone looked at: HEAD
/// at `head`, merging `merge_head` alone.
fn expect(cwd: &Path, head: &str, merge_head: &str) -> Result<()> {
    let heads = merge_heads(cwd)?;
    if heads.is_empty() {
        bail!("No merge is in progress in this checkout any more.");
    }
    if heads != [merge_head] {
        bail!("The checkout is now merging {}, not {}.", heads.iter().map(|commit| short(commit)).collect::<Vec<_>>().join(" and "), short(merge_head));
    }
    let current = git::head_commit(cwd).context("the checkout has no commit")?;
    if current != head {
        bail!("HEAD moved to {} since the merge was read; it was at {}.", short(&current), short(head));
    }
    Ok(())
}

/// Commit the merge as it stands, with the message Git prepared for it.
/// Everything uncommitted goes into it, as with any commit made here.
/// Refused while a file is still conflicted. The new commit.
pub fn commit(cwd: &Path, head: &str, merge_head: &str) -> Result<String> {
    expect(cwd, head, merge_head)?;
    let conflicted = unmerged(cwd)?;
    if !conflicted.is_empty() {
        let (files, have, them) = match conflicted.len() {
            1 => ("1 file".to_string(), "has", "it"),
            n => (format!("{n} files"), "have", "them"),
        };
        bail!("{files} still {have} unresolved conflicts: {}. Resolve {them} first.", conflicted.join(", "));
    }
    git::run(cwd, &["add", "-A", "--", "."])?;
    git::run(cwd, &["commit", "--no-edit"])?;
    git::head_commit(cwd).context("the merge was committed, but HEAD could not be read")
}

/// `git merge --abort`: the checkout goes back to `head` as it was before
/// the merge. Only while it still holds exactly that merge; Git refuses an
/// abort that would lose changes it cannot put back, and says so.
pub fn abort(cwd: &Path, head: &str, merge_head: &str) -> Result<()> {
    expect(cwd, head, merge_head)?;
    git::run(cwd, &["merge", "--abort"])?;
    if !merge_heads(cwd)?.is_empty() {
        bail!("git merge --abort left the merge in progress.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(cwd: &Path, args: &[&str]) -> std::process::Output {
        std::process::Command::new("git")
            .current_dir(cwd)
            .args(["-c", "user.name=T", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", "-c", "core.editor=true"])
            .args(args)
            .output()
            .unwrap()
    }

    fn ok(cwd: &Path, args: &[&str]) -> String {
        let out = git(cwd, args);
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn write(root: &Path, path: &str, text: &str) {
        let path = root.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// `main` gained three files and an edit to the changelog the branch
    /// also edited; the branch is part way through merging it, as a
    /// resolver that stopped before its commit leaves it.
    fn half_merged() -> (tempfile::TempDir, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        ok(root, &["init", "-q", "-b", "main"]);
        // `commit` runs git as the app does, with the repository's own identity.
        for (key, value) in [("user.name", "T"), ("user.email", "t@example.test"), ("commit.gpgsign", "false")] {
            ok(root, &["config", key, value]);
        }
        write(root, "CHANGELOG.md", "# Changes\n");
        // Unlike the base's new files, so no rename is detected between them.
        write(root, "src/old.rs", "pub const RETIRED: &[&str] = &[\"legacy\", \"handlers\", \"kept for one release\"];\n");
        ok(root, &["add", "."]);
        ok(root, &["commit", "-qm", "first"]);
        ok(root, &["checkout", "-qb", "raccoon/736-work"]);
        write(root, "CHANGELOG.md", "# Changes\n- branch\n");
        write(root, "src/work.rs", "fn work() {}\n");
        ok(root, &["add", "."]);
        ok(root, &["commit", "-qm", "branch"]);
        let head = ok(root, &["rev-parse", "HEAD"]);
        ok(root, &["checkout", "-q", "main"]);
        write(root, "CHANGELOG.md", "# Changes\n- base\n");
        write(root, "src/a.rs", "fn a() {}\n");
        write(root, "src/b.rs", "fn b() {}\n");
        std::fs::remove_file(root.join("src/old.rs")).unwrap();
        ok(root, &["add", "-A"]);
        ok(root, &["commit", "-qm", "base one"]);
        write(root, "src/c.rs", "fn c() {}\n");
        ok(root, &["add", "."]);
        ok(root, &["commit", "-qm", "base two"]);
        let base = ok(root, &["rev-parse", "HEAD"]);
        ok(root, &["update-ref", "refs/remotes/origin/main", &base]);
        ok(root, &["checkout", "-q", "raccoon/736-work"]);
        assert!(!git(root, &["merge", "--no-ff", "--no-commit", &base]).status.success(), "the changelog conflicts");
        (dir, head, base)
    }

    #[test]
    fn no_merge_is_read_as_none() {
        let (dir, _, base) = half_merged();
        ok(dir.path(), &["merge", "--abort"]);
        assert_eq!(read(dir.path()).unwrap(), None);
        assert!(merge_heads(dir.path()).unwrap().is_empty());
        assert!(git(dir.path(), &["cat-file", "-e", &base]).status.success());
    }

    #[test]
    fn the_bases_files_are_told_from_conflicts_and_from_what_was_changed_while_merging() {
        let (dir, head, base) = half_merged();
        let root = dir.path();
        let merge = read(root).unwrap().unwrap();
        assert_eq!((merge.head.as_str(), merge.merge_head.as_str()), (head.as_str(), base.as_str()));
        assert_eq!(merge.names, ["origin/main", "main"]);
        assert_eq!(merge.what(), "origin/main");
        assert_eq!(merge.incoming, 2);
        assert_eq!(merge.conflicted, ["CHANGELOG.md"]);
        assert!(merge.changed_here.is_empty(), "{:?}", merge.changed_here);
        // Added and deleted by the base alike.
        assert_eq!(merge.from_base, ["src/a.rs", "src/b.rs", "src/c.rs", "src/old.rs"]);

        // The conflict resolved by hand and staged; an auto-merged file edited
        // while merging; a new file nobody committed.
        write(root, "CHANGELOG.md", "# Changes\n- base\n- branch\n");
        ok(root, &["add", "CHANGELOG.md"]);
        write(root, "src/b.rs", "fn b() { todo!() }\n");
        write(root, "notes.txt", "scratch\n");
        let merge = read(root).unwrap().unwrap();
        assert!(merge.conflicted.is_empty());
        assert_eq!(merge.changed_here, ["CHANGELOG.md", "notes.txt", "src/b.rs"]);
        assert_eq!(merge.from_base, ["src/a.rs", "src/c.rs", "src/old.rs"]);
        // Reading it changed nothing.
        assert_eq!(merge_heads(root).unwrap(), std::slice::from_ref(&base));
        assert_eq!(ok(root, &["rev-parse", "HEAD"]), head);
        assert_eq!(std::fs::read_to_string(root.join("src/b.rs")).unwrap(), "fn b() { todo!() }\n");
    }

    #[test]
    fn a_merge_no_branch_points_at_is_named_by_its_commit() {
        let (dir, _, base) = half_merged();
        ok(dir.path(), &["update-ref", "-d", "refs/remotes/origin/main"]);
        ok(dir.path(), &["update-ref", "refs/heads/main", "HEAD"]);
        let merge = read(dir.path()).unwrap().unwrap();
        assert!(merge.names.is_empty());
        assert_eq!(merge.what(), format!("commit {}", &base[..10]));
    }

    #[test]
    fn a_merge_is_committed_only_once_nothing_is_conflicted_and_only_the_one_that_was_read() {
        let (dir, head, base) = half_merged();
        let root = dir.path();
        let refused = commit(root, &head, &base).unwrap_err().to_string();
        assert!(refused.contains("1 file still has unresolved conflicts: CHANGELOG.md. Resolve it first."), "{refused}");
        write(root, "CHANGELOG.md", "# Changes\n- base\n- branch\n");
        ok(root, &["add", "CHANGELOG.md"]);
        write(root, "notes.txt", "kept\n");
        assert!(commit(root, &head, &head).unwrap_err().to_string().contains(&format!("not {}", &head[..10])));
        assert!(commit(root, &base, &base).unwrap_err().to_string().contains("HEAD moved"));
        let merged = commit(root, &head, &base).unwrap();
        assert_eq!(ok(root, &["show", "-s", "--format=%P", &merged]), format!("{head} {base}"));
        assert!(merge_heads(root).unwrap().is_empty());
        assert!(ok(root, &["status", "--porcelain"]).is_empty(), "everything listed as uncommitted went into it");
        assert!(ok(root, &["log", "-1", "--format=%s"]).starts_with("Merge commit"));
        assert!(commit(root, &merged, &base).unwrap_err().to_string().contains("No merge is in progress"));
    }

    #[test]
    fn an_abort_puts_the_checkout_back_and_git_refusing_one_that_would_lose_work_is_an_error() {
        let (dir, head, base) = half_merged();
        let root = dir.path();
        assert!(abort(root, &head, &head).is_err(), "not the merge that was read");
        assert_eq!(merge_heads(root).unwrap(), std::slice::from_ref(&base));
        abort(root, &head, &base).unwrap();
        assert!(merge_heads(root).unwrap().is_empty());
        assert_eq!(ok(root, &["rev-parse", "HEAD"]), head);
        assert!(ok(root, &["status", "--porcelain"]).is_empty());
        assert!(!root.join("src/a.rs").exists());

        // An auto-merged file edited and not staged: git will not throw the edit away.
        assert!(!git(root, &["merge", "--no-ff", "--no-commit", &base]).status.success());
        write(root, "src/a.rs", "fn a() { edited() }\n");
        assert!(abort(root, &head, &base).is_err());
        assert_eq!(merge_heads(root).unwrap(), [base]);
        assert_eq!(std::fs::read_to_string(root.join("src/a.rs")).unwrap(), "fn a() { edited() }\n");
    }

    #[test]
    fn a_linked_worktree_keeps_its_own_merge() {
        let (dir, head, base) = half_merged();
        let root = dir.path();
        ok(root, &["merge", "--abort"]);
        let holder = tempfile::tempdir().unwrap();
        let linked = holder.path().join("wt");
        ok(root, &["worktree", "add", "-q", "-b", "raccoon/737", linked.to_str().unwrap(), &head]);
        assert!(!git(&linked, &["merge", "--no-ff", "--no-commit", &base]).status.success());
        assert_eq!(merge_heads(&linked).unwrap(), std::slice::from_ref(&base));
        assert!(merge_heads(root).unwrap().is_empty(), "the main checkout is not merging");
        assert_eq!(read(&linked).unwrap().unwrap().conflicted, ["CHANGELOG.md"]);
        abort(&linked, &head, &base).unwrap();
        assert!(merge_heads(&linked).unwrap().is_empty());
    }
}
