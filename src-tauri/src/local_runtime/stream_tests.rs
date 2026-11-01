//! The event socket served in process, against real terminals (#716): a view
//! or events that fall behind cost no connection, and every end is logged.

use super::*;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::OnceLock;

use serde_json::Value;

use crate::local_runtime::bridge::Bridge;
use crate::local_runtime::client::Client;
use crate::pty::{PaneSpec, SCROLLBACK_BYTES};
use crate::sink::EventSink;

/// What was logged at info and above while these tests ran.
struct Captured(Mutex<Vec<(log::Level, String)>>);

impl log::Log for Captured {
    fn enabled(&self, metadata: &log::Metadata) -> bool { metadata.level() <= log::Level::Info }
    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            self.0.lock().unwrap().push((record.level(), record.args().to_string()));
        }
    }
    fn flush(&self) {}
}

fn captured() -> &'static Captured {
    static CAPTURED: OnceLock<&'static Captured> = OnceLock::new();
    CAPTURED.get_or_init(|| {
        let captured: &'static Captured = Box::leak(Box::new(Captured(Mutex::default())));
        log::set_logger(captured).expect("nothing else in this test binary installs a logger");
        log::set_max_level(log::LevelFilter::Info);
        captured
    })
}

/// The lines logged so far that contain `text`.
fn logged(text: &str) -> Vec<(log::Level, String)> {
    captured().0.lock().unwrap().iter().filter(|(_, line)| line.contains(text)).cloned().collect()
}

fn wait(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(60);
    while !done() {
        assert!(Instant::now() < deadline, "{what} within 60 s");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|window| window == needle)
}

/// A runtime's event socket and the terminals it serves.
struct Rig {
    sink: Arc<BroadcastSink>,
    terminals: Arc<Terminals>,
    lifetime: Arc<super::super::Lifetime>,
    path: PathBuf,
    token: String,
    dir: tempfile::TempDir,
    runtime: tokio::runtime::Runtime,
    _home: crate::store::TempHome,
}

impl Rig {
    fn new(events: usize) -> Self {
        captured();
        let home = crate::store::temp_home();
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().unwrap();
        let endpoint = crate::hooks::prepare_control().unwrap();
        let sink = Arc::new(BroadcastSink::new(events));
        let terminals = Arc::new(Terminals::new());
        let lifetime = super::super::Lifetime::new(Duration::from_secs(60));
        let path = {
            let _entered = runtime.enter();
            start(&endpoint, sink.clone(), terminals.clone(), lifetime.clone()).unwrap()
        };
        Self { sink, terminals, lifetime, path, token: endpoint.token.clone(), dir: tempfile::tempdir().unwrap(), runtime, _home: home }
    }

    fn pane(&self, id: &str, command: &str) {
        let spec = PaneSpec { cwd: self.dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some(command), env: &[] };
        let sink: Arc<dyn EventSink> = self.sink.clone();
        self.terminals.spawn(sink, id, spec).unwrap();
    }

    fn hello(&self, stream: Option<&str>, window: Option<&str>) -> Value {
        let mut hello = json!({"protocol": super::super::PROTOCOL, "token": self.token});
        if let Some(stream) = stream { hello["stream"] = json!(stream); }
        if let Some(window) = window { hello["window"] = json!(window); }
        hello
    }

    fn connect(&self, hello: Value) -> Peer {
        Peer::connect(&self.path, hello)
    }

    /// The desktop's own client of this socket.
    fn client(&self) -> Arc<Client> {
        Client::for_stream(self.path.clone(), &self.token, self.lifetime.status()["epoch"].as_str().unwrap())
    }
}

impl Drop for Rig {
    fn drop(&mut self) { self.terminals.kill_all(); }
}

/// A client of the socket that reads only when told to.
struct Peer {
    socket: UnixStream,
    buffer: Vec<u8>,
}

impl Peer {
    fn connect(path: &std::path::Path, hello: Value) -> Self {
        let mut socket = UnixStream::connect(path).unwrap();
        socket.set_read_timeout(Some(Duration::from_millis(200))).unwrap();
        writeln!(socket, "{hello}").unwrap();
        let mut peer = Self { socket, buffer: Vec::new() };
        assert_eq!(peer.next()["type"], "ready");
        peer
    }

    fn send(&mut self, frame: Value) {
        writeln!(self.socket, "{frame}").unwrap();
    }

    /// Read at most `limit` more bytes. `false` once the runtime has closed the connection.
    fn fill(&mut self, limit: usize) -> bool {
        let mut chunk = vec![0; limit];
        match self.socket.read(&mut chunk) {
            Ok(0) => false,
            Ok(read) => {
                self.buffer.extend_from_slice(&chunk[..read]);
                true
            }
            Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => true,
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => false,
            Err(error) => panic!("read: {error}"),
        }
    }

    fn take(&mut self) -> Option<Value> {
        let end = self.buffer.iter().position(|byte| *byte == b'\n')?;
        let line: Vec<u8> = self.buffer.drain(..=end).collect();
        Some(serde_json::from_slice(&line).unwrap())
    }

    fn next(&mut self) -> Value {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(frame) = self.take() { return frame; }
            assert!(self.fill(256 * 1024), "the runtime closed the connection");
            assert!(Instant::now() < deadline, "no frame within 60 s");
        }
    }

    /// Every frame up to and including the first that `wanted` picks.
    fn until(&mut self, wanted: impl Fn(&Value) -> bool) -> Vec<Value> {
        let mut frames = Vec::new();
        loop {
            let frame = self.next();
            let done = wanted(&frame);
            frames.push(frame);
            if done { return frames; }
        }
    }

    /// The connection is open and answers.
    fn answers(&mut self) {
        self.send(json!({"method": "ping"}));
        self.until(|frame| frame["type"] == "pong");
    }

    /// The runtime closes the connection within 60 s.
    fn closed(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while self.fill(256 * 1024) {
            self.buffer.clear();
            assert!(Instant::now() < deadline, "the connection was still open after 60 s");
        }
    }
}

/// What the frames carried of the output of the view attached as `token`.
fn output(frames: &[Value], token: &str) -> Vec<u8> {
    frames.iter().filter(|frame| frame["type"] == "pty" && frame["token"] == token)
        .flat_map(|frame| base64::engine::general_purpose::STANDARD.decode(frame["data"].as_str().unwrap()).unwrap())
        .collect()
}

/// Prints `bytes` of one letter once told to, then `marker`.
fn flood(bytes: usize, letter: char, marker: &str) -> String {
    format!("sh -c 'read go; head -c {bytes} /dev/zero | tr \"\\000\" {letter}; echo; echo {marker}; exec sleep 600'")
}

#[test]
fn a_replay_is_one_frame_and_longer_output_is_split_to_fit() {
    let (output, mut rx) = Output::new();
    let view = ViewTap { output, budget: Arc::new(Semaphore::new(VIEW_QUEUED_BYTES)), id: "pane".into(), token: "t".into(),
        told: true, peer: Arc::from("test"), tally: Arc::default() };
    assert!(view.send(&vec![b'r'; SCROLLBACK_BYTES]));
    let frame = rx.try_recv().unwrap();
    assert!(frame.bytes.len() < MAX_FRAME, "{}", size(frame.bytes.len()));
    assert!(rx.try_recv().is_err(), "a full replay is one frame");
    drop(frame);
    assert!(view.send(&vec![b'r'; SCROLLBACK_BYTES + 1]));
    assert!(rx.try_recv().unwrap().bytes.len() < MAX_FRAME);
    assert!(rx.try_recv().unwrap().bytes.len() < MAX_FRAME);
}

#[test]
fn a_view_that_acknowledges_what_it_draws_never_reaches_its_budget() {
    // Its most outstanding output, the scrollback replay counted in: a pane
    // is held once it is `FLOW_HIGH` ahead, after one more flush of at most
    // two chunks. As base64, with each frame's envelope (256 bytes is generous)
    // for the smallest pieces live output can come in.
    let outstanding = crate::pty::FLOW_HIGH + 2 * crate::pty::MAX_CHUNK;
    let frames = outstanding.div_ceil(1024);
    let encoded = frames * 256 + outstanding.div_ceil(3) * 4;
    assert!(encoded < VIEW_QUEUED_BYTES, "{} of {}", size(encoded), size(VIEW_QUEUED_BYTES));
}

/// #716: a view whose window has all but stopped reading falls behind on its
/// own. The desktop lets that view go and tells its window, which attaches it
/// again from the pane's scrollback; the other pane's output keeps coming,
/// and the connection stays up.
#[test]
fn a_view_far_behind_is_let_go_alone_and_caught_up_from_scrollback() {
    let rig = Rig::new(1024);
    rig.pane("quiet", "cat");
    // 8 MiB, far past the 2 MiB a view may have queued.
    rig.pane("flood", &flood(8 * 1024 * 1024, 'x', "flood-done"));
    let client = rig.client();
    let window_sink = Arc::new(BroadcastSink::new(64));
    let lagged = Arc::new(Mutex::new(Vec::new()));
    let heard = lagged.clone();
    window_sink.listen("pty_view_lagged", Box::new(move |payload| heard.lock().unwrap().push(payload.to_string())));
    let lost = Arc::new(Mutex::new(None::<String>));
    let losing = lost.clone();
    let bridge = Bridge::connect_views(&client, window_sink.clone(), "behind", Some(Box::new(move |reason| *losing.lock().unwrap() = Some(reason)))).unwrap();

    // The flood's window draws a piece every quarter of a second, and never says what it drew.
    let slow = Arc::new(AtomicBool::new(true));
    let drawing = slow.clone();
    bridge.attach("flood", "f", Box::new(move |_| {
        if drawing.load(Ordering::Relaxed) { std::thread::sleep(Duration::from_millis(250)); }
        true
    })).unwrap();
    let (quiet_tap, quiet) = std::sync::mpsc::channel::<Vec<u8>>();
    let quiet_tap = Mutex::new(quiet_tap);
    bridge.attach("quiet", "q", Box::new(move |bytes| quiet_tap.lock().unwrap().send(bytes.to_vec()).is_ok())).unwrap();
    wait("both views attached", || rig.terminals.stats().views == 2);
    rig.terminals.write("flood", b"go\n").unwrap();

    wait("the flood's view let go", || !lagged.lock().unwrap().is_empty());
    slow.store(false, Ordering::Relaxed);
    assert_eq!(*lagged.lock().unwrap(), [r#"{"id":"flood","token":"f"}"#], "told once, naming the view that fell behind");
    assert_eq!(rig.terminals.stats().views, 1, "the runtime let go of that view alone");
    // The runtime and the desktop each record it once, naming the connection.
    let runtime = logged("pane \"flood\" fell behind with 2.0 MiB of its output");
    assert_eq!(runtime.len(), 1, "{runtime:?}");
    assert_eq!(runtime[0].0, log::Level::Info);
    assert!(runtime[0].1.starts_with("terminal output of window \"behind\": "), "{runtime:?}");
    let desktop = logged("the view of pane \"flood\" fell behind; it is drawn again from the pane's scrollback");
    assert_eq!(desktop.len(), 1, "{desktop:?}");
    assert!(desktop[0].1.starts_with("terminal output of window \"behind\": "), "{desktop:?}");

    // The other pane's output still flows over the same connection.
    rig.terminals.write("quiet", b"still-here\n").unwrap();
    let mut seen = Vec::new();
    while !contains(&seen, b"still-here") {
        seen.extend(quiet.recv_timeout(Duration::from_secs(60)).expect("the quiet pane's output"));
    }

    // Attached again, the view starts from the pane's scrollback: the latest of the flood.
    let (caught_up, replay) = std::sync::mpsc::channel::<Vec<u8>>();
    let caught_up = Mutex::new(caught_up);
    bridge.attach("flood", "f2", Box::new(move |bytes| caught_up.lock().unwrap().send(bytes.to_vec()).is_ok())).unwrap();
    let first = replay.recv_timeout(Duration::from_secs(60)).expect("the replay");
    assert!(first.len() >= 64 * 1024 && first[..64 * 1024].iter().all(|byte| *byte == b'x'), "the replay is the flood's tail");
    let mut tail = first;
    while !contains(&tail, b"flood-done") {
        tail.extend(replay.recv_timeout(Duration::from_secs(60)).expect("the rest of the flood"));
    }
    assert_eq!(*lost.lock().unwrap(), None, "the connection was never lost");
    assert!(bridge.attachment().is_ok());

    // Its end is one line naming it, and what it had been through.
    drop(bridge);
    wait("its end logged", || !logged("local connection ended: terminal output of window \"behind\"").is_empty());
    let ended = logged("local connection ended: terminal output of window \"behind\"");
    assert_eq!(ended.len(), 1, "{ended:?}");
    assert_eq!(ended[0].0, log::Level::Info, "the desktop closed it");
    assert!(ended[0].1.contains("the client closed the connection; 1 terminal views fell behind"), "{ended:?}");
}

/// Four replays of a full scrollback at once are 2.7 MiB as base64: more
/// than a whole connection could hold before #716, which closed it.
#[test]
fn four_full_scrollbacks_attached_at_once_all_arrive_on_an_open_connection() {
    let rig = Rig::new(1024);
    for n in 1..=4 {
        rig.pane(&format!("full{n}"), &flood(600_000, 'y', &format!("full-{n}-done")));
        rig.terminals.write(&format!("full{n}"), b"go\n").unwrap();
    }
    wait("four full scrollbacks", || (1..=4).all(|n| rig.terminals.read_output(&format!("full{n}"))
        .is_some_and(|printed| printed.len() == SCROLLBACK_BYTES && contains(&printed, format!("full-{n}-done").as_bytes()))));
    let mut peer = rig.connect(rig.hello(Some("terminals"), Some("four")));
    for n in 1..=4 { peer.send(json!({"method": "attach", "id": format!("full{n}"), "token": format!("t{n}")})); }
    // Nothing is read until all four are queued.
    wait("four views attached", || rig.terminals.stats().views == 4);

    let mut frames = Vec::new();
    while !(1..=4).all(|n| contains(&output(&frames, &format!("t{n}")), format!("full-{n}-done").as_bytes())) {
        frames.push(peer.next());
    }
    assert!(frames.iter().all(|frame| frame["type"] == "pty"), "nothing fell behind: {:?}", frames.iter().find(|frame| frame["type"] != "pty"));
    for n in 1..=4 {
        let replayed = output(&frames, &format!("t{n}"));
        assert!(replayed.len() >= SCROLLBACK_BYTES - 4096, "view {n} got {}", size(replayed.len()));
    }
    assert!(frames.iter().all(|frame| frame.to_string().len() < MAX_FRAME), "each frame fits");
    peer.answers();
    assert!(logged("window \"four\"").is_empty(), "nothing to log: {:?}", logged("window \"four\""));
}

/// An event over the 1 MiB a frame carries goes to no terminal-output
/// connection, and on the event connection is logged and reported as
/// missed: neither connection closes.
#[test]
fn an_event_too_large_to_send_is_logged_and_reported_and_closes_nothing() {
    let rig = Rig::new(1024);
    rig.pane("echo", "cat");
    let mut terminals = rig.connect(rig.hello(Some("terminals"), Some("big-event")));
    terminals.send(json!({"method": "attach", "id": "echo", "token": "e"}));
    wait("the view attached", || rig.terminals.stats().views == 1);
    let client = rig.client();
    let desktop_sink = Arc::new(BroadcastSink::new(64));
    let reread = Arc::new(Mutex::new(Vec::new()));
    let heard = reread.clone();
    desktop_sink.listen("local_runtime_reattached", Box::new(move |payload| heard.lock().unwrap().push(payload.to_string())));
    let events_bridge = Bridge::connect(&client, desktop_sink.clone(), None).unwrap();
    let mut events = rig.connect(rig.hello(Some("events"), None));

    let sink: &dyn EventSink = &*rig.sink;
    sink.emit("oversized_test_event", &json!({"blob": "x".repeat(1_200_000)}));
    sink.emit("after_the_oversized_event", &json!({"ok": true}));
    let frames = events.until(|frame| frame["type"] == "missed");
    assert_eq!(frames.last().unwrap()["events"], 1);
    assert!(frames.iter().any(|frame| frame["event"] == "after_the_oversized_event"), "later events still arrive");
    assert!(!frames.iter().any(|frame| frame["event"] == "oversized_test_event"));
    events.answers();
    // The desktop re-reads what the missed event changed, as after a reconnect.
    wait("the desktop told its windows to re-read", || !reread.lock().unwrap().is_empty());
    assert_eq!(*reread.lock().unwrap(), [r#"{"missedEvents":1}"#]);
    assert!(events_bridge.attachment().is_ok());

    let line = logged("event \"oversized_test_event\" is 1.1 MiB, over the 1.0 MiB one frame carries; it was not sent");
    assert_eq!(line.len(), 2, "once for each event connection: {line:?}");
    assert!(line.iter().all(|(level, line)| *level == log::Level::Warn && line.starts_with("the desktop's event connection: ")), "{line:?}");
    wait("the missed event reported", || logged("events were not delivered (1 over 1.0 MiB)").len() == 2);

    // The terminal-output connection carried none of it, and still flows.
    rig.terminals.write("echo", b"after-the-event\n").unwrap();
    let frames = terminals.until(|frame| contains(&output(std::slice::from_ref(frame), "e"), b"after-the-event"));
    assert!(frames.iter().all(|frame| frame["type"] == "pty"), "{:?}", frames.iter().find(|frame| frame["type"] != "pty"));
    terminals.answers();
    // An event connection takes no terminal output.
    events.send(json!({"method": "attach", "id": "echo", "token": "wrong"}));
    events.closed();
    wait("the refusal logged", || !logged("an event connection carries no terminal output").is_empty());
}

/// Events published faster than the connection takes them: the oldest are
/// dropped for it, counted, and reported, and the connection goes on. Every
/// one of them is either delivered or counted.
#[test]
fn events_faster_than_the_connection_takes_them_are_counted_not_fatal() {
    let rig = Rig::new(4);
    let mut events = rig.connect(rig.hello(Some("events"), None));
    // Both of the runtime's workers are held while the burst is published,
    // so the connection takes none of it as it comes.
    let held = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let release = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    for _ in 0..2 {
        let (held, release) = (held.clone(), release.clone());
        rig.runtime.spawn(async move {
            held.fetch_add(1, Ordering::SeqCst);
            let (released, wake) = &*release;
            let _released = wake.wait_while(released.lock().unwrap(), |released| !*released).unwrap();
        });
    }
    wait("both workers held", || held.load(Ordering::SeqCst) == 2);
    let sink: &dyn EventSink = &*rig.sink;
    const BURST: u64 = 5_000;
    for n in 0..BURST { sink.emit("burst", &json!({"n": n})); }
    *release.0.lock().unwrap() = true;
    release.1.notify_all();
    let (mut delivered, mut missed, mut last) = (0, 0, None);
    while delivered + missed < BURST {
        let frame = events.next();
        match frame["type"].as_str() {
            Some("event") if frame["event"] == "burst" => {
                delivered += 1;
                last = frame["payload"]["n"].as_u64();
            }
            Some("missed") => missed += frame["events"].as_u64().unwrap(),
            _ => {}
        }
    }
    assert_eq!(delivered + missed, BURST);
    assert!(missed > 0, "a channel of 4 cannot hold a burst of {BURST}");
    assert_eq!(last, Some(BURST - 1), "the newest events are the ones kept");
    events.answers();
    wait("the shortfall logged", || !logged("while the connection fell behind the app's events").is_empty());
}

/// A desktop from before #716 names no stream: it takes events and output on
/// one connection, and when it cannot be told what it missed, the
/// connection closes, as that desktop expects.
#[test]
fn a_desktop_from_before_716_takes_both_on_one_connection_and_is_closed_not_told() {
    let rig = Rig::new(1024);
    rig.pane("echo", "cat");
    let mut peer = rig.connect(rig.hello(None, None));
    peer.send(json!({"method": "attach", "id": "echo", "token": "e"}));
    wait("the view attached", || rig.terminals.stats().views == 1);
    let sink: &dyn EventSink = &*rig.sink;
    sink.emit("legacy_event", &json!({"ok": true}));
    rig.terminals.write("echo", b"legacy-output\n").unwrap();
    let mut frames = Vec::new();
    while !(frames.iter().any(|frame: &Value| frame["event"] == "legacy_event") && contains(&output(&frames, "e"), b"legacy-output")) {
        frames.push(peer.next());
    }
    peer.answers();
    sink.emit("oversized_legacy_event", &json!({"blob": "x".repeat(1_200_000)}));
    peer.closed();
    wait("its end logged", || !logged("local connection ended: a combined event and terminal connection").is_empty());
    let ended = logged("local connection ended: a combined event and terminal connection");
    assert_eq!(ended[0].0, log::Level::Warn);
    assert!(ended[0].1.contains("event \"oversized_legacy_event\" is 1.1 MiB"), "{ended:?}");
}

#[test]
fn a_connection_end_says_which_connection_it_was_and_why() {
    let account = |hello: Value| {
        let hello: Hello = serde_json::from_value(hello).unwrap();
        Account { peer: Arc::from(describe(&hello)), authenticated: true, tally: Arc::default() }
    };
    let views = account(json!({"protocol": 1, "token": "t", "stream": "terminals", "window": "main"}));
    views.tally.lagged.store(2, Ordering::Relaxed);
    let (level, line) = ended(&views, Duration::from_secs(3 * 3600 + 120), &anyhow::anyhow!("the client did not read a 64.1 KiB frame within 10.0 s"));
    assert_eq!(level, log::Level::Warn);
    assert_eq!(line, "local connection ended: terminal output of window \"main\", connected for 3 h 2 min: \
        the client did not read a 64.1 KiB frame within 10.0 s; 2 terminal views fell behind and started again from scrollback");
    let events = account(json!({"protocol": 1, "token": "t", "stream": "events"}));
    events.tally.missed.store(7, Ordering::Relaxed);
    let (level, line) = ended(&events, Duration::from_millis(1500), &anyhow::Error::new(Closed));
    assert_eq!(level, log::Level::Info, "a desktop closing its own connection is no fault");
    assert_eq!(line, "local connection ended: the desktop's event connection, connected for 1.5 s: the client closed the connection; 7 events could not be delivered");
    // A window name cannot forge a line of its own.
    let forged = account(json!({"protocol": 1, "token": "t", "stream": "terminals", "window": "main\"\n[ERROR] forged"}));
    assert_eq!(&*forged.peer, "terminal output of window \"main???ERROR??forged\"");
    let probe = Account::default();
    assert_eq!(ended(&probe, Duration::ZERO, &anyhow::Error::new(Closed)).0, log::Level::Debug, "a probe of the socket is not news");
}
