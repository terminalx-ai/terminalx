//! Pinned turn trees and narrowly scoped restores. No shell interpolation or pathspec expansion.
use super::*;
use std::collections::BTreeSet;

pub fn reference(session: &str, turn: &str, edge: &str) -> Result<String> {
    for part in [session, turn, edge] {
        if part.is_empty() || !part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
            bail!("Invalid checkpoint identifier");
        }
    }
    Ok(format!("refs/raccoon-checkpoints/{session}/{turn}/{edge}"))
}

pub fn pin(cwd: &Path, session: &str, turn: &str, edge: &str, tree: &str) -> Result<()> {
    if !is_tree_id(tree) {
        bail!("Invalid checkpoint tree");
    }
    run(cwd, &["update-ref", &reference(session, turn, edge)?, tree])?;
    Ok(())
}

pub fn prune(cwd: &Path, session: &str) -> Result<()> {
    reference(session, "validate", "start")?;
    let prefix = format!("refs/raccoon-checkpoints/{session}/");
    for name in run(cwd, &["for-each-ref", "--format=%(refname)", &prefix])?.lines() {
        run(cwd, &["update-ref", "-d", name])?;
    }
    Ok(())
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

pub fn current(cwd: &Path, paths: &[String]) -> Result<String> {
    for path in paths {
        safe_path(cwd, path)?;
    }
    snapshot_tree_including(cwd, paths)
}

/// Roll back a failed restore when possible. Callers pin the backup trees before writing.
pub fn restore_with_backup(cwd: &Path, tree: &str, index: &str, paths: &[String], before: &str, before_index: &str) -> Result<()> {
    // Refuse invalid paths/source entries before starting (and before attempting rollback).
    for path in paths {
        safe_path(cwd, path)?;
        contains(cwd, tree, path)?;
        contains(cwd, index, path)?;
    }
    if let Err(error) = restore(cwd, tree, index, paths) {
        return match restore(cwd, before, before_index, paths) {
            Ok(()) => Err(error.context("Restore failed; the previous files and staging were restored")),
            Err(rollback) => Err(error.context(format!(
                "Restore failed and rollback failed ({rollback:#}); the previous files are retained in the backup checkpoint"
            ))),
        };
    }
    Ok(())
}

fn contains(cwd: &Path, tree: &str, path: &str) -> Result<bool> {
    if !is_tree_id(tree) {
        bail!("Invalid restore tree");
    }
    let entry = run(cwd, &["--literal-pathspecs", "ls-tree", "-z", tree, "--", path])?;
    if entry.is_empty() {
        return Ok(false);
    }
    if entry.split_whitespace().nth(1) != Some("blob") {
        bail!("Cannot restore directory or submodule {path} as a file");
    }
    Ok(true)
}

/// Restore only the named files, including binary blobs, modes, links and deletions.
/// The index is restored separately, preserving the staging state from before the turn.
/// Validate every path before the first write; never recurse into a directory or follow a link.
pub fn restore(cwd: &Path, tree: &str, index_tree: &str, paths: &[String]) -> Result<()> {
    for tree in [tree, index_tree] {
        if !is_tree_id(tree) {
            bail!("Invalid restore tree");
        }
        run(cwd, &["cat-file", "-e", &format!("{tree}^{{tree}}")])?;
    }
    let entries: Vec<_> = paths
        .iter()
        .map(|path| {
            safe_path(cwd, path)?;
            Ok((path, contains(cwd, tree, path)?, contains(cwd, index_tree, path)?))
        })
        .collect::<Result<_>>()?;
    for (path, in_tree, in_index) in entries {
        if in_tree {
            run(cwd, &["--literal-pathspecs", "restore", &format!("--source={tree}"), "--worktree", "--", path])?;
        } else {
            match std::fs::remove_file(cwd.join(path)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        if in_index {
            run(
                cwd,
                &["--literal-pathspecs", "restore", &format!("--source={index_tree}"), "--staged", "--", path],
            )?;
        } else {
            run(cwd, &["--literal-pathspecs", "rm", "--cached", "-f", "--ignore-unmatch", "--", path])?;
        }
    }
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
}
