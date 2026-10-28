//! Process-bounded owner lifecycle regressions. Shell children exercise Host
//! drain and cancellation only; they are not provider compatibility evidence.
use super::*;
use std::sync::mpsc;
use serde_json::json;

const CASE: &str = "TERMINALX_TEST_STDIO_OWNER_CASE";
const WAIT: Duration = Duration::from_secs(3);

thread_local! {
    static FULL_PIPE: std::cell::RefCell<Option<mpsc::Sender<()>>> = const { std::cell::RefCell::new(None) };
}
pub(super) fn observed_full_pipe() {
    FULL_PIPE.with(|hook| { if let Some(tx) = hook.borrow_mut().take() { tx.send(()).unwrap(); } });
}

#[test]
fn owned_stdio_lifecycle_is_process_bounded() {
    for case in ["admission-drain", "retain-drained-child", "full-input-pipe", "expired-input-pipe", "stale-control"] {
        let dir = tempfile::tempdir().unwrap();
        let log = std::fs::File::create(dir.path().join("child.log")).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "session::codex_stdio::tests::child_fixture", "--nocapture"])
            .env(CASE, case).env("TERMINALX_HOME", dir.path().join("store"))
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log)
            .spawn().unwrap();
        let until = Instant::now() + Duration::from_secs(15);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() { break status; }
            if Instant::now() >= until {
                child.kill().unwrap(); child.wait().unwrap();
                panic!("{case}: owner lifecycle exceeded process deadline");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(status.success(), "{case}: {}", std::fs::read_to_string(dir.path().join("child.log")).unwrap());
    }
}

struct GateSink {
    sink: StdioSink,
    entered: mpsc::Sender<()>,
    release: Mutex<mpsc::Receiver<()>>,
    settled: mpsc::Sender<()>,
}
impl Sink for GateSink {
    fn stdout_line(&self, line: String) {
        self.entered.send(()).unwrap();
        self.release.lock().unwrap().recv_timeout(WAIT).unwrap();
        self.sink.stdout_line(line);
        self.settled.send(()).unwrap();
    }
    fn stderr_line(&self, line: String) { self.sink.stderr_line(line); }
    fn stdout_closed(&self, end: crate::harness::host::ReaderEnd) { self.sink.stdout_closed(end); }
    fn exited(&self, pid: u32, code: Option<i32>) { self.sink.exited(pid, code); }
    fn drained(&self, receipt: &TerminalReceipt) { self.sink.drained(receipt); }
}

#[test]
fn child_fixture() {
    let Ok(case) = std::env::var(CASE) else { return };
    let _home = store::temp_home();
    let root = store::root().unwrap();
    let session: index::SessionEntry = serde_json::from_value(json!({
        "id":"stdio-owner", "projectPath":root, "cwd":root, "title":"fixture",
        "created":index::now(), "modified":index::now(),
        "tabs":[{"id":"tab", "harness":"codex", "transport":"experimentalCodexStdio", "permissionMode":"auto", "created":index::now()}]
    })).unwrap();
    index::save(&[session]).unwrap();
    let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)),
        Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
        Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    let rt_arc = manager.runtime("stdio-owner", "tab").unwrap();
    let (entered, observed) = mpsc::channel();
    let (release, gate) = mpsc::channel();
    let (settled, done) = mpsc::channel();
    let mut rt = rt_arc.lock().unwrap();
    let mut engine = Stdio::new(root.to_string_lossy().into_owned(), String::new(), None, "auto".into());
    let frame = if matches!(case.as_str(), "expired-input-pipe" | "stale-control") {
        engine.thread = Some("thread".into());
        engine.ready = true;
        engine.handle(r#"{"method":"turn/started","params":{"threadId":"thread","turn":{"id":"turn"}}}"#).unwrap();
        let StdioAction::Write(mut frame) = engine.interrupt().unwrap().remove(0) else { panic!("missing interrupt") };
        // Inflate a typed frame to exercise partial delivery, not protocol
        // compatibility. This shell child never interprets the bytes.
        let mut json: serde_json::Value = serde_json::from_str(&frame.line).unwrap();
        json["testPadding"] = serde_json::Value::String("x".repeat(1024 * 1024));
        frame.line = json.to_string();
        frame
    } else { Outbound::connection("large input".repeat(65536)) };
    let launch = engine.launch.clone();
    rt.engine = Engine::CodexStdio(engine);
    if case == "stale-control" {
        let Engine::CodexStdio(engine) = &mut rt.engine else { unreachable!() };
        engine.handle(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}"#).unwrap();
        drop(rt);
        // There is deliberately no child: a stale, entirely unsent control
        // must retire before touching stdin and without failing the owner.
        manager.write_codex_frame(&Arc::downgrade(&rt_arc), &launch, frame).unwrap();
        assert!(matches!(&rt_arc.lock().unwrap().engine, Engine::CodexStdio(e) if !e.blocked));
        return;
    }
    let sink = Arc::new(GateSink { sink: StdioSink { manager: manager.clone(), rt: rt_arc.clone(), launch: launch.clone() },
        entered, release: Mutex::new(gate), settled });
    // A complete buffered frame is held at the callback boundary. The process
    // exits naturally, so even a failed assertion leaves no long-lived child.
    let script = if matches!(case.as_str(), "full-input-pipe" | "expired-input-pipe") {
        r#"printf '%s\n' '{"method":"thread/status/changed","params":{"threadId":"unbound"}}'; exec sleep 10"#
    } else {
        r#"printf '%s\n' '{"method":"thread/status/changed","params":{"threadId":"unbound"}}'"#
    };
    let args = vec!["-c".into(), script.into()];
    let child = manager.host.spawn(&rt.key(), SpawnSpec { program: Path::new("/bin/sh"), args: &args, cwd: &root, env: &[] }, sink).unwrap();
    rt.child_pid = Some(child.pid); rt.child = Some(child.clone());
    drop(rt);
    observed.recv_timeout(WAIT).unwrap();
    if matches!(case.as_str(), "full-input-pipe" | "expired-input-pipe") {
        // The production writer fills the initially blocking pipe itself.
        // No prefill changes the descriptor flags before the writer runs.
        let writer_manager = manager.clone();
        let runtime = Arc::downgrade(&rt_arc);
        let (finished, result) = mpsc::channel();
        let (blocked, full_pipe) = mpsc::channel();
        let writer = std::thread::spawn(move || {
            FULL_PIPE.with(|hook| *hook.borrow_mut() = Some(blocked));
            finished.send(writer_manager.write_codex_frame(&runtime, &launch, frame)).unwrap();
        });
        full_pipe.recv_timeout(WAIT).unwrap();
        // Buffered stdout and Stop must both advance despite the full stdin.
        release.send(()).unwrap();
        done.recv_timeout(WAIT).unwrap();
        assert!(matches!(&rt_arc.lock().unwrap().engine, Engine::CodexStdio(e) if !e.blocked && !e.exited));
        assert!(matches!(result.try_recv(), Err(mpsc::TryRecvError::Empty)));
        if case == "expired-input-pipe" {
            let mut rt = rt_arc.lock().unwrap();
            let Engine::CodexStdio(engine) = &mut rt.engine else { panic!("owner missing") };
            engine.handle(r#"{"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn","status":"completed"}}}"#).unwrap();
            drop(rt);
            let error = result.recv_timeout(WAIT).unwrap().unwrap_err();
            assert!(error.to_string().contains("partial write"), "expired partial frame must fail, got {error:#}");
            manager.stop("stdio-owner", "tab").unwrap();
        } else {
            manager.stop("stdio-owner", "tab").unwrap();
            let error = result.recv_timeout(WAIT).unwrap().unwrap_err();
            assert!(error.to_string().contains("cancelled"), "expected Stop cancellation, got {error:#}");
        }
        writer.join().unwrap();
        assert!(child.terminal_receipt().is_some());
    } else if case == "admission-drain" {
        // This is the distinguishing close/delete/stop-all schedule: admission
        // stays held until Stop has received the Host terminal receipt.
        let _admission = crate::issue_pipeline::admission::lock();
        release.send(()).unwrap();
        manager.stop("stdio-owner", "tab").unwrap();
        done.recv_timeout(WAIT).unwrap();
        assert!(child.terminal_receipt().is_some());
    } else {
        release.send(()).unwrap();
        done.recv_timeout(WAIT).unwrap();
        let until = Instant::now() + WAIT;
        while child.terminal_receipt().is_none() {
            assert!(Instant::now() < until, "Host did not publish reader receipt");
            std::thread::sleep(Duration::from_millis(5));
        }
        let rt = rt_arc.lock().unwrap();
        assert!(matches!(rt.engine, Engine::CodexStdio(_)));
        assert!(rt.child.as_ref().is_some_and(|retained| Arc::ptr_eq(retained, &child)), "drain must retain the exact cleanup witness");
        assert_eq!(rt.child_pid, Some(child.pid));
        drop(rt);
        manager.stop("stdio-owner", "tab").unwrap();
        assert!(rt_arc.lock().unwrap().child.is_none());
    }
}
