//! The real executable's early github-auth dispatch must load the Mac policy.
use std::io::{BufRead, Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[test]
fn github_auth_entrypoint_obeys_saved_privacy_and_restores_broker_access() {
    for enabled in [true, false] {
        let root = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let write = |name: &str, value: serde_json::Value| std::fs::write(root.path().join(name), value.to_string()).unwrap();
        write("data-privacy.json", serde_json::json!({"enabled":enabled}));
        write("runtime.json", serde_json::json!({"v":1,"workspaceId":"ws_1","organizationId":"org_1","relayHostId":"rh_1","tokenSha256":"fixture","runtimeCredential":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}));
        write("broker.json", serde_json::json!({"v":1,"origin":origin,"stateDir":root.path(),"cacheDir":null}));
        let stdout = std::fs::File::create(root.path().join("out")).unwrap();
        let stderr = std::fs::File::create(root.path().join("err")).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_terminalx-serve"))
            .args(["github-auth", "--dir"]).arg(root.path()).args(["token", "--repository", "acme/api"])
            .env("TERMINALX_HOME", root.path()).stdin(Stdio::null()).stdout(stdout).stderr(stderr).spawn().unwrap();
        let until = Instant::now() + Duration::from_secs(20);
        let mut requests = 0;
        let status = loop {
            match listener.accept() {
                Ok((mut socket, _)) => {
                    requests += 1;
                    assert!(!enabled, "the executable contacted the broker with saved privacy enabled");
                    socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                    let mut reader = std::io::BufReader::new(socket.try_clone().unwrap());
                    let mut line = String::new(); reader.read_line(&mut line).unwrap();
                    assert!(line.starts_with("POST /v1/cloud-workspace-bootstrap/github-token "));
                    let mut length = 0;
                    loop {
                        line.clear(); reader.read_line(&mut line).unwrap();
                        if line == "\r\n" { break; }
                        if let Some((key, value)) = line.split_once(':') {
                            if key.eq_ignore_ascii_case("content-length") { length = value.trim().parse::<usize>().unwrap(); }
                        }
                    }
                    let mut body = vec![0; length]; reader.read_exact(&mut body).unwrap();
                    assert_eq!(serde_json::from_slice::<serde_json::Value>(&body).unwrap()["repository"], "acme/api");
                    let expiry = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() + 3_600_000;
                    let reply = serde_json::json!({"v":1,"token":"ghs_privacy_fixture","expiresAt":expiry,"source":"github-app","repositories":["acme/api"],"permissions":{"contents":"write"}}).to_string();
                    write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len()).unwrap();
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {},
                Err(error) => panic!("broker listener: {error}"),
            }
            if let Some(status) = child.try_wait().unwrap() { break status; }
            if Instant::now() >= until { let _ = child.kill(); let _ = child.wait(); panic!("github-auth did not exit"); }
            std::thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(status.success(), !enabled, "{}", std::fs::read_to_string(root.path().join("err")).unwrap());
        assert_eq!(requests, usize::from(!enabled));
        assert_eq!(std::fs::read_to_string(root.path().join("out")).unwrap().trim(), if enabled { "" } else { "ghs_privacy_fixture" });
    }
}
