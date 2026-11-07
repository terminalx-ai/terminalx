//! The durable reader queue and its real Stop-hook/PTY delivery path.
use super::*;
use crate::session::held::{Change, Queue};

fn change(rig: &Rig, change: Change) -> SendOutcome {
    rig.manager.change_held(SESSION, TAB, change).unwrap()
}
fn queue(rig: &Rig) -> Queue { rig.rt().lock().unwrap().held_queue.clone() }
fn enqueue(rig: &Rig, text: &str) {
    change(rig, Change::Enqueue { text: text.into(), images: Vec::new(), send_now: false });
}
fn hook(rig: &Rig, event: &str, payload: Value) {
    let rt = rig.rt();
    let token = match &rt.lock().unwrap().engine { Engine::Cli(cli) => cli.origin.token.clone(), _ => panic!("CLI") };
    rig.manager.on_hook(HookFrame { session: SESSION.into(), tab: TAB.into(), token, event: event.into(), payload });
}
fn prompt(rig: &Rig, text: &str) {
    rig.wait("the prompt typed", || rig.typed().contains(text));
    hook(rig, "UserPromptSubmit", json!({"prompt":text}));
}
fn started() -> Rig {
    let rig = Rig::new(claude_tab(None), LISTENS);
    rig.manager.send(SESSION, TAB, "initial".into(), Vec::new()).unwrap();
    rig.up();
    prompt(&rig, "initial");
    rig
}

#[test]
fn stop_delivers_one_held_follow_up_per_finished_turn_in_tray_order() {
    let rig = started();
    for text in ["one", "two", "three"] { enqueue(&rig, text); }
    assert_eq!(queue(&rig).items.len(), 3);
    assert!(!rig.typed().contains("one"));
    assert_eq!(rig.said().iter().filter(|line| line.starts_with("user:")).count(), 1);
    for (index, text) in ["one", "two", "three"].into_iter().enumerate() {
        hook(&rig, "Stop", json!({}));
        prompt(&rig, text);
        rig.wait("exactly one removed", || queue(&rig).items.len() == 2 - index && queue(&rig).sending.is_none());
        assert_eq!(rig.said().iter().filter(|line| line.starts_with("user:")).count(), index + 2);
    }
}

#[test]
fn edits_reorder_delete_pause_and_attachments_survive_reloading_the_tab_log() {
    let rig = started();
    for text in ["one", "two", "three"] { enqueue(&rig, text); }
    let items = queue(&rig).items;
    change(&rig, Change::Pause { paused: true });
    change(&rig, Change::Edit { id: items[0].id.clone(), text: "corrected".into() });
    change(&rig, Change::Move { id: items[2].id.clone(), before_id: Some(items[0].id.clone()) });
    change(&rig, Change::Delete { id: items[1].id.clone() });
    change(&rig, Change::Enqueue { text: "look".into(), images: vec![ImageInput { media_type: "image/png".into(), data: "aW1hZ2U=".into(), name: Some("shot.png".into()) }], send_now: false });
    let path = store::log_path(SESSION, TAB).unwrap();
    let restored = Queue::restore(&path).unwrap();
    assert_eq!(restored, queue(&rig));
    assert!(restored.paused);
    assert_eq!(restored.items.iter().map(|item| item.text.as_str()).collect::<Vec<_>>(), ["three", "corrected", "look"]);
    let image = unsent::image_input(&restored.items[2].images[0]).unwrap();
    assert_eq!((image.data.as_str(), image.name.as_deref()), ("aW1hZ2U=", Some("shot.png")));
    hook(&rig, "Stop", json!({}));
    // An explicit dispatch attempts the same eligibility check as the worker.
    rig.manager.deliver_held(SESSION, TAB).unwrap();
    assert_eq!(queue(&rig), restored);
    change(&rig, Change::Pause { paused: false });
    prompt(&rig, "three");
    rig.wait("resumed first item removed", || queue(&rig).items.len() == 2);
    assert_eq!(queue(&rig).items[0].text, "corrected");
    hook(&rig, "Stop", json!({}));
    prompt(&rig, "corrected");
    hook(&rig, "Stop", json!({}));
    rig.wait("attachment prompt recorded", || queue(&rig).items.is_empty());
    let events: Vec<AgentEvent> = store::read_lines(&path).unwrap();
    let images = events.iter().find_map(|event| match &event.payload {
        Payload::UserMessage { text, images, .. } if text == "look" => Some(images), _ => None,
    }).unwrap();
    assert_eq!(images.len(), 1);
    assert_eq!(unsent::image_input(&images[0]).unwrap().data, "aW1hZ2U=");
}

#[test]
fn a_failed_queue_write_never_acknowledges_or_changes_the_queue() {
    let rig = started();
    enqueue(&rig, "keep me");
    let original = queue(&rig);
    let rt = rig.rt();
    let path = rt.lock().unwrap().log_path.clone();
    // An unwritable target works even in CI running with broad permissions.
    rt.lock().unwrap().log_path = rig._dir.path().to_path_buf();
    assert!(rig.manager.change_held(SESSION, TAB, Change::Delete { id: original.items[0].id.clone() }).is_err());
    assert_eq!(queue(&rig), original);
    rt.lock().unwrap().log_path = path;
}

#[test]
fn a_claim_interrupted_by_restart_is_retained_and_paused_but_a_logged_send_is_not_repeated() {
    let rig = started();
    enqueue(&rig, "next");
    let mut claimed = queue(&rig);
    claimed.sending = Some(claimed.items[0].id.clone());
    claimed.next = claimed.sending.clone();
    rig.manager.save_held(&mut rig.rt().lock().unwrap(), claimed).unwrap();
    let path = store::log_path(SESSION, TAB).unwrap();
    let restored = Queue::restore(&path).unwrap();
    assert_eq!(restored.items.len(), 1);
    assert!(restored.paused && restored.sending.is_none() && restored.next.is_none());
    rig.manager.publish(&mut rig.rt().lock().unwrap(), Payload::UserMessage { text: "next".into(), author: None, images: Vec::new(), queued: false, baseline: None, cwd: None }, None);
    assert!(Queue::restore(&path).unwrap().items.is_empty());
}

#[test]
fn send_now_selects_the_requested_item_even_when_paused_and_hard_stop_keeps_the_rest() {
    let rig = started();
    for text in ["first", "chosen", "last"] { enqueue(&rig, text); }
    change(&rig, Change::Pause { paused: true });
    let id = queue(&rig).items[1].id.clone();
    change(&rig, Change::SendNow { id });
    // The stand-in reads Escape but has no interrupt hook: supply the same
    // aborted boundary a provider emits after it takes that Escape.
    rig.manager.close_open_turn(&mut rig.rt().lock().unwrap(), TurnStatus::Aborted, None);
    prompt(&rig, "chosen");
    rig.wait("chosen removed", || queue(&rig).items.len() == 2 && queue(&rig).sending.is_none());
    assert!(queue(&rig).paused);
    assert_eq!(queue(&rig).items.iter().map(|item| item.text.clone()).collect::<Vec<_>>(), ["first", "last"]);
    rig.manager.stop(SESSION, TAB).unwrap();
    assert_eq!(queue(&rig).items.len(), 2);
    assert!(queue(&rig).paused);
}

#[test]
fn reading_history_during_a_delivery_does_not_write_the_consumed_item_back() {
    let rig = started();
    enqueue(&rig, "next");
    let mut claimed = queue(&rig);
    claimed.sending = Some(claimed.items[0].id.clone());
    rig.manager.save_held(&mut rig.rt().lock().unwrap(), claimed).unwrap();
    rig.manager.publish(&mut rig.rt().lock().unwrap(), Payload::UserMessage { text: "next".into(), author: None, images: Vec::new(), queued: false, baseline: None, cwd: None }, None);
    let events = rig.manager.load_events(SESSION, TAB).unwrap();
    assert!(Queue::replay(&events).items.is_empty());
    assert!(Queue::restore(&store::log_path(SESSION, TAB).unwrap()).unwrap().items.is_empty());
}

#[test]
fn a_new_runtime_restores_held_messages_after_the_agent_has_stopped() {
    let rig = started();
    enqueue(&rig, "keep after restart");
    rig.manager.stop(SESSION, TAB).unwrap();
    let expected = queue(&rig);
    rig.manager.tabs.lock().unwrap().remove(&key_of(SESSION, TAB));
    let restored = queue(&rig);
    assert_eq!(restored, expected);
    assert!(restored.paused);
    assert_eq!(restored.items[0].text, "keep after restart");
}

#[test]
fn a_held_queue_keeps_an_unopened_session_out_of_the_idle_archive_after_restart() {
    let rig = started();
    enqueue(&rig, "still pending");
    rig.manager.stop(SESSION, TAB).unwrap();
    rig.manager.tabs.lock().unwrap().remove(&key_of(SESSION, TAB));
    let session = index::get(SESSION).unwrap();
    assert_eq!(crate::session_archive::busy(&rig.manager, &session, &[]), Some(crate::session_archive::Kept::Queued));
}

#[cfg(unix)]
#[test]
fn a_runtime_handover_waits_for_a_claimed_delivery_to_finish() {
    let rig = started();
    enqueue(&rig, "next");
    let mut claimed = queue(&rig);
    claimed.sending = Some(claimed.items[0].id.clone());
    rig.manager.save_held(&mut rig.rt().lock().unwrap(), claimed).unwrap();
    assert!(rig.manager.hold_tabs(Duration::from_secs(1), |_| ()).is_err());
}
