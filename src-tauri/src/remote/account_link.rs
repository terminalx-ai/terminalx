//! The relay session of a signed-in machine (PRO-368) as a [`RuntimeLink`].
//!
//! A machine registers with the relay under its host key's relay host id
//! with a generation-fenced token from
//! `POST /v1/desktop/machine-host/relay-session` (terminalx-saas
//! `apps/api/docs/machine-relay-access.md`, "Machine relay session"). The
//! first token of a link starts a new generation; later ones refresh it.
//! `409 machine_runtime_superseded` means a newer runtime process serves the
//! machine: this one stops serving through the relay for good.
//!
//! The account is the desktop Cloud Session in `<data dir>/account/session.json`
//! (`machine_account`): kept there by `terminalx-serve login` on a headless
//! machine, and by the window while "Let other computers operate this Mac" is
//! on (`account.rs`). Refresh tokens rotate, and presenting a superseded one
//! ends the session for everyone, so only one process refreshes at a time,
//! under the file's lock: the window while it is attached (asked through
//! [`AccountWindow::refresh`]), else this runtime.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Result};
use serde::Serialize;

use super::host::{RelaySession, Revoked, RuntimeLink};
use crate::machine_account::{self, Api, RelaySessionGrant, RelaySessionRefused, Session, SessionEnded};
use crate::relay_e2ee::HostKeypair;

/// An access token this close to expiry is refreshed before it is used. The
/// window refreshes at the same distance (`REFRESH_SKEW_MS` in `account.rs`).
const ACCESS_MARGIN_MS: i64 = 60_000;
/// A relay token is renewed this long before it expires, so a registration
/// that has to reconnect never presents an expired one.
const RELAY_MARGIN_MS: i64 = 5 * 60_000;
/// A debug build registers only with this director, never production's,
/// as the window does (`pairing::cloud::DEV_RELAY_DIRECTOR_URL_ENV`).
const DEV_RELAY_DIRECTOR_URL_ENV: &str = "TERMINALX_DEV_RELAY_DIRECTOR_URL";

/// The window that keeps the account's session on a desktop.
pub trait AccountWindow: Send + Sync + 'static {
    /// Whether a window is attached now. While one is, it alone refreshes
    /// the session: a rotation here would leave its access token dead.
    fn attached(&self) -> bool;
    /// Ask the window to refresh the session if it is about to expire. It
    /// writes the result to the session file. Blocking.
    fn refresh(&self) -> Result<()>;
}

/// Why a link serves no more.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Ended {
    /// Nobody is signed in on this machine (or the account service ended
    /// the session). It serves again once someone signs in.
    SignedOut,
    /// A newer runtime process for this machine was issued a generation.
    /// This process never serves through the relay again.
    Superseded,
    /// Another account binds this machine (`409 host_binding_owner_conflict`):
    /// asking again changes nothing until that account lets it go.
    OwnerConflict,
}

/// Whether this build may register with the relay. A release build always
/// may; a debug build only with [`DEV_RELAY_DIRECTOR_URL_ENV`] set.
pub fn relay_enabled() -> bool {
    !cfg!(debug_assertions) || dev_director().is_some()
}

/// [`DEV_RELAY_DIRECTOR_URL_ENV`] in a debug build, when it is an HTTPS or
/// loopback HTTP origin.
fn dev_director() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let url = url::Url::parse(std::env::var(DEV_RELAY_DIRECTOR_URL_ENV).ok()?.trim()).ok()?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    (url.scheme() == "https" || (url.scheme() == "http" && loopback)).then(|| url.origin().ascii_serialization())
}

#[derive(Default)]
struct State {
    /// Whose session the generation and the grant are for.
    user_id: Option<String>,
    /// This process's generation, once the server issued one.
    generation: Option<u64>,
    grant: Option<RelaySessionGrant>,
    ended: Option<Ended>,
}

pub struct AccountLink {
    data_dir: PathBuf,
    secret: [u8; 32],
    api: Api,
    window: Option<Arc<dyn AccountWindow>>,
    state: Mutex<State>,
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl AccountLink {
    /// A link for the machine with host key `secret`, from the session in
    /// `data_dir`. `window`: the desktop window, on a desktop-launched runtime.
    pub fn new(data_dir: PathBuf, secret: [u8; 32], window: Option<Arc<dyn AccountWindow>>) -> Self {
        Self::with_api(data_dir, secret, window, Api::new(&machine_account::api_base_url()))
    }

    fn with_api(data_dir: PathBuf, secret: [u8; 32], window: Option<Arc<dyn AccountWindow>>, api: Api) -> Self {
        Self { data_dir, secret, api, window, state: Mutex::new(State::default()) }
    }

    /// Why the link serves no more, if it does not.
    pub fn ended(&self) -> Option<Ended> {
        self.state.lock().unwrap().ended
    }

    /// The account the link registers for, once it read a session.
    pub fn user_id(&self) -> Option<String> {
        self.state.lock().unwrap().user_id.clone()
    }

    fn end(&self, ended: Ended) -> anyhow::Error {
        let mut state = self.state.lock().unwrap();
        state.grant = None;
        state.ended = Some(ended);
        log::info!("machine relay: {}", match ended {
            Ended::SignedOut => "signed out; not registering with the relay",
            Ended::Superseded => "a newer runtime process serves this machine; this one stops serving through the relay",
            Ended::OwnerConflict => "another account binds this machine; not registering with the relay",
        });
        Revoked.into()
    }

    /// The session, with an access token that is not about to expire.
    pub(crate) fn fresh_session(&self) -> Result<Session> {
        let Some(session) = machine_account::load(&self.data_dir)? else { return Err(self.end(Ended::SignedOut)) };
        if session.expires_at > now_ms() + ACCESS_MARGIN_MS {
            return Ok(session);
        }
        if let Some(window) = self.window.as_ref().filter(|window| window.attached()) {
            // The window rotates its own session and writes it here.
            window.refresh()?;
            return match machine_account::load(&self.data_dir)? {
                Some(session) if session.expires_at > now_ms() => Ok(session),
                Some(_) => Err(anyhow!("the window did not refresh the account session")),
                None => Err(self.end(Ended::SignedOut)),
            };
        }
        let refreshed = machine_account::locked(&self.data_dir, || {
            // Someone may have refreshed while this waited for the lock.
            let Some(current) = machine_account::load(&self.data_dir)? else { return Ok(None) };
            if current.expires_at > now_ms() + ACCESS_MARGIN_MS {
                return Ok(Some(current));
            }
            match self.api.refresh(&current) {
                Ok(refreshed) => {
                    machine_account::save(&self.data_dir, &refreshed)?;
                    Ok(Some(refreshed))
                }
                Err(error) if error.is::<SessionEnded>() => {
                    machine_account::remove_if_current(&self.data_dir, &current.refresh_token)?;
                    Ok(None)
                }
                Err(error) => Err(error),
            }
        })?;
        refreshed.ok_or_else(|| self.end(Ended::SignedOut))
    }

    fn grant(&self, session: &Session) -> Result<RelaySessionGrant> {
        let keypair = HostKeypair::from_secret(self.secret);
        let generation = self.state.lock().unwrap().generation;
        let ask = |session: &Session| self.api.relay_session(&session.access_token, &keypair.host_id(), &keypair.public_key_b64(), generation);
        let answer = match ask(session) {
            // The window may have rotated the token since it was read.
            Err(error) if error.downcast_ref::<RelaySessionRefused>() == Some(&RelaySessionRefused::Unauthorized) => {
                let reread = self.fresh_session()?;
                if reread.access_token == session.access_token {
                    return Err(error);
                }
                ask(&reread)
            }
            answer => answer,
        };
        match answer {
            Ok(grant) => Ok(grant),
            Err(error) => match error.downcast_ref::<RelaySessionRefused>() {
                Some(RelaySessionRefused::Superseded) => Err(self.end(Ended::Superseded)),
                Some(RelaySessionRefused::OwnerConflict) => Err(self.end(Ended::OwnerConflict)),
                _ => Err(error),
            },
        }
    }
}

impl RuntimeLink for AccountLink {
    fn host_secret(&self) -> [u8; 32] {
        self.secret
    }

    fn session(&self) -> Result<RelaySession> {
        if matches!(self.ended(), Some(Ended::Superseded | Ended::OwnerConflict)) {
            return Err(Revoked.into());
        }
        let session = self.fresh_session()?;
        {
            let mut state = self.state.lock().unwrap();
            if state.ended == Some(Ended::SignedOut) {
                state.ended = None;
            }
            if state.user_id.as_deref() != Some(session.cloud.user_id.as_str()) {
                // Another account: its own generation, from a fresh start.
                let switched = state.user_id.is_some();
                *state = State { user_id: Some(session.cloud.user_id.clone()), ..State::default() };
                if switched {
                    log::info!("machine relay: another account signed in; registering for it");
                    return Err(Revoked.into());
                }
            }
            if let Some(grant) = state.grant.as_ref().filter(|grant| grant.expires_at > now_ms() + RELAY_MARGIN_MS) {
                return Ok(relay_session(grant));
            }
        }
        let grant = self.grant(&session)?;
        let mut state = self.state.lock().unwrap();
        if state.user_id.as_deref() == Some(session.cloud.user_id.as_str()) {
            state.generation = Some(grant.runtime_generation);
            state.grant = Some(grant.clone());
        }
        Ok(relay_session(&grant))
    }

    /// A machine's link carries no attachments: its computers pair by code.
    fn complete_attachment(&self, _attachment_id: &str, _pairing_code: &str) -> Result<()> {
        Ok(())
    }

    fn complete_revocation(&self, _attachment_id: &str) -> Result<()> {
        Ok(())
    }

    /// Another registration retired this one: ask the server now, which
    /// answers `machine_runtime_superseded` when a newer process took over.
    fn fenced(&self, runtime_generation: u64) {
        let mut state = self.state.lock().unwrap();
        if state.generation == Some(runtime_generation) {
            state.grant = None;
        }
    }
}

fn relay_session(grant: &RelaySessionGrant) -> RelaySession {
    RelaySession {
        relay_token: grant.relay_token.clone(),
        director_url: dev_director().unwrap_or_else(|| grant.director_url.clone()),
        attachments: Vec::new(),
        revocations: Vec::new(),
        collaboration: None,
        // An account link never requests `collaboration-v2`; only the cloud bootstrap does.
        collaboration_v2: false,
        desktop_ready: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use std::time::Duration;

    /// What the service was sent: path and body.
    type Seen = Arc<Mutex<Vec<(String, Value)>>>;

    /// A loopback account service answering each request with the next of
    /// `answers`, recording the path and body of each.
    fn service(answers: Vec<(u16, Value)>) -> (String, Seen, std::thread::JoinHandle<()>) {
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
                record.lock().unwrap().push((path, serde_json::from_slice(&request[head_end..]).unwrap()));
                let text = body.to_string();
                write!(stream, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}", text.len()).unwrap();
            }
        });
        (base, seen, handle)
    }

    fn session(user: &str, refresh: &str, expires_at: i64) -> Session {
        serde_json::from_value(json!({
            "accessToken": format!("dat_{refresh}"),
            "refreshToken": format!("drt_family-{user}.{refresh}"),
            "expiresAt": expires_at,
            "cloud": { "cloudProfileId": "cp1", "userId": user, "email": "person@example.com" },
        }))
        .unwrap()
    }

    fn grant(generation: u64) -> Value {
        // A relay token whose claims the relay host reads (`token_identity`).
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let claims = URL_SAFE_NO_PAD.encode(json!({ "sub": "u1", "cloudProfileId": "cp1", "organizationId": "", "runtimeGeneration": generation }).to_string());
        json!({ "relayToken": format!("e30.{claims}.sig"), "expiresAt": now_ms() + 3_600_000, "runtimeGeneration": generation, "directorUrl": "https://relay.example" })
    }

    struct Window {
        attached: bool,
        dir: PathBuf,
        refreshed: Mutex<u32>,
    }

    impl AccountWindow for Window {
        fn attached(&self) -> bool {
            self.attached
        }
        fn refresh(&self) -> Result<()> {
            *self.refreshed.lock().unwrap() += 1;
            machine_account::save(&self.dir, &session("u1", "from-window", now_ms() + 1_800_000))
        }
    }

    #[test]
    fn a_link_starts_a_generation_keeps_its_token_and_refreshes_with_its_generation() {
        let dir = tempfile::tempdir().unwrap();
        machine_account::save(dir.path(), &session("u1", "one", now_ms() + 1_800_000)).unwrap();
        let (base, seen, handle) = service(vec![(200, grant(7)), (200, grant(7))]);
        let link = AccountLink::with_api(dir.path().into(), [7; 32], None, Api::new(&base));
        assert!(link.session().unwrap().relay_token.starts_with("e30."));
        // Still fresh: no second request.
        link.session().unwrap();
        // Close to expiry: renewed with this process's generation.
        link.state.lock().unwrap().grant.as_mut().unwrap().expires_at = now_ms() + 1_000;
        link.session().unwrap();
        handle.join().unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 2);
        assert!(seen[0].1.get("runtimeGeneration").is_none(), "a new process starts a generation");
        assert_eq!(seen[1].1["runtimeGeneration"], 7, "and refreshes with its own");
        let keypair = HostKeypair::from_secret([7; 32]);
        assert_eq!(seen[0].1["relayHostId"], keypair.host_id());
        assert_eq!(seen[0].1["hostPublicKeyB64"], keypair.public_key_b64());
    }

    #[test]
    fn a_machine_another_account_binds_ends_the_link() {
        let dir = tempfile::tempdir().unwrap();
        machine_account::save(dir.path(), &session("u1", "one", now_ms() + 1_800_000)).unwrap();
        let (base, _, handle) = service(vec![(409, json!({ "error": "host_binding_owner_conflict" }))]);
        let link = AccountLink::with_api(dir.path().into(), [7; 32], None, Api::new(&base));
        assert!(link.session().err().unwrap().is::<Revoked>());
        assert_eq!(link.ended(), Some(Ended::OwnerConflict));
        // It does not ask again: the service answers only once.
        assert!(link.session().err().unwrap().is::<Revoked>());
        handle.join().unwrap();
    }

    #[test]
    fn a_superseded_link_stops_for_good() {
        let dir = tempfile::tempdir().unwrap();
        machine_account::save(dir.path(), &session("u1", "one", now_ms() + 1_800_000)).unwrap();
        let (base, _, handle) = service(vec![(409, json!({ "error": "machine_runtime_superseded" }))]);
        let link = AccountLink::with_api(dir.path().into(), [7; 32], None, Api::new(&base));
        assert!(link.session().err().unwrap().is::<Revoked>());
        assert_eq!(link.ended(), Some(Ended::Superseded));
        // No further request: the service answers only once.
        assert!(link.session().err().unwrap().is::<Revoked>());
        handle.join().unwrap();
    }

    #[test]
    fn a_fenced_link_asks_again_and_learns_it_was_superseded() {
        let dir = tempfile::tempdir().unwrap();
        machine_account::save(dir.path(), &session("u1", "one", now_ms() + 1_800_000)).unwrap();
        let (base, seen, handle) = service(vec![(200, grant(4)), (409, json!({ "error": "machine_runtime_superseded" }))]);
        let link = AccountLink::with_api(dir.path().into(), [7; 32], None, Api::new(&base));
        link.session().unwrap();
        link.fenced(4);
        assert!(link.session().err().unwrap().is::<Revoked>());
        handle.join().unwrap();
        assert_eq!(link.ended(), Some(Ended::Superseded));
        assert_eq!(seen.lock().unwrap()[1].1["runtimeGeneration"], 4);
    }

    #[test]
    fn signing_out_ends_the_link_until_someone_signs_in() {
        let dir = tempfile::tempdir().unwrap();
        let (base, _, handle) = service(vec![(200, grant(3))]);
        let link = AccountLink::with_api(dir.path().into(), [7; 32], None, Api::new(&base));
        assert!(link.session().err().unwrap().is::<Revoked>());
        assert_eq!(link.ended(), Some(Ended::SignedOut));
        machine_account::save(dir.path(), &session("u1", "one", now_ms() + 1_800_000)).unwrap();
        link.session().unwrap();
        assert_eq!(link.ended(), None);
        handle.join().unwrap();
    }

    #[test]
    fn with_no_window_the_runtime_refreshes_under_the_lock_and_keeps_the_rotation() {
        let dir = tempfile::tempdir().unwrap();
        machine_account::save(dir.path(), &session("u1", "one", now_ms() + 1_000)).unwrap();
        let rotated = serde_json::to_value(session("u1", "two", now_ms() + 1_800_000)).unwrap();
        let (base, seen, handle) = service(vec![(200, rotated), (200, grant(3))]);
        let window = Arc::new(Window { attached: false, dir: dir.path().into(), refreshed: Mutex::new(0) });
        let link = AccountLink::with_api(dir.path().into(), [7; 32], Some(window.clone()), Api::new(&base));
        link.session().unwrap();
        handle.join().unwrap();
        assert_eq!(*window.refreshed.lock().unwrap(), 0, "a closed window is not asked");
        assert_eq!(machine_account::load(dir.path()).unwrap().unwrap().refresh_token, "drt_family-u1.two");
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].0, "/v1/desktop/auth/refresh");
        assert_eq!(seen[0].1["refreshToken"], "drt_family-u1.one");
    }

    #[test]
    fn an_attached_window_refreshes_the_session_itself() {
        let dir = tempfile::tempdir().unwrap();
        machine_account::save(dir.path(), &session("u1", "one", now_ms() + 1_000)).unwrap();
        let (base, seen, handle) = service(vec![(200, grant(3))]);
        let window = Arc::new(Window { attached: true, dir: dir.path().into(), refreshed: Mutex::new(0) });
        let link = AccountLink::with_api(dir.path().into(), [7; 32], Some(window.clone()), Api::new(&base));
        link.session().unwrap();
        handle.join().unwrap();
        assert_eq!(*window.refreshed.lock().unwrap(), 1);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 1, "the runtime never refreshes while the window is attached");
        assert_eq!(seen[0].0, "/v1/desktop/machine-host/relay-session");
    }

    #[test]
    fn a_refused_refresh_signs_the_machine_out() {
        let dir = tempfile::tempdir().unwrap();
        machine_account::save(dir.path(), &session("u1", "one", now_ms() + 1_000)).unwrap();
        let (base, _, handle) = service(vec![(401, json!({ "error": "invalid_refresh_token" }))]);
        let link = AccountLink::with_api(dir.path().into(), [7; 32], None, Api::new(&base));
        assert!(link.session().err().unwrap().is::<Revoked>());
        handle.join().unwrap();
        assert_eq!(link.ended(), Some(Ended::SignedOut));
        assert!(machine_account::load(dir.path()).unwrap().is_none());
    }
}
