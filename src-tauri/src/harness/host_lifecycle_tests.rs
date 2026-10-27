//! Source-derived boundary drafts; no provider fixture or protocol inference.
use super::*;
use std::sync::atomic::AtomicUsize;

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
    let worker = std::thread::spawn(move || {
        let receipt = finish_readers(41, 7, true, Some(0), vec![stdout, stderr], false);
        *terminal.lock().unwrap() = Some(receipt);
    });
    assert_eq!(live.terminal_receipt(), None);
    release.send(()).unwrap();
    worker.join().unwrap();
    let receipt = live.terminal_receipt().unwrap();
    assert_eq!((receipt.pid, receipt.epoch, receipt.code), (41, 7, Some(0)));
    assert!(receipt.leader_reaped);
    assert_eq!((receipt.stdout, receipt.stderr), (ReaderEnd::Eof, ReaderEnd::Eof));
}

#[test]
fn reader_failure_and_callback_panic_do_not_become_successful_drain() {
    let stdout = start_reader("panic-out".into(), || panic!("sink panic fixture")).unwrap().begin();
    let stderr = start_reader("error-err".into(), || ReaderEnd::ReadError).unwrap().begin();
    let receipt = finish_readers(42, 8, false, None, vec![stdout, stderr], true);
    assert!(!receipt.leader_reaped);
    assert!(receipt.exit_callback_panicked);
    assert_eq!(receipt.code, None);
    assert_eq!(receipt.stdout, ReaderEnd::Panicked);
    assert_eq!(receipt.stderr, ReaderEnd::ReadError);
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
