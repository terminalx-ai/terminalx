//! Local ownership and detach exercise the real runtime and fake provider,
//! with no installed desktop, cloud account or production store.
#![cfg(unix)]

mod common;

use std::time::{Duration, Instant};
use common::agent::{count, texts, AgentWorld, Serve};
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use base64::Engine as _;

struct Stream(BufReader<UnixStream>);

impl Stream {
    fn open(serve: &Serve) -> Self {
        let status = serve.control("status", json!({}));
        let socket = UnixStream::connect(status["localRuntime"]["eventSocket"].as_str().unwrap()).unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut stream = Self(BufReader::new(socket));
        stream.send(json!({"protocol":1,"token":serve.token}));
        assert_eq!(stream.next()["type"], "ready");
        stream
    }
    fn send(&mut self, value: serde_json::Value) {
        writeln!(self.0.get_mut(), "{value}").unwrap();
    }
    fn next(&mut self) -> serde_json::Value {
        let mut line = String::new();
        assert!(self.0.read_line(&mut line).unwrap() != 0, "stream disconnected");
        serde_json::from_str(&line).unwrap()
    }
    fn pty(&mut self, id: &str) -> Vec<u8> {
        loop {
            let frame = self.next();
            if frame["type"] == "pty" && frame["id"] == id {
                return base64::engine::general_purpose::STANDARD.decode(frame["data"].as_str().unwrap()).unwrap();
            }
        }
    }
}

fn stopped(serve: &mut Serve) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = serve.child.try_wait().unwrap() {
            assert!(status.success());
            return;
        }
        assert!(Instant::now() < until, "runtime failed to exit");
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn only_one_local_owner_can_touch_a_home() {
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);
    let before = serve.control("status", json!({}));
    let token = std::fs::read(world.data.join("run/control.token")).unwrap();
    let rejected = world.command().output().unwrap();
    assert!(!rejected.status.success());
    assert_eq!(std::fs::read(world.data.join("run/control.token")).unwrap(), token);
    // The age of the loop's last pass moves on by itself (#661); nothing else may.
    let owner = |status: serde_json::Value| {
        let mut local = status["localRuntime"].clone();
        local.as_object_mut().unwrap().remove("loopAgeMs");
        local
    };
    assert_eq!(owner(serve.control("status", json!({}))), owner(before));
}

#[test]
fn a_lease_holds_an_idle_runtime_and_detach_releases_it() {
    let world = AgentWorld::new();
    let mut command = world.command();
    command.args(["--idle-grace-seconds", "1"]);
    let mut serve = Serve::start(command, &world.data);
    let attachment = serve.control("runtime.attach", json!({"protocol":1}));
    std::thread::sleep(Duration::from_secs(2));
    assert!(serve.child.try_wait().unwrap().is_none());
    serve.control("runtime.heartbeat", attachment.clone());
    serve.control("runtime.detach", attachment);
    stopped(&mut serve);
}

#[test]
fn detached_turn_and_permission_keep_the_same_owner_and_history() {
    let world = AgentWorld::new();
    let mut command = world.command();
    command.args(["--idle-grace-seconds", "1"]);
    let mut serve = Serve::start(command, &world.data);
    let first = serve.control("runtime.attach", json!({"protocol":1}));
    let created = serve.control("sessions.create", json!({
        "project":world.project, "agent":"claude", "prompt":"slow:6:500",
        "useWorktree":false, "onMain":true, "mode":"manual"
    }));
    let tab = created["tabId"].as_str().unwrap();
    serve.control("runtime.detach", first.clone());
    let events = serve.wait_events(tab, "detached turn completion", |events| count(events, "turn_completed") == 1);
    let said = texts(&events, "assistant_text");
    for chunk in 1..=6 { assert!(said.contains(&format!("chunk {chunk} of 6"))); }
    assert_eq!(texts(&events, "user_message"), ["slow:6:500"]);
    let second = serve.control("runtime.attach", json!({"protocol":1}));
    assert_eq!(first["epoch"], second["epoch"]);
    assert_ne!(first["lease"], second["lease"]);
    assert_eq!(serve.control("status", json!({}))["pid"], serve.child.id());
    serve.control("send", json!({"target":tab, "text":"ask:echo approved"}));
    assert_eq!(serve.control("wait", json!({"target":tab, "timeoutSeconds":10}))["reason"], "permission");
    let pending = serve.control("permissions.list", json!({}));
    serve.control("runtime.detach", second);
    std::thread::sleep(Duration::from_secs(2));
    let third = serve.control("runtime.attach", json!({"protocol":1}));
    assert_eq!(first["epoch"], third["epoch"]);
    assert_eq!(pending, serve.control("permissions.list", json!({})));
    let request = &pending["permissions"][0]["requestId"];
    serve.control("permissions.allow", json!({"request":request}));
    let events = serve.wait_events(tab, "reattached approval", |events| count(events, "turn_completed") == 2);
    assert!(texts(&events, "assistant_text").contains(&"allowed: echo approved".into()));
    assert!(!events.iter().any(|event| event["payload"]["type"] == "recovery"));
    serve.control("runtime.stopAll", json!({"epoch":third["epoch"]}));
    stopped(&mut serve);
}

#[test]
fn disconnect_releases_unacknowledged_output_and_reattach_reads_the_retained_tail() {
    let world = AgentWorld::new();
    let mut serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project, "agent":"claude", "prompt":"echo:ready",
        "useWorktree":false, "onMain":true, "mode":"manual"
    }));
    let id = format!("{}:1", created["sessionId"].as_str().unwrap());
    let mut stream = Stream::open(&serve);
    // Attach before spawn, just like a newly mounted terminal view. Its old
    // acknowledgement debt must not hold the process after the socket closes.
    stream.send(json!({"method":"attach","id":id,"token":"view"}));
    serve.control("runtime.pty.spawn", json!({"id":id,"cwd":world.project,"cols":80,"rows":24,
        "command":"sh -c 'sleep 0.2; head -c 4194304 /dev/zero; printf done-after-detach; sleep 20'"}));
    let pid = serve.control("runtime.pty.output", json!({"id":id}))["pid"].clone();
    let mut bytes = 0;
    while bytes <= 1024 * 1024 { bytes += stream.pty(&id).len(); }
    drop(stream);
    common::agent::wait_until("the disconnected tap to disappear", || {
        (serve.control("runtime.pty.stats", json!({}))["views"] == 0).then_some(())
    });
    let output = common::agent::wait_until("the command to finish printing while detached", || {
        let output = serve.control("runtime.pty.output", json!({"id":id}));
        let bytes = base64::engine::general_purpose::STANDARD.decode(output["data"].as_str().unwrap()).unwrap();
        bytes.ends_with(b"done-after-detach").then_some((output, bytes))
    });
    assert_eq!(output.0["pid"], pid);
    assert_eq!(output.0["running"], true);
    assert!(output.1.len() <= 512 * 1024, "history is bounded");
    let mut stream = Stream::open(&serve);
    stream.send(json!({"method":"attach","id":id,"token":"new-view"}));
    let replay = stream.pty(&id);
    assert_eq!(replay, output.1, "reattach hands over the retained bytes exactly once");
    stream.send(json!({"method":"ack","id":id,"token":"new-view","drawn":replay.len()}));
    common::agent::wait_until("the replay acknowledgement", || {
        (serve.control("runtime.pty.stats", json!({}))["unackedBytes"] == 0).then_some(())
    });
    let epoch = serve.control("status", json!({}))["localRuntime"]["epoch"].clone();
    serve.control("runtime.stopAll", json!({"epoch":epoch}));
    stopped(&mut serve);
    // This is this disposable runtime's shell PID, never a live app process.
    let status = std::process::Command::new("kill").args(["-0", &pid.as_u64().unwrap().to_string()]).output().unwrap();
    assert!(!status.status.success(), "stop-all left the terminal process alive");
}

#[test]
fn event_socket_rejects_invalid_authentication_without_an_attachment() {
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);
    let status = serve.control("status", json!({}));
    for hello in [json!({"protocol":1,"token":"not-the-owner"}), json!({"protocol":2,"token":serve.token})] {
        let socket = UnixStream::connect(status["localRuntime"]["eventSocket"].as_str().unwrap()).unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut stream = Stream(BufReader::new(socket));
        stream.send(hello);
        let mut response = String::new();
        assert_eq!(stream.0.read_line(&mut response).unwrap(), 0);
        assert_eq!(serve.control("status", json!({}))["localRuntime"]["attachedClients"], 0);
    }
}

#[test]
fn native_client_pins_its_owner_and_cannot_send_to_a_replacement() {
    let world = AgentWorld::new();
    // This is an empty-profile transport test. Registering the fixture Git
    // project also starts asynchronous GitHub PR recovery, whose legitimate
    // missing-credential error races the empty accounting assertion below.
    // Start without a project so there is no unrelated external GitHub work.
    let start = || {
        let mut command = std::process::Command::new(env!("CARGO_BIN_EXE_terminalx-serve"));
        command.arg("--data-dir").arg(&world.data)
            .env("HOME", &world.home)
            .env("CLAUDE_CONFIG_DIR", world.home.join(".claude"))
            .env_remove("TERMINALX_HOME")
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit());
        Serve::start(command, &world.data)
    };
    let mut serve = start();
    let client = raccoon_lib::local_runtime::client::Client::connect(&world.data).unwrap();
    let mut events = client.stream(&raccoon_lib::local_runtime::client::Stream::Events).unwrap();
    writeln!(events.writer().unwrap(), "{}", json!({"method":"ping"})).unwrap();
    assert_eq!(events.receive().unwrap()["type"], "pong");
    let status: serde_json::Value = client.call("status", json!({})).unwrap();
    assert_eq!(status["pid"], serve.child.id());
    assert_eq!(events.attachment().epoch, status["localRuntime"]["epoch"]);
    assert!(!events.attachment().lease.is_empty());
    let sessions = raccoon_lib::local_runtime::sessions::Sessions::new(client.clone());
    sessions.usage_snapshot().unwrap();
    let activity = sessions.activity_summary().unwrap();
    assert_eq!(activity.agents_spawned, 0);
    assert!(activity.accounting_error.is_none(), "unexpected accounting error: {:?}", activity.accounting_error);
    client.stop_all().unwrap();
    stopped(&mut serve);
    drop(events);
    drop(serve);
    let replacement = start();
    assert!(client.call::<serde_json::Value>("status", json!({})).is_err());
    assert!(sessions.usage_snapshot().is_err(), "disconnected usage must not look like an empty account");
    assert!(sessions.activity_summary().is_err(), "disconnected activity must not be read by a new UI owner");
    assert!(sessions.running_tabs().is_err(), "disconnect is not an empty running list");
    assert!(sessions.pending_permissions().is_err(), "disconnect must not hide pending asks");
    assert!(sessions.status_of("unknown", "unknown").is_err(), "disconnect is not idle");
    assert!(client.stop_all().is_err(), "stale clients must never follow a rotated discovery token");
    assert_ne!(status["localRuntime"]["epoch"], replacement.control("status", json!({}))["localRuntime"]["epoch"]);
}

#[test]
fn stop_all_cancels_an_already_admitted_long_poll() {
    let world = AgentWorld::new();
    let mut serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project, "agent":"claude", "prompt":"slow:100:1000",
        "useWorktree":false, "onMain":true, "mode":"manual"
    }));
    let tab = created["tabId"].as_str().unwrap();
    serve.wait_events(tab, "first slow chunk", |events| texts(events, "assistant_text").iter().any(|text| text.contains("chunk 1 of 100")));
    let mut socket = UnixStream::connect(&serve.socket).unwrap();
    socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    writeln!(socket, "{}", json!({"id":"long-wait", "token":serve.token, "command":"wait", "params":{"target":tab,"timeoutSeconds":86400}})).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let epoch = serve.control("status", json!({}))["localRuntime"]["epoch"].clone();
    serve.control("runtime.stopAll", json!({"epoch":epoch}));
    let mut line = String::new();
    BufReader::new(socket).read_line(&mut line).unwrap();
    let response: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["id"], "long-wait");
    assert_eq!(response["error"]["code"], "runtime_stopping");
    stopped(&mut serve);
}

#[test]
fn native_bridge_replays_bytes_and_releases_only_its_own_views() {
    use raccoon_lib::local_runtime::{bridge::Bridge, client::Client};
    use std::sync::Arc;
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project, "agent":"claude", "prompt":"echo:ready",
        "useWorktree":false, "onMain":true, "mode":"manual"
    }));
    let id = format!("{}:7", created["sessionId"].as_str().unwrap());
    serve.control("runtime.pty.spawn", json!({"id":id,"cwd":world.project,"cols":80,"rows":24,
        "command":"sh -c 'printf bridge-replay; sleep 60'"}));
    let output = common::agent::wait_until("retained bridge output", || {
        let output = serve.control("runtime.pty.output", json!({"id":id}));
        let bytes = base64::engine::general_purpose::STANDARD.decode(output["data"].as_str().unwrap()).unwrap();
        bytes.ends_with(b"bridge-replay").then_some(bytes)
    });
    let client = Client::connect(&world.data).unwrap();
    let sink = Arc::new(raccoon_lib::sink::BroadcastSink::new(16));
    let first = Bridge::connect_views(&client, sink.clone(), "first", None).unwrap();
    let second = Bridge::connect_views(&client, sink, "second", None).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    first.attach(&id, "same-token", Box::new(move |bytes| tx.send(bytes.to_vec()).is_ok())).unwrap();
    let (tx2, rx2) = std::sync::mpsc::channel();
    second.attach(&id, "same-token", Box::new(move |bytes| tx2.send(bytes.to_vec()).is_ok())).unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), output);
    assert_eq!(rx2.recv_timeout(Duration::from_secs(5)).unwrap(), output);
    common::agent::wait_until("two independent native views", || {
        (serve.control("runtime.pty.stats", json!({}))["views"] == 2).then_some(())
    });
    drop(first);
    common::agent::wait_until("only the closed window's view to detach", || {
        (serve.control("runtime.pty.stats", json!({}))["views"] == 1).then_some(())
    });
    second.ack(&id, "same-token", output.len() as u64).unwrap();
    common::agent::wait_until("native acknowledgement", || {
        (serve.control("runtime.pty.stats", json!({}))["unackedBytes"] == 0).then_some(())
    });
    second.detach_all().unwrap();
    common::agent::wait_until("native detach", || {
        (serve.control("runtime.pty.stats", json!({}))["views"] == 0).then_some(())
    });
    assert_eq!(serve.control("runtime.pty.output", json!({"id":id}))["running"], true);
}

#[test]
fn launcher_process_fixture() {
    let Some(home) = std::env::var_os("TERMINALX_LAUNCHER_FIXTURE_HOME") else { return };
    let source = std::env::var_os("TERMINALX_LAUNCHER_FIXTURE_BINARY").unwrap();
    let client = raccoon_lib::local_runtime::launch::connect_or_start(std::path::Path::new(&source), std::path::Path::new(&home)).unwrap();
    let _connection = client.stream(&raccoon_lib::local_runtime::client::Stream::Events).unwrap();
    // Deliberately skip all Rust drops: actual UI process exit must release
    // its socket without sending stop-all or owning the runtime's lifetime.
    std::process::exit(0);
}

/// Asks whatever runtime owns a disposable home to stop, and waits for it,
/// before the fixture is deleted, however the test ends.
struct StopPrivate(std::path::PathBuf);

impl Drop for StopPrivate {
    fn drop(&mut self) {
        if let Ok(client) = raccoon_lib::local_runtime::client::Client::connect(&self.0) {
            let status = client.call::<serde_json::Value>("status", json!({})).ok();
            let _ = client.stop_all();
            if let Some(pid) = status.and_then(|status| status["pid"].as_u64()) {
                let deadline = Instant::now() + Duration::from_secs(10);
                while Instant::now() < deadline {
                    if !alive(pid) { break; }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
        }
    }
}

fn alive(pid: u64) -> bool {
    std::process::Command::new("/bin/kill").args(["-0", &pid.to_string()]).output().is_ok_and(|output| output.status.success())
}

/// A home with one project, and a bundled runtime to install from it.
fn bundled(world: &AgentWorld) -> std::path::PathBuf {
    std::fs::write(world.data.join("projects.json"), serde_json::to_vec(&json!({"projects":[{"path":world.project,"name":"fixture"}]})).unwrap()).unwrap();
    let source = world.home.join("bundled-terminalx-serve");
    std::fs::copy(env!("CARGO_BIN_EXE_terminalx-serve"), &source).unwrap();
    source
}

/// Discover or start the home's runtime from `source` as a desktop does, from
/// a process with the fixture's environment, which then exits.
fn launch_installed(world: &AgentWorld, source: &std::path::Path) {
    let mut launcher = std::process::Command::new(std::env::current_exe().unwrap());
    launcher.args(["--exact", "launcher_process_fixture", "--nocapture"])
        .env_clear().env("HOME", &world.home)
        .env("PATH", format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", world.bin.display()))
        .env("CLAUDE_CONFIG_DIR", world.home.join(".claude"))
        .env("TERMINALX_HOME", &world.data)
        .env("TERMINALX_LAUNCHER_FIXTURE_HOME", &world.data)
        .env("TERMINALX_LAUNCHER_FIXTURE_BINARY", source);
    assert!(launcher.status().unwrap().success());
}

#[test]
fn installed_runtime_survives_launcher_exit_and_bundle_source_replacement() {
    use raccoon_lib::local_runtime::client::Client;
    let world = AgentWorld::new();
    // Created before the launcher so even an attachment assertion failure
    // asks only this disposable home's owner to stop before fixture deletion.
    let _private_owner = StopPrivate(world.data.clone());
    let source = bundled(&world);
    launch_installed(&world, &source);
    let client = Client::connect(&world.data).unwrap();
    struct Stop(std::sync::Arc<Client>);
    impl Drop for Stop { fn drop(&mut self) { let _ = self.0.stop_all(); } }
    let cleanup = Stop(client.clone());
    let _connection = client.stream(&raccoon_lib::local_runtime::client::Stream::Events).unwrap();
    let before: serde_json::Value = client.call("status", json!({})).unwrap();
    // Replace the bundle source inode, then remove it altogether. The signed
    // installed image and hook command paths must remain outside that source.
    std::fs::remove_file(&source).unwrap();
    std::fs::write(&source, b"replacement bundle placeholder").unwrap();
    let same = raccoon_lib::local_runtime::launch::connect_or_start(&source, &world.data).unwrap();
    std::fs::remove_file(&source).unwrap();
    let after: serde_json::Value = same.call("status", json!({})).unwrap();
    assert_eq!(before["pid"], after["pid"]);
    assert_eq!(before["localRuntime"]["epoch"], after["localRuntime"]["epoch"]);
    let created: serde_json::Value = client.call("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:after-bundle-replacement",
        "useWorktree":false,"onMain":true,"mode":"manual"
    })).unwrap();
    let tab = created["tabId"].as_str().unwrap();
    common::agent::wait_until("provider hooks from the installed helper", || {
        let events: serde_json::Value = client.call("read", json!({"target":tab})).unwrap();
        events["events"].as_array().filter(|events| count(events,"turn_completed") == 1).cloned()
    });
    client.stop_all().unwrap();
    let pid = before["pid"].as_u64().unwrap();
    common::agent::wait_until("the installed owner to stop", || (!alive(pid)).then_some(()));
    drop(cleanup);
}

/// #730, against a real installed runtime: what a desktop needs to bring the
/// runtime along with an update. The runtime says its build without being
/// asked, says which agents are in the middle of a turn (what the switch
/// waits for), and once retired as Stop All retires it, has gone, so the next
/// launch starts another in its place, with the session there to resume.
#[test]
fn a_runtime_says_its_build_and_turns_and_a_retired_one_is_replaced_by_the_next_launch() {
    use raccoon_lib::local_runtime::{client::{Client, Stream}, launch};
    let world = AgentWorld::new();
    let _private_owner = StopPrivate(world.data.clone());
    let source = bundled(&world);
    launch_installed(&world, &source);
    let client = Client::connect(&world.data).unwrap();
    let _connection = client.stream(&Stream::Events).unwrap();
    let status: serde_json::Value = client.call("status", json!({})).unwrap();
    assert_eq!(client.build().version.as_ref().map(ToString::to_string).as_deref(), status["appVersion"].as_str());
    assert_eq!(serde_json::Value::Object(client.build().mobile.clone()), raccoon_lib::local_runtime::mobile::features());

    let created: serde_json::Value = client.call("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"slow:30:200","useWorktree":false,"onMain":true,"mode":"manual"
    })).unwrap();
    let (session, tab) = (created["sessionId"].as_str().unwrap().to_string(), created["tabId"].as_str().unwrap().to_string());
    let turn = |status: &serde_json::Value| status["runningTabs"].as_array().unwrap().iter()
        .find(|running| running["tabId"] == tab.as_str()).map(|running| running["status"].as_str().unwrap().to_string());
    common::agent::wait_until("the agent to be in the middle of its turn", || {
        (turn(&client.call("status", json!({})).unwrap()).as_deref() == Some("in_progress")).then_some(())
    });
    common::agent::wait_until("its turn to end", || {
        let events: serde_json::Value = client.call("read", json!({"target":tab})).unwrap();
        (count(events["events"].as_array().unwrap(), "turn_completed") == 1).then_some(())
    });
    let status: serde_json::Value = client.call("status", json!({})).unwrap();
    assert!(turn(&status).is_some_and(|status| status != "in_progress" && status != "waiting"), "nothing mid-turn: {status}");

    let pid = status["pid"].as_u64().unwrap();
    launch::retire(&world.data, || client.stop_all()).unwrap();
    // It has let go of its socket; the process itself may take a moment more.
    common::agent::wait_until("the retired runtime to exit", || (!alive(pid)).then_some(()));
    launch_installed(&world, &source);
    let next = Client::connect(&world.data).unwrap();
    assert_ne!(next.epoch(), client.epoch(), "a fresh runtime took its place");
    let shown: serde_json::Value = next.call("sessions.show", json!({"session": session})).unwrap();
    assert!(shown["tabs"].as_array().unwrap().iter().any(|shown| shown["id"] == tab.as_str()), "the session is there to resume: {shown}");
    next.stop_all().unwrap();
}

#[test]
fn a_partial_view_request_is_not_discarded_when_an_event_arrives() {
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:ready",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let id = format!("{}:8", created["sessionId"].as_str().unwrap());
    let mut stream = Stream::open(&serve);
    let request = format!("{}\n", json!({"method":"attach","id":id,"token":"fragmented-view"}));
    let split = request.len() / 2;
    stream.0.get_mut().write_all(&request.as_bytes()[..split]).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    serve.control("runtime.pty.spawn", json!({"id":id,"cwd":world.project,"cols":80,"rows":24,
        "command":"sh -c 'printf fragmented-request-survived; sleep 30'"}));
    loop {
        let frame = stream.next();
        if frame["type"] == "event" && frame["event"] == "pty_opened" && frame["payload"]["id"] == id { break; }
    }
    // Reading this event proves select resumed its other branch while the
    // input frame had no newline. The already consumed prefix must survive.
    stream.0.get_mut().write_all(&request.as_bytes()[split..]).unwrap();
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"fragmented-request-survived") { bytes.extend(stream.pty(&id)); }
}

fn scheduled_fixture(world: &AgentWorld, enabled: bool) {
    let automation = json!({
        "id":"scheduled-fixture","name":"Fixture schedule","enabled":enabled,
        "projectPath":world.project,"harness":"claude","mode":"manual",
        "prompt":"echo:scheduled-without-a-window","workspace":"newWorktree",
        "schedule":{"kind":"preset","preset":"hourly","minute":0,"timezone":"UTC","dtstart":"1970-01-01T00:00:00Z"},
        "nextRunAt":"1970-01-01T00:00:00Z","missedRunGraceMinutes":u32::MAX,
        "created":"1970-01-01T00:00:00Z","modified":"1970-01-01T00:00:00Z",
        "pipeline":{"autoMerge":false,"resolveConflicts":false}
    });
    std::fs::write(world.data.join("automations.json"), serde_json::to_vec(&json!({"automations":[automation]})).unwrap()).unwrap();
}

#[test]
fn local_schedule_runs_and_records_completion_without_a_window() {
    let world = AgentWorld::new();
    scheduled_fixture(&world, true);
    let mut serve = Serve::start(world.command(), &world.data);
    let completed = common::agent::wait_until("the local scheduled turn to complete", || {
        let runs = std::fs::read_to_string(world.data.join("automations/scheduled-fixture/runs.jsonl")).ok()?;
        runs.lines().filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .find(|run| run["status"] == "completed")
    });
    let tab = completed["tabId"].as_str().unwrap();
    let events = serve.events(tab);
    assert!(texts(&events, "assistant_text").iter().any(|text| text.contains("scheduled-without-a-window")));
    assert_eq!(serve.control("status", json!({}))["localRuntime"]["attachedClients"], 0);
    let pipelines = std::fs::read_to_string(world.data.join("issue-pipelines.json")).ok()
        .map(|text| serde_json::from_str::<serde_json::Value>(&text).unwrap()).unwrap_or_else(|| json!({"pipelines":[]}));
    assert_eq!(pipelines["pipelines"], json!([]), "both-off automation must not create a pipeline");
    let epoch = serve.control("status", json!({}))["localRuntime"]["epoch"].clone();
    serve.control("runtime.stopAll", json!({"epoch":epoch}));
    stopped(&mut serve);
}

#[test]
fn a_disabled_schedule_does_not_hold_an_idle_runtime() {
    let world = AgentWorld::new();
    scheduled_fixture(&world, false);
    let mut command = world.command();
    command.args(["--idle-grace-seconds", "1"]);
    let mut serve = Serve::start(command, &world.data);
    stopped(&mut serve);
    assert!(!world.data.join("automations/scheduled-fixture/runs.jsonl").exists());
}

#[test]
fn interrupted_automation_is_recovered_before_ready_and_not_on_reattach() {
    let world = AgentWorld::new();
    scheduled_fixture(&world, false);
    let directory = world.data.join("automations/scheduled-fixture");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("runs.jsonl");
    let open = json!({"runId":"interrupted-fixture","runNumber":1,
        "automationId":"scheduled-fixture","trigger":"scheduled","status":"running",
        "startedAt":"1970-01-01T00:00:00Z","futureField":{"retained":true}});
    std::fs::write(&path, format!("{open}\n")).unwrap();
    let serve = Serve::start(world.command(), &world.data);
    let recovered = std::fs::read_to_string(&path).unwrap();
    let last: serde_json::Value = serde_json::from_str(recovered.lines().last().unwrap()).unwrap();
    assert_eq!(last["status"], "failed");
    assert!(last["endedAt"].is_string());
    assert_eq!(last["futureField"], open["futureField"]);
    for _ in 0..2 {
        let stream = Stream::open(&serve);
        drop(stream);
    }
    assert_eq!(std::fs::read_to_string(path).unwrap(), recovered,
        "attachment must not rewrite recovered automation history");
}

#[test]
fn typed_session_adapter_reattaches_to_a_pending_turn_and_answers_without_recovery() {
    use raccoon_lib::local_runtime::{client::Client, sessions::Sessions};
    let world = AgentWorld::new();
    let mut serve = Serve::start(world.command(), &world.data);
    let first_client = Client::connect(&world.data).unwrap();
    let first_stream = first_client.stream(&raccoon_lib::local_runtime::client::Stream::Events).unwrap();
    let epoch = first_stream.attachment().epoch.clone();
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"ask:echo pending-while-detached",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let session = created["sessionId"].as_str().unwrap();
    let tab = created["tabId"].as_str().unwrap();
    drop(first_stream);
    drop(first_client);
    assert_eq!(serve.control("wait", json!({"target":tab,"timeoutSeconds":10}))["reason"], "permission");
    let client = Client::connect(&world.data).unwrap();
    let stream = client.stream(&raccoon_lib::local_runtime::client::Stream::Events).unwrap();
    assert_eq!(stream.attachment().epoch, epoch);
    let sessions = Sessions::new(client.clone());
    let pending = sessions.pending_permissions().unwrap();
    let pending = pending.iter().find(|request| request.tab_id == tab).unwrap();
    assert_eq!(pending.session_id, session);
    assert!(sessions.running_tabs().unwrap().iter().any(|running| running.tab_id == tab));
    assert!(sessions.pane_of(session, tab).unwrap().is_some());
    assert!(sessions.queued(session, tab).unwrap().is_empty());
    sessions.load_events(session, tab).unwrap();
    sessions.respond_permission(session, tab, &pending.request_id, "allow").unwrap();
    serve.wait_events(tab, "reattached permission completion", |events| count(events, "turn_completed") == 1);
    let events: Vec<serde_json::Value> = sessions.load_events(session, tab).unwrap().into_iter().map(|event| serde_json::to_value(event).unwrap()).collect();
    assert_eq!(texts(&events, "user_message"), ["ask:echo pending-while-detached"]);
    assert!(!serde_json::to_string(&events).unwrap().contains("Session closed."));
    assert!(sessions.pending_permissions().unwrap().is_empty());
    sessions.send(session, tab, "echo:typed-after-attach".into(), Vec::new()).unwrap();
    serve.wait_events(tab, "typed adapter send", |events| texts(events, "assistant_text").iter().any(|text| text.contains("typed-after-attach")));
    client.stop_all().unwrap();
    stopped(&mut serve);
    assert!(sessions.load_events(session, tab).is_err());
}

#[test]
fn desktop_windows_share_events_once_and_release_only_their_own_flow_control() {
    use raccoon_lib::local_runtime::{client::Client, desktop::Desktop};
    use raccoon_lib::sink::EventSink;
    use std::sync::Arc;
    let world = AgentWorld::new();
    let mut serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:ready",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let id = format!("{}:8", created["sessionId"].as_str().unwrap());
    serve.control("runtime.pty.spawn", json!({"id":id,"cwd":world.project,"cols":80,"rows":24,
        "command":"sh -c 'printf window-replay; sleep 60'"}));
    let output = common::agent::wait_until("window replay", || {
        let value = serve.control("runtime.pty.output", json!({"id":id}));
        let bytes = base64::engine::general_purpose::STANDARD.decode(value["data"].as_str().unwrap()).unwrap();
        bytes.ends_with(b"window-replay").then_some(bytes)
    });
    let sink = Arc::new(raccoon_lib::sink::BroadcastSink::new(16));
    let (events_tx, events_rx) = std::sync::mpsc::channel();
    sink.listen("pty_renamed", Box::new(move |event| { let _ = events_tx.send(event.to_owned()); }));
    let (closed_tx, closed_rx) = std::sync::mpsc::channel();
    for event in ["local_runtime_disconnected", "local_runtime_view_disconnected"] {
        let closed_tx = closed_tx.clone();
        sink.listen(event, Box::new(move |_| { let _ = closed_tx.send(()); }));
    }
    let desktop = Desktop::connect(Client::connect(&world.data).unwrap(), sink).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    desktop.attach("main", &id, "same-token", Box::new(move |bytes| tx.send(bytes.to_vec()).is_ok())).unwrap();
    let (tx2, rx2) = std::sync::mpsc::channel();
    desktop.attach("floating", &id, "same-token", Box::new(move |bytes| tx2.send(bytes.to_vec()).is_ok())).unwrap();
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), output);
    assert_eq!(rx2.recv_timeout(Duration::from_secs(5)).unwrap(), output);
    serve.control("runtime.pty.rename", json!({"id":id,"title":"Renamed once"}));
    assert!(events_rx.recv_timeout(Duration::from_secs(5)).unwrap().contains("Renamed once"));
    assert!(events_rx.recv_timeout(Duration::from_millis(200)).is_err(), "one owner event must not be published by each window");
    desktop.detach_window("main");
    common::agent::wait_until("only floating view remains", || {
        (serve.control("runtime.pty.stats", json!({}))["views"] == 1).then_some(())
    });
    // Identical view tokens in different windows cannot acknowledge each other.
    desktop.ack("main", &id, "same-token", output.len() as u64).unwrap();
    assert_eq!(serve.control("runtime.pty.stats", json!({}))["unackedBytes"], output.len());
    desktop.ack("floating", &id, "same-token", output.len() as u64).unwrap();
    common::agent::wait_until("floating acknowledgement", || {
        (serve.control("runtime.pty.stats", json!({}))["unackedBytes"] == 0).then_some(())
    });
    desktop.detach_window("floating");
    common::agent::wait_until("all views released", || {
        (serve.control("runtime.pty.stats", json!({}))["views"] == 0).then_some(())
    });
    assert_eq!(serve.control("runtime.pty.output", json!({"id":id}))["running"], true);
    assert!(desktop.sessions().is_ok(), "closing both views must retain the desktop control attachment");
    assert!(closed_rx.recv_timeout(Duration::from_millis(200)).is_err(), "intentional view detachment must not announce a lost runtime");
    desktop.stop_all().unwrap();
    stopped(&mut serve);
    common::agent::wait_until("desktop disconnect", || desktop.sessions().is_err().then_some(()));
}

#[test]
fn typed_terminal_adapter_preserves_input_resize_and_explicit_stop() {
    use raccoon_lib::local_runtime::{client::Client, terminals::Terminals};
    let world = AgentWorld::new();
    let mut serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:ready",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let id = format!("{}:9", created["sessionId"].as_str().unwrap());
    let client = Client::connect(&world.data).unwrap();
    let terminals = Terminals::new(client.clone());
    terminals.spawn(&id, world.project.to_str().unwrap(), 80, 24,
        Some("sh -c 'stty -echo; printf adapter-ready; IFS= read -r line; printf \"\\nreceived:%s\\n\" \"$line\"; stty size; sleep 60'"), Some("Adapter terminal")).unwrap();
    let read = || {
        let value = serve.control("runtime.pty.output", json!({"id":id}));
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(value["data"].as_str().unwrap()).unwrap()).unwrap()
    };
    common::agent::wait_until("terminal adapter readiness", || read().contains("adapter-ready").then_some(()));
    assert!(terminals.shells().unwrap().iter().any(|shell| shell.id == id && shell.title.as_deref() == Some("Adapter terminal")));
    terminals.resize(&id, 100, 30).unwrap();
    terminals.write(&id, b"typed input survives\n").unwrap();
    common::agent::wait_until("typed input and resize", || {
        let output = read();
        (output.contains("received:typed input survives") && output.contains("30 100")).then_some(())
    });
    assert_eq!(terminals.busy(std::slice::from_ref(&id)).unwrap().as_slice(), std::slice::from_ref(&id));
    terminals.rename(&id, "Renamed through owner").unwrap();
    assert!(terminals.shells().unwrap().iter().any(|shell| shell.id == id && shell.title.as_deref() == Some("Renamed through owner")));
    assert!(terminals.spawn("unknown-session:1", world.project.to_str().unwrap(), 80, 24, None, None).is_err());
    terminals.kill(&id).unwrap();
    common::agent::wait_until("explicit terminal stop", || {
        (!serve.control("runtime.pty.output", json!({"id":id}))["running"].as_bool().unwrap()).then_some(())
    });
    client.stop_all().unwrap();
    stopped(&mut serve);
    assert!(terminals.stats().is_err());
    assert!(terminals.shells().is_err());
}

#[test]
fn desktop_reconnect_revokes_old_views_without_replaying_or_replacing_the_owner() {
    use raccoon_lib::local_runtime::{client::Client, desktop::Desktop};
    use std::sync::Arc;
    let world = AgentWorld::new();
    let mut serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:once-before-reconnect",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let session = created["sessionId"].as_str().unwrap();
    let tab = created["tabId"].as_str().unwrap();
    serve.wait_events(tab, "initial turn completion", |events| count(events, "turn_completed") == 1);
    let client = Client::connect(&world.data).unwrap();
    let sink = Arc::new(raccoon_lib::sink::BroadcastSink::new(32));
    let previous = Desktop::connect(client.clone(), sink).unwrap();
    let old_attachment = previous.attachment().unwrap();
    let next = previous.reconnect(client.clone()).unwrap();
    assert_eq!(next.attachment().unwrap().epoch, old_attachment.epoch);
    assert_ne!(next.attachment().unwrap().lease, old_attachment.lease);
    assert!(previous.sessions().is_err(), "retained old handles must not pretend their view is still connected");
    common::agent::wait_until("old desktop lease revocation", || {
        client.call::<serde_json::Value>("runtime.heartbeat", serde_json::to_value(&old_attachment).unwrap()).is_err().then_some(())
    });
    let events: Vec<serde_json::Value> = next.sessions().unwrap().load_events(session, tab).unwrap().into_iter().map(|event| serde_json::to_value(event).unwrap()).collect();
    assert_eq!(texts(&events, "user_message"), ["echo:once-before-reconnect"]);
    assert_eq!(count(&events, "turn_completed"), 1);
    client.stop_all().unwrap();
    stopped(&mut serve);
    drop(serve);
    let replacement = Serve::start(world.command(), &world.data);
    assert!(next.reconnect(client.clone()).is_err(), "a pinned client must not follow a replacement owner or replay an earlier request");
    // Only discovery finds the replacement, and only a new attachment reaches it.
    let replaced = next.reconnect(Client::connect(&world.data).unwrap()).unwrap();
    let epoch = replacement.control("status", json!({}))["localRuntime"]["epoch"].clone();
    assert_ne!(epoch, old_attachment.epoch);
    assert_eq!(replaced.attachment().unwrap().epoch, epoch);
    assert!(replaced.generation() > next.generation());
}

#[test]
fn a_hung_owner_is_noticed_and_attaching_again_neither_replaces_it_nor_replays() {
    use raccoon_lib::local_runtime::{client::Client, desktop::{Desktop, Lost}};
    use std::sync::Arc;
    let world = AgentWorld::new();
    let mut serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:once-before-hang",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let session = created["sessionId"].as_str().unwrap();
    let tab = created["tabId"].as_str().unwrap();
    serve.wait_events(tab, "initial turn completion", |events| count(events, "turn_completed") == 1);
    let liveness = Duration::from_secs(2);
    let client = Client::connect(&world.data).unwrap().with_liveness(Duration::from_millis(250), liveness);
    let (lost_tx, lost_rx) = std::sync::mpsc::channel();
    let desktop = Desktop::connect_watched(client, Arc::new(raccoon_lib::sink::BroadcastSink::new(32)),
        Some(Arc::new(move |lost| { let _ = lost_tx.send(lost); }))).unwrap();
    // Pings keep a quiet, healthy connection open past its deadline.
    assert!(lost_rx.recv_timeout(liveness * 5 / 2).is_err(), "a healthy owner was taken for a hung one");
    let old = desktop.attachment().unwrap();
    let pid = serve.child.id().to_string();
    let signal = |name: &str| assert!(std::process::Command::new("kill").args([name, pid.as_str()]).status().unwrap().success());
    // A stopped owner keeps its sockets open: only the missing pongs show it.
    signal("-STOP");
    let lost = lost_rx.recv_timeout(liveness * 5);
    signal("-CONT");
    let Lost::Events { generation, reason } = lost.expect("a hung owner went unnoticed") else { panic!("the event connection was lost") };
    assert_eq!(generation, desktop.generation());
    assert_eq!(reason, "the background runtime sent nothing, not even a pong, for 2.0 s", "the log says why");
    assert!(desktop.sessions().is_err(), "a hung owner's attachment must not look connected");
    let next = desktop.reconnect(Client::connect(&world.data).unwrap()).unwrap();
    assert_eq!(next.attachment().unwrap().epoch, old.epoch, "an owner that answers again is attached to, not replaced");
    assert_ne!(next.attachment().unwrap().lease, old.lease);
    let events: Vec<serde_json::Value> = next.sessions().unwrap().load_events(session, tab).unwrap().into_iter().map(|event| serde_json::to_value(event).unwrap()).collect();
    assert_eq!(texts(&events, "user_message"), ["echo:once-before-hang"], "attaching again must not resend a prompt");
    assert_eq!(count(&events, "turn_completed"), 1);
    assert_eq!(serve.control("status", json!({}))["pid"], serve.child.id());
    assert!(lost_rx.try_recv().is_err(), "replacing an attachment on purpose is not a loss");
    next.stop_all().unwrap();
    stopped(&mut serve);
}

/// #716: a view whose window has all but stopped reading falls behind on its
/// own. Only that view is let go, and its window told to attach it again: the
/// connection stays up, the other window's output keeps coming, and the view
/// attached again starts from the pane's scrollback.
#[test]
fn a_window_view_that_stops_reading_is_let_go_alone_and_attached_again_on_the_same_connection() {
    use raccoon_lib::local_runtime::{client::Client, desktop::Desktop};
    use raccoon_lib::sink::EventSink;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    let world = AgentWorld::new();
    let mut serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:ready",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let session = created["sessionId"].as_str().unwrap();
    let (quiet, flood) = (format!("{session}:11"), format!("{session}:12"));
    serve.control("runtime.pty.spawn", json!({"id":quiet,"cwd":world.project,"cols":80,"rows":24,
        "command":"sh -c 'stty -echo; printf quiet-ready; exec cat'"}));
    let sink = Arc::new(raccoon_lib::sink::BroadcastSink::new(32));
    let (lagged_tx, lagged_rx) = std::sync::mpsc::channel();
    sink.listen("pty_view_lagged", Box::new(move |payload| { let _ = lagged_tx.send(payload.to_owned()); }));
    let (lost_tx, lost_rx) = std::sync::mpsc::channel();
    let desktop = Desktop::connect_watched(Client::connect(&world.data).unwrap(), sink,
        Some(Arc::new(move |lost| { let _ = lost_tx.send(lost); }))).unwrap();
    let text = |buffer: &Arc<Mutex<Vec<u8>>>| String::from_utf8_lossy(&buffer.lock().unwrap()).into_owned();
    type Tap = Box<dyn Fn(&[u8]) -> bool + Send>;
    let collect = |buffer: &Arc<Mutex<Vec<u8>>>| -> Tap {
        let buffer = buffer.clone();
        Box::new(move |bytes| { buffer.lock().unwrap().extend_from_slice(bytes); true })
    };
    let floating = Arc::new(Mutex::new(Vec::new()));
    desktop.attach("floating", &quiet, "floating-view", collect(&floating)).unwrap();
    common::agent::wait_until("the floating window's replay", || text(&floating).contains("quiet-ready").then_some(()));
    // The main window reads a piece every quarter of a second and never says
    // what it drew, while its pane prints as fast as it can.
    let slow = Arc::new(AtomicBool::new(true));
    let drawing = slow.clone();
    serve.control("runtime.pty.spawn", json!({"id":flood,"cwd":world.project,"cols":80,"rows":24,
        "command":"sh -c 'exec yes output-that-no-one-reads'"}));
    let main_quiet = Arc::new(Mutex::new(Vec::new()));
    desktop.attach("main", &quiet, "main-quiet", collect(&main_quiet)).unwrap();
    desktop.attach("main", &flood, "main-view", Box::new(move |_| {
        if drawing.load(Ordering::Relaxed) { std::thread::sleep(Duration::from_millis(250)); }
        true
    })).unwrap();
    let lagged = lagged_rx.recv_timeout(Duration::from_secs(90)).expect("the view that fell behind was never let go");
    slow.store(false, Ordering::Relaxed);
    assert_eq!(serde_json::from_str::<serde_json::Value>(&lagged).unwrap(), json!({"id":flood, "token":"main-view"}));
    assert!(lost_rx.recv_timeout(Duration::from_millis(500)).is_err(), "no connection was lost: {:?}", lost_rx.try_recv());
    assert_eq!(serve.control("runtime.pty.stats", json!({}))["views"], 2, "only the view that fell behind was let go");
    assert!(desktop.sessions().is_ok(), "the app-wide event connection is unaffected");
    // The other pane on the same connection, and the other window, keep receiving live output.
    desktop.terminals().unwrap().write(&quiet, b"still-live\n").unwrap();
    common::agent::wait_until("live output beside the view that fell behind", || text(&main_quiet).contains("still-live").then_some(()));
    common::agent::wait_until("live output in the healthy window", || text(&floating).contains("still-live").then_some(()));
    // Attached again over the same connection, the view starts from the pane's scrollback.
    let main = Arc::new(Mutex::new(Vec::new()));
    desktop.attach("main", &flood, "main-view-again", collect(&main)).unwrap();
    common::agent::wait_until("the main window's replay after it attached again", || text(&main).contains("output-that-no-one-reads").then_some(()));
    assert_eq!(desktop.renewed("main"), 0, "the window's connection was never replaced");
    assert!(lost_rx.try_recv().is_err());
    assert_eq!(serve.control("runtime.pty.output", json!({"id":flood}))["running"], true, "a view let go never stops its process");
    desktop.terminals().unwrap().kill(&flood).unwrap();
    desktop.stop_all().unwrap();
    stopped(&mut serve);
}

#[test]
fn closing_a_tab_stops_the_owner_and_retains_its_conversation() {
    use raccoon_lib::local_runtime::{client::Client, sessions::Sessions};
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"ask:echo close-owned-tab",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let session = created["sessionId"].as_str().unwrap();
    let tab = created["tabId"].as_str().unwrap();
    assert_eq!(serve.control("wait", json!({"target":tab,"timeoutSeconds":10}))["reason"], "permission");
    let sessions = Sessions::new(Client::connect(&world.data).unwrap());
    let before = sessions.load_events(session, tab).unwrap();
    assert!(!before.is_empty());
    let pane = sessions.pane_of(session, tab).unwrap().unwrap().pane_id;
    sessions.close_tab(session, tab).unwrap();
    assert!(sessions.ensure_started(session, tab).is_err(), "a late view must not recreate the closed agent");
    assert!(sessions.send(session, tab, "echo:must-not-reopen".into(), vec![]).is_err(), "a stale composer cannot reopen a closed tab");
    assert!(!serve.control("runtime.pty.output", json!({"id":pane}))["running"].as_bool().unwrap());
    assert!(sessions.pending_permissions().unwrap().iter().all(|pending| pending.tab_id != tab));
    let index: serde_json::Value = serde_json::from_slice(&std::fs::read(world.data.join("sessions/index.json")).unwrap()).unwrap();
    assert!(index["sessions"].as_array().unwrap().iter().find(|entry| entry["id"] == session).unwrap()["tabs"].as_array().unwrap().iter().all(|entry| entry["id"] != tab));
    assert!(index["closedTabs"].as_array().unwrap().iter().any(|entry| entry["sessionId"] == session && entry["tab"]["id"] == tab));
    let after = sessions.load_events(session, tab).unwrap();
    for event in before { assert!(after.iter().any(|retained| retained.id == event.id)); }
    let after_json = after.iter().map(|event| serde_json::to_value(event).unwrap()).collect::<Vec<_>>();
    assert_eq!(count(&after_json, "turn_completed"), 1);
}

#[test]
fn automation_commands_use_the_owner_and_preserve_disabled_pipeline_choices() {
    use raccoon_lib::local_runtime::{client::Client, sessions::Sessions};
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);
    let sessions = Sessions::new(Client::connect(&world.data).unwrap());
    let input = json!({
        "name":"Owner automation","enabled":false,"projectPath":world.project,
        "harness":"claude","mode":"manual","prompt":"echo:owner-manual-automation",
        "workspace":"newWorktree",
        "schedule":{"kind":"preset","preset":"hourly","minute":0,"timezone":"UTC","dtstart":"1970-01-01T00:00:00Z"},
        "pipeline":{"autoMerge":false,"resolveConflicts":false}
    });
    let created = sessions.save_automation(None, serde_json::from_value(input.clone()).unwrap()).unwrap();
    assert_eq!(sessions.automations().unwrap().len(), 1);
    let run = sessions.run_automation(&created.id).unwrap();
    let tab = run.tab_id.as_deref().unwrap();
    serve.wait_events(tab, "manual owner automation to finish", |events| count(events, "turn_completed") == 1);
    assert!(texts(&serve.events(tab), "assistant_text").iter().any(|text| text.contains("owner-manual-automation")));
    let runs = sessions.automation_runs(&created.id).unwrap();
    assert!(runs.iter().any(|saved| saved.run_id == run.run_id));
    let mut update = input;
    update["name"] = json!("Updated at owner");
    let updated = sessions.save_automation(Some(&created.id), serde_json::from_value(update).unwrap()).unwrap();
    assert_eq!(updated.name, "Updated at owner");
    assert_eq!(updated.pipeline.as_ref().map(|options| (options.auto_merge, options.resolve_conflicts)), Some((false, false)));
    let pipelines = std::fs::read_to_string(world.data.join("issue-pipelines.json")).ok()
        .map(|text| serde_json::from_str::<serde_json::Value>(&text).unwrap()).unwrap_or_else(|| json!({"pipelines":[]}));
    assert_eq!(pipelines["pipelines"], json!([]));
    sessions.delete_automation(&created.id).unwrap();
    assert!(sessions.automations().unwrap().is_empty());
}

#[test]
fn an_owner_hook_disconnect_withdraws_the_card_and_rejects_a_late_answer() {
    use std::os::unix::fs::PermissionsExt;
    let world = AgentWorld::new();
    let fake = std::fs::canonicalize(world.bin.join("claude")).unwrap();
    std::fs::remove_file(world.bin.join("claude")).unwrap();
    let captured = world.home.join("launch.json");
    // Only the disposable fixture launch is captured; never a user credential.
    let wrapper = format!("#!/usr/bin/python3\nimport os,json\nwith open({},'w') as f: json.dump({{k:os.environ[k] for k in ['RACCOON_HOOK_TOKEN','RACCOON_TAB_ID','RACCOON_SESSION_ID']}},f)\nos.execv({},[{}]+__import__('sys').argv[1:])\n",
        serde_json::to_string(&captured).unwrap(), serde_json::to_string(&fake).unwrap(), serde_json::to_string(&fake).unwrap());
    std::fs::write(world.bin.join("claude"), wrapper).unwrap();
    std::fs::set_permissions(world.bin.join("claude"), std::fs::Permissions::from_mode(0o700)).unwrap();
    let serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:ready",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let tab = created["tabId"].as_str().unwrap();
    serve.wait_events(tab, "initial turn completion", |events| count(events, "turn_completed") == 1);
    let launch: serde_json::Value = serde_json::from_slice(&std::fs::read(captured).unwrap()).unwrap();
    let mut hook = UnixStream::connect(&serve.socket).unwrap();
    let frame = json!({"session":launch["RACCOON_SESSION_ID"],"tab":launch["RACCOON_TAB_ID"],
        "token":launch["RACCOON_HOOK_TOKEN"],"event":"PermissionRequest",
        "payload":{"tool_name":"Bash","tool_input":{"command":"echo must-not-run"}}});
    writeln!(hook,"{frame}").unwrap();
    let pending = common::agent::wait_until("the connected hook card", || {
        let pending = serve.control("permissions.list", json!({}));
        (!pending["permissions"].as_array().unwrap().is_empty()).then_some(pending)
    });
    let request = pending["permissions"][0]["requestId"].clone();
    drop(hook);
    assert_eq!(serve.try_control("permissions.allow", json!({"request":request}))["ok"], false);
    common::agent::wait_until("the disconnected hook card to withdraw", || {
        serve.control("permissions.list", json!({}))["permissions"].as_array().unwrap().is_empty().then_some(())
    });
    assert!(!serve.events(tab).iter().any(|event| event["payload"]["type"] == "permission_decided" && event["payload"]["allowed"] == true));
}

#[test]
fn owner_hook_process_fails_closed_when_its_socket_disappears() {
    use std::process::{Child, Command, Stdio};
    use std::io::Read;
    struct HookChild(Child);
    impl Drop for HookChild {
        fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
    }
    let home = tempfile::tempdir().unwrap();
    for event in ["PermissionRequest", "PreToolUse"] {
        let socket = home.path().join(format!("{event}.sock"));
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_terminalx-serve"));
        command.args(["hook",event,"--local-owner-decision"])
            .env_clear().env("HOME",home.path()).env("TERMINALX_HOME",home.path())
            .env("CLAUDE_CONFIG_DIR",home.path()).env("RACCOON_HOOK_SOCKET",&socket)
            .env("RACCOON_TAB_ID","fixture").env("RACCOON_HOOK_TOKEN","fixture-only")
            // The desktop activation flag is inherited by real hook children.
            // An invalid application id makes any accidental AppKit path fail
            // before touching the host GUI; hooks must still answer with deny.
            .env("TERMINALX_LOCAL_DESKTOP","1").env("TERMINALX_LOCAL_APPLICATION",":invalid:")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = HookChild(command.spawn().unwrap());
        child.0.stdin.take().unwrap().write_all(b"{}\n").unwrap();
        listener.set_nonblocking(true).unwrap();
        let (connection,_) = common::agent::wait_until("hook connection", || match listener.accept() {
            Ok(connection) => Some(connection),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => None,
            Err(error) => panic!("hook fixture accept: {error}"),
        });
        connection.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut reader = BufReader::new(connection);
        let mut frame = String::new();
        reader.read_line(&mut frame).unwrap();
        drop(reader);
        drop(listener);
        let status = common::agent::wait_until("hook denial before exit", || child.0.try_wait().unwrap());
        assert!(status.success());
        let mut output = Vec::new();
        child.0.stdout.take().unwrap().take(1024 * 1024).read_to_end(&mut output).unwrap();
        let reply: serde_json::Value = serde_json::from_slice(&output).unwrap();
        let decision = &reply["hookSpecificOutput"];
        assert_eq!(if event == "PreToolUse" { &decision["permissionDecision"] } else { &decision["decision"]["behavior"] }, "deny");
    }
}

#[test]
fn resource_projection_and_stop_rules_are_checked_by_the_owner() {
    use raccoon_lib::local_runtime::{client::Client, sessions::Sessions};
    let world = AgentWorld::new();
    let mut serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:resource-owner",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let tab = created["tabId"].as_str().unwrap();
    serve.wait_events(tab, "resource owner turn", |events| count(events, "turn_completed") == 1);
    let sessions = Sessions::new(Client::connect(&world.data).unwrap());
    let pane = sessions.pane_of(created["sessionId"].as_str().unwrap(), tab).unwrap().unwrap().pane_id;
    assert_eq!(sessions.resource_overview().unwrap()["agentCount"], 1);
    let sample = sessions.resource_sample().unwrap();
    let process = sample["processes"].as_array().unwrap().iter().find(|entry| entry["paneId"] == pane).unwrap();
    assert_eq!(process["tabId"], tab);
    // An idle agent the app started can be stopped from App resources (#696):
    // asked first, then stopped as its tab's own Stop would, never by ending
    // its pane, so its conversation is kept and the note says why.
    assert_eq!(process["killRule"], "stop");
    let asked = sessions.resource_kill(&pane, false).unwrap();
    assert_eq!(asked["killed"], false);
    assert!(asked["confirmation"].as_str().is_some_and(|question| question.starts_with("Stop the agent in")), "{asked}");
    assert_eq!(sessions.resource_overview().unwrap()["agentCount"], 1, "asking stops nothing");
    assert_eq!(sessions.resource_kill(&pane, true).unwrap()["killed"], true);
    serve.wait_events(tab, "the stop's note in the conversation", |events| {
        events.iter().any(|event| event["payload"]["type"] == "status" && event["payload"]["text"].as_str().is_some_and(|text| text.starts_with("Stopped from App resources.")))
    });
    common::agent::wait_until("the agent stopped through its tab", || (sessions.resource_overview().unwrap()["agentCount"] == 0).then_some(()));
    let status = serve.control("status", json!({}));
    serve.control("runtime.stopAll", json!({"epoch":status["localRuntime"]["epoch"]}));
    stopped(&mut serve);
    assert!(sessions.resource_overview().is_err(), "a disconnected owner is not a zero-agent snapshot");
}

#[test]
fn stop_all_acknowledges_confirmed_terminal_group_exit() {
    let alive = |pid: u32| std::process::Command::new("/bin/kill").args(["-0", &pid.to_string()]).output().unwrap().status.success();
    let world = AgentWorld::new();
    let mut serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:stop-all",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let tab = created["tabId"].as_str().unwrap();
    serve.wait_events(tab, "stop-all fixture turn", |events| count(events, "turn_completed") == 1);
    let pane = format!("{}:9",created["sessionId"].as_str().unwrap());
    serve.control("runtime.pty.spawn", json!({"id":pane,"cwd":world.project,"cols":80,"rows":24,
        "command":"sh -c 'trap \"\" TERM; sleep 60 & echo $! > child.pid; wait'"}));
    let parent = serve.control("runtime.pty.output",json!({"id":pane}))["pid"].as_u64().unwrap() as u32;
    let child: u32 = common::agent::wait_until("the terminal child to start", || {
        std::fs::read_to_string(world.project.join("child.pid")).ok().and_then(|text| text.trim().parse().ok())
    });
    assert!(alive(parent));
    assert!(alive(child));
    let status = serve.control("status",json!({}));
    serve.control("runtime.stopAll",json!({"epoch":status["localRuntime"]["epoch"]}));
    assert!(!alive(parent), "an acknowledgement cannot precede process exit");
    assert!(!alive(child), "the terminal child must be stopped too");
    stopped(&mut serve);
}

#[test]
fn an_idle_managed_cli_exits_and_its_terminal_tail_survives_the_next_owner() {
    use raccoon_lib::local_runtime::{client::Client, sessions::Sessions};
    let world = AgentWorld::new();
    let mut command = world.command();
    command.args(["--idle-grace-seconds","1"]);
    let mut serve = Serve::start(command, &world.data);
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:retained-before-idle",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let session = created["sessionId"].as_str().unwrap();
    let tab = created["tabId"].as_str().unwrap();
    serve.wait_events(tab, "idle fixture turn", |events| count(events, "turn_completed") == 1);
    let sessions = Sessions::new(Client::connect(&world.data).unwrap());
    let pane = sessions.pane_of(session,tab).unwrap().unwrap().pane_id;
    let before = serve.control("runtime.pty.output",json!({"id":pane}));
    assert_eq!(before["running"],true);
    stopped(&mut serve);
    assert!(world.data.join("run/pty-history.json").is_file());
    let replacement = Serve::start(world.command(), &world.data);
    let after = replacement.control("runtime.pty.output",json!({"id":pane}));
    assert_eq!(after["data"],before["data"]);
    assert_eq!(after["running"],false);
    assert!(after["pid"].is_null());
    assert!(!world.data.join("run/pty-history.json").exists(),"an old snapshot cannot resurrect a subsequently closed pane");
    let sessions = Sessions::new(Client::connect(&world.data).unwrap());
    let events = sessions.load_events(session,tab).unwrap();
    let serialized = serde_json::to_value(&events).unwrap().to_string();
    assert!(!serialized.contains("Session closed"));
    sessions.ensure_started(session,tab).unwrap();
    let resumed = replacement.control("runtime.pty.output",json!({"id":pane}));
    let original = base64::engine::general_purpose::STANDARD.decode(before["data"].as_str().unwrap()).unwrap();
    let bytes = base64::engine::general_purpose::STANDARD.decode(resumed["data"].as_str().unwrap()).unwrap();
    assert!(bytes.starts_with(&original),"resuming a CLI must retain its prior terminal output");
    assert_eq!(resumed["running"],true);
}

#[test]
fn an_open_plain_shell_keeps_its_environment_across_detached_idle_grace() {
    let world = AgentWorld::new();
    let mut command = world.command();
    command.args(["--idle-grace-seconds", "1"]);
    let mut serve = Serve::start(command, &world.data);
    let attachment = serve.control("runtime.attach", json!({"protocol":1}));
    let created = serve.control("sessions.create", json!({
        "project":world.project,"agent":"claude","prompt":"echo:shell-owner",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let tab = created["tabId"].as_str().unwrap();
    serve.wait_events(tab,"shell owner ready",|events| count(events,"turn_completed")==1);
    let pane = format!("{}:retained-shell",created["sessionId"].as_str().unwrap());
    serve.control("runtime.pty.spawn",json!({"id":pane,"cwd":world.project,"cols":80,"rows":24}));
    let input = base64::engine::general_purpose::STANDARD.encode(b"export TERMINALX_FIXTURE_RETAINED=still-here\n");
    serve.control("runtime.pty.write",json!({"id":pane,"data":input}));
    let pid = serve.control("runtime.pty.output",json!({"id":pane}))["pid"].clone();
    serve.control("runtime.detach",attachment);
    std::thread::sleep(Duration::from_secs(2));
    assert!(serve.child.try_wait().unwrap().is_none());
    let attached = serve.control("runtime.attach",json!({"protocol":1}));
    let input = base64::engine::general_purpose::STANDARD.encode(b"printf 'fixture-state:%s:end\\n' \"$TERMINALX_FIXTURE_RETAINED\"\n");
    serve.control("runtime.pty.write",json!({"id":pane,"data":input}));
    let until = Instant::now()+Duration::from_secs(5);
    loop {
        let output = serve.control("runtime.pty.output",json!({"id":pane}));
        assert_eq!(output["pid"],pid);
        assert_eq!(output["running"],true);
        let bytes = base64::engine::general_purpose::STANDARD.decode(output["data"].as_str().unwrap()).unwrap();
        if String::from_utf8_lossy(&bytes).contains("fixture-state:still-here:end") { break; }
        assert!(Instant::now()<until,"shell environment was not retained");
        std::thread::sleep(Duration::from_millis(20));
    }
    serve.control("runtime.stopAll",json!({"epoch":attached["epoch"]}));
    stopped(&mut serve);
}

#[test]
fn deleting_a_session_stops_only_its_owner_processes_and_rejects_stale_views() {
    use raccoon_lib::local_runtime::{client::Client, sessions::Sessions};
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create",json!({
        "project":world.project,"agent":"claude","prompt":"ask:echo deleted-session",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let other = serve.control("sessions.create",json!({
        "project":world.project,"agent":"claude","prompt":"ask:echo retained-session",
        "useWorktree":false,"onMain":true,"mode":"manual"
    }));
    let session = created["sessionId"].as_str().unwrap();
    let tab = created["tabId"].as_str().unwrap();
    let other_tab = other["tabId"].as_str().unwrap();
    for target in [tab,other_tab] {
        assert_eq!(serve.control("wait",json!({"target":target,"timeoutSeconds":10}))["reason"],"permission");
    }
    let sessions = Sessions::new(Client::connect(&world.data).unwrap());
    let agent = sessions.pane_of(session,tab).unwrap().unwrap().pane_id;
    let shell = format!("{session}:delete-shell");
    serve.control("runtime.pty.spawn",json!({"id":shell,"cwd":world.project,"cols":80,"rows":24,"command":"sleep 60"}));
    let pids: Vec<_> = [&agent,&shell].iter().map(|id| serve.control("runtime.pty.output",json!({"id":id}))["pid"].as_u64().unwrap()).collect();
    sessions.delete_session(session).unwrap();
    for pid in pids {
        assert!(!std::process::Command::new("/bin/kill").args(["-0",&pid.to_string()])
            .stderr(std::process::Stdio::null()).status().unwrap().success(),"deletion acknowledged before child exit");
    }
    assert!(sessions.ensure_started(session,tab).is_err());
    assert!(sessions.send(session,tab,"echo:stale".into(),vec![]).is_err());
    let pending = sessions.pending_permissions().unwrap();
    assert!(pending.iter().all(|ask| ask.tab_id != tab));
    assert!(pending.iter().any(|ask| ask.tab_id == other_tab));
    let index: serde_json::Value = serde_json::from_slice(&std::fs::read(world.data.join("sessions/index.json")).unwrap()).unwrap();
    assert!(index["sessions"].as_array().unwrap().iter().all(|entry| entry["id"] != session));
    assert!(index["sessions"].as_array().unwrap().iter().any(|entry| entry["id"] == other["sessionId"]));
    assert!(world.project.join("README.md").is_file(),"deleting a conversation must not delete its workspace");
}

#[test]
fn owner_relocation_stops_the_agent_but_preserves_the_readers_shell_and_worktree() {
    use raccoon_lib::local_runtime::{client::Client, sessions::Sessions};
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create",json!({
        "project":world.project,"agent":"claude","prompt":"ask:echo moving-agent",
        "useWorktree":true,"mode":"manual"
    }));
    let session = created["sessionId"].as_str().unwrap();
    let tab = created["tabId"].as_str().unwrap();
    assert_eq!(serve.control("wait",json!({"target":tab,"timeoutSeconds":10}))["reason"],"permission");
    let index: serde_json::Value = serde_json::from_slice(&std::fs::read(world.data.join("sessions/index.json")).unwrap()).unwrap();
    let cwd = index["sessions"].as_array().unwrap().iter().find(|entry| entry["id"] == session).unwrap()["cwd"].as_str().unwrap().to_string();
    let sessions = Sessions::new(Client::connect(&world.data).unwrap());
    let agent = sessions.pane_of(session,tab).unwrap().unwrap().pane_id;
    let shell = format!("{session}:keep-shell");
    serve.control("runtime.pty.spawn",json!({"id":shell,"cwd":cwd,"cols":80,"rows":24}));
    let pid = serve.control("runtime.pty.output",json!({"id":shell}))["pid"].clone();
    let moved: serde_json::Value = sessions.workspace("relocate",json!({"sessionId":session})).unwrap();
    assert_eq!(std::path::Path::new(moved["cwd"].as_str().unwrap()),world.project.as_path());
    assert!(moved["worktreeName"].is_null());
    assert!(std::path::Path::new(&cwd).join("README.md").is_file());
    assert_eq!(serve.control("runtime.pty.output",json!({"id":agent}))["running"],false);
    let kept = serve.control("runtime.pty.output",json!({"id":shell}));
    assert_eq!(kept["pid"],pid);
    assert_eq!(kept["running"],true);
    assert!(sessions.pending_permissions().unwrap().is_empty());
    sessions.ensure_started(session,tab).unwrap();
    assert_eq!(serve.control("runtime.pty.output",json!({"id":agent}))["running"],true);
}

#[test]
fn cli_workspace_deletion_confirms_owner_processes_and_keeps_the_project() {
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create",json!({
        "project":world.project,"agent":"claude","prompt":"ask:echo removed-workspace",
        "useWorktree":true,"mode":"manual"
    }));
    let session = created["sessionId"].as_str().unwrap();
    let tab = created["tabId"].as_str().unwrap();
    assert_eq!(serve.control("wait",json!({"target":tab,"timeoutSeconds":10}))["reason"],"permission");
    let index: serde_json::Value = serde_json::from_slice(&std::fs::read(world.data.join("sessions/index.json")).unwrap()).unwrap();
    let cwd = index["sessions"].as_array().unwrap().iter().find(|entry| entry["id"] == session).unwrap()["cwd"].as_str().unwrap().to_string();
    let shell = format!("{session}:cleanup-shell");
    serve.control("runtime.pty.spawn",json!({"id":shell,"cwd":cwd,"cols":80,"rows":24,"command":"sleep 60"}));
    let pid = serve.control("runtime.pty.output",json!({"id":shell}))["pid"].as_u64().unwrap();
    // Without --yes it says what would go, running agent and shell included (#719).
    let refused = serve.try_control("worktrees.delete",json!({"project":world.project,"worktree":cwd,"force":true}));
    assert_eq!((&refused["ok"],&refused["error"]["code"]),(&json!(false),&json!("confirmation_required")));
    let message = refused["error"]["message"].as_str().unwrap();
    assert!(message.contains(session) && message.contains("still running, would be stopped: claude tab") && message.contains("1 shell"),"{message}");
    let preview = serve.control("worktrees.delete",json!({"project":world.project,"worktree":cwd,"dryRun":true}));
    assert_eq!((&preview["sessions"][0]["id"],&preview["sessions"][0]["runningTabs"][0]["id"],&preview["sessions"][0]["runningShells"]),(&json!(session),&json!(tab),&json!(1)));
    assert!(std::path::Path::new(&cwd).is_dir(),"missing confirmation must leave the worktree alone");
    assert_eq!(serve.control("runtime.pty.output",json!({"id":shell}))["running"],true,"a preview stops nothing");
    let deleted = serve.control("worktrees.delete",json!({"project":world.project,"worktree":cwd,"force":true,"confirmed":true,"sessions":[session]}));
    assert_eq!(deleted["deleted"],cwd);
    assert_eq!((&deleted["removedSessions"][0]["id"],&deleted["removedSessions"][0]["belongsTo"]),(&json!(session),&json!("thisProject")));
    assert!(!std::path::Path::new(&cwd).exists());
    assert!(!std::process::Command::new("/bin/kill").args(["-0",&pid.to_string()])
        .stderr(std::process::Stdio::null()).status().unwrap().success());
    assert!(world.project.join("README.md").is_file());
    assert!(serve.control("permissions.list",json!({}))["permissions"].as_array().unwrap().is_empty());
}

#[test]
fn window_services_follow_only_the_registered_live_owner_attachment() {
    use std::os::unix::{net::UnixListener, fs::PermissionsExt};
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);
    let endpoint = world.data.join("run/window-test.sock");
    let listener = UnixListener::bind(&endpoint).unwrap();
    std::fs::set_permissions(&endpoint,std::fs::Permissions::from_mode(0o600)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let token = "d".repeat(64);
    let expected = token.clone();
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let seen = calls.clone();
    let responder = std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            match listener.accept() {
                Ok((mut socket,_)) => {
                    socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    let mut line = String::new();
                    BufReader::new(socket.try_clone().unwrap()).read_line(&mut line).unwrap();
                    let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                    assert_eq!(request["token"],expected);
                    assert_eq!(request["command"],"window.dispatch");
                    assert_eq!(request["params"]["command"],"computer.listApps");
                    seen.fetch_add(1,std::sync::atomic::Ordering::SeqCst);
                    writeln!(socket,"{}",json!({"id":request["id"],"ok":true,"result":{"servedBy":"private-window"}})).unwrap();
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < until,"owner did not dispatch to the private window");
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => panic!("private window accept: {error}"),
            }
        }
    });
    let attachment = serve.control("runtime.attach",json!({"protocol":1}));
    let mut registration = json!({"epoch":attachment["epoch"],"lease":attachment["lease"],"socket":endpoint,"token":token});
    registration["epoch"] = json!("wrong-owner");
    assert_eq!(serve.try_control("runtime.window.register",registration.clone())["ok"],false);
    registration["epoch"] = attachment["epoch"].clone();
    serve.control("runtime.window.register",registration.clone());
    let published = std::fs::read(world.data.join("run/control.token")).unwrap();
    assert_eq!(published,serve.token.as_bytes());
    assert_eq!(serve.control("computer.listApps",json!({}))["servedBy"],"private-window");
    responder.join().unwrap();
    serve.control("runtime.detach",attachment);
    assert_eq!(serve.try_control("computer.listApps",json!({}))["error"]["code"],"desktop_unavailable");
    assert_eq!(serve.try_control("runtime.window.register",registration)["ok"],false);
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst),1);
    assert_eq!(std::fs::read(world.data.join("run/control.token")).unwrap(),published);
}

#[test]
fn window_publication_precedes_dispatch_and_failed_activation_revokes_the_view() {
    let world = AgentWorld::new();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "window_publication_process_fixture", "--nocapture"])
        .env("TERMINALX_467_PUBLICATION_FIXTURE", "1")
        .env("TERMINALX_HOME", &world.data)
        .env("CLAUDE_CONFIG_DIR", world.home.join(".claude"))
        .output().unwrap();
    assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
}

#[test]
fn window_publication_process_fixture() {
    if std::env::var("TERMINALX_467_PUBLICATION_FIXTURE").as_deref() != Ok("1") { return; }
    use raccoon_lib::local_runtime::{client::{Client, AttachmentIdentity}, desktop::Desktop};
    use std::sync::{Arc, Mutex};
    use std::os::unix::{net::UnixListener, fs::PermissionsExt};
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);
    let client = Client::connect(&world.data).unwrap();
    let mut endpoint = raccoon_lib::hooks::prepare_control().unwrap();
    endpoint.socket = world.data.join("run/window-publication.sock");
    let listener = UnixListener::bind(&endpoint.socket).unwrap();
    std::fs::set_permissions(&endpoint.socket,std::fs::Permissions::from_mode(0o600)).unwrap();
    listener.set_nonblocking(true).unwrap();
    let current: Arc<Mutex<Option<AttachmentIdentity>>> = Arc::new(Mutex::new(None));
    let observed = current.clone();
    let token = endpoint.token.clone();
    let responder = std::thread::spawn(move || {
        let until = Instant::now() + Duration::from_secs(15);
        let mut calls = 0;
        while calls < 2 {
            match listener.accept() {
                Ok((mut socket,_)) => {
                    socket.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                    let mut line = String::new();
                    BufReader::new(socket.try_clone().unwrap()).read_line(&mut line).unwrap();
                    let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                    let identity = observed.lock().unwrap().clone().expect("owner dispatched before attachment publication");
                    assert_eq!(request["token"],token);
                    assert_eq!(request["command"],"window.dispatch");
                    assert_eq!(request["params"]["epoch"],identity.epoch);
                    assert_eq!(request["params"]["lease"],identity.lease);
                    assert_eq!(request["params"]["command"],"floating.show");
                    calls += 1;
                    writeln!(socket,"{}",json!({"id":request["id"],"ok":true,"result":{"delivered":calls}})).unwrap();
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < until,"window request was lost");
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(error) => panic!("window accept: {error}"),
            }
        }
    });
    let first = Arc::new(Desktop::connect(client.clone(),Arc::new(raccoon_lib::sink::BroadcastSink::new(32))).unwrap());
    let publish = |next: &Arc<Desktop>| -> anyhow::Result<()> {
        // A live caller must not reach the endpoint while its validator still
        // has no identity (or the previous identity during reconnection).
        assert_eq!(serve.try_control("floating.show",json!({}))["error"]["code"],"desktop_unavailable");
        *current.lock().unwrap() = Some(next.attachment()?);
        Ok(())
    };
    first.activate_window(endpoint.clone(),publish).unwrap();
    assert_eq!(serve.control("floating.show",json!({}))["delivered"],1);
    let old = first.attachment().unwrap();
    let next = Arc::new(first.reconnect(client.clone()).unwrap());
    assert_eq!(serve.try_control("runtime.heartbeat",serde_json::to_value(&old).unwrap())["ok"],false,
        "reconnect returned before revoking its old owner lease");
    assert!(first.attachment().is_err());
    next.activate_window(endpoint.clone(),publish).unwrap();
    assert_eq!(serve.control("floating.show",json!({}))["delivered"],2);
    responder.join().unwrap();
    let old = next.attachment().unwrap();
    let failed = Arc::new(next.reconnect(client.clone()).unwrap());
    assert_eq!(serve.try_control("runtime.heartbeat",serde_json::to_value(&old).unwrap())["ok"],false,
        "reconnect returned before revoking its old owner lease");
    endpoint.token = "invalid-registration".into();
    assert!(failed.activate_window(endpoint,publish).is_err());
    assert!(failed.attachment().is_err(),"failed registration left a valid view");
    assert_eq!(serve.try_control("floating.show",json!({}))["error"]["code"],"desktop_unavailable");
    assert_eq!(serve.control("status",json!({}))["pid"],serve.child.id(),"activation failure must not stop the owner");
}

#[test]
fn stop_all_reaps_terminal_descendants_after_the_leader_and_output_exit() {
    let alive = |pid: u32| std::process::Command::new("/bin/kill").args(["-0", &pid.to_string()]).output().unwrap().status.success();
    let world = AgentWorld::new();
    let mut command = world.command();
    command.args(["--idle-grace-seconds", "1"]);
    let mut serve = Serve::start(command, &world.data);
    let attachment = serve.control("runtime.attach", json!({"protocol":1}));
    let created = serve.control("sessions.create", json!({"project":world.project,"agent":"claude","prompt":"echo:orphan-group","useWorktree":false,"onMain":true,"mode":"manual"}));
    serve.wait_events(created["tabId"].as_str().unwrap(), "fixture ready", |events| count(events, "turn_completed") == 1);
    // Python fork preserves the PTY launch group. Close all inherited PTY
    // descriptors so output EOF cannot disguise the exited leader as live.
    std::fs::write(world.project.join("fork.py"), r#"import os,signal,time
signal.signal(signal.SIGHUP,signal.SIG_IGN)
signal.signal(signal.SIGTERM,signal.SIG_IGN)
pid=os.fork()
if pid:
    open('orphan.pid','w').write(str(pid))
    os._exit(0)
for fd in range(3):
    os.close(fd)
time.sleep(120)
"#).unwrap();
    let pane = format!("{}:orphan", created["sessionId"].as_str().unwrap());
    serve.control("runtime.pty.spawn", json!({"id":pane,"cwd":world.project,"cols":80,"rows":24,"command":"python3 fork.py"}));
    let child: u32 = common::agent::wait_until("forked descendant", || std::fs::read_to_string(world.project.join("orphan.pid")).ok().and_then(|value|value.parse().ok()));
    struct Cleanup(u32);
    impl Drop for Cleanup { fn drop(&mut self) { let _ = std::process::Command::new("/bin/kill").args(["-KILL",&self.0.to_string()]).output(); } }
    let _cleanup = Cleanup(child);
    common::agent::wait_until("exited leader and closed output", || {
        let pane = serve.control("runtime.pty.output",json!({"id":pane}));
        (pane["running"] == false && !alive(pane["pid"].as_u64().unwrap() as u32)).then_some(())
    });
    assert!(alive(child));
    serve.control("runtime.detach", attachment);
    std::thread::sleep(Duration::from_secs(2));
    assert!(serve.child.try_wait().unwrap().is_none(), "orphaned terminal work must prevent idle exit");
    assert!(alive(child));
    let status = serve.control("status",json!({}));
    serve.control("runtime.stopAll",json!({"epoch":status["localRuntime"]["epoch"]}));
    assert!(!alive(child), "Stop all acknowledged while the exited leader's descendant survived");
    stopped(&mut serve);
}

#[test]
fn history_larger_than_an_ipc_frame_loads_including_a_single_oversized_event() {
    use raccoon_lib::local_runtime::{client::Client, sessions::Sessions};
    let world = AgentWorld::new();
    let mut serve = Serve::start(world.command(), &world.data);
    let created = serve.control("sessions.create", json!({"project":world.project,"agent":"claude","prompt":"echo:large-history","useWorktree":false,"onMain":true,"mode":"manual"}));
    let session = created["sessionId"].as_str().unwrap(); let tab = created["tabId"].as_str().unwrap();
    serve.wait_events(tab,"fixture settled",|events|count(events,"turn_completed")==1);
    let client = Client::connect(&world.data).unwrap(); let sessions = Sessions::new(client.clone());
    let baseline = sessions.load_events(session,tab).unwrap();
    let mut event = serde_json::to_value(&baseline[0]).unwrap();
    event["seq"] = json!(baseline.iter().map(|event|event.seq).max().unwrap()+1);
    event["id"] = json!("oversized-event");
    event["payload"] = json!({"type":"user_message","text":"é".repeat(17*1024*1024),"queued":false});
    let log = world.data.join("sessions").join(session).join(format!("{tab}.jsonl"));
    let mut file = std::fs::OpenOptions::new().append(true).open(log).unwrap();
    serde_json::to_writer(&mut file,&event).unwrap(); writeln!(file).unwrap(); file.flush().unwrap();
    let loaded = sessions.load_events(session,tab).unwrap();
    assert_eq!(loaded.len(),baseline.len()+1);
    assert_eq!(serde_json::to_value(loaded.last().unwrap()).unwrap(),event);
    assert_eq!(&loaded[..baseline.len()],baseline.as_slice());
    // Chunk framing is bounded independently of the single oversized event.
    let opened: serde_json::Value = client.call("runtime.session.eventsOpen",json!({"sessionId":session,"tabId":tab})).unwrap();
    let bad: anyhow::Result<serde_json::Value> = client.call("runtime.session.eventsChunk",json!({"sessionId":"wrong-session","tabId":tab,"token":opened["token"],"offset":0}));
    assert!(bad.is_err());
    let mut appended = event.clone();
    appended["id"] = json!("later-event");
    appended["seq"] = json!(event["seq"].as_u64().unwrap()+1);
    appended["payload"]["text"] = json!("appended after snapshot opened");
    serde_json::to_writer(&mut file,&appended).unwrap(); writeln!(file).unwrap(); file.flush().unwrap();
    let mut snapshot = Vec::new();
    while (snapshot.len() as u64) < opened["size"].as_u64().unwrap() {
        let chunk: serde_json::Value = client.call("runtime.session.eventsChunk",json!({"sessionId":session,"tabId":tab,"token":opened["token"],"offset":snapshot.len()})).unwrap();
        assert_eq!(chunk["offset"].as_u64().unwrap(),snapshot.len() as u64);
        assert!(serde_json::to_vec(&chunk).unwrap().len()<512*1024);
        let data = base64::engine::general_purpose::STANDARD.decode(chunk["data"].as_str().unwrap()).unwrap();
        assert!(!data.is_empty());
        snapshot.extend(data);
    }
    assert_eq!(serde_json::from_slice::<serde_json::Value>(&snapshot).unwrap(),serde_json::to_value(&loaded).unwrap());
    let _: serde_json::Value = client.call("runtime.session.eventsClose",json!({"sessionId":session,"tabId":tab,"token":opened["token"]})).unwrap();
    let next = sessions.load_events(session,tab).unwrap();
    assert_eq!(&next[..loaded.len()],loaded.as_slice());
    assert_eq!(serde_json::to_value(next.last().unwrap()).unwrap(),appended);
    client.stop_all().unwrap(); stopped(&mut serve);
}

#[cfg(target_os = "linux")]
#[test]
fn linux_desktop_attaches_to_a_local_owner_without_a_macos_tray() {
    let world = AgentWorld::new();
    let mut serve = Serve::start(world.command(), &world.data);
    let client = raccoon_lib::local_runtime::launch::connect_desktop(std::path::Path::new("unused-existing-owner"), &world.data,"com.terminalx.fixture",None).unwrap();
    let status: serde_json::Value = client.call("status",json!({})).unwrap();
    assert_eq!(status["localRuntime"]["nativeTray"],false);
    client.stop_all().unwrap(); stopped(&mut serve);
}
