use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::bots::items::{By, NewItem};
use crate::sink::BroadcastSink;

fn bots_on() -> crate::store::TempHome {
    let home = crate::store::temp_home();
    set_bots(true);
    home
}

fn set_bots(on: bool) {
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = on;
    crate::store::settings::save(&settings).unwrap();
}

fn manager() -> (SessionManager, Arc<BroadcastSink>) {
    let sink = Arc::new(BroadcastSink::new(256));
    let manager = SessionManager::new(
        sink.clone(),
        Arc::new(crate::sink::NoObserver),
        Arc::new(crate::harness::host::Host::new()),
        Arc::new(crate::pty::Terminals::new()),
        Arc::new(Default::default()),
        Arc::new(Default::default()),
        crate::hooks::prepare_control().unwrap(),
    );
    (manager, sink)
}

/// A bot with an item that asks its owner "Fix now or file it?".
fn asking(sink: &BroadcastSink) -> (crate::bots::Bot, crate::bots::items::Item) {
    let bot = crate::bots::chat::hire(sink, "security-auditor", "Sentry").unwrap();
    let new = NewItem { title: "Token written to a log".into(), summary: String::new(), done_means: Vec::new(), start: true, asked_by: None, added_by: None };
    items::add(sink, &bot, &By::Bot { session: None }, new).unwrap();
    let item = items::ask(sink, &bot, 1, "Fix now or file it?", &["Fix it now".into(), "File an issue".into(), "Not a problem".into()], Some(0)).unwrap();
    (bot, item)
}

fn refusal(error: anyhow::Error) -> String {
    match crate::bots::refusal(&error) {
        Some(crate::bots::BotError::Refused(message)) => message.clone(),
        Some(crate::bots::BotError::Off) => crate::bots::OFF_MESSAGE.into(),
        other => panic!("not a refusal: {other:?} {error:#}"),
    }
}

#[test]
fn the_phone_lists_what_needs_the_owner_and_answers_it_as_the_window_does() {
    let _home = bots_on();
    let (manager, sink) = manager();
    let (bot, item) = asking(&sink);
    let question = item.question.clone().unwrap();

    let listed = call(&manager, "list", &json!({})).unwrap();
    assert_eq!(listed["bots"]["bots"][0]["id"], bot.id.as_str());
    let entry = &listed["needsYou"]["entries"][0];
    assert_eq!((entry["kind"].as_str(), entry["botId"].as_str()), (Some("item"), Some(bot.id.as_str())));
    assert_eq!(entry["item"]["question"]["text"], "Fix now or file it?");
    assert_eq!(listed["team"][0]["botId"], bot.id.as_str());

    // The owner's choice, to the question they saw: recorded as the window records it, and sent to the home chat.
    items::SENT_FOR_TESTS.with(|sent| sent.borrow_mut().clear());
    let answered = call(&manager, "answer", &json!({"id": bot.id, "number": 1, "answer": 0, "question": question.id})).unwrap();
    assert_eq!(answered["item"]["state"], "inProgress");
    assert!(answered["item"]["question"].is_null());
    let last = answered["item"]["activity"].as_array().unwrap().last().unwrap().clone();
    assert_eq!((last["kind"].as_str(), last["by"].as_str(), last["text"].as_str()), (Some("chose"), Some(crate::bots::OWNER), Some("You chose answer 1")));
    let (home, _) = home_chat_of(&bot.id).expect("the home chat made at hire");
    let sent = items::SENT_FOR_TESTS.with(|sent| sent.borrow().clone());
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, home, "the answer goes to the bot's home chat");
    assert_eq!(sent[0].2, items::owner_choice_message(1, 0, "Fix it now"));

    // Answered once: the same answer again, or one to a question no longer asked, is refused.
    assert!(refusal(call(&manager, "answer", &json!({"id": bot.id, "number": 1, "answer": 0, "question": question.id})).unwrap_err()).contains("no longer asks"));
    assert!(call(&manager, "list", &json!({})).unwrap()["needsYou"]["entries"].as_array().unwrap().is_empty());
    assert_eq!(call(&manager, "list", &json!({})).unwrap()["team"][0]["working"], "Token written to a log");
}

#[test]
fn a_typed_reply_answers_and_an_empty_one_is_refused() {
    let _home = bots_on();
    let (manager, sink) = manager();
    let (bot, item) = asking(&sink);
    let question = item.question.unwrap().id;
    assert!(refusal(call(&manager, "answer", &json!({"id": bot.id, "number": 1})).unwrap_err()).contains("Choose an answer, or write one."));
    assert!(refusal(call(&manager, "answer", &json!({"id": bot.id, "number": 1, "text": "  ", "question": question})).unwrap_err()).contains("empty"));
    let answered = call(&manager, "answer", &json!({"id": bot.id, "number": 1, "text": "File it, low priority", "question": question})).unwrap();
    let last = answered["item"]["activity"].as_array().unwrap().last().unwrap().clone();
    assert_eq!((last["kind"].as_str(), last["by"].as_str()), (Some("answered"), Some(crate::bots::OWNER)));
}

#[test]
fn pause_resume_and_pause_all_are_the_owners_and_say_so() {
    let _home = bots_on();
    let (manager, sink) = manager();
    let atlas = crate::bots::create(&*sink, "cto", "Atlas").unwrap();
    let iris = crate::bots::create(&*sink, "ux-designer", "Iris").unwrap();
    let paused = call(&manager, "pause", &json!({"id": atlas.id})).unwrap();
    assert_eq!(paused["paused"]["by"], crate::bots::OWNER);
    assert!(crate::bots::get(&iris.id).unwrap().paused.is_none(), "only the bot named");
    let resumed = call(&manager, "resume", &json!({"id": atlas.id})).unwrap();
    assert!(resumed["paused"].is_null());
    let all = call(&manager, "pauseAll", &json!({})).unwrap();
    assert!(all["bots"].as_array().unwrap().iter().all(|bot| bot["paused"]["by"] == crate::bots::OWNER));
    assert!(call(&manager, "pause", &json!({})).is_err(), "a pause names its bot");
}

#[test]
fn a_bots_home_has_its_list_chats_duties_and_role_and_makes_nothing() {
    let _home = bots_on();
    let (manager, sink) = manager();
    let (bot, _) = asking(&sink);
    let other = crate::bots::chat::new_chat(&*sink, &bot.id).unwrap();
    let before = index::load().unwrap().len();
    let home = call(&manager, "home", &json!({"id": bot.id})).unwrap();
    assert_eq!(home["bot"]["name"], "Sentry");
    assert_eq!(home["items"]["items"][0]["state"], "needsYou");
    let chats = home["chats"].as_array().unwrap();
    assert_eq!(chats.len(), 2);
    assert_eq!(chats[0]["home"], true, "the home chat first, though another is newer");
    assert_eq!(chats[1]["sessionId"], other.id.as_str());
    assert!(chats.iter().all(|chat| chat["running"] == false && chat["tabId"].is_string()));
    assert!(home["duties"].is_array());
    assert!(home["role"]["text"].as_str().unwrap().contains("ecurity"), "{}", home["role"]);
    assert_eq!(home["role"]["cut"], false);
    assert_eq!(index::load().unwrap().len(), before, "a read makes no chat");
    assert_eq!(call(&manager, "items", &json!({"id": bot.id})).unwrap()["items"][0]["number"], 1);
}

#[test]
fn with_bots_off_the_phone_is_refused_everything() {
    let _home = bots_on();
    let (manager, sink) = manager();
    let (bot, _) = asking(&sink);
    set_bots(false);
    for (operation, params) in [("list", json!({})), ("home", json!({"id": bot.id})), ("answer", json!({"id": bot.id, "number": 1, "answer": 0})), ("pause", json!({"id": bot.id})), ("pauseAll", json!({}))] {
        assert_eq!(refusal(call(&manager, operation, &params).unwrap_err()), crate::bots::OFF_MESSAGE, "{operation}");
    }
    // Read from the store itself: the bots' own reads are refused too while Bots is off.
    assert!(crate::store::bots::get(&bot.id).unwrap().expect("the bot is still saved").paused.is_none());
}

#[test]
fn only_reads_are_open_to_a_phone_that_cannot_drive() {
    for operation in OPERATIONS {
        assert_eq!(acts(operation), !matches!(operation, "list" | "home" | "items"), "{operation}");
    }
}

#[test]
fn a_phone_reaches_the_bots_through_its_own_admitted_connection() {
    let _home = bots_on();
    let (manager, sink) = manager();
    let (bot, item) = asking(&sink);
    let phone = crate::local_runtime::mobile::ApprovalPhone::register(&manager);
    assert_eq!(phone.bots(&manager, json!({"operation": "list"})).unwrap()["needsYou"]["entries"][0]["botId"], bot.id.as_str());
    // An operation a phone is not given is refused as unknown.
    for refused in ["delete", "create", "roleWrite", "itemHand", "dutyRun"] {
        let error = phone.bots(&manager, json!({"operation": refused, "id": bot.id})).unwrap_err();
        assert_eq!(error.to_string(), crate::local_runtime::mobile::UNSUPPORTED, "{refused}");
    }
    let answered = phone.bots(&manager, json!({"operation": "answer", "id": bot.id, "number": 1, "answer": 1, "question": item.question.unwrap().id})).unwrap();
    assert_eq!(answered["item"]["state"], "inProgress");
    // A revoked phone does nothing more.
    phone.revoke(&manager);
    assert!(phone.bots(&manager, json!({"operation": "pause", "id": bot.id})).is_err());
    assert!(crate::bots::get(&bot.id).unwrap().paused.is_none());
}
