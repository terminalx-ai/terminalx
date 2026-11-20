//! Forking a tab's conversation (PRO-379): into a new tab beside it, or into
//! a new session on a worktree of its own with the turn's files where they
//! were kept. Shared by the desktop's commands and a runtime's
//! `session.fork` (#1326), so a cloud or machine session forks exactly as a
//! local one does. Nothing here announces the fork; each caller does.
use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use crate::store::index::{self, SessionEntry, TabEntry, TabStatus};
use crate::{git, names, store};

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

/// Where a fork from a turn goes (PRO-379).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ForkInto {
    /// A new tab beside the source, in the same checkout.
    Tab,
    /// A new session, on a worktree of its own with the turn's files where it can.
    Session,
}

/// A tab's new copy for a fork: idle, not yet run, on the account the source ran on.
pub(crate) fn forked_tab(tab: &TabEntry, now: &str) -> TabEntry {
    let mut new_tab = tab.clone();
    new_tab.id = uuid::Uuid::now_v7().to_string();
    new_tab.status = TabStatus::Idle;
    new_tab.created = now.to_owned();
    new_tab.modified = now.to_owned();
    // Claude can fork a conversation; Codex starts a new thread over the copied log.
    new_tab.fork_from = if tab.harness == "claude" { tab.provider_session_id.clone() } else { None };
    new_tab.provider_session_id = None;
    for key in ["resetLogId", "resetBackupId", "resetSeq", "resetTurn", "resetFilesRestored"] { new_tab.unknown.remove(key); }
    // On the agent account the source tab ran on (#980), asked for, so
    // the fork goes on as the conversation did; it has not run yet.
    let account = crate::session_ops::tab_running_account(tab).map(str::to_owned);
    crate::session_ops::set_tab_account(&mut new_tab, account.as_deref());
    new_tab.unknown.remove(crate::session_ops::TAB_LAUNCHED_ACCOUNT);
    new_tab
}

/// Write a forked tab's log: these events, re-stamped so the new tab owns them.
pub(crate) fn write_forked_log(session_id: &str, tab_id: &str, lines: impl Iterator<Item = serde_json::Value>) -> Result<(), String> {
    let mut out = String::new();
    for mut v in lines {
        v["sessionId"] = serde_json::Value::String(session_id.to_owned());
        v["tabId"] = serde_json::Value::String(tab_id.to_owned());
        out.push_str(&v.to_string());
        out.push('\n');
    }
    let path = store::log_path(session_id, tab_id).map_err(err)?;
    store::write_atomic(&path, out.as_bytes()).map_err(err)
}

/// The conversation up to `end_seq` under a new provider id (see
/// [`crate::session::fork_conversation`]), with the new tab pointed at it.
/// Read-only until [`ForkedConversation::write`].
pub(crate) struct ForkedConversation { harness: String, provider: String, native: String, events: Vec<crate::events::AgentEvent> }

impl ForkedConversation {
    fn prepare(src: &SessionEntry, tab: &TabEntry, new_tab: &mut TabEntry, end_seq: u64) -> Result<Self, String> {
        let provider = uuid::Uuid::new_v4().to_string();
        let (native, events) = crate::session::fork_conversation(src, tab, end_seq, &provider).map_err(err)?;
        new_tab.provider_session_id = Some(provider.clone());
        new_tab.fork_from = None;
        new_tab.continuation = None;
        new_tab.context_used = None;
        new_tab.context_max = None;
        Ok(Self { harness: tab.harness.clone(), provider, native, events })
    }

    /// The agent's transcript where it looks from `cwd`, and the app log for the new tab.
    fn write(&self, cwd: &str, session_id: &str, tab_id: &str) -> Result<(), String> {
        crate::session::write_forked_conversation(&self.harness, cwd, &self.provider, &self.native).map_err(err)?;
        let lines = self.events.iter().map(|event| serde_json::to_value(event).map_err(err)).collect::<Result<Vec<_>, String>>()?;
        write_forked_log(session_id, tab_id, lines.into_iter())
    }
}

/// Fork a tab's conversation at the end of the turn `end_seq` into a new tab
/// beside it, in the same checkout (PRO-379). Persisted; announcing it is the
/// caller's: the desktop's window events, or a runtime's `session.sessions`.
pub(crate) fn fork_into_tab_contents(session_id: &str, tab_id: &str, end_seq: u64) -> Result<(SessionEntry, String), String> {
    let src = index::get(session_id).map_err(err)?;
    if src.worktree_removed { return Err("This workspace was removed.".into()); }
    let tab = src.tab(tab_id).cloned().ok_or("no such tab")?;
    let mut new_tab = forked_tab(&tab, &index::now());
    ForkedConversation::prepare(&src, &tab, &mut new_tab, end_seq)?.write(&src.cwd, session_id, &new_tab.id)?;
    let session = index::update_session(session_id, |session| {
        let at = session.tabs.iter().position(|t| t.id == tab_id).map_or(session.tabs.len(), |i| i + 1);
        session.tabs.insert(at, new_tab.clone());
        session.active_tab = Some(new_tab.id.clone());
        Ok(session.clone())
    }).map_err(err)?;
    Ok((session, new_tab.id))
}

/// Resolve the existing prefix of a path while retaining its missing suffix.
pub(crate) fn resolve_missing_path(path: &Path) -> Result<std::path::PathBuf, String> {
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::CurDir)) {
        return Err("Cannot verify a source path containing relative components.".into());
    }
    for ancestor in path.ancestors() {
        match std::fs::symlink_metadata(ancestor) {
            Ok(_) => return Ok(std::fs::canonicalize(ancestor).map_err(err)?.join(path.strip_prefix(ancestor).map_err(err)?)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(err(error)),
        }
    }
    Err("Missing path ancestor".into())
}

/// Allocate and restore the fork's checkout under the same rollback guard as its conversation.
pub(crate) fn fork_workspace(src: &SessionEntry, tab: &TabEntry, entry: &mut SessionEntry, at: Option<u64>, allocation: &mut crate::fork_allocation::ForkAllocation) -> Result<Option<String>, String> {
    let project_path = Path::new(&src.project_path);
    let project_repo = git::common_dir(project_path);
    let source_repo = git::common_dir(Path::new(&src.cwd));
    let main_git_turn = at.is_some() && !src.is_quick() && project_repo.is_some() && project_repo == source_repo;
    let mut relative_cwd = None;
    let mut recovered_checkout = None;
    if !src.worktree_removed && (src.worktree_name.is_some() || main_git_turn) {
        let source_cwd = Path::new(&src.cwd);
        let missing = match std::fs::symlink_metadata(source_cwd) {
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Err(error) => return Err(err(error)),
        };
        let recovery_branch = if missing {
            let unavailable = "The source working directory is unavailable and its checkout could not be verified.";
            let branch = src.branch.as_deref().filter(|branch| !branch.is_empty()).ok_or(unavailable)?;
            let common = project_repo.as_deref().ok_or(unavailable)?;
            let (root, relative) = if let Some(identity) = src.checkout_identity() {
                let root = Path::new(src.checkout_root().ok_or(unavailable)?);
                (root.to_path_buf(), identity.missing_cwd(common, root, source_cwd, branch).ok_or(unavailable)?)
            } else if src.unknown.contains_key("checkoutIdentity") {
                return Err(unavailable.into());
            } else {
                crate::checkpoints::legacy_fork_workspace(src, project_path, common, branch).ok_or(
                    "This older session has no saved evidence that verifies the missing checkout's original Git registration.",
                )?
            };
            relative_cwd = Some(relative);
            if git::run(project_path, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_err() {
                return Err("The source worktree branch is unavailable.".into());
            }
            recovered_checkout = Some(root);
            Some(branch)
        } else { None };
        if !missing {
            let source_cwd = std::fs::canonicalize(source_cwd).map_err(err)?;
            if project_repo.is_none() || git::common_dir(&source_cwd) != project_repo {
                return Err("The source worktree belongs to a different repository.".into());
            }
            let source_root = git::run(&source_cwd, &["rev-parse", "--show-toplevel"]).map_err(err)?;
            let source_root = std::fs::canonicalize(source_root.trim()).map_err(err)?;
            relative_cwd = Some(source_cwd.strip_prefix(source_root).map_err(err)?.to_path_buf());
        }
        let taken = index::load().map(|s| index::claimed_worktree_names(&s)).unwrap_or_default();
        let taken = git::taken_worktree_names(project_path, &taken);
        let name = names::unclaimed(&taken);
        if let Some(source_root) = recovered_checkout.as_deref() {
            let destination = resolve_missing_path(&git::worktree_path(project_path, &name))?;
            if destination.starts_with(source_root) || source_root.starts_with(&destination) {
                return Err("The fork destination overlaps the source worktree.".into());
            }
        }
        // A main checkout may have switched branches since the session was created.
        let source_branch = if src.worktree_name.is_none() { git::current_branch(source_cwd) } else { None };
        let base = if let Some(branch) = recovery_branch {
            Some(format!("refs/heads/{branch}"))
        } else if src.worktree_name.is_none() {
            Some(match &source_branch {
                Some(branch) => branch.clone(),
                None => git::run(Path::new(&src.cwd), &["rev-parse", "HEAD"]).map_err(err)?.trim().to_owned(),
            })
        } else { src.branch.clone() };
        let (mut wt, created_commit) = git::create_fork_worktree(project_path, &name, base.as_deref()).map_err(err)?;
        if let Some(provenance) = &mut wt.worktree_base {
            if let Some(branch) = recovery_branch {
                provenance.from = Some(branch.into());
            } else if src.worktree_name.is_none() && source_branch.is_none() {
                provenance.from = None;
            }
        }
        entry.cwd = wt.path.clone();
        entry.bind_checkout_root(&wt.path);
        entry.worktree_name = Some(wt.name.clone());
        entry.branch = Some(wt.branch.clone());
        entry.base_ref = Some(wt.base_tree.clone());
        entry.worktree_base = wt.worktree_base.clone();
        allocation.worktree(project_path, wt, created_commit);
    }
    let mut note = if let Some(end_seq) = at {
        if entry.worktree_name.is_some() {
            let verified_checkout = recovered_checkout.as_deref().map(|root| (root, Path::new(&entry.cwd)));
            match crate::checkpoints::turn_end(&src.id, &tab.id, end_seq, verified_checkout) {
                Err(error) => Some(format!("The new worktree has the branch's latest files: {error:#}")),
                Ok((tree, index)) => allocation.checkpoint(&tree, &index, || crate::checkpoints::check_out_turn(&entry.cwd, &tree, &index))
                    .err().map(|error| format!("The turn's files could not be fully restored in the new worktree: {error:#}")),
            }
        } else {
            Some("The fork shares this checkout, so its files are as they are now.".into())
        }
    } else { None };
    if let Some(relative) = relative_cwd.filter(|path| !path.as_os_str().is_empty()) {
        let root = std::fs::canonicalize(&entry.cwd).map_err(err)?;
        let target = root.join(&relative);
        match std::fs::canonicalize(&target) {
            Ok(path) if path.starts_with(&root) && path.is_dir() => entry.cwd = path.to_string_lossy().into_owned(),
            _ => {
                let message = format!("The original working directory {} is unavailable in the new worktree; the fork starts at its root.", relative.display());
                note = Some(match note { Some(note) => format!("{note} {message}"), None => message });
            }
        }
    }
    Ok(note)
}

/// Create and persist a fork before announcing it to the app.
pub(crate) fn fork_session_contents(session_id: &str, tab_id: &str, at: Option<u64>) -> Result<(SessionEntry, Option<String>), String> {
    {
        let session_id = session_id.to_owned();
        let tab_id = tab_id.to_owned();
        let src = index::get(&session_id).map_err(err)?;
        let tab = src.tab(&tab_id).cloned().ok_or("no such tab")?;
        let id = uuid::Uuid::now_v7().to_string();
        let now = index::now();
        let mut new_tab = forked_tab(&tab, &now);
        // Read and checked before anything is made for the fork.
        let conversation = at.map(|end_seq| ForkedConversation::prepare(&src, &tab, &mut new_tab, end_seq)).transpose()?;
        // A quick chat's fork is a quick chat with a scratch directory of its
        // own: sharing the parent's would have either one's deletion take the
        // other's files. What the parent had there is copied, since the
        // conversation refers to it.
        let mut allocation = crate::fork_allocation::ForkAllocation::default();
        let result = (|| -> Result<(SessionEntry, Option<String>), String> {
            let scratch = if src.is_quick() {
                let path = store::quick::dir(&id).map_err(err)?;
                allocation.directory(&path).map_err(err)?;
                Some(std::fs::canonicalize(&path).map_err(err)?.to_string_lossy().into_owned())
            } else { None };
            let in_scratch = src.is_quick() && store::quick::is_scratch(&src.id, &src.cwd);
            let mut scratch_copy = None;
            if let (Some(scratch), true) = (&scratch, in_scratch) {
                scratch_copy = Some(copy_dir(Path::new(&src.cwd), Path::new(scratch)));
                // The fork's CLI reopens the parent conversation from the new
                // directory, and Claude Code looks for it under that directory's name.
                if let (Some(parent), Some(projects)) = (new_tab.fork_from.as_deref(), crate::agent_data::claude_projects_root()) {
                    allocation.rehome_claude(&projects, &src.cwd, scratch, parent).map_err(err)?;
                }
            }
            let mut entry = SessionEntry {
                id: id.clone(),
                kind: src.kind,
                project_path: scratch.clone().unwrap_or_else(|| src.project_path.clone()),
                cwd: if in_scratch { scratch.clone().unwrap_or_else(|| src.cwd.clone()) } else { src.cwd.clone() },
                worktree_name: None,
                branch: src.branch.clone(),
                base_ref: None,
                worktree_base: None,
                worktree_removed: false,
                removed_workspace: None,
                issue: src.issue.clone(),
                issue_work: src.issue_work.clone(),
                automation: src.automation.clone(),
                title: format!("{} (fork)", src.title),
                created: now.clone(),
                modified: now,
                archived: false,
                archive: Default::default(),
                pinned: false,
                manual_status: Default::default(),
                tabs: vec![new_tab.clone()],
                active_tab: Some(new_tab.id.clone()),
                link: None,
                parent: None,
                unknown: BTreeMap::new(),
            };
            let mut note = fork_workspace(&src, &tab, &mut entry, at, &mut allocation)?;
            if at.is_some() && entry.worktree_name.is_none() {
                note = Some(non_worktree_fork_note(scratch_copy.as_ref()));
            }
            if let Some(conversation) = &conversation {
                let native = crate::session::fork_conversation_destination(&conversation.harness, &entry.cwd, &conversation.provider).map_err(err)?;
                let lines = conversation.events.iter().map(|event| serde_json::to_value(event).map_err(err)).collect::<Result<Vec<_>, String>>()?;
                let mut out = String::new();
                for mut value in lines {
                    value["sessionId"] = serde_json::Value::String(id.clone());
                    value["tabId"] = serde_json::Value::String(new_tab.id.clone());
                    out.push_str(&value.to_string());
                    out.push('\n');
                }
                let dir = store::sessions_dir().map_err(err)?.join(&id);
                allocation.conversation(&native, conversation.native.as_bytes(), &dir, &new_tab.id, out.as_bytes()).map_err(err)?;
            }
            // Copy the log, re-stamping envelopes so the new tab owns them.
            if let (None, Ok(dir)) = (&conversation, store::sessions_dir()) {
                let from = store::log_path(&src.id, &tab.id).map_err(err)?;
                if let Ok(text) = std::fs::read_to_string(&from) {
                    let to_dir = dir.join(&id);
                    allocation.directory(&to_dir).map_err(err)?;
                    let mut out = String::with_capacity(text.len());
                    for line in text.lines() {
                        if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(line) {
                            v["sessionId"] = serde_json::Value::String(id.clone());
                            v["tabId"] = serde_json::Value::String(new_tab.id.clone());
                            out.push_str(&v.to_string());
                            out.push('\n');
                        }
                    }
                    allocation.write(&to_dir.join(format!("{}.jsonl", new_tab.id)), out.as_bytes()).map_err(err)?;
                }
            }
            if let Ok(root) = store::root() {
                let from = root.join("attachments").join(&src.id);
                if from.is_dir() {
                    let parent = root.join("attachments");
                    std::fs::create_dir_all(&parent).map_err(err)?;
                    let to = parent.join(&id);
                    allocation.directory(&to).map_err(err)?;
                    copy_dir(&from, &to).map_err(err)?;
                }
            }
            index::update(|sessions| {
                if sessions.iter().any(|session| session.id == id) { anyhow::bail!("Session id already exists"); }
                sessions.push(entry.clone());
                Ok(())
            })
            .map_err(err)?;
            Ok((entry, note))
        })();
        let (entry, note) = match result {
            Ok(result) => { allocation.commit(); result }
            Err(error) => return Err(allocation.rollback(error)),
        };
        Ok((entry, note))
    }
}

/// Describe the actual non-worktree destination and its file-state limitation.
pub(crate) fn non_worktree_fork_note(scratch_copy: Option<&std::io::Result<()>>) -> String {
    match scratch_copy {
        Some(Ok(())) => "The fork has a separate scratch directory with a copy of the current files. Files were not restored to the selected turn.".into(),
        Some(Err(error)) => format!("The fork has a separate scratch directory, but copying the current files failed and may be incomplete: {error}. Files were not restored to this turn."),
        None => "The fork shares this checkout, so its files are as they are now.".into(),
    }
}

#[cfg(test)]
mod fork_notice_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn turn_forks_report_their_actual_scratch_or_shared_destination() {
        let _home = store::temp_home();
        let shared = store::root().unwrap().join("shared");
        std::fs::create_dir(&shared).unwrap();
        let scratch = store::quick::create("quick-scratch").unwrap();
        let provider = "32610000-0000-4000-8000-000000000001";
        let cases = [
            ("quick-scratch", "quick", scratch.as_str(), true),
            ("quick-shared", "quick", shared.to_str().unwrap(), false),
            ("project-shared", "project", shared.to_str().unwrap(), false),
        ];
        for (id, kind, cwd, copied) in cases {
            std::fs::write(Path::new(cwd).join("note.txt"), "current files").unwrap();
            let entry: SessionEntry = serde_json::from_value(json!({
                "id": id, "kind": kind, "projectPath": cwd, "cwd": cwd, "title": "Fork",
                "created": "now", "modified": "now",
                "tabs": [{"id":"fork-t", "harness":"claude", "providerSessionId":provider, "created":"now"}]
            })).unwrap();
            index::update(|sessions| { sessions.push(entry.clone()); Ok(()) }).unwrap();
            let native = crate::session::fork_conversation_destination("claude", cwd, provider).unwrap();
            std::fs::create_dir_all(native.parent().unwrap()).unwrap();
            std::fs::write(native, include_str!("harness/fixtures/claude-reset.jsonl")).unwrap();
            let log = store::log_path(id, "fork-t").unwrap();
            for (seq, payload) in [
                (1, json!({"type":"turn_started"})),
                (2, json!({"type":"assistant_text","text":"FIRST_RESET_MARKER"})),
                (3, json!({"type":"turn_completed","status":"ok"})),
            ] {
                store::append_line(&log, &json!({"id":format!("e{seq}"),"sessionId":id,"tabId":"fork-t","harness":"claude","seq":seq,"ts":"2026-11-07T10:56:21.941Z","payload":payload}).to_string()).unwrap();
            }
            let (fork, note) = fork_session_contents(id, "fork-t", Some(3)).unwrap();
            let note = note.unwrap();
            if copied {
                assert_ne!(fork.cwd, cwd);
                assert_eq!(std::fs::read_to_string(Path::new(&fork.cwd).join("note.txt")).unwrap(), "current files");
                assert!(note.contains("separate scratch directory") && note.contains("copy of the current files"), "{note}");
                assert!(note.contains("not restored to the selected turn"), "{note}");
                std::fs::write(Path::new(&fork.cwd).join("note.txt"), "fork files").unwrap();
                assert_eq!(std::fs::read_to_string(Path::new(cwd).join("note.txt")).unwrap(), "current files");
            } else {
                assert_eq!(fork.cwd, cwd);
                assert!(note.contains("shares this checkout") && note.contains("files are as they are now"), "{note}");
            }
        }
    }

    #[test]
    fn failed_scratch_copy_reports_incomplete_current_files() {
        let source = tempfile::tempdir().unwrap();
        let destination = tempfile::tempdir().unwrap();
        let failed = copy_dir(&source.path().join("missing"), destination.path());
        let note = non_worktree_fork_note(Some(&failed));
        assert!(note.contains("copying the current files failed") && note.contains("may be incomplete"));
        assert!(note.contains("not restored to this turn"));
    }
}

pub(crate) fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let dest = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &dest)?;
        } else {
            std::fs::copy(e.path(), dest)?;
        }
    }
    Ok(())
}
