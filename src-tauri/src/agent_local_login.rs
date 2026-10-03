//! "Use this Mac's login" (PRO-79): read the Claude Code or Codex login that
//! is already on this computer, so an owner or admin can register it for
//! their organization's cloud workspaces without pasting a file.
//!
//! Rules this module keeps:
//!
//! - It is read only when the person asked for exactly that, after the
//!   consent the command checks. Nothing here runs on its own.
//! - The login never reaches the webview and is never logged. It lives in a
//!   `Zeroizing<String>` from the read to the one request that uploads it,
//!   and an error says only which kind of failure it was.
//! - Only the part the service stores is kept: for Claude the
//!   `claudeAiOauth` object, for Codex its mode, tokens and key. Anything
//!   else in the file (settings, other accounts' data) is dropped here.
//!
//! Where each login lives is the CLI's own choice: Claude Code keeps it in
//! the macOS Keychain item `Claude Code-credentials` (or
//! `<config dir>/.credentials.json`), Codex in `$CODEX_HOME/auth.json`.
//! Reading the Keychain item makes macOS ask the person to allow it.

use std::path::PathBuf;

use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

/// The largest login the service accepts.
const MAX_LOGIN_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalLoginError {
    /// No login for that agent on this computer.
    NotFound,
    /// Something is there but it is not a login the service can use.
    Invalid,
    /// The Keychain did not hand it over (denied, or no answer in time).
    Denied,
}

impl LocalLoginError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFound => "cloud_agent_local_login_not_found",
            Self::Invalid => "cloud_agent_local_login_invalid",
            Self::Denied => "cloud_agent_local_login_denied",
        }
    }
}

fn object(raw: &str) -> Result<Map<String, Value>, LocalLoginError> {
    if raw.len() > MAX_LOGIN_BYTES {
        return Err(LocalLoginError::Invalid);
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(LocalLoginError::Invalid),
    }
}

fn nonempty(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| !text.trim().is_empty())
}

/// The part of a Claude Code credentials document the service stores.
pub fn claude_from_raw(raw: &str) -> Result<Zeroizing<String>, LocalLoginError> {
    let parsed = object(raw)?;
    let oauth = parsed.get("claudeAiOauth").and_then(Value::as_object).ok_or(LocalLoginError::Invalid)?;
    if !nonempty(oauth.get("accessToken")) {
        return Err(LocalLoginError::Invalid);
    }
    Ok(Zeroizing::new(json!({ "claudeAiOauth": oauth }).to_string()))
}

/// The part of a Codex `auth.json` the service stores: a ChatGPT sign-in's
/// tokens, or an API key kept there.
pub fn codex_from_raw(raw: &str) -> Result<Zeroizing<String>, LocalLoginError> {
    let parsed = object(raw)?;
    let tokens = parsed.get("tokens").filter(|value| value.is_object());
    let api_key = parsed.get("OPENAI_API_KEY").filter(|value| nonempty(Some(value)));
    if tokens.is_none() && api_key.is_none() {
        return Err(LocalLoginError::Invalid);
    }
    let mut kept = Map::new();
    for key in ["auth_mode", "last_refresh"] {
        if let Some(value) = parsed.get(key).filter(|value| value.is_string()) {
            kept.insert(key.into(), value.clone());
        }
    }
    if let Some(value) = api_key {
        kept.insert("OPENAI_API_KEY".into(), value.clone());
    }
    if let Some(value) = tokens {
        kept.insert("tokens".into(), value.clone());
    }
    Ok(Zeroizing::new(Value::Object(kept).to_string()))
}

fn read_file(path: PathBuf) -> Result<Zeroizing<String>, LocalLoginError> {
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(Zeroizing::new(raw)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Err(LocalLoginError::NotFound),
        Err(_) => Err(LocalLoginError::Denied),
    }
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from)
}

/// Claude Code's Keychain item. macOS asks the person before `security`
/// may read another program's item, so the wait is long enough to answer.
#[cfg(target_os = "macos")]
fn claude_keychain() -> Result<Zeroizing<String>, LocalLoginError> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let account = std::env::var("USER").map_err(|_| LocalLoginError::NotFound)?;
    let mut child = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-a", &account, "-w"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| LocalLoginError::Denied)?;
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut raw = Zeroizing::new(String::new());
                let read = child.stdout.take().map(|mut out| out.read_to_string(&mut raw));
                // 44: the item does not exist. Anything else: not allowed.
                return match (status.success(), status.code(), read) {
                    (true, _, Some(Ok(_))) => Ok(raw),
                    (false, Some(44), _) => Err(LocalLoginError::NotFound),
                    _ => Err(LocalLoginError::Denied),
                };
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(LocalLoginError::Denied);
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn claude_keychain() -> Result<Zeroizing<String>, LocalLoginError> {
    Err(LocalLoginError::NotFound)
}

/// This computer's Claude Code login.
pub fn claude() -> Result<Zeroizing<String>, LocalLoginError> {
    // A custom config directory never falls back to another account's Keychain item.
    if let Some(dir) = env_dir("CLAUDE_CONFIG_DIR") {
        return claude_from_raw(&read_file(dir.join(".credentials.json"))?);
    }
    match claude_keychain() {
        Ok(raw) => claude_from_raw(&raw),
        Err(LocalLoginError::NotFound) => {
            let home = dirs::home_dir().ok_or(LocalLoginError::NotFound)?;
            claude_from_raw(&read_file(home.join(".claude/.credentials.json"))?)
        }
        Err(error) => Err(error),
    }
}

/// This computer's Codex login.
pub fn codex() -> Result<Zeroizing<String>, LocalLoginError> {
    let dir = env_dir("CODEX_HOME").or_else(|| dirs::home_dir().map(|home| home.join(".codex"))).ok_or(LocalLoginError::NotFound)?;
    codex_from_raw(&read_file(dir.join("auth.json"))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_claude_login_keeps_only_the_oauth_object() {
        let raw = json!({
            "claudeAiOauth": { "accessToken": "at-1", "refreshToken": "rt-1", "expiresAt": 1, "scopes": ["user:inference"] },
            "mcpOAuth": { "some-server": { "accessToken": "other-secret" } },
            "organizationUuid": "not-needed",
        })
        .to_string();
        let kept: Value = serde_json::from_str(&claude_from_raw(&raw).unwrap()).unwrap();
        assert_eq!(kept, json!({ "claudeAiOauth": { "accessToken": "at-1", "refreshToken": "rt-1", "expiresAt": 1, "scopes": ["user:inference"] } }));
        assert!(!kept.to_string().contains("other-secret"));
    }

    #[test]
    fn what_is_not_a_claude_login_is_refused_without_saying_what_it_held() {
        for raw in [
            "",
            "not json",
            "[1]",
            r#"{"claudeAiOauth":"sk-secret"}"#,
            r#"{"claudeAiOauth":{"accessToken":"  "}}"#,
            r#"{"tokens":{"access_token":"sk-secret"}}"#,
        ] {
            assert_eq!(claude_from_raw(raw).unwrap_err(), LocalLoginError::Invalid, "{raw}");
        }
        let huge = format!(r#"{{"claudeAiOauth":{{"accessToken":"{}"}}}}"#, "a".repeat(MAX_LOGIN_BYTES));
        assert_eq!(claude_from_raw(&huge).unwrap_err(), LocalLoginError::Invalid);
        // The error is a kind, never the content.
        assert!(!LocalLoginError::Invalid.code().contains("secret"));
    }

    #[test]
    fn a_codex_login_keeps_its_mode_tokens_and_key_only() {
        let raw = json!({
            "auth_mode": "chatgpt",
            "last_refresh": "2026-10-01T00:00:00Z",
            "tokens": { "id_token": "id-1", "access_token": "at-1", "refresh_token": "rt-1", "account_id": "acct" },
            "OPENAI_API_KEY": null,
            "something_else": "dropped",
        })
        .to_string();
        let kept: Value = serde_json::from_str(&codex_from_raw(&raw).unwrap()).unwrap();
        assert_eq!(
            kept,
            json!({ "auth_mode": "chatgpt", "last_refresh": "2026-10-01T00:00:00Z", "tokens": { "id_token": "id-1", "access_token": "at-1", "refresh_token": "rt-1", "account_id": "acct" } })
        );
        let key_only: Value = serde_json::from_str(&codex_from_raw(r#"{"OPENAI_API_KEY":"sk-1"}"#).unwrap()).unwrap();
        assert_eq!(key_only, json!({ "OPENAI_API_KEY": "sk-1" }));
        for raw in ["{}", r#"{"tokens":"x"}"#, r#"{"OPENAI_API_KEY":" "}"#, r#"{"claudeAiOauth":{"accessToken":"at"}}"#] {
            assert_eq!(codex_from_raw(raw).unwrap_err(), LocalLoginError::Invalid, "{raw}");
        }
    }

    #[test]
    fn a_missing_file_is_not_found_and_an_unreadable_one_is_denied() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_file(dir.path().join("auth.json")).unwrap_err(), LocalLoginError::NotFound);
        // A directory where the file should be cannot be read as one.
        std::fs::create_dir(dir.path().join("auth.json")).unwrap();
        assert_eq!(read_file(dir.path().join("auth.json")).unwrap_err(), LocalLoginError::Denied);
    }
}
