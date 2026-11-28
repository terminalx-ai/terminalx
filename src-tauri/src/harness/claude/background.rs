//! What a Claude Code CLI started that it is still waiting on (#696).
//!
//! A turn can leave work behind that wakes the agent later: a command or an
//! agent run in the background, a Monitor, a wakeup scheduled for its
//! `/loop`, a cron job. Until that comes back the agent sits at its prompt
//! with no turn open and its terminal quiet, just as one with nothing to do,
//! and stopping it then ends the work (its process group goes with it) and
//! the wakeup never comes. The transcript says what was started and what came
//! back; this reads it.
//!
//! Records as Claude Code 2.1.3xx writes them:
//!
//! - an assistant `tool_use` with `input.run_in_background` (Bash, Agent), or
//!   named `Monitor`, starts a task. Its result names it: `toolUseResult`
//!   carries `backgroundTaskId` (or `taskId` for a Monitor). A result with
//!   `backgroundTaskId` and no such input is a command the reader sent to the
//!   background while it ran, and starts one too;
//! - a `<task-notification>` with a final `<status>` ends the task its
//!   `<tool-use-id>` or `<task-id>` names. It comes as a `user` record when
//!   the agent was idle, or as a `queued_command` attachment mid-turn. So
//!   does a `TaskStop` (or `KillShell`) that succeeded;
//! - `ScheduleWakeup` sets the agent's next wakeup `delaySeconds` on, and
//!   `stop: true` cancels it;
//! - `CronCreate` adds a job until a `CronDelete` names it (both results name
//!   it in `toolUseResult.id`). A one-shot job is spent by the next turn the
//!   scheduler starts, and Claude Code lets any job lapse after seven days.
//!
//! Only what this CLI wrote is read ([`Watch`]): the file its tab's tail
//! follows, from where the tail began reading it, and on into the next file
//! when the tail moves (a `/clear` starts one; a resumed conversation can be
//! filed elsewhere than guessed). What a CLI before it left running went
//! with it; the records a fork's file is given as a copy of its parent are
//! the parent's, and skipped as the tail skips them. Sidechain (subagent)
//! records are not the session's own.

use std::collections::{BTreeMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Arc;

use crate::harness::tui::Tail;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How long after a wakeup was due it still counts: the CLI fires it only
/// while its prompt is idle, and a turn it was waiting behind can run long.
const WAKEUP_SLACK: Duration = Duration::minutes(5);
/// Claude Code's own bounds on `ScheduleWakeup`'s `delaySeconds`.
const WAKEUP_RANGE: (i64, i64) = (60, 3600);
/// Claude Code deletes a recurring job after seven days.
const CRON_LIFETIME: Duration = Duration::days(7);
/// Statuses a task notification ends its task with. A Monitor's events in
/// between carry none of these.
const FINAL: &[&str] = &["completed", "failed", "killed", "stopped", "error", "errored", "cancelled", "canceled", "timeout", "timed_out", "expired"];
/// Upper bound on pending automation notifications kept in memory per tab.
const MAX_AUTOMATION_NOTIFICATIONS: usize = 64;

fn default_track_automation() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Task {
    /// The CLI's own id for it, once its result has said.
    id: Option<String>,
    what: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Cron {
    /// The job's id, once its result has said.
    id: Option<String>,
    recurring: bool,
    made: DateTime<Utc>,
}

/// A stop the agent asked for, applied once its result says it worked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum Stopping {
    Task(String),
    Cron(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Notification {
    at: DateTime<Utc>,
    task_id: Option<String>,
    tool_use_id: Option<String>,
    previous_message: Option<String>,
    delivered_at: Option<DateTime<Utc>>,
    response: Option<(DateTime<Utc>, String)>,
}

impl Notification {
    fn matches(&self, text: &str) -> bool {
        text.split("<task-notification>").skip(1).any(|block| {
            let block = block.split("</task-notification>").next().unwrap_or(block);
            self.task_id.as_deref().is_some_and(|id| tagged(block, "task-id") == Some(id))
                || self.tool_use_id.as_deref().is_some_and(|id| tagged(block, "tool-use-id") == Some(id))
        })
    }
}

fn same_notification(prompt: &str, rendered: &str) -> bool {
    rendered.contains("<task-notification>") && (
        tagged(prompt, "task-id").is_some_and(|id| tagged(rendered, "task-id") == Some(id))
        || tagged(prompt, "tool-use-id").is_some_and(|id| tagged(rendered, "tool-use-id") == Some(id))
    )
}

/// What one CLI started and has not heard back from, by the tool use that
/// started each.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ledger {
    tasks: BTreeMap<String, Task>,
    crons: BTreeMap<String, Cron>,
    stopping: BTreeMap<String, Stopping>,
    /// When the wakeup it scheduled last is due.
    wakeup: Option<DateTime<Utc>>,
    /// Whether this tab tracks automation notifications. Interactive tabs leave
    /// this off so completed background tasks never accumulate unboundedly.
    #[serde(default = "default_track_automation")]
    track_automation: bool,
    /// A task ended, but the agent has yet to finish a turn that took its notification.
    automation_notifications: Vec<Notification>,
    last_assistant_id: Option<String>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self::for_tab(true)
    }
}

impl Ledger {
    pub fn for_tab(track_automation: bool) -> Self {
        Self {
            tasks: BTreeMap::new(),
            crons: BTreeMap::new(),
            stopping: BTreeMap::new(),
            wakeup: None,
            track_automation,
            automation_notifications: Vec::new(),
            last_assistant_id: None,
        }
    }

    /// Take in one transcript record.
    #[cfg(test)]
    pub fn read(&mut self, line: &str) {
        self.read_skipping(line, &HashSet::new());
    }

    /// Take in one transcript record, unless its uuid is in `skip`.
    pub fn read_skipping(&mut self, line: &str, skip: &HashSet<String>) {
        let Ok(record) = serde_json::from_str::<Value>(line) else { return };
        self.read_value_skipping(&record, skip);
    }

    /// Take in one already-parsed transcript record, unless its uuid is in `skip`.
    pub fn read_value_skipping(&mut self, record: &Value, skip: &HashSet<String>) {
        if record["isSidechain"].as_bool() == Some(true) || record["uuid"].as_str().is_some_and(|uuid| skip.contains(uuid)) {
            return;
        }
        let at = record["timestamp"].as_str().and_then(|at| DateTime::parse_from_rfc3339(at).ok()).map_or_else(Utc::now, |at| at.with_timezone(&Utc));
        let parts = record["message"]["content"].as_array().map(Vec::as_slice).unwrap_or_default();
        match record["type"].as_str() {
            Some("assistant") => {
                let id = record["message"]["id"].as_str();
                if let Some(id) = id {
                    if !self.automation_notifications.is_empty()
                        && self.automation_notifications.iter().any(|notice| notice.previous_message.as_deref().is_some_and(|old| old != id))
                    {
                        let text = text_of(&record["message"]["content"]);
                        if !text.is_empty() {
                            for notice in &mut self.automation_notifications {
                                if notice.previous_message.as_deref().is_some_and(|old| old != id) {
                                    notice.response = Some((at, text.clone()));
                                }
                            }
                        }
                    }
                    self.last_assistant_id = Some(id.to_string());
                }
                for part in parts.iter().filter(|part| part["type"] == "tool_use") {
                    self.tool_use(part, at);
                }
            }
            Some("user") => {
                let results: Vec<&Value> = parts.iter().filter(|part| part["type"] == "tool_result").collect();
                // The structured result is the record's, and a record holds one.
                let structured = if results.len() == 1 { &record["toolUseResult"] } else { &Value::Null };
                for part in &results {
                    self.tool_result(part, structured);
                }
                if results.is_empty() {
                    let content = text_of(&record["message"]["content"]);
                    self.notifications(&content, at, |_| true);
                    for notice in &mut self.automation_notifications {
                        if !notice.matches(&content) { continue; }
                        notice.delivered_at = Some(at);
                    }
                    let origin = record["turnOrigin"].as_str().or_else(|| record["origin"]["kind"].as_str());
                    if origin == Some("scheduled") {
                        self.scheduled_turn(at);
                    }
                }
            }
            Some("attachment") if record["attachment"]["type"] == "queued_command" => {
                let prompt = text_of(&record["attachment"]["prompt"]);
                self.notifications(&prompt, at, |block| record["rendered"].as_array().is_some_and(|parts| parts.iter().any(|part| {
                    part["content"].as_str().is_some_and(|text| same_notification(block, text))
                })));
            }
            _ => {}
        }
    }

    fn note_notification(&mut self, at: DateTime<Utc>, content: &str, delivered_in_turn: bool) {
        if !self.track_automation {
            return;
        }
        if self.automation_notifications.len() >= MAX_AUTOMATION_NOTIFICATIONS {
            let drop_count = self.automation_notifications.len() - MAX_AUTOMATION_NOTIFICATIONS + 1;
            self.automation_notifications.drain(..drop_count);
        }
        self.automation_notifications.push(Notification { at, task_id: tagged(content, "task-id").map(str::to_owned), tool_use_id: tagged(content, "tool-use-id").map(str::to_owned), previous_message: self.last_assistant_id.clone(), delivered_at: delivered_in_turn.then_some(at), response: None });
    }

    fn tool_use(&mut self, part: &Value, at: DateTime<Utc>) {
        let (Some(id), Some(name)) = (part["id"].as_str(), part["name"].as_str()) else { return };
        let input = &part["input"];
        match name {
            "ScheduleWakeup" if input["stop"].as_bool() == Some(true) => self.wakeup = None,
            "ScheduleWakeup" => {
                let delay = input["delaySeconds"].as_f64().unwrap_or(WAKEUP_RANGE.1 as f64) as i64;
                self.wakeup = Some(at + Duration::seconds(delay.clamp(WAKEUP_RANGE.0, WAKEUP_RANGE.1)));
            }
            "CronCreate" => {
                self.crons.insert(id.into(), Cron { id: None, recurring: input["recurring"].as_bool() != Some(false), made: at });
            }
            "CronDelete" => {
                if let Some(job) = input["id"].as_str() {
                    self.stopping.insert(id.into(), Stopping::Cron(job.into()));
                }
            }
            "TaskStop" | "KillShell" => {
                if let Some(task) = input["task_id"].as_str().or_else(|| input["shell_id"].as_str()) {
                    self.stopping.insert(id.into(), Stopping::Task(task.into()));
                }
            }
            "Monitor" => {
                self.tasks.insert(id.into(), Task { id: None, what: "a monitor".into() });
            }
            _ if input["run_in_background"].as_bool() == Some(true) => {
                let what = if name == "Bash" { "a background command" } else { "a background agent" };
                self.tasks.insert(id.into(), Task { id: None, what: what.into() });
            }
            _ => {}
        }
    }

    fn tool_result(&mut self, part: &Value, structured: &Value) {
        let Some(id) = part["tool_use_id"].as_str() else { return };
        let failed = part["is_error"].as_bool() == Some(true);
        let task_id = structured["backgroundTaskId"].as_str().or_else(|| structured["taskId"].as_str());
        match self.tasks.get_mut(id) {
            Some(_) if failed => {
                self.tasks.remove(id);
            }
            Some(task) => {
                if let Some(task_id) = task_id {
                    task.id = Some(task_id.into());
                }
            }
            // Sent to the background while it ran.
            None if !failed && structured["backgroundTaskId"].is_string() => {
                self.tasks.insert(id.into(), Task { id: task_id.map(String::from), what: "a background command".into() });
            }
            None => {}
        }
        match self.crons.get_mut(id) {
            Some(_) if failed => {
                self.crons.remove(id);
            }
            Some(cron) => {
                if let Some(job) = structured["id"].as_str() {
                    cron.id = Some(job.into());
                }
            }
            None => {}
        }
        match self.stopping.remove(id) {
            Some(Stopping::Task(task)) if !failed => self.tasks.retain(|_, known| known.id.as_deref() != Some(task.as_str())),
            Some(Stopping::Cron(job)) if !failed => self.crons.retain(|_, known| known.id.as_deref() != Some(job.as_str())),
            _ => {}
        }
    }

    /// Each `<task-notification>` in `text` with a final status ends its task.
    fn notifications(&mut self, text: &str, at: DateTime<Utc>, delivered: impl Fn(&str) -> bool) -> bool {
        let mut matched = false;
        for block in text.split("<task-notification>").skip(1) {
            let block = block.split("</task-notification>").next().unwrap_or(block);
            let status = tagged(block, "status").map(str::to_ascii_lowercase);
            if !status.is_some_and(|status| FINAL.contains(&status.as_str())) {
                continue;
            }
            let (tool_use, task) = (tagged(block, "tool-use-id"), tagged(block, "task-id"));
            let before = self.tasks.len();
            self.tasks.retain(|key, known| Some(key.as_str()) != tool_use && (task.is_none() || known.id.as_deref() != task));
            if self.tasks.len() != before {
                let complete = format!("<task-notification>{block}</task-notification>");
                self.note_notification(at, &complete, delivered(&complete));
                matched = true;
            }
        }
        matched
    }

    /// The scheduler started a turn: the oldest one-shot job made before it
    /// was what it fired.
    fn scheduled_turn(&mut self, at: DateTime<Utc>) {
        let fired = self.crons.iter().filter(|(_, cron)| !cron.recurring && cron.made <= at).min_by_key(|(_, cron)| cron.made).map(|(key, _)| key.clone());
        if let Some(key) = fired {
            self.crons.remove(&key);
        }
    }

    /// What the CLI is still waiting on at `now`, in a few words; `None` when
    /// nothing.
    pub fn outstanding(&self, now: DateTime<Utc>) -> Option<String> {
        if let Some(task) = self.tasks.values().next() {
            return Some(match self.tasks.len() {
                1 => format!("{} it has not heard back from", task.what),
                n => format!("{n} background tasks it has not heard back from"),
            });
        }
        if self.wakeup.is_some_and(|due| now < due + WAKEUP_SLACK) {
            return Some("a wakeup it scheduled".into());
        }
        let jobs = self.crons.values().filter(|cron| now < cron.made + CRON_LIFETIME).count();
        match jobs {
            0 => None,
            1 => Some("a scheduled job".into()),
            n => Some(format!("{n} scheduled jobs")),
        }
    }

    fn automation_outstanding(&self, now: DateTime<Utc>) -> Option<String> {
        self.outstanding(now).or_else(|| (!self.automation_notifications.is_empty()).then(|| "a background notification awaiting the agent".into()))
    }
}

/// The text of a tag's first occurrence in `block`, trimmed.
fn tagged<'a>(block: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = block.find(&open)? + open.len();
    let end = block[start..].find(&format!("</{tag}>"))? + start;
    Some(block[start..end].trim())
}

#[cfg(test)]
thread_local! {
    static TEXT_OF_CALLS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static WATCH_DISK_READS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// A message's text: a string, or its text parts joined.
fn text_of(content: &Value) -> String {
    #[cfg(test)]
    TEXT_OF_CALLS.with(|count| count.set(count.get() + 1));
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts.iter().filter_map(|part| part["text"].as_str().or_else(|| part.as_str())).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

/// A [`Ledger`] kept up with what a CLI writes: the file its tab's tail
/// follows, read on from where it was last looked at.
pub struct Watch {
    tail: Arc<Tail>,
    /// The file read, and where the tail began reading it: the pair that
    /// says when the tail has moved on.
    aimed: (PathBuf, u64),
    offset: u64,
    /// A line the CLI had not finished writing at the last look.
    partial: Vec<u8>,
    /// Records copied in from another conversation (a fork's parent).
    skip: HashSet<String>,
    ledger: Ledger,
}

/// The cursor and ledger must move together: replaying from the launch would
/// recreate notifications that a completed turn already acknowledged.
#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct WatchRecord {
    aimed: (PathBuf, u64),
    offset: u64,
    partial: Vec<u8>,
    skip: HashSet<String>,
    ledger: Ledger,
}

impl Watch {
    /// Keep up with `tail` from where it stands: where its CLI was started.
    pub fn new(tail: Arc<Tail>) -> Self {
        Self::for_tab(tail, true)
    }

    /// Keep up with `tail`, tracking automation notifications only when
    /// `track_automation` is set.
    pub fn for_tab(tail: Arc<Tail>, track_automation: bool) -> Self {
        let aimed = tail.reading();
        let skip = tail.carried();
        Self { offset: aimed.1, aimed, tail, partial: Vec::new(), skip, ledger: Ledger::for_tab(track_automation) }
    }

    /// Wire `watch` onto `tail` so parsed JSON records from `Tail::drain_records`
    /// feed the ledger directly without re-reading or re-parsing the transcript.
    pub(crate) fn attach_to_tail(watch: &Arc<std::sync::Mutex<Self>>, tail: &Arc<Tail>) {
        let weak = Arc::downgrade(watch);
        tail.set_observer(Arc::new(move |path, began, skip, lines| {
            if let Some(watch) = weak.upgrade() {
                if let Ok(mut guard) = watch.lock() {
                    guard.ingest_from_tail(path, began, skip, lines);
                }
            }
        }));
    }

    pub fn enable_automation_tracking(&mut self) {
        self.ledger.track_automation = true;
    }

    pub fn ingest_from_tail(&mut self, path: &std::path::Path, began: u64, skip: &HashSet<String>, lines: &[crate::harness::tui::ObservedLine]) {
        if self.aimed.0 != path || self.aimed.1 != began || !self.partial.is_empty() {
            return;
        }
        for (line_start, line_end, record) in lines {
            if *line_end <= self.offset {
                continue;
            }
            if *line_start != self.offset {
                break;
            }
            if let Some(value) = record {
                self.ledger.read_value_skipping(value, skip);
            }
            self.offset = *line_end;
        }
    }

    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn handover(&self) -> WatchRecord {
        WatchRecord { aimed: self.aimed.clone(), offset: self.offset, partial: self.partial.clone(), skip: self.skip.clone(), ledger: self.ledger.clone() }
    }

    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn from_handover(tail: Arc<Tail>, record: WatchRecord) -> Self {
        Self { tail, aimed: record.aimed, offset: record.offset, partial: record.partial, skip: record.skip, ledger: record.ledger }
    }

    /// Read what the CLI has written since the last look; what it is still
    /// waiting on at `now`. A transcript that cannot be read leaves what was
    /// known as it was.
    pub fn outstanding(&mut self, now: DateTime<Utc>) -> Option<String> {
        if let Err(error) = self.catch_up() {
            log::debug!("read {} for background work: {error}", self.aimed.0.display());
        }
        self.ledger.outstanding(now)
    }

    pub fn automation_outstanding(&mut self, now: DateTime<Utc>) -> Option<String> {
        self.ledger.track_automation = true;
        if let Err(error) = self.catch_up() {
            log::debug!("read {} for automation work: {error}", self.aimed.0.display());
            return Some("background state could not be read".into());
        }
        self.ledger.automation_outstanding(now)
    }

    /// A later turn, or a new model response in the current turn after the
    /// notification, proves that the queued report was taken. The reply must
    /// belong to this completed turn, not a transcript written later.
    pub fn automation_turn_completed(&mut self, started: Option<DateTime<Utc>>, finished: DateTime<Utc>, final_message: Option<&str>) {
        if !self.ledger.track_automation {
            return;
        }
        if self.catch_up().is_err() { return; }
        self.ledger.automation_notifications.retain(|notice| {
            !(notice.delivered_at.is_some_and(|delivered| delivered + chrono::TimeDelta::milliseconds(1) < finished) && (started.is_some_and(|start| notice.at < start)
                || notice.response.as_ref().is_some_and(|(at, text)| *at >= notice.at && *at + chrono::TimeDelta::milliseconds(1) < finished && Some(text.as_str()) == final_message)))
        });
    }

    fn catch_up(&mut self) -> std::io::Result<()> {
        let now = self.tail.reading();
        if now != self.aimed {
            // The rest of the file it left first: what it wrote there just
            // before it moved on is still its own. Then the new one, from where
            // the tail began it. What was started stays started: it is the same
            // CLI, and a task may report in to the next file.
            self.read_on()?;
            self.partial.clear();
            self.offset = now.1;
            self.skip = self.tail.carried();
            self.aimed = now;
        }
        self.read_on()
    }

    fn read_on(&mut self) -> std::io::Result<()> {
        let path = &self.aimed.0;
        if path.as_os_str().is_empty() {
            return Ok(());
        }
        let mut file = match std::fs::File::open(path) {
            Ok(file) => file,
            // Not written yet: the CLI writes it with its first prompt.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        if file.metadata()?.len() <= self.offset {
            return Ok(());
        }
        #[cfg(test)]
        WATCH_DISK_READS.with(|count| count.set(count.get() + 1));
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        self.offset += bytes.len() as u64;
        self.partial.extend_from_slice(&bytes);
        let mut start = 0;
        while let Some(rel) = self.partial[start..].iter().position(|&byte| byte == b'\n') {
            let end = start + rel;
            let line = &self.partial[start..end];
            start = end + 1;
            if !line.is_empty() {
                self.ledger.read_skipping(&String::from_utf8_lossy(line), &self.skip);
            }
        }
        if start > 0 {
            self.partial.drain(..start);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const AT: &str = "2026-11-01T14:00:00.000Z";

    fn at(offset_minutes: i64) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(AT).unwrap().with_timezone(&Utc) + Duration::minutes(offset_minutes)
    }

    fn tool_use(id: &str, name: &str, input: Value) -> String {
        serde_json::json!({ "type": "assistant", "timestamp": AT, "message": { "role": "assistant", "content": [{ "type": "tool_use", "id": id, "name": name, "input": input }] } }).to_string()
    }

    fn tool_result(id: &str, text: &str, structured: Value, error: bool) -> String {
        serde_json::json!({ "type": "user", "timestamp": AT, "message": { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": id, "content": text, "is_error": error }] }, "toolUseResult": structured }).to_string()
    }

    fn notification(task: &str, tool_use: &str, status: &str) -> String {
        format!("<task-notification>\n<task-id>{task}</task-id>\n<tool-use-id>{tool_use}</tool-use-id>\n<output-file>/tmp/tasks/{task}.output</output-file>\n<status>{status}</status>\n<summary>Background command \"Watch the CI run\" {status}</summary>\n</task-notification>")
    }

    /// Mid-turn, as the CLI hands it over with the next tool result.
    fn queued(text: &str) -> String {
        serde_json::json!({ "type": "attachment", "timestamp": AT, "attachment": { "type": "queued_command", "prompt": text, "commandMode": "task-notification" } }).to_string()
    }

    /// With the agent idle, as the record of the turn it starts.
    fn reported(text: &str) -> String {
        serde_json::json!({ "type": "user", "timestamp": AT, "turnOrigin": "task_notification", "origin": { "kind": "task-notification" }, "message": { "role": "user", "content": text } }).to_string()
    }

    fn ledger(lines: &[String]) -> Ledger {
        let mut ledger = Ledger::default();
        for line in lines {
            ledger.read(line);
        }
        ledger
    }

    /// The review's case: a 40-minute CI watch run in the background, its
    /// turn over. Waited on until it reports in, whichever way that comes.
    #[test]
    fn a_background_command_is_waited_on_until_it_reports_in() {
        let started = [
            tool_use("toolu_ci", "Bash", serde_json::json!({ "command": "gh run watch 123", "run_in_background": true, "description": "Watch the CI run" })),
            tool_result("toolu_ci", "Command running in background with ID: b3a8zex3u. Output is being written to: /tmp/tasks/b3a8zex3u.output", serde_json::json!({ "stdout": "", "backgroundTaskId": "b3a8zex3u" }), false),
        ];
        assert_eq!(ledger(&started).outstanding(at(30)).as_deref(), Some("a background command it has not heard back from"));
        for report in [queued(&notification("b3a8zex3u", "toolu_ci", "completed")), reported(&notification("b3a8zex3u", "toolu_ci", "failed"))] {
            let mut lines = started.to_vec();
            lines.push(report);
            assert_eq!(ledger(&lines).outstanding(at(30)), None);
        }
        // Matched by its task id alone, when that is all a notification names.
        let mut lines = started.to_vec();
        lines.push(queued("<task-notification><task-id>b3a8zex3u</task-id><status>killed</status></task-notification>"));
        assert_eq!(ledger(&lines).outstanding(at(30)), None);
    }

    #[test]
    fn automation_waits_for_a_turn_to_handle_the_queued_notification() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conversation.jsonl");
        let mut watch = Watch::new(tail(&path, HashSet::new()));
        append(&path, &[
            tool_use("toolu_ci", "Bash", serde_json::json!({ "run_in_background": true })),
            tool_result("toolu_ci", "running", serde_json::json!({ "backgroundTaskId": "bci" }), false),
            queued(&notification("bci", "toolu_ci", "failed")),
        ]);
        assert!(watch.outstanding(at(30)).is_none());
        assert!(watch.automation_outstanding(at(30)).is_some());
        // Even a very long delay and the end of the preceding turn do not
        // prove the queued notification was taken.
        watch.automation_turn_completed(Some(at(-1)), at(0), Some("Interim"));
        assert!(watch.automation_outstanding(at(600)).is_some());
        let mut delivery: Value = serde_json::from_str(&reported(&notification("bci", "toolu_ci", "failed"))).unwrap();
        delivery["timestamp"] = at(2).to_rfc3339().into();
        append(&path, &[delivery.to_string()]);
        watch.automation_turn_completed(Some(at(1)), at(1) + chrono::TimeDelta::seconds(30), Some("Earlier turn"));
        assert!(watch.automation_outstanding(at(600)).is_some(), "a later delivery cannot settle an earlier turn");
        watch.automation_turn_completed(Some(at(3)), at(4), Some("Final"));
        assert!(watch.automation_outstanding(at(600)).is_none());
    }

    #[test]
    fn handover_keeps_acknowledged_and_pending_notifications_distinct() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conversation.jsonl");
        let tail = tail(&path, HashSet::new());
        let mut watch = Watch::new(tail.clone());
        let first = notification("b1", "t1", "completed");
        append(&path, &[
            tool_use("t1", "Bash", serde_json::json!({ "run_in_background": true })),
            tool_result("t1", "running", serde_json::json!({ "backgroundTaskId": "b1" }), false),
            reported(&first),
        ]);
        watch.automation_turn_completed(Some(at(1)), at(2), Some("Handled"));
        assert!(watch.automation_outstanding(at(2)).is_none());
        let record = watch.handover();
        let record = serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        let mut adopted = Watch::from_handover(tail.clone(), record);
        assert!(adopted.automation_outstanding(at(100)).is_none(), "handover must not recreate the handled report");

        let second = notification("b2", "t2", "failed");
        append(&path, &[
            tool_use("t2", "Bash", serde_json::json!({ "run_in_background": true })),
            tool_result("t2", "running", serde_json::json!({ "backgroundTaskId": "b2" }), false),
            queued(&second),
        ]);
        let record = adopted.handover();
        let mut adopted = Watch::from_handover(tail, record);
        assert!(adopted.automation_outstanding(at(100)).is_some(), "an unhandled report must survive handover");
        append(&path, &[reported(&second)]);
        adopted.automation_turn_completed(Some(at(3)), at(4), Some("Handled failure"));
        assert!(adopted.automation_outstanding(at(100)).is_none());
    }

    #[test]
    fn handover_preserves_an_unfinished_transcript_record() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conversation.jsonl");
        let tail = tail(&path, HashSet::new());
        let mut watch = Watch::new(tail.clone());
        let line = format!("{}\n", background("partial"));
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(&line.as_bytes()[..20]).unwrap();
        assert!(watch.automation_outstanding(at(1)).is_none());
        let record = watch.handover();
        let mut adopted = Watch::from_handover(tail, serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap());
        assert!(adopted.automation_outstanding(at(1)).is_none());
        file.write_all(&line.as_bytes()[20..]).unwrap();
        assert!(adopted.automation_outstanding(at(1)).is_some());
    }

    #[test]
    fn notification_handled_within_a_turn_requires_a_new_completed_reply() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conversation.jsonl");
        let mut watch = Watch::new(tail(&path, HashSet::new()));
        let report = notification("bci", "ci", "failed");
        let mut delivered: Value = serde_json::from_str(&queued(&report)).unwrap();
        delivered["rendered"] = serde_json::json!([{ "content": report }]);
        append(&path, &[
            serde_json::json!({ "type": "assistant", "timestamp": AT, "message": { "id": "before", "content": [{ "type": "tool_use", "id": "ci", "name": "Bash", "input": { "run_in_background": true } }] } }).to_string(),
            tool_result("ci", "running", serde_json::json!({ "backgroundTaskId": "bci" }), false),
            delivered.to_string(),
        ]);
        watch.automation_turn_completed(Some(at(-1)), at(1), Some("Interim"));
        assert!(watch.automation_outstanding(at(100)).is_some());
        append(&path, &[serde_json::json!({ "type": "assistant", "timestamp": "2026-11-01T14:02:00Z", "message": { "id": "after", "content": [{ "type": "text", "text": "Handled failure" }] } }).to_string()]);
        // A callback belonging to an older turn cannot consume a later reply.
        watch.automation_turn_completed(Some(at(-1)), at(1), Some("Handled failure"));
        assert!(watch.automation_outstanding(at(100)).is_some());
        watch.automation_turn_completed(Some(at(-1)), at(3), Some("Handled failure"));
        assert!(watch.automation_outstanding(at(100)).is_none());

        let other = dir.path().join("queued.jsonl");
        let mut queued_watch = Watch::new(tail(&other, HashSet::new()));
        append(&other, &[
            serde_json::json!({ "type": "assistant", "timestamp": AT, "message": { "id": "before", "content": [{ "type": "tool_use", "id": "ci", "name": "Bash", "input": { "run_in_background": true } }] } }).to_string(),
            tool_result("ci", "running", serde_json::json!({ "backgroundTaskId": "bci" }), false),
            queued(&notification("bci", "ci", "failed")),
            serde_json::json!({ "type": "assistant", "timestamp": "2026-11-01T14:02:00Z", "message": { "id": "after", "content": [{ "type": "text", "text": "Interim" }] } }).to_string(),
        ]);
        queued_watch.automation_turn_completed(Some(at(-1)), at(3), Some("Interim"));
        assert!(queued_watch.automation_outstanding(at(100)).is_some(), "a queued report without delivery evidence remains pending");
    }

    #[test]
    fn each_queued_notification_must_be_delivered() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conversation.jsonl");
        let mut watch = Watch::new(tail(&path, HashSet::new()));
        let first = notification("b1", "t1", "completed");
        let second = notification("b2", "t2", "failed");
        append(&path, &[
            tool_use("t1", "Bash", serde_json::json!({ "run_in_background": true })),
            tool_result("t1", "running", serde_json::json!({ "backgroundTaskId": "b1" }), false),
            tool_use("t2", "Bash", serde_json::json!({ "run_in_background": true })),
            tool_result("t2", "running", serde_json::json!({ "backgroundTaskId": "b2" }), false),
            queued(&format!("{first}{second}")),
            reported(&first),
        ]);
        watch.automation_turn_completed(Some(at(1)), at(2), Some("First handled"));
        assert!(watch.automation_outstanding(at(100)).is_some());
        append(&path, &[reported(&second)]);
        watch.automation_turn_completed(Some(at(3)), at(4), Some("Both handled"));
        assert!(watch.automation_outstanding(at(100)).is_none());
    }

    /// A Monitor's events report in without ending it; its end does.
    #[test]
    fn a_monitor_is_waited_on_through_its_events_until_its_stream_ends() {
        let mut lines = vec![
            tool_use("toolu_mon", "Monitor", serde_json::json!({ "description": "deploy log", "timeout_ms": 1_800_000, "command": "tail -f deploy.log" })),
            tool_result("toolu_mon", "Monitor started (task bbko5vubn, expires in 30m)", serde_json::json!({ "taskId": "bbko5vubn", "timeoutMs": 1_800_000, "persistent": false }), false),
            reported("<task-notification>\n<task-id>bbko5vubn</task-id>\n<tool-use-id>toolu_mon</tool-use-id>\n<event>ERROR deploy failed</event>\n</task-notification>"),
        ];
        assert_eq!(ledger(&lines).outstanding(at(10)).as_deref(), Some("a monitor it has not heard back from"));
        lines.push(queued(&notification("bbko5vubn", "toolu_mon", "completed")));
        assert_eq!(ledger(&lines).outstanding(at(10)), None);
    }

    #[test]
    fn a_task_the_agent_stopped_or_that_never_started_is_not_waited_on() {
        let started = |id: &str, task: &str| {
            vec![
                tool_use(id, "Bash", serde_json::json!({ "command": "npm run dev", "run_in_background": true })),
                tool_result(id, "running", serde_json::json!({ "backgroundTaskId": task }), false),
            ]
        };
        let mut lines = started("toolu_dev", "bdev");
        lines.push(tool_use("toolu_stop", "TaskStop", serde_json::json!({ "task_id": "bdev" })));
        assert!(ledger(&lines).outstanding(at(1)).is_some(), "not stopped until its result says so");
        lines.push(tool_result("toolu_stop", "Successfully stopped task bdev", Value::Null, false));
        assert_eq!(ledger(&lines).outstanding(at(1)), None);

        // A stop that failed leaves it running.
        let mut failed = started("toolu_dev", "bdev");
        failed.push(tool_use("toolu_stop", "KillShell", serde_json::json!({ "shell_id": "bdev" })));
        failed.push(tool_result("toolu_stop", "No such task", Value::Null, true));
        assert!(ledger(&failed).outstanding(at(1)).is_some());

        // Refused before it began.
        let refused = [tool_use("toolu_x", "Bash", serde_json::json!({ "command": "x", "run_in_background": true })), tool_result("toolu_x", "Permission denied", Value::Null, true)];
        assert_eq!(ledger(&refused).outstanding(at(1)), None);

        // Sent to the background by the reader while it ran: started all the same.
        let backgrounded = [tool_use("toolu_b", "Bash", serde_json::json!({ "command": "cargo build" })), tool_result("toolu_b", "Command was moved to the background with ID: bmoved", serde_json::json!({ "backgroundTaskId": "bmoved" }), false)];
        assert!(ledger(&backgrounded).outstanding(at(1)).is_some());

        // Two at once are said as such; a subagent's own are not the session's.
        let mut two = started("toolu_1", "b1");
        two.extend(started("toolu_2", "b2"));
        two.push(tool_use("toolu_3", "Agent", serde_json::json!({ "prompt": "x", "run_in_background": true })).replace("\"type\":\"assistant\"", "\"type\":\"assistant\",\"isSidechain\":true"));
        assert_eq!(ledger(&two).outstanding(at(1)).as_deref(), Some("2 background tasks it has not heard back from"));
    }

    /// The review's other case: a `/loop` sleeping for ScheduleWakeup's
    /// longest, an hour, is not stopped just before it wakes.
    #[test]
    fn a_scheduled_wakeup_is_waited_for_until_a_while_after_it_was_due() {
        let lines = [tool_use("toolu_w", "ScheduleWakeup", serde_json::json!({ "delaySeconds": 3600, "prompt": "<<autonomous-loop-dynamic>>", "reason": "waiting for CI" }))];
        let waiting = ledger(&lines);
        assert_eq!(waiting.outstanding(at(59)).as_deref(), Some("a wakeup it scheduled"));
        assert_eq!(waiting.outstanding(at(64)).as_deref(), Some("a wakeup it scheduled"));
        // Long past it, with no new one: the loop is over.
        assert_eq!(waiting.outstanding(at(66)), None);
        // Asked for longer than the CLI allows, it is the CLI's longest.
        assert_eq!(ledger(&[tool_use("toolu_w", "ScheduleWakeup", serde_json::json!({ "delaySeconds": 86_400 }))]).outstanding(at(66)), None);
        // Ended by the agent.
        let mut ended = lines.to_vec();
        ended.push(tool_use("toolu_s", "ScheduleWakeup", serde_json::json!({ "stop": true })));
        assert_eq!(ledger(&ended).outstanding(at(10)), None);
    }

    #[test]
    fn a_cron_job_is_kept_until_deleted_spent_or_lapsed() {
        let made = |id: &str, job: &str, recurring: bool| {
            vec![
                tool_use(id, "CronCreate", serde_json::json!({ "cron": "7 * * * *", "prompt": "check the deploy", "recurring": recurring })),
                tool_result(id, &format!("Scheduled job {job}"), serde_json::json!({ "id": job }), false),
            ]
        };
        let mut lines = made("toolu_c", "cbb8efe7", true);
        assert_eq!(ledger(&lines).outstanding(at(600)).as_deref(), Some("a scheduled job"));
        assert_eq!(ledger(&lines).outstanding(at(8 * 24 * 60)), None, "lapsed after seven days");
        lines.extend([tool_use("toolu_d", "CronDelete", serde_json::json!({ "id": "cbb8efe7" })), tool_result("toolu_d", "Cancelled job cbb8efe7.", serde_json::json!({ "id": "cbb8efe7" }), false)]);
        assert_eq!(ledger(&lines).outstanding(at(1)), None);

        // A one-shot job is spent by the turn the scheduler starts for it.
        let mut once = made("toolu_o", "c0ne", false);
        assert!(ledger(&once).outstanding(at(1)).is_some());
        once.push(serde_json::json!({ "type": "user", "timestamp": "2026-11-01T15:00:00.000Z", "turnOrigin": "scheduled", "message": { "role": "user", "content": "check the deploy" } }).to_string());
        assert_eq!(ledger(&once).outstanding(at(61)), None);
    }

    fn tail(path: &std::path::Path, carried: HashSet<String>) -> Arc<Tail> {
        Arc::new(Tail::opening(path.to_path_buf(), super::super::transcript::decode_line, carried))
    }

    fn append(path: &std::path::Path, lines: &[String]) {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap();
        for line in lines {
            file.write_all(format!("{line}\n").as_bytes()).unwrap();
        }
    }

    fn uuid(line: String, uuid: &str) -> String {
        let mut record: Value = serde_json::from_str(&line).unwrap();
        record["uuid"] = uuid.into();
        record.to_string()
    }

    fn background(id: &str) -> String {
        tool_use(id, "Bash", serde_json::json!({ "command": "gh run watch", "run_in_background": true }))
    }

    /// Read on from where the CLI was started, a line at a time as it lands.
    #[test]
    fn a_watch_reads_only_what_its_cli_wrote_and_picks_up_where_it_left_off() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conversation.jsonl");
        // Left by the CLI before: its background command died with it.
        append(&path, &[background("toolu_old")]);
        let mut watch = Watch::new(tail(&path, HashSet::new()));
        assert_eq!(watch.outstanding(at(1)), None);

        let started = format!("{}\n", background("toolu_new"));
        let mut file = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        // Half a line: not read until it is whole.
        file.write_all(&started.as_bytes()[..20]).unwrap();
        assert_eq!(watch.outstanding(at(1)), None);
        file.write_all(&started.as_bytes()[20..]).unwrap();
        assert!(watch.outstanding(at(1)).is_some());
        append(&path, &[queued(&notification("bnew", "toolu_new", "completed"))]);
        assert_eq!(watch.outstanding(at(1)), None);

        // A transcript not written yet has nothing in it.
        assert_eq!(Watch::new(tail(&dir.path().join("none.jsonl"), HashSet::new())).outstanding(at(1)), None);
    }

    /// The second review's case: `/clear` starts a new file and the tail
    /// follows it. What the CLI starts there is read there; what it wrote to
    /// the old file just before is not lost; and a task started before can
    /// report in to the new file.
    #[test]
    fn a_watch_follows_its_tail_to_the_file_a_clear_opens() {
        let dir = tempfile::tempdir().unwrap();
        let (first, cleared) = (dir.path().join("first.jsonl"), dir.path().join("cleared.jsonl"));
        let tail = tail(&first, HashSet::new());
        let mut watch = Watch::new(tail.clone());
        append(&first, &[background("toolu_before")]);
        assert!(watch.outstanding(at(1)).is_some());
        // Written to the old file, unread, as the CLI moved on.
        append(&first, &[background("toolu_last")]);
        tail.retarget(&cleared);
        append(&cleared, &[background("toolu_after")]);
        assert_eq!(watch.outstanding(at(1)).as_deref(), Some("3 background tasks it has not heard back from"));
        append(&cleared, &[
            queued(&notification("b1", "toolu_before", "completed")),
            queued(&notification("b2", "toolu_last", "completed")),
            queued(&notification("b3", "toolu_after", "completed")),
        ]);
        assert_eq!(watch.outstanding(at(1)), None);
        // And on, in the new file.
        append(&cleared, &[tool_use("toolu_w", "ScheduleWakeup", serde_json::json!({ "delaySeconds": 1800 }))]);
        assert_eq!(watch.outstanding(at(10)).as_deref(), Some("a wakeup it scheduled"));
    }

    /// The second review's other case: a fork's new file is given a copy of
    /// its parent, under the parent's uuids. What the parent started there is
    /// the parent's, not this CLI's.
    #[test]
    fn a_forks_copy_of_its_parent_is_not_what_its_cli_started() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fork.jsonl");
        let carried = HashSet::from(["p-1".to_string(), "p-2".to_string()]);
        let mut watch = Watch::new(tail(&path, carried));
        append(&path, &[
            uuid(background("toolu_parent"), "p-1"),
            uuid(tool_use("toolu_cron", "CronCreate", serde_json::json!({ "cron": "7 * * * *", "prompt": "check" })), "p-2"),
        ]);
        assert_eq!(watch.outstanding(at(1)), None);
        append(&path, &[uuid(background("toolu_own"), "f-1")]);
        assert_eq!(watch.outstanding(at(1)).as_deref(), Some("a background command it has not heard back from"));
    }

    #[test]
    fn interactive_tab_skips_automation_notifications_and_automation_tab_caps_and_hoists_text() {
        // Interactive tab (`track_automation = false`): never retains notifications.
        let mut interactive = Ledger::for_tab(false);
        for i in 0..10 {
            let tool = format!("t_{i}");
            let task = format!("b_{i}");
            interactive.read(&tool_use(&tool, "Bash", serde_json::json!({ "run_in_background": true })));
            interactive.read(&tool_result(&tool, "running", serde_json::json!({ "backgroundTaskId": task }), false));
            interactive.read(&queued(&notification(&task, &tool, "completed")));
        }
        assert!(interactive.automation_notifications.is_empty());

        // Automation tab (`track_automation = true`): capped at MAX_AUTOMATION_NOTIFICATIONS,
        // and assistant message `text_of` is extracted at most once across all notifications.
        let mut auto = Ledger::for_tab(true);
        auto.read(&serde_json::json!({ "type": "assistant", "timestamp": AT, "message": { "id": "msg_0", "content": [{ "type": "text", "text": "start" }] } }).to_string());
        for i in 0..(MAX_AUTOMATION_NOTIFICATIONS + 20) {
            let tool = format!("t_{i}");
            let task = format!("b_{i}");
            auto.read(&tool_use(&tool, "Bash", serde_json::json!({ "run_in_background": true })));
            auto.read(&tool_result(&tool, "running", serde_json::json!({ "backgroundTaskId": task }), false));
            auto.read(&queued(&notification(&task, &tool, "completed")));
        }
        assert_eq!(auto.automation_notifications.len(), MAX_AUTOMATION_NOTIFICATIONS);
        TEXT_OF_CALLS.with(|c| c.set(0));
        auto.read(&serde_json::json!({ "type": "assistant", "timestamp": AT, "message": { "id": "msg_1", "content": [{ "type": "text", "text": "reply" }] } }).to_string());
        assert_eq!(TEXT_OF_CALLS.with(|c| c.get()), 1, "text_of must be hoisted outside the notification loop");
    }

    #[test]
    fn tail_observer_feeds_watch_without_duplicate_disk_reads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conversation.jsonl");
        let t = tail(&path, HashSet::new());
        let watch = Arc::new(std::sync::Mutex::new(Watch::for_tab(t.clone(), false)));
        Watch::attach_to_tail(&watch, &t);
        append(&path, &[
            tool_use("toolu_ci", "Bash", serde_json::json!({ "run_in_background": true })),
            tool_result("toolu_ci", "running", serde_json::json!({ "backgroundTaskId": "b1" }), false),
        ]);
        let _ = t.drain_records();
        WATCH_DISK_READS.with(|c| c.set(0));
        assert_eq!(watch.lock().unwrap().outstanding(at(1)).as_deref(), Some("a background command it has not heard back from"));
        assert_eq!(WATCH_DISK_READS.with(|c| c.get()), 0, "Watch should reuse parsed values from Tail without re-reading disk");
    }
}
