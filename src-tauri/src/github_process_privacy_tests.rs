//! Real public identity/issue calls against observed gh/ssh executables. Each
//! policy scenario runs in an isolated process, including the managed override.
use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use crate::{data_privacy, github_identity, issue_ops, issues, store};

const OPERATIONS: &[&str] = &["ssh", "https", "list", "legacy-read", "legacy-write", "details", "write", "repositories", "overview", "disposition", "review-list", "review-files", "review-resolve", "review-reply"];

#[test]
fn privacy_covers_identity_and_issue_entry_points() {
    for managed in [false, true] {
        for child in ["privacy_entry_points_child", "privacy_transport_entry_points_child"] {
            let root = tempfile::tempdir().unwrap();
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", &format!("github_process::tests::{child}"), "--nocapture"])
                .env("TERMINALX_TEST_GITHUB_ENTRIES", if managed { "managed" } else { "personal" })
                .env("TERMINALX_HOME", root.path().canonicalize().unwrap());
            let (output, timed_out) = fixture_output(&mut command, Duration::from_secs(300));
            assert!(!timed_out, "policy={managed}/{child} exceeded 300 seconds; child killed and reaped\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            assert!(output.status.success(), "policy={managed}/{child}\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
            print!("{}", String::from_utf8_lossy(&output.stdout));
        }
    }
}

fn fixture_output(command: &mut Command, timeout: Duration) -> (std::process::Output, bool) {
    // Files retain diagnostics without a full pipe blocking the child, or a
    // descendant holding a pipe open after the child has been killed.
    let stdout = tempfile::NamedTempFile::new().unwrap();
    let stderr = tempfile::NamedTempFile::new().unwrap();
    let mut child = command.stdin(std::process::Stdio::null())
        .stdout(stdout.reopen().unwrap()).stderr(stderr.reopen().unwrap()).spawn().unwrap();
    let deadline = Instant::now() + timeout;
    let (status, timed_out) = loop {
        if let Some(status) = child.try_wait().unwrap() { break (status, false); }
        if Instant::now() >= deadline {
            child.kill().expect("kill timed-out privacy fixture");
            break (child.wait().expect("reap timed-out privacy fixture"), true);
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    (std::process::Output {
        status,
        stdout: std::fs::read(stdout.path()).unwrap(),
        stderr: std::fs::read(stderr.path()).unwrap(),
    }, timed_out)
}

#[test]
fn privacy_fixture_timeout_kills_and_reaps_child() {
    use std::os::unix::process::ExitStatusExt;
    let (output, timed_out) = fixture_output(Command::new("/bin/sleep").arg("30"), Duration::from_millis(100));
    assert!(timed_out);
    assert_eq!(output.status.signal(), Some(libc::SIGKILL));
}

#[test]
fn privacy_transport_entry_points_child() {
    let Ok(kind) = std::env::var("TERMINALX_TEST_GITHUB_ENTRIES") else { return };
    let managed = kind == "managed";
    let root = store::root().unwrap();
    fixture(&root);
    policy(false, managed);
    let fetch = fresh_fixture(&root);
    store::projects::add(fetch.project.to_str().unwrap()).unwrap();
    // The bridge being frozen must also own discovery. Earlier entrypoint
    // fixtures retain listeners, so give this handover its own process/home.
    transport::run(&root, &fetch, managed);
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
        "review-list" => crate::github::reviews::list("https://github.com/privacy/fixture/pull/7").is_ok(),
        "review-files" => crate::github::reviews::files("https://github.com/privacy/fixture/pull/7", "head", "base").is_ok(),
        "review-resolve" => crate::github::reviews::resolve("https://github.com/privacy/fixture/pull/7", "thread", true).is_ok(),
        "review-reply" => crate::github::reviews::reply("https://github.com/privacy/fixture/pull/7", "thread", "hello").is_ok(),
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
 all:*|write:*' -X PATCH '*|create:'pr create '*|panel-checks:'pr checks '*|panel-merge:'pr merge '*)
   : > "$TERMINALX_HOME/held-$$"
   exec /bin/sleep 30 ;;
esac
case "${0##*/}" in
 ssh)
   case " $* " in *' -G '*) printf 'hostname github.com\nuser git\nport 22\nproxycommand none\nproxyjump none\n'; exit 0 ;; esac
   printf "Hi privacy-reader! You've successfully authenticated.\n" >&2; exit 1 ;;
esac
case "$*" in
 *'query=query($owner:'*) printf '{"data":{"repository":{"pullRequest":{"url":"https://github.com/privacy/fixture/pull/7","headRefOid":"head","baseRefOid":"base","reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false}}}}}}\n'; exit 0 ;;
 *'query=query($id:'*) printf '{"data":{"node":{"id":"thread","pullRequest":{"url":"https://github.com/privacy/fixture/pull/7"}}}}\n'; exit 0 ;;
 *'resolveReviewThread(input:'*) printf '{"data":{"resolveReviewThread":{"thread":{"id":"thread","isResolved":true}}}}\n'; exit 0 ;;
 *'addPullRequestReviewThreadReply(input:'*) printf '{"data":{"addPullRequestReviewThreadReply":{"comment":{"id":"reply"}}}}\n'; exit 0 ;;
 *'pulls/7/files?'*) printf '[]\n'; exit 0 ;;
 'pr view '*'url,headRefOid,baseRefOid') printf '{"url":"https://github.com/privacy/fixture/pull/7","headRefOid":"head","baseRefOid":"base"}\n'; exit 0 ;;
 'auth status '*) printf 'Logged in to github.com account privacy-reader\n  Active account: true\n'; exit 0 ;;
esac
if [ -f "$TERMINALX_HOME/panel-pr" ]; then
 case "$*" in
  'pr list '*) exec /bin/cat "$TERMINALX_HOME/panel-list.json" ;;
  'pr view '*) exec /bin/cat "$TERMINALX_HOME/panel-view.json" ;;
  'pr checks '*) exec /bin/cat "$TERMINALX_HOME/panel-required.json" ;;
  'api graphql '*) exec /bin/cat "$TERMINALX_HOME/panel-queue.json" ;;
  'pr merge '*' --auto') : > "$TERMINALX_HOME/panel-enqueued"; exit 0 ;;
 esac
fi
if [ -f "$TERMINALX_HOME/create-pr" ]; then
 case "$*" in
  'pr list '*) if [ ! -f "$TERMINALX_HOME/created-pr" ]; then printf '[]\n'; exit 0; fi ;;
  'pr create '*) : > "$TERMINALX_HOME/created-pr"; printf 'https://github.com/privacy/fixture/pull/7\n'; exit 0 ;;
 esac
fi
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
if [ "$1" = cat-file ] && [ -f "$TERMINALX_HOME/media-cat-hold" ]; then
 printf '%s %s\n' "$$" "${GIT_NO_LAZY_FETCH:-unset}" > "$TERMINALX_HOME/media-cat-entered"
 while [ -f "$TERMINALX_HOME/media-cat-hold" ]; do /bin/sleep 0.01; done
fi
case "$1" in
 fetch|pull|push|ls-remote)
   printf 'git %s\n' "$*" >> "$TERMINALX_HOME/launches"
   hold=''
   if [ -f "$TERMINALX_HOME/hold" ]; then read -r hold < "$TERMINALX_HOME/hold"; fi
   case "$hold:$1" in
    all:*|fetch:fetch)
     : > "$TERMINALX_HOME/held-$$"
     exec /bin/sleep 30 ;;
   esac
   if [ "$1" = fetch ] && [ -f "$TERMINALX_HOME/real-fetch" ]; then exec /usr/bin/git "$@"; fi
   if [ -f "$TERMINALX_HOME/real-pull" ]; then
     printf '%s\n' "$$" > "$TERMINALX_HOME/pull-owner"
     exec /usr/bin/git "$@"
   fi
   if [ "$1" = ls-remote ] && [ -f "$TERMINALX_HOME/create-pr" ]; then
     printf '%s\trefs/heads/main\n' "$(/usr/bin/git rev-parse HEAD)"
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
    for operation in ["review-files", "review-resolve", "review-reply"] {
        policy(false, managed);
        let before = launches(&root);
        let (arrived, release) = after_output_barrier();
        let worker = std::thread::spawn({ let cwd = ssh.clone(); move || invoke(operation, &cwd) });
        arrived.recv_timeout(Duration::from_secs(10)).unwrap();
        policy(true, managed);
        policy(false, managed);
        release.send(()).unwrap();
        assert!(!worker.join().unwrap(), "{operation} renewed authority between its read and delivery");
        assert_eq!(launches(&root), before + 1);
        assert!(invoke(operation, &ssh));
    }
    overview_reads_share_authority(&root, &ssh, managed);
    workspace_rpc(&root, &ssh, managed);
    panel::run(&root, &ssh, managed);
    media::run(&root, managed);
    pull::run(&root, managed);
    let fetch = fresh_fixture(&root);
    fresh_runtime(&root, &fetch, managed);
    cleanup_keeps_revoked_branches(&root, &fetch, managed);
    forwarded_cleanup_keeps_denial(&root, &fetch, managed);
    #[cfg(feature = "desktop")]
    queued_commands(&root, &ssh, &fetch, managed);
    let observed = std::fs::read_to_string(root.join("launches")).unwrap();
    assert!(observed.contains("ControlMaster=no -o ControlPath=none -o ControlPersist=no"));
}

/// Saturate the actual Tauri blocking pool, poll each IPC command until queued,
/// flip the policy, then let it run. No sleeps decide whether capture happened.
#[cfg(feature = "desktop")]
fn queued_commands(root: &Path, cwd: &Path, fetch: &FetchFixture, managed: bool) {
    use std::future::Future;
    use std::task::{Context, Waker};
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2)
        .max_blocking_threads(1).enable_all().build().unwrap();
    tauri::async_runtime::set(runtime.handle().clone());
    for operation in ["identity", "issue", "overview", "disposition", "review-list", "review-files", "review-resolve", "review-reply"] {
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
    fresh_ipcs(root, fetch, managed, &runtime);
    panel::ipc_queues(root, cwd, managed, &runtime);
    media::ipc_queues(root, managed, &runtime);
    pull::ipc_queues(root, managed, &runtime);
}

#[cfg(feature = "desktop")]
async fn ipc(operation: &str, cwd: &Path) -> bool {
    let path = cwd.to_string_lossy().into_owned();
    match operation {
        "review-list" => crate::commands::pr_review_threads("https://github.com/privacy/fixture/pull/7".into()).await.is_ok(),
        "review-files" => crate::commands::pr_review_files("https://github.com/privacy/fixture/pull/7".into(), "head".into(), "base".into()).await.is_ok(),
        "review-resolve" => crate::commands::pr_review_resolve("https://github.com/privacy/fixture/pull/7".into(), "thread".into(), true).await.is_ok(),
        "review-reply" => crate::commands::pr_review_reply("https://github.com/privacy/fixture/pull/7".into(), "thread".into(), "hello".into()).await.is_ok(),
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
    let request = |method: &str| {
        let mut request = json!({"id":"privacy-call", "method":method,"params":{
            "repo":".","branch":"main","base":"develop","number":7,"title":"Privacy fixture",
            "clientRequestId":uuid::Uuid::new_v4().to_string()
        }});
        if method == "git.prs" { request["params"].as_object_mut().unwrap().remove("number"); }
        request
    };
    let refused = |answer: &Value| {
        assert_eq!(answer["ok"], false, "{answer}");
        assert_eq!(answer["error"]["code"], "forbidden", "{answer}");
        assert_eq!(answer["error"]["message"], data_privacy::MESSAGE);
    };
    for method in ["git.prs", "git.prCreate", "git.prReady", "git.prMerge", "git.fetch"] {
        println!("privacy WorkspaceRpc/WorkspaceGit: managed={managed}/{method}");
        if method == "git.prCreate" { std::fs::write(root.join("create-pr"), "").unwrap(); }
        policy(true, managed);
        let before = launches(root);
        let input = request(method);
        let error = workspace.handle(method, &input["params"]).unwrap().unwrap_err();
        assert_eq!(error.code, "forbidden");
        refused(&runtime.block_on(rpc.handle(&peer, &input)));
        assert_eq!(launches(root), before, "enabled runtime started {method}");
        refused(&runtime.block_on(rpc.handle(&peer, &request("git.branches"))));
        let local = workspace.handle("git.branches", &request("git.branches")["params"]).unwrap().unwrap();
        assert_eq!(local["current"], "main", "local inspection remains available without a remote request");
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

        std::fs::write(root.join("hold"), if method == "git.prCreate" { "create\n" } else { "all\n" }).unwrap();
        let pending = runtime.spawn(rpc.handle_owned(peer.clone(), request(method)));
        let until = Instant::now() + Duration::from_secs(10);
        while held(root).is_empty() {
            assert!(!pending.is_finished(), "{method} returned before physical work");
            assert!(Instant::now() < until, "{method} never started");
            std::thread::sleep(Duration::from_millis(5));
        }
        if method == "git.prCreate" {
            assert!(std::fs::read_to_string(root.join("launches")).unwrap().lines().any(|line| line.starts_with("gh pr create ")),
                "active cancellation must reach physical PR creation, not the initial read");
            assert!(!root.join("created-pr").exists());
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
        if method == "git.prCreate" {
            assert_eq!(answer["result"]["created"], true, "must execute gh pr create");
            assert_eq!(answer["result"]["existing"], false);
            assert!(root.join("created-pr").exists());
            std::fs::remove_file(root.join("create-pr")).unwrap();
            std::fs::remove_file(root.join("created-pr")).unwrap();
        }
    }

    // A failed ready call normally reconciles by reading the PR. Invalidate
    // after the real failed process has exited but before that fallback read.
    let before = launches(root);
    let (arrived, release) = after_output_barrier();
    let pending = runtime.spawn(rpc.handle_owned(peer.clone(), request("git.prReady")));
    arrived.recv_timeout(Duration::from_secs(10)).unwrap();
    // The subprocess has drained, but the enclosing remote mutation still
    // owns admission. Activation withdraws its ticket immediately and must
    // await that mutation before acknowledging, including reconciliation.
    let (acknowledged, ack) = std::sync::mpsc::channel();
    let activation = std::thread::spawn(move || { policy(true, managed); acknowledged.send(()).unwrap(); });
    let until = Instant::now() + Duration::from_secs(5);
    while !data_privacy::enabled() {
        assert!(Instant::now() < until, "activation did not withdraw the RPC ticket");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(ack.recv_timeout(Duration::from_millis(100)), Err(std::sync::mpsc::RecvTimeoutError::Timeout),
        "activation acknowledged while the admitted RPC mutation was paused");
    release.send(()).unwrap();
    assert_eq!(runtime.block_on(pending).unwrap()["ok"], false);
    ack.recv_timeout(Duration::from_secs(5)).unwrap();
    activation.join().unwrap();
    assert_eq!(launches(root), before + 1, "reconciliation must retain original authority");
    policy(false, managed);
    assert_eq!(launches(root), before + 1, "restoration must not replay reconciliation");
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

struct FetchFixture {
    seed: std::path::PathBuf,
    project: std::path::PathBuf,
    worktree: std::path::PathBuf,
    session: String,
}

fn real_git(cwd: &Path, args: &[&str]) -> String {
    let output = Command::new("/usr/bin/git").current_dir(cwd)
        .args(["-c", "user.email=local@example.test", "-c", "user.name=Privacy Fixture", "-c", "commit.gpgsign=false"])
        .args(args).output().unwrap();
    assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
    String::from_utf8(output.stdout).unwrap().trim().to_string()
}

/// Real bare origin, clone and indexed non-main worktree. The observed fetch
/// wrapper delegates to real Git, so restoration must actually update refs.
fn fresh_fixture(root: &Path) -> FetchFixture {
    let seed = root.join("fetch-seed");
    std::fs::create_dir(&seed).unwrap();
    real_git(&seed, &["init", "-q", "-b", "main"]);
    real_git(&seed, &["commit", "--allow-empty", "-qm", "seed"]);
    real_git(root, &["clone", "-q", "--bare", "fetch-seed", "fetch-origin.git"]);
    real_git(root, &["clone", "-q", "fetch-origin.git", "fetch-project"]);
    real_git(&seed, &["remote", "add", "origin", root.join("fetch-origin.git").to_str().unwrap()]);
    let project = std::fs::canonicalize(root.join("fetch-project")).unwrap();
    let entry = crate::session_ops::create_session_entry(crate::session_ops::NewSession {
        checkout_pr: None, parent: None,
        section_id: None,
        project_path: project.to_string_lossy().into_owned(), checkout_branch: None,
        title: Some("Fetch privacy".into()), use_worktree: true, base_ref: Some("main".into()),
        worktree_name: Some("privacy-fetch".into()), on_main: false, issue: None, automation: None, cwd: None,
        tab: Some(crate::session_ops::NewTab { transport: Default::default(), harness: "claude".into(), model: "opus".into(), effort: None, permission_mode: None }),
        orchestrate: false,
    }).unwrap();
    std::fs::write(root.join("real-fetch"), "").unwrap();
    FetchFixture { seed, project, worktree: entry.cwd.into(), session: entry.id }
}

impl FetchFixture {
    fn advance(&self) -> String {
        real_git(&self.seed, &["commit", "--allow-empty", "-qm", "Advance origin"]);
        real_git(&self.seed, &["push", "-q", "origin", "main"]);
        let expected = real_git(&self.seed, &["rev-parse", "HEAD"]);
        assert_ne!(real_git(&self.project, &["rev-parse", "origin/main"]), expected);
        expected
    }
    fn disposition(&self, value: &serde_json::Value, fresh: bool) {
        assert_eq!(value["exists"], true, "{value}");
        assert_eq!(value["checked"], true);
        assert_eq!(value["isMain"], false, "must reach the non-main fetching branch");
        assert!(value["branch"].is_string());
        assert_eq!(value["sessionIds"], serde_json::json!([self.session]));
        assert_landed(&value["landed"], fresh);
    }
}

fn assert_landed(value: &serde_json::Value, fresh: bool) {
    assert_eq!(value["checked"], true, "{value}");
    assert_eq!(value["clean"], true);
    assert!(value["branch"].is_string() && value["head"].is_string(), "local metadata survives");
    assert_eq!(value["base"], "origin/main");
    assert!(!value["merged"].is_null(), "even apparently merged stale refs must not permit deletion");
    assert_eq!(value["fresh"], fresh, "{value}");
    assert_eq!(value["safe"], fresh, "{value}");
    if fresh { assert!(value["notVerified"].is_null(), "{value}"); }
    else { assert!(value["notVerified"].as_str().unwrap().contains(data_privacy::MESSAGE), "{value}"); }
}

fn wait_for_fetch(root: &Path, finished: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while held(root).is_empty() {
        assert!(!finished(), "call completed before observed fetch");
        assert!(Instant::now() < until, "no physical fetch reached");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(std::fs::read_to_string(root.join("launches")).unwrap().lines().last().unwrap().starts_with("git fetch "));
}

fn cancel_fetch(root: &Path, managed: bool) {
    let started = Instant::now();
    policy(true, managed);
    assert!(started.elapsed() < Duration::from_secs(5));
    for pid in held(root) {
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "fetch must be dead and reaped before activation acknowledgement");
    }
}

fn clear_hold(root: &Path) {
    std::fs::remove_file(root.join("hold")).unwrap();
    for pid in held(root) { std::fs::remove_file(root.join(format!("held-{pid}"))).unwrap(); }
}

fn fresh_runtime(root: &Path, fixture: &FetchFixture, managed: bool) {
    use std::future::Future;
    use std::sync::Arc;
    use std::task::{Context, Waker};
    use crate::remote::{protocol::{Authority, PROTOCOL}, server::{Peer, WorkspaceRpc}};
    use serde_json::json;
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2)
        .max_blocking_threads(1).enable_all().build().unwrap();
    let rpc = WorkspaceRpc::new(&fixture.project, 1, Arc::new(crate::sink::BroadcastSink::new(64)), Arc::new(crate::pty::Terminals::new()), None).unwrap();
    let (peer, _events) = Peer::new("privacy-fetch-client".into(), Authority::Manage);
    assert_eq!(runtime.block_on(rpc.handle(&peer, &json!({"id":"hello","method":"rpc.hello","params":{"protocol":PROTOCOL,"want":["workspace/1"]}})))["ok"], true);
    let request = || json!({"id":"fetch","method":"workspace.disposition","params":{"sessionId":fixture.session,"fetch":true}});
    let check = |answer: serde_json::Value, fresh: bool| {
        assert_eq!(answer["ok"], true, "{answer}");
        fixture.disposition(&answer["result"]["disposition"], fresh);
    };
    let refused = |answer: serde_json::Value| {
        assert_eq!(answer["ok"], false, "{answer}");
        assert_eq!(answer["error"]["code"], "forbidden");
        assert_eq!(answer["error"]["message"], data_privacy::MESSAGE);
        // A local verification request remains useful under explicit denial:
        // it returns unverified facts without authorizing a replacement fetch.
        let local = super::with_ticket(data_privacy::Ticket::denied(), ||
            crate::session_ops::workspace_disposition(&fixture.project, &fixture.worktree, true)).unwrap();
        fixture.disposition(&serde_json::to_value(local).unwrap(), false);
    };
    policy(true, managed);
    let before = launches(root);
    refused(runtime.block_on(rpc.handle_owned(peer.clone(), request())));
    assert_eq!(launches(root), before);
    policy(false, managed);
    let queued = rpc.handle_owned(peer.clone(), request());
    policy(true, managed);
    policy(false, managed);
    refused(runtime.block_on(queued));
    assert_eq!(launches(root), before, "first async queue must retain the fetch ticket");

    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let blocker = runtime.spawn_blocking(move || { entered_tx.send(()).unwrap(); release_rx.recv().unwrap(); });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let mut pending = Box::pin(rpc.handle_owned(peer.clone(), request()));
    {
        let _runtime = runtime.enter();
        assert!(pending.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
    }
    policy(true, managed);
    policy(false, managed);
    release_tx.send(()).unwrap();
    runtime.block_on(blocker).unwrap();
    refused(runtime.block_on(pending));
    assert_eq!(launches(root), before, "blocking queue must retain the fetch ticket");

    std::fs::write(root.join("hold"), "fetch\n").unwrap();
    let pending = runtime.spawn(rpc.handle_owned(peer.clone(), request()));
    wait_for_fetch(root, || pending.is_finished());
    cancel_fetch(root, managed);
    check(runtime.block_on(pending).unwrap(), false);
    clear_hold(root);
    let cancelled = launches(root);
    policy(false, managed);
    assert_eq!(launches(root), cancelled, "restoration must not replay a cancelled fetch");
    let expected = fixture.advance();
    check(runtime.block_on(rpc.handle_owned(peer.clone(), request())), true);
    assert_eq!(real_git(&fixture.project, &["rev-parse", "origin/main"]), expected);

    // Fresh fetch completed, but a policy change while reading local metadata
    // must also withdraw freshness. The process hook is after lease release.
    let (arrived, release) = after_output_barrier();
    let project = fixture.project.clone();
    let path = fixture.worktree.clone();
    let worker = std::thread::spawn(move || crate::landed::check(&project, &path, crate::landed::Fetch::Fresh));
    arrived.recv_timeout(Duration::from_secs(10)).unwrap();
    policy(true, managed);
    policy(false, managed);
    release.send(()).unwrap();
    assert_landed(&serde_json::to_value(worker.join().unwrap()).unwrap(), false);
    // A sweep's retained JustFetched optimization must not resurrect its old
    // verified base after the same toggle, even without another subprocess.
    let stale = super::queued(|| crate::landed::check(&fixture.project, &fixture.worktree, crate::landed::Fetch::JustFetched));
    policy(true, managed);
    policy(false, managed);
    assert_landed(&serde_json::to_value(stale()).unwrap(), false);
}

#[cfg(feature = "desktop")]
async fn fresh_ipc(operation: &str, fixture: &FetchFixture) -> serde_json::Value {
    let project = fixture.project.to_string_lossy().into_owned();
    let path = fixture.worktree.to_string_lossy().into_owned();
    match operation {
        "disposition" => serde_json::to_value(crate::commands::workspace_disposition(project, path, Some(true)).await.unwrap()).unwrap(),
        "pr_landed" => serde_json::to_value(crate::commands::pr_landed(path).await.unwrap()).unwrap(),
        _ => unreachable!(),
    }
}

#[cfg(feature = "desktop")]
fn fresh_ipcs(root: &Path, fixture: &FetchFixture, managed: bool, runtime: &tokio::runtime::Runtime) {
    use std::future::Future;
    use std::task::{Context, Waker};
    for operation in ["disposition", "pr_landed"] {
        println!("privacy non-main IPC fetch: managed={managed}/{operation}");
        let check = |answer: serde_json::Value, fresh: bool| {
            if operation == "disposition" { fixture.disposition(&answer, fresh); }
            else { assert_landed(&answer, fresh); }
        };
        policy(true, managed);
        let before = launches(root);
        check(runtime.block_on(fresh_ipc(operation, fixture)), false);
        assert_eq!(launches(root), before);
        policy(false, managed);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || { entered_tx.send(()).unwrap(); release_rx.recv().unwrap(); });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut command = Box::pin(fresh_ipc(operation, fixture));
        assert!(command.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
        policy(true, managed);
        policy(false, managed);
        release_tx.send(()).unwrap();
        runtime.block_on(blocker).unwrap();
        check(runtime.block_on(command), false);
        assert_eq!(launches(root), before, "stale non-main {operation} must not fetch");

        std::fs::write(root.join("hold"), "fetch\n").unwrap();
        let completed = std::sync::atomic::AtomicBool::new(false);
        // The real IPC future runs on Tauri's configured runtime. Scope keeps
        // its borrowed fixture alive while policy refresh occurs concurrently.
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| {
                let answer = runtime.block_on(fresh_ipc(operation, fixture));
                completed.store(true, std::sync::atomic::Ordering::Release);
                answer
            });
            wait_for_fetch(root, || completed.load(std::sync::atomic::Ordering::Acquire));
            cancel_fetch(root, managed);
            check(worker.join().unwrap(), false);
        });
        clear_hold(root);
        let cancelled = launches(root);
        policy(false, managed);
        assert_eq!(launches(root), cancelled);
        let expected = fixture.advance();
        check(runtime.block_on(fresh_ipc(operation, fixture)), true);
        assert_eq!(real_git(&fixture.project, &["rev-parse", "origin/main"]), expected, "fresh {operation} must execute the real fetch");
    }
}

/// An indirect Fresh caller scans once, then deletes many items. Invalidation
/// between that scan and the branch mutation must withdraw its proof too.
fn cleanup_keeps_revoked_branches(root: &Path, fixture: &FetchFixture, managed: bool) {
    use crate::cleanup::{Progress, Sources};
    let project = store::projects::add(fixture.project.to_str().unwrap()).unwrap();
    let branch = format!("{}privacy-leftover", store::settings::load().branch_prefix);
    real_git(&fixture.project, &["branch", &branch, "main"]);
    let projects = [project];
    let sessions = store::index::load().unwrap();
    let sources = Sources { projects: &projects, sessions: &sessions, claude_root: None, codex_home: None, fetch: crate::landed::Fetch::Fresh };
    let id = format!("branch:{}:{branch}", fixture.project.display());
    policy(true, managed);
    let before = launches(root);
    let scan = crate::cleanup::scan_sources(&sources);
    assert!(scan.iter().find(|item| item.id == id).unwrap().kept_because.is_some());
    assert_eq!(launches(root), before);
    policy(false, managed);
    let revoked = crate::cleanup::remove_from_sources(&sources, std::slice::from_ref(&id), &|progress| {
        if matches!(progress, Progress::Started { .. }) { policy(true, managed); policy(false, managed); }
    });
    assert!(revoked.removed.is_empty());
    assert_eq!(revoked.failed.len(), 1);
    assert!(revoked.failed[0].error.contains(data_privacy::MESSAGE));
    assert!(!real_git(&fixture.project, &["rev-parse", "--verify", &branch]).is_empty());
    let fresh = crate::cleanup::remove_from_sources(&sources, &[id], &|_| {});
    assert_eq!(fresh.removed.len(), 1);
    assert!(fresh.failed.is_empty());
}

/// Forwarding from the desktop may narrow the owner's ticket, never renew it.
/// Exercise the actual owner call dispatcher and non-main removal verifier.
fn forwarded_cleanup_keeps_denial(root: &Path, fixture: &FetchFixture, managed: bool) {
    use std::sync::Arc;
    let manager = crate::session::SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(64)), Arc::new(crate::sink::NoObserver),
        Arc::new(crate::harness::host::Host::new()), Arc::new(crate::pty::Terminals::new()), Arc::new(Default::default()),
        Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    let request = |allowed| serde_json::json!({"operation":"removeWorkspace", "networkAllowed":allowed, "params":{
        "projectPath":fixture.project, "path":fixture.worktree, "keepSessions":true, "deleteBranch":false,
        "confirmedDigest":null, "expectedSessions":[fixture.session]
    }});
    policy(false, managed);
    let before = launches(root);
    let error = crate::local_runtime::calls::session(&manager, "workspace", request(false)).unwrap_err();
    assert!(format!("{error:#}").contains(data_privacy::MESSAGE));
    assert_eq!(launches(root), before, "a stale desktop must not reacquire owner authority");
    let queued = super::queued(|| crate::local_runtime::calls::session(&manager, "workspace", request(true)));
    policy(true, managed);
    policy(false, managed);
    assert!(format!("{:#}", queued().unwrap_err()).contains(data_privacy::MESSAGE));
    assert_eq!(launches(root), before, "a forwarding flag cannot override the owner's original ticket");
    assert!(fixture.worktree.exists());
    assert!(store::index::get(&fixture.session).is_ok());
}

#[path = "github_transport_privacy_tests.rs"]
mod transport;

#[path = "github_panel_privacy_tests.rs"]
mod panel;

#[path = "git_media_privacy_tests.rs"]
mod media;

#[path = "git_pull_privacy_tests.rs"]
mod pull;

#[test]
fn privacy_contains_identity_and_simple_openssh() {
    for managed in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "github_process::tests::privacy_native_ssh_child", "--nocapture"])
            .env("TERMINALX_TEST_GITHUB_ENTRIES", if managed { "managed" } else { "personal" })
            .env("TERMINALX_HOME", root.path().canonicalize().unwrap()).output().unwrap();
        assert!(output.status.success(), "policy={managed}\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        print!("{}", String::from_utf8_lossy(&output.stdout));
    }
}

#[test]
fn privacy_native_ssh_child() {
    let Ok(kind) = std::env::var("TERMINALX_TEST_GITHUB_ENTRIES") else { return };
    let root = store::root().unwrap();
    fixture(&root);
    pull::native_review_ssh(&root, kind == "managed");
}

#[test]
fn privacy_review3_high_strict_wrappers_cannot_leave_connections() {
    native3_git_case("strict-wrapper");
}

#[test]
fn privacy_review3_clone_uses_destination_configuration() {
    native3_git_case("clone-context");
}

#[test]
fn privacy_review3_verification_cancellation_cleans_reference_locks() {
    native3_git_case("reference-lock");
}

fn native3_git_case(case: &str) {
    for managed in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "github_process::tests::privacy_native3_git_child", "--nocapture"])
            .env("TERMINALX_TEST_GITHUB_ENTRIES", if managed { "managed" } else { "personal" })
            .env("TERMINALX_TEST_NATIVE3_GIT", case)
            .env("TERMINALX_HOME", root.path().canonicalize().unwrap()).output().unwrap();
        assert!(output.status.success(), "{case}/policy={managed}\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
}
#[test]
fn privacy_native3_git_child() {
    let Ok(kind) = std::env::var("TERMINALX_TEST_GITHUB_ENTRIES") else { return };
    let root = store::root().unwrap(); fixture(&root);
    let case = std::env::var("TERMINALX_TEST_NATIVE3_GIT").unwrap_or_else(|_| "reference-lock".into());
    pull::native3_regressions(&root, kind == "managed", &case);
}

#[path = "github_checks_privacy_tests.rs"]
mod checks;

#[path = "github_conversation_privacy_tests.rs"]
mod conversation;

#[test]
fn privacy_main_integration_entry_points() {
    for kind in ["personal", "managed"] {
        let root = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "github_process::tests::privacy_main_integration_child", "--nocapture"])
            .env("TERMINALX_TEST_MAIN_PRIVACY", kind).env("TERMINALX_HOME", root.path()).output().unwrap();
        assert!(output.status.success(), "{kind}\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
}

#[test]
fn privacy_main_integration_child() {
    let Ok(kind) = std::env::var("TERMINALX_TEST_MAIN_PRIVACY") else { return };
    let managed = kind == "managed";
    let root = store::root().unwrap();
    let (cwd, no_remote) = fixture(&root);
    crate::git::run(&cwd, &["remote", "set-url", "origin", "https://opaque.example/owner/repo.git"]).unwrap();
    crate::git::run(&no_remote, &["remote", "remove", "origin"]).unwrap();
    let invoke = |operation: &str| match operation {
        "forge" => matches!(crate::github::project_forge(&cwd), crate::github::ProjectForge::Github),
        "connection" => crate::github::connection_status(Some(&cwd)).state == "connected",
        "search" => crate::github::search_prs(&cwd, "privacy").is_ok(),
        "attachment" => crate::github::attach_pr(&cwd, 7).is_ok(),
        "create" => crate::github::create_repository(&no_remote, "privacy/new", true).is_ok(),
        _ => unreachable!(),
    };
    for operation in ["forge", "connection", "search", "attachment", "create"] {
        policy(true, managed);
        let before = launches(&root);
        assert!(!invoke(operation), "{operation} admitted while enabled");
        assert_eq!(launches(&root), before);
        policy(false, managed);
        let queued = super::queued(|| invoke(operation));
        policy(true, managed); policy(false, managed);
        assert!(!queued(), "{operation} renewed stale authority");
        assert_eq!(launches(&root), before);
        assert!(invoke(operation), "{operation} did not restore");
        assert!(launches(&root) > before);
        std::fs::write(root.join("hold"), "all\n").unwrap();
        std::thread::scope(|scope| {
            let work = scope.spawn(super::queued(|| invoke(operation)));
            let until = Instant::now() + Duration::from_secs(10);
            while held(&root).is_empty() {
                assert!(!work.is_finished() && Instant::now() < until, "{operation} never reached process");
                std::thread::sleep(Duration::from_millis(5));
            }
            policy(true, managed);
            for pid in held(&root) { assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "{operation} did not drain"); }
            assert!(!work.join().unwrap());
        });
        std::fs::remove_file(root.join("hold")).unwrap();
        for pid in held(&root) { std::fs::remove_file(root.join(format!("held-{pid}"))).unwrap(); }
        policy(false, managed);
        assert!(invoke(operation));
    }
    // Automatic lifecycle scripts share admission; user/agent terminals remain independent.
    let script_terminals = std::sync::Arc::new(crate::pty::Terminals::new());
    let script_sink: std::sync::Arc<dyn crate::sink::EventSink> = std::sync::Arc::new(crate::sink::BroadcastSink::new(32));
    // Publish complete PID markers: redirection creates an empty file before
    // printf writes, so existence alone is only safe after an atomic rename.
    let script = "printf '%s' $$ > setup-pid.tmp && /bin/mv setup-pid.tmp setup-pid && exec /bin/sleep 30";
    let run_script = || {
        let runner = crate::archive_script::Runner { terminals: &script_terminals, sink: &script_sink, unattended: false };
        crate::archive_script::ScriptRun::spawn(runner, "privacy-setup", &cwd, script, &[], &|| {})?
            .wait(Duration::from_secs(30), &std::sync::atomic::AtomicBool::new(false))
    };
    policy(true, managed);
    assert!(run_script().is_err());
    policy(false, managed);
    let queued = super::queued(run_script);
    policy(true, managed); policy(false, managed);
    assert!(queued().is_err());
    std::thread::scope(|scope| {
        let work = scope.spawn(super::queued(run_script));
        let marker = cwd.join("setup-pid");
        let until = Instant::now() + Duration::from_secs(10);
        while !marker.exists() { assert!(Instant::now() < until); std::thread::sleep(Duration::from_millis(5)); }
        let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
        policy(true, managed);
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert!(work.join().unwrap().unwrap().stopped);
    });
    policy(false, managed);
    let runner = crate::archive_script::Runner { terminals: &script_terminals, sink: &script_sink, unattended: false };
    let restored = crate::archive_script::ScriptRun::spawn(runner, "privacy-setup-restored", &cwd, "exit 0", &[], &|| {}).unwrap()
        .wait(Duration::from_secs(5), &std::sync::atomic::AtomicBool::new(false)).unwrap();
    assert_eq!(restored.code, Some(0));
    // The interactive gh login path holds admission after its RPC has returned.
    let terminals = crate::pty::Terminals::new();
    let sink: std::sync::Arc<dyn crate::sink::EventSink> = std::sync::Arc::new(crate::sink::BroadcastSink::new(32));
    // The PTY launcher execs the supplied command. Keep publication and the
    // long-lived process in one shell so it cannot exec only printf and exit.
    let command = "/bin/sh -c 'printf \"%s\" $$ > login-pid.tmp && /bin/mv login-pid.tmp login-pid && exec /bin/sleep 30'";
    let start = || terminals.spawn_network(sink.clone(), "github-login-fixture", crate::pty::PaneSpec { cwd: cwd.to_str().unwrap(), cols:80, rows:20, command:Some(command), env:&[] });
    policy(true, managed); assert!(start().is_err());
    policy(false, managed);
    let queued = super::queued(start);
    policy(true, managed); policy(false, managed);
    assert!(queued().is_err());
    start().unwrap();
    let marker = cwd.join("login-pid");
    let until = Instant::now() + Duration::from_secs(10);
    while !marker.exists() { assert!(Instant::now() < until); std::thread::sleep(Duration::from_millis(5)); }
    let pid: i32 = std::fs::read_to_string(marker).unwrap().parse().unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "login fixture must remain alive until privacy activation");
    policy(true, managed);
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    terminals.kill("github-login-fixture");
    policy(false, managed);
    terminals.spawn_network(sink, "github-login-restored", crate::pty::PaneSpec { cwd:cwd.to_str().unwrap(), cols:80, rows:20, command:Some("exit 0"), env:&[] }).unwrap();
    policy(true, managed);
}
