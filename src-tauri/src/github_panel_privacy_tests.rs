//! Actual panel/enqueue entry points against the observed gh process, using
//! PRO207's recorded responses. Both isolated personal/managed children run it.
use super::*;
use std::sync::Arc;

fn install(root: &Path) {
    let fixture: serde_json::Value = serde_json::from_str(include_str!("fixtures/github_pr_panel.json")).unwrap();
    let mut pr = fixture["pr"].clone();
    pr["headRefName"] = "main".into();
    pr["url"] = "https://github.com/privacy/fixture/pull/7".into();
    let mut queue = fixture["queue"].clone();
    queue["data"]["repository"]["pullRequest"]["isMergeQueueEnabled"] = true.into();
    for (name, value) in [("list", serde_json::json!([pr.clone()])), ("view", pr), ("required", fixture["required"].clone()), ("queue", queue)] {
        store::write_json(&root.join(format!("panel-{name}.json")), &value).unwrap();
    }
    std::fs::write(root.join("panel-pr"), "").unwrap();
}

fn panel_ok(prs: Vec<crate::github::PullRequest>) -> bool {
    assert_eq!(prs.len(), 1, "keep the already-read PR even if enrichment is refused");
    let pr = &prs[0];
    assert_eq!(pr.number, 7);
    if let Some(error) = &pr.details_error {
        assert!(error.contains(data_privacy::MESSAGE), "{error}");
        assert!(pr.required_checks.is_none());
        return false;
    }
    assert_eq!(pr.required_checks, Some(vec!["build".into()]));
    assert_eq!(pr.merge_queue_enabled, Some(true));
    true
}

fn invoke_panel(operation: &str, cwd: &Path) -> bool {
    use crate::remote::{files::WorkspaceFiles, git::WorkspaceGit};
    match operation {
        "list" => crate::github::panel_prs_for_branch(cwd, "main").is_ok_and(panel_ok),
        "details" => crate::github::panel_pr_details(cwd, 7, None).is_ok_and(|pr| panel_ok(vec![pr])),
        "queue" => crate::github::merge_associated_pr(cwd, 7, "queue", None).is_ok(),
        "workspace" | "workspace-queue" => {
            let cwd = std::fs::canonicalize(cwd).unwrap();
            let workspace = WorkspaceGit::new(cwd.clone(), Arc::new(WorkspaceFiles::new(cwd)));
            let method = if operation == "workspace" { "git.prs" } else { "git.prMerge" };
            let answer = workspace.handle(method, &serde_json::json!({"repo":".","branch":"main","number":7,"method":"queue"})).unwrap();
            answer.is_ok_and(|answer| operation != "workspace" || panel_ok(serde_json::from_value(answer["prs"].clone()).unwrap()))
        }
        _ => unreachable!(),
    }
}

/// Stop after an actual response has drained, at either enrichment boundary.
fn after_outputs(count: usize) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    fn arm(left: usize, arrived: std::sync::mpsc::Sender<()>, release: std::sync::mpsc::Receiver<()>) {
        *crate::github_process::AFTER_OUTPUT.lock().unwrap() = Some(Box::new(move || {
            if left > 1 { arm(left - 1, arrived, release); }
            else { arrived.send(()).unwrap(); release.recv_timeout(Duration::from_secs(10)).unwrap(); }
        }));
    }
    let (arrived_tx, arrived_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    arm(count, arrived_tx, release_rx);
    (arrived_rx, release_tx)
}

pub(super) fn run(root: &Path, cwd: &Path, managed: bool) {
    install(root);
    for operation in ["list", "details", "workspace", "queue", "workspace-queue"] {
        println!("privacy PRO207 panel/enqueue: managed={managed}/{operation}");
        let queue = operation.ends_with("queue");
        policy(true, managed);
        let before = launches(root);
        assert!(!invoke_panel(operation, cwd));
        assert_eq!(launches(root), before);
        policy(false, managed);
        let stale = crate::github_process::queued(|| invoke_panel(operation, cwd));
        policy(true, managed); policy(false, managed);
        assert!(!stale());
        assert_eq!(launches(root), before);

        // The list/view and required checks may complete, but cannot renew
        // authority before the next read or the actual enqueue mutation.
        for count in [1, 2] {
            let before = launches(root);
            let (arrived, release) = after_outputs(count);
            let path = cwd.to_path_buf();
            let worker = std::thread::spawn(move || invoke_panel(operation, &path));
            arrived.recv_timeout(Duration::from_secs(10)).unwrap();
            assert_eq!(launches(root), before + count);
            policy(true, managed); policy(false, managed);
            release.send(()).unwrap();
            assert!(!worker.join().unwrap());
            assert_eq!(launches(root), before + count, "{operation} renewed its original ticket");
        }

        let _ = std::fs::remove_file(root.join("panel-enqueued"));
        std::fs::write(root.join("hold"), if queue { "panel-merge\n" } else { "panel-checks\n" }).unwrap();
        let path = cwd.to_path_buf();
        let worker = std::thread::spawn(move || invoke_panel(operation, &path));
        let until = Instant::now() + Duration::from_secs(10);
        while held(root).is_empty() {
            assert!(!worker.is_finished());
            assert!(Instant::now() < until, "{operation} never reached the held subprocess");
            std::thread::sleep(Duration::from_millis(5));
        }
        let last = std::fs::read_to_string(root.join("launches")).unwrap();
        assert!(last.lines().last().unwrap().starts_with(if queue { "gh pr merge " } else { "gh pr checks " }));
        let started = Instant::now();
        policy(true, managed);
        assert!(started.elapsed() < Duration::from_secs(5));
        for pid in held(root) { assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "acknowledged before {operation} process died"); }
        assert!(!worker.join().unwrap());
        assert!(!root.join("panel-enqueued").exists());
        clear_hold(root);
        let before = launches(root);
        policy(false, managed);
        assert_eq!(launches(root), before, "no replay on restoration");
        assert!(invoke_panel(operation, cwd), "fresh {operation} did not restore");
        assert!(launches(root) >= before + 3, "exercise actual enrichment/enqueue processes");
        if queue { assert!(root.join("panel-enqueued").exists(), "fresh enqueue must physically execute"); }
    }
    std::fs::remove_file(root.join("panel-pr")).unwrap();
}

#[cfg(feature = "desktop")]
pub(super) fn ipc_queues(root: &Path, cwd: &Path, managed: bool, runtime: &tokio::runtime::Runtime) {
    use std::future::Future;
    use std::task::{Context, Waker};
    async fn invoke(operation: &str, cwd: &Path) -> bool {
        let path = cwd.to_string_lossy().into_owned();
        match operation {
            "list" => crate::commands::pr_list(path, "main".into()).await.is_ok_and(panel_ok),
            "details" => crate::commands::pr_details(path, 7, None).await.is_ok_and(|pr| panel_ok(vec![pr])),
            "queue" => crate::commands::pr_merge(path, 7, "queue".into(), None).await.is_ok(),
            _ => unreachable!(),
        }
    }
    install(root);
    for operation in ["list", "details", "queue"] {
        policy(true, managed);
        let before = launches(root);
        assert!(!runtime.block_on(invoke(operation, cwd)));
        assert_eq!(launches(root), before);
        policy(false, managed);
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || { entered_tx.send(()).unwrap(); release_rx.recv().unwrap(); });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut command = Box::pin(invoke(operation, cwd));
        assert!(command.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
        policy(true, managed); policy(false, managed);
        release_tx.send(()).unwrap(); runtime.block_on(blocker).unwrap();
        assert!(!runtime.block_on(command));
        assert_eq!(launches(root), before, "IPC {operation} captured after dispatch");
        assert!(runtime.block_on(invoke(operation, cwd)));
        assert!(launches(root) >= before + 3);
    }
    std::fs::remove_file(root.join("panel-pr")).unwrap();
}
