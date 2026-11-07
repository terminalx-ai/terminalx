//! Real public identity/issue calls against observed gh/ssh executables. Each
//! policy scenario runs in an isolated process, including the managed override.
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use crate::{data_privacy, github_identity, issue_ops, issues, store};

const OPERATIONS: &[&str] = &["ssh", "https", "list", "legacy-read", "legacy-write", "details", "write", "repositories", "overview", "disposition"];

#[test]
fn privacy_covers_identity_and_issue_entry_points() {
    for managed in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "github_process::tests::privacy_entry_points_child", "--nocapture"])
            .env("TERMINALX_TEST_GITHUB_ENTRIES", if managed { "managed" } else { "personal" })
            .env("TERMINALX_HOME", root.path()).output().unwrap();
        assert!(output.status.success(), "policy={managed}\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
}

fn policy(enabled: bool, managed: bool) {
    if enabled && managed { std::env::set_var("TERMINALX_TEST_MANAGED_PRIVACY", "1"); }
    else { std::env::remove_var("TERMINALX_TEST_MANAGED_PRIVACY"); }
    store::write_json(&store::root().unwrap().join("data-privacy.json"), &serde_json::json!({"enabled":enabled && !managed})).unwrap();
    let status = data_privacy::refresh();
    assert_eq!(status.enabled, enabled);
    assert_eq!(status.managed, enabled && managed);
}

fn invoke(operation: &str, cwd: &Path) -> bool {
    match operation {
        "ssh" | "https" => {
            // Real local git config remains available on both policy settings.
            let answer = github_identity::identity(cwd, true);
            assert_eq!(answer.email.as_deref(), Some("local@example.test"));
            assert_eq!(answer.repo.as_deref(), Some("privacy/fixture"));
            assert_eq!(answer.remote_host.as_deref(), Some("github"));
            answer.login.as_deref() == Some("privacy-reader")
        }
        "list" => issues::github_list(cwd, &issues::IssueFilter::default()).is_ok(),
        "legacy-read" => issues::github_details(cwd, "7").is_ok(),
        "legacy-write" => issues::github_comment(cwd, "privacy/fixture", 7, "hello").is_ok(),
        "details" => issue_ops::github::details(cwd, "privacy/fixture", "7").is_ok(),
        // Exceed the pipe capacity: cancellation must work even when gh never
        // reads a body, not only while waiting for a short read-only request.
        "write" => issue_ops::github::set_title(cwd, "privacy/fixture", "7", &"x".repeat(2 * 1024 * 1024)).is_ok(),
        "overview" => overview_network(crate::project_overview::overview(cwd)),
        "disposition" => disposition_network(crate::session_ops::workspace_disposition(cwd, cwd, false).unwrap()),
        "repositories" => matches!(crate::project_start::github_repositories(), crate::project_start::GithubRepositories::Ready { .. }),
        _ => panic!("unknown operation {operation}"),
    }
}

fn overview_network(answer: crate::project_overview::ProjectOverview) -> bool {
    assert!(answer.branches.iter().any(|branch| branch.name == "main"), "local branch metadata survives refusal");
    assert!(!answer.contributors.is_empty(), "local commit metadata survives refusal");
    if answer.pull_requests.is_none() { assert_eq!(answer.pull_request_note.as_deref(), Some(data_privacy::MESSAGE)); }
    answer.pull_requests.is_some()
}

fn disposition_network(answer: crate::workspaces::WorkspaceDisposition) -> bool {
    assert!(answer.exists && answer.checked && answer.is_main);
    assert_eq!(answer.branch.as_deref(), Some("main"));
    answer.pr_checked
}

fn launches(root: &Path) -> usize {
    std::fs::read_to_string(root.join("launches")).unwrap_or_default().lines().count()
}

fn held(root: &Path) -> Vec<i32> {
    std::fs::read_dir(root).unwrap().flatten().filter_map(|entry| {
        entry.file_name().to_str()?.strip_prefix("held-")?.parse().ok()
    }).collect()
}

fn fixture(root: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
    use std::os::unix::fs::PermissionsExt;
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = r#"#!/bin/sh
printf '%s %s\n' "${0##*/}" "$*" >> "$TERMINALX_HOME/launches"
# auth token reads local gh credentials; the network boundary is api below.
case "$*" in
 'auth token '*) printf 'local-fixture-token\n'; exit 0 ;;
esac
hold=''
if [ -f "$TERMINALX_HOME/hold" ]; then read -r hold < "$TERMINALX_HOME/hold"; fi
case "$hold:$*" in
 all:*|write:*' -X PATCH '*)
   : > "$TERMINALX_HOME/held-$$"
   exec /bin/sleep 30 ;;
esac
case "${0##*/}" in
 ssh) printf "Hi privacy-reader! You've successfully authenticated.\n" >&2; exit 1 ;;
esac
case "$*" in
 'auth status '*) printf 'Logged in to github.com account privacy-reader\n  Active account: true\n'; exit 0 ;;
esac
for arg do
 if [ "$arg" = '--input' ]; then /bin/cat > /dev/null; fi
done
case "$*" in
 *' repos/privacy/fixture '*|*' repos/privacy/fixture') printf '{"full_name":"privacy/fixture","permissions":{"push":true}}\n' ;;
 *' user/repos?'*) printf '{"nameWithOwner":"privacy/fixture","isPrivate":true}\n' ;;
 'pr list '*) printf '[{"number":7,"title":"Privacy fixture","state":"OPEN","isDraft":false,"headRefName":"main","baseRefName":"develop","url":"https://github.com/privacy/fixture/pull/7"}]\n' ;;
 'pr view '*) printf '{"number":7,"title":"Privacy fixture","state":"MERGED","isDraft":false,"headRefName":"main","baseRefName":"develop","url":"https://github.com/privacy/fixture/pull/7"}\n' ;;
 'pr ready '*) printf 'temporary network failure\n' >&2; exit 1 ;;
 'issue list '*) printf '[]\n' ;;
 *'repos/privacy/fixture/issues -f '*) printf '[]\n' ;;
 'issue comment '*) printf 'https://github.com/privacy/fixture/issues/7#issuecomment-1\n' ;;
 *) printf '{"number":7,"title":"Privacy fixture","state":"open","html_url":"https://github.com/privacy/fixture/issues/7"}\n' ;;
esac
"#;
    for tool in ["ssh", "gh"] {
        let path = bin.join(tool);
        std::fs::write(&path, script).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    // Local Git operations execute the real git. Only its app-owned network
    // verbs are observed substitutes, so metadata assertions exercise Git too.
    let git = bin.join("git");
    std::fs::write(&git, r#"#!/bin/sh
case "$1" in
 fetch|pull|push|ls-remote)
   printf 'git %s\n' "$*" >> "$TERMINALX_HOME/launches"
   if [ -f "$TERMINALX_HOME/hold" ]; then
     : > "$TERMINALX_HOME/held-$$"
     exec /bin/sleep 30
   fi
   exit 0 ;;
 *) exec /usr/bin/git "$@" ;;
esac
"#).unwrap();
    std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
    // Resolve only these observed substitutes, before binpath caches anything.
    assert!(crate::binpath::set_priority_dir(&bin));
    std::env::set_var("PATH", format!("{}:/usr/bin:/bin", bin.display()));
    let mut paths = Vec::new();
    for (name, remote) in [("ssh-project", "git@github.com:privacy/fixture.git"), ("https-project", "https://github.com/privacy/fixture.git")] {
        let cwd = root.join(name);
        std::fs::create_dir_all(&cwd).unwrap();
        for args in [vec!["init", "-q", "-b", "main"], vec!["config", "user.email", "local@example.test"], vec!["config", "user.name", "Privacy Fixture"], vec!["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "Local metadata"], vec!["remote", "add", "origin", remote]] {
            assert!(Command::new("/usr/bin/git").current_dir(&cwd).args(args).status().unwrap().success());
        }
        paths.push(cwd);
    }
    (paths.remove(0), paths.remove(0))
}

#[test]
fn privacy_entry_points_child() {
    let Ok(kind) = std::env::var("TERMINALX_TEST_GITHUB_ENTRIES") else { return };
    let managed = kind == "managed";
    let root = store::root().unwrap();
    let (ssh, https) = fixture(&root);
    policy(true, managed);
    // Agent-owned executables are not globally intercepted: the same observed
    // gh remains runnable outside the app's request boundary while privacy is on.
    let direct = Command::new(root.join("bin/gh")).args(["auth", "status", "--hostname", "github.com"]).output().unwrap();
    assert!(direct.status.success());
    assert!(String::from_utf8_lossy(&direct.stdout).contains("privacy-reader"));
    let templates = ssh.join(".github/ISSUE_TEMPLATE");
    std::fs::create_dir_all(&templates).unwrap();
    std::fs::write(templates.join("bug.md"), "---\nname: Bug\nabout: Describe a problem\n---\nLocal template").unwrap();
    assert_eq!(issue_ops::templates::load(&ssh).unwrap().len(), 1);
    for operation in OPERATIONS {
        println!("privacy identity/issues: {kind}/{operation}");
        let cwd = if *operation == "https" { &https } else { &ssh };
        policy(true, managed);
        let before = launches(&root);
        assert!(!invoke(operation, cwd), "{operation} allowed while enabled");
        assert_eq!(launches(&root), before, "{operation} spawned while enabled");
        assert_eq!(issues::github_repo(cwd).as_deref(), Some("privacy/fixture"));

        policy(false, managed);
        // This is the queue wrapper used by the UI command and RPC dispatchers.
        // It captures before dispatch and invokes the real operation afterwards.
        let stale = super::queued(|| invoke(operation, cwd));
        policy(true, managed);
        policy(false, managed);
        assert!(!stale(), "{operation} revived from a stale queue");
        assert_eq!(launches(&root), before, "stale {operation} spawned after off/on");

        std::fs::write(root.join("hold"), if *operation == "write" { "write\n" } else { "all\n" }).unwrap();
        let worker = std::thread::spawn({
            let operation = operation.to_string();
            let cwd = cwd.to_path_buf();
            super::queued(move || invoke(&operation, &cwd))
        });
        let until = Instant::now() + Duration::from_secs(10);
        while held(&root).is_empty() {
            assert!(!worker.is_finished(), "{operation} returned before its physical request");
            assert!(Instant::now() < until, "{operation} did not launch observed process");
            std::thread::sleep(Duration::from_millis(5));
        }
        let started = Instant::now();
        policy(true, managed);
        assert!(started.elapsed() < Duration::from_secs(5), "{operation} failed to drain on activation");
        for pid in held(&root) {
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "{operation} acknowledged before process exit");
        }
        assert!(!worker.join().unwrap(), "{operation} accepted revoked output");
        let after = launches(&root);
        std::fs::remove_file(root.join("hold")).unwrap();
        for pid in held(&root) { std::fs::remove_file(root.join(format!("held-{pid}"))).unwrap(); }
        policy(false, managed);
        assert_eq!(launches(&root), after, "restoration must not replay work");
        if matches!(*operation, "ssh" | "https") {
            assert_eq!(github_identity::identity(cwd, false).login.as_deref(), Some("privacy-reader"), "disabled lookups must not cache an absent login");
        }
        assert!(invoke(operation, cwd), "{operation} did not restore without sign-in");
        assert!(launches(&root) > after, "{operation} restoration didn't exercise a real process");
    }
    overview_reads_share_authority(&root, &ssh, managed);
    workspace_rpc(&root, &ssh, managed);
    #[cfg(feature = "desktop")]
    queued_commands(&root, &ssh, managed);
    let observed = std::fs::read_to_string(root.join("launches")).unwrap();
    assert!(observed.contains("ControlMaster=no -o ControlPath=none -o ControlPersist=no"));
}

/// Saturate the actual Tauri blocking pool, poll each IPC command until queued,
/// flip the policy, then let it run. No sleeps decide whether capture happened.
#[cfg(feature = "desktop")]
fn queued_commands(root: &Path, cwd: &Path, managed: bool) {
    use std::future::Future;
    use std::task::{Context, Waker};
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2)
        .max_blocking_threads(1).enable_all().build().unwrap();
    tauri::async_runtime::set(runtime.handle().clone());
    for operation in ["identity", "issue", "overview", "disposition"] {
        policy(true, managed);
        let before = launches(root);
        assert!(!runtime.block_on(ipc(operation, cwd)));
        assert_eq!(launches(root), before);
        policy(false, managed);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || { entered_tx.send(()).unwrap(); release_rx.recv().unwrap(); });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut command = Box::pin(ipc(operation, cwd));
        let before = launches(root);
        let mut context = Context::from_waker(Waker::noop());
        assert!(command.as_mut().poll(&mut context).is_pending());
        policy(true, managed);
        policy(false, managed);
        release_tx.send(()).unwrap();
        runtime.block_on(blocker).unwrap();
        assert!(!runtime.block_on(command), "queued IPC command revived after restoration");
        assert_eq!(launches(root), before, "queued IPC command launched a network probe");
        assert!(runtime.block_on(ipc(operation, cwd)), "fresh {operation} did not restore");
        if operation == "overview" { assert_eq!(launches(root), before + 2, "both overview reads execute when valid"); }
        else { assert!(launches(root) > before); }
    }
}

#[cfg(feature = "desktop")]
async fn ipc(operation: &str, cwd: &Path) -> bool {
    let path = cwd.to_string_lossy().into_owned();
    match operation {
        "identity" => crate::commands::github_identity(path, Some(true)).await.unwrap().login.is_some(),
        "issue" => crate::commands::issue_details(path, issue_ops::Provider::Github, "7".into()).await.is_ok(),
        "overview" => overview_network(crate::commands::project_overview(path).await.unwrap()),
        "disposition" => disposition_network(crate::commands::workspace_disposition(path.clone(), path, Some(false)).await.unwrap()),
        _ => panic!("unknown IPC {operation}"),
    }
}

/// Pause after a real first process has exited and released admission, before
/// the same overview issues its second read. Restore privacy before resuming.
fn overview_reads_share_authority(root: &Path, cwd: &Path, managed: bool) {
    policy(false, managed);
    let before = launches(root);
    let (arrived, release) = after_output_barrier();
    let worker = std::thread::spawn({ let cwd = cwd.to_path_buf(); move || crate::project_overview::overview(&cwd) });
    arrived.recv_timeout(Duration::from_secs(10)).unwrap();
    assert_eq!(launches(root), before + 1);
    policy(true, managed);
    policy(false, managed);
    release.send(()).unwrap();
    assert!(!overview_network(worker.join().unwrap()));
    assert_eq!(launches(root), before + 1, "second overview read must not renew authority");
    assert!(overview_network(crate::project_overview::overview(cwd)));
    assert_eq!(launches(root), before + 3, "fresh overview reads both lists");
}

fn after_output_barrier() -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    let (arrived_tx, arrived_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    *super::AFTER_OUTPUT.lock().unwrap() = Some(Box::new(move || {
        arrived_tx.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    }));
    (arrived_rx, release_tx)
}

fn workspace_rpc(root: &Path, cwd: &Path, managed: bool) {
    use std::future::Future;
    use std::sync::Arc;
    use std::task::{Context, Waker};
    use crate::remote::{files::WorkspaceFiles, git::WorkspaceGit, protocol::{Authority, PROTOCOL}, server::{Peer, WorkspaceRpc}};
    use serde_json::{json, Value};

    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2)
        .max_blocking_threads(1).enable_all().build().unwrap();
    let cwd = std::fs::canonicalize(cwd).unwrap();
    let workspace = WorkspaceGit::new(cwd.clone(), Arc::new(WorkspaceFiles::new(cwd.clone())));
    let terminals = Arc::new(crate::pty::Terminals::new());
    let rpc = WorkspaceRpc::new(&cwd, 1, Arc::new(crate::sink::BroadcastSink::new(64)), terminals, None).unwrap();
    let (peer, _notifications) = Peer::new("privacy-runtime-client".into(), Authority::Manage);
    let hello = json!({"id":"hello", "method":"rpc.hello", "params":{"protocol":PROTOCOL,"want":["git/1","lifecycle/1"]}});
    assert_eq!(runtime.block_on(rpc.handle(&peer, &hello))["ok"], true);
    let request = |method: &str| json!({"id":"privacy-call", "method":method,"params":{
        "repo":".","branch":"main","base":"develop","number":7,"title":"Privacy fixture",
        "clientRequestId":uuid::Uuid::new_v4().to_string()
    }});
    let refused = |answer: &Value| {
        assert_eq!(answer["ok"], false, "{answer}");
        assert_eq!(answer["error"]["code"], "forbidden", "{answer}");
        assert_eq!(answer["error"]["message"], data_privacy::MESSAGE);
    };
    for method in ["git.prs", "git.prCreate", "git.prReady", "git.prMerge", "git.fetch"] {
        println!("privacy WorkspaceRpc/WorkspaceGit: managed={managed}/{method}");
        policy(true, managed);
        let before = launches(root);
        let input = request(method);
        let error = workspace.handle(method, &input["params"]).unwrap().unwrap_err();
        assert_eq!(error.code, "forbidden");
        refused(&runtime.block_on(rpc.handle(&peer, &input)));
        assert_eq!(launches(root), before, "enabled runtime started {method}");
        let local = runtime.block_on(rpc.handle(&peer, &request("git.branches")));
        assert_eq!(local["ok"], true);
        assert_eq!(local["result"]["current"], "main");
        assert_eq!(launches(root), before, "local metadata must not contact GitHub");

        policy(false, managed);
        // The relay uses handle_owned BEFORE tokio::spawn. Defer the first
        // poll entirely, so capturing inside the async body would fail this.
        let queued = rpc.handle_owned(peer.clone(), request(method));
        policy(true, managed);
        policy(false, managed);
        refused(&runtime.block_on(queued));
        assert_eq!(launches(root), before, "{method} revived from the first async queue");

        // Independently cover the second queue: the actual blocking worker.
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || { entered_tx.send(()).unwrap(); release_rx.recv().unwrap(); });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let input = request(method);
        let mut pending = Box::pin(rpc.handle(&peer, &input));
        {
            let _runtime = runtime.enter();
            assert!(pending.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
        }
        policy(true, managed);
        policy(false, managed);
        release_tx.send(()).unwrap();
        runtime.block_on(blocker).unwrap();
        refused(&runtime.block_on(pending));
        assert_eq!(launches(root), before, "{method} revived from the blocking queue");

        std::fs::write(root.join("hold"), "all\n").unwrap();
        let pending = runtime.spawn(rpc.handle_owned(peer.clone(), request(method)));
        let until = Instant::now() + Duration::from_secs(10);
        while held(root).is_empty() {
            assert!(!pending.is_finished(), "{method} returned before physical work");
            assert!(Instant::now() < until, "{method} never started");
            std::thread::sleep(Duration::from_millis(5));
        }
        let started = Instant::now();
        policy(true, managed);
        assert!(started.elapsed() < Duration::from_secs(5));
        for pid in held(root) {
            assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "{method} survived runtime policy acknowledgement");
        }
        refused(&runtime.block_on(pending).unwrap());
        std::fs::remove_file(root.join("hold")).unwrap();
        for pid in held(root) { std::fs::remove_file(root.join(format!("held-{pid}"))).unwrap(); }
        let cancelled = launches(root);
        policy(false, managed);
        assert_eq!(launches(root), cancelled, "restoring policy must not replay {method}");
        let answer = runtime.block_on(rpc.handle_owned(peer.clone(), request(method)));
        assert_eq!(answer["ok"], true, "fresh {method}: {answer}");
        assert!(launches(root) > cancelled);
    }

    // A failed ready call normally reconciles by reading the PR. Invalidate
    // after the real failed process has exited but before that fallback read.
    let before = launches(root);
    let (arrived, release) = after_output_barrier();
    let pending = runtime.spawn(rpc.handle_owned(peer.clone(), request("git.prReady")));
    arrived.recv_timeout(Duration::from_secs(10)).unwrap();
    policy(true, managed);
    policy(false, managed);
    release.send(()).unwrap();
    assert_eq!(runtime.block_on(pending).unwrap()["ok"], false);
    assert_eq!(launches(root), before + 1, "reconciliation must retain original authority");
    assert_eq!(runtime.block_on(rpc.handle_owned(peer.clone(), request("git.prReady")))["ok"], true);
    assert_eq!(launches(root), before + 3, "a fresh ready request performs its reconciliation");

    // Lifecycle facts fan out onto scoped repository threads. Local facts
    // survive, while each thread must inherit the caller's expired ticket.
    let before = launches(root);
    let stale = super::queued(|| workspace.disposition_repositories());
    policy(true, managed);
    policy(false, managed);
    let facts = stale();
    assert_eq!(facts.len(), 1);
    assert_eq!(facts[0]["branch"], "main");
    assert!(facts[0]["dirtyFiles"].is_number());
    assert!(facts[0]["openPullRequests"].is_null());
    assert_eq!(launches(root), before);
    assert!(workspace.disposition_repositories()[0]["openPullRequests"].is_array());
    assert_eq!(launches(root), before + 1);
}
