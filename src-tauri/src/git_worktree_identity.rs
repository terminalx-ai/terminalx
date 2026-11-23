//! Evidence recorded while a session's linked checkout is still live.

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub(crate) struct WorktreeIdentity {
    repository: DirectoryIdentity,
    registration: DirectoryIdentity,
    checkout: DirectoryIdentity,
    registration_name: String,
}

#[derive(Deserialize, PartialEq, Serialize)]
struct DirectoryIdentity {
    device: u64,
    inode: u64,
    created: std::time::SystemTime,
}

#[cfg(unix)]
fn directory_identity(path: &Path) -> Option<DirectoryIdentity> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_dir() {
        return None;
    }
    Some(DirectoryIdentity {
        device: meta.dev(),
        inode: meta.ino(),
        created: meta.created().ok()?,
    })
}

#[cfg(not(unix))]
fn directory_identity(_: &Path) -> Option<DirectoryIdentity> {
    None
}

fn git_dir(root: &Path) -> Option<PathBuf> {
    let out = super::run(root, &["rev-parse", "--absolute-git-dir"]).ok()?;
    crate::paths::canonicalize(out.strip_suffix('\n')?).ok()
}

impl WorktreeIdentity {
    pub(crate) fn capture(project: &Path, root: &Path) -> Option<Self> {
        let root = crate::paths::canonicalize(root).ok()?;
        if !super::is_worktree_of(project, &root) {
            return None;
        }
        let common = super::common_dir(project)?;
        let admin = git_dir(&root)?;
        if admin.parent()? != common.join("worktrees") {
            return None;
        }
        Some(Self {
            repository: directory_identity(&common)?,
            registration: directory_identity(&admin)?,
            checkout: directory_identity(&root)?,
            registration_name: admin.file_name()?.to_str()?.to_owned(),
        })
    }

    /// Verify the recorded registration and return the cwd relative to its
    /// checkout. The directory walk refuses aliases, non-directories and Git
    /// boundaries within the checkout, including dangling links.
    pub(crate) fn missing_cwd(
        &self,
        common: &Path,
        root: &Path,
        cwd: &Path,
        branch: &str,
    ) -> Option<PathBuf> {
        if directory_identity(common)? != self.repository {
            return None;
        }
        let mut parts = Path::new(&self.registration_name).components();
        if !matches!(parts.next(), Some(Component::Normal(_))) || parts.next().is_some() {
            return None;
        }
        let admin = registrations(common)?.join(&self.registration_name);
        if directory_identity(&admin)? != self.registration || !matches_registration(&admin, root, branch) {
            return None;
        }
        missing_relative_cwd(root, cwd, &admin, |identity| *identity == self.checkout)
    }
}

fn registrations(common: &Path) -> Option<PathBuf> {
    let path = common.join("worktrees");
    (crate::paths::canonicalize(&path).ok()? == path).then_some(path)
}

// Git can store either absolute paths or paths relative to the directory
// containing the link. Accept Git's leading ".." components, but refuse
// interior parent traversals that might resolve differently through symlinks.
fn registration_link_matches(base: &Path, value: &str, expected: &Path) -> bool {
    let path = Path::new(value);
    if path.is_absolute() {
        return path == expected;
    }
    let mut base = base;
    let mut tail = path.components();
    while let Some(Component::ParentDir) = tail.clone().next() {
        let Some(parent) = base.parent() else { return false };
        base = parent;
        tail.next();
    }
    tail.clone().all(|part| matches!(part, Component::Normal(_)))
        && base.join(tail.as_path()) == expected
}

fn matches_registration(admin: &Path, root: &Path, branch: &str) -> bool {
    record_value(&admin.join("gitdir")).is_some_and(|path| registration_link_matches(admin, &path, &root.join(".git")))
        && record_value(&admin.join("HEAD")).as_deref() == Some(&format!("ref: refs/heads/{branch}"))
        && record_value(&admin.join("commondir")).as_deref() == Some("../..")
}

#[cfg(unix)]
fn metadata_changed_at(meta: &std::fs::Metadata) -> Option<std::time::SystemTime> {
    use std::{os::unix::fs::MetadataExt, time::{Duration, UNIX_EPOCH}};
    UNIX_EPOCH.checked_add(Duration::new(meta.ctime().try_into().ok()?, meta.ctime_nsec().try_into().ok()?))
}

#[cfg(not(unix))]
fn metadata_changed_at(_: &std::fs::Metadata) -> Option<std::time::SystemTime> {
    None
}

fn recorded_before(path: &Path, observed: std::time::SystemTime) -> Option<bool> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    Some(meta.is_file() && metadata_changed_at(&meta)? < observed && meta.modified().ok()? < observed)
}

/// Without a pinned ref, conservatively require an ordinary project checkout
/// whose directory entry and immediate contents predate the saved observation.
/// Renaming a replacement into place or swapping its .git entry changes this
/// timestamp even if the replacement itself was created much earlier.
pub(crate) fn legacy_project_unchanged(
    project: &Path, common: &Path, observed: std::time::SystemTime,
) -> Option<()> {
    let meta = std::fs::symlink_metadata(project).ok()?;
    (meta.is_dir() && common == project.join(".git") && metadata_changed_at(&meta)? < observed).then_some(())
}

/// Require the Git directories and backlink to predate a recorded attachment
/// or observation. This keeps a later replacement or re-registration from
/// inheriting a legacy session's checkout path.
pub(crate) fn legacy_missing_cwd(
    common: &Path, root: &Path, cwd: &Path, branch: &str, observed: std::time::SystemTime,
) -> Option<PathBuf> {
    if directory_identity(common)?.created >= observed {
        return None;
    }
    let mut matching = None;
    for entry in std::fs::read_dir(registrations(common)?).ok()? {
        let admin = entry.ok()?.path();
        if !std::fs::symlink_metadata(&admin).ok()?.is_dir() {
            return None;
        }
        let backlink = admin.join("gitdir");
        if !registration_link_matches(&admin, &record_value(&backlink)?, &root.join(".git")) {
            continue;
        }
        if matching.is_some()
            || directory_identity(&admin)?.created >= observed
            || !recorded_before(&backlink, observed)?
            || !matches_registration(&admin, root, branch)
        {
            return None;
        }
        matching = Some(admin);
    }
    missing_relative_cwd(root, cwd, &matching?, |identity| identity.created < observed)
}

fn missing_relative_cwd(
    root: &Path, cwd: &Path, admin: &Path, matches_checkout: impl Fn(&DirectoryIdentity) -> bool,
) -> Option<PathBuf> {
    let relative = cwd.strip_prefix(root).ok()?;
    if !root.is_absolute() || cwd.components().any(|part| part == Component::ParentDir) {
        return None;
    }

    let mut prefix = PathBuf::new();
    for part in cwd.components() {
        prefix.push(part);
        match std::fs::symlink_metadata(&prefix) {
            Ok(meta) if meta.is_dir() => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Some(relative.to_path_buf());
            }
            _ => return None,
        }
        if prefix == root {
            if !matches_checkout(&directory_identity(root)?)
                || !registration_link_matches(root, record_value(&root.join(".git"))?.strip_prefix("gitdir: ")?, admin)
            {
                return None;
            }
        } else if prefix.starts_with(root) {
            match std::fs::symlink_metadata(prefix.join(".git")) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                _ => return None,
            }
        }
    }
    None
}

// Git's registration files are short, single-line values. Refuse symlinks and
// special files and bound the read even if a malformed file keeps growing.
#[cfg(unix)]
fn record_value(path: &Path) -> Option<String> {
    use std::{io::Read, os::unix::fs::OpenOptionsExt};
    const LIMIT: u64 = 8192;
    if !std::fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut value = String::new();
    file.take(LIMIT).read_to_string(&mut value).ok()?;
    let line = value.strip_suffix('\n')?;
    (value.len() < LIMIT as usize && !line.contains(['\n', '\r', '\0'])).then(|| line.to_owned())
}

#[cfg(not(unix))]
fn record_value(_: &Path) -> Option<String> {
    None
}
