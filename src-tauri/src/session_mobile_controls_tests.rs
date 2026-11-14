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
        Self::paired_on(json!({"harness":"claude","model":"opus"}))
    }

    /// The same, on a tab of its own: `tab` is what it has beyond its id,
    /// mode and creation.
    fn paired_on(mut tab: Value) -> Self {
        let home = store::temp_home();
        let root = store::root().unwrap();
        let harness = tab["harness"].clone();
        tab["id"] = json!("tab");
        tab["permissionMode"] = json!("auto");
        tab["created"] = json!(index::now());
        let session: index::SessionEntry = serde_json::from_value(json!({
            "id":"phone-controls", "projectPath":root, "cwd":root, "title":"fixture", "created":index::now(), "modified":index::now(),
            "tabs":[tab]
        })).unwrap();
        index::save(&[session]).unwrap();
        // An answered exchange: context to continue from, and nothing unsent.
        let said = |seq: u64, payload: Value| json!({"id":format!("e{seq}"),"sessionId":"phone-controls","tabId":"tab","harness":harness,"seq":seq,"ts":index::now(),"payload":payload}).to_string();
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

/// Codex's stand-in (#746): it answers `--help` as a Codex with
/// `--no-daemon` does and refuses to be an app server. Started in a pane, it
/// notes how it was launched and then every byte typed at it, as a TUI reads
/// them. It never goes quiet, so it is never ready unless the test says so:
/// a Codex a settings restart has just started, still drawing.
const CODEX: &str = r#"#!/bin/sh
case "$1" in
  --help) printf '  --no-daemon  Run without the daemon\n'; exit 0;;
  app-server) exit 1;;
esac
printf 'LAUNCH %s\n' "$*" >> "$0.typed"
(while :; do printf '.'; sleep 0.2; done) &
stty raw -echo
exec cat >> "$0.typed"
"#;

const CONVERSATION: &str = "019a3d1e-6b1c-7d52-9b4e-0c7a1f2e3d4c";

/// A terminal Codex tab on a conversation it resumes, with a paired phone.
struct Codex {
    phone: Phone,
    typed: PathBuf,
    _program: codex::pty::TestProgram,
    _dir: tempfile::TempDir,
}

impl Drop for Codex {
    fn drop(&mut self) {
        self.phone.manager.closing();
        self.phone.manager.terminals.kill_all();
    }
}

impl Codex {
    fn new() -> Self {
        use std::os::unix::fs::PermissionsExt;
        let phone = Phone::paired_on(json!({"harness":"codex","model":"","providerSessionId":CONVERSATION}));
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("codex");
        std::fs::write(&program, CODEX).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();
        let program = codex::pty::codex_program_for_tests(program.clone());
        // Its rollout, in the home the app runs Codex in: what each launch resumes.
        let day = codex::home::managed_root().unwrap().join("sessions/2026/11/02");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join(format!("rollout-2026-11-02T10-00-00-{CONVERSATION}.jsonl")), "").unwrap();
        phone.manager.follow_pane_exits();
        Codex { typed: dir.path().join("codex.typed"), phone, _program: program, _dir: dir }
    }

    fn manager(&self) -> &SessionManager {
        &self.phone.manager
    }

    fn rt(&self) -> Arc<Mutex<TabRuntime>> {
        self.manager().runtime("phone-controls", "tab").unwrap()
    }

    /// Each launch's arguments, and what was typed at it.
    fn launches(&self) -> Vec<(String, Vec<u8>)> {
        let typed = std::fs::read(&self.typed).unwrap_or_default();
        let mut launches = Vec::new();
        let mut rest = typed.as_slice();
        while let Some(at) = rest.windows(7).position(|bytes| bytes == b"LAUNCH ") {
            if let Some((_, typed)) = launches.last_mut() {
                *typed = rest[..at].to_vec();
            }
            let line = &rest[at + 7..];
            let end = line.iter().position(|byte| *byte == b'\n').unwrap_or(line.len());
            launches.push((String::from_utf8_lossy(&line[..end]).into_owned(), Vec::new()));
            rest = line.get(end + 1..).unwrap_or_default();
        }
        if let Some((_, typed)) = launches.last_mut() {
            *typed = rest.to_vec();
        }
        launches
    }

    fn launched(&self, nth: usize, with: &str) {
        self.phone.wait_for(&format!("launch {nth} with {with}"), || self.launches().get(nth - 1).is_some_and(|(args, _)| args.contains(with)));
        assert_eq!(self.launches().len(), nth, "{:?}", self.launches());
    }

    fn send(&self, text: &str) -> u64 {
        self.manager().send("phone-controls", "tab", text.into(), vec![]).unwrap().events[0].seq
    }

    /// The turn `seq` opened ended as stopped, its prompt withdrawn.
    fn stopped(&self, seq: u64) {
        self.phone.wait_for("the turn to end", || !self.rt().lock().unwrap().turn_open);
        assert_eq!(self.rt().lock().unwrap().status, TabStatus::Idle);
        let events = store::read_lines::<AgentEvent>(&store::log_path("phone-controls", "tab").unwrap()).unwrap();
        let after: Vec<_> = events.iter().skip_while(|event| event.seq != seq).map(|event| &event.payload).collect();
        assert!(after.iter().any(|payload| matches!(payload, Payload::TurnCompleted { status: TurnStatus::Aborted, .. })), "{after:?}");
        assert!(after.iter().any(|payload| matches!(payload, Payload::PromptWithdrawn { prompt_seq, .. } if *prompt_seq == seq)), "{after:?}");
    }
}

impl Phone {
    fn wait_for(&self, what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !done() {
            assert!(Instant::now() < deadline, "never happened: {what}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// #746: a new effort or mode restarts a terminal Codex tab's Codex, and a
/// prompt sent then waits for the new one to be ready. An interrupt while it
/// waited, from the desktop or from a phone, was an Escape typed into a
/// Codex with no turn running; the prompt was typed once Codex was up, and
/// its turn ran to the end. Now the interrupt ends that turn at once: the
/// prompt is withdrawn, nothing at all is typed into the new Codex, and the
/// next prompt is the first thing it reads.
#[test]
fn an_interrupt_right_after_a_settings_restart_ends_the_turn() {
    let codex = Codex::new();
    codex.manager().ensure_started("phone-controls", "tab").unwrap();
    codex.launched(1, &format!("resume {CONVERSATION}"));

    // The desktop: a new effort, a prompt, and Interrupt.
    codex.manager().set_effort("phone-controls", "tab", Some("high")).unwrap();
    codex.launched(2, "model_reasoning_effort=high");
    let seq = codex.send("count to a thousand slowly");
    assert!(codex.manager().interrupt("phone-controls", "tab").unwrap(), "the interrupt took");
    codex.stopped(seq);

    // A phone: a new mode, a prompt, and its Interrupt.
    codex.phone.call("driving", "setMode", json!({"mode":"plan"})).unwrap();
    codex.launched(3, "-a on-request -s read-only");
    let seq = codex.send("and again");
    assert_eq!(codex.phone.call("driving", "interrupt", json!({})).unwrap(), json!({"interrupted": true}));
    codex.stopped(seq);

    // Neither prompt, nor an Escape, reached either Codex: the next prompt,
    // once Codex is up, is the first thing it reads.
    codex.send("next");
    if let Engine::Cli(p) = &codex.rt().lock().unwrap().engine {
        p.ready.mark();
    }
    codex.phone.wait_for("the next prompt to be entered", || codex.launches().get(2).is_some_and(|(_, typed)| typed.contains(&b'\r')));
    let launches = codex.launches();
    assert_eq!(launches.len(), 3, "{launches:?}");
    assert_eq!(String::from_utf8_lossy(&launches[1].1), "", "typed into the Codex restarted for the effort");
    assert!(launches[2].1.starts_with(b"\x1b[200~next\x1b[201~\r"), "typed into the Codex restarted for the mode: {:?}", String::from_utf8_lossy(&launches[2].1));
}
