//! Terminals. A PTY per pane, the reader's login shell inside it, and output
//! coalesced before it crosses to the webview: every emit is a JS eval, and a
//! flood of tiny reads (a build log, `yes`) is thousands per second, which
//! freezes input. Chunks are gathered for up to 8ms or 32KB and sent once.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const COALESCE: Duration = Duration::from_millis(8);
const MAX_CHUNK: usize = 32 * 1024;

struct Pane {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    pid: Option<u32>,
    alive: Arc<Mutex<bool>>,
}

#[derive(Default)]
pub struct Terminals {
    panes: Mutex<HashMap<String, Pane>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyData {
    pub id: String,
    /// base64 of the raw bytes; the terminal decodes them itself.
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
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

fn shell() -> String {
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".into()
        } else {
            "/bin/bash".into()
        }
    })
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
    pub fn spawn(&self, app: AppHandle, id: &str, spec: PaneSpec<'_>) -> Result<()> {
        if self.panes.lock().unwrap().contains_key(id) {
            return Ok(());
        }
        let PaneSpec { cwd, cols, rows, command, env } = spec;
        let pty = portable_pty::native_pty_system();
        let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| anyhow!("openpty: {e}"))?;
        let sh = shell();
        let mut cmd = CommandBuilder::new(&sh);
        // A login shell so PATH and prompts match the reader's own terminal.
        let known_shell = sh.ends_with("zsh") || sh.ends_with("bash") || sh.ends_with("fish") || sh.ends_with("sh");
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

        {
            let app = app.clone();
            let id = id.to_string();
            let alive = alive.clone();
            std::thread::Builder::new().name(format!("pty-read-{id}")).spawn(move || {
                let mut buf = vec![0u8; 16 * 1024];
                let mut acc: Vec<u8> = Vec::with_capacity(MAX_CHUNK);
                let mut window_start: Option<Instant> = None;
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            acc.extend_from_slice(&buf[..n]);
                            let start = *window_start.get_or_insert_with(Instant::now);
                            // Gather a little more if it is arriving fast, so one emit
                            // carries a burst rather than each read costing an eval.
                            if acc.len() < MAX_CHUNK && start.elapsed() < COALESCE {
                                std::thread::sleep(COALESCE.saturating_sub(start.elapsed()).min(Duration::from_millis(4)));
                                continue;
                            }
                            let data = base64::engine::general_purpose::STANDARD.encode(&acc);
                            let _ = app.emit("pty_data", PtyData { id: id.clone(), data });
                            acc.clear();
                            window_start = None;
                        }
                    }
                }
                if !acc.is_empty() {
                    let data = base64::engine::general_purpose::STANDARD.encode(&acc);
                    let _ = app.emit("pty_data", PtyData { id: id.clone(), data });
                }
                *alive.lock().unwrap() = false;
            })?;
        }
        {
            let app = app.clone();
            let id = id.to_string();
            std::thread::Builder::new().name(format!("pty-wait-{id}")).spawn(move || {
                let code = child.wait().ok().map(|s| s.exit_code() as i32);
                let _ = app.emit("pty_exit", PtyExit { id, code });
            })?;
        }
        self.panes.lock().unwrap().insert(id.to_string(), Pane { master: pair.master, writer, pid, alive });
        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        let mut panes = self.panes.lock().unwrap();
        let pane = panes.get_mut(id).context("no such terminal")?;
        pane.writer.write_all(data)?;
        pane.writer.flush()?;
        Ok(())
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

    /// Whether the pane's own process is still there. `is_live` only says the
    /// pane was opened and not closed; a command that exited on its own leaves
    /// the pane in place so its last output stays on screen.
    pub fn is_running(&self, id: &str) -> bool {
        self.panes.lock().unwrap().get(id).map(|p| *p.alive.lock().unwrap()).unwrap_or(false)
    }
}
