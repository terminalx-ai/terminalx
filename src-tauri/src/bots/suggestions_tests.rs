//! The suggestion store (PRO-477): kept beside the home, bounded, newer
//! records kept as they are, and gone to the trash with its bot.

use serde_json::json;

use super::*;
use crate::sink::BroadcastSink;

fn bot(sink: &dyn EventSink) -> Bot {
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = true;
    crate::store::settings::save(&settings).unwrap();
    super::super::create(sink, "cto", "Atlas").unwrap()
}

fn look(run: &str) -> From {
    From { kind: "lookAround".into(), run: Some(run.into()), run_number: Some(1), ..Default::default() }
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_suggestion_is_one_line_once_and_says_so_to_the_window() {
    let _home = crate::store::temp_home();
    let sink = BroadcastSink::new(64);
    let mut events = sink.subscribe();
    let atlas = bot(&sink);
    let made = suggest(&sink, &atlas, "  Close PR #1247  ", "#1198 covers it.", look("r1")).unwrap();
    assert_eq!((made.number, made.title.as_str(), made.state.as_str()), (1, "Close PR #1247", OPEN));
    let said: Vec<_> = std::iter::from_fn(|| events.try_recv().ok()).filter(|event| &*event.event == CHANGED_EVENT).collect();
    assert_eq!(said.len(), 1);
    assert!(suggest(&sink, &atlas, "Two\nlines", "Why.", From::default()).is_err());
    assert!(suggest(&sink, &atlas, "Close it", "", From::default()).is_err());
    assert!(suggest(&sink, &atlas, "close pr #1247", "Again.", From::default()).unwrap_err().to_string().contains("already suggested"));
    // Kept outside the home, which the bot writes with its own tools.
    assert!(crate::store::root().unwrap().join(DIR).join(format!("{}.json", atlas.id)).is_file());
    assert!(!super::super::home(&atlas).unwrap().join(DIR).exists());
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn open_suggestions_are_capped_and_closed_ones_trimmed() {
    let _home = crate::store::temp_home();
    let sink = BroadcastSink::new(64);
    let atlas = bot(&sink);
    for n in 0..MAX_OPEN {
        suggest(&sink, &atlas, &format!("Idea {n}"), "Worth it.", From::default()).unwrap();
    }
    assert!(suggest(&sink, &atlas, "One more", "Worth it.", From::default()).unwrap_err().to_string().contains("waiting for your owner"));
    // Closing makes room; a closed one cannot be closed again.
    dismiss(&sink, &atlas, 1).unwrap();
    assert!(dismiss(&sink, &atlas, 1).unwrap_err().to_string().contains("already dismissed"));
    assert!(dismiss(&sink, &atlas, 999).is_err());
    suggest(&sink, &atlas, "One more", "Worth it.", From::default()).unwrap();
    // Only the newest closed ones are kept.
    for number in 2..=(MAX_OPEN as u64) {
        dismiss(&sink, &atlas, number).unwrap();
    }
    for n in 0..60 {
        let made = suggest(&sink, &atlas, &format!("Later {n}"), "Worth it.", From::default()).unwrap();
        dismiss(&sink, &atlas, made.number).unwrap();
    }
    let file = read(&atlas.id).unwrap();
    assert_eq!(file.readable().iter().filter(|suggestion| !suggestion.open()).count(), KEEP_CLOSED);
    assert_eq!(file.open().len(), 1);
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn what_a_newer_build_wrote_is_kept_and_shown_by_none() {
    let _home = crate::store::temp_home();
    let sink = BroadcastSink::new(64);
    let atlas = bot(&sink);
    suggest(&sink, &atlas, "Close PR #1247", "#1198 covers it.", From::default()).unwrap();
    let path = crate::store::root().unwrap().join(DIR).join(format!("{}.json", atlas.id));
    let mut stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    stored["suggestions"].as_array_mut().unwrap().push(json!({"number": 7, "title": {"rich": true}}));
    stored["suggestions"][0]["priority"] = json!("high");
    stored["newer"] = json!(true);
    std::fs::write(&path, stored.to_string()).unwrap();
    suggest(&sink, &atlas, "Sort the issues", "37 untriaged.", From::default()).unwrap();
    let shown = listing(&atlas).unwrap();
    assert_eq!((shown["suggestions"].as_array().unwrap().len(), shown["unreadable"].as_u64()), (2, Some(1)));
    let kept: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(kept["newer"], true);
    assert_eq!(kept["suggestions"][0]["priority"], "high");
    assert!(kept["suggestions"].as_array().unwrap().iter().any(|value| value["number"] == 7));
    assert!(dismiss(&sink, &atlas, 7).is_err(), "never rewritten");
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_look_remembers_what_it_was_refused_and_its_suggestions_go_to_the_trash_with_its_bot() {
    let _home = crate::store::temp_home();
    let sink = BroadcastSink::new(64);
    let atlas = bot(&sink);
    for _ in 0..3 {
        note_refused(&atlas.id, "r1", "`git push`");
    }
    note_refused(&atlas.id, "r1", "`Write`");
    let note = read(&atlas.id).unwrap().looks["r1"].clone();
    assert_eq!((note.refused, note.what.as_slice()), (4, &["`git push`".to_string(), "`Write`".to_string()][..]));
    for n in 0..30 {
        note_refused(&atlas.id, &format!("run-{n:02}"), "`Write`");
    }
    assert_eq!(read(&atlas.id).unwrap().looks.len(), KEEP_LOOKS);

    trash(&atlas.id).unwrap();
    assert!(read(&atlas.id).unwrap().looks.is_empty());
    assert!(crate::store::root().unwrap().join("trash").join(DIR).join(format!("{}.json", atlas.id)).is_file());
    assert!(path("../escape").is_err(), "an id names no path outside the folder");
}
