//! Two machines end to end (PRO-358): the operating computer's own code (the
//! desktop's pairing client and `MachineSupervisor`) against two real
//! runtimes in their own processes, "Mac mini" (a second runtime on this
//! host, approved in its window) and "dev-server" (a headless runtime in a
//! Linux container, paired from its terminal), with "this Mac" (the operating
//! computer's own runtime, hosting off) beside them. `common/world.rs` starts
//! them; `scripts/machine-e2e/run.py` builds the container image and runs
//! this in CI (job `machines-e2e`).
//!
//! Two assertions guard what `scripts/machine-e2e/breaks/` breaks on
//! purpose, and their messages say so, so the scheduled break check
//! (`.github/workflows/machines-e2e-breaks.yml`) knows the right one failed:
//! - [`PAIRING_BROKEN`]: a used code replayed from another computer, and a
//!   paired token sent with another client key, are refused
//!   (`MachineHost::paired_with_key`, rule 2 of "As built (PRO-342)").
//! - [`SCOPING_BROKEN`]: another machine's `projectId` is not served
//!   (`remote::machine::Projects::get`, "Project scoping").
//!
//! The Linux scenarios need `TERMINALX_E2E_LINUX_IMAGE`; with
//! `TERMINALX_E2E_REQUIRE_LINUX=1` (CI) a missing image fails the test.
//! Previous-release compatibility is the `machine-compat` job
//! (`tests/machine_compat.rs`, PRO-354), not this.
#![cfg(unix)]

mod common;

use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use common::machine::{connect, Outcome};
use common::world::{count, linux_image, pair_with, project_id, summary, texts, DevServer, Kept, Link, MacMini, Terminal, ThisMac, OPERATOR_KEY, OPERATOR_LABEL, OTHER_KEY, THIRD_KEY};
use raccoon_lib::machine_wire::MachineCode;
use raccoon_lib::remote::machine_client::MachineConnectionState;
use serde_json::{json, Value};

/// In the message of every assertion the pairing-check break must fail.
const PAIRING_BROKEN: &str = "PAIRING CHECK BROKEN";
/// In the message of every assertion the project-scoping break must fail.
const SCOPING_BROKEN: &str = "PROJECT SCOPING BROKEN";

const COMMIT_AUTHOR: (&str, &str) = ("E2E Tester", "e2e@example.com");

/// A machine's own disk, read there: Mac mini's on this host, dev-server's
/// inside its container.
trait Disk {
    fn git(&self, project: &Path, args: &[&str]) -> String;
    fn read(&self, path: &Path) -> String;
}

impl Disk for MacMini {
    fn git(&self, project: &Path, args: &[&str]) -> String {
        MacMini::git(self, project, args)
    }
    fn read(&self, path: &Path) -> String {
        MacMini::read(self, path)
    }
}

impl Disk for DevServer {
    fn git(&self, project: &Path, args: &[&str]) -> String {
        DevServer::git(self, project, args)
    }
    fn read(&self, path: &Path) -> String {
        DevServer::read(self, path)
    }
}

/// What the scenarios expect of one machine.
struct Machine<'a> {
    name: &'static str,
    /// A short tag for ids and markers.
    tag: &'static str,
    family: &'static str,
    has_window: bool,
    projects: Vec<PathBuf>,
    /// A file outside its first project, relative to that project.
    outside: &'static str,
    disk: &'a dyn Disk,
}

/// A project of another machine, which this one must not serve.
struct Foreign {
    machine: &'static str,
    id: String,
    path: PathBuf,
}

/// The family `machine.describe` gives the host these tests run on.
fn host_family() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

/// A call that must be refused with `code`; `why` heads the failure.
async fn refuse(link: &mut Link, method: &str, params: Value, code: &str, why: &str) {
    let response = link.call(method, params.clone()).await;
    assert!(response["ok"] != true && response["error"]["code"] == code, "{why}: {}: {method} {params} answered {response}, not the refusal {code}", link.name);
}

// ---------------------------------------------------------------- pairing

/// Pair with Mac mini by a code its window made, and Allow there. The code
/// and the paired computer's id.
async fn pair_mac_mini(mini: &MacMini) -> (MachineCode, String) {
    pair_mac_mini_with(mini, mini.create_code()).await
}

/// [`pair_mac_mini`] with a code already made.
async fn pair_mac_mini_with(mini: &MacMini, code: MachineCode) -> (MachineCode, String) {
    assert_eq!(code.machine.name, "Mac mini", "the code names the machine");
    let pairing = {
        let (code, endpoint) = (code.clone(), mini.endpoint());
        tokio::spawn(async move { pair_with(&code, &endpoint, OPERATOR_KEY).await })
    };
    let pending = mini.pending();
    assert_eq!(pending["label"], OPERATOR_LABEL, "Mac mini's window names the asking computer: {pending}");
    assert!(pending["fingerprint"].as_str().is_some_and(|fingerprint| !fingerprint.is_empty()), "and shows the fingerprint: {pending}");
    mini.approve(pending["requestId"].as_str().expect("the request has an id"));
    let described = pairing.await.unwrap().unwrap_or_else(|failure| panic!("Mac mini refused the pairing it allowed: {failure:?}"));
    let described = described.expect("Mac mini described itself after Allow");
    assert_eq!(described.machine_id, code.machine.machine_id);
    assert_eq!(described.name, "Mac mini");
    let computers = mini.computers();
    assert_eq!(computers.len(), 1, "one paired computer on Mac mini: {computers:?}");
    assert_eq!(computers[0]["label"], OPERATOR_LABEL, "{computers:?}");
    let id = computers[0]["id"].as_str().expect("the paired computer has an id").to_string();
    (code, id)
}

/// Start `terminalx-serve pair` on the dev-server; the first time it asks
/// to turn hosting on and is answered `y`. The terminal and its code.
fn start_pair_on_dev_server(dev: &DevServer, hosting_on: bool) -> (Terminal, MachineCode) {
    let mut terminal = dev.pair_in_terminal();
    if !hosting_on {
        terminal.wait_for("Let other computers operate this server? [y/N]");
        terminal.type_line("y");
    }
    let code = terminal.code();
    assert_eq!(code.machine.name, "dev-server", "the code names the server by its host name");
    assert_eq!(code.machine.os.family, "linux");
    (terminal, code)
}

/// The person at the dev-server's terminal answers the computer that asks.
async fn answer_on_dev_server(terminal: &mut Terminal, code: &MachineCode, endpoint: &str, key: [u8; 32], answer: &str) -> Result<(), raccoon_lib::machine_pair::Failure> {
    let pairing = {
        let (code, endpoint) = (code.clone(), endpoint.to_string());
        tokio::spawn(async move { pair_with(&code, &endpoint, key).await })
    };
    let screen = terminal.wait_for("Allow? [y/N]");
    assert!(screen.contains(&format!("{OPERATOR_LABEL} asks to operate this server")), "the server names the asking computer:\n{screen}");
    terminal.type_line(answer);
    pairing.await.unwrap().map(|described| {
        let described = described.expect("the dev-server described itself after Allow");
        assert_eq!(described.machine_id, code.machine.machine_id);
        assert_eq!(described.name, "dev-server");
    })
}

/// Pair with the dev-server from its terminal, answered `y` twice.
async fn pair_dev_server(dev: &DevServer) -> (MachineCode, String) {
    let (mut terminal, code) = start_pair_on_dev_server(dev, false);
    answer_on_dev_server(&mut terminal, &code, &dev.endpoint(), OPERATOR_KEY, "y").await.unwrap_or_else(|failure| panic!("the dev-server refused the pairing its person allowed: {failure:?}"));
    terminal.wait_for("may now operate this server");
    assert_eq!(terminal.exit_code(), 0, "{}", terminal.screen());
    let computers = dev.computers();
    assert_eq!(computers.len(), 1, "one paired computer on the dev-server: {computers:?}");
    let id = computers[0]["id"].as_str().expect("the paired computer has an id").to_string();
    (code, id)
}

// ---------------------------------------------------------------- operating

/// Everything a paired computer does on one machine, through the workspace
/// RPC over the supervisor's direct connection. The sessions it made; an
/// interrupt or approval the machine refused is added to `failures`.
async fn operate(link: &mut Link, machine: &Machine<'_>, foreign: &Foreign, failures: &mut Vec<String>) -> Vec<String> {
    let (name, tag) = (machine.name, machine.tag);

    // The machine and its projects.
    let described = link.ok("machine.describe", json!({})).await;
    assert_eq!(described["name"], name, "{described}");
    assert_eq!(described["os"]["family"], machine.family, "{described}");
    assert_eq!(described["hasWindow"], machine.has_window, "{described}");
    let listed = link.ok("machine.projects", json!({})).await;
    let mut ids: Vec<String> = listed["projects"].as_array().unwrap_or_else(|| panic!("{listed}")).iter().map(|project| project["projectId"].as_str().unwrap().to_string()).collect();
    let mut expected: Vec<String> = machine.projects.iter().map(|path| project_id(path)).collect();
    ids.sort();
    expected.sort();
    assert_eq!(ids, expected, "{name} lists its own projects: {listed}");
    let project = &machine.projects[0];
    let id = project_id(project);

    // A session in its first project, and a prompt the fake agent answers.
    let created = link
        .ok("session.create", json!({ "agent": "claude", "model": "sonnet", "mode": "manual", "title": format!("{name} e2e"), "projectId": id, "clientRequestId": format!("{tag}-create") }))
        .await;
    assert_eq!(created["session"]["projectId"], json!(id), "{created}");
    let session = created["sessionId"].as_str().unwrap().to_string();
    let tab = created["tabId"].as_str().unwrap().to_string();
    let send = |text: String, request: &str| json!({ "sessionId": session, "tabId": tab, "text": text, "clientRequestId": format!("{tag}-{request}") });
    link.ok("session.send", send(format!("echo:hello from {name}"), "send-1")).await;
    let reply = format!("hello from {name}");
    let events = link.wait_events(&session, &tab, "the fake agent's reply", |events| texts(events, "assistant_text").contains(&reply) && count(events, "turn_completed") >= 1).await;
    assert_eq!(texts(&events, "user_message"), vec![format!("echo:hello from {name}")], "{:?}", summary(&events));

    // A shell: type, resize, reconnect, and the replay from an offset.
    let shell = link.ok("pty.create", json!({ "projectId": id, "cols": 100, "rows": 30, "clientRequestId": format!("{tag}-shell") })).await;
    let pty = shell["ptyId"].as_str().unwrap_or_else(|| panic!("{shell}")).to_string();
    let attached = link.ok("pty.attach", json!({ "ptyId": pty })).await;
    let cursor = json!({ "runtimeGeneration": attached["runtimeGeneration"], "epoch": attached["epoch"] });
    let typed = link.ok("pty.write", json!({ "ptyId": pty, "data": format!("echo e2e-$((6*7))-{tag}\n"), "seq": 1 })).await;
    assert_eq!(typed["applied"], true, "{typed}");
    let first = format!("e2e-42-{tag}");
    replay_until(link, &pty, &cursor, 0, &first).await;
    let resized = link.ok("pty.resize", json!({ "ptyId": pty, "cols": 120, "rows": 40 })).await;
    assert_eq!((resized["cols"].as_u64(), resized["rows"].as_u64()), (Some(120), Some(40)), "{resized}");
    link.ok("pty.write", json!({ "ptyId": pty, "data": "stty size\n", "seq": 2 })).await;
    let (_, offset) = replay_until(link, &pty, &cursor, 0, "40 120").await;
    link.reconnect().await;
    let typed = link.ok("pty.write", json!({ "ptyId": pty, "data": format!("echo after-$((2+3))-{tag}\n"), "seq": 3 })).await;
    assert_eq!(typed["applied"], true, "a write after reconnecting: {typed}");
    let (replayed, _) = replay_until(link, &pty, &cursor, offset, &format!("after-5-{tag}")).await;
    assert!(!replayed.contains(&first), "the replay from offset {offset} holds only what came after it: {replayed:?}");

    // A file written and committed through the workspace RPC, found on the
    // machine's own disk by its own git.
    let note = format!("written on {name} by the operating computer\n");
    link.ok("fs.write", json!({ "projectId": id, "path": "e2e-notes.txt", "text": note, "expectedEtag": null, "clientRequestId": format!("{tag}-write") })).await;
    let message = format!("Notes from the operating computer ({tag})");
    let committed = link
        .ok("git.commit", json!({ "projectId": id, "repo": ".", "message": message, "author": { "name": COMMIT_AUTHOR.0, "email": COMMIT_AUTHOR.1 }, "paths": ["e2e-notes.txt"], "clientRequestId": format!("{tag}-commit") }))
        .await;
    let commit = committed["commit"].as_str().unwrap_or_else(|| panic!("git.commit named no commit: {committed}")).to_string();
    assert_eq!(machine.disk.read(&project.join("e2e-notes.txt")), note, "the file on {name}'s disk");
    let logged = machine.disk.git(project, &["log", "-1", "--format=%H%n%s%n%an%n%ae"]);
    assert_eq!(logged.lines().collect::<Vec<_>>(), vec![commit.as_str(), message.as_str(), COMMIT_AUTHOR.0, COMMIT_AUTHOR.1], "{name}'s git log");
    assert_eq!(machine.disk.git(project, &["status", "--porcelain", "--", "e2e-notes.txt"]), "", "the note is committed on {name}");

    // Project scoping: another machine's project is not this machine's, and
    // no path leaves the project named.
    let why = format!("{SCOPING_BROKEN}: {name} must not serve {}'s project {}", foreign.machine, foreign.id);
    refuse(link, "fs.read", json!({ "projectId": foreign.id, "path": "README.md" }), "not_found", &why).await;
    refuse(link, "git.status", json!({ "projectId": foreign.id }), "not_found", &why).await;
    refuse(link, "session.create", json!({ "agent": "claude", "model": "sonnet", "projectId": foreign.id, "clientRequestId": format!("{tag}-foreign") }), "not_found", &why).await;
    let escaping = format!("{name} must refuse a path that leaves project {id}");
    refuse(link, "fs.read", json!({ "projectId": id, "path": machine.outside }), "path_forbidden", &escaping).await;
    refuse(link, "fs.read", json!({ "projectId": id, "path": foreign.path.join("README.md") }), "path_forbidden", &escaping).await;
    refuse(link, "fs.write", json!({ "projectId": id, "path": "../escaped.txt", "text": "x", "expectedEtag": null, "clientRequestId": format!("{tag}-escape") }), "path_forbidden", &escaping).await;
    // A session is in its own project; naming another one is refused.
    let mismatched = format!("{name} must refuse a projectId that is not the session's");
    refuse(link, "session.get", json!({ "sessionId": session, "projectId": foreign.id }), "invalid_params", &mismatched).await;
    for other in machine.projects.iter().skip(1) {
        refuse(link, "session.get", json!({ "sessionId": session, "projectId": project_id(other) }), "invalid_params", &mismatched).await;
    }
    refuse(link, "fs.read", json!({ "path": "README.md" }), "invalid_params", &format!("{name} must refuse a project call that names no project")).await;

    // Last, as they leave the tab busy when refused: a running turn
    // interrupted, and an approval answered, from the operating computer.
    // A refusal is kept in `failures` (the test fails on it at its end), so
    // what follows on the other machine is still checked.
    link.ok("session.send", send("slow:40:500".into(), "send-2")).await;
    link.wait_events(&session, &tab, "the slow turn to start", |events| texts(events, "assistant_text").iter().any(|text| text == "chunk 1 of 40")).await;
    let interrupted = link.call("session.interrupt", json!({ "sessionId": session, "tabId": tab })).await;
    if interrupted["ok"] == true {
        assert_eq!(interrupted["result"]["interrupted"], true, "{interrupted}");
        let events = link.wait_events(&session, &tab, "the interrupted turn to end", |events| count(events, "turn_completed") >= 2).await;
        assert!(!texts(&events, "assistant_text").iter().any(|text| text == "chunk 40 of 40"), "{name}: the interrupted turn ran to its end: {:?}", summary(&events));
    } else {
        failures.push(format!("{name}: session.interrupt on a running turn was refused: {}", interrupted["error"]));
        // It runs out by itself (40 × 0.5 s) before the approval.
        link.wait_events(&session, &tab, "the slow turn to end by itself", |events| count(events, "turn_completed") >= 2).await;
    }

    let command = format!("touch approved-{tag}.txt");
    link.ok("session.send", send(format!("ask:{command}"), "send-3")).await;
    let events = link.wait_events(&session, &tab, "the permission request", |events| count(events, "permission_requested") >= 1).await;
    let request = events.iter().find(|event| event["payload"]["type"] == "permission_requested").unwrap()["payload"]["requestId"].as_str().expect("the request names its id").to_string();
    if !link.has("agent-commands/1") {
        failures.push(format!("{name}: rpc.hello did not grant agent-commands/1 (granted {:?}), so nothing can answer the agent's approval", link.granted));
    }
    let decided = link.call("session.decide", json!({ "sessionId": session, "tabId": tab, "requestId": request, "optionId": "allow", "clientRequestId": format!("{tag}-decide") })).await;
    if decided["ok"] == true {
        assert_eq!(decided["result"]["requestId"], json!(request), "{decided}");
        let allowed = format!("allowed: {command}");
        link.wait_events(&session, &tab, "the allowed tool", |events| texts(events, "assistant_text").contains(&allowed) && count(events, "turn_completed") >= 3).await;
    } else {
        failures.push(format!("{name}: session.decide on the agent's approval was refused: {}", decided["error"]));
    }
    vec![session]
}

/// Attach to a terminal from `since` until its output holds `marker`: the
/// output from there, and the offset after it.
async fn replay_until(link: &mut Link, pty: &str, cursor: &Value, since: u64, marker: &str) -> (String, u64) {
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let mut params = cursor.clone();
        params["ptyId"] = json!(pty);
        params["sinceOffset"] = json!(since);
        let replay = link.ok("pty.attach", params).await;
        assert_eq!(replay["offset"].as_u64(), Some(since), "the replay starts at the offset asked for: {replay}");
        assert_eq!(replay["truncated"], false, "{replay}");
        let data = String::from_utf8_lossy(&STANDARD.decode(replay["data"].as_str().unwrap_or_default()).unwrap()).into_owned();
        if data.contains(marker) {
            return (data, replay["end"].as_u64().expect("the replay says where it ends"));
        }
        assert!(std::time::Instant::now() < deadline, "{}: the terminal never showed {marker:?} after offset {since}; it shows {data:?}", link.name);
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// Revoked: the supervisor ends in "access removed" and retries nothing.
async fn assert_access_removed(link: &mut Link) {
    link.state("access removed after the revocation", Duration::from_secs(30), |state| *state == MachineConnectionState::AccessRemoved).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert_eq!(link.supervisor_state(), MachineConnectionState::AccessRemoved, "{}: nothing reconnected after access was removed", link.name);
}

// ---------------------------------------------------------------- the scenarios

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_computer_pairs_with_two_machines_and_operates_each_in_its_own_projects() {
    let this_mac = ThisMac::start();
    let mini = MacMini::start();
    let dev = linux_image().map(|image| DevServer::start(&image));
    let mut failures = Vec::new();

    // Mac mini: paired by code, allowed in its window; then operated.
    let (mini_code, mini_computer) = pair_mac_mini(&mini).await;
    let mut mini_link = Link::open("Mac mini", Kept::new(&mini_code, &mini.endpoint(), &mini_code.device_token, OPERATOR_KEY)).await;
    let mini_machine = Machine {
        name: "Mac mini",
        tag: "mini",
        family: host_family(),
        has_window: true,
        projects: mini.projects.clone(),
        // Its other project is outside the first.
        outside: "../web/README.md",
        disk: &mini,
    };
    let this_mac_project = Foreign { machine: "this Mac", id: this_mac.project_id.clone(), path: this_mac.world.project.clone() };
    let mini_sessions = operate(&mut mini_link, &mini_machine, &this_mac_project, &mut failures).await;
    assert!(mini.computers()[0]["connected"] == true, "Mac mini shows the computer connected: {:?}", mini.computers());

    if let Some(dev) = &dev {
        // dev-server: paired from its terminal; then operated.
        let (dev_code, dev_computer) = pair_dev_server(dev).await;
        let mut dev_link = Link::open("dev-server", Kept::new(&dev_code, &dev.endpoint(), &dev_code.device_token, OPERATOR_KEY)).await;
        let dev_machine = Machine {
            name: "dev-server",
            tag: "dev",
            family: "linux",
            has_window: false,
            projects: vec![dev.world.project.clone()],
            // `pair` wrote the server's settings beside the project.
            outside: "../data/settings.json",
            disk: dev,
        };
        let mini_project = Foreign { machine: "Mac mini", id: mini.project_ids()[0].clone(), path: mini.projects[0].clone() };
        let dev_sessions = operate(&mut dev_link, &dev_machine, &mini_project, &mut failures).await;

        // Each machine keeps its own sessions.
        let listed = dev_link.ok("session.list", json!({})).await;
        let on_dev: Vec<&str> = listed["sessions"].as_array().unwrap().iter().filter_map(|session| session["id"].as_str()).collect();
        assert!(mini_sessions.iter().all(|session| !on_dev.contains(&session.as_str())), "Mac mini's sessions are not on the dev-server: {listed}");
        assert!(dev_sessions.iter().all(|session| on_dev.contains(&session.as_str())), "{listed}");
        refuse(&mut dev_link, "session.get", json!({ "sessionId": mini_sessions[0] }), "not_found", "the dev-server must not know Mac mini's session").await;
        refuse(&mut mini_link, "session.get", json!({ "sessionId": dev_sessions[0] }), "not_found", "Mac mini must not know the dev-server's session").await;
        // And Mac mini's project is not the dev-server's, nor the other way.
        let dev_project = Foreign { machine: "dev-server", id: dev.project_id(), path: dev.world.project.clone() };
        let why = format!("{SCOPING_BROKEN}: Mac mini must not serve the dev-server's project {}", dev_project.id);
        refuse(&mut mini_link, "fs.read", json!({ "projectId": dev_project.id, "path": "README.md" }), "not_found", &why).await;

        // `devices revoke` on the server ends the computer's connection.
        let (revoked, said) = dev.exec(&["devices", "revoke", &dev_computer, "--data-dir", &dev.world.data.to_string_lossy()]);
        assert_eq!(revoked, 0, "devices revoke on the dev-server: {said}");
        assert_access_removed(&mut dev_link).await;
        assert!(dev.computers().is_empty(), "no computer is paired with the dev-server after the revocation: {:?}", dev.computers());
    }

    // Revoked in Mac mini's window: the connection ends, and the credential
    // is refused from then on.
    mini.revoke(&mini_computer);
    assert_access_removed(&mut mini_link).await;
    assert!(mini.computers().is_empty(), "no computer is paired with Mac mini after the revocation: {:?}", mini.computers());
    assert!(matches!(connect(mini.port, &mini_code.public_key_b64, &mini_code.device_token).await, Outcome::Refused(Some(4401))), "a revoked credential is refused by Mac mini");

    this_mac.assert_untouched();
    // An operating computer stops a running turn and answers its agent's
    // approvals on every machine it operates.
    assert!(failures.is_empty(), "the operating computer could not control the agents it started:\n{}", failures.join("\n"));
}

/// The pairing check: a wrong code, a used code from another computer, a
/// paired token with another client key, and an approval the person
/// declines are all refused, on both machines.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pairing_refuses_a_wrong_or_used_code_another_key_and_a_declined_approval() {
    let mini = MacMini::start();
    let dev = linux_image().map(|image| DevServer::start(&image));

    // A code with a token Mac mini never made.
    let code = mini.create_code();
    let mut wrong = code.clone();
    wrong.device_token = raccoon_lib::relay_e2ee::random_token();
    match pair_with(&wrong, &mini.endpoint(), OTHER_KEY).await {
        Err(failure) => assert_eq!(failure.reason, "code-inactive", "a wrong code on Mac mini: {failure:?}"),
        Ok(_) => panic!("{PAIRING_BROKEN}: Mac mini let a computer in with a code it never made"),
    }
    // The live code still pairs the operating computer.
    let (mini_code, _) = pair_mac_mini_with(&mini, code).await;
    refused_after_pairing(&mini_code, &mini.endpoint(), mini.port, "Mac mini").await;
    // The operating computer, with its own key, still gets in.
    let mut link = Link::open("Mac mini", Kept::new(&mini_code, &mini.endpoint(), &mini_code.device_token, OPERATOR_KEY)).await;
    assert_eq!(link.ok("machine.describe", json!({})).await["machineId"], json!(mini_code.machine.machine_id));
    link.stop();

    // Declined in Mac mini's window: nothing is paired.
    let another = mini.create_code();
    let pairing = {
        let (code, endpoint) = (another.clone(), mini.endpoint());
        tokio::spawn(async move { pair_with(&code, &endpoint, THIRD_KEY).await })
    };
    let pending = mini.pending();
    mini.decline(pending["requestId"].as_str().unwrap());
    match pairing.await.unwrap() {
        Err(failure) => assert_eq!(failure.reason, "not-approved", "a declined approval on Mac mini: {failure:?}"),
        Ok(_) => panic!("{PAIRING_BROKEN}: Mac mini paired a computer its window declined"),
    }
    assert_eq!(mini.computers().len(), 1, "the declined computer was not paired: {:?}", mini.computers());

    let Some(dev) = dev else { return };
    let (mut terminal, code) = start_pair_on_dev_server(&dev, false);
    let mut wrong = code.clone();
    wrong.device_token = raccoon_lib::relay_e2ee::random_token();
    match pair_with(&wrong, &dev.endpoint(), OTHER_KEY).await {
        Err(failure) => assert_eq!(failure.reason, "code-inactive", "a wrong code on the dev-server: {failure:?}"),
        Ok(_) => panic!("{PAIRING_BROKEN}: the dev-server let a computer in with a code it never made"),
    }
    answer_on_dev_server(&mut terminal, &code, &dev.endpoint(), OPERATOR_KEY, "y").await.unwrap_or_else(|failure| panic!("the dev-server refused the pairing its person allowed: {failure:?}"));
    assert_eq!(terminal.exit_code(), 0, "{}", terminal.screen());
    refused_after_pairing(&code, &dev.endpoint(), dev.port, "the dev-server").await;
    // The operating computer's Mac mini credential is Mac mini's alone.
    assert!(
        matches!(connect(dev.port, &code.public_key_b64, &mini_code.device_token).await, Outcome::Refused(Some(4401))),
        "the dev-server refuses the credential Mac mini issued"
    );

    // Declined at the server's terminal: anything but `y`.
    let (mut terminal, another) = start_pair_on_dev_server(&dev, true);
    match answer_on_dev_server(&mut terminal, &another, &dev.endpoint(), THIRD_KEY, "n").await {
        Err(failure) => assert_eq!(failure.reason, "not-approved", "a declined approval on the dev-server: {failure:?}"),
        Ok(()) => panic!("{PAIRING_BROKEN}: the dev-server paired a computer its person declined"),
    }
    terminal.wait_for("Not allowed.");
    assert_eq!(terminal.exit_code(), 1, "{}", terminal.screen());
    assert_eq!(dev.computers().len(), 1, "the declined computer was not paired: {:?}", dev.computers());
}

/// After the operating computer paired by `code`: the same code from
/// another computer, and its token with another client key, are refused
/// (rule 2: a paired token is admitted only with the key it paired with).
async fn refused_after_pairing(code: &MachineCode, endpoint: &str, port: u16, name: &str) {
    match pair_with(code, endpoint, OTHER_KEY).await {
        Err(failure) => assert_eq!(failure.reason, "code-inactive", "{name}: a used code from another computer: {failure:?}"),
        Ok(_) => panic!("{PAIRING_BROKEN}: {name} let another computer in with a code that was already used"),
    }
    match connect(port, &code.public_key_b64, &code.device_token).await {
        Outcome::Refused(Some(4401)) => {}
        Outcome::Refused(other) => panic!("{name}: a paired token with another client key was refused, but closed with {other:?}, not 4401"),
        Outcome::In(_) => panic!("{PAIRING_BROKEN}: {name} admitted a paired computer's token sent with another client key"),
    }
}
