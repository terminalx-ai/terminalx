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

/// Whether the installed Codex can serve the app-server connection.
fn codex_supported() -> bool {
    let Some(program) = crate::binpath::resolve("codex") else { return false };
    let mut probe = std::process::Command::new(&program);
    probe.arg("--version").env("PATH", crate::binpath::login_path());
    crate::git::output_within(probe, Duration::from_secs(5)).is_ok_and(|version| codex::stdio::supported(&version))
}

impl SessionManager {
    /// Native Codex is tried, not required (#644): a tab that has not started
    /// its thread runs on the terminal engine instead when this Codex is older
    /// than the app server's minimum, or missing. Decided at its first launch,
    /// so an update since the tab was made is followed, and under admission
    /// like the terminal engine's own `--help` probe. Says whether it moved.
    pub(super) fn codex_stdio_falls_back(&self, rt: &TabRuntime, tab: &TabEntry) -> Result<bool> {
        let first_launch = selected(tab) && tab.provider_session_id.is_none() && tab.fork_from.is_none()
            && matches!(rt.engine, Engine::None) && rt.child.is_none();
        if !first_launch || codex_supported() { return Ok(false); }
        index::update_tab(&rt.session_id, &rt.tab_id, |tab| {
            if selected(tab) && tab.provider_session_id.is_none() { tab.transport = AgentTransport::Pty; }
            Ok(())
        })?;
        if let Ok(session) = index::get(&rt.session_id) { self.sink.emit("session_updated", &session); }
        Ok(true)
    }

    pub(super) fn refuse_codex_stdio_operation(&self, session: &str, tab: &str) -> Result<()> {
        let entry = index::get(session)?;
        anyhow::ensure!(!entry.tab(tab).is_some_and(selected), "This operation is not supported for experimental Codex stdio. Create a new session with the desired settings; no PTY handoff or thread migration is performed.");
        Ok(())
    }
    /// The reader opened the terminal view of an experimental tab: Codex moves
    /// to its own terminal interface on the same thread, for good. Admission is
    /// held throughout, so no send starts another connection between the
    /// confirmed exit and the switch. The PTY engine copies the thread's
    /// rollout into its home and reads it from the end, so what the chat
    /// already shows is not drawn again.
    pub fn codex_stdio_to_terminal(&self, session_id: &str, tab_id: &str) -> Result<()> {
        let _admission = crate::issue_pipeline::admission::lock();
        self.accepting_work()?;
        let rt_arc = self.runtime(session_id, tab_id)?;
        let experimental = index::get(session_id)?.tab(tab_id).is_some_and(selected);
        let running = {
            // Decided under the runtime lock as well as by the index: a live
            // connection is never left behind a tab that reads as moved.
            let rt = rt_arc.lock().unwrap();
            let running = matches!(rt.engine, Engine::CodexStdio(_));
            if !experimental && !running { return Ok(()); }
            anyhow::ensure!(!rt.turn_open, "Wait for Codex to finish this turn, or interrupt it, before opening its terminal.");
            running
        };
        if running { self.stop_codex_stdio(&rt_arc)?; }
        index::update_tab(session_id, tab_id, |tab| { tab.transport = AgentTransport::Pty; Ok(()) })?;
        if let Ok(session) = index::get(session_id) { self.sink.emit("session_updated", &session); }
        Ok(())
    }

    /// A permission mode is an approval policy and a sandbox, which Codex
    /// takes when a thread starts or resumes: between turns, an experimental
    /// tab's connection is stopped so its next send resumes under the new one.
    pub(super) fn codex_stdio_mode_change(&self, session: &str, tab: &str, mode: &str, turn_open: bool) -> Result<bool> {
        if !index::get(session)?.tab(tab).is_some_and(selected) { return Ok(false); }
        Stdio::validate_mode(mode)?;
        anyhow::ensure!(!turn_open, "Experimental Codex changes permission mode between turns. Wait for this turn to finish or interrupt it, then change it.");
        Ok(true)
    }

    /// `receipt`: a continuation's sender, told once Codex takes the prompt's
    /// turn, or why it never did. Nothing is replayed into a later turn.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn send_codex_stdio(&self, rt: &mut TabRuntime, rt_arc: &Arc<Mutex<TabRuntime>>, entry: &index::SessionEntry,
        prompt: PromptText, images: Vec<ImageRef>, wire_images: Vec<(String, String)>, receipt: Option<DeliveryReceipt>) -> Result<SendOutcome> {
        let tab = entry.tab(&rt.tab_id).context("tab not found")?;
        // A phone's prompt names who it is from ahead of the request itself;
        // the request alone says whether it is a command.
        let request = typed_request(&prompt.agent);
        let manual = request.trim() == "/compact";
        anyhow::ensure!(!request.trim_start().starts_with('/') || manual, "Only /compact is supported in experimental Codex stdio");
        anyhow::ensure!(!manual || images.is_empty(), "Compaction does not accept images");
        anyhow::ensure!(!manual || receipt.is_none(), "A continuation cannot be a compaction");
        anyhow::ensure!(tab.harness == "codex", "Experimental stdio requires Codex");
        anyhow::ensure!(!rt.turn_open && rt.pending.is_empty(), "Experimental Codex is busy; wait or interrupt before sending again");
        Stdio::validate_mode(&tab.permission_mode)?;
        self.reclaim_ended_codex_stdio(rt);
        if !matches!(rt.engine, Engine::CodexStdio(_)) {
            anyhow::ensure!(matches!(rt.engine, Engine::None) && rt.child.is_none(), "Another engine owns this tab");
            anyhow::ensure!(tab.fork_from.is_none(), "Experimental Codex cannot fork a thread. Create a new experimental session.");
            self.start_codex_stdio(rt, rt_arc, entry, tab)?;
        }
        let text = if manual { "/compact".to_owned() } else { prompt.agent };
        let Engine::CodexStdio(engine) = &mut rt.engine else { unreachable!() };
        let actions = if engine.ready { engine.prompt(text, wire_images)? } else { engine.start(text, wire_images)? };
        // No user message or user turn for manual compaction (#524/#566).
        let events = if manual { Vec::new() } else { vec![self.publish(rt, Payload::UserMessage {
            author: prompt.author, text: prompt.display, images, baseline: git::snapshot_tree(Path::new(&entry.cwd)).ok(), queued: false, cwd: Some(entry.cwd.clone()),
        }, None)] };
        // Every prompt replaces what the last one left: a desktop prompt is
        // held to nothing, a phone's or a share's to its permits.
        rt.stdio_authority = (prompt.mobile.is_some() || prompt.shared_connection.is_some()).then(|| Authority {
            session: rt.session_id.clone(), tab: rt.tab_id.clone(),
            seq: events.first().map(|event| event.seq), mobile: prompt.mobile, shared: prompt.shared_connection,
        });
        // As for the PTY engine: the brief this tab was opened with, which
        // "Resend last prompt" prefers while Codex has not answered it. Only
        // the desktop's Continue in New Session sends one, with no permits.
        if let (Some(receipt), Some(event)) = (receipt, events.first()) {
            if let Err(error) = index::update_tab(&rt.session_id, &rt.tab_id, |t| { t.continuation = Some(event.seq); Ok(()) }) {
                log::warn!("record the continuation prompt of {}: {error:#}", rt.key());
            }
            rt.stdio_receipt = Some((event.seq, receipt));
        }
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
            while let Ok((line, sender)) = rx.recv() {
                if let Err(error) = manager.write_codex_frame(&runtime, &launch, line, sender) {
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

    /// A prompt refused at its write, as `cancel_shared_prompt` ends a PTY
    /// one: the turn it opened ends as stopped and the tab is idle again. A
    /// manual compaction opened no user turn, so it only closes.
    fn withdraw_codex_prompt(&self, rt: &mut TabRuntime, seq: Option<u64>) {
        if seq.is_some() { self.end_open_turn(rt, TurnStatus::Aborted, None); } else { rt.turn_open = false; }
        self.set_status(rt, TabStatus::Idle);
    }

    /// `sender`: the phone's or share's authority a prompt frame carries,
    /// checked before its first byte. It is taken in the order every sender
    /// takes it (`send_mobile`, `type_prompt`, a phone's reconcile): sharing,
    /// the share's admission, the phone's permit, the share owner's
    /// attachment, and only then the tab's runtime, never under it.
    fn write_codex_frame(&self, runtime: &std::sync::Weak<Mutex<TabRuntime>>, launch: &Arc<()>, frame: Outbound, sender: Option<Authority>) -> Result<()> {
        let mut bytes = frame.line.as_bytes().to_vec();
        bytes.push(b'\n');
        let mut offset = 0;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut sender = sender;
        while offset < bytes.len() {
            anyhow::ensure!(Instant::now() < deadline, "Codex input pipe timed out; delivery is uncertain and will not be replayed");
            {
                let _admission = crate::issue_pipeline::admission::lock();
                // Delivery that has begun under a current permit is finished:
                // a stream takes no half frame back.
                let sender = if offset == 0 { sender.take() } else { None };
                let mut sharing = sender.is_some().then(|| self.sharing.lock().unwrap());
                let mut owner_attachment = None;
                let admitted = match &sender {
                    None => Ok(None),
                    Some(sender) => admit_codex_prompt(sender, sharing.as_deref_mut(), &mut owner_attachment)
                        .and_then(|()| sender.mobile.as_ref().map(|permit| permit.enter()).transpose()),
                };
                let owner = admitted.as_ref().ok().and(owner_attachment.as_ref()).map(|attachment| attachment.enter()).transpose();
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
                let (_mobile, _owner) = match (admitted, owner) {
                    (Ok(mobile), Ok(owner)) => (mobile, owner),
                    (Err(error), _) | (_, Err(error)) => {
                        engine.withdraw(&frame);
                        log::warn!("[{}] withdrew a Codex prompt before delivery: {error:#}", rt.key());
                        self.withdraw_codex_prompt(&mut rt, sender.as_ref().and_then(|sender| sender.seq));
                        return Ok(());
                    }
                };
                let entry = index::get(&rt.session_id)?;
                anyhow::ensure!(entry.tab(&rt.tab_id).is_some_and(selected), "Codex tab was closed or changed");
                // The launch is the instance a PTY prompt's pane stands for.
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
                    // The frame carries its sender, so the writer can check
                    // the sender's permits without holding this runtime.
                    let sender = if line.delivers_prompt() { rt.stdio_authority.take() } else { None };
                    rt.stdio_writer.as_ref().context("Codex writer is closed")?
                        .try_send((line, sender)).context("Codex writer queue unavailable; input will not be replayed")?;
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
                StdioAction::Accepted => {
                    if let Some((_, receipt)) = rt.stdio_receipt.take() { let _ = receipt.send(Ok(())); }
                }
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
        // A closed pipe and the write it broke both report one failure; only
        // the stderr read at the close can say more: a refused sign-in.
        if matches!(&rt.engine, Engine::CodexStdio(engine) if engine.failed()) && !exit.as_ref().is_some_and(|exit| exit.sign_in_refused) { return; }
        let unaccepted = matches!(&rt.engine, Engine::CodexStdio(engine) if engine.unaccepted());
        rt.stdio_writer = None;
        rt.stdio_authority = None;
        if let Engine::CodexStdio(engine) = &mut rt.engine { engine.fail(); }
        self.cancel_asks(rt);
        self.codex_stdio_loss(rt, CompactionLoss::Disconnected);
        if let Some((_, receipt)) = rt.stdio_receipt.take() {
            let _ = receipt.send(Err(format!("The new session opened, but Codex did not receive its continuation prompt: {}. The prepared prompt is retained.", said.trim_end_matches('.'))));
        }
        match exit {
            Some(exit) if exit.sign_in_refused && rt.turn_open => self.fail_open_turn(rt, &exit),
            Some(exit) if exit.sign_in_refused => {
                self.apply(rt, Payload::Error { message: RecoveryKind::SignedOut.message().into(), fatal: false, detail: exit.detail }, None);
                self.sign_in_refused(rt);
                self.needs_recovery(rt, RecoveryKind::SignedOut);
            }
            // Codex never took the prompt: it is the reader's to send again
            // ("Resend last prompt"), and its turn never ran.
            exit if unaccepted && rt.turn_open => {
                let detail = exit.and_then(|exit| exit.detail).or_else(|| recovery::detail(&said));
                self.apply(rt, Payload::Error { message: format!("Codex did not receive this prompt: {}", said.trim_end_matches('.')), fatal: false, detail }, None);
                self.close_open_turn(rt, TurnStatus::Aborted, None);
                self.needs_recovery(rt, RecoveryKind::Unsent);
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
        let (launch, unsent) = {
            let mut rt = rt_arc.lock().unwrap();
            anyhow::ensure!(!rt.stop_in_flight, "Stop is already in progress");
            // Stopped before Codex took the prompt: never received, so offered
            // back like any prompt a CLI never took. Decided now: the reader's
            // drain closes the turn before the exit below is confirmed.
            let turn_open = rt.turn_open;
            let Engine::CodexStdio(engine) = &mut rt.engine else { bail!("Codex owner changed") };
            let unsent = turn_open && !engine.is_manual_compact() && engine.unaccepted();
            engine.exited = true;
            let launch = engine.launch.clone();
            rt.stop_in_flight = true; rt.stopping = true;
            rt.stdio_writer = None;
            self.codex_stdio_loss(&mut rt, CompactionLoss::Exited);
            (launch, unsent)
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
        if let Some((_, receipt)) = rt.stdio_receipt.take() {
            let _ = receipt.send(Err("The new session was stopped before Codex received its continuation prompt. The prepared prompt is retained.".into()));
        }
        if manual { rt.turn_open = false; }
        else { self.close_open_turn(&mut rt, TurnStatus::Aborted, None); }
        rt.child = None; rt.child_pid = None; rt.stdio_compaction = None; rt.stdio_authority = None;
        rt.engine = Engine::None;
        rt.stop_in_flight = false; rt.stopping = false;
        if unsent { self.needs_recovery(&mut rt, RecoveryKind::Unsent); }
        else { self.set_status(&mut rt, TabStatus::Idle); }
        Ok(())
    }

    /// A connection that ended on its own (a failed start, a closed pipe)
    /// with nothing left running is let go here, so the next send, "Resend
    /// last prompt" among them, starts or resumes afresh without a Stop. A
    /// child still alive keeps its engine until Stop confirms its exit.
    fn reclaim_ended_codex_stdio(&self, rt: &mut TabRuntime) {
        let ended = matches!(&rt.engine, Engine::CodexStdio(e) if e.exited || e.blocked);
        let gone = rt.child.as_ref().is_none_or(|child| child.terminal_receipt().is_some() && !crate::harness::host::group_or_process_alive(child.pid));
        if !ended || !gone || rt.stdio_starting || rt.stopping { return; }
        rt.stdio_writer = None; rt.stdio_receipt = None; rt.stdio_authority = None; rt.stdio_compaction = None;
        rt.child = None; rt.child_pid = None;
        rt.engine = Engine::None;
    }
}

/// What an experimental tab's history means when it is opened with no
/// connection: a prompt whose turn Codex never started (its `turn_started` is
/// what `unsent::said_in` counts as the agent answering) was never received,
/// and is offered back rather than called a lost connection.
pub(super) fn recovery_on_open(tab: &TabEntry, log: &Path, kind: RecoveryKind) -> RecoveryKind {
    if kind != RecoveryKind::Disconnected { return kind; }
    if unsent::said_in(log, tab.follow.conversation.as_deref()).since.is_empty() { kind } else { RecoveryKind::Unsent }
}

/// A phone's or a share's prompt, as `type_prompt` holds a PTY one: what the
/// sender may give is decided again when its frame is written, and a prompt
/// refused there is withdrawn with nothing of it sent.
pub(super) struct Authority {
    session: String,
    tab: String,
    /// The user message it was published as; none for a manual compaction.
    seq: Option<u64>,
    mobile: Option<crate::local_runtime::mobile::WritePermit>,
    shared: Option<crate::local_sharing::WritePermit>,
}

/// What `type_prompt` asks of a share and of a phone before it types, with
/// the sharing mutex held and the tab's runtime not: the share's own
/// admission and a mode it allows, and the phone's mode unchanged. The
/// guards are taken by the caller.
fn admit_codex_prompt(sender: &Authority, sharing: Option<&mut crate::local_sharing::Sharing>,
    owner: &mut Option<Arc<crate::local_runtime::Attachment>>) -> Result<()> {
    if let Some(connection) = &sender.shared {
        let share = sharing.and_then(|sharing| sharing.sessions.get_mut(&sender.session)).context("Sharing ended before prompt delivery.")?;
        share.admit_at_writer(connection, &sender.tab, chrono::Utc::now().timestamp_millis())?;
        *owner = share.owner.as_ref().map(|owner| owner.attachment.clone());
        let entry = index::get(&sender.session)?;
        let tab = entry.tab(&sender.tab).context("Tab closed before prompt delivery.")?;
        anyhow::ensure!(settings::allowed_while_shared(&tab.permission_mode), "The shared tab changed before prompt delivery.");
    }
    if let Some(permit) = &sender.mobile { permit.check_mode(&sender.session, &sender.tab)?; }
    Ok(())
}

/// What was typed, without the effective-user line a phone's prompt starts with.
fn typed_request(agent: &str) -> &str {
    agent.strip_prefix("[TerminalX Effective User v1] ").and_then(|attributed| attributed.split_once('\n')).map_or(agent, |(_, request)| request)
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
