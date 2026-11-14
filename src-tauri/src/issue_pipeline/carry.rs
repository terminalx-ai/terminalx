//! Whether a passing verdict carries over the commits made after it (#947).
//!
//! A pull request whose last allowed review passed often has to merge its
//! base branch before it can merge: GitHub reports it behind, or in
//! conflict. That merge moves the head, and a verdict is about one commit.
//! Reviewing the merge in full would spend a round on code the reviewer has
//! already read, and at the round limit it stopped the pipeline for nothing.
//!
//! So the commits between the reviewed one and the new head are read here.
//! A verdict carries forward only over merges of the base branch:
//!
//! - the reviewed commit is on the head's first-parent line, and every
//!   commit on that line after it is a two-parent merge whose other parent
//!   is on the base branch as GitHub has it now. Any commit of its own, an
//!   octopus, or a merge of anything else needs a review as before;
//! - what those merges did beyond merging is read with
//!   `git show --remerge-diff`: the difference between the merge Git would
//!   make by itself and the one recorded. A clean merge has none. Conflict
//!   resolutions and edits made while merging are exactly that difference;
//! - the pull request's change set relative to its base (`base...commit`,
//!   the three-dot diff GitHub shows) is compared before and after, hunk
//!   positions left out: the base moving code above a change shifts its line
//!   numbers and nothing else. Trees are not compared, since merging the
//!   base changes them by design.
//!
//! Merges with no resolution and an unchanged change set carry the verdict
//! as it is. Anything else that only merges the base gets the light check of
//! just what the merges changed, which does not use up a review round.
//!
//! The author's conversation works in this same checkout, so nothing here
//! takes the history from anything it could rewrite. Commits are named by
//! their hash: the head is the pull request's, the base was fetched by its
//! hash, and a parent is part of the commit it belongs to. Only replacement
//! refs (`git replace`), a grafts file and a shallow clone can make Git show
//! other parents than those, so every command runs with replacements off,
//! and a checkout with grafts or a shallow history carries nothing. The diff
//! options the checkout's config could use to hide a change (submodules,
//! `diff.relative`, external diff and textconv drivers) are pinned on the
//! command line, which config does not override.

use std::path::Path;

use anyhow::{Context, Result};

use crate::git;

/// Longest resolution quoted to the reviewer; past it, the prompt names the
/// command that shows it instead.
pub const QUOTE_LIMIT: usize = 40_000;

/// What happened between the reviewed commit and the head.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Carry {
    /// Something other than merges of the base: a review of its own is due.
    /// The words say what, for the record.
    NewWork(String),
    /// Only merges of the base branch.
    BaseMerges(BaseMerges),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseMerges {
    /// The base branch's commit the comparison was made against.
    pub base_commit: String,
    /// The merge commits, oldest first.
    pub merges: Vec<String>,
    /// `git show --remerge-diff` of each merge that resolved anything, in
    /// order, each headed by its commit. Empty when every merge was clean.
    pub resolution: String,
    /// The pull request's change against its base is not what it was at the
    /// reviewed commit (hunk positions aside).
    pub change_set_moved: bool,
}

impl BaseMerges {
    /// Nothing to look at: the verdict carries as it is.
    pub fn clean(&self) -> bool {
        self.resolution.is_empty() && !self.change_set_moved
    }
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(10)]
}

/// `git` with replacement refs ignored: the history as the commits record it.
fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    let mut all = vec!["--no-replace-objects"];
    all.extend_from_slice(args);
    git::run(cwd, &all)
}

/// Why this checkout's history cannot be read as the commits record it, if
/// it cannot: a grafts file or a shallow clone rewrites parents.
fn rewritten_history(cwd: &Path) -> Result<Option<String>> {
    let grafts = run(cwd, &["rev-parse", "--path-format=absolute", "--git-path", "info/grafts"])?;
    if Path::new(grafts.trim()).exists() {
        return Ok(Some("this checkout has a grafts file, which changes commits' parents".into()));
    }
    if run(cwd, &["rev-parse", "--is-shallow-repository"])?.trim() == "true" {
        return Ok(Some("this checkout is a shallow clone, so its history is cut short".into()));
    }
    Ok(None)
}

fn full(cwd: &Path, rev: &str) -> Result<String> {
    Ok(run(cwd, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{commit}}")]).with_context(|| format!("{} is not a commit in this checkout", short(rev)))?.trim().to_string())
}

fn is_ancestor(cwd: &Path, ancestor: &str, of: &str) -> Result<bool> {
    let output = git::inspect_output(cwd, &["--no-replace-objects", "merge-base", "--is-ancestor", ancestor, of])?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => anyhow::bail!("git merge-base --is-ancestor failed: {}", String::from_utf8_lossy(&output.stderr).trim()),
    }
}

/// The pull request's change at `commit` relative to `base`, as the
/// three-dot diff has it, with nothing that depends on where in a file a
/// hunk lands: no context lines (`-U0`), no hunk headers, no blob ids.
/// Every option that could make two runs print the same change differently
/// is pinned.
fn change_set(cwd: &Path, base: &str, commit: &str) -> Result<String> {
    let range = format!("{base}...{commit}");
    let patch = run(cwd, &["-c", "core.quotepath=off", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-relative", "--ignore-submodules=none", "--binary", "--src-prefix=a/", "--dst-prefix=b/", &range, "--"])?;
    Ok(patch.lines().filter(|line| !line.starts_with("@@") && !line.starts_with("index ")).collect::<Vec<_>>().join("\n"))
}

/// What the merges between `reviewed` and `head` are, against the base
/// branch at `base_commit`. Reads objects only: nothing is written to the
/// checkout, its index or its refs.
pub fn classify(cwd: &Path, base_commit: &str, reviewed: &str, head: &str) -> Result<Carry> {
    if let Some(why) = rewritten_history(cwd)? {
        return Ok(Carry::NewWork(why));
    }
    let base_commit = full(cwd, base_commit)?;
    let reviewed = full(cwd, reviewed)?;
    let head = full(cwd, head)?;
    if reviewed == head {
        return Ok(Carry::NewWork("the head is the reviewed commit".into()));
    }
    if !is_ancestor(cwd, &reviewed, &head)? {
        return Ok(Carry::NewWork(format!("{} is not in the history of {} any more", short(&reviewed), short(&head))));
    }
    // Newest first, each with its parents: the line from the head back to
    // the reviewed commit, following first parents only.
    let line = run(cwd, &["rev-list", "--first-parent", "--parents", &format!("{reviewed}..{head}")])?;
    let mut merges = Vec::new();
    let mut expected = head.clone();
    for entry in line.lines() {
        let mut ids = entry.split_whitespace();
        let Some(commit) = ids.next() else { continue };
        let parents: Vec<&str> = ids.collect();
        if commit != expected {
            return Ok(Carry::NewWork(format!("the history from {} does not lead back to {} through its first parents", short(&head), short(&reviewed))));
        }
        match parents.as_slice() {
            [first, other] => {
                if !is_ancestor(cwd, other, &base_commit)? {
                    return Ok(Carry::NewWork(format!("{} merges {}, which is not on the base branch", short(commit), short(other))));
                }
                merges.push(commit.to_string());
                expected = first.to_string();
            }
            [_] | [] => return Ok(Carry::NewWork(format!("{} is a commit of its own, not a merge of the base branch", short(commit)))),
            _ => return Ok(Carry::NewWork(format!("{} merges more than one branch at once", short(commit)))),
        }
    }
    if expected != reviewed || merges.is_empty() {
        return Ok(Carry::NewWork(format!("the history from {} does not lead back to {} through its first parents", short(&head), short(&reviewed))));
    }
    merges.reverse();

    // What each merge recorded beyond the merge Git makes by itself. The
    // remerge is made in a temporary object store Git removes afterwards.
    let mut resolution = String::new();
    for merge in &merges {
        let shown = run(cwd, &["-c", "core.quotepath=off", "show", "--remerge-diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--ignore-submodules=none", "--src-prefix=a/", "--dst-prefix=b/", "--format=", merge, "--"])?;
        let shown = shown.trim_matches('\n');
        if !shown.is_empty() {
            resolution.push_str(&format!("Merge {merge}:\n{shown}\n"));
        }
    }
    let change_set_moved = change_set(cwd, &base_commit, &reviewed)? != change_set(cwd, &base_commit, &head)?;
    Ok(Carry::BaseMerges(BaseMerges { base_commit, merges, resolution, change_set_moved }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    struct Repo(tempfile::TempDir);

    impl Repo {
        fn new() -> Self {
            let repo = Self(tempfile::tempdir().unwrap());
            repo.git(&["init", "-q", "-b", "main"]);
            repo.git(&["config", "user.name", "Test"]);
            repo.git(&["config", "user.email", "test@example.invalid"]);
            repo.git(&["config", "commit.gpgsign", "false"]);
            repo
        }

        fn path(&self) -> &Path {
            self.0.path()
        }

        fn git(&self, args: &[&str]) -> String {
            let output = Command::new("git").current_dir(self.path()).args(args).output().unwrap();
            assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8(output.stdout).unwrap().trim().to_string()
        }

        /// `git merge` that may stop on a conflict: its success.
        fn try_git(&self, args: &[&str]) -> bool {
            Command::new("git").current_dir(self.path()).args(args).output().unwrap().status.success()
        }

        fn write(&self, file: &str, text: &str) {
            std::fs::write(self.path().join(file), text).unwrap();
        }

        fn commit(&self, file: &str, text: &str, message: &str) -> String {
            self.write(file, text);
            self.git(&["add", file]);
            self.git(&["commit", "-q", "-m", message]);
            self.git(&["rev-parse", "HEAD"])
        }

        fn head(&self) -> String {
            self.git(&["rev-parse", "HEAD"])
        }
    }

    /// Twenty numbered lines, `edit` applied: a file the base and the branch
    /// change in different places.
    fn lines(edit: impl Fn(usize) -> Option<String>) -> String {
        (1..=20).map(|n| edit(n).unwrap_or_else(|| format!("line {n}"))).collect::<Vec<_>>().join("\n") + "\n"
    }

    /// main with a shared file, a branch that changed line 15 of it and
    /// added a file of its own, reviewed at its tip.
    fn branch_reviewed(repo: &Repo) -> String {
        repo.commit("shared.txt", &lines(|_| None), "base");
        repo.commit("package.json", "{\n  \"version\": \"1.0.0\"\n}\n", "package");
        repo.git(&["checkout", "-q", "-b", "feature"]);
        repo.commit("shared.txt", &lines(|n| (n == 15).then(|| "line 15, padded".into())), "pad line 15");
        repo.commit("feature.txt", "feature\n", "feature file")
    }

    fn base_merges(carry: Carry) -> BaseMerges {
        match carry {
            Carry::BaseMerges(merges) => merges,
            other => panic!("expected only base merges, got {other:?}"),
        }
    }

    #[test]
    fn a_clean_merge_of_the_base_carries_the_verdict_even_when_line_numbers_shift() {
        let repo = Repo::new();
        let reviewed = branch_reviewed(&repo);
        // The base moves on: two lines at the top of the shared file, which
        // shifts the branch's hunk, and a file of its own.
        repo.git(&["checkout", "-q", "main"]);
        repo.commit("shared.txt", &format!("header a\nheader b\n{}", lines(|_| None)), "headers");
        let base = repo.commit("other.txt", "other\n", "other");
        repo.git(&["checkout", "-q", "feature"]);
        repo.git(&["merge", "-q", "--no-edit", "main"]);
        let head = repo.head();

        let merges = base_merges(classify(repo.path(), &base, &reviewed, &head).unwrap());
        assert_eq!(merges.merges, std::slice::from_ref(&head));
        assert_eq!(merges.base_commit, base);
        assert!(merges.resolution.is_empty(), "{}", merges.resolution);
        assert!(!merges.change_set_moved, "the same change, only further down the file");
        assert!(merges.clean());

        // Main moves again and is merged again: two merges, both clean.
        repo.git(&["checkout", "-q", "main"]);
        let base = repo.commit("more.txt", "more\n", "more");
        repo.git(&["checkout", "-q", "feature"]);
        repo.git(&["merge", "-q", "--no-edit", "main"]);
        let second = repo.head();
        let merges = base_merges(classify(repo.path(), &base, &reviewed, &second).unwrap());
        assert_eq!(merges.merges, [head, second]);
        assert!(merges.clean());
    }

    #[test]
    fn a_merge_that_resolved_a_conflict_is_not_clean_and_shows_only_the_resolution() {
        let repo = Repo::new();
        let reviewed = branch_reviewed(&repo);
        // Both sides bump the version: the conflict a merge of main resolves.
        repo.git(&["checkout", "-q", "feature"]);
        let reviewed_bump = repo.commit("package.json", "{\n  \"version\": \"1.1.0\"\n}\n", "bump on the branch");
        repo.git(&["checkout", "-q", "main"]);
        let base = repo.commit("package.json", "{\n  \"version\": \"1.0.1\"\n}\n", "bump on main");
        repo.git(&["checkout", "-q", "feature"]);
        assert!(!repo.try_git(&["merge", "-q", "--no-edit", "main"]), "the versions conflict");
        repo.write("package.json", "{\n  \"version\": \"1.1.1\"\n}\n");
        repo.git(&["add", "package.json"]);
        repo.git(&["commit", "-q", "--no-edit"]);
        let head = repo.head();
        assert_ne!(reviewed, reviewed_bump);

        let merges = base_merges(classify(repo.path(), &base, &reviewed_bump, &head).unwrap());
        assert_eq!(merges.merges, std::slice::from_ref(&head));
        assert!(!merges.clean());
        assert!(merges.resolution.starts_with(&format!("Merge {head}:\n")), "{}", merges.resolution);
        assert!(merges.resolution.contains("package.json") && merges.resolution.contains("+  \"version\": \"1.1.1\""), "{}", merges.resolution);
        assert!(!merges.resolution.contains("shared.txt") && !merges.resolution.contains("feature.txt"), "only the resolved file: {}", merges.resolution);
        assert!(merges.change_set_moved, "the branch now changes 1.0.1 to 1.1.1, not 1.0.0 to 1.1.0");
    }

    #[test]
    fn a_commit_of_its_own_after_the_review_needs_a_review() {
        let repo = Repo::new();
        let reviewed = branch_reviewed(&repo);
        repo.git(&["checkout", "-q", "main"]);
        let base = repo.commit("other.txt", "other\n", "other");
        repo.git(&["checkout", "-q", "feature"]);
        repo.git(&["merge", "-q", "--no-edit", "main"]);
        let head = repo.commit("feature.txt", "feature, changed\n", "a real change");
        assert!(matches!(classify(repo.path(), &base, &reviewed, &head).unwrap(), Carry::NewWork(why) if why.contains("commit of its own")));

        // Hidden behind a later merge of main, it is still found.
        repo.git(&["checkout", "-q", "main"]);
        let base = repo.commit("more.txt", "more\n", "more");
        repo.git(&["checkout", "-q", "feature"]);
        repo.git(&["merge", "-q", "--no-edit", "main"]);
        assert!(matches!(classify(repo.path(), &base, &reviewed, &repo.head()).unwrap(), Carry::NewWork(_)));
    }

    #[test]
    fn a_merge_of_something_other_than_the_base_or_a_rewritten_history_needs_a_review() {
        let repo = Repo::new();
        let reviewed = branch_reviewed(&repo);
        let base = repo.git(&["rev-parse", "main"]);
        // A side branch that is not the base, merged in.
        repo.git(&["checkout", "-q", "-b", "side", "main"]);
        repo.commit("side.txt", "side\n", "side");
        repo.git(&["checkout", "-q", "feature"]);
        repo.git(&["merge", "-q", "--no-edit", "side"]);
        assert!(matches!(classify(repo.path(), &base, &reviewed, &repo.head()).unwrap(), Carry::NewWork(why) if why.contains("not on the base branch")));

        // An amended tip: the reviewed commit is not in the history any more.
        repo.git(&["reset", "-q", "--hard", &reviewed]);
        repo.write("feature.txt", "feature, amended\n");
        repo.git(&["commit", "-q", "-a", "--amend", "--no-edit"]);
        assert!(matches!(classify(repo.path(), &base, &reviewed, &repo.head()).unwrap(), Carry::NewWork(why) if why.contains("not in the history")));
    }

    #[test]
    fn edits_made_while_merging_cleanly_count_as_a_resolution() {
        let repo = Repo::new();
        let reviewed = branch_reviewed(&repo);
        repo.git(&["checkout", "-q", "main"]);
        let base = repo.commit("other.txt", "other\n", "other");
        repo.git(&["checkout", "-q", "feature"]);
        repo.git(&["merge", "-q", "--no-commit", "--no-ff", "main"]);
        // Slipped into the merge commit: no conflict asked for it.
        repo.write("feature.txt", "feature, slipped in\n");
        repo.git(&["add", "feature.txt"]);
        repo.git(&["commit", "-q", "--no-edit"]);
        let merges = base_merges(classify(repo.path(), &base, &reviewed, &repo.head()).unwrap());
        assert!(!merges.clean());
        assert!(merges.resolution.contains("+feature, slipped in"), "{}", merges.resolution);
        assert!(merges.change_set_moved);
    }

    #[test]
    fn a_commit_dressed_up_as_a_merge_of_the_base_is_still_a_commit_of_its_own() {
        let repo = Repo::new();
        let reviewed = branch_reviewed(&repo);
        repo.git(&["checkout", "-q", "main"]);
        let base = repo.commit("other.txt", "other\n", "other");
        repo.git(&["checkout", "-q", "feature"]);
        let head = repo.commit("feature.txt", "feature, changed\n", "a real change");
        // The checkout is told the commit merges main, with its own change as
        // the merge's result: as a clean merge it would carry the verdict.
        repo.git(&["replace", "--graft", &head, &reviewed, &base]);
        assert_eq!(repo.git(&["rev-list", "--parents", "-1", &head]).split_whitespace().count(), 3, "git believes the replacement");
        assert!(matches!(classify(repo.path(), &base, &reviewed, &head).unwrap(), Carry::NewWork(why) if why.contains("commit of its own")));

        // A grafts file says the same, and a checkout with one carries nothing.
        repo.git(&["replace", "-d", &head]);
        let grafts = repo.path().join(".git/info/grafts");
        std::fs::create_dir_all(grafts.parent().unwrap()).unwrap();
        std::fs::write(&grafts, format!("{head} {reviewed} {base}\n")).unwrap();
        assert!(matches!(classify(repo.path(), &base, &reviewed, &head).unwrap(), Carry::NewWork(why) if why.contains("grafts")));
    }

    #[test]
    fn nothing_is_written_while_classifying() {
        let repo = Repo::new();
        let reviewed = branch_reviewed(&repo);
        repo.git(&["checkout", "-q", "main"]);
        let base = repo.commit("package.json", "{\n  \"version\": \"1.0.1\"\n}\n", "bump on main");
        repo.git(&["checkout", "-q", "feature"]);
        repo.git(&["merge", "-q", "--no-edit", "main"]);
        let objects = || repo.git(&["count-objects", "-v"]);
        let (before, status) = (objects(), repo.git(&["status", "--porcelain"]));
        classify(repo.path(), &base, &reviewed, &repo.head()).unwrap();
        assert_eq!((objects(), repo.git(&["status", "--porcelain"])), (before, status));
    }
}
