//! Reset changes the native conversation and the app log with one atomic index
//! write. Prepared files are private, immutable generations until that commit.
use super::*;
use crate::harness::reset::{anchor, duplicate};
use crate::issue_pipeline::admission::{self, Kind, Scope};
use std::io::Read;

const LIMIT: u64 = 128 * 1024 * 1024;

fn read(path: &Path) -> Result<String> {
    let meta = std::fs::symlink_metadata(path).context("The saved conversation is unavailable.")?;
    anyhow::ensure!(meta.is_file() && meta.len() <= LIMIT, "The conversation must be a regular file smaller than 128 MiB to reset.");
    let mut text = String::new();
    std::fs::File::open(path)?.take(LIMIT + 1).read_to_string(&mut text)?;
    anyhow::ensure!(text.len() as u64 <= LIMIT, "The conversation is too large to reset.");
    Ok(text)
}

fn log_events(text: &str) -> Result<Vec<AgentEvent>> {
    let events: Vec<AgentEvent> = text.lines().filter(|l| !l.trim().is_empty()).map(|line| serde_json::from_str(line)
        .context("Unknown app transcript format. Nothing was reset.")).collect::<Result<_>>()?;
    anyhow::ensure!(events.windows(2).all(|pair| pair[0].seq < pair[1].seq
        && pair[0].session_id == pair[1].session_id && pair[0].tab_id == pair[1].tab_id),
        "The app transcript has inconsistent records. Nothing was reset.");
    Ok(events)
}

fn saved_path(session: &str, tab: &str, id: &str, suffix: &str) -> Result<PathBuf> {
    anyhow::ensure!(uuid::Uuid::parse_str(id).is_ok(), "Invalid reset backup id.");
    Ok(store::session_dir(session)?.join(format!("{tab}.reset-{id}.{suffix}")))
}

fn native_path(entry: &index::SessionEntry, tab: &TabEntry) -> Result<PathBuf> {
    let id = tab.provider_session_id.as_deref().context("This tab has no saved agent conversation yet.")?;
    anyhow::ensure!(uuid::Uuid::parse_str(id).is_ok(), "Invalid provider conversation id.");
    match tab.harness.as_str() {
        "claude" => Ok(claude::transcript::locate_in(&crate::agent_data::claude_projects_root().context("Claude's transcript folder is unavailable.")?, &entry.cwd, id)),
        "codex" => [Some(codex::home::managed_root()?), codex::home::native_root_if_made(), codex::home::user_root()]
            .into_iter().flatten().find_map(|home| codex::home::find_rollout(&home, id)).context("Codex's rollout is unavailable."),
        _ => bail!("Reset supports Claude Code and Codex CLI conversations only."),
    }
}

fn destination(harness: &str, cwd: &str, id: &str) -> Result<PathBuf> {
    match harness {
        "claude" => Ok(claude::transcript::transcript_in(&crate::agent_data::claude_projects_root().context("No Claude home.")?, cwd, id)),
        "codex" => {
            let now = chrono::Utc::now();
            Ok(codex::home::managed_root()?.join("sessions").join(now.format("%Y/%m/%d").to_string())
                .join(format!("rollout-{}-{id}.jsonl", now.format("%Y-%m-%dT%H-%M-%S"))))
        }
        _ => bail!("Unsupported agent."),
    }
}

impl SessionManager {
    /// `end_seq=None` restores the one saved reset. Files are deliberately not
    /// supported until PRO-258's checkpoints and overlap confirmation land.
    pub fn reset_chat(&self, session_id: &str, tab_id: &str, end_seq: Option<u64>, reset_files: bool) -> Result<Option<String>> {
        anyhow::ensure!(!reset_files, "Resetting files needs saved turn checkpoints and is not available yet. Nothing was reset.");
        let admitted = admission::lock_for(session_id, tab_id);
        admission::open(session_id, Some(tab_id))?;
        self.accepting_work()?;
        let fence = admission::fence(Kind::Refuse("This chat is being reset. Try again when reset finishes."), [Scope::Tab(session_id.into(), tab_id.into())]);
        drop(admitted);
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).context("Tab not found.")?.clone();
        anyhow::ensure!(matches!(tab.harness.as_str(), "claude" | "codex") && tab.transport == index::AgentTransport::Pty
            && !tab.by_hand() && !tab.is_terminal() && tab.follow.history.is_empty() && tab.follow.conversation.is_none(),
            "Reset is available for managed Claude Code and Codex CLI chats with a single conversation.");
        anyhow::ensure!(!entry.worktree_removed, "This workspace was removed.");
        anyhow::ensure!(!self.sharing.lock().unwrap().sessions.contains_key(session_id), "Stop sharing this chat before resetting it.");
        let rt_arc = self.runtime(session_id, tab_id)?;
        {
            let rt = rt_arc.lock().unwrap();
            anyhow::ensure!(!rt.turn_open && !rt.stopping && !rt.stop_in_flight && rt.restart_claim.is_none()
                && !rt.stdio_starting && rt.pending.is_empty() && rt.queued.is_empty()
                && !matches!(rt.status, TabStatus::InProgress | TabStatus::Waiting)
                && !rt.held_queue.keeps_runtime_busy()
                && !matches!(&rt.engine, Engine::Cli(c) if c.awaiting_delivery.is_some() || c.resend_after_abort.is_some() || !c.held.is_empty()),
                "Wait for the agent and queued messages to finish before resetting this chat.");
        }
        anyhow::ensure!(self.background_work(session_id, tab_id).is_none(), "Stop the agent's background work before resetting this chat.");
        let current_log = rt_arc.lock().unwrap().log_path.clone();
        let current_text = read(&current_log)?;
        let current_events = log_events(&current_text)?;
        let source_path = native_path(&entry, &tab)?;
        let source_text = read(&source_path)?;
        let generation = uuid::Uuid::new_v4().to_string();
        let provider = uuid::Uuid::new_v4().to_string();
        let mut next = tab.clone();
        let (native, log) = if let Some(seq) = end_seq {
            let (end, answer) = anchor(&current_events, seq)?;
            anyhow::ensure!(current_events[end + 1..].iter().any(|e| matches!(e.payload, Payload::UserMessage { .. } | Payload::TurnStarted { .. })),
                "This is already the last turn.");
            let native = duplicate(&tab.harness, &source_text, tab.provider_session_id.as_deref().unwrap(), &provider, Some(&answer))?;
            let mut log = String::new();
            let future_prompts: std::collections::HashSet<u64> = current_events[end + 1..].iter().filter_map(|event| match &event.payload {
                Payload::TurnStarted { prompt_seq, .. } => *prompt_seq,
                _ => None,
            }).collect();
            anyhow::ensure!(!current_events[..=end].iter().any(|event| future_prompts.contains(&event.seq)),
                "This turn has a prompt queued for a later turn. Choose a turn without queued follow-ups.");
            for event in &current_events[..=end] { log.push_str(&serde_json::to_string(event)?); log.push('\n'); }
            (native, log)
        } else {
            let backup = tab.unknown.get("resetBackupId").and_then(Value::as_str).context("There is no reset to undo.")?;
            let old: TabEntry = serde_json::from_str(&read(&saved_path(session_id, tab_id, backup, "tab.json")?)?)?;
            anyhow::ensure!(old.id == tab.id && old.harness == tab.harness, "This reset backup belongs to another tab or agent.");
            let original = read(&saved_path(session_id, tab_id, backup, "provider.backup")?)?;
            let log = read(&saved_path(session_id, tab_id, backup, "log.backup")?)?;
            log_events(&log)?;
            let native = duplicate(&old.harness, &original, old.provider_session_id.as_deref().context("Backup has no conversation id.")?, &provider, None)?;
            next.unknown.remove("resetBackupId");
            (native, log)
        };
        let retained = log_events(&log)?;
        // Everything above is read-only, including strict format validation.
        // Stop behind admission, then verify no tail/hook raced the validation.
        self.stop(session_id, tab_id)?;
        let mut rt = rt_arc.lock().unwrap();
        anyhow::ensure!(read(&source_path)? == source_text, "The native conversation changed during reset. Nothing was reset; try again.");
        let settled = log_events(&read(&current_log)?)?;
        anyhow::ensure!(settled.iter().filter(|e| e.seq > current_events.last().map_or(0, |e| e.seq)).all(|e| matches!(e.payload, Payload::Status { .. } | Payload::SettingsChanged { .. })),
            "The chat changed during reset. Nothing was reset; try again.");
        let native_path = destination(&tab.harness, &entry.cwd, &provider)?;
        store::ensure_dir(native_path.parent().context("No transcript directory.")?.to_path_buf())?;
        store::write_atomic(&native_path, native.as_bytes())?;
        let next_log = saved_path(session_id, tab_id, &generation, "jsonl")?;
        store::write_atomic(&next_log, log.as_bytes())?;
        if end_seq.is_some() {
            let mut backup = tab.clone();
            // Retain exactly one undo level, without recursively retaining a
            // previous backup through the saved tab metadata.
            backup.unknown.remove("resetBackupId");
            store::write_json(&saved_path(session_id, tab_id, &generation, "tab.json")?, &backup)?;
            store::write_atomic(&saved_path(session_id, tab_id, &generation, "provider.backup")?, source_text.as_bytes())?;
            store::write_atomic(&saved_path(session_id, tab_id, &generation, "log.backup")?, current_text.as_bytes())?;
            next.unknown.insert("resetBackupId".into(), generation.clone().into());
        }
        next.provider_session_id = Some(provider);
        next.fork_from = None;
        next.continuation = None;
        next.context_used = None;
        next.context_max = None;
        next.status = TabStatus::Idle;
        next.parked = false;
        next.unknown.insert("resetLogId".into(), generation.clone().into());
        next.unknown.insert("resetSeq".into(), rt.seq.into());
        next.modified = index::now();
        // One commit point for both histories. Failure leaves the original
        // pointers in place; any prepared files are harmless orphan backups.
        let committed = index::update_session(session_id, |session| {
            anyhow::ensure!(session.cwd == entry.cwd && !session.worktree_removed, "The workspace moved during reset. Try again.");
            let current = session.tab_mut(tab_id).context("The tab was closed during reset.")?;
            anyhow::ensure!(current.harness == tab.harness && current.transport == tab.transport && current.follow == tab.follow,
                "The tab changed during reset. Try again.");
            anyhow::ensure!(current.provider_session_id == tab.provider_session_id && current.unknown.get("resetLogId") == tab.unknown.get("resetLogId"), "The conversation changed. Try again.");
            // Change only reset-owned fields: titles/settings may have been
            // edited in another window while the CLI was stopping.
            current.provider_session_id.clone_from(&next.provider_session_id);
            current.fork_from = None;
            current.continuation = None;
            current.context_used = None;
            current.context_max = None;
            current.status = TabStatus::Idle;
            current.parked = false;
            current.modified.clone_from(&next.modified);
            for key in ["resetLogId", "resetBackupId", "resetSeq"] {
                if let Some(value) = next.unknown.get(key) { current.unknown.insert(key.into(), value.clone()); }
                else { current.unknown.remove(key); }
            }
            for key in ["lastMessageAt", "hasMessages"] { current.unknown.remove(key); }
            next = current.clone();
            Ok(session.clone())
        })?;
        rt.log_path = next_log;
        // The new log is a copy cut at an earlier turn (or the pre-reset one
        // on undo). Its last held_queue snapshot can predate deliveries and
        // edits; restore after a restart must not bring those items back.
        if held::Queue::replay(&retained) != rt.held_queue {
            let queue = rt.held_queue.clone();
            if let Err(error) = self.save_held(&mut rt, queue) {
                log::warn!("persist held queue after chat reset: {error:#}");
            }
        }
        rt.left_at = None;
        rt.message_times.clear();
        rt.recovery = None;
        rt.prepared_baseline = None;
        rt.last_settings_report = None;
        rt.compaction = compaction::Admission::default();
        if let Err(error) = store::message_activity::replaced(session_id, tab_id, &retained) {
            log::warn!("Refresh message activity after chat reset: {error:#}");
        }
        self.announce_tab(&rt);
        self.sink.emit("tab_history_reset", &serde_json::json!({"sessionId":session_id,"tabId":tab_id,"generation":generation}));
        // Start while the fence still excludes sends. A failed launch does not
        // roll back a completed reset; its saved conversation resumes later.
        let warning = self.start_cli(&mut rt, &rt_arc, &committed, &next, false).err()
            .map(|error| {
                let detail = recovery::detail(&format!("{error:#}")).unwrap_or_else(|| "The CLI could not start.".into());
                format!("Chat reset, but the agent could not restart: {detail} Send a message to retry.")
            });
        drop(rt);
        drop(fence);
        Ok(warning)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manager() -> SessionManager {
        SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(1024)), Arc::new(crate::sink::NoObserver),
            Arc::new(Host::new()), Arc::new(pty::Terminals::new()), Arc::new(Default::default()),
            Arc::new(Default::default()), crate::hooks::prepare_control().unwrap())
    }

    #[test]
    fn reset_switches_both_histories_and_undo_survives_runtime_restart() {
        let _home = store::temp_home();
        // A harmless stand-in accepts --resume but never calls a provider.
        let program = store::root().unwrap().join("claude");
        std::fs::write(&program, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let _program = claude::pty::claude_program_for_tests(program);
        let cwd = store::root().unwrap().join("checkout");
        std::fs::create_dir(&cwd).unwrap();
        let provider = "32610000-0000-4000-8000-000000000001";
        let entry: index::SessionEntry = serde_json::from_value(json!({"id":"reset-s", "projectPath":cwd,"cwd":cwd,"title":"Reset", "created":"now", "modified":"now", "tabs":[{"id":"reset-t","harness":"claude","providerSessionId":provider,"created":"now"}]})).unwrap();
        index::save(std::slice::from_ref(&entry)).unwrap();
        let native = native_path(&entry, &entry.tabs[0]).unwrap();
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        let fixture = include_str!("harness/fixtures/claude-reset.jsonl");
        std::fs::write(&native, fixture).unwrap();
        let log = store::log_path("reset-s", "reset-t").unwrap();
        for (seq, payload) in [
            (1, json!({"type":"turn_started"})),
            (2, json!({"type":"assistant_text","text":"FIRST_RESET_MARKER"})),
            (3, json!({"type":"turn_completed","status":"ok"})),
            (4, json!({"type":"user_message","text":"LATER_RESET_SECRET","images":[],"queued":false})),
            (5, json!({"type":"turn_completed","status":"ok"})),
        ] {
            store::append_line(&log, &json!({"id":format!("e{seq}"),"sessionId":"reset-s","tabId":"reset-t","harness":"claude","seq":seq,"ts":"2026-11-07T10:56:21.941Z","payload":payload}).to_string()).unwrap();
        }
        let m = manager();
        // Unsupported file restore and unknown formats leave process, index
        // and both log files untouched, before any backup is prepared.
        let before = read(&log).unwrap();
        assert!(m.reset_chat("reset-s", "reset-t", Some(3), true).is_err());
        std::fs::write(&native, format!("{fixture}\n{{\"type\":\"future\"}}\n")).unwrap();
        assert!(m.reset_chat("reset-s", "reset-t", Some(3), false).is_err());
        assert_eq!(store::log_path("reset-s", "reset-t").unwrap(), log);
        assert_eq!(read(&log).unwrap(), before);
        assert_eq!(index::get("reset-s").unwrap().tabs[0].provider_session_id.as_deref(), Some(provider));
        std::fs::write(&native, fixture).unwrap();
        m.reset_chat("reset-s", "reset-t", Some(3), false).unwrap();
        let new_log = store::log_path("reset-s", "reset-t").unwrap();
        assert_ne!(new_log, log);
        assert!(!read(&new_log).unwrap().contains("LATER_RESET_SECRET"));
        assert_eq!(read(&native).unwrap(), fixture);
        let reset_entry = index::get("reset-s").unwrap();
        assert!(!read(&native_path(&reset_entry, &reset_entry.tabs[0]).unwrap()).unwrap().contains("LATER_RESET_SECRET"));
        m.stop("reset-s", "reset-t").unwrap();
        m.closing();
        m.terminals.kill_all();
        let restarted = manager();
        restarted.reset_chat("reset-s", "reset-t", None, false).unwrap();
        let restored = index::get("reset-s").unwrap();
        assert!(!restored.tabs[0].unknown.contains_key("resetBackupId"));
        assert!(read(&store::log_path("reset-s", "reset-t").unwrap()).unwrap().contains("LATER_RESET_SECRET"));
        assert!(read(&native_path(&restored, &restored.tabs[0]).unwrap()).unwrap().contains("LATER_RESET_SECRET"));
        restarted.closing();
        restarted.terminals.kill_all();
    }

    /// The cut log can end on a held_queue snapshot older than the live
    /// queue. Reset must not let a restart bring a delivered item back, and
    /// must not race a held delivery that is about to start.
    #[test]
    fn reset_keeps_the_live_held_queue_and_waits_for_its_delivery() {
        let _home = store::temp_home();
        let program = store::root().unwrap().join("claude");
        std::fs::write(&program, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let _program = claude::pty::claude_program_for_tests(program);
        let cwd = store::root().unwrap().join("checkout");
        std::fs::create_dir(&cwd).unwrap();
        let provider = "32610000-0000-4000-8000-000000000002";
        let entry: index::SessionEntry = serde_json::from_value(json!({"id":"reset-held-s", "projectPath":cwd,"cwd":cwd,"title":"Reset", "created":"now", "modified":"now", "tabs":[{"id":"reset-held-t","harness":"claude","providerSessionId":provider,"created":"now"}]})).unwrap();
        index::save(std::slice::from_ref(&entry)).unwrap();
        let native = native_path(&entry, &entry.tabs[0]).unwrap();
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&native, include_str!("harness/fixtures/claude-reset.jsonl")).unwrap();
        let log = store::log_path("reset-held-s", "reset-held-t").unwrap();
        let held = |items: serde_json::Value, paused: bool| json!({"type":"held_queue","queue":{"items":items,"paused":paused}});
        for (seq, payload) in [
            (1, json!({"type":"turn_started"})),
            (2, held(json!([{"id":"h1","text":"HELD_BEFORE_RESET","images":[]}]), true)),
            (3, json!({"type":"turn_completed","status":"ok"})),
            (4, held(json!([]), false)),
            (5, json!({"type":"user_message","text":"LATER","images":[],"queued":false})),
            (6, json!({"type":"turn_completed","status":"ok"})),
        ] {
            store::append_line(&log, &json!({"id":format!("e{seq}"),"sessionId":"reset-held-s","tabId":"reset-held-t","harness":"claude","seq":seq,"ts":"2026-11-07T10:56:21.941Z","payload":payload}).to_string()).unwrap();
        }
        let m = manager();
        let rt = m.runtime("reset-held-s", "reset-held-t").unwrap();
        assert!(rt.lock().unwrap().held_queue.items.is_empty());
        rt.lock().unwrap().held_queue = held::Queue { items: vec![held::Item { id: "h2".into(), text: "CLAIMED".into(), images: Vec::new() }], sending: Some("h2".into()), ..Default::default() };
        let error = m.reset_chat("reset-held-s", "reset-held-t", Some(3), false).unwrap_err();
        assert!(error.to_string().contains("queued messages"), "{error:#}");
        assert_eq!(store::log_path("reset-held-s", "reset-held-t").unwrap(), log);
        rt.lock().unwrap().held_queue = held::Queue::default();
        m.reset_chat("reset-held-s", "reset-held-t", Some(3), false).unwrap();
        let new_log = store::log_path("reset-held-s", "reset-held-t").unwrap();
        assert_ne!(new_log, log);
        assert!(held::Queue::restore(&new_log).unwrap().items.is_empty());
        m.stop("reset-held-s", "reset-held-t").unwrap();
        m.closing();
        m.terminals.kill_all();
    }
}
