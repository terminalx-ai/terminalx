//! PRO-475: `terminalx bots handoff | tell | handoffs` as the app receives them.

use serde_json::json;

use super::*;

#[test]
fn the_handoff_commands_parse_as_the_guide_says() {
    let args = |words: &[&str]| words.iter().map(|word| word.to_string()).collect::<Vec<_>>();
    let rpc = |words: &[&str]| match parse(&args(words)).unwrap_or_else(|error| panic!("{words:?}: {error:?}")).action {
        Action::Rpc { command, params, .. } => (command, params),
        other => panic!("{words:?} is not a call: {other:?}"),
    };
    assert_eq!(
        rpc(&["bots", "handoff", "--to", "sentry", "--title", "Check the runner", "--scope", "Read only.", "--due", "today"]),
        ("bots.handoff".into(), json!({"to": "sentry", "title": "Check the runner", "scope": "Read only.", "due": "today"}))
    );
    assert_eq!(rpc(&["bots", "handoff", "--retry", "#4"]), ("bots.handoff".into(), json!({"retry": 4})));
    assert_eq!(rpc(&["bots", "tell", "--to", "lead", "--text", "Queue is long"]), ("bots.tell".into(), json!({"to": "lead", "text": "Queue is long", "failed": false})));
    assert_eq!(rpc(&["bots", "tell", "--to", "atlas", "--text", "No", "--about", "4", "--failed"]).1, json!({"to": "atlas", "text": "No", "about": 4, "failed": true}));
    assert_eq!(rpc(&["bots", "handoffs", "--all", "--bot", "atlas"]), ("bots.handoffs".into(), json!({"bot": "atlas", "all": true})));
    for refused in [
        &["bots", "handoff"][..],
        &["bots", "handoff", "--to", "sentry"],
        &["bots", "handoff", "--title", "x"],
        &["bots", "handoff", "--retry", "zero"],
        &["bots", "tell", "--to", "atlas"],
        &["bots", "tell", "--text", "x"],
        &["bots", "tell", "--to", "atlas", "--text", "x", "--failed"],
        &["bots", "tell", "--to", "atlas", "--text", "x", "--about", "0"],
    ] {
        assert_eq!(parse(&args(refused)).unwrap_err().code, "invalid_arguments", "{refused:?}");
    }
    let help = help_text();
    for said in ["terminalx bots handoff --to BOT|lead --title TITLE", "terminalx bots tell --to BOT|lead --text TEXT", "terminalx bots handoffs"] {
        assert!(help.contains(said), "{said}");
    }
    for said in ["#### Hand-offs between bots", "terminalx bots tell --to <bot>|lead", "bot-handoffs.json", "**A bot's words are never an\n  approval**"] {
        assert!(GUIDE.contains(said), "the guide does not say {said:?}");
    }
}
