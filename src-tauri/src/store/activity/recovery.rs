//! Best-effort, repeatable pre-ledger recovery. Old logs lack hook transitions:
//! prompts require evidence of actual agent work; identity announcements alone
//! are not launches. Never infer an interval across a missing stop or an idle gap.

use std::fs;
use std::io::{BufRead, BufReader};

use super::*;
use crate::events::{AgentEvent, Payload, TurnStatus};

const VERSION: u32 = 1;

struct Work {
    id: String,
    key: String,
    at: i64,
    duration_ms: u64,
}

impl Collector {
    pub(super) fn recover(&mut self) {
        if self.data.recovery_version >= VERSION {
            return;
        }
        let mut errors = Vec::new();
        match log_files(&self.root.join("sessions")) {
            Ok(files) => {
                for file in files {
                    match recover_log(&file, self.data.recovery_before) {
                        Ok(work) => {
                            for work in work {
                                if self.data.recovered.insert(work.id.clone()) {
                                    self.data.agents_spawned += 1;
                                    self.data.agent_time_ms =
                                        self.data.agent_time_ms.saturating_add(work.duration_ms);
                                    self.data.remember(ActivityEvent {
                                        id: work.id,
                                        at: work.at,
                                        kind: "recovered_work".into(),
                                        key: work.key,
                                        duration_ms: work.duration_ms,
                                    });
                                }
                            }
                        }
                        Err(error) => errors.push(format!("{}: {error:#}", file.display())),
                    }
                }
            }
            Err(error) => errors.push(format!("{error:#}")),
        }
        // Keep the old file intact. A corrupt legacy PR file must not silently
        // become an empty history, even if other recovery sources succeeded.
        let path = self.root.join("stats-prs.json");
        match fs::read(&path) {
            Ok(bytes) => {
                #[derive(Deserialize)]
                struct PrHistory {
                    urls: Vec<String>,
                }
                match serde_json::from_slice::<PrHistory>(&bytes) {
                    Ok(history) => {
                        let at = fs::metadata(&path)
                            .and_then(|m| m.modified())
                            .ok()
                            .map(|time| {
                                chrono::DateTime::<chrono::Utc>::from(time).timestamp_millis()
                            })
                            .unwrap_or(self.data.recovery_before)
                            .min(self.data.recovery_before);
                        for url in history.urls {
                            if let Err(error) = self.record_pr(&url, at) {
                                errors.push(format!("{error:#}"));
                            }
                        }
                    }
                    Err(error) => errors.push(format!("{}: {error}", path.display())),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => errors.push(format!("{}: {error}", path.display())),
        }
        if errors.is_empty() {
            self.data.recovery_version = VERSION;
        } else {
            self.error = Some(format!(
                "Activity recovery is incomplete (will retry on restart): {}",
                errors.join("; ")
            ));
        }
        let _ = self.save();
    }
}

fn log_files(root: &Path) -> Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            files.extend(log_files(&entry.path())?);
        }
        if kind.is_file() && entry.path().extension().is_some_and(|ext| ext == "jsonl") {
            files.push(entry.path());
        }
    }
    files.sort();
    Ok(files)
}

fn recover_log(path: &Path, before: i64) -> Result<Vec<Work>> {
    let mut work = Vec::<Work>::new();
    let mut open: Option<Work> = None;
    let mut prompt: Option<(String, i64)> = None;
    let mut seen = BTreeSet::new();
    for line in BufReader::new(fs::File::open(path)?).lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        // Do not mark a partial/corrupt file migrated. Other files still recover;
        // after repair this whole file is re-evaluated with stable event IDs.
        let event: AgentEvent =
            serde_json::from_str(&line).context("unreadable event log record")?;
        let at = chrono::DateTime::parse_from_rfc3339(&event.ts)?.timestamp_millis();
        if at >= before || event.subagent.is_some() || !seen.insert(event.id.clone()) {
            continue;
        }
        let key = format!("{}/{}", event.session_id, event.tab_id);
        match &event.payload {
            Payload::UserMessage { queued: false, .. } if open.is_none() => {
                prompt = Some((event.id.clone(), at));
            }
            Payload::AssistantText { .. }
            | Payload::Reasoning { .. }
            | Payload::ToolCallStarted { .. } => {
                if open.is_none() {
                    let (id, start) = prompt.take().unwrap_or((event.id.clone(), at));
                    open = Some(Work {
                        id,
                        key,
                        at: start,
                        duration_ms: 0,
                    });
                }
            }
            Payload::PermissionRequested { .. } | Payload::QuestionsAsked { .. } => {
                if let Some(mut interval) = open.take() {
                    interval.duration_ms = at.saturating_sub(interval.at).max(0) as u64;
                    work.push(interval);
                }
                prompt = None;
            }
            Payload::PermissionDecided {
                automatic: false, ..
            } => {
                // Resumption needs subsequent work evidence, as with a prompt.
                prompt = Some((event.id.clone(), at));
            }
            Payload::TurnCompleted {
                status,
                duration_ms,
                ..
            } => {
                if let Some(mut interval) = open.take() {
                    interval.duration_ms = at.saturating_sub(interval.at).max(0) as u64;
                    if let Some(duration) = duration_ms {
                        interval.duration_ms = interval.duration_ms.min(*duration);
                    }
                    work.push(interval);
                } else if let Some((id, start)) = prompt.take() {
                    // A success can be the only surviving work evidence. Failed
                    // submissions without output/tool evidence do not qualify.
                    if *status == TurnStatus::Ok {
                        let elapsed = at.saturating_sub(start).max(0) as u64;
                        work.push(Work {
                            id,
                            key,
                            at: start,
                            duration_ms: duration_ms.map_or(elapsed, |d| d.min(elapsed)),
                        });
                    }
                }
                prompt = None;
            }
            // TurnStarted carries resume/provider identity in these logs. It
            // is deliberately not used as an activity start.
            _ => {}
        }
    }
    // Work was observed, but no terminating timestamp survived: count the
    // start without inventing time up to migration/restart.
    if let Some(interval) = open {
        work.push(interval);
    }
    Ok(work)
}
