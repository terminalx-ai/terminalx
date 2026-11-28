//! PRO-353: `terminalx-serve update` (and the installer run again) puts the
//! new runtime in place by the runtime's own handover (#765), never by
//! restarting the service: an agent in the middle of a turn keeps running,
//! in the same process, and finishes its turn.
//!
//! PRO-354: another computer updates a headless machine over `machine/3`:
//! the runtime's helper downloads a signed release from a release server
//! here, tries it on a scratch data directory, hands the running runtime
//! over to it, and moves `current` only once it is ready. Two agent tabs and
//! a shell keep running; a release that does not start changes nothing.
#![cfg(unix)]

mod common;

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use common::agent::{count, texts, wait_until, AgentWorld, Serve};
use common::machine::{allow, computer, connect, free_port, host_key, listening, pair, Computer};
use raccoon_lib::serve_cli::handover::{hand_over, Outcome};
use raccoon_lib::serve_cli::{SIGNATURE_NAMESPACE, SIGNER_PRINCIPAL};
use serde_json::{json, Value};

#[test]
fn an_update_hands_the_running_runtime_over_and_its_agent_finishes_its_turn() {
    if std::process::Command::new("python3").arg("--version").output().is_err() {
        eprintln!("skipped: python3 is not installed");
        return;
    }
    let world = AgentWorld::new();
    let binary = Path::new(env!("CARGO_BIN_EXE_terminalx-serve"));
    // No runtime yet: nothing to hand over; the service starts the new one.
    assert_eq!(hand_over(&world.data, binary, "9.9.9").unwrap(), Outcome::NotRunning);

    let serve = Serve::start(world.command(), &world.data);
    let before = serve.control("status", json!({}));
    let version = before["localRuntime"]["version"].as_str().unwrap().to_string();
    // The same version runs already: nothing to do.
    assert_eq!(hand_over(&world.data, binary, &version).unwrap(), Outcome::Current);

    let created = serve.control("sessions.create", json!({
        "project": world.project, "agent": "claude", "prompt": "slow:60:400", "useWorktree": false, "onMain": true, "mode": "manual",
    }));
    let tab = created["tabId"].as_str().unwrap().to_string();
    serve.wait_events(&tab, "the long turn to start", |events| texts(events, "assistant_text").iter().any(|text| text == "chunk 2 of 60"));
    let pane = format!("tab:{tab}");
    let agent_pid = serve.control("runtime.pty.output", json!({ "id": pane }))["pid"].clone();
    assert!(agent_pid.is_u64());

    // A version other than the running one's: `update` hands over to the
    // binary it installed (here this same build, which the runtime accepts).
    assert_eq!(count(&serve.events(&tab), "turn_completed"), 0, "the turn is under way at the handover");
    assert_eq!(hand_over(&world.data, binary, "9.9.9").unwrap(), Outcome::HandedOver);
    assert_eq!(count(&serve.events(&tab), "turn_completed"), 0, "the turn was still under way when the new runtime took over");
    let after: Value = wait_until("the runtime that took over", || {
        let status = serve.try_control("status", json!({}));
        (status["ok"] == true && status["result"]["localRuntime"]["epoch"] != before["localRuntime"]["epoch"]).then(|| status["result"].clone())
    });
    assert_eq!(after["pid"], before["pid"], "the same process: the service manager sees the same service");
    assert_eq!(serve.control("runtime.pty.output", json!({ "id": pane }))["pid"], agent_pid, "the agent was not restarted");
    let events = serve.wait_events(&tab, "the turn to end after the handover", |events| count(events, "turn_completed") >= 1);
    assert!(texts(&events, "assistant_text").iter().any(|text| text == "chunk 60 of 60"), "the turn finished: {:?}", texts(&events, "assistant_text"));
}

// ----------------------------------------------------------- machine/3

const TOKEN: &str = "a-paired-computers-device-token-0354";
const TAG_TIME: &str = "20261116120000";

/// The release asset this platform's runtime is published as.
fn asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("terminalx-serve-linux-x64"),
        ("linux", "aarch64") => Some("terminalx-serve-linux-arm64"),
        ("macos", "aarch64") => Some("terminalx-serve-macos-arm64"),
        _ => None,
    }
}

/// What this test needs from the machine, or why it is skipped.
fn missing() -> Option<String> {
    for (tool, args) in [("python3", &["--version"][..]), ("ssh-keygen", &["-?"][..])] {
        if Command::new(tool).args(args).output().is_err() {
            return Some(format!("{tool} is not installed"));
        }
    }
    asset().is_none().then(|| format!("there is no runtime release for {} on {}", std::env::consts::OS, std::env::consts::ARCH))
}

fn sha256(bytes: &[u8]) -> String {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f");
    std::fs::write(&file, bytes).unwrap();
    for (tool, args) in [("sha256sum", &[][..]), ("shasum", &["-a", "256"][..])] {
        if let Ok(output) = Command::new(tool).args(args).arg(&file).output() {
            if output.status.success() {
                return String::from_utf8(output.stdout).unwrap().split_whitespace().next().unwrap().to_string();
            }
        }
    }
    panic!("neither sha256sum nor shasum is installed");
}

/// The version this build of the runtime says it is.
fn own_version() -> String {
    let said = Command::new(env!("CARGO_BIN_EXE_terminalx-serve")).arg("--version").output().unwrap();
    String::from_utf8(said.stdout).unwrap().trim().strip_prefix("terminalx-serve ").unwrap().to_string()
}

/// One signed runtime release, as `release-serve.yml` publishes one, served
/// over HTTP from here, with a throwaway signing key the runtime is told to
/// trust (`TERMINALX_INSTALL_ALLOWED_SIGNERS`, as the installer's tests do).
struct ReleaseServer {
    _dir: tempfile::TempDir,
    signers: PathBuf,
    port: u16,
}

impl ReleaseServer {
    fn publish(version: &str, binary: Vec<u8>) -> Self {
        let asset = asset().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let key = dir.path().join("key");
        assert!(Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f"]).arg(&key).status().unwrap().success());
        let public = std::fs::read_to_string(key.with_extension("pub")).unwrap();
        let public = public.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
        let signers = dir.path().join("allowed_signers");
        std::fs::write(&signers, format!("{SIGNER_PRINCIPAL} namespaces=\"{SIGNATURE_NAMESPACE}\" {public}\n")).unwrap();

        let tag = format!("runtime-v{version}-{TAG_TIME}-abcdef1");
        let manifest = json!({ "version": version }).to_string().into_bytes();
        let sums = format!("{}  {asset}\n{}  terminalx-serve.json\n", sha256(&binary), sha256(&manifest));
        let sums_file = dir.path().join("SHA256SUMS");
        std::fs::write(&sums_file, &sums).unwrap();
        assert!(Command::new("ssh-keygen").args(["-q", "-Y", "sign", "-n", SIGNATURE_NAMESPACE, "-f"]).arg(&key).arg(&sums_file).status().unwrap().success());
        let signature = std::fs::read(dir.path().join("SHA256SUMS.sig")).unwrap();
        let names = [asset, "SHA256SUMS", "SHA256SUMS.sig", "terminalx-serve.json"];
        let list = json!([{ "tag_name": tag, "draft": false, "assets": names.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>() }]);

        let mut files: HashMap<String, Vec<u8>> = HashMap::new();
        files.insert("/releases".into(), list.to_string().into_bytes());
        files.insert(format!("/download/{tag}/{asset}"), binary);
        files.insert(format!("/download/{tag}/terminalx-serve.json"), manifest);
        files.insert(format!("/download/{tag}/SHA256SUMS"), sums.into_bytes());
        files.insert(format!("/download/{tag}/SHA256SUMS.sig"), signature);
        let files = Arc::new(files);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().map_while(Result::ok) {
                let files = files.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream);
                    let mut request = String::new();
                    if reader.read_line(&mut request).is_err() {
                        return;
                    }
                    loop {
                        let mut header = String::new();
                        if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
                            break;
                        }
                    }
                    let path = request.split_whitespace().nth(1).unwrap_or_default().to_string();
                    let mut stream = reader.into_inner();
                    let _ = match files.get(&path) {
                        Some(body) => stream
                            .write_all(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n", body.len()).as_bytes())
                            .and_then(|()| stream.write_all(body)),
                        None => stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
                    };
                });
            }
        });
        Self { _dir: dir, signers, port }
    }

    /// Point a runtime (and the helper it starts) at this release server.
    fn serve_to(&self, command: &mut Command) {
        command
            .env("TERMINALX_INSTALL_API_URL", format!("http://127.0.0.1:{}/releases", self.port))
            .env("TERMINALX_INSTALL_BASE_URL", format!("http://127.0.0.1:{}/download", self.port))
            .env("TERMINALX_INSTALL_ALLOWED_SIGNERS", &self.signers);
    }
}

/// A headless install in the world's home, as `install.sh` leaves one:
/// `~/.terminalx/versions/<version>` and `current` pointing at it.
fn install(world: &AgentWorld, version: &str) -> PathBuf {
    let root = world.home.join(".terminalx");
    let folder = root.join("versions").join(version);
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::copy(env!("CARGO_BIN_EXE_terminalx-serve"), folder.join("terminalx-serve")).unwrap();
    std::os::unix::fs::symlink(Path::new("versions").join(version), root.join("current")).unwrap();
    root
}

/// The runtime, hosting operating computers, with one paired computer
/// connected and granted `machine/3`.
async fn machine(world: &AgentWorld, release: &ReleaseServer) -> (Serve, u16, Computer) {
    let port = free_port();
    let mut command = world.command();
    command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string());
    release.serve_to(&mut command);
    let serve = Serve::start(command, &world.data);
    pair(&world.data, "macbook", TOKEN, None);
    allow(&world.data, true);
    listening(&serve);
    let macbook = connected(&world.data, port).await;
    (serve, port, macbook)
}

async fn connected(data: &Path, port: u16) -> Computer {
    let mut macbook = computer(connect(port, &host_key(data).public_key_b64(), TOKEN).await);
    let hello = macbook.call("rpc.hello", json!({ "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1", "machine/2", "machine/3", "session/1"] })).await;
    assert!(hello["result"]["capabilities"].as_array().unwrap().contains(&json!("machine/3")), "{hello}");
    macbook
}

/// The update record once the update has ended (`updated` or `failed`).
async fn ended(data: &Path) -> Value {
    let path = data.join("run/machine-update.json");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(300);
    loop {
        let record: Value = std::fs::read(&path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or(Value::Null);
        if matches!(record["progress"]["phase"].as_str(), Some("updated" | "failed")) {
            return record;
        }
        assert!(tokio::time::Instant::now() < deadline, "the update did not end: {record}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn versions_on_disk(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root.join("versions")).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).filter(|name| !name.starts_with('.')).collect();
    names.sort();
    names
}

/// Every `tick-N` in a terminal's output, in order.
fn ticks(serve: &Serve, pane: &str) -> Vec<u64> {
    let output = serve.control("runtime.pty.output", json!({ "id": pane }));
    let bytes = base64::engine::general_purpose::STANDARD.decode(output["data"].as_str().unwrap_or_default()).unwrap();
    String::from_utf8_lossy(&bytes).split("tick-").skip(1).filter_map(|rest| rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()).collect()
}

fn pid(serve: &Serve, pane: &str) -> Value {
    serve.control("runtime.pty.output", json!({ "id": pane }))["pid"].clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn another_computer_updates_a_headless_machine_and_two_agents_and_a_shell_keep_running() {
    if let Some(why) = missing() {
        eprintln!("skipped: {why}");
        return;
    }
    let world = AgentWorld::new();
    let version = own_version();
    let root = install(&world, "0.0.1");
    let release = ReleaseServer::publish(&version, std::fs::read(env!("CARGO_BIN_EXE_terminalx-serve")).unwrap());
    let (serve, port, mut macbook) = machine(&world, &release).await;

    // Two agent tabs, one in the middle of a long turn, and a shell.
    let create = |prompt: &str| {
        let created = serve.control("sessions.create", json!({
            "project": world.project, "agent": "claude", "prompt": prompt, "useWorktree": false, "onMain": true, "mode": "manual",
        }));
        (created["sessionId"].as_str().unwrap().to_string(), created["tabId"].as_str().unwrap().to_string())
    };
    let (session, resting) = create("echo:ready");
    serve.wait_events(&resting, "the first agent's turn to end", |events| count(events, "turn_completed") >= 1);
    let (_, working) = create("slow:600:200");
    serve.wait_events(&working, "the long turn to start", |events| texts(events, "assistant_text").iter().any(|text| text == "chunk 2 of 600"));
    let shell = format!("{session}:1");
    serve.control("runtime.pty.spawn", json!({ "id": shell, "cwd": world.project, "cols": 80, "rows": 24,
        "command": "sh -c 'i=0; while [ ! -f stop ]; do i=$((i+1)); echo tick-$i; sleep 0.05; done'" }));
    wait_until("the shell's first ticks", || (ticks(&serve, &shell).len() >= 5).then_some(()));
    let pids = [pid(&serve, &format!("tab:{resting}")), pid(&serve, &format!("tab:{working}")), pid(&serve, &shell)];
    assert!(pids.iter().all(Value::is_u64), "{pids:?}");
    let before = serve.control("status", json!({}));

    // The machine says what it runs and what it could update to.
    let status = macbook.call("machine.updateStatus", json!({ "refresh": true })).await;
    assert_eq!(status["ok"], true, "{status}");
    let status = &status["result"];
    assert_eq!(status["method"], "installer");
    assert_eq!(status["current"], version.as_str());
    assert_eq!(status["available"], json!({ "version": version }), "newer than the installed 0.0.1");
    assert_eq!(status["kept"], json!(["0.0.1"]));
    assert_eq!(status["blockers"], json!([]), "agents mid-turn and shells are carried over");
    assert_eq!(status["otherComputers"], json!([]));

    // Ignore queued idle status and keep progress even if it arrives before the RPC reply.
    let progress = |params: &Value| params["status"]["progress"]["phase"] != "idle";
    let mut early = None;
    let started = macbook.call_observing("machine.update", json!({ "version": version }), |message| {
        if early.is_none() && message["event"] == "machine.updateChanged" && progress(&message["params"]) {
            early = Some(message["params"].clone());
        }
    }).await;
    assert_eq!(started["ok"], true, "{started}");
    assert_eq!(started["result"]["progress"]["phase"], "downloading");
    let told = match early {
        Some(told) => told,
        None => macbook.notification("machine.updateChanged", Duration::from_secs(120), progress).await
            .expect("the computer is told how the update goes"),
    };
    assert!(["downloading", "verifying", "trial", "handingOver", "cleaningUp", "updated"].contains(&told["status"]["progress"]["phase"].as_str().unwrap()), "{told}");

    let record = ended(&world.data).await;
    assert_eq!(record["progress"]["phase"], "updated", "{record}; log: {}", std::fs::read_to_string(world.data.join("run/machine-update.log")).unwrap_or_default());
    assert_eq!(record["progress"]["to"], version.as_str());

    // The same process, a new runtime in it, with the same agents and shell.
    let after: Value = wait_until("the runtime that took over", || {
        let status = serve.try_control("status", json!({}));
        (status["ok"] == true && status["result"]["localRuntime"]["epoch"] != before["localRuntime"]["epoch"]).then(|| status["result"].clone())
    });
    assert_eq!(after["pid"], before["pid"], "handed over in place, not restarted");
    assert_eq!([pid(&serve, &format!("tab:{resting}")), pid(&serve, &format!("tab:{working}")), pid(&serve, &shell)], pids, "no agent or shell was restarted");
    let ticked = ticks(&serve, &shell).last().copied().unwrap();
    wait_until("the shell to go on ticking", || (ticks(&serve, &shell).last().copied().unwrap() > ticked + 5).then_some(()));
    serve.control("send", json!({ "target": resting, "text": "echo:after the update" }));
    let events = serve.wait_events(&resting, "the resting agent to answer after the update", |events| count(events, "turn_completed") >= 2);
    assert!(texts(&events, "assistant_text").iter().any(|text| text == "after the update"));

    // `current` moved only now, and no more than three versions stay.
    assert_eq!(std::fs::read_link(root.join("current")).unwrap(), Path::new("versions").join(&version));
    let kept = versions_on_disk(&root);
    assert!(kept.len() <= 3 && kept.contains(&version), "{kept:?}");

    // A computer connecting again is told it is updated.
    drop(macbook);
    listening(&serve);
    let mut again = connected(&world.data, port).await;
    let status = again.call("machine.updateStatus", json!({})).await;
    let status = &status["result"];
    assert_eq!(status["progress"]["phase"], "updated", "{status}");
    assert_eq!(status["current"], version.as_str());
    assert_eq!(status["kept"], json!([version, "0.0.1"]));
    std::fs::write(world.project.join("stop"), "").unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_release_that_does_not_start_leaves_the_running_version_and_says_so() {
    if let Some(why) = missing() {
        eprintln!("skipped: {why}");
        return;
    }
    let world = AgentWorld::new();
    let root = install(&world, "0.0.1");
    // Signed, and says its version; it only cannot run.
    let broken = "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'terminalx-serve 9.9.9'; exit 0; fi\necho 'this build cannot start' >&2\nexit 3\n";
    let release = ReleaseServer::publish("9.9.9", broken.as_bytes().to_vec());
    let (serve, _port, mut macbook) = machine(&world, &release).await;
    let (_, tab) = {
        let created = serve.control("sessions.create", json!({
            "project": world.project, "agent": "claude", "prompt": "echo:here", "useWorktree": false, "onMain": true, "mode": "manual",
        }));
        (created["sessionId"].as_str().unwrap().to_string(), created["tabId"].as_str().unwrap().to_string())
    };
    serve.wait_events(&tab, "the agent's turn to end", |events| count(events, "turn_completed") >= 1);
    let agent = pid(&serve, &format!("tab:{tab}"));
    let before = serve.control("status", json!({}));

    let status = macbook.call("machine.updateStatus", json!({ "refresh": true })).await;
    assert_eq!(status["result"]["available"], json!({ "version": "9.9.9" }), "{status}");
    let started = macbook.call("machine.update", json!({ "version": "9.9.9" })).await;
    assert_eq!(started["ok"], true, "{started}");
    let record = ended(&world.data).await;
    let progress = &record["progress"];
    assert_eq!(progress["phase"], "failed", "{record}");
    assert_eq!(progress["version"], "9.9.9");
    assert_eq!(progress["running"], own_version().as_str(), "it says what runs");
    assert_eq!(progress["rolledBack"], false, "the running runtime was never touched");
    assert!(progress["message"].as_str().unwrap().contains("did not start"), "{progress}");

    // Nothing changed: the same runtime, `current` and versions as before.
    let after = serve.control("status", json!({}));
    assert_eq!(after["localRuntime"]["epoch"], before["localRuntime"]["epoch"], "never handed over");
    assert_eq!(pid(&serve, &format!("tab:{tab}")), agent);
    assert_eq!(std::fs::read_link(root.join("current")).unwrap(), Path::new("versions/0.0.1"));
    assert_eq!(versions_on_disk(&root), ["0.0.1"], "the release that did not start was removed");
    let status = macbook.call("machine.updateStatus", json!({})).await;
    assert_eq!(status["result"]["progress"]["phase"], "failed", "{status}");
    assert_eq!(status["result"]["kept"], json!(["0.0.1"]));
}
