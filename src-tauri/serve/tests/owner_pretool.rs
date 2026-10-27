//! A real owner, session handler, socket and hook process. The provider is
//! the existing disposable CLI fixture; no user store or account is touched.
#![cfg(unix)]

mod common;

use common::agent::{count, wait_until, AgentWorld, Serve};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::process::{Child, Command, Stdio};

struct Hook(Child);

impl Hook {
    fn start(serve: &Serve, world: &AgentWorld, launch: &Value, event: &str) -> Self {
        Self::at_socket(&serve.socket, world, launch, event)
    }

    fn at_socket(socket: &std::path::Path, world: &AgentWorld, launch: &Value, event: &str) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_terminalx-serve"))
            .args(["hook", event, "--local-owner-decision"])
            .env_clear().env("HOME", &world.home).env("TERMINALX_HOME", &world.data)
            .env("RACCOON_HOOK_SOCKET", socket)
            .env("RACCOON_SESSION_ID", launch["RACCOON_SESSION_ID"].as_str().unwrap())
            .env("RACCOON_TAB_ID", launch["RACCOON_TAB_ID"].as_str().unwrap())
            .env("RACCOON_HOOK_TOKEN", launch["RACCOON_HOOK_TOKEN"].as_str().unwrap())
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().unwrap();
        child.stdin.take().unwrap().write_all(br#"{"cwd":"/workspace/app","tool_name":"Bash","tool_input":{"command":"pwd","description":"Inspect the current directory"}}"#).unwrap();
        Self(child)
    }

    fn reply(mut self) -> Value {
        let status = wait_until("the real hook process to return", || self.0.try_wait().unwrap());
        assert!(status.success());
        let mut output = String::new();
        self.0.stdout.take().unwrap().take(1024 * 1024).read_to_string(&mut output).unwrap();
        serde_json::from_str(&output).unwrap()
    }
}

impl Drop for Hook {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

fn start(mode: &str) -> (AgentWorld, Serve, Value) {
    let world = AgentWorld::new();
    let fake = std::fs::canonicalize(world.bin.join("claude")).unwrap();
    std::fs::remove_file(world.bin.join("claude")).unwrap();
    let captured = world.home.join("launch.json");
    // These identities belong only to the disposable test launch.
    let wrapper = format!("#!/usr/bin/python3\nimport os,json,sys\nwith open({},'w') as f: json.dump({{k:os.environ[k] for k in ['RACCOON_HOOK_TOKEN','RACCOON_TAB_ID','RACCOON_SESSION_ID']}},f)\nos.execv({},[{}]+sys.argv[1:])\n",
        serde_json::to_string(&captured).unwrap(), serde_json::to_string(&fake).unwrap(), serde_json::to_string(&fake).unwrap());
    std::fs::write(world.bin.join("claude"), wrapper).unwrap();
    std::fs::set_permissions(world.bin.join("claude"), std::fs::Permissions::from_mode(0o700)).unwrap();
    let serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:ready",
        "useWorktree":false,"onMain":true,"mode":mode
    }));
    serve.wait_events(created["tabId"].as_str().unwrap(), "initial turn completion", |events| count(events, "turn_completed") == 1);
    let launch = serde_json::from_slice(&std::fs::read(captured).unwrap()).unwrap();
    (world, serve, launch)
}

#[test]
fn owner_pretool_report_survives_the_complete_hook_round_trip() {
    let (world, serve, launch) = start("bypassPermissions");
    let reply = Hook::start(&serve, &world, &launch, "PreToolUse").reply();
    assert_eq!(reply, json!({}), "an authenticated report must leave the provider's policy untouched, not say the user declined");
    assert_eq!(serve.control("permissions.list", json!({}))["permissions"], json!([]));

    let mut stale = launch.clone();
    stale["RACCOON_HOOK_TOKEN"] = json!("not-this-launch");
    let denied = Hook::start(&serve, &world, &stale, "PreToolUse").reply();
    assert_eq!(denied["hookSpecificOutput"]["permissionDecision"], "deny");
    serve.control("runtime.session.stop", json!({"sessionId":launch["RACCOON_SESSION_ID"], "tabId":launch["RACCOON_TAB_ID"]}));
    let denied = Hook::start(&serve, &world, &launch, "PreToolUse").reply();
    assert_eq!(denied["hookSpecificOutput"]["permissionDecision"], "deny");
}

#[test]
fn a_retired_owner_socket_blocks_the_tool_without_claiming_a_human_refusal() {
    let (world, _serve, launch) = start("bypassPermissions");
    let retired = world.data.join("retired-owner.sock");
    for event in ["PreToolUse", "PermissionRequest"] {
        let reply = Hook::at_socket(&retired, &world, &launch, event).reply();
        let output = &reply["hookSpecificOutput"];
        let (decision, reason) = if event == "PreToolUse" {
            (&output["permissionDecision"], &output["permissionDecisionReason"])
        } else {
            (&output["decision"]["behavior"], &output["decision"]["message"])
        };
        assert_eq!(decision, "deny", "a disconnected owner must still fail closed");
        let reason = reason.as_str().expect("explain why the tool was blocked");
        assert!(!reason.contains("user declined"), "a missing owner is not a human refusal: {reason}");
        assert!(reason.contains("TerminalX"), "identify the unavailable permission authority: {reason}");
    }
}

#[test]
fn owner_permission_decisions_still_require_an_answer() {
    let (world, serve, launch) = start("manual");
    for (action, expected) in [("permissions.allow", "allow"), ("permissions.deny", "deny")] {
        let hook = Hook::start(&serve, &world, &launch, "PermissionRequest");
        let pending = wait_until("the permission card", || {
            let pending = serve.control("permissions.list", json!({}));
            (!pending["permissions"].as_array().unwrap().is_empty()).then_some(pending)
        });
        assert_eq!(pending["permissions"][0]["input"]["command"], "pwd");
        let events = serve.events(launch["RACCOON_TAB_ID"].as_str().unwrap());
        let request = events.iter().find(|event| event["payload"]["requestId"] == pending["permissions"][0]["requestId"]).unwrap();
        assert_eq!(request["payload"]["cwd"], "/workspace/app", "context survives the real hook process and owner socket");
        assert_eq!(request["payload"]["description"], "Inspect the current directory");
        serve.control(action, json!({"request":pending["permissions"][0]["requestId"]}));
        assert_eq!(hook.reply()["hookSpecificOutput"]["decision"]["behavior"], expected);
    }
}
