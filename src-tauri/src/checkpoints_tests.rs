//! PRO-261: a chat reset puts the checkout back to the END of the chosen turn.
use super::tests::{done, fixture, prompt, second_tab};
use super::*;

fn observe_in(session: &index::SessionEntry, seq: u64, mut event: Payload) {
    observe(&session.id, &session.tabs[0].id, seq, &mut event).unwrap();
}
fn read(repo: &tempfile::TempDir, path: &str) -> Option<String> {
    std::fs::read_to_string(repo.path().join(path)).ok()
}

fn bytes(repo: &tempfile::TempDir, path: &str) -> Vec<u8> {
    std::fs::read(repo.path().join(path)).unwrap()
}

/// With `core.autocrlf` on, a turn that changes only a file's line endings.
fn ending_only_turn(repo: &tempfile::TempDir, session: &index::SessionEntry) {
    git::run(repo.path(), &["config", "core.autocrlf", "true"]).unwrap();
    std::fs::write(repo.path().join("a.txt"), "one\ntwo\n").unwrap();
    git::run(repo.path(), &["add", "a.txt"]).unwrap();
    git::run(repo.path(), &["commit", "-qm", "Two lines"]).unwrap();
    std::fs::write(repo.path().join("a.txt"), "one\ntwo\n").unwrap();
    observe_in(session, 1, prompt(false));
    std::fs::write(repo.path().join("a.txt"), "one\r\ntwo\r\n").unwrap();
    observe_in(session, 2, done());
}

#[test]
fn a_turn_that_only_changes_line_endings_is_listed_and_undone_exactly() {
    let _home = store::temp_home();
    let (repo, session) = fixture();
    let tab = &session.tabs[0].id;
    ending_only_turn(&repo, &session);
    let turn = get(&session.id, tab, 1).unwrap().unwrap();
    assert_eq!(turn.files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(), ["a.txt"]);
    let undone = undo(&session.id, tab, 1, None).unwrap();
    assert!(undone.undone, "overlap: {:?}", undone.overlap);
    assert_eq!(bytes(&repo, "a.txt"), b"one\ntwo\n");
    let restored = restore_undo(&session.id, tab, 1, None).unwrap();
    assert!(restored.undone, "overlap: {:?}", restored.overlap);
    assert_eq!(bytes(&repo, "a.txt"), b"one\r\ntwo\r\n");
}

#[test]
fn a_hand_edit_of_line_endings_alone_needs_confirmation_and_a_later_one_voids_it() {
    let _home = store::temp_home();
    let (repo, session) = fixture();
    let tab = &session.tabs[0].id;
    ending_only_turn(&repo, &session);
    std::fs::write(repo.path().join("a.txt"), "one\r\ntwo\n").unwrap();
    let asked = undo(&session.id, tab, 1, None).unwrap();
    assert!(!asked.undone);
    assert_eq!(asked.overlap, ["a.txt"]);
    std::fs::write(repo.path().join("a.txt"), "one\ntwo\r\n").unwrap();
    let stale = undo(&session.id, tab, 1, Some(&asked.token)).unwrap();
    assert!(!stale.undone, "the token named the file as it was");
    assert_eq!(bytes(&repo, "a.txt"), b"one\ntwo\r\n");
    assert!(undo(&session.id, tab, 1, Some(&stale.token)).unwrap().undone);
    assert_eq!(bytes(&repo, "a.txt"), b"one\ntwo\n");
}

#[test]
fn a_reset_and_its_undo_put_back_exact_line_endings() {
    let _home = store::temp_home();
    let (repo, session) = fixture();
    let tab = &session.tabs[0].id;
    ending_only_turn(&repo, &session);
    observe_in(&session, 3, prompt(false));
    std::fs::write(repo.path().join("a.txt"), "one\ntwo\r\n").unwrap();
    observe_in(&session, 4, done());
    let plan = plan_reset(&session.id, tab, 2).unwrap();
    assert_eq!(plan.paths, ["a.txt"]);
    apply_reset(&session.id, tab, &plan, "55555555-5555-4555-8555-555555555555").unwrap();
    assert_eq!(bytes(&repo, "a.txt"), b"one\r\ntwo\r\n");
    let back = plan_reset_undo(&session.id, tab, "55555555-5555-4555-8555-555555555555").unwrap().unwrap();
    assert!(back.overlap.is_empty());
    apply_reset(&session.id, tab, &back, "unused").unwrap();
    assert_eq!(bytes(&repo, "a.txt"), b"one\ntwo\r\n");
}

#[test]
fn a_checkpoint_saved_before_exact_bytes_loads_and_saves_the_same_shape() {
    let saved = serde_json::json!({ "seq": 1, "number": 1, "cwd": "/repo", "start": "aaaaaaa", "index": null, "end": "bbbbbbb", "endIndex": null, "reviewed": false, "undone": false, "files": [] });
    let turn: Checkpoint = serde_json::from_value(saved).unwrap();
    assert_eq!((turn.start_kept.as_deref(), turn.end_kept.as_deref()), (None, None));
    let written = serde_json::to_value(&turn).unwrap();
    assert!(written.get("startKept").is_none() && written.get("endKept").is_none());
}

/// Turn 1 writes a.txt; turn 2 rewrites it, stages it and adds b.txt.
fn two_turns(repo: &tempfile::TempDir, session: &index::SessionEntry) {
    observe_in(session, 1, prompt(false));
    std::fs::write(repo.path().join("a.txt"), "first\n").unwrap();
    observe_in(session, 2, done());
    observe_in(session, 3, prompt(false));
    std::fs::write(repo.path().join("a.txt"), "second\n").unwrap();
    git::run(repo.path(), &["add", "a.txt"]).unwrap();
    std::fs::write(repo.path().join("b.txt"), "new\n").unwrap();
    observe_in(session, 4, done());
}

#[test]
fn reset_restores_the_turns_end_checkpoint_and_undo_puts_the_later_files_back() {
    let _home = store::temp_home();
    let (repo, session) = fixture();
    let tab = &session.tabs[0].id;
    two_turns(&repo, &session);
    let end = get(&session.id, tab, 1).unwrap().unwrap();
    let plan = plan_reset(&session.id, tab, 2).unwrap();
    assert_eq!(plan.paths, vec!["a.txt", "b.txt"]);
    assert!(plan.overlap.is_empty(), "only this chat's later turn changed them: {:?}", plan.overlap);
    assert!(confirm_overlap(&plan, None), "nothing to confirm");
    let applied = apply_reset(&session.id, tab, &plan, "11111111-1111-4111-8111-111111111111").unwrap();
    assert_eq!(applied.paths.len(), 2);
    // The worktree and staging match the end checkpoint of turn 1 exactly.
    assert_eq!(git::snapshot_tree(repo.path()).unwrap(), end.end.clone().unwrap());
    assert_eq!(index_tree(repo.path()).unwrap(), end.end_index.clone().unwrap());
    assert_eq!(read(&repo, "a.txt").as_deref(), Some("first\n"));
    assert_eq!(read(&repo, "b.txt"), None);
    git::run(repo.path(), &["gc", "--prune=now"]).unwrap();

    assert!(reset_has_files(&session.id, tab, "11111111-1111-4111-8111-111111111111"));
    assert!(plan_reset_undo(&session.id, tab, "another-reset").unwrap().is_none());
    let undo = plan_reset_undo(&session.id, tab, "11111111-1111-4111-8111-111111111111").unwrap().unwrap();
    assert!(undo.overlap.is_empty());
    apply_reset(&session.id, tab, &undo, "unused").unwrap();
    assert_eq!(read(&repo, "a.txt").as_deref(), Some("second\n"));
    assert_eq!(read(&repo, "b.txt").as_deref(), Some("new\n"));
    assert_eq!(git::run(repo.path(), &["show", ":a.txt"]).unwrap(), "second\n");
    assert!(!reset_has_files(&session.id, tab, "11111111-1111-4111-8111-111111111111"));
}

#[test]
fn other_chats_and_hand_edits_need_confirmation_and_only_the_shown_plans_token_confirms() {
    let _home = store::temp_home();
    let (repo, session) = fixture();
    let tab = &session.tabs[0].id;
    two_turns(&repo, &session);
    // Another session in the checkout edits c.txt after turn 1 ended.
    let peer = second_tab(&session, true);
    observe(&peer.id, &peer.tabs[0].id, 1, &mut prompt(false)).unwrap();
    std::fs::write(repo.path().join("c.txt"), "peer\n").unwrap();
    observe(&peer.id, &peer.tabs[0].id, 2, &mut done()).unwrap();
    let plan = plan_reset(&session.id, tab, 2).unwrap();
    assert_eq!(plan.overlap, vec!["c.txt"]);
    assert!(!confirm_overlap(&plan, None), "a request without the token only shows the overlap");
    // A hand edit after the warning makes the shown list stale: its token no longer confirms.
    std::fs::write(repo.path().join("d.txt"), "by hand\n").unwrap();
    let stale = plan_reset(&session.id, tab, 2).unwrap();
    assert_eq!(stale.overlap, vec!["c.txt", "d.txt"]);
    assert!(!confirm_overlap(&stale, Some(plan.token())));
    // A plan made before a change can no longer be applied.
    std::fs::write(repo.path().join("d.txt"), "again\n").unwrap();
    assert!(apply_reset(&session.id, tab, &stale, "22222222-2222-4222-8222-222222222222").is_err());
    assert_eq!(read(&repo, "a.txt").as_deref(), Some("second\n"));
    let fresh = plan_reset(&session.id, tab, 2).unwrap();
    assert!(!confirm_overlap(&fresh, None));
    // Nothing is remembered: a cancelled dialog, or a plain request from another window, never confirms.
    let again = plan_reset(&session.id, tab, 2).unwrap();
    assert!(!confirm_overlap(&again, None), "asking again without the token does not confirm");
    assert!(confirm_overlap(&again, Some(fresh.token())), "the token of the plan that was shown confirms it");
    let applied = apply_reset(&session.id, tab, &again, "22222222-2222-4222-8222-222222222222").unwrap();
    assert_eq!(read(&repo, "c.txt"), None);
    assert_eq!(read(&repo, "d.txt"), None);
    // A failed conversation commit puts every file back.
    revert_reset(&session.id, tab, &applied).unwrap();
    assert_eq!(read(&repo, "c.txt").as_deref(), Some("peer\n"));
    assert_eq!(read(&repo, "d.txt").as_deref(), Some("again\n"));
    assert_eq!(read(&repo, "a.txt").as_deref(), Some("second\n"));
    assert!(!reset_has_files(&session.id, tab, "22222222-2222-4222-8222-222222222222"));
}

#[test]
fn undo_warns_about_edits_made_after_the_reset() {
    let _home = store::temp_home();
    let (repo, session) = fixture();
    let tab = &session.tabs[0].id;
    two_turns(&repo, &session);
    let generation = "33333333-3333-4333-8333-333333333333";
    apply_reset(&session.id, tab, &plan_reset(&session.id, tab, 2).unwrap(), generation).unwrap();
    std::fs::write(repo.path().join("a.txt"), "after reset\n").unwrap();
    let undo = plan_reset_undo(&session.id, tab, generation).unwrap().unwrap();
    assert_eq!(undo.overlap, vec!["a.txt"]);
    assert!(!confirm_overlap(&undo, None));
    assert_eq!(read(&repo, "a.txt").as_deref(), Some("after reset\n"));
}

#[test]
fn a_turn_without_a_finished_checkpoint_cannot_reset_files() {
    let _home = store::temp_home();
    let (repo, session) = fixture();
    let tab = &session.tabs[0].id;
    assert!(plan_reset(&session.id, tab, 2).err().unwrap().to_string().contains("no saved file checkpoint"));
    observe_in(&session, 1, prompt(false));
    std::fs::write(repo.path().join("a.txt"), "running\n").unwrap();
    assert!(plan_reset(&session.id, tab, 2).is_err());
}

#[test]
fn a_hand_edit_after_the_last_turn_to_a_file_this_chat_changed_needs_confirmation() {
    let _home = store::temp_home();
    let (repo, session) = fixture();
    let tab = &session.tabs[0].id;
    two_turns(&repo, &session);
    // Turn 2 wrote a.txt (and staged it); then the person edits it by hand.
    std::fs::write(repo.path().join("a.txt"), "by hand after turn 2\n").unwrap();
    let plan = plan_reset(&session.id, tab, 2).unwrap();
    assert_eq!(plan.overlap, vec!["a.txt"], "the edit is not turn 2's, so it is shown before it is overwritten");
    // Staging it by hand counts too, even with the worktree put back.
    std::fs::write(repo.path().join("a.txt"), "second\n").unwrap();
    assert!(plan_reset(&session.id, tab, 2).unwrap().overlap.is_empty(), "back as turn 2 left it");
    std::fs::write(repo.path().join("b.txt"), "staged by hand\n").unwrap();
    git::run(repo.path(), &["add", "b.txt"]).unwrap();
    std::fs::write(repo.path().join("b.txt"), "new\n").unwrap();
    assert_eq!(plan_reset(&session.id, tab, 2).unwrap().overlap, vec!["b.txt"]);
}

#[test]
fn turns_an_earlier_reset_cut_off_are_not_this_chats_own() {
    let _home = store::temp_home();
    let (repo, session) = fixture();
    let tab = &session.tabs[0].id;
    two_turns(&repo, &session);
    // Reset to turn 1 with its files: turn 2 (seq 3-4) is cut off.
    let first = plan_reset(&session.id, tab, 2).unwrap();
    apply_reset(&session.id, tab, &first, "44444444-4444-4444-8444-444444444444").unwrap();
    sync_live_turns(&session.id, tab, &[1, 2].into_iter().collect()).unwrap();
    // The chat goes on: a new turn writes e.txt.
    observe_in(&session, 10, prompt(false));
    std::fs::write(repo.path().join("e.txt"), "new turn\n").unwrap();
    observe_in(&session, 11, done());
    // By hand, a.txt gets exactly what the cut-off turn 2 had written.
    std::fs::write(repo.path().join("a.txt"), "second\n").unwrap();
    let plan = plan_reset(&session.id, tab, 2).unwrap();
    assert_eq!(plan.paths, vec!["a.txt", "e.txt"]);
    assert_eq!(plan.overlap, vec!["a.txt"], "turn 2 is no longer part of this chat, so a.txt is someone else's change");
    // Undo brings turn 2 back into the conversation, and its files are its own again.
    sync_live_turns(&session.id, tab, &[1, 2, 3, 4].into_iter().collect()).unwrap();
    assert!(load(&session.id, tab).unwrap().turns.iter().all(|turn| !turn.abandoned || turn.seq == 10));
}

