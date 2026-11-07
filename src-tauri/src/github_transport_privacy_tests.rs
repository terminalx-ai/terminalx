//! Actual authenticated bridge queues/handover and configured SSH subprocesses.
//! Called by the isolated personal/managed privacy entrypoint children.
use super::*;
use std::io::{BufRead, BufReader, Write};
use std::sync::Arc;
use serde_json::{json, Value};
use crate::{control::{ControlRequest, ControlResponse, ControlService}, hooks, local_runtime::{client::Client, sessions::Sessions, Lifetime}};

pub(super) fn run(root: &Path, fixture: &FetchFixture, managed: bool) {
    forwarding(root, fixture, managed);
    configured_ssh(root, fixture, managed);
    variants::run(root, fixture, managed);
    submodules::run(root, managed);
}

#[path = "github_ssh_variant_privacy_tests.rs"]
mod variants;

#[path = "github_submodule_privacy_tests.rs"]
mod submodules;

pub(super) fn service(root: &Path, endpoint: &hooks::ControlEndpoint) -> ControlService {
    let lifetime = Lifetime::new(Duration::from_secs(60));
    lifetime.set_stream_socket(root.join("run/unused-events.sock"));
    let sink = Arc::new(crate::sink::BroadcastSink::new(64));
    let manager = crate::session::SessionManager::new(sink.clone(), Arc::new(crate::sink::NoObserver),
        Arc::new(crate::harness::host::Host::new()), Arc::new(crate::pty::Terminals::new()), Arc::new(Default::default()),
        Arc::new(Default::default()), endpoint.clone());
    ControlService::headless(sink, manager, endpoint.clone(), "local".into()).with_local_lifetime(lifetime)
}

pub(super) fn control(endpoint: &hooks::ControlEndpoint, token: &str, command: &str, params: Value) -> ControlResponse {
    let mut stream = std::os::unix::net::UnixStream::connect(&endpoint.socket).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let request = ControlRequest { id: uuid::Uuid::new_v4().to_string(), token: token.into(), command: command.into(), params };
    writeln!(stream, "{}", serde_json::to_string(&request).unwrap()).unwrap();
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).unwrap();
    let response: ControlResponse = serde_json::from_str(&line).unwrap();
    assert_eq!(response.id, request.id);
    response
}

fn preference(enabled: bool, managed: bool) {
    if enabled && managed { std::env::set_var("TERMINALX_TEST_MANAGED_PRIVACY", "1"); }
    else { std::env::remove_var("TERMINALX_TEST_MANAGED_PRIVACY"); }
    store::write_json(&store::root().unwrap().join("data-privacy.json"), &json!({"enabled":enabled && !managed})).unwrap();
}

pub(super) fn acknowledge(endpoint: &hooks::ControlEndpoint, enabled: bool, managed: bool) {
    preference(enabled, managed);
    let response = control(endpoint, &endpoint.token, "runtime.dataPrivacy.refresh", json!({}));
    assert!(response.ok, "{response:?}");
    assert_eq!(response.result.unwrap()["enabled"], enabled);
}

fn scan(client: &Arc<Client>, fixture: &FetchFixture) -> Value {
    Sessions::new(client.clone()).workspace("scan", json!({"projectPaths":[fixture.project]})).unwrap()
}

fn scanned(value: &Value, fixture: &FetchFixture, verified: bool) {
    let candidate = value.as_array().unwrap().iter().flat_map(|project| project["candidates"].as_array().unwrap())
        .find(|candidate| candidate["path"] == fixture.worktree.to_str().unwrap()).unwrap();
    assert!(candidate["branch"].is_string() && candidate["head"].is_string(), "local facts survive: {candidate}");
    assert_eq!(candidate["verdict"], "unpushed", "unique local work must remain: {candidate}");
    let reason = candidate["reason"].as_str().unwrap();
    if verified { assert!(reason.contains("not merged into origin/main"), "{reason}"); }
    else { assert!(reason.contains("could not be verified"), "{reason}"); }
    assert!(fixture.worktree.exists());
}

fn forwarding(root: &Path, fixture: &FetchFixture, managed: bool) {
    // Force cleanup's lazy Fresh fetch, without deleting this worktree: it has
    // a real unpushed change that remains unmerged even after a successful fetch.
    std::fs::write(fixture.worktree.join("private-work.txt"), "keep this work\n").unwrap();
    real_git(&fixture.worktree, &["add", "private-work.txt"]);
    real_git(&fixture.worktree, &["commit", "-qm", "Unpushed private work"]);
    policy(false, managed);
    let endpoint = hooks::prepare_control().unwrap();
    let owner = service(root, &endpoint);
    let (_, mut bridge) = hooks::serve(endpoint.clone(), |_| hooks::HookReply::default(), move |request| owner.handle(request)).unwrap();
    let mut client = Client::connect(root).unwrap();
    assert_eq!(control(&endpoint, "wrong-token", "runtime.session.workspace", json!({})).error.unwrap().code, "unauthorized");
    let before = launches(root);
    scanned(&scan(&client, fixture), fixture, true);
    assert!(launches(root) > before, "a fresh forwarded scan must fetch through the owner");

    // The production Sessions -> Client path has already captured/serialized
    // positive authority. Acknowledge on/off through the authenticated bridge
    // while that real frame is paused before connection/admission.
    let (arrived_tx, arrived_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    *crate::local_runtime::client::BEFORE_WORKSPACE_SEND.lock().unwrap() = Some(Box::new(move || {
        arrived_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    }));
    let before = launches(root);
    std::thread::scope(|scope| {
        let worker = scope.spawn(super::super::queued(|| scan(&client, fixture)));
        arrived_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        acknowledge(&endpoint, true, managed);
        acknowledge(&endpoint, false, managed);
        // Even updating the cache cannot replace the stamp already captured.
        client.refresh_data_privacy().unwrap();
        release_tx.send(()).unwrap();
        scanned(&worker.join().unwrap(), fixture, false);
    });
    assert_eq!(launches(root), before, "delayed authenticated frame renewed authority");
    scanned(&scan(&client, fixture), fixture, true);
    assert!(launches(root) > before);

    acknowledge(&endpoint, true, managed);
    client.refresh_data_privacy().unwrap();
    let before = launches(root);
    scanned(&scan(&client, fixture), fixture, false);
    assert_eq!(launches(root), before);
    acknowledge(&endpoint, false, managed);
    client.refresh_data_privacy().unwrap();

    // A second real authenticated endpoint can acknowledge policy while the
    // first bridge is frozen. No direct call substitutes for the socket path.
    let admin = hooks::prepare_control().unwrap();
    let owner = service(root, &admin);
    let (_, _admin_bridge) = hooks::serve(admin.clone(), |_| hooks::HookReply::default(), move |request| owner.handle(request)).unwrap();
    for cycle in [true, false] {
        bridge.freeze(Duration::from_secs(5)).unwrap();
        let (written_tx, written_rx) = std::sync::mpsc::channel();
        *crate::local_runtime::client::AFTER_WORKSPACE_WRITE.lock().unwrap() = Some(Box::new(move || { written_tx.send(()).unwrap(); }));
        let before = launches(root);
        std::thread::scope(|scope| {
            let worker = scope.spawn(super::super::queued(|| scan(&client, fixture)));
            written_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            let frozen = bridge.take(|_| false).unwrap();
            assert!(frozen.held.is_empty() && frozen.parked.is_empty(), "this case must be an UNREAD listener backlog, not an already-read held frame");
            if cycle {
                acknowledge(&admin, true, managed);
                acknowledge(&admin, false, managed);
            }
            let replacement = hooks::ControlEndpoint::adopted(endpoint.socket.clone(), endpoint.token.clone());
            let owner = service(root, &replacement);
            let adopted = hooks::Adopted { own: frozen.own, published: frozen.published, held: Vec::new() };
            let (_, next) = hooks::serve_adopted(replacement, adopted, |_| hooks::HookReply::default(), move |request| owner.handle(request)).unwrap();
            next.thaw();
            scanned(&worker.join().unwrap(), fixture, false);
            bridge = next;
        });
        assert_eq!(launches(root), before, "unread handover request gained replacement authority (cycle={cycle})");
        client = Client::connect(root).unwrap();
        scanned(&scan(&client, fixture), fixture, true);
        assert!(launches(root) > before, "fresh request after handover must restore");
    }
    // Explicit denial cannot be overridden by an otherwise valid stamp.
    let authority = data_privacy::Ticket::default().forwarded(client.epoch());
    let before = launches(root);
    let response = control(&endpoint, &endpoint.token, "runtime.session.workspace", json!({
        "operation":"scan", "params":{"projectPaths":[fixture.project]}, "networkAuthority":authority, "networkAllowed":false
    }));
    assert!(response.ok);
    scanned(&response.result.unwrap(), fixture, false);
    assert_eq!(launches(root), before);
}

fn ssh_launches(root: &Path) -> usize {
    std::fs::read_to_string(root.join("ssh-launches")).unwrap_or_default().lines().count()
}

struct UnrelatedTransport(std::process::Child);
impl Drop for UnrelatedTransport {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

fn configured_ssh(root: &Path, fixture: &FetchFixture, managed: bool) {
    use std::os::unix::{fs::PermissionsExt, process::CommandExt};
    let saved: Vec<_> = ["GIT_SSH_COMMAND", "GIT_SSH", "GIT_SSH_VARIANT"].into_iter().map(|name| (name, std::env::var_os(name))).collect();
    for (name, _) in &saved { std::env::remove_var(name); }
    let wrapper = root.join("configured ssh wrapper");
    std::fs::write(&wrapper, r#"#!/bin/sh
if [ "$1" = --unrelated ]; then exec /bin/sleep 300; fi
printf '%s\n' "$$" >> "$TERMINALX_HOME/ssh-launches"
printf '%s\n' "$0" "$@" >> "$TERMINALX_HOME/ssh-arguments"
# The wrapper's own identity/proxy configuration is retained too.
printf 'wrapper-identity-kept\n' >> "$TERMINALX_HOME/ssh-arguments"
for arg do
 if [ "$arg" = -G ]; then printf 'hostname fixture.invalid\nuser configured-user\nport 2222\nproxycommand none\nproxyjump none\nforkafterauthentication no\npermitlocalcommand no\n'; exit 0; fi
 last="$arg"
done
if [ -f "$TERMINALX_HOME/hold-ssh" ]; then
 : > "$TERMINALX_HOME/held-$$"
 exec /bin/sleep 30
fi
# The remote command is Git's actual upload-pack invocation, against the real
# local bare fixture. This exercises Git's configured SSH transport selection
# and protocol without connecting to a live provider.
exec /bin/sh -c "$last"
"#).unwrap();
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let socket_path = root.join("unrelated-control.sock");
    let unrelated_socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    unrelated_socket.set_nonblocking(true).unwrap();
    let mut unrelated = UnrelatedTransport(Command::new(&wrapper).arg("--unrelated").process_group(0).spawn().unwrap());
    let quote = |value: &str| format!("'{}'", value.replace('\'', "'\\''"));
    let command = format!("{} -i {} -p 2222 -o ControlMaster=auto -o ControlPersist=yes -S {}",
        quote(wrapper.to_str().unwrap()), quote("/configured/key with spaces"), quote(socket_path.to_str().unwrap()));
    let remote = root.join("fetch-origin.git");
    real_git(&fixture.project, &["remote", "set-url", "origin", &format!("ssh://configured-user@fixture.invalid{}", remote.display())]);
    let fetch = || {
        let (base, why, fresh) = crate::landed::base_for(&fixture.project, crate::landed::Fetch::Fresh);
        assert_eq!(base.as_deref(), Some("origin/main"), "local base remains available");
        if !fresh { assert!(why.unwrap().contains(data_privacy::MESSAGE)); }
        fresh
    };
    for setting in ["core", "command", "path"] {
        println!("privacy configured SSH: managed={managed}/{setting}");
        std::env::remove_var("GIT_SSH_COMMAND");
        std::env::remove_var("GIT_SSH");
        let _ = Command::new("/usr/bin/git").current_dir(&fixture.project).args(["config", "--unset", "core.sshCommand"]).status();
        match setting {
            "core" => {
                real_git(&fixture.project, &["config", "core.sshCommand", &command]);
                // core.sshCommand must keep its precedence over GIT_SSH.
                std::env::set_var("GIT_SSH", "/nonexistent/lower-priority-wrapper");
            }
            "command" => {
                real_git(&fixture.project, &["config", "core.sshCommand", "/nonexistent/lower-priority-command"]);
                std::env::set_var("GIT_SSH_COMMAND", &command);
                std::env::set_var("GIT_SSH", "/nonexistent/lower-priority-wrapper");
            }
            "path" => { std::env::set_var("GIT_SSH", &wrapper); }
            _ => unreachable!(),
        }
        std::fs::write(root.join("ssh-arguments"), "").unwrap();
        policy(false, managed);
        let expected = fixture.advance();
        assert!(fetch(), "normal configured {setting} fetch failed");
        assert_eq!(real_git(&fixture.project, &["rev-parse", "origin/main"]), expected);
        let arguments = std::fs::read_to_string(root.join("ssh-arguments")).unwrap();
        assert!(arguments.contains(wrapper.to_str().unwrap()) && arguments.contains("wrapper-identity-kept"));
        assert!(arguments.contains("-S\nnone\n"), "disable sharing without replacing the configured transport: {arguments}");
        assert!(arguments.contains("configured-user@fixture.invalid"));
        if setting != "path" {
            assert!(arguments.contains("-i\n/configured/key with spaces\n-p\n2222\n"), "identity and port changed: {arguments}");
            assert!(arguments.contains("ProxyCommand=none"));
            assert!(arguments.contains(socket_path.to_str().unwrap()), "configured arguments are preserved; final -S none overrides only sharing");
        }
        let before = ssh_launches(root);
        policy(true, managed);
        assert!(!fetch());
        assert_eq!(ssh_launches(root), before, "enabled policy launched configured SSH");
        policy(false, managed);
        let stale = super::super::queued(fetch);
        policy(true, managed);
        policy(false, managed);
        assert!(!stale());
        assert_eq!(ssh_launches(root), before, "stale configured SSH request revived");

        std::fs::write(root.join("hold-ssh"), "").unwrap();
        std::thread::scope(|scope| {
            let worker = scope.spawn(super::super::queued(fetch));
            let until = Instant::now() + Duration::from_secs(10);
            while held(root).is_empty() {
                assert!(!worker.is_finished());
                assert!(Instant::now() < until, "configured SSH never reached physical transfer");
                std::thread::sleep(Duration::from_millis(5));
            }
            cancel_fetch(root, managed);
            assert!(!worker.join().unwrap());
        });
        assert!(unrelated.0.try_wait().unwrap().is_none(), "cancellation killed an unrelated transport process");
        assert!(matches!(unrelated_socket.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock));
        std::fs::remove_file(root.join("hold-ssh")).unwrap();
        for pid in held(root) { std::fs::remove_file(root.join(format!("held-{pid}"))).unwrap(); }
        let cancelled = ssh_launches(root);
        policy(false, managed);
        assert_eq!(ssh_launches(root), cancelled);
        let expected = fixture.advance();
        assert!(fetch(), "restored configured {setting} fetch failed");
        assert_eq!(real_git(&fixture.project, &["rev-parse", "origin/main"]), expected);
        assert!(ssh_launches(root) > cancelled);
    }
    // Check OpenSSH's actual parsing of explicit multiplexing settings. The
    // final -S wins even though -o values are first-wins; -G never connects.
    let parsed = Command::new("/usr/bin/ssh").args(["-G", "-F", "/dev/null", "-o", "ControlMaster=auto", "-o", "ControlPersist=yes", "-S"])
        .arg(&socket_path).args(["-S", "none", "fixture.invalid"]).output().unwrap();
    assert!(parsed.status.success());
    let config = String::from_utf8(parsed.stdout).unwrap();
    assert!(!config.lines().any(|line| line.starts_with("controlpath ") && line != "controlpath none"), "{config}");
    drop(unrelated);
    real_git(&fixture.project, &["remote", "set-url", "origin", remote.to_str().unwrap()]);
    let _ = Command::new("/usr/bin/git").current_dir(&fixture.project).args(["config", "--unset", "core.sshCommand"]).status();
    for (name, value) in saved {
        if let Some(value) = value { std::env::set_var(name, value); } else { std::env::remove_var(name); }
    }
}
