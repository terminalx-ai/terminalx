use std::sync::Arc;

use super::*;
use crate::sink::BroadcastSink;

/// A temporary store with the switch on, and a sink whose events are read back.
fn bots_on() -> (crate::store::TempHome, Arc<BroadcastSink>, tokio::sync::broadcast::Receiver<crate::sink::Published>) {
    let home = crate::store::temp_home();
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = true;
    crate::store::settings::save(&settings).unwrap();
    let sink = Arc::new(BroadcastSink::new(64));
    let events = sink.subscribe();
    (home, sink, events)
}

fn changes(events: &mut tokio::sync::broadcast::Receiver<crate::sink::Published>) -> usize {
    std::iter::from_fn(|| events.try_recv().ok()).filter(|published| &*published.event == "bots_changed").count()
}

/// Off unix Bots stays off with the switch on, and says why (PRO-489):
/// nothing there can tell a bot's commands from its owner's.
#[test]
fn bots_stay_off_where_they_cannot_be_held_to_their_access() {
    let (_home, sink, _events) = bots_on();
    assert_eq!(SUPPORTED, cfg!(unix));
    assert_eq!(enabled(), cfg!(unix));
    let expected = if cfg!(unix) { OFF_MESSAGE } else { UNSUPPORTED_MESSAGE };
    assert_eq!((off_message(), BotError::Off.to_string().as_str()), (expected, expected));
    if !cfg!(unix) {
        assert_eq!(call(sink.as_ref(), "create", &json!({"roleTemplateId": "cto", "name": "Atlas"})).unwrap_err().to_string(), UNSUPPORTED_MESSAGE);
    }
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn everything_refuses_while_the_switch_is_off() {
    let _home = crate::store::temp_home();
    let sink = BroadcastSink::new(8);
    let mut events = sink.subscribe();
    assert!(!enabled());
    for operation in ["list", "get", "templates", "create", "update", "delete", "pause", "resume", "pauseAll", "resumeAll", "roleRead", "roleWrite"] {
        let refused = call(&sink, operation, &json!({"id": "x", "roleTemplateId": "cto", "name": "Atlas", "text": "", "patch": {}})).unwrap_err();
        assert_eq!(refused.to_string(), OFF_MESSAGE, "{operation}");
    }
    assert!(resolve("atlas").unwrap_err().to_string().contains("Bots are off"));
    assert_eq!(changes(&mut events), 0);
    assert!(!crate::store::root().unwrap().join("bots.json").exists());
    assert!(!crate::store::root().unwrap().join("bots").exists());
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn hiring_asks_for_a_role_and_a_name_and_defaults_the_rest() {
    let (_home, sink, mut events) = bots_on();
    let bot = create(sink.as_ref(), "cto", "  Atlas  ").unwrap();
    assert_eq!((bot.name.as_str(), bot.slug.as_str(), bot.role_title.as_str(), bot.role_template_id.as_str()), ("Atlas", "atlas", "CTO", "cto"));
    assert_eq!((bot.harness.as_str(), bot.model.as_str(), bot.effort.as_deref()), ("claude", "", None));
    assert_eq!((&bot.access, &bot.runs_on, bot.reports_to.as_str(), bot.paused.as_ref()), (&BotAccess::Full, &BotRunsOn::ThisMac, OWNER, None));
    assert_eq!(bot.works_in, [PERSONAL]);
    assert_eq!(bot.created, bot.modified);
    assert_eq!(changes(&mut events), 1);
    assert_eq!(list().unwrap(), vec![bot.clone()]);
    assert_eq!(get(&bot.id).unwrap(), bot);
    // As it is stored: the names later tickets read.
    let stored: Value = serde_json::from_str(&std::fs::read_to_string(crate::store::root().unwrap().join("bots.json")).unwrap()).unwrap();
    assert_eq!(stored["bots"][0], json!({
        "id": bot.id, "slug": "atlas", "name": "Atlas", "roleTitle": "CTO", "roleTemplateId": "cto", "harness": "claude", "model": "",
        "access": "full", "runsOn": "thisMac", "reportsTo": "owner", "worksIn": ["personal"], "created": bot.created, "modified": bot.modified,
    }));

    // The role is found by its title too, and an unknown one names the roles there are.
    assert_eq!(create(sink.as_ref(), "Security auditor", "Sentry").unwrap().role_template_id, "security-auditor");
    let unknown = create(sink.as_ref(), "janitor", "Mop").unwrap_err().to_string();
    assert!(unknown.contains("No role template janitor") && unknown.contains("cto, chief-of-staff") && unknown.contains("watcher"), "{unknown}");
    for name in ["", "   ", "two\nlines", &"n".repeat(81)] {
        assert!(create(sink.as_ref(), "cto", name).is_err(), "{name:?}");
    }
    assert_eq!(list().unwrap().len(), 2);
    // A refused hire leaves no home behind.
    assert_eq!(std::fs::read_dir(crate::store::root().unwrap().join("bots")).unwrap().count(), 2);
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_home_is_made_from_the_role_template_at_hire() {
    let (_home, sink, _events) = bots_on();
    let bot = create(sink.as_ref(), "watcher", "Argus").unwrap();
    let home = home(&bot).unwrap();
    assert_eq!(home, crate::store::root().unwrap().join("bots").join(&bot.id));
    let role = std::fs::read_to_string(home.join("ROLE.md")).unwrap();
    let template = templates::find("watcher").unwrap();
    assert_eq!(role, format!("{}\n", template.role.trim()));
    assert!(role.starts_with("You keep watch") && role.ends_with("lead bot.\n"), "{role}");
    assert_eq!(role_read(&bot.id).unwrap(), role);
    assert_eq!(std::fs::read_to_string(home.join("MEMORY.md")).unwrap(), "# Memory\n\nNotes kept across conversations. Longer notes go in `memory/`.\n");
    assert!(home.join("memory").is_dir());
    assert_eq!(std::fs::read_dir(home.join("memory")).unwrap().count(), 0);
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn slugs_come_from_the_name_and_are_never_shared() {
    assert_eq!(slugify("Atlas"), "atlas");
    assert_eq!(slugify("  Atlas  Prime! "), "atlas-prime");
    assert_eq!(slugify("QA #2 (night)"), "qa-2-night");
    assert_eq!(slugify("Zoë"), "zo");
    assert_eq!(slugify("…"), "bot");
    assert!(slugify(&"long name ".repeat(20)).len() <= MAX_SLUG_CHARS);
    assert!(!slugify(&"ab ".repeat(30)).ends_with('-'));

    let (_home, sink, _events) = bots_on();
    let slugs: Vec<String> = ["Atlas", "atlas", "ATLAS!", "Iris", "…", "???"].iter().map(|name| create(sink.as_ref(), "cto", name).unwrap().slug).collect();
    assert_eq!(slugs, ["atlas", "atlas-2", "atlas-3", "iris", "bot", "bot-2"]);

    // A rename takes the new name's slug, keeps its own when the name comes to the same, and steps past another bot's.
    let bots = list().unwrap();
    let rename = |id: &str, name: &str| update(sink.as_ref(), id, BotPatch { name: Some(name.into()), ..Default::default() }).unwrap();
    assert_eq!(rename(&bots[3].id, "Kestrel").slug, "kestrel");
    assert_eq!(rename(&bots[1].id, "Atlas").slug, "atlas-2");
    assert_eq!(rename(&bots[2].id, "Kestrel").slug, "kestrel-2");
    assert_eq!(rename(&bots[0].id, "Atlas").slug, "atlas");
    let all = list().unwrap();
    let mut unique: Vec<&str> = all.iter().map(|bot| bot.slug.as_str()).collect();
    unique.sort_unstable();
    unique.dedup();
    assert_eq!(unique.len(), all.len());
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_bot_is_named_by_id_slug_or_name() {
    let (_home, sink, _events) = bots_on();
    let atlas = create(sink.as_ref(), "cto", "Atlas").unwrap();
    let twin = create(sink.as_ref(), "watcher", "atlas").unwrap();
    let iris = create(sink.as_ref(), "ux-designer", "Iris").unwrap();
    assert_eq!(resolve(&atlas.id).unwrap().id, atlas.id);
    assert_eq!(resolve("atlas").unwrap().id, atlas.id);
    assert_eq!(resolve("atlas-2").unwrap().id, twin.id);
    assert_eq!(resolve("IRIS").unwrap().id, iris.id);
    assert!(resolve("Atlas").unwrap_err().to_string().contains("More than one bot is named Atlas"));
    assert_eq!(resolve("argus").unwrap_err().to_string(), "No bot matches argus.");
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn an_update_changes_what_it_names_and_refuses_what_cannot_be() {
    let (_home, sink, mut events) = bots_on();
    let atlas = create(sink.as_ref(), "cto", "Atlas").unwrap();
    let iris = create(sink.as_ref(), "ux-designer", "Iris").unwrap();
    let patch = |value: Value| serde_json::from_value::<BotPatch>(value).unwrap();
    changes(&mut events);

    let changed = update(sink.as_ref(), &iris.id, patch(json!({
        "roleTitle": " Design lead ", "harness": "codex", "model": "gpt-6", "effort": "high", "access": "askOutward", "reportsTo": atlas.id, "worksIn": ["personal", " acme ", "personal", ""],
    }))).unwrap();
    assert_eq!((changed.role_title.as_str(), changed.harness.as_str(), changed.model.as_str(), changed.effort.as_deref()), ("Design lead", "codex", "gpt-6", Some("high")));
    assert_eq!((changed.access, changed.reports_to.as_str()), (BotAccess::AskOutward, atlas.id.as_str()));
    assert_eq!(changed.works_in, ["personal", "acme"]);
    assert_eq!((changed.name.as_str(), changed.slug.as_str(), changed.created.as_str()), ("Iris", "iris", iris.created.as_str()));
    assert_eq!(changes(&mut events), 1);

    // `effort: null` goes back to the agent's default; another agent drops the model and effort chosen for the last one.
    assert_eq!(update(sink.as_ref(), &iris.id, patch(json!({"effort": null}))).unwrap().effort, None);
    let moved = update(sink.as_ref(), &iris.id, patch(json!({"harness": "claude"}))).unwrap();
    assert_eq!((moved.model.as_str(), moved.effort.as_deref()), ("", None));
    // Nothing named, nothing changed: the bot is as it was, to the second.
    let same = update(sink.as_ref(), &iris.id, patch(json!({}))).unwrap();
    assert_eq!(same, moved);

    for (refused, said) in [
        (json!({"name": " "}), "needs a name"),
        (json!({"roleTitle": ""}), "role title"),
        (json!({"harness": "clippy"}), "Unknown agent clippy"),
        (json!({"reportsTo": iris.id}), "does not report to itself"),
        (json!({"reportsTo": "nobody"}), "nobody is neither"),
        (json!({"worksIn": []}), "works somewhere"),
    ] {
        let error = update(sink.as_ref(), &iris.id, patch(refused.clone())).unwrap_err().to_string();
        assert!(error.contains(said), "{refused}: {error}");
    }
    // Iris reports to Atlas, so Atlas cannot report to Iris.
    assert!(update(sink.as_ref(), &atlas.id, patch(json!({"reportsTo": iris.id}))).unwrap_err().to_string().contains("report to each other"));
    assert_eq!(update(sink.as_ref(), &iris.id, patch(json!({"reportsTo": "owner"}))).unwrap().reports_to, OWNER);
    assert!(update(sink.as_ref(), "missing", patch(json!({"name": "X"}))).is_err());
    assert!(serde_json::from_value::<BotPatch>(json!({"budget": 5})).is_err());
    // A value this build does not offer is refused as the caller's mistake, and changes nothing.
    for (odd, said) in [(json!({"runsOn": "cloudWorkspace"}), "runs on thisMac for now"), (json!({"access": "root"}), "Unknown access root")] {
        let error = update(sink.as_ref(), &iris.id, patch(odd.clone())).unwrap_err();
        assert!(matches!(refusal(&error), Some(BotError::Refused(message)) if message.contains(said)), "{odd}: {error}");
    }
    assert_eq!(get(&iris.id).unwrap().access, BotAccess::AskOutward);
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn pausing_records_when_and_by_whom_and_resuming_clears_it() {
    let (_home, sink, mut events) = bots_on();
    let atlas = create(sink.as_ref(), "cto", "Atlas").unwrap();
    let iris = create(sink.as_ref(), "ux-designer", "Iris").unwrap();
    let argus = create(sink.as_ref(), "watcher", "Argus").unwrap();
    changes(&mut events);

    let paused = pause(sink.as_ref(), &iris.id, OWNER).unwrap();
    let first = paused.paused.clone().unwrap();
    assert_eq!(first.by, OWNER);
    assert!(chrono::DateTime::parse_from_rfc3339(&first.at).is_ok(), "{}", first.at);
    assert_eq!(serde_json::to_value(&paused).unwrap()["paused"], json!({"at": first.at, "by": "owner", "from": "app"}));
    // Pausing a paused bot keeps the first record, whoever asks.
    assert_eq!(pause(sink.as_ref(), &iris.id, &atlas.id).unwrap().paused, Some(first.clone()));

    // Pause all: the others are paused now, and the one already paused keeps its record.
    let listed = pause_all(sink.as_ref(), OWNER).unwrap();
    let all = listed.bots;
    assert_eq!(all.len(), 3);
    assert_eq!(listed.revision, listing().unwrap().revision);
    assert!(all.iter().all(|bot| bot.paused.is_some()));
    assert_eq!(all.iter().find(|bot| bot.id == iris.id).unwrap().paused, Some(first));
    assert_eq!(list().unwrap(), all);

    let resumed = resume(sink.as_ref(), &argus.id).unwrap();
    assert_eq!(resumed.paused, None);
    assert!(serde_json::to_value(&resumed).unwrap().get("paused").is_none());
    assert_eq!(resume(sink.as_ref(), &argus.id).unwrap(), resumed);
    assert_eq!(list().unwrap().iter().filter(|bot| bot.paused.is_some()).count(), 2);

    assert!(resume_all(sink.as_ref()).unwrap().bots.iter().all(|bot| bot.paused.is_none()));
    assert!(list().unwrap().iter().all(|bot| bot.paused.is_none()));
    assert!(pause(sink.as_ref(), "missing", OWNER).is_err() && resume(sink.as_ref(), "missing").is_err());
    assert_eq!(changes(&mut events), 6);
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn deleting_a_bot_moves_its_home_to_the_trash() {
    let (_home, sink, mut events) = bots_on();
    let atlas = create(sink.as_ref(), "cto", "Atlas").unwrap();
    let iris = create(sink.as_ref(), "ux-designer", "Iris").unwrap();
    update(sink.as_ref(), &iris.id, BotPatch { reports_to: Some(atlas.id.clone()), ..Default::default() }).unwrap();
    role_write(sink.as_ref(), &atlas.id, "Lead the others.\n", None).unwrap();
    let home = home(&atlas).unwrap();
    std::fs::write(home.join("memory").join("decisions.md"), "Ship on Thursdays.").unwrap();
    changes(&mut events);

    delete(sink.as_ref(), &atlas.id).unwrap();
    assert_eq!(changes(&mut events), 1);
    assert!(!home.exists());
    let trashed = crate::store::root().unwrap().join("trash").join("bots").join(&atlas.id);
    assert_eq!(std::fs::read_to_string(trashed.join("ROLE.md")).unwrap(), "Lead the others.\n");
    assert!(trashed.join("MEMORY.md").is_file());
    assert_eq!(std::fs::read_to_string(trashed.join("memory").join("decisions.md")).unwrap(), "Ship on Thursdays.");
    // Its record goes with it, so it can be restored as it was.
    let kept: Bot = serde_json::from_str(&std::fs::read_to_string(trashed.join("bot.json")).unwrap()).unwrap();
    assert_eq!((kept.id.as_str(), kept.name.as_str(), kept.role_template_id.as_str()), (atlas.id.as_str(), "Atlas", "cto"));
    // The bot that reported to it reports to the owner, and is the only one left.
    let left = list().unwrap();
    assert_eq!(left.len(), 1);
    assert_eq!((left[0].id.as_str(), left[0].reports_to.as_str()), (iris.id.as_str(), OWNER));
    assert!(get(&atlas.id).is_err() && role_read(&atlas.id).is_err());
    assert!(delete(sink.as_ref(), &atlas.id).is_err());
    // Its slug is free again.
    assert_eq!(create(sink.as_ref(), "cto", "Atlas").unwrap().slug, "atlas");
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_role_is_read_and_replaced_through_its_bot() {
    let (_home, sink, mut events) = bots_on();
    let bot = create(sink.as_ref(), "docs-writer", "Quill").unwrap();
    changes(&mut events);
    let written = role_write(sink.as_ref(), &bot.id, "Keep the changelog current.\n", None).unwrap();
    assert_eq!(role_read(&bot.id).unwrap(), "Keep the changelog current.\n");
    assert!(written.modified >= bot.modified);
    assert_eq!(changes(&mut events), 1);
    assert!(role_write(sink.as_ref(), &bot.id, &"x".repeat(memory::ROLE_LIMIT as usize + 1), None).is_err());
    for id in ["missing", "../settings", ""] {
        assert!(role_read(id).is_err() && role_write(sink.as_ref(), id, "x", None).is_err(), "{id:?}");
    }
    assert_eq!(role_read(&bot.id).unwrap(), "Keep the changelog current.\n");
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn the_runtime_answers_the_apps_commands_and_bots_survive_a_restart() {
    let (_home, sink, mut events) = bots_on();
    let ask = |operation: &str, params: Value| call(sink.as_ref(), operation, &params).unwrap();
    assert_eq!(ask("list", json!({})), json!({"revision": 0, "bots": [], "unreadable": 0}));
    assert_eq!(ask("templates", json!({})).as_array().unwrap().len(), 8);
    let bot = ask("create", json!({"roleTemplateId": "qa-engineer", "name": "Kestrel"}));
    let id = bot["id"].as_str().unwrap().to_owned();
    assert_eq!(ask("get", json!({"id": id})), bot);
    assert_eq!(ask("update", json!({"id": id, "patch": {"name": "Merlin"}}))["slug"], "merlin");
    assert_eq!(ask("pause", json!({"id": id}))["paused"]["by"], "owner");
    assert!(ask("resume", json!({"id": id})).get("paused").is_none());
    assert_eq!(ask("pauseAll", json!({}))["bots"][0]["paused"]["by"], "owner");
    assert_eq!(ask("roleWrite", json!({"id": id, "text": "Break it first."}))["id"], id.as_str());
    assert_eq!(ask("roleRead", json!({"id": id})), json!("Break it first."));
    // Every change was announced with the whole list.
    assert_eq!(changes(&mut events), 6);

    // What a restarted app reads is what was saved: the definitions and the home are on disk.
    let listed = ask("list", json!({}));
    assert_eq!(listed["revision"], 6);
    let read_again: Vec<Bot> = serde_json::from_value(listed["bots"].clone()).unwrap();
    assert_eq!(read_again, crate::store::bots::list().unwrap());
    assert_eq!((read_again[0].name.as_str(), read_again[0].paused.is_some()), ("Merlin", true));

    assert_eq!(ask("resumeAll", json!({}))["bots"].as_array().unwrap().len(), 1);
    assert_eq!(ask("delete", json!({"id": id})), Value::Null);
    assert_eq!(ask("list", json!({}))["bots"], json!([]));
    assert!(call(sink.as_ref(), "hire", &json!({})).unwrap_err().to_string().contains("Unknown bots operation hire"));
    assert!(call(sink.as_ref(), "get", &json!({})).unwrap_err().to_string().contains("id must be a string"));
}

#[test]
fn a_bot_saved_by_a_newer_app_keeps_its_unknown_fields() {
    let raw = json!({
        "id": "0198", "slug": "atlas", "name": "Atlas", "roleTitle": "CTO", "roleTemplateId": "cto", "harness": "claude", "model": "",
        "access": "readReport", "runsOn": "thisMac", "reportsTo": "owner", "worksIn": ["personal"], "paused": {"at": "2026-11-20T10:00:00Z", "by": "owner"},
        "created": "2026-11-20T09:00:00Z", "modified": "2026-11-20T10:00:00Z", "channels": ["slack"], "spend": {"usd": 4.2},
    });
    let bot: Bot = serde_json::from_value(raw.clone()).unwrap();
    assert_eq!(bot.access, BotAccess::ReadReport);
    assert_eq!(bot.unknown.keys().map(String::as_str).collect::<Vec<_>>(), ["channels", "spend"]);
    assert_eq!(serde_json::to_value(&bot).unwrap(), raw);
    // The least a record holds: everything else takes its default.
    let least: Bot = serde_json::from_value(json!({"id": "1", "slug": "a", "name": "A", "roleTitle": "CTO", "roleTemplateId": "cto", "harness": "claude", "created": "c", "modified": "m"})).unwrap();
    assert_eq!((least.access, least.runs_on, least.reports_to.as_str(), least.paused), (BotAccess::Full, BotRunsOn::ThisMac, OWNER, None));
    assert_eq!(least.works_in, [PERSONAL]);
}

fn write_file(value: Value) {
    std::fs::write(crate::store::root().unwrap().join("bots.json"), serde_json::to_vec(&value).unwrap()).unwrap();
}

fn file() -> Value {
    serde_json::from_str(&std::fs::read_to_string(crate::store::root().unwrap().join("bots.json")).unwrap()).unwrap()
}

fn record(id: &str, slug: &str, extra: Value) -> Value {
    let mut value = json!({
        "id": id, "slug": slug, "name": slug, "roleTitle": "CTO", "roleTemplateId": "cto", "harness": "claude", "model": "",
        "access": "full", "runsOn": "thisMac", "reportsTo": "owner", "worksIn": ["personal"], "created": "c", "modified": "m",
    });
    for (key, field) in extra.as_object().unwrap() {
        value[key] = field.clone();
    }
    value
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_bot_with_values_from_a_newer_build_lists_shows_and_round_trips_unchanged() {
    let (_home, sink, _events) = bots_on();
    let newer = record("0198-new", "atlas", json!({
        "access": "approveEverything", "runsOn": "cloudWorkspace",
        "paused": {"at": "2026-11-20T10:00:00Z", "by": "owner", "source": "duty", "reason": "spend"},
        "channels": ["slack"],
    }));
    write_file(json!({"version": 1, "revision": 4, "bots": [newer.clone(), record("0198-old", "iris", json!({}))]}));

    let listed = listing().unwrap();
    assert_eq!((listed.revision, listed.bots.len(), listed.unreadable), (4, 2, 0));
    let bot = get("0198-new").unwrap();
    assert_eq!(bot.access, BotAccess::Other("approveEverything".into()));
    assert_eq!(bot.runs_on, BotRunsOn::Other("cloudWorkspace".into()));
    assert_eq!(bot.paused.as_ref().unwrap().unknown.keys().map(String::as_str).collect::<Vec<_>>(), ["reason", "source"]);
    assert_eq!(serde_json::to_value(&bot).unwrap(), newer);
    // This build acts on an access level it does not know as the most restrictive one it knows.
    assert_eq!(bot.access.effective(), BotAccess::ReadReport);
    assert_eq!(BotAccess::Full.effective(), BotAccess::Full);

    // Changes to the other bot, to every bot and to this one's name leave what this build does not know as it was.
    update(sink.as_ref(), "0198-old", BotPatch { name: Some("Kestrel".into()), ..Default::default() }).unwrap();
    pause_all(sink.as_ref(), OWNER).unwrap();
    assert_eq!(file()["bots"][0], newer);
    let renamed = update(sink.as_ref(), "0198-new", BotPatch { name: Some("Argus".into()), ..Default::default() }).unwrap();
    let saved = file()["bots"][0].clone();
    for key in ["access", "runsOn", "paused", "channels"] {
        assert_eq!(saved[key], newer[key], "{key}");
    }
    assert_eq!((saved["name"].as_str(), renamed.slug.as_str()), (Some("Argus"), "argus"));
    assert_eq!(file()["revision"], 7);
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_record_this_build_cannot_read_is_counted_kept_and_hides_no_other() {
    let (_home, sink, _events) = bots_on();
    let bad = json!({"id": "0198-bad", "slug": 7});
    write_file(json!({"bots": [record("0198-a", "atlas", json!({})), bad.clone()]}));
    let listed = listing().unwrap();
    assert_eq!((listed.bots.len(), listed.unreadable), (1, 1));
    let created = create(sink.as_ref(), "watcher", "Argus").unwrap();
    let saved = file();
    assert_eq!(saved["bots"].as_array().unwrap().len(), 3);
    assert!(saved["bots"].as_array().unwrap().contains(&bad));
    assert_eq!(list().unwrap().iter().map(|bot| bot.id.as_str()).collect::<Vec<_>>(), ["0198-a", created.id.as_str()]);
    assert_eq!(saved["version"], 1);
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_file_this_build_cannot_read_refuses_every_command_and_stays_as_it_was() {
    let (_home, sink, mut events) = bots_on();
    let path = crate::store::root().unwrap().join("bots.json");
    std::fs::write(&path, "{\"bots\": [").unwrap();
    assert!(list().is_err() && listing().is_err());
    let error = create(sink.as_ref(), "cto", "Atlas").unwrap_err();
    // Not the caller's mistake: no refusal it could fix by asking differently.
    assert!(refusal(&error).is_none(), "{error}");
    assert!(pause_all(sink.as_ref(), OWNER).is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"bots\": [");
    assert_eq!(changes(&mut events), 0);
    // The home made for the refused hire is not left behind.
    assert_eq!(std::fs::read_dir(crate::store::root().unwrap().join("bots")).map(|dir| dir.count()).unwrap_or(0), 0);
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_hand_edited_record_whose_id_names_no_home_can_still_be_deleted() {
    let (_home, sink, _events) = bots_on();
    write_file(json!({"bots": [record("a/b", "atlas", json!({})), record("0198-b", "iris", json!({"reportsTo": "a/b"}))]}));
    assert_eq!(home(&get("a/b").unwrap()), None);
    delete(sink.as_ref(), "a/b").unwrap();
    assert_eq!(list().unwrap().iter().map(|bot| (bot.id.as_str(), bot.reports_to.as_str())).collect::<Vec<_>>(), [("0198-b", OWNER)]);
    assert!(!crate::store::root().unwrap().join("a").exists());
    assert!(!crate::store::root().unwrap().join("trash").join("bots").join("a").exists());
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn every_change_is_announced_in_order_with_its_revision() {
    let (_home, sink, mut events) = bots_on();
    let atlas = create(sink.as_ref(), "cto", "Atlas").unwrap();
    pause(sink.as_ref(), &atlas.id, OWNER).unwrap();
    resume_all(sink.as_ref()).unwrap();
    delete(sink.as_ref(), &atlas.id).unwrap();
    let announced: Vec<BotList> = std::iter::from_fn(|| events.try_recv().ok())
        .filter(|published| &*published.event == "bots_changed")
        .map(|published| serde_json::from_str(&published.payload).unwrap())
        .collect();
    assert_eq!(announced.iter().map(|list| (list.revision, list.bots.len())).collect::<Vec<_>>(), [(1, 1), (2, 1), (3, 1), (4, 0)]);
    assert!(announced[1].bots[0].paused.is_some() && announced[2].bots[0].paused.is_none());
    assert_eq!(listing().unwrap().revision, 4);
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn reserved_words_are_never_a_slug_and_the_id_always_names_the_bot() {
    let (_home, sink, _events) = bots_on();
    let slugs: Vec<String> = ["Owner", "Personal", "All", "everyone", "Atlas"].iter().map(|name| create(sink.as_ref(), "cto", name).unwrap().slug).collect();
    assert_eq!(slugs, ["owner-2", "personal-2", "all-2", "everyone-2", "atlas"]);
    // A bot whose slug is another bot's id is still found by the id first.
    let atlas = get_by_slug("atlas");
    let other = create(sink.as_ref(), "watcher", "Iris").unwrap();
    update(sink.as_ref(), &other.id, BotPatch { name: Some(atlas.id.clone()), ..Default::default() }).unwrap();
    assert_eq!(resolve(&atlas.id).unwrap().id, atlas.id);
}

fn get_by_slug(slug: &str) -> Bot {
    list().unwrap().into_iter().find(|bot| bot.slug == slug).unwrap()
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn refusals_are_told_apart_from_failures() {
    let (_home, sink, _events) = bots_on();
    let kind = |error: anyhow::Error| refusal(&error).cloned();
    assert!(matches!(kind(create(sink.as_ref(), "janitor", "Mop").unwrap_err()), Some(BotError::Refused(_))));
    assert!(matches!(kind(create(sink.as_ref(), "cto", " ").unwrap_err()), Some(BotError::Refused(_))));
    assert_eq!(kind(pause(sink.as_ref(), "gone", OWNER).unwrap_err()), Some(BotError::NotFound("gone".into())));
    assert_eq!(kind(delete(sink.as_ref(), "gone").unwrap_err()), Some(BotError::NotFound("gone".into())));
    assert_eq!(kind(get("gone").unwrap_err()), Some(BotError::NotFound("gone".into())));
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = false;
    crate::store::settings::save(&settings).unwrap();
    assert_eq!(kind(list().unwrap_err()), Some(BotError::Off));
}

/// PRO-478: who besides the owner may ask a bot for work, and what each may do.
#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn who_can_ask_keeps_people_and_bots_with_what_each_may_do() {
    let (_home, sink, _events) = bots_on();
    let sentry = create(sink.as_ref(), "security-auditor", "Sentry").unwrap();
    let atlas = create(sink.as_ref(), "cto", "Atlas").unwrap();
    let patch = |askers: Value| -> Result<Bot> { update(sink.as_ref(), &sentry.id, serde_json::from_value(json!({"whoCanAsk": askers})).unwrap()) };
    assert!(sentry.who_can_ask.is_empty(), "a new bot is asked by its owner alone");
    assert!(serde_json::to_value(&sentry).unwrap().get("whoCanAsk").is_none(), "an empty list is not written");

    let saved = patch(json!([
        {"kind": "person", "id": " user-ak ", "name": "Ankit Kumar", "may": "ask"},
        {"kind": "bot", "id": atlas.id, "may": "handOff"},
        {"kind": "person", "id": "user-ak", "name": "Again", "may": "askApprove"},
    ]))
    .unwrap();
    let kept: Vec<(&str, &str, &str)> = saved.who_can_ask.iter().map(|asker| (asker.kind.as_str(), asker.id.as_str(), asker.may.as_str())).collect();
    assert_eq!(kept, [("person", "user-ak", "ask"), ("bot", atlas.id.as_str(), "handOff")]);
    assert_eq!(get(&sentry.id).unwrap().who_can_ask, saved.who_can_ask);

    for (refused, why) in [
        (json!([{"kind": "bot", "id": atlas.id, "may": "askApprove"}]), "only a person's words count as approval"),
        (json!([{"kind": "bot", "id": sentry.id, "may": "handOff"}]), "A bot does not ask itself"),
        (json!([{"kind": "bot", "id": "nobody", "may": "ask"}]), "No bot has the id nobody"),
        (json!([{"kind": "person", "id": "u", "may": "handOff"}]), "A person may ask, or ask and approve"),
        (json!([{"kind": "person", "id": "owner", "may": "ask"}]), "you are not listed"),
        (json!([{"kind": "team", "id": "t", "may": "ask"}]), "Unknown kind team"),
        (json!([{"kind": "person", "id": "", "may": "ask"}]), "an id of one line"),
    ] {
        let error = patch(refused.clone()).unwrap_err().to_string();
        assert!(error.contains(why), "{refused}: {error}");
    }
    assert_eq!(get(&sentry.id).unwrap().who_can_ask, saved.who_can_ask, "a refused change changes nothing");

    // A deleted bot asks nobody any more.
    delete(sink.as_ref(), &atlas.id).unwrap();
    assert_eq!(get(&sentry.id).unwrap().who_can_ask.iter().map(|asker| asker.id.as_str()).collect::<Vec<_>>(), ["user-ak"]);
}

/// An entry a newer build wrote is kept through a save of the whole list, as it was.
#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn an_asker_this_build_does_not_know_is_kept_as_it_was() {
    let (_home, _sink, _events) = bots_on();
    let sink = BroadcastSink::new(8);
    let unknown = json!({"kind": "team", "id": "t1", "may": "triage", "since": "2027"});
    write_file(json!({"version": 1, "revision": 1, "bots": [record("b1", "sentry", json!({"whoCanAsk": [unknown]}))]}));
    let bot = get("b1").unwrap();
    assert_eq!(serde_json::to_value(&bot.who_can_ask[0]).unwrap(), unknown);
    let mut askers = serde_json::to_value(&bot.who_can_ask).unwrap();
    askers.as_array_mut().unwrap().push(json!({"kind": "person", "id": "u2", "may": "ask"}));
    let saved = update(&sink, "b1", serde_json::from_value(json!({"whoCanAsk": askers})).unwrap()).unwrap();
    assert_eq!(serde_json::to_value(&saved.who_can_ask[0]).unwrap(), unknown);
    assert_eq!(saved.who_can_ask.len(), 2);
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_list_change_made_on_an_older_read_is_refused() {
    let (_home, sink, _events) = bots_on();
    let bot = create(sink.as_ref(), "cto", "Atlas").unwrap();
    let seen = bot.modified.clone();
    std::thread::sleep(std::time::Duration::from_millis(5));
    update(sink.as_ref(), &bot.id, serde_json::from_value(json!({"roleTitle": "Chief"})).unwrap()).unwrap();
    let stale = serde_json::from_value(json!({"whoCanAsk": [], "ifModified": seen})).unwrap();
    assert!(update(sink.as_ref(), &bot.id, stale).unwrap_err().to_string().contains("changed since"));
    let fresh = get(&bot.id).unwrap().modified;
    update(sink.as_ref(), &bot.id, serde_json::from_value(json!({"worksIn": ["personal"], "ifModified": fresh})).unwrap()).unwrap();
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn an_asker_missing_a_field_leaves_the_bot_readable() {
    let (_home, sink, _events) = bots_on();
    let bot = create(sink.as_ref(), "cto", "Atlas").unwrap();
    let path = crate::store::root().unwrap().join("bots.json");
    let mut raw: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    raw["bots"][0]["whoCanAsk"] = json!([{"kind": "person", "id": "u1"}]);
    std::fs::write(&path, serde_json::to_vec(&raw).unwrap()).unwrap();
    let read = get(&bot.id).expect("still readable");
    assert_eq!((read.who_can_ask[0].id.as_str(), read.who_can_ask[0].may.as_str()), ("u1", ""));
}

/// A resume asked for from the CLI is shown for a day, then forgotten.
#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_resume_request_is_dropped_after_a_day() {
    let (_home, sink, _events) = bots_on();
    let bot = create(sink.as_ref(), "cto", "Atlas").unwrap();
    pause(sink.as_ref(), &bot.id, OWNER).unwrap();
    request_resume(sink.as_ref(), &bot.id, "cli").unwrap();
    assert!(get(&bot.id).unwrap().unknown.contains_key(RESUME_REQUEST_KEY), "shown while fresh");
    assert!(listing().unwrap().bots[0].unknown.contains_key(RESUME_REQUEST_KEY));

    let mut stale = get(&bot.id).unwrap();
    let day_ago = (chrono::Utc::now() - RESUME_REQUEST_LASTS - chrono::Duration::minutes(1)).to_rfc3339();
    stale.unknown.insert(RESUME_REQUEST_KEY.into(), json!({"at": day_ago, "by": "cli"}));
    forget_stale_request(&mut stale, chrono::Utc::now());
    assert!(!stale.unknown.contains_key(RESUME_REQUEST_KEY), "a day old: gone");
    let mut unreadable = get(&bot.id).unwrap();
    unreadable.unknown.insert(RESUME_REQUEST_KEY.into(), json!({"at": "yesterday"}));
    forget_stale_request(&mut unreadable, chrono::Utc::now());
    assert!(!unreadable.unknown.contains_key(RESUME_REQUEST_KEY));
}

/// L4: the change events carry no resume request older than a day either.
#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_stale_resume_request_is_not_announced() {
    let (_home, sink, mut events) = bots_on();
    let bot = create(sink.as_ref(), "cto", "Atlas").unwrap();
    pause(sink.as_ref(), &bot.id, OWNER).unwrap();
    let day_ago = (chrono::Utc::now() - RESUME_REQUEST_LASTS - chrono::Duration::minutes(1)).to_rfc3339();
    bot_store::change(
        |bots| {
            bots[0].unknown.insert(RESUME_REQUEST_KEY.into(), json!({"at": day_ago, "by": "cli"}));
            Ok(())
        },
        |_| {},
    )
    .unwrap();
    while events.try_recv().is_ok() {}
    update(sink.as_ref(), &bot.id, BotPatch { name: Some("Atlas II".into()), ..Default::default() }).unwrap();
    let announced: Vec<_> = std::iter::from_fn(|| events.try_recv().ok()).filter(|published| &*published.event == "bots_changed").collect();
    assert_eq!(announced.len(), 1);
    let list: serde_json::Value = serde_json::from_str(&announced[0].payload).unwrap();
    assert_eq!(list["bots"][0]["name"], "Atlas II");
    assert!(list["bots"][0].get(RESUME_REQUEST_KEY).is_none(), "{list}");
}

/// L2: an update no person was shown to ask for is judged under the store's
/// lock: less access, fewer places, fewer askers and an asker who may do less
/// go through; more access, another reporting line, a new place, a new, wider
/// or otherwise changed asker, another agent, model or effort, a rename and
/// another place to run (PRO-478) do not.
#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn an_update_no_person_asked_for_gives_nothing_more() {
    let (_home, sink, _events) = bots_on();
    let atlas = create(sink.as_ref(), "cto", "Atlas").unwrap();
    let argus = create(sink.as_ref(), "watcher", "Argus").unwrap();
    let asker = |may: &str| serde_json::from_value::<BotAsker>(json!({"kind": "person", "id": "u1", "may": may})).unwrap();
    update(sink.as_ref(), &atlas.id, BotPatch { works_in: Some(vec![PERSONAL.into(), "org-a".into()]), who_can_ask: Some(vec![asker("askApprove")]), ..Default::default() }).unwrap();
    let lower = BotPatch { access: Some(BotAccess::AskOutward), name: Some(" Atlas ".into()), works_in: Some(vec![PERSONAL.into()]), who_can_ask: Some(vec![asker("ask")]), ..Default::default() };
    let lowered = update_as(sink.as_ref(), &atlas.id, lower, false).unwrap();
    assert_eq!((lowered.access, lowered.works_in.len(), lowered.who_can_ask[0].may.as_str()), (BotAccess::AskOutward, 1, "ask"));
    for patch in [
        BotPatch { access: Some(BotAccess::Full), ..Default::default() },
        BotPatch { reports_to: Some(argus.id.clone()), ..Default::default() },
        BotPatch { works_in: Some(vec![PERSONAL.into(), "org-b".into()]), ..Default::default() },
        BotPatch { who_can_ask: Some(vec![asker("askApprove")]), ..Default::default() },
        BotPatch { who_can_ask: Some(vec![asker("ask"), serde_json::from_value(json!({"kind": "bot", "id": argus.id, "may": "handOff"})).unwrap()]), ..Default::default() },
        BotPatch { harness: Some("codex".into()), ..Default::default() },
        BotPatch { model: Some("some-model".into()), ..Default::default() },
        BotPatch { effort: Some(Some("high".into())), ..Default::default() },
        BotPatch { name: Some("Atlas II".into()), ..Default::default() },
        BotPatch { who_can_ask: Some(vec![serde_json::from_value(json!({"kind": "person", "id": "u1", "may": "ask", "org": "org-b"})).unwrap()]), ..Default::default() },
        BotPatch { runs_on: Some(BotRunsOn::Other("cloudWorkspace".into())), ..Default::default() },
    ] {
        let refused = update_as(sink.as_ref(), &atlas.id, patch, false).unwrap_err().to_string();
        assert!(refused.contains(PERSON_REQUIRED), "{refused}");
    }
    assert_eq!(get(&atlas.id).unwrap().access, BotAccess::AskOutward);
    assert_eq!(update_as(sink.as_ref(), &atlas.id, BotPatch { access: Some(BotAccess::Full), ..Default::default() }, true).unwrap().access, BotAccess::Full);
}
