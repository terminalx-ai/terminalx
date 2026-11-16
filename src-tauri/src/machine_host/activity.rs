//! The record, on this machine, of what operating computers did (PRO-357,
//! docs/MACHINES.md "Trust model"): `<data dir>/machine-host/activity.jsonl`,
//! mode 0600, one entry a line, the last [`KEEP`] kept. It survives a
//! restart. Settings → Machines shows it under "Computers that can operate
//! this Mac".
//!
//! An entry names the computer and the time, and at most a project's name,
//! a route or a version. Never a prompt, a command, a path inside a project
//! or a file's contents.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const FILE: &str = "activity.jsonl";
/// How many entries are kept and shown.
pub const KEEP: usize = 200;
/// The file is cut back to [`KEEP`] once it holds this many.
const TRIM_AT: usize = KEEP * 2;
/// A detail is at most this many characters.
const DETAIL_CHARS: usize = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// The person allowed a new computer.
    Paired,
    /// A computer's first connection opened. `detail`: `lan`, `tailscale` or `relay`.
    Connected,
    /// Its last connection closed.
    Disconnected,
    /// `session.create`. `detail`: the project's name.
    SessionCreated,
    /// `pty.create`. `detail`: the project's name.
    TerminalOpened,
    /// A project appeared on this machine while a computer was connected.
    /// No method adds one, so it is not put down to a computer.
    ProjectAdded,
    ProjectRemoved,
    /// `machine.update`. `detail`: the version asked for.
    Update,
    /// The person revoked it.
    Revoked,
    /// Its credential went unused for 90 days.
    Expired,
    /// The person pressed Disconnect: refused until they let it back.
    Held,
    /// The person let it reconnect.
    LetBack,
    /// A kind a newer build wrote.
    #[serde(other)]
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Milliseconds since the epoch.
    pub at: i64,
    pub kind: Kind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer_id: Option<String>,
    /// The computer's name when it happened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Entry {
    pub fn new(kind: Kind, computer: Option<(&str, &str)>, detail: Option<&str>) -> Self {
        Self {
            at: chrono::Utc::now().timestamp_millis(),
            kind,
            computer_id: computer.map(|(id, _)| id.to_string()),
            computer: computer.map(|(_, label)| clean(label)),
            detail: detail.map(clean).filter(|detail| !detail.is_empty()),
        }
    }
}

/// One line of plain text: no control characters, at most [`DETAIL_CHARS`].
fn clean(text: &str) -> String {
    text.chars().filter(|c| !c.is_control()).take(DETAIL_CHARS).collect::<String>().trim().to_string()
}

#[derive(Clone)]
pub struct Log {
    path: PathBuf,
    /// One writer at a time in this process; the runtime is the file's only writer.
    write: Arc<Mutex<()>>,
}

impl Log {
    /// The log in the machine host's directory `dir`.
    pub fn in_dir(dir: &Path) -> Self {
        Self { path: dir.join(FILE), write: Arc::new(Mutex::new(())) }
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Append `entry`, cutting the file back to the last [`KEEP`] when it grew past twice that.
    pub fn note(&self, entry: &Entry) -> Result<()> {
        let _write = self.write.lock().unwrap();
        let dir = self.path.parent().context("the activity log has no directory")?;
        super::private_dir(dir)?;
        let mut line = serde_json::to_vec(entry)?;
        line.push(b'\n');
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&self.path).with_context(|| format!("open {}", self.path.display()))?;
        file.write_all(&line)?;
        file.sync_data()?;
        drop(file);
        let text = std::fs::read_to_string(&self.path)?;
        let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
        if lines.len() >= TRIM_AT {
            let kept = lines[lines.len() - KEEP..].join("\n") + "\n";
            crate::cloud_bootstrap::write_durable(&self.path, kept.as_bytes())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))?;
            }
        }
        Ok(())
    }

    /// Write `entry`, logging rather than failing: the record must never
    /// stop a connection or a call.
    pub fn record(&self, entry: Entry) {
        if let Err(error) = self.note(&entry) {
            log::warn!("machine host: keep the activity log: {error:#}");
        }
    }

    /// The last [`KEEP`] entries, newest first. A line that cannot be read
    /// (cut short by a crash) is skipped.
    pub fn recent(&self) -> Result<Vec<Entry>> {
        let text = match std::fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error).with_context(|| format!("read {}", self.path.display())),
        };
        let entries: Vec<Entry> = text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect();
        Ok(entries.into_iter().rev().take(KEEP).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_last_two_hundred_are_kept_newest_first_and_survive_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let log = Log::in_dir(&dir.path().join("machine-host"));
        for n in 0..(TRIM_AT + 7) {
            log.note(&Entry { at: n as i64, ..Entry::new(Kind::SessionCreated, Some(("computer-a", "Air")), Some("terminalx")) }).unwrap();
        }
        let lines = std::fs::read_to_string(log.path()).unwrap().lines().count();
        assert!(lines < TRIM_AT, "the file was cut back ({lines} lines)");
        // Another process reading it (a restarted runtime) sees the same.
        let again = Log::in_dir(&dir.path().join("machine-host"));
        let recent = again.recent().unwrap();
        assert_eq!(recent.len(), KEEP);
        assert_eq!(recent[0].at, (TRIM_AT + 6) as i64, "newest first");
        assert_eq!(recent[KEEP - 1].at, (TRIM_AT + 7 - KEEP) as i64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(log.path()).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn an_entry_holds_one_line_of_text_and_skips_what_it_cannot_read() {
        let dir = tempfile::tempdir().unwrap();
        let log = Log::in_dir(dir.path());
        let entry = Entry::new(Kind::Connected, Some(("computer-a", "Paresh\u{7}’s\nAir")), Some(&"x".repeat(500)));
        assert_eq!(entry.computer.as_deref(), Some("Paresh’sAir"));
        assert_eq!(entry.detail.as_ref().unwrap().chars().count(), DETAIL_CHARS);
        log.note(&entry).unwrap();
        std::fs::OpenOptions::new().append(true).open(log.path()).unwrap().write_all(b"{\"at\":1,\"kind\":\"futureKind\"}\n{\"at\":").unwrap();
        let recent = log.recent().unwrap();
        assert_eq!(recent.len(), 2, "a half-written line is skipped: {recent:?}");
        assert_eq!(recent[0].kind, Kind::Other, "a newer build's kind is kept as other");
        assert_eq!(recent[1], entry);
    }
}
