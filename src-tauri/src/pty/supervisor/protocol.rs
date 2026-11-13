//! Private inherited socket protocol. No hook, mobile or remote RPC surface.
use std::io;
use std::os::fd::RawFd;
use serde::{Deserialize, Serialize};
use serde::de::DeserializeOwned;
use uuid::Uuid;

pub(super) const VERSION: u8 = 1;
pub(super) const MAX_FRAME: usize = 96 * 1024;
pub(super) const CHUNK: usize = 16 * 1024;
pub(super) const MAX_CONFIG: usize = 8 * 1024 * 1024;
pub(super) const HELPER: &str = "__terminalx-private-pty-supervisor-v1";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Envelope<T> { pub version: u8, pub launch: Uuid, pub body: T }
#[derive(Serialize, Deserialize)]
// snake_case: a private wire format between the runtime and its own helper
// image, never read by the web view or any other program; its field names
// are single words, which this keeps exactly as they are on the wire.
#[serde(tag = "op", rename_all_fields = "snake_case", deny_unknown_fields)]
pub(super) enum Request {
    Config { offset: usize, bytes: Vec<u8> },
    Launch { length: usize },
    /// TERM each of the launch's processes once, then KILL `grace`
    /// milliseconds after this Stop arrived. The same claim again, with a
    /// shorter grace, brings that KILL forward: the caller forcing its stop.
    Stop { claim: u64, #[serde(default = "stop_grace")] grace: u32 },
    Release { claim: u64 },
}

/// A Stop's grace when its caller names none, and the supervisor's own
/// when it stops a launch by itself (its channel lost).
pub(super) const STOP_GRACE: u32 = 400;
fn stop_grace() -> u32 { STOP_GRACE }
#[derive(Debug, Serialize, Deserialize)]
// snake_case, as `Request`: the helper's private wire format.
#[serde(tag = "op", rename_all_fields = "snake_case", deny_unknown_fields)]
pub(super) enum Response {
    Ready { supervisor: u32 },
    /// An observed exec transition, not completed loader work, provider
    /// readiness, first userspace instruction or guaranteed future survival.
    Started { shell: u32 },
    ShellExit { status: i32 },
    Empty,
    Extinct { claim: u64 },
    Unconfirmed { claim: u64 },
    Failed { stage: String, errno: i32 },
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Launch {
    pub executable: Vec<u8>,
    pub argv: Vec<Vec<u8>>,
    pub env: Vec<(Vec<u8>, Vec<u8>)>,
    pub cwd: Vec<u8>,
}

pub(super) fn send<T: Serialize>(fd: RawFd, launch: Uuid, body: &T) -> io::Result<bool> {
    let bytes = serde_json::to_vec(&Envelope { version: VERSION, launch, body })?;
    if bytes.len() > MAX_FRAME { return Err(io::Error::new(io::ErrorKind::InvalidData, "supervisor frame exceeds bound")); }
    let n = unsafe { libc::send(fd, bytes.as_ptr().cast(), bytes.len(), libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL) };
    if n < 0 {
        let e = io::Error::last_os_error();
        if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) { return Ok(false); }
        return Err(e);
    }
    if n as usize != bytes.len() { return Err(io::Error::new(io::ErrorKind::WriteZero, "partial supervisor packet")); }
    Ok(true)
}

pub(super) fn receive<T: DeserializeOwned>(fd: RawFd, launch: Uuid) -> io::Result<Option<T>> {
    let mut bytes = vec![0u8; MAX_FRAME];
    let n = unsafe { libc::recv(fd, bytes.as_mut_ptr().cast(), bytes.len(), libc::MSG_DONTWAIT | libc::MSG_TRUNC) };
    if n < 0 {
        let e = io::Error::last_os_error();
        if matches!(e.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) { return Ok(None); }
        return Err(e);
    }
    if n == 0 { return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "supervisor channel closed")); }
    if n as usize > bytes.len() { return Err(io::Error::new(io::ErrorKind::InvalidData, "oversized supervisor packet")); }
    let envelope: Envelope<T> = serde_json::from_slice(&bytes[..n as usize])
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "malformed supervisor packet"))?;
    if envelope.version != VERSION || envelope.launch != launch {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "stale supervisor protocol/launch"));
    }
    Ok(Some(envelope.body))
}
