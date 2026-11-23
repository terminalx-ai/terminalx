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
//! Codex keeps a ChatGPT sign-in in `$CODEX_HOME/auth.json` (default
//! `~/.codex`): `tokens.{id_token, access_token, refresh_token, account_id}`.
//! What is lent from it is the access token, the ID token (the account and
//! plan Codex shows; it signs nothing in) and the account id, with no refresh
//! token. A workspace's runtime writes them into Codex's own `auth.json` with
//! an empty refresh token, so Codex runs on the lent access token until its
//! expiry (the token's `exp`) and never tries to renew it. A login Codex
//! keeps in the Keychain (`cli_auth_credentials_store = "keyring"`) is not
//! read: it reads as not found.

use std::path::{Path, PathBuf};

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
pub struct LocalLogin {
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

/// What a JWT says about itself, unverified: display and expiry only.
pub(crate) fn jwt_claims(token: &str) -> Option<Map<String, Value>> {
    use base64::Engine;
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    match serde_json::from_slice::<Value>(&bytes).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// An address fit to name an account in a dialog and on the stored login.
fn display_address(raw: &str) -> Option<String> {
    let address = raw.trim();
    (address.len() <= 120 && address.contains('@') && !address.chars().any(|c| c.is_control() || c.is_whitespace())).then(|| address.to_string())
}

/// The ChatGPT account a Codex ID token names, for display.
pub(crate) fn codex_account(id_token: &str) -> Option<String> {
    display_address(jwt_claims(id_token)?.get("email")?.as_str()?)
}

fn non_empty<'a>(map: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty())
}

/// What may be lent from a Codex `auth.json`: the access token, the ID token
/// and the account id, never the refresh token. Only a ChatGPT sign-in; an
/// API key kept there is not a sign-in and is connected as an API key.
pub fn codex_from_raw(raw: &str, now_ms: i64) -> Result<(Zeroizing<String>, i64, Option<String>), LocalLoginError> {
    let parsed = object(raw)?;
    let tokens = parsed.get("tokens").and_then(Value::as_object).ok_or(LocalLoginError::Invalid)?;
    let access_token = non_empty(tokens, "access_token").ok_or(LocalLoginError::Invalid)?;
    let id_token = non_empty(tokens, "id_token").ok_or(LocalLoginError::Invalid)?;
    // Without an expiry nobody could be told how long it lasts.
    let expires_at = jwt_claims(access_token).and_then(|claims| claims.get("exp").and_then(Value::as_i64)).ok_or(LocalLoginError::Invalid)? * 1000;
    if expires_at < now_ms + MIN_REMAINING_MS {
        return Err(LocalLoginError::Expired);
    }
    let mut kept = Map::new();
    kept.insert("id_token".into(), Value::String(id_token.into()));
    kept.insert("access_token".into(), Value::String(access_token.into()));
    if let Some(account_id) = non_empty(tokens, "account_id") {
        kept.insert("account_id".into(), Value::String(account_id.into()));
    }
    let secret = json!({ "auth_mode": "chatgpt", "tokens": kept });
    Ok((Zeroizing::new(secret.to_string()), expires_at, codex_account(id_token)))
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

/// Whether a sign-in read a while ago still has enough time left to lend.
pub fn still_worth_lending(expires_at_ms: i64) -> bool {
    expires_at_ms >= now_ms() + MIN_REMAINING_MS
}

/// The address of the account Claude Code is signed in to, from its
/// `.claude.json`. Display only: it names the account in the confirmation
/// and on the stored login.
pub fn claude_account_from_raw(raw: &str) -> Option<String> {
    let parsed = object(raw).ok()?;
    display_address(parsed.get("oauthAccount")?.get("emailAddress")?.as_str()?)
}

/// A login document, read only up to just over the largest one used: a
/// larger file is refused as invalid without being read whole.
fn read_file(path: PathBuf) -> Result<Zeroizing<String>, LocalLoginError> {
    use std::io::Read;
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Err(LocalLoginError::NotFound),
        Err(_) => return Err(LocalLoginError::Denied),
    };
    let mut raw = Zeroizing::new(String::new());
    file.take(MAX_LOGIN_BYTES as u64 + 1).read_to_string(&mut raw).map_err(|_| LocalLoginError::Denied)?;
    if raw.len() > MAX_LOGIN_BYTES {
        return Err(LocalLoginError::Invalid);
    }
    Ok(raw)
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from)
}

/// Claude Code's Keychain item. macOS asks the person before `security`
/// may read another program's item, so the wait is long enough to answer.
#[cfg(target_os = "macos")]
fn claude_keychain(service: &str) -> Result<Zeroizing<String>, LocalLoginError> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let account = std::env::var("USER").map_err(|_| LocalLoginError::NotFound)?;
    let mut child = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service, "-a", &account, "-w"])
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
fn claude_keychain(_service: &str) -> Result<Zeroizing<String>, LocalLoginError> {
    Err(LocalLoginError::NotFound)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or(0)
}

/// The Keychain item Claude Code keeps this Mac's own login in.
const CLAUDE_SERVICE: &str = "Claude Code-credentials";

/// This computer's Claude Code sign-in, as far as it may be lent.
pub fn claude() -> Result<LocalLogin, LocalLoginError> {
    // A custom config directory never falls back to another account's Keychain item.
    if let Some(dir) = env_dir("CLAUDE_CONFIG_DIR") {
        return claude_in(&dir);
    }
    let home = dirs::home_dir();
    let raw = match claude_keychain(CLAUDE_SERVICE) {
        Ok(raw) => raw,
        Err(LocalLoginError::NotFound) => read_file(home.clone().ok_or(LocalLoginError::NotFound)?.join(".claude/.credentials.json"))?,
        Err(error) => return Err(error),
    };
    let (secret, expires_at_ms) = claude_from_raw(&raw, now_ms())?;
    Ok(LocalLogin { secret, expires_at_ms, account: home.and_then(|home| claude_account_in(&home)) })
}

fn claude_account_in(dir: &Path) -> Option<String> {
    std::fs::read_to_string(dir.join(".claude.json")).ok().and_then(|raw| claude_account_from_raw(&raw))
}

/// The Claude Code sign-in of configuration directory `dir` (an agent
/// account's, #980, or the app's own `$CLAUDE_CONFIG_DIR`), as far as it may
/// be lent. Claude Code keeps a directory's login in a Keychain item of its
/// own ([`crate::agent_accounts::claude_dir::keychain_service`]), or in
/// `<dir>/.credentials.json`; never the person's unsuffixed item.
pub fn claude_in(dir: &Path) -> Result<LocalLogin, LocalLoginError> {
    let from_item = match crate::agent_accounts::claude_dir::keychain_service(dir) {
        Some(service) => claude_keychain(&service),
        None => Err(LocalLoginError::NotFound),
    };
    let raw = match from_item {
        Ok(raw) => raw,
        Err(LocalLoginError::NotFound) => read_file(dir.join(".credentials.json"))?,
        Err(error) => return Err(error),
    };
    let (secret, expires_at_ms) = claude_from_raw(&raw, now_ms())?;
    Ok(LocalLogin { secret, expires_at_ms, account: claude_account_in(dir) })
}

/// The Codex sign-in of `CODEX_HOME` `home` (an agent account's, #980), as
/// far as it may be lent.
pub fn codex_in(home: &Path) -> Result<LocalLogin, LocalLoginError> {
    let (secret, expires_at_ms, account) = codex_from_raw(&read_file(home.join("auth.json"))?, now_ms())?;
    Ok(LocalLogin { secret, expires_at_ms, account })
}

pub use crate::agent_accounts::Identity;

/// A short display string: one line, no control characters.
fn display_text(raw: &str, max: usize) -> Option<String> {
    let text = raw.trim();
    (!text.is_empty() && text.chars().count() <= max && !text.chars().any(char::is_control)).then(|| text.to_string())
}

/// An id: letters, digits, dashes and underscores.
fn plain_id(raw: &str) -> Option<String> {
    let id = raw.trim();
    (!id.is_empty() && id.len() <= 80 && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')).then(|| id.to_string())
}

/// A plan as the agents name them, capitalised for a label.
fn plan_name(raw: &str) -> Option<String> {
    let plan = raw.trim().to_ascii_lowercase();
    let plan = plan.strip_prefix("claude_").unwrap_or(&plan);
    let known = ["free", "pro", "max", "team", "enterprise", "plus", "business", "edu", "go"];
    known.contains(&plan).then(|| {
        let mut chars = plan.chars();
        chars.next().map(|first| first.to_ascii_uppercase().to_string() + chars.as_str()).unwrap_or_default()
    })
}

/// Who Claude Code is signed in as in a `.claude.json`: its `oauthAccount`.
pub fn claude_identity_from_raw(raw: &str) -> Identity {
    let Ok(parsed) = object(raw) else { return Identity::default() };
    let Some(account) = parsed.get("oauthAccount").and_then(Value::as_object) else { return Identity::default() };
    let text = |key: &str| account.get(key).and_then(Value::as_str);
    Identity {
        email: text("emailAddress").and_then(display_address),
        plan: text("organizationType").and_then(plan_name).or_else(|| text("planDisplayName").and_then(|plan| display_text(plan, 30))),
        organization: text("organizationName").and_then(|name| display_text(name, 120)),
        organization_id: text("organizationUuid").and_then(plain_id),
    }
}

/// Who a Codex `auth.json` is signed in as: its ID token's claims.
pub fn codex_identity_from_raw(raw: &str) -> Identity {
    let Ok(parsed) = object(raw) else { return Identity::default() };
    let Some(id_token) = parsed.get("tokens").and_then(Value::as_object).and_then(|tokens| non_empty(tokens, "id_token")) else { return Identity::default() };
    let Some(claims) = jwt_claims(id_token) else { return Identity::default() };
    let auth = claims.get("https://api.openai.com/auth").and_then(Value::as_object);
    let text = |key: &str| auth.and_then(|auth| auth.get(key)).and_then(Value::as_str);
    Identity {
        email: claims.get("email").and_then(Value::as_str).and_then(display_address),
        plan: text("chatgpt_plan_type").and_then(plan_name),
        organization: None,
        organization_id: text("chatgpt_account_id").and_then(plain_id),
    }
}

/// Who the configuration directory `dir` of `agent` ("claude" or "codex")
/// is signed in as: Claude Code's `<dir>/.claude.json`, Codex's
/// `<dir>/auth.json`. Read only; a file that is missing or not a login is
/// nobody.
pub fn identity_in(agent: &str, dir: &Path) -> Identity {
    match agent {
        "claude" => read_file(dir.join(".claude.json")).map(|raw| claude_identity_from_raw(&raw)).unwrap_or_default(),
        "codex" => read_file(dir.join("auth.json")).map(|raw| codex_identity_from_raw(&raw)).unwrap_or_default(),
        _ => Identity::default(),
    }
}

/// Who This Mac's own login (`local`) is, for telling an added account
/// apart from it: `~/.claude.json` (or `$CLAUDE_CONFIG_DIR/.claude.json`),
/// and `$CODEX_HOME` or `~/.codex`. Read only.
pub fn local_identity(agent: &str) -> Identity {
    match agent {
        "claude" => match env_dir("CLAUDE_CONFIG_DIR") {
            Some(dir) => identity_in("claude", &dir),
            None => dirs::home_dir().map(|home| identity_in("claude", &home)).unwrap_or_default(),
        },
        "codex" => crate::harness::codex::home::user_root().map(|home| identity_in("codex", &home)).unwrap_or_default(),
        _ => Identity::default(),
    }
}

/// This computer's Codex sign-in, as far as it may be lent. A custom
/// `CODEX_HOME` is where Codex itself would look, so it is read instead.
pub fn codex() -> Result<LocalLogin, LocalLoginError> {
    let home = env_dir("CODEX_HOME").or_else(|| dirs::home_dir().map(|home| home.join(".codex"))).ok_or(LocalLoginError::NotFound)?;
    let (secret, expires_at_ms, account) = codex_from_raw(&read_file(home.join("auth.json"))?, now_ms())?;
    Ok(LocalLogin { secret, expires_at_ms, account })
}

#[cfg(test)]
pub(crate) mod tests {
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
        // A huge file is refused as invalid, and not read whole.
        std::fs::write(dir.path().join("huge.json"), vec![b' '; 8 * 1024 * 1024]).unwrap();
        assert_eq!(read_file(dir.path().join("huge.json")).err(), Some(LocalLoginError::Invalid));
    }

    pub(crate) fn jwt(claims: Value) -> String {
        use base64::Engine;
        let part = |value: &Value| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(value.to_string());
        format!("{}.{}.sig", part(&json!({ "alg": "none" })), part(&claims))
    }

    #[test]
    fn a_codex_sign_in_is_lent_without_its_refresh_token() {
        let access = jwt(json!({ "exp": LATER / 1000 }));
        let id = jwt(json!({ "email": "ada@example.com", "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" } }));
        let raw = json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": { "id_token": id, "access_token": access, "refresh_token": "rt-must-stay-here", "account_id": "acct_1" },
            "last_refresh": "2026-10-01T00:00:00Z",
        })
        .to_string();
        let (secret, expires_at, account) = codex_from_raw(&raw, NOW).unwrap();
        let kept: Value = serde_json::from_str(&secret).unwrap();
        assert_eq!(kept, json!({ "auth_mode": "chatgpt", "tokens": { "id_token": id, "access_token": access, "account_id": "acct_1" } }));
        assert_eq!(expires_at, LATER / 1000 * 1000);
        assert_eq!(account.as_deref(), Some("ada@example.com"));
        assert!(!secret.contains("rt-must-stay-here") && !secret.contains("refresh"));
    }

    #[test]
    fn whose_sign_in_a_directory_holds_is_read_as_display_strings_only() {
        let raw = json!({ "oauthAccount": {
            "emailAddress": "ada@example.com", "organizationType": "claude_max", "planDisplayName": "Max",
            "organizationName": "Acme", "organizationUuid": "8d3c1a2e-0000-4000-8000-000000000001", "accountUuid": "not-kept",
        }, "mcpServers": {} }).to_string();
        let identity = claude_identity_from_raw(&raw);
        assert_eq!(identity, Identity { email: Some("ada@example.com".into()), plan: Some("Max".into()), organization: Some("Acme".into()), organization_id: Some("8d3c1a2e-0000-4000-8000-000000000001".into()) });
        for raw in ["{}", "not json", r#"{"oauthAccount":{"emailAddress":"two words@x"}}"#] {
            assert!(!claude_identity_from_raw(raw).signed_in(), "{raw}");
        }
        let id_token = jwt(json!({ "email": "ada@example.com", "https://api.openai.com/auth": { "chatgpt_plan_type": "plus", "chatgpt_account_id": "acct_1" } }));
        let raw = json!({ "auth_mode": "chatgpt", "tokens": { "id_token": id_token, "access_token": "at-secret", "refresh_token": "rt-secret" } }).to_string();
        let identity = codex_identity_from_raw(&raw);
        assert_eq!(identity, Identity { email: Some("ada@example.com".into()), plan: Some("Plus".into()), organization: None, organization_id: Some("acct_1".into()) });
        assert!(!format!("{identity:?}").contains("secret"));

        let dir = tempfile::tempdir().unwrap();
        assert!(!identity_in("codex", dir.path()).signed_in());
        std::fs::write(dir.path().join("auth.json"), &raw).unwrap();
        assert_eq!(identity_in("codex", dir.path()).email.as_deref(), Some("ada@example.com"));
        assert!(!identity_in("claude", dir.path()).signed_in());
    }

    #[test]
    fn an_account_directory_lends_its_own_file_login() {
        let dir = tempfile::tempdir().unwrap();
        // A scratch directory: no Keychain item is named for it, so the file is read.
        assert_eq!(claude_in(dir.path()).err(), Some(LocalLoginError::NotFound));
        let later = now_ms() + 6 * 60 * 60 * 1000;
        std::fs::write(dir.path().join(".credentials.json"), json!({ "claudeAiOauth": { "accessToken": "at-1", "refreshToken": "rt-stays", "expiresAt": later } }).to_string()).unwrap();
        std::fs::write(dir.path().join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"bo@example.com"}}"#).unwrap();
        let lent = claude_in(dir.path()).unwrap();
        assert_eq!(lent.account.as_deref(), Some("bo@example.com"));
        assert!(!lent.secret.contains("rt-stays"));
        let codex = tempfile::tempdir().unwrap();
        assert_eq!(codex_in(codex.path()).err(), Some(LocalLoginError::NotFound));
    }

    #[test]
    fn a_codex_file_that_cannot_be_lent_is_refused() {
        let access = jwt(json!({ "exp": LATER / 1000 }));
        let id = jwt(json!({ "email": "ada@example.com" }));
        for raw in [
            // An API key is not a sign-in.
            json!({ "auth_mode": "apikey", "OPENAI_API_KEY": "sk-secret" }).to_string(),
            json!({ "tokens": { "access_token": access, "refresh_token": "rt" } }).to_string(),
            json!({ "tokens": { "id_token": id, "refresh_token": "rt" } }).to_string(),
            // No readable expiry: nobody could be told how long it lasts.
            json!({ "tokens": { "id_token": id, "access_token": "opaque", "refresh_token": "rt" } }).to_string(),
            "nope".to_string(),
        ] {
            assert_eq!(codex_from_raw(&raw, NOW).err(), Some(LocalLoginError::Invalid), "{raw}");
        }
        let soon = jwt(json!({ "exp": (NOW + 60_000) / 1000 }));
        let raw = json!({ "tokens": { "id_token": id, "access_token": soon } }).to_string();
        assert_eq!(codex_from_raw(&raw, NOW).err(), Some(LocalLoginError::Expired));
        // An ID token without a usable address names no account, and lends all the same.
        let raw = json!({ "tokens": { "id_token": jwt(json!({ "email": "a@b.c\nUpload elsewhere" })), "access_token": access } }).to_string();
        assert_eq!(codex_from_raw(&raw, NOW).unwrap().2, None);
    }
}
