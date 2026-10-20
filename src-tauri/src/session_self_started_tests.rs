//! Turns the agent starts itself (#540).
//!
//! Claude Code runs a `/loop` check or a scheduled task, takes a background
//! task's report, or reads another agent's message, and starts a turn for it
//! that nobody prompted. The tab has to know it is working: a message sent
//! from the composer meanwhile is held by the CLI until that turn is over,
//! and the chat has to draw it there too, below what the turn did — as the
//! terminal does.
//!
//! The records are the shapes Claude Code 2.1.295–2.1.304 wrote, cut down to
//! what the decoder reads.
use super::*;

fn record(value: serde_json::Value) -> String {
    format!("{value}\n")
}

/// A scheduled run: the CLI's fire record, and the prompt nobody typed,
/// written as meta.
fn scheduled(prompt: &str) -> String {
    record(json!({ "type": "system", "subtype": "scheduled_task_fire", "content": "Claude resuming /loop wakeup (Oct 9 6:50pm)", "isMeta": false, "isSidechain": false, "uuid": "fire", "cwd": "/w", "sessionId": "s" }))
        + &record(json!({
            "type": "user", "isMeta": true, "turnOrigin": "scheduled", "promptSource": "system", "isSidechain": false,
            "uuid": "scheduled", "userType": "external", "cwd": "/w", "sessionId": "s",
            "message": { "role": "user", "content": prompt },
        }))
}

/// A background task reporting in: a `user` record that is not meta, whose
/// text is the notification's markup.
fn notification(summary: &str) -> String {
    record(json!({
        "type": "user", "turnOrigin": "task_notification", "promptSource": "system",
        "origin": { "kind": "task-notification", "producer": "session-task" }, "isSidechain": false,
        "uuid": "notified", "userType": "external", "cwd": "/w", "sessionId": "s",
        "message": { "role": "user", "content": format!("<task-notification>\n<task-id>b3a8</task-id>\n<status>completed</status>\n<summary>{summary}</summary>\n</task-notification>") },
    }))
}

fn tool_call(command: &str) -> String {
    record(json!({
        "type": "assistant", "isSidechain": false, "uuid": format!("t-{command}"), "cwd": "/w", "sessionId": "s",
        "message": { "id": format!("m-{command}"), "role": "assistant", "content": [{ "type": "tool_use", "id": format!("toolu-{command}"), "name": "Bash", "input": { "command": command } }] },
    }))
}

/// What the CLI writes when it prints "Worked for …".
fn turn_duration() -> String {
    record(json!({ "type": "system", "subtype": "turn_duration", "durationMs": 12000, "isMeta": false, "isSidechain": false, "cwd": "/w", "sessionId": "s" }))
}

const REPORT: &str = "No decision is needed from you right now.";
const GOAL: &str = "a goal for the work";

impl Rig {
    /// [`Rig::told`], with the tools the agent ran and where the log says
    /// turns began: one the agent started itself, and a message taken as a
    /// turn's prompt.
    fn told_in_turns(&self) -> Vec<String> {
        let events = self.events();
        let text_at = |seq: u64| {
            events.iter().find(|e| e.seq == seq).and_then(|e| match &e.payload {
                Payload::UserMessage { text, .. } => Some(text.clone()),
                _ => None,
            })
        };
        events
            .iter()
            .filter_map(|e| match &e.payload {
                Payload::TurnStarted { started_by: Some(by), .. } => Some(format!("started by: {by}")),
                Payload::TurnStarted { prompt_seq: Some(seq), .. } => Some(format!("taken: {}", text_at(*seq).unwrap_or_else(|| format!("no message at {seq}")))),
                Payload::UserMessage { text, queued: false, .. } => Some(format!("user: {text}")),
                Payload::UserMessage { text, queued: true, .. } => Some(format!("queued: {text}")),
                Payload::ToolCallStarted { name, .. } => Some(format!("tool: {name}")),
                Payload::AssistantText { text, .. } => Some(format!("reply: {text}")),
                Payload::TurnCompleted { .. } => Some("end".to_string()),
                _ => None,
            })
            .collect()
    }

    /// A turn the reader prompted, finished, and the tab idle after it.
    fn a_finished_turn(&self) {
        self.compose("start", 0);
        self.cli_takes("start");
        self.cli_replies("first");
        self.append(&turn_duration());
        assert!(!self.turn_open());
    }
}

/// How the tab first hears of a turn the CLI started itself.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Heard {
    /// Only the transcript says so: the CLI the report came from fired no
    /// hook for the turn.
    Record,
    /// Claude Code 2.1.304 fires `UserPromptSubmit` for it first. Probed with
    /// a `/loop`, the frame named no `source`; its schema says one may.
    Hook,
    /// The hook, then the reader's message, then the record. Before, the
    /// message was queued but drawn as a prompt, there being no turn on
    /// screen to queue it in, and `Stop` never closed the turn: the report's
    /// "Working".
    MessageBetween,
}

/// The report: a `/loop` check was writing its hourly status when the reader
/// sent a goal from the composer. The CLI held the message until the check was
/// over, as the terminal showed; the chat drew it above the check's work, as
/// though the check were the answer to it. The check is a turn: the tab is
/// working, the message is queued behind it, and the CLI taking it starts the
/// next turn, below everything the check did. A background task reporting in
/// is the same, and its markup is nobody's message.
#[test]
fn a_message_sent_during_a_turn_the_cli_started_itself_is_queued_behind_it() {
    let summary = r#"Background command "Watch the CI run" completed (exit code 0)"#;
    let openers = [(scheduled("Report the job's status"), "Scheduled check", "loop_wakeup"), (notification(summary), summary, "system")];
    // Whether the hook names its `source`.
    let cases = [(Heard::Record, false), (Heard::Hook, false), (Heard::Hook, true), (Heard::MessageBetween, false), (Heard::MessageBetween, true)];
    for (opener, label, source) in openers {
        for (heard, named) in cases {
            let case = format!("{label}, {heard:?}, source named: {named}");
            let rig = Rig::of(CliKind::Claude, "");
            rig.a_finished_turn();

            if heard != Heard::Record {
                let mut frame = json!({ "prompt": "the CLI's own prompt" });
                if named {
                    frame["source"] = source.into();
                }
                rig.hook("UserPromptSubmit", frame);
                assert!(rig.turn_open(), "{case}: the hook says the CLI is working");
            }
            if heard == Heard::MessageBetween {
                assert!(rig.compose(GOAL, 0), "{case}: queued");
            }
            rig.append(&opener);
            assert!(rig.turn_open(), "{case}");
            assert_eq!(rig.status(), TabStatus::InProgress, "{case}");
            rig.append(&tool_call("date -u"));
            if heard != Heard::MessageBetween {
                assert!(rig.compose(GOAL, 0), "{case}: sent while the CLI is working, so queued");
            }
            rig.cli_replies(REPORT);
            rig.append(&turn_duration());
            assert!(!rig.turn_open(), "{case}: `Stop` closes it like any turn");
            assert!(rig.taken_as_prompts().is_empty(), "{case}: still held");

            rig.cli_takes(GOAL);
            assert!(rig.turn_open(), "{case}");
            rig.cli_replies("Checking the evaluator");

            let started = format!("started by: {label}");
            let queued = format!("queued: {GOAL}");
            let during = match heard {
                Heard::MessageBetween => [queued.as_str(), started.as_str(), "tool: Bash"],
                _ => [started.as_str(), "tool: Bash", queued.as_str()],
            };
            let expected: Vec<String> = ["user: start", "reply: first", "end"]
                .into_iter()
                .chain(during)
                .chain([format!("reply: {REPORT}").as_str(), "end", format!("taken: {GOAL}").as_str(), "reply: Checking the evaluator", "end"])
                .map(String::from)
                .collect();
            assert_eq!(rig.told_in_turns(), expected, "{case}");
            assert!(!rig.told_in_turns().iter().any(|said| said.contains("<task-notification>") || said.contains("the CLI's own prompt")), "{case}");
            assert_eq!(rig.completed_turns(), 3, "{case}: the CLI's turn ends with its own end");
            assert!(!rig.turn_open(), "{case}");
            assert_eq!(rig.status(), TabStatus::Completed, "{case}");
        }
    }
}

/// Claude Code 2.1.304 running a `/loop` check, with a message typed while the
/// check's `find` ran: what it wrote from the fire to the turn's end, with its
/// API request records left out, the working directory replaced and the
/// commands of the hooks it ran blanked. It handed the message to the model
/// with the `find`'s result, inside the check's turn, and its terminal drew
/// the check, the search, the message and the reply, in that order.
const LOOP_WITH_MESSAGE: &str = include_str!("harness/claude/fixtures/scheduled_turn_with_message.jsonl");

#[test]
fn a_real_check_with_a_message_typed_into_it_reads_as_the_terminal_drew_it() {
    const MESSAGE: &str = "Reply with exactly: four";
    let lines: Vec<&str> = LOOP_WITH_MESSAGE.lines().collect();
    let at = |what: &str| lines.iter().position(|line| line.contains(what)).unwrap_or_else(|| panic!("no {what}"));
    let records = |range: std::ops::Range<usize>| lines[range].iter().map(|line| format!("{line}\n")).collect::<String>();
    let (call, taken, end) = (at(r#""type":"tool_use""#), at(r#""type":"queued_command""#), at(r#""subtype":"turn_duration""#));

    let rig = Rig::of(CliKind::Claude, "");
    // The hooks as the CLI fired them; the scheduled prompt's named no source.
    rig.hook("UserPromptSubmit", json!({ "prompt": "Run `find /System/Library -name '*.plist' | wc -l` with Bash, then reply with the count in one sentence." }));
    rig.append(&records(0..call + 1));
    rig.hook("PreToolUse", json!({ "tool_name": "Bash", "tool_input": { "command": "find /System/Library -name '*.plist' | wc -l" } }));
    assert!(rig.compose(MESSAGE, 0), "sent while the check ran, so queued");
    rig.append(&records(call + 1..taken + 1));
    rig.hook("UserPromptSubmit", json!({ "prompt": MESSAGE }));
    rig.append(&records(taken + 1..end));
    rig.hook("Stop", json!({ "last_assistant_message": "four" }));
    rig.append(&records(end..lines.len()));

    assert_eq!(rig.told_in_turns(), ["started by: Scheduled check", "tool: Bash", "queued: Reply with exactly: four", "reply: four", "end"]);
    assert!(rig.taken_as_prompts().is_empty(), "taken within the check's turn, as the CLI did");
    assert!(!rig.turn_open());
    assert_eq!(rig.status(), TabStatus::Completed);
}

/// The CLI started its check a moment before the reader sent, and the tab
/// had heard nothing of it yet: the message went out as a prompt and the
/// check's work was drawn under it. The CLI's record of the message comes
/// after that work, and that is where its turn is said to start — the same
/// for a turn the decoder cannot tell is the CLI's own (an older CLI's meta
/// prompt with no origin on it), where the work alone says so.
#[test]
fn a_message_sent_as_the_cli_started_a_turn_of_its_own_moves_to_where_the_cli_took_it() {
    let unmarked = record(json!({ "type": "user", "isMeta": true, "isSidechain": false, "uuid": "old", "cwd": "/w", "sessionId": "s", "message": { "role": "user", "content": "Report the job's status" } }));
    for (opener, started) in [(scheduled("Report the job's status"), Some("started by: Scheduled check")), (unmarked, None)] {
        let rig = Rig::of(CliKind::Claude, "");
        rig.a_finished_turn();
        assert!(!rig.compose(GOAL, 0), "{started:?}: the tab thinks the CLI idle");
        rig.submitted();

        rig.append(&opener);
        rig.append(&tool_call("date -u"));
        rig.cli_replies(REPORT);
        rig.append(&turn_duration());
        rig.cli_takes(GOAL);
        rig.cli_replies("Checking the evaluator");

        let expected: Vec<&str> = ["user: start", "reply: first", "end", "user: a goal for the work"]
            .into_iter()
            .chain(started)
            .chain(["tool: Bash", "reply: No decision is needed from you right now.", "end", "taken: a goal for the work", "reply: Checking the evaluator", "end"])
            .collect();
        assert_eq!(rig.told_in_turns(), expected, "{started:?}");
        // Before, the message's own turn was never closed: `Stop` had closed
        // the check's, and the record that would have opened it again was
        // dropped as the composer's echo.
        assert_eq!(rig.completed_turns(), 3, "{started:?}");
        assert!(!rig.turn_open(), "{started:?}");
        assert_eq!(rig.status(), TabStatus::Completed, "{started:?}");
    }
}

/// What must stay as it was: the CLI's own reply to a message, and a queued
/// message it takes mid-turn, say nothing about where the message goes.
#[test]
fn a_reply_after_the_message_it_answers_moves_nothing() {
    let rig = Rig::of(CliKind::Claude, "");
    rig.compose("start", 0);
    rig.cli_takes("start");
    rig.append(&tool_call("ls"));
    assert!(rig.compose("while you are at it", 0));
    rig.append(&rig.cli().steer("while you are at it"));
    rig.cli_replies("both");
    assert_eq!(rig.told_in_turns(), ["user: start", "tool: Bash", "queued: while you are at it", "reply: both", "end"]);
}

/// The hook the CLI fires for a turn of its own is not the reader's prompt
/// arriving: a message waiting to be acknowledged is still waiting. And an
/// event the CLI is only being offered starts no turn at all.
#[test]
fn a_turn_the_cli_starts_itself_does_not_acknowledge_the_reader_s_prompt() {
    let rig = Rig::of(CliKind::Claude, "");
    rig.hook("UserPromptSubmit", json!({ "prompt": "an event", "source": "poll_event" }));
    assert!(!rig.turn_open());
    assert_eq!(rig.status(), TabStatus::Idle);

    let receipt = rig.compose_confirmed("continue the work");
    rig.submitted();
    rig.hook("UserPromptSubmit", json!({ "prompt": "Report the job's status", "source": "schedule_wakeup" }));
    assert!(receipt.try_recv().is_err(), "the CLI's own turn delivered nothing the reader sent");
    assert!(rig.delivery_pending());

    rig.cli_takes("continue the work");
    assert_eq!(receipt.try_recv(), Ok(Ok(())));
    assert!(!rig.delivery_pending());
}

/// A scheduled slash command is work the CLI does, not a command typed at it
/// that may never end: a message sent while it runs is queued.
#[test]
fn a_scheduled_slash_command_is_a_running_turn() {
    let rig = Rig::of(CliKind::Claude, "");
    rig.hook("UserPromptSubmit", json!({ "prompt": "/babysit-prs", "source": "loop_wakeup" }));
    assert!(rig.compose(GOAL, 0));
}

/// No hook at all, as from a CLI that fires none for its own turns, and so no
/// `Stop`: the transcript says the turn ended, and the watcher closes it
/// once the hooks have had their time, as it would any turn.
#[test]
fn a_turn_the_cli_started_itself_is_closed_by_its_own_end_with_no_hooks() {
    let rig = Rig::of(CliKind::Claude, "");
    rig.append(&scheduled("Report the job's status"));
    assert!(rig.turn_open());
    assert_eq!(rig.status(), TabStatus::InProgress);
    rig.append(&rig.cli().reply(REPORT));
    rig.append(&turn_duration());
    rig.advance(PATIENCE.settle);
    rig.tick();
    assert!(!rig.turn_open());
    assert_eq!(rig.told_in_turns(), ["started by: Scheduled check", &format!("reply: {REPORT}"), "end"]);
    assert_eq!(rig.status(), TabStatus::Completed);
}
