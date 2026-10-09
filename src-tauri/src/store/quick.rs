//! Scratch directories of quick chats: `~/.raccoon/quick/<session id>`.
//!
//! A quick chat has no project, so it needs somewhere of its own to run: not
//! the reader's home directory, where an agent would see everything, and not
//! a repository. Each gets one directory here, named for its session, made
//! when the session is and removed when the session is deleted.
//!
//! The directory is found from the session id alone, so a quick chat that was
//! pointed at another folder, or moved into a project, still has its scratch
//! directory cleaned up when it goes.

use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};

/// `~/.raccoon/quick`, made on first use.
pub fn root() -> Result<PathBuf> {
    super::ensure_dir(super::root()?.join("quick"))
}

/// A session id is one path component here, never a path.
fn checked(session_id: &str) -> Result<&str> {
    let mut parts = Path::new(session_id).components();
    match (parts.next(), parts.next()) {
        (Some(Component::Normal(_)), None) => Ok(session_id),
        _ => bail!("not a session id: {session_id:?}"),
    }
}

/// Where a session's scratch directory is, whether or not it exists.
pub fn dir(session_id: &str) -> Result<PathBuf> {
    Ok(root()?.join(checked(session_id)?))
}

/// Make a session's scratch directory and return its canonical path: the
/// agent CLIs key their trust and their transcripts on the literal path, so
/// it is stored the way they will see it.
pub fn create(session_id: &str) -> Result<String> {
    let dir = super::ensure_dir(dir(session_id)?)?;
    let canonical = std::fs::canonicalize(&dir).with_context(|| format!("resolve {}", dir.display()))?;
    Ok(canonical.to_string_lossy().into_owned())
}

/// Whether `path` is the scratch directory of `session_id`, on disk or not:
/// it is asked about a directory that has just been removed, too.
pub fn is_scratch(session_id: &str, path: &str) -> bool {
    let (Ok(root), Ok(id)) = (root(), checked(session_id)) else { return false };
    let path = Path::new(path);
    if path.file_name().and_then(|name| name.to_str()) != Some(id) {
        return false;
    }
    let Some(parent) = path.parent() else { return false };
    parent == root || std::fs::canonicalize(parent).ok().zip(std::fs::canonicalize(&root).ok()).is_some_and(|(parent, root)| parent == root)
}

/// How many files a session's scratch directory holds, counted no further
/// than `limit`: enough to say "it has files" and roughly how many, without
/// walking something an agent filled with a dependency tree.
pub fn file_count(session_id: &str, limit: usize) -> usize {
    let Ok(dir) = dir(session_id) else { return 0 };
    let mut count = 0;
    let mut pending = vec![dir];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            // A link is counted, never followed: what it points at is not in here.
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => pending.push(entry.path()),
                Ok(_) => count += 1,
                Err(_) => {}
            }
            if count >= limit {
                return count;
            }
        }
    }
    count
}

/// Remove a session's scratch directory and everything in it. A session that
/// never had one is not an error.
pub fn remove(session_id: &str) -> Result<()> {
    let dir = dir(session_id)?;
    match std::fs::symlink_metadata(&dir) {
        // Someone put a link where the directory was: the link goes, not its target.
        Ok(meta) if !meta.is_dir() => std::fs::remove_file(&dir).with_context(|| format!("remove {}", dir.display())),
        Ok(_) => std::fs::remove_dir_all(&dir).with_context(|| format!("remove {}", dir.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("read {}", dir.display())),
    }
}

/// Remove a scratch directory that holds nothing. Returns whether it is gone.
pub fn remove_if_empty(session_id: &str) -> bool {
    let Ok(dir) = dir(session_id) else { return false };
    match std::fs::remove_dir(&dir) {
        Ok(()) => true,
        Err(error) => error.kind() == std::io::ErrorKind::NotFound,
    }
}

/// Scratch directories no session in `known` accounts for: left by a crash
/// between making the directory and saving the index, or by an older build.
pub fn orphans(known: &std::collections::HashSet<&str>) -> Vec<PathBuf> {
    let Ok(root) = root() else { return Vec::new() };
    std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter(|entry| !known.contains(entry.file_name().to_string_lossy().as_ref()))
        .map(|entry| entry.path())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scratch_directory_is_made_under_the_home_counted_and_removed() {
        let _home = crate::store::temp_home();
        let made = create("0198-session").unwrap();
        assert_eq!(Path::new(&made), dir("0198-session").unwrap().canonicalize().unwrap());
        assert!(Path::new(&made).starts_with(root().unwrap().canonicalize().unwrap()));
        assert!(is_scratch("0198-session", &made));
        assert!(!is_scratch("0198-session", root().unwrap().to_str().unwrap()));
        assert_eq!(file_count("0198-session", 100), 0);

        std::fs::create_dir_all(Path::new(&made).join("notes/deep")).unwrap();
        for name in ["a.txt", "notes/b.txt", "notes/deep/c.txt"] {
            std::fs::write(Path::new(&made).join(name), "x").unwrap();
        }
        assert_eq!(file_count("0198-session", 100), 3);
        assert_eq!(file_count("0198-session", 2), 2, "the count stops at its limit");
        assert!(!remove_if_empty("0198-session"), "a directory with files is kept");

        remove("0198-session").unwrap();
        assert!(!Path::new(&made).exists());
        assert!(is_scratch("0198-session", &made), "still known as its scratch directory once it is gone");
        assert!(!is_scratch("another", &made));
        // Removing what is not there, and counting it, are both quiet.
        remove("0198-session").unwrap();
        assert_eq!(file_count("0198-session", 100), 0);
        assert!(remove_if_empty("0198-session"));
    }

    #[test]
    fn an_id_that_is_a_path_names_no_directory() {
        let _home = crate::store::temp_home();
        let outside = crate::store::root().unwrap().join("sessions");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("index.json"), "{}").unwrap();
        for id in ["", ".", "..", "../sessions", "a/b", "/etc"] {
            assert!(dir(id).is_err(), "{id:?}");
            assert!(create(id).is_err(), "{id:?}");
            assert!(remove(id).is_err(), "{id:?}");
            assert_eq!(file_count(id, 10), 0, "{id:?}");
        }
        assert!(outside.join("index.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn removing_a_scratch_directory_never_follows_a_link_out_of_it() {
        let _home = crate::store::temp_home();
        let elsewhere = tempfile::tempdir().unwrap();
        std::fs::write(elsewhere.path().join("kept.txt"), "kept").unwrap();
        let made = create("linked").unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), Path::new(&made).join("out")).unwrap();
        assert_eq!(file_count("linked", 10), 1, "the link is one entry; its target is not walked");
        remove("linked").unwrap();
        assert!(elsewhere.path().join("kept.txt").exists());

        // The directory itself replaced by a link: only the link goes.
        std::os::unix::fs::symlink(elsewhere.path(), dir("swapped").unwrap()).unwrap();
        remove("swapped").unwrap();
        assert!(elsewhere.path().join("kept.txt").exists());
        assert!(std::fs::symlink_metadata(dir("swapped").unwrap()).is_err());
    }

    #[test]
    fn directories_no_session_accounts_for_are_orphans() {
        let _home = crate::store::temp_home();
        create("kept").unwrap();
        let lost = create("lost").unwrap();
        let known = std::collections::HashSet::from(["kept"]);
        let found = orphans(&known);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].canonicalize().unwrap(), Path::new(&lost));
    }
}
