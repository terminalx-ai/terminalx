//! What a worker session reports back to the session that started it.
//!
//! A worker ends its final reply with a `terminalx-report` block: JSON in a
//! fenced code block, found the way the pipeline's blocks are
//! (`reply_block`). `terminalx sessions report` returns it parsed, so a lead
//! learns whether the piece is done without reading the transcript, and a
//! failure cannot read as confidently as a success. A reply without a
//! readable block is `missing`: no status is ever guessed from prose.
//!
//! A session asked for a report (`sessions create --report`) is held to it:
//! when its turn ends without one it is asked once more, as a pipeline asks
//! for its status block, and after that the report stays `missing`.

use std::sync::Mutex;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::events::{AgentEvent, Payload, TurnStatus};
use crate::reply_block::{last_block, text_field, turn_reply};

pub const REPORT_FENCE: &str = "terminalx-report";
/// The most of a report that `sessions report` returns; the rest is in the transcript.
pub const REPORT_LIMIT: usize = 8_000;
/// How much of a reply without a report is returned in its place.
pub const TAIL_LIMIT: usize = 2_000;

/// How every reminder begins: what tells a reminder from a lead's own prompt
/// in the transcript, so a worker is asked once and not again.
const REMINDER_OPENING: &str = "Your last reply did not end with a readable `terminalx-report` block";

const EXAMPLE: &str = r#"{
  "status": "done",
  "result": "Two or three sentences on what you did or found.",
  "evidence": ["cargo test auth: exit 0", "src/auth.rs:42"],
  "changed": {"files": ["src/auth.rs"], "branch": "fix-login", "commit": "abc1234"},
  "notDone": [],
  "couldNotRead": [],
  "uncertain": []
}"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Done,
    Partial,
    Blocked,
    Failed,
}

/// What the worker changed. Absent from a report that changed nothing.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changed {
    pub files: Vec<String>,
    pub branch: Option<String>,
    pub commit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub status: Status,
    pub result: String,
    /// Commands run with their exit codes, or `file:line` for a claim.
    pub evidence: Vec<String>,
    pub changed: Option<Changed>,
    /// What was skipped, and why.
    pub not_done: Vec<String>,
    /// Sources that could not be read: a failed read is not "nothing found".
    pub could_not_read: Vec<String>,
    /// Claims made without direct evidence.
    pub uncertain: Vec<String>,
}

impl Report {
    /// Done, with nothing to show for it.
    pub fn no_evidence(&self) -> bool {
        self.status == Status::Done && self.evidence.is_empty()
    }
}

/// Why a reply holds no report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoReport {
    /// No report block in the reply.
    NoBlock,
    /// A block that cannot be read as a report, and what is wrong with it.
    Malformed(String),
}

impl NoReport {
    fn reason(&self) -> &'static str {
        match self {
            Self::NoBlock => "noBlock",
            Self::Malformed(_) => "malformed",
        }
    }

    fn detail(&self) -> String {
        match self {
            Self::NoBlock => format!("The reply has no `{REPORT_FENCE}` block."),
            Self::Malformed(problem) => format!("The `{REPORT_FENCE}` block is not a report: {problem}."),
        }
    }
}

/// A list of text: absent, null and "none" are an empty list, and one string
/// is a list of one. Anything else is not a list, and is said so rather than
/// read as empty: an unreadable `couldNotRead` must not look like none.
fn list(value: &Value, name: &str) -> Result<Vec<String>, NoReport> {
    let wrong = || NoReport::Malformed(format!("`{name}` must be a list of strings"));
    let kept = |text: &str| Some(text.trim()).filter(|text| !text.is_empty()).map(String::from);
    match value.get(name) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::String(text)) if text.trim().eq_ignore_ascii_case("none") => Ok(Vec::new()),
        Some(Value::String(text)) => Ok(kept(text).into_iter().collect()),
        Some(Value::Array(items)) => items.iter().map(|item| item.as_str().map(kept).ok_or_else(wrong)).collect::<Result<Vec<_>, _>>().map(|items| items.into_iter().flatten().collect()),
        Some(_) => Err(wrong()),
    }
}

fn changed(value: &Value) -> Result<Option<Changed>, NoReport> {
    let wrong = || NoReport::Malformed("`changed` must be an object with `files`, `branch` and `commit`, or null".into());
    let changed = match value.get("changed") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::String(text)) if text.trim().is_empty() || text.trim().eq_ignore_ascii_case("none") => return Ok(None),
        Some(object @ Value::Object(_)) => {
            if ["branch", "commit"].iter().any(|name| object.get(name).is_some_and(|value| !value.is_null() && !value.is_string())) {
                return Err(wrong());
            }
            Changed { files: list(object, "files").map_err(|_| wrong())?, branch: text_field(object, &["branch"]), commit: text_field(object, &["commit"]) }
        }
        Some(_) => return Err(wrong()),
    };
    Ok(Some(changed).filter(|changed| *changed != Changed::default()))
}

/// The report a reply ends with, and how many characters its block ran to.
pub fn parse(reply: &str) -> Result<(Report, usize), NoReport> {
    let block = last_block(reply, REPORT_FENCE).ok_or(NoReport::NoBlock)?;
    let value: Value = serde_json::from_str(&block).map_err(|error| NoReport::Malformed(format!("it is not JSON ({error})")))?;
    if !value.is_object() {
        return Err(NoReport::Malformed("it is not a JSON object".into()));
    }
    // Exactly one of the four: a status nobody defined is not rounded to the nearest one.
    let status = match text_field(&value, &["status"]).unwrap_or_default().to_ascii_lowercase().as_str() {
        "done" => Status::Done,
        "partial" => Status::Partial,
        "blocked" => Status::Blocked,
        "failed" => Status::Failed,
        "" => return Err(NoReport::Malformed("it has no `status`".into())),
        other => return Err(NoReport::Malformed(format!("`status` must be \"done\", \"partial\", \"blocked\" or \"failed\", not {other:?}"))),
    };
    let result = text_field(&value, &["result"]).ok_or_else(|| NoReport::Malformed("it has no `result`".into()))?;
    let report = Report {
        status,
        result,
        evidence: list(&value, "evidence")?,
        changed: changed(&value)?,
        not_done: list(&value, "notDone")?,
        could_not_read: list(&value, "couldNotRead")?,
        uncertain: list(&value, "uncertain")?,
    };
    Ok((report, block.chars().count()))
}

/// Keep `text` within what is left of `budget`, marking a cut with an ellipsis.
fn clip_text(text: &mut String, budget: &mut usize) -> bool {
    let length = text.chars().count();
    if length <= *budget {
        *budget -= length;
        return false;
    }
    *text = format!("{}…", text.chars().take(*budget).collect::<String>().trim_end());
    *budget = 0;
    true
}

/// Keep the items that fit, the last of them cut short; the rest are dropped.
fn clip_list(items: &mut Vec<String>, budget: &mut usize) -> bool {
    let mut cut = false;
    let mut kept = Vec::new();
    for mut item in std::mem::take(items) {
        if *budget == 0 {
            cut = true;
            break;
        }
        cut |= clip_text(&mut item, budget);
        kept.push(item);
    }
    *items = kept;
    cut
}

/// Cut a report down to `limit` characters of text and name the fields that
/// lost some. The short fields a lead must not miss are kept first; the
/// evidence, which is what runs long, gives way first.
fn clip(report: &mut Report, limit: usize) -> Vec<&'static str> {
    let mut budget = limit;
    let mut cut = Vec::new();
    let mut note = |name: &'static str, was_cut: bool| {
        if was_cut {
            cut.push(name);
        }
    };
    note("result", clip_text(&mut report.result, &mut budget));
    note("couldNotRead", clip_list(&mut report.could_not_read, &mut budget));
    note("notDone", clip_list(&mut report.not_done, &mut budget));
    note("uncertain", clip_list(&mut report.uncertain, &mut budget));
    if let Some(changed) = report.changed.as_mut() {
        let mut was_cut = clip_list(&mut changed.files, &mut budget);
        for text in [changed.branch.as_mut(), changed.commit.as_mut()].into_iter().flatten() {
            was_cut |= clip_text(text, &mut budget);
        }
        note("changed", was_cut);
    }
    note("evidence", clip_list(&mut report.evidence, &mut budget));
    cut
}

fn tail(reply: &str) -> String {
    let skip = reply.chars().count().saturating_sub(TAIL_LIMIT);
    reply.chars().skip(skip).collect()
}

fn top_level(event: &AgentEvent) -> bool {
    event.subagent.is_none()
}

/// Whether the last thing sent to the tab was the reminder: it has been asked
/// once already.
fn reminded(events: &[AgentEvent]) -> bool {
    events.iter().rev().filter(|event| top_level(event)).find_map(|event| match &event.payload {
        Payload::UserMessage { text, .. } => Some(text.trim_start().starts_with(REMINDER_OPENING)),
        _ => None,
    }) == Some(true)
}

fn missing(reason: &str, detail: String, reply: Option<&(u64, String)>, events: &[AgentEvent]) -> Value {
    let mut row = json!({
        "status": "missing",
        "reason": reason,
        "detail": detail,
        "tail": reply.map(|(_, text)| tail(text)).unwrap_or_default(),
        "reminded": reminded(events),
    });
    if let Some((seq, _)) = reply {
        row["seq"] = json!(seq);
    }
    row
}

/// Whether the agent started the turn that ends at `events[end]` itself
/// (#540): a background task reporting in, a scheduled check.
fn self_started(events: &[AgentEvent], end: usize) -> bool {
    events[..end]
        .iter()
        .rev()
        .filter(|event| top_level(event))
        .take_while(|event| !matches!(event.payload, Payload::TurnCompleted { .. }))
        .find_map(|event| match &event.payload {
            Payload::TurnStarted { started_by, .. } => Some(started_by.is_some()),
            _ => None,
        })
        .unwrap_or(false)
}

/// The turn a tab's report is read from.
struct Deciding {
    /// Where its `turn_completed` is.
    end: usize,
    reply: Option<(u64, String)>,
    /// A later turn the agent started itself and ended without a report:
    /// the sequence number of what it said.
    later: Option<u64>,
}

/// The last turn somebody prompted, or a later one the agent started itself
/// that carries a report block. A turn the agent starts itself to note that a
/// background task finished does not unsay the report before it, and is not
/// a reply anyone asked a report of.
fn deciding(events: &[AgentEvent]) -> Option<Deciding> {
    let ends: Vec<usize> = events.iter().enumerate().rev().filter(|(_, event)| top_level(event) && matches!(event.payload, Payload::TurnCompleted { .. })).map(|(at, _)| at).collect();
    let mut later = None;
    for &end in &ends {
        let reply = turn_reply(events, end);
        let ok = matches!(events[end].payload, Payload::TurnCompleted { status: TurnStatus::Ok, .. });
        let carries = ok && reply.as_ref().is_some_and(|(_, text)| last_block(text, REPORT_FENCE).is_some());
        if self_started(events, end) && !carries {
            later.get_or_insert(reply.map_or(events[end].seq, |(seq, _)| seq));
            continue;
        }
        return Some(Deciding { end, reply, later });
    }
    // Nothing but turns the agent started itself: the last of them is all there is.
    let end = *ends.first()?;
    Some(Deciding { end, reply: turn_reply(events, end), later: None })
}

/// A turn that has not ended: whatever an earlier turn reported is not its answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenTurn {
    /// The agent is working, or has a prompt it has yet to take.
    Working,
    /// The agent waits on someone: a permission request, a question, an error.
    Waiting,
}

/// One tab's report as `sessions report` returns it, read from its transcript:
/// the report of its last turn, or `missing` with why and the end of what it
/// said instead. `open` is the turn the tab is in now, if any; `owed`, that
/// the tab is held to a report and reminded of one.
pub fn of_tab(events: &[AgentEvent], open: Option<OpenTurn>, owed: bool) -> Value {
    match open {
        Some(OpenTurn::Working) => return missing("working", "The tab is still in a turn. Wait for it with `terminalx wait`, then ask again.".into(), None, events),
        Some(OpenTurn::Waiting) => return missing("waiting", "The tab's turn has stopped on a permission request, a question or an error; `terminalx wait` says which.".into(), None, events),
        None => {}
    }
    let Some(turn) = deciding(events) else {
        return missing("noTurn", "The tab has not finished a turn.".into(), None, events);
    };
    let mut row = of_turn(events, &turn);
    if let Some(seq) = turn.later {
        row["laterTurn"] = json!({ "seq": seq });
    }
    // The reminder goes out just after the turn ends: a lead that asks in between is told it is coming.
    if owed && row["status"] == "missing" && reminder_due(events).is_some() {
        row["reminderPending"] = json!(true);
    }
    row
}

fn of_turn(events: &[AgentEvent], turn: &Deciding) -> Value {
    let (end, reply) = (turn.end, &turn.reply);
    match &events[end].payload {
        Payload::TurnCompleted { status: TurnStatus::Ok, .. } => {}
        Payload::TurnCompleted { status: TurnStatus::Aborted, .. } => return missing("turnAborted", "The last turn was interrupted before it finished.".into(), reply.as_ref(), events),
        _ => return missing("turnFailed", "The last turn ended on an error.".into(), reply.as_ref(), events),
    }
    let Some((seq, text)) = reply.as_ref() else {
        return missing("noReply", "The last turn ended without a reply.".into(), None, events);
    };
    let (mut report, chars) = match parse(text) {
        Ok(read) => read,
        Err(problem) => return missing(problem.reason(), problem.detail(), reply.as_ref(), events),
    };
    // Judged on what the worker wrote, before anything is cut from it.
    let no_evidence = report.no_evidence();
    // The block is measured as written; a long one whose fields all fit (padding, fields of its own) loses nothing.
    let cut = if chars > REPORT_LIMIT { clip(&mut report, REPORT_LIMIT) } else { Vec::new() };
    let mut row = serde_json::to_value(&report).unwrap_or_else(|_| json!({}));
    row["seq"] = json!(seq);
    row["at"] = json!(events[end].ts);
    if no_evidence {
        row["noEvidence"] = json!(true);
    }
    if !cut.is_empty() {
        row["truncated"] = json!({ "limit": REPORT_LIMIT, "chars": chars, "seq": seq, "cut": cut });
    }
    row
}

/// Added to a worker's first prompt: how it hands its result back.
pub fn brief() -> String {
    format!(
        "---\n\nAnother session started you and will read your result with `terminalx sessions report`, not your whole transcript. End your final reply with a report block in exactly this form:\n\n\
```{REPORT_FENCE}\n{EXAMPLE}\n```\n\n\
- `status`: \"done\" only when everything asked for is finished; \"partial\" when some of it is; \"blocked\" when you need something to go on; \"failed\" when it did not work.\n\
- `result`: two or three sentences.\n\
- `evidence`: the commands you ran with their exit codes, or `file:line` for each claim. A \"done\" with no evidence is flagged to the reader.\n\
- `changed`: the files, branch and commit you changed, or null when you changed nothing.\n\
- `notDone`: what you skipped, and why.\n\
- `couldNotRead`: every source you tried to read and could not. A failed read is not \"nothing found\": list it here.\n\
- `uncertain`: claims you make without direct evidence.\n\n\
Use an empty list where there is nothing to say. Do not report \"done\" for work you did not verify."
    )
}

/// Sent once to a worker whose turn ended without a report.
pub fn reminder(problem: &NoReport) -> String {
    let why = match problem {
        NoReport::NoBlock => String::new(),
        NoReport::Malformed(problem) => format!(" (the block was not readable: {problem})"),
    };
    format!(
        "{REMINDER_OPENING}{why}, so the session that started you cannot tell how the work went. Reply with the block and nothing else:\n\n\
```{REPORT_FENCE}\n{EXAMPLE}\n```\n\n\
`status` is \"done\", \"partial\", \"blocked\" or \"failed\". If something you started is still running, report \"partial\" and name it in `notDone`. Use an empty list where there is nothing to say, and null for `changed` when you changed nothing."
    )
}

/// The reminder a worker is owed, if any: none when the turn its report is
/// read from has one, none for a turn that was cut short, and none when it has
/// been asked once already.
fn reminder_due(events: &[AgentEvent]) -> Option<String> {
    let turn = deciding(events)?;
    if !matches!(events[turn.end].payload, Payload::TurnCompleted { status: TurnStatus::Ok, .. }) {
        return None;
    }
    let problem = parse(turn.reply.as_ref().map_or("", |(_, text)| text.as_str())).err()?;
    (!reminded(events)).then(|| reminder(&problem))
}

/// A turn of a session that owes a report ended. `events` reads its
/// transcript and `send` sends it a prompt; neither is touched for a turn
/// that ended with its report.
pub fn turn_completed(final_message: Option<&str>, events: impl FnOnce() -> Result<Vec<AgentEvent>>, send: impl FnOnce(&str) -> Result<()>) {
    if final_message.is_some_and(|message| parse(message).is_ok()) {
        return;
    }
    let events = match events() {
        Ok(events) => events,
        Err(error) => return log::warn!("read a worker's transcript for its report: {error:#}"),
    };
    if let Some(prompt) = reminder_due(&events) {
        if let Err(error) = send(&prompt) {
            log::warn!("ask a worker again for its report: {error:#}");
        }
    }
}

// ---- which sessions owe a report --------------------------------------------

static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Owed {
    /// The tabs asked for a report when their session was started.
    #[serde(default)]
    tabs: Vec<crate::issue_pipeline::SessionRef>,
}

fn file_path() -> Result<std::path::PathBuf> {
    Ok(crate::store::root()?.join("worker-reports.json"))
}

/// Record that a tab was asked for a report. Tabs of sessions that no longer
/// exist are dropped on the way.
pub fn expect(session_id: &str, tab_id: &str) -> Result<()> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let path = file_path()?;
    let mut owed = crate::store::read_json::<Owed>(&path)?.unwrap_or_default();
    if let Ok(sessions) = crate::store::index::load() {
        owed.tabs.retain(|tab| sessions.iter().any(|session| session.id == tab.session_id));
    }
    owed.tabs.retain(|tab| !(tab.session_id == session_id && tab.tab_id == tab_id));
    owed.tabs.push(crate::issue_pipeline::SessionRef { session_id: session_id.into(), tab_id: tab_id.into() });
    crate::store::write_json(&path, &owed)
}

/// Whether a tab was asked for a report. Asked on every turn that ends
/// anywhere, so it reads the store and nothing else.
pub fn expected(session_id: &str, tab_id: &str) -> bool {
    file_path()
        .and_then(|path| crate::store::read_json::<Owed>(&path))
        .ok()
        .flatten()
        .is_some_and(|owed| owed.tabs.iter().any(|tab| tab.session_id == session_id && tab.tab_id == tab_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(json: &str) -> String {
        format!("Here is how it went.\n\n```{REPORT_FENCE}\n{json}\n```\n")
    }

    fn event(seq: u64, subagent: bool, payload: Value) -> AgentEvent {
        serde_json::from_value(json!({
            "id": format!("e{seq}"), "sessionId": "s", "tabId": "t", "harness": "claude", "seq": seq, "ts": format!("2026-11-10T10:{:02}:00.000Z", seq % 60),
            "subagent": if subagent { json!({ "id": "sub" }) } else { Value::Null }, "payload": payload,
        }))
        .unwrap()
    }

    /// One finished turn: a prompt, the reply, the turn's end.
    fn turn(from: u64, prompt: &str, reply: &str) -> Vec<AgentEvent> {
        vec![
            event(from, false, json!({ "type": "user_message", "text": prompt })),
            event(from + 1, false, json!({ "type": "turn_started" })),
            event(from + 2, false, json!({ "type": "assistant_text", "text": reply })),
            event(from + 3, false, json!({ "type": "turn_completed", "status": "ok" })),
        ]
    }

    const FULL: &str = r#"{"status":"partial","result":"The login retry is in. The logout path is untouched.","evidence":["cargo test auth: exit 0","src/auth.rs:42"],"changed":{"files":["src/auth.rs","src/session.rs"],"branch":"fix-login","commit":"abc1234"},"notDone":["Logout: out of scope"],"couldNotRead":["https://example.com/spec: 403"],"uncertain":["The retry count of 3 is a guess"]}"#;

    #[test]
    fn a_reply_ending_in_a_valid_block_parses_into_all_seven_fields() {
        let (report, chars) = parse(&block(FULL)).unwrap();
        assert_eq!(
            report,
            Report {
                status: Status::Partial,
                result: "The login retry is in. The logout path is untouched.".into(),
                evidence: vec!["cargo test auth: exit 0".into(), "src/auth.rs:42".into()],
                changed: Some(Changed { files: vec!["src/auth.rs".into(), "src/session.rs".into()], branch: Some("fix-login".into()), commit: Some("abc1234".into()) }),
                not_done: vec!["Logout: out of scope".into()],
                could_not_read: vec!["https://example.com/spec: 403".into()],
                uncertain: vec!["The retry count of 3 is a guess".into()],
            }
        );
        assert_eq!(chars, FULL.chars().count());
        // As `sessions report` returns it: the seven fields, and where the reply is.
        let row = of_tab(&turn(1, "Fix the login.", &block(FULL)), None, false);
        let mut expected: Value = serde_json::from_str(FULL).unwrap();
        expected["seq"] = json!(3);
        expected["at"] = json!("2026-11-10T10:04:00.000Z");
        assert_eq!(row, expected);
        // Every status, however it is cased, and the last block of a reply is the one that counts.
        for (said, status) in [("done", Status::Done), ("Partial", Status::Partial), (" BLOCKED ", Status::Blocked), ("failed", Status::Failed)] {
            assert_eq!(parse(&block(&format!(r#"{{"status":"{said}","result":"r"}}"#))).unwrap().0.status, status);
        }
        let twice = format!("{}\nOn reflection:\n\n{}", block(r#"{"status":"done","result":"first"}"#), block(r#"{"status":"failed","result":"second"}"#));
        assert_eq!(parse(&twice).unwrap().0.status, Status::Failed);
    }

    #[test]
    fn lists_left_out_are_empty_and_nothing_changed_is_null() {
        let (report, _) = parse(&block(r#"{"status":"blocked","result":"Which database?","evidence":"none","changed":"none","notDone":null,"couldNotRead":"the staging dump"}"#)).unwrap();
        assert_eq!((report.evidence.len(), &report.changed, report.not_done.len(), report.uncertain.len()), (0, &None, 0, 0));
        assert_eq!(report.could_not_read, ["the staging dump"]);
        let row = of_tab(&turn(1, "go", &block(r#"{"status":"blocked","result":"Which database?","changed":{"files":[],"branch":null}}"#)), None, false);
        assert_eq!((&row["changed"], &row["evidence"], &row["couldNotRead"]), (&Value::Null, &json!([]), &json!([])));
        // Blocked without evidence is not flagged: only a "done" has to show something.
        assert!(row.get("noEvidence").is_none());
    }

    #[test]
    fn a_malformed_block_is_missing_and_never_a_guessed_status() {
        let malformed = [
            ("not json", "not JSON"),
            (r#"["done"]"#, "not a JSON object"),
            (r#"{"result":"All done, tests pass."}"#, "no `status`"),
            (r#"{"status":"mostly done","result":"r"}"#, "`status` must be"),
            (r#"{"status":"complete","result":"r"}"#, "`status` must be"),
            (r#"{"status":"done"}"#, "no `result`"),
            (r#"{"status":"done","result":"r","evidence":3}"#, "`evidence` must be a list of strings"),
            (r#"{"status":"done","result":"r","couldNotRead":[{"url":"x"}]}"#, "`couldNotRead` must be a list of strings"),
            (r#"{"status":"done","result":"r","changed":["src/a.rs"]}"#, "`changed` must be an object"),
            (r#"{"status":"done","result":"r","changed":{"files":"a.rs","commit":7}}"#, "`changed` must be an object"),
        ];
        for (body, problem) in malformed {
            let reply = block(body);
            match parse(&reply) {
                Err(NoReport::Malformed(said)) => assert!(said.contains(problem), "{body}: {said}"),
                other => panic!("{body}: {other:?}"),
            }
            let row = of_tab(&turn(1, "go", &reply), None, false);
            assert_eq!((row["status"].as_str(), row["reason"].as_str()), (Some("missing"), Some("malformed")), "{body}");
            assert!(row["detail"].as_str().unwrap().contains(problem), "{body}");
            assert!(row["tail"].as_str().unwrap().contains(body), "{body}");
            assert!(row.get("result").is_none() && row.get("evidence").is_none(), "{body}: nothing is read out of a block that is not a report");
        }
    }

    #[test]
    fn an_absent_block_is_missing_with_the_end_of_the_reply() {
        let prose = format!("{}All done, tests pass! status: done", "x".repeat(3_000));
        let row = of_tab(&turn(1, "go", &prose), None, false);
        assert_eq!((row["status"].as_str(), row["reason"].as_str(), row["seq"].as_u64(), row["reminded"].as_bool()), (Some("missing"), Some("noBlock"), Some(3), Some(false)));
        let tail = row["tail"].as_str().unwrap();
        assert_eq!(tail.chars().count(), TAIL_LIMIT);
        assert!(tail.ends_with("All done, tests pass! status: done"));
        // Another label's block, a block inside another fence and an unterminated one are not reports.
        for reply in [
            "```terminalx-status\n{\"status\":\"done\",\"checks\":\"passed\"}\n```".to_string(),
            format!("You asked for:\n\n```markdown\n```{REPORT_FENCE}\n{{\"status\":\"done\",\"result\":\"r\"}}\n```\n```"),
            format!("```{REPORT_FENCE}\n{{\"status\":\"done\",\"result\":\"r\"}}"),
        ] {
            assert_eq!(parse(&reply), Err(NoReport::NoBlock), "{reply}");
        }
        // A short reply comes back whole, cut on characters and not bytes.
        assert_eq!(of_tab(&turn(1, "go", "Fertig — nichts gefunden."), None, false)["tail"], json!("Fertig — nichts gefunden."));
    }

    #[test]
    fn a_tab_with_no_finished_reply_reports_nothing_and_says_why() {
        assert_eq!(of_tab(&[], None, false)["reason"], json!("noTurn"));
        // Still in a turn: an earlier turn's report is not this one's answer.
        let mut events = turn(1, "go", &block(FULL));
        let working = of_tab(&events, Some(OpenTurn::Working), false);
        assert_eq!((working["status"].as_str(), working["reason"].as_str(), working["tail"].as_str()), (Some("missing"), Some("working"), Some("")));
        assert_eq!(of_tab(&events, Some(OpenTurn::Waiting), false)["reason"], json!("waiting"));
        // A turn that was interrupted or failed is not a report either, whatever it said first.
        events.extend([
            event(5, false, json!({ "type": "user_message", "text": "And the logout?" })),
            event(6, false, json!({ "type": "turn_started" })),
            event(7, false, json!({ "type": "assistant_text", "text": "Looking at the logout." })),
            event(8, false, json!({ "type": "turn_completed", "status": "aborted" })),
        ]);
        let aborted = of_tab(&events, None, false);
        assert_eq!((aborted["status"].as_str(), aborted["reason"].as_str(), aborted["tail"].as_str()), (Some("missing"), Some("turnAborted"), Some("Looking at the logout.")));
        events.push(event(9, false, json!({ "type": "turn_started" })));
        events.push(event(10, false, json!({ "type": "turn_completed", "status": "error" })));
        let failed = of_tab(&events, None, false);
        assert_eq!((failed["reason"].as_str(), failed["tail"].as_str()), (Some("turnFailed"), Some("")));
        events.push(event(11, false, json!({ "type": "turn_started" })));
        events.push(event(12, false, json!({ "type": "turn_completed", "status": "ok" })));
        assert_eq!(of_tab(&events, None, false)["reason"], json!("noReply"));
        // The turn's own final text is its reply, and a subagent's report is not the tab's.
        events.push(event(13, false, json!({ "type": "turn_started" })));
        events.push(event(14, true, json!({ "type": "assistant_text", "text": block(r#"{"status":"done","result":"the subagent's"}"#) })));
        events.push(event(15, false, json!({ "type": "turn_completed", "status": "ok" })));
        assert_eq!(of_tab(&events, None, false)["reason"], json!("noReply"));
        events.push(event(16, false, json!({ "type": "turn_started" })));
        events.push(event(17, false, json!({ "type": "turn_completed", "status": "ok", "finalText": block(r#"{"status":"failed","result":"It does not build."}"#) })));
        let last = of_tab(&events, None, false);
        assert_eq!((last["status"].as_str(), last["seq"].as_u64()), (Some("failed"), Some(17)));
    }

    #[test]
    fn done_without_evidence_is_returned_with_a_flag() {
        let row = of_tab(&turn(1, "go", &block(r#"{"status":"done","result":"Fixed it.","evidence":[]}"#)), None, false);
        assert_eq!((row["status"].as_str(), row["noEvidence"].as_bool()), (Some("done"), Some(true)));
        // Blank entries are no evidence; one real entry is.
        assert_eq!(of_tab(&turn(1, "go", &block(r#"{"status":"done","result":"Fixed it.","evidence":["  ",""]}"#)), None, false)["noEvidence"], json!(true));
        let shown = of_tab(&turn(1, "go", &block(r#"{"status":"done","result":"Fixed it.","evidence":["cargo test: exit 0"]}"#)), None, false);
        assert!(shown.get("noEvidence").is_none());
        // The other statuses claim nothing that needs showing.
        for status in ["partial", "blocked", "failed"] {
            assert!(of_tab(&turn(1, "go", &block(&format!(r#"{{"status":"{status}","result":"r"}}"#))), None, false).get("noEvidence").is_none(), "{status}");
        }
    }

    #[test]
    fn an_oversized_report_is_cut_and_points_at_the_transcript() {
        let evidence: Vec<String> = (0..400).map(|n| format!("src/module_{n:03}.rs:{n}: the handler reads the token before checking it")).collect();
        let body = json!({"status": "done", "result": "Audited every handler.", "evidence": evidence, "changed": {"files": ["a.rs"], "branch": "audit", "commit": "abc1234"}, "notDone": ["The admin handlers"], "couldNotRead": ["vendor/closed.bin: binary"], "uncertain": ["Whether the token is logged"]}).to_string();
        let chars = body.chars().count();
        assert!(chars > REPORT_LIMIT);
        let row = of_tab(&turn(1, "go", &block(&body)), None, false);
        assert_eq!(row["truncated"], json!({ "limit": REPORT_LIMIT, "chars": chars, "seq": 3, "cut": ["evidence"] }));
        // What a lead must not miss is whole; the evidence gives way, its last kept entry cut short.
        assert_eq!((row["status"].as_str(), &row["couldNotRead"], &row["notDone"], &row["uncertain"]), (Some("done"), &json!(["vendor/closed.bin: binary"]), &json!(["The admin handlers"]), &json!(["Whether the token is logged"])));
        assert_eq!(row["changed"], json!({"files": ["a.rs"], "branch": "audit", "commit": "abc1234"}));
        let kept = row["evidence"].as_array().unwrap();
        assert!(!kept.is_empty() && kept.len() < 400 && kept[0] == json!(evidence[0]));
        let text = |row: &Value| -> usize {
            let lists = ["evidence", "notDone", "couldNotRead", "uncertain"].iter().flat_map(|name| row[*name].as_array().unwrap().iter()).chain(row["changed"]["files"].as_array().unwrap().iter()).map(|item| item.as_str().unwrap().chars().count()).sum::<usize>();
            lists + ["result"].iter().map(|name| row[*name].as_str().unwrap().chars().count()).sum::<usize>() + row["changed"]["branch"].as_str().unwrap().chars().count() + row["changed"]["commit"].as_str().unwrap().chars().count()
        };
        assert!(text(&row) <= REPORT_LIMIT + 1, "{}", text(&row));
        assert!(row.get("noEvidence").is_none());
        // One long field is cut in place, and every field after it in the order says it lost its text.
        let long = json!({"status": "failed", "result": "é".repeat(REPORT_LIMIT + 500), "notDone": ["everything"], "evidence": ["make: exit 2"]}).to_string();
        let row = of_tab(&turn(1, "go", &block(&long)), None, false);
        assert_eq!(row["truncated"]["cut"], json!(["result", "notDone", "evidence"]));
        assert_eq!(row["result"].as_str().unwrap().chars().count(), REPORT_LIMIT + 1);
        assert!(row["result"].as_str().unwrap().ends_with('…'));
        assert_eq!((&row["notDone"], &row["evidence"]), (&json!([]), &json!([])));
        // A "done" whose evidence was all cut still showed some: the flag is about what the worker wrote.
        let crowded = json!({"status": "done", "result": "r".repeat(REPORT_LIMIT + 1), "evidence": ["cargo test: exit 0"]}).to_string();
        let row = of_tab(&turn(1, "go", &block(&crowded)), None, false);
        assert!(row.get("noEvidence").is_none() && row["truncated"]["cut"] == json!(["result", "evidence"]));
        // A long block whose fields all fit (padding, a field of its own) is returned whole and says nothing was cut.
        let padded = format!(r#"{{"status":"done","result":"r","evidence":["make: exit 0"],"notes":"{}"}}"#, "n".repeat(REPORT_LIMIT));
        let row = of_tab(&turn(1, "go", &block(&padded)), None, false);
        assert!(row.get("truncated").is_none() && row["evidence"] == json!(["make: exit 0"]));
        // At the limit nothing is cut.
        let padding = "p".repeat(REPORT_LIMIT - r#"{"status":"done","result":""}"#.len());
        let exact = format!(r#"{{"status":"done","result":"{padding}"}}"#);
        assert_eq!(exact.chars().count(), REPORT_LIMIT);
        assert!(of_tab(&turn(1, "go", &block(&exact)), None, false).get("truncated").is_none());
    }

    #[test]
    fn the_examples_a_worker_is_given_are_ones_that_parse() {
        for prompt in [brief(), reminder(&NoReport::NoBlock), reminder(&NoReport::Malformed("it has no `status`".into()))] {
            let (report, _) = parse(&prompt).unwrap_or_else(|problem| panic!("{problem:?}: {prompt}"));
            assert_eq!(report.status, Status::Done);
            assert!(!report.evidence.is_empty() && report.changed.is_some());
            for field in ["status", "result", "evidence", "changed", "notDone", "couldNotRead", "uncertain"] {
                assert!(prompt.contains(&format!("\"{field}\"")), "{field}");
            }
        }
        assert!(reminder(&NoReport::NoBlock).starts_with(REMINDER_OPENING));
        assert!(reminder(&NoReport::Malformed("it has no `status`".into())).contains("it has no `status`"));
        assert!(!brief().starts_with(REMINDER_OPENING));
    }

    #[test]
    fn a_worker_without_a_report_is_asked_once_and_then_left_missing() {
        let sent = std::cell::RefCell::new(Vec::<String>::new());
        let ended = |final_message: Option<&str>, events: &[AgentEvent]| turn_completed(final_message, || Ok(events.to_vec()), |prompt| {
            sent.borrow_mut().push(prompt.to_string());
            Ok(())
        });

        // A turn that ends with its report: nothing is sent, and the transcript is not even read.
        turn_completed(Some(&block(FULL)), || panic!("the transcript is not needed"), |_| panic!("nothing is sent"));

        // No block: one reminder, saying what to send.
        let mut events = turn(1, &format!("Fix the login.\n\n{}", brief()), "All done, tests pass!");
        ended(Some("All done, tests pass!"), &events);
        assert_eq!(sent.borrow().len(), 1);
        assert!(sent.borrow()[0].starts_with(REMINDER_OPENING) && parse(&sent.borrow()[0]).is_ok());
        assert_eq!(of_tab(&events, None, false)["reminded"], json!(false));

        // The reminder's own turn ends without one too: it is not asked again, and the report says it was asked.
        let reminder = sent.borrow()[0].clone();
        events.extend(turn(5, &reminder, "I already told you it is done."));
        ended(Some("I already told you it is done."), &events);
        ended(None, &events);
        assert_eq!(sent.borrow().len(), 1);
        let row = of_tab(&events, None, false);
        assert_eq!((row["status"].as_str(), row["reminded"].as_bool()), (Some("missing"), Some(true)));

        // The lead sends more work: a reply without a report is owed one reminder again.
        events.extend(turn(9, "Now the logout.", &block(r#"{"status":"done","result":"r","evidence":7}"#)));
        ended(None, &events);
        assert_eq!(sent.borrow().len(), 2);
        assert!(sent.borrow()[1].contains("`evidence` must be a list of strings"));

        // Answered with a report: nothing more, and the report is read.
        events.extend(turn(13, &sent.borrow()[1].clone(), &block(FULL)));
        ended(None, &events);
        assert_eq!(sent.borrow().len(), 2);
        assert_eq!(of_tab(&events, None, false)["status"], json!("partial"));

        // The agent then starts a turn of its own (a background task reports in) and ends it without a block:
        // the report stands, with a pointer to what came after, and nobody is asked again.
        let own = |from: u64, reply: &str| vec![
            event(from, false, json!({ "type": "turn_started", "startedBy": "Background task" })),
            event(from + 1, false, json!({ "type": "assistant_text", "text": reply })),
            event(from + 2, false, json!({ "type": "turn_completed", "status": "ok" })),
        ];
        events.extend(own(17, "The watcher exited; nothing to add."));
        ended(Some("The watcher exited; nothing to add."), &events);
        assert_eq!(sent.borrow().len(), 2);
        let row = of_tab(&events, None, true);
        assert_eq!((row["status"].as_str(), row["seq"].as_u64(), &row["laterTurn"], row.get("reminderPending")), (Some("partial"), Some(15), &json!({"seq": 18}), None));
        // One that carries a report of its own is the newer answer.
        events.extend(own(20, &block(r#"{"status":"done","result":"The watcher finished clean.","evidence":["watch: exit 0"]}"#)));
        let row = of_tab(&events, None, true);
        assert_eq!((row["status"].as_str(), row.get("laterTurn")), (Some("done"), None));

        // Between a turn's end and the reminder reaching the tab, a worker held to a report says one is coming;
        // a session nobody asked a report of does not, and neither does a worker already asked.
        let fresh = turn(1, "Fix the login.", "All done, tests pass!");
        assert_eq!(of_tab(&fresh, None, true)["reminderPending"], json!(true));
        assert!(of_tab(&fresh, None, false).get("reminderPending").is_none());
        let mut asked = fresh.clone();
        asked.extend(turn(5, &reminder, "It is done."));
        let row = of_tab(&asked, None, true);
        assert!(row.get("reminderPending").is_none() && row["reminded"] == json!(true));
        // A self-started turn after a reply with no report does not use up or repeat the reminder.
        let mut noted = fresh.clone();
        noted.extend(own(5, "The watcher exited."));
        ended(None, &noted);
        assert_eq!(sent.borrow().len(), 3);
        let row = of_tab(&noted, None, true);
        assert_eq!((row["reason"].as_str(), row["tail"].as_str(), &row["laterTurn"]), (Some("noBlock"), Some("All done, tests pass!"), &json!({"seq": 6})));
        // Only turns of its own: the last is all there is to read.
        assert_eq!(of_tab(&own(1, "Scheduled check: nothing new."), None, false)["reason"], json!("noBlock"));

        // A transcript that cannot be read sends nothing rather than a guess.
        turn_completed(None, || anyhow::bail!("no log"), |_| panic!("nothing is sent"));
    }
}
