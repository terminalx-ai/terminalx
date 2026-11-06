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
}

pub struct Policy {
    state: RwLock<State>,
    updating: Mutex<()>,
    writers: Mutex<usize>,
    drained: Condvar,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            state: RwLock::new(State { status: Status::default(), epoch: 0, cancel: CancellationToken::new() }),
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
#[derive(Clone)]
pub struct Ticket { policy: Arc<Policy>, epoch: Option<u64> }

impl Default for Ticket {
    fn default() -> Self { Self::with_policy(policy().clone()) }
}

impl Ticket {
    fn with_policy(policy: Arc<Policy>) -> Self {
        let state = policy.state.read().unwrap();
        let epoch = (!state.status.enabled).then_some(state.epoch);
        drop(state);
        Self { policy, epoch }
    }
    pub fn valid(&self) -> bool {
        let state = self.policy.state.read().unwrap();
        !state.status.enabled && self.epoch == Some(state.epoch)
    }
    pub fn enter(&self) -> anyhow::Result<RemoteWrite> {
        let state = self.policy.state.read().unwrap();
        anyhow::ensure!(!state.status.enabled && self.epoch == Some(state.epoch), MESSAGE);
        *self.policy.writers.lock().unwrap() += 1;
        Ok(RemoteWrite(self.policy.clone()))
    }
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

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn data_privacy_status(state: tauri::State<'_, crate::AppState>) -> Result<Status, String> {
    let runtime = state.runtime();
    tauri::async_runtime::spawn_blocking(move || synchronize_runtime(refresh(), runtime.as_deref()))
        .await.map_err(|error| error.to_string())?
}

#[cfg(feature = "desktop")]
fn synchronize_runtime(status: Status, runtime: Option<&crate::local_runtime::desktop::Desktop>) -> Result<Status, String> {
    if let Some(runtime) = runtime {
        let owner = runtime.refresh_data_privacy().map_err(|error| format!("Could not apply data privacy mode to the background runtime: {error}. Update or restart the runtime before using remote features."))?;
        if owner != status { return Err("The background runtime's data privacy setting changed. Try again.".into()); }
    }
    Ok(status)
}

#[cfg(feature = "desktop")]
#[tauri::command]
pub async fn data_privacy_set(state: tauri::State<'_, crate::AppState>, enabled: bool) -> Result<Status, String> {
    let runtime = state.runtime();
    tauri::async_runtime::spawn_blocking(move || {
        let _settings = SETTINGS.lock().unwrap();
        let status = read_status();
        if !enabled && status.managed {
            policy().set(status);
            return Err("Managed by your organisation".into());
        }
        crate::store::write_json(&crate::store::root().map_err(|e| e.to_string())?.join("data-privacy.json"), &Preference { enabled })
            .map_err(|error| error.to_string())?;
        policy().set(read_status());
        let status = policy().status();
        drop(_settings);
        synchronize_runtime(status, runtime.as_deref())
    }).await.map_err(|error| error.to_string())?
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
            let mut bytes = Vec::new();
            while !bytes.windows(4).any(|window| window == b"\r\n\r\n") {
                let mut chunk = [0; 4096];
                let n = stream.read(&mut chunk).unwrap();
                assert!(n > 0);
                bytes.extend_from_slice(&chunk[..n]);
            }
            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").unwrap();
            String::from_utf8_lossy(&bytes).into_owned()
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
