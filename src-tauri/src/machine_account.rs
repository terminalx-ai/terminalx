//! The TerminalX account of a headless machine (PRO-353): signed in with a
//! device code (RFC 8628), since a server has no browser, and kept in a file
//! in the runtime's data directory, since it has no Keychain either.
//!
//! The server side is terminalx-saas `apps/api/docs/machine-relay-access.md`,
//! "Device-code sign-in for a headless machine". The grant ends in the same
//! desktop Cloud Session the desktop's browser sign-in issues; the relay
//! registration that uses it is PRO-368.
//!
//! Nothing here prints or logs the device code, the access token or the
//! refresh token. The user code is meant for the person and is shown.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

const API_BASE_URL: &str = "https://login.terminalx.ai";
/// Debug builds only, as for the desktop (`account.rs`): an HTTPS origin or a
/// loopback HTTP one, e.g. a local terminalx-saas stack.
const DEV_API_BASE_URL_ENV: &str = "TERMINALX_DEV_API_BASE_URL";
const DEVICE_CODE_PATH: &str = "/v1/desktop/auth/device/code";
const DEVICE_TOKEN_PATH: &str = "/v1/desktop/auth/device/token";
const LOGOUT_PATH: &str = "/v1/desktop/auth/logout";
const CLIENT_ID: &str = "terminalx-desktop";
const LOCAL_PROFILE_ID: &str = "local-default";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// RFC 8628 §3.5: `slow_down` adds five seconds to the interval.
const SLOW_DOWN_STEP: Duration = Duration::from_secs(5);
/// The server's interval is honoured, but never below one second.
const MIN_INTERVAL: Duration = Duration::from_secs(1);

/// The account service origin: production, or in a debug build
/// [`DEV_API_BASE_URL_ENV`] when it is an HTTPS or loopback HTTP origin.
pub fn api_base_url() -> String {
    dev_origin(cfg!(debug_assertions), std::env::var(DEV_API_BASE_URL_ENV).ok().as_deref()).unwrap_or_else(|| API_BASE_URL.to_string())
}

fn dev_origin(debug_build: bool, value: Option<&str>) -> Option<String> {
    if !debug_build {
        return None;
    }
    let url = url::Url::parse(value?.trim()).ok()?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    let allowed = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !allowed || url.path() != "/" || url.query().is_some() || !url.username().is_empty() {
        log::warn!("ignoring {DEV_API_BASE_URL_ENV}: expected an HTTPS or loopback HTTP origin");
        return None;
    }
    Some(url.origin().ascii_serialization())
}

/// `<data dir>/account/session.json`, mode 0600 in a 0700 folder.
pub fn session_path(data_dir: &Path) -> PathBuf {
    data_dir.join("account").join("session.json")
}

/// Who the session belongs to, as the server names them.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub cloud_profile_id: String,
    pub user_id: String,
    pub email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

/// A desktop Cloud Session (the body of `POST /v1/desktop/auth/session`).
/// Fields this module does not read (organizations, capabilities) are kept
/// as the server sent them, for the runtime that registers with the relay.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    pub cloud: Identity,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session").field("expires_at", &self.expires_at).field("cloud", &self.cloud).finish_non_exhaustive()
    }
}

impl Session {
    fn validated(mut self) -> Result<Self> {
        self.access_token = self.access_token.trim().into();
        self.refresh_token = self.refresh_token.trim().into();
        self.cloud.email = self.cloud.email.trim().into();
        if self.access_token.is_empty()
            || self.refresh_token.is_empty()
            || self.expires_at <= 0
            || self.cloud.cloud_profile_id.trim().is_empty()
            || self.cloud.user_id.trim().is_empty()
            || self.cloud.email.is_empty()
        {
            bail!("the account service returned an incomplete session");
        }
        Ok(self)
    }

    /// The person, for messages: their name and email, or the email.
    pub fn who(&self) -> String {
        match self.cloud.display_name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
            Some(name) => format!("{name} ({})", self.cloud.email),
            None => self.cloud.email.clone(),
        }
    }
}

/// The saved session, if this machine is signed in.
pub fn load(data_dir: &Path) -> Result<Option<Session>> {
    let path = session_path(data_dir);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let session: Session = serde_json::from_slice(&bytes).with_context(|| format!("{} is not a session this version can read", path.display()))?;
    Ok(Some(session))
}

/// Keep `session`, replacing any other in one rename. The file is created
/// 0600, so the tokens are never readable by another user, even briefly.
pub fn save(data_dir: &Path, session: &Session) -> Result<()> {
    let path = session_path(data_dir);
    let dir = path.parent().expect("the session file is in a folder");
    crate::machine_host::private_dir(dir)?;
    let temporary = dir.join(format!(".session.{}.json", std::process::id()));
    let _ = std::fs::remove_file(&temporary);
    let write = || -> Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(session)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, &path)?;
        Ok(())
    };
    write().inspect_err(|_| {
        let _ = std::fs::remove_file(&temporary);
    })
    .with_context(|| format!("save {}", path.display()))
}

/// Forget the saved session. Whether there was one.
pub fn remove(data_dir: &Path) -> Result<bool> {
    let path = session_path(data_dir);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("remove {}", path.display())),
    }
}

/// What `device/code` answers. `device_code` is a credential: it is sent back
/// to the token endpoint and nowhere else.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthorization {
    device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    #[serde(default)]
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    pub interval: u64,
}

impl std::fmt::Debug for DeviceAuthorization {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceAuthorization").field("user_code", &self.user_code).field("verification_uri", &self.verification_uri).finish_non_exhaustive()
    }
}

/// How a device-code sign-in ended without a session.
#[derive(Debug, PartialEq, Eq)]
pub enum Refused {
    /// The person denied it in the console.
    Denied,
    /// Nobody approved it in time.
    Expired,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Refused::Denied => "the sign-in was denied",
            Refused::Expired => "the code expired before anyone approved it",
        })
    }
}

impl std::error::Error for Refused {}

/// The account service at one origin.
pub struct Api {
    base: String,
    agent: ureq::Agent,
}

/// An error answer from the account service: its status and `error` code.
#[derive(Debug)]
struct Answered {
    status: u16,
    code: String,
}

impl Api {
    pub fn new(base: &str) -> Self {
        Self { base: base.trim_end_matches('/').to_string(), agent: crate::data_privacy::http_agent().timeout(REQUEST_TIMEOUT).redirects(0).build() }
    }

    fn post(&self, path: &str, body: Value, bearer: Option<&str>) -> Result<std::result::Result<Value, Answered>> {
        let mut request = self.agent.post(&format!("{}{path}", self.base)).set("content-type", "application/json");
        if let Some(token) = bearer {
            request = request.set("authorization", &format!("Bearer {token}"));
        }
        match request.send_json(body) {
            Ok(response) => Ok(Ok(response.into_json().map_err(|_| anyhow!("the account service sent an unreadable answer"))?)),
            Err(ureq::Error::Status(status, response)) => {
                let code = response.into_json::<Value>().ok().and_then(|body| body["error"].as_str().map(str::to_string)).unwrap_or_default();
                Ok(Err(Answered { status, code }))
            }
            // The transport error names the address and the cause, never the body.
            Err(ureq::Error::Transport(error)) => Err(anyhow!("cannot reach the account service at {}: {error}", self.base)),
        }
    }

    /// Ask for a device code naming this machine.
    pub fn device_code(&self, label: &str, platform: &str) -> Result<DeviceAuthorization> {
        let body = json!({ "clientId": CLIENT_ID, "localProfileId": LOCAL_PROFILE_ID, "deviceLabel": label, "platform": platform });
        match self.post(DEVICE_CODE_PATH, body, None)? {
            Ok(value) => {
                let authorization: DeviceAuthorization = serde_json::from_value(value).map_err(|_| anyhow!("the account service sent an unreadable device code"))?;
                if authorization.device_code.is_empty() || authorization.user_code.is_empty() || authorization.verification_uri.is_empty() {
                    bail!("the account service sent an incomplete device code");
                }
                Ok(authorization)
            }
            Err(Answered { code, .. }) if code == "rate_limited" => bail!("too many sign-in requests from this network; wait a minute and try again"),
            Err(Answered { code, .. }) if code == "device_authorization_unavailable" => bail!("the account service does not offer device sign-in right now"),
            Err(Answered { status, code }) => bail!("the account service refused a device code ({status} {code})"),
        }
    }

    /// Poll until the person approves or denies `authorization`, or it
    /// expires. `sleep` waits between polls (tests pass one that does not).
    pub fn wait_for_session(&self, authorization: &DeviceAuthorization, mut sleep: impl FnMut(Duration)) -> Result<Session> {
        let mut interval = Duration::from_secs(authorization.interval).max(MIN_INTERVAL);
        let deadline = std::time::Instant::now() + Duration::from_secs(authorization.expires_in.max(1));
        let body = json!({ "clientId": CLIENT_ID, "deviceCode": authorization.device_code });
        loop {
            sleep(interval);
            if std::time::Instant::now() >= deadline {
                return Err(Refused::Expired.into());
            }
            match self.post(DEVICE_TOKEN_PATH, body.clone(), None) {
                Ok(Ok(value)) => {
                    let session: Session = serde_json::from_value(value).map_err(|_| anyhow!("the account service sent an unreadable session"))?;
                    return session.validated();
                }
                Ok(Err(Answered { code, .. })) if code == "authorization_pending" => {}
                Ok(Err(Answered { code, .. })) if code == "slow_down" => interval += SLOW_DOWN_STEP,
                Ok(Err(Answered { code, .. })) if code == "access_denied" => return Err(Refused::Denied.into()),
                Ok(Err(Answered { code, .. })) if code == "expired_token" => return Err(Refused::Expired.into()),
                Ok(Err(Answered { code, .. })) if code == "invalid_grant" => bail!("the account service no longer knows this code; run the sign-in again"),
                Ok(Err(Answered { status, code })) if status >= 500 || status == 429 => log::warn!("device sign-in: the account service answered {status} {code}; asking again"),
                Ok(Err(Answered { status, code })) => bail!("the account service refused the sign-in ({status} {code})"),
                // A network blip while someone approves: ask again until the code expires.
                Err(error) => log::warn!("device sign-in: {error:#}; asking again"),
            }
        }
    }

    /// End `session` at the account service. An unknown or expired session is
    /// already ended.
    pub fn logout(&self, session: &Session) -> Result<()> {
        match self.post(LOGOUT_PATH, json!({ "refreshToken": session.refresh_token }), Some(&session.access_token))? {
            Ok(_) => Ok(()),
            Err(Answered { status: 401 | 404, .. }) => Ok(()),
            Err(Answered { status, code }) => bail!("the account service refused to sign out ({status} {code})"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::sync::{Arc, Mutex};

    /// A loopback account service answering each request with the next of
    /// `answers` (status, body), recording what it was sent.
    fn service(answers: Vec<(u16, Value)>) -> (String, Arc<Mutex<Vec<(String, Value, Option<String>)>>>, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        let handle = std::thread::spawn(move || {
            for (status, body) in answers {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = Vec::new();
                let mut buffer = [0_u8; 4096];
                let head_end = loop {
                    let read = stream.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..read]);
                    if let Some(end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                        break end + 4;
                    }
                };
                let head = String::from_utf8_lossy(&request[..head_end]).to_string();
                let length: usize = head
                    .lines()
                    .find_map(|line| line.to_ascii_lowercase().strip_prefix("content-length:").map(|value| value.trim().parse().unwrap()))
                    .unwrap_or(0);
                while request.len() < head_end + length {
                    let read = stream.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..read]);
                }
                let path = head.split_whitespace().nth(1).unwrap().to_string();
                let bearer = head.lines().find_map(|line| line.to_ascii_lowercase().starts_with("authorization:").then(|| line[14..].trim().to_string()));
                record.lock().unwrap().push((path, serde_json::from_slice(&request[head_end..]).unwrap(), bearer));
                let text = body.to_string();
                let reason = if status == 200 { "OK" } else { "Bad Request" };
                write!(stream, "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len()).unwrap();
            }
        });
        (base, seen, handle)
    }

    fn session_body() -> Value {
        json!({
            "accessToken": "access-1",
            "refreshToken": "refresh-1",
            "expiresAt": 1_900_000_000_000_i64,
            "cloud": { "cloudProfileId": "cp1", "userId": "u1", "email": "person@example.com", "displayName": "A Person", "linkedAt": 1 },
            "organizations": [{ "orgId": "o1", "name": "Org", "role": "owner" }],
            "capabilities": { "flags": {}, "refreshedAt": 1 },
        })
    }

    fn authorization(interval: u64) -> Value {
        json!({ "deviceCode": "device-secret", "userCode": "BCDF-GHJK", "verificationUri": "https://console.example/device", "verificationUriComplete": "https://console.example/device?code=BCDF-GHJK", "expiresIn": 600, "interval": interval })
    }

    #[test]
    fn a_device_code_sign_in_waits_for_approval_and_slows_down_when_told() {
        let (base, seen, handle) = service(vec![
            (200, authorization(5)),
            (400, json!({ "error": "authorization_pending" })),
            (400, json!({ "error": "slow_down" })),
            (200, session_body()),
        ]);
        let api = Api::new(&base);
        let code = api.device_code("dev-server", "linux").unwrap();
        assert_eq!(code.user_code, "BCDF-GHJK");
        assert!(!format!("{code:?}").contains("device-secret"), "the device code is never printed");
        let mut waits = Vec::new();
        let session = api.wait_for_session(&code, |wait| waits.push(wait)).unwrap();
        handle.join().unwrap();
        assert_eq!(waits, [Duration::from_secs(5), Duration::from_secs(5), Duration::from_secs(10)]);
        assert_eq!(session.who(), "A Person (person@example.com)");
        assert!(!format!("{session:?}").contains("access-1") && !format!("{session:?}").contains("refresh-1"));
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, DEVICE_CODE_PATH);
        assert_eq!(seen[0].1, json!({ "clientId": CLIENT_ID, "localProfileId": LOCAL_PROFILE_ID, "deviceLabel": "dev-server", "platform": "linux" }));
        assert!(seen[1..].iter().all(|(path, body, bearer)| path == DEVICE_TOKEN_PATH && *body == json!({ "clientId": CLIENT_ID, "deviceCode": "device-secret" }) && bearer.is_none()));
    }

    #[test]
    fn a_denied_or_expired_code_ends_the_sign_in() {
        for (error, refused) in [("access_denied", Refused::Denied), ("expired_token", Refused::Expired)] {
            let (base, _, handle) = service(vec![(200, authorization(1)), (400, json!({ "error": error }))]);
            let api = Api::new(&base);
            let code = api.device_code("dev-server", "linux").unwrap();
            let result = api.wait_for_session(&code, |_| {});
            handle.join().unwrap();
            assert_eq!(result.unwrap_err().downcast::<Refused>().unwrap(), refused);
        }
    }

    #[test]
    fn an_incomplete_session_is_refused() {
        let mut body = session_body();
        body["refreshToken"] = json!(" ");
        let (base, _, handle) = service(vec![(200, authorization(1)), (200, body)]);
        let api = Api::new(&base);
        let code = api.device_code("dev-server", "linux").unwrap();
        assert!(api.wait_for_session(&code, |_| {}).is_err());
        handle.join().unwrap();
    }

    #[test]
    fn the_session_file_is_private_and_keeps_what_it_does_not_read() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path()).unwrap().is_none());
        let session: Session = serde_json::from_value(session_body()).unwrap();
        save(dir.path(), &session).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = session_path(dir.path());
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(path.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }
        let saved: Value = serde_json::from_slice(&std::fs::read(session_path(dir.path())).unwrap()).unwrap();
        assert_eq!(saved, session_body(), "organizations, capabilities and linkedAt are kept for the relay registration");
        assert_eq!(load(dir.path()).unwrap().unwrap().cloud.email, "person@example.com");
        assert!(remove(dir.path()).unwrap());
        assert!(!remove(dir.path()).unwrap());
    }

    #[test]
    fn logout_sends_the_refresh_token_with_the_access_token() {
        let (base, seen, handle) = service(vec![(200, json!({})), (401, json!({ "error": "invalid_session" }))]);
        let api = Api::new(&base);
        let session: Session = serde_json::from_value(session_body()).unwrap();
        api.logout(&session).unwrap();
        api.logout(&session).unwrap();
        handle.join().unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, LOGOUT_PATH);
        assert_eq!(seen[0].1, json!({ "refreshToken": "refresh-1" }));
        assert_eq!(seen[0].2.as_deref(), Some("Bearer access-1"));
    }

    #[test]
    fn only_a_debug_build_takes_another_origin() {
        assert_eq!(dev_origin(false, Some("http://127.0.0.1:42220")), None);
        assert_eq!(dev_origin(true, Some("http://127.0.0.1:42220")).as_deref(), Some("http://127.0.0.1:42220"));
        assert_eq!(dev_origin(true, Some("http://example.com")), None);
        assert_eq!(dev_origin(true, Some("https://api.example.com/v1")), None);
    }
}
