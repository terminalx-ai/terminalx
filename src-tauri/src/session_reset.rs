//! Reset changes the native conversation and the app log with one atomic index
//! write. Prepared files are private, immutable generations until that commit.
use super::*;
use crate::checkpoints;
use crate::harness::reset::{anchor, duplicate};
use crate::issue_pipeline::admission::{self, Kind, Scope};
use std::io::Read;

const LIMIT: u64 = 128 * 1024 * 1024;
/// Starts the refusal when restoring files would overwrite other changes; a
/// JSON array of the paths follows. The dialog reads it to ask for confirmation.
pub const OVERLAP: &str = "Other changes to these files would be overwritten: ";
/// Ends an [`OVERLAP`] refusal: the token that confirms exactly that plan.
pub const CONFIRM: &str = "Confirm: ";
const FILES_FENCE: &str = "Files in this checkout are being reset to an earlier turn. Send it again once the reset finishes.";

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

/// Puts back the files a reset restored when the conversation commit fails.
struct RevertFiles<'a> {
    session_id: &'a str,
    tab_id: &'a str,
    applied: Option<&'a checkpoints::ResetApplied>,
}

impl Drop for RevertFiles<'_> {
    fn drop(&mut self) {
        if let Some(applied) = self.applied {
            if let Err(error) = checkpoints::revert_reset(self.session_id, self.tab_id, applied) {
                log::error!("put files back after a failed chat reset (kept in the reset backup checkpoint): {error:#}");
            }
        }
    }
}

impl SessionManager {
    /// `end_seq=None` restores the one saved reset, with the files it replaced.
    /// `reset_files` also puts the checkout back to the end of the chosen turn
    /// (its saved checkpoint); a reset that would overwrite changes other than
    /// this chat's later turns is refused with [`OVERLAP`], the paths and a
    /// [`CONFIRM`] token. Only a request that passes that token as `confirm`,
    /// with nothing changed since, goes ahead.
    pub fn reset_chat(&self, session_id: &str, tab_id: &str, end_seq: Option<u64>, reset_files: bool, confirm: Option<&str>) -> Result<Option<String>> {
        let admitted = admission::lock_for(session_id, tab_id);
        admission::open(session_id, Some(tab_id))?;
        self.accepting_work()?;
        let fence = admission::fence(Kind::Refuse("This chat is being reset. Try again when reset finishes."), [Scope::Tab(session_id.into(), tab_id.into())]);
        drop(admitted);
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).context("Tab not found.")?.clone();
        let undo_backup = tab.unknown.get("resetBackupId").and_then(Value::as_str).map(String::from);
        let undo_files = end_seq.is_none() && undo_backup.as_deref().is_some_and(|backup| checkpoints::reset_has_files(session_id, tab_id, backup));
        // Nothing starts in the checkout while its files go back.
        let _checkout = (reset_files && end_seq.is_some() || undo_files).then(|| {
            let root = checkpoints::workspace_root(&entry.cwd).unwrap_or_else(|_| entry.cwd.clone());
            admission::fence(Kind::Refuse(FILES_FENCE), [Scope::checkout(root)])
        });
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
        let files = match (end_seq, undo_backup.as_deref()) {
            (Some(seq), _) if reset_files => Some(checkpoints::plan_reset(session_id, tab_id, seq)?),
            (None, Some(backup)) => checkpoints::plan_reset_undo(session_id, tab_id, backup)?,
            _ => None,
        };
        anyhow::ensure!(files.is_some() || !undo_files, "The files saved before the reset are unavailable. Nothing was undone.");
        if let Some(plan) = &files {
            if !checkpoints::confirm_overlap(plan, confirm) {
                bail!("{OVERLAP}{}. {} {CONFIRM}{}", serde_json::to_string(&plan.overlap)?,
                    if end_seq.is_some() { "Resetting files removes those changes too." } else { "Undoing the reset removes those changes too." },
                    plan.token());
            }
        }
        let turn = end_seq.map(|seq| current_events.iter().filter(|e| e.seq <= seq && matches!(e.payload, Payload::TurnCompleted { .. })).count());
        // Everything above is read-only, including strict format validation.
        // Stop behind admission, then verify no tail/hook raced the validation.
        self.stop(session_id, tab_id)?;
        // Files go back after the agent stopped and before the conversation
        // commit, which puts them back again if it fails.
        let applied = match &files {
            Some(plan) => Some(checkpoints::apply_reset(session_id, tab_id, plan, &generation)?),
            None => None,
        };
        let mut revert = RevertFiles { session_id, tab_id, applied: applied.as_ref() };
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
        // What the transcript's notice says: "Reset to turn N · M files restored".
        match turn { Some(turn) => { next.unknown.insert("resetTurn".into(), turn.into()); } None => { next.unknown.remove("resetTurn"); } }
        match (&applied, end_seq) {
            (Some(applied), Some(_)) => { next.unknown.insert("resetFilesRestored".into(), applied.paths.len().into()); }
            _ => { next.unknown.remove("resetFilesRestored"); }
        }
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
            for key in ["resetLogId", "resetBackupId", "resetSeq", "resetTurn", "resetFilesRestored"] {
                if let Some(value) = next.unknown.get(key) { current.unknown.insert(key.into(), value.clone()); }
                else { current.unknown.remove(key); }
            }
            for key in ["lastMessageAt", "hasMessages"] { current.unknown.remove(key); }
            next = current.clone();
            Ok(session.clone())
        })?;
        revert.applied = None;
        // The turns cut off (or, on Undo, brought back) are no longer this
        // chat's own when a later reset plans its files.
        let live: std::collections::HashSet<u64> = retained.iter().map(|event| event.seq).collect();
        if let Err(error) = checkpoints::sync_live_turns(session_id, tab_id, &live) {
            log::warn!("[{session_id}/{tab_id}] could not mark the turns a reset cut off: {error:#}");
        }
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
        // File restore outside Git and unknown formats leave process, index
        // and both log files untouched, before any backup is prepared.
        let before = read(&log).unwrap();
        assert!(m.reset_chat("reset-s", "reset-t", Some(3), true, None).is_err());
        std::fs::write(&native, format!("{fixture}\n{{\"type\":\"future\"}}\n")).unwrap();
        assert!(m.reset_chat("reset-s", "reset-t", Some(3), false, None).is_err());
        assert_eq!(store::log_path("reset-s", "reset-t").unwrap(), log);
        assert_eq!(read(&log).unwrap(), before);
        assert_eq!(index::get("reset-s").unwrap().tabs[0].provider_session_id.as_deref(), Some(provider));
        std::fs::write(&native, fixture).unwrap();
        m.reset_chat("reset-s", "reset-t", Some(3), false, None).unwrap();
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
        restarted.reset_chat("reset-s", "reset-t", None, false, None).unwrap();
        let restored = index::get("reset-s").unwrap();
        assert!(!restored.tabs[0].unknown.contains_key("resetBackupId"));
        assert!(read(&store::log_path("reset-s", "reset-t").unwrap()).unwrap().contains("LATER_RESET_SECRET"));
        assert!(read(&native_path(&restored, &restored.tabs[0]).unwrap()).unwrap().contains("LATER_RESET_SECRET"));
        restarted.closing();
        restarted.terminals.kill_all();
    }

    /// PRO-261: "Also reset files" puts the checkout back to the end of the
    /// chosen turn's checkpoint, and Undo puts the later files back.
    #[test]
    fn reset_with_files_matches_the_end_checkpoint_and_undo_restores_them() {
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
        let cwd = std::fs::canonicalize(&cwd).unwrap();
        for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "test@example.com"], &["config", "user.name", "Test"]] {
            crate::git::run(&cwd, args).unwrap();
        }
        std::fs::write(cwd.join("a.txt"), "initial\n").unwrap();
        crate::git::run(&cwd, &["add", "."]).unwrap();
        crate::git::run(&cwd, &["commit", "-qm", "Initial"]).unwrap();
        let provider = "32610000-0000-4000-8000-000000000001";
        let (s, t) = ("reset-files-s", "reset-files-t");
        let entry: index::SessionEntry = serde_json::from_value(json!({"id":s, "projectPath":cwd,"cwd":cwd,"title":"Reset", "created":"now", "modified":"now", "tabs":[{"id":t,"harness":"claude","providerSessionId":provider,"created":"now"}]})).unwrap();
        index::save(std::slice::from_ref(&entry)).unwrap();
        let native = native_path(&entry, &entry.tabs[0]).unwrap();
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&native, include_str!("harness/fixtures/claude-reset.jsonl")).unwrap();
        let log = store::log_path(s, t).unwrap();
        for (seq, payload, write) in [
            (1, json!({"type":"turn_started"}), None),
            (2, json!({"type":"assistant_text","text":"FIRST_RESET_MARKER"}), Some("first\n")),
            (3, json!({"type":"turn_completed","status":"ok"}), None),
            (4, json!({"type":"user_message","text":"LATER","images":[],"queued":false}), Some("later\n")),
            (5, json!({"type":"turn_completed","status":"ok"}), None),
        ] {
            let mut event: Payload = serde_json::from_value(payload.clone()).unwrap();
            crate::checkpoints::observe(s, t, seq, &mut event).unwrap();
            if let Some(text) = write { std::fs::write(cwd.join("a.txt"), text).unwrap(); }
            store::append_line(&log, &json!({"id":format!("e{seq}"),"sessionId":s,"tabId":t,"harness":"claude","seq":seq,"ts":"2026-11-07T10:56:21.941Z","payload":payload}).to_string()).unwrap();
        }
        let end = crate::checkpoints::get(s, t, 1).unwrap().unwrap();
        assert_eq!(std::fs::read_to_string(cwd.join("a.txt")).unwrap(), "later\n");
        let m = manager();
        // A file made by hand overlaps: the refusal lists it with a token, and only that token goes ahead.
        std::fs::write(cwd.join("c.txt"), "by hand\n").unwrap();
        let refused = m.reset_chat(s, t, Some(3), true, None).unwrap_err().to_string();
        assert!(refused.starts_with(OVERLAP) && refused.contains(r#"["c.txt"]"#), "{refused}");
        let token = refused.rsplit_once(CONFIRM).expect("the refusal carries its token").1.to_string();
        let again = m.reset_chat(s, t, Some(3), true, None).unwrap_err().to_string();
        assert!(again.starts_with(OVERLAP), "asking again without the token is refused again, as after a Cancel: {again}");
        assert!(m.reset_chat(s, t, Some(3), true, Some("reset:stale")).is_err(), "another plan's token does not confirm");
        assert_eq!(std::fs::read_to_string(cwd.join("c.txt")).unwrap(), "by hand\n");
        m.reset_chat(s, t, Some(3), true, Some(&token)).unwrap();
        assert!(!cwd.join("c.txt").exists());
        assert_eq!(std::fs::read_to_string(cwd.join("a.txt")).unwrap(), "first\n");
        let first_end = crate::git::run(&cwd, &["rev-parse", &crate::git::checkpoints::reference(s, &format!("{t}-1"), "end").unwrap()]).unwrap();
        assert_eq!(crate::git::snapshot_tree(&cwd).unwrap(), first_end.trim(), "the worktree matches turn 1's end checkpoint");
        assert_eq!(end.files.len(), 1);
        let reset = index::get(s).unwrap();
        assert_eq!(reset.tabs[0].unknown.get("resetTurn"), Some(&json!(1)));
        assert_eq!(reset.tabs[0].unknown.get("resetFilesRestored"), Some(&json!(2)), "a.txt and the confirmed c.txt");
        m.stop(s, t).unwrap();
        m.closing();
        m.terminals.kill_all();
        let restarted = manager();
        restarted.reset_chat(s, t, None, false, None).unwrap();
        assert_eq!(std::fs::read_to_string(cwd.join("a.txt")).unwrap(), "later\n");
        assert_eq!(std::fs::read_to_string(cwd.join("c.txt")).unwrap(), "by hand\n", "Undo puts the confirmed hand edit back too");
        let undone = index::get(s).unwrap();
        assert!(!undone.tabs[0].unknown.contains_key("resetFilesRestored"));
        assert!(!undone.tabs[0].unknown.contains_key("resetBackupId"));
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
        // The fixture's conversation: reset refuses a transcript of another one.
        let provider = "32610000-0000-4000-8000-000000000001";
        let entry: index::SessionEntry = serde_json::from_value(json!({"id":"reset-held-s", "projectPath":cwd,"cwd":cwd,"title":"Reset", "created":"now", "modified":"now", "tabs":[{"id":"reset-held-t","harness":"claude","providerSessionId":provider,"created":"now"}]})).unwrap();
        index::save(std::slice::from_ref(&entry)).unwrap();
        let native = native_path(&entry, &entry.tabs[0]).unwrap();
        std::fs::create_dir_all(native.parent().unwrap()).unwrap();
        std::fs::write(&native, include_str!("harness/fixtures/claude-reset.jsonl")).unwrap();
        let log = store::log_path("reset-held-s", "reset-held-t").unwrap();
        let held = |items: serde_json::Value, paused: bool| json!({"type":"held_queue","queue":{"items":items,"paused":paused}});
        for (seq, payload) in [
            (1, json!({"type":"turn_started"})),
            // The answer reset anchors the cut to in the agent's transcript.
            (2, json!({"type":"assistant_text","text":"FIRST_RESET_MARKER"})),
            (3, held(json!([{"id":"h1","text":"HELD_BEFORE_RESET","images":[]}]), true)),
            (4, json!({"type":"turn_completed","status":"ok"})),
            (5, held(json!([]), false)),
            (6, json!({"type":"user_message","text":"LATER","images":[],"queued":false})),
            (7, json!({"type":"turn_completed","status":"ok"})),
        ] {
            store::append_line(&log, &json!({"id":format!("e{seq}"),"sessionId":"reset-held-s","tabId":"reset-held-t","harness":"claude","seq":seq,"ts":"2026-11-07T10:56:21.941Z","payload":payload}).to_string()).unwrap();
        }
        let m = manager();
        let rt = m.runtime("reset-held-s", "reset-held-t").unwrap();
        assert!(rt.lock().unwrap().held_queue.items.is_empty());
        rt.lock().unwrap().held_queue = held::Queue { items: vec![held::Item { id: "h2".into(), text: "CLAIMED".into(), images: Vec::new(), files: Vec::new() }], sending: Some("h2".into()), ..Default::default() };
        let error = m.reset_chat("reset-held-s", "reset-held-t", Some(4), false, None).unwrap_err();
        assert!(error.to_string().contains("queued messages"), "{error:#}");
        assert_eq!(store::log_path("reset-held-s", "reset-held-t").unwrap(), log);
        rt.lock().unwrap().held_queue = held::Queue::default();
        m.reset_chat("reset-held-s", "reset-held-t", Some(4), false, None).unwrap();
        let new_log = store::log_path("reset-held-s", "reset-held-t").unwrap();
        assert_ne!(new_log, log);
        assert!(held::Queue::restore(&new_log).unwrap().items.is_empty());
        m.stop("reset-held-s", "reset-held-t").unwrap();
        m.closing();
        m.terminals.kill_all();
    }
}
