//! The built-in duties (PRO-477): made once per bot, kept as built-ins, a free
//! check before any model, their prompts, and the memory tidy as one
//! undoable change.

use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use crate::automations::{AutomationHost, DueAction};
use crate::session::SessionManager;
use crate::sink::BroadcastSink;

struct Rig {
    sink: Arc<BroadcastSink>,
    manager: SessionManager,
    _home: crate::store::TempHome,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.manager.closing();
        self.manager.terminals().kill_all();
    }
}

fn rig() -> Rig {
    let home = crate::store::temp_home();
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = true;
    crate::store::settings::save(&settings).unwrap();
    let sink = Arc::new(BroadcastSink::new(1024));
    let manager = SessionManager::new(
        sink.clone(),
        Arc::new(crate::sink::NoObserver),
        Arc::new(crate::harness::host::Host::new()),
        Arc::new(crate::pty::Terminals::new()),
        Arc::new(Default::default()),
        Arc::new(Default::default()),
        crate::hooks::prepare_control().unwrap(),
    );
    Rig { sink, manager, _home: home }
}

impl Rig {
    /// The runtime's `bots` call, as the window's route hands it on.
    fn bots(&self, operation: &str, params: Value) -> Result<Value> {
        let sink: Arc<dyn EventSink> = self.sink.clone();
        crate::local_runtime::calls::execute(&self.manager, &sink, "runtime.session.bots", json!({"operation": operation, "params": params}))
    }

    fn hire(&self, name: &str) -> Bot {
        serde_json::from_value(self.bots("create", json!({"roleTemplateId": "cto", "name": name})).unwrap()).unwrap()
    }

    fn builtin(&self, bot: &Bot, kind: Builtin) -> Automation {
        duties::duties_of(&bot.id).unwrap().into_iter().find(|duty| of(duty) == Some(kind)).expect("the built-in")
    }

    fn host(&self) -> Host {
        Host(self.sink.clone(), self.manager.clone())
    }
}

#[derive(Clone)]
struct Host(Arc<BroadcastSink>, SessionManager);

impl AutomationHost for Host {
    fn sink(&self) -> Arc<dyn EventSink> {
        self.0.clone()
    }
    fn sessions(&self) -> Result<SessionManager> {
        Ok(self.1.clone())
    }
    fn execution_continues(&self, _: &str, _: &str) -> bool {
        false
    }
    fn with_quiescent_execution<T>(&self, _: &str, _: &str, _: Option<u64>, action: impl FnOnce() -> T) -> Option<T> {
        Some(action())
    }
    fn with_current_turn<T>(&self, _: &str, _: &str, _: Option<u64>, action: impl FnOnce() -> T) -> Option<T> {
        Some(action())
    }
}

fn completed(duty: &Automation) -> AutomationRun {
    serde_json::from_value(json!({"runId": format!("{}-1", duty.id), "runNumber": 1, "automationId": duty.id, "trigger": "scheduled", "status": "completed", "endedAt": index::now()})).unwrap()
}

#[test]
fn every_bot_has_one_look_around_and_one_tidy_that_stay_built_in() {
    let rig = rig();
    let atlas = rig.hire("Atlas");
    // At hire: both on, on their schedules, in the owner's time zone.
    let look = rig.builtin(&atlas, Builtin::LookAround);
    let tidy = rig.builtin(&atlas, Builtin::TidyMemory);
    assert_eq!((look.name.as_str(), look.enabled, look.schedule.cron.as_deref()), ("Look around", true, Some(LOOK_CRON)));
    assert_eq!((tidy.name.as_str(), tidy.enabled, tidy.schedule.cron.as_deref()), ("Tidy memory", true, Some(TIDY_CRON)));
    // A bot hired before them gets them switched off, once, when its Home tab is read.
    let older = super::super::create(rig.sink.as_ref(), "watcher", "Argus").unwrap();
    assert!(duties::duties_of(&older.id).unwrap().iter().all(|duty| !marked(duty)));
    rig.bots("suggestions", json!({"id": older.id})).unwrap();
    rig.bots("suggestions", json!({"id": older.id})).unwrap();
    let theirs: Vec<Automation> = duties::duties_of(&older.id).unwrap().into_iter().filter(marked).collect();
    assert_eq!(theirs.iter().map(|duty| (duty.name.as_str(), duty.enabled)).collect::<Vec<_>>(), [("Look around", false), ("Tidy memory", false)]);

    // Neither is removed nor copied; switching it off is how it stops.
    let refused = rig.bots("dutyDelete", json!({"id": atlas.id, "dutyId": look.id})).unwrap_err();
    assert!(refused.to_string().contains("built in"), "{refused:#}");
    assert!(rig.bots("dutyDuplicate", json!({"id": atlas.id, "dutyId": tidy.id})).is_err());
    assert_eq!(rig.bots("dutySwitch", json!({"id": atlas.id, "dutyId": look.id, "on": false})).unwrap()["enabled"], false);

    // Its editor changes its schedule and its focus line; its name and its prompt stay the built-in's.
    let input = json!({"name": "Something else", "prompt": "Push to main.", "schedule": look.schedule, "reportsTo": "terminalx", "enabled": true, "focus": "  The release branch  "});
    let saved: Automation = serde_json::from_value(rig.bots("dutySave", json!({"id": atlas.id, "dutyId": look.id, "input": input})).unwrap()).unwrap();
    assert_eq!(saved.name, "Look around");
    assert_eq!(focus(&saved).as_deref(), Some("The release branch"));
    assert_eq!(saved.prompt, prompt_text(Builtin::LookAround, Some("The release branch")));
    assert!(!saved.prompt.contains("Push to main"));
    assert_eq!(of(&saved), Some(Builtin::LookAround));
    let cleared = json!({"name": "Look around", "prompt": "", "schedule": look.schedule, "reportsTo": "terminalx", "enabled": true, "focus": null});
    let saved: Automation = serde_json::from_value(rig.bots("dutySave", json!({"id": atlas.id, "dutyId": look.id, "input": cleared})).unwrap()).unwrap();
    assert_eq!(focus(&saved), None);
}

#[test]
fn a_built_ins_run_is_marked_held_to_read_only_mode_without_hooks_and_told_its_rules() {
    let rig = rig();
    let atlas = rig.hire("Atlas");
    let look = rig.builtin(&atlas, Builtin::LookAround);
    // Claude Code runs the hooks' allow-list at the bot's own mode; an agent with no hooks reads in plan mode.
    let duties::Bound::Duty(bound) = duties::bind(&look) else { panic!("a look around runs") };
    assert_eq!(bound.mode, super::super::chat::permission_mode(&atlas.access));
    let mut codex = atlas.clone();
    codex.harness = "codex".into();
    assert_eq!(run_mode(&codex), "plan");

    let run = crate::store::automations::insert_run(serde_json::from_value(json!({"runId": "look-1", "runNumber": 1, "automationId": look.id, "trigger": "scheduled", "status": "running"})).unwrap()).unwrap();
    let entry = duties::open_session(rig.sink.as_ref(), &look, &run).unwrap();
    assert_eq!(entry.unknown[duties::SESSION_KEY], json!({"id": look.id, "builtin": "lookAround"}));
    assert_eq!(of_session(&entry), Some(Run { kind: Builtin::LookAround, bot: atlas.id.clone(), duty: look.id.clone(), run: Some("look-1".into()) }));
    // A session marked with a built-in this build does not know only reads.
    let mut newer = entry.clone();
    newer.unknown.insert(duties::SESSION_KEY.into(), json!({"id": look.id, "builtin": "auditEverything"}));
    assert_eq!(of_session(&newer).unwrap().kind, Builtin::LookAround);

    // Its prompt: what it may do, how to suggest, what still waits, and no duty note to write.
    super::super::suggestions::suggest(rig.sink.as_ref(), &atlas, "Close PR #1247", "#1198 covers it.", Default::default()).unwrap();
    let prompt = duties::prompt(&look, &run, look.prompt.clone()).unwrap();
    assert!(prompt.contains("you only read") && prompt.contains("terminalx bots suggest --title"), "{prompt}");
    assert!(prompt.contains("Close PR #1247") && prompt.contains("<suggestions>"), "what still waits, fenced: {prompt}");
    assert!(!prompt.contains(&duties::note_file(&look.id)), "{prompt}");
    let tidy = rig.builtin(&atlas, Builtin::TidyMemory);
    let prompt = duties::prompt(&tidy, &run, tidy.prompt.clone()).unwrap();
    assert!(prompt.contains("terminalx bots memory tidy --plan") && prompt.contains("one change"), "{prompt}");
}

#[test]
fn a_look_around_with_nothing_new_to_see_costs_no_model_and_is_logged_as_nothing_new() {
    let rig = rig();
    let atlas = rig.hire("Atlas");
    let look = rig.builtin(&atlas, Builtin::LookAround);
    // Nothing remembered yet: it goes ahead.
    assert_eq!(nothing_to_do(Builtin::LookAround, &atlas), None);
    // A look that finished remembers what it saw; with nothing changed since, the next one is not needed.
    ended(Builtin::LookAround, &atlas, &completed(&look));
    let why = nothing_to_do(Builtin::LookAround, &atlas).expect("nothing changed");
    assert!(why.starts_with("Nothing new"), "{why}");
    // Another bot, its chats and its own looks are not what this one watches: still nothing new.
    let iris = rig.hire("Iris");
    let theirs = rig.builtin(&iris, Builtin::LookAround);
    let run = crate::store::automations::insert_run(serde_json::from_value(json!({"runId": "iris-look-1", "runNumber": 1, "automationId": theirs.id, "trigger": "scheduled", "status": "running"})).unwrap()).unwrap();
    duties::open_session(rig.sink.as_ref(), &theirs, &run).unwrap();
    assert!(nothing_to_do(Builtin::LookAround, &atlas).is_some(), "another bot's sessions count for nothing");
    // A new focus line is a reason to look again.
    let refocus = json!({"name": "Look around", "prompt": "", "schedule": look.schedule, "reportsTo": "terminalx", "enabled": true, "focus": "The release branch"});
    rig.bots("dutySave", json!({"id": atlas.id, "dutyId": look.id, "input": refocus})).unwrap();
    assert_eq!(nothing_to_do(Builtin::LookAround, &atlas), None, "the focus changed");
    ended(Builtin::LookAround, &atlas, &completed(&look));
    assert!(nothing_to_do(Builtin::LookAround, &atlas).is_some());
    // A change it can see (a new item on its list) and it goes ahead.
    super::super::items::add(rig.sink.as_ref(), &atlas, &super::super::items::By::Owner, super::super::items::NewItem { title: "Ship it".into(), summary: String::new(), done_means: Vec::new(), start: false, asked_by: None, added_by: None }).unwrap();
    assert_eq!(nothing_to_do(Builtin::LookAround, &atlas), None);
    // A failed look remembers nothing.
    let mut failed = completed(&look);
    failed.status = AutomationRunStatus::Failed;
    ended(Builtin::LookAround, &atlas, &failed);
    assert_eq!(nothing_to_do(Builtin::LookAround, &atlas), None);
    // While enough of its suggestions wait on the owner, it makes no more.
    for n in 0..WAITING_LIMIT {
        super::super::suggestions::suggest(rig.sink.as_ref(), &atlas, &format!("Idea {n}"), "Worth it.", Default::default()).unwrap();
    }
    assert!(nothing_to_do(Builtin::LookAround, &atlas).unwrap().contains("still waiting for you"));

    // Due on its schedule, the scheduler records it as nothing new and starts no session.
    crate::store::automations::update(&look.id, |duty| {
        duty.next_run_at = (chrono::Utc::now() - chrono::TimeDelta::minutes(1)).to_rfc3339();
        Ok(())
    })
    .unwrap();
    let look = crate::store::automations::get(&look.id).unwrap();
    let now = chrono::Utc::now();
    assert!(matches!(crate::automations::due_action(&look, now), Ok(Some(DueAction::Dispatch { .. }))));
    assert!(!duties::may_wake(&rig.host(), &look, now));
    let runs = crate::store::automations::list_runs(&look.id).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, AutomationRunStatus::SkippedPrecheck);
    assert!(runs[0].error.as_deref().unwrap().contains("still waiting"), "{:?}", runs[0].error);
    assert!(runs[0].session_id.is_none(), "no session, no model");
    assert!(crate::store::automations::get(&look.id).unwrap().next_run_at > look.next_run_at, "its next run moved on");
    // The Home tab says so.
    let status = status(&atlas).unwrap();
    assert_eq!(status["lookAround"]["last"]["status"], "skippedPrecheck");
    assert!(status["lookAround"]["last"]["why"].as_str().unwrap().starts_with("Nothing new"));
}

#[test]
fn a_tidy_waits_until_memory_changed_since_the_last_one() {
    let rig = rig();
    let atlas = rig.hire("Atlas");
    let tidy = rig.builtin(&atlas, Builtin::TidyMemory);
    assert!(nothing_to_do(Builtin::TidyMemory, &atlas).unwrap().contains("fewer than two notes"));
    let add = |bot: &Bot, text: &str| memory::add(rig.sink.as_ref(), bot, &memory::Place::Bot, text, super::super::OWNER, super::super::changes::Source::of("app")).unwrap();
    add(&atlas, "Status updates go in a table.");
    add(&atlas, "Status updates belong in a table.");
    assert_eq!(nothing_to_do(Builtin::TidyMemory, &atlas), None);
    ended(Builtin::TidyMemory, &atlas, &completed(&tidy));
    assert!(nothing_to_do(Builtin::TidyMemory, &atlas).unwrap().contains("not changed since the last tidy"));
    add(&atlas, "Releases ship on Tuesdays.");
    assert_eq!(nothing_to_do(Builtin::TidyMemory, &atlas), None);
    let off = super::super::update(rig.sink.as_ref(), &atlas.id, super::super::BotPatch { memory_off: Some(true), ..Default::default() }).unwrap();
    assert!(nothing_to_do(Builtin::TidyMemory, &off).unwrap().contains("memory is off"));
}

/// Every tidy is one undoable history entry (PRO-470's history).
#[test]
fn a_tidy_merges_and_removes_as_one_change_that_one_undo_puts_back() {
    let rig = rig();
    let atlas = rig.hire("Atlas");
    let source = || super::super::changes::Source::of("app");
    for note in ["Status updates go in a table.", "Merges wait for CI.", "Status updates belong in a table.", "Releases ship on Fridays.", "Releases ship on Tuesdays now."] {
        memory::add(rig.sink.as_ref(), &atlas, &memory::Place::Bot, note, super::super::OWNER, source()).unwrap();
    }
    let home = super::super::home(&atlas).unwrap();
    let read = || std::fs::read_to_string(home.join(memory::Place::Bot.memory_file())).unwrap();
    let before = read();
    let lines: Vec<&str> = before.lines().collect();
    let number = |text: &str| lines.iter().position(|line| line.ends_with(text)).unwrap() + 1;
    let line = |text: &str| memory::TidyLine { place: None, line: number(text), note: text.into() };
    let plan = memory::TidyPlan {
        merge: vec![memory::TidyMerge { lines: vec![line("Status updates go in a table."), line("Status updates belong in a table.")], into: "Status updates go in a table, newest first.".into() }],
        remove: vec![line("Releases ship on Fridays.")],
    };
    let places = memory::conversation_places(&atlas);
    let log_before = super::super::changes::read_log(&atlas.id).unwrap().changes.len();
    let recorded = memory::tidy(rig.sink.as_ref(), &atlas, &plan, &places, &atlas.id, source(), None).unwrap();
    assert_eq!(recorded.len(), 1, "one change");
    assert_eq!((recorded[0].kind.as_str(), recorded[0].text.as_str()), (memory::TIDY_KIND, "Tidied memory: merged 2 notes into 1 note, removed 1 note"));
    assert_eq!(super::super::changes::read_log(&atlas.id).unwrap().changes.len(), log_before + 1);
    let after = read();
    let notes: Vec<&str> = after.lines().filter(|line| line.starts_with("- ")).map(memory::note_text).collect();
    // The merged note takes the place of the first it was made from; the others stay in order.
    assert_eq!(notes, ["Status updates go in a table, newest first.", "Merges wait for CI.", "Releases ship on Tuesdays now."]);

    // One Undo puts every note back where it was.
    memory::undo(rig.sink.as_ref(), &atlas, &recorded[0].id, super::super::OWNER, source()).unwrap();
    assert_eq!(read(), before);

    // A Tidy memory run tidies once, judged under the history's lock: its second tidy is refused and writes nothing.
    let run_source = || super::super::changes::Source { session: Some("tidy-run".into()), ..source() };
    let plan = memory::TidyPlan { remove: vec![memory::TidyLine { place: None, line: number("Releases ship on Fridays."), note: "Releases ship on Fridays.".into() }], ..Default::default() };
    memory::tidy(rig.sink.as_ref(), &atlas, &plan, &places, &atlas.id, run_source(), Some("tidy-run")).unwrap();
    let once = read();
    let again = memory::TidyPlan { remove: vec![memory::TidyLine { place: None, line: 1 + once.lines().position(|line| line.ends_with("Merges wait for CI.")).unwrap(), note: "Merges wait for CI.".into() }], ..Default::default() };
    let refused = memory::tidy(rig.sink.as_ref(), &atlas, &again, &places, &atlas.id, run_source(), Some("tidy-run")).unwrap_err();
    assert!(refused.to_string().contains("already tidied"), "{refused:#}");
    assert_eq!(read(), once);
}

#[test]
fn a_tidy_is_refused_whole_when_its_lines_do_not_read_as_named() {
    let rig = rig();
    let atlas = rig.hire("Atlas");
    let source = || super::super::changes::Source::of("app");
    for note in ["One.", "Two.", "Three."] {
        memory::add(rig.sink.as_ref(), &atlas, &memory::Place::Bot, note, super::super::OWNER, source()).unwrap();
    }
    let home = super::super::home(&atlas).unwrap();
    let before = std::fs::read_to_string(home.join(memory::Place::Bot.memory_file())).unwrap();
    let at = |text: &str| before.lines().position(|line| line.ends_with(text)).unwrap() + 1;
    let places = memory::conversation_places(&atlas);
    let tidy = |plan: memory::TidyPlan| memory::tidy(rig.sink.as_ref(), &atlas, &plan, &places, &atlas.id, source(), None).unwrap_err().to_string();
    let named = |line: usize, note: &str| memory::TidyLine { place: None, line, note: note.into() };
    assert!(tidy(memory::TidyPlan::default()).contains("Nothing to tidy"));
    assert!(tidy(memory::TidyPlan { remove: vec![named(at("One."), "Two.")], ..Default::default() }).contains("memory changed since it was read"));
    assert!(tidy(memory::TidyPlan { remove: vec![named(at("One."), "One."), named(at("One."), "One.")], ..Default::default() }).contains("named twice"));
    assert!(tidy(memory::TidyPlan { merge: vec![memory::TidyMerge { lines: vec![named(at("One."), "One.")], into: "One".into() }], ..Default::default() }).contains("two or more"));
    assert!(tidy(memory::TidyPlan { remove: vec![named(1, "# Memory")], ..Default::default() }).contains("does not read"), "a heading is no note");
    assert!(tidy(memory::TidyPlan { merge: vec![memory::TidyMerge { lines: vec![named(at("One."), "One."), named(at("Two."), "Two.")], into: "token ghp_abcdefghijklmnopqrstuvwxyz0123".into() }], ..Default::default() }).contains("secret"));
    // A place the caller may not tidy.
    let personal = memory::TidyLine { place: Some("personal".into()), line: 1, note: "x".into() };
    let only_own = [memory::Place::Bot];
    let refused = memory::tidy(rig.sink.as_ref(), &atlas, &memory::TidyPlan { remove: vec![personal], ..Default::default() }, &only_own, &atlas.id, source(), None).unwrap_err();
    assert!(refused.to_string().contains("may not change"), "{refused:#}");
    // Nothing was written by any of them.
    assert_eq!(std::fs::read_to_string(home.join(memory::Place::Bot.memory_file())).unwrap(), before);
}
