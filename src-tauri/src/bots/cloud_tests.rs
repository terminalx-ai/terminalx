use serde_json::json;

use super::*;
use crate::bots::{self, chat, BotAccess, BotPatch};
use crate::sink::BroadcastSink;

fn bots_on() -> crate::store::TempHome {
    let home = crate::store::temp_home();
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = true;
    crate::store::settings::save(&settings).unwrap();
    home
}

fn hire(sink: &BroadcastSink, name: &str, access: BotAccess) -> String {
    let bot = bots::create(sink, "cto", name).unwrap();
    bots::update(sink, &bot.id, BotPatch { access: Some(access), ..Default::default() }).unwrap();
    bot.id
}

#[test]
fn a_cloud_key_is_read_as_the_window_reads_it() {
    assert_eq!(parse("cloud:org-a:ws-1"), Some(("cloud:org-a:ws-1".into(), None)));
    assert_eq!(parse("cloud:org-a:ws-1:s1"), Some(("cloud:org-a:ws-1".into(), Some("s1"))));
    // A trailing colon names no session; a project's key (a repository) is no workspace.
    assert_eq!(parse("cloud:org-a:ws-1:"), Some(("cloud:org-a:ws-1".into(), None)));
    for not_one in ["", "org-a:ws-1", "cloud:org-a", "cloud::ws-1", "cloud:org-a:github.com/o/r", "cloud:org-a:ws-1:s1:more"] {
        assert_eq!(parse(not_one), None, "{not_one}");
    }
}

#[test]
fn a_cloud_session_is_recorded_as_one_bots_and_no_others() {
    let _home = bots_on();
    let sink = BroadcastSink::new(16);
    let atlas = hire(&sink, "Atlas", BotAccess::Full);
    let argus = hire(&sink, "Argus", BotAccess::ReadReport);
    assert_eq!(works_for(&atlas, "cloud:org-a:ws-1:s1").unwrap(), Works::No, "nothing recorded yet");

    record(&atlas, "cloud:org-a:ws-1", Some("cloud:org-a:ws-1:s1")).unwrap();
    assert_eq!(works_for(&atlas, "cloud:org-a:ws-1:s1").unwrap(), Works::Session);
    assert_eq!(works_for(&argus, "cloud:org-a:ws-1:s1").unwrap(), Works::No, "another bot's");
    assert_eq!(works_for(&atlas, "cloud:org-a:ws-1:s2").unwrap(), Works::No, "another session of the workspace");
    assert_eq!(works_for(&atlas, "cloud:org-a:ws-1").unwrap(), Works::No, "a workspace is no session");

    // A workspace the bot's session created: its first session is the bot's, which only the window can name.
    record(&argus, "cloud:org-a:ws-2", None).unwrap();
    assert_eq!(works_for(&argus, "cloud:org-a:ws-2:first").unwrap(), Works::Launch);
    assert_eq!(works_for(&atlas, "cloud:org-a:ws-2:first").unwrap(), Works::No);
    // A session of that workspace recorded as another bot's is never the first bot's by the launch.
    record(&atlas, "cloud:org-a:ws-2", Some("cloud:org-a:ws-2:later")).unwrap();
    assert_eq!(works_for(&argus, "cloud:org-a:ws-2:later").unwrap(), Works::No);
    assert_eq!(sessions_in(&atlas, "cloud:org-a:ws-2").unwrap(), (vec!["cloud:org-a:ws-2:later".to_owned()], false));
    assert_eq!(sessions_in(&argus, "cloud:org-a:ws-2").unwrap(), (Vec::new(), true));
    assert_eq!(sessions_in(&argus, "cloud:org-a:ws-9").unwrap(), (Vec::new(), false));

    // Recorded twice is recorded once, and a session named under the wrong workspace is not recorded.
    record(&atlas, "cloud:org-a:ws-1", Some("cloud:org-a:ws-1:s1")).unwrap();
    assert_eq!(sessions_in(&atlas, "cloud:org-a:ws-1").unwrap().0.len(), 1);
    assert!(record(&atlas, "cloud:org-a:ws-1", Some("cloud:org-a:ws-7:s1")).is_err());
    assert!(record(&atlas, "not-a-key", None).is_err());

    // The records are kept with the bots' definitions, and a change to a bot keeps them.
    let file: serde_json::Value = serde_json::from_slice(&std::fs::read(crate::store::root().unwrap().join("bots.json")).unwrap()).unwrap();
    assert_eq!(file["cloudSessions"].as_array().unwrap().len(), 3);
    bots::update(&sink, &atlas, BotPatch { access: Some(BotAccess::AskOutward), ..Default::default() }).unwrap();
    assert_eq!(works_for(&atlas, "cloud:org-a:ws-1:s1").unwrap(), Works::Session);
    assert_eq!(works_for(&argus, "cloud:org-a:ws-2:first").unwrap(), Works::Launch);
}

#[test]
fn the_limit_the_window_is_told_is_the_one_local_sessions_are_held_to() {
    let _home = bots_on();
    let sink = BroadcastSink::new(16);
    let full = hire(&sink, "Atlas", BotAccess::Full);
    let asks = hire(&sink, "Iris", BotAccess::AskOutward);
    let reads = hire(&sink, "Argus", BotAccess::ReadReport);
    let limit = |id: &str| chat::bot_limit(id, "a test").unwrap();

    // Full access narrows nothing: the window is told of no limit, and a launch takes the default mode.
    assert!(widest(&limit(&full)) && hold(&limit(&full)).is_none());
    assert_eq!(launch_mode(&limit(&full), None), "bypassPermissions");
    assert_eq!(launch_mode(&limit(&full), Some("acceptEdits")), "acceptEdits", "a narrower mode asked for is kept");

    // Ask before acting: Ask every time at most, and plan on native Codex, which cannot ask.
    let told = hold(&limit(&asks)).unwrap();
    assert_eq!(told["terminal"]["limit"], "manual");
    assert_eq!(told["terminal"]["modes"], json!({"plan": "plan", "manual": "manual", "default": "default", "ask": "ask", "auto": "manual", "acceptEdits": "manual", "bypassPermissions": "manual", "bypass": "manual"}));
    assert_eq!(told["nativeCodex"]["limit"], "plan");
    assert!(told["nativeCodex"]["modes"].as_object().unwrap().iter().all(|(mode, held)| held == "plan" || mode == "plan"));
    for asked in [None, Some(""), Some("bypassPermissions"), Some("acceptEdits"), Some("auto"), Some("something-newer")] {
        assert_eq!(launch_mode(&limit(&asks), asked), "manual", "{asked:?}");
    }
    assert_eq!(launch_mode(&limit(&asks), Some("plan")), "plan");

    // Read and report: plan, whatever is asked for.
    let told = hold(&limit(&reads)).unwrap();
    assert_eq!((&told["terminal"]["limit"], &told["nativeCodex"]["limit"]), (&json!("plan"), &json!("plan")));
    for asked in [None, Some("bypassPermissions"), Some("manual"), Some("auto")] {
        assert_eq!(launch_mode(&limit(&reads), asked), "plan", "{asked:?}");
    }
    // Every mode the window is told of is held exactly as a local tab's is.
    for id in [&asks, &reads] {
        let limit = limit(id);
        for mode in MODES {
            assert_eq!(hold(&limit).unwrap()["terminal"]["modes"][mode], json!(limit.clamp(mode)));
        }
    }

    // Paused: plan, as its local sessions are. Gone, or Bots off: no limit, an ordinary session.
    bots::pause(&sink, &full, bots::OWNER).unwrap();
    assert_eq!(limit(&full).mode, "plan");
    bots::delete(&sink, &asks).unwrap();
    assert!(chat::bot_limit(&asks, "a test").is_none());
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = false;
    crate::store::settings::save(&settings).unwrap();
    assert!(chat::bot_limit(&reads, "a test").is_none());
}

/// A Codex launch held to Ask every time is named `manual`, not `plan`, as a
/// local terminal Codex tab is. That is within the limit only because the
/// workspace's runtime never puts such a tab on native Codex, which cannot
/// ask before each action: every path that picks it (`session.create`,
/// `session.addTab`, a workspace's launch) goes through
/// `session_ops::native_codex`, which keeps a mode native Codex cannot serve
/// on the terminal engine. If that rule changes, this launch has to be held
/// to plan instead.
#[test]
fn a_codex_launch_held_to_ask_never_runs_on_native_codex() {
    let _home = bots_on();
    let sink = BroadcastSink::new(16);
    let asks = hire(&sink, "Iris", BotAccess::AskOutward);
    let limit = chat::bot_limit(&asks, "a test").unwrap();
    for asked in [None, Some("bypassPermissions"), Some("auto"), Some("acceptEdits"), Some("default"), Some("ask"), Some("manual")] {
        let mode = launch_mode(&limit, asked);
        let mut tab = crate::session_ops::NewTab { harness: "codex".into(), transport: Default::default(), model: String::new(), effort: None, permission_mode: Some(mode.clone()) };
        crate::session_ops::native_codex(&mut tab, false);
        assert_eq!(tab.transport, index::AgentTransport::Pty, "asked {asked:?}, launched in {mode}");
        assert!(limit.clone().on(tab.transport).allows(&mode), "{mode} is within the limit of the engine it runs on");
    }
    // Narrower than the limit by its own choice: native Codex may serve plan, which is within its limit there too.
    let mut tab = crate::session_ops::NewTab { harness: "codex".into(), transport: Default::default(), model: String::new(), effort: None, permission_mode: Some(launch_mode(&limit, Some("plan"))) };
    crate::session_ops::native_codex(&mut tab, false);
    assert!(limit.clone().on(tab.transport).allows("plan"));
}
