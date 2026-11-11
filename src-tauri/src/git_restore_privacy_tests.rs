//! The actual Undo command's blocking dispatch -> authenticated Sessions ->
//! owner restore, backed by real deleted worktrees and remote branch refs.
use super::*;
use std::future::Future;
use std::task::{Context, Waker};
use serde_json::{json, Value};
use crate::github_process::tests::transport::{acknowledge, service};
use crate::local_runtime::{client::Client, sessions::Sessions};

pub(super) fn run(root: &Path, managed: bool, runtime: &tokio::runtime::Runtime) {
    for kind in ["enabled-origin", "off-on-queue", "fresh"] {
        let _environment = Environment::new(root);
        policy(false, managed);
        let f = Fixture::new(root, &format!("restore-{kind}"));
        f.workspace("git.pull").unwrap();
        crate::store::projects::add(f.cwd.to_str().unwrap()).unwrap();
        let created = crate::git::create_worktree(&f.cwd, &format!("undo-{kind}"), None).unwrap();
        let reference = format!("refs/heads/{}", created.branch);
        let commit = git(Path::new(&created.path), &["rev-parse", "HEAD"]);
        // Set up and really delete the remote/local refs. Only the removal
        // ledger is supplied directly; the restore implementation is real.
        git(&f.cwd, &["push", "origin", &format!("{commit}:{reference}")]);
        assert_eq!(git(&f.origin, &["rev-parse", &reference]), commit);
        git(&f.cwd, &["push", "origin", &format!(":{reference}")]);
        git(&f.cwd, &["worktree", "remove", &created.path]);
        git(&f.cwd, &["branch", "-D", &created.branch]);
        assert!(!raw(&f.origin, &["rev-parse", "--verify", &reference]).status.success());
        let id = format!("privacy-restore-{kind}");
        let session_id = format!("privacy-restored-session-{kind}");
        let at = "2026-10-12T00:00:00Z";
        let session: crate::store::index::SessionEntry = serde_json::from_value(json!({
            "id":session_id,"projectPath":f.cwd,"cwd":f.cwd,"title":"Retained conversation",
            "created":at,"modified":at,"worktreeRemoved":true,
            "removedWorkspace":{"path":created.path,"name":created.name,"branch":created.branch},
            "tabs":[]
        })).unwrap();
        crate::store::index::update(|sessions| { sessions.push(session.clone()); Ok(()) }).unwrap();
        let record = crate::merged_cleanup::Record {
            id:id.clone(), removed_at:at.into(), project_path:f.cwd.to_string_lossy().into_owned(),
            path:created.path.clone(), name:created.name, branch:created.branch.clone(), commit:commit.clone(),
            pr:crate::merged_cleanup::PrRef { number:1,title:"Recorded fixture removal".into(),url:"https://example.test/pr/1".into(),head:commit.clone() },
            local_branch:crate::merged_cleanup::BranchFate::Deleted, remote_branch:crate::merged_cleanup::BranchFate::Deleted,
            sessions_kept:vec![session_id.clone()], sessions_deleted:Vec::new(), restored_at:None,
        };
        let file = root.join("merged-cleanup.json");
        let mut ledger: Value = crate::store::read_json(&file).unwrap().unwrap_or_else(|| json!({"removed":[]}));
        ledger["removed"].as_array_mut().unwrap().push(serde_json::to_value(record).unwrap());
        crate::store::write_json(&file, &ledger).unwrap();
        let endpoint = crate::hooks::prepare_control().unwrap();
        let owner = service(root, &endpoint);
        let (_, _bridge) = crate::hooks::serve(endpoint.clone(), |_| crate::hooks::HookReply::default(), move |request| owner.handle(request)).unwrap();
        let client = Client::connect(root).unwrap();
        let before = f.transfers();
        acknowledge(&endpoint, kind == "enabled-origin", managed); client.refresh_data_privacy().unwrap();
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let blocker = runtime.spawn_blocking(move || {
            entered_tx.send(()).unwrap(); release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let owner_client = client.clone();
        let mut command = Box::pin(crate::commands::merged_cleanup_restore_work(id,
            move || Ok(Sessions::new(owner_client))));
        assert!(command.as_mut().poll(&mut Context::from_waker(Waker::noop())).is_pending());
        if kind == "off-on-queue" { acknowledge(&endpoint, true, managed); }
        acknowledge(&endpoint, false, managed); client.refresh_data_privacy().unwrap();
        release_tx.send(()).unwrap(); runtime.block_on(blocker).unwrap();
        let result = runtime.block_on(command).unwrap();
        assert!(Path::new(&created.path).join(FILE).exists(), "local worktree restoration survives denial");
        assert_eq!(git(Path::new(&created.path), &["rev-parse", "HEAD"]), commit);
        let session = crate::store::index::get(&session_id).unwrap();
        assert_eq!(session.cwd, created.path); assert!(!session.worktree_removed && session.removed_workspace.is_none());
        if kind == "fresh" {
            assert!(result["notes"].as_array().unwrap().is_empty(), "{result}");
            assert_eq!(git(&f.origin, &["rev-parse", &reference]), commit);
            assert!(f.transfers() > before, "fresh Undo must really restore the remote ref");
        } else {
            assert!(result["notes"].to_string().contains(data_privacy::MESSAGE), "explicit remote restoration warning: {result}");
            assert_eq!(f.transfers(), before, "queued Undo gained new permission to republish");
            assert!(!raw(&f.origin, &["rev-parse", "--verify", &reference]).status.success());
        }
    }
}
