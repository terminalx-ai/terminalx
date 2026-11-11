//! Landed Actions entrypoints against observed gh processes and the real IPC
//! blocking queue. No mock stands in for subprocess admission or pipe drain.
use super::*;
use crate::github::checks::{self, CheckLog, LOG_LIMIT};
use serde_json::json;

const PR: &str = "https://github.com/privacy/fixture/pull/7";
const RUN: &str = "https://github.com/privacy/fixture/actions/runs/42/job/9";
const SESSION: &str = "actions-privacy";
const TAB: &str = "agent";

#[test]
fn privacy_actions_entrypoints_keep_authority_and_drain_logs() {
    for kind in ["personal", "managed"] {
        let root = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "github_process::tests::checks::actions_privacy_child", "--nocapture"])
            .env("TERMINALX_TEST_ACTIONS_PRIVACY", kind)
            .env_remove("TERMINALX_TEST_MANAGED_PRIVACY")
            .env("TERMINALX_HOME", root.path().canonicalize().unwrap()).output().unwrap();
        assert!(output.status.success(), "{kind}\n{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        print!("{}", String::from_utf8_lossy(&output.stdout));
    }
}

fn install(root: &Path, cwd: &Path) {
    // The helper's real output exceeds the cap; the failure tail must survive
    // streaming capture and the final UTF-8/attachment budget separately.
    std::fs::write(root.join("actions-log"), format!("{}\nFAILURE TAIL\n", "é".repeat(LOG_LIMIT))).unwrap();
    store::write_json(&root.join("actions-pr"), &json!({
        "number":7,"url":PR,"state":"OPEN","headRefOid":"head",
        "statusCheckRollup":[{"name":"build","conclusion":"FAILURE","detailsUrl":RUN}]
    })).unwrap();
    let pr: serde_json::Value = store::read_json(&root.join("actions-pr")).unwrap().unwrap();
    store::write_json(&root.join("actions-list"), &json!([pr])).unwrap();
    let panel: serde_json::Value = serde_json::from_str(include_str!("fixtures/github_pr_panel.json")).unwrap();
    store::write_json(&root.join("actions-queue"), &panel["queue"]).unwrap();
    let entry: store::index::SessionEntry = serde_json::from_value(json!({
        "id":SESSION,"projectPath":cwd,"cwd":cwd,"title":"Actions privacy",
        "created":"2026-11-09T00:00:00Z","modified":"2026-11-09T00:00:00Z",
        "tabs":[{"id":TAB,"harness":"claude","created":"2026-11-09T00:00:00Z"}]
    })).unwrap();
    store::index::update(|entries| { entries.push(entry); Ok(()) }).unwrap();
    crate::pr_associations::record_local(SESSION, cwd, PR, "main").unwrap();
    // fixture() already made this executable and installed its bin directory.
    std::fs::write(root.join("bin/gh"), r#"#!/bin/sh
printf 'gh %s\n' "$*" >> "$TERMINALX_HOME/launches"
hold=''
if [ -f "$TERMINALX_HOME/hold" ]; then read -r hold < "$TERMINALX_HOME/hold"; fi
case "$hold:$*" in
 logs:'run view '*--log*|rerun:'run rerun '*)
   /bin/sleep 30 & descendant=$!
   : > "$TERMINALX_HOME/held-$descendant"
   : > "$TERMINALX_HOME/held-$$"
   wait "$descendant" ;;
esac
case "$*" in
 'run view --job '*) printf '{"databaseId":42}\n' ;;
 'run view 42 '*--json*) printf '{"databaseId":42,"headSha":"head"}\n' ;;
 'run view 43 '*--json*) printf '{"databaseId":43,"headSha":"head"}\n' ;;
 'run view 42 '*--log*) exec /bin/cat "$TERMINALX_HOME/actions-log" ;;
 'pr list '*) exec /bin/cat "$TERMINALX_HOME/actions-list" ;;
 'pr checks '*) printf '[]\n' ;;
 'api graphql '*) exec /bin/cat "$TERMINALX_HOME/actions-queue" ;;
 'pr view '*) exec /bin/cat "$TERMINALX_HOME/actions-pr" ;;
 'run rerun 42 '*|'run rerun 43 '*) printf '%s\n' "$3" >> "$TERMINALX_HOME/reran" ;;
 *) printf 'Unexpected gh call: %s\n' "$*" >&2; exit 9 ;;
esac
"#).unwrap();
}

fn assert_log(log: CheckLog) {
    assert!(log.truncated);
    assert!(log.text.len() <= LOG_LIMIT);
    assert!(log.text.ends_with("FAILURE TAIL\n") || log.text.ends_with("FAILURE TAIL\n\n\n"));
    assert!(log.text.contains("Earlier log output trimmed"));
}

fn invoke(operation: &str, cwd: &Path) -> anyhow::Result<()> {
    match operation {
        "log" => assert_log(checks::log(cwd, PR, RUN, true)?),
        "rerun" => checks::rerun(cwd, PR, RUN, true)?,
        "failed" => assert_log(checks::failed_logs(cwd, PR)?),
        "fix" => {
            let attachment = checks::prepare_fix(SESSION, TAB, PR)?;
            let text = std::fs::read_to_string(attachment.path)?;
            assert!(text.contains("Untrusted CI output follows"));
            assert_log(CheckLog { text, truncated: attachment.truncated });
        }
        _ => unreachable!(),
    }
    Ok(())
}

fn pause_after(count: usize) -> (std::sync::mpsc::Receiver<()>, std::sync::mpsc::Sender<()>) {
    fn arm(left: usize, arrived: std::sync::mpsc::Sender<()>, release: std::sync::mpsc::Receiver<()>) {
        *crate::github_process::AFTER_OUTPUT.lock().unwrap() = Some(Box::new(move || {
            if left > 1 { arm(left - 1, arrived, release); }
            else { arrived.send(()).unwrap(); release.recv_timeout(Duration::from_secs(10)).unwrap(); }
        }));
    }
    let (arrived_tx, arrived) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    arm(count, arrived_tx, release_rx);
    (arrived, release)
}

fn denied(result: anyhow::Result<()>) {
    let error = result.unwrap_err();
    assert!(format!("{error:#}").contains(data_privacy::MESSAGE), "{error:#}");
}

#[test]
fn actions_privacy_child() {
    let Ok(kind) = std::env::var("TERMINALX_TEST_ACTIONS_PRIVACY") else { return };
    let managed = kind == "managed";
    let root = store::root().unwrap();
    let (_, cwd) = fixture(&root);
    install(&root, &cwd);
    for operation in ["log", "rerun", "failed", "fix"] {
        println!("Actions privacy {kind}/{operation}");
        policy(true, managed);
        let before = launches(&root);
        denied(invoke(operation, &cwd));
        assert_eq!(launches(&root), before, "enabled {operation} launched gh");
        assert!(store::index::get(SESSION).unwrap().tab(TAB).is_some(), "local metadata remains available");
        policy(false, managed);
        let stale = crate::github_process::queued(|| invoke(operation, &cwd));
        policy(true, managed); policy(false, managed);
        denied(stale());
        assert_eq!(launches(&root), before);

        // Exercise each logical operation directly, without an outer scope
        // supplied by the test. Its own scope must span the actual reads.
        for count in 1..=if operation == "rerun" { 2 } else { 1 } {
            let before = launches(&root);
            let (arrived, release) = pause_after(count);
            let path = cwd.clone();
            let worker = std::thread::spawn(move || invoke(operation, &path));
            arrived.recv_timeout(Duration::from_secs(10)).unwrap();
            policy(true, managed); policy(false, managed);
            release.send(()).unwrap();
            denied(worker.join().unwrap());
            assert_eq!(launches(&root), before + count, "{operation} renewed authority between calls");
        }

        let _ = std::fs::remove_file(root.join("reran"));
        std::fs::write(root.join("hold"), if operation == "rerun" { "rerun\n" } else { "logs\n" }).unwrap();
        let path = cwd.clone();
        let worker = std::thread::spawn(move || invoke(operation, &path));
        let until = Instant::now() + Duration::from_secs(10);
        while held(&root).len() != 2 {
            assert!(!worker.is_finished());
            assert!(Instant::now() < until, "{operation} never reached held physical work");
            std::thread::sleep(Duration::from_millis(5));
        }
        let started = Instant::now();
        policy(true, managed);
        assert!(started.elapsed() < Duration::from_secs(5));
        for pid in held(&root) { assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "{operation} acknowledged before owned process/pipe drain"); }
        denied(worker.join().unwrap());
        assert!(!root.join("reran").exists());
        clear_hold(&root);
        let before = launches(&root);
        policy(false, managed);
        assert_eq!(launches(&root), before, "no automatic replay");
        invoke(operation, &cwd).unwrap();
        assert!(launches(&root) >= before + 2);
        if operation == "rerun" { assert!(root.join("reran").exists()); }
    }
    // The same executable is still available to agents with privacy enabled.
    policy(true, managed);
    let direct = Command::new(root.join("bin/gh")).args(["run", "view", "42", "--repo", "github.com/privacy/fixture", "--log-failed"]).output().unwrap();
    assert!(direct.status.success());
    assert!(direct.stdout.len() > LOG_LIMIT);
    #[cfg(feature = "desktop")]
    ipc_queues(&root, &cwd, managed);
    policy(false, managed);
}

#[cfg(feature = "desktop")]
fn ipc_queues(root: &Path, cwd: &Path, managed: bool) {
    use std::future::Future;
    use std::task::{Context, Waker};
    async fn invoke(operation: &str, cwd: &Path) -> Result<(), String> {
        match operation {
            "log" => assert_log(crate::commands::pr_check_log(cwd.to_string_lossy().into_owned(), PR.into(), RUN.into(), true).await?),
            "rerun" => crate::commands::pr_check_rerun(cwd.to_string_lossy().into_owned(), PR.into(), RUN.into(), true, data_privacy::Ticket::default()).await?,
            "fix" => {
                let result = crate::commands::pr_check_fix_attachment(SESSION.into(), TAB.into(), PR.into(), data_privacy::Ticket::default()).await?;
                assert_log(CheckLog { text: std::fs::read_to_string(result.path).unwrap(), truncated: result.truncated });
            }
            _ => unreachable!(),
        }
        Ok(())
    }
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).max_blocking_threads(1).enable_all().build().unwrap();
    tauri::async_runtime::set(runtime.handle().clone());
    ipc_continuations(root, cwd, managed, &runtime);
    for operation in ["log", "rerun", "fix"] {
        policy(true, managed);
        let before = launches(root);
        assert!(runtime.block_on(invoke(operation, cwd)).unwrap_err().contains(data_privacy::MESSAGE));
        assert_eq!(launches(root), before);
        policy(false, managed);
        let (arrived_tx, arrived) = std::sync::mpsc::channel();
        let (release, release_rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || { arrived_tx.send(()).unwrap(); release_rx.recv_timeout(Duration::from_secs(10)).unwrap(); });
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut call = Box::pin(invoke(operation, cwd));
        assert!(call.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
        policy(true, managed); policy(false, managed);
        release.send(()).unwrap(); runtime.block_on(blocker).unwrap();
        assert!(runtime.block_on(call).unwrap_err().contains(data_privacy::MESSAGE));
        assert_eq!(launches(root), before, "{operation} IPC captured after dispatch");
        runtime.block_on(invoke(operation, cwd)).unwrap();
        assert!(launches(root) >= before + 2);
    }
}

/// The prior per-process pauses cannot expose renewal AFTER an IPC has fully
/// completed. These calls use serialized owner tickets across that exact gap.
#[cfg(feature = "desktop")]
fn ipc_continuations(root: &Path, cwd: &Path, managed: bool, runtime: &tokio::runtime::Runtime) {
    use crate::commands;
    let path = cwd.to_string_lossy().into_owned();
    let wire = |ticket: data_privacy::Ticket| -> data_privacy::Ticket {
        serde_json::from_value(serde_json::to_value(ticket).unwrap()).unwrap()
    };
    let runs = || std::fs::read_to_string(root.join("reran")).unwrap_or_default();
    let attachments = || std::fs::read_dir(store::attachments_dir(SESSION).unwrap()).unwrap().count();
    policy(true, managed);
    assert!(commands::pr_check_authority().unwrap_err().contains(data_privacy::MESSAGE));
    policy(false, managed);
    let mut old_owner = serde_json::to_value(commands::pr_check_authority().unwrap()).unwrap();
    old_owner["owner"] = "previous-runtime-incarnation".into();
    let before = launches(root);
    assert!(runtime.block_on(commands::pr_check_rerun(path.clone(), PR.into(), RUN.into(), false, serde_json::from_value(old_owner).unwrap())).unwrap_err().contains(data_privacy::MESSAGE));
    assert_eq!(launches(root), before, "a foreign/old owner must not become current authority");
    for cycle in [false, true] {
        println!("Actions completed IPC continuation: managed={managed}, off/on={cycle}");
        let _ = std::fs::remove_file(root.join("reran"));
        let ticket = wire(commands::pr_check_authority().unwrap());
        runtime.block_on(commands::pr_check_rerun(path.clone(), PR.into(), RUN.into(), false, wire(ticket.clone()))).unwrap();
        assert_eq!(runs(), "42\n", "first completed mutation must be retained");
        let before = launches(root);
        // There is no active worker or lease here: model an unread completed
        // reply/paused JavaScript continuation, then acknowledge the setting.
        policy(true, managed);
        if cycle { policy(false, managed); }
        let second = "https://github.com/privacy/fixture/actions/runs/43";
        let error = runtime.block_on(commands::pr_check_rerun(path.clone(), PR.into(), second.into(), false, wire(ticket))).unwrap_err();
        assert!(error.contains(data_privacy::MESSAGE), "{error}");
        assert_eq!(launches(root), before, "old click started the next workflow");
        assert_eq!(runs(), "42\n");
        policy(false, managed);
        assert_eq!(launches(root), before, "restoration cannot replay the old click");
        runtime.block_on(commands::pr_check_rerun(path.clone(), PR.into(), second.into(), false, wire(commands::pr_check_authority().unwrap()))).unwrap();
        assert_eq!(runs(), "42\n43\n");

        // Both discovery and associated-PR reads occur outside attachment
        // collection. Exercise each completed IPC, plus a held capture reply.
        for completed in ["capture", "discovery", "associated"] {
            let ticket = wire(commands::pr_check_authority().unwrap());
            if completed != "capture" {
                let prs = runtime.block_on(commands::pr_list(path.clone(), "main".into(), Some(wire(ticket.clone())))).unwrap();
                assert_eq!(prs.len(), 1); assert_eq!(prs[0].url, PR);
                let owned = runtime.block_on(commands::pr_associations(SESSION.into(), vec![])).unwrap();
                assert_eq!(owned.len(), 1); assert_eq!(owned[0].url, PR);
            }
            if completed == "associated" {
                let pr = runtime.block_on(commands::pr_details(path.clone(), 7, Some(PR.into()), Some(wire(ticket.clone())))).unwrap();
                assert_eq!(pr.url, PR);
            }
            let before = launches(root);
            let files = attachments();
            policy(true, managed);
            if cycle { policy(false, managed); }
            // Every later network-capable step must refuse the same ticket,
            // including an association fallback and the final log collection.
            assert!(runtime.block_on(commands::pr_list(path.clone(), "main".into(), Some(wire(ticket.clone())))).unwrap_err().contains(data_privacy::MESSAGE));
            assert!(runtime.block_on(commands::pr_details(path.clone(), 7, Some(PR.into()), Some(wire(ticket.clone())))).unwrap_err().contains(data_privacy::MESSAGE));
            assert!(runtime.block_on(commands::pr_check_fix_attachment(SESSION.into(), TAB.into(), PR.into(), wire(ticket))).unwrap_err().contains(data_privacy::MESSAGE));
            assert_eq!(launches(root), before, "{completed} renewed discovery authority");
            assert_eq!(attachments(), files, "refused collection wrote an attachment");
            assert_eq!(runtime.block_on(commands::pr_associations(SESSION.into(), vec![])).unwrap().len(), 1, "local ownership survives");
            policy(false, managed);
            assert_eq!(launches(root), before);
            let fresh = wire(commands::pr_check_authority().unwrap());
            assert_eq!(runtime.block_on(commands::pr_list(path.clone(), "main".into(), Some(wire(fresh.clone())))).unwrap().len(), 1);
            assert_eq!(runtime.block_on(commands::pr_details(path.clone(), 7, Some(PR.into()), Some(wire(fresh.clone())))).unwrap().url, PR);
            let restored = runtime.block_on(commands::pr_check_fix_attachment(SESSION.into(), TAB.into(), PR.into(), fresh)).unwrap();
            assert_log(CheckLog { text: std::fs::read_to_string(restored.path).unwrap(), truncated: restored.truncated });
            assert_eq!(attachments(), files + 1);
        }
    }
}
