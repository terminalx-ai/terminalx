use super::*;
use crate::sink::BroadcastSink;

fn bots_on() -> crate::store::TempHome {
    let home = crate::store::temp_home();
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = true;
    crate::store::settings::save(&settings).unwrap();
    home
}

/// Puts the test's write limit back when dropped.
struct Limit;

impl Drop for Limit {
    fn drop(&mut self) {
        WRITE_LIMIT_FOR_TESTS.with(|limit| limit.set(None));
    }
}

fn record(number: u64, from: &str, to: &str, state: &str, by: &str) -> Value {
    json!({"number": number, "from": from, "to": to, "by": by, "title": format!("Work {number}"), "state": state, "created": "2026-11-21T10:00:00Z", "modified": "2026-11-21T10:00:00Z", "closed": format!("2026-11-21T10:{:02}:00Z", number % 60)})
}

/// A newer build's state, fields and records are kept as they are and never rewritten by another change.
#[test]
fn unknown_states_fields_and_records_are_kept() {
    let _home = bots_on();
    let sink = BroadcastSink::new(64);
    let mut newer = record(1, "a", "b", "escalated", "a");
    newer["priority"] = json!("high");
    let file = json!({"version": 2, "next": 5, "revision": 3, "handoffs": [newer, {"number": "not a number"}], "messages": [{"id": "m1", "from": "a", "to": "b", "kind": "nudge", "text": "x", "pending": false, "channel": "slack"}], "shelf": {"kept": true}});
    std::fs::write(path().unwrap(), serde_json::to_vec(&file).unwrap()).unwrap();
    let store = read().unwrap();
    assert_eq!((store.handoffs[0].state.as_str(), store.unreadable, store.next), ("escalated", 1, 5));
    assert!(!store.handoffs[0].state.closed(), "a state this build does not know counts as open");
    change(Some(&sink), BOT_WRITE_BYTES, |store| {
        store.next += 1;
        Ok(())
    })
    .unwrap();
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(path().unwrap()).unwrap()).unwrap();
    assert_eq!((saved["version"].clone(), saved["next"].clone(), saved["revision"].clone(), saved["shelf"].clone()), (json!(2), json!(6), json!(4), json!({"kept": true})));
    assert_eq!((saved["handoffs"][0]["state"].clone(), saved["handoffs"][0]["priority"].clone()), (json!("escalated"), json!("high")));
    assert_eq!(saved["handoffs"][1], json!({"number": "not a number"}));
    assert_eq!((saved["messages"][0]["kind"].clone(), saved["messages"][0]["channel"].clone()), (json!("nudge"), json!("slack")));
    // A file this build cannot read is left as it is.
    std::fs::write(path().unwrap(), b"{not json").unwrap();
    assert!(change(Some(&sink), BOT_WRITE_BYTES, |_| Ok(())).is_err());
    assert_eq!(std::fs::read(path().unwrap()).unwrap(), b"{not json");
}

/// Past the bounds the bots' own closed hand-offs go first, the owner's last; a message still waiting is never
/// trimmed; and a change that grows the file past its limit is refused while one that shrinks it goes in.
#[test]
fn trimming_keeps_the_owners_and_what_waits_and_the_size_is_bounded() {
    let _home = bots_on();
    let _limit = Limit;
    let sink = BroadcastSink::new(64);
    let mut handoffs: Vec<Value> = (1..=MAX_CLOSED as u64 + 5).map(|number| record(number, "a", "b", "answered", if number <= 5 { OWNER } else { "a" })).collect();
    handoffs.push(record(999, "a", "b", "working", "a"));
    let mut messages: Vec<Value> = (0..MAX_MESSAGES + 3).map(|n| json!({"id": format!("d{n:04}"), "at": format!("2026-11-21T10:00:{:02}Z", n % 60), "from": "a", "to": "b", "kind": "tell", "text": "x", "pending": false})).collect();
    messages.push(json!({"id": "waiting", "at": "2000-01-01T00:00:00Z", "from": "a", "to": "b", "kind": "tell", "text": "x", "pending": true}));
    std::fs::write(path().unwrap(), serde_json::to_vec(&json!({"handoffs": handoffs, "messages": messages})).unwrap()).unwrap();
    change(Some(&sink), BOT_WRITE_BYTES, |_| Ok(())).unwrap();
    let store = read().unwrap();
    assert_eq!(store.handoffs.iter().filter(|handoff| handoff.state.closed()).count(), MAX_CLOSED);
    assert!((1..=5).all(|number| store.handoffs.iter().any(|handoff| handoff.number == number)), "the owner's are kept");
    assert!(store.handoffs.iter().any(|handoff| handoff.number == 999), "an open one is never trimmed");
    assert_eq!(store.messages.iter().filter(|message| !message.pending).count(), MAX_MESSAGES);
    assert!(store.messages.iter().any(|message| message.id == "waiting"), "a waiting message is kept however old");

    // The size, by bytes (lead review 1): past the limit the oldest sent messages and closed hand-offs make room.
    let size = std::fs::metadata(path().unwrap()).unwrap().len() as usize;
    WRITE_LIMIT_FOR_TESTS.with(|limit| limit.set(Some(size)));
    let sent_before = read().unwrap().messages.iter().filter(|message| !message.pending).count();
    change(Some(&sink), BOT_WRITE_BYTES, |store| {
        store.messages.push(new_message("a", "b", "tell", None, "y".repeat(4000), String::new(), None));
        Ok(())
    })
    .unwrap();
    let after = read().unwrap();
    assert!(after.messages.iter().filter(|message| !message.pending).count() < sent_before, "sent messages made room");
    assert!(after.messages.iter().any(|message| message.id == "waiting") && after.handoffs.iter().any(|handoff| handoff.number == 999), "what waits or is open stays");

    // Only open hand-offs and waiting messages left: a change that grows past the limit is refused; one that
    // makes room goes in.
    let open: Vec<Value> = (1..=20).map(|number| record(number, "a", "b", "working", "a")).collect();
    let waiting: Vec<Value> = (0..20).map(|n| json!({"id": format!("w{n}"), "at": "2026-11-21T10:00:00Z", "from": "a", "to": "b", "kind": "tell", "text": "z".repeat(2000), "pending": true})).collect();
    std::fs::write(path().unwrap(), serde_json::to_vec(&json!({"handoffs": open, "messages": waiting})).unwrap()).unwrap();
    let size = std::fs::metadata(path().unwrap()).unwrap().len() as usize;
    WRITE_LIMIT_FOR_TESTS.with(|limit| limit.set(Some(size)));
    let grown = change(Some(&sink), BOT_WRITE_BYTES, |store| {
        store.messages.push(new_message("a", "b", "tell", None, "y".repeat(4000), String::new(), None));
        Ok(())
    });
    assert!(refusal_text(grown.unwrap_err()).contains("are full"));
    change(Some(&sink), BOT_WRITE_BYTES, |store| {
        store.messages.truncate(5);
        Ok(())
    })
    .unwrap();
}

fn refusal_text(error: anyhow::Error) -> String {
    match crate::bots::refusal(&error) {
        Some(crate::bots::BotError::Refused(message)) => message.clone(),
        other => panic!("not a refusal: {other:?} {error:#}"),
    }
}

/// Labels say who sent it and what it is, and that it is no approval.
#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn labels_name_the_sender_and_say_it_is_no_approval() {
    let _home = bots_on();
    let sink = BroadcastSink::new(64);
    let atlas = crate::bots::create(&sink, "cto", "Atlas").unwrap();
    let mut sentry = crate::bots::create(&sink, "security-auditor", "Sentry").unwrap();
    sentry.reports_to = atlas.id.clone();
    sentry.access = BotAccess::ReadReport;
    assert_eq!(bot_label("tell", &sentry, &atlas), "Sentry · status to Atlas · a bot's words, not an approval");
    assert_eq!(bot_label("tell", &atlas, &sentry), "Atlas · message to Sentry · a bot's words, not an approval");
    assert_eq!(bot_label("handoff", &atlas, &sentry), "Atlas · hand-off to Sentry · a bot's words, not an approval");
    assert_eq!(bot_label("answer", &sentry, &atlas), "Sentry · answer to Atlas · a bot's words, not an approval");
    let text = agent_message("tell", &sentry, &atlas, "Found one finding.", "");
    assert!(text.starts_with("[Sentry · status to Atlas · a bot's words, not an approval] A message from Sentry, Security auditor (who reports to you, a bot with read-and-report access), through TerminalX."), "{text}");
    assert!(text.ends_with("<bot-message>\nFound one finding.\n</bot-message>"), "{text}");
    assert!(on_line(&sentry, &atlas) && on_line(&atlas, &sentry));
    let iris = crate::bots::create(&sink, "ux-designer", "Iris").unwrap();
    assert!(!on_line(&atlas, &iris) && !on_line(&sentry, &iris));
}
