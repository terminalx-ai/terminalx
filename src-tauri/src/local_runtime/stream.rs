//! Authenticated local event and PTY taps. No process belongs to a connection.
//! Slow/disconnected clients lose their taps, never their terminal processes.
//! The desktop bridge decodes PTY bytes back into the existing raw IPC channel.
//!
//! A connection carries one stream, which its hello names (#716): the app's
//! events, or one window's terminal output. Neither is closed for being read
//! too slowly. A terminal view that falls behind is dropped on its own and
//! the client told (`lagged`); its window attaches it again, from the pane's
//! scrollback, and the other views on the connection go on as they were.
//! Events that cannot be delivered are counted and the client told how many
//! (`missed`), so it re-reads what they changed. A client that names no stream
//! (a desktop from before #716) takes both on one connection and, as it
//! expects, loses the connection instead.
//!
//! Every connection's end is logged at info or above, saying which it was and
//! why it ended: the runtime's log is the evidence of a dropped connection.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::value::RawValue;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc, OwnedSemaphorePermit, Semaphore};

use super::log_file::{size, span};
use crate::hooks::ControlEndpoint;
use crate::pty::Terminals;
use crate::sink::{BroadcastSink, Published};

/// The longest frame either side sends, its newline included.
const MAX_FRAME: usize = 1024 * 1024;
/// Event and terminal frames queued for one connection and not yet written.
const QUEUED_BYTES: usize = 8 * 1024 * 1024;
/// Terminal frames queued for one view. A view that acknowledges what it
/// draws has at most `pty::FLOW_HIGH` and a chunk outstanding, a full
/// scrollback replay included: 1.4 MiB as base64. Only a view whose window
/// stopped reading reaches this.
const VIEW_QUEUED_BYTES: usize = 2 * 1024 * 1024;
/// Greetings, pongs and notices. These are queued past the budgets above, so
/// a connection whose queue is full can still say that a view fell behind;
/// only a client that pings and never reads fills this.
const CONTROL_BYTES: usize = 256 * 1024;
/// Terminal output goes in frames of at most this: a full scrollback replay
/// is one, and as base64 it fits a frame. Anything longer is split rather than
/// refused, or a view handed it would fall behind on every attach.
const PTY_PIECE: usize = crate::pty::SCROLLBACK_BYTES;
/// How long the client may take to read one frame. A desktop that has not
/// read 683 KiB in this long has stopped reading altogether.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Missed events are reported this long after the first of them, so a burst
/// costs the client one re-read, not one for each event.
const MISSED_REPORT: Duration = Duration::from_millis(250);
// A full scrollback replay fits one view's queue, and four views at their
// limit fit the connection's.
const _: () = assert!(crate::pty::SCROLLBACK_BYTES.div_ceil(3) * 4 < VIEW_QUEUED_BYTES);
const _: () = assert!(4 * VIEW_QUEUED_BYTES <= QUEUED_BYTES);
/// The longest window name a hello may give.
const MAX_WINDOW_NAME: usize = 64;

/// The client closed the connection: the one ending that is no fault.
#[derive(Debug, thiserror::Error)]
#[error("the client closed the connection")]
struct Closed;

/// Why a connection cannot go on. The first reason given is the one logged.
#[derive(Default)]
struct Failure {
    token: tokio_util::sync::CancellationToken,
    why: Mutex<Option<String>>,
}

impl Failure {
    fn fail(&self, why: String) {
        self.why.lock().unwrap().get_or_insert(why);
        self.token.cancel();
    }

    fn reason(&self) -> String {
        self.why.lock().unwrap().clone().unwrap_or_else(|| "the connection failed".into())
    }
}

struct Queued {
    bytes: Vec<u8>,
    _budget: OwnedSemaphorePermit,
    _view: Option<OwnedSemaphorePermit>,
}

/// What a connection has queued for its client, and what it may queue.
#[derive(Clone)]
struct Output {
    tx: mpsc::UnboundedSender<Queued>,
    frames: Arc<Semaphore>,
    control: Arc<Semaphore>,
    failure: Arc<Failure>,
}

impl Output {
    fn new() -> (Self, mpsc::UnboundedReceiver<Queued>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (Self { tx, frames: Arc::new(Semaphore::new(QUEUED_BYTES)), control: Arc::new(Semaphore::new(CONTROL_BYTES)),
            failure: Arc::default() }, rx)
    }

    /// A greeting, pong or notice. Fails the connection only when the client
    /// has read none of the last 256 KiB of them.
    fn control(&self, value: &serde_json::Value) -> bool {
        let Some(bytes) = encode(value) else {
            self.failure.fail("a reply was too large to send".into());
            return false;
        };
        let Some(budget) = take(&self.control, bytes.len()) else {
            self.failure.fail(format!("the client read nothing while {} of replies and notices waited", size(CONTROL_BYTES)));
            return false;
        };
        self.queue(Queued { bytes, _budget: budget, _view: None })
    }

    /// An event, or a piece of a view's output, if the connection has room
    /// for it, and the view too.
    fn frame(&self, bytes: Vec<u8>, view: Option<&Arc<Semaphore>>) -> bool {
        let view = match view {
            Some(view) => match take(view, bytes.len()) { Some(permit) => Some(permit), None => return false },
            None => None,
        };
        let Some(budget) = take(&self.frames, bytes.len()) else { return false };
        self.queue(Queued { bytes, _budget: budget, _view: view })
    }

    fn queue(&self, queued: Queued) -> bool {
        // Closed only once the writer has stopped, which failed the connection.
        self.tx.send(queued).is_ok()
    }

    /// Bytes queued and not yet written.
    fn queued(&self) -> usize { QUEUED_BYTES.saturating_sub(self.frames.available_permits()) }
}

fn take(budget: &Arc<Semaphore>, bytes: usize) -> Option<OwnedSemaphorePermit> {
    budget.clone().try_acquire_many_owned(u32::try_from(bytes).ok()?).ok()
}

/// One frame and its newline, or `None` if it is over [`MAX_FRAME`].
fn encode(value: &impl Serialize) -> Option<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value).ok()?;
    if bytes.len() >= MAX_FRAME { return None; }
    bytes.push(b'\n');
    Some(bytes)
}

/// What a connection carries, as its hello names it.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Stream {
    Events,
    Terminals,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Hello {
    protocol: u64,
    token: String,
    /// Absent from a desktop older than #716, which takes both streams on
    /// one connection and is closed, not told, when it falls behind.
    #[serde(default)]
    stream: Option<Stream>,
    /// The window a terminal-output connection serves, for the log.
    #[serde(default)]
    window: Option<String>,
}

/// Which connection a log line is about.
fn describe(hello: &Hello) -> String {
    match hello.stream {
        Some(Stream::Events) => "the desktop's event connection".into(),
        Some(Stream::Terminals) => {
            // The client's words, so only so many and none that could forge a line.
            let window: String = hello.window.as_deref().unwrap_or("unnamed").chars().take(MAX_WINDOW_NAME)
                .map(|ch| if ch.is_ascii_alphanumeric() || "-_.:".contains(ch) { ch } else { '?' }).collect();
            format!("terminal output of window \"{window}\"")
        }
        None => "a combined event and terminal connection (a desktop from before #716)".into(),
    }
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
        let available = reader.fill_buf().await.context("reading from the client failed")?;
        if available.is_empty() { return Err(Closed.into()); }
        let end = available.iter().position(|byte| *byte == b'\n').map(|at| at + 1);
        let take = end.unwrap_or(available.len());
        if bytes.len() + take > MAX_FRAME { bail!("the client sent a frame over {}", size(MAX_FRAME)); }
        bytes.extend_from_slice(&available[..take]);
        reader.consume(take);
        if end.is_some() { return Ok(std::mem::take(bytes)); }
    }
}

/// What a connection lost along the way, for the line logged at its end.
#[derive(Default)]
struct Tally {
    lagged: AtomicU64,
    missed: AtomicU64,
}

/// Who a connection was with, filled in as it goes.
struct Account {
    peer: Arc<str>,
    authenticated: bool,
    tally: Arc<Tally>,
}

impl Default for Account {
    fn default() -> Self {
        Self { peer: Arc::from("an unauthenticated local client"), authenticated: false, tally: Arc::default() }
    }
}

/// The line a connection's end is logged with, and how loudly. A desktop
/// closing its own connection is normal; anything else is how a window
/// comes to say its live connection was lost.
fn ended(account: &Account, up: Duration, outcome: &anyhow::Error) -> (log::Level, String) {
    let closed = outcome.chain().any(|cause| cause.is::<Closed>());
    let mut line = format!("local connection ended: {}, connected for {}: {outcome:#}", account.peer, span(up));
    let lagged = account.tally.lagged.load(Ordering::Relaxed);
    if lagged > 0 { line += &format!("; {lagged} terminal views fell behind and started again from scrollback"); }
    let missed = account.tally.missed.load(Ordering::Relaxed);
    if missed > 0 { line += &format!("; {missed} events could not be delivered"); }
    let level = match (closed, account.authenticated) {
        // A probe of the socket, or a client that never said who it was.
        (true, false) => log::Level::Debug,
        (true, true) => log::Level::Info,
        (false, _) => log::Level::Warn,
    };
    (level, line)
}

struct Attached {
    terminals: Arc<Terminals>,
    window: String,
    lifetime: Arc<super::Lifetime>,
    lease: serde_json::Value,
}

impl Drop for Attached {
    fn drop(&mut self) {
        self.terminals.detach_window(&self.window);
        let _ = self.lifetime.command("runtime.detach", self.lease.clone());
    }
}

/// One terminal view on a connection: its pane's output, in pieces, under a
/// budget of its own, so one view that falls behind costs no other its output.
struct ViewTap {
    output: Output,
    budget: Arc<Semaphore>,
    id: String,
    token: String,
    /// The client names its stream, and so knows what `lagged` means.
    told: bool,
    peer: Arc<str>,
    tally: Arc<Tally>,
}

impl ViewTap {
    /// `false` once the view has fallen behind: the pane stops sending to it.
    fn send(&self, bytes: &[u8]) -> bool {
        for piece in bytes.chunks(PTY_PIECE) {
            let frame = encode(&json!({"type":"pty", "id":self.id, "token":self.token,
                "data":base64::engine::general_purpose::STANDARD.encode(piece)}));
            if !frame.is_some_and(|frame| self.output.frame(frame, Some(&self.budget))) {
                return self.fell_behind();
            }
        }
        true
    }

    fn fell_behind(&self) -> bool {
        let queued = VIEW_QUEUED_BYTES.saturating_sub(self.budget.available_permits());
        let behind = format!("pane {:?} fell behind with {} of its output and {} in all queued", self.id, size(queued), size(self.output.queued()));
        if !self.told {
            self.output.failure.fail(behind);
            return false;
        }
        self.tally.lagged.fetch_add(1, Ordering::Relaxed);
        log::info!("{}: {behind}; its window draws it again from the pane's scrollback", self.peer);
        self.output.control(&json!({"type":"lagged", "id":self.id, "token":self.token}));
        false
    }
}

/// Why an event was not delivered.
#[derive(Clone, Copy)]
enum Undelivered {
    /// The connection fell behind the app's events, which dropped the oldest.
    Behind,
    /// Its queue was full.
    Full,
    /// It is too large for one frame.
    Oversized,
}

/// Events this connection could not deliver since it last said so.
#[derive(Default)]
struct Missed {
    behind: u64,
    full: u64,
    oversized: u64,
    since: Option<Instant>,
}

impl Missed {
    fn count(&mut self, why: Undelivered, events: u64) {
        *match why {
            Undelivered::Behind => &mut self.behind,
            Undelivered::Full => &mut self.full,
            Undelivered::Oversized => &mut self.oversized,
        } += events;
        self.since.get_or_insert_with(Instant::now);
    }

    fn total(&self) -> u64 { self.behind + self.full + self.oversized }

    /// When to tell the client, if there is anything to tell.
    fn due(&self) -> Option<Instant> { self.since.map(|since| since + MISSED_REPORT) }

    /// What the log says, and the notice the client is sent.
    fn report(&mut self, peer: &str) -> (String, serde_json::Value) {
        let total = self.total();
        let mut reasons = Vec::new();
        if self.behind > 0 { reasons.push(format!("{} while the connection fell behind the app's events", self.behind)); }
        if self.full > 0 { reasons.push(format!("{} while {} waited to be written", self.full, size(QUEUED_BYTES))); }
        if self.oversized > 0 { reasons.push(format!("{} over {}", self.oversized, size(MAX_FRAME))); }
        let line = format!("{peer}: {total} events were not delivered ({}); the desktop re-reads what they changed", reasons.join(", "));
        *self = Self::default();
        (line, json!({"type":"missed", "events":total}))
    }
}

#[derive(Serialize)]
struct EventFrame<'a> {
    r#type: &'static str,
    event: &'a str,
    payload: &'a RawValue,
}

/// Queue one event, or count it missed. Without a named stream the client
/// cannot be told, and a missed event ends the connection, as it always did.
fn deliver(output: &Output, event: &Published, told: bool, missed: &mut Missed, peer: &str) -> Result<()> {
    let payload: &RawValue = serde_json::from_str(&event.payload).context("an event's payload is not JSON")?;
    let Some(frame) = encode(&EventFrame { r#type: "event", event: &event.event, payload }) else {
        let over = format!("event {:?} is {}, over the {} one frame carries", &*event.event, size(event.payload.len()), size(MAX_FRAME));
        if !told { bail!(over); }
        log::warn!("{peer}: {over}; it was not sent");
        missed.count(Undelivered::Oversized, 1);
        return Ok(());
    };
    if !output.frame(frame, None) {
        if !told { bail!("{} of events and output waited to be written", size(output.queued())); }
        missed.count(Undelivered::Full, 1);
    }
    Ok(())
}

async fn next_event(events: &mut Option<broadcast::Receiver<Published>>) -> Result<Published, RecvError> {
    match events {
        Some(events) => events.recv().await,
        None => std::future::pending().await,
    }
}

async fn wait_until(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await,
        None => std::future::pending().await,
    }
}

/// The stream socket beside the endpoint's: `hooks-<pid>.sock` has
/// `local-<pid>.sock`, so each control endpoint has one of its own.
fn socket_path(endpoint: &ControlEndpoint) -> std::path::PathBuf {
    let name = endpoint.socket.file_name().and_then(|name| name.to_str()).and_then(|name| name.strip_prefix("hooks"))
        .map(|rest| format!("local{rest}")).unwrap_or_else(|| format!("local-{}.sock", std::process::id()));
    endpoint.socket.with_file_name(name)
}

pub fn start(endpoint: &ControlEndpoint, sink: Arc<BroadcastSink>, terminals: Arc<Terminals>, lifetime: Arc<super::Lifetime>) -> Result<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = socket_path(endpoint);
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
            let Ok(slot) = clients.clone().try_acquire_owned() else {
                log::warn!("a local client was turned away: {} are already connected", super::MAX_CLIENTS);
                continue;
            };
            let (token, sink, terminals, lifetime) = (token.clone(), sink.clone(), terminals.clone(), lifetime.clone());
            tokio::spawn(async move {
                let _slot = slot;
                let since = Instant::now();
                let mut account = Account::default();
                if let Err(error) = connection(socket, &token, sink, terminals, lifetime, &mut account).await {
                    let (level, line) = ended(&account, since.elapsed(), &error);
                    log::log!(level, "{line}");
                }
            });
        }
    });
    Ok(path)
}

async fn connection(socket: tokio::net::UnixStream, token: &str, sink: Arc<BroadcastSink>, terminals: Arc<Terminals>,
    lifetime: Arc<super::Lifetime>, account: &mut Account) -> Result<()> {
    let (read, mut write) = socket.into_split();
    let mut read = BufReader::new(read);
    // Lives outside select: cancellation while a frame is partial must not
    // discard bytes already consumed when an event wins the select race.
    let mut pending = Vec::new();
    let hello = tokio::time::timeout(Duration::from_secs(5), frame(&mut read, &mut pending)).await
        .context("the client said nothing within 5 seconds")??;
    let hello: Hello = serde_json::from_slice(&hello).context("the client's hello was not understood")?;
    if hello.protocol != super::PROTOCOL || !crate::hooks::token_matches(token, &hello.token) {
        bail!("local event authentication or protocol rejected");
    }
    account.peer = Arc::from(describe(&hello));
    account.authenticated = true;
    let peer = account.peer.clone();
    let tally = account.tally.clone();
    let stream = hello.stream;
    let told = stream.is_some();
    let lease = lifetime.command("runtime.attach", json!({"protocol":hello.protocol}))
        .map_err(|error| anyhow::anyhow!(error.message))?;
    let attached = Attached { terminals: terminals.clone(), window: format!("local:{}", uuid::Uuid::new_v4()), lifetime: lifetime.clone(), lease };
    // Terminal output never travels as events (`subscribe_app`), and a
    // terminal-output connection takes none at all.
    let mut events = (stream != Some(Stream::Terminals)).then(|| sink.subscribe_app());
    let (output, mut rx) = Output::new();
    output.control(&json!({"type":"ready", "attachment":attached.lease}));
    let failure = output.failure.clone();
    let writer = tokio::spawn(async move {
        while let Some(queued) = rx.recv().await {
            match tokio::time::timeout(WRITE_TIMEOUT, write.write_all(&queued.bytes)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => return failure.fail(format!("writing to the client failed: {error}")),
                Err(_) => return failure.fail(format!("the client did not read a {} frame within {}", size(queued.bytes.len()), span(WRITE_TIMEOUT))),
            }
        }
    });
    // Abort the writer on every return, including malformed input. Its queue
    // must not keep this socket and its byte budget alive after disconnect.
    struct Writer(tokio::task::JoinHandle<()>);
    impl Drop for Writer { fn drop(&mut self) { self.0.abort(); } }
    let _writer = Writer(writer);
    let mut heartbeat = tokio::time::interval(Duration::from_secs(5));
    let mut missed = Missed::default();
    loop {
        tokio::select! {
            _ = output.failure.token.cancelled() => bail!(output.failure.reason()),
            incoming = frame(&mut read, &mut pending) => {
                let _request = lifetime.enter().map_err(|error| anyhow::anyhow!(error.message))?;
                let input: Input = serde_json::from_slice(&incoming?).context("the client sent a frame that was not understood")?;
                match input {
                    Input::Attach { id, token } => {
                        if id.len() > 256 || token.len() > 256 { bail!("invalid pane attachment"); }
                        if stream == Some(Stream::Events) { bail!("an event connection carries no terminal output"); }
                        let view = ViewTap { output: output.clone(), budget: Arc::new(Semaphore::new(VIEW_QUEUED_BYTES)),
                            id: id.clone(), token: token.clone(), told, peer: peer.clone(), tally: tally.clone() };
                        terminals.attach(&attached.window, &id, &format!("{}:{token}", attached.window), Box::new(move |bytes| view.send(bytes)));
                    }
                    Input::Ack { id, token, drawn } => terminals.ack(&id, &format!("{}:{token}", attached.window), drawn),
                    Input::Detach { id, token } => terminals.detach(&id, &format!("{}:{token}", attached.window)),
                    Input::Ping => { output.control(&json!({"type":"pong"})); }
                }
            }
            event = next_event(&mut events) => match event {
                Ok(event) => deliver(&output, &event, told, &mut missed, &peer)?,
                Err(RecvError::Lagged(skipped)) if told => missed.count(Undelivered::Behind, skipped),
                Err(RecvError::Lagged(skipped)) => bail!("the connection fell {skipped} events behind the app's events"),
                Err(RecvError::Closed) => bail!("the runtime stopped publishing events"),
            },
            _ = wait_until(missed.due()) => {
                tally.missed.fetch_add(missed.total(), Ordering::Relaxed);
                let (line, notice) = missed.report(&peer);
                log::warn!("{line}");
                output.control(&notice);
            }
            _ = heartbeat.tick() => {
                lifetime.command("runtime.heartbeat", attached.lease.clone()).map_err(|error| anyhow::anyhow!(error.message))?;
            }
        }
    }
}

#[cfg(test)]
#[path = "stream_tests.rs"]
mod tests;
