//! PRO-469: `terminalx bots items …` as the app receives it.

use serde_json::json;

use super::*;

/// The CLI's words become the parameters the app checks.
#[test]
fn the_items_commands_parse_as_the_guide_says() {
    let args = |words: &[&str]| words.iter().map(|word| word.to_string()).collect::<Vec<_>>();
    let rpc = |words: &[&str]| match parse(&args(words)).unwrap_or_else(|error| panic!("{words:?}: {error:?}")).action {
        Action::Rpc { command, params, .. } => (command, params),
        other => panic!("{words:?} is not a call: {other:?}"),
    };
    assert_eq!(rpc(&["bots", "items", "list", "--all", "--bot", "atlas"]), ("bots.items.list".into(), json!({"bot": "atlas", "all": true})));
    assert_eq!(
        rpc(&["bots", "items", "add", "--title", "Merge main", "--done", "merged | by code", "--done", "tests pass", "--start"]),
        ("bots.items.add".into(), json!({"title": "Merge main", "done": ["merged | by code", "tests pass"], "start": true}))
    );
    assert_eq!(
        rpc(&["bots", "items", "ask", "#14", "--question", "Approve?", "--answer", "Yes", "--answer", "No", "--recommend", "1"]),
        ("bots.items.ask".into(), json!({"item": 14, "question": "Approve?", "answers": ["Yes", "No"], "recommend": 1}))
    );
    assert_eq!(rpc(&["bots", "items", "check", "14", "2", "--met", "--how", "CI"]), ("bots.items.check".into(), json!({"item": 14, "line": 2, "met": true, "how": "CI"})));
    assert_eq!(rpc(&["bots", "items", "set", "3", "--state", "waiting", "--link", "ticket:PRO-120"]).1, json!({"item": 3, "state": "waiting", "done": [], "link": ["ticket:PRO-120"]}));
    assert_eq!(rpc(&["bots", "items", "comment", "3", "--text", "Waiting on CI"]).1, json!({"item": 3, "text": "Waiting on CI"}));
    assert_eq!(rpc(&["bots", "items", "done", "3"]).1, json!({"item": 3}));
    for refused in [
        &["bots", "items"][..],
        &["bots", "items", "remove", "3"],
        &["bots", "items", "add"],
        &["bots", "items", "show"],
        &["bots", "items", "show", "zero"],
        &["bots", "items", "check", "3", "1"],
        &["bots", "items", "check", "3", "1", "--met", "--unmet"],
        &["bots", "items", "check", "3", "0", "--met"],
        &["bots", "items", "ask", "3", "--answer", "Yes"],
        &["bots", "items", "ask", "3", "--question", "Q", "--recommend", "0"],
        &["bots", "items", "comment", "3"],
        &["bots", "items", "done", "3", "extra"],
    ] {
        assert_eq!(parse(&args(refused)).unwrap_err().code, "invalid_arguments", "{refused:?}");
    }
    let help = help_text();
    for said in ["terminalx bots items list", "terminalx bots items ask ITEM --question TEXT", "terminalx bots items check ITEM LINE --met|--unmet"] {
        assert!(help.contains(said), "{said}");
    }
    for said in ["#### A bot's work items", "terminalx bots items ask <item>", "bot-items/<id>/items.json"] {
        assert!(GUIDE.contains(said), "the guide does not say {said:?}");
    }
}
