//! A person pairs a computer with a headless server from its terminal
//! (PRO-353): the real `terminalx-serve` on a throwaway data directory,
//! `terminalx-serve pair` driven through a pseudo-terminal the way a person
//! types into it, and an operating computer that pairs by the printed code.
//! `devices` lists the computer, it connects again after the runtime
//! restarts, and `devices revoke` removes it.
//!
//! Only a person may answer: `pair` refuses without a terminal, and the
//! runtime refuses to make a code or approve for anything it started itself,
//! here `pair` run in one of its own terminals.
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD}, Engine as _};
use common::agent::{count, wait_until, AgentWorld, Serve, AGENT_WAIT};
use common::machine::{free_port, listening, status};
use futures_util::{SinkExt, StreamExt};
use raccoon_lib::machine_wire::MachineCode;
use raccoon_lib::relay_e2ee::{E2eeClientHandshake, E2eeSession, PayloadKind};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

/// The operating computer's long-lived key, the same on every connection.
const COMPUTER_KEY: [u8; 32] = [42; 32];
const COMPUTER_LABEL: &str = "Test MacBook";

fn runtime(world: &AgentWorld, port: u16) -> Serve {
    let mut command = world.command();
    command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string());
    let serve = Serve::start(command, &world.data);
    // The control socket's ready line precedes machine-host installation.
    // Wait for the host on initial launch and after a restart.
    wait_until("the installed machine host", || {
        let reply = serve.try_control("runtime.machineHost.status", json!({}));
        if reply["error"]["code"] == "unsupported" {
            return None;
        }
        assert_eq!(reply["ok"], true, "machine host status failed: {reply}");
        Some(())
    });
    serve
}

/// `terminalx-serve <args>` as a person on the server runs it: the same
/// home as the runtime, so no service of the reader's is found.
fn cli(world: &AgentWorld, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_terminalx-serve"));
    command.args(args).arg("--data-dir").arg(&world.data).env("HOME", &world.home).env_remove("TERMINALX_HOME").env_remove("RACCOON_HOME");
    command
}

/// A program in a pseudo-terminal of its own, which it has as its
/// controlling terminal, as in a person's SSH session.
struct Terminal {
    master: std::fs::File,
    child: Child,
    screen: Arc<Mutex<Vec<u8>>>,
}

impl Terminal {
    fn start(mut command: Command) -> Self {
        let (mut master, mut slave) = (0, 0);
        let size = libc::winsize { ws_row: 40, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0 };
        // SAFETY: openpty fills both descriptors and only reads `size` (macOS
        // declares it `*mut`, Linux `*const`); no name or termios is asked for.
        assert_eq!(unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::from_ref(&size).cast_mut()) }, 0);
        // SAFETY: both were just opened and are owned here alone.
        let (master, slave) = unsafe { (std::fs::File::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        command
            .stdin(Stdio::from(slave.try_clone().unwrap()))
            .stdout(Stdio::from(slave.try_clone().unwrap()))
            .stderr(Stdio::from(slave.try_clone().unwrap()));
        #[cfg(target_os = "macos")]
        const TIOCSCTTY: libc::c_ulong = 0x2000_7461;
        #[cfg(not(target_os = "macos"))]
        const TIOCSCTTY: libc::Ioctl = libc::TIOCSCTTY;
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 || libc::ioctl(0, TIOCSCTTY, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().expect("start the program in its terminal");
        drop(slave);
        let screen = Arc::new(Mutex::new(Vec::new()));
        let mut reader = master.try_clone().unwrap();
        let shown = screen.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            // The far end closing reads as an error on macOS, end of file on Linux.
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                shown.lock().unwrap().extend_from_slice(&buffer[..read]);
            }
        });
        Self { master, child, screen }
    }

    fn screen(&self) -> String {
        String::from_utf8_lossy(&self.screen.lock().unwrap()).into_owned()
    }

    /// Everything shown so far, once it holds `text`.
    fn wait_for(&self, text: &str) -> String {
        let deadline = Instant::now() + AGENT_WAIT;
        loop {
            let screen = self.screen();
            if screen.contains(text) {
                return screen;
            }
            assert!(Instant::now() < deadline, "the terminal never showed {text:?}; it shows:\n{screen}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Type a line, as a person presses Return.
    fn type_line(&mut self, line: &str) {
        self.master.write_all(format!("{line}\r").as_bytes()).unwrap();
    }

    fn exit_code(&mut self) -> i32 {
        let deadline = Instant::now() + AGENT_WAIT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code().unwrap_or(-1);
            }
            assert!(Instant::now() < deadline, "the program never exited; it shows:\n{}", self.screen());
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// A direct client, connected and authenticated.
struct DirectClient {
    socket: Socket,
    session: E2eeSession,
    next: u64,
}

/// Connect as the operating computer with `token`, and wait for the machine
/// to let it in (`Ok`) or refuse it (`Err` with the close code).
async fn operate(port: u16, host_public_key_b64: &str, token: &str) -> Result<DirectClient, Option<u16>> {
    connect(port, "/machine/1", host_public_key_b64, token, Some(COMPUTER_LABEL)).await
}

async fn connect(port: u16, path: &str, host_public_key_b64: &str, token: &str, label: Option<&str>) -> Result<DirectClient, Option<u16>> {
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}{path}")).await.unwrap();
    let handshake = E2eeClientHandshake::with_secret(COMPUTER_KEY, host_public_key_b64, "direct", None).unwrap();
    socket.send(Message::Text(serde_json::to_string(handshake.hello()).unwrap().into())).await.unwrap();
    let ready = match socket.next().await.unwrap().unwrap() {
        Message::Text(text) => text.to_string(),
        other => panic!("expected E2EE ready, got {other:?}"),
    };
    let mut session = handshake.accept_ready(&ready).unwrap();
    let transcript = session.transcript_hash_b64.clone();
    let mut auth = json!({ "type": "e2ee_auth", "v": 2, "transcriptHashB64": transcript, "deviceToken": token });
    if let Some(label) = label {
        auth["label"] = json!(label);
        auth["platform"] = json!("macos");
    }
    let sealed = session.seal(auth.to_string().as_bytes(), PayloadKind::Text).unwrap();
    socket.send(Message::Text(STANDARD.encode(sealed).into())).await.unwrap();
    // A person has two minutes to answer.
    loop {
        match tokio::time::timeout(Duration::from_secs(150), socket.next()).await.expect("an answer from the machine") {
            Some(Ok(Message::Text(text))) => {
                let reply: Value = serde_json::from_slice(&session.open(&STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap()).unwrap();
                match reply["type"].as_str() {
                    Some("e2ee_authenticated") => {
                        assert_eq!(reply["transcriptHashB64"], transcript.as_str());
                        return Ok(DirectClient { socket, session, next: 1 });
                    }
                    Some("pairing_refused") => continue,
                    _ => panic!("unexpected reply {reply}"),
                }
            }
            Some(Ok(Message::Close(frame))) => return Err(frame.map(|frame| u16::from(frame.code))),
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return Err(None),
        }
    }
}

impl DirectClient {
    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = format!("r{}", self.next);
        self.next += 1;
        let request = json!({ "id": id, "method": method, "params": params });
        let sealed = self.session.seal(request.to_string().as_bytes(), PayloadKind::Text).unwrap();
        self.socket.send(Message::Text(STANDARD.encode(sealed).into())).await.unwrap();
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(30), self.socket.next()).await.expect("an answer").expect("open").unwrap();
            let Message::Text(text) = frame else { continue };
            let message: Value = serde_json::from_slice(&self.session.open(&STANDARD.decode(text.as_bytes()).unwrap(), PayloadKind::Text).unwrap()).unwrap();
            if message["id"] == id.as_str() {
                return message;
            }
        }
    }

    async fn closed(&mut self) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            match tokio::time::timeout_at(deadline, self.socket.next()).await {
                Err(_) => return false,
                Ok(None) | Ok(Some(Err(_))) | Ok(Some(Ok(Message::Close(_)))) => return true,
                Ok(Some(Ok(_))) => continue,
            }
        }
    }
}

fn devices(world: &AgentWorld, extra: &[&str]) -> (i32, String) {
    let mut args = vec!["devices"];
    args.extend_from_slice(extra);
    let output = cli(world, &args).stdin(Stdio::null()).output().unwrap();
    (output.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)))
}

fn hosting(data: &Path) -> bool {
    std::fs::read_to_string(data.join("settings.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|settings| settings["machines"]["allowOperating"] == true)
}

#[tokio::test(flavor = "multi_thread")]
async fn phone_pairs_from_terminal_and_answers_an_agent_approval_without_a_window() {
    let world = AgentWorld::new();
    let port = free_port();
    let serve = runtime(&world, port);
    let mut pair = Terminal::start(cli(&world, &["pair", "--phone"]));
    pair.wait_for("Let other computers operate this server? [y/N]");
    pair.type_line("y");
    pair.wait_for("Where should this server listen for them?");
    pair.wait_for("Choice [1]:");
    // All interfaces, so the test's loopback connection reaches it; public callers stay refused.
    pair.type_line("4");
    pair.wait_for("Also answer callers whose own address is public? [y/N]");
    pair.type_line("n");
    let screen = pair.wait_for("Waiting for the phone");
    assert!(screen.contains('▀'), "shows a terminal QR");
    let link = screen.split_whitespace().find(|word| word.starts_with("terminalx://pair?")).unwrap();
    let code = link.trim_start_matches("terminalx://pair?code=").split('&').next().unwrap();
    let offer: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(code).unwrap()).unwrap();
    assert_eq!(offer["v"], 2);
    assert_eq!(offer["scope"], "mobile");
    let key = offer["publicKeyB64"].as_str().unwrap().to_string();
    let token = offer["deviceToken"].as_str().unwrap().to_string();
    let pairing = tokio::spawn({
        let (key, token) = (key.clone(), token.clone());
        async move { connect(port, "/", &key, &token, None).await }
    });
    let screen = pair.wait_for("Allow? [y/N]");
    assert!(screen.contains("Check it shows the fingerprint"));
    pair.type_line("y");
    let mut phone = pairing.await.unwrap().unwrap();
    assert_eq!(pair.exit_code(), 0);
    assert_eq!(phone.call("host.describe", json!({})).await["result"]["hasWindow"], false);
    assert_eq!(phone.call("machine.describe", json!({})).await["ok"], false);

    let created = serve.control("sessions.create", json!({
        "project": world.project, "agent": "claude", "prompt": "ask:echo paired-phone",
        "mode": "manual", "useWorktree": false, "onMain": true,
    }));
    let tab = &created["tabId"];
    assert_eq!(serve.control("wait", json!({"target": tab, "timeoutSeconds": 10}))["reason"], "permission");
    let pending = serve.control("permissions.list", json!({}));
    let answer = phone.call("permission.respond", json!({
        "sessionId": created["sessionId"], "tabId": tab,
        "requestId": pending["permissions"][0]["requestId"], "optionId": "allow",
    })).await;
    assert_eq!(answer["ok"], true, "{answer}");
    serve.wait_events(tab.as_str().unwrap(), "the phone's approval", |events| count(events, "turn_completed") == 1);

    let summaries = phone.call("sessions.summaries", json!({})).await;
    assert_eq!(summaries["ok"], true, "{summaries}");
    assert!(summaries["result"]["sessions"].as_array().unwrap().iter().any(|session| session["id"] == created["sessionId"]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_person_pairs_a_computer_from_the_servers_terminal_and_revokes_it() {
    let world = AgentWorld::new();
    let port = free_port();
    let serve = runtime(&world, port);
    std::fs::write(world.data.join("settings.json"), json!({ "keepMe": { "unknown": 1 } }).to_string()).unwrap();
    let initial = wait_until("the installed machine host", || {
        let reply = serve.try_control("runtime.machineHost.status", json!({}));
        (reply["ok"] == true).then(|| reply["result"].clone())
    });
    assert_eq!(initial["enabled"], false, "off until a person turns it on");

    // Without a terminal, `pair` refuses before it changes anything.
    let piped = cli(&world, &["pair"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
    let output = piped.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(2), "{output:?}");
    assert!(String::from_utf8_lossy(&output.stderr).contains("only a person at a terminal"), "{output:?}");
    assert!(!hosting(&world.data), "a refused pair turns nothing on");

    // Nor does a request that does not say who sent it make a code or approve.
    let attached = serve.control("runtime.attach", json!({ "protocol": 1 }));
    let lease = json!({ "epoch": attached["epoch"], "lease": attached["lease"] });
    let mut answer = lease.clone();
    answer["requestId"] = json!("r");
    for (command, params) in [("runtime.machineHost.createCode", lease), ("runtime.machineHost.approve", answer)] {
        let refused = serve.try_control(command, params);
        assert_eq!(refused["error"]["code"], "person_required", "{command}: {refused}");
    }

    // A person runs `pair`: it asks before it turns hosting on.
    let mut pair = Terminal::start(cli(&world, &["pair"]));
    pair.wait_for("Let other computers operate this server? [y/N]");
    pair.type_line("y");
    // The first time hosting is turned on it asks where to listen, saying what each choice opens (PRO-487).
    let asked = pair.wait_for("Choice [1]:");
    for said in ["1) Relay only", "No port is opened", "2) Tailscale", "3) Local network", "4) All interfaces", "public ones included", "Callers from public addresses are refused under every choice unless you allow them."] {
        assert!(asked.contains(said), "the question says {said:?}:\n{asked}");
    }
    assert!(!hosting(&world.data), "nothing is turned on before the answer");
    // All interfaces, so the test's loopback connection reaches it; public callers stay refused.
    pair.type_line("4");
    pair.wait_for("Also answer callers whose own address is public? [y/N]");
    pair.type_line("n");
    let screen = pair.wait_for("Waiting for a computer to pair");
    assert!(hosting(&world.data), "pair turned hosting on");
    let settings: Value = serde_json::from_str(&std::fs::read_to_string(world.data.join("settings.json")).unwrap()).unwrap();
    assert_eq!((settings["machines"]["listen"].as_str(), settings["machines"]["allowPublic"].as_bool()), (Some("all"), Some(false)), "the answer is kept: {settings}");
    assert_eq!(settings["keepMe"]["unknown"], 1, "the settings store kept a key it does not know");
    let machine_id = status(&serve)["machineId"].as_str().unwrap().to_string();
    assert!(screen.contains("TerminalX "), "{screen}");
    assert!(screen.contains(&format!("Machine ID  {machine_id}")), "{screen}");
    assert!(screen.contains("Name        "), "{screen}");
    assert!(screen.contains("Pairing code, valid for 5:00, works once:") || screen.contains("Pairing code, valid for 4:59, works once:"), "{screen}");
    let printed = screen.split_whitespace().find(|word| word.starts_with("txm2.")).expect("the code is shown").to_string();
    let code = MachineCode::decode(&printed).expect("the whole code is shown");
    assert_eq!(code.machine.machine_id, machine_id);

    // The operating computer pairs by that code and waits for Allow.
    let key = code.public_key_b64.clone();
    let token = code.device_token.clone();
    let pairing = tokio::spawn({
        let (key, token) = (key.clone(), token.clone());
        async move { operate(port, &key, &token).await }
    });
    let asked = wait_until("the computer to ask", || status(&serve)["pending"].as_object().cloned());
    let fingerprint = asked["fingerprint"].as_str().unwrap().to_string();
    let screen = pair.wait_for("Allow? [y/N]");
    assert!(screen.contains(&format!("✓ {COMPUTER_LABEL} asks to operate this server. Fingerprint {fingerprint}.")), "{screen}");
    pair.type_line("y");
    let mut macbook = pairing.await.unwrap().unwrap_or_else(|code| panic!("the computer was refused ({code:?})"));
    pair.wait_for("may now operate this server");
    assert_eq!(pair.exit_code(), 0);
    let hello = macbook.call("rpc.hello", json!({ "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1"] })).await;
    assert_eq!(hello["ok"], true, "{hello}");

    // `devices` lists it, connected.
    let id = status(&serve)["computers"][0]["id"].as_str().unwrap().to_string();
    let (code_listed, listed) = devices(&world, &[]);
    assert_eq!(code_listed, 0, "{listed}");
    assert!(listed.contains(&id) && listed.contains(COMPUTER_LABEL) && listed.contains("connected now"), "{listed}");

    // `pair` in a terminal the runtime runs is refused by the runtime, as an
    // agent's would be: no code is made, so nothing can be approved.
    let created = serve.control("sessions.create", json!({
        "project": world.project, "agent": "claude", "prompt": "echo:host a terminal", "useWorktree": false, "onMain": true, "mode": "manual",
    }));
    let tab = created["tabId"].as_str().unwrap().to_string();
    serve.wait_events(&tab, "the host session's turn", |events| count(events, "turn_completed") >= 1);
    let terminal = format!("{}:1", created["sessionId"].as_str().unwrap());
    // The runtime's own environment: the same HOME as the person's.
    let command = format!("'{}' pair --data-dir '{}'", env!("CARGO_BIN_EXE_terminalx-serve"), world.data.display());
    serve.control("runtime.pty.spawn", json!({ "id": terminal, "cwd": world.project, "cols": 120, "rows": 40, "command": command }));
    let inside = wait_until("pair in the runtime's terminal to be refused", || {
        let output = serve.control("runtime.pty.output", json!({ "id": terminal }));
        let text = String::from_utf8_lossy(&STANDARD.decode(output["data"].as_str().unwrap_or_default()).unwrap()).into_owned();
        (text.contains("Only a person may do this")
            || text.contains("processes started by this runtime are refused")
            || output["running"] == false)
            .then_some(text)
    });
    assert!(
        (inside.contains("Only a person may do this") && inside.contains("this runtime started"))
            || inside.contains("processes started by this runtime are refused"),
        "{inside}"
    );
    assert!(!inside.contains("txm2."), "no code was shown: {inside}");
    assert!(status(&serve)["code"].is_null(), "no code was made");

    // After the runtime restarts, the paired computer connects again, with
    // no one asked.
    drop(macbook);
    drop(serve);
    let serve = runtime(&world, port);
    listening(&serve);
    let mut again = operate(port, &key, &token).await.unwrap_or_else(|code| panic!("the paired computer was refused after a restart ({code:?})"));
    assert_eq!(again.call("rpc.hello", json!({ "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1"] })).await["ok"], true);
    assert!(status(&serve)["pending"].is_null());

    // `devices revoke` removes it: its connection closes, and it may not come back.
    let (revoked, said) = devices(&world, &["revoke", &id]);
    assert_eq!(revoked, 0, "{said}");
    assert!(said.contains("Removed"), "{said}");
    assert!(again.closed().await, "a revoked computer's connection closes at once");
    assert!(matches!(operate(port, &key, &token).await.err(), Some(Some(4401))), "a revoked computer is refused");
    let (_, listed) = devices(&world, &[]);
    assert!(!listed.contains(&id), "{listed}");
    assert!(listed.contains("No computer is paired"), "{listed}");
    let (unknown, said) = devices(&world, &["revoke", &id]);
    assert_eq!(unknown, 1, "{said}");
}

#[tokio::test(flavor = "multi_thread")]
async fn no_answer_or_anything_but_y_declines() {
    let world = AgentWorld::new();
    let port = free_port();
    std::fs::write(world.data.join("settings.json"), json!({ "machines": { "allowOperating": true } }).to_string()).unwrap();
    let serve = runtime(&world, port);
    listening(&serve);

    let mut pair = Terminal::start(cli(&world, &["pair"]));
    let screen = pair.wait_for("Waiting for a computer to pair");
    assert!(!screen.contains("[y/N]"), "hosting is on already, so nothing is asked first: {screen}");
    let printed = screen.split_whitespace().find(|word| word.starts_with("txm2.")).unwrap().to_string();
    let code = MachineCode::decode(&printed).unwrap();
    let pairing = tokio::spawn(async move { operate(port, &code.public_key_b64, &code.device_token).await });
    pair.wait_for("Allow? [y/N]");
    pair.type_line("sure");
    assert!(pairing.await.unwrap().is_err(), "anything but y declines");
    pair.wait_for("Not allowed.");
    assert_eq!(pair.exit_code(), 1);
    assert!(status(&serve)["computers"].as_array().unwrap().is_empty(), "nothing was paired");
    assert!(status(&serve)["code"].is_null(), "declining ends the code");
}
