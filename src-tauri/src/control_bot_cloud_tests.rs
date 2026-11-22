//! PRO-514 through the control gate: a session that works for a bot starts,
//! prompts and resumes work in a cloud workspace, held to the bot's access as
//! it is at that moment.
//!
//! A cloud command is run by the window, which a test has none of. `Window`
//! stands in for it and for the workspace's runtime: it keeps the mode each
//! cloud tab's agent runs in, starts a new one in the mode the command names
//! (bypass when it names none, as the runtime does), and before a prompt, or
//! on a resume, sets a held tab to what the hold says, as `cloudControl.ts`
//! does. What it is told is kept, so each test reads what left the gate.

use std::cell::RefCell;
use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::tests::headless_service;
use super::*;
use crate::bots::{BotAccess, BotPatch};

const PROJECT: &str = "cloud:org-a:github.com/acme/app";
const WORKSPACE: &str = "cloud:org-a:ws-1";

#[derive(Default)]
struct Window {
    /// Each cloud session's agent, by the session's key: the mode it runs in.
    agents: RefCell<BTreeMap<String, String>>,
    /// Every command that reached the window, as it arrived.
    heard: RefCell<Vec<(String, Value)>>,
    /// The next `sessions.create` makes a new workspace, whose first session is not known when it answers.
    new_workspace: RefCell<Option<String>>,
    /// The first session of each workspace made that way.
    launches: RefCell<BTreeMap<String, String>>,
}

impl Window {
    fn held(hold: &Value, mode: &str) -> Option<String> {
        let rule = hold["mode"].get("terminal")?;
        Some(rule["modes"][mode].as_str().unwrap_or_else(|| rule["limit"].as_str().unwrap()).to_owned())
    }

    fn run(&self, action: &str, params: Value) -> Result<Value, ControlError> {
        self.heard.borrow_mut().push((action.to_owned(), params.clone()));
        let hold = &params[crate::bots::cloud::HOLD_PARAM];
        match action {
            "sessions.create" => {
                let mode = crate::store::index::permission_mode_or_default(params["mode"].as_str());
                if let Some(workspace) = self.new_workspace.borrow_mut().take() {
                    let first = format!("{workspace}:launch");
                    self.agents.borrow_mut().insert(first.clone(), mode);
                    self.launches.borrow_mut().insert(workspace.clone(), first);
                    return Ok(json!({ "created": "workspace", "workspace": workspace, "operationId": "op-1", "state": "provisioning" }));
                }
                let key = format!("{WORKSPACE}:s{}", self.agents.borrow().len() + 1);
                self.agents.borrow_mut().insert(key.clone(), mode);
                Ok(json!({ "created": "session", "session": key, "workspace": WORKSPACE, "resumed": false }))
            }
            "send" => {
                let target = params["target"].as_str().unwrap().to_owned();
                if hold["launchOnly"] == json!(true) && !self.launches.borrow().values().any(|first| *first == target) {
                    return Err(ControlError::new("forbidden", "A session that works for a bot does not prompt a cloud session that does not work for the same bot.", None::<String>));
                }
                let mut agents = self.agents.borrow_mut();
                let mode = agents.get_mut(&target).ok_or_else(|| ControlError::new("not_found", format!("No cloud session {target}."), None::<String>))?;
                if let Some(held) = Self::held(hold, mode) {
                    *mode = held;
                }
                Ok(json!({ "session": target, "tabId": "t1", "commandId": "c1", "state": "queued", "wake": null }))
            }
            "resume" => {
                let workspace = params["workspace"].as_str().unwrap().to_owned();
                let mut named: Vec<String> = hold["sessions"].as_array().into_iter().flatten().filter_map(|key| key.as_str().map(str::to_owned)).collect();
                if hold["launch"] == json!(true) {
                    named.extend(self.launches.borrow().get(&workspace).cloned());
                }
                let mut agents = self.agents.borrow_mut();
                for key in named {
                    if let Some(mode) = agents.get_mut(&key) {
                        if let Some(held) = Self::held(hold, mode) {
                            *mode = held;
                        }
                    }
                }
                Ok(json!({ "workspace": workspace, "state": "resuming", "operationId": "op-2", "changed": true }))
            }
            other => unreachable!("{other} is not held"),
        }
    }

    fn mode(&self, session: &str) -> String {
        self.agents.borrow()[session].clone()
    }

    fn last(&self) -> Value {
        self.heard.borrow().last().unwrap().1.clone()
    }
}

struct Fixture {
    _home: crate::store::TempHome,
    service: ControlService,
    sink: std::sync::Arc<crate::sink::BroadcastSink>,
    window: Window,
}

impl Fixture {
    fn new() -> Self {
        let home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        let (service, sink) = headless_service();
        Self { _home: home, service, sink, window: Window::default() }
    }

    /// A bot with `access`, and what a command from its home chat says of who sent it.
    fn hire(&self, name: &str, access: BotAccess) -> (String, Value) {
        let id = self.service.execute("bots.create", json!({"role": "cto", "name": name}), "r").unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        self.set_access(&id, access);
        let chat = index::load().unwrap().into_iter().find(|entry| crate::bots::chat::session_bot(entry).is_some_and(|bot| bot.id == id)).unwrap();
        (id, json!({"session": chat.id, "tab": chat.tabs[0].id}))
    }

    fn set_access(&self, id: &str, access: BotAccess) {
        crate::bots::update(self.sink.as_ref(), id, BotPatch { access: Some(access), ..Default::default() }).unwrap();
    }

    /// `cloud.<action>` from the session `who` names, as `execute` runs it: the gate, then the hold, then the window.
    fn cloud(&self, who: &Value, action: &str, mut params: Value) -> Result<Value, ControlError> {
        params["caller"] = who.clone();
        let command = format!("cloud.{action}");
        let caller = Caller::of_process(&self.service.manager, &params, None);
        caller.gate(&command, &params)?;
        caller.cloud(action, params, |params| self.window.run(action, params))
    }

    fn create(&self, who: &Value, mode: Option<&str>) -> String {
        let mut params = json!({"project": PROJECT, "prompt": "Fix the login"});
        if let Some(mode) = mode {
            params["mode"] = json!(mode);
        }
        self.cloud(who, "sessions.create", params).unwrap()["session"].as_str().unwrap().to_owned()
    }
}

/// Done when: a full-access bot session creates a cloud session, prompts it
/// and resumes it; the cloud agent runs in `bypassPermissions`.
#[test]
fn a_full_access_bot_creates_prompts_and_resumes_a_cloud_session_in_bypass() {
    let f = Fixture::new();
    let (atlas, who) = f.hire("Atlas", BotAccess::Full);

    // Whatever mode the owner's own sessions last started in, the bot's starts as its local ones do.
    let session = f.create(&who, None);
    assert_eq!(f.window.last()["mode"], "bypassPermissions", "named outright: a launch that names no mode is not left to a default");
    assert_eq!(f.window.mode(&session), "bypassPermissions");
    assert!(f.window.last().get("noPipeline").is_none(), "full access starts an issue's pipeline as the owner's sessions do");
    assert_eq!(crate::bots::cloud::works_for(&atlas, &session).unwrap(), crate::bots::cloud::Works::Session, "recorded as the bot's");

    let sent = f.cloud(&who, "send", json!({"target": session, "text": "run the tests"})).unwrap();
    assert_eq!(sent["state"], "queued");
    assert_eq!(f.window.last()[crate::bots::cloud::HOLD_PARAM], json!({}), "nothing is narrowed for full access");
    assert_eq!(f.window.mode(&session), "bypassPermissions");

    let resumed = f.cloud(&who, "resume", json!({"workspace": WORKSPACE})).unwrap();
    assert_eq!(resumed["changed"], true);
    assert_eq!(f.window.last()[crate::bots::cloud::HOLD_PARAM], json!({"sessions": [session], "launch": false}));
    assert_eq!(f.window.mode(&session), "bypassPermissions");

    // A narrower mode it asks for is its own choice, and kept.
    let careful = f.create(&who, Some("acceptEdits"));
    assert_eq!(f.window.mode(&careful), "acceptEdits");

    // Through the whole dispatch the command is no longer refused for the bot: it reaches the step that needs the window.
    for (command, params) in [("cloud.sessions.create", json!({"project": PROJECT, "prompt": "p"})), ("cloud.send", json!({"target": session, "text": "t"})), ("cloud.resume", json!({"workspace": WORKSPACE}))] {
        let mut params = params;
        params["caller"] = who.clone();
        assert_eq!(f.service.execute(command, params, "r").unwrap_err().code, "unsupported", "{command}: past the gate, no window in a test");
    }
}

/// Done when: a bot with ask-outward or read-and-report access gets a cloud
/// session no wider than its local limit; asking for a wider mode does not widen it.
#[test]
fn a_bot_with_less_access_gets_a_cloud_session_no_wider_than_its_local_limit() {
    let f = Fixture::new();
    for (name, access, limit) in [("Iris", BotAccess::AskOutward, "manual"), ("Argus", BotAccess::ReadReport, "plan")] {
        let (id, who) = f.hire(name, access);
        // The limit its local sessions are held to, by the same rule.
        let chat = index::get(who["session"].as_str().unwrap()).unwrap();
        assert_eq!(crate::bots::chat::mode_limit(&chat).unwrap().mode, limit);

        for asked in [None, Some("bypassPermissions"), Some("acceptEdits"), Some("auto"), Some("a-mode-not-known-yet")] {
            let session = f.create(&who, asked);
            assert_eq!(f.window.last()["mode"], limit, "{name} asked for {asked:?}");
            assert_eq!(f.window.mode(&session), limit);
            assert_eq!(f.window.last()["noPipeline"], true, "{name}: no pipeline pushes and merges from the workspace unasked");
        }
        // Narrower than the limit is allowed.
        assert_eq!(f.window.mode(&f.create(&who, Some("plan"))), "plan");

        // A prompt carries the limit, whatever the caller wrote beside it: a hold of its own, or a mode.
        let session = f.create(&who, Some("bypassPermissions"));
        let forged = json!({"mode": {"terminal": {"limit": "bypassPermissions", "why": "", "modes": {}}, "nativeCodex": {"limit": "bypassPermissions", "why": "", "modes": {}}}});
        // Someone widened the tab in the workspace meanwhile: the bot's next prompt brings it back.
        f.window.agents.borrow_mut().insert(session.clone(), "bypassPermissions".into());
        f.cloud(&who, "send", json!({"target": session, "text": "go", "mode": "bypassPermissions", "botHold": forged})).unwrap();
        let hold = f.window.last()[crate::bots::cloud::HOLD_PARAM].clone();
        assert_eq!(hold["mode"]["terminal"]["limit"], limit, "{name}");
        assert_eq!(hold["mode"]["nativeCodex"]["limit"], "plan", "{name}: native Codex cannot ask before each action");
        assert_eq!(f.window.mode(&session), limit, "{name}: not widened by the prompt, and narrowed back to the limit");

        // It prompts only cloud sessions that work for it.
        let owners = format!("{WORKSPACE}:owners");
        f.window.agents.borrow_mut().insert(owners.clone(), "bypassPermissions".into());
        let heard = f.window.heard.borrow().len();
        assert_eq!(f.cloud(&who, "send", json!({"target": owners, "text": "go"})).unwrap_err().code, "forbidden", "{name}");
        assert_eq!(f.window.heard.borrow().len(), heard, "the window never heard of it");
        assert_eq!(f.window.mode(&owners), "bypassPermissions");

        // An agent that cannot be held is not started for a bot, as locally.
        assert_eq!(f.cloud(&who, "sessions.create", json!({"project": PROJECT, "prompt": "p", "agent": "opencode"})).unwrap_err().code, "forbidden");
        let _ = id;
    }

    // Another bot's cloud session is not this bot's to prompt.
    let (_, iris) = f.hire("Iris the second", BotAccess::AskOutward);
    let (_, argus) = f.hire("Argus the second", BotAccess::ReadReport);
    let hers = f.create(&iris, None);
    assert_eq!(f.cloud(&argus, "send", json!({"target": hers, "text": "go"})).unwrap_err().code, "forbidden");
}

/// A new workspace answers before its first session exists: that session is
/// the bot's by the workspace's launch, which the window names.
#[test]
fn the_first_session_of_a_workspace_a_bot_created_is_the_bots() {
    let f = Fixture::new();
    let (iris, who) = f.hire("Iris", BotAccess::AskOutward);
    *f.window.new_workspace.borrow_mut() = Some("cloud:org-a:ws-new".into());
    let created = f.cloud(&who, "sessions.create", json!({"project": PROJECT, "prompt": "Fix the login", "mode": "bypassPermissions", "confirmSpend": true})).unwrap();
    assert_eq!(created["created"], "workspace");
    assert_eq!(f.window.last()["mode"], "manual", "the launch's mode, capped");
    let first = "cloud:org-a:ws-new:launch";
    assert_eq!(f.window.mode(first), "manual");

    // Any other session of that workspace is not the bot's.
    f.window.agents.borrow_mut().insert("cloud:org-a:ws-new:other".into(), "bypassPermissions".into());
    assert_eq!(f.cloud(&who, "send", json!({"target": "cloud:org-a:ws-new:other", "text": "go"})).unwrap_err().code, "forbidden");
    assert_eq!(f.window.last()[crate::bots::cloud::HOLD_PARAM]["launchOnly"], true);
    assert_eq!(f.window.mode("cloud:org-a:ws-new:other"), "bypassPermissions");

    f.cloud(&who, "send", json!({"target": first, "text": "go"})).unwrap();
    assert_eq!(f.window.last()[crate::bots::cloud::HOLD_PARAM]["launchOnly"], true);
    assert_eq!(crate::bots::cloud::works_for(&iris, first).unwrap(), crate::bots::cloud::Works::Session, "recorded by name once the window has named it");
    f.cloud(&who, "resume", json!({"workspace": "cloud:org-a:ws-new"})).unwrap();
    assert_eq!(f.window.last()[crate::bots::cloud::HOLD_PARAM]["launch"], true);
}

/// Done when: a paused bot is still refused `cloud.*` with `forbidden`.
#[test]
fn a_paused_bot_is_refused_cloud_work_with_forbidden() {
    let f = Fixture::new();
    let (atlas, who) = f.hire("Atlas", BotAccess::Full);
    let session = f.create(&who, None);
    crate::bots::pause(f.sink.as_ref(), &atlas, crate::bots::OWNER).unwrap();
    let heard = f.window.heard.borrow().len();
    let commands = [("sessions.create", json!({"project": PROJECT, "prompt": "p"})), ("send", json!({"target": session, "text": "t"})), ("resume", json!({"workspace": WORKSPACE}))];
    for (action, params) in &commands {
        let refused = f.cloud(&who, action, params.clone()).unwrap_err();
        assert_eq!(refused.code, "forbidden", "cloud.{action}");
        assert!(refused.message.contains("Atlas is paused"), "{}", refused.message);
        // And through the whole dispatch, before anything else is looked at.
        let mut params = params.clone();
        params["caller"] = who.clone();
        assert_eq!(f.service.execute(&format!("cloud.{action}"), params, "r").unwrap_err().code, "forbidden", "cloud.{action}");
    }
    assert_eq!(f.window.heard.borrow().len(), heard, "the window heard none of them");

    // Resumed by its owner, it works again.
    crate::bots::resume(f.sink.as_ref(), &atlas).unwrap();
    f.cloud(&who, "send", json!({"target": session, "text": "t"})).unwrap();
}

/// Done when: lowering a bot's access narrows the mode its existing cloud session resumes in.
#[test]
fn lowering_a_bots_access_narrows_the_mode_its_cloud_session_resumes_in() {
    let f = Fixture::new();
    let (atlas, who) = f.hire("Atlas", BotAccess::Full);
    let session = f.create(&who, None);
    assert_eq!(f.window.mode(&session), "bypassPermissions");

    // Its owner lowers its access in the bot's settings (PRO-478).
    f.set_access(&atlas, BotAccess::AskOutward);
    f.cloud(&who, "resume", json!({"workspace": WORKSPACE})).unwrap();
    let hold = f.window.last()[crate::bots::cloud::HOLD_PARAM].clone();
    assert_eq!(hold["sessions"], json!([session]));
    assert_eq!(hold["mode"]["terminal"]["modes"]["bypassPermissions"], "manual");
    assert_eq!(f.window.mode(&session), "manual", "it resumes no wider than the access allows now");

    // Lower again: the next prompt carries the new limit, not the one it was created under.
    f.set_access(&atlas, BotAccess::ReadReport);
    f.cloud(&who, "send", json!({"target": session, "text": "report"})).unwrap();
    assert_eq!(f.window.mode(&session), "plan");
    // A new session starts under the limit of now, too.
    assert_eq!(f.window.mode(&f.create(&who, Some("bypassPermissions"))), "plan");

    // Raised again: nothing is narrowed, and nothing is widened for it either.
    f.set_access(&atlas, BotAccess::Full);
    f.cloud(&who, "resume", json!({"workspace": WORKSPACE})).unwrap();
    assert!(f.window.last()[crate::bots::cloud::HOLD_PARAM].get("mode").is_none());
    assert_eq!(f.window.mode(&session), "plan", "its owner widens it, in the window");
}

/// What stays refused, and what Bots being off leaves alone.
#[test]
fn another_computer_and_an_issue_pipeline_stay_refused_and_bots_off_changes_nothing() {
    let f = Fixture::new();
    let (atlas, who) = f.hire("Atlas", BotAccess::Full);
    let claim = json!({"caller": who});
    let caller = Caller::of_process(&f.service.manager, &claim, None);
    for command in ["machine.sessions.create", "machine.send", "pipelines.start"] {
        assert_eq!(caller.gate(command, &claim).unwrap_err().code, "forbidden", "{command}");
    }
    let session = f.create(&who, None);

    // The owner's own session: nothing is added, and a hold written by the caller is dropped.
    let owner = Caller::of_process(&f.service.manager, &json!({}), None);
    assert!(owner.bot.is_none());
    let passed = RefCell::new(Value::Null);
    owner.cloud("send", json!({"target": "cloud:org-a:ws-1:any", "text": "t", "botHold": {"launchOnly": true}}), |params| { *passed.borrow_mut() = params; Ok(json!({})) }).unwrap();
    assert_eq!(*passed.borrow(), json!({"target": "cloud:org-a:ws-1:any", "text": "t"}));

    // Bots switched off: the bot's chat is an ordinary session, and its commands go on as they came.
    f.set_access(&atlas, BotAccess::ReadReport);
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = false;
    crate::store::settings::save(&settings).unwrap();
    let before = f.window.mode(&session);
    f.cloud(&who, "send", json!({"target": "cloud:org-a:ws-1:s1", "text": "t"})).unwrap();
    assert_eq!(f.window.last(), json!({"target": "cloud:org-a:ws-1:s1", "text": "t", "caller": who}));
    assert_eq!(f.window.mode(&session), before);
    let created = f.cloud(&who, "sessions.create", json!({"project": PROJECT, "prompt": "p", "agent": "opencode"})).unwrap();
    assert!(f.window.last().get("mode").is_none() && f.window.last().get("noPipeline").is_none());
    assert_eq!(crate::bots::cloud::works_for(&atlas, created["session"].as_str().unwrap()).unwrap(), crate::bots::cloud::Works::No, "nothing is recorded with Bots off");
}
