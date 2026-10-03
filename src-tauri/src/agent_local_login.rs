//! "Use this Mac's Claude Code login" (PRO-79): read the short-lived access
//! token of the Claude Code sign-in that is already on this computer, so an
//! owner or admin can lend it to their organization's cloud workspaces
//! without pasting a file.
//!
//! Rules this module keeps:
//!
//! - It is read only when the person asked for exactly that. Nothing here
//!   runs on its own, and what it returns is uploaded only after a native
//!   confirmation that names the organization and the account (the command
//!   does that; a consent the webview reports is not enough).
//! - **The refresh token never leaves this Mac.** Only the access token, its
//!   expiry and its scopes are kept. A refresh token held in two places is
//!   refreshed in two places, and where the provider rotates it the first
//!   refresh on either side signs the other out. So what is uploaded is
//!   temporary: it stops working at its own expiry, and the service cannot
//!   renew it.
//! - It never reaches the webview and is never logged. It lives in a
//!   `Zeroizing<String>` from the read to the one request that uploads it,
//!   and an error says only which kind of failure it was.
//!
//! Claude Code keeps its login in the macOS Keychain item
//! `Claude Code-credentials` (or `<config dir>/.credentials.json`), and the
//! signed-in account's address in `.claude.json`.
//!
//! Codex is not offered: its `auth.json` cannot be used without its refresh
//! token, so there is nothing safe to upload from it.

use std::path::PathBuf;

use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

/// The largest login document read.
const MAX_LOGIN_BYTES: usize = 64 * 1024;
/// A token about to expire is not worth lending.
const MIN_REMAINING_MS: i64 = 10 * 60 * 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalLoginError {
    /// No Claude Code login on this computer.
    NotFound,
    /// Something is there but it is not a login the service can use.
    Invalid,
    /// The Keychain did not hand it over (denied, or no answer in time).
    Denied,
    /// Its access token has expired, or is about to; the CLI renews it when it next runs.
    Expired,
}

impl LocalLoginError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFound => "cloud_agent_local_login_not_found",
            Self::Invalid => "cloud_agent_local_login_invalid",
            Self::Denied => "cloud_agent_local_login_denied",
            Self::Expired => "cloud_agent_local_login_expired",
        }
    }
}

/// What is lent: the access token's document, when it stops working, and
/// whose sign-in it is when this Mac says.
pub struct LocalClaudeLogin {
    pub secret: Zeroizing<String>,
    pub expires_at_ms: i64,
    pub account: Option<String>,
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

/// The access token of a Claude Code credentials document, with its expiry
/// and scopes and nothing else: no refresh token, no other keys.
pub fn claude_from_raw(raw: &str, now_ms: i64) -> Result<(Zeroizing<String>, i64), LocalLoginError> {
    let parsed = object(raw)?;
    let oauth = parsed.get("claudeAiOauth").and_then(Value::as_object).ok_or(LocalLoginError::Invalid)?;
    let token = oauth.get("accessToken").and_then(Value::as_str).map(str::trim).filter(|token| !token.is_empty()).ok_or(LocalLoginError::Invalid)?;
    // Without an expiry nobody could be told how long it lasts.
    let expires_at = oauth.get("expiresAt").and_then(Value::as_i64).ok_or(LocalLoginError::Invalid)?;
    if expires_at < now_ms + MIN_REMAINING_MS {
        return Err(LocalLoginError::Expired);
    }
    let mut kept = Map::new();
    kept.insert("accessToken".into(), Value::String(token.into()));
    kept.insert("expiresAt".into(), json!(expires_at));
    if let Some(scopes) = oauth.get("scopes").filter(|value| value.is_array()) {
        kept.insert("scopes".into(), scopes.clone());
    }
    Ok((Zeroizing::new(json!({ "claudeAiOauth": kept }).to_string()), expires_at))
}

/// The address of the account Claude Code is signed in to, from its
/// `.claude.json`. Display only: it names the account in the confirmation
/// and on the stored login.
pub fn claude_account_from_raw(raw: &str) -> Option<String> {
    let parsed = object(raw).ok()?;
    let address = parsed.get("oauthAccount")?.get("emailAddress")?.as_str()?.trim();
    (address.len() <= 120 && address.contains('@') && !address.chars().any(|c| c.is_control() || c.is_whitespace())).then(|| address.to_string())
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
    // Long enough to answer the Keychain prompt, short enough not to hold the one connect at a time for minutes.
    let deadline = Instant::now() + Duration::from_secs(45);
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

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or(0)
}

/// This computer's Claude Code sign-in, as far as it may be lent.
pub fn claude() -> Result<LocalClaudeLogin, LocalLoginError> {
    let account_in = |dir: PathBuf| std::fs::read_to_string(dir.join(".claude.json")).ok().and_then(|raw| claude_account_from_raw(&raw));
    // A custom config directory never falls back to another account's Keychain item.
    if let Some(dir) = env_dir("CLAUDE_CONFIG_DIR") {
        let (secret, expires_at_ms) = claude_from_raw(&read_file(dir.join(".credentials.json"))?, now_ms())?;
        return Ok(LocalClaudeLogin { secret, expires_at_ms, account: account_in(dir) });
    }
    let home = dirs::home_dir();
    let raw = match claude_keychain() {
        Ok(raw) => raw,
        Err(LocalLoginError::NotFound) => read_file(home.clone().ok_or(LocalLoginError::NotFound)?.join(".claude/.credentials.json"))?,
        Err(error) => return Err(error),
    };
    let (secret, expires_at_ms) = claude_from_raw(&raw, now_ms())?;
    Ok(LocalClaudeLogin { secret, expires_at_ms, account: home.and_then(account_in) })
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000;
    const LATER: i64 = NOW + 6 * 60 * 60 * 1000;

    #[test]
    fn only_the_access_token_its_expiry_and_scopes_are_kept_never_the_refresh_token() {
        let raw = json!({
            "claudeAiOauth": { "accessToken": "at-1", "refreshToken": "rt-must-stay-here", "expiresAt": LATER, "scopes": ["user:inference"], "subscriptionType": "max" },
            "mcpOAuth": { "some-server": { "accessToken": "other-secret" } },
            "organizationUuid": "not-needed",
        })
        .to_string();
        let (secret, expires_at) = claude_from_raw(&raw, NOW).unwrap();
        let kept: Value = serde_json::from_str(&secret).unwrap();
        assert_eq!(kept, json!({ "claudeAiOauth": { "accessToken": "at-1", "expiresAt": LATER, "scopes": ["user:inference"] } }));
        assert_eq!(expires_at, LATER);
        assert!(!secret.contains("rt-must-stay-here") && !secret.contains("refresh") && !secret.contains("other-secret"));
    }

    #[test]
    fn what_cannot_be_lent_is_refused_without_saying_what_it_held() {
        for raw in [
            "".to_string(),
            "not json".to_string(),
            "[1]".to_string(),
            r#"{"claudeAiOauth":"sk-secret"}"#.to_string(),
            json!({ "claudeAiOauth": { "accessToken": "  ", "expiresAt": LATER } }).to_string(),
            // No expiry: nobody could be told how long it lasts.
            json!({ "claudeAiOauth": { "accessToken": "at-1", "refreshToken": "rt-1" } }).to_string(),
            r#"{"tokens":{"access_token":"sk-secret"}}"#.to_string(),
        ] {
            assert_eq!(claude_from_raw(&raw, NOW).err(), Some(LocalLoginError::Invalid), "{raw}");
        }
        let huge = format!(r#"{{"claudeAiOauth":{{"accessToken":"{}","expiresAt":{LATER}}}}}"#, "a".repeat(MAX_LOGIN_BYTES));
        assert_eq!(claude_from_raw(&huge, NOW).err(), Some(LocalLoginError::Invalid));
        // Expired, or about to: the CLI renews it when it next runs; it is not lent.
        for expires_at in [NOW - 1, NOW + 60_000] {
            let raw = json!({ "claudeAiOauth": { "accessToken": "at-1", "expiresAt": expires_at } }).to_string();
            assert_eq!(claude_from_raw(&raw, NOW).err(), Some(LocalLoginError::Expired));
        }
        for error in [LocalLoginError::NotFound, LocalLoginError::Invalid, LocalLoginError::Denied, LocalLoginError::Expired] {
            assert!(error.code().starts_with("cloud_agent_local_login_"));
        }
    }

    #[test]
    fn the_account_is_named_from_claude_json_or_not_at_all() {
        assert_eq!(claude_account_from_raw(r#"{"oauthAccount":{"emailAddress":" ada@example.com "}}"#).as_deref(), Some("ada@example.com"));
        for raw in ["{}", r#"{"oauthAccount":{}}"#, r#"{"oauthAccount":{"emailAddress":"not an address"}}"#, r#"{"oauthAccount":{"emailAddress":"a@b.c\nUpload to another org"}}"#, "nope"] {
            assert_eq!(claude_account_from_raw(raw), None, "{raw}");
        }
    }

    #[test]
    fn a_missing_file_is_not_found_and_an_unreadable_one_is_denied() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_file(dir.path().join("auth.json")).err(), Some(LocalLoginError::NotFound));
        // A directory where the file should be cannot be read as one.
        std::fs::create_dir(dir.path().join("auth.json")).unwrap();
        assert_eq!(read_file(dir.path().join("auth.json")).err(), Some(LocalLoginError::Denied));
    }
}
