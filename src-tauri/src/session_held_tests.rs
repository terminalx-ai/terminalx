//! The durable reader queue and its real Stop-hook/PTY delivery path.
use super::*;
use crate::session::held::{Change, Queue};

fn change(rig: &Rig, change: Change) -> SendOutcome {
    rig.manager.change_held(SESSION, TAB, change).unwrap()
}
fn queue(rig: &Rig) -> Queue { rig.rt().lock().unwrap().held_queue.clone() }
fn enqueue(rig: &Rig, text: &str) {
    change(rig, Change::Enqueue { text: text.into(), images: Vec::new(), files: Vec::new(), send_now: false });
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
fn cli_queued_input_runs_before_held_follow_ups_without_pausing_the_app_queue() {
    let rig = started();
    // Enter under "now" types into the CLI; alternate Send holds in the app.
    // A prompt from another sender that the CLI queues has the same ordering.
    let sent = rig.manager.send(SESSION, TAB, "CLI first".into(), Vec::new()).unwrap();
    assert!(sent.queued);
    rig.wait("the CLI follow-up typed", || rig.typed().contains("CLI first"));
    for text in ["app second", "app third"] { enqueue(&rig, text); }
    let expected = queue(&rig);

    hook(&rig, "Stop", json!({}));
    assert!(matches!(&rig.rt().lock().unwrap().engine, Engine::Cli(cli) if !cli.held.is_empty()));
    // Exercise the worker before the next echo, independent of scheduling.
    rig.manager.deliver_held(SESSION, TAB).unwrap();
    assert_eq!(queue(&rig), expected);
    assert!(!rig.typed().contains("app second"));

    prompt(&rig, "CLI first");
    rig.cli_takes("CLI first", "CLI reply");
    rig.wait("the queued prompt's transcript echo", || matches!(&rig.rt().lock().unwrap().engine,
        Engine::Cli(cli) if cli.held.is_empty()));
    // Echoing the CLI prompt only starts its turn; it cannot deliver app input.
    rig.manager.deliver_held(SESSION, TAB).unwrap();
    assert_eq!(queue(&rig), expected);
    for (index, text) in ["app second", "app third"].into_iter().enumerate() {
        hook(&rig, "Stop", json!({}));
        prompt(&rig, text);
        rig.wait("one held item delivered", || queue(&rig).items.len() == 1 - index && queue(&rig).sending.is_none());
        assert!(!queue(&rig).paused);
        assert!(queue(&rig).error.is_none());
    }
}

#[test]
fn awaiting_cli_delivery_without_recovery_waits_for_the_next_finished_turn() {
    let rig = started();
    enqueue(&rig, "after CLI acceptance");
    change(&rig, Change::Pause { paused: true });
    hook(&rig, "Stop", json!({}));
    {
        let rt_arc = rig.rt();
        let mut rt = rt_arc.lock().unwrap();
        rt.held_queue.paused = false;
        if let Engine::Cli(cli) = &mut rt.engine { cli.awaiting_delivery = Some(1); }
    }
    let expected = queue(&rig);
    rig.manager.deliver_held(SESSION, TAB).unwrap();
    assert_eq!(queue(&rig), expected);
    assert!(!rig.typed().contains("after CLI acceptance"));
    hook(&rig, "UserPromptSubmit", json!({"prompt":"earlier CLI input"}));
    // Input typed into the CLI reaches the chat through its transcript, which
    // also opens the turn's close again (TurnTail::opened) for the Stop below.
    rig.cli_takes("earlier CLI input", "CLI reply");
    rig.wait("the CLI input's transcript record", || rig.said().iter().any(|line| line == "claude: CLI reply"));
    hook(&rig, "Stop", json!({}));
    prompt(&rig, "after CLI acceptance");
    rig.wait("held item delivered after acceptance", || queue(&rig).items.is_empty() && queue(&rig).sending.is_none());
    assert!(!queue(&rig).paused);
}

#[test]
fn cli_input_appearing_after_a_claim_releases_the_claim_without_pausing() {
    let rig = started();
    enqueue(&rig, "after the raced CLI input");
    change(&rig, Change::Pause { paused: true });
    hook(&rig, "Stop", json!({}));
    // Hold the normal send's sharing lock to let CLI state change between
    // the durable claim and its final send check, without sleeps or hooks.
    let sharing = rig.manager.sharing.lock().unwrap();
    rig.rt().lock().unwrap().held_queue.paused = false;
    let expected = queue(&rig);
    let manager = rig.manager.clone();
    let delivery = std::thread::spawn(move || manager.deliver_held(SESSION, TAB));
    rig.wait("the held delivery claim", || queue(&rig).sending.is_some());
    if let Engine::Cli(cli) = &mut rig.rt().lock().unwrap().engine { cli.awaiting_delivery = Some(1); }
    drop(sharing);
    delivery.join().unwrap().unwrap();
    assert_eq!(queue(&rig), expected);
    assert_eq!(Queue::restore(&store::log_path(SESSION, TAB).unwrap()).unwrap(), expected);
    assert!(!rig.typed().contains("after the raced CLI input"));
    hook(&rig, "UserPromptSubmit", json!({"prompt":"raced CLI input"}));
    // Input typed into the CLI reaches the chat through its transcript, which
    // also opens the turn's close again (TurnTail::opened) for the Stop below.
    rig.cli_takes("raced CLI input", "CLI reply");
    rig.wait("the CLI input's transcript record", || rig.said().iter().any(|line| line == "claude: CLI reply"));
    hook(&rig, "Stop", json!({}));
    prompt(&rig, "after the raced CLI input");
    rig.wait("held item delivered after the race", || queue(&rig).items.is_empty() && queue(&rig).sending.is_none());
    assert!(!queue(&rig).paused);
}

#[test]
fn cli_input_does_not_hide_recovery_or_an_explicit_retry_that_cannot_proceed() {
    for recovery in [false, true] {
        let rig = started();
        rig.manager.send(SESSION, TAB, "CLI first".into(), Vec::new()).unwrap();
        rig.wait("the CLI follow-up typed", || rig.typed().contains("CLI first"));
        enqueue(&rig, "held retry");
        hook(&rig, "Stop", json!({}));
        if recovery {
            rig.rt().lock().unwrap().recovery = Some(RecoveryKind::UsageLimit);
            rig.manager.deliver_held(SESSION, TAB).unwrap();
        } else {
            change(&rig, Change::SendNow { id: queue(&rig).items[0].id.clone() });
        }
        rig.wait("the delivery block's explanation", || queue(&rig).error.is_some());
        let blocked = queue(&rig);
        assert!(blocked.paused);
        assert!(blocked.next.is_none() && blocked.sending.is_none());
        assert!(blocked.error.unwrap().contains("Earlier messages are still in the agent's queue"));
        assert!(!rig.typed().contains("held retry"));
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
    change(&rig, Change::Enqueue { text: "look".into(), images: vec![ImageInput { media_type: "image/png".into(), data: "aW1hZ2U=".into(), name: Some("shot.png".into()) }], files: Vec::new(), send_now: false });
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
    rig.manager.publish(&mut rig.rt().lock().unwrap(), Payload::UserMessage { text: "next".into(), author: None, images: Vec::new(), queued: false, files: Vec::new(), baseline: None, cwd: None }, None);
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
    rig.manager.publish(&mut rig.rt().lock().unwrap(), Payload::UserMessage { text: "next".into(), author: None, images: Vec::new(), queued: false, files: Vec::new(), baseline: None, cwd: None }, None);
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

#[test]
fn a_fresh_idle_prompt_sends_despite_a_paused_queue_or_recovery() {
    for recovery in [None, Some(RecoveryKind::Failed), Some(RecoveryKind::UsageLimit), Some(RecoveryKind::DeliveryUnconfirmed), Some(RecoveryKind::SignedOut)] {
        let rig = started();
        enqueue(&rig, "older held message");
        change(&rig, Change::Pause { paused: true });
        hook(&rig, "Stop", json!({}));
        let saved = queue(&rig);
        rig.rt().lock().unwrap().recovery = recovery;
        let outcome = change(&rig, Change::Enqueue {
            text: "fresh idle message".into(),
            images: vec![ImageInput { media_type: "image/png".into(), data: "aW1hZ2U=".into(), name: Some("shot.png".into()) }],
            files: Vec::new(),
            send_now: false,
        });
        assert!(!outcome.queued, "idle send with {recovery:?}");
        assert!(outcome.events.iter().any(|event| matches!(&event.payload,
            Payload::UserMessage { text, images, queued: false, .. } if text == "fresh idle message" && images.len() == 1)));
        assert_eq!(queue(&rig), saved, "the older paused queue stays intact");
        assert!(rig.rt().lock().unwrap().recovery.is_none());
    }
}

#[test]
fn the_first_prompt_is_sent_immediately_even_with_an_empty_paused_queue() {
    let rig = Rig::new(claude_tab(None), LISTENS);
    change(&rig, Change::Pause { paused: true });
    enqueue(&rig, "first prompt");
    rig.up();
    prompt(&rig, "first prompt");
    assert!(queue(&rig).items.is_empty());
}

#[test]
fn an_idle_send_that_meets_a_new_terminal_turn_is_held_at_the_final_send_lock() {
    let rig = started();
    let admission = crate::issue_pipeline::admission::lock_for(SESSION, TAB);
    let outcome = rig.manager.send_admitted(&admission, SESSION, TAB,
        PromptText { files: Vec::new(), hold_if_busy: Some(false), mobile: None, shared_connection: None, author: None,
            agent: "arrived during turn".into(), display: "arrived during turn".into() },
        Vec::new(), None, crate::recovery_log::Origin::Composer).unwrap();
    assert!(outcome.queued);
    assert_eq!(queue(&rig).items[0].text, "arrived during turn");
    assert!(!rig.typed().contains("arrived during turn"));
}

#[test]
fn recovery_explains_why_delivery_is_paused_and_explicit_send_now_can_retry() {
    let rig = started();
    enqueue(&rig, "retry held");
    // Keep the boundary from dispatching until the recovery is in place.
    change(&rig, Change::Pause { paused: true });
    hook(&rig, "Stop", json!({}));
    {
        let rt_arc = rig.rt();
        let mut rt = rt_arc.lock().unwrap();
        rt.held_queue.paused = false;
        rt.recovery = Some(RecoveryKind::UsageLimit);
    }
    rig.manager.deliver_held(SESSION, TAB).unwrap();
    let blocked = queue(&rig);
    assert!(blocked.paused);
    assert!(blocked.error.as_deref().unwrap().contains("usage limit"));
    assert!(blocked.error.as_deref().unwrap().contains("Send now"));
    change(&rig, Change::SendNow { id: blocked.items[0].id.clone() });
    prompt(&rig, "retry held");
    rig.wait("explicit retry delivered", || queue(&rig).items.is_empty());
}

#[test]
fn resume_retries_recovery_but_unconfirmed_cli_input_explains_how_to_get_unstuck() {
    let rig = started();
    enqueue(&rig, "resume held");
    change(&rig, Change::Pause { paused: true });
    hook(&rig, "Stop", json!({}));
    {
        let rt_arc = rig.rt();
        let mut rt = rt_arc.lock().unwrap();
        rt.recovery = Some(RecoveryKind::DeliveryUnconfirmed);
        if let Engine::Cli(cli) = &mut rt.engine { cli.awaiting_delivery = Some(1); }
    }
    change(&rig, Change::Pause { paused: false });
    rig.wait("blocked explanation", || queue(&rig).error.is_some());
    assert!(queue(&rig).error.unwrap().contains("not confirmed an earlier message"));
    assert_eq!(queue(&rig).items.len(), 1);
    if let Engine::Cli(cli) = &mut rig.rt().lock().unwrap().engine { cli.awaiting_delivery = None; }
    change(&rig, Change::Pause { paused: false });
    prompt(&rig, "resume held");
    rig.wait("resumed recovery delivered", || queue(&rig).items.is_empty());
}

#[test]
fn a_paused_queue_does_not_keep_the_runtime_busy_but_a_claim_does() {
    let rig = started();
    enqueue(&rig, "durable");
    assert!(queue(&rig).keeps_runtime_busy());
    change(&rig, Change::Pause { paused: true });
    assert!(!queue(&rig).keeps_runtime_busy());
    let mut claimed = queue(&rig);
    claimed.sending = Some(claimed.items[0].id.clone());
    assert!(claimed.keeps_runtime_busy());
}

#[test]
fn a_failed_queue_reconciliation_write_does_not_hide_the_transcript() {
    let rig = started();
    enqueue(&rig, "still held");
    let rt_arc = rig.rt();
    let path = rt_arc.lock().unwrap().log_path.clone();
    {
        let mut rt = rt_arc.lock().unwrap();
        rt.held_queue.paused = true;
        rt.log_path = rig._dir.path().to_path_buf();
    }
    let events = rig.manager.load_events(SESSION, TAB).unwrap();
    assert!(events.iter().any(|event| matches!(&event.payload, Payload::UserMessage { text, .. } if text == "initial")));
    assert!(queue(&rig).paused);
    assert!(Queue::replay(&events).paused);
    rt_arc.lock().unwrap().log_path = path;
}

#[test]
fn a_failed_delivery_claim_write_pauses_visibly_and_keeps_the_item() {
    let rig = started();
    enqueue(&rig, "keep on disk failure");
    change(&rig, Change::Pause { paused: true });
    hook(&rig, "Stop", json!({}));
    let rt_arc = rig.rt();
    let path = rt_arc.lock().unwrap().log_path.clone();
    {
        let mut rt = rt_arc.lock().unwrap();
        rt.held_queue.paused = false;
        rt.log_path = rig._dir.path().to_path_buf();
    }
    assert!(rig.manager.deliver_held(SESSION, TAB).is_err());
    let held = queue(&rig);
    assert!(held.paused && held.sending.is_none());
    assert_eq!(held.items.len(), 1);
    assert!(held.error.unwrap().contains("Could not save the delivery claim"));
    assert!(!rig.typed().contains("keep on disk failure"));
    rt_arc.lock().unwrap().log_path = path;
}

#[test]
fn archive_uses_live_membership_and_invalidates_unopened_log_membership_after_an_edit() {
    let rig = started();
    enqueue(&rig, "pending archive");
    rig.manager.stop(SESSION, TAB).unwrap();
    assert!(rig.manager.has_held_queue(SESSION, TAB).unwrap());
    rig.manager.tabs.lock().unwrap().remove(&key_of(SESSION, TAB));
    assert!(rig.manager.has_held_queue(SESSION, TAB).unwrap());
    let id = queue(&rig).items[0].id.clone();
    change(&rig, Change::Delete { id });
    assert!(!rig.manager.has_held_queue(SESSION, TAB).unwrap());
    rig.manager.tabs.lock().unwrap().remove(&key_of(SESSION, TAB));
    assert!(!rig.manager.has_held_queue(SESSION, TAB).unwrap());
}
