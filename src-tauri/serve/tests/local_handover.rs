//! #765: replacing the local runtime hands everything it runs to the newer
//! runtime, in the same process, and stops nothing: the real runtime execs an
//! installed copy of itself, with the fake Claude Code under the real harness.
#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};

use base64::Engine as _;
use common::agent::{count, texts, wait_until, AgentWorld, Serve};
use serde_json::{json, Value};

/// The runtime installed in the world's home as the app installs one, which
/// is the only kind a runtime hands over to.
fn installed(world: &AgentWorld) -> PathBuf {
    raccoon_lib::local_runtime::launch::install(Path::new(env!("CARGO_BIN_EXE_terminalx-serve")), &world.data).unwrap()
}

/// Every `tick-N` in a terminal's output, in order.
fn ticks(output: &[u8]) -> Vec<u64> {
    String::from_utf8_lossy(output).split("tick-").skip(1)
        .filter_map(|rest| rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()).collect()
}

fn output(serve: &Serve, pane: &str) -> (Vec<u8>, Value) {
    let output = serve.control("runtime.pty.output", json!({ "id": pane }));
    let bytes = base64::engine::general_purpose::STANDARD.decode(output["data"].as_str().unwrap_or_default()).unwrap();
    (bytes, output["pid"].clone())
}

/// Hand the runtime over to `binary` and wait for the runtime that takes
/// over to answer: the same process, a new runtime in it.
fn hand_over(serve: &Serve, binary: &Path) -> Value {
    let before = serve.control("status", json!({}));
    let epoch = before["localRuntime"]["epoch"].clone();
    assert_eq!(before["localRuntime"]["handover"], 1, "the runtime says which handover it writes");
    let plan = serve.control("runtime.handover.plan", json!({ "epoch": epoch, "binary": binary }));
    assert_eq!(plan["unadoptable"], json!([]), "nothing needs stopping");
    let reply = serve.control("runtime.handover", json!({ "epoch": epoch, "binary": binary }));
    assert_eq!(reply["handingOver"], true, "{reply}");
    let after = wait_until("the runtime that took over", || {
        let status = serve.try_control("status", json!({}));
        (status["ok"] == true && status["result"]["localRuntime"]["epoch"] != epoch).then(|| status["result"].clone())
    });
    assert_eq!(after["pid"], before["pid"], "the same process");
    after
}

fn closed(events: &[Value]) -> bool {
    events.iter().any(|event| event.to_string().contains("Session closed"))
}

/// #818: a native connection cannot transfer, even between turns. Refusing
/// first must leave it running; approving its stop must then allow the real
/// runtime exec, without disturbing an ordinary PTY agent beside it.
#[test]
fn approved_native_codex_stop_allows_handover_after_a_refusal() {
    use std::os::unix::fs::PermissionsExt;
    extern "C" { fn kill(pid: i32, signal: i32) -> i32; }
    let alive = |pid: u32| unsafe { kill(pid as i32, 0) == 0 };
    let world = AgentWorld::new();
    let codex = world.bin.join("codex");
    std::fs::write(&codex, r#"#!/usr/bin/env python3
import json, os, sys
if '--version' in sys.argv:
    print('codex-cli 0.166.0')
    sys.exit(0)
def emit(frame):
    print(json.dumps(frame), flush=True)
for line in sys.stdin:
    frame = json.loads(line)
    method, ident = frame.get('method'), frame.get('id')
    if method == 'initialize':
        emit({'id': ident, 'result': {}})
    elif method in ('thread/start', 'thread/resume'):
        emit({'id': ident, 'result': {'thread': {'id': 'native-thread'}}})
    elif method == 'turn/start':
        with open('native.pid', 'w') as f:
            f.write(str(os.getpid()))
        emit({'id': ident, 'result': {'turn': {'id': 'turn'}}})
        emit({'method': 'turn/started', 'params': {'threadId': 'native-thread', 'turn': {'id': 'turn'}}})
        emit({'method': 'turn/completed', 'params': {'threadId': 'native-thread', 'turn': {'id': 'turn', 'status': 'completed'}}})
"#).unwrap();
    std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755)).unwrap();
    // Discovery checks the home's known install directories before PATH.
    // Pin both stand-ins there even on a developer machine with real CLIs.
    let local_bin = world.home.join(".local/bin");
    std::fs::create_dir_all(&local_bin).unwrap();
    for name in ["codex", "claude"] {
        std::os::unix::fs::symlink(world.bin.join(name), local_bin.join(name)).unwrap();
    }
    let binary = installed(&world);
    let mut command = world.command();
    command.env("SHELL", "/bin/sh");
    let serve = Serve::start(command, &world.data);
    let native = serve.control("sessions.create", json!({
        "project": world.project, "agent": "codex", "prompt": "finish a turn", "useWorktree": false,
        "onMain": true, "mode": "auto", "experimentalCodexStdio": true,
    }));
    let tab = native["tabId"].as_str().unwrap();
    serve.wait_events(tab, "the native turn to finish", |events| count(events, "turn_completed") == 1);
    let native_pid: u32 = std::fs::read_to_string(world.project.join("native.pid")).unwrap().parse().unwrap();
    let pty = serve.control("sessions.create", json!({
        "project": world.project, "agent": "claude", "prompt": "echo:before", "useWorktree": false,
        "onMain": true, "mode": "manual",
    }));
    let pty_tab = pty["tabId"].as_str().unwrap();
    serve.wait_events(pty_tab, "the PTY turn to finish", |events| count(events, "turn_completed") == 1);
    let pane = format!("tab:{pty_tab}");
    let pty_pid = output(&serve, &pane).1;
    let before = serve.control("status", json!({}));
    let epoch = &before["localRuntime"]["epoch"];
    let plan = serve.control("runtime.handover.plan", json!({ "epoch": epoch, "binary": binary }));
    let stop = plan["unadoptable"].as_array().unwrap();
    assert_eq!(stop.len(), 1);
    assert_eq!(stop[0]["tabId"], tab);
    let refused = serve.try_control("runtime.handover", json!({ "epoch": epoch, "binary": binary }));
    assert_eq!(refused["error"]["code"], "handover_unadoptable", "{refused}");
    assert!(alive(native_pid), "refusal does not stop native Codex");
    let reply = serve.control("runtime.handover", json!({ "epoch": epoch, "binary": binary, "stop": stop }));
    assert_eq!(reply["handingOver"], true);
    let after = wait_until("the approved handover", || {
        let status = serve.try_control("status", json!({}));
        (status["ok"] == true && status["result"]["localRuntime"]["epoch"] != *epoch).then(|| status["result"].clone())
    });
    assert_eq!(after["pid"], before["pid"]);
    assert_eq!(after["localRuntime"]["version"], raccoon_lib::local_runtime::handover::formats()["version"]);
    assert_eq!(after["appVersion"], after["localRuntime"]["version"]);
    assert!(!alive(native_pid), "only the approved native process stopped");
    assert_eq!(output(&serve, &pane).1, pty_pid);
    serve.control("send", json!({ "target": pty_tab, "text": "echo:after" }));
    let events = serve.wait_events(pty_tab, "the PTY turn after handover", |events| count(events, "turn_completed") == 2);
    assert!(texts(&events, "assistant_text").iter().any(|text| text == "after"));
    hand_over(&serve, &binary);
    assert_eq!(output(&serve, &pane).1, pty_pid, "retry remains safe after native cleanup");
}

/// #765: an agent mid-turn with a follow-up queued, an agent waiting on a
/// permission, and a terminal running a long command all go on through the
/// replacement, with the same processes: the turn finishes, the follow-up is
/// answered, the permission granted afterwards is the one asked before, the
/// command's later output reaches the terminal, and no tab is closed.
#[test]
fn replacing_the_runtime_keeps_its_agents_and_terminals_running() {
    if std::process::Command::new("python3").arg("--version").output().is_err() {
        eprintln!("skipped: python3 is not installed");
        return;
    }
    let world = AgentWorld::new();
    let binary = installed(&world);
    let serve = Serve::start(world.command(), &world.data);
    let create = |prompt: &str| {
        let created = serve.control("sessions.create", json!({
            "project": world.project, "agent": "claude", "prompt": prompt, "useWorktree": false, "onMain": true, "mode": "manual",
        }));
        (created["sessionId"].as_str().unwrap().to_string(), created["tabId"].as_str().unwrap().to_string())
    };

    // An agent in the middle of a long turn, with a follow-up sent during it.
    let (_, working) = create("slow:16:400");
    serve.wait_events(&working, "the long turn to start", |events| texts(events, "assistant_text").iter().any(|text| text == "chunk 2 of 16"));
    assert_eq!(serve.control("send", json!({ "target": working, "text": "and then the tests" }))["outcome"]["queued"], true);
    // An agent waiting on a permission.
    let (_, asking) = create("ask:touch kept.txt");
    assert_eq!(serve.control("wait", json!({ "target": asking, "timeoutSeconds": 30 }))["reason"], "permission");
    let asked = serve.control("permissions.list", json!({}))["permissions"].as_array().cloned().unwrap();
    assert_eq!(asked.len(), 1, "{asked:?}");
    // A terminal running a long command.
    let (session, echoing) = create("echo:terminal host");
    let terminal = format!("{session}:1");
    serve.control("runtime.pty.spawn", json!({ "id": terminal, "cwd": world.project, "cols": 80, "rows": 24,
        "command": "sh -c 'i=0; while [ ! -f stop ]; do i=$((i+1)); echo tick-$i; sleep 0.05; done'" }));
    wait_until("the terminal's first ticks", || (ticks(&output(&serve, &terminal).0).len() >= 5).then_some(()));
    let agent_pane = format!("tab:{working}");
    let (_, agent_pid) = output(&serve, &agent_pane);
    let (_, asking_pid) = output(&serve, &format!("tab:{asking}"));
    let (before, terminal_pid) = output(&serve, &terminal);
    assert!(agent_pid.is_u64() && asking_pid.is_u64() && terminal_pid.is_u64());

    let version = serve.control("status", json!({}))["localRuntime"]["version"].clone();
    // Every turn but the long one has started, and the terminal's host has
    // ended, before stats are read.
    serve.wait_events(&echoing, "the terminal host's turn to end", |events| count(events, "turn_completed") >= 1);
    let counted = || serve.control("runtime.session.activity", json!({}));
    let before_activity = counted();
    let after = hand_over(&serve, &binary);
    assert_eq!(after["localRuntime"]["version"], version, "the installed copy is the same build");

    // The same processes, in the same terminals.
    assert_eq!(output(&serve, &agent_pane).1, agent_pid, "the working agent was not restarted");
    assert_eq!(output(&serve, &format!("tab:{asking}")).1, asking_pid, "the asking agent was not restarted");
    assert_eq!(output(&serve, &terminal).1, terminal_pid, "the terminal's command was not restarted");

    // The turn under way finishes in the chat, and the follow-up sent during
    // it is answered, once.
    let events = serve.wait_events(&working, "the long turn to end", |events| count(events, "turn_completed") >= 1);
    let said = texts(&events, "assistant_text");
    for chunk in 1..=16 {
        assert_eq!(said.iter().filter(|text| **text == format!("chunk {chunk} of 16")).count(), 1, "chunk {chunk}: {said:?}");
    }
    assert_eq!(said.iter().filter(|text| *text == "steered: and then the tests").count(), 1, "{said:?}");
    assert_eq!(texts(&events, "user_message").iter().filter(|text| *text == "and then the tests").count(), 1);
    // Stats count the turn once, for the whole of it, though it began in the
    // runtime that handed over: 16 chunks, 400 ms apart, at least 6 s.
    let activity = counted();
    assert_eq!(activity["agentsSpawned"], before_activity["agentsSpawned"], "the turn under way is no new start: {activity}");
    let time = |summary: &Value| summary["agentTimeMs"].as_u64().unwrap();
    assert!(time(&activity) - time(&before_activity) >= 15 * 400, "the turn's time before the handover counts: {before_activity} then {activity}");

    // The card asked for before is the one answered after, and the tool runs.
    let pending = serve.control("permissions.list", json!({}))["permissions"].as_array().cloned().unwrap();
    assert_eq!(pending.iter().map(|ask| &ask["requestId"]).collect::<Vec<_>>(), asked.iter().map(|ask| &ask["requestId"]).collect::<Vec<_>>());
    serve.control("permissions.allow", json!({ "request": pending[0]["requestId"] }));
    let events = serve.wait_events(&asking, "the allowed tool", |events| texts(events, "assistant_text").iter().any(|text| text == "allowed: touch kept.txt"));
    assert_eq!(count(&events, "permission_requested"), 1, "asked once");
    serve.wait_events(&asking, "its turn to end", |events| count(events, "turn_completed") >= 1);

    // A permission asked by an agent the old runtime started reaches the new
    // one, and so does the end of its turn.
    serve.control("send", json!({ "target": working, "text": "ask:echo after the update" }));
    assert_eq!(serve.control("wait", json!({ "target": working, "timeoutSeconds": 30 }))["reason"], "permission");
    let pending = serve.control("permissions.list", json!({}))["permissions"].as_array().cloned().unwrap();
    serve.control("permissions.allow", json!({ "request": pending[0]["requestId"] }));
    let events = serve.wait_events(&working, "the turn after the update to end", |events| count(events, "turn_completed") >= 2);
    assert!(texts(&events, "assistant_text").iter().any(|text| text == "allowed: echo after the update"));
    assert_eq!(serve.control("wait", json!({ "target": working, "timeoutSeconds": 30 }))["reason"], "stop");

    // The command's output went on reaching its terminal, none of it lost.
    let last = *ticks(&before).last().unwrap();
    wait_until("the terminal's ticks after the update", || ticks(&output(&serve, &terminal).0).last().is_some_and(|tick| *tick > last + 40).then_some(()));
    let all = ticks(&output(&serve, &terminal).0);
    assert!(all.windows(2).all(|pair| pair[1] == pair[0] + 1), "a tick was lost or repeated: {all:?}");

    for tab in [&working, &asking] {
        assert!(!closed(&serve.events(tab)), "no tab says its session closed");
    }
    std::fs::write(world.project.join("stop"), b"").unwrap();
}

/// #765: the runtime that took over can be handed over again; a binary that
/// is not one of this home's installed runtimes, or one that cannot read the
/// record this runtime writes, is refused with nothing stopped.
#[test]
fn a_runtime_is_handed_over_only_to_an_installed_runtime_and_again_after() {
    if std::process::Command::new("python3").arg("--version").output().is_err() {
        eprintln!("skipped: python3 is not installed");
        return;
    }
    let world = AgentWorld::new();
    let binary = installed(&world);
    let serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project": world.project, "agent": "claude", "prompt": "echo:before", "useWorktree": false, "onMain": true, "mode": "manual",
    }));
    let tab = created["tabId"].as_str().unwrap().to_string();
    serve.wait_events(&tab, "the first turn", |events| count(events, "turn_completed") >= 1);
    let (_, pid) = output(&serve, &format!("tab:{tab}"));

    let epoch = serve.control("status", json!({}))["localRuntime"]["epoch"].clone();
    let stranger = serve.try_control("runtime.handover", json!({ "epoch": epoch, "binary": env!("CARGO_BIN_EXE_terminalx-serve") }));
    assert_eq!(stranger["error"]["code"], "handover_unsupported", "{stranger}");
    assert_eq!(serve.control("status", json!({}))["localRuntime"]["epoch"], epoch, "nothing was replaced");
    let stale = serve.try_control("runtime.handover", json!({ "epoch": "another", "binary": binary }));
    assert_eq!(stale["error"]["code"], "runtime_restarted");
    // A runtime that reads none of the handover records this one writes
    // (a newer format only, say) is never handed over to: it is refused
    // before anything is held, and nothing is stopped.
    let dir = tempfile::tempdir().unwrap();
    let foreign = dir.path().join("terminalx-serve");
    std::fs::write(&foreign, "#!/bin/sh\n[ \"$1\" = handover-formats ] && echo '{\"version\":\"99.0.0\",\"formats\":[999]}' && exit 0\nexit 1\n").unwrap();
    let foreign = raccoon_lib::local_runtime::launch::install(&foreign, &world.data).unwrap();
    let unreadable = serve.try_control("runtime.handover", json!({ "epoch": epoch, "binary": foreign }));
    assert_eq!(unreadable["error"]["code"], "handover_unsupported", "{unreadable}");
    let planned = serve.try_control("runtime.handover.plan", json!({ "epoch": epoch, "binary": foreign }));
    assert_eq!(planned["error"]["code"], "handover_unsupported", "{planned}");
    assert_eq!(serve.control("status", json!({}))["localRuntime"]["epoch"], epoch, "nothing was replaced");
    assert_eq!(output(&serve, &format!("tab:{tab}")).1, pid, "nothing was stopped");

    hand_over(&serve, &binary);
    hand_over(&serve, &binary);
    assert_eq!(output(&serve, &format!("tab:{tab}")).1, pid, "the same agent through two replacements");
    serve.control("send", json!({ "target": tab, "text": "echo:after twice" }));
    let events = serve.wait_events(&tab, "a turn after two replacements", |events| count(events, "turn_completed") >= 2);
    assert!(texts(&events, "assistant_text").iter().any(|text| text == "after twice"));
    assert!(!closed(&events));
}
