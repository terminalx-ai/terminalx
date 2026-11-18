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
    std::fs::canonicalize(out.strip_suffix('\n')?).ok()
}

impl WorktreeIdentity {
    pub(crate) fn capture(project: &Path, root: &Path) -> Option<Self> {
        let root = std::fs::canonicalize(root).ok()?;
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
        let relative = cwd.strip_prefix(root).ok()?;
        if !root.is_absolute()
            || cwd.components().any(|part| part == Component::ParentDir)
            || directory_identity(common)? != self.repository
        {
            return None;
        }
        let mut parts = Path::new(&self.registration_name).components();
        if !matches!(parts.next(), Some(Component::Normal(_))) || parts.next().is_some() {
            return None;
        }
        let registrations = common.join("worktrees");
        let admin = registrations.join(&self.registration_name);
        if std::fs::canonicalize(&registrations).ok()? != registrations
            || directory_identity(&admin)? != self.registration
            || Path::new(record_value(&admin.join("gitdir"))?.as_str()) != root.join(".git")
            || record_value(&admin.join("HEAD"))? != format!("ref: refs/heads/{branch}")
            || record_value(&admin.join("commondir"))? != "../.."
        {
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
                if directory_identity(root)? != self.checkout
                    || record_value(&root.join(".git"))?.strip_prefix("gitdir: ")? != admin.to_str()?
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
