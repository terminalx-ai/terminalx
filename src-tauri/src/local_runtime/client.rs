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

pub struct Client {
    socket: PathBuf,
    token: zeroize::Zeroizing<String>,
    epoch: String,
    event_socket: PathBuf,
}

fn request(socket: &Path, token: &str, command: &str, params: Value) -> Result<Value> {
    let mut stream = UnixStream::connect(socket).context("connect to the local runtime")?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    stream.set_read_timeout(Some(Duration::from_secs(120)))?;
    let request = ControlRequest { id: uuid::Uuid::new_v4().to_string(), token: token.into(), command: command.into(), params };
    serde_json::to_writer(&mut stream, &request)?;
    stream.write_all(b"\n")?;
    let mut line = String::new();
    BufReader::new(stream).take(MAX_RESPONSE + 1).read_line(&mut line)?;
    if line.len() as u64 > MAX_RESPONSE { bail!("local runtime response exceeded its size limit"); }
    let response: ControlResponse = serde_json::from_str(&line).context("decode local runtime response")?;
    if response.id != request.id { bail!("local runtime response does not match its request"); }
    if !response.ok {
        let error = response.error.context("local runtime refused the request")?;
        bail!("{}: {}", error.code, error.message);
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
        let status = request(&run.join("hooks.sock"), &token, "status", json!({}))?;
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
        let pinned = request(&socket, &token, "status", json!({}))?;
        if pinned["localRuntime"]["epoch"] != epoch { bail!("runtime changed during attachment"); }
        Ok(Arc::new(Self { socket, event_socket, token, epoch }))
    }

    pub fn call<T: DeserializeOwned>(&self, command: &str, params: Value) -> Result<T> {
        serde_json::from_value(request(&self.socket, &self.token, command, params)?).context("decode local runtime result")
    }

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
