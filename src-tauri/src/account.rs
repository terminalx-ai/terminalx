//! Optional TerminalX account authentication.
//!
//! OAuth state and every credential stay in the native process. The webview
//! receives only the identity it needs to draw the account surfaces.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Context, Result};
use base64::Engine;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use thiserror::Error;
use url::Url;
use uuid::Uuid;

pub const STATUS_EVENT: &str = "account_status";

const API_BASE_URL: &str = "https://login.terminalx.ai";
const AUTHORIZE_PATH: &str = "/v1/desktop/auth/authorize";
const SESSION_PATH: &str = "/v1/desktop/auth/session";
const REFRESH_PATH: &str = "/v1/desktop/auth/refresh";
const LOGOUT_PATH: &str = "/v1/desktop/auth/logout";
const CLIENT_ID: &str = "terminalx-desktop";
const SCOPE: &str = "openid profile email offline_access";
const REDIRECT_URI: &str = "terminalx://auth/callback";
const LOCAL_PROFILE_ID: &str = "local-default";
const KEYCHAIN_ACCOUNT: &str = "desktop-session";
const AUTH_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const REFRESH_SKEW_MS: i64 = 60_000;
const KEYCHAIN_NOT_FOUND: i32 = -25_300;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    state: AccountPhase,
    identity: Option<AccountIdentity>,
    expires_at: Option<i64>,
    last_error: Option<String>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum AccountPhase {
    SignedOut,
    SigningIn,
    SignedIn,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    name: Option<String>,
    email: String,
    organization: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSession {
    access_token: String,
    refresh_token: String,
    expires_at: i64,
    cloud: CloudIdentity,
    #[serde(default)]
    organizations: Vec<Organization>,
    capabilities: Capabilities,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudIdentity {
    cloud_profile_id: String,
    user_id: String,
    email: String,
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    active_org_id: Option<String>,
    #[serde(default)]
    active_org_name: Option<String>,
    linked_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Organization {
    org_id: String,
    name: String,
    role: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities {
    #[serde(default)]
    flags: BTreeMap<String, bool>,
    refreshed_at: i64,
}

struct PendingAuth {
    generation: u64,
    code_verifier: String,
    nonce: String,
    state: String,
    started_at: Instant,
}

#[derive(Default)]
struct Inner {
    loaded: bool,
    session: Option<DesktopSession>,
    pending: Option<PendingAuth>,
    signing_in: bool,
    generation: u64,
    last_error: Option<String>,
}

#[derive(Default)]
pub struct AccountManager {
    service: OnceLock<String>,
    inner: Mutex<Inner>,
    refresh_gate: Mutex<()>,
}

enum CallbackAction {
    Ignore,
    Failed,
    Exchange { pending: PendingAuth, code: String },
}

#[derive(Debug, Error)]
enum CloudError {
    #[error("account service returned HTTP {0}")]
    Http(u16),
    #[error("account service request failed")]
    Transport,
    #[error("account service returned an invalid session")]
    InvalidSession,
}

impl AccountManager {
    pub fn configure(&self, app_identifier: &str) -> Result<()> {
        let wanted = format!("{app_identifier}.account");
        if let Some(current) = self.service.get() {
            if current == &wanted {
                return Ok(());
            }
            return Err(anyhow!("account service was already configured"));
        }
        self.service
            .set(wanted)
            .map_err(|_| anyhow!("account service was already configured"))
    }

    pub fn status(&self, app: &AppHandle) -> AccountStatus {
        self.ensure_loaded();
        if self.refresh_if_needed() {
            self.emit(app);
        }

        self.snapshot()
    }

    pub fn begin_sign_in(self: &Arc<Self>, app: &AppHandle) -> Result<AccountStatus> {
        self.ensure_loaded();
        {
            let inner = self.inner.lock().unwrap();
            if inner.session.is_some() {
                return Ok(snapshot(&inner));
            }
        }

        let pending = PendingAuth {
            generation: 0,
            code_verifier: random_url_token(),
            nonce: random_url_token(),
            state: random_url_token(),
            started_at: Instant::now(),
        };
        let authorize_url = authorize_url(&pending)?;
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            inner.generation = inner.generation.wrapping_add(1);
            let generation = inner.generation;
            inner.pending = Some(PendingAuth {
                generation,
                ..pending
            });
            inner.signing_in = true;
            inner.last_error = None;
            generation
        };

        if let Err(error) = app.opener().open_url(authorize_url.as_str(), None::<&str>) {
            let mut inner = self.inner.lock().unwrap();
            if inner.generation == generation {
                inner.pending = None;
                inner.signing_in = false;
                inner.last_error = Some("The sign-in page could not be opened.".into());
            }
            return Err(error).context("open the TerminalX sign-in page");
        }

        let manager = self.clone();
        let timeout_app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(AUTH_TIMEOUT).await;
            let expired = {
                let mut inner = manager.inner.lock().unwrap();
                let current = inner.pending.as_ref().map(|pending| pending.generation);
                if current == Some(generation) {
                    inner.pending = None;
                    inner.signing_in = false;
                    inner.last_error = Some("Sign-in timed out. Try again.".into());
                    true
                } else {
                    false
                }
            };
            if expired {
                manager.emit(&timeout_app);
            }
        });

        let status = self.snapshot();
        self.emit(app);
        Ok(status)
    }

    pub fn sign_out(&self, app: &AppHandle) -> AccountStatus {
        self.ensure_loaded();
        let session = {
            let mut inner = self.inner.lock().unwrap();
            inner.generation = inner.generation.wrapping_add(1);
            inner.pending = None;
            inner.signing_in = false;
            inner.last_error = None;
            if let Err(error) = self.delete_session() {
                log::warn!("could not remove TerminalX account session from Keychain: {error:#}");
                inner.last_error = Some(
                    "Sign-out could not remove the account session from macOS Keychain.".into(),
                );
                None
            } else {
                inner.session.take()
            }
        };
        let status = self.snapshot();
        self.emit(app);

        if let Some(session) = session {
            if let Err(error) = logout(&session) {
                log::debug!("TerminalX account logout request failed: {error}");
            }
        }
        status
    }

    pub fn handle_deep_link(self: &Arc<Self>, app: &AppHandle, url: &Url) -> bool {
        if !is_auth_callback(url) {
            return false;
        }
        let action = self.claim_callback(url);
        match action {
            CallbackAction::Ignore => {}
            CallbackAction::Failed => self.emit(app),
            CallbackAction::Exchange { pending, code } => {
                let manager = self.clone();
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let outcome = exchange_code(&pending, &code);
                    manager.finish_exchange(&app, pending.generation, outcome);
                });
            }
        }
        true
    }

    fn claim_callback(&self, url: &Url) -> CallbackAction {
        let returned_state = url
            .query_pairs()
            .find_map(|(key, value)| (key == "state").then(|| value.into_owned()));
        let mut inner = self.inner.lock().unwrap();
        let Some(expected) = inner.pending.as_ref() else {
            return CallbackAction::Ignore;
        };
        if returned_state.as_deref() != Some(expected.state.as_str()) {
            return CallbackAction::Ignore;
        }

        let pending = inner
            .pending
            .take()
            .expect("pending authentication disappeared");
        if pending.started_at.elapsed() > AUTH_TIMEOUT {
            inner.signing_in = false;
            inner.last_error = Some("That sign-in link expired. Try again.".into());
            return CallbackAction::Failed;
        }
        if url.query_pairs().any(|(key, _)| key == "error") {
            inner.signing_in = false;
            inner.last_error = Some("Sign-in was cancelled.".into());
            return CallbackAction::Failed;
        }
        let code = url
            .query_pairs()
            .find_map(|(key, value)| (key == "code").then(|| value.into_owned()));
        let Some(code) = code.filter(|code| !code.trim().is_empty()) else {
            inner.signing_in = false;
            inner.last_error = Some("The sign-in response was incomplete. Try again.".into());
            return CallbackAction::Failed;
        };
        CallbackAction::Exchange { pending, code }
    }

    fn finish_exchange(
        &self,
        app: &AppHandle,
        generation: u64,
        outcome: Result<DesktopSession, CloudError>,
    ) {
        let mut inner = self.inner.lock().unwrap();
        if inner.generation != generation || !inner.signing_in {
            return;
        }
        inner.signing_in = false;
        match outcome {
            Ok(session) => {
                inner.last_error = self.save_session(&session).err().map(|error| {
                    log::warn!("could not save TerminalX account session to Keychain: {error:#}");
                    "Signed in for this run, but macOS Keychain could not save the session.".into()
                });
                inner.session = Some(session);
            }
            Err(error) => {
                inner.last_error = Some(friendly_cloud_error(&error));
            }
        }
        drop(inner);
        self.emit(app);
    }

    fn refresh_session(&self, generation: u64, session: DesktopSession) {
        let result = refresh(&session);
        let mut inner = self.inner.lock().unwrap();
        let unchanged = inner.generation == generation
            && inner
                .session
                .as_ref()
                .map(|current| current.refresh_token.as_str())
                == Some(session.refresh_token.as_str());
        if !unchanged {
            return;
        }

        match result {
            Ok(refreshed) => {
                inner.last_error = self.save_session(&refreshed).err().map(|error| {
                    log::warn!(
                        "could not save refreshed TerminalX account session to Keychain: {error:#}"
                    );
                    "The account session refreshed, but macOS Keychain could not save it.".into()
                });
                inner.session = Some(refreshed);
            }
            Err(CloudError::Http(400 | 401 | 403)) => {
                inner.session = None;
                inner.last_error = Some("Your TerminalX session expired. Sign in again.".into());
                if let Err(error) = self.delete_session() {
                    log::warn!("could not remove expired TerminalX account session from Keychain: {error:#}");
                }
            }
            Err(error) => {
                inner.last_error = Some(friendly_cloud_error(&error));
            }
        }
    }

    fn refresh_if_needed(&self) -> bool {
        // Refresh tokens rotate. Serializing this section prevents two status
        // reads from submitting the same token family at once.
        let _gate = self.refresh_gate.lock().unwrap();
        let refresh = {
            let inner = self.inner.lock().unwrap();
            inner.session.as_ref().and_then(|session| {
                should_refresh(session.expires_at, now_ms())
                    .then(|| (inner.generation, session.clone()))
            })
        };
        if let Some((generation, session)) = refresh {
            self.refresh_session(generation, session);
            true
        } else {
            false
        }
    }

    fn ensure_loaded(&self) {
        let mut inner = self.inner.lock().unwrap();
        if inner.loaded {
            return;
        }
        inner.loaded = true;
        match self.load_session() {
            Ok(session) => inner.session = session,
            Err(error) => {
                log::warn!("could not read TerminalX account session from Keychain: {error:#}");
                inner.last_error = Some(
                    "The saved TerminalX account session could not be read from macOS Keychain."
                        .into(),
                );
            }
        }
    }

    fn snapshot(&self) -> AccountStatus {
        snapshot(&self.inner.lock().unwrap())
    }

    fn emit(&self, app: &AppHandle) {
        let _ = app.emit(STATUS_EVENT, self.snapshot());
    }

    fn service(&self) -> Result<&str> {
        self.service
            .get()
            .map(String::as_str)
            .ok_or_else(|| anyhow!("account service is not configured"))
    }

    #[cfg(target_os = "macos")]
    fn load_session(&self) -> Result<Option<DesktopSession>> {
        use security_framework::passwords::get_generic_password;

        let bytes = match get_generic_password(self.service()?, KEYCHAIN_ACCOUNT) {
            Ok(bytes) => bytes,
            Err(error) if error.code() == KEYCHAIN_NOT_FOUND => return Ok(None),
            Err(error) => return Err(error).context("read account session from Keychain"),
        };
        let session = serde_json::from_slice(bytes.as_slice())
            .context("decode account session from Keychain")?;
        normalize_session(session)
            .map(Some)
            .map_err(anyhow::Error::from)
    }

    #[cfg(not(target_os = "macos"))]
    fn load_session(&self) -> Result<Option<DesktopSession>> {
        Ok(None)
    }

    #[cfg(target_os = "macos")]
    fn save_session(&self, session: &DesktopSession) -> Result<()> {
        use security_framework::passwords::set_generic_password;

        let bytes = serde_json::to_vec(session).context("encode account session")?;
        set_generic_password(self.service()?, KEYCHAIN_ACCOUNT, bytes.as_slice())
            .context("save account session to Keychain")
    }

    #[cfg(not(target_os = "macos"))]
    fn save_session(&self, _session: &DesktopSession) -> Result<()> {
        Err(anyhow!("macOS Keychain is unavailable"))
    }

    #[cfg(target_os = "macos")]
    fn delete_session(&self) -> Result<()> {
        use security_framework::passwords::delete_generic_password;

        match delete_generic_password(self.service()?, KEYCHAIN_ACCOUNT) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == KEYCHAIN_NOT_FOUND => Ok(()),
            Err(error) => Err(error).context("delete account session from Keychain"),
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn delete_session(&self) -> Result<()> {
        Ok(())
    }
}

pub fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn is_launch_link(url: &Url) -> bool {
    matches!(url.scheme(), "terminalx" | "terminalx-next")
        && url.host_str() == Some("launch")
        && matches!(url.path(), "" | "/")
}

fn is_auth_callback(url: &Url) -> bool {
    matches!(url.scheme(), "terminalx" | "terminalx-next")
        && url.host_str() == Some("auth")
        && url.path() == "/callback"
}

fn snapshot(inner: &Inner) -> AccountStatus {
    let (state, identity, expires_at) = if let Some(session) = inner.session.as_ref() {
        (
            AccountPhase::SignedIn,
            Some(AccountIdentity {
                name: session.cloud.display_name.clone(),
                email: session.cloud.email.clone(),
                organization: session.cloud.active_org_name.clone(),
            }),
            Some(session.expires_at),
        )
    } else if inner.signing_in {
        (AccountPhase::SigningIn, None, None)
    } else {
        (AccountPhase::SignedOut, None, None)
    };
    AccountStatus {
        state,
        identity,
        expires_at,
        last_error: inner.last_error.clone(),
    }
}

fn random_url_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

fn code_challenge(verifier: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorize_url(pending: &PendingAuth) -> Result<Url> {
    let mut url = Url::parse(&format!("{API_BASE_URL}{AUTHORIZE_PATH}"))?;
    url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", SCOPE)
        .append_pair("nonce", &pending.nonce)
        .append_pair("state", &pending.state)
        .append_pair("code_challenge", &code_challenge(&pending.code_verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("local_profile_id", LOCAL_PROFILE_ID);
    Ok(url)
}

fn endpoint(path: &str) -> String {
    format!("{API_BASE_URL}{path}")
}

fn exchange_code(pending: &PendingAuth, code: &str) -> Result<DesktopSession, CloudError> {
    post_json(
        SESSION_PATH,
        json!({
            "code": code,
            "codeVerifier": pending.code_verifier,
            "nonce": pending.nonce,
            "redirectUri": REDIRECT_URI,
            "state": pending.state,
            "localProfileId": LOCAL_PROFILE_ID,
        }),
        None,
    )
    .and_then(normalize_session)
}

fn refresh(session: &DesktopSession) -> Result<DesktopSession, CloudError> {
    post_json(
        REFRESH_PATH,
        json!({ "refreshToken": session.refresh_token }),
        None,
    )
    .and_then(normalize_session)
}

fn logout(session: &DesktopSession) -> Result<(), CloudError> {
    post_json::<serde_json::Value>(
        LOGOUT_PATH,
        json!({ "refreshToken": session.refresh_token }),
        Some(&session.access_token),
    )
    .map(|_| ())
}

fn post_json<T: DeserializeOwned>(
    path: &str,
    body: serde_json::Value,
    access_token: Option<&str>,
) -> Result<T, CloudError> {
    let agent = ureq::AgentBuilder::new()
        .timeout(REQUEST_TIMEOUT)
        .redirects(0)
        .build();
    let mut request = agent
        .post(&endpoint(path))
        .set("content-type", "application/json");
    if let Some(token) = access_token {
        request = request.set("authorization", &format!("Bearer {token}"));
    }
    let response = match request.send_json(body) {
        Ok(response) => response,
        Err(ureq::Error::Status(status, _)) => return Err(CloudError::Http(status)),
        Err(ureq::Error::Transport(_)) => return Err(CloudError::Transport),
    };
    let value = response
        .into_json::<T>()
        .map_err(|_| CloudError::InvalidSession)?;
    Ok(value)
}

fn normalize_session(mut session: DesktopSession) -> Result<DesktopSession, CloudError> {
    session.access_token = session.access_token.trim().into();
    session.refresh_token = session.refresh_token.trim().into();
    session.cloud.cloud_profile_id = session.cloud.cloud_profile_id.trim().into();
    session.cloud.user_id = session.cloud.user_id.trim().into();
    session.cloud.email = session.cloud.email.trim().into();
    session.cloud.display_name = trimmed(session.cloud.display_name);
    session.cloud.active_org_id = trimmed(session.cloud.active_org_id);
    session.cloud.active_org_name = trimmed(session.cloud.active_org_name);
    for organization in &mut session.organizations {
        organization.org_id = organization.org_id.trim().into();
        organization.name = organization.name.trim().into();
        organization.role = organization.role.trim().into();
    }
    let invalid = session.access_token.is_empty()
        || session.refresh_token.is_empty()
        || session.expires_at <= 0
        || session.cloud.cloud_profile_id.is_empty()
        || session.cloud.user_id.is_empty()
        || session.cloud.email.is_empty()
        || session.cloud.linked_at <= 0
        || session.capabilities.refreshed_at <= 0
        || session
            .organizations
            .iter()
            .any(|organization| organization.org_id.is_empty() || organization.name.is_empty());
    if invalid {
        return Err(CloudError::InvalidSession);
    }
    Ok(session)
}

fn trimmed(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

fn friendly_cloud_error(error: &CloudError) -> String {
    match error {
        CloudError::Http(400) => "That sign-in link was invalid or expired. Try again.".into(),
        CloudError::Http(401 | 403) => {
            "TerminalX could not authorize this account. Try signing in again.".into()
        }
        CloudError::Http(_) | CloudError::Transport => {
            "TerminalX could not reach the account service. Try again.".into()
        }
        CloudError::InvalidSession => "The account service returned an invalid session.".into(),
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

fn should_refresh(expires_at: i64, now: i64) -> bool {
    expires_at <= now + REFRESH_SKEW_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending() -> PendingAuth {
        PendingAuth {
            generation: 7,
            code_verifier: "a".repeat(64),
            nonce: "nonce-value".into(),
            state: "state-value".into(),
            started_at: Instant::now(),
        }
    }

    #[test]
    fn authorize_url_matches_the_deployed_desktop_contract() {
        let pending = pending();
        let url = authorize_url(&pending).unwrap();
        let params: BTreeMap<_, _> = url
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();

        assert_eq!(
            url.as_str().split('?').next(),
            Some("https://login.terminalx.ai/v1/desktop/auth/authorize")
        );
        assert_eq!(
            params.get("client_id").map(String::as_str),
            Some("terminalx-desktop")
        );
        assert_eq!(
            params.get("redirect_uri").map(String::as_str),
            Some("terminalx://auth/callback")
        );
        assert_eq!(params.get("scope").map(String::as_str), Some(SCOPE));
        assert_eq!(
            params.get("code_challenge_method").map(String::as_str),
            Some("S256")
        );
        assert_eq!(
            params.get("code_challenge").map(String::as_str),
            Some(code_challenge(&pending.code_verifier).as_str())
        );
        assert_eq!(
            params.get("local_profile_id").map(String::as_str),
            Some("local-default")
        );
    }

    #[test]
    fn recognizes_only_the_expected_account_callback() {
        assert!(is_auth_callback(
            &Url::parse("terminalx://auth/callback?code=secret&state=state").unwrap()
        ));
        assert!(!is_auth_callback(
            &Url::parse("terminalx://launch?code=secret&state=state").unwrap()
        ));
        assert!(!is_auth_callback(
            &Url::parse("https://auth/callback?code=secret&state=state").unwrap()
        ));
        assert!(is_launch_link(&Url::parse("terminalx://launch").unwrap()));
    }

    #[test]
    fn ignores_a_callback_that_does_not_match_the_pending_state() {
        let manager = AccountManager::default();
        manager.inner.lock().unwrap().pending = Some(pending());

        let action = manager.claim_callback(
            &Url::parse("terminalx://auth/callback?code=one-time-code&state=another-state")
                .unwrap(),
        );

        assert!(matches!(action, CallbackAction::Ignore));
        assert!(manager.inner.lock().unwrap().pending.is_some());
    }

    #[test]
    fn consumes_a_matching_callback_once() {
        let manager = AccountManager::default();
        manager.inner.lock().unwrap().pending = Some(pending());

        let action = manager.claim_callback(
            &Url::parse("terminalx://auth/callback?code=one-time-code&state=state-value").unwrap(),
        );

        assert!(matches!(
            action,
            CallbackAction::Exchange { code, .. } if code == "one-time-code"
        ));
        assert!(manager.inner.lock().unwrap().pending.is_none());
    }

    #[test]
    fn normalizes_the_desktop_session_identity() {
        let session: DesktopSession = serde_json::from_value(json!({
            "accessToken": " access ",
            "refreshToken": " refresh ",
            "expiresAt": 1_800_000_000_000_i64,
            "cloud": {
                "cloudProfileId": " profile ",
                "userId": " user ",
                "email": " owner@example.com ",
                "displayName": " Owner ",
                "activeOrgId": " org ",
                "activeOrgName": " TerminalX ",
                "linkedAt": 1_700_000_000_000_i64
            },
            "organizations": [{ "orgId": " org ", "name": " TerminalX ", "role": "owner" }],
            "capabilities": { "flags": { "relay.use": true }, "refreshedAt": 1_700_000_000_000_i64 },
            "ignoredServerExtension": true
        }))
        .unwrap();

        let session = normalize_session(session).unwrap();
        assert_eq!(session.access_token, "access");
        assert_eq!(session.cloud.display_name.as_deref(), Some("Owner"));
        assert_eq!(session.cloud.active_org_name.as_deref(), Some("TerminalX"));
    }

    #[test]
    fn refreshes_before_expiry() {
        assert!(!should_refresh(1_000_061_000, 1_000_000_000));
        assert!(should_refresh(1_000_060_000, 1_000_000_000));
        assert!(should_refresh(999_999_999, 1_000_000_000));
    }
}
