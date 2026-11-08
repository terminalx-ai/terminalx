// Physical gh observations and the production desktop blocking dispatcher.
use super::*;
use std::path::Path;
use std::process::Command;
use std::time::Duration;

fn policy(enabled: bool, managed: bool) {
    if managed && enabled { std::env::set_var("TERMINALX_TEST_MANAGED_PRIVACY", "1"); }
    else { std::env::remove_var("TERMINALX_TEST_MANAGED_PRIVACY"); }
    crate::store::write_json(&crate::store::root().unwrap().join("data-privacy.json"), &serde_json::json!({"enabled":enabled && !managed})).unwrap();
    assert_eq!(crate::data_privacy::refresh().enabled, enabled);
}

fn calls(root: &Path) -> String { std::fs::read_to_string(root.join("calls")).unwrap_or_default() }

#[test]
fn privacy_cloud_merge_keeps_dispatch_and_reconciliation_authority() {
    for managed in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let out = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "issue_pipeline::cloud_merge::tests::privacy::privacy_cloud_child", "--nocapture"])
            .env("TERMINALX_TEST_CLOUD_MERGE", if managed { "managed" } else { "personal" })
            .env("TERMINALX_HOME", root.path().canonicalize().unwrap()).output().unwrap();
        assert!(out.status.success(), "managed={managed}\n{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    }
}

struct PausedGithub {
    reached: std::sync::mpsc::Sender<()>,
    release: Mutex<std::sync::mpsc::Receiver<()>>,
    after_merge: bool,
}
impl Github for PausedGithub {
    fn pull_request(&self, repository: &str, number: u64) -> Result<PrSnapshot> {
        let snapshot = ReadersGh.pull_request(repository, number)?;
        if !self.after_merge {
            self.reached.send(()).unwrap();
            self.release.lock().unwrap().recv_timeout(Duration::from_secs(15)).unwrap();
        }
        Ok(snapshot)
    }
    fn merge(&self, repository: &str, number: u64, method: &str, commit: &str) -> Result<PinnedMerge> {
        if self.after_merge {
            // A physical refusal followed by the outer merge's reconciliation.
            let mut command = Command::new(crate::binpath::resolve("gh").unwrap());
            command.args(["refuse", "merge"]);
            crate::github_process::output(command, Duration::from_secs(10), None)?;
            self.reached.send(()).unwrap();
            self.release.lock().unwrap().recv_timeout(Duration::from_secs(15)).unwrap();
            anyhow::bail!("injected lost merge response");
        }
        ReadersGh.merge(repository, number, method, commit)
    }
}

#[test]
fn privacy_cloud_child() {
    use std::os::unix::fs::PermissionsExt;
    let Ok(kind) = std::env::var("TERMINALX_TEST_CLOUD_MERGE") else { return };
    let managed = kind == "managed";
    let root = crate::store::root().unwrap();
    let bin = root.join("bin"); std::fs::create_dir_all(&bin).unwrap();
    let gh = bin.join("gh");
    let snapshot = serde_json::json!({"number":7,"state":"OPEN","headRefOid":HEAD,"headRefName":ready().branch,
        "baseRefName":"main","url":"https://github.com/acme/widgets/pull/7","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","isDraft":false,"statusCheckRollup":[]});
    crate::store::write_json(&root.join("snapshot.json"), &snapshot).unwrap();
    std::fs::write(&gh, r#"#!/bin/sh
printf '%s\n' "$*" >> "$TERMINALX_HOME/calls"
case "$*" in
 'pr view '*) cat "$TERMINALX_HOME/snapshot.json" ;;
 'pr checks '*) printf '[]\n' ;;
 'api '*'/actions/runs?'*) printf '[{"total_count":0,"workflow_runs":[]}]\n' ;;
 'api '*'/check-suites?'*) printf '[{"total_count":0,"check_suites":[]}]\n' ;;
 'api '*'/check-runs?'*) printf '[{"total_count":0,"check_runs":[]}]\n' ;;
 'api '*'/status?'*) printf '[{"total_count":0,"statuses":[]}]\n' ;;
 'pr merge '*)
   case "$*" in *'--match-head-commit 1111111111111111111111111111111111111111'*) ;; *) exit 91 ;; esac
   if [ -f "$TERMINALX_HOME/hold" ]; then printf '%s\n' "$$" > "$TERMINALX_HOME/held"; exec /bin/sleep 30; fi
   : > "$TERMINALX_HOME/merged" ;;
 'refuse merge') exit 1 ;;
 *) exit 92 ;;
esac
"#).unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(crate::binpath::set_priority_dir(&bin));
    let settings = IssuePipelineSettings { allow_no_ci:true, ..settings() };
    let attempt = || merge(&ReadersGh, &ready(), "acme/widgets", &settings);
    policy(true, managed); assert!(attempt().is_err()); assert!(calls(&root).is_empty());
    policy(false, managed);
    let queued = crate::github_process::queued(attempt);
    policy(true, managed); policy(false, managed);
    assert!(queued().is_err()); assert!(calls(&root).is_empty());
    for after_merge in [false, true] {
        let (reached, arrived) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel();
        let github = PausedGithub { reached, release:Mutex::new(released), after_merge };
        std::thread::scope(|scope| {
            let worker = scope.spawn(|| merge(&github, &ready(), "acme/widgets", &settings));
            arrived.recv_timeout(Duration::from_secs(15)).unwrap();
            let before = calls(&root);
            policy(true, managed); policy(false, managed);
            release.send(()).unwrap();
            assert!(worker.join().unwrap().is_err());
            assert_eq!(calls(&root), before, "cloud merge renewed authority between snapshot/mutation/reconciliation");
            assert!(!root.join("merged").exists());
        });
    }
    std::fs::write(root.join("hold"), "").unwrap();
    std::thread::scope(|scope| {
        let worker = scope.spawn(attempt);
        let until = std::time::Instant::now() + Duration::from_secs(15);
        while !root.join("held").exists() { assert!(!worker.is_finished() && std::time::Instant::now() < until); std::thread::sleep(Duration::from_millis(5)); }
        let pid: i32 = std::fs::read_to_string(root.join("held")).unwrap().trim().parse().unwrap();
        policy(true, managed);
        assert_eq!(unsafe { libc::kill(pid,0) }, -1, "merge process must drain before acknowledgement");
        assert!(worker.join().unwrap().is_err());
        assert!(!root.join("merged").exists());
    });
    std::fs::remove_file(root.join("hold")).unwrap();
    policy(false, managed);
    #[cfg(feature="desktop")]
    {
        use std::future::Future;
        use std::task::{Context, Waker};
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).max_blocking_threads(1).enable_all().build().unwrap();
        tauri::async_runtime::set(runtime.handle().clone());
        let (entered, arrived) = std::sync::mpsc::channel(); let (release, released) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || { entered.send(()).unwrap(); released.recv().unwrap(); });
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        let before = calls(&root);
        let mut pending = Box::pin(crate::commands::issue_pipeline_merge_cloud(ready(), "acme/widgets".into(), Some(settings.clone())));
        { let _runtime = runtime.enter(); assert!(pending.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending()); }
        policy(true, managed); policy(false, managed); release.send(()).unwrap(); runtime.block_on(blocker).unwrap();
        assert!(runtime.block_on(pending).is_err()); assert_eq!(calls(&root),before, "production IPC renewed a queued request");
        assert!(matches!(runtime.block_on(crate::commands::issue_pipeline_merge_cloud(ready(), "acme/widgets".into(), Some(settings.clone()))).unwrap(), CloudMerge::Accepted{..}));
    }
    assert!(matches!(attempt().unwrap(), CloudMerge::Accepted{..}));
    assert!(root.join("merged").exists(), "fresh restoration must reach the physical pinned merge");
}
