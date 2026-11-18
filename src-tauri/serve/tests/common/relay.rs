//! A relay that runs inside the test process (PRO-358): a director and a
//! cell that speak the relay wire the runtime and the desktop speak, so the
//! machine routes are tested in CI without the hosted relay.
//!
//! What it does, as the hosted relay does it (docs/MACHINES.md "As built
//! (PRO-341)" and "As built (PRO-345)"):
//!
//! - The director assigns a host its cell (`POST /v1/assign`) and resolves a
//!   resume credential to it (`POST /v1/resolve`; 403 for a credential it
//!   does not hold).
//! - The cell registers a host on `/v1/host/control`: `host-hello`, then a
//!   host challenge sealed to the host key with NaCl `crypto_box`, which only
//!   the holder of that key can answer, and the HMAC it answers with is
//!   checked before `host-hello-ack`. Then `invite-create`,
//!   `device-revoke`, `device-credential-install` (and its status) and
//!   `device-resume-confirm`, a ping every 20 s, and `conn-open` for each
//!   client connection.
//! - A client connects on `/v1/connect/<relayHostId>` with `relay-auth`. An
//!   invite is good once; a resume token is matched by its hash, the
//!   current one or the one it replaced. Each admitted connection gets its
//!   own host data leg (`/v1/host/data/<connId>`, `host-data-auth` with the
//!   ticket and the registration's generation); `relay-hello` goes to the
//!   client only once the host has attached, and from then on frames pass
//!   verbatim both ways. The relay never sees plaintext.
//! - Close codes keep their meanings: 4401 the credential is refused (the
//!   client deletes it), 4404 the host is offline (the client retries),
//!   4408 the peer dropped. A revoked device's connections are closed with
//!   4401 and its resume credential is gone.
//!
//! Any relay token and any attach ticket is accepted (there is no API
//! here); a token's claims are read for the host proof's identity.
//! [`TestRelay::relay_token`] makes one. Invites, credentials and the
//! assignment outlive [`TestRelay::stop`], as the hosted relay keeps them in
//! Redis; the host registrations and connections do not.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use futures_util::stream::SplitStream;
use futures_util::{SinkExt, StreamExt};
use raccoon_lib::cloud_agents::crypto::random_bytes;
use raccoon_lib::relay_e2ee::{host_id_of, random_token, token_hash};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;

/// `HOST_OFFLINE`: the client keeps its credential and retries.
pub const HOST_OFFLINE: u16 = 4404;
/// `BAD_OUTER_CREDENTIAL`: the client deletes its credential.
pub const CREDENTIAL_REFUSED: u16 = 4401;
const PEER_DROPPED: u16 = 4408;
const WRONG_CELL: u16 = 4409;
const DRAINING: u16 = 4503;
const STALE_GENERATION: u16 = 4101;
const RUNTIME_UNAVAILABLE: u16 = 4100;

const HOST_ATTACH_DEADLINE: Duration = Duration::from_secs(15);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const PING_INTERVAL: Duration = Duration::from_secs(20);
const CHALLENGE_WINDOW_MS: i64 = 8_000;
const LEASE_MS: i64 = 60_000;
const INVITE_TTL_MS: i64 = 10 * 60_000;
const INVITE_MAX_ATTEMPTS: u64 = 5;
const RESUME_TTL_MS: i64 = 30 * 24 * 60 * 60_000;
const GRACE_TTL_MS: i64 = 10 * 60_000;
/// The hosted cell's WebSocket payload limit (pairing/wire.rs mirrors it).
const MAX_PAYLOAD: usize = 1024 * 1024;
/// The assignment epoch the director hands out.
const ASSIGNMENT_EPOCH: u64 = 1;

type Socket = WebSocketStream<TcpStream>;

/// What a socket's writer is asked to do.
enum Out {
    Frame(Message),
    Close(u16, &'static str),
}

type Tx = mpsc::UnboundedSender<Out>;

fn text(value: Value) -> Out {
    Out::Frame(Message::Text(value.to_string().into()))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// 32 bytes as 43 base64url characters, as every relay credential is.
fn base64url_32(value: &str) -> bool {
    value.len() == 43 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn opaque_id(value: &Value) -> Option<String> {
    value.as_str().filter(|value| !value.is_empty() && value.len() <= 128).map(str::to_string)
}

/// The claims of a relay token: who registers, and for which host.
#[derive(Clone)]
struct Claims {
    user_id: String,
    profile_id: String,
    organization_id: String,
    relay_host_id: String,
    runtime_generation: u64,
}

fn claims(token: &str) -> Option<Claims> {
    let payload = token.split('.').nth(1)?;
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?).ok()?;
    let text = |name: &str| claims[name].as_str().map(str::to_string);
    Some(Claims {
        user_id: text("sub")?,
        profile_id: text("cloudProfileId")?,
        organization_id: text("organizationId").unwrap_or_default(),
        relay_host_id: text("relayHostId")?,
        runtime_generation: claims["runtimeGeneration"].as_u64().unwrap_or(0),
    })
}

fn bearer(headers: &[(String, String)]) -> Option<String> {
    headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .and_then(|(_, value)| value.strip_prefix("Bearer ").map(str::to_string))
}

struct Invite {
    relay_host_id: String,
    relay_device_id: String,
    expires_at: i64,
    redeemed: bool,
}

struct Credential {
    current_hash: String,
    current_version: u64,
    resume_expires_at: i64,
    grace_hash: Option<String>,
    grace_expires_at: Option<i64>,
}

/// A resume token matched to a device's credential.
#[derive(Clone)]
struct ResumeMatch {
    relay_device_id: String,
    accepted_as: &'static str,
    current_version: u64,
    resume_expires_at: i64,
    grace_expires_at: Option<i64>,
}

struct Host {
    control: Tx,
    /// The registration's generation, which a data leg must name.
    generation: u64,
    lease_expires_at: i64,
}

struct Connection {
    relay_host_id: String,
    relay_device_id: String,
    conn_ticket: String,
    resume: Option<ResumeMatch>,
    client: Tx,
    host: Option<Tx>,
    /// `relay-hello`, released when the host attaches.
    hello: Option<Value>,
}

/// How one client `relay-auth` went: the device and credential kind, or the
/// close code it was refused with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Attach {
    Admitted { relay_device_id: String, kind: &'static str },
    Refused(u16),
}

#[derive(Default)]
struct State {
    // Kept across a restart, as the hosted relay keeps them in Redis.
    invites: HashMap<String, Invite>,
    credentials: HashMap<(String, String), Credential>,
    /// Committed installs by host and request id, answered again on a retry.
    installs: HashMap<(String, String), Value>,
    confirms: HashMap<(String, String), Value>,
    /// Hosts the director assigned to this cell.
    placements: HashMap<String, u64>,
    /// The newest runtime generation each host registered with.
    fences: HashMap<String, u64>,
    next_generation: u64,
    revoked: Vec<(String, String)>,
    attaches: Vec<(String, Attach)>,
    /// Host data legs attached, per host.
    data_legs: HashMap<String, usize>,
    // Gone with the relay process.
    /// Bumped by each stop, so a task of a stopped relay changes nothing.
    incarnation: u64,
    hosts: HashMap<String, Host>,
    connections: HashMap<String, Connection>,
}

impl State {
    fn match_resume(&self, relay_host_id: &str, token: &str, now: i64) -> Option<ResumeMatch> {
        let hash = token_hash(token);
        self.credentials.iter().find_map(|((host, device), credential)| {
            if host != relay_host_id {
                return None;
            }
            let accepted_as = if credential.current_hash == hash && credential.resume_expires_at > now {
                "current"
            } else if credential.grace_hash.as_deref() == Some(hash.as_str()) && credential.grace_expires_at.unwrap_or(0) > now {
                "grace"
            } else {
                return None;
            };
            Some(ResumeMatch {
                relay_device_id: device.clone(),
                accepted_as,
                current_version: credential.current_version,
                resume_expires_at: credential.resume_expires_at,
                grace_expires_at: credential.grace_expires_at,
            })
        })
    }

    /// Admit a client to a registered host with `credential`, and ask the
    /// host for a data leg (`conn-open`): the connection id, the device and
    /// the credential kind, or the close code it is refused with.
    fn open_connection(&mut self, relay_host_id: &str, credential: &str, ticketed: bool, tx: &Tx) -> Result<(String, String, &'static str), u16> {
        let now = now_ms();
        let offline = if ticketed { RUNTIME_UNAVAILABLE } else { HOST_OFFLINE };
        let Some((control, lease_expires_at)) = self.hosts.get(relay_host_id).map(|host| (host.control.clone(), host.lease_expires_at)) else { return Err(offline) };
        // An invite is good once; otherwise the token is a resume credential.
        let invite = self.invites.get_mut(credential).filter(|invite| invite.relay_host_id == relay_host_id && !invite.redeemed && invite.expires_at > now).map(|invite| {
            invite.redeemed = true;
            invite.relay_device_id.clone()
        });
        let (relay_device_id, resume) = match invite {
            Some(device) => (device, None),
            None => match self.match_resume(relay_host_id, credential, now) {
                Some(resume) => (resume.relay_device_id.clone(), Some(resume)),
                None => return Err(CREDENTIAL_REFUSED),
            },
        };
        let kind = if resume.is_some() { "resume" } else { "invite" };
        let hello = match &resume {
            None => json!({ "type": "relay-hello", "ok": true, "credentialKind": "invite", "leaseExpiresAt": lease_expires_at }),
            Some(resume) => {
                let mut hello = json!({
                    "type": "relay-hello",
                    "ok": true,
                    "credentialKind": "resume",
                    "leaseExpiresAt": lease_expires_at,
                    "acceptedCredentialVersion": resume.current_version,
                    "acceptedAs": resume.accepted_as,
                    "resumeExpiresAt": resume.resume_expires_at,
                });
                if let Some(expires) = resume.grace_expires_at {
                    hello["graceExpiresAt"] = json!(expires);
                }
                hello
            }
        };
        let conn_id = hex(&random_bytes::<16>());
        let conn_ticket = random_token();
        let open = json!({ "type": "conn-open", "connId": conn_id, "connTicket": conn_ticket, "kind": kind, "relayDeviceId": relay_device_id, "attachDeadlineMs": HOST_ATTACH_DEADLINE.as_millis() as u64 });
        if control.send(text(open)).is_err() {
            return Err(offline);
        }
        let connection = Connection { relay_host_id: relay_host_id.to_string(), relay_device_id: relay_device_id.clone(), conn_ticket, resume, client: tx.clone(), host: None, hello: Some(hello) };
        self.connections.insert(conn_id.clone(), connection);
        Ok((conn_id, relay_device_id, kind))
    }

    /// Close both legs of a connection with `code`.
    fn close_connection(&mut self, conn_id: &str, code: u16, reason: &'static str) {
        if let Some(connection) = self.connections.remove(conn_id) {
            let _ = connection.client.send(Out::Close(code, reason));
            if let Some(host) = connection.host {
                let _ = host.send(Out::Close(code, reason));
            }
        }
    }
}

/// The director and the cell, on two loopback ports that stay the same
/// across [`Self::stop`] and [`Self::start_again`].
pub struct TestRelay {
    state: Arc<Mutex<State>>,
    director_port: u16,
    cell_port: u16,
    runtime: Mutex<Option<tokio::runtime::Runtime>>,
}

impl TestRelay {
    pub fn start() -> Self {
        let director = std::net::TcpListener::bind("127.0.0.1:0").expect("bind the test director");
        let cell = std::net::TcpListener::bind("127.0.0.1:0").expect("bind the test cell");
        let relay = Self {
            state: Arc::new(Mutex::new(State { next_generation: 1, ..State::default() })),
            director_port: director.local_addr().unwrap().port(),
            cell_port: cell.local_addr().unwrap().port(),
            runtime: Mutex::new(None),
        };
        relay.serve(director, cell);
        relay
    }

    /// `http://127.0.0.1:<port>`: a relay link's `directorUrl`.
    pub fn director_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.director_port)
    }

    /// The cell the director assigns every host.
    pub fn cell_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.cell_port)
    }

    /// A relay token for `relay_host_id` that this relay accepts: a JWT whose
    /// claims the runtime reads (`token_identity`) and binds its host proof to.
    pub fn relay_token(relay_host_id: &str, runtime_generation: u64) -> String {
        let seconds = now_ms() / 1000;
        let header = URL_SAFE_NO_PAD.encode(json!({ "alg": "none", "typ": "JWT" }).to_string());
        let claims = URL_SAFE_NO_PAD.encode(
            json!({
                "sub": "user-test-relay",
                "cloudProfileId": "profile-test-relay",
                "organizationId": "org-test-relay",
                "relayHostId": relay_host_id,
                "runtimeGeneration": runtime_generation,
                "iat": seconds,
                "exp": seconds + 24 * 3600,
            })
            .to_string(),
        );
        format!("{header}.{claims}.test-relay")
    }

    /// The relay goes away: both ports close and every host registration and
    /// connection drops at once, with no close frame.
    pub fn stop(&self) {
        if let Some(runtime) = self.runtime.lock().unwrap().take() {
            runtime.shutdown_background();
        }
        let mut state = self.state.lock().unwrap();
        state.incarnation += 1;
        state.hosts.clear();
        state.connections.clear();
    }

    /// Back on the same ports, with the invites and credentials it had.
    pub fn start_again(&self) {
        assert!(self.runtime.lock().unwrap().is_none(), "the test relay is already running");
        let director = bind_again(self.director_port);
        let cell = bind_again(self.cell_port);
        self.serve(director, cell);
    }

    fn serve(&self, director: std::net::TcpListener, cell: std::net::TcpListener) {
        director.set_nonblocking(true).unwrap();
        cell.set_nonblocking(true).unwrap();
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name("test-relay").enable_all().build().unwrap();
        let incarnation = self.state.lock().unwrap().incarnation;
        let relay = Relay { state: self.state.clone(), cell_url: self.cell_url(), incarnation };
        runtime.spawn(relay.clone().director(director));
        runtime.spawn(relay.cell(cell));
        *self.runtime.lock().unwrap() = Some(runtime);
    }

    /// Every invite minted for `relay_device_id`: its token and whether it
    /// was redeemed.
    pub fn invites(&self, relay_device_id: &str) -> Vec<(String, bool)> {
        let state = self.state.lock().unwrap();
        state.invites.iter().filter(|(_, invite)| invite.relay_device_id == relay_device_id).map(|(token, invite)| (token.clone(), invite.redeemed)).collect()
    }

    /// The device's installed resume credential: its token hash and version.
    pub fn credential(&self, relay_host_id: &str, relay_device_id: &str) -> Option<(String, u64)> {
        let state = self.state.lock().unwrap();
        state.credentials.get(&(relay_host_id.to_string(), relay_device_id.to_string())).map(|credential| (credential.current_hash.clone(), credential.current_version))
    }

    /// Whether the host sent `device-revoke` for the device.
    pub fn revoked(&self, relay_host_id: &str, relay_device_id: &str) -> bool {
        self.state.lock().unwrap().revoked.iter().any(|(host, device)| host == relay_host_id && device == relay_device_id)
    }

    /// Every client `relay-auth` for the host so far, in order.
    pub fn attaches(&self, relay_host_id: &str) -> Vec<Attach> {
        self.state.lock().unwrap().attaches.iter().filter(|(host, _)| host == relay_host_id).map(|(_, attach)| attach.clone()).collect()
    }

    /// Host data legs the host attached so far.
    pub fn data_legs(&self, relay_host_id: &str) -> usize {
        self.state.lock().unwrap().data_legs.get(relay_host_id).copied().unwrap_or(0)
    }

    /// The device's open connections.
    pub fn connections(&self, relay_device_id: &str) -> usize {
        self.state.lock().unwrap().connections.values().filter(|connection| connection.relay_device_id == relay_device_id).count()
    }

    /// The host's live registration generation, while it is registered.
    pub fn registration(&self, relay_host_id: &str) -> Option<u64> {
        self.state.lock().unwrap().hosts.get(relay_host_id).map(|host| host.generation)
    }
}

impl Drop for TestRelay {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The port again: a socket the relay closed may hold it in TIME_WAIT for a
/// moment (std sets SO_REUSEADDR, but be patient anyway).
fn bind_again(port: u16) -> std::net::TcpListener {
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match std::net::TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => return listener,
            Err(error) => {
                assert!(Instant::now() < deadline, "the test relay could not bind port {port} again: {error}");
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }
}

/// Connect to `cell_url` as a client with `credential` (`relay-auth` v1)
/// and read the relay's `relay-hello`: the credential kind it accepted, or
/// the close code it refused with. An accepted connection is closed at once.
pub async fn try_attach(cell_url: &str, relay_host_id: &str, credential: &str) -> Result<String, Option<u16>> {
    let url = format!("{}/v1/connect/{relay_host_id}", cell_url.replacen("http://", "ws://", 1));
    let (mut socket, _) = tokio_tungstenite::connect_async(url).await.map_err(|_| None)?;
    socket.send(Message::Text(json!({ "type": "relay-auth", "v": 1, "mode": "connect", "credential": credential }).to_string().into())).await.map_err(|_| None)?;
    let hello = loop {
        match tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => break serde_json::from_str::<Value>(&text).map_err(|_| None)?,
            Ok(Some(Ok(Message::Close(frame)))) => return Err(frame.map(|frame| u16::from(frame.code))),
            Ok(Some(Ok(_))) => continue,
            _ => return Err(None),
        }
    };
    let _ = socket.close(None).await;
    if hello["type"] == "relay-hello" && hello["ok"] == true {
        Ok(hello["credentialKind"].as_str().unwrap_or_default().to_string())
    } else {
        Err(hello["code"].as_u64().map(|code| code as u16))
    }
}

/// What every task of one running relay shares.
#[derive(Clone)]
struct Relay {
    state: Arc<Mutex<State>>,
    cell_url: String,
    incarnation: u64,
}

impl Relay {
    /// The state, if this relay is still the running one.
    fn live(&self) -> Option<std::sync::MutexGuard<'_, State>> {
        let state = self.state.lock().unwrap();
        (state.incarnation == self.incarnation).then_some(state)
    }

    // ------------------------------------------------------------ director

    async fn director(self, listener: std::net::TcpListener) {
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            tokio::spawn(self.clone().http(stream));
        }
    }

    async fn http(self, mut stream: TcpStream) {
        let Ok(Ok(Some(request))) = tokio::time::timeout(HANDSHAKE_TIMEOUT, read_request(&mut stream)).await else { return };
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        let (status, answer) = match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/v1/assign") => self.assign(&request.headers, &body),
            ("POST", "/v1/resolve") => self.resolve(&body),
            _ => (404, json!({ "error": "not found" })),
        };
        let reason = match status {
            200 => "OK",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            _ => "Not Found",
        };
        let answer = answer.to_string();
        let response = format!("HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{answer}", answer.len());
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
    }

    fn assign(&self, headers: &[(String, String)], body: &Value) -> (u16, Value) {
        let Some(claims) = bearer(headers).and_then(|token| claims(&token)) else { return (401, json!({ "error": "unauthorized" })) };
        if body["v"] != 1 || body["relayHostId"] != claims.relay_host_id.as_str() {
            return (400, json!({ "error": "bad request" }));
        }
        let epoch = *self.state.lock().unwrap().placements.entry(claims.relay_host_id.clone()).or_insert(ASSIGNMENT_EPOCH);
        let lease = now_ms() + LEASE_MS;
        (200, json!({ "v": 1, "cellUrl": self.cell_url, "assignmentEpoch": epoch, "lease": format!("{}.{epoch}.{lease}", claims.relay_host_id) }))
    }

    /// The phone's question: the resume token is the credential, checked
    /// before any placement is disclosed.
    fn resolve(&self, body: &Value) -> (u16, Value) {
        let (Some(relay_host_id), Some(token)) = (body["relayHostId"].as_str(), body["resumeToken"].as_str()) else { return (400, json!({ "error": "bad request" })) };
        if body["v"] != 1 || !base64url_32(token) {
            return (400, json!({ "error": "bad request" }));
        }
        let state = self.state.lock().unwrap();
        if state.match_resume(relay_host_id, token, now_ms()).is_none() {
            return (403, json!({ "error": "forbidden" }));
        }
        match state.placements.get(relay_host_id) {
            Some(epoch) => (200, json!({ "v": 1, "cellUrl": self.cell_url, "assignmentEpoch": epoch, "leaseExpiresAt": now_ms() + LEASE_MS })),
            None => (404, json!({ "error": "not found" })),
        }
    }

    // ------------------------------------------------------------ cell

    async fn cell(self, listener: std::net::TcpListener) {
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            tokio::spawn(self.clone().socket(stream));
        }
    }

    // The handshake callback's error type is fixed by tungstenite's server API.
    #[allow(clippy::result_large_err)]
    async fn socket(self, stream: TcpStream) {
        let mut target = String::new();
        let mut headers = Vec::new();
        let config = WebSocketConfig::default().max_message_size(Some(MAX_PAYLOAD)).max_frame_size(Some(MAX_PAYLOAD));
        let accepted = tokio_tungstenite::accept_hdr_async_with_config(
            stream,
            |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
                target = request.uri().to_string();
                headers = request.headers().iter().map(|(name, value)| (name.to_string(), value.to_str().unwrap_or_default().to_string())).collect();
                Ok(response)
            },
            Some(config),
        )
        .await;
        let Ok(socket) = accepted else { return };
        let (sink, stream) = socket.split();
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(write_loop(sink, rx));
        // Credentials ride in the first frame, never in a query string.
        if target.contains('?') {
            let _ = tx.send(Out::Close(CREDENTIAL_REFUSED, "query string not accepted"));
        } else if target == "/v1/host/control" {
            self.control(stream, tx, bearer(&headers)).await;
        } else if let Some(conn_id) = target.strip_prefix("/v1/host/data/") {
            self.host_data(stream, tx, conn_id.to_string()).await;
        } else if let Some(relay_host_id) = target.strip_prefix("/v1/connect/") {
            self.client(stream, tx, relay_host_id.to_string()).await;
        } else {
            let _ = tx.send(Out::Close(1008, "not found"));
        }
    }

    /// A host registers: hello, proof of its key, then its commands.
    async fn control(self, mut stream: SplitStream<Socket>, tx: Tx, token: Option<String>) {
        let refuse = |code: u16, reason: &'static str| {
            let _ = tx.send(Out::Close(code, reason));
        };
        let Some(claims) = token.and_then(|token| claims(&token)) else { return refuse(CREDENTIAL_REFUSED, "relay_unauthorized") };
        let Some(hello) = next_json(&mut stream).await else { return };
        let host_key: Option<[u8; 32]> = hello["hostPublicKeyB64"]
            .as_str()
            .and_then(|key| STANDARD.decode(key).ok())
            .and_then(|key| key.try_into().ok());
        let relay_host_id = claims.relay_host_id.clone();
        let Some(host_key) = host_key.filter(|key| {
            hello["type"] == "host-hello" && hello["v"] == 1 && hello["relayHostId"] == relay_host_id.as_str() && host_id_of(key) == relay_host_id && hello["appVersion"].is_string()
        }) else {
            return refuse(CREDENTIAL_REFUSED, "relay_bad_host_hello");
        };
        let epoch = self.state.lock().unwrap().placements.get(&relay_host_id).copied();
        if epoch.is_none() || hello["assignmentEpoch"].as_u64() != epoch {
            return refuse(WRONG_CELL, "relay_stale_assignment_epoch");
        }
        let stale = {
            let mut state = self.state.lock().unwrap();
            let fence = state.fences.entry(relay_host_id.clone()).or_insert(0);
            let stale = claims.runtime_generation < *fence;
            if !stale {
                *fence = claims.runtime_generation;
            }
            stale
        };
        if stale {
            return refuse(STALE_GENERATION, "stale_generation");
        }
        let previous_generation = hello["previousGeneration"].as_u64();
        let resume_requested = hello["controlResumeSecret"].is_string();
        let challenge = HostChallenge::issue(&claims, &self.cell_url, &host_key, epoch.unwrap(), previous_generation, resume_requested);
        let _ = tx.send(text(challenge.frame.clone()));
        let Some(ack) = next_json(&mut stream).await else { return };
        if ack["type"] != "host-challenge-ack" || ack["challengeId"] != challenge.frame["challengeId"] || !challenge.verify(ack["proofB64"].as_str().unwrap_or_default()) {
            return refuse(CREDENTIAL_REFUSED, "relay_bad_host_proof");
        }
        let generation = {
            let Some(mut state) = self.live() else { return };
            let generation = state.next_generation;
            state.next_generation += 1;
            let lease_expires_at = now_ms() + LEASE_MS;
            if let Some(old) = state.hosts.insert(relay_host_id.clone(), Host { control: tx.clone(), generation, lease_expires_at }) {
                let _ = old.control.send(Out::Close(DRAINING, "relay_control_superseded"));
            }
            let _ = tx.send(text(json!({
                "type": "host-hello-ack",
                "v": 1,
                "generation": generation,
                "controlResumeSecret": random_token(),
                "leaseExpiresAt": lease_expires_at,
                "activeConnIds": [],
                "pendingConns": [],
            })));
            generation
        };
        let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + PING_INTERVAL, PING_INTERVAL);
        loop {
            tokio::select! {
                _ = ping.tick() => {
                    let _ = tx.send(text(json!({ "type": "ping", "t": now_ms() })));
                }
                incoming = stream.next() => match incoming {
                    Some(Ok(Message::Text(frame))) => {
                        let command = serde_json::from_str::<Value>(&frame).unwrap_or(Value::Null);
                        if !self.command(&relay_host_id, &tx, &command) {
                            refuse(CREDENTIAL_REFUSED, "relay_unknown_control_message");
                            break;
                        }
                    }
                    Some(Ok(Message::Binary(_))) => {
                        refuse(CREDENTIAL_REFUSED, "relay_binary_control_frame");
                        break;
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => {}
                },
            }
        }
        // Connections stay: the host may come back and serve them. New
        // clients find it offline until it does.
        if let Some(mut state) = self.live() {
            if state.hosts.get(&relay_host_id).is_some_and(|host| host.generation == generation) {
                state.hosts.remove(&relay_host_id);
            }
        }
    }

    /// One control command; false when it is not one.
    fn command(&self, relay_host_id: &str, tx: &Tx, command: &Value) -> bool {
        let now = now_ms();
        let host = relay_host_id.to_string();
        let error = |req_id: &str, code: &str| text(json!({ "type": "control-error", "reqId": req_id, "code": code }));
        match command["type"].as_str().unwrap_or_default() {
            "pong" => command["t"].is_u64(),
            "auth-refresh" => command["relayJwt"].is_string(),
            "invite-create" => {
                let (Some(req_id), Some(device)) = (opaque_id(&command["reqId"]), opaque_id(&command["relayDeviceId"])) else { return false };
                let token = random_token();
                let expires_at = now + INVITE_TTL_MS;
                self.state.lock().unwrap().invites.insert(token.clone(), Invite { relay_host_id: host, relay_device_id: device, expires_at, redeemed: false });
                let _ = tx.send(text(json!({ "type": "invite-created", "reqId": req_id, "inviteToken": token, "expiresAt": expires_at, "maxAttempts": INVITE_MAX_ATTEMPTS })));
                true
            }
            "device-revoke" => {
                let (Some(req_id), Some(device)) = (opaque_id(&command["reqId"]), opaque_id(&command["relayDeviceId"])) else { return false };
                let mut state = self.state.lock().unwrap();
                state.credentials.remove(&(host.clone(), device.clone()));
                state.revoked.push((host.clone(), device.clone()));
                let open: Vec<String> = state.connections.iter().filter(|(_, connection)| connection.relay_host_id == host && connection.relay_device_id == device).map(|(id, _)| id.clone()).collect();
                for conn_id in open {
                    state.close_connection(&conn_id, CREDENTIAL_REFUSED, "relay_device_revoked");
                }
                let _ = tx.send(text(json!({ "type": "device-revoked", "reqId": req_id })));
                true
            }
            "device-credential-install" => {
                let (Some(req_id), Some(device)) = (opaque_id(&command["reqId"]), opaque_id(&command["relayDeviceId"])) else { return false };
                let Some(new_hash) = command["newResumeTokenHash"].as_str().filter(|hash| base64url_32(hash)) else { return false };
                let mode = command["authorization"]["mode"].as_str().unwrap_or_default();
                if command["v"] != 1 || !matches!(mode, "relay-basis" | "authenticated-direct") {
                    return false;
                }
                let mut state = self.state.lock().unwrap();
                let key = (host.clone(), req_id.clone());
                if let Some(committed) = state.installs.get(&key) {
                    let _ = tx.send(text(committed.clone()));
                    return true;
                }
                // `relay-basis` is checkable: the connection is this cell's.
                if mode == "relay-basis" {
                    let basis = command["authorization"]["basisConnId"].as_str().unwrap_or_default();
                    if !state.connections.get(basis).is_some_and(|connection| connection.relay_host_id == host) {
                        let _ = tx.send(error(&req_id, "relay_basis_connection_not_found"));
                        return true;
                    }
                }
                let existing = state.credentials.get(&(host.clone(), device.clone()));
                if let Some(expected) = command["expectedCurrentHash"].as_str() {
                    if existing.is_none_or(|credential| credential.current_hash != expected) {
                        let _ = tx.send(error(&req_id, "relay_credential_version_conflict"));
                        return true;
                    }
                }
                let grace = existing.map(|credential| (credential.current_hash.clone(), now + GRACE_TTL_MS));
                let credential = Credential {
                    current_hash: new_hash.to_string(),
                    current_version: existing.map(|credential| credential.current_version).unwrap_or(0) + 1,
                    resume_expires_at: now + RESUME_TTL_MS,
                    grace_expires_at: grace.as_ref().map(|(_, expires)| *expires),
                    grace_hash: grace.map(|(hash, _)| hash),
                };
                let mut installed = json!({
                    "type": "device-credential-installed",
                    "v": 1,
                    "reqId": req_id,
                    "authorizationMode": mode,
                    "currentVersion": credential.current_version,
                    "resumeExpiresAt": credential.resume_expires_at,
                });
                if let Some(expires) = credential.grace_expires_at {
                    installed["graceExpiresAt"] = json!(expires);
                }
                state.credentials.insert((host, device), credential);
                state.installs.insert(key, installed.clone());
                let _ = tx.send(text(installed));
                true
            }
            "device-credential-install-status" => {
                let Some(req_id) = opaque_id(&command["reqId"]) else { return false };
                let committed = self.state.lock().unwrap().installs.get(&(host, req_id.clone())).cloned();
                let mut answer = json!({ "type": "device-credential-install-status-result", "v": 1, "reqId": req_id });
                match committed {
                    Some(mut result) => {
                        result.as_object_mut().map(|object| object.remove("type"));
                        answer["state"] = json!("committed");
                        answer["result"] = result;
                    }
                    None => answer["state"] = json!("not-found"),
                }
                let _ = tx.send(text(answer));
                true
            }
            "device-resume-confirm" => {
                let (Some(req_id), Some(basis)) = (opaque_id(&command["reqId"]), opaque_id(&command["basisConnId"])) else { return false };
                let mut state = self.state.lock().unwrap();
                if let Some(confirmed) = state.confirms.get(&(host.clone(), req_id.clone())) {
                    let _ = tx.send(text(confirmed.clone()));
                    return true;
                }
                let resume = state.connections.get(&basis).filter(|connection| connection.relay_host_id == host).map(|connection| connection.resume.clone());
                let resume = match resume {
                    None => {
                        let _ = tx.send(error(&req_id, "relay_basis_connection_not_found"));
                        return true;
                    }
                    Some(None) => {
                        let _ = tx.send(error(&req_id, "relay_basis_connection_not_resume"));
                        return true;
                    }
                    Some(Some(resume)) => resume,
                };
                let Some(credential) = state.credentials.get_mut(&(host.clone(), resume.relay_device_id.clone())) else {
                    let _ = tx.send(error(&req_id, "relay_credential_not_found"));
                    return true;
                };
                let renewed = resume.accepted_as == "current";
                if renewed {
                    credential.resume_expires_at = now + RESUME_TTL_MS;
                    credential.grace_hash = None;
                    credential.grace_expires_at = None;
                }
                let mut confirmed = json!({
                    "type": "device-resume-confirmed",
                    "v": 1,
                    "reqId": req_id,
                    "currentVersion": credential.current_version,
                    "acceptedAs": resume.accepted_as,
                    "renewed": renewed,
                    "resumeExpiresAt": credential.resume_expires_at,
                });
                if let Some(expires) = credential.grace_expires_at {
                    confirmed["graceExpiresAt"] = json!(expires);
                }
                state.confirms.insert((host, req_id), confirmed.clone());
                let _ = tx.send(text(confirmed));
                true
            }
            _ => false,
        }
    }

    /// A client: its credential, then a splice to its own host data leg.
    async fn client(self, mut stream: SplitStream<Socket>, tx: Tx, relay_host_id: String) {
        let refuse = |code: u16| {
            let _ = tx.send(text(json!({ "type": "relay-hello", "ok": false, "code": code })));
            let _ = tx.send(Out::Close(code, "relay_phone_rejected"));
        };
        let Some(auth) = next_json(&mut stream).await else { return };
        let credential = auth["credential"].as_str().filter(|credential| base64url_32(credential)).map(str::to_string);
        let ticketed = auth["v"] == 2 && auth["attachTicket"].as_str().is_some_and(|ticket| !ticket.is_empty() && ticket.len() <= 4096);
        let (Some(credential), true) = (credential, auth["type"] == "relay-auth" && auth["mode"] == "connect" && (auth["v"] == 1 || ticketed)) else {
            return refuse(CREDENTIAL_REFUSED);
        };
        let admitted = self.admit(&relay_host_id, &credential, ticketed, &tx);
        let conn_id = match admitted {
            Ok(conn_id) => conn_id,
            Err(code) => return refuse(code),
        };
        // A host that never attaches: the client hears it is offline.
        let (deadline_relay, deadline_conn) = (self.clone(), conn_id.clone());
        tokio::spawn(async move {
            tokio::time::sleep(HOST_ATTACH_DEADLINE).await;
            if let Some(mut state) = deadline_relay.live() {
                if state.connections.get(&deadline_conn).is_some_and(|connection| connection.host.is_none()) {
                    let code = if ticketed { RUNTIME_UNAVAILABLE } else { HOST_OFFLINE };
                    state.close_connection(&deadline_conn, code, "relay_host_did_not_attach");
                }
            }
        });
        let code = self.pump(&mut stream, &conn_id, |connection| connection.host.clone()).await;
        self.end_splice(&conn_id, code);
    }

    /// The connection id for an admitted client, or the code it is refused with.
    fn admit(&self, relay_host_id: &str, credential: &str, ticketed: bool, tx: &Tx) -> Result<String, u16> {
        let Some(mut state) = self.live() else { return Err(HOST_OFFLINE) };
        let result = state.open_connection(relay_host_id, credential, ticketed, tx);
        let attach = match &result {
            Ok((_, relay_device_id, kind)) => Attach::Admitted { relay_device_id: relay_device_id.clone(), kind },
            Err(code) => Attach::Refused(*code),
        };
        state.attaches.push((relay_host_id.to_string(), attach));
        result.map(|(conn_id, _, _)| conn_id)
    }

    /// The host's data leg for one connection: its ticket, then the splice.
    async fn host_data(self, mut stream: SplitStream<Socket>, tx: Tx, conn_id: String) {
        let Some(auth) = next_json(&mut stream).await else { return };
        let attached = {
            let Some(mut state) = self.live() else { return };
            let generation = state.connections.get(&conn_id).and_then(|connection| state.hosts.get(&connection.relay_host_id)).map(|host| host.generation);
            match state.connections.get_mut(&conn_id) {
                None => Err((PEER_DROPPED, "relay_unknown_connection")),
                Some(connection) if connection.host.is_some() => Err((CREDENTIAL_REFUSED, "relay_connection_already_attached")),
                Some(connection)
                    if auth["type"] != "host-data-auth"
                        || auth["v"] != 1
                        || auth["connTicket"] != connection.conn_ticket.as_str()
                        || generation.is_none()
                        || auth["generation"].as_u64() != generation =>
                {
                    Err((CREDENTIAL_REFUSED, "relay_bad_host_data_auth"))
                }
                Some(connection) => {
                    connection.host = Some(tx.clone());
                    // From here the relay injects nothing: the next frame
                    // each side reads is the E2EE handshake.
                    if let Some(hello) = connection.hello.take() {
                        let _ = connection.client.send(text(hello));
                    }
                    let host = connection.relay_host_id.clone();
                    *state.data_legs.entry(host).or_default() += 1;
                    Ok(())
                }
            }
        };
        if let Err((code, reason)) = attached {
            let _ = tx.send(Out::Close(code, reason));
            return;
        }
        let code = self.pump(&mut stream, &conn_id, |connection| Some(connection.client.clone())).await;
        self.end_splice(&conn_id, code);
    }

    /// Forward this leg's frames verbatim to the other leg of `conn_id`
    /// until it closes: its close code, if it sent one.
    async fn pump(&self, stream: &mut SplitStream<Socket>, conn_id: &str, peer: impl Fn(&Connection) -> Option<Tx>) -> Option<u16> {
        loop {
            match stream.next().await {
                Some(Ok(frame @ (Message::Text(_) | Message::Binary(_)))) => {
                    let to = self.state.lock().unwrap().connections.get(conn_id).and_then(&peer);
                    if let Some(to) = to {
                        let _ = to.send(Out::Frame(frame));
                    }
                }
                Some(Ok(Message::Close(frame))) => return frame.map(|frame| u16::from(frame.code)),
                Some(Ok(_)) => {}
                Some(Err(_)) | None => return None,
            }
        }
    }

    /// One leg ended: close the other, with its code when it is a relay code.
    fn end_splice(&self, conn_id: &str, code: Option<u16>) {
        let code = code.filter(|code| (4000..=4999).contains(code)).unwrap_or(PEER_DROPPED);
        if let Some(mut state) = self.live() {
            state.close_connection(conn_id, code, "relay_peer_closed");
        }
    }
}

async fn write_loop(mut sink: futures_util::stream::SplitSink<Socket, Message>, mut outgoing: mpsc::UnboundedReceiver<Out>) {
    while let Some(out) = outgoing.recv().await {
        match out {
            Out::Frame(frame) => {
                if sink.send(frame).await.is_err() {
                    return;
                }
            }
            Out::Close(code, reason) => {
                let _ = sink.send(Message::Close(Some(CloseFrame { code: code.into(), reason: reason.into() }))).await;
                let _ = sink.close().await;
                return;
            }
        }
    }
}

/// The next text frame as JSON, within the handshake timeout.
async fn next_json(stream: &mut SplitStream<Socket>) -> Option<Value> {
    let deadline = tokio::time::Instant::now() + HANDSHAKE_TIMEOUT;
    loop {
        match tokio::time::timeout_at(deadline, stream.next()).await.ok()?? {
            Ok(Message::Text(frame)) => return serde_json::from_str(&frame).ok(),
            Ok(Message::Ping(_) | Message::Pong(_)) => continue,
            _ => return None,
        }
    }
}

/// One HTTP/1.1 request to the director.
struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

/// One HTTP/1.1 request, its body by content-length; `None` when the peer
/// closed first or sent something else.
async fn read_request(stream: &mut TcpStream) -> std::io::Result<Option<HttpRequest>> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 4096];
    let end = loop {
        if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
            break end;
        }
        if buffer.len() > 64 * 1024 {
            return Ok(None);
        }
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = String::from_utf8_lossy(&buffer[..end]).into_owned();
    let mut lines = head.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let (method, path) = (request_line.next().unwrap_or_default().to_string(), request_line.next().unwrap_or_default().to_string());
    let headers: Vec<(String, String)> = lines.filter_map(|line| line.split_once(':')).map(|(name, value)| (name.trim().to_string(), value.trim().to_string())).collect();
    let length = headers.iter().find(|(name, _)| name.eq_ignore_ascii_case("content-length")).and_then(|(_, value)| value.parse::<usize>().ok()).unwrap_or(0);
    let mut body = buffer[end + 4..].to_vec();
    while body.len() < length {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(length);
    Ok(Some(HttpRequest { method, path, headers, body }))
}

/// The cell's host challenge (the hosted relay's `host-proof`): a random
/// secret sealed to the host key with a transcript binding it to this cell,
/// this host and the token's identity. Only the key's holder can open it,
/// and it proves so with an HMAC over the transcript keyed by the secret.
struct HostChallenge {
    frame: Value,
    transcript: Vec<u8>,
    secret: [u8; 32],
    expires_at: i64,
}

impl HostChallenge {
    fn issue(claims: &Claims, relay_origin: &str, host_key: &[u8; 32], assignment_epoch: u64, previous_generation: Option<u64>, resume_requested: bool) -> Self {
        let ephemeral = random_bytes::<32>();
        let ephemeral_public = nacl::public_key(&ephemeral);
        let nonce = random_bytes::<24>();
        let secret = random_bytes::<32>();
        let challenge_id = hex(&random_bytes::<16>());
        let issued_at = now_ms();
        let expires_at = issued_at + CHALLENGE_WINDOW_MS;
        let previous = previous_generation.map(|generation| generation.to_be_bytes().to_vec()).unwrap_or_default();
        let fields: [(&str, &[u8]); 16] = [
            ("protocol", b"terminalx-relay-host-proof/v1"),
            ("version", &[1]),
            ("relayOrigin", relay_origin.as_bytes()),
            ("relayEphemeralPublicKey", &ephemeral_public),
            ("challengeNonce", &nonce),
            ("challengeId", challenge_id.as_bytes()),
            ("issuedAt", &(issued_at as u64).to_be_bytes()),
            ("expiresAt", &(expires_at as u64).to_be_bytes()),
            ("userId", claims.user_id.as_bytes()),
            ("profileId", claims.profile_id.as_bytes()),
            ("organizationId", claims.organization_id.as_bytes()),
            ("relayHostId", claims.relay_host_id.as_bytes()),
            ("hostPublicKey", host_key),
            ("assignmentEpoch", &assignment_epoch.to_be_bytes()),
            ("previousGeneration", &previous),
            ("resumeRequested", &[u8::from(resume_requested)]),
        ];
        let mut transcript = Vec::new();
        for (name, value) in fields {
            transcript.extend_from_slice(&(name.len() as u32).to_be_bytes());
            transcript.extend_from_slice(name.as_bytes());
            transcript.extend_from_slice(&(value.len() as u32).to_be_bytes());
            transcript.extend_from_slice(value);
        }
        let mut plaintext = b"terminalx-relay-host-challenge/v1\0".to_vec();
        plaintext.extend_from_slice(&(transcript.len() as u32).to_be_bytes());
        plaintext.extend_from_slice(&transcript);
        plaintext.extend_from_slice(&secret);
        let sealed = nacl::seal_box(&plaintext, &nonce, host_key, &ephemeral);
        let frame = json!({
            "type": "host-challenge",
            "challengeId": challenge_id,
            "relayEphemeralPublicKeyB64": STANDARD.encode(ephemeral_public),
            "nonceB64": STANDARD.encode(nonce),
            "ciphertextB64": STANDARD.encode(sealed),
            "expiresAt": expires_at,
        });
        Self { frame, transcript, secret, expires_at }
    }

    fn verify(&self, proof_b64: &str) -> bool {
        let expected = nacl::hmac_sha256(&self.secret, &[b"terminalx-relay-host-proof/v1\0ack\0".as_slice(), self.transcript.as_slice()]);
        now_ms() <= self.expires_at && STANDARD.encode(expected) == proof_b64
    }
}

/// NaCl's `crypto_box` and HMAC-SHA-256, from the crates the runtime opens
/// and answers the host challenge with (`relay_e2ee::answer_relay_challenge`).
mod nacl {
    use crypto_box::aead::{generic_array::GenericArray, Aead};
    use crypto_box::{PublicKey, SalsaBox, SecretKey};
    use hmac::{Hmac, Mac};
    use sha2::Sha256;

    pub fn public_key(secret: &[u8; 32]) -> [u8; 32] {
        *SecretKey::from(*secret).public_key().as_bytes()
    }

    /// `plaintext` sealed from `secret` to `public` under `nonce`.
    pub fn seal_box(plaintext: &[u8], nonce: &[u8; 24], public: &[u8; 32], secret: &[u8; 32]) -> Vec<u8> {
        SalsaBox::new(&PublicKey::from(*public), &SecretKey::from(*secret)).encrypt(GenericArray::from_slice(nonce), plaintext).expect("crypto_box seals")
    }

    pub fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC takes any key length");
        for part in parts {
            mac.update(part);
        }
        mac.finalize().into_bytes().into()
    }
}
