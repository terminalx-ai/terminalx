//! Wire-level transport regressions. Native owner integration remains separately
//! held: these tests do not certify SessionManager queue/callback coverage.
use super::*;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, mpsc};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use crate::remote::collab::{Collaboration, v2::{Action as Right, Permit, Snapshot}};

const WAIT: Duration = Duration::from_secs(3);

fn policy() -> (Arc<Collaboration>, tempfile::TempDir) {
    let policy = Arc::new(Collaboration::new());
    let dir = tempfile::tempdir().unwrap();
    policy.runtime_policy.bind(dir.path(), 1).unwrap();
    install(&policy, "1", "explicit");
    (policy, dir)
}

fn install(policy: &Collaboration, revision: &str, source: &str) {
    let snapshot: Snapshot = serde_json::from_value(json!({"v":2,"revision":revision,"members":[
        {"userId":"original","role":"driver","canApprove":true,"writeSource":source}
    ]})).unwrap();
    policy.install_v2(snapshot).unwrap();
}

fn original(policy: &Arc<Collaboration>) -> Permit {
    Permit::new(policy.clone(), "original", policy.runtime_policy.stamp("original"), Right::Drive)
}

// Physical peer records the actual bytes, even when they are only a prefix.
// EOF is the client retiring its one connection, not a synthetic request log.
fn server(reply: &'static [u8]) -> (String, mpsc::Receiver<Vec<u8>>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/session", listener.local_addr().unwrap());
    let (sent, received) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0; 4096];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    bytes.extend_from_slice(&buffer[..n]);
                    if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]);
                        let length: usize = header.lines().find_map(|line| line.strip_prefix("Content-Length: ")).unwrap().parse().unwrap();
                        if bytes.len() == end + 4 + length {
                            stream.write_all(reply).unwrap();
                            break;
                        }
                    }
                }
                Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => break,
                Err(e) => panic!("loopback read: {e}"),
            }
        }
        sent.send(bytes).unwrap();
    });
    (url, received, worker)
}

fn admitted(attempt: &mut dyn FnMut() -> std::io::Result<usize>) -> WriteAdmission {
    let _ = attempt();
    WriteAdmission::Admitted
}

#[test]
fn phase2_opencode_collaboration_revoked_original_at_physical_barrier_sends_zero_bytes() {
    let (policy, _dir) = policy();
    let permit = original(&policy);
    let (url, bytes, peer) = server(b"");
    let (arrived, held) = mpsc::channel();
    let (resume, release) = mpsc::channel();
    let dispatch = std::thread::spawn(move || bounded_http("POST", &url, Some(&json!({})), WAIT, || true, |attempt| {
        arrived.send(()).unwrap();
        release.recv_timeout(WAIT).unwrap(); // barrier BEFORE acquiring policy
        let _admission = permit.collaboration.enter_admission();
        if permit.check(None).is_err() { return WriteAdmission::Refused; }
        admitted(attempt)
    }));
    held.recv_timeout(WAIT).unwrap();
    install(&policy, "2", "explicit");
    resume.send(()).unwrap();
    assert_eq!(dispatch.join().unwrap(), PhysicalOutcome::Refused);
    assert!(bytes.recv_timeout(WAIT).unwrap().is_empty());
    peer.join().unwrap();
}

#[test]
fn phase2_opencode_collaboration_partial_revocation_has_no_remainder_or_replay() {
    let (policy, _dir) = policy();
    let permit = original(&policy);
    let (url, bytes, peer) = server(b"");
    let (arrived, held) = mpsc::channel();
    let (resume, release) = mpsc::channel();
    let dispatch = std::thread::spawn(move || {
        let mut attempts = 0;
        bounded_http("POST", &url, Some(&json!({"text":"x".repeat(32768)})), WAIT, || true, |attempt| {
            attempts += 1;
            if attempts == 2 { arrived.send(()).unwrap(); release.recv_timeout(WAIT).unwrap(); }
            let _admission = permit.collaboration.enter_admission();
            if permit.check(None).is_err() { return WriteAdmission::Refused; }
            admitted(attempt)
        })
    });
    held.recv_timeout(WAIT).unwrap();
    // Updating policy can finish while the transport is between capacity attempts.
    install(&policy, "2", "everyone");
    resume.send(()).unwrap();
    assert_eq!(dispatch.join().unwrap(), PhysicalOutcome::Unknown);
    let observed = bytes.recv_timeout(WAIT).unwrap();
    assert!(!observed.is_empty() && observed.len() <= 4096, "{} bytes", observed.len());
    assert!(observed.starts_with(b"POST /session HTTP/1.1\r\n"));
    peer.join().unwrap();
}

#[test]
fn phase2_opencode_collaboration_deferred_capacity_releases_policy_before_retry() {
    let (policy, _dir) = policy();
    let permit = original(&policy);
    let (url, bytes, peer) = server(b"");
    let (arrived, held) = mpsc::channel();
    let (resume, release) = mpsc::channel();
    let dispatch = std::thread::spawn(move || {
        let mut first = true;
        bounded_http("POST", &url, Some(&json!({})), WAIT, || true, |attempt| {
            if first {
                first = false;
                { let _admission = permit.collaboration.enter_admission(); }
                arrived.send(()).unwrap();
                release.recv_timeout(WAIT).unwrap();
                return WriteAdmission::Deferred;
            }
            let _admission = permit.collaboration.enter_admission();
            if permit.check(None).is_err() { return WriteAdmission::Refused; }
            admitted(attempt)
        })
    });
    held.recv_timeout(WAIT).unwrap();
    install(&policy, "2", "explicit");
    resume.send(()).unwrap();
    assert_eq!(dispatch.join().unwrap(), PhysicalOutcome::Refused);
    assert!(bytes.recv_timeout(WAIT).unwrap().is_empty());
    peer.join().unwrap();
}

#[test]
fn phase2_opencode_collaboration_explicit_original_survives_unrelated_everyone_tls() {
    let (policy, _dir) = policy();
    let permit = original(&policy);
    let unrelated = Arc::new(Collaboration::new());
    let dir = tempfile::tempdir().unwrap();
    unrelated.runtime_policy.bind(dir.path(), 1).unwrap();
    install(&unrelated, "1", "everyone");
    let tls = original(&unrelated);
    assert!(tls.check(None).is_err(), "OpenCode Everyone witness stays unsupported");
    let (url, bytes, peer) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"id\":\"s1\"}");
    let result = tls.with(|| bounded_http("POST", &url, Some(&json!({"source":"original"})), WAIT, || true, |attempt| {
        let _admission = permit.collaboration.enter_admission();
        if permit.check(None).is_err() { return WriteAdmission::Refused; }
        admitted(attempt)
    }));
    assert_eq!(result, PhysicalOutcome::Response { status: 200, body: json!({"id":"s1"}) });
    let observed = bytes.recv_timeout(WAIT).unwrap();
    assert!(String::from_utf8(observed).unwrap().ends_with("{\"source\":\"original\"}"));
    peer.join().unwrap();
}

#[test]
fn phase2_opencode_collaboration_cancel_during_response_is_unknown() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/session", listener.local_addr().unwrap());
    let current = Arc::new(AtomicBool::new(true));
    let live = current.clone();
    let (arrived, held) = mpsc::channel();
    let (resume, release) = mpsc::channel();
    let peer = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        let mut buffer = [0; 4096];
        let n = stream.read(&mut buffer).unwrap();
        assert!(buffer[..n].starts_with(b"POST /session HTTP/1.1\r\n"));
        arrived.send(()).unwrap();
        release.recv_timeout(WAIT).unwrap();
    });
    let worker = std::thread::spawn(move || bounded_http("POST", &url, Some(&json!({})), WAIT,
        || live.load(Ordering::SeqCst), admitted));
    held.recv_timeout(WAIT).unwrap();
    current.store(false, Ordering::SeqCst);
    assert_eq!(worker.join().unwrap(), PhysicalOutcome::Unknown);
    resume.send(()).unwrap();
    peer.join().unwrap();
}

#[test]
fn phase2_opencode_collaboration_truncated_response_is_unknown_no_fallback() {
    let (url, bytes, peer) = server(b"HTTP/1.1 200 OK\r\nContent-Length: 99\r\n\r\n{}");
    assert_eq!(bounded_http("POST", &url, Some(&json!({})), WAIT, || true, admitted), PhysicalOutcome::Unknown);
    assert!(!bytes.recv_timeout(WAIT).unwrap().is_empty());
    peer.join().unwrap();
}

#[test]
fn phase2_opencode_collaboration_non_loopback_refused_before_gate() {
    assert_eq!(bounded_http("POST", "http://localhost:1234/session", None, WAIT, || true,
        |_| panic!("no write for unsupported destination")), PhysicalOutcome::Refused);
}

#[test]
fn phase2_opencode_collaboration_real_socket_capacity_wait_rechecks_original() {
    let (policy, _dir) = policy();
    let permit = original(&policy);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/session", listener.local_addr().unwrap());
    let (accepted, connected) = mpsc::channel();
    let (drain, draining) = mpsc::channel();
    let peer = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        // Hold the peer's actual receive window shut until the client observes
        // WouldBlock. This is not a synthetic capacity/defer flag.
        socket2::SockRef::from(&stream).set_recv_buffer_size(4096).unwrap();
        accepted.send(()).unwrap();
        draining.recv_timeout(WAIT).unwrap();
        stream.set_read_timeout(Some(WAIT)).unwrap();
        let mut observed = Vec::new();
        stream.read_to_end(&mut observed).unwrap();
        observed
    });
    let (arrived, held) = mpsc::channel();
    let (resume, release) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let mut paused = false;
        bounded_http("POST", &url, Some(&json!({"text":"x".repeat(7 * 1024 * 1024)})), WAIT, || true, |attempt| {
            let result = {
                let _admission = permit.collaboration.enter_admission();
                if permit.check(None).is_err() { return WriteAdmission::Refused; }
                attempt()
            }; // ALL policy guards released before the real capacity barrier
            if !paused && result.as_ref().is_err_and(|e| e.kind() == std::io::ErrorKind::WouldBlock) {
                paused = true;
                arrived.send(()).unwrap();
                release.recv_timeout(WAIT).unwrap();
            }
            WriteAdmission::Admitted
        })
    });
    connected.recv_timeout(WAIT).unwrap();
    held.recv_timeout(WAIT).unwrap();
    install(&policy, "2", "explicit");
    resume.send(()).unwrap();
    assert_eq!(worker.join().unwrap(), PhysicalOutcome::Unknown);
    drain.send(()).unwrap();
    let observed = peer.join().unwrap();
    assert!(!observed.is_empty() && observed.len() < 7 * 1024 * 1024);
}

fn event_pump_after_revocation(retire_before_delivery: bool) {
    let (policy, _dir) = policy();
    let permit = original(&policy);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let (arrived, held) = mpsc::channel();
    let (resume, release) = mpsc::channel();
    let peer = std::thread::spawn(move || {
        // Real readiness GET, then a real SSE connection held across revision.
        for path in ["/session", "/event"] {
            let (mut stream, _) = listener.accept().unwrap();
            stream.set_read_timeout(Some(WAIT)).unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                assert_eq!(stream.read(&mut byte).unwrap(), 1);
                request.push(byte[0]);
            }
            assert!(String::from_utf8(request).unwrap().starts_with(&format!("GET {path} HTTP/1.1\r\n")));
            if path == "/session" {
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]").unwrap();
            } else {
                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").unwrap();
                arrived.send(()).unwrap();
                release.recv_timeout(WAIT).unwrap();
                stream.write_all(b"data: {\"type\":\"local-output\",\"text\":\"local B\"}\n\n").unwrap();
            }
        }
    });
    let live = Arc::new(AtomicBool::new(true));
    let alive = live.clone();
    let retired = live.clone();
    let (emit, emitted) = mpsc::channel();
    let pump = std::thread::spawn(move || pump_events(&base,
        || alive.load(Ordering::SeqCst),
        |line| { emit.send(line).unwrap(); retired.store(false, Ordering::SeqCst); }));
    held.recv_timeout(WAIT).unwrap();
    install(&policy, "2", "explicit");
    assert!(permit.check(None).is_err());
    if retire_before_delivery { live.store(false, Ordering::SeqCst); }
    resume.send(()).unwrap();
    pump.join().unwrap();
    if retire_before_delivery {
        assert!(emitted.recv_timeout(WAIT).is_err(), "retired read callback emitted stale bytes");
    } else {
        let line = emitted.recv_timeout(WAIT).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap()["text"], "local B");
    }
    peer.join().unwrap();
}

#[test]
fn phase2_opencode_collaboration_read_only_event_survives_old_drive_revocation() {
    event_pump_after_revocation(false);
}

#[test]
fn phase2_opencode_collaboration_event_read_retired_before_delivery_never_calls_emit() {
    event_pump_after_revocation(true);
}
