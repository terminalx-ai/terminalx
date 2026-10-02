//! Terminals. A PTY per pane, the reader's login shell inside it, and output
//! coalesced before it crosses to the webview: every emit is a JS eval, and a
//! flood of tiny reads (a build log, `yes`) is thousands per second, which
//! freezes input. Chunks are gathered for up to 8ms or 32KB and sent once;
//! the first output after a quiet spell (a key's echo) goes at once.
//!
//! A view that shows a pane takes its output over a tap and says how much it
//! has drawn. A pane that is too far ahead of its view stops being read, so
//! the program blocks on its own output instead of the window drowning in it.

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use serde::Serialize;

use crate::sink::EventSink;
const COALESCE: Duration = Duration::from_millis(8);
const MAX_CHUNK: usize = 32 * 1024;
/// Enough raw output to reconstruct a useful terminal tail on a newly attached
/// mobile reader without retaining an unbounded command history in memory.
const SCROLLBACK_BYTES: usize = 512 * 1024;
/// How long a pane gets to exit on its own before it is killed outright.
const TERM_GRACE: Duration = Duration::from_millis(400);

struct Pane {
    master: Box<dyn MasterPty + Send>,
    /// Locked on its own, so a write the program is slow to read blocks
    /// only this pane, not every other pane's resize or kill.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pid: Option<u32>,
    alive: Arc<Mutex<bool>>,
    /// When this pane last wrote something. A caller that has to type into a
    /// program rather than talk to it uses the gap since the last byte as its
    /// only sign that the program has finished drawing and is listening.
    last_output: Arc<Mutex<Option<Instant>>>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
    cwd: String,
}

/// A direct line for one pane's raw output, beside the `pty_data` event: the
/// desktop window attaches one per terminal it shows, so its bytes cross as
/// bytes, to that terminal only. Returns `false` once nobody is receiving.
pub type Tap = Box<dyn Fn(&[u8]) -> bool + Send>;

#[derive(Default)]
struct Tapped {
    tap: Option<Tap>,
    /// Bytes sent to the tap that its view has not said it has drawn.
    unacked: usize,
    /// The view went silent while the pane was held for it, so the pane is no
    /// longer held; the view's next word puts it back under control.
    stalled: bool,
}
type TapSlot = Arc<(Mutex<Tapped>, std::sync::Condvar)>;

/// A pane this far ahead of its view is not read until the view catches up.
/// xterm.js throws output away past 50 MB of backlog; this keeps it near none,
/// and it is what makes Ctrl+C take effect at once during a flood.
const FLOW_HIGH: usize = 1024 * 1024;
/// A view that says nothing for this long while its pane is held (a frozen
/// window, a page that was reloaded) stops being waited for: a program must
/// never hang on a window that is not drawing.
const FLOW_STALL: Duration = Duration::from_secs(2);

pub struct Terminals {
    panes: Mutex<HashMap<String, Pane>>,
    sink: Mutex<Option<Arc<dyn EventSink>>>,
    /// Keyed by pane id and kept across the pane's own life: a view may
    /// attach before its pane is spawned, and stays attached when the process
    /// in its pane is replaced.
    taps: Mutex<HashMap<String, TapSlot>>,
    /// Output sent to the webview since launch, for `terminalx status`.
    emitted: Arc<Emitted>,
}

#[derive(Default)]
struct Emitted {
    events: AtomicU64,
    bytes: AtomicU64,
}

impl Default for Terminals {
    fn default() -> Self {
        Self { panes: Mutex::new(HashMap::new()), sink: Mutex::new(None), taps: Mutex::new(HashMap::new()), emitted: Arc::default() }
    }
}

/// What the terminals hold and have sent, for `terminalx status` (issue #232).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStats {
    pub panes: usize,
    pub running: usize,
    pub scrollback_bytes: usize,
    /// Views attached to a pane's output, and what they have yet to draw.
    pub views: usize,
    pub unacked_bytes: usize,
    /// `pty_data` events and their raw bytes since launch.
    pub data_events: u64,
    pub data_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct PaneInfo {
    pub id: String,
    pub pid: Option<u32>,
    pub running: bool,
    pub cwd: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyData {
    pub id: String,
    /// base64 of the raw bytes; the terminal decodes them itself.
    pub data: String,
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExit {
    pub id: String,
    pub code: Option<i32>,
}

/// What a pane runs and where.
pub struct PaneSpec<'a> {
    pub cwd: &'a str,
    pub cols: u16,
    pub rows: u16,
    /// Replaces the interactive shell; the pane exits with it.
    pub command: Option<&'a str>,
    /// Set inside the PTY before the command runs.
    pub env: &'a [(String, String)],
}

pub(crate) fn shell() -> String {
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".into()
        } else if cfg!(windows) {
            "powershell.exe".into()
        } else {
            "/bin/bash".into()
        }
    })
}

/// Hold the pane's output back while its view is more than `FLOW_HIGH` behind.
fn wait_for_view(slot: &TapSlot) {
    let (tapped, acked) = &**slot;
    let mut tapped = tapped.lock().unwrap();
    let deadline = Instant::now() + FLOW_STALL;
    while tapped.tap.is_some() && !tapped.stalled && tapped.unacked > FLOW_HIGH {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            tapped.stalled = true;
            break;
        }
        tapped = acked.wait_timeout(tapped, left).unwrap().0;
    }
}

fn append_scrollback(scrollback: &Mutex<VecDeque<u8>>, bytes: &[u8]) {
    let mut scrollback = scrollback.lock().unwrap();
    if bytes.len() >= SCROLLBACK_BYTES {
        scrollback.clear();
        scrollback.extend(bytes[bytes.len() - SCROLLBACK_BYTES..].iter().copied());
        return;
    }
    let overflow = scrollback.len().saturating_add(bytes.len()).saturating_sub(SCROLLBACK_BYTES);
    if overflow > 0 {
        scrollback.drain(..overflow);
    }
    scrollback.extend(bytes.iter().copied());
}

impl Terminals {
    pub fn new() -> Self {
        Self::default()
    }

    /// `command`, when given, replaces the interactive shell: the login shell
    /// execs it so PATH and rc files still apply, and the pane exits with it.
    /// That exit is the signal a terminal-view tab relies on, so there is no
    /// fallback shell kept alive behind the command.
    ///
    /// `env` is set inside the PTY before the command runs. An agent tab uses
    /// it to tell the CLI — and every hook the CLI spawns, since a hook is a
    /// grandchild of this shell — which tab it belongs to.
    pub fn spawn(&self, sink: Arc<dyn EventSink>, id: &str, spec: PaneSpec<'_>) -> Result<()> {
        if self.panes.lock().unwrap().contains_key(id) {
            return Ok(());
        }
        let PaneSpec { cwd, cols, rows, command, env } = spec;
        *self.sink.lock().unwrap() = Some(sink.clone());
        let pty = portable_pty::native_pty_system();
        let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| anyhow!("openpty: {e}"))?;
        let sh = shell();
        let mut cmd = CommandBuilder::new(&sh);
        // A login shell so PATH and prompts match the reader's own terminal.
        let known_shell = sh.ends_with("zsh") || sh.ends_with("bash") || sh.ends_with("fish") || sh.ends_with("sh") && !sh.ends_with("pwsh");
        match command {
            Some(c) if known_shell => {
                cmd.arg("-l");
                cmd.arg("-c");
                cmd.arg(format!("exec {c}"));
            }
            Some(c) => {
                cmd.arg("-c");
                cmd.arg(c);
            }
            None if known_shell => {
                cmd.arg("-l");
            }
            None => {}
        }
        cmd.cwd(cwd);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Raccoon");
        cmd.env("PATH", crate::binpath::login_path());
        cmd.env("RACCOON", "1");
        // Raccoon itself may have been started from inside an agent's session
        // (a `tauri dev` an agent ran). Those stamps would tell a CLI spawned
        // here that it is a nested child, and a nested child stops writing the
        // transcript the chat view is projected from.
        for k in ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_BRIDGE_SESSION_ID"] {
            cmd.env_remove(k);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = pair.slave.spawn_command(cmd).map_err(|e| anyhow!("spawn shell: {e}"))?;
        drop(pair.slave);
        let pid = child.process_id();
        let mut reader = pair.master.try_clone_reader().map_err(|e| anyhow!("pty reader: {e}"))?;
        let writer = pair.master.take_writer().map_err(|e| anyhow!("pty writer: {e}"))?;
        let alive = Arc::new(Mutex::new(true));
        let last_output = Arc::new(Mutex::new(None));
        let scrollback = Arc::new(Mutex::new(VecDeque::with_capacity(SCROLLBACK_BYTES)));

        {
            let sink = sink.clone();
            let id = id.to_string();
            let alive = alive.clone();
            let last_output = last_output.clone();
            let scrollback = scrollback.clone();
            let emitted = self.emitted.clone();
            let tap = self.tap_slot(&id);
            // Reading blocks until the program writes again, so it gets a
            // thread of its own: the emitter below must be able to send what
            // it gathered when the window closes even if the program has
            // gone quiet (a prompt waiting for input), not on its next write.
            let (chunks, gathered) = std::sync::mpsc::sync_channel::<Vec<u8>>(64);
            std::thread::Builder::new().name(format!("pty-read-{id}")).spawn(move || {
                let mut buf = vec![0u8; 16 * 1024];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if chunks.send(buf[..n].to_vec()).is_err() {
                                break;
                            }
                        }
                    }
                }
            })?;
            std::thread::Builder::new().name(format!("pty-emit-{id}")).spawn(move || {
                let flush = |acc: &mut Vec<u8>| {
                    let data = base64::engine::general_purpose::STANDARD.encode(&*acc);
                    {
                        // Held across both, so a view attaching now gets these
                        // bytes exactly once: in the scrollback it is handed,
                        // or from its tap.
                        let mut tapped = tap.0.lock().unwrap();
                        append_scrollback(&scrollback, acc);
                        match tapped.tap.as_ref().map(|send| send(acc)) {
                            Some(true) => tapped.unacked += acc.len(),
                            Some(false) => *tapped = Tapped::default(),
                            None => {}
                        }
                    }
                    emitted.events.fetch_add(1, Ordering::Relaxed);
                    emitted.bytes.fetch_add(acc.len() as u64, Ordering::Relaxed);
                    *last_output.lock().unwrap() = Some(Instant::now());
                    sink.emit("pty_data", &PtyData { id: id.clone(), data });
                    acc.clear();
                };
                let mut acc: Vec<u8> = Vec::with_capacity(MAX_CHUNK);
                let mut open = true;
                let mut flushed: Option<Instant> = None;
                while open {
                    let Ok(first) = gathered.recv() else { break };
                    acc.extend_from_slice(&first);
                    // Gather a little more if it is arriving fast, so one emit
                    // carries a burst rather than each read costing an eval.
                    // After a quiet spell there is no burst yet to gather: a
                    // key's echo is sent as it is, not 8ms later.
                    let start = Instant::now();
                    let quiet = flushed.is_none_or(|at| at.elapsed() >= COALESCE);
                    while !quiet && acc.len() < MAX_CHUNK {
                        let left = COALESCE.saturating_sub(start.elapsed());
                        if left.is_zero() {
                            break;
                        }
                        match gathered.recv_timeout(left) {
                            Ok(more) => acc.extend_from_slice(&more),
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                                open = false;
                                break;
                            }
                        }
                    }
                    flush(&mut acc);
                    flushed = Some(Instant::now());
                    wait_for_view(&tap);
                }
                *alive.lock().unwrap() = false;
                sink.emit(crate::status::resources::CHANGED_EVENT, &());
            })?;
        }
        {
            let sink = sink.clone();
            let id = id.to_string();
            std::thread::Builder::new().name(format!("pty-wait-{id}")).spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code() as i32);
                sink.emit("pty_exit", &PtyExit { id, code });
            })?;
        }
        let writer = Arc::new(Mutex::new(writer));
        self.panes.lock().unwrap().insert(id.to_string(), Pane { master: pair.master, writer, pid, alive, last_output, scrollback, cwd: cwd.to_string() });
        self.changed();
        Ok(())
    }

    fn tap_slot(&self, id: &str) -> TapSlot {
        self.taps.lock().unwrap().entry(id.to_string()).or_default().clone()
    }

    /// Send pane `id`'s output to `tap` from here on, starting with what the
    /// pane has printed so far (its bounded scrollback), with nothing lost or
    /// repeated in between. It replaces an earlier tap for the same pane.
    pub fn attach(&self, id: &str, tap: Tap) {
        let slot = self.tap_slot(id);
        let mut tapped = slot.0.lock().unwrap();
        let mut sent = 0;
        if let Some(printed) = self.read_output(id).filter(|bytes| !bytes.is_empty()) {
            // A full scrollback was cut at an arbitrary byte, perhaps inside
            // a character or an escape sequence: start at the next line.
            let cut = printed.len() >= SCROLLBACK_BYTES;
            let start = cut.then(|| printed.iter().take(4096).position(|byte| *byte == b'\n').map(|at| at + 1)).flatten().unwrap_or(0);
            if !tap(&printed[start..]) {
                return;
            }
            sent = printed.len() - start;
        }
        *tapped = Tapped { tap: Some(tap), unacked: sent, stalled: false };
        slot.1.notify_all();
    }

    /// The view has drawn `bytes` more of what its tap was sent.
    pub fn ack(&self, id: &str, bytes: usize) {
        let Some(slot) = self.taps.lock().unwrap().get(id).cloned() else { return };
        let mut tapped = slot.0.lock().unwrap();
        tapped.unacked = tapped.unacked.saturating_sub(bytes);
        tapped.stalled = false;
        slot.1.notify_all();
    }

    /// Every view is gone at once: the window was loaded afresh, and its old
    /// page's views will never draw or answer again.
    pub fn detach_all(&self) {
        let slots: Vec<TapSlot> = self.taps.lock().unwrap().drain().map(|(_, slot)| slot).collect();
        for slot in slots {
            *slot.0.lock().unwrap() = Tapped::default();
            slot.1.notify_all();
        }
    }

    /// The view is gone: stop sending, and forget the pane id.
    pub fn detach(&self, id: &str) {
        if let Some(slot) = self.taps.lock().unwrap().remove(id) {
            *slot.0.lock().unwrap() = Tapped::default();
            slot.1.notify_all();
        }
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let writer = self.panes.lock().unwrap().get(id).context("no such terminal")?.writer.clone();
        let mut writer = writer.lock().unwrap();
        writer.write_all(data)?;
        writer.flush()?;
        Ok(())
    }

    pub fn pid(&self, id: &str) -> Option<u32> {
        self.panes.lock().unwrap().get(id)?.pid
    }

    pub fn read_output(&self, id: &str) -> Option<Vec<u8>> {
        let scrollback = self.panes.lock().unwrap().get(id)?.scrollback.clone();
        let bytes = scrollback.lock().unwrap().iter().copied().collect();
        Some(bytes)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        let panes = self.panes.lock().unwrap();
        let pane = panes.get(id).context("no such terminal")?;
        pane.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| anyhow!("resize: {e}"))
    }

    pub fn kill(&self, id: &str) {
        if let Some(pane) = self.panes.lock().unwrap().remove(id) {
            if let Some(pid) = pane.pid {
                crate::harness::host::terminate(pid);
            }
            drop(pane);
        }
        self.changed();
    }

    /// Kill the pane and wait for its process to really be gone.
    ///
    /// An agent CLI holds its conversation for as long as it runs, and refuses
    /// to open one another process still has, so a replacement started before
    /// the old one has let go dies on the spot. Claude Code's TUI also ignores
    /// SIGTERM outright, so asking politely and moving on is not enough.
    pub fn kill_and_wait(&self, id: &str, timeout: Duration) {
        let Some(pane) = self.panes.lock().unwrap().remove(id) else { return };
        let pid = pane.pid;
        if let Some(pid) = pid {
            crate::harness::host::terminate(pid);
        }
        drop(pane);
        self.changed();
        let Some(pid) = pid else { return };
        let start = Instant::now();
        let mut forced = false;
        while start.elapsed() < timeout {
            if !crate::harness::host::is_alive(pid) {
                return;
            }
            if !forced && start.elapsed() >= TERM_GRACE {
                crate::harness::host::kill_now(pid);
                forced = true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        log::warn!("pane {id} did not exit within {timeout:?}");
    }

    /// Kill the shells opened for a session, whose pane ids are
    /// `<session id>:<suffix>`. An agent tab's pane (`tab:<tab id>`) is its
    /// tab's to stop.
    pub fn kill_session_shells(&self, session_id: &str) {
        let prefix = format!("{session_id}:");
        let ids: Vec<String> = self.panes.lock().unwrap().keys().filter(|id| id.starts_with(&prefix)).cloned().collect();
        for id in ids {
            self.kill(&id);
        }
    }

    pub fn kill_all(&self) {
        let ids: Vec<String> = self.panes.lock().unwrap().keys().cloned().collect();
        for id in ids {
            self.kill(&id);
        }
    }

    pub fn is_live(&self, id: &str) -> bool {
        self.panes.lock().unwrap().contains_key(id)
    }

    /// How long the pane has been quiet, once it has said anything at all.
    /// `None` means it has not drawn yet, or there is no such pane.
    pub fn quiet_for(&self, id: &str) -> Option<Duration> {
        Some(self.last_output(id)?.elapsed())
    }

    /// When the pane last drew anything. `None` means it has not drawn yet,
    /// or there is no such pane.
    pub fn last_output(&self, id: &str) -> Option<Instant> {
        let panes = self.panes.lock().unwrap();
        let at = *panes.get(id)?.last_output.lock().unwrap();
        at
    }

    /// Whether the pane's own process is still there. `is_live` only says the
    /// pane was opened and not closed; a command that exited on its own leaves
    /// the pane in place so its last output stays on screen.
    pub fn is_running(&self, id: &str) -> bool {
        self.panes.lock().unwrap().get(id).map(|p| *p.alive.lock().unwrap()).unwrap_or(false)
    }

    pub fn panes(&self) -> Vec<PaneInfo> {
        self.panes
            .lock()
            .unwrap()
            .iter()
            .map(|(id, pane)| PaneInfo {
                id: id.clone(),
                pid: pane.pid,
                running: *pane.alive.lock().unwrap(),
                cwd: pane.cwd.clone(),
            })
            .collect()
    }

    pub fn stats(&self) -> TerminalStats {
        let taps: Vec<TapSlot> = self.taps.lock().unwrap().values().cloned().collect();
        let (views, unacked_bytes) = taps.iter().fold((0, 0), |(views, bytes), slot| {
            let tapped = slot.0.lock().unwrap();
            (views + usize::from(tapped.tap.is_some()), bytes + tapped.unacked)
        });
        let panes = self.panes.lock().unwrap();
        TerminalStats {
            views,
            unacked_bytes,
            panes: panes.len(),
            running: panes.values().filter(|pane| *pane.alive.lock().unwrap()).count(),
            scrollback_bytes: panes.values().map(|pane| pane.scrollback.lock().unwrap().len()).sum(),
            data_events: self.emitted.events.load(Ordering::Relaxed),
            data_bytes: self.emitted.bytes.load(Ordering::Relaxed),
        }
    }

    fn changed(&self) {
        if let Some(sink) = self.sink.lock().unwrap().as_ref() {
            sink.emit(crate::status::resources::CHANGED_EVENT, &());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_sent_when_the_program_goes_quiet_not_on_its_next_write() {
        let sink = Arc::new(crate::sink::BroadcastSink::new(64));
        let (sent, received) = std::sync::mpsc::channel::<Vec<u8>>();
        let sent = Mutex::new(sent);
        sink.listen(
            "pty_data",
            Box::new(move |payload| {
                if let Ok(data) = serde_json::from_str::<PtyData>(payload) {
                    let _ = sent.lock().unwrap().send(base64::engine::general_purpose::STANDARD.decode(data.data).unwrap());
                }
            }),
        );
        let terminals = Terminals::new();
        let dir = tempfile::tempdir().unwrap();
        // The pauses end each earlier batch, so the last piece opens a batch
        // of its own, and then the program writes nothing more for minutes.
        let command = "sh -c 'printf a; sleep 1; printf b; sleep 1; printf quiet-end; exec sleep 600'";
        let spec = PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some(command), env: &[] };
        terminals.spawn(sink, "quiet", spec).unwrap();
        let mut output = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(60);
        while !String::from_utf8_lossy(&output).contains("quiet-end") {
            let chunk = received
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| panic!("output held back while the program is quiet: {:?}", String::from_utf8_lossy(&output)));
            output.extend(chunk);
        }
        let stats = terminals.stats();
        assert_eq!((stats.panes, stats.running), (1, 1));
        assert_eq!(stats.data_bytes as usize, output.len());
        assert_eq!(stats.scrollback_bytes, output.len());
        assert!(stats.data_events >= 3, "{stats:?}");
        terminals.kill_all();
        assert_eq!(terminals.stats().panes, 0);
    }

    /// Collects what a tap is sent.
    fn collector() -> (Tap, std::sync::mpsc::Receiver<Vec<u8>>) {
        let (sent, received) = std::sync::mpsc::channel::<Vec<u8>>();
        let sent = Mutex::new(sent);
        (Box::new(move |bytes| sent.lock().unwrap().send(bytes.to_vec()).is_ok()), received)
    }

    fn read_until(received: &std::sync::mpsc::Receiver<Vec<u8>>, wanted: &str) -> String {
        let mut output = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(60);
        while !String::from_utf8_lossy(&output).contains(wanted) {
            let chunk = received
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| panic!("no {wanted:?} in {:?}", String::from_utf8_lossy(&output)));
            output.extend(chunk);
        }
        String::from_utf8_lossy(&output).into_owned()
    }

    #[test]
    fn a_tap_gets_what_was_printed_before_it_attached_and_everything_after_exactly_once() {
        let sink: Arc<dyn EventSink> = Arc::new(crate::sink::BroadcastSink::new(64));
        let terminals = Terminals::new();
        let dir = tempfile::tempdir().unwrap();
        // Attached before the pane exists: a view can mount before its spawn lands.
        let (early, early_output) = collector();
        terminals.attach("pane", early);
        let command = "sh -c 'printf one-; sleep 2; printf two-; sleep 2; printf three; exec sleep 600'";
        let spec = PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some(command), env: &[] };
        terminals.spawn(sink, "pane", spec).unwrap();
        assert!(read_until(&early_output, "one-").ends_with("one-"));

        // A second view takes over: it starts with the scrollback, then follows.
        let (late, late_output) = collector();
        terminals.attach("pane", late);
        let seen = read_until(&late_output, "three");
        assert!(seen.contains("one-two-three"), "{seen:?}");
        assert_eq!(seen.matches("one-").count(), 1, "{seen:?}");
        // The first one was replaced, not doubled.
        assert!(early_output.try_recv().is_err());

        terminals.detach("pane");
        assert!(terminals.taps.lock().unwrap().is_empty());
        terminals.kill_all();
    }

    #[test]
    fn a_tap_whose_receiver_is_gone_is_dropped() {
        let sink: Arc<dyn EventSink> = Arc::new(crate::sink::BroadcastSink::new(64));
        let terminals = Terminals::new();
        let dir = tempfile::tempdir().unwrap();
        let (tap, output) = collector();
        drop(output);
        terminals.attach("pane", tap);
        let spec = PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some("sh -c 'printf hello; exec sleep 600'"), env: &[] };
        terminals.spawn(sink, "pane", spec).unwrap();
        let deadline = Instant::now() + Duration::from_secs(60);
        while terminals.tap_slot("pane").0.lock().unwrap().tap.is_some() {
            assert!(Instant::now() < deadline, "a dead tap is still attached");
            std::thread::sleep(Duration::from_millis(20));
        }
        terminals.kill_all();
    }

    #[test]
    fn a_pane_far_ahead_of_its_view_is_not_read_until_the_view_catches_up() {
        let sink: Arc<dyn EventSink> = Arc::new(crate::sink::BroadcastSink::new(64));
        let terminals = Terminals::new();
        let dir = tempfile::tempdir().unwrap();
        let received = Arc::new(AtomicU64::new(0));
        let count = received.clone();
        terminals.attach("pane", Box::new(move |bytes| {
                count.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                true
            }));
        // 64 MB as fast as the PTY carries it.
        let command = "sh -c 'head -c 67108864 /dev/zero | tr \"\\0\" x; exec sleep 600'";
        let spec = PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some(command), env: &[] };
        terminals.spawn(sink, "pane", spec).unwrap();

        let total = 64 * 1024 * 1024;
        let sent = || received.load(Ordering::Relaxed) as usize;
        let bound = FLOW_HIGH + 16 * MAX_CHUNK;

        // The view draws nothing: the pane is held about a megabyte in.
        std::thread::sleep(Duration::from_millis(700));
        let held = sent();
        assert!(held > FLOW_HIGH && held < bound, "sent {held} bytes to a view that drew none");
        assert!(terminals.stats().unacked_bytes > FLOW_HIGH);

        // The view catches up: the pane moves on, and is held again that much further.
        terminals.ack("pane", held);
        std::thread::sleep(Duration::from_millis(700));
        let ahead = sent() - held;
        assert!(ahead > FLOW_HIGH && ahead < bound, "{ahead} bytes ahead of a view that drew {held}");

        // The view never speaks again (its page is gone): the program is not left hanging.
        let deadline = Instant::now() + Duration::from_secs(120);
        while sent() < total {
            assert!(Instant::now() < deadline, "stuck at {} bytes", sent());
            std::thread::sleep(Duration::from_millis(20));
        }
        terminals.kill_all();
    }

    #[test]
    fn deleting_a_session_kills_its_shells_and_no_one_elses() {
        let sink: Arc<dyn EventSink> = Arc::new(crate::sink::BroadcastSink::new(64));
        let terminals = Terminals::new();
        let dir = tempfile::tempdir().unwrap();
        for id in ["s1:a", "s1:b", "s10:a", "tab:s1"] {
            let spec = PaneSpec { cwd: dir.path().to_str().unwrap(), cols: 80, rows: 24, command: Some("sleep 600"), env: &[] };
            terminals.spawn(sink.clone(), id, spec).unwrap();
        }
        terminals.kill_session_shells("s1");
        let mut left: Vec<String> = terminals.panes().into_iter().map(|pane| pane.id).collect();
        left.sort();
        assert_eq!(left, ["s10:a", "tab:s1"]);
        terminals.kill_all();
    }

    #[test]
    fn scrollback_retains_only_the_newest_bounded_bytes() {
        let scrollback = Mutex::new(VecDeque::new());
        append_scrollback(&scrollback, &[1, 2, 3]);
        append_scrollback(&scrollback, &vec![4; SCROLLBACK_BYTES]);
        let bytes: Vec<_> = scrollback.lock().unwrap().iter().copied().collect();
        assert_eq!(bytes.len(), SCROLLBACK_BYTES);
        assert!(bytes.iter().all(|byte| *byte == 4));
    }
}
