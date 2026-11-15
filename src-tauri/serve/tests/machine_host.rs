//! A local runtime accepts operating computers itself (PRO-341): the real
//! `terminalx-serve`, no desktop, no account. Off by default it opens no
//! port; on, a paired computer connects on `/machine/1` with E2EE v2 and
//! works the machine's workspace RPC, and a phone's connection goes to the
//! window's phone route untouched. The relay route is in `relay_e2e.rs`.
#![cfg(unix)]

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixListener;
use std::time::Duration;

use common::agent::{wait_until, AgentWorld, Serve};
use common::machine::{allow, computer, connect, free_port, host_key, listening, pair, status, Outcome};
use serde_json::json;

const TOKEN: &str = "a-paired-computers-device-token-0001";

#[tokio::test(flavor = "multi_thread")]
async fn a_paired_computer_operates_a_local_runtime_directly_and_only_while_allowed() {
    let world = AgentWorld::new();
    let port = free_port();
    let mut command = world.machine_command();
    command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string());
    let serve = Serve::start(command, &world.data);

    // Off by default: nothing listens, and no key is made.
    std::thread::sleep(Duration::from_secs(2));
    let off = status(&serve);
    assert_eq!(off["enabled"], false);
    assert!(off["listening"].is_null());
    assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_err(), "no port is open while the switch is off");
    assert!(!world.data.join("machine-host/host-key.json").exists());

    pair(&world.data, "macbook", TOKEN, None);
    allow(&world.data, true);
    let address = listening(&serve);
    assert!(address.ends_with(&format!(":{port}")), "{address}");
    let keypair = host_key(&world.data);
    assert_eq!(status(&serve)["machineId"], keypair.host_id().as_str());

    // The paired computer works the machine's workspace RPC.
    let mut macbook = computer(connect(port, &keypair.public_key_b64(), TOKEN).await);
    let hello = macbook.call("rpc.hello", json!({ "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1", "session/1", "pty/1"], "client": { "app": "terminalx-desktop" } })).await;
    assert_eq!(hello["ok"], true, "{hello}");
    let granted: Vec<String> = serde_json::from_value(hello["result"]["capabilities"].clone()).unwrap();
    assert!(granted.contains(&"machine/1".to_string()), "{granted:?}");
    let described = macbook.call("machine.describe", json!({})).await;
    assert_eq!(described["result"]["machineId"], keypair.host_id().as_str(), "{described}");
    let sessions = macbook.call("session.list", json!({})).await;
    assert_eq!(sessions["ok"], true, "{sessions}");
    assert!(sessions["result"]["sessions"].is_array());
    let connected = status(&serve);
    assert_eq!(connected["computers"][0]["connected"], true, "{connected}");
    assert!(connected["computers"][0]["lastSeenAt"].is_i64());

    // A token it does not know is refused as "Access removed".
    match connect(port, &keypair.public_key_b64(), "an-unknown-device-token-0000000000").await {
        Outcome::Refused(code) => assert_eq!(code, Some(4401)),
        Outcome::In(_) => panic!("an unknown token was let in"),
    }

    // A phone (any other path) goes to the window's route, byte for byte.
    let attachment = serve.control("runtime.attach", json!({ "protocol": 1 }));
    let route = world.data.join("run/phones.sock");
    let listener = UnixListener::bind(&route).unwrap();
    std::fs::set_permissions(&route, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
    serve.control("runtime.machineHost.phoneRoute", json!({ "epoch": attachment["epoch"], "lease": attachment["lease"], "socket": route }));
    let window = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut reader = BufReader::new(stream);
        let mut header = String::new();
        reader.read_line(&mut header).unwrap();
        let mut body = vec![0u8; "GET / HTTP/1.1\r\nHost: mac\r\n\r\nphone-bytes".len()];
        reader.read_exact(&mut body).unwrap();
        reader.get_mut().write_all(b"from-window").unwrap();
        (header, body)
    });
    {
        let mut phone = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        phone.write_all(b"GET / HTTP/1.1\r\nHost: mac\r\n\r\nphone-bytes").unwrap();
        phone.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut answer = [0u8; 11];
        phone.read_exact(&mut answer).unwrap();
        assert_eq!(&answer, b"from-window");
    }
    let (header, body) = window.join().unwrap();
    let header = raccoon_lib::machine_wire::decode_header(header.as_bytes()).unwrap();
    assert!(matches!(header, raccoon_lib::machine_wire::Forwarded::Direct { peer: Some(_) }), "{header:?}");
    assert_eq!(body, b"GET / HTTP/1.1\r\nHost: mac\r\n\r\nphone-bytes");

    // Revoking a computer closes its connection at once and refuses it after.
    serve.control("runtime.machineHost.revoke", json!({ "epoch": attachment["epoch"], "lease": attachment["lease"], "id": "macbook" }));
    assert!(macbook.closed().await, "a revoked computer's connection closes");
    drop(macbook);
    assert!(matches!(connect(port, &keypair.public_key_b64(), TOKEN).await, Outcome::Refused(Some(4401))));

    // Off again: every computer is disconnected and the port closes; the
    // records stay, so on again needs no new pairing.
    pair(&world.data, "studio", "studio-device-token-000000000000000", None);
    let mut studio = computer(connect(port, &keypair.public_key_b64(), "studio-device-token-000000000000000").await);
    allow(&world.data, false);
    assert!(studio.closed().await, "turning the switch off closes every computer's connection");
    // A socket still open on the port would keep it from being bound again.
    drop(studio);
    wait_until("the port to close", || std::net::TcpStream::connect(("127.0.0.1", port)).is_err().then_some(()));
    assert_eq!(status(&serve)["computers"].as_array().unwrap().len(), 1);
    allow(&world.data, true);
    // The closed connections hold the port in TIME_WAIT for up to 30 s.
    listening(&serve);
    assert_eq!(host_key(&world.data).host_id(), keypair.host_id(), "the key is never made again");
    let mut again = computer(connect(port, &keypair.public_key_b64(), "studio-device-token-000000000000000").await);
    assert_eq!(again.call("rpc.hello", json!({ "protocol": "terminalx-workspace-rpc/1", "want": ["machine/1"] })).await["ok"], true);
}

#[test]
fn a_runtime_hosting_computers_does_not_exit_when_idle() {
    let world = AgentWorld::new();
    let port = free_port();
    allow(&world.data, true);
    let mut command = world.machine_command();
    command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string()).args(["--idle-grace-seconds", "1"]);
    let mut serve = Serve::start(command, &world.data);
    listening(&serve);
    std::thread::sleep(Duration::from_secs(3));
    assert!(serve.child.try_wait().unwrap().is_none(), "a standing service with the switch on");
    allow(&world.data, false);
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while serve.child.try_wait().unwrap().is_none() {
        assert!(std::time::Instant::now() < deadline, "with the switch off, an idle runtime exits as before");
        std::thread::sleep(Duration::from_millis(100));
    }
}
