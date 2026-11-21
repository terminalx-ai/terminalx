//! PRO-477 through the real dispatch: a look around's session is refused
//! every write by its hook gate and still ends with suggestions; the owner's
//! Start makes the item and sends it to the bot as the owner's message, so the
//! bot begins; Dismiss only closes it; and only a bot suggests, from its own
//! session, while it is not paused.

use serde_json::{json, Value};

use super::super::tests::headless_service;
use super::super::*;
use crate::automations::{AutomationRun, AutomationRunStatus};
use crate::bots::access::Gate;
use crate::bots::builtins::{self, Builtin};

/// Puts the test switches back when dropped, on failure too.
struct Switches;

impl Drop for Switches {
    fn drop(&mut self) {
        crate::bots::items::SENT_FOR_TESTS.with(|sent| sent.borrow_mut().clear());
    }
}

fn bots_on() {
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = true;
    crate::store::settings::save(&settings).unwrap();
}

struct Rig {
    service: ControlService,
    bot: String,
}

impl Rig {
    fn new() -> Self {
        bots_on();
        let (service, _sink) = headless_service();
        let bot = service.execute("bots.create", json!({"role": "cto", "name": "Atlas"}), "r").unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        Self { service, bot }
    }

    fn ask(&self, command: &str, params: Value) -> Result<Value, ControlError> {
        self.service.execute(command, params, "r")
    }

    /// The runtime's `bots` call as the window's own route hands it on, below the person's proof.
    fn window(&self, operation: &str, params: Value) -> anyhow::Result<Value> {
        let sink: std::sync::Arc<dyn crate::sink::EventSink> = self.service.sink.clone();
        crate::local_runtime::calls::execute(&self.service.manager, &sink, "runtime.session.bots", json!({"operation": operation, "params": params}))
    }

    fn builtin(&self, kind: Builtin) -> crate::automations::Automation {
        crate::bots::duties::duties_of(&self.bot).unwrap().into_iter().find(|duty| builtins::of(duty) == Some(kind)).expect("a hire makes both built-ins")
    }

    /// A run of `kind` as the scheduler starts one: its record, and its session as the duty opens it, with the
    /// tab's launch secret installed so the session proves itself.
    fn start(&self, kind: Builtin, token: &str) -> (AutomationRun, SessionEntry) {
        let duty = self.builtin(kind);
        let run: AutomationRun = serde_json::from_value(json!({"runId": format!("{}-1", duty.id), "runNumber": 1, "automationId": duty.id, "trigger": "scheduled", "status": "running", "startedAt": index::now()})).unwrap();
        let run = crate::store::automations::insert_run(run).unwrap();
        let entry = crate::bots::duties::open_session(self.service.sink.as_ref(), &duty, &run).unwrap();
        self.service.manager.install_review_test_cli(&entry.id, &entry.tabs[0].id, token);
        (run, entry)
    }

    fn as_session(&self, entry: &SessionEntry, token: &str, command: &str, mut params: Value) -> Result<Value, ControlError> {
        params["caller"] = json!({"session": entry.id, "tab": entry.tabs[0].id});
        params["hookToken"] = json!(token);
        self.ask(command, params)
    }
}

fn call(tool: &str, input: Value) -> Value {
    json!({"tool_name": tool, "tool_input": input, "cwd": "/tmp"})
}

fn shell(command: &str) -> Value {
    call("Bash", json!({"command": command}))
}

/// Done when (PRO-477): a look around that tries to write is refused by the hook and still ends with suggestions.
#[test]
fn a_look_around_that_tries_to_write_is_refused_and_still_ends_with_suggestions() {
    let _home = crate::store::temp_home();
    let _switches = Switches;
    let rig = Rig::new();
    let (run, entry) = rig.start(Builtin::LookAround, "look-secret");
    // The session is marked, so the tab's runtime holds it to the look around's allow-list.
    let look = builtins::of_session(&entry).expect("a look around's session says so");
    assert_eq!((look.kind, look.bot.as_str(), look.run.as_deref()), (Builtin::LookAround, rig.bot.as_str(), Some(run.run_id.as_str())));

    // A Full access bot: every write is refused all the same, saying to suggest it instead.
    for refused in [
        call("Write", json!({"file_path": "/tmp/notes.md", "content": "x"})),
        call("Edit", json!({"file_path": "/tmp/notes.md", "old_string": "a", "new_string": "b"})),
        shell("git push origin main"),
        shell("gh pr close 1247"),
        shell("terminalx bots memory add 'Noted while looking'"),
        shell("terminalx bots items add --title 'Close PR #1247'"),
        call("AskUserQuestion", json!({"questions": []})),
        call("mcp__github__merge_pull_request", json!({"number": 1247})),
    ] {
        match builtins::session_gate(Some(&look), Some(&rig.bot), &refused) {
            Gate::Refuse(why) => assert!(why.contains("terminalx bots suggest"), "{refused}: {why}"),
            other => panic!("{refused} was let through: {other:?}"),
        }
    }
    // Reads and its suggestions go through, as at full access.
    for allowed in [call("Read", json!({"file_path": "/tmp/notes.md"})), call("Grep", json!({"pattern": "TODO"})), shell("terminalx bots suggest --title 'Close PR #1247' --why 'Superseded by #1198'"), shell("terminalx bots items list")] {
        assert_eq!(builtins::session_gate(Some(&look), Some(&rig.bot), &allowed), Gate::Leave, "{allowed}");
    }
    // Outside a look around, the same bot's write is its own access's to decide.
    assert_eq!(builtins::session_gate(None, Some(&rig.bot), &call("Write", json!({"file_path": "/tmp/notes.md"}))), Gate::Leave);

    // The suggestions it makes from that session are the look's.
    let made = rig.as_session(&entry, "look-secret", "bots.suggest", json!({"title": "Close PR #1247: #1198 covers it", "why": "It has conflicted for two days."})).unwrap();
    assert_eq!(made["suggestion"]["from"]["kind"], "lookAround");
    assert_eq!(made["suggestion"]["from"]["run"], run.run_id.as_str());
    rig.as_session(&entry, "look-secret", "bots.suggest", json!({"title": "Merge main into phase-2", "why": "Each day adds conflicts."})).unwrap();
    assert_eq!(rig.as_session(&entry, "look-secret", "bots.suggest", json!({"title": "merge main into PHASE-2", "why": "Again."})).unwrap_err().code, "invalid_arguments", "the same suggestion twice");

    // It ends: the Home tab's status says when, how many it made, and what was refused.
    crate::store::automations::replace_run(&run.automation_id, &run.run_id, |value| {
        value.status = AutomationRunStatus::Completed;
        value.ended_at = Some(index::now());
        Ok(())
    })
    .unwrap();
    let shown = rig.window("suggestions", json!({"id": rig.bot})).unwrap();
    let titles: Vec<&str> = shown["suggestions"].as_array().unwrap().iter().map(|suggestion| suggestion["title"].as_str().unwrap()).collect();
    assert_eq!(titles, ["Merge main into phase-2", "Close PR #1247: #1198 covers it"], "newest first");
    let last = &shown["status"]["lookAround"]["last"];
    assert_eq!((last["suggestions"].as_u64(), last["refused"].as_u64(), last["status"].as_str()), (Some(2), Some(8), Some("completed")), "{shown}");
    assert!(last["refusedWhat"].as_array().unwrap().iter().any(|what| what.as_str().unwrap().contains("git push")), "{last}");
    assert_eq!(shown["status"]["lookAround"]["enabled"], true, "on from hire");
}

/// Done when (PRO-477): Start on a suggestion creates the item and the bot begins.
#[test]
fn start_makes_the_item_and_sends_it_as_the_owners_message_and_dismiss_only_closes() {
    let _home = crate::store::temp_home();
    let _switches = Switches;
    let rig = Rig::new();
    let (_, entry) = rig.start(Builtin::LookAround, "look-secret");
    let first = rig.as_session(&entry, "look-secret", "bots.suggest", json!({"title": "Close PR #1247", "why": "#1198 covers it."})).unwrap()["suggestion"]["number"].as_u64().unwrap();
    let second = rig.as_session(&entry, "look-secret", "bots.suggest", json!({"title": "Sort the open issues", "why": "37 are untriaged."})).unwrap()["suggestion"]["number"].as_u64().unwrap();

    // Start gives the bot work, so only a person may: the window attaches its proof to it (`guards_request`, which
    // `local_runtime::desktop` asks before it signs), and the control socket's route without that proof is refused.
    let start = json!({"operation": "suggestionStart", "params": {"id": rig.bot, "number": first}});
    let dismiss = json!({"operation": "suggestionDismiss", "params": {"id": rig.bot, "number": second}});
    assert!(crate::serve_cli::consent::guards_request("runtime.session.bots", &start), "the window witnesses Start");
    assert!(!crate::serve_cli::consent::guards_request("runtime.session.bots", &dismiss), "Dismiss gives nothing");
    assert!(crate::bots::enforce::needs_person("suggestionStart", &start["params"]));
    assert!(!crate::bots::enforce::needs_person("suggestionDismiss", &dismiss["params"]));
    let socket = headless_service().0.with_local_lifetime(crate::local_runtime::Lifetime::new(std::time::Duration::ZERO));
    assert_eq!(socket.execute_for_tests("runtime.session.bots", start.clone()).unwrap_err().code, "person_required");
    assert!(crate::bots::items::read(&rig.bot).unwrap().items.is_empty(), "nothing was made without the proof");
    assert!(crate::bots::suggestions::read(&rig.bot).unwrap().open().iter().any(|suggestion| suggestion.number == first), "and it still waits");

    let started = rig.window("suggestionStart", json!({"id": rig.bot, "number": first})).unwrap();
    assert_eq!(started["suggestion"]["state"], "started");
    let number = started["suggestion"]["item"].as_u64().expect("Start names the item it made");
    let items = crate::bots::items::read(&rig.bot).unwrap();
    let item = items.items.iter().find(|item| item.number == number).unwrap();
    assert_eq!((item.title.as_str(), item.state.as_str(), item.asked_by.as_str()), ("Close PR #1247", "inProgress", "owner"));
    // Sent to its home chat as the owner's message, which tells it to begin.
    let sent = crate::bots::items::SENT_FOR_TESTS.with(|sent| sent.borrow().clone());
    assert_eq!(sent.len(), 1, "{sent:?}");
    assert!(sent[0].2.contains("Close PR #1247") && sent[0].2.contains("Start on it now"), "{}", sent[0].2);
    // Started once: a second Start, or a Dismiss after it, is refused, and no second item is made or sent.
    assert!(rig.window("suggestionStart", json!({"id": rig.bot, "number": first})).is_err());
    assert!(rig.window("suggestionDismiss", json!({"id": rig.bot, "number": first})).unwrap_err().to_string().contains("already started"));
    assert_eq!(crate::bots::items::SENT_FOR_TESTS.with(|sent| sent.borrow().len()), 1);
    assert_eq!(crate::bots::items::read(&rig.bot).unwrap().items.len(), items.items.len());

    // Dismiss closes it and tells the bot nothing.
    assert_eq!(rig.window("suggestionDismiss", json!({"id": rig.bot, "number": second})).unwrap()["state"], "dismissed");
    assert_eq!(crate::bots::items::SENT_FOR_TESTS.with(|sent| sent.borrow().len()), 1);
    assert!(rig.window("suggestions", json!({"id": rig.bot})).unwrap()["suggestions"].as_array().unwrap().is_empty());
}

#[test]
fn only_a_bot_suggests_from_its_own_session_while_not_paused_and_a_look_makes_a_few() {
    let _home = crate::store::temp_home();
    let _switches = Switches;
    let rig = Rig::new();
    let (_, entry) = rig.start(Builtin::LookAround, "look-secret");
    let idea = |title: &str| json!({"title": title, "why": "Worth it."});
    // The owner's terminal, a claim it cannot prove, and naming another bot are refused.
    assert_eq!(rig.ask("bots.suggest", idea("From the owner")).unwrap_err().code, "forbidden");
    assert_eq!(rig.as_session(&entry, "wrong-secret", "bots.suggest", idea("Forged")).unwrap_err().code, "unauthorized");
    let mut other = idea("For Iris");
    other["bot"] = json!("iris");
    assert_eq!(rig.as_session(&entry, "look-secret", "bots.suggest", other).unwrap_err().code, "forbidden");
    // A secret is never kept.
    assert_eq!(rig.as_session(&entry, "look-secret", "bots.suggest", json!({"title": "Rotate ghp_abcdefghijklmnopqrstuvwxyz0123", "why": "Leaked."})).unwrap_err().code, "invalid_arguments");
    // One look makes at most a few.
    for n in 0..crate::bots::suggestions::PER_LOOK {
        rig.as_session(&entry, "look-secret", "bots.suggest", idea(&format!("Idea {n}"))).unwrap();
    }
    let refused = rig.as_session(&entry, "look-secret", "bots.suggest", idea("One too many")).unwrap_err();
    assert!(refused.message.contains("at most"), "{}", refused.message);
    // A paused bot suggests nothing.
    crate::bots::pause(rig.service.sink.as_ref(), &rig.bot, crate::bots::OWNER).unwrap();
    let chat = index::load().unwrap().into_iter().find(|entry| crate::bots::chat::session_bot(entry).is_some_and(|bot| bot.id == rig.bot && bot.home)).unwrap();
    rig.service.manager.install_review_test_cli(&chat.id, &chat.tabs[0].id, "home-secret");
    assert!(rig.as_session(&chat, "home-secret", "bots.suggest", idea("While paused")).is_err());
    assert_eq!(crate::bots::suggestions::read(&rig.bot).unwrap().open().len(), crate::bots::suggestions::PER_LOOK, "nothing more was kept");
}

/// The tidy is one change: a run of Tidy memory tidies once, and only its own notes' places.
#[test]
fn a_tidy_run_makes_one_change_and_only_reads_and_tidies() {
    let _home = crate::store::temp_home();
    let rig = Rig::new();
    let (_, entry) = rig.start(Builtin::TidyMemory, "tidy-secret");
    let run = builtins::of_session(&entry).unwrap();
    assert_eq!(run.kind, Builtin::TidyMemory);
    for refused in [shell("terminalx bots memory add 'x'"), shell("terminalx bots memory forget 'x'"), shell("terminalx bots suggest --title a --why b"), call("Write", json!({"file_path": "/tmp/MEMORY.md"}))] {
        assert!(matches!(builtins::gate(&run, &refused), Gate::Refuse(_)), "{refused}");
    }
    assert_eq!(builtins::gate(&run, &shell("terminalx bots memory tidy --plan '{}'")), Gate::Leave);
    assert_eq!(builtins::gate(&run, &shell("terminalx bots memory list")), Gate::Leave);

    for note in ["Status updates go in a table.", "Status updates belong in a table.", "Releases ship on Fridays.", "Releases ship on Tuesdays now."] {
        rig.ask("bots.memory.add", json!({"bot": rig.bot, "text": note})).unwrap();
    }
    let lines: Vec<String> = rig.ask("bots.memory.list", json!({"bot": rig.bot})).unwrap()["lines"].as_array().unwrap().iter().map(|line| line.as_str().unwrap().to_owned()).collect();
    let number = |text: &str| lines.iter().position(|line| line.ends_with(text)).unwrap() + 1;
    let plan = json!({
        "merge": [{"lines": [{"line": number("go in a table."), "note": "Status updates go in a table."}, {"line": number("belong in a table."), "note": "Status updates belong in a table."}], "into": "Status updates go in a table."}],
        "remove": [{"line": number("on Fridays."), "note": "Releases ship on Fridays."}],
    });
    let tidied = rig.as_session(&entry, "tidy-secret", "bots.memory.tidy", json!({"plan": plan})).unwrap();
    assert_eq!(tidied["changes"].as_array().unwrap().len(), 1, "one change: {tidied}");
    assert_eq!(tidied["changes"][0]["kind"], "tidied");
    // Recorded as the bot's, from its duty's session.
    let log = crate::bots::changes::read_log(&rig.bot).unwrap();
    let change = log.changes.last().unwrap();
    assert_eq!((change.by.as_str(), change.source.kind.as_str(), change.source.session.as_deref()), (rig.bot.as_str(), "duty", Some(entry.id.as_str())));
    // A second tidy in the same run is refused.
    let again = json!({"remove": [{"line": 1, "note": "x"}]});
    assert_eq!(rig.as_session(&entry, "tidy-secret", "bots.memory.tidy", json!({"plan": again})).unwrap_err().code, "forbidden");
}
