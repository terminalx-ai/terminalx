//! Native client for the local owner. Discovery is separate from calls: a
//! request never silently switches to a replacement process or retries a send.

use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::control::{ControlRequest, ControlResponse};

const MAX_RESPONSE: u64 = 32 * 1024 * 1024;
/// How long a call waits for the owner unless it says otherwise. Some calls
/// do real work: stopping an agent waits for its CLI to be gone.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a read the window shows, or a quick control, waits. Long enough
/// to outlast one terminal write that waits out [`crate::pty::INPUT_STALL`]
/// under a tab's lock; short enough that a wedged owner shows up as not
/// responding instead of as a window that hangs (#661).
pub const QUICK_TIMEOUT: Duration = Duration::from_secs(15);

/// The owner took a request and did not answer it in time. It may still be
/// working on it, so the request's effect is unknown, not refused.
#[derive(Debug)]
pub struct Unresponsive {
    pub command: String,
    pub waited: Duration,
}

impl std::fmt::Display for Unresponsive {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "The TerminalX runtime did not answer {} within {} seconds.", self.command, self.waited.as_secs())
    }
}

impl std::error::Error for Unresponsive {}

/// The owner answered with a refusal. `busy` means it is already handling as
/// many requests as it will, all held up: to a caller, an owner that will not
/// answer, whatever the request.
#[derive(Debug)]
pub struct Refused {
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for Refused {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for Refused {}

/// Whether `error` says the owner holds its socket but will not answer: it
/// timed out, or refused for want of a free request place.
pub fn unanswered(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<Unresponsive>() || cause.downcast_ref::<Refused>().is_some_and(|refused| refused.code == "busy"))
}

/// What the owner says about itself without waiting on any of its work:
/// `runtime.liveness`, or `status` from an owner too old to have it.
fn liveness(socket: &Path, token: &str) -> Result<Value> {
    match request(socket, token, "runtime.liveness", json!({}), QUICK_TIMEOUT) {
        Err(error) if error.downcast_ref::<Refused>().is_some_and(|refused| refused.code == "unsupported") => {
            request(socket, token, "status", json!({}), QUICK_TIMEOUT)
        }
        answered => answered,
    }
}

pub struct Client {
    socket: PathBuf,
    token: zeroize::Zeroizing<String>,
    epoch: String,
    event_socket: PathBuf,
}

fn request(socket: &Path, token: &str, command: &str, params: Value, timeout: Duration) -> Result<Value> {
    let mut stream = UnixStream::connect(socket).context("connect to the local runtime")?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    stream.set_read_timeout(Some(timeout))?;
    let request = ControlRequest { id: uuid::Uuid::new_v4().to_string(), token: token.into(), command: command.into(), params };
    serde_json::to_writer(&mut stream, &request)?;
    stream.write_all(b"\n")?;
    let mut line = String::new();
    if let Err(error) = BufReader::new(stream).take(MAX_RESPONSE + 1).read_line(&mut line) {
        if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) {
            return Err(Unresponsive { command: command.into(), waited: timeout }.into());
        }
        return Err(error.into());
    }
    if line.len() as u64 > MAX_RESPONSE { bail!("local runtime response exceeded its size limit"); }
    let response: ControlResponse = serde_json::from_str(&line).context("decode local runtime response")?;
    if response.id != request.id { bail!("local runtime response does not match its request"); }
    if !response.ok {
        let error = response.error.context("local runtime refused the request")?;
        return Err(Refused { code: error.code, message: error.message }.into());
    }
    Ok(response.result.unwrap_or(Value::Null))
}

impl Client {
    /// Read only the explicitly selected home, never an inherited CLI token
    /// that may address the installed app or a different worktree's runtime.
    pub fn connect(root: &Path) -> Result<Arc<Self>> {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        let root = std::fs::canonicalize(root)?;
        let run = root.join("run");
        let metadata = std::fs::symlink_metadata(&run)?;
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        if !metadata.is_dir() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 {
            bail!("local runtime directory is not private");
        }
        let mut file = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(run.join("control.token"))?;
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.uid() != uid || metadata.mode() & 0o077 != 0 || metadata.len() > 256 {
            bail!("local runtime credential file is not private or valid");
        }
        let mut token = zeroize::Zeroizing::new(String::new());
        file.read_to_string(&mut token)?;
        let token = zeroize::Zeroizing::new(token.trim().to_string());
        if token.is_empty() { bail!("local runtime credential is empty"); }
        let status = liveness(&run.join("hooks.sock"), &token)?;
        let local = &status["localRuntime"];
        if status["runtimeKind"] != "local" || local["protocol"].as_u64() != Some(super::PROTOCOL) {
            bail!("the running owner does not support this desktop's local runtime protocol; its work was left running");
        }
        let socket = PathBuf::from(status["socket"].as_str().context("runtime has no control endpoint")?);
        let event_socket = PathBuf::from(local["eventSocket"].as_str().context("runtime has no event endpoint")?);
        if socket.parent() != Some(run.as_path()) || event_socket.parent() != Some(run.as_path()) {
            bail!("runtime endpoints are outside the selected home");
        }
        let epoch = local["epoch"].as_str().context("runtime has no epoch")?.to_string();
        // Pin discovery to this owner. A publisher change between reading the
        // token and status cannot authorize commands to the replacement.
        let pinned = liveness(&socket, &token)?;
        if pinned["localRuntime"]["epoch"] != epoch { bail!("runtime changed during attachment"); }
        Ok(Arc::new(Self { socket, event_socket, token, epoch }))
    }

    pub fn call<T: DeserializeOwned>(&self, command: &str, params: Value) -> Result<T> {
        self.call_within(command, params, CALL_TIMEOUT)
    }

    /// A call that gives up with [`Unresponsive`] after `timeout`.
    pub fn call_within<T: DeserializeOwned>(&self, command: &str, params: Value, timeout: Duration) -> Result<T> {
        serde_json::from_value(request(&self.socket, &self.token, command, params, timeout)?).context("decode local runtime result")
    }

    /// A read the window shows or a quick control: see [`QUICK_TIMEOUT`].
    pub fn quick<T: DeserializeOwned>(&self, command: &str, params: Value) -> Result<T> {
        self.call_within(command, params, QUICK_TIMEOUT)
    }

    pub fn epoch(&self) -> &str { &self.epoch }

    /// See [`liveness`]: answered while the owner's sessions are held up, so
    /// asking never takes a request place that stays taken.
    pub fn liveness(&self) -> Result<Value> { liveness(&self.socket, &self.token) }

    pub fn stop_all(&self) -> Result<()> {
        let _: Value = self.call("runtime.stopAll", json!({"epoch":self.epoch}))?;
        Ok(())
    }

    pub fn stream(&self) -> Result<Connection> {
        let mut socket = UnixStream::connect(&self.event_socket)?;
        socket.set_read_timeout(Some(Duration::from_secs(10)))?;
        socket.set_write_timeout(Some(Duration::from_secs(5)))?;
        serde_json::to_writer(&mut socket, &json!({"protocol":super::PROTOCOL,"token":self.token.as_str()}))?;
        socket.write_all(b"\n")?;
        let mut read = BufReader::new(socket.try_clone()?);
        let hello = receive(&mut read)?;
        if hello["type"] != "ready" || hello["attachment"]["epoch"] != self.epoch {
            bail!("runtime changed before event attachment");
        }
        let attachment: AttachmentIdentity = serde_json::from_value(hello["attachment"].clone())?;
        if attachment.lease.is_empty() || attachment.lease.len() > 128 { bail!("invalid runtime attachment lease"); }
        read.get_ref().set_read_timeout(None)?;
        Ok(Connection { read, write: socket, attachment })
    }
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentIdentity {
    pub epoch: String,
    pub lease: String,
}

pub struct Connection {
    attachment: AttachmentIdentity,
    read: BufReader<UnixStream>,
    write: UnixStream,
}

impl Connection {
    pub fn attachment(&self) -> &AttachmentIdentity { &self.attachment }

    pub fn writer(&self) -> Result<UnixStream> { Ok(self.write.try_clone()?) }

    pub fn receive(&mut self) -> Result<Value> { receive(&mut self.read) }
}

fn receive(read: &mut BufReader<UnixStream>) -> Result<Value> {
    let mut line = String::new();
    let count = read.take(1024 * 1024 + 1).read_line(&mut line)?;
    if count == 0 { bail!("local event stream disconnected"); }
    if count > 1024 * 1024 { bail!("local event frame exceeded its size limit"); }
    Ok(serde_json::from_str(&line)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::ControlError;
    use std::os::unix::net::UnixListener;
    use std::sync::{Arc, Mutex};

    /// An owner that answers each request as `answer` says, or holds it
    /// unanswered (`None`). Returns its socket and the commands it was sent.
    fn owner(dir: &Path, answer: fn(&ControlRequest) -> Option<ControlResponse>) -> (PathBuf, Arc<Mutex<Vec<String>>>) {
        let socket = dir.join("owner.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        std::thread::spawn(move || for stream in listener.incoming().flatten() {
            let seen = seen.clone();
            std::thread::spawn(move || {
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap()).read_line(&mut line).unwrap();
                let request: ControlRequest = serde_json::from_str(&line).unwrap();
                seen.lock().unwrap().push(request.command.clone());
                match answer(&request) {
                    Some(response) => { let _ = writeln!(&stream, "{}", serde_json::to_string(&response).unwrap()); }
                    None => std::thread::sleep(Duration::from_secs(10)),
                }
            });
        });
        (socket, asked)
    }

    fn refusal(request: &ControlRequest, code: &str) -> Option<ControlResponse> {
        Some(ControlResponse::failure(request.id.clone(), ControlError::new(code, "refused", None::<String>)))
    }

    #[test]
    fn an_owner_too_old_for_liveness_is_asked_for_its_status() {
        let dir = tempfile::tempdir().unwrap();
        let (socket, asked) = owner(dir.path(), |request| match request.command.as_str() {
            "runtime.liveness" => refusal(request, "unsupported"),
            _ => Some(ControlResponse::success(request.id.clone(), json!({"localRuntime": {"epoch": "old"}}))),
        });
        assert_eq!(liveness(&socket, "token").unwrap()["localRuntime"]["epoch"], "old");
        assert_eq!(*asked.lock().unwrap(), ["runtime.liveness", "status"]);
    }

    #[test]
    fn an_owner_that_answers_liveness_is_never_asked_for_status() {
        let dir = tempfile::tempdir().unwrap();
        let (socket, asked) = owner(dir.path(), |request| Some(ControlResponse::success(request.id.clone(), json!({"command": request.command}))));
        assert_eq!(liveness(&socket, "token").unwrap()["command"], "runtime.liveness");
        assert_eq!(*asked.lock().unwrap(), ["runtime.liveness"]);
    }

    /// The review of #661: with every request place held by stuck work, an
    /// owner answers `busy`, and a desktop must offer a restart for that just
    /// as for an owner that never answers.
    #[test]
    fn an_owner_that_turns_requests_away_or_never_answers_is_not_answering() {
        let dir = tempfile::tempdir().unwrap();
        let (busy, _) = owner(&subdir(dir.path(), "busy"), |request| refusal(request, "busy"));
        let error = request(&busy, "token", "runtime.liveness", json!({}), QUICK_TIMEOUT).unwrap_err();
        assert!(unanswered(&error), "{error:#}");
        assert_eq!(error.to_string(), "busy: refused", "a refusal still reads as it did");

        let (silent, _) = owner(&subdir(dir.path(), "silent"), |_| None);
        let error = request(&silent, "token", "runtime.liveness", json!({}), Duration::from_millis(200)).unwrap_err();
        assert!(error.is::<Unresponsive>() && unanswered(&error), "{error:#}");

        let (unauthorized, _) = owner(&subdir(dir.path(), "refuses"), |request| refusal(request, "unauthorized"));
        let error = request(&unauthorized, "token", "runtime.liveness", json!({}), QUICK_TIMEOUT).unwrap_err();
        assert!(!unanswered(&error), "an owner that answers with a reason is answering: {error:#}");
    }

    fn subdir(parent: &Path, name: &str) -> PathBuf {
        let dir = parent.join(name);
        std::fs::create_dir(&dir).unwrap();
        dir
    }
}
