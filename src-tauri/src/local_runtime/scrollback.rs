//! Bounded terminal tails for an orderly idle-owner exit. This is history,
//! never evidence that a PID or a command survived a runtime restart.
use std::collections::HashSet;
use std::path::Path;
use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};

pub(crate) const TOTAL_BYTES: usize = 32 * 1024 * 1024;
const FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PANES: usize = 4096;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct History {
    pub id: String,
    pub cwd: String,
    pub created: String,
    pub title: Option<String>,
    pub renamed: bool,
    #[serde(with = "bytes")]
    pub data: Vec<u8>,
}

mod bytes {
    use super::*;
    pub fn serialize<S: serde::Serializer>(value: &[u8], serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(value))
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Vec<u8>, D::Error> {
        let value = String::deserialize(deserializer)?;
        if value.len() > 1024 * 1024 { return Err(serde::de::Error::custom("terminal tail is too large")); }
        base64::engine::general_purpose::STANDARD.decode(value).map_err(serde::de::Error::custom)
    }
}

fn path(root: &Path) -> std::path::PathBuf { root.join("run/pty-history.json") }

pub(crate) fn save(root: &Path, terminals: &crate::pty::Terminals) -> Result<()> {
    let history = terminals.history(TOTAL_BYTES);
    validate(&history)?;
    let bytes = serde_json::to_vec(&history)?;
    if bytes.len() as u64 > FILE_BYTES { bail!("terminal history exceeds the snapshot limit"); }
    use std::io::Write;
    let path = path(root);
    let parent = path.parent().context("terminal history directory is missing")?;
    let mut staged = tempfile::NamedTempFile::new_in(parent)?;
    staged.write_all(&bytes)?;
    staged.as_file().sync_all()?;
    staged.persist(&path).map_err(|error| error.error)?;
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

fn validate(history: &[History]) -> Result<()> {
    if history.len() > MAX_PANES || history.iter().map(|pane| pane.data.len()).sum::<usize>() > TOTAL_BYTES {
        bail!("terminal history exceeds its bounds");
    }
    let mut ids = HashSet::new();
    for pane in history {
        if pane.id.is_empty() || pane.id.len() > 256 || pane.cwd.len() > 16384 || pane.created.len() > 128
            || pane.title.as_ref().is_some_and(|title| title.len() > 16384)
            || pane.data.len() > 512 * 1024 || !ids.insert(&pane.id) {
            bail!("invalid terminal history entry");
        }
    }
    Ok(())
}

/// Consume only a private regular snapshot. Removing it after import prevents
/// a later owner crash from resurrecting terminal tabs explicitly closed since
/// this snapshot. Crash recovery remains interruption, not false live output.
#[cfg(unix)]
pub(crate) fn restore(root: &Path, terminals: &crate::pty::Terminals) -> Result<()> {
    use std::io::Read;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let path = path(root);
    let file = match std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).context("open retained terminal history"),
    };
    let metadata = file.metadata()?;
    // SAFETY: geteuid has no preconditions.
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0
        || metadata.nlink() != 1 || metadata.len() > FILE_BYTES {
        bail!("retained terminal history is not a private bounded file");
    }
    let mut bytes = Vec::new();
    file.take(FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > FILE_BYTES { bail!("terminal history changed beyond its size limit"); }
    let mut history: Vec<History> = serde_json::from_slice(&bytes)?;
    validate(&history)?;
    let sessions = crate::store::index::load()?;
    history.retain(|pane| {
        if let Some(tab) = pane.id.strip_prefix("tab:") {
            sessions.iter().any(|session| session.tabs.iter().any(|entry| entry.id == tab))
        } else {
            crate::pty::shell_session(&pane.id).is_some_and(|id| sessions.iter().any(|session| session.id == id))
        }
    });
    terminals.restore_history(history);
    std::fs::remove_file(path)?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn retained_bytes_are_bounded_and_never_restore_a_pid() {
        let terminals = crate::pty::Terminals::new();
        terminals.restore_history((0..100).map(|n| History { id: format!("fixture:{n}"), cwd: "/fixture".into(),
            created: "now".into(), title: None, renamed: false, data: vec![b'x'; 512 * 1024] }).collect());
        let history = terminals.history(TOTAL_BYTES);
        assert_eq!(history.len(),100);
        assert!(history.iter().map(|pane| pane.data.len()).sum::<usize>() <= TOTAL_BYTES);
        assert!(history.iter().all(|pane| pane.data.len() <= 512 * 1024));
        assert!(terminals.panes().iter().all(|pane| pane.pid.is_none() && !pane.running));
        assert!(terminals.shells().iter().all(|pane| pane.exited));
        terminals.kill("fixture:0");
        assert!(terminals.read_output("fixture:0").is_none());
    }

    #[test]
    fn restored_shell_titles_survive_rename_and_another_pane_closing() {
        let terminals = crate::pty::Terminals::new();
        terminals.restore_history(["session:one", "session:two"].into_iter().map(|id| History {
            id: id.into(), cwd: "/fixture".into(), created: "now".into(), title: Some("original".into()),
            renamed: false, data: b"retained output".to_vec(),
        }).collect());
        terminals.rename("session:one", "renamed after restore");
        terminals.kill("session:two");
        let shell = terminals.shell("session:one").unwrap();
        assert_eq!(shell.title.as_deref(), Some("renamed after restore"));
        assert!(shell.renamed && shell.exited);
        let history = terminals.history(TOTAL_BYTES);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].title, shell.title);
        assert!(history[0].renamed);
        let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let observed = output.clone();
        terminals.attach("fixture", "session:one", "fixture-view", Box::new(move |bytes| {
            observed.lock().unwrap().extend_from_slice(bytes); true
        }));
        assert_eq!(*output.lock().unwrap(), b"retained output");
    }

    #[test]
    fn restore_refuses_symlinks_public_files_and_oversized_snapshots() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("run")).unwrap();
        let external = home.path().join("external");
        std::fs::write(&external,b"[]").unwrap();
        std::os::unix::fs::symlink(&external,path(home.path())).unwrap();
        let terminals = crate::pty::Terminals::new();
        assert!(restore(home.path(),&terminals).is_err());
        assert_eq!(std::fs::read(&external).unwrap(),b"[]");
        std::fs::remove_file(path(home.path())).unwrap();
        use std::os::unix::ffi::OsStrExt;
        let fifo = std::ffi::CString::new(path(home.path()).as_os_str().as_bytes()).unwrap();
        // SAFETY: fifo is a valid NUL-terminated path inside this private fixture.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(restore(home.path(), &terminals).is_err(), "a FIFO must be refused without waiting for a writer");
        std::fs::remove_file(path(home.path())).unwrap();
        std::fs::write(path(home.path()),b"[]").unwrap();
        std::fs::set_permissions(path(home.path()),std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(restore(home.path(),&terminals).is_err());
        std::fs::set_permissions(path(home.path()),std::fs::Permissions::from_mode(0o600)).unwrap();
        std::fs::OpenOptions::new().write(true).open(path(home.path())).unwrap().set_len(FILE_BYTES+1).unwrap();
        assert!(restore(home.path(),&terminals).is_err());
    }
}
