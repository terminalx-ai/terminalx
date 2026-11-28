use serde_json::json;

use super::*;
use crate::bots::items::{self, By, NewItem};
use crate::sink::BroadcastSink;

fn sink() -> BroadcastSink {
    BroadcastSink::new(256)
}

fn bots_on() -> crate::store::TempHome {
    let home = crate::store::temp_home();
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = true;
    crate::store::settings::save(&settings).unwrap();
    home
}

/// Another runtime's store: the next calls read and write there.
fn other_runtime() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::env::set_var("TERMINALX_HOME", dir.path());
    dir
}

fn hire() -> Bot {
    let bot = super::super::create(&sink(), "cto", "Atlas").unwrap();
    super::super::duties::from_template(&sink(), &bot).unwrap();
    crate::store::write_atomic(&bot_store::home_dir(&bot.id).unwrap().join("MEMORY.md"), b"- The owner likes short reports.\n").unwrap();
    let new = NewItem { title: "Check the release".into(), summary: String::new(), done_means: Vec::new(), start: false, asked_by: None, added_by: None };
    let item = items::add(&sink(), &bot, &By::Owner, new).unwrap();
    items::ask(&sink(), &bot, item.number, "Ship today?", &["Yes".into(), "No".into()], Some(0)).unwrap();
    bot
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_moved_bot_takes_its_role_memory_items_and_duties_and_rests_where_it_left() {
    let _home = bots_on();
    let bot = hire();
    let duties_here = duties::duties_of(&bot.id).unwrap();
    assert!(!duties_here.is_empty(), "the CTO role brings duties");
    let bundle = decode(&encode(&export(&bot.id).unwrap()).unwrap()).unwrap();
    assert!(bundle.files.iter().any(|file| file.tree == "home" && file.path == "MEMORY.md"));
    assert!(bundle.files.iter().any(|file| file.tree == "items"));
    assert_eq!(bundle.duties.len(), duties_here.len());

    // Here it is marked moved: it stays listed, and its duties and chats do nothing.
    let moved = move_out(&sink(), &bot.id, "cloud:org-1:ws-1").unwrap();
    assert_eq!(moved.runs_on, BotRunsOn::Cloud("cloud:org-1:ws-1".into()));
    assert!(super::super::chat::new_chat(&sink(), &bot.id, None).unwrap_err().to_string().contains("runs on a cloud workspace now"));
    assert!(duties::held(&duties_here[0]).unwrap().contains("its duties run there"));
    assert!(export(&bot.id).is_err(), "a bot that lives elsewhere is not moved from here");

    // The other runtime takes it in, with Bots off there until now.
    let _there = other_runtime();
    assert!(!crate::bots::enabled());
    let imported = import(&sink(), bundle, Some("user-1")).unwrap();
    assert!(crate::bots::enabled());
    assert_eq!(imported.bot.runs_on, BotRunsOn::ThisMac);
    assert_eq!(imported.bot.unknown.get(OWNER_USER_KEY), Some(&json!("user-1")));
    let home = bot_store::home_dir(&bot.id).unwrap();
    assert_eq!(std::fs::read_to_string(home.join("MEMORY.md")).unwrap(), "- The owner likes short reports.\n");
    let list = items::read(&bot.id).unwrap();
    assert_eq!(list.items[0].question.as_ref().unwrap().text, "Ship today?");
    let duties_there = duties::duties_of(&bot.id).unwrap();
    assert_eq!(duties_there.len(), duties_here.len());
    assert!(duties_there.iter().all(|duty| duty.project_path.starts_with(&home.to_string_lossy().into_owned())), "duties work in the new home");
    assert!(duties::held(&duties_there[0]).is_none());

    // Only its owner reads it there; a second import of the same bot is refused while it lives there.
    assert!(belongs_to(&imported.bot, Some("user-1")));
    assert!(!belongs_to(&imported.bot, Some("user-2")));
    assert!(!belongs_to(&imported.bot, None));
    let again = export(&bot.id).unwrap();
    assert!(import(&sink(), again.clone(), Some("user-1")).unwrap_err().to_string().contains("already lives here"));
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_bot_brought_back_replaces_the_copy_it_left_and_works_here_again() {
    let _home = bots_on();
    let bot = hire();
    let mine = std::env::var("TERMINALX_HOME").unwrap();
    let bundle = export(&bot.id).unwrap();
    move_out(&sink(), &bot.id, "machine:mac-2").unwrap();

    let _there = other_runtime();
    import(&sink(), bundle, None).unwrap();
    crate::store::write_atomic(&bot_store::home_dir(&bot.id).unwrap().join("MEMORY.md"), b"- Learned while away.\n").unwrap();
    let back = export(&bot.id).unwrap();

    std::env::set_var("TERMINALX_HOME", &mine);
    let imported = import(&sink(), back, None).unwrap();
    assert_eq!(imported.bot.runs_on, BotRunsOn::ThisMac);
    assert_eq!(std::fs::read_to_string(bot_store::home_dir(&bot.id).unwrap().join("MEMORY.md")).unwrap(), "- Learned while away.\n");
    // The copy it left is in the trash, not deleted.
    let replaced = crate::store::root().unwrap().join("trash").join("bots-replaced");
    assert_eq!(std::fs::read_dir(replaced).unwrap().count(), 1);
    assert!(super::super::chat::new_chat(&sink(), &bot.id, None).is_ok() || duties::held(&duties::duties_of(&bot.id).unwrap()[0]).is_none());
    assert!(duties::held(&duties::duties_of(&bot.id).unwrap()[0]).is_none());
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_failed_move_is_undone_and_places_are_checked() {
    let _home = bots_on();
    let bot = hire();
    for odd in ["thisMac", "cloud:org", "cloud:org:ws/../x", "machine:", "elsewhere"] {
        assert!(move_out(&sink(), &bot.id, odd).is_err(), "{odd}");
    }
    move_out(&sink(), &bot.id, "cloud:org-1:ws-1").unwrap();
    assert!(move_out(&sink(), &bot.id, "machine:mac-2").unwrap_err().to_string().contains("Bring it back first"));
    assert!(move_back(&sink(), &bot.id).unwrap().runs_on.here());
    // Its record alone never moves it.
    let patch = crate::bots::BotPatch { runs_on: Some(BotRunsOn::parse("cloud:org-1:ws-1".into())), ..Default::default() };
    assert!(crate::bots::update_as(&sink(), &bot.id, patch, true).unwrap_err().to_string().contains("with Move in its settings"));
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_bundle_cannot_write_outside_the_bots_folders() {
    let _home = bots_on();
    let bot = hire();
    let exported = export(&bot.id).unwrap();
    let _there = other_runtime();
    for (tree, path) in [("home", "../escape"), ("home", "/etc/passwd"), ("nowhere", "x"), ("suggestions", "other.json"), ("items", "a\\b")] {
        let mut bundle = exported.clone();
        bundle.files = vec![BundleFile { tree: tree.into(), path: path.into(), data: String::new() }];
        assert!(import(&sink(), bundle, None).is_err(), "{tree} {path}");
    }
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_bundle_brings_only_its_own_bots_duties_once_each() {
    let _home = bots_on();
    let atlas = hire();
    let exported = export(&atlas.id).unwrap();
    // Another member's bot already lives there, with its own duties.
    let _there = other_runtime();
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = true;
    crate::store::settings::save(&settings).unwrap();
    let theirs = super::super::create(&sink(), "watcher", "Argus").unwrap();
    super::super::duties::from_template(&sink(), &theirs).unwrap();
    let their_duties = duties::duties_of(&theirs.id).unwrap();
    let their_duty = their_duties.first().expect("the watcher role brings duties").clone();

    // A duty that names another bot would run with that bot's access: refused, and nothing changes.
    let mut forged = exported.clone();
    let mut duty = forged.duties[0].clone();
    duty.unknown = their_duty.unknown.clone();
    forged.duties.push(duty);
    assert!(import(&sink(), forged, Some("user-2")).unwrap_err().to_string().contains("not one of Atlas's duties"));
    // Neither twice in one bundle, nor taking an id something else has here.
    let mut twice = exported.clone();
    twice.duties.push(twice.duties[0].clone());
    assert!(import(&sink(), twice, None).unwrap_err().to_string().contains("twice"));
    let mut taken = exported.clone();
    taken.duties[0].id = their_duty.id.clone();
    assert!(import(&sink(), taken, None).unwrap_err().to_string().contains("taken here"));

    assert!(bot_store::get(&atlas.id).unwrap().is_none(), "a refused bundle leaves no bot");
    assert!(!bot_store::home_dir(&atlas.id).unwrap().exists(), "nor any of its files");
    assert_eq!(duties::duties_of(&theirs.id).unwrap(), their_duties, "their duties are untouched");
    import(&sink(), exported, None).unwrap();
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_refused_bundle_turns_nothing_on_and_moves_nothing_aside() {
    let _home = bots_on();
    let bot = hire();
    let mut bundle = export(&bot.id).unwrap();
    move_out(&sink(), &bot.id, "machine:mac-2").unwrap();
    let memory = bot_store::home_dir(&bot.id).unwrap().join("MEMORY.md");
    bundle.files.push(BundleFile { tree: "home".into(), path: "../escape".into(), data: String::new() });
    assert!(import(&sink(), bundle, None).is_err());
    // The copy it left here is where it was, and nothing went to the trash.
    assert!(memory.exists());
    assert!(!crate::store::root().unwrap().join("trash").join("bots-replaced").exists());

    let _there = other_runtime();
    let mut bundle = export_from_scratch(&bot);
    bundle.files.push(BundleFile { tree: "nowhere".into(), path: "x".into(), data: String::new() });
    assert!(import(&sink(), bundle, None).is_err());
    assert!(!crate::bots::enabled(), "a refused bundle does not turn Bots on");
}

/// A bundle for `bot` with no files or duties, for a runtime that never had it.
fn export_from_scratch(bot: &Bot) -> Bundle {
    Bundle { v: BUNDLE_VERSION, bot: bot.clone(), home: String::new(), files: Vec::new(), duties: Vec::new(), duty_settings: None }
}

/// S-17: Remote-to-local migration bundles are untrusted: imported duties are
/// forced disabled, shell prechecks and `WatchTarget::Command` are quarantined
/// and refused by `duties::run_check`/`run_watch`, and local access levels &
/// pause state cannot be escalated by a tampered remote bundle.
#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn imported_remote_bundle_disables_duties_quarantines_shell_commands_and_caps_access_s17() {
    use crate::automations::{AutomationEventSource, AutomationEventTrigger, AutomationPrecheck};
    use crate::bots::wakes::{BotSource, BotSourceFields, WatchTarget};

    let _home = bots_on();
    let bot = hire();
    // Local owner restricted this bot to `readReport` and paused it before moving it out.
    let patch = crate::bots::BotPatch { access: Some(crate::bots::BotAccess::ReadReport), ..Default::default() };
    crate::bots::update_as(&sink(), &bot.id, patch, true).unwrap();
    crate::bots::pause(&sink(), &bot.id, crate::bots::OWNER).unwrap();

    let mut bundle = export(&bot.id).unwrap();
    move_out(&sink(), &bot.id, "cloud:org-1:ws-1").unwrap();

    // Attacker in compromised cloud workspace tampers with the bundle before moving it back locally:
    // 1) Escalates access from ReadReport -> Full and clears `paused`
    // 2) Enables a duty with a malicious shell `precheck.command`
    // 3) Enables a duty with a malicious `WatchTarget::Command`
    bundle.bot.access = crate::bots::BotAccess::Full;
    bundle.bot.paused = None;
    assert!(!bundle.duties.is_empty());
    bundle.duties[0].enabled = true;
    bundle.duties[0].precheck = Some(AutomationPrecheck { command: "echo PWNED_PRECHECK".into(), timeout_seconds: 30 });
    let mut watch_duty = bundle.duties[0].clone();
    watch_duty.id = "malicious-watch-duty".into();
    watch_duty.name = "Malicious Watch".into();
    watch_duty.enabled = true;
    watch_duty.precheck = None;
    watch_duty.event_trigger = Some(AutomationEventTrigger {
        source: AutomationEventSource::Bot(BotSource {
            kind: "watch".into(),
            fields: BotSourceFields {
                target: Some(WatchTarget::Command),
                value: Some("echo PWNED_WATCH".into()),
                timeout_seconds: Some(30),
                ..Default::default()
            },
        }),
        poll_interval_minutes: 5,
        max_runs_per_tick: 1,
        max_runs_per_day: None,
    });
    bundle.duties.push(watch_duty);

    let imported = import(&sink(), bundle, None).unwrap();
    // 1. Local access cap & pause state preserved (no privilege escalation!).
    assert_eq!(imported.bot.access, crate::bots::BotAccess::ReadReport, "cannot escalate past local ReadReport");
    assert!(imported.bot.paused.is_some(), "cannot silently unpause a locally paused bot");

    // 2. Every imported duty is forced `enabled = false`, and shell precheck/watch are quarantined.
    let imported_duties = duties::duties_of(&bot.id).unwrap();
    assert!(imported_duties.iter().all(|d| !d.enabled), "every imported duty must be disabled until locally reviewed");

    let precheck_duty = imported_duties.iter().find(|d| d.id == imported_duties[0].id).unwrap();
    assert!(precheck_duty.precheck.is_none(), "shell precheck must be stripped on import");
    assert!(duties::is_shell_quarantined(precheck_duty), "duty must carry quarantine flag");
    assert_eq!(
        precheck_duty.unknown.get(QUARANTINED_PRECHECK_KEY).and_then(|v| v["command"].as_str()),
        Some("echo PWNED_PRECHECK")
    );
    // Defense in depth: even calling `duties::run_check` directly refuses quarantined duties.
    assert!(
        duties::run_check(precheck_duty, &AutomationPrecheck { command: "echo hi".into(), timeout_seconds: 10 }, None).is_err(),
        "quarantined duty must refuse precheck execution"
    );

    let watch_imported = imported_duties.iter().find(|d| d.id == "malicious-watch-duty").unwrap();
    assert!(watch_imported.event_trigger.is_none(), "WatchTarget::Command trigger must be stripped on import");
    assert!(duties::is_shell_quarantined(watch_imported));
    assert_eq!(
        watch_imported.unknown.get(QUARANTINED_WATCH_COMMAND_KEY).and_then(|v| v["command"].as_str()),
        Some("echo PWNED_WATCH")
    );
    assert!(
        duties::run_watch(watch_imported, &AutomationPrecheck { command: "echo hi".into(), timeout_seconds: 10 }).is_err(),
        "quarantined duty must refuse watch command execution"
    );
    assert!(!imported.notes.is_empty(), "owner must be notified about disabled/quarantined duties and capped access");

    // 3. Brand-new local import with no prior local bot caps `Full` -> `AskOutward`.
    let _fresh = other_runtime();
    let mut fresh_bundle = export_from_scratch(&bot);
    fresh_bundle.bot.access = crate::bots::BotAccess::Full;
    fresh_bundle.bot.paused = None;
    let fresh_imported = import(&sink(), fresh_bundle, None).unwrap();
    assert_eq!(fresh_imported.bot.access, crate::bots::BotAccess::AskOutward, "new local import must cap Full to AskOutward");
}
