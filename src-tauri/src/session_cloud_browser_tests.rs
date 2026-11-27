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
