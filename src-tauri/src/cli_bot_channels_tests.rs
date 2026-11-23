//! PRO-480: `terminalx bots post | reply` as the app receives them.

use serde_json::json;

use super::*;

#[test]
fn the_channel_commands_parse_as_the_guide_says() {
    let args = |words: &[&str]| words.iter().map(|word| word.to_string()).collect::<Vec<_>>();
    let rpc = |words: &[&str]| match parse(&args(words)).unwrap_or_else(|error| panic!("{words:?}: {error:?}")).action {
        Action::Rpc { command, params, .. } => (command, params),
        other => panic!("{words:?} is not a call: {other:?}"),
    };
    assert_eq!(
        rpc(&["bots", "post", "github", "--pr", "https://github.com/acme/app/pull/7", "--request-changes", "--text", "The token is logged."]),
        ("bots.post".into(), json!({"service": "github", "pr": "https://github.com/acme/app/pull/7", "requestChanges": true, "text": "The token is logged."}))
    );
    assert_eq!(
        rpc(&["bots", "post", "github", "--issue", "9", "--repo", "acme/app", "--text", "Found it."]),
        ("bots.post".into(), json!({"service": "github", "issue": "9", "repo": "acme/app", "requestChanges": false, "text": "Found it."}))
    );
    assert_eq!(rpc(&["bots", "post", "linear", "--issue", "PRO-9", "--text", "Done."]), ("bots.post".into(), json!({"service": "linear", "issue": "PRO-9", "text": "Done."})));
    assert_eq!(rpc(&["bots", "reply", "--text", "On it."]), ("bots.reply".into(), json!({"text": "On it."})));
    for words in [
        &["bots", "post", "github", "--text", "x"][..],
        &["bots", "post", "github", "--pr", "1", "--issue", "2", "--text", "x"],
        &["bots", "post", "github", "--issue", "2", "--request-changes", "--text", "x"],
        &["bots", "post", "linear", "--text", "x"],
        &["bots", "post", "slack", "--text", "x"],
        &["bots", "reply"],
    ] {
        assert!(parse(&args(words)).is_err(), "{words:?}");
    }
}

/// PRO-492: `terminalx bots duty-off DUTY [--bot BOT]`.
#[test]
fn duty_off_parses_with_and_without_its_bot() {
    let args = |words: &[&str]| words.iter().map(|word| word.to_string()).collect::<Vec<_>>();
    let rpc = |words: &[&str]| match parse(&args(words)).unwrap_or_else(|error| panic!("{words:?}: {error:?}")).action {
        Action::Rpc { command, params, .. } => (command, params),
        other => panic!("{words:?} is not a call: {other:?}"),
    };
    assert_eq!(rpc(&["bots", "duty-off", "Watch CI"]), ("bots.dutyOff".into(), json!({"duty": "Watch CI"})));
    assert_eq!(rpc(&["bots", "duty-off", "Watch CI", "--bot", "atlas"]), ("bots.dutyOff".into(), json!({"duty": "Watch CI", "bot": "atlas"})));
    assert!(parse(&args(&["bots", "duty-off"])).is_err());
}
