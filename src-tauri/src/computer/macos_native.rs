//! The macOS provider: a signed helper app reached over a unix socket.
//!
//! Lifecycle of one connection:
//! 1. make a private 0700 directory holding `provider.sock` and a 0600
//!    `provider.token`;
//! 2. spawn `terminalx-computer-use-macos --agent <sock> --token-file <path>`
//!    from inside the helper bundle (spawning the bundle's executable directly
//!    keeps TCC looking at the helper's identity, not the app that launched it);
//! 3. connect with retries until the helper binds, then delete the token file;
//! 4. `handshake` must answer protocol version 1 and the capability matrix;
//! 5. every later request carries the token, is answered on one line, and
//!    times out after 60 s, which tears the connection down;
//! 6. `terminate` on shutdown, the socket directory is removed, and the helper
//!    also exits by itself when the owning socket hangs up.
//!
//! The framing and handshake logic lives in [`LineTransport`] and
//! [`Handshake`] so it can be exercised in tests against a fake helper
//! listening on a unix socket, without any Swift code.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::{ActionMethod, ComputerError, ComputerProvider, REQUIRED_PROTOCOL_VERSION};

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_RETRY: Duration = Duration::from_millis(100);
const TERMINATE_GRACE: Duration = Duration::from_millis(1500);

/// macOS 14 (Darwin 23) is the helper's floor: ScreenCaptureKit screenshots
/// and the accessibility APIs it relies on.
pub fn is_macos_14_or_newer() -> bool {
    #[cfg(target_os = "macos")]
    {
        darwin_release_major().is_some_and(|major| major >= 23)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(target_os = "macos")]
fn darwin_release_major() -> Option<u32> {
    let mut info: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut info) } != 0 {
        return None;
    }
    let release = unsafe { std::ffi::CStr::from_ptr(info.release.as_ptr()) };
    release
        .to_str()
        .ok()?
        .split('.')
        .next()?
        .parse()
        .ok()
}

/// A JSON-lines request/response channel over an already connected socket.
#[cfg(unix)]
pub struct LineTransport {
    writer: std::os::unix::net::UnixStream,
    reader: BufReader<std::os::unix::net::UnixStream>,
    token: String,
    next_id: u64,
}

#[cfg(unix)]
impl LineTransport {
    pub fn new(stream: std::os::unix::net::UnixStream, token: String, timeout: Duration) -> Result<Self, ComputerError> {
        stream
            .set_read_timeout(Some(timeout))
            .map_err(|e| ComputerError::accessibility(format!("configure helper socket: {e}")))?;
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| ComputerError::accessibility(format!("configure helper socket: {e}")))?;
        let reader = BufReader::new(
            stream
                .try_clone()
                .map_err(|e| ComputerError::accessibility(format!("clone helper socket: {e}")))?,
        );
        Ok(Self {
            writer: stream,
            reader,
            token,
            next_id: 1,
        })
    }

    /// Send one request and wait for the line that answers it. Lines that are
    /// blank, unparseable, or answer a different id are skipped: a late reply
    /// from a timed-out request must not be mistaken for this one.
    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, ComputerError> {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"id": id, "method": method, "params": params, "token": self.token});
        let mut bytes = serde_json::to_vec(&request)
            .map_err(|e| ComputerError::accessibility(format!("encode helper request: {e}")))?;
        bytes.push(b'\n');
        self.writer
            .write_all(&bytes)
            .and_then(|_| self.writer.flush())
            .map_err(|e| ComputerError::accessibility(format!("write to helper: {e}")))?;
        loop {
            let mut line = String::new();
            let read = self.reader.read_line(&mut line).map_err(|e| {
                if matches!(e.kind(), std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock) {
                    ComputerError::new("action_timeout", format!("native macOS provider {method} timed out"))
                } else {
                    ComputerError::accessibility(format!("read from helper: {e}"))
                }
            })?;
            if read == 0 {
                return Err(ComputerError::accessibility(
                    "native macOS helper app connection closed",
                ));
            }
            if line.trim().is_empty() {
                continue;
            }
            let Ok(response) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if response.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            return decode_response(response);
        }
    }

    /// Fire-and-forget: used for `terminate`, whose answer nobody waits for.
    pub fn notify(&mut self, method: &str) {
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"id": id, "method": method, "params": {}, "token": self.token});
        if let Ok(mut bytes) = serde_json::to_vec(&request) {
            bytes.push(b'\n');
            let _ = self.writer.write_all(&bytes);
            let _ = self.writer.flush();
        }
        let _ = self.writer.shutdown(std::net::Shutdown::Both);
    }
}

/// Turn a `{id, ok, result | error}` line into the provider result.
pub fn decode_response(response: Value) -> Result<Value, ComputerError> {
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(response.get("result").cloned().unwrap_or(Value::Null));
    }
    let error = response.get("error");
    let code = error
        .and_then(|e| e.get("code"))
        .and_then(Value::as_str)
        .unwrap_or("accessibility_error");
    let message = error
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("the helper returned an error without a message");
    Err(ComputerError::new(code, message))
}

/// What the handshake decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Handshake {
    Compatible(Value),
    Incompatible { protocol_version: u64 },
}

pub fn evaluate_handshake(capabilities: Value) -> Handshake {
    let version = capabilities
        .get("protocolVersion")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if version == REQUIRED_PROTOCOL_VERSION {
        Handshake::Compatible(capabilities)
    } else {
        Handshake::Incompatible {
            protocol_version: version,
        }
    }
}

pub fn supports(capabilities: &Value, group: &str, key: &str) -> bool {
    capabilities
        .get("supports")
        .and_then(|s| s.get(group))
        .and_then(|g| g.get(key))
        .and_then(Value::as_bool)
        == Some(true)
}

/// The spawned helper. On macOS it is started through `posix_spawn` with a
/// responsibility disclaim so TCC evaluates the helper's own signed identity
/// instead of attributing it to TerminalX (or to whatever launched a dev
/// binary); a plain `Command` child would inherit the parent's grants and
/// denials. Elsewhere it is an ordinary child process.
#[cfg(unix)]
pub struct HelperProcess {
    pid: libc::pid_t,
    status: Option<i32>,
}

#[cfg(unix)]
impl HelperProcess {
    pub fn id(&self) -> u32 {
        self.pid as u32
    }

    /// `Some(code)` once the helper has exited (a signal reports as -1).
    pub fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        if let Some(status) = self.status {
            return Ok(Some(status));
        }
        let mut raw = 0;
        let waited = unsafe { libc::waitpid(self.pid, &mut raw, libc::WNOHANG) };
        if waited == self.pid {
            let code = if libc::WIFEXITED(raw) { libc::WEXITSTATUS(raw) } else { -1 };
            self.status = Some(code);
            Ok(Some(code))
        } else if waited == 0 {
            Ok(None)
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    pub fn kill(&mut self) {
        if self.status.is_none() {
            unsafe { libc::kill(self.pid, libc::SIGTERM) };
        }
    }

    pub fn wait(&mut self) {
        if self.status.is_some() {
            return;
        }
        let mut raw = 0;
        if unsafe { libc::waitpid(self.pid, &mut raw, 0) } == self.pid {
            self.status = Some(if libc::WIFEXITED(raw) { libc::WEXITSTATUS(raw) } else { -1 });
        }
    }
}

#[cfg(target_os = "macos")]
extern "C" {
    /// Private but long-stable (Chromium and Electron rely on it): makes the
    /// spawned process responsible for itself in TCC's eyes.
    fn responsibility_spawnattrs_setdisclaim(attrs: *mut libc::posix_spawnattr_t, disclaim: libc::c_int) -> libc::c_int;
}

/// Spawn `executable --agent <socket> --token-file <token>` with stdio on
/// /dev/null, no inherited descriptors, and (on macOS) its own TCC identity.
#[cfg(unix)]
fn spawn_helper(executable: &Path, socket: &Path, token: &Path) -> std::io::Result<HelperProcess> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let program = CString::new(executable.as_os_str().as_bytes())?;
    let args = [
        program.clone(),
        CString::new("--agent")?,
        CString::new(socket.as_os_str().as_bytes())?,
        CString::new("--token-file")?,
        CString::new(token.as_os_str().as_bytes())?,
    ];
    let mut argv: Vec<*mut libc::c_char> = args.iter().map(|a| a.as_ptr() as *mut _).collect();
    argv.push(std::ptr::null_mut());
    let dev_null = CString::new("/dev/null")?;

    unsafe {
        let mut attr: libc::posix_spawnattr_t = std::mem::zeroed();
        let mut actions: libc::posix_spawn_file_actions_t = std::mem::zeroed();
        if libc::posix_spawnattr_init(&mut attr) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        if libc::posix_spawn_file_actions_init(&mut actions) != 0 {
            libc::posix_spawnattr_destroy(&mut attr);
            return Err(std::io::Error::last_os_error());
        }
        #[cfg(target_os = "macos")]
        {
            // POSIX_SPAWN_CLOEXEC_DEFAULT: only the descriptors named in the
            // file actions survive into the helper.
            libc::posix_spawnattr_setflags(&mut attr, 0x4000);
            responsibility_spawnattrs_setdisclaim(&mut attr, 1);
        }
        libc::posix_spawn_file_actions_addopen(&mut actions, 0, dev_null.as_ptr(), libc::O_RDONLY, 0);
        libc::posix_spawn_file_actions_addopen(&mut actions, 1, dev_null.as_ptr(), libc::O_WRONLY, 0);
        libc::posix_spawn_file_actions_addopen(&mut actions, 2, dev_null.as_ptr(), libc::O_WRONLY, 0);
        let mut pid: libc::pid_t = 0;
        let environ = environ_ptr();
        let result = libc::posix_spawn(&mut pid, program.as_ptr(), &actions, &attr, argv.as_ptr(), environ);
        libc::posix_spawn_file_actions_destroy(&mut actions);
        libc::posix_spawnattr_destroy(&mut attr);
        if result != 0 {
            return Err(std::io::Error::from_raw_os_error(result));
        }
        Ok(HelperProcess { pid, status: None })
    }
}

#[cfg(target_os = "macos")]
unsafe fn environ_ptr() -> *const *mut libc::c_char {
    *libc::_NSGetEnviron() as *const *mut libc::c_char
}

#[cfg(all(unix, not(target_os = "macos")))]
unsafe fn environ_ptr() -> *const *mut libc::c_char {
    extern "C" {
        static environ: *const *mut libc::c_char;
    }
    environ
}

#[cfg(unix)]
struct Session {
    transport: LineTransport,
    child: HelperProcess,
    socket_dir: PathBuf,
    capabilities: Value,
}

#[cfg(unix)]
impl Session {
    fn close(mut self) {
        self.transport.notify("terminate");
        let deadline = Instant::now() + TERMINATE_GRACE;
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    self.child.kill();
                    self.child.wait();
                    break;
                }
            }
        }
        let _ = std::fs::remove_dir_all(&self.socket_dir);
    }
}

pub struct MacosNativeProvider {
    executable: PathBuf,
    #[cfg(unix)]
    session: Option<Session>,
}

impl MacosNativeProvider {
    pub fn new(executable: PathBuf) -> Self {
        Self {
            executable,
            #[cfg(unix)]
            session: None,
        }
    }

    #[cfg(unix)]
    fn session(&mut self) -> Result<&mut Session, ComputerError> {
        if self.session.is_none() {
            self.session = Some(self.start()?);
        }
        Ok(self.session.as_mut().expect("session was just started"))
    }

    #[cfg(unix)]
    fn start(&self) -> Result<Session, ComputerError> {
        let mut started = start_session(&self.executable)?;
        let (started, capabilities) = match evaluate_handshake(started.handshake()?) {
            Handshake::Compatible(capabilities) => (started, capabilities),
            Handshake::Incompatible { .. } => {
                // One restart covers a stale helper left from a previous
                // app version; a second mismatch is a real incompatibility.
                started.close();
                let mut restarted = start_session(&self.executable)?;
                match evaluate_handshake(restarted.handshake()?) {
                    Handshake::Compatible(capabilities) => (restarted, capabilities),
                    Handshake::Incompatible { protocol_version } => {
                        restarted.close();
                        return Err(ComputerError::new(
                            "provider_incompatible",
                            format!(
                                "native macOS provider protocol {protocol_version} is incompatible with required protocol {REQUIRED_PROTOCOL_VERSION}"
                            ),
                        ));
                    }
                }
            }
        };
        Ok(Session {
            transport: started.transport,
            child: started.child,
            socket_dir: started.socket_dir,
            capabilities,
        })
    }

    #[cfg(unix)]
    fn call(&mut self, method: &str, params: Value) -> Result<Value, ComputerError> {
        let session = self.session()?;
        match session.transport.request(method, params) {
            Ok(result) => Ok(result),
            Err(error) => {
                // Any transport failure (timeout, hangup, write error) makes
                // the socket unreliable; the next call starts a fresh helper.
                if error.code == "action_timeout" || error.message.contains("helper") {
                    if let Some(session) = self.session.take() {
                        session.close();
                    }
                }
                Err(error)
            }
        }
    }

    #[cfg(unix)]
    fn ensure_capability(&mut self, group: &str, key: &str) -> Result<(), ComputerError> {
        let session = self.session()?;
        if supports(&session.capabilities, group, key) {
            Ok(())
        } else {
            Err(ComputerError::new(
                "unsupported_capability",
                format!("native macOS provider does not support {group}.{key}"),
            ))
        }
    }
}

#[cfg(unix)]
impl ComputerProvider for MacosNativeProvider {
    fn capabilities(&mut self) -> Result<Value, ComputerError> {
        Ok(self.session()?.capabilities.clone())
    }

    fn list_apps(&mut self) -> Result<Value, ComputerError> {
        self.call("listApps", json!({}))
    }

    fn list_windows(&mut self, params: Value) -> Result<Value, ComputerError> {
        self.ensure_capability("windows", "list")?;
        self.call("listWindows", params)
    }

    fn snapshot(&mut self, params: Value) -> Result<Value, ComputerError> {
        self.call("getAppState", params)
    }

    fn action(&mut self, method: ActionMethod, params: Value) -> Result<Value, ComputerError> {
        self.ensure_capability("actions", method.capability_key())?;
        self.call(method.wire(), params)
    }

    fn shutdown(&mut self) {
        if let Some(session) = self.session.take() {
            session.close();
        }
    }
}

#[cfg(not(unix))]
impl ComputerProvider for MacosNativeProvider {
    fn capabilities(&mut self) -> Result<Value, ComputerError> {
        Err(ComputerError::new("unsupported_capability", super::provider_unavailable_message()))
    }
    fn list_apps(&mut self) -> Result<Value, ComputerError> {
        self.capabilities()
    }
    fn list_windows(&mut self, _params: Value) -> Result<Value, ComputerError> {
        self.capabilities()
    }
    fn snapshot(&mut self, _params: Value) -> Result<Value, ComputerError> {
        self.capabilities()
    }
    fn action(&mut self, _method: ActionMethod, _params: Value) -> Result<Value, ComputerError> {
        self.capabilities()
    }
    fn shutdown(&mut self) {}
}

impl Drop for MacosNativeProvider {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// A helper that has been spawned and connected but not yet handshaken.
#[cfg(unix)]
pub struct StartedSession {
    transport: LineTransport,
    child: HelperProcess,
    socket_dir: PathBuf,
}

#[cfg(unix)]
impl StartedSession {
    pub fn handshake(&mut self) -> Result<Value, ComputerError> {
        self.transport.request("handshake", json!({}))
    }

    pub fn close(self) {
        Session {
            transport: self.transport,
            child: self.child,
            socket_dir: self.socket_dir,
            capabilities: Value::Null,
        }
        .close();
    }
}

/// `sun_path` holds 104 bytes on macOS; a socket deeper than that cannot be
/// bound at all, so the directory name stays short and `/tmp` is the fallback
/// for an unusually long `TMPDIR`.
const MAX_SOCKET_PATH_BYTES: usize = 100;

/// Remove socket directories left by an app that died without running its
/// shutdown (a crash or SIGTERM). A directory is stale when nothing answers
/// on its socket any more; a live helper, ours or another TerminalX's,
/// accepts the connection and is left alone.
#[cfg(unix)]
pub fn sweep_stale_socket_dirs() -> usize {
    sweep_stale_socket_dirs_in(&socket_base_dir(std::env::temp_dir()))
}

#[cfg(unix)]
pub fn sweep_stale_socket_dirs_in(base: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(base) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_ours = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("terminalx-computer-use-"));
        if !is_ours || !path.is_dir() {
            continue;
        }
        let socket = path.join("provider.sock");
        let alive = socket.exists() && std::os::unix::net::UnixStream::connect(&socket).is_ok();
        if alive {
            continue;
        }
        // A directory without a socket may belong to a helper still
        // starting; only sweep it once it is clearly abandoned.
        let abandoned = socket.exists()
            || entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|modified| modified.elapsed().unwrap_or_default() > Duration::from_secs(120))
                .unwrap_or(false);
        if abandoned && std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Spawn the helper and connect to its socket.
#[cfg(unix)]
pub fn start_session(executable: &Path) -> Result<StartedSession, ComputerError> {
    start_session_in(executable, &socket_base_dir(std::env::temp_dir()))
}

#[cfg(unix)]
fn socket_base_dir(preferred: PathBuf) -> PathBuf {
    let longest = preferred.join("terminalx-computer-use-xxxxxxxx/provider.sock");
    if longest.as_os_str().len() > MAX_SOCKET_PATH_BYTES {
        PathBuf::from("/tmp")
    } else {
        preferred
    }
}

/// Spawn the helper with its socket directory under `base`. Public so tests
/// can drive a fake helper and assert that nothing is left behind.
#[cfg(unix)]
pub fn start_session_in(executable: &Path, base: &Path) -> Result<StartedSession, ComputerError> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

    let suffix = uuid::Uuid::new_v4().simple().to_string();
    let socket_dir = base.join(format!("terminalx-computer-use-{}", &suffix[..8]));
    std::fs::DirBuilder::new()
        .mode(0o700)
        .create(&socket_dir)
        .map_err(|e| ComputerError::accessibility(format!("create helper socket directory: {e}")))?;
    let socket_path = socket_dir.join("provider.sock");
    let token = uuid::Uuid::new_v4().to_string();
    let token_path = socket_dir.join("provider.token");
    let write_token = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&token_path)
        .and_then(|mut file| file.write_all(token.as_bytes()));
    if let Err(error) = write_token {
        let _ = std::fs::remove_dir_all(&socket_dir);
        return Err(ComputerError::accessibility(format!("write helper token: {error}")));
    }

    let mut child = match spawn_helper(executable, &socket_path, &token_path) {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&socket_dir);
            return Err(ComputerError::accessibility(format!(
                "native macOS helper app failed to start: {error}"
            )));
        }
    };

    match connect_with_retry(&socket_path, &mut child, CONNECT_TIMEOUT) {
        Ok(stream) => {
            let _ = std::fs::remove_file(&token_path);
            match LineTransport::new(stream, token, REQUEST_TIMEOUT) {
                Ok(transport) => Ok(StartedSession {
                    transport,
                    child,
                    socket_dir,
                }),
                Err(error) => {
                    child.kill();
                    child.wait();
                    let _ = std::fs::remove_dir_all(&socket_dir);
                    Err(error)
                }
            }
        }
        Err(error) => {
            child.kill();
            child.wait();
            let _ = std::fs::remove_dir_all(&socket_dir);
            Err(error)
        }
    }
}

#[cfg(unix)]
fn connect_with_retry(
    socket_path: &Path,
    child: &mut HelperProcess,
    timeout: Duration,
) -> Result<std::os::unix::net::UnixStream, ComputerError> {
    let deadline = Instant::now() + timeout;
    loop {
        let last_error = match std::os::unix::net::UnixStream::connect(socket_path) {
            Ok(stream) => return Ok(stream),
            Err(error) => error,
        };
        if let Ok(Some(code)) = child.try_wait() {
            let detail = if code < 0 { "a signal".to_string() } else { format!("code {code}") };
            return Err(ComputerError::accessibility(format!(
                "native macOS helper app exited before connecting: {detail}"
            )));
        }
        if Instant::now() >= deadline {
            return Err(ComputerError::new(
                "action_timeout",
                format!(
                    "native macOS helper app did not open its socket: {}",
                    last_error
                ),
            ));
        }
        std::thread::sleep(CONNECT_RETRY);
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::net::UnixStream;

    fn pair() -> (UnixStream, UnixStream) {
        UnixStream::pair().unwrap()
    }

    fn line(stream: &mut BufReader<UnixStream>) -> Value {
        let mut text = String::new();
        stream.read_line(&mut text).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn requests_carry_the_token_and_match_answers_by_id() {
        let (client, server) = pair();
        let mut transport = LineTransport::new(client, "tok".into(), Duration::from_secs(2)).unwrap();
        let helper = std::thread::spawn(move || {
            let mut reader = BufReader::new(server.try_clone().unwrap());
            let mut server = server;
            let request = line(&mut reader);
            assert_eq!(request["token"], "tok");
            assert_eq!(request["method"], "listApps");
            assert_eq!(request["id"], 1);
            // A stray reply for another id, a blank line, and garbage precede
            // the real answer; none of them may satisfy the request.
            server
                .write_all(b"{\"id\":99,\"ok\":true,\"result\":\"stale\"}\n\nnot json\n")
                .unwrap();
            server
                .write_all(b"{\"id\":1,\"ok\":true,\"result\":{\"apps\":[]}}\n")
                .unwrap();
        });
        let result = transport.request("listApps", json!({})).unwrap();
        assert_eq!(result, json!({"apps": []}));
        helper.join().unwrap();
    }

    #[test]
    fn helper_errors_keep_their_code_and_message() {
        let (client, server) = pair();
        let mut transport = LineTransport::new(client, "tok".into(), Duration::from_secs(2)).unwrap();
        let helper = std::thread::spawn(move || {
            let mut reader = BufReader::new(server.try_clone().unwrap());
            let mut server = server;
            let request = line(&mut reader);
            let id = request["id"].as_u64().unwrap();
            let reply = json!({"id": id, "ok": false, "error": {"code": "app_blocked", "message": "1Password"}});
            server
                .write_all(format!("{reply}\n").as_bytes())
                .unwrap();
        });
        let error = transport.request("getAppState", json!({"app": "1Password"})).unwrap_err();
        assert_eq!(error.code, "app_blocked");
        assert_eq!(error.message, "1Password");
        helper.join().unwrap();
    }

    #[test]
    fn a_silent_helper_times_out_with_the_guide_code() {
        let (client, _server) = pair();
        let mut transport =
            LineTransport::new(client, "tok".into(), Duration::from_millis(200)).unwrap();
        let error = transport.request("click", json!({})).unwrap_err();
        assert_eq!(error.code, "action_timeout");
        assert!(error.message.contains("click"));
    }

    #[test]
    fn a_closed_helper_is_reported_as_a_lost_connection() {
        let (client, server) = pair();
        let mut transport = LineTransport::new(client, "tok".into(), Duration::from_secs(1)).unwrap();
        drop(server);
        let error = transport.request("listApps", json!({})).unwrap_err();
        assert_eq!(error.code, "accessibility_error");
        assert!(error.message.contains("connection closed") || error.message.contains("write to helper"));
    }

    #[test]
    fn handshake_requires_protocol_version_one() {
        let compatible = evaluate_handshake(json!({"protocolVersion": 1, "supports": {"windows": {"list": true}}}));
        let Handshake::Compatible(capabilities) = compatible else {
            panic!("expected compatible")
        };
        assert!(supports(&capabilities, "windows", "list"));
        assert!(!supports(&capabilities, "windows", "moveResize"));
        assert_eq!(
            evaluate_handshake(json!({"protocolVersion": 2})),
            Handshake::Incompatible { protocol_version: 2 }
        );
        assert_eq!(
            evaluate_handshake(json!({})),
            Handshake::Incompatible { protocol_version: 0 }
        );
    }

    #[test]
    fn decode_defaults_a_bare_failure_to_accessibility_error() {
        let error = decode_response(json!({"id": 1, "ok": false})).unwrap_err();
        assert_eq!(error.code, "accessibility_error");
        assert_eq!(decode_response(json!({"id": 1, "ok": true})).unwrap(), Value::Null);
    }

    #[test]
    fn starting_a_missing_helper_cleans_up_its_socket_directory() {
        let base = tempfile::tempdir().unwrap();
        let error = start_session_in(Path::new("/definitely/not/a/helper"), base.path()).err().unwrap();
        assert_eq!(error.code, "accessibility_error");
        assert!(error.message.contains("failed to start"));
        assert_eq!(std::fs::read_dir(base.path()).unwrap().count(), 0);
    }

    #[test]
    fn a_helper_that_exits_without_listening_is_reported_and_reaped() {
        let base = tempfile::tempdir().unwrap();
        let error = start_session_in(Path::new("/usr/bin/true"), base.path()).err().unwrap();
        assert_eq!(error.code, "accessibility_error");
        assert!(error.message.contains("exited before connecting"), "{}", error.message);
        assert_eq!(std::fs::read_dir(base.path()).unwrap().count(), 0);
    }

    /// Drives the real signed helper: `cargo test real_helper -- --ignored --nocapture`.
    /// Needs a built helper (`pnpm build:computer-macos --dev`) and macOS 14+.
    #[test]
    #[ignore]
    fn real_helper_round_trip() {
        let app = super::super::helper_app_path(None).expect("build the helper first");
        let executable = super::super::helper_executable_in(&app).unwrap();
        let mut provider = MacosNativeProvider::new(executable);
        let capabilities = provider.capabilities().unwrap();
        println!("capabilities: {capabilities}");
        assert_eq!(capabilities["protocolVersion"], 1);
        assert!(supports(&capabilities, "actions", "click"));
        let apps = provider.list_apps().unwrap();
        let count = apps["apps"].as_array().map(Vec::len).unwrap_or(0);
        println!("{count} apps listed");
        assert!(count > 0);
        match provider.list_windows(json!({"app": "com.apple.finder"})) {
            Ok(windows) => println!("finder windows: {}", windows["windows"].as_array().map(Vec::len).unwrap_or(0)),
            Err(error) => println!("finder windows: {error}"),
        }
        match provider.snapshot(json!({"app": "com.apple.finder", "noScreenshot": true})) {
            Ok(state) => println!("finder tree lines: {}", state["snapshot"]["treeText"].as_str().unwrap_or("").lines().count()),
            Err(error) => println!("finder snapshot: {error}"),
        }
        let blocked = provider.snapshot(json!({"app": "com.1password.1password"})).err().unwrap();
        assert!(matches!(blocked.code.as_str(), "app_blocked" | "app_not_found"), "{blocked}");
        let missing = provider.snapshot(json!({"app": "definitely-not-an-app-xyz"})).err().unwrap();
        assert_eq!(missing.code, "app_not_found");
        let pid = provider.session.as_ref().unwrap().child.id();
        let socket_dir = provider.session.as_ref().unwrap().socket_dir.clone();
        provider.shutdown();
        assert!(!process_alive(pid), "helper must exit on terminate");
        assert!(!socket_dir.exists());
    }

    #[test]
    fn the_sweep_removes_dead_socket_dirs_and_keeps_live_and_fresh_ones() {
        // Under /tmp so the live socket's path fits in sun_path.
        let base = tempfile::tempdir_in("/tmp").unwrap();
        let dead = base.path().join("terminalx-computer-use-dead0001");
        std::fs::create_dir(&dead).unwrap();
        std::fs::write(dead.join("provider.sock"), b"").unwrap();
        let fresh = base.path().join("terminalx-computer-use-fresh001");
        std::fs::create_dir(&fresh).unwrap();
        let live = base.path().join("terminalx-computer-use-live0001");
        std::fs::create_dir(&live).unwrap();
        let listener = std::os::unix::net::UnixListener::bind(live.join("provider.sock")).unwrap();
        let unrelated = base.path().join("something-else");
        std::fs::create_dir(&unrelated).unwrap();

        assert_eq!(sweep_stale_socket_dirs_in(base.path()), 1);
        assert!(!dead.exists());
        assert!(fresh.exists(), "a directory still starting up is left alone");
        assert!(live.exists(), "a helper that answers is left alone");
        assert!(unrelated.exists());
        drop(listener);
    }

    #[test]
    fn socket_paths_stay_within_the_sun_path_limit() {
        let typical = PathBuf::from("/var/folders/nb/q9zcrfm96k764pqtrycshxn40000gn/T/");
        assert_eq!(socket_base_dir(typical.clone()), typical);
        let long = PathBuf::from("/private/var/folders/nb/q9zcrfm96k764pqtrycshxn40000gn/T/deeper/still");
        assert_eq!(socket_base_dir(long), PathBuf::from("/tmp"));
    }

    #[test]
    fn a_fake_helper_completes_the_handshake_and_is_terminated_on_close() {
        // The fake helper: a shell script that binds the socket with a tiny
        // python server, answers handshake with protocol 1, and exits on
        // terminate exactly like the Swift helper.
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-helper.sh");
        std::fs::write(
            &script,
            r#"#!/bin/sh
exec /usr/bin/python3 - "$2" "$4" <<'PY'
import json, os, socket, sys
sock_path, token_path = sys.argv[1], sys.argv[2]
token = open(token_path).read().strip()
server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
server.bind(sock_path)
server.listen(1)
conn, _ = server.accept()
buf = b""
while True:
    chunk = conn.recv(65536)
    if not chunk:
        break
    buf += chunk
    while b"\n" in buf:
        line, buf = buf.split(b"\n", 1)
        req = json.loads(line)
        if req["token"] != token:
            reply = {"id": req["id"], "ok": False, "error": {"code": "permission_denied", "message": "bad token"}}
        elif req["method"] == "handshake":
            reply = {"id": req["id"], "ok": True, "result": {"protocolVersion": 1, "provider": "fake", "supports": {"windows": {"list": True}, "actions": {"click": True}}}}
        elif req["method"] == "terminate":
            conn.sendall((json.dumps({"id": req["id"], "ok": True, "result": {"ok": True}}) + "\n").encode())
            sys.exit(0)
        else:
            reply = {"id": req["id"], "ok": True, "result": {"echo": req["method"], "params": req["params"]}}
        conn.sendall((json.dumps(reply) + "\n").encode())
PY
"#,
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let mut provider = MacosNativeProvider::new(script);
        let capabilities = provider.capabilities().unwrap();
        assert_eq!(capabilities["provider"], "fake");
        let windows = provider.list_windows(json!({"app": "Finder"})).unwrap();
        assert_eq!(windows["echo"], "listWindows");
        assert_eq!(windows["params"]["app"], "Finder");
        let unsupported = provider.action(ActionMethod::Drag, json!({})).unwrap_err();
        assert_eq!(unsupported.code, "unsupported_capability");
        let clicked = provider.action(ActionMethod::Click, json!({"app": "Finder", "elementIndex": 1})).unwrap();
        assert_eq!(clicked["echo"], "click");

        let socket_dir = provider.session.as_ref().unwrap().socket_dir.clone();
        assert!(socket_dir.exists());
        assert!(!socket_dir.join("provider.token").exists(), "token file must be deleted after connect");
        let pid = provider.session.as_ref().unwrap().child.id();
        provider.shutdown();
        assert!(!socket_dir.exists(), "socket directory must be removed on shutdown");
        assert!(!process_alive(pid), "helper must exit on terminate");
    }

    fn process_alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

}
