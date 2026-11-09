//! Actual desktop IPC and WorkspaceRpc/WorkspaceGit conversation entrypoints,
//! observed gh processes, and pauses after completed physical calls.
use super::*;
use crate::github::conversation::{Action, Update};
use serde_json::{json, Value};
use std::sync::Arc;

const PR: &str = "https://github.com/acme/widgets/pull/799";
const METHODS: &[&str] = &["read", "search", "edit", "request", "remove", "approve"];

#[test]
fn privacy_conversation_entrypoints_keep_one_authority() {
    for kind in ["personal", "managed"] {
        let root = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "github_process::tests::conversation::conversation_privacy_child", "--nocapture"])
            .env("TERMINALX_TEST_CONVERSATION_PRIVACY", kind)
            .env_remove("TERMINALX_TEST_MANAGED_PRIVACY")
            .env("TERMINALX_HOME", root.path().canonicalize().unwrap()).output().unwrap();
        assert!(output.status.success(), "{kind}\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        print!("{}", String::from_utf8_lossy(&output.stdout));
    }
}

fn install(root: &Path) {
    let mut page: Value = serde_json::from_str(include_str!("fixtures/github_pr_conversation.json")).unwrap();
    page["data"]["viewer"]["login"] = "reviewer".into();
    page["data"]["repository"]["pullRequest"]["state"] = "OPEN".into();
    store::write_json(&root.join("page2"), &page).unwrap();
    page["data"]["repository"]["pullRequest"]["timelineItems"]["pageInfo"] = json!({"hasNextPage":true,"endCursor":"next"});
    store::write_json(&root.join("page1"), &page).unwrap();
    std::fs::write(root.join("bin/gh"), r#"#!/bin/sh
printf 'gh\n' >> "$TERMINALX_HOME/launches"
if [ -f "$TERMINALX_HOME/hold" ]; then
  /bin/sleep 30 & descendant=$!
  : > "$TERMINALX_HOME/held-$descendant"
  : > "$TERMINALX_HOME/held-$$"
  wait "$descendant"
fi
case "$*" in
 'repo view '*) printf '{"url":"https://github.com/acme/widgets"}\n' ;;
 *'assignableUsers('*) printf '{"data":{"repository":{"assignableUsers":{"nodes":[{"login":"ada"}]}}}}\n' ;;
 'api graphql '*)
   case " $* " in *' timeline=next '*) exec /bin/cat "$TERMINALX_HOME/page2" ;; *) exec /bin/cat "$TERMINALX_HOME/page1" ;; esac ;;
 'pr view '*) printf '{"title":"Title","body":"Body"}\n' ;;
 'api --hostname github.com user') printf '{"type":"User","login":"reviewer"}\n' ;;
 'pr edit '*|'pr review '*|*'requested_reviewers'*) printf 'mutation\n' >> "$TERMINALX_HOME/mutations" ;;
 *) printf 'Unexpected gh call: %s\n' "$*" >&2; exit 9 ;;
esac
"#).unwrap();
}
fn action(operation: &str) -> Action {
    match operation {
        "edit" => Action::Edit { title: "New title".into(), body: "New body".into(), expected_title: "Title".into(), expected_body: "Body".into() },
        "request" => Action::Request { login: "ada".into(), team: false },
        "remove" => Action::Remove { login: "ada".into(), team: false },
        "approve" => Action::Approve { viewer: "reviewer".into() },
        _ => unreachable!(),
    }
}
fn invoke(operation: &str) -> anyhow::Result<Option<Update>> {
    match operation {
        "read" => { assert_eq!(crate::github::pr_conversation(PR)?.url, PR); Ok(None) }
        "search" => { assert_eq!(crate::github::pr_reviewer_search(PR, "ada")?, ["ada"]); Ok(None) }
        _ => crate::github::pr_conversation_action(PR, action(operation)).map(Some),
    }
}
fn denied(result: anyhow::Result<Option<Update>>) {
    let error = result.unwrap_err();
    assert!(format!("{error:#}").contains(data_privacy::MESSAGE), "{error:#}");
}
fn mutations(root: &Path) -> usize { std::fs::read_to_string(root.join("mutations")).unwrap_or_default().lines().count() }
fn wait_held(root: &Path, finished: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while held(root).len() != 2 {
        assert!(!finished()); assert!(Instant::now() < until, "never entered physical gh work");
        std::thread::sleep(Duration::from_millis(5));
    }
}
fn cancel(root: &Path, managed: bool) {
    policy(true, managed);
    for pid in held(root) { assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "privacy acknowledged before process/pipe drain"); }
}
fn pause_after(count: usize) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    fn arm(left: usize, arrived: std::sync::mpsc::Sender<()>, release: std::sync::mpsc::Receiver<()>) {
        *crate::github_process::AFTER_OUTPUT.lock().unwrap() = Some(Box::new(move || {
            if left > 1 { arm(left - 1, arrived, release); }
            else { arrived.send(()).unwrap(); release.recv_timeout(Duration::from_secs(10)).unwrap(); }
        }));
    }
    let (tx, arrived) = std::sync::mpsc::channel(); let (release, rx) = std::sync::mpsc::channel();
    arm(count, tx, rx); (arrived, release)
}

#[test]
fn conversation_privacy_child() {
    let Ok(kind) = std::env::var("TERMINALX_TEST_CONVERSATION_PRIVACY") else { return };
    let managed = kind == "managed"; let root = store::root().unwrap();
    let (_, cwd) = fixture(&root); install(&root);
    for &operation in METHODS {
        println!("Conversation {kind}/{operation}");
        policy(true, managed); let before = launches(&root);
        denied(invoke(operation)); assert_eq!(launches(&root), before);
        assert_eq!(real_git(&cwd, &["branch", "--show-current"]), "main");
        policy(false, managed);
        let queued = crate::github_process::queued(move || invoke(operation));
        policy(true, managed); policy(false, managed);
        denied(queued()); assert_eq!(launches(&root), before);
        std::fs::write(root.join("hold"), "all").unwrap();
        let worker = std::thread::spawn(move || invoke(operation));
        wait_held(&root, || worker.is_finished()); cancel(&root, managed);
        denied(worker.join().unwrap()); clear_hold(&root);
        let before = launches(&root); policy(false, managed); assert_eq!(launches(&root), before);
        let answer = invoke(operation).unwrap();
        if let Some(update) = answer { assert_eq!(update.conversation.unwrap().url, PR); assert!(update.error.is_none()); }
    }
    // One logical read spans pagination; edit/approval spans identity/current
    // text preflight, mutation and readback, even without an outer test scope.
    for cycle in [false, true] {
        for (operation, completed, mutated) in [("read",1,false),("edit",1,false),("approve",1,false),("edit",2,true),("approve",2,true),("request",1,true),("remove",1,true)] {
            policy(false, managed);
            let before = launches(&root); let writes = mutations(&root);
            let (arrived, release) = pause_after(completed);
            let worker = std::thread::spawn(move || invoke(operation));
            arrived.recv_timeout(Duration::from_secs(10)).unwrap();
            policy(true, managed); if cycle { policy(false, managed); }
            release.send(()).unwrap();
            let answer = worker.join().unwrap();
            if mutated {
                let update = answer.unwrap().unwrap();
                assert!(update.conversation.is_none());
                assert!(update.error.unwrap().contains(data_privacy::MESSAGE));
            } else { denied(answer); }
            assert_eq!(launches(&root), before + completed, "{operation} renewed authority between physical calls");
            assert_eq!(mutations(&root), writes + usize::from(mutated));
            policy(false, managed); assert_eq!(launches(&root), before + completed);
            invoke(operation).unwrap();
        }
    }
    policy(true, managed);
    assert!(Command::new(root.join("bin/gh")).args(["pr", "view", PR]).output().unwrap().status.success(), "agent-owned executable remains available");
    policy(false, managed);
    runtime_entrypoints(&root, &cwd, managed);
}

fn runtime_entrypoints(root: &Path, cwd: &Path, managed: bool) {
    use crate::remote::{files::WorkspaceFiles, git::WorkspaceGit, protocol::{Authority, PROTOCOL}, server::{Peer, WorkspaceRpc}};
    use std::future::Future;
    use std::task::{Context, Waker};
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).max_blocking_threads(1).enable_all().build().unwrap();
    #[cfg(feature = "desktop")]
    tauri::async_runtime::set(runtime.handle().clone());
    let workspace = WorkspaceGit::new(cwd.into(), Arc::new(WorkspaceFiles::new(cwd.into())));
    let rpc = WorkspaceRpc::new(cwd, 1, Arc::new(crate::sink::BroadcastSink::new(64)), Arc::new(crate::pty::Terminals::new()), None).unwrap();
    let (peer, _notifications) = Peer::new("conversation-client".into(), Authority::Manage);
    assert_eq!(runtime.block_on(rpc.handle(&peer, &json!({"id":"hello","method":"rpc.hello","params":{"protocol":PROTOCOL,"want":["git/1"]}})))["ok"], true);
    let request = |operation| json!({"id":"conversation","method":match operation {"read"=>"git.prConversation","search"=>"git.prReviewerSearch",_=>"git.prConversationAction"},"params":{"repo":".","url":PR,"query":"ada","action":if ["read","search"].contains(&operation) {Value::Null} else {json!(action(operation))},"clientRequestId":uuid::Uuid::new_v4().to_string()}});
    for &operation in METHODS {
        println!("Conversation IPC/RPC {managed}/{operation}");
        #[cfg(feature = "desktop")]
        {
            policy(true, managed); let before = launches(root);
            assert!(runtime.block_on(ipc(operation)).unwrap_err().contains(data_privacy::MESSAGE));
            assert_eq!(launches(root), before);
            policy(false, managed);
            let (tx, arrived) = std::sync::mpsc::channel(); let (release, rx) = std::sync::mpsc::channel();
            let blocker = runtime.spawn_blocking(move || { tx.send(()).unwrap(); rx.recv_timeout(Duration::from_secs(10)).unwrap(); });
            arrived.recv_timeout(Duration::from_secs(5)).unwrap();
            let mut pending = Box::pin(ipc(operation));
            assert!(pending.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
            policy(true, managed); policy(false, managed);
            release.send(()).unwrap(); runtime.block_on(blocker).unwrap();
            assert!(runtime.block_on(pending).unwrap_err().contains(data_privacy::MESSAGE));
            assert_eq!(launches(root), before, "IPC captured after queue");
            std::fs::write(root.join("hold"), "all").unwrap();
            let task = runtime.spawn(ipc(operation));
            wait_held(root, || task.is_finished()); cancel(root, managed);
            assert!(runtime.block_on(task).unwrap().unwrap_err().contains(data_privacy::MESSAGE));
            clear_hold(root);
            let before = launches(root); policy(false, managed); assert_eq!(launches(root), before);
            runtime.block_on(ipc(operation)).unwrap();
        }
        if operation == "approve" {
            let input = request(operation); let before = launches(root);
            let error = workspace.handle(input["method"].as_str().unwrap(), &input["params"]).unwrap().unwrap_err();
            assert!(error.message.contains("personal account")); assert_eq!(launches(root), before); continue;
        }
        // WorkspaceGit itself owns the repository-identity -> operation scope;
        // its first completed reply must not confer fresh authority afterward.
        for cycle in [false, true] {
            policy(false, managed);
            let (arrived, release) = pause_after(1);
            let path = cwd.to_path_buf(); let input = request(operation); let before = launches(root);
            let worker = std::thread::spawn(move || {
                let git = WorkspaceGit::new(path.clone(), Arc::new(WorkspaceFiles::new(path)));
                git.handle(input["method"].as_str().unwrap(), &input["params"]).unwrap()
            });
            arrived.recv_timeout(Duration::from_secs(10)).unwrap();
            policy(true, managed); if cycle { policy(false, managed); }
            release.send(()).unwrap();
            assert!(worker.join().unwrap().unwrap_err().message.contains(data_privacy::MESSAGE));
            assert_eq!(launches(root), before + 1);
        }
        policy(true, managed); let before = launches(root); let input = request(operation);
        let error = workspace.handle(input["method"].as_str().unwrap(), &input["params"]).unwrap().unwrap_err();
        assert!(error.message.contains(data_privacy::MESSAGE));
        assert_eq!(runtime.block_on(rpc.handle(&peer, &input))["ok"], false);
        assert_eq!(launches(root), before);
        policy(false, managed);
        let queued = rpc.handle_owned(peer.clone(), request(operation));
        policy(true, managed); policy(false, managed);
        assert_eq!(runtime.block_on(queued)["ok"], false); assert_eq!(launches(root), before);
        let (tx, arrived) = std::sync::mpsc::channel(); let (release, rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || { tx.send(()).unwrap(); rx.recv_timeout(Duration::from_secs(10)).unwrap(); });
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        let input = request(operation); let mut pending = Box::pin(rpc.handle(&peer, &input));
        { let _runtime = runtime.enter(); assert!(pending.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending()); }
        policy(true, managed); policy(false, managed); release.send(()).unwrap(); runtime.block_on(blocker).unwrap();
        assert_eq!(runtime.block_on(pending)["ok"], false); assert_eq!(launches(root), before);
        std::fs::write(root.join("hold"), "all").unwrap();
        let task = runtime.spawn(rpc.handle_owned(peer.clone(), request(operation)));
        wait_held(root, || task.is_finished()); cancel(root, managed);
        assert_eq!(runtime.block_on(task).unwrap()["ok"], false); clear_hold(root);
        let before = launches(root); policy(false, managed); assert_eq!(launches(root), before);
        let answer = runtime.block_on(rpc.handle(&peer, &request(operation)));
        assert_eq!(answer["ok"], true, "{answer}");
    }
    policy(false, managed);
}

#[cfg(feature = "desktop")]
async fn ipc(operation: &str) -> Result<(), String> {
    match operation {
        "read" => { assert_eq!(crate::commands::pr_conversation(PR.into()).await?.url, PR); }
        "search" => { assert_eq!(crate::commands::pr_reviewer_search(PR.into(), "ada".into()).await?, ["ada"]); }
        _ => { let update = crate::commands::pr_conversation_action(PR.into(), action(operation)).await?; assert!(update.error.is_none()); assert_eq!(update.conversation.unwrap().url, PR); }
    }
    Ok(())
}
