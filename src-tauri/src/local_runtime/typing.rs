//! Desktop typing, delivered to each pane in order by a thread of its own.
//! A program that stops reading keeps its typing waiting here, not in a
//! request and not under a lock: the window's write returns once its bytes
//! are queued, and they reach the program, in full and in order, when it reads
//! again. A paste into a shell busy with a command waits for the command, as
//! it does in any terminal, instead of being cut off part way (#661).

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};

use super::mobile::Registry;
use crate::pty::{InputStalled, Terminals};

/// Unread typing one pane may have waiting. Past it the program is plainly not
/// reading, and further typing is refused whole rather than kept.
const BACKLOG: usize = 1024 * 1024;
/// The most one attempt writes, so a long paste goes in pieces.
const CHUNK: usize = 64 * 1024;
/// How long typing waits before trying again while its program is not reading.
const RETRY: Duration = Duration::from_millis(250);

/// Typing refused because the pane already has [`BACKLOG`] waiting.
#[derive(Debug)]
pub struct Backlogged {
    pub waiting: usize,
}

impl std::fmt::Display for Backlogged {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "The program in this terminal is not reading its input; {} bytes of typing are already waiting, so this was not sent.", self.waiting)
    }
}

impl std::error::Error for Backlogged {}

/// One pane's waiting typing, and the process it was typed at: typing never
/// goes to a process that replaced the one it was meant for.
struct Waiting {
    pid: u32,
    bytes: VecDeque<u8>,
}

#[derive(Default)]
pub struct Typing(Arc<Mutex<HashMap<String, Waiting>>>);

impl Typing {
    /// Queue `bytes` for pane `id`, and start its delivery if none is running.
    /// Refused at once for a pane a mobile device drives, one that is not
    /// running, or one whose program has left [`BACKLOG`] of typing unread.
    pub fn send(&self, mobile: &Arc<Registry>, terminals: &Arc<Terminals>, id: &str, bytes: &[u8]) -> Result<()> {
        mobile.check_desktop_input(id)?;
        let pid = terminals.pid(id).filter(|_| terminals.is_running(id)).context("no such terminal")?;
        let mut panes = self.0.lock().unwrap();
        let deliver = !panes.contains_key(id);
        let waiting = panes.entry(id.to_string()).or_insert_with(|| Waiting { pid, bytes: VecDeque::new() });
        if waiting.pid != pid {
            // What was typed at the process before has nobody to read it.
            *waiting = Waiting { pid, bytes: VecDeque::new() };
        }
        if waiting.bytes.len() + bytes.len() > BACKLOG {
            let waiting = waiting.bytes.len();
            // Only an entry made just now: one a delivery thread owns stays,
            // or a second thread could start on the same queue.
            if deliver { panes.remove(id); }
            return Err(Backlogged { waiting }.into());
        }
        waiting.bytes.extend(bytes);
        if deliver {
            let (queue, mobile, terminals, pane) = (self.0.clone(), mobile.clone(), terminals.clone(), id.to_string());
            let spawned = std::thread::Builder::new().name(format!("pty-typing-{id}")).spawn(move || deliver_all(&queue, &mobile, &terminals, &pane));
            if let Err(error) = spawned {
                panes.remove(id);
                return Err(error).context("start delivering terminal input");
            }
        }
        Ok(())
    }
}

/// Write a pane's waiting typing until none is left. Holds the pane's gate
/// only for one attempt at a time, so a mobile claim or resize is never kept
/// waiting longer than that.
fn deliver_all(queue: &Mutex<HashMap<String, Waiting>>, mobile: &Registry, terminals: &Terminals, id: &str) {
    loop {
        let (pid, chunk) = {
            let mut panes = queue.lock().unwrap();
            match panes.get(id) {
                Some(waiting) if !waiting.bytes.is_empty() => (waiting.pid, waiting.bytes.iter().take(CHUNK).copied().collect::<Vec<_>>()),
                _ => {
                    panes.remove(id);
                    return;
                }
            }
        };
        let outcome = mobile.desktop_input(id, || terminals.write_for_process(id, pid, &chunk));
        let (written, failure) = match outcome {
            Ok(()) => (chunk.len(), None),
            Err(error) => match error.downcast_ref::<InputStalled>() {
                Some(stalled) => (stalled.written, None),
                None => (0, Some(error)),
            },
        };
        let mut panes = queue.lock().unwrap();
        // Typing for a process that has since replaced this one is left alone.
        let Some(waiting) = panes.get_mut(id).filter(|waiting| waiting.pid == pid) else { continue };
        waiting.bytes.drain(..written);
        if let Some(error) = failure {
            let lost = waiting.bytes.len();
            panes.remove(id);
            log::warn!("[{id}] {lost} bytes of typing were not delivered: {error:#}");
            return;
        }
        let stalled = written < chunk.len();
        drop(panes);
        if stalled {
            std::thread::sleep(RETRY);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::PaneSpec;
    use std::time::Instant;

    fn pane(terminals: &Terminals, dir: &tempfile::TempDir, id: &str, command: &str) {
        let sink: Arc<dyn crate::sink::EventSink> = Arc::new(crate::sink::BroadcastSink::new(64));
        terminals.spawn(sink, id, PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some(command), env: &[] }).unwrap();
    }

    /// A program in raw mode, so typing past the input queue waits for it
    /// instead of being thrown away as a cooked line's overflow is.
    fn raw(terminals: &Terminals, dir: &tempfile::TempDir, id: &str, then: &str) {
        let ready = dir.path().join(format!("{id}.ready"));
        let _ = std::fs::remove_file(&ready);
        pane(terminals, dir, id, &format!("sh -c 'stty raw -echo; touch {}; {then}'", ready.display()));
        until("the program never set its terminal up", || ready.exists());
    }

    fn until(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(60);
        while !done() {
            assert!(Instant::now() < deadline, "{what}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// The review of #661: a paste into a program that is not reading must
    /// reach it whole once it reads again, not stop at the first kilobyte.
    #[cfg(unix)]
    #[test]
    fn typing_at_a_program_that_is_not_reading_arrives_whole_once_it_reads() {
        let terminals = Arc::new(Terminals::new());
        let mobile = Arc::new(Registry::default());
        let typing = Typing::default();
        let dir = tempfile::tempdir().unwrap();
        let received = dir.path().join("received");
        // Reads nothing for its first moments, then everything.
        raw(&terminals, &dir, "busy", &format!("sleep 3; head -c 200000 > {}; sleep 600", received.display()));
        let paste: Vec<u8> = (0..200_000u32).map(|n| b'a' + (n % 26) as u8).collect();
        let sent = Instant::now();
        for piece in paste.chunks(40_000) {
            typing.send(&mobile, &terminals, "busy", piece).unwrap();
        }
        assert!(sent.elapsed() < Duration::from_secs(1), "queuing waited on the program");
        until("the paste never arrived whole", || std::fs::metadata(&received).is_ok_and(|file| file.len() == 200_000));
        assert_eq!(std::fs::read(&received).unwrap(), paste);
        until("delivery did not finish", || typing.0.lock().unwrap().is_empty());
        terminals.kill_all();
    }

    #[cfg(unix)]
    #[test]
    fn typing_past_the_backlog_is_refused_whole_and_never_reaches_a_replacement() {
        let terminals = Arc::new(Terminals::new());
        let mobile = Arc::new(Registry::default());
        let typing = Typing::default();
        let dir = tempfile::tempdir().unwrap();
        raw(&terminals, &dir, "deaf", "sleep 600");
        typing.send(&mobile, &terminals, "deaf", &vec![b'x'; BACKLOG - 10]).unwrap();
        // More than the terminal's own input queue can have taken meanwhile.
        let error = typing.send(&mobile, &terminals, "deaf", &[b'y'; 4096]).unwrap_err();
        assert!(error.downcast_ref::<Backlogged>().is_some_and(|backlog| backlog.waiting > 0), "{error:#}");

        // The program goes; what was typed at it is not handed to its successor.
        let received = dir.path().join("received");
        terminals.kill_and_wait("deaf", Duration::from_secs(5));
        raw(&terminals, &dir, "deaf", &format!("cat > {}", received.display()));
        until("the old process's typing was not let go", || typing.0.lock().unwrap().is_empty());
        typing.send(&mobile, &terminals, "deaf", b"fresh").unwrap();
        until("the replacement never got its own typing", || std::fs::read(&received).is_ok_and(|bytes| bytes == b"fresh"));
        terminals.kill_all();
    }

    #[test]
    fn typing_for_a_pane_that_is_not_running_is_refused() {
        let typing = Typing::default();
        assert!(typing.send(&Arc::new(Registry::default()), &Arc::new(Terminals::new()), "gone", b"x").is_err());
        assert!(typing.0.lock().unwrap().is_empty());
    }
}
