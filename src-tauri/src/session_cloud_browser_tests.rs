//! PRO-209: the cloud browser's MCP calls reach their tab as a hook, and the
//! CLI's gate passes only the tools of the server this launch was given.
use super::*;

fn token(rig: &Rig) -> String {
    match &rig.rt().lock().unwrap().engine { Engine::Cli(cli) => cli.origin.token.clone(), _ => panic!("CLI") }
}

fn hook(rig: &Rig, event: &str, payload: Value) -> crate::hooks::HookReply {
    rig.manager.on_hook(HookFrame { session: SESSION.into(), tab: TAB.into(), token: token(rig), event: event.into(), payload })
}

fn started() -> Rig {
    let rig = Rig::new(claude_tab(None), LISTENS);
    rig.manager.send(SESSION, TAB, "initial".into(), Vec::new()).unwrap();
    rig.up();
    rig
}

#[test]
fn this_launchs_tools_pass_the_cli_gate_and_its_calls_are_answered() {
    let rig = started();
    crate::cloud_browser::offering(Some("on"));
    let args = crate::cloud_browser::launch_args("claude", "/opt/terminalx", &token(&rig), SESSION, TAB);
    let server = args.split("\"mcpServers\":{\"").nth(1).unwrap().split('"').next().unwrap().to_string();
    let gate = hook(&rig, "PermissionRequest", json!({"tool_name": format!("mcp__{server}__click"), "tool_input": {"text": "Sign in"}}));
    assert_eq!(gate.output.unwrap()["hookSpecificOutput"]["decision"]["behavior"], "allow");
    assert!(rig.rt().lock().unwrap().pending.is_empty(), "no card for a click");
    assert!(rig.manager.cli_launch_alive(SESSION, TAB, &token(&rig)));
    assert!(!rig.manager.cli_launch_alive(SESSION, TAB, "an-earlier-launch"));

    // Revoked: the call is answered, nothing is asked.
    crate::cloud_browser::offering(Some("off"));
    let call = hook(&rig, crate::cloud_browser::HOOK_EVENT, json!({"tool": "open", "arguments": {"url": "http://localhost:3000"}}));
    let result = call.output.unwrap();
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"].as_str().unwrap().contains("off for this workspace"));
    assert!(rig.rt().lock().unwrap().pending.is_empty(), "nothing is asked while it is off");
    crate::cloud_browser::offering(None);
}

#[test]
fn a_launch_without_the_tool_or_with_another_token_is_not_served() {
    let rig = started();
    crate::cloud_browser::offering(Some("on"));
    let refused = hook(&rig, crate::cloud_browser::HOOK_EVENT, json!({"tool": "open", "arguments": {"url": "http://localhost:3000"}}));
    assert!(refused.output.is_none() && refused.refused.is_some(), "this launch was not given the tool");
    let stranger = rig.manager.on_hook(HookFrame { session: SESSION.into(), tab: TAB.into(), token: "not-this-launch".into(), event: crate::cloud_browser::HOOK_EVENT.into(), payload: json!({"tool": "open"}) });
    assert!(stranger.output.is_none());
    crate::cloud_browser::offering(None);
}

/// A Codex app-server tab in `mode`, its launch given the tool: the engine a
/// `prepare_codex_stdio` launch leaves, with the server it was given.
fn stdio_tab(rig: &Rig, mode: &str) -> (String, String) {
    let launch = "stdio-launch-token".to_string();
    let words = crate::cloud_browser::codex_stdio_args("/opt/terminalx", &launch, SESSION, TAB);
    let server = words[1].strip_prefix("mcp_servers.").unwrap().split('=').next().unwrap().to_string();
    let mut engine = codex::stdio::Stdio::new(rig.checkout.to_string_lossy().into_owned(), String::new(), None, mode.into(), None);
    engine.hook_token = launch.clone();
    rig.rt().lock().unwrap().engine = Engine::CodexStdio(engine);
    (launch, server)
}

fn stdio_hook(rig: &Rig, token: &str, payload: Value) -> crate::hooks::HookReply {
    rig.manager.on_hook(HookFrame { session: SESSION.into(), tab: TAB.into(), token: token.into(), event: crate::cloud_browser::HOOK_EVENT.into(), payload })
}

fn open_call() -> Value {
    json!({"tool": "open", "arguments": {"url": "http://localhost:3000", "plan": "Check the sign-in page"}})
}

#[test]
fn a_codex_app_server_launch_is_offered_the_tool_only_while_it_is_on() {
    let _lock = crate::cloud_browser::TEST_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    crate::cloud_browser::offering(Some("off"));
    assert!(crate::cloud_browser::codex_stdio_args("/opt/terminalx", "off-launch", SESSION, TAB).is_empty());
    assert!(!crate::cloud_browser::launched_with_tool("off-launch"));
    crate::cloud_browser::offering(Some("packages-missing"));
    assert!(crate::cloud_browser::codex_stdio_args("/opt/terminalx", "off-launch", SESSION, TAB).is_empty());

    crate::cloud_browser::offering(Some("on"));
    let words = crate::cloud_browser::codex_stdio_args("/opt/terminalx", "on-launch", SESSION, TAB);
    assert_eq!(words.len(), 2);
    assert_eq!(words[0], "-c");
    let config: toml::Table = toml::from_str(&words[1]).unwrap();
    let (server, table) = config["mcp_servers"].as_table().unwrap().iter().next().unwrap();
    assert!(server.starts_with("cloud_browser_") && server.len() == "cloud_browser_".len() + 12, "{server}");
    assert_eq!(table["command"].as_str(), Some("/opt/terminalx"));
    assert_eq!(table["args"].as_array().unwrap()[0].as_str(), Some("cloud-browser-stdio"));
    // Codex asks nothing itself: the server asks once per browser session.
    assert_eq!(table["default_tools_approval_mode"].as_str(), Some("approve"));
    let env: Vec<&str> = table["env_vars"].as_array().unwrap().iter().filter_map(toml::Value::as_str).collect();
    assert!(env.contains(&crate::hooks::SOCKET_ENV) && env.contains(&crate::hooks::TOKEN_ENV), "{env:?}");
    assert!(!words[1].contains("on-launch"), "the token goes by name, never on a command line");
    assert!(crate::cloud_browser::launched_with_tool("on-launch"));

    // Ahead of `app-server`, where Codex reads options.
    let mut args: Vec<String> = ["-c", "model_provider=\"route\"", "app-server", "--listen", "stdio://"].map(String::from).to_vec();
    codex_stdio::with_server(&mut args, words.clone());
    assert_eq!(&args[2..4], &words[..]);
    assert_eq!(&args[4..], ["app-server", "--listen", "stdio://"]);
    crate::cloud_browser::offering(None);
}

#[test]
fn an_ask_first_codex_app_server_tab_shows_one_card_and_a_denial_opens_nothing() {
    let _lock = crate::cloud_browser::TEST_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    crate::cloud_browser::runtime_for_tests();
    let rig = started();
    crate::cloud_browser::offering(Some("on"));
    let (launch, _) = stdio_tab(&rig, "auto");
    assert!(rig.manager.cli_launch_alive(SESSION, TAB, &launch), "the reaper sees the launch running");
    assert!(!rig.manager.cli_launch_alive(SESSION, TAB, "an-earlier-launch"));

    let manager = rig.manager.clone();
    let token = launch.clone();
    let call = std::thread::spawn(move || {
        crate::cloud_browser::offering(Some("on"));
        manager.on_hook(HookFrame { session: SESSION.into(), tab: TAB.into(), token, event: crate::cloud_browser::HOOK_EVENT.into(), payload: open_call() })
    });
    rig.wait("the browser card", || !rig.rt().lock().unwrap().pending.is_empty());
    let (request_id, ask) = rig.rt().lock().unwrap().pending.iter().map(|(id, ask)| (id.clone(), ask.clone())).next().unwrap();
    assert_eq!(rig.rt().lock().unwrap().pending.len(), 1, "one card");
    assert_eq!(ask.tool_name, crate::cloud_browser::OPEN_TOOL);
    assert_eq!(ask.input["agent"], "Codex");
    assert!(matches!(&rig.rt().lock().unwrap().engine, Engine::CodexStdio(_)), "answered by TerminalX, never sent to Codex");

    rig.manager.respond_permission(SESSION, TAB, &request_id, "deny").unwrap();
    let reply = call.join().unwrap();
    let result = reply.output.unwrap();
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"].as_str().unwrap().contains("denied the browser session"), "{result}");
    assert!(rig.rt().lock().unwrap().pending.is_empty());
    assert!(rig.manager.respond_permission(SESSION, TAB, &request_id, "allow").is_err(), "a card is answered once");
    let events = store::read_lines::<AgentEvent>(&store::log_path(SESSION, TAB).unwrap()).unwrap_or_default();
    let requested = events.iter().find_map(|event| match &event.payload {
        Payload::PermissionRequested { request_id: id, title, options, .. } if *id == request_id => Some((title.clone(), options.iter().map(|option| option.label.clone()).collect::<Vec<_>>())),
        _ => None,
    });
    assert_eq!(requested, Some((Some("Use the browser on the cloud desktop?".into()), vec!["Allow for this browser session".to_string(), "Deny".to_string()])));
    assert!(events.iter().any(|event| matches!(&event.payload, Payload::PermissionDecided { request_id: id, allowed: false, .. } if *id == request_id)));
    crate::cloud_browser::offering(None);
}

#[test]
fn a_codex_app_server_tab_that_runs_without_asking_is_not_asked_and_strangers_are_refused() {
    let _lock = crate::cloud_browser::TEST_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    crate::cloud_browser::runtime_for_tests();
    let rig = started();
    crate::cloud_browser::offering(Some("on"));
    let (launch, _) = stdio_tab(&rig, "bypassPermissions");
    // Straight to the desktop (which this test has none of), no card.
    let reply = stdio_hook(&rig, &launch, open_call());
    let result = reply.output.unwrap();
    assert!(result["content"][0]["text"].as_str().unwrap().contains("No desktop in this test"), "{result}");
    assert!(rig.rt().lock().unwrap().pending.is_empty(), "no card in a tab that runs without asking");

    // Another token is not this launch, and a launch without the tool is not served.
    let stranger = stdio_hook(&rig, "not-this-launch", open_call());
    assert!(stranger.output.is_none() && stranger.refused.is_some());
    let mut engine = codex::stdio::Stdio::new(String::new(), String::new(), None, "auto".into(), None);
    engine.hook_token = "launch-without-the-tool".into();
    rig.rt().lock().unwrap().engine = Engine::CodexStdio(engine);
    let without = stdio_hook(&rig, "launch-without-the-tool", open_call());
    assert!(without.output.is_none() && without.refused.unwrap().contains("not started with the cloud browser"));

    // Turned off: answered, nothing asked.
    let (launch, _) = stdio_tab(&rig, "auto");
    crate::cloud_browser::offering(Some("off"));
    let off = stdio_hook(&rig, &launch, open_call()).output.unwrap();
    assert!(off["content"][0]["text"].as_str().unwrap().contains("off for this workspace"));
    assert!(rig.rt().lock().unwrap().pending.is_empty());
    crate::cloud_browser::offering(None);
}

#[test]
fn a_lapsed_browser_card_puts_the_tab_back_to_work_and_cannot_be_answered_later() {
    let _lock = crate::cloud_browser::TEST_LOCK.lock().unwrap_or_else(|poison| poison.into_inner());
    crate::cloud_browser::runtime_for_tests();
    let rig = started();
    crate::cloud_browser::offering(Some("on"));
    let (launch, _) = stdio_tab(&rig, "auto");
    *BROWSER_ASK_WAIT.lock().unwrap() = Some(Duration::from_secs(1));
    let manager = rig.manager.clone();
    let call = std::thread::spawn(move || {
        crate::cloud_browser::offering(Some("on"));
        manager.on_hook(HookFrame { session: SESSION.into(), tab: TAB.into(), token: launch, event: crate::cloud_browser::HOOK_EVENT.into(), payload: open_call() })
    });
    rig.wait("the browser card", || !rig.rt().lock().unwrap().pending.is_empty());
    let request_id = rig.rt().lock().unwrap().pending.keys().next().unwrap().clone();
    assert_eq!(rig.rt().lock().unwrap().status, TabStatus::Waiting);
    let result = call.join().unwrap().output.unwrap();
    *BROWSER_ASK_WAIT.lock().unwrap() = None;
    assert!(result["content"][0]["text"].as_str().unwrap().contains("denied the browser session"), "{result}");
    {
        let rt_arc = rig.rt();
        let rt = rt_arc.lock().unwrap();
        assert!(rt.pending.is_empty());
        assert_eq!(rt.status, TabStatus::InProgress, "no card left to wait on");
    }
    let events = store::read_lines::<AgentEvent>(&store::log_path(SESSION, TAB).unwrap()).unwrap_or_default();
    assert!(events.iter().any(|event| matches!(&event.payload, Payload::PermissionDecided { request_id: id, label, .. } if *id == request_id && label == "Lapsed")));
    // A late click is refused here, never sent to Codex as an id it never issued.
    let late = rig.manager.respond_permission(SESSION, TAB, &request_id, "allow").unwrap_err().to_string();
    assert!(late.contains("no longer open") || late.contains("lapsed"), "{late}");
    crate::cloud_browser::offering(None);
}
