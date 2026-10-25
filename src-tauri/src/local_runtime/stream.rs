//! Authenticated local event and PTY taps. No process belongs to a connection.
//! Slow/disconnected clients lose their taps, never their terminal processes.
//! The desktop bridge decodes PTY bytes back into the existing raw IPC channel.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Semaphore};

use crate::hooks::ControlEndpoint;
use crate::pty::Terminals;
use crate::sink::BroadcastSink;

const MAX_FRAME: usize = 1024 * 1024;
const QUEUED_BYTES: usize = 2 * 1024 * 1024;
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

struct Queued {
    bytes: Vec<u8>,
    _budget: tokio::sync::OwnedSemaphorePermit,
}

#[derive(Clone)]
struct Output {
    tx: mpsc::Sender<Queued>,
    budget: Arc<Semaphore>,
    failed: tokio_util::sync::CancellationToken,
}

impl Output {
    fn send(&self, value: Value) -> bool {
        let mut bytes = match serde_json::to_vec(&value) {
            Ok(bytes) if bytes.len() <= MAX_FRAME => bytes,
            _ => { self.failed.cancel(); return false; }
        };
        bytes.push(b'\n');
        let Ok(budget) = self.budget.clone().try_acquire_many_owned(bytes.len() as u32) else {
            self.failed.cancel();
            return false;
        };
        if self.tx.try_send(Queued { bytes, _budget: budget }).is_err() {
            self.failed.cancel();
            return false;
        }
        true
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Hello {
    protocol: u64,
    token: String,
}

#[derive(Deserialize)]
#[serde(tag = "method", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
enum Input {
    Attach { id: String, token: String },
    Ack { id: String, token: String, drawn: u64 },
    Detach { id: String, token: String },
    Ping,
}

async fn frame(reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>, bytes: &mut Vec<u8>) -> Result<Vec<u8>> {
    // read_until alone would allow an unauthenticated peer to grow memory
    // without ever sending a newline.
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() { bail!("local client disconnected"); }
        let end = available.iter().position(|byte| *byte == b'\n').map(|at| at + 1);
        let take = end.unwrap_or(available.len());
        if bytes.len() + take > MAX_FRAME { bail!("local frame is too large"); }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take);
        if end.is_some() { return Ok(std::mem::take(bytes)); }
    }
}

struct Attached {
    terminals: Arc<Terminals>,
    window: String,
    lifetime: Arc<super::Lifetime>,
    lease: Value,
}

impl Drop for Attached {
    fn drop(&mut self) {
        self.terminals.detach_window(&self.window);
        let _ = self.lifetime.command("runtime.detach", self.lease.clone());
    }
}

pub fn start(endpoint: &ControlEndpoint, sink: Arc<BroadcastSink>, terminals: Arc<Terminals>, lifetime: Arc<super::Lifetime>) -> Result<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = endpoint.socket.with_file_name(format!("local-{}.sock", std::process::id()));
    // The lifetime lock is held; never unlink a live or unexpected endpoint.
    if path.exists() {
        use std::os::unix::fs::FileTypeExt;
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.file_type().is_socket() || std::os::unix::net::UnixStream::connect(&path).is_ok() {
            bail!("local event endpoint is already in use or is not a socket");
        }
        std::fs::remove_file(&path)?;
    }
    let listener = tokio::net::UnixListener::bind(&path).context("bind local event socket")?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    let token = endpoint.token.clone();
    let clients = Arc::new(Semaphore::new(super::MAX_CLIENTS));
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let Ok(slot) = clients.clone().try_acquire_owned() else { continue };
            let (token, sink, terminals, lifetime) = (token.clone(), sink.clone(), terminals.clone(), lifetime.clone());
            tokio::spawn(async move {
                let _slot = slot;
                if let Err(error) = connection(socket, &token, sink, terminals, lifetime).await {
                    log::debug!("local event connection ended: {error}");
                }
            });
        }
    });
    Ok(path)
}

async fn connection(socket: tokio::net::UnixStream, token: &str, sink: Arc<BroadcastSink>, terminals: Arc<Terminals>, lifetime: Arc<super::Lifetime>) -> Result<()> {
    let (read, mut write) = socket.into_split();
    let mut read = BufReader::new(read);
    // Lives outside select: cancellation while a frame is partial must not
    // discard bytes already consumed when an event wins the select race.
    let mut pending = Vec::new();
    let hello: Hello = serde_json::from_slice(&tokio::time::timeout(Duration::from_secs(5), frame(&mut read, &mut pending)).await??)?;
    if hello.protocol != super::PROTOCOL || !crate::hooks::token_matches(token, &hello.token) {
        bail!("local event authentication or protocol rejected");
    }
    let lease = lifetime.command("runtime.attach", json!({"protocol":hello.protocol}))
        .map_err(|error| anyhow::anyhow!(error.message))?;
    let attached = Attached { terminals: terminals.clone(), window: format!("local:{}", uuid::Uuid::new_v4()), lifetime: lifetime.clone(), lease };
    let mut events = sink.subscribe();
    let (tx, mut rx) = mpsc::channel::<Queued>(64);
    let output = Output { tx, budget: Arc::new(Semaphore::new(QUEUED_BYTES)), failed: tokio_util::sync::CancellationToken::new() };
    output.send(json!({"type":"ready", "attachment":attached.lease}));
    let writer_failed = output.failed.clone();
    let writer = tokio::spawn(async move {
        while let Some(queued) = rx.recv().await {
            if !matches!(tokio::time::timeout(WRITE_TIMEOUT, write.write_all(&queued.bytes)).await, Ok(Ok(()))) {
                break;
            }
        }
        writer_failed.cancel();
    });
    // Abort the writer on every return, including malformed input. Its queue
    // must not keep this socket and its byte budget alive after disconnect.
    struct Writer(tokio::task::JoinHandle<()>);
    impl Drop for Writer { fn drop(&mut self) { self.0.abort(); } }
    let _writer = Writer(writer);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            _ = output.failed.cancelled() => bail!("local output lagged or disconnected; reattach for replay"),
            incoming = frame(&mut read, &mut pending) => {
                let _request = lifetime.enter().map_err(|error| anyhow::anyhow!(error.message))?;
                let input: Input = serde_json::from_slice(&incoming?)?;
                match input {
                    Input::Attach { id, token } => {
                        if id.len() > 256 || token.len() > 256 { bail!("invalid pane attachment"); }
                        let output = output.clone();
                        let (pane, view) = (id.clone(), token.clone());
                        terminals.attach(&attached.window, &id, &format!("{}:{token}", attached.window), Box::new(move |bytes| {
                            output.send(json!({"type":"pty", "id":pane, "token":view,
                                "data":base64::engine::general_purpose::STANDARD.encode(bytes)}))
                        }));
                    }
                    Input::Ack { id, token, drawn } => terminals.ack(&id, &format!("{}:{token}", attached.window), drawn),
                    Input::Detach { id, token } => terminals.detach(&id, &format!("{}:{token}", attached.window)),
                    Input::Ping => { output.send(json!({"type":"pong"})); }
                }
            }
            event = events.recv() => {
                let event = event.context("local event stream lagged; reattach for replay")?;
                // Raw PTYs use explicitly attached taps and acknowledgements.
                // Never broadcast every pane's base64 stream to every window.
                if event.event.as_ref() != "pty_data" {
                    let payload: Value = serde_json::from_str(&event.payload)?;
                    output.send(json!({"type":"event", "event":event.event.as_ref(), "payload":payload}));
                }
            }
            _ = heartbeat.tick() => {
                lifetime.command("runtime.heartbeat", attached.lease.clone()).map_err(|error| anyhow::anyhow!(error.message))?;
            }
        }
    }
}
