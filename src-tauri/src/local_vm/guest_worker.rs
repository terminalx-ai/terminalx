//! Private owner/cua protocol. This is an internal construction seam, not an
//! enabled guest runtime. Production admission stays disabled until every
//! owner-side task effect has been moved behind this boundary.
//!
//! fd 3: inherited AF_UNIX SOCK_STREAM; fd 4: lifetime pipe read end. There
//! is no listener, path lookup, authentication token, or host key in this
//! protocol. The sealed launcher establishes credentials, not SO_PEERCRED
//! on the socketpair (which can describe the pre-fork creator).
#![allow(dead_code)] // Deliberately not connected to production admission yet.
use anyhow::{ensure, Context, Result};

#[path = "guest_worker_channel.rs"]
mod channel;
#[path = "guest_worker_owner.rs"]
mod owner;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::io::{Read, Write};

use super::journal::{validate_id, validate_relative, TaskTarget};

pub(super) const VERSION: u32 = 1;
pub(super) const MAX_FRAME: usize = 16 * 1024 * 1024;
pub(super) const MAX_CHANNEL_BYTES: usize = 256 * 1024 * 1024;
pub(super) const WORKER_HOME: &str = "/home/cua";
pub(super) const WORKER_STATE: &str = "/home/cua/.terminalx-local/worker-runtime";
pub(super) const WORKSPACES: &str = "/home/cua/.terminalx-local/workspaces";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Binding {
    pub environment: String,
    pub generation: String,
    /// Fresh for each process pair. A reconnect cannot revive old requests.
    pub epoch: String,
}
impl Binding {
    fn validate(&self) -> Result<()> {
        for id in [&self.environment, &self.generation, &self.epoch] {
            validate_id(id)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Hello {
    pub version: u32,
    pub binding: Binding,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Provider {
    Codex,
    Claude,
}

/// Only relative names and bytes cross the filesystem boundary. In particular
/// the owner must never open a path returned by the worker, even after checking
/// it with canonicalize: cua can replace it immediately afterwards.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FileBytes {
    pub name: String,
    pub content_base64: String,
}
impl FileBytes {
    fn validate(&self) -> Result<()> {
        use base64::Engine as _;
        ensure!(self.name.len() <= 4096, "file name too long");
        validate_relative(&self.name)?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(&self.content_base64)?;
        ensure!(bytes.len() <= 12 * 1024 * 1024, "file transfer too large");
        Ok(())
    }
}

/// No generic execute, shell, absolute filesystem path or arbitrary RPC method.
/// These operations are implemented by the cua runtime, never by an owner
/// fallback. Replies are observations; only the owner can commit task receipts.
#[derive(Clone, Debug, Serialize, Deserialize)]
// Keep the existing snake_case fields on the guest worker wire.
#[serde(
    tag = "operation",
    rename_all = "snake_case",
    rename_all_fields = "snake_case",
    deny_unknown_fields
)]
pub(super) enum Operation {
    Discover {
        provider: Provider,
    },
    Models {
        provider: Provider,
    },
    LoginStart,
    LoginCancel {
        login: String,
    },
    AccountVerify,
    WorkspaceCreate {
        files: Vec<FileBytes>,
    },
    WorkspaceSnapshot {
        after: Option<String>,
    },
    SessionCreate {
        provider: Provider,
        model: String,
        effort: String,
        permission_mode: String,
    },
    Send {
        session: String,
        tab: String,
        prompt: String,
    },
    Stop {
        session: String,
        tab: String,
    },
    Poll {
        session: String,
        tab: String,
        after: u64,
    },
    Transcript {
        session: String,
        tab: String,
        offset: u64,
    },
    Shutdown,
}
impl Operation {
    fn task_required(&self) -> bool {
        matches!(
            self,
            Self::WorkspaceCreate { .. }
                | Self::WorkspaceSnapshot { .. }
                | Self::SessionCreate { .. }
                | Self::Send { .. }
                | Self::Stop { .. }
                | Self::Poll { .. }
                | Self::Transcript { .. }
        )
    }
    fn validate(&self) -> Result<()> {
        match self {
            Self::WorkspaceCreate { files } => {
                ensure!(files.len() <= 1024, "too many selected files");
                let mut names = std::collections::BTreeSet::new();
                for file in files {
                    file.validate()?;
                    ensure!(names.insert(&file.name), "duplicate file");
                }
            }
            Self::WorkspaceSnapshot { after: Some(name) } => {
                validate_relative(name)?;
            }
            Self::LoginCancel { login } => validate_id(login)?,
            Self::Send {
                session,
                tab,
                prompt,
            } => {
                validate_id(session)?;
                validate_id(tab)?;
                ensure!(
                    !prompt.is_empty() && prompt.len() <= 1024 * 1024,
                    "invalid prompt size"
                );
            }
            Self::Stop { session, tab }
            | Self::Poll { session, tab, .. }
            | Self::Transcript { session, tab, .. } => {
                validate_id(session)?;
                validate_id(tab)?;
            }
            Self::SessionCreate {
                model,
                effort,
                permission_mode,
                ..
            } => {
                ensure!(
                    !model.is_empty()
                        && model.len() <= 256
                        && effort.len() <= 64
                        && permission_mode.len() <= 64,
                    "invalid session settings"
                );
            }
            _ => (),
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub version: u32,
    pub binding: Binding,
    pub sequence: u64,
    pub target: Option<TaskTarget>,
    pub command: Operation,
}
impl Request {
    fn validate(&self, binding: &Binding, sequence: u64) -> Result<()> {
        ensure!(
            self.version == VERSION && &self.binding == binding,
            "wrong worker timeline"
        );
        ensure!(
            self.sequence == sequence && sequence > 0,
            "duplicate or reordered request"
        );
        ensure!(
            self.target.is_some() == self.command.task_required(),
            "wrong command scope"
        );
        if let Some(target) = &self.target {
            ensure!(
                target.environment_id == binding.environment
                    && target.generation == binding.generation,
                "cross-environment task"
            );
            validate_id(&target.task_id)?;
            validate_id(&target.workspace_id)?;
        }
        self.command.validate()
    }
}

#[derive(Debug, Serialize, Deserialize)]
// Keep the existing snake_case fields on the guest worker wire.
#[serde(
    tag = "observation",
    rename_all = "snake_case",
    rename_all_fields = "snake_case",
    deny_unknown_fields
)]
pub(super) enum Observation {
    Provider {
        installed: bool,
        authenticated: bool,
        version: Option<String>,
    },
    Models {
        models: Vec<Model>,
    },
    Login {
        login: String,
        verification_url: String,
        user_code: String,
    },
    Account {
        authenticated: bool,
    },
    Applied,
    Events {
        events: Vec<crate::events::AgentEvent>,
    },
    /// An application failure is still an observation, not proof of no effect.
    Failed {
        reason: String,
    },
    Files {
        files: Vec<FileBytes>,
        next: Option<String>,
    },
    Bytes {
        content_base64: String,
        next_offset: Option<u64>,
    },
    Session {
        session: String,
        tab: String,
    },
    Stopped {
        extinction_confirmed: bool,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Model {
    pub id: String,
    pub label: String,
    pub efforts: Vec<String>,
}

impl Observation {
    fn validate(&self, command: &Operation) -> Result<()> {
        use base64::Engine as _;
        let appropriate = matches!(
            (command, self),
            (_, Self::Failed { .. })
                | (Operation::Discover { .. }, Self::Provider { .. })
                | (Operation::Models { .. }, Self::Models { .. })
                | (Operation::LoginStart, Self::Login { .. })
                | (Operation::AccountVerify, Self::Account { .. })
                | (
                    Operation::LoginCancel { .. }
                        | Operation::WorkspaceCreate { .. }
                        | Operation::Send { .. },
                    Self::Applied
                )
                | (Operation::WorkspaceSnapshot { .. }, Self::Files { .. })
                | (Operation::SessionCreate { .. }, Self::Session { .. })
                | (
                    Operation::Stop { .. } | Operation::Shutdown,
                    Self::Stopped { .. }
                )
                | (Operation::Poll { .. }, Self::Events { .. })
                | (Operation::Transcript { .. }, Self::Bytes { .. })
        );
        ensure!(appropriate, "unexpected worker observation for operation");
        match self {
            Self::Failed { reason } => ensure!(reason.len() <= 4096, "failure text too long"),
            Self::Files { files, next } => {
                ensure!(files.len() <= 1024, "too many snapshot files");
                let mut names = std::collections::BTreeSet::new();
                for file in files {
                    file.validate()?;
                    ensure!(names.insert(&file.name), "duplicate snapshot file");
                }
                if let Some(next) = next {
                    validate_relative(next)?;
                }
            }
            Self::Bytes { content_base64, .. } => {
                ensure!(
                    base64::engine::general_purpose::STANDARD
                        .decode(content_base64)?
                        .len()
                        <= 12 * 1024 * 1024,
                    "transcript chunk too large"
                );
            }
            Self::Session { session, tab } => {
                validate_id(session)?;
                validate_id(tab)?;
            }
            Self::Events { events } => {
                let Operation::Poll {
                    session,
                    tab,
                    after,
                } = command
                else {
                    unreachable!()
                };
                ensure!(events.len() <= 1024, "too many events");
                let mut sequence = *after;
                for event in events {
                    ensure!(
                        &event.session_id == session
                            && &event.tab_id == tab
                            && event.seq > sequence,
                        "unbound or reordered event"
                    );
                    sequence = event.seq;
                }
            }
            Self::Provider { version, .. } => ensure!(
                version.as_ref().is_none_or(|v| v.len() <= 256),
                "version too long"
            ),
            Self::Models { models } => {
                ensure!(models.len() <= 1024, "too many models");
                for model in models {
                    ensure!(
                        !model.id.is_empty()
                            && model.id.len() <= 256
                            && model.label.len() <= 256
                            && model.efforts.len() <= 32
                            && model.efforts.iter().all(|s| s.len() <= 64),
                        "invalid model"
                    );
                }
            }
            Self::Login {
                login,
                verification_url,
                user_code,
            } => {
                validate_id(login)?;
                ensure!(
                    verification_url == "https://auth.openai.com/codex/device"
                        && !user_code.is_empty()
                        && user_code.len() <= 128,
                    "invalid login challenge"
                );
            }
            _ => (),
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Reply {
    pub version: u32,
    pub binding: Binding,
    pub sequence: u64,
    pub target: Option<TaskTarget>,
    pub result: Observation,
}

/// Only transports that can bound each blocking operation may carry frames.
/// This trait is private: an arbitrary Read/Write cannot silently bypass timeouts.
pub(super) trait DeadlineIo: Read + Write {
    fn set_deadline(&mut self, deadline: std::time::Instant) -> std::io::Result<()>;
    fn read_before(
        &mut self,
        bytes: &mut [u8],
        deadline: std::time::Instant,
    ) -> std::io::Result<usize> {
        self.set_deadline(deadline)?;
        self.read(bytes)
    }
    fn write_before(
        &mut self,
        bytes: &[u8],
        deadline: std::time::Instant,
    ) -> std::io::Result<usize> {
        self.set_deadline(deadline)?;
        self.write(bytes)
    }
}
fn time_left(deadline: std::time::Instant) -> std::io::Result<std::time::Duration> {
    deadline
        .checked_duration_since(std::time::Instant::now())
        .filter(|left| !left.is_zero())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::TimedOut, "worker frame deadline"))
}
fn socket_ready(
    stream: &std::os::unix::net::UnixStream,
    events: i16,
    deadline: std::time::Instant,
) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    loop {
        let left = time_left(deadline)?;
        let mut fd = libc::pollfd {
            fd: stream.as_raw_fd(),
            events,
            revents: 0,
        };
        let count = unsafe {
            libc::poll(
                &mut fd,
                1,
                left.as_millis().max(1).min(i32::MAX as u128) as i32,
            )
        };
        if count > 0 {
            time_left(deadline)?;
            return Ok(());
        }
        if count < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}
impl DeadlineIo for std::os::unix::net::UnixStream {
    fn set_deadline(&mut self, deadline: std::time::Instant) -> std::io::Result<()> {
        time_left(deadline)?;
        self.set_nonblocking(true)
    }
    fn read_before(
        &mut self,
        bytes: &mut [u8],
        deadline: std::time::Instant,
    ) -> std::io::Result<usize> {
        self.set_deadline(deadline)?;
        loop {
            socket_ready(self, libc::POLLIN, deadline)?;
            match self.read(bytes) {
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {}
                result => return result,
            }
        }
    }
    fn write_before(
        &mut self,
        bytes: &[u8],
        deadline: std::time::Instant,
    ) -> std::io::Result<usize> {
        self.set_deadline(deadline)?;
        loop {
            socket_ready(self, libc::POLLOUT, deadline)?;
            match self.write(bytes) {
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) =>
                {}
                result => return result,
            }
        }
    }
}
impl<T: DeadlineIo + ?Sized> DeadlineIo for &mut T {
    fn set_deadline(&mut self, deadline: std::time::Instant) -> std::io::Result<()> {
        (**self).set_deadline(deadline)
    }
    fn read_before(
        &mut self,
        bytes: &mut [u8],
        deadline: std::time::Instant,
    ) -> std::io::Result<usize> {
        (**self).read_before(bytes, deadline)
    }
    fn write_before(
        &mut self,
        bytes: &[u8],
        deadline: std::time::Instant,
    ) -> std::io::Result<usize> {
        (**self).write_before(bytes, deadline)
    }
}
#[cfg(test)]
impl DeadlineIo for std::io::Cursor<Vec<u8>> {
    fn set_deadline(&mut self, deadline: std::time::Instant) -> std::io::Result<()> {
        time_left(deadline).map(|_| ())
    }
}
struct FrameIo<'a, S> {
    io: &'a mut S,
    deadline: std::time::Instant,
}
impl<S: DeadlineIo> Read for FrameIo<'_, S> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let count = self.io.read_before(bytes, self.deadline)?;
        time_left(self.deadline)?;
        Ok(count)
    }
}
impl<S: DeadlineIo> Write for FrameIo<'_, S> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let count = self.io.write_before(bytes, self.deadline)?;
        time_left(self.deadline)?;
        Ok(count)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.io.set_deadline(self.deadline)?;
        self.io.flush()?;
        time_left(self.deadline).map(|_| ())
    }
}

/// Four-byte unsigned big endian JSON length, followed by exactly that many
/// bytes. Length checked before allocation; aggregate budget checked before
/// every read/write. Errors permanently poison the channel, including EOF.
struct Wire<S> {
    io: S,
    remaining: usize,
    poisoned: bool,
    frame_timeout: std::time::Duration,
}
impl<S: DeadlineIo> Wire<S> {
    fn new(io: S) -> Self {
        Self {
            io,
            remaining: MAX_CHANNEL_BYTES,
            poisoned: false,
            frame_timeout: std::time::Duration::from_secs(30),
        }
    }
    fn budget(&mut self, len: usize) -> Result<()> {
        ensure!(!self.poisoned, "worker channel fenced");
        ensure!(len > 0 && len <= MAX_FRAME, "invalid frame size");
        self.remaining = self
            .remaining
            .checked_sub(len + 4)
            .context("worker channel budget exhausted")?;
        Ok(())
    }
    fn receive<T: DeserializeOwned>(&mut self) -> Result<T> {
        let result = (|| {
            ensure!(!self.poisoned, "worker channel fenced");
            let deadline = std::time::Instant::now() + self.frame_timeout;
            let mut header = [0; 4];
            FrameIo {
                io: &mut self.io,
                deadline,
            }
            .read_exact(&mut header)?;
            let len = u32::from_be_bytes(header) as usize;
            self.budget(len)?;
            let mut bytes = vec![0; len];
            FrameIo {
                io: &mut self.io,
                deadline,
            }
            .read_exact(&mut bytes)?;
            let value = serde_json::from_slice(&bytes)?;
            time_left(deadline)?;
            Ok(value)
        })();
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }
    fn send<T: Serialize>(&mut self, value: &T) -> Result<()> {
        let result = (|| {
            ensure!(!self.poisoned, "worker channel fenced");
            // A bounded writer also prevents allocating an oversized outbound frame.
            struct Buffer(Vec<u8>);
            impl Write for Buffer {
                fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                    if self.0.len().saturating_add(bytes.len()) > MAX_FRAME {
                        return Err(std::io::Error::other("frame too large"));
                    }
                    self.0.extend_from_slice(bytes);
                    Ok(bytes.len())
                }
                fn flush(&mut self) -> std::io::Result<()> {
                    Ok(())
                }
            }
            let mut bytes = Buffer(Vec::new());
            serde_json::to_writer(&mut bytes, value)?;
            self.budget(bytes.0.len())?;
            let mut frame = FrameIo {
                io: &mut self.io,
                deadline: std::time::Instant::now() + self.frame_timeout,
            };
            frame.write_all(&(bytes.0.len() as u32).to_be_bytes())?;
            frame.write_all(&bytes.0)?;
            frame.flush()?;
            Ok(())
        })();
        if result.is_err() {
            self.poisoned = true;
        }
        result
    }
}

/// Exactly one in-flight operation. The checkpoint callback MUST durably write
/// owner intent before any request byte is dispatched. No automatic reconnect,
/// retry, or replay exists. A reply never commits the owner's durable receipt.
pub(super) struct Owner<S> {
    wire: Wire<S>,
    binding: Binding,
    next: u64,
}
impl<S: DeadlineIo> Owner<S> {
    pub fn connect(io: S, binding: Binding) -> Result<Self> {
        #[cfg(all(target_os = "linux", not(test)))]
        super::guest_account::check_linux_owner()?;
        binding.validate()?;
        let mut wire = Wire::new(io);
        wire.send(&Hello {
            version: VERSION,
            binding: binding.clone(),
        })?;
        let hello: Hello = wire.receive()?;
        ensure!(
            hello.version == VERSION && hello.binding == binding,
            "worker handshake mismatch"
        );
        Ok(Self {
            wire,
            binding,
            next: 1,
        })
    }
    pub fn request(
        &mut self,
        target: Option<TaskTarget>,
        command: Operation,
        checkpoint: impl FnOnce(&Request) -> Result<()>,
    ) -> Result<Observation> {
        ensure!(
            !self.wire.poisoned,
            "worker channel fenced; dispatched outcome unknown"
        );
        let request = Request {
            version: VERSION,
            binding: self.binding.clone(),
            sequence: self.next,
            target,
            command,
        };
        request.validate(&self.binding, self.next)?;
        checkpoint(&request)?;
        // From here every failure fences this incarnation, even if a zero-byte
        // write may have failed: only the durable owner can reconcile intent.
        let result = (|| {
            self.wire.send(&request)?;
            let reply: Reply = self.wire.receive()?;
            ensure!(
                reply.version == VERSION
                    && reply.binding == request.binding
                    && reply.sequence == request.sequence
                    && reply.target == request.target,
                "unbound worker reply"
            );
            reply.result.validate(&request.command)?;
            self.next = self
                .next
                .checked_add(1)
                .context("worker sequence exhausted")?;
            Ok(reply.result)
        })();
        if result.is_err() {
            self.wire.poisoned = true;
        }
        result
    }
}

/// Worker dispatch is deliberately supplied by the cua runtime, not the owner.
/// Consume admission before the effect, so handler/serialization failures cannot
/// make the same request eligible again. Caller shuts down retained children on
/// any error; a new incarnation cannot recover this object's sequence state.
pub(super) struct Worker<S> {
    wire: Wire<S>,
    binding: Binding,
    next: u64,
}
impl<S: DeadlineIo> Worker<S> {
    pub fn accept(io: S) -> Result<Self> {
        #[cfg(all(target_os = "linux", not(test)))]
        super::guest_account::check_linux_worker()?;
        let mut wire = Wire::new(io);
        let hello: Hello = wire.receive()?;
        ensure!(hello.version == VERSION, "unsupported worker protocol");
        hello.binding.validate()?;
        wire.send(&hello)?;
        Ok(Self {
            wire,
            binding: hello.binding,
            next: 1,
        })
    }
    pub fn dispatch(&mut self, effect: impl FnOnce(&Request) -> Result<Observation>) -> Result<()> {
        let result = (|| {
            let request: Request = self.wire.receive()?;
            request.validate(&self.binding, self.next)?;
            self.next = self
                .next
                .checked_add(1)
                .context("worker sequence exhausted")?;
            let result = effect(&request)?;
            result.validate(&request.command)?;
            self.wire.send(&Reply {
                version: VERSION,
                binding: self.binding.clone(),
                sequence: request.sequence,
                target: request.target,
                result,
            })
        })();
        if result.is_err() {
            self.wire.poisoned = true;
        }
        result
    }
}

/// Internal dispatcher loop. The runtime supplies its retained-child shutdown
/// initiator; the watcher runs independently of the operation closure. This
/// does not enable the production entrypoint or provide execution adapters.
fn serve_channel(
    channel: channel::Channel,
    mut effect: impl FnMut(&Request) -> Result<Observation>,
    shutdown: impl FnOnce() + Send + 'static,
) -> Result<()> {
    let lifetime = channel.watch_lifetime(shutdown)?;
    let result = (|| {
        let mut worker = Worker::accept(channel)?;
        loop {
            let mut stopping = false;
            worker.dispatch(|request| {
                lifetime.check()?;
                stopping = matches!(request.command, Operation::Shutdown);
                let result = effect(request)?;
                // A late result must not turn lifetime loss into a receipt.
                lifetime.check()?;
                Ok(result)
            })?;
            if stopping {
                return Ok(());
            }
        }
    })();
    // Malformed frames and dispatcher failures also initiate shutdown, even
    // when the peer leaves both descriptors open. The callback runs once.
    lifetime.revoke();
    result
}

#[cfg(test)]
#[path = "guest_worker_tests.rs"]
mod tests;
