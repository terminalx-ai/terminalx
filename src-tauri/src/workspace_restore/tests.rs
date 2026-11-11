use super::*;
use crate::{
    session_ops::{self, Confirmation, SessionsFate, WorkspaceRemoval},
    sink::BroadcastSink,
};

fn fixture() -> (tempfile::TempDir, SessionEntry, RemovedWorkspace) {
    let repo = tempfile::tempdir().unwrap();
    let project = std::fs::canonicalize(repo.path()).unwrap();
    for args in [vec!["init", "-q", "-b", "main"], vec!["config", "user.name", "Test"], vec!["config", "user.email", "test@example.com"]] {
        git::run(&project, &args).unwrap();
    }
    std::fs::write(project.join("tracked.txt"), "committed\n").unwrap();
    git::run(&project, &["add", "."]).unwrap();
    git::run(&project, &["commit", "-qm", "initial"]).unwrap();
    let path = git::worktree_root(&project).join("restore-me");
    git::run(&project, &["worktree", "add", "-b", "topic", path.to_str().unwrap()]).unwrap();
    let session: SessionEntry = serde_json::from_value(serde_json::json!({
        "id": "retained", "projectPath": project, "cwd": path, "worktreeName": "restore-me", "branch": "stale-cached-branch",
        "title": "Keep this conversation", "created": index::now(), "modified": index::now(), "archived": true,
        "activeTab": "tab", "tabs": [{"id": "tab", "harness": "codex", "created": index::now(), "providerSessionId": "native-conversation"}]
    }))
    .unwrap();
    index::save(std::slice::from_ref(&session)).unwrap();
    let removed = removal_record(&project, &path);
    let request = WorkspaceRemoval {
        project_path: project.to_str().unwrap(),
        path: path.to_str().unwrap(),
        sessions: SessionsFate::Keep,
        delete_branch: false,
        confirmation: Confirmation::Forced,
        expected_sessions: None,
        direct: git::DirectDelete::Allowed,
        fetch: crate::landed::Fetch::Skip,
        guard: None,
        archive: None,
        archive_failure: None,
        archive_retry: None,
        archive_started: None,
    };
    session_ops::remove_workspace(&BroadcastSink::new(16), &request, &|_| {}).unwrap();
    (repo, index::get(&session.id).unwrap(), removed)
}

fn restore_preview(preview: &Preview, branch: Option<&str>) -> Result<Vec<SessionEntry>> {
    restore(&BroadcastSink::new(16), "retained", preview, branch, &|_| Ok(()))
}

fn assert_absent(project: &Path, path: &str, branch: &str) {
    assert!(!Path::new(path).exists());
    assert!(!git::list_worktrees(project).unwrap().iter().any(|(p, _)| p == path));
    assert!(branch_tip(project, branch).is_none());
    assert!(index::get("retained").unwrap().worktree_removed);
}

#[test]
fn records_actual_head_and_branch_and_restores_all_retained_tabs() {
    let _home = crate::store::temp_home();
    let (_repo, session, removed) = fixture();
    assert_eq!(session.removed_workspace.as_ref(), Some(&removed));
    assert_eq!(removed.branch.as_deref(), Some("topic"));
    let mut sibling = session.clone();
    sibling.id = "sibling".into();
    index::save(&[session, sibling]).unwrap();
    let plan = preview("retained").unwrap();
    assert!(plan.needs_branch.is_none());
    assert_eq!(plan.session_ids.len(), 2);
    let stopped = std::cell::RefCell::new(Vec::new());
    let restored = restore(&BroadcastSink::new(16), "retained", &plan, None, &|entry| {
        stopped.borrow_mut().push(entry.id.clone());
        Ok(())
    })
    .unwrap();
    assert_eq!(stopped.borrow().len(), 2);
    assert_eq!(git::head_commit(Path::new(&plan.path)), removed.commit);
    assert_eq!(git::current_branch(Path::new(&plan.path)).as_deref(), Some("topic"));
    for entry in restored {
        assert!(!entry.worktree_removed && !entry.archived && entry.removed_workspace.is_none());
        assert_eq!(entry.cwd, plan.path);
        assert_eq!(entry.tabs[0].provider_session_id.as_deref(), Some("native-conversation"));
    }
}

#[test]
fn deleted_moved_occupied_and_detached_branches_offer_a_new_branch_at_removal_head() {
    for scenario in ["deleted", "moved", "occupied", "detached"] {
        let _home = crate::store::temp_home();
        let (repo, _, removed) = fixture();
        let original = removed.commit.unwrap();
        match scenario {
            "deleted" => {
                git::run(repo.path(), &["branch", "-D", "topic"]).unwrap();
            }
            "moved" => {
                git::run(repo.path(), &["commit", "--allow-empty", "-qm", "later"]).unwrap();
                git::run(repo.path(), &["branch", "-f", "topic", "HEAD"]).unwrap();
            }
            "occupied" => {
                git::run(repo.path(), &["worktree", "add", repo.path().join("elsewhere").to_str().unwrap(), "topic"]).unwrap();
            }
            "detached" => {
                index::update_session("retained", |entry| {
                    entry.removed_workspace.as_mut().unwrap().branch = None;
                    Ok(())
                })
                .unwrap();
            }
            _ => unreachable!(),
        }
        let plan = preview("retained").unwrap();
        assert!(plan.needs_branch.is_some(), "{scenario}");
        assert!(restore_preview(&plan, None).is_err());
        let tip = branch_tip(repo.path(), "topic");
        restore_preview(&plan, Some(&plan.suggested_branch)).unwrap();
        assert_eq!(git::head_commit(Path::new(&plan.path)), Some(original));
        assert_eq!(git::current_branch(Path::new(&plan.path)), Some(plan.suggested_branch));
        assert_eq!(branch_tip(repo.path(), "topic"), tip, "the original branch is never reset");
    }
}

#[test]
fn conflicts_and_stale_previews_leave_everything_intact() {
    let _home = crate::store::temp_home();
    let (repo, session, _) = fixture();
    let plan = preview("retained").unwrap();
    std::fs::create_dir(&plan.path).unwrap();
    std::fs::write(Path::new(&plan.path).join("keep"), "mine").unwrap();
    assert!(restore_preview(&plan, Some("new-branch")).unwrap_err().to_string().contains("path is taken"));
    assert_eq!(std::fs::read_to_string(Path::new(&plan.path).join("keep")).unwrap(), "mine");
    std::fs::remove_dir_all(&plan.path).unwrap();
    git::run(repo.path(), &["branch", "-D", "topic"]).unwrap();
    assert!(restore_preview(&plan, Some("new-branch")).is_err());
    assert_absent(repo.path(), &plan.path, "new-branch");
    assert_eq!(index::get("retained").unwrap(), session);
    index::update_session("retained", |entry| {
        entry.removed_workspace.as_mut().unwrap().commit = Some("1".repeat(40));
        Ok(())
    })
    .unwrap();
    assert!(preview("retained").unwrap_err().to_string().contains("commit is missing"));
}

#[test]
fn legacy_records_use_the_existing_branch_only_and_report_missing_provenance() {
    let _home = crate::store::temp_home();
    let (repo, _, _) = fixture();
    index::update_session("retained", |entry| {
        entry.removed_workspace.as_mut().unwrap().commit = None;
        Ok(())
    })
    .unwrap();
    let plan = preview("retained").unwrap();
    assert!(plan.legacy);
    git::run(repo.path(), &["branch", "-D", "topic"]).unwrap();
    assert!(preview("retained").unwrap_err().to_string().contains("No removal commit"));
    assert_absent(repo.path(), &plan.path, "topic-restored");
}

#[test]
fn suggestions_avoid_existing_refs_and_ref_directory_conflicts() {
    let _home = crate::store::temp_home();
    let (repo, _, _) = fixture();
    git::run(repo.path(), &["branch", "topic-restored/nested"]).unwrap();
    git::run(repo.path(), &["branch", "topic-restored-2"]).unwrap();
    let plan = preview("retained").unwrap();
    assert_eq!(plan.suggested_branch, "topic-restored-3");
    assert!(restore_preview(&plan, Some("topic-restored")).is_err());
    assert!(restore_preview(&plan, Some("topic/child")).is_err());
    assert!(!Path::new(&plan.path).exists());
}

#[test]
fn rejects_invalid_taken_names_and_stop_failures_before_creating_files() {
    let _home = crate::store::temp_home();
    let (repo, _, _) = fixture();
    let plan = preview("retained").unwrap();
    for branch in ["topic", "-bad", "../bad", "bad name", "HEAD", "@{-1}"] {
        assert!(restore_preview(&plan, Some(branch)).is_err(), "{branch}");
        assert!(!Path::new(&plan.path).exists());
    }
    assert!(restore(&BroadcastSink::new(16), "retained", &plan, Some("new-branch"), &|_| anyhow::bail!("cannot stop")).is_err());
    assert_absent(repo.path(), &plan.path, "new-branch");
}

#[test]
fn checkout_failure_rolls_back_the_reserved_directory_and_new_branch() {
    let _home = crate::store::temp_home();
    let (repo, _, _) = fixture();
    // A required smudge filter fails while Git populates the checkout.
    git::run(repo.path(), &["config", "filter.fail.smudge", "false"]).unwrap();
    // Only the checkout fails: Git also cleans tracked.txt when it re-reads it
    // (a racily clean index entry), and a required filter needs both commands.
    git::run(repo.path(), &["config", "filter.fail.clean", "cat"]).unwrap();
    git::run(repo.path(), &["config", "filter.fail.required", "true"]).unwrap();
    std::fs::write(repo.path().join(".gitattributes"), "tracked.txt filter=fail\n").unwrap();
    git::run(repo.path(), &["add", ".gitattributes"]).unwrap();
    git::run(repo.path(), &["commit", "-qm", "filter"]).unwrap();
    let commit = git::head_commit(repo.path()).unwrap();
    index::update_session("retained", |entry| {
        entry.removed_workspace.as_mut().unwrap().commit = Some(commit);
        Ok(())
    })
    .unwrap();
    let plan = preview("retained").unwrap();
    assert!(restore_preview(&plan, Some("new-branch")).is_err());
    assert_absent(repo.path(), &plan.path, "new-branch");
}

#[test]
fn a_session_changed_during_stop_is_not_restored() {
    let _home = crate::store::temp_home();
    let (repo, _, _) = fixture();
    let plan = preview("retained").unwrap();
    // The second preview catches this without creating either Git resource.
    assert!(restore(&BroadcastSink::new(16), "retained", &plan, Some("new-branch"), &|_| {
        index::update_session("retained", |entry| {
            entry.worktree_removed = false;
            Ok(())
        })?;
        Ok(())
    })
    .is_err());
    assert!(!Path::new(&plan.path).exists());
    assert!(branch_tip(repo.path(), "new-branch").is_none());
}

#[cfg(unix)]
#[test]
fn refuses_a_dangling_symlink_at_the_path() {
    let _home = crate::store::temp_home();
    let (_repo, _, removed) = fixture();
    std::os::unix::fs::symlink("/missing-target", &removed.path).unwrap();
    assert!(preview("retained").unwrap_err().to_string().contains("path is taken"));
}

#[test]
fn index_failure_after_checkout_rolls_back_the_checkout_and_branch() {
    let _home = crate::store::temp_home();
    let (repo, session, _) = fixture();
    let plan = preview("retained").unwrap();
    let failure = |expected: &Preview, _: &RemovedWorkspace, _: &str| {
        assert!(Path::new(&expected.path).join("tracked.txt").exists());
        anyhow::bail!("index write failed")
    };
    let error = restore_with(&BroadcastSink::new(16), "retained", &plan, Some("new-branch"), &|_| Ok(()), &failure).unwrap_err();
    assert!(error.to_string().contains("index write failed"));
    assert_absent(repo.path(), &plan.path, "new-branch");
    assert_eq!(index::get("retained").unwrap(), session);
}
