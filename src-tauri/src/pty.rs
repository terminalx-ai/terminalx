//! Terminals. A PTY per pane, the reader's login shell inside it, and output
//! coalesced before it crosses to the webview: every emit is a JS eval, and a
//! flood of tiny reads (a build log, `yes`) is thousands per second, which
//! freezes input. Chunks are gathered for up to 8ms or 32KB and sent once.

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

pub struct Terminals {
    panes: Mutex<HashMap<String, Pane>>,
    sink: Mutex<Option<Arc<dyn EventSink>>>,
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
        Self { panes: Mutex::new(HashMap::new()), sink: Mutex::new(None), emitted: Arc::default() }
    }
}

/// What the terminals hold and have sent, for `terminalx status` (issue #232).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStats {
    pub panes: usize,
    pub running: usize,
    pub scrollback_bytes: usize,
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
                    append_scrollback(&scrollback, acc);
                    emitted.events.fetch_add(1, Ordering::Relaxed);
                    emitted.bytes.fetch_add(acc.len() as u64, Ordering::Relaxed);
                    *last_output.lock().unwrap() = Some(Instant::now());
                    sink.emit("pty_data", &PtyData { id: id.clone(), data });
                    acc.clear();
                };
                let mut acc: Vec<u8> = Vec::with_capacity(MAX_CHUNK);
                let mut open = true;
                while open {
                    let Ok(first) = gathered.recv() else { break };
                    acc.extend_from_slice(&first);
                    // Gather a little more if it is arriving fast, so one emit
                    // carries a burst rather than each read costing an eval.
                    let start = Instant::now();
                    while acc.len() < MAX_CHUNK {
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
        let panes = self.panes.lock().unwrap();
        TerminalStats {
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
