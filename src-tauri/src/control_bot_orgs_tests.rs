//! PRO-483: one bot across several organisations, through the real dispatch.
//! The bot's role and the notes that go with it reach every conversation;
//! what it learns inside an organisation, and the work it takes on there,
//! reach only that organisation's conversations.

use serde_json::{json, Value};

use super::tests::headless_service;
use super::*;

fn bots_on() {
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = true;
    crate::store::settings::save(&settings).unwrap();
}

fn launch_note(entry: &SessionEntry) -> String {
    crate::bots::chat::launch_note(entry, &entry.tabs[0]).expect("a bot's chat has a launch note")
}

#[test]
fn a_fact_learned_in_one_organisation_is_not_given_to_the_agent_in_another() {
    let _home = crate::store::temp_home();
    bots_on();
    let (service, _sink) = headless_service();
    let sink = service.sink.as_ref();
    let ask = |command: &str, params: Value| service.execute(command, params, "r");
    let atlas = ask("bots.create", json!({"role": "cto", "name": "Atlas"})).unwrap()["bot"]["id"].as_str().unwrap().to_owned();
    crate::bots::update(sink, &atlas, crate::bots::BotPatch { works_in: Some(vec!["acme".into(), "kestrel".into(), "personal".into()]), ..Default::default() }).unwrap();

    // A chat is started in a place, and says so; a place it does not work in is refused.
    let acme = crate::bots::chat::new_chat(sink, &atlas, Some("acme")).unwrap();
    let kestrel = crate::bots::chat::new_chat(sink, &atlas, Some("kestrel")).unwrap();
    assert_eq!(crate::bots::chat::session_org(&acme).as_deref(), Some("acme"));
    assert_eq!(crate::bots::chat::session_org(&kestrel).as_deref(), Some("kestrel"));
    assert!(crate::bots::chat::new_chat(sink, &atlas, Some("umbrella")).unwrap_err().to_string().contains("does not work in umbrella"));
    service.manager.install_review_test_cli(&acme.id, &acme.tabs[0].id, "acme-secret");
    service.manager.install_review_test_cli(&kestrel.id, &kestrel.tabs[0].id, "kestrel-secret");
    let from = |chat: &SessionEntry, token: &str, command: &str, mut params: Value| {
        params["caller"] = json!({"session": chat.id, "tab": chat.tabs[0].id});
        params["hookToken"] = json!(token);
        ask(command, params)
    };

    // In Acme it learns a fact about Acme, takes on Acme's work, and learns something about its job.
    let learned = from(&acme, "acme-secret", "bots.memory.add", json!({"text": "Acme deploys only on Fridays", "place": "acme"})).unwrap();
    assert_eq!(learned["place"], "acme");
    from(&acme, "acme-secret", "bots.memory.add", json!({"text": "The owner wants short status updates"})).unwrap();
    let item = from(&acme, "acme-secret", "bots.items.add", json!({"title": "Rotate the Acme deploy key"})).unwrap();
    assert_eq!(item["item"]["org"], "acme");

    // The Acme conversation is given all three.
    let given = launch_note(&acme);
    assert!(given.contains("Acme deploys only on Fridays") && given.contains("Rotate the Acme deploy key") && given.contains("short status updates"), "{given}");

    // The Kestrel conversation is given what goes with the bot, and nothing of Acme's.
    let given = launch_note(&kestrel);
    assert!(given.contains("short status updates"), "what the bot knows about its owner goes everywhere: {given}");
    assert!(!given.contains("Fridays") && !given.contains("Rotate the Acme deploy key"), "Acme's fact reached Kestrel: {given}");
    assert!(given.contains("Notes kept in organisation kestrel"), "{given}");

    // Nor can it read them from there: not Acme's notes, nor that it keeps any, nor Acme's work.
    let refused = from(&kestrel, "kestrel-secret", "bots.memory.list", json!({"place": "acme"})).unwrap_err();
    assert_eq!(refused.code, "forbidden", "{refused:?}");
    let listed = from(&kestrel, "kestrel-secret", "bots.memory.list", json!({})).unwrap();
    let places: Vec<&str> = listed["places"].as_array().unwrap().iter().map(|place| place["place"].as_str().unwrap()).collect();
    assert_eq!(places, ["bot", "kestrel"]);
    assert_eq!(from(&kestrel, "kestrel-secret", "bots.items.list", json!({"all": true})).unwrap()["items"].as_array().unwrap().len(), 0);
    let number = item["item"]["number"].as_u64().unwrap();
    for (command, params) in [("bots.items.show", json!({"item": number})), ("bots.items.comment", json!({"item": number, "text": "x"})), ("bots.items.done", json!({"item": number}))] {
        let refused = from(&kestrel, "kestrel-secret", command, params).unwrap_err();
        assert!(refused.code == "invalid_arguments" && refused.message.contains("No item"), "{command}: {refused:?}");
    }
    // The owner's terminal still reads the whole list.
    assert_eq!(ask("bots.items.list", json!({"bot": atlas, "all": true})).unwrap()["items"].as_array().unwrap().len(), 1);

    // A session the Kestrel chat starts works in Kestrel too.
    let mut started = kestrel.clone();
    started.id = "started-in-kestrel".into();
    started.unknown.clear();
    started.parent = Some(index::ParentRef { session_id: kestrel.id.clone(), tab_id: None });
    crate::bots::chat::inherit(&mut started);
    assert_eq!(crate::bots::chat::session_org(&started).as_deref(), Some("kestrel"));
    index::update(|entries| {
        entries.push(started.clone());
        Ok(())
    })
    .unwrap();
    service.manager.install_review_test_cli(&started.id, &started.tabs[0].id, "started-secret");
    assert_eq!(from(&started, "started-secret", "bots.memory.list", json!({"place": "acme"})).unwrap_err().code, "forbidden");

    // Switched off in Acme, the Acme chat keeps only what goes with the bot, and takes on no work.
    crate::bots::update(sink, &atlas, crate::bots::BotPatch { works_in: Some(vec!["kestrel".into(), "personal".into()]), ..Default::default() }).unwrap();
    let given = launch_note(&acme);
    assert!(!given.contains("Fridays") && !given.contains("Rotate the Acme deploy key") && given.contains("short status updates"), "{given}");
    assert!(!launch_note(&kestrel).contains("Fridays"), "nor is Acme's fact handed to the first place left");
    assert_eq!(from(&acme, "acme-secret", "bots.memory.list", json!({"place": "kestrel"})).unwrap_err().code, "forbidden");
    let refused = from(&acme, "acme-secret", "bots.items.add", json!({"title": "More Acme work"})).unwrap_err();
    assert!(refused.message.contains("no longer work in"), "{refused:?}");
}

/// Cloud time is billed to the organisation the work is for: a bot's command
/// carries its conversation's organisation to the window, which takes only
/// that organisation's workspaces (`cloudControl.ts`, `assertBotOrg`).
#[test]
fn a_bots_cloud_command_carries_the_organisation_its_conversation_works_in() {
    let _home = crate::store::temp_home();
    bots_on();
    let (service, _sink) = headless_service();
    let sink = service.sink.as_ref();
    let atlas = service.execute("bots.create", json!({"role": "cto", "name": "Atlas"}), "r").unwrap()["bot"]["id"].as_str().unwrap().to_owned();
    crate::bots::update(sink, &atlas, crate::bots::BotPatch { works_in: Some(vec!["acme".into(), "personal".into()]), ..Default::default() }).unwrap();
    let acme = crate::bots::chat::new_chat(sink, &atlas, Some("acme")).unwrap();
    let personal = crate::bots::chat::new_chat(sink, &atlas, Some("personal")).unwrap();
    assert_eq!(crate::bots::cloud::hold_org(&atlas, Some(&acme.id)), "acme");
    assert_eq!(crate::bots::cloud::hold_org(&atlas, Some(&personal.id)), "personal");
    assert_eq!(crate::bots::cloud::hold_org(&atlas, None), "", "a session that cannot be read uses no organisation's");
    crate::bots::update(sink, &atlas, crate::bots::BotPatch { works_in: Some(vec!["personal".into()]), ..Default::default() }).unwrap();
    assert_eq!(crate::bots::cloud::hold_org(&atlas, Some(&acme.id)), "", "nor one the bot no longer works in");
}
