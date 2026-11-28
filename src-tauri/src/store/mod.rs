//! Everything under `~/.raccoon`.
//!
//! Two kinds of file with two kinds of write:
//! - per-tab event logs (`sessions/<session>/<tab>.jsonl`) are append-only and
//!   have one writer, so `O_APPEND` alone keeps them consistent;
//! - shared JSON (`index.json`, `projects.json`, `settings.json`) is rewritten
//!   whole under a process-wide lock and lands via write-temp + rename.

pub mod automations;
pub mod cloud_pins;
pub mod bots;
pub mod activity;
pub mod message_activity;
pub mod index;
pub mod conversation_titles;
pub mod projects;
pub mod review_comments;
pub mod quick;
pub mod settings;
pub mod environment;
pub mod configuration;
mod config_files;
pub(crate) mod managed_configuration;
// Dormant transactional journal primitive; no live event publisher uses it.
#[allow(dead_code)]
pub(crate) mod batch_journal;
pub(crate) mod transaction;

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use anyhow::{Context, Result};

const WRITE_LOCK_STRIPES: usize = 64;
static WRITE_LOCKS: [Mutex<()>; WRITE_LOCK_STRIPES] = [const { Mutex::new(()) }; WRITE_LOCK_STRIPES];

pub(crate) fn write_lock_for(path: &Path) -> &'static Mutex<()> {
    use std::hash::{Hash, Hasher};
    // Key by the staging path stem so files sharing `<stem>.tmp.<pid>` serialize
    // on the same stripe while unrelated store files write concurrently.
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.with_extension("").hash(&mut hasher);
    &WRITE_LOCKS[(hasher.finish() as usize) % WRITE_LOCK_STRIPES]
}

/// Lightweight metadata fingerprint for cache invalidation without reading file contents.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct FileStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
    #[cfg(unix)]
    ino: u64,
    #[cfg(unix)]
    ctime: i64,
    #[cfg(unix)]
    ctime_nsec: i64,
}

pub(crate) fn file_stamp(path: &Path) -> std::io::Result<Option<FileStamp>> {
    match fs::metadata(path) {
        Ok(meta) => {
            #[cfg(unix)]
            let stamp = {
                use std::os::unix::fs::MetadataExt;
                FileStamp {
                    len: meta.len(),
                    modified: meta.modified().ok(),
                    ino: meta.ino(),
                    ctime: meta.ctime(),
                    ctime_nsec: meta.ctime_nsec(),
                }
            };
            #[cfg(not(unix))]
            let stamp = FileStamp {
                len: meta.len(),
                modified: meta.modified().ok(),
            };
            Ok(Some(stamp))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// `~/.raccoon`, created on first use with owner-only permissions so the
/// transcripts and the orchestration socket in it are private to this user.
pub fn root() -> Result<PathBuf> {
    let root = match state_home_env() {
        Some(p) => PathBuf::from(p),
        None => dirs::home_dir().context("no home directory")?.join(".raccoon"),
    };
    #[cfg(windows)]
    harden_root(&root)?;
    ensure_dir(root)
}

/// On Windows a new home is created owner-only, as `ensure_dir` makes one
/// `0o700` on Unix. An existing home, which may be a folder the person chose,
/// is only checked, never changed: one another account owns or can open is
/// refused, with how to fix it, before anything is stored in it.
#[cfg(windows)]
fn harden_root(root: &Path) -> Result<()> {
    static CHECKED: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
    let mut checked = CHECKED.lock().unwrap_or_else(|e| e.into_inner());
    if checked.iter().any(|done| done == root) {
        return Ok(());
    }
    if root.exists() {
        if let Err(error) = crate::win::security::verify_private(root) {
            anyhow::bail!(
                "{} is not private to this Windows account ({error}). TerminalX keeps credentials and transcripts there, so it was left unchanged and not used. Make it private, for example with `icacls \"{}\" /inheritance:r /grant:r \"%USERNAME%\":(OI)(CI)F`, or choose another folder.",
                root.display(), root.display()
            );
        }
    } else {
        crate::win::fs::create_private_dir_all(root).with_context(|| format!("create {}", root.display()))?;
    }
    checked.push(root.to_owned());
    Ok(())
}


/// Resolve the state directory. TERMINALX_HOME is canonical; RACCOON_HOME is
/// accepted during migration when the canonical variable is unset.
pub fn state_home_env() -> Option<String> {
    std::env::var("TERMINALX_HOME").ok().or_else(|| std::env::var("RACCOON_HOME").ok())
}

pub fn ensure_dir(p: PathBuf) -> Result<PathBuf> {
    if !p.exists() {
        fs::create_dir_all(&p).with_context(|| format!("create {}", p.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o700))
                .with_context(|| format!("set 0o700 permissions on {}", p.display()))?;
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
    session_dir(session_id)?;
    log_path_in(&root()?, session_id, tab_id)
}

/// Derive a tab's event log path directly from an already-loaded [`index::TabEntry`]
/// without re-reading or re-parsing `sessions/index.json` (P-60).
pub fn log_path_for_tab(root: &Path, session_id: &str, tab: &index::TabEntry) -> Result<PathBuf> {
    let name = match tab.unknown.get("resetLogId") {
        None | Some(serde_json::Value::Null) => format!("{}.jsonl", tab.id),
        Some(serde_json::Value::String(id)) if uuid::Uuid::parse_str(id).is_ok() => {
            format!("{}.reset-{id}.jsonl", tab.id)
        }
        Some(_) => anyhow::bail!("Invalid reset log id."),
    };
    Ok(root.join("sessions").join(session_id).join(name))
}

#[derive(Clone, PartialEq, Eq)]
enum ResetLogEntry {
    Valid(String),
    Invalid,
}

struct CachedLogPaths {
    stamp: Option<FileStamp>,
    entries: HashMap<(String, String), ResetLogEntry>,
    last_used: u64,
}

#[derive(Default)]
struct LogPathCache {
    tick: u64,
    by_index: HashMap<PathBuf, CachedLogPaths>,
}

const MAX_LOG_PATH_CACHE_ROOTS: usize = 16;
static LOG_PATH_CACHE: LazyLock<Mutex<LogPathCache>> = LazyLock::new(Default::default);

#[cfg(test)]
thread_local! {
    pub(crate) static TEST_LOG_PATH_PARSES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn invalidate_log_path_cache(path: &Path) {
    if path.file_name().is_some_and(|name| name == "index.json") {
        LOG_PATH_CACHE.lock().unwrap_or_else(|e| e.into_inner()).by_index.remove(path);
    }
}

fn parse_reset_log_entries(index_path: &Path) -> Result<HashMap<(String, String), ResetLogEntry>> {
    #[derive(serde::Deserialize, Default)]
    #[serde(rename_all = "camelCase")]
    struct MinimalIndex {
        #[serde(default)]
        sessions: Vec<MinimalSession>,
        #[serde(default)]
        closed_tabs: Vec<MinimalClosedTab>,
    }
    #[derive(serde::Deserialize)]
    struct MinimalSession {
        #[serde(default)]
        id: String,
        #[serde(default)]
        tabs: Vec<MinimalTab>,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MinimalClosedTab {
        #[serde(default)]
        session_id: String,
        tab: MinimalTab,
    }
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct MinimalTab {
        #[serde(default)]
        id: String,
        #[serde(default)]
        reset_log_id: Option<serde_json::Value>,
    }

    #[cfg(test)]
    TEST_LOG_PATH_PARSES.with(|count| count.set(count.get() + 1));

    let minimal: MinimalIndex = read_json(index_path)?.unwrap_or_default();
    let mut entries = HashMap::new();
    let classify = |val: Option<serde_json::Value>| -> Option<ResetLogEntry> {
        match val {
            None | Some(serde_json::Value::Null) => None,
            Some(serde_json::Value::String(id)) if uuid::Uuid::parse_str(&id).is_ok() => Some(ResetLogEntry::Valid(id)),
            Some(_) => Some(ResetLogEntry::Invalid),
        }
    };
    // Active tabs take precedence over closed tabs, matching the original `.find().or_else(...)` order.
    for session in minimal.sessions {
        for tab in session.tabs {
            if let Some(entry) = classify(tab.reset_log_id) {
                entries.entry((session.id.clone(), tab.id)).or_insert(entry);
            }
        }
    }
    for closed in minimal.closed_tabs {
        if let Some(entry) = classify(closed.tab.reset_log_id) {
            entries.entry((closed.session_id, closed.tab.id)).or_insert(entry);
        }
    }
    Ok(entries)
}

/// The index selects an immutable log generation together with its provider
/// conversation. A reset never exposes half of that switch after a crash.
/// Read the raw index here: projecting message activity would recurse.
pub(crate) fn log_path_in(root: &Path, session_id: &str, tab_id: &str) -> Result<PathBuf> {
    let index_path = root.join("sessions/index.json");
    let current_stamp = file_stamp(&index_path)?;

    let cached_entry = {
        let mut cache = LOG_PATH_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        let hit = cache.by_index.get(&index_path).is_some_and(|c| c.stamp == current_stamp);
        if hit {
            cache.tick = cache.tick.wrapping_add(1);
            let tick = cache.tick;
            let entry = cache.by_index.get_mut(&index_path).unwrap();
            entry.last_used = tick;
            Some(entry.entries.get(&(session_id.to_owned(), tab_id.to_owned())).cloned())
        } else {
            None
        }
    };

    let generation = match cached_entry {
        Some(entry) => entry,
        None => {
            let parsed = parse_reset_log_entries(&index_path)?;
            let result = parsed.get(&(session_id.to_owned(), tab_id.to_owned())).cloned();
            let mut cache = LOG_PATH_CACHE.lock().unwrap_or_else(|e| e.into_inner());
            cache.tick = cache.tick.wrapping_add(1);
            let tick = cache.tick;
            if !cache.by_index.contains_key(&index_path) && cache.by_index.len() >= MAX_LOG_PATH_CACHE_ROOTS {
                if let Some(oldest) = cache.by_index.iter().min_by_key(|(_, v)| v.last_used).map(|(k, _)| k.clone()) {
                    cache.by_index.remove(&oldest);
                }
            }
            cache.by_index.insert(
                index_path,
                CachedLogPaths {
                    stamp: current_stamp,
                    entries: parsed,
                    last_used: tick,
                },
            );
            result
        }
    };

    let name = match generation {
        Some(ResetLogEntry::Valid(id)) => format!("{tab_id}.reset-{id}.jsonl"),
        None => format!("{tab_id}.jsonl"),
        Some(ResetLogEntry::Invalid) => anyhow::bail!("Invalid reset log id."),
    };
    Ok(root.join("sessions").join(session_id).join(name))
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
///
/// The temp file is created new, never opened through a link: in a folder
/// another program can write to (a bot's home), a file or a link planted at
/// its name is removed (the link itself, never what it points to) and the
/// create tried once more, so the write never goes through it.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    write_atomic_unless(path, bytes, || false).map(|_| ())
}

/// Atomic write+rename without `fsync`/`F_FULLFSYNC`, for derived or ephemeral
/// caches that can be rebuilt on crash and must not stall on NVMe flush barriers.
pub fn write_atomic_nosync(path: &Path, bytes: &[u8]) -> Result<()> {
    write_atomic_inner(path, bytes, false, || false).map(|_| ())
}

/// [`write_atomic`], asking `abandon` once the new bytes are written and
/// fsynced beside `path`, right before the rename swaps them in. When it
/// says so, the temp file is removed, `path` is left untouched and
/// `Ok(false)` is returned. This narrows, but cannot close, the window in
/// which another program's write to `path` is lost: one landing after
/// `abandon` answered and before the rename is still replaced.
pub fn write_atomic_unless(path: &Path, bytes: &[u8], abandon: impl FnOnce() -> bool) -> Result<bool> {
    write_atomic_inner(path, bytes, true, abandon)
}

fn temp_path(path: &Path) -> PathBuf {
    path.with_extension(format!("tmp.{}", std::process::id()))
}

fn write_atomic_inner(path: &Path, bytes: &[u8], sync: bool, abandon: impl FnOnce() -> bool) -> Result<bool> {
    let _guard = write_lock_for(path).lock().unwrap_or_else(|e| e.into_inner());
    let tmp = temp_path(path);
    let written = (|| -> Result<()> {
        let mut f = match create_private(&tmp, mode_of(path)) {
            Err(error) if matches!(fs::symlink_metadata(&tmp), Ok(meta) if !meta.is_dir()) => {
                fs::remove_file(&tmp).with_context(|| format!("create {}: {error}", tmp.display()))?;
                create_private(&tmp, mode_of(path))
            }
            created => created,
        }
        .with_context(|| format!("create {}", tmp.display()))?;
        f.write_all(bytes)?;
        if sync {
            f.sync_all()?;
        }
        Ok(())
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    if abandon() {
        let _ = fs::remove_file(&tmp);
        return Ok(false);
    }
    if let Err(error) = fs::rename(&tmp, path).with_context(|| format!("rename into {}", path.display())) {
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    invalidate_log_path_cache(path);
    Ok(true)
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
    fs::OpenOptions::new().write(true).create_new(true).custom_flags(libc::O_NOFOLLOW).mode(keep.unwrap_or(0o600)).open(path)
}

#[cfg(not(unix))]
fn create_private(path: &Path, _keep: Option<u32>) -> std::io::Result<fs::File> {
    // Created new, as on Unix, and owner-only.
    crate::win::fs::create_new_private(path)
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    write_atomic(path, &bytes)
}

pub fn write_json_nosync<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(value)?;
    write_atomic_nosync(path, &bytes)
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
    std::env::set_var("TERMINALX_HOME", dir.path());
    TempHome { _dir: dir, _guard: guard }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A write whose rename fails (a folder holding a file is in the way)
    /// leaves no temporary file beside it.
    #[test]
    fn a_failed_rename_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("x.json");
        fs::create_dir(&p).unwrap();
        fs::write(p.join("keep"), "mine").unwrap();
        let error = write_atomic(&p, b"{}").unwrap_err();
        assert!(format!("{error:#}").starts_with("rename into "), "{error:#}");
        let names: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(names, ["x.json"]);
        assert_eq!(fs::read(p.join("keep")).unwrap(), b"mine");
    }

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

#[cfg(test)]
mod reset_log_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn generation_pointer_is_atomic_and_survives_closing_a_tab() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        let tab = json!({"id":"t","resetLogId":id});
        let index = root.join("sessions/index.json");
        write_json(&index, &json!({"sessions":[{"id":"s","tabs":[{"id":"t"}]}]})).unwrap();
        assert_eq!(log_path_in(root, "s", "t").unwrap(), root.join("sessions/s/t.jsonl"));
        write_json(&index, &json!({"sessions":[{"id":"s","tabs":[tab]}]})).unwrap();
        let selected = log_path_in(root, "s", "t").unwrap();
        assert_eq!(selected, root.join(format!("sessions/s/t.reset-{id}.jsonl")));
        write_json(&index, &json!({"sessions":[{"id":"s","tabs":[]}],"closedTabs":[{"sessionId":"s","tab":tab}]})).unwrap();
        assert_eq!(log_path_in(root, "s", "t").unwrap(), selected);
        write_json(&index, &json!({"sessions":[{"id":"s","tabs":[{"id":"t","resetLogId":"../../outside"}]}]})).unwrap();
        assert!(log_path_in(root, "s", "t").is_err());
    }

    #[test]
    fn log_path_in_caches_parsed_index_and_invalidates_on_write() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        let index = root.join("sessions/index.json");
        let id = "22222222-2222-4222-8222-222222222222";
        write_json(&index, &json!({"sessions":[{"id":"s","tabs":[{"id":"t"}]}]})).unwrap();

        TEST_LOG_PATH_PARSES.with(|c| c.set(0));
        assert_eq!(log_path_in(root, "s", "t").unwrap(), root.join("sessions/s/t.jsonl"));
        for _ in 0..50 {
            assert_eq!(log_path_in(root, "s", "t").unwrap(), root.join("sessions/s/t.jsonl"));
        }
        assert_eq!(TEST_LOG_PATH_PARSES.with(|c| c.get()), 1, "repeated log_path_in calls must hit cache");

        write_json(&index, &json!({"sessions":[{"id":"s","tabs":[{"id":"t","resetLogId":id}]}]})).unwrap();
        assert_eq!(log_path_in(root, "s", "t").unwrap(), root.join(format!("sessions/s/t.reset-{id}.jsonl")));
        assert_eq!(TEST_LOG_PATH_PARSES.with(|c| c.get()), 2, "index write must invalidate log_path cache");
    }

    #[test]
    fn striped_locks_allow_concurrent_writes_to_distinct_paths() {
        let dir = tempfile::tempdir().unwrap();
        let p1 = dir.path().join("alpha.json");
        let p2 = dir.path().join("beta.json");
        // Verify write_atomic_nosync preserves atomicity and leaves no temp files.
        write_json_nosync(&p1, &json!({"k": 1})).unwrap();
        write_json_nosync(&p2, &json!({"k": 2})).unwrap();
        assert_eq!(read_json::<serde_json::Value>(&p1).unwrap().unwrap()["k"], 1);
        assert_eq!(read_json::<serde_json::Value>(&p2).unwrap().unwrap()["k"], 2);
        let mut names: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        assert_eq!(names, ["alpha.json", "beta.json"]);
    }
}
