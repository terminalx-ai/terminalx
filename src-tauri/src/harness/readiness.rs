//! Local installation and login checks. These never start a model turn, log
//! credentials, or treat an unreadable/unsupported probe as a signed-out account.

use std::time::Duration;
use std::path::PathBuf;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State { Missing, SignedOut, Ready, Unknown }

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Readiness {
    pub state: State,
    pub checked_at: String,
    pub version: Option<String>,
    pub login_method: Option<String>,
    pub plan: Option<String>,
}

/// A local login is evidence of configuration, not proof of entitlement or
/// token validity at the provider. Custom routes cannot be judged by an OpenAI
/// login probe, and are deliberately left unknown.
fn codex_state(value: &Value) -> State {
    if value["requiresOpenaiAuth"] != true { return State::Unknown; }
    match value.get("account") {
        Some(Value::Null) => State::SignedOut,
        Some(account) if matches!(account["type"].as_str(), Some("chatgpt" | "apiKey" | "chatgptAuthTokens")) => State::Ready,
        _ => State::Unknown,
    }
}

fn claude_state(value: &Value) -> State {
    match value["loggedIn"].as_bool() {
        Some(true) => State::Ready,
        Some(false) => State::SignedOut,
        None => State::Unknown,
    }
}

/// Only allowlisted display metadata reaches the webview, never the account
/// document (which may gain credential fields in a future CLI release).
fn account_details(agent: &str, value: &Value) -> (Option<String>, Option<String>) {
    let (method, plan) = if agent == "claude" && claude_state(value) == State::Ready {
        (value["authMethod"].as_str(), value["subscriptionType"].as_str())
    } else if agent == "codex" && codex_state(value) == State::Ready {
        (value["account"]["type"].as_str(), value["account"]["planType"].as_str())
    } else { return (None, None); };
    let method = match method {
        Some("claude.ai" | "oauth") => Some("Claude account"),
        Some("chatgpt" | "chatgptAuthTokens") => Some("ChatGPT account"),
        Some("api_key" | "apiKey" | "console") => Some("API key"),
        _ => None,
    }.map(str::to_owned);
    let plan = plan.filter(|plan| matches!(*plan, "free" | "pro" | "max" | "team" | "enterprise" | "plus" | "business" | "edu" | "go" | "api"))
        .map(str::to_owned);
    (method, plan)
}

/// `home::prepare` links the user's auth file when one exists, and otherwise
/// preserves a login completed in the managed terminal. Inspect that same
/// effective account without creating a home or reading credential contents.
fn codex_home_for_check(user: Option<PathBuf>, managed: Option<PathBuf>) -> Option<PathBuf> {
    if !user.as_ref().is_some_and(|home| home.join("auth.json").exists())
        && managed.as_ref().is_some_and(|home| home.join("auth.json").exists()) {
        managed
    } else { user }
}

pub fn check(id: &str) -> Readiness {
    match super::offered().into_iter().find(|h| h.id == id) {
        Some(agent) => check_binary(id, agent.path),
        None => Readiness { state: State::Unknown, checked_at: chrono::Utc::now().to_rfc3339(), version: None, login_method: None, plan: None },
    }
}

/// The checks for agent `id` with its CLI at `path` (`None`: not installed).
///
/// One check at a time. Every view of an agent checks again when a terminal
/// exits, so an install's exit starts several at once; and two Codex app
/// servers starting together in a new `CODEX_HOME` (the first run after an
/// install) race to create its state database, and the loser exits with
/// "failed to initialize sqlite state runtime" (Codex 0.167.0, PRO-152): a
/// fresh install would read as "login not checked" and its sign-in would
/// not follow.
pub fn check_binary(id: &str, path: Option<String>) -> Readiness {
    static ONE_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let mut result = Readiness { state: State::Unknown, checked_at: String::new(), version: None, login_method: None, plan: None };
    if let Some(path) = path {
        let mut version = std::process::Command::new(&path);
        version.arg("--version").env("PATH", crate::binpath::login_path()).env("NO_COLOR", "1");
        if let Ok(text) = crate::git::output_within(version, Duration::from_secs(3)) {
            // Only retain the version token, never arbitrary command output.
            result.version = text.split_whitespace().find(|s| s.starts_with(|c: char| c.is_ascii_digit()) && s.len() <= 40 && s.chars().all(|c| c.is_ascii_alphanumeric() || ".-_+".contains(c))).map(str::to_owned);
        }
        result.state = match id {
            "codex" => {
                let home = codex_home_for_check(super::codex::home::user_root(), crate::store::root().ok().map(|root| root.join("codex")));
                super::codex::appserver::ask_with_timeout(
                    super::codex::appserver::Where { codex_home: home.as_deref(), cwd: None },
                    "account/read", json!({ "refreshToken": false }), Duration::from_secs(5),
                ).map(|value| { (result.login_method, result.plan) = account_details("codex", &value); codex_state(&value) }).unwrap_or(State::Unknown)
            }
            "claude" => {
                let mut command = std::process::Command::new(path);
                command.args(["auth", "status", "--json"]).env("PATH", crate::binpath::login_path()).env("NO_COLOR", "1");
                crate::git::capture_within(command, Duration::from_secs(5)).ok()
                    .and_then(|output| serde_json::from_slice::<Value>(&output.stdout).ok())
                    .map(|value| { (result.login_method, result.plan) = account_details("claude", &value); claude_state(&value) }).unwrap_or(State::Unknown)
            }
            _ => State::Unknown,
        };
    } else { result.state = State::Missing; }
    result.checked_at = chrono::Utc::now().to_rfc3339();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn account_details_only_keep_display_fields_of_a_known_login() {
        assert_eq!(account_details("claude", &json!({"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max","accessToken":"secret"})), (Some("Claude account".into()), Some("max".into())));
        assert_eq!(account_details("codex", &json!({"requiresOpenaiAuth":true,"account":{"type":"chatgpt","planType":"plus","accessToken":"secret"}})), (Some("ChatGPT account".into()), Some("plus".into())));
        assert_eq!(account_details("claude", &json!({"loggedIn":false,"authMethod":"claude.ai","subscriptionType":"max"})), (None, None));
        assert_eq!(account_details("codex", &json!({"requiresOpenaiAuth":false,"account":{"type":"chatgpt","planType":"plus"}})), (None, None));
    }

    #[test]
    fn a_login_completed_in_the_managed_terminal_is_not_reported_signed_out() {
        let user = tempfile::tempdir().unwrap();
        let managed = tempfile::tempdir().unwrap();
        let choose = || codex_home_for_check(Some(user.path().into()), Some(managed.path().into())).unwrap();
        assert_eq!(choose(), user.path());
        std::fs::write(managed.path().join("auth.json"), "{}").unwrap();
        assert_eq!(choose(), managed.path());
        std::fs::write(user.path().join("auth.json"), "{}").unwrap();
        assert_eq!(choose(), user.path(), "the user's login takes precedence on the next launch");
    }

    #[cfg(unix)]
    #[test]
    fn checks_made_at_once_do_not_race_a_new_codex_home() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        // A stand-in that fails as Codex does when another app server is
        // creating the same new home at that moment.
        let fake = dir.path().join("codex");
        std::fs::write(&fake, format!(r#"#!/bin/sh
case "$1" in
  --version) echo "codex-cli 0.167.0" ;;
  app-server)
    mkdir "{lock}" 2>/dev/null || {{ echo "failed to initialize sqlite state runtime" >&2; exit 1; }}
    sleep 0.3
    rmdir "{lock}"
    echo '{{"id":2,"result":{{"account":null,"requiresOpenaiAuth":true}}}}'
    cat >/dev/null ;;
esac
"#, lock = dir.path().join("creating").display())).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let _codex = super::super::codex::pty::codex_program_for_tests(fake.clone());
        let path = fake.to_string_lossy().into_owned();
        let states: Vec<State> = std::thread::scope(|scope| {
            let checks: Vec<_> = (0..3).map(|_| scope.spawn(|| check_binary("codex", Some(path.clone())).state)).collect();
            checks.into_iter().map(|check| check.join().unwrap()).collect()
        });
        assert_eq!(states, [State::SignedOut; 3]);
    }

    #[test]
    fn local_account_evidence_is_distinct_from_unknown_and_custom_routes() {
        assert_eq!(codex_state(&json!({"account": null, "requiresOpenaiAuth": true})), State::SignedOut);
        for kind in ["chatgpt", "apiKey", "chatgptAuthTokens"] {
            assert_eq!(codex_state(&json!({"account": {"type": kind}, "requiresOpenaiAuth": true})), State::Ready);
        }
        for value in [json!({}), json!({"account": null}), json!({"account": null, "requiresOpenaiAuth": false}), json!({"account": {}, "requiresOpenaiAuth": true})] {
            assert_eq!(codex_state(&value), State::Unknown);
        }
        assert_eq!(claude_state(&json!({"loggedIn": true})), State::Ready);
        assert_eq!(claude_state(&json!({"loggedIn": false})), State::SignedOut);
        assert_eq!(claude_state(&json!({"error": "unavailable"})), State::Unknown);
    }
}
