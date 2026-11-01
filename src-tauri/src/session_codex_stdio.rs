//! Default-off experimental owner. One runtime gate orders protocol dispatch,
//! final writes, indexed thread identity and the existing compaction event log.
//! No PTY tail, second subscription, automatic reconnect, or prompt replay: a
//! tab whose connection ended resumes its thread only for the next explicit send.
use super::*;
use std::time::Duration;
use crate::harness::codex::owned_transport::{Observation, TurnOutcome};
use crate::harness::codex::stdio::{Action as StdioAction, Outbound, Stdio};
use crate::harness::host::TerminalReceipt;
use crate::store::index::AgentTransport;

pub(super) fn selected(tab: &TabEntry) -> bool {
    tab.transport == AgentTransport::ExperimentalCodexStdio
}

impl SessionManager {
    pub(super) fn refuse_codex_stdio_operation(&self, session: &str, tab: &str) -> Result<()> {
        let entry = index::get(session)?;
        anyhow::ensure!(!entry.tab(tab).is_some_and(selected), "This operation is not supported for experimental Codex stdio. Create a new session with the desired settings; no PTY handoff or thread migration is performed.");
        Ok(())
    }
    pub(super) fn send_codex_stdio(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, entry: &index::SessionEntry,
        prompt: PromptText, images: Vec<ImageRef>, wire_images: Vec<(String, String)>) -> Result<SendOutcome> {
        let tab = entry.tab(&rt.tab_id).context("tab not found")?;
        ensure_local(&prompt)?;
        anyhow::ensure!(!prompt.agent.trim_start().starts_with('/') || prompt.agent.trim() == "/compact", "Only /compact is supported in experimental Codex stdio");
        anyhow::ensure!(prompt.agent.trim() != "/compact" || images.is_empty(), "Compaction does not accept images");
        anyhow::ensure!(tab.harness == "codex", "Experimental stdio requires Codex");
        anyhow::ensure!(!rt.turn_open && rt.pending.is_empty(), "Experimental Codex is busy; wait or interrupt before sending again");
        Stdio::validate_mode(&tab.permission_mode)?;
        if !matches!(rt.engine, Engine::CodexStdio(_)) {
            anyhow::ensure!(matches!(rt.engine, Engine::None) && rt.child.is_none(), "Another engine owns this tab");
            anyhow::ensure!(tab.fork_from.is_none(), "Experimental Codex cannot fork a thread. Create a new experimental session.");
            self.start_codex_stdio(rt, rt_arc, entry, tab)?;
        }
        let manual = prompt.agent.trim() == "/compact";
        let Engine::CodexStdio(engine) = &mut rt.engine else { unreachable!() };
        let actions = if engine.ready { engine.prompt(prompt.agent, wire_images)? } else { engine.start(prompt.agent, wire_images)? };
        // No user message or user turn for manual compaction (#524/#566).
        let events = if manual { Vec::new() } else { vec![self.publish(rt, Payload::UserMessage {
            author: None, text: prompt.display, images, baseline: git::snapshot_tree(Path::new(&entry.cwd)).ok(), queued: false, cwd: Some(entry.cwd.clone()),
        }, None)] };
        rt.open_turn();
        rt.turn_started_at = Some(Instant::now());
        self.set_status(rt, TabStatus::InProgress);
        if let Err(error) = self.apply_codex_actions(rt, actions) {
            self.codex_stdio_failed(rt, &error, None);
            return Err(error);
        }
        Ok(SendOutcome { queued: false, events, in_input: false })
    }

    fn start_codex_stdio(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, entry: &index::SessionEntry, tab: &TabEntry) -> Result<()> {
        self.accepting_work()?;
        let engine = Stdio::new(entry.cwd.clone(), tab.model.clone(), tab.effort.clone(), tab.permission_mode.clone(), tab.provider_session_id.clone());
        let launch = engine.launch.clone();
        let (tx, rx) = std::sync::mpsc::sync_channel(32);
        rt.engine = Engine::CodexStdio(engine);
        rt.stdio_starting = true;
        rt.stdio_writer = Some(tx);
        let manager = self.clone();
        let runtime = Arc::downgrade(rt_arc);
        let cwd = entry.cwd.clone();
        let session = rt.session_id.clone();
        let tab = rt.tab_id.clone();
        // Reserve the exact launch while admitted; no discovery, version wait,
        // spawn, rollback or reader join runs under admission/runtime locks.
        let spawned = std::thread::Builder::new().name("codex-stdio-owner".into()).spawn(move || {
            let Some(rt_arc) = runtime.upgrade() else { return };
            let result = manager.prepare_codex_stdio(&rt_arc, &launch, &session, &tab, &cwd);
            {
                let mut rt = rt_arc.lock().unwrap();
                if !same_launch(&rt, &launch) { return; }
                rt.stdio_starting = false;
                if let Err(error) = result {
                    rt.stdio_writer = None;
                    manager.codex_stdio_failed(&mut rt, &error, None);
                    return;
                }
            }
            drop(rt_arc);
            // Only this worker writes. It may wait for admission, but reader
            // settlement and the Host terminal receipt never wait for it.
            while let Ok(line) = rx.recv() {
                if let Err(error) = manager.write_codex_frame(&runtime, &launch, line) {
                    if let Some(rt_arc) = runtime.upgrade() {
                        let mut rt = rt_arc.lock().unwrap();
                        if same_launch(&rt, &launch) && !rt.stopping {
                            manager.codex_stdio_failed(&mut rt, &error, None);
                        }
                    }
                    return;
                }
            }
        });
        if let Err(error) = spawned {
            rt.stdio_starting = false; rt.stdio_writer = None; rt.engine = Engine::None;
            return Err(error.into());
        }
        Ok(())
    }

    fn prepare_codex_stdio(&self, rt_arc: &Arc<Mutex<TabRuntime>>, launch: &Arc<()>, session: &str, tab: &str, cwd: &str) -> Result<()> {
        let current = || {
            self.accepting_work()?;
            let rt = rt_arc.lock().unwrap();
            anyhow::ensure!(same_launch(&rt, launch) && !rt.stopping && matches!(&rt.engine, Engine::CodexStdio(e) if !e.exited && !e.blocked), "Codex startup cancelled; no input was sent");
            Ok::<_, anyhow::Error>(())
        };
        current()?;
        let program = crate::binpath::resolve("codex").context("Codex is not installed")?;
        current()?;
        let mut probe = std::process::Command::new(&program);
        probe.arg("--version").env("PATH", crate::binpath::login_path());
        let version = crate::git::output_within(probe, Duration::from_secs(5)).map_err(|_| anyhow!("Could not verify experimental Codex stdio version. No prompt was sent."))?;
        anyhow::ensure!(codex::stdio::supported(&version), "Experimental stdio requires Codex {} or newer (found {}). No prompt was sent; PTY fallback is disabled.", codex::stdio::MIN_VERSION, version.trim());
        current()?;
        let env = vec![
            ("RACCOON_SESSION_ID".into(), session.to_owned()), ("RACCOON_TAB_ID".into(), tab.to_owned()),
            ("RACCOON_HOOK_TOKEN".into(), uuid::Uuid::now_v7().to_string()),
            (crate::hooks::CONTROL_SOCKET_ENV.into(), self.control.socket.to_string_lossy().into_owned()),
            (crate::hooks::CONTROL_TOKEN_ENV.into(), self.control.token.clone()),
        ];
        let sink = Arc::new(StdioSink { manager: self.clone(), rt: rt_arc.clone(), launch: launch.clone(), startup_stderr_bytes: Mutex::new(0), startup_stderr: Mutex::new(String::new()) });
        let args = vec!["app-server".into(), "--listen".into(), "stdio://".into()];
        let child = self.host.spawn(&key_of(session, tab), SpawnSpec { program: &program, args: &args, cwd: Path::new(cwd), env: &env }, sink)?;
        let cancelled = {
            let mut rt = rt_arc.lock().unwrap();
            // Stop retains the launch until startup has settled. Even a late
            // cancelled child must be installed as a cleanup witness, never
            // discarded on an error path or replaced by a key-based lookup.
            let cancelled = !same_launch(&rt, launch) || rt.stopping || matches!(&rt.engine, Engine::CodexStdio(e) if e.exited || e.blocked);
            rt.child_pid = Some(child.pid);
            rt.child = Some(child.clone());
            cancelled
        };
        if cancelled {
            crate::harness::host::terminate(child.pid);
            bail!("Codex startup cancelled; no input was sent");
        }
        Ok(())
    }

    fn write_codex_frame(&self, runtime: &std::sync::Weak<Mutex<TabRuntime>>, launch: &Arc<()>, frame: Outbound) -> Result<()> {
        let mut bytes = frame.line.as_bytes().to_vec();
        bytes.push(b'\n');
        let mut offset = 0;
        let deadline = Instant::now() + Duration::from_secs(5);
        while offset < bytes.len() {
            anyhow::ensure!(Instant::now() < deadline, "Codex input pipe timed out; delivery is uncertain and will not be replayed");
            {
                let _admission = crate::issue_pipeline::admission::lock();
                let rt_arc = runtime.upgrade().context("Codex runtime was removed")?;
                let mut rt = rt_arc.lock().unwrap();
                self.accepting_work()?;
                crate::issue_pipeline::admission::check(&rt.session_id, &rt.tab_id)?;
                anyhow::ensure!(same_launch(&rt, launch) && !rt.stopping, "Codex launch was cancelled; input will not be replayed");
                anyhow::ensure!(matches!(&rt.engine, Engine::CodexStdio(e) if !e.exited && !e.blocked), "Codex connection is no longer writable");
                let Engine::CodexStdio(engine) = &mut rt.engine else { unreachable!() };
                if !engine.write_is_current(&frame) {
                    anyhow::ensure!(offset == 0, "Codex frame expired after a partial write; delivery is uncertain and will not be replayed");
                    anyhow::ensure!(frame.can_discard_unsent(), "Codex input expired before delivery; no input was replayed");
                    engine.retire_write(&frame, false);
                    return Ok(());
                }
                let entry = index::get(&rt.session_id)?;
                anyhow::ensure!(entry.tab(&rt.tab_id).is_some_and(selected), "Codex tab was closed or changed");
                let child = rt.child.as_ref().context("Codex child is missing")?;
                anyhow::ensure!(self.host.get(&rt.key()).is_some_and(|live| Arc::ptr_eq(&live, child)), "Codex child has been replaced or exited");
                // A nonblocking syscall is the only physical write under the
                // authority locks. Reader/Stop can run between attempts, even
                // when the child never reads or produces a full stdout pipe.
                anyhow::ensure!(Instant::now() < deadline, "Codex input pipe timed out; delivery is uncertain and will not be replayed");
                match child.try_write_stdin(&bytes[offset..]) {
                    Ok(0) => bail!("Codex input pipe closed; delivery is uncertain and will not be replayed"),
                    Ok(written) => offset += written,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        #[cfg(test)]
                        tests::observed_full_pipe();
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {},
                    Err(error) => return Err(error).context("Codex write failed; delivery is uncertain and will not be replayed"),
                }
                if offset == bytes.len() {
                    if let Engine::CodexStdio(engine) = &mut rt.engine { engine.retire_write(&frame, true); }
                }
            }
            if offset < bytes.len() { std::thread::sleep(Duration::from_millis(5)); }
        }
        Ok(())
    }

    pub(super) fn apply_codex_actions(&self, rt: &mut TabRuntime, actions: Vec<StdioAction>) -> Result<()> {
        for action in actions {
            match action {
                StdioAction::Write(line) => {
                    anyhow::ensure!(!rt.stopping && matches!(&rt.engine, Engine::CodexStdio(e) if !e.exited && !e.blocked), "Codex connection is no longer writable");
                    rt.stdio_writer.as_ref().context("Codex writer is closed")?
                        .try_send(line).context("Codex writer queue unavailable; input will not be replayed")?;
                }
                StdioAction::ThreadReady(id) => {
                    let Engine::CodexStdio(engine) = &rt.engine else { bail!("Codex owner was replaced") };
                    let identity = compaction::Identity::Stdio { launch: engine.launch.clone(), epoch: rt.child.as_ref().context("Codex child missing")?.epoch };
                    // A resumed thread keeps the identity it was indexed under.
                    let tab = index::update_tab(&rt.session_id, &rt.tab_id, |tab| {
                        anyhow::ensure!(selected(tab) && tab.provider_session_id.as_ref().is_none_or(|known| *known == id), "Codex thread identity changed");
                        tab.provider_session_id = Some(id.clone()); Ok(tab.clone())
                    })?;
                    let scope = CompactionScope { session_id: rt.session_id.clone(), tab_id: rt.tab_id.clone(), provider: "codex".into(), thread_id: id, conversation_id: tab.follow.conversation, subagent_id: None };
                    rt.stdio_compaction = Some(self.bind_compaction_locked(rt, scope, identity)?);
                }
                StdioAction::Lifecycle(observation) => {
                    let token = rt.stdio_compaction.clone().context("Codex lifecycle arrived before binding")?;
                    let generation = token.generation();
                    let evidence = match observation {
                        Observation::ItemStarted { turn_id, item_id } => CompactionObservation::ItemStarted { generation, turn_id, item_id },
                        Observation::ItemCompleted { turn_id, item_id } => CompactionObservation::ItemCompleted { generation, turn_id, item_id },
                        Observation::TurnError { turn_id, will_retry } => CompactionObservation::TurnError { generation, turn_id, will_retry },
                        Observation::TurnEnded { turn_id, outcome } => CompactionObservation::TurnEnded { generation, turn_id, outcome: match outcome { TurnOutcome::Completed => CompactionTurnEnd::Completed, TurnOutcome::Failed => CompactionTurnEnd::Failed, TurnOutcome::Interrupted => CompactionTurnEnd::Interrupted } },
                        _ => bail!("Invalid Codex lifecycle observation"),
                    };
                    let confirmed = matches!(evidence, CompactionObservation::ItemStarted { .. });
                    anyhow::ensure!(matches!(self.publish_compaction_locked(rt, &token, evidence, confirmed)?, compaction::Publication::Committed(_)), "Compaction publication uncertain");
                }
                StdioAction::Emit(payload) => self.apply(rt, payload, None),
                StdioAction::CompactEnded => {
                    rt.turn_open = false;
                    self.cancel_asks(rt);
                    self.set_status(rt, if rt.recovery.is_some() { TabStatus::Waiting } else { TabStatus::Idle });
                }
            }
        }
        Ok(())
    }

    /// `stderr`: what Codex wrote there before its thread was ready, which
    /// says why better than a closed pipe does.
    fn codex_stdio_failed(&self, rt: &mut TabRuntime, error: &anyhow::Error, stderr: Option<&str>) {
        // Before its thread is ready nothing has worked yet: what Codex said
        // is shown, and a refused sign-in is said as one (#667).
        let starting = matches!(&rt.engine, Engine::CodexStdio(engine) if !engine.ready);
        let said = format!("{error:#}");
        let exit = starting.then(|| recovery::EarlyExit::said(&match stderr {
            Some(stderr) if !stderr.trim().is_empty() => format!("{said}\n{stderr}"),
            _ => said.clone(),
        }));
        rt.stdio_writer = None;
        if let Engine::CodexStdio(engine) = &mut rt.engine { engine.fail(); }
        self.cancel_asks(rt);
        self.codex_stdio_loss(rt, CompactionLoss::Disconnected);
        match exit {
            Some(exit) if exit.sign_in_refused && rt.turn_open => self.fail_open_turn(rt, &exit),
            Some(exit) if exit.sign_in_refused => {
                self.apply(rt, Payload::Error { message: RecoveryKind::SignedOut.message().into(), fatal: false, detail: exit.detail }, None);
                self.sign_in_refused(rt);
                self.needs_recovery(rt, RecoveryKind::SignedOut);
            }
            exit => {
                let message = format!("Experimental Codex connection failed: {said}. Stop this session, then send again to resume it; input will not be replayed.");
                self.apply(rt, Payload::Error { message, fatal: false, detail: exit.and_then(|exit| exit.detail) }, None);
                self.needs_recovery(rt, RecoveryKind::Disconnected);
            }
        }
    }

    fn codex_stdio_loss(&self, rt: &mut TabRuntime, reason: CompactionLoss) {
        if let Engine::CodexStdio(engine) = &mut rt.engine {
            if engine.lifecycle_lost { return; }
            engine.lifecycle_lost = true;
        }
        if let Some(token) = rt.stdio_compaction.clone() {
            let observation = CompactionObservation::ContinuityLost { generation: token.generation(), reason };
            if let Err(error) = self.publish_compaction_locked(rt, &token, observation, false) { log::warn!("Codex compaction loss: {error:#}"); }
        }
    }

    pub(super) fn stop_codex_stdio(&self, rt_arc: &Arc<Mutex<TabRuntime>>) -> Result<()> {
        let launch = {
            let mut rt = rt_arc.lock().unwrap();
            anyhow::ensure!(!rt.stop_in_flight, "Stop is already in progress");
            let Engine::CodexStdio(engine) = &mut rt.engine else { bail!("Codex owner changed") };
            engine.exited = true;
            let launch = engine.launch.clone();
            rt.stop_in_flight = true; rt.stopping = true;
            rt.stdio_writer = None;
            self.codex_stdio_loss(&mut rt, CompactionLoss::Exited);
            launch
        };
        let deadline = Instant::now() + RESTART_WAIT;
        let mut signalled = None;
        loop {
            let (starting, child) = {
                let rt = rt_arc.lock().unwrap();
                anyhow::ensure!(same_launch(&rt, &launch), "Codex cleanup owner changed; exit cannot be certified");
                (rt.stdio_starting, rt.child.clone())
            };
            if let Some(child) = &child {
                if signalled != Some(child.epoch) {
                    // Target the retained child, including on retry after Host
                    // removed its leader. A tab-name lookup is not a witness.
                    crate::harness::host::terminate(child.pid);
                    signalled = Some(child.epoch);
                }
            }
            if !starting && child.as_ref().is_none_or(|child| child.terminal_receipt().is_some() && !crate::harness::host::group_or_process_alive(child.pid)) {
                break;
            }
            if Instant::now() >= deadline {
                rt_arc.lock().unwrap().stop_in_flight = false;
                bail!("Experimental Codex startup, readers or processes have not exited. Retry Stop; exact ownership and history were retained.");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let mut rt = rt_arc.lock().unwrap();
        self.cancel_asks(&mut rt);
        let manual = matches!(&rt.engine, Engine::CodexStdio(e) if e.is_manual_compact());
        if manual { rt.turn_open = false; }
        else { self.close_open_turn(&mut rt, TurnStatus::Aborted, None); }
        rt.child = None; rt.child_pid = None; rt.stdio_compaction = None;
        rt.engine = Engine::None;
        rt.stop_in_flight = false; rt.stopping = false;
        self.set_status(&mut rt, TabStatus::Idle);
        Ok(())
    }
}

fn ensure_local(prompt: &PromptText) -> Result<()> {
    anyhow::ensure!(prompt.shared_connection.is_none() && prompt.mobile.is_none() && prompt.author.is_none(), "Experimental Codex stdio currently accepts local input only");
    Ok(())
}

/// `startup_stderr` holds, in memory only, the same bounded startup stderr
/// the diagnostics keep: why a Codex that never got ready exited (#667).
struct StdioSink { manager: SessionManager, rt: Arc<Mutex<TabRuntime>>, launch: Arc<()>, startup_stderr_bytes: Mutex<usize>, startup_stderr: Mutex<String> }
impl StdioSink {
    fn current(&self, rt: &TabRuntime) -> bool { same_launch(rt, &self.launch) }
    fn startup_stderr(&self) -> String { self.startup_stderr.lock().unwrap().clone() }
}
impl Sink for StdioSink {
    fn stdout_line(&self, line: String) {
        let mut rt = self.rt.lock().unwrap();
        if !self.current(&rt) { return; }
        let Engine::CodexStdio(engine) = &mut rt.engine else { return };
        let actions = engine.handle(&line);
        let result = actions.and_then(|actions| self.manager.apply_codex_actions(&mut rt, actions));
        if let Err(error) = result { self.manager.codex_stdio_failed(&mut rt, &error, None); }
    }
    fn stderr_line(&self, line: String) {
        let rt = self.rt.lock().unwrap();
        if !self.current(&rt) || !matches!(&rt.engine, Engine::CodexStdio(engine) if !engine.ready) { return; }
        // Retain at most 4 KiB of startup stderr per launch, in the tab's
        // existing private diagnostics only. Once the thread is ready, model
        // work has begun and stderr is not captured. It never drives status.
        let mut used = self.startup_stderr_bytes.lock().unwrap();
        let remaining = 4096usize.saturating_sub(*used);
        if remaining == 0 { return; }
        let mut end = line.len().min(remaining);
        while !line.is_char_boundary(end) { end -= 1; }
        *used += end.max(1);
        let mut kept = self.startup_stderr.lock().unwrap();
        kept.push_str(&line[..end]);
        kept.push('\n');
        recovery::diagnose_codex_stdio(&rt.diagnostics_path(), serde_json::json!({
            "stage": "startup_stderr", "text": &line[..end], "truncated": end < line.len(),
        }));
    }
    fn stdout_closed(&self, _end: crate::harness::host::ReaderEnd) {
        let mut rt = self.rt.lock().unwrap();
        if !self.current(&rt) { return; }
        if let Engine::CodexStdio(engine) = &mut rt.engine { engine.exited = true; }
        rt.stdio_writer = None;
        self.manager.codex_stdio_loss(&mut rt, CompactionLoss::Disconnected);
        if !rt.stopping {
            let stderr = self.startup_stderr();
            self.manager.codex_stdio_failed(&mut rt, &anyhow!("Codex output connection closed"), Some(&stderr));
        }
    }
    fn exited(&self, pid: u32, code: Option<i32>) {
        let mut rt = self.rt.lock().unwrap();
        if !self.current(&rt) || rt.child_pid != Some(pid) { return; }
        recovery::diagnose_codex_stdio(&rt.diagnostics_path(), serde_json::json!({
            "stage": "exit", "code": code, "stop_requested": rt.stopping,
        }));
        if let Engine::CodexStdio(engine) = &mut rt.engine { engine.exited = true; }
        rt.stdio_writer = None;
        self.manager.codex_stdio_loss(&mut rt, CompactionLoss::Exited);
    }
    fn drained(&self, receipt: &TerminalReceipt) {
        let mut rt = self.rt.lock().unwrap();
        if !self.current(&rt) || !rt.child.as_ref().is_some_and(|c| c.pid == receipt.pid && c.epoch == receipt.epoch) { return; }
        rt.stdio_writer = None;
        self.manager.codex_stdio_loss(&mut rt, CompactionLoss::Exited);
        let manual = matches!(&rt.engine, Engine::CodexStdio(e) if e.is_manual_compact());
        let starting = matches!(&rt.engine, Engine::CodexStdio(e) if !e.ready);
        rt.stdio_compaction = None;
        // Reader drain is not process-group extinction. Keep the engine and
        // exact child/PID even on spontaneous exit, until Stop confirms both.
        self.manager.cancel_asks(&mut rt);
        if manual { rt.turn_open = false; }
        // Every line of its stderr is in by now: a Codex that exited before
        // its thread was ready fails the turn with why (#667).
        else if rt.turn_open && starting && !rt.stopping { self.manager.fail_open_turn(&mut rt, &recovery::EarlyExit::said(&self.startup_stderr())); }
        else if rt.turn_open { self.manager.close_open_turn(&mut rt, TurnStatus::Aborted, None); }
        let status = if rt.recovery.is_some() && !rt.stopping { TabStatus::Waiting } else { TabStatus::Idle };
        self.manager.set_status(&mut rt, status);
    }
}

fn same_launch(rt: &TabRuntime, launch: &Arc<()>) -> bool {
    matches!(&rt.engine, Engine::CodexStdio(engine) if Arc::ptr_eq(&engine.launch, launch))
}

#[cfg(test)]
#[path = "session_codex_stdio_tests.rs"]
mod tests;
