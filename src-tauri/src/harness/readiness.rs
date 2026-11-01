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
    let mut result = Readiness { state: State::Unknown, checked_at: String::new(), version: None };
    if let Some(agent) = super::offered().into_iter().find(|h| h.id == id) {
        if let Some(path) = agent.path {
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
                    ).map(|value| codex_state(&value)).unwrap_or(State::Unknown)
                }
                "claude" => {
                    let mut command = std::process::Command::new(path);
                    command.args(["auth", "status", "--json"]).env("PATH", crate::binpath::login_path()).env("NO_COLOR", "1");
                    crate::git::capture_within(command, Duration::from_secs(5)).ok()
                        .and_then(|output| serde_json::from_slice::<Value>(&output.stdout).ok())
                        .map(|value| claude_state(&value)).unwrap_or(State::Unknown)
                }
                _ => State::Unknown,
            };
        } else { result.state = State::Missing; }
    }
    result.checked_at = chrono::Utc::now().to_rfc3339();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

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
