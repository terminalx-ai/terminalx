//! A phone's session controls (`sessionControls`): each is the desktop's own
//! operation behind the device checks a phone's send has.
use super::*;
use crate::local_runtime::{mobile::{self, Actor}, Lifetime};
use serde_json::{json, Value};
use std::time::Duration;

const CHANGES: &[&str] = &["stop", "interrupt", "setModel", "setEffort", "setMode", "resendUnsent", "continue"];

struct Phone {
    manager: SessionManager,
    lifetime: Arc<Lifetime>,
    actor: Actor,
    _home: store::TempHome,
}

impl Phone {
    /// A Claude tab in `auto`, and two paired phones: one that drives, one that only reads.
    fn paired() -> Self {
        let home = store::temp_home();
        let root = store::root().unwrap();
        let session: index::SessionEntry = serde_json::from_value(json!({
            "id":"phone-controls", "projectPath":root, "cwd":root, "title":"fixture", "created":index::now(), "modified":index::now(),
            "tabs":[{"id":"tab","harness":"claude","model":"opus","permissionMode":"auto","created":index::now()}]
        })).unwrap();
        index::save(&[session]).unwrap();
        // An answered exchange: context to continue from, and nothing unsent.
        let said = |seq: u64, payload: Value| json!({"id":format!("e{seq}"),"sessionId":"phone-controls","tabId":"tab","harness":"claude","seq":seq,"ts":index::now(),"payload":payload}).to_string();
        std::fs::write(store::log_path("phone-controls", "tab").unwrap(), format!("{}\n{}\n",
            said(1, json!({"type":"user_message","text":"fix the build","queued":false})),
            said(2, json!({"type":"assistant_text","text":"The build passes now."})))).unwrap();
        let device = |id: &str, scope: &str| json!({"id":id,"label":id,"platform":"test","token":format!("{id}-hash"),"scope":scope,"provenance":"explicit","bindingGeneration":0,"createdAt":index::now()});
        store::write_json(&root.join("devices.json"), &json!({"devices":[device("driver", "driver"), device("viewer", "viewer")]})).unwrap();
        let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)),
            Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
            Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
        let lifetime = Lifetime::new(Duration::from_secs(60));
        let lease = lifetime.command("runtime.attach", json!({"protocol":1})).unwrap();
        let actor: Actor = serde_json::from_value(json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
        manager.mobile.register(&lifetime, actor.clone(), "driving", "driver").unwrap();
        manager.mobile.register(&lifetime, actor.clone(), "reading", "viewer").unwrap();
        Phone { manager, lifetime, actor, _home: home }
    }

    fn call(&self, connection: &str, method: &str, mut params: Value) -> Result<Value> {
        params["actor"] = serde_json::to_value(&self.actor).unwrap();
        params["connection"] = json!(connection);
        params["sessionId"] = json!("phone-controls");
        params["tabId"] = json!("tab");
        mobile::execute(&self.manager, &self.lifetime, method, params)
    }

    fn tab(&self) -> index::TabEntry {
        index::get("phone-controls").unwrap().tab("tab").unwrap().clone()
    }
}

/// What each change carries beyond the tab.
fn params(method: &str) -> Value {
    match method {
        "setModel" => json!({"model":"sonnet"}),
        "setEffort" => json!({"effort":"high"}),
        "setMode" => json!({"mode":"plan"}),
        "continue" => json!({"tab":{"harness":"claude","model":"","permissionMode":"auto"},"prompt":"carry on"}),
        _ => json!({}),
    }
}

#[test]
fn a_phone_controls_a_tab_as_the_desktop_does() {
    let phone = Phone::paired();
    let tab = phone.call("driving", "tab", json!({})).unwrap();
    assert_eq!((&tab["harness"], &tab["model"], &tab["permissionMode"], &tab["status"]), (&json!("claude"), &json!("opus"), &json!("auto"), &json!("idle")));
    phone.call("driving", "setModel", params("setModel")).unwrap();
    phone.call("driving", "setEffort", params("setEffort")).unwrap();
    phone.call("driving", "setMode", params("setMode")).unwrap();
    let after = phone.tab();
    assert_eq!((after.model.as_str(), after.effort.as_deref(), after.permission_mode.as_str()), ("sonnet", Some("high"), "plan"));
    assert_eq!(phone.call("driving", "interrupt", json!({})).unwrap(), json!({"interrupted": false}), "nothing was running");
    assert_eq!(phone.call("driving", "stop", json!({})).unwrap(), Value::Null);
    let context = phone.call("driving", "prepareContinuation", json!({})).unwrap();
    assert_eq!((&context["sessionId"], &context["tabId"]), (&json!("phone-controls"), &json!("tab")));
    let refused = phone.call("driving", "resendUnsent", json!({})).unwrap_err();
    assert!(refused.to_string().contains("no unanswered prompt"), "{refused:#}");
}

#[test]
fn a_read_only_phone_reads_a_tab_but_changes_nothing() {
    let phone = Phone::paired();
    assert_eq!(phone.call("reading", "tab", json!({})).unwrap()["model"], "opus");
    phone.call("reading", "prepareContinuation", json!({})).unwrap();
    for method in CHANGES {
        let refused = phone.call("reading", method, params(method)).unwrap_err();
        assert!(refused.to_string().contains("read-only"), "{method}: {refused:#}");
    }
    let tab = phone.tab();
    assert_eq!((tab.model.as_str(), tab.permission_mode.as_str()), ("opus", "auto"));
    assert_eq!(index::get("phone-controls").unwrap().tabs.len(), 1, "no tab was added");
}

#[test]
fn a_revoked_phone_can_do_nothing() {
    let phone = Phone::paired();
    phone.manager.mobile.revoke_device(&phone.actor, "driver").unwrap();
    for method in CHANGES.iter().chain(&["tab", "prepareContinuation"]) {
        assert!(phone.call("driving", method, params(method)).is_err(), "{method} after revocation");
    }
    assert_eq!(phone.tab().model, "opus");
}

#[test]
fn a_tab_another_session_holds_is_refused() {
    let phone = Phone::paired();
    let mut call = json!({"actor": phone.actor, "connection": "driving", "sessionId": "phone-controls", "tabId": "elsewhere"});
    for method in ["stop", "tab"] {
        let refused = mobile::execute(&phone.manager, &phone.lifetime, method, call.clone()).unwrap_err();
        assert!(refused.to_string().contains("does not belong"), "{method}: {refused:#}");
    }
    call["tabId"] = json!("tab");
    assert!(mobile::execute(&phone.manager, &phone.lifetime, "tab", call).is_ok());
}

/// A handoff over a phone's limit is refused before any tab is made.
#[test]
fn an_oversize_handoff_is_refused_before_a_tab_is_made() {
    let phone = Phone::paired();
    let prompt = "x".repeat(8 * 1024 * 1024 + 1);
    let refused = phone.call("driving", "continue", json!({"tab":{"harness":"claude","model":"","permissionMode":"default"},"prompt":prompt})).unwrap_err();
    assert!(refused.to_string().contains("too large"), "{refused:#}");
    assert_eq!(index::get("phone-controls").unwrap().tabs.len(), 1);
}

const HANDOFF: &str = "Continue work from the prior TerminalX conversation using the context below.";

/// Claude Code's stand-in, as `session_unsent_tests` has it: up, and reading
/// what it is given while its terminal echoes it. Real panes; the test says
/// when it is ready, and writes its transcript for what it takes. It never
/// goes quiet, so only the test's word makes it ready, not a quiet screen.
struct Cli {
    phone: Phone,
    _program: claude::pty::TestProgram,
    _dir: tempfile::TempDir,
}

impl Drop for Cli {
    fn drop(&mut self) {
        self.phone.manager.closing();
        self.phone.manager.terminals.kill_all();
    }
}

impl Cli {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let phone = Phone::paired();
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("claude");
        std::fs::write(&program, "#!/bin/sh\nprintf 'listening\\n'\n(while :; do printf '.'; sleep 0.2; done) &\nstty -icanon\nexec cat\n").unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let program = claude::pty::claude_program_for_tests(program);
        phone.manager.follow_pane_exits();
        Cli { phone, _program: program, _dir: dir }
    }

    /// Continue in New Session from the phone, answered once the handoff is confirmed or refused.
    fn continue_in_background(&self) -> std::thread::JoinHandle<Result<Value>> {
        let (manager, lifetime) = (self.phone.manager.clone(), self.phone.lifetime.clone());
        let params = json!({"actor": self.phone.actor, "connection": "driving", "sessionId": "phone-controls", "tabId": "tab",
            "tab": {"harness":"claude","model":"","permissionMode":"default"}, "prompt": HANDOFF});
        std::thread::spawn(move || mobile::execute(&manager, &lifetime, "continue", params))
    }

    fn wait(&self, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !done() {
            assert!(Instant::now() < deadline, "never happened: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The tab the continuation made, once its CLI is in it and has published the handoff.
    fn started(&self) -> index::TabEntry {
        let new = || index::get("phone-controls").unwrap().tabs.into_iter().find(|tab| tab.id != "tab");
        self.wait("the new tab's CLI and its handoff", || new().is_some_and(|tab| {
            let cli = matches!(self.phone.manager.runtime("phone-controls", &tab.id).unwrap().lock().unwrap().engine, Engine::Cli(_));
            cli && store::read_lines::<AgentEvent>(&store::log_path("phone-controls", &tab.id).unwrap()).unwrap_or_default().iter()
                .any(|event| matches!(&event.payload, Payload::UserMessage { text, .. } if text == HANDOFF))
        }));
        new().unwrap()
    }

    /// Claude Code's `SessionStart` hook, as the stand-in has none.
    fn up(&self, tab: &str) {
        if let Engine::Cli(p) = &self.phone.manager.runtime("phone-controls", tab).unwrap().lock().unwrap().engine { p.ready.mark(); }
    }

    fn typed(&self, tab: &str) -> String {
        String::from_utf8_lossy(&self.phone.manager.terminals.read_output(&SessionManager::pane_id(tab)).unwrap_or_default()).into_owned()
    }

    /// Claude Code taking a prompt and answering it, in its transcript.
    fn takes(&self, tab: &index::TabEntry, prompt: &str) {
        let root = store::root().unwrap();
        let conversation = index::get("phone-controls").unwrap().tab(&tab.id).unwrap().provider_session_id.clone().expect("a conversation id");
        let path = claude::transcript::transcript_in(&crate::agent_data::claude_projects_root().unwrap(), root.to_str().unwrap(), &conversation);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let records = format!("{}\n{}\n",
            json!({ "parentUuid": null, "isSidechain": false, "type": "user", "uuid": "u-1", "userType": "external", "cwd": root, "sessionId": conversation, "origin": { "kind": "human" }, "message": { "role": "user", "content": prompt } }),
            json!({ "parentUuid": "u-1", "isSidechain": false, "type": "assistant", "uuid": "a-1", "cwd": root, "sessionId": conversation, "message": { "id": "m-1", "role": "assistant", "content": [{ "type": "text", "text": "Reading the earlier conversation." }] } }));
        use std::io::Write;
        std::fs::OpenOptions::new().create(true).append(true).open(path).unwrap().write_all(records.as_bytes()).unwrap();
    }
}

/// A phone's handoff goes as the phone's message: named for the phone, held
/// to its permit, and confirmed by the CLI taking it.
#[test]
fn a_phone_handoff_goes_as_the_phones_message_and_is_confirmed() {
    let cli = Cli::new();
    let handoff = cli.continue_in_background();
    let tab = cli.started();
    cli.up(&tab.id);
    // Its record counts only once its Enter is written.
    cli.wait("the handoff to be typed and entered", || matches!(&cli.phone.manager.runtime("phone-controls", &tab.id).unwrap().lock().unwrap().engine, Engine::Cli(p) if p.entered_at.is_some()));
    assert!(cli.typed(&tab.id).contains(HANDOFF) && cli.typed(&tab.id).contains("[TerminalX Effective User v1]"), "the agent is told who it is from");
    let agent = format!("[TerminalX Effective User v1] {}\n{HANDOFF}", json!({"userId":"driver","displayName":"driver","authority":"host"}));
    cli.takes(&tab, &agent);
    let answer = handoff.join().unwrap().unwrap();
    assert_eq!((&answer["delivered"], &answer["tab"]["id"]), (&json!(true), &json!(tab.id)), "{answer}");
}

/// The phone's access ending between the new tab's start and the handoff's
/// write: nothing is typed, the phone is told it was not delivered, and the
/// tab keeps no brief to send again and shows no banner.
#[test]
fn a_handoff_whose_phone_was_revoked_before_the_write_sends_nothing() {
    let cli = Cli::new();
    let handoff = cli.continue_in_background();
    let tab = cli.started();
    cli.phone.manager.mobile.revoke_device(&cli.phone.actor, "driver").unwrap();
    cli.up(&tab.id);
    let answer = handoff.join().unwrap().unwrap();
    assert_eq!(answer["delivered"], false, "{answer}");
    assert!(answer["error"].as_str().unwrap().contains("access changed"), "{answer}");
    assert!(!cli.typed(&tab.id).contains(HANDOFF), "nothing of the handoff was written: {:?}", cli.typed(&tab.id));
    assert_eq!(index::get("phone-controls").unwrap().tab(&tab.id).unwrap().continuation, None, "no brief to send again");
    let rt = cli.phone.manager.runtime("phone-controls", &tab.id).unwrap();
    let rt = rt.lock().unwrap();
    assert!(!rt.turn_open && rt.recovery.is_none(), "no turn left open and no banner");
}

/// Resending to a tab that is mid-turn is a phone's send like any other: it
/// waits for the turn, under this phone's permit, instead of being refused.
#[test]
fn a_resend_to_a_busy_tab_waits_for_its_turn() {
    let phone = Phone::paired();
    let unanswered = json!({"id":"e1","sessionId":"phone-controls","tabId":"tab","harness":"claude","seq":1,"ts":index::now(),
        "payload":{"type":"user_message","text":"fix the build","queued":false}});
    std::fs::write(store::log_path("phone-controls", "tab").unwrap(), format!("{unanswered}\n")).unwrap();
    phone.manager.runtime("phone-controls", "tab").unwrap().lock().unwrap().turn_open = true;
    let outcome = phone.call("driving", "resendUnsent", json!({})).unwrap();
    assert_eq!(outcome["queued"], true);
    assert!(phone.manager.mobile.has_pending(), "held for the end of the turn");
}
