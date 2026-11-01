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

#[derive(Debug, Clone, PartialEq, Eq)]
struct Task {
    /// The CLI's own id for it, once its result has said.
    id: Option<String>,
    what: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Cron {
    /// The job's id, once its result has said.
    id: Option<String>,
    recurring: bool,
    made: DateTime<Utc>,
}

/// A stop the agent asked for, applied once its result says it worked.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Stopping {
    Task(String),
    Cron(String),
}

/// What one CLI started and has not heard back from, by the tool use that
/// started each.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Ledger {
    tasks: BTreeMap<String, Task>,
    crons: BTreeMap<String, Cron>,
    stopping: BTreeMap<String, Stopping>,
    /// When the wakeup it scheduled last is due.
    wakeup: Option<DateTime<Utc>>,
}

impl Ledger {
    /// Take in one transcript record.
    #[cfg(test)]
    pub fn read(&mut self, line: &str) {
        self.read_skipping(line, &HashSet::new());
    }

    /// Take in one transcript record, unless its uuid is in `skip`.
    pub fn read_skipping(&mut self, line: &str, skip: &HashSet<String>) {
        let Ok(record) = serde_json::from_str::<Value>(line) else { return };
        if record["isSidechain"].as_bool() == Some(true) || record["uuid"].as_str().is_some_and(|uuid| skip.contains(uuid)) {
            return;
        }
        let at = record["timestamp"].as_str().and_then(|at| DateTime::parse_from_rfc3339(at).ok()).map_or_else(Utc::now, |at| at.with_timezone(&Utc));
        let parts = record["message"]["content"].as_array().map(Vec::as_slice).unwrap_or_default();
        match record["type"].as_str() {
            Some("assistant") => {
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
                    self.notifications(&text_of(&record["message"]["content"]));
                    let origin = record["turnOrigin"].as_str().or_else(|| record["origin"]["kind"].as_str());
                    if origin == Some("scheduled") {
                        self.scheduled_turn(at);
                    }
                }
            }
            Some("attachment") if record["attachment"]["type"] == "queued_command" => self.notifications(&text_of(&record["attachment"]["prompt"])),
            _ => {}
        }
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
                self.tasks.insert(id.into(), Task { id: None, what: "a monitor" });
            }
            _ if input["run_in_background"].as_bool() == Some(true) => {
                let what = if name == "Bash" { "a background command" } else { "a background agent" };
                self.tasks.insert(id.into(), Task { id: None, what });
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
                self.tasks.insert(id.into(), Task { id: task_id.map(String::from), what: "a background command" });
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
    fn notifications(&mut self, text: &str) {
        for block in text.split("<task-notification>").skip(1) {
            let block = block.split("</task-notification>").next().unwrap_or(block);
            let status = tagged(block, "status").map(str::to_ascii_lowercase);
            if !status.is_some_and(|status| FINAL.contains(&status.as_str())) {
                continue;
            }
            let (tool_use, task) = (tagged(block, "tool-use-id"), tagged(block, "task-id"));
            self.tasks.retain(|key, known| Some(key.as_str()) != tool_use && (task.is_none() || known.id.as_deref() != task));
        }
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
}

/// The text of a tag's first occurrence in `block`, trimmed.
fn tagged<'a>(block: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = block.find(&open)? + open.len();
    let end = block[start..].find(&format!("</{tag}>"))? + start;
    Some(block[start..end].trim())
}

/// A message's text: a string, or its text parts joined.
fn text_of(content: &Value) -> String {
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

impl Watch {
    /// Keep up with `tail` from where it stands: where its CLI was started.
    pub fn new(tail: Arc<Tail>) -> Self {
        let aimed = tail.reading();
        let skip = tail.carried();
        Self { offset: aimed.1, aimed, tail, partial: Vec::new(), skip, ledger: Ledger::default() }
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
        file.seek(SeekFrom::Start(self.offset))?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        self.offset += bytes.len() as u64;
        self.partial.extend_from_slice(&bytes);
        let Some(end) = self.partial.iter().rposition(|byte| *byte == b'\n') else { return Ok(()) };
        let complete: Vec<u8> = self.partial.drain(..=end).collect();
        for line in complete.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
            self.ledger.read_skipping(&String::from_utf8_lossy(line), &self.skip);
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
}
