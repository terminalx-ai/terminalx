//! Source-derived boundary drafts; no provider fixture or protocol inference.
use super::*;
use std::sync::atomic::AtomicUsize;

// Per-waiter, one-shot observation at the actual join helper boundary. No
// production hook, shared global schedule, sleep or process fixture is added.
thread_local! {
    static BEFORE_JOIN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
}

pub(super) fn before_join() {
    let observe = BEFORE_JOIN.with(|slot| slot.borrow_mut().take());
    if let Some(observe) = observe { observe(); }
}

struct ExitSink {
    calls: Arc<AtomicUsize>,
    panic_drop: Option<Arc<AtomicUsize>>,
}
impl Sink for ExitSink {
    fn stdout_line(&self, _: String) {}
    fn stderr_line(&self, _: String) {}
    fn exited(&self, pid: u32, code: Option<i32>) {
        assert!(pid == 41 || pid == 42);
        assert!(code == Some(0) || code.is_none());
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Some(drops) = &self.panic_drop { std::panic::panic_any(PanickingDrop(drops.clone())); }
    }
}

struct PanickingDrop(Arc<AtomicUsize>);
impl Drop for PanickingDrop {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
        panic!("panic payload destructor must not run on the waiter");
    }
}

#[test]
fn rollback_cancels_and_joins_parked_readers_without_entering_callbacks() {
    let entered = Arc::new(AtomicUsize::new(0));
    let mut start = StartingChild { child: None, readers: Vec::new() };
    for name in ["stdout", "stderr"] {
        let entered = entered.clone();
        start.readers.push(start_reader(name.into(), move || {
            entered.fetch_add(1, Ordering::SeqCst);
            panic!("a failed start must not enter a caller's locked sink");
        }).unwrap());
    }
    start.rollback().unwrap();
    assert!(start.readers.is_empty());
    assert_eq!(entered.load(Ordering::SeqCst), 0);
    start.rollback().unwrap(); // Ownership was consumed, not retained for a second kill.
}

#[cfg(unix)]
#[test]
fn partial_start_rollback_reaps_process_and_joins_each_started_reader() {
    use std::os::unix::process::CommandExt;
    // Exercise the exact rollback used after stdout/stderr/wait Builder failure.
    // The shell is a local pipe fixture, never a provider.
    for reader_count in 0..=2 {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "read line"]).process_group(0)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = command.spawn().unwrap();
        let pid = child.id();
        let mut start = StartingChild { child: Some(child), readers: Vec::new() };
        let entered = Arc::new(AtomicUsize::new(0));
        for index in 0..reader_count {
            let entered = entered.clone();
            start.readers.push(start_reader(format!("partial-{index}"), move || {
                entered.fetch_add(1, Ordering::SeqCst);
                ReaderEnd::Eof
            }).unwrap());
        }
        start.rollback().unwrap();
        assert!(!is_alive(pid));
        assert!(start.child.is_none());
        assert!(start.readers.is_empty());
        assert_eq!(entered.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn leader_exit_cannot_publish_terminal_receipt_before_reader_join() {
    let (release, blocked) = mpsc::channel();
    let (entered, ready) = mpsc::channel();
    let stdout = start_reader("drain-out".into(), move || {
        entered.send(()).unwrap();
        blocked.recv().unwrap();
        ReaderEnd::Eof
    }).unwrap().begin();
    ready.recv_timeout(Duration::from_secs(2)).unwrap();
    let stderr = start_reader("drain-err".into(), || ReaderEnd::Eof).unwrap().begin();
    let live = Arc::new(LiveChild { pid: 41, epoch: 7, stdin: Mutex::new(None), terminal: Arc::new(Mutex::new(None)) });
    let terminal = live.terminal.clone();
    let (at_join, reached_join) = mpsc::channel();
    let (resume, proceed) = mpsc::channel();
    let calls = Arc::new(AtomicUsize::new(0));
    let sink = ExitSink { calls: calls.clone(), panic_drop: None };
    let worker = std::thread::spawn(move || {
        BEFORE_JOIN.with(|slot| *slot.borrow_mut() = Some(Box::new(move || {
            at_join.send(()).unwrap();
            proceed.recv().unwrap();
        })));
        let receipt = finish_readers(41, 7, true, Some(0), vec![stdout, stderr], &sink);
        *terminal.lock().unwrap() = Some(receipt);
    });
    reached_join.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1); // Actual exit callback preceded join.
    assert_eq!(live.terminal_receipt(), None); // Waiter reached the join boundary.
    release.send(()).unwrap();
    resume.send(()).unwrap();
    worker.join().unwrap();
    let receipt = live.terminal_receipt().unwrap();
    assert_eq!((receipt.pid, receipt.epoch, receipt.code), (41, 7, Some(0)));
    assert!(receipt.leader_reaped);
    assert_eq!((receipt.stdout, receipt.stderr), (ReaderEnd::Eof, ReaderEnd::Eof));
}

#[test]
fn reader_panicking_drop_payload_cannot_skip_the_other_join_or_receipt() {
    let drops = Arc::new(AtomicUsize::new(0));
    let payload = drops.clone();
    let stdout = start_reader("panic-out".into(), move || std::panic::panic_any(PanickingDrop(payload))).unwrap().begin();
    assert_panic_receipt(stdout, None, &drops, ReaderEnd::Panicked, false);
}

#[test]
fn actual_exit_callback_panicking_drop_payload_cannot_skip_joins_or_receipt() {
    let drops = Arc::new(AtomicUsize::new(0));
    let stdout = start_reader("error-out".into(), || ReaderEnd::ReadError).unwrap().begin();
    assert_panic_receipt(stdout, Some(drops.clone()), &drops, ReaderEnd::ReadError, true);
}

fn assert_panic_receipt(stdout: JoinHandle<ReaderEnd>, exit_payload: Option<Arc<AtomicUsize>>, drops: &AtomicUsize, expected_stdout: ReaderEnd, expected_exit_panic: bool) {
    let (release, blocked) = mpsc::channel();
    let (entered, ready) = mpsc::channel();
    let stderr_done = Arc::new(AtomicUsize::new(0));
    let done = stderr_done.clone();
    let stderr = start_reader("controlled-err".into(), move || {
        entered.send(()).unwrap();
        blocked.recv().unwrap();
        done.fetch_add(1, Ordering::SeqCst);
        ReaderEnd::Eof
    }).unwrap().begin();
    ready.recv_timeout(Duration::from_secs(2)).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let sink = ExitSink { calls: calls.clone(), panic_drop: exit_payload };
    let live = Arc::new(LiveChild { pid: 42, epoch: 8, stdin: Mutex::new(None), terminal: Arc::new(Mutex::new(None)) });
    let terminal = live.terminal.clone();
    let (at_join, reached_join) = mpsc::channel();
    let (resume, proceed) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        BEFORE_JOIN.with(|slot| *slot.borrow_mut() = Some(Box::new(move || {
            at_join.send(()).unwrap();
            proceed.recv().unwrap();
        })));
        let receipt = finish_readers(42, 8, false, None, vec![stdout, stderr], &sink);
        *terminal.lock().unwrap() = Some(receipt);
    });
    reached_join.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(live.terminal_receipt(), None);
    release.send(()).unwrap();
    resume.send(()).unwrap();
    worker.join().unwrap(); // The waiter must survive payload destruction hazards.
    assert_eq!(drops.load(Ordering::SeqCst), 0); // Intentional exceptional forget.
    assert_eq!(stderr_done.load(Ordering::SeqCst), 1);
    let receipt = live.terminal_receipt().unwrap();
    assert!(!receipt.leader_reaped); // Supplied unknown reap evidence, not a Child wait test.
    assert_eq!(receipt.code, None);
    assert_eq!(receipt.exit_callback_panicked, expected_exit_panic);
    assert_eq!(receipt.stdout, expected_stdout);
    assert_eq!(receipt.stderr, ReaderEnd::Eof);
}

#[test]
fn stdout_preserves_line_decoding_but_reports_read_failure_instead_of_eof() {
    let mut lines = Vec::new();
    assert_eq!(read_stdout(&b"first\r\n\nlast\xff"[..], |s| lines.push(s)), ReaderEnd::Eof);
    assert_eq!(lines, ["first", "last\u{fffd}"]);
    struct Broken;
    impl std::io::Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("read failure fixture"))
        }
    }
    assert_eq!(read_stdout(Broken, |_| panic!("no line available")), ReaderEnd::ReadError);
}
