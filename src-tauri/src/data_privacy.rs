//! The local owner's network policy. Credentials are retained while access is off.
//!
//! HTTP holds a read lease until its request completes. Relay TCP I/O holds a
//! lease for each poll; disabling cancels and permanently invalidates existing
//! streams, including TLS/WS handshakes and otherwise idle connections.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Condvar, Mutex, OnceLock, RwLock};
use std::task::{Context, Poll};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_util::sync::CancellationToken;

pub const MESSAGE: &str = "Turned off by data privacy mode";
pub const DOMAIN: &str = "com.terminalx.next";
pub const MANAGED_KEY: &str = "DataPrivacyMode";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub enabled: bool,
    pub managed: bool,
}

struct State {
    status: Status,
    epoch: u64,
    cancel: CancellationToken,
    forwarding: Option<Forwarding>,
}

pub struct Policy {
    id: String,
    state: RwLock<State>,
    updating: Mutex<()>,
    writers: Mutex<usize>,
    drained: Condvar,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            state: RwLock::new(State { status: Status::default(), epoch: 0, cancel: CancellationToken::new(), forwarding: None }),
            updating: Mutex::new(()), writers: Mutex::new(0), drained: Condvar::new(),
        }
    }
}

impl Policy {
    fn status(&self) -> Status { self.state.read().unwrap().status }

    // The writer waits for requests already admitted. Once it returns, no
    // old request or socket can send, even if the switch is turned off again.
    fn set(&self, status: Status) {
        let _updating = self.updating.lock().unwrap();
        let mut state = self.state.write().unwrap();
        if status.enabled && !state.status.enabled {
            state.epoch = state.epoch.wrapping_add(1);
            state.cancel.cancel();
            state.cancel = CancellationToken::new();
        }
        state.status = status;
        drop(state);
        if status.enabled {
            let mut writers = self.writers.lock().unwrap();
            while *writers != 0 { writers = self.drained.wait(writers).unwrap(); }
        }
    }
}

/// Authority captured when a phone connects or a share is created. A toggle
/// permanently expires it, including queued work, even after privacy is off.
#[derive(Clone, Serialize, Deserialize)]
pub struct Ticket {
    #[serde(skip, default = "shared_policy")]
    policy: Arc<Policy>,
    owner: String,
    epoch: Option<u64>,
    // Captured with the originating ticket, never looked up after queuing.
    #[serde(skip)]
    forwarding: Option<Forwarding>,
}

/// An owner-issued policy generation, bound to that runtime incarnation.
/// Serializing the stamp does not transfer its local Arc/positive authority.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Forwarding {
    pub runtime: String,
    owner: String,
    epoch: Option<u64>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OwnerStatus {
    #[serde(flatten)]
    pub status: Status,
    #[serde(default)]
    pub network_authority: Option<Forwarding>,
}

pub(crate) fn owner_status(runtime: &str) -> OwnerStatus {
    let status = refresh();
    let ticket = Ticket::default();
    OwnerStatus { status, network_authority: Some(Forwarding { runtime: runtime.into(), owner: ticket.owner, epoch: ticket.epoch }) }
}

pub(crate) fn install_forwarding(authority: Option<Forwarding>) {
    policy().state.write().unwrap().forwarding = authority;
}

impl Forwarding {
    pub(crate) fn admit(self, runtime: &str) -> Ticket {
        if self.runtime != runtime { return Ticket::denied(); }
        Ticket { policy: policy().clone(), owner: self.owner, epoch: self.epoch, forwarding: None }
    }
}

fn shared_policy() -> Arc<Policy> { policy().clone() }

impl std::fmt::Debug for Ticket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Ticket").field("owner", &self.owner).field("epoch", &self.epoch).finish()
    }
}
impl PartialEq for Ticket {
    fn eq(&self, other: &Self) -> bool { self.owner == other.owner && self.epoch == other.epoch }
}
impl Eq for Ticket {}

impl Default for Ticket {
    fn default() -> Self { Self::with_policy(policy().clone()) }
}

impl Ticket {
    /// A forwarded/held request may only narrow the receiving owner's policy.
    pub(crate) fn denied() -> Self {
        Self { epoch: None, ..Self::default() }
    }
    fn with_policy(policy: Arc<Policy>) -> Self {
        let state = policy.state.read().unwrap();
        let epoch = (!state.status.enabled).then_some(state.epoch);
        let forwarding = state.forwarding.clone();
        drop(state);
        Self { owner: policy.id.clone(), policy, epoch, forwarding }
    }
    pub(crate) fn forwarded(&self, runtime: &str) -> Option<Forwarding> {
        self.forwarding.clone().filter(|authority| self.valid() && authority.runtime == runtime)
    }
    pub fn valid(&self) -> bool {
        let state = self.policy.state.read().unwrap();
        self.owner == self.policy.id && !state.status.enabled && self.epoch == Some(state.epoch)
    }
    pub fn enter(&self) -> anyhow::Result<RemoteWrite> {
        let state = self.policy.state.read().unwrap();
        anyhow::ensure!(self.owner == self.policy.id && !state.status.enabled && self.epoch == Some(state.epoch), MESSAGE);
        *self.policy.writers.lock().unwrap() += 1;
        Ok(RemoteWrite(self.policy.clone()))
    }
}

// Owner operations are synchronous until they explicitly enqueue work. The
// scope carries just privacy authority, never device/attachment locks. Each
// asynchronous writer captures `remote_ticket()` and re-enters it at delivery.
thread_local! {
    static REMOTE: std::cell::RefCell<Option<Ticket>> = const { std::cell::RefCell::new(None) };
}

pub fn remote_ticket() -> Option<Ticket> { REMOTE.with(|ticket| ticket.borrow().clone()) }

pub struct RemoteScope {
    _write: RemoteWrite,
    previous: Option<Ticket>,
    _thread: std::marker::PhantomData<std::rc::Rc<()>>,
}
impl Ticket {
    pub fn scope(&self) -> anyhow::Result<RemoteScope> {
        let write = self.enter()?;
        let previous = REMOTE.with(|ticket| ticket.replace(Some(self.clone())));
        Ok(RemoteScope { _write: write, previous, _thread: Default::default() })
    }
}
impl Drop for RemoteScope {
    fn drop(&mut self) { REMOTE.with(|ticket| ticket.replace(self.previous.take())); }
}

/// Held through the last physical mutation, including PTY paste/draw waits
/// and partial stdio frames. Counted leases allow nested admission without a
/// recursive RwLock deadlock when activation is waiting for existing work.
pub struct RemoteWrite(Arc<Policy>);
impl Drop for RemoteWrite {
    fn drop(&mut self) {
        let mut writers = self.0.writers.lock().unwrap();
        *writers -= 1;
        if *writers == 0 { self.0.drained.notify_all(); }
    }
}

fn policy() -> &'static Arc<Policy> {
    static POLICY: OnceLock<Arc<Policy>> = OnceLock::new();
    POLICY.get_or_init(|| Arc::new(Policy::default()))
}

pub fn enabled() -> bool { policy().status().enabled }

pub fn require_network() -> anyhow::Result<()> {
    anyhow::ensure!(!enabled(), MESSAGE);
    Ok(())
}

#[cfg(any(feature = "desktop", test))]
pub(crate) const TRANSFER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Drain native updater traffic admitted before activation. No lease lives
/// in JavaScript, so closing a window cannot strand the acknowledgement.
/// A timeout drops the entire transport future before releasing admission.
#[cfg(any(feature = "desktop", test))]
pub(crate) async fn transfer<T>(ticket: &Ticket, work: impl Future<Output = anyhow::Result<T>>) -> anyhow::Result<T> {
    let _privacy = ticket.enter()?;
    let result = tokio::time::timeout(TRANSFER_TIMEOUT, work).await??;
    anyhow::ensure!(ticket.valid(), MESSAGE);
    Ok(result)
}

/// Every TerminalX service client, including the relay director, uses this
/// builder. The policy is checked at send time, not when a client is made.
pub fn http_agent() -> ureq::AgentBuilder {
    ureq::AgentBuilder::new().middleware(HttpPolicy(policy().clone()))
}

struct HttpPolicy(Arc<Policy>);

impl ureq::Middleware for HttpPolicy {
    fn handle(&self, request: ureq::Request, next: ureq::MiddlewareNext<'_>) -> Result<ureq::Response, ureq::Error> {
        let state = self.0.state.read().unwrap();
        if state.status.enabled { return Err(io::Error::new(io::ErrorKind::PermissionDenied, MESSAGE).into()); }
        next.handle(request)
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Preference { enabled: bool }

fn local_preference() -> bool {
    // A damaged existing privacy file must not silently re-enable networking.
    match crate::store::root() {
        Ok(root) => local_preference_at(&root.join("data-privacy.json")),
        Err(_) => true,
    }
}

fn local_preference_at(path: &std::path::Path) -> bool {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Preference>(&bytes).map_or(true, |preference| preference.enabled),
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(_) => true,
    }
}

fn resolve(local: bool, forced: bool, value: Option<bool>) -> Status {
    // IT can enforce on; a false profile never overrides the person's choice.
    let managed = forced && value != Some(false);
    Status { enabled: local || managed, managed }
}

fn read_status() -> Status {
    let (forced, value) = managed_preference();
    // Process-isolated network/entrypoint tests exercise the forced-profile
    // result without installing or changing an OS configuration profile.
    #[cfg(test)]
    let (forced, value) = if std::env::var_os("TERMINALX_TEST_MANAGED_PRIVACY").is_some() { (true, Some(true)) } else { (forced, value) };
    resolve(local_preference(), forced, value)
}

// Serialize file/profile reads with writes so a monitor cannot publish an
// older read after the settings command has finished.
static SETTINGS: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn refresh() -> Status {
    let _settings = SETTINGS.lock().unwrap();
    policy().set(read_status());
    policy().status()
}

/// Called before any desktop clients start. The local runtime uses the same
/// profile domain and file, so a detached owner observes policy changes too.
pub fn initialize() {
    static STARTED: OnceLock<()> = OnceLock::new();
    STARTED.get_or_init(|| {
        refresh();
        std::thread::Builder::new().name("data-privacy".into()).spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            refresh();
        }).expect("watch the data privacy setting");
    });
}

/// Always report the applied transport policy, even when owner synchronization
/// failed. A synchronization error must never be mistaken for a policy value.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(flatten)]
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[cfg(any(feature = "desktop", test))]
fn synchronize(policy: &Policy, desired: Status, owner: impl FnOnce() -> anyhow::Result<Status>) -> Snapshot {
    policy.set(desired);
    let status = policy.status();
    let error = match owner() {
        Ok(applied) if applied == status => None,
        Ok(_) => Some("The background runtime's data privacy setting changed. Try again.".into()),
        Err(error) => Some(format!("Could not apply data privacy mode to the background runtime: {error}. Update or restart the runtime before relying on this setting.")),
    };
    Snapshot { status, error }
}

#[cfg(feature = "desktop")]
fn synchronize_runtime(status: Status, runtime: Option<&crate::local_runtime::desktop::Desktop>) -> Snapshot {
    synchronize(policy(), status, || runtime.map_or(Ok(status), |runtime| runtime.refresh_data_privacy()))
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn data_privacy_status(state: tauri::State<'_, crate::AppState>) -> Result<Snapshot, String> {
    let runtime = state.runtime();
    tauri::async_runtime::spawn_blocking(move || {
        let _settings = SETTINGS.lock().unwrap();
        synchronize_runtime(read_status(), runtime.as_deref())
    })
        .await.map_err(|error| error.to_string())
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn data_privacy_set(state: tauri::State<'_, crate::AppState>, enabled: bool) -> Result<Snapshot, String> {
    let runtime = state.runtime();
    tauri::async_runtime::spawn_blocking(move || {
        let _settings = SETTINGS.lock().unwrap();
        let write = || -> anyhow::Result<()> {
            anyhow::ensure!(enabled || !read_status().managed, "Managed by your organisation");
            crate::store::write_json(&crate::store::root()?.join("data-privacy.json"), &Preference { enabled })
        };
        let error = write().err().map(|error| error.to_string());
        policy().set(read_status());
        let status = policy().status();
        let mut snapshot = synchronize_runtime(status, runtime.as_deref());
        if error.is_some() { snapshot.error = error; }
        snapshot
    }).await.map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
fn managed_preference() -> (bool, Option<bool>) { (false, None) }

#[cfg(target_os = "macos")]
fn managed_preference() -> (bool, Option<bool>) {
    read_managed_preference(DOMAIN, MANAGED_KEY)
}

#[cfg(target_os = "macos")]
fn read_managed_preference(domain: &str, name: &str) -> (bool, Option<bool>) {
    use std::ffi::{c_char, c_void, CString};
    type CF = *const c_void;
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(allocator: CF, text: *const c_char, encoding: u32) -> CF;
        fn CFPreferencesAppSynchronize(app: CF) -> u8;
        fn CFPreferencesAppValueIsForced(key: CF, app: CF) -> u8;
        fn CFPreferencesCopyAppValue(key: CF, app: CF) -> CF;
        fn CFGetTypeID(value: CF) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(value: CF) -> u8;
        fn CFRelease(value: CF);
    }
    // CFPreferences resolves configuration profiles; `defaults read` cannot
    // establish that a value is forced. Only actual CFBooleans are accepted.
    unsafe {
        let key = CFStringCreateWithCString(std::ptr::null(), CString::new(name).unwrap().as_ptr(), 0x08000100);
        let app = CFStringCreateWithCString(std::ptr::null(), CString::new(domain).unwrap().as_ptr(), 0x08000100);
        CFPreferencesAppSynchronize(app);
        let forced = CFPreferencesAppValueIsForced(key, app) != 0;
        let value = CFPreferencesCopyAppValue(key, app);
        let boolean = if !value.is_null() && CFGetTypeID(value) == CFBooleanGetTypeID() { Some(CFBooleanGetValue(value) != 0) } else { None };
        if !value.is_null() { CFRelease(value); }
        CFRelease(key);
        CFRelease(app);
        (forced, boolean)
    }
}

/// Below TLS and WebSocket framing: covers automatic pong/close writes as
/// well as application messages. Never wrap the local owner IPC in this.
pub struct NetworkIo<T> {
    inner: T,
    policy: Arc<Policy>,
    epoch: u64,
    cancelled: Pin<Box<dyn Future<Output = ()> + Send>>,
}

impl<T> NetworkIo<T> {
    pub fn new(inner: T) -> Self { Self::with_policy(inner, policy().clone()) }
    fn with_policy(inner: T, policy: Arc<Policy>) -> Self {
        let state = policy.state.read().unwrap();
        let epoch = state.epoch;
        let cancelled = Box::pin(state.cancel.clone().cancelled_owned());
        drop(state);
        Self { inner, policy, epoch, cancelled }
    }
    pub fn get_ref(&self) -> &T { &self.inner }
    fn permitted(&mut self, cx: &mut Context<'_>) -> bool {
        // Registers the idle socket's waker before checking the current epoch.
        let _ = self.cancelled.as_mut().poll(cx);
        let state = self.policy.state.read().unwrap();
        !state.status.enabled && state.epoch == self.epoch
    }
}

fn denied() -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, MESSAGE) }

impl<T: AsyncRead + Unpin> AsyncRead for NetworkIo<T> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if !this.permitted(cx) { return Poll::Ready(Err(denied())); }
        let state = this.policy.state.read().unwrap();
        if state.status.enabled || state.epoch != this.epoch { return Poll::Ready(Err(denied())); }
        Pin::new(&mut this.inner).poll_read(cx, buf)
    }
}

impl<T: AsyncWrite + Unpin> AsyncWrite for NetworkIo<T> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        if !this.permitted(cx) { return Poll::Ready(Err(denied())); }
        let state = this.policy.state.read().unwrap();
        if state.status.enabled || state.epoch != this.epoch { return Poll::Ready(Err(denied())); }
        Pin::new(&mut this.inner).poll_write(cx, buf)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if !this.permitted(cx) { return Poll::Ready(Err(denied())); }
        let state = this.policy.state.read().unwrap();
        if state.status.enabled || state.epoch != this.epoch { return Poll::Ready(Err(denied())); }
        Pin::new(&mut this.inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> { Poll::Ready(Ok(())) }
}

pub type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<NetworkIo<tokio::net::TcpStream>>>;

pub async fn connect<R: tokio_tungstenite::tungstenite::client::IntoClientRequest + Unpin>(
    request: R, config: Option<tokio_tungstenite::tungstenite::protocol::WebSocketConfig>, disable_nagle: bool,
) -> Result<(Socket, tokio_tungstenite::tungstenite::handshake::client::Response), tokio_tungstenite::tungstenite::Error> {
    connect_with_policy(request, config, disable_nagle, policy().clone()).await
}

async fn connect_with_policy<R: tokio_tungstenite::tungstenite::client::IntoClientRequest + Unpin>(
    request: R, config: Option<tokio_tungstenite::tungstenite::protocol::WebSocketConfig>, disable_nagle: bool, policy: Arc<Policy>,
) -> Result<(Socket, tokio_tungstenite::tungstenite::handshake::client::Response), tokio_tungstenite::tungstenite::Error> {
    use tokio_tungstenite::tungstenite::{Error, error::UrlError};
    let request = request.into_client_request()?;
    let host = request.uri().host().ok_or(Error::Url(UrlError::NoHostName))?.to_owned();
    let port = request.uri().port_u16().or_else(|| match request.uri().scheme_str() { Some("wss") => Some(443), Some("ws") => Some(80), _ => None })
        .ok_or(Error::Url(UrlError::UnsupportedUrlScheme))?;
    // The TCP connect future itself is fenced, so enabling cannot race a new
    // SYN. No lock is held across an await or a potentially blocked I/O poll.
    let connect = tokio::net::TcpStream::connect((host.trim_start_matches('[').trim_end_matches(']'), port));
    tokio::pin!(connect);
    let (epoch, cancelled) = {
        let state = policy.state.read().unwrap();
        (state.epoch, state.cancel.clone().cancelled_owned())
    };
    tokio::pin!(cancelled);
    let tcp = futures_util::future::poll_fn(|cx| {
        let _ = cancelled.as_mut().poll(cx);
        let state = policy.state.read().unwrap();
        if state.status.enabled || state.epoch != epoch { return Poll::Ready(Err(denied())); }
        connect.as_mut().poll(cx)
    }).await?;
    if disable_nagle { tcp.set_nodelay(true)?; }
    let mut stream = NetworkIo::with_policy(tcp, policy);
    // Retain the connect epoch across a simultaneous disable/re-enable.
    stream.epoch = epoch;
    tokio_tungstenite::client_async_tls_with_config(request, stream, config, None).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::time::Duration;
    use futures_util::{SinkExt, StreamExt};

    const ON: Status = Status { enabled: true, managed: false };

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_transfer_drains_before_privacy_ack_and_discards_expired_results() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let owner = Arc::new(Policy::default());
        let ticket = Ticket::with_policy(owner.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (arrived, receiving) = tokio::sync::oneshot::channel();
        let (finish, finishing) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0]; socket.read_exact(&mut request).await.unwrap();
            arrived.send(()).unwrap();
            finishing.await.unwrap();
            socket.write_all(b"x").await.unwrap();
        });
        let operation = tokio::spawn({ let ticket = ticket.clone(); async move {
            transfer(&ticket, async {
                let mut socket = tokio::net::TcpStream::connect(address).await?;
                socket.write_all(b"u").await?;
                let mut body = [0]; socket.read_exact(&mut body).await?;
                Ok(body)
            }).await
        }});
        receiving.await.unwrap();
        let (acknowledge, acknowledged) = std::sync::mpsc::channel();
        let enabling = std::thread::spawn({ let owner = owner.clone(); move || { owner.set(ON); acknowledge.send(()).unwrap(); } });
        while !owner.status().enabled { tokio::task::yield_now().await; }
        assert!(acknowledged.try_recv().is_err(), "an in-flight native transfer holds activation until drained");
        finish.send(()).unwrap();
        assert!(operation.await.unwrap().is_err(), "a drained update cannot be installed after activation");
        server.await.unwrap();
        acknowledged.recv_timeout(Duration::from_secs(5)).unwrap();
        enabling.join().unwrap();
        owner.set(Status::default());
        assert!(transfer::<()>(&ticket, async { panic!("an expired discovered update must never start its download") }).await.is_err());
        assert_eq!(transfer(&Ticket::with_policy(owner), async { Ok(7) }).await.unwrap(), 7);
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        // A raw fixture must consume the whole request before closing;
        // unread headers or a POST body can reset the socket on macOS.
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            bytes.push(byte[0]);
        }
        let headers = String::from_utf8(bytes).unwrap();
        let length = headers.lines().filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map_or(0, |(_, value)| value.trim().parse::<usize>().unwrap());
        let mut body = vec![0; length];
        stream.read_exact(&mut body).unwrap();
        headers
    }

    #[test]
    fn persisted_tickets_cannot_become_local_authority_after_owner_replacement() {
        let owner = Arc::new(Policy::default());
        let ticket = Ticket::with_policy(owner.clone());
        assert!(ticket.valid());
        let saved = serde_json::to_vec(&ticket).unwrap();
        // Deserialization binds to this process's owner, never to the owner
        // named in an old record. The nonce must reject that old authority.
        let restored: Ticket = serde_json::from_slice(&saved).unwrap();
        assert_eq!(ticket, restored);
        assert!(!restored.valid());
        assert!(restored.enter().is_err());
        owner.set(ON);
        owner.set(Status::default());
        assert!(!ticket.valid());
    }

    #[test]
    fn pending_setting_leases_hold_the_activation_barrier_until_work_finishes() {
        let owner = Arc::new(Policy::default());
        let ticket = Ticket::with_policy(owner.clone());
        let mut settings = crate::harness::settings::Settings::default();
        {
            let _scope = ticket.scope().unwrap();
            settings.request_mode("bypassPermissions", true);
            settings.request_model("remote-model", true);
        }
        // The desktop edits only effort; both other tickets must remain.
        settings.request_effort(Some("high"), true);
        let leases = settings.admit_pending();
        assert_eq!(leases.len(), 2);
        let (sent, acknowledged) = std::sync::mpsc::channel();
        let updating = owner.clone();
        let activation = std::thread::spawn(move || { updating.set(ON); sent.send(()).unwrap(); });
        // Status changes before the drain. Wait for that transition rather
        // than assuming the activation thread was scheduled in a timeout.
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while !owner.status().enabled {
            assert!(std::time::Instant::now() < until);
            std::thread::yield_now();
        }
        assert!(acknowledged.try_recv().is_err());
        drop(leases);
        acknowledged.recv_timeout(Duration::from_secs(5)).unwrap();
        activation.join().unwrap();
        owner.set(Status::default());
        assert!(settings.admit_pending().is_empty());
        assert!(settings.requested_model.is_none());
        assert!(settings.requested_permission_mode.is_none());
        assert_eq!(settings.requested_effort.as_deref(), Some("high"));
        settings.launched();
        assert_eq!(settings.effort.as_deref(), Some("high"));
        assert!(settings.model.is_empty());
        assert!(settings.permission_mode.is_empty());
    }

    #[test]
    fn missing_preference_defaults_off_but_damaged_files_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("data-privacy.json");
        assert!(!local_preference_at(&file));
        for bytes in ["", "{", "{}", r#"{"enabled":"false"}"#, r#"{"enabled":true}"#] {
            std::fs::write(&file, bytes).unwrap();
            assert!(local_preference_at(&file), "{bytes}");
        }
        std::fs::write(&file, r#"{"enabled":false}"#).unwrap();
        assert!(!local_preference_at(&file));
    }

    #[test]
    fn managed_setting_is_forced_on_without_overriding_a_personal_opt_in() {
        assert_eq!(resolve(false, true, Some(true)), Status { enabled: true, managed: true });
        assert_eq!(resolve(false, true, None), Status { enabled: true, managed: true });
        assert_eq!(resolve(false, false, Some(true)), Status::default());
        assert_eq!(resolve(false, true, Some(false)), Status::default());
        assert_eq!(resolve(true, true, Some(false)), ON);
        assert_eq!(resolve(true, false, None), ON);
        assert_eq!(resolve(false, false, None), Status::default());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_macos_preferences_without_treating_an_unmanaged_value_as_forced() {
        // Isolated domain: never write the real app's preferences/profile.
        use std::ffi::{c_char, c_void, CString};
        type CF = *const c_void;
        #[link(name = "CoreFoundation", kind = "framework")]
        extern "C" {
            fn CFStringCreateWithCString(allocator: CF, text: *const c_char, encoding: u32) -> CF;
            fn CFPreferencesSetAppValue(key: CF, value: CF, app: CF);
            fn CFPreferencesAppSynchronize(app: CF) -> u8;
            fn CFRelease(value: CF);
            static kCFBooleanTrue: CF;
        }
        let domain = format!("test.terminalx.privacy.{}", uuid::Uuid::new_v4());
        assert_eq!(read_managed_preference(&domain, MANAGED_KEY), (false, None));
        unsafe {
            let key = CFStringCreateWithCString(std::ptr::null(), CString::new(MANAGED_KEY).unwrap().as_ptr(), 0x08000100);
            let app = CFStringCreateWithCString(std::ptr::null(), CString::new(domain.as_str()).unwrap().as_ptr(), 0x08000100);
            CFPreferencesSetAppValue(key, kCFBooleanTrue, app);
            CFPreferencesAppSynchronize(app);
            let read = read_managed_preference(&domain, MANAGED_KEY);
            CFPreferencesSetAppValue(key, std::ptr::null(), app);
            CFPreferencesAppSynchronize(app);
            CFRelease(app);
            CFRelease(key);
            assert_eq!(read, (false, Some(true)));
        }
    }

    #[test]
    fn network_http_is_silent_when_enabled_and_reuses_credentials_when_disabled() {
        let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        server.set_nonblocking(true).unwrap();
        let url = format!("http://{}", server.local_addr().unwrap());
        let policy = Arc::new(Policy::default());
        let client = ureq::AgentBuilder::new().timeout(Duration::from_secs(2)).middleware(HttpPolicy(policy.clone())).build();
        let request = || client.post(&format!("{url}/v1/desktop/auth/capabilities")).set("Authorization", "Bearer retained-session").send_json(serde_json::json!({})).map_err(|error| error.to_string());
        policy.set(ON);
        for _ in 0..3 { assert!(request().is_err()); }
        assert_eq!(server.accept().unwrap_err().kind(), io::ErrorKind::WouldBlock, "no TCP connection, not just an HTTP error");
        policy.set(Status::default());
        server.set_nonblocking(false).unwrap();
        let received = std::thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
            let headers = read_http_request(&mut stream);
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
            headers
        });
        assert_eq!(request().unwrap().status(), 200);
        assert!(received.join().unwrap().contains("Bearer retained-session"));
    }

    #[test]
    fn enabling_waits_for_an_admitted_http_request() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let policy = Arc::new(Policy::default());
        let client = ureq::AgentBuilder::new().timeout(Duration::from_secs(3)).middleware(HttpPolicy(policy.clone())).build();
        let request = std::thread::spawn(move || client.get(&url).call().map_err(|error| error.to_string()));
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut byte = [0];
        stream.read_exact(&mut byte).unwrap();
        let (done, receive) = std::sync::mpsc::channel();
        let switch = std::thread::spawn(move || { policy.set(ON); done.send(()).unwrap(); });
        assert!(receive.recv_timeout(Duration::from_millis(50)).is_err());
        stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        assert_eq!(request.join().unwrap().unwrap().status(), 200);
        receive.recv_timeout(Duration::from_secs(1)).unwrap();
        switch.join().unwrap();
    }

    #[tokio::test]
    async fn owner_failure_reports_the_applied_http_and_relay_policy() {
        for initial in [Status::default(), ON] {
            for failure in ["unsupported", "unavailable"] {
                let dir = tempfile::tempdir().unwrap();
                let file = dir.path().join("data-privacy.json");
                let policy = Arc::new(Policy::default());
                policy.set(initial);
                // Both a saved-off read and an on-to-off write have the same
                // response contract, including later background file refresh.
                for enabled in [false, true, false] {
                    crate::store::write_json(&file, &Preference { enabled }).unwrap();
                    let desired = Status { enabled: local_preference_at(&file), managed: false };
                    let reply = synchronize(&policy, desired, || anyhow::bail!(failure));
                    let shown = serde_json::to_value(&reply).unwrap();
                    assert_eq!(shown["enabled"], enabled);
                    assert!(shown["error"].as_str().unwrap().contains(failure));
                    // The background refresh uses the same applied policy;
                    // there is no hidden hold for it to accidentally undo.
                    policy.set(desired);
                    assert_eq!(reply.status, policy.status());
                    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                    let url = format!("http://{}",listener.local_addr().unwrap());
                    let client = ureq::AgentBuilder::new().timeout(Duration::from_secs(2)).middleware(HttpPolicy(policy.clone())).build();
                    if enabled {
                        listener.set_nonblocking(true).unwrap();
                        assert!(client.get(&url).call().is_err());
                        assert_eq!(listener.accept().unwrap_err().kind(),io::ErrorKind::WouldBlock);
                    } else {
                        let peer = std::thread::spawn(move || {
                            let (mut socket,_) = listener.accept().unwrap();
                            socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                            read_http_request(&mut socket);
                            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
                        });
                        assert_eq!(client.get(&url).call().unwrap().status(),200);
                        peer.join().unwrap();
                    }
                    let relay = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                    let url = format!("ws://{}",relay.local_addr().unwrap());
                    if enabled {
                        assert!(connect_with_policy(url.as_str(),None,false,policy.clone()).await.is_err());
                        assert!(tokio::time::timeout(Duration::from_millis(20),relay.accept()).await.is_err());
                    } else {
                        let peer = tokio::spawn(async move {
                            let (socket,_) = relay.accept().await.unwrap();
                            tokio_tungstenite::accept_async(socket).await.unwrap()
                        });
                        assert!(connect_with_policy(url.as_str(),None,false,policy.clone()).await.is_ok());
                        drop(peer.await.unwrap());
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn network_relay_rejects_new_connections_and_invalidates_an_idle_socket() {
        let server = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", server.local_addr().unwrap());
        let policy = Arc::new(Policy::default());
        policy.set(ON);
        assert!(connect_with_policy(url.as_str(), None, false, policy.clone()).await.is_err());
        assert!(tokio::time::timeout(Duration::from_millis(30), server.accept()).await.is_err());
        policy.set(Status::default());
        let peer = tokio::spawn(async move {
            let (stream, _) = server.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            assert_eq!(socket.next().await.unwrap().unwrap().into_text().unwrap(), "before");
            socket.send(tokio_tungstenite::tungstenite::Message::Text("ack".into())).await.unwrap();
            // No app data after enabling. A TCP EOF is expected when the old socket drops.
            socket.next().await
        });
        let (mut socket, _) = connect_with_policy(url.as_str(), None, false, policy.clone()).await.unwrap();
        socket.send(tokio_tungstenite::tungstenite::Message::Text("before".into())).await.unwrap();
        assert!(socket.next().await.unwrap().is_ok());
        let idle = tokio::spawn(async move {
            let result = socket.next().await;
            (socket, result)
        });
        tokio::task::yield_now().await;
        policy.set(ON);
        let (mut socket, result) = tokio::time::timeout(Duration::from_secs(1), idle).await.unwrap().unwrap();
        assert!(result.unwrap().is_err(), "enabling wakes idle relay reads");
        policy.set(Status::default());
        assert!(socket.send(tokio_tungstenite::tungstenite::Message::Text("after".into())).await.is_err(), "old sockets never revive");
        drop(socket);
        let result = tokio::time::timeout(Duration::from_secs(1), peer).await.unwrap().unwrap();
        assert!(result.is_none_or(|result| result.is_err()));
    }
}
