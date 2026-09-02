#![allow(dead_code)] // consumers land in later checkpoints; audited at C16

//! Everything under `~/.raccoon`.
//!
//! Two kinds of file with two kinds of write:
//! - per-tab event logs (`sessions/<session>/<tab>.jsonl`) are append-only and
//!   have one writer, so `O_APPEND` alone keeps them consistent;
//! - shared JSON (`index.json`, `projects.json`, `settings.json`) is rewritten
//!   whole under a process-wide lock and lands via write-temp + rename.

pub mod index;
pub mod projects;
pub mod settings;

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};

static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// `~/.raccoon`, created on first use with owner-only permissions so the
/// transcripts and the orchestration socket in it are private to this user.
pub fn root() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("RACCOON_HOME") {
        return ensure_dir(PathBuf::from(p));
    }
    let home = dirs::home_dir().context("no home directory")?;
    ensure_dir(home.join(".raccoon"))
}

pub fn ensure_dir(p: PathBuf) -> Result<PathBuf> {
    if !p.exists() {
        fs::create_dir_all(&p).with_context(|| format!("create {}", p.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o700));
        }
    }
    Ok(p)
}

pub fn sessions_dir() -> Result<PathBuf> {
    ensure_dir(root()?.join("sessions"))
}

pub fn session_dir(session_id: &str) -> Result<PathBuf> {
    ensure_dir(sessions_dir()?.join(session_id))
}

pub fn attachments_dir(session_id: &str) -> Result<PathBuf> {
    ensure_dir(root()?.join("attachments").join(session_id))
}

pub fn log_path(session_id: &str, tab_id: &str) -> Result<PathBuf> {
    Ok(session_dir(session_id)?.join(format!("{tab_id}.jsonl")))
}

/// Rewrite `path` atomically. Readers never see a torn file: the temp file is
/// fully written and fsynced before the rename swaps it in.
///
/// The temp file is created owner-only rather than tightened afterwards —
/// these files hold API keys and transcripts, and a umask of 022 would
/// otherwise leave every byte world-readable for the whole write. When the
/// target already exists its mode is carried over: `~/.claude.json` is the
/// CLI's file, not ours, and a rewrite is no place to change what its owner
/// chose.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    {
        let mut f = create_private(&tmp, mode_of(path)).with_context(|| format!("create {}", tmp.display()))?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display()))?;
    Ok(())
}

/// The mode `path` already has, if it is there to have one.
#[cfg(unix)]
fn mode_of(path: &Path) -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    fs::metadata(path).ok().map(|m| m.mode() & 0o7777)
}

#[cfg(not(unix))]
fn mode_of(_path: &Path) -> Option<u32> {
    None
}

#[cfg(unix)]
fn create_private(path: &Path, keep: Option<u32>) -> std::io::Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new().write(true).create(true).truncate(true).mode(keep.unwrap_or(0o600)).open(path)
}

#[cfg(not(unix))]
fn create_private(path: &Path, _keep: Option<u32>) -> std::io::Result<fs::File> {
    fs::File::create(path)
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    write_atomic(path, &bytes)
}

/// Read a JSON file; a missing file is `None`, a broken one is an error the
/// caller decides about (an index that fails to parse must not be rewritten
/// empty over the top of real data).
pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match fs::read(path) {
        Ok(bytes) if bytes.is_empty() => Ok(None),
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Append one line to an event log.
pub fn append_line(path: &Path, line: &str) -> Result<()> {
    let mut f = fs::OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(line.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(())
}

/// Read every line of a log as `T`, skipping lines that no longer parse so one
/// event written by a newer build can't hide the whole conversation.
pub fn read_lines<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Vec<T>> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<T>(line) {
            Ok(v) => out.push(v),
            Err(e) => log::warn!("skipping unreadable log line in {}: {e}", path.display()),
        }
    }
    Ok(out)
}

/// The last `seq` in a log, read from the tail so a long log is not parsed whole
/// just to continue the counter.
pub fn last_seq(path: &Path) -> Result<u64> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = match fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let len = f.metadata()?.len();
    let window = len.min(64 * 1024);
    f.seek(SeekFrom::Start(len - window))?;
    let mut buf = String::new();
    f.read_to_string(&mut buf)?;
    let mut best = 0u64;
    for line in buf.lines().rev() {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            if let Some(seq) = v.get("seq").and_then(|s| s.as_u64()) {
                best = seq;
                break;
            }
        }
    }
    Ok(best)
}

/// Tests that touch `~/.raccoon` point it at a temp dir. The env var is
/// process-wide, so they also hold a lock and run one at a time.
#[cfg(test)]
pub(crate) struct TempHome {
    _dir: tempfile::TempDir,
    _guard: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
pub(crate) fn temp_home() -> TempHome {
    static LOCK: Mutex<()> = Mutex::new(());
    let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("RACCOON_HOME", dir.path());
    TempHome { _dir: dir, _guard: guard }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.json");
        write_json(&p, &serde_json::json!({"a": 1})).unwrap();
        let v: Option<serde_json::Value> = read_json(&p).unwrap();
        assert_eq!(v.unwrap()["a"], 1);
        assert!(!dir.path().join("x.tmp").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_new_file_is_owner_only_from_the_moment_it_exists() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();

        // Nothing there before: ours to choose, and the choice is 0600 — not
        // 0644-then-chmod, which would publish the contents for the length of
        // the write.
        let fresh = dir.path().join("settings.json");
        write_json(&fresh, &serde_json::json!({"linearApiKey": "secret"})).unwrap();
        assert_eq!(fresh.metadata().unwrap().permissions().mode() & 0o777, 0o600);

        // Someone else's file, rewritten: their mode survives.
        let theirs = dir.path().join("claude.json");
        fs::write(&theirs, b"{}").unwrap();
        fs::set_permissions(&theirs, fs::Permissions::from_mode(0o644)).unwrap();
        write_json(&theirs, &serde_json::json!({"projects": {}})).unwrap();
        assert_eq!(theirs.metadata().unwrap().permissions().mode() & 0o777, 0o644);

        // And a file that was already tight stays tight.
        fs::set_permissions(&theirs, fs::Permissions::from_mode(0o600)).unwrap();
        write_json(&theirs, &serde_json::json!({"projects": {"a": 1}})).unwrap();
        assert_eq!(theirs.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn missing_json_is_none_and_broken_is_error() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("y.json");
        let v: Option<serde_json::Value> = read_json(&p).unwrap();
        assert!(v.is_none());
        fs::write(&p, b"{not json").unwrap();
        assert!(read_json::<serde_json::Value>(&p).is_err());
    }

    #[test]
    fn last_seq_reads_tail() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("log.jsonl");
        for i in 1..=500u64 {
            append_line(&p, &format!("{{\"seq\":{i},\"pad\":\"{}\"}}", "x".repeat(300))).unwrap();
        }
        assert_eq!(last_seq(&p).unwrap(), 500);
        assert_eq!(last_seq(&dir.path().join("none")).unwrap(), 0);
    }

    #[test]
    fn unreadable_lines_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("log.jsonl");
        append_line(&p, "{\"seq\":1}").unwrap();
        append_line(&p, "garbage").unwrap();
        append_line(&p, "{\"seq\":2}").unwrap();
        let v: Vec<serde_json::Value> = read_lines(&p).unwrap();
        assert_eq!(v.len(), 2);
    }
}
