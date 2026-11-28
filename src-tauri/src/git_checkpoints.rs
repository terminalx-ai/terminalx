//! Pinned turn trees and narrowly scoped restores. No shell interpolation or pathspec expansion.
use super::*;
use std::collections::{BTreeSet, HashMap};
use std::io::Write;
use std::process::Stdio;
#[path = "checkpoint_bytes.rs"]
pub(crate) mod bytes;
#[path = "checkpoint_retention.rs"]
mod retention;
#[cfg(test)]
pub use retention::enforce_for_test as enforce_retention;

#[cfg(test)]
thread_local! {
    static TEST_RESTORE_GIT_SPAWNS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn run_stdin(cwd: &Path, args: &[&str], input: &[u8]) -> Result<Vec<u8>> {
    #[cfg(test)]
    TEST_RESTORE_GIT_SPAWNS.with(|c| c.set(c.get() + 1));
    let mut child = git()
        .current_dir(cwd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut stdin = child.stdin.take().expect("stdin is piped");
    let (write_res, output) = std::thread::scope(|scope| {
        let writer = scope.spawn(move || stdin.write_all(input));
        let output = child.wait_with_output();
        let write_res = writer.join().unwrap_or(Ok(()));
        (write_res, output)
    });
    let output = output?;
    if !output.status.success() {
        bail!("git {}: {}", args.join(" "), String::from_utf8_lossy(&output.stderr));
    }
    write_res?;
    Ok(output.stdout)
}

pub fn reference(session: &str, turn: &str, edge: &str) -> Result<String> {
    for part in [session, turn, edge] {
        if part.is_empty() || !part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
            bail!("Invalid checkpoint identifier");
        }
    }
    Ok(format!("refs/raccoon-checkpoints/{session}/{turn}/{edge}"))
}

/// How many more turns in this checkout `turn`'s checkpoint lasts before the
/// retention limit removes it (see `retention::remaining`).
pub fn turns_left(cwd: &Path, session: &str, turn: &str) -> Result<Option<usize>> {
    let start = reference(session, turn, "start")?;
    let group = start.rsplit_once('/').map_or(start.as_str(), |(group, _)| group);
    retention::remaining(cwd, group)
}

#[cfg(test)]
pub fn pin(cwd: &Path, session: &str, turn: &str, edge: &str, tree: &str) -> Result<()> {
    pin_many(cwd, session, turn, &[(edge, tree)])
}

pub fn pin_many(cwd: &Path, session: &str, turn: &str, snapshots: &[(&str, &str)]) -> Result<()> {
    let updates = snapshots
        .iter()
        .map(|(edge, tree)| {
            if !is_tree_id(tree) {
                bail!("Invalid checkpoint tree");
            }
            Ok((reference(session, turn, edge)?, *tree))
        })
        .collect::<Result<Vec<_>>>()?;
    retention::pin(cwd, &updates)
}

/// Pin snapshots with their kept bytes, as `<edge>-bytes`, and plain trees
/// (the staging) as they are. An edge pinned again without bytes loses the old ones.
pub fn pin_exact(cwd: &Path, session: &str, turn: &str, snapshots: &[(&str, &bytes::Snapshot)], trees: &[(&str, &str)]) -> Result<()> {
    let edges: Vec<String> = snapshots.iter().map(|(edge, _)| format!("{edge}-bytes")).collect();
    let mut updates: Vec<(&str, &str)> = trees.to_vec();
    for ((edge, snapshot), kept_edge) in snapshots.iter().zip(&edges) {
        updates.push((edge, snapshot.tree.as_str()));
        match snapshot.kept_bytes() {
            Some(kept) => updates.push((kept_edge, kept)),
            None => {
                let stale = reference(session, turn, kept_edge)?;
                if run_ok(cwd, &["show-ref", "--verify", "--quiet", &stale]) {
                    run(cwd, &["update-ref", "-d", &stale])?;
                }
            }
        }
    }
    pin_many(cwd, session, turn, &updates)
}

/// The kept bytes pinned for `edge`, to read a snapshot back from its refs.
pub fn pinned_kept(cwd: &Path, session: &str, turn: &str, edge: &str) -> Option<String> {
    let name = reference(session, turn, &format!("{edge}-bytes")).ok()?;
    run(cwd, &["rev-parse", "--verify", "--quiet", &name]).ok().map(|id| id.trim().to_string())
}

pub fn exists(cwd: &Path, session: &str, turn: &str, edge: &str) -> Result<bool> {
    Ok(run_ok(cwd, &["show-ref", "--verify", "--quiet", &reference(session, turn, edge)?]))
}

fn delete_refs_with_prefix(cwd: &Path, prefix: &str) -> Result<()> {
    let listing = run(cwd, &["for-each-ref", "--format=%(refname)", prefix])?;
    let mut input = String::new();
    for name in listing.lines().filter(|line| !line.is_empty()) {
        input.push_str("delete ");
        input.push_str(name);
        input.push('\n');
    }
    if !input.is_empty() {
        run_stdin(cwd, &["update-ref", "--stdin"], input.as_bytes())?;
    }
    Ok(())
}

pub fn prune_turn(cwd: &Path, session: &str, turn: &str) -> Result<()> {
    let prefix = reference(session, turn, "start")?.trim_end_matches("start").to_string();
    delete_refs_with_prefix(cwd, &prefix)
}

pub fn prune(cwd: &Path, session: &str) -> Result<()> {
    reference(session, "validate", "start")?;
    let prefix = format!("refs/raccoon-checkpoints/{session}/");
    delete_refs_with_prefix(cwd, &prefix)
}

pub fn paths(cwd: &Path, base: &str, head: &str) -> Result<Vec<String>> {
    let files = changes_between(cwd, base, Some(head))?;
    Ok(files
        .into_iter()
        .flat_map(|f| std::iter::once(f.path).chain(f.old_path))
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

/// The files that differ between two snapshots, line endings included.
pub fn exact_paths(cwd: &Path, a: &bytes::Snapshot, b: &bytes::Snapshot) -> Result<Vec<String>> {
    let mut all: BTreeSet<String> = paths(cwd, &a.tree, &b.tree)?.into_iter().collect();
    all.extend(bytes::changed_paths(cwd, a, b)?);
    Ok(all.into_iter().collect())
}

fn safe_path(cwd: &Path, path: &str) -> Result<()> {
    let relative = Path::new(path);
    if path.is_empty()
        || relative.components().any(|c| !matches!(c, std::path::Component::Normal(_)))
        || relative.components().any(|c| c.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))
    {
        bail!("Invalid repository file path");
    }
    let mut parent = cwd.to_path_buf();
    let parts: Vec<_> = relative.components().collect();
    for part in &parts[..parts.len() - 1] {
        parent.push(part);
        match std::fs::symlink_metadata(&parent) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => bail!("Cannot restore through {}", parent.display()),
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
    }
    match std::fs::symlink_metadata(cwd.join(relative)) {
        Ok(meta) if meta.is_dir() => bail!("Cannot replace directory {path}; move its contents first"),
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    Ok(())
}

pub fn current(cwd: &Path, paths: &[String]) -> Result<bytes::Snapshot> {
    for path in paths {
        safe_path(cwd, path)?;
    }
    snapshot_tree_including(cwd, paths)
}

/// Roll back a failed restore when possible. Callers pin the backup trees before writing.
pub fn restore_with_backup(cwd: &Path, target: &bytes::Snapshot, index: &str, paths: &[String], before: &bytes::Snapshot, before_index: &str) -> Result<()> {
    // Refuse invalid paths/source entries before starting (and before attempting rollback).
    validate_trees(cwd, target.tree.as_str(), index)?;
    for path in paths {
        safe_path(cwd, path)?;
    }
    let target_blobs = tree_blobs(cwd, &target.tree, paths)?;
    let index_blobs = tree_blobs(cwd, index, paths)?;
    if let Err(error) = restore_exact_prepared(cwd, target, index, paths, &target_blobs, &index_blobs) {
        return match restore_exact(cwd, before, before_index, paths) {
            Ok(()) => Err(error.context("Restore failed; the previous files and staging were restored")),
            Err(rollback) => Err(error.context(format!(
                "Restore failed and rollback failed ({rollback:#}); the previous files are retained in the backup checkpoint"
            ))),
        };
    }
    Ok(())
}

fn validate_trees(cwd: &Path, tree: &str, index_tree: &str) -> Result<()> {
    for candidate in [tree, index_tree] {
        if !is_tree_id(candidate) {
            bail!("Invalid restore tree");
        }
        #[cfg(test)]
        TEST_RESTORE_GIT_SPAWNS.with(|c| c.set(c.get() + 1));
        run(cwd, &["cat-file", "-e", &format!("{candidate}^{{tree}}")])?;
    }
    Ok(())
}

/// Inspect all `paths` in `tree` in batched `git ls-tree` calls, returning
/// `(mode, oid)` for every present blob and rejecting any directory/submodule.
fn tree_blobs(cwd: &Path, tree: &str, paths: &[String]) -> Result<HashMap<String, (String, String)>> {
    if !is_tree_id(tree) {
        bail!("Invalid restore tree");
    }
    let mut blobs = HashMap::new();
    if paths.is_empty() {
        return Ok(blobs);
    }
    const CHUNK: usize = 256;
    for chunk in paths.chunks(CHUNK) {
        #[cfg(test)]
        TEST_RESTORE_GIT_SPAWNS.with(|c| c.set(c.get() + 1));
        let mut args: Vec<&str> = Vec::with_capacity(chunk.len() + 5);
        args.extend(["--literal-pathspecs", "ls-tree", "-z", tree, "--"]);
        args.extend(chunk.iter().map(String::as_str));
        let listing = run(cwd, &args)?;
        for entry in listing.split('\0').filter(|e| !e.is_empty()) {
            let Some((meta, path)) = entry.split_once('\t') else { continue };
            let mut parts = meta.split_whitespace();
            let (Some(mode), Some(kind), Some(oid)) = (parts.next(), parts.next(), parts.next()) else {
                continue;
            };
            if kind != "blob" {
                bail!("Cannot restore directory or submodule {path} as a file");
            }
            blobs.insert(path.to_owned(), (mode.to_owned(), oid.to_owned()));
        }
    }
    Ok(blobs)
}

/// Restore only the named files, including binary blobs, modes, links and deletions.
/// The index is restored separately, preserving the staging state from before the turn.
/// Validate every path before the first write; never recurse into a directory or follow a link.
#[cfg(test)]
pub fn restore(cwd: &Path, tree: &str, index_tree: &str, paths: &[String]) -> Result<()> {
    restore_exact(cwd, &bytes::Snapshot::new(tree, None), index_tree, paths)
}

/// [`restore`] of a snapshot, each file with its exact bytes.
pub fn restore_exact(cwd: &Path, snapshot: &bytes::Snapshot, index_tree: &str, paths: &[String]) -> Result<()> {
    validate_trees(cwd, snapshot.tree.as_str(), index_tree)?;
    for path in paths {
        safe_path(cwd, path)?;
    }
    let target_blobs = tree_blobs(cwd, snapshot.tree.as_str(), paths)?;
    let index_blobs = tree_blobs(cwd, index_tree, paths)?;
    restore_exact_prepared(cwd, snapshot, index_tree, paths, &target_blobs, &index_blobs)
}

fn restore_exact_prepared(
    cwd: &Path,
    snapshot: &bytes::Snapshot,
    index_tree: &str,
    paths: &[String],
    target_blobs: &HashMap<String, (String, String)>,
    index_blobs: &HashMap<String, (String, String)>,
) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let tree = snapshot.tree.as_str();
    let mut worktree_restore: Vec<&str> = Vec::new();
    for path in paths {
        if target_blobs.contains_key(path.as_str()) {
            worktree_restore.push(path.as_str());
        } else {
            match std::fs::remove_file(cwd.join(path)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    // Batch all worktree file checkouts in one git invocation using NUL-delimited literal pathspecs.
    if !worktree_restore.is_empty() {
        let mut pathspec_input = Vec::new();
        for path in &worktree_restore {
            pathspec_input.extend_from_slice(path.as_bytes());
            pathspec_input.push(0);
        }
        let source_arg = format!("--source={tree}");
        run_stdin(
            cwd,
            &["--literal-pathspecs", "restore", &source_arg, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"],
            &pathspec_input,
        )?;
        if snapshot.kept.is_some() {
            for path in &worktree_restore {
                bytes::put_back(cwd, snapshot, path)?;
            }
        }
    }
    // Batch all staged additions, updates, and removals in one `git update-index -z --index-info`.
    let zero_oid = "0".repeat(index_tree.len());
    let mut index_input = Vec::new();
    for path in paths {
        if let Some((mode, oid)) = index_blobs.get(path.as_str()) {
            index_input.extend_from_slice(mode.as_bytes());
            index_input.push(b' ');
            index_input.extend_from_slice(oid.as_bytes());
            index_input.push(b'\t');
            index_input.extend_from_slice(path.as_bytes());
            index_input.push(0);
        } else {
            index_input.extend_from_slice(b"0 ");
            index_input.extend_from_slice(zero_oid.as_bytes());
            index_input.push(b'\t');
            index_input.extend_from_slice(path.as_bytes());
            index_input.push(0);
        }
    }
    run_stdin(cwd, &["update-index", "-z", "--index-info"], &index_input)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refs_survive_gc_and_restore_files_and_original_staging() {
        let _home = crate::store::temp_home();
        let repo = super::super::tests::repo();
        let p = repo.path();
        std::fs::write(p.join("a.txt"), "staged\n").unwrap();
        run(p, &["add", "a.txt"]).unwrap();
        let index = run(p, &["write-tree"]).unwrap().trim().to_string();
        std::fs::write(p.join("a.txt"), b"before\0binary").unwrap();
        std::fs::write(p.join("[literal].txt"), "before").unwrap();
        let start = snapshot_tree(p).unwrap();
        pin(p, "session", "tab-1", "start", &start).unwrap();
        pin(p, "session", "tab-1", "index", &index).unwrap();
        std::fs::remove_file(p.join("a.txt")).unwrap();
        std::fs::rename(p.join("[literal].txt"), p.join("renamed.txt")).unwrap();
        std::fs::write(p.join("new.txt"), "new").unwrap();
        let end = snapshot_tree(p).unwrap();
        pin(p, "session", "tab-1", "end", &end).unwrap();
        run(p, &["gc", "--prune=now"]).unwrap();
        std::fs::write(p.join("unrelated.txt"), "keep").unwrap();
        restore(p, &start, &index, &paths(p, &start, &end).unwrap()).unwrap();
        assert_eq!(std::fs::read(p.join("a.txt")).unwrap(), b"before\0binary");
        assert_eq!(run(p, &["show", ":a.txt"]).unwrap(), "staged\n");
        assert!(p.join("[literal].txt").exists());
        assert!(!p.join("renamed.txt").exists());
        assert!(!p.join("new.txt").exists());
        assert!(p.join("unrelated.txt").exists());
        prune(p, "session").unwrap();
        assert!(run(p, &["for-each-ref", "refs/raccoon-checkpoints"]).unwrap().is_empty());
    }

    #[test]
    fn refuses_traversal_and_symlink_parents_before_changing_any_file() {
        let _home = crate::store::temp_home();
        let repo = super::super::tests::repo();
        let p = repo.path();
        let tree = snapshot_tree(p).unwrap();
        std::fs::write(p.join("a.txt"), "keep").unwrap();
        for path in ["../outside", "/tmp/outside", ".git/config"] {
            assert!(restore(p, &tree, &tree, &["a.txt".into(), path.into()]).is_err());
            assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "keep");
        }
        #[cfg(unix)]
        {
            std::fs::write(p.join(":(glob)*"), "literal").unwrap();
            restore(p, &tree, &tree, &[":(glob)*".into()]).unwrap();
            assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "keep");
            assert!(!p.join(":(glob)*").exists());
            let outside = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(outside.path(), p.join("link")).unwrap();
            assert!(restore(p, &tree, &tree, &["a.txt".into(), "link/file".into()]).is_err());
            assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "keep");
        }
    }
    #[cfg(unix)]
    #[test]
    fn restore_keeps_executable_modes_and_symlinks_without_touching_their_targets() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let _home = crate::store::temp_home();
        let repo = super::super::tests::repo();
        let p = repo.path();
        std::fs::write(p.join("run.sh"), "#!/bin/sh\necho before\n").unwrap();
        std::fs::set_permissions(p.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        symlink("a.txt", p.join("link")).unwrap();
        let start = snapshot_tree(p).unwrap();
        let index = run(p, &["write-tree"]).unwrap().trim().to_string();
        std::fs::set_permissions(p.join("run.sh"), std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::remove_file(p.join("link")).unwrap();
        std::fs::write(p.join("link"), "a regular file now").unwrap();
        let end = snapshot_tree(p).unwrap();
        restore(p, &start, &index, &paths(p, &start, &end).unwrap()).unwrap();
        assert_ne!(std::fs::metadata(p.join("run.sh")).unwrap().permissions().mode() & 0o111, 0);
        assert_eq!(std::fs::read_link(p.join("link")).unwrap(), Path::new("a.txt"));
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "hello\n");
    }

    #[test]
    fn batched_restore_uses_constant_git_spawns_for_many_files() {
        let _home = crate::store::temp_home();
        let repo = super::super::tests::repo();
        let p = repo.path();
        for i in 0..25 {
            std::fs::write(p.join(format!("f{i:02}.txt")), format!("before-{i}\n")).unwrap();
        }
        run(p, &["add", "f00.txt", "f01.txt"]).unwrap();
        let index = run(p, &["write-tree"]).unwrap().trim().to_string();
        let start = snapshot_tree(p).unwrap();

        // Modify all 25 files, add 5 extra files, and stage changes.
        for i in 0..25 {
            std::fs::write(p.join(format!("f{i:02}.txt")), format!("after-{i}\n")).unwrap();
        }
        for i in 0..5 {
            std::fs::write(p.join(format!("extra{i}.txt")), "extra\n").unwrap();
        }
        run(p, &["add", "f02.txt", "extra0.txt"]).unwrap();
        let end = snapshot_tree(p).unwrap();
        let changed = paths(p, &start, &end).unwrap();
        assert_eq!(changed.len(), 30);

        TEST_RESTORE_GIT_SPAWNS.with(|c| c.set(0));
        restore(p, &start, &index, &changed).unwrap();
        let spawns = TEST_RESTORE_GIT_SPAWNS.with(|c| c.get());
        assert!(spawns <= 6, "batched restore for 30 files should take O(1) git spawns, got {spawns}");

        for i in 0..25 {
            assert_eq!(std::fs::read_to_string(p.join(format!("f{i:02}.txt"))).unwrap(), format!("before-{i}\n"));
        }
        for i in 0..5 {
            assert!(!p.join(format!("extra{i}.txt")).exists());
        }
        assert_eq!(run(p, &["show", ":f00.txt"]).unwrap(), "before-0\n");
        assert!(run(p, &["show", ":extra0.txt"]).is_err());
    }
}
