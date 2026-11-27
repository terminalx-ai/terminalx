//! PRO-209: the cloud browser's MCP calls reach their tab as a hook, and its
//! tools pass the CLI's own permission gate without a second card.
use super::*;

fn hook(rig: &Rig, event: &str, payload: Value) -> crate::hooks::HookReply {
    let rt = rig.rt();
    let token = match &rt.lock().unwrap().engine { Engine::Cli(cli) => cli.origin.token.clone(), _ => panic!("CLI") };
    rig.manager.on_hook(HookFrame { session: SESSION.into(), tab: TAB.into(), token, event: event.into(), payload })
}

fn started() -> Rig {
    let rig = Rig::new(claude_tab(None), LISTENS);
    rig.manager.send(SESSION, TAB, "initial".into(), Vec::new()).unwrap();
    rig.up();
    rig
}

#[test]
fn its_tools_are_allowed_at_the_cli_gate_and_its_calls_answered_while_off() {
    let rig = started();
    let gate = hook(&rig, "PermissionRequest", json!({"tool_name": "mcp__cloud_browser__click", "tool_input": {"text": "Sign in"}}));
    assert_eq!(gate.output.unwrap()["hookSpecificOutput"]["decision"]["behavior"], "allow");
    assert!(rig.rt().lock().unwrap().pending.is_empty(), "no card for a click");
    // Another MCP server's tool still asks as before.
    assert!(!crate::cloud_browser::is_tool("mcp__other__click"));

    crate::cloud_browser::set_switch(false);
    let call = hook(&rig, crate::cloud_browser::HOOK_EVENT, json!({"tool": "open", "arguments": {"url": "http://localhost:3000"}}));
    let result = call.output.unwrap();
    assert_eq!(result["isError"], true);
    assert!(result["content"][0]["text"].as_str().unwrap().contains("off for this workspace"));
    assert!(rig.rt().lock().unwrap().pending.is_empty(), "nothing is asked while it is off");
}

#[test]
fn a_call_with_another_launchs_token_is_not_answered() {
    let rig = started();
    let reply = rig.manager.on_hook(HookFrame { session: SESSION.into(), tab: TAB.into(), token: "not-this-launch".into(), event: crate::cloud_browser::HOOK_EVENT.into(), payload: json!({"tool": "open", "arguments": {"url": "http://localhost:3000"}}) });
    assert!(reply.output.is_none());
}
