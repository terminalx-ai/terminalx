//! Durable turn checkpoints, review decisions and one-shot revert context.
use crate::{
    events::Payload,
    git::{self, checkpoints as trees},
    store::{self, index},
};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Mutex,
};

// Sends may publish checkpoint events, so this is separate from the store lock.
type SendLocks = Mutex<std::collections::HashMap<String, std::sync::Arc<Mutex<()>>>>;
static SEND_LOCKS: std::sync::LazyLock<SendLocks> = std::sync::LazyLock::new(Mutex::default);
pub fn send_lock(session: &str, tab: &str) -> std::sync::Arc<Mutex<()>> {
    SEND_LOCKS.lock().unwrap().entry(format!("{session}/{tab}")).or_default().clone()
}
fn workspace_locked<T>(cwd: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    use sha2::{Digest, Sha256};
    // The desktop and runtime must share a lock, including different sessions
    // in one checkout, without making unrelated workspaces wait for a snapshot.
    let workspace = root(cwd).unwrap_or_else(|_| cwd.to_string());
    let key = format!("{:x}", Sha256::digest(workspace.as_bytes()));
    store::transaction::run(&store::root()?.join(format!("checkpoints-{key}.lock")), std::time::Duration::from_secs(30), f)
}
fn locked<T>(session: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    workspace_locked(&index::get(session)?.cwd, f)
}

#[derive(Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    repository: Option<String>,
    turns: Vec<Checkpoint>,
    #[serde(default)]
    notes: Vec<Note>,
    #[serde(default)]
    sent_notes: std::collections::BTreeMap<u64, Vec<Note>>,
    /// The files the last chat reset replaced, for its one level of Undo.
    #[serde(default)]
    reset: Option<ResetBackup>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Note {
    id: String,
    text: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    seq: u64,
    pub number: usize,
    cwd: String,
    start: String,
    index: Option<String>,
    end: Option<String>,
    end_index: Option<String>,
    pub reviewed: bool,
    pub undone: bool,
    pub files: Vec<git::ChangedFile>,
    #[serde(default)]
    started_at: Option<i64>,
    #[serde(default)]
    ended_at: Option<i64>,
    /// Retained even when a concurrent conversation is subsequently deleted.
    #[serde(default)]
    concurrent_paths: BTreeSet<String>,
    /// A concurrent turn had incomplete evidence; all of this turn's paths overlap.
    #[serde(default)]
    concurrent_unknown: bool,
    #[serde(default)]
    backup: Option<Backup>,
    #[serde(default)]
    pub restored: bool,
    #[serde(default)]
    pub backup_ref: Option<String>,
    #[serde(default)]
    pub unavailable_reason: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Backup {
    tree: String,
    index: String,
    note_id: String,
}

pub struct Completed {
    pub seq: u64,
    pub base: String,
    pub head: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    pub overlap: Vec<String>,
    pub token: String,
    pub undone: bool,
    pub backup_ref: Option<String>,
}

fn file(session: &str, tab: &str) -> Result<PathBuf> {
    trees::reference(session, tab, "start")?;
    Ok(store::root()?.join("sessions").join(session).join(format!("checkpoints-{tab}.json")))
}
fn load(session: &str, tab: &str) -> Result<State> {
    match std::fs::read(file(session, tab)?) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(e) => Err(e.into()),
    }
}
fn save(session: &str, tab: &str, state: &State) -> Result<()> {
    let path = file(session, tab)?;
    store::ensure_dir(path.parent().unwrap().to_path_buf())?;
    store::write_json(&path, state)
}
fn root(cwd: &str) -> Result<String> {
    Ok(git::run(Path::new(cwd), &["rev-parse", "--show-toplevel"])?.trim().into())
}
fn index_tree(cwd: &Path) -> Result<String> {
    Ok(git::run(cwd, &["write-tree"])?.trim().into())
}

fn file_paths(turn: &Checkpoint) -> BTreeSet<String> {
    turn.files
        .iter()
        .flat_map(|f| std::iter::once(f.path.clone()).chain(f.old_path.clone()))
        .collect()
}

/// Atomic state files include closed tabs; the index includes archived sessions.
fn workspace_states(cwd: &str) -> Result<Vec<(String, String, State)>> {
    workspace_states_in(cwd, &index::load()?)
}

fn workspace_states_in(cwd: &str, sessions: &[index::SessionEntry]) -> Result<Vec<(String, String, State)>> {
    let mut states = Vec::new();
    let directory = store::root()?.join("sessions");
    for session in sessions {
        trees::reference(&session.id, "validate", "start")?;
        let entries = match std::fs::read_dir(directory.join(&session.id)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(tab) = name.strip_prefix("checkpoints-").and_then(|n| n.strip_suffix(".json")) else {
                continue;
            };
            let state = load(&session.id, tab)?;
            if state.turns.iter().any(|turn| turn.cwd == cwd) {
                states.push((session.id.clone(), tab.to_string(), state));
            }
        }
    }
    Ok(states)
}

pub(crate) struct RetentionState {
    pub owned: BTreeSet<String>,
    pub protected: BTreeSet<String>,
    pub discard_prefixes: Vec<String>,
    pub running: bool,
}

/// One read per batch of refs, under the workspace lock. Protect the complete
/// overlap window, not just the active turn: newer completed turns may include
/// the active agent's edits, and must remain available for its eventual diff.
pub(crate) fn retention_state(cwd: &str) -> Result<RetentionState> {
    let sessions = index::load()?;
    let states = workspace_states_in(cwd, &sessions)?;
    let oldest_running = states
        .iter()
        .flat_map(|(_, _, state)| &state.turns)
        .filter(|turn| turn.cwd == cwd && turn.end.is_none())
        .map(|turn| turn.started_at.unwrap_or(i64::MIN))
        .min();
    let mut owned = BTreeSet::new();
    let mut protected = BTreeSet::new();
    for (session, tab, state) in states {
        for turn in state.turns.iter().filter(|turn| turn.cwd == cwd) {
            let name = trees::reference(&session, &format!("{tab}-{}", turn.seq), "start")?;
            let group = name.trim_end_matches("/start").to_string();
            if turn.end.is_none()
                || oldest_running.is_some_and(|oldest| turn.started_at.unwrap_or(i64::MAX) >= oldest || turn.ended_at.unwrap_or(i64::MAX) >= oldest)
            {
                protected.insert(group.clone());
            }
            owned.insert(group);
        }
    }
    let discard_prefixes = sessions
        .iter()
        .filter(|session| in_workspace(&session.cwd, cwd))
        .map(|session| format!("refs/raccoon-checkpoints/{}/discard-", session.id))
        .collect();
    Ok(RetentionState {
        owned,
        protected,
        discard_prefixes,
        running: oldest_running.is_some(),
    })
}

/// Missing refs are uncertain even if their objects have not been collected yet.
/// Never interpret a lost/unfinished checkpoint's empty file list as no edits.
fn uncertain(session: &str, tab: &str, turn: &Checkpoint) -> Result<bool> {
    let id = format!("{tab}-{}", turn.seq);
    let cwd = Path::new(&turn.cwd);
    Ok(turn.end.is_none() || turn.unavailable_reason.is_some() || !trees::exists(cwd, session, &id, "start")? || !trees::exists(cwd, session, &id, "end")?)
}

fn not_before(peer: &Checkpoint, target: &Checkpoint) -> bool {
    match (peer.ended_at, target.started_at) {
        (Some(end), Some(start)) => end >= start,
        _ => true,
    }
}
fn concurrent(peer: &Checkpoint, target: &Checkpoint) -> bool {
    not_before(peer, target) && not_before(target, peer)
}

/// Save evidence on both sides before either conversation can be removed.
fn remember_concurrent(session: &str, tab: &str, turn: &mut Checkpoint) -> Result<()> {
    let own_paths = file_paths(turn);
    let target = turn.clone();
    let unknown = uncertain(session, tab, turn)?;
    for (owner, peer_tab, mut state) in workspace_states(&turn.cwd)? {
        if owner == session && peer_tab == tab {
            continue;
        }
        let mut changed = false;
        for peer in state.turns.iter_mut().filter(|p| p.cwd == target.cwd && concurrent(p, &target)) {
            if unknown {
                peer.concurrent_unknown = true;
            } else {
                peer.concurrent_paths.extend(own_paths.iter().cloned());
            }
            if uncertain(&owner, &peer_tab, peer)? {
                turn.concurrent_unknown = true;
            } else {
                turn.concurrent_paths.extend(file_paths(peer));
            }
            changed = true;
        }
        if changed {
            save(&owner, &peer_tab, &state)?;
        }
    }
    Ok(())
}

fn finish(session: &str, tab: &str, turn: &mut Checkpoint) -> Result<()> {
    let cwd = Path::new(&turn.cwd);
    let end = git::snapshot_tree(cwd)?;
    let end_index = index_tree(cwd).ok();
    let id = format!("{tab}-{}", turn.seq);
    if trees::exists(cwd, session, &id, "start")? {
        turn.files = git::changes_between(cwd, &turn.start, Some(&end))?;
        let mut snapshots = vec![("end", end.as_str())];
        if let Some(index) = &end_index {
            snapshots.push(("end-index", index));
        }
        trees::pin_many(cwd, session, &id, &snapshots)?;
    } else {
        // An old version or external cleanup may have removed the ref. Keep a
        // best-effort summary, but propagate uncertainty even if the diff works.
        turn.files = git::changes_between(cwd, &turn.start, Some(&end)).unwrap_or_default();
        turn.unavailable_reason
            .get_or_insert_with(|| "This checkpoint has expired under the workspace retention limit.".into());
    }
    turn.end = Some(end);
    turn.end_index = end_index;
    turn.ended_at = Some(chrono::Utc::now().timestamp_micros());
    remember_concurrent(session, tab, turn)?;
    Ok(())
}

/// Called by the one publication path, including CLI-originated and queued turns.
/// A provider's acknowledgement of an already-open prompt does not start a second checkpoint.
pub fn observe(session: &str, tab: &str, seq: u64, payload: &mut Payload) -> Result<Option<Completed>> {
    if !matches!(
        payload,
        Payload::UserMessage { queued: false, .. } | Payload::TurnStarted { .. } | Payload::TurnCompleted { .. }
    ) {
        return Ok(None);
    }
    locked(session, || {
        let entry = index::get(session)?;
        if !git::is_repo(Path::new(&entry.cwd)) {
            return Ok(None);
        }
        let cwd = root(&entry.cwd)?;
        let mut state = load(session, tab)?;
        state.repository = Some(
            git::run(Path::new(&cwd), &["rev-parse", "--path-format=absolute", "--git-common-dir"])?
                .trim()
                .into(),
        );
        let mut completed = None;
        let active = state.turns.last().filter(|t| t.end.is_none());
        let begin = match payload {
            Payload::UserMessage { queued: false, .. } => true,
            Payload::TurnStarted { prompt_seq, started_by, .. } => active.is_none() || prompt_seq.is_some() || started_by.is_some(),
            _ => false,
        };
        if begin {
            if let Some(turn) = state.turns.last_mut().filter(|t| t.end.is_none()) {
                finish(session, tab, turn)?;
            }
            // A prepared composer baseline can precede another tab's edits. Capture
            // here so the recorded interval covers precisely this checkout snapshot.
            let started_at = Some(chrono::Utc::now().timestamp_micros());
            let start = git::snapshot_tree(Path::new(&cwd))?;
            let index = index_tree(Path::new(&cwd)).ok();
            let id = format!("{tab}-{seq}");
            let mut snapshots = vec![("start", start.as_str())];
            if let Some(index) = &index {
                snapshots.push(("index", index));
            }
            trees::pin_many(Path::new(&cwd), session, &id, &snapshots)?;
            if let Payload::UserMessage { baseline, .. } = payload {
                *baseline = Some(start.clone());
            }
            state.turns.push(Checkpoint {
                seq,
                number: state.turns.len() + 1,
                cwd,
                start,
                index,
                end: None,
                end_index: None,
                reviewed: false,
                undone: false,
                files: Vec::new(),
                started_at,
                ended_at: None,
                concurrent_paths: BTreeSet::new(),
                concurrent_unknown: false,
                backup: None,
                restored: false,
                backup_ref: None,
                unavailable_reason: None,
            });
        } else if let Payload::TurnCompleted { head, .. } = payload {
            if let Some(turn) = state.turns.last_mut().filter(|t| t.end.is_none()) {
                finish(session, tab, turn)?;
                *head = turn.end.clone();
                if turn.unavailable_reason.is_none() {
                    completed = Some(Completed {
                        seq: turn.seq,
                        base: turn.start.clone(),
                        head: turn.end.clone().unwrap(),
                    });
                }
            }
        } else {
            return Ok(None);
        }
        save(session, tab, &state)?;
        Ok(completed)
    })
}

pub fn get(session: &str, tab: &str, seq: u64) -> Result<Option<Checkpoint>> {
    // Metadata is atomically replaced. Card reads must not wait behind Git snapshots.
    let mut turn = load(session, tab)?.turns.into_iter().find(|t| t.seq == seq && t.end.is_some());
    if let Some(turn) = &mut turn {
        let id = format!("{tab}-{seq}");
        if !trees::exists(Path::new(&turn.cwd), session, &id, "start")? || !trees::exists(Path::new(&turn.cwd), session, &id, "end")? {
            turn.unavailable_reason
                .get_or_insert_with(|| "This checkpoint has expired under the workspace retention limit.".into());
        }
        turn.backup_ref = if turn.undone
            && trees::exists(Path::new(&turn.cwd), session, &id, "before-undo")?
            && trees::exists(Path::new(&turn.cwd), session, &id, "before-undo-index")?
        {
            Some(trees::reference(session, &id, "before-undo")?)
        } else {
            None
        };
    }
    Ok(turn)
}

pub fn keep(session: &str, tab: &str, seq: u64) -> Result<()> {
    locked(session, || {
        let mut state = load(session, tab)?;
        let turn = state
            .turns
            .iter_mut()
            .find(|t| t.seq == seq && t.end.is_some())
            .ok_or_else(|| anyhow::anyhow!("Checkpoint unavailable"))?;
        turn.reviewed = true;
        save(session, tab, &state)
    })
}

fn in_workspace(candidate: &str, cwd: &str) -> bool {
    std::fs::canonicalize(candidate).is_ok_and(|p| p.starts_with(cwd)) && root(candidate).ok().as_deref() == Some(cwd)
}
fn idle(cwd: &str, allow_waiting: bool) -> Result<()> {
    for session in index::load()? {
        if session
            .tabs
            .iter()
            .any(|t| t.status == index::TabStatus::InProgress || (!allow_waiting && t.status == index::TabStatus::Waiting))
            && in_workspace(&session.cwd, cwd)
        {
            bail!("Wait for the agents in this workspace to finish before reverting files.");
        }
    }
    Ok(())
}
fn note(paths: &[String], number: Option<usize>) -> Note {
    let files = paths
        .iter()
        .map(|p| serde_json::to_string(p).unwrap_or_default())
        .collect::<Vec<_>>()
        .join(", ");
    let from = number.map(|n| format!(" from turn {n}")).unwrap_or_default();
    Note {
        id: uuid::Uuid::new_v4().to_string(),
        text: format!("The user reverted {files}{from}."),
    }
}

pub fn undo(session: &str, tab: &str, seq: u64, confirmed: Option<&str>) -> Result<UndoResult> {
    locked(session, || {
        let mut state = load(session, tab)?;
        let at = state
            .turns
            .iter()
            .position(|t| t.seq == seq && t.end.is_some())
            .ok_or_else(|| anyhow::anyhow!("Checkpoint unavailable"))?;
        let turn = &state.turns[at];
        if let Some(reason) = &turn.unavailable_reason {
            bail!(reason.clone());
        }
        if turn.reviewed {
            bail!("This turn has already been reviewed.");
        }
        if root(&index::get(session)?.cwd)? != turn.cwd {
            bail!("This checkpoint belongs to a workspace that is no longer attached.");
        }
        idle(&turn.cwd, false)?;
        let id = format!("{tab}-{seq}");
        if !trees::exists(Path::new(&turn.cwd), session, &id, "start")? || !trees::exists(Path::new(&turn.cwd), session, &id, "end")? {
            bail!("This checkpoint has expired under the workspace retention limit.");
        }
        let cwd = Path::new(&turn.cwd);
        let start_index = turn.index.as_deref().ok_or_else(|| {
            anyhow::anyhow!(
                "This turn started with unresolved Git conflicts. Its checkpoint is retained, but automatic Undo cannot restore the conflicted index."
            )
        })?;
        let paths = trees::paths(cwd, &turn.start, turn.end.as_deref().unwrap())?;
        let now = trees::current(cwd, &paths)?;
        let now_index = index_tree(cwd)?;
        let token = format!("{now}:{now_index}");
        let mut changed = trees::paths(cwd, turn.end.as_deref().unwrap(), &now)?;
        changed.extend(trees::paths(cwd, turn.end_index.as_deref().unwrap_or(start_index), &now_index)?);
        changed.extend(turn.concurrent_paths.iter().cloned());
        if turn.concurrent_unknown {
            changed.extend(paths.iter().cloned());
        }
        for later in &state.turns[at + 1..] {
            changed.extend(file_paths(later));
            if uncertain(session, tab, later)? {
                changed.extend(paths.iter().cloned());
            }
        }
        // Whole-checkout snapshots include other agents' work already present at end.
        // Include every conversation in this checkout, including closed tabs and turns
        // spanning either boundary. Unknown legacy timestamps are treated conservatively.
        for (owner, peer_tab, peer_state) in workspace_states(&turn.cwd)? {
            if owner == session && peer_tab == tab {
                continue;
            }
            for peer in peer_state.turns.iter().filter(|peer| peer.cwd == turn.cwd && not_before(peer, turn)) {
                changed.extend(file_paths(peer));
                if uncertain(&owner, &peer_tab, peer)? {
                    changed.extend(paths.iter().cloned());
                }
            }
        }
        let overlap: Vec<_> = paths.iter().filter(|p| changed.contains(p)).cloned().collect();
        if !overlap.is_empty() && confirmed != Some(token.as_str()) {
            return Ok(UndoResult {
                overlap,
                token,
                undone: false,
                backup_ref: None,
            });
        }
        // Retain the current contents too, so an I/O error never makes them unreachable.
        let id = format!("{tab}-{seq}");
        trees::pin_many(cwd, session, &id, &[("before-undo", &now), ("before-undo-index", &now_index)])?;
        trees::restore_with_backup(cwd, &turn.start, start_index, &paths, &now, &now_index)?;
        let number = turn.number;
        let revert_note = note(&paths, Some(number));
        let backup_ref = trees::reference(session, &id, "before-undo")?;
        state.turns[at].reviewed = true;
        state.turns[at].undone = true;
        state.turns[at].backup = Some(Backup {
            tree: now,
            index: now_index,
            note_id: revert_note.id.clone(),
        });
        state.turns[at].backup_ref = Some(backup_ref.clone());
        state.notes.push(revert_note);
        save(session, tab, &state)?;
        Ok(UndoResult {
            overlap: Vec::new(),
            token,
            undone: true,
            backup_ref: Some(backup_ref),
        })
    })
}

/// Discard from the displayed base (HEAD for Uncommitted). Notify each conversation
/// that edited the file; a file with no turn provenance is described without inventing one.
pub fn discard(cwd: &str, path: &str, base: Option<&str>, old_path: Option<&str>) -> Result<()> {
    workspace_locked(cwd, || {
        let cwd = root(cwd)?;
        idle(&cwd, true)?;
        let p = Path::new(&cwd);
        let base = base.map(String::from).map(Ok).unwrap_or_else(|| git::head_tree(p))?;
        let paths: Vec<_> = std::iter::once(path.to_string()).chain(old_path.map(String::from)).collect();
        let before = trees::current(p, &paths)?;
        let before_index = index_tree(p)?;
        // Read all affected metadata before modifying files, so unreadable state fails safely.
        let mut affected = Vec::new();
        let mut backup_owner = None;
        for session in index::load()? {
            if !in_workspace(&session.cwd, &cwd) {
                continue;
            }
            backup_owner.get_or_insert_with(|| session.id.clone());
            for tab in &session.tabs {
                let state = load(&session.id, &tab.id)?;
                let mut number = None;
                for turn in state.turns.iter().rev().filter(|t| t.cwd == cwd) {
                    let changed = if turn.end.is_none() && trees::exists(p, &session.id, &format!("{}-{}", tab.id, turn.seq), "start")? {
                        // Waiting turns have not populated their final file list yet.
                        trees::paths(p, &turn.start, &before)?.into_iter().collect()
                    } else {
                        file_paths(turn)
                    };
                    if paths.iter().any(|path| changed.contains(path)) {
                        number = Some(turn.number);
                        break;
                    }
                }
                if number.is_some() {
                    affected.push((session.id.clone(), tab.id.clone(), state, number));
                }
            }
        }
        if let Some(session) = &backup_owner {
            // One bounded recovery slot, rather than an unbounded ref pair per discard.
            let id = "discard-backup";
            trees::pin_many(p, session, id, &[("start", &before), ("index", &before_index)])?;
        }
        trees::restore_with_backup(p, &base, &base, &paths, &before, &before_index)?;
        if let Some(session) = &backup_owner {
            trees::prune_turn(p, session, "discard-backup")?;
        }
        for (session, tab, mut state, number) in affected {
            state.notes.push(note(&paths, number));
            save(&session, &tab, &state)?;
        }
        Ok(())
    })
}

/// Restore only the paths Undo replaced, retaining the same overlap protection.
pub fn restore_undo(session: &str, tab: &str, seq: u64, confirmed: Option<&str>) -> Result<UndoResult> {
    locked(session, || {
        let mut state = load(session, tab)?;
        let at = state
            .turns
            .iter()
            .position(|t| t.seq == seq)
            .ok_or_else(|| anyhow::anyhow!("Checkpoint unavailable"))?;
        let turn = &state.turns[at];
        if !turn.undone {
            bail!("This turn has not been undone.");
        }
        let id = format!("{tab}-{seq}");
        if !trees::exists(Path::new(&turn.cwd), session, &id, "before-undo")? || !trees::exists(Path::new(&turn.cwd), session, &id, "before-undo-index")? {
            bail!("The Undo backup has expired under the workspace retention limit.");
        }
        let backup = match turn.backup.clone() {
            Some(backup) => backup,
            None => {
                let expected = note(&file_paths(turn).into_iter().collect::<Vec<_>>(), Some(turn.number)).text;
                Backup {
                    tree: git::run(Path::new(&turn.cwd), &["rev-parse", &trees::reference(session, &id, "before-undo")?])?
                        .trim()
                        .into(),
                    index: git::run(Path::new(&turn.cwd), &["rev-parse", &trees::reference(session, &id, "before-undo-index")?])?
                        .trim()
                        .into(),
                    note_id: state.notes.iter().find(|n| n.text == expected).map(|n| n.id.clone()).unwrap_or_default(),
                }
            }
        };
        if root(&index::get(session)?.cwd)? != turn.cwd {
            bail!("This checkpoint belongs to another workspace.");
        }
        idle(&turn.cwd, false)?;
        let cwd = Path::new(&turn.cwd);
        let paths: Vec<_> = file_paths(turn).into_iter().collect();
        let index = turn.index.as_deref().ok_or_else(|| anyhow::anyhow!("The original index is unavailable."))?;
        let now = trees::current(cwd, &paths)?;
        let now_index = index_tree(cwd)?;
        let token = format!("restore:{now}:{now_index}");
        let mut changed = trees::paths(cwd, &turn.start, &now)?;
        changed.extend(trees::paths(cwd, index, &now_index)?);
        let overlap: Vec<_> = paths.iter().filter(|p| changed.contains(p)).cloned().collect();
        if !overlap.is_empty() && confirmed != Some(token.as_str()) {
            return Ok(UndoResult {
                overlap,
                token,
                undone: false,
                backup_ref: None,
            });
        }
        trees::pin_many(cwd, session, &id, &[("before-restore", &now), ("before-restore-index", &now_index)])?;
        trees::restore_with_backup(cwd, &backup.tree, &backup.index, &paths, &now, &now_index)?;
        let number = turn.number;
        state.turns[at].undone = false;
        state.turns[at].restored = true;
        state.turns[at].backup_ref = None;
        let pending = state.notes.iter().any(|n| n.id == backup.note_id);
        state.notes.retain(|n| n.id != backup.note_id);
        for notes in state.sent_notes.values_mut() {
            notes.retain(|n| n.id != backup.note_id);
        }
        if !pending {
            let mut restored = note(&paths, Some(number));
            restored.text = restored.text.replacen("The user reverted", "The user restored the files Undo removed:", 1);
            state.notes.push(restored);
        }
        save(session, tab, &state)?;
        Ok(UndoResult {
            overlap: Vec::new(),
            token,
            undone: true,
            backup_ref: None,
        })
    })
}

/// The files a chat reset replaced, kept for that reset's one level of Undo.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetBackup {
    /// The reset's backup id (the tab's `resetBackupId`).
    generation: String,
    cwd: String,
    paths: Vec<String>,
    /// The files and staging before the reset, pinned as `before-reset`.
    tree: String,
    index: String,
    /// What the reset wrote, so Undo can tell later edits apart.
    restored_tree: String,
    restored_index: String,
}

/// What restoring files for a chat reset (or its Undo) will change. Read-only.
pub struct ResetPlan {
    pub cwd: String,
    pub paths: Vec<String>,
    /// Paths that something other than this chat's later turns changed:
    /// other tabs or sessions in the checkout, or edits by hand.
    pub overlap: Vec<String>,
    token: String,
    tree: String,
    index: String,
    undo: bool,
}

/// A completed file restore, so a failed conversation commit can put the files back.
pub struct ResetApplied {
    cwd: String,
    pub paths: Vec<String>,
    tree: String,
    index: String,
    before: String,
    before_index: String,
    previous: Option<ResetBackup>,
}

fn reset_group(tab: &str) -> String {
    format!("{tab}-reset")
}

/// The Git working tree a session's checkpoints are taken in.
pub fn workspace_root(cwd: &str) -> Result<String> {
    root(cwd)
}

/// A peer turn that ran or ended after `turn` ended: its edits are not in `turn`'s end tree.
fn after_end(peer: &Checkpoint, turn: &Checkpoint) -> bool {
    match (peer.end.as_ref().and(peer.ended_at), turn.ended_at) {
        (Some(peer_end), Some(end)) => peer_end >= end,
        _ => true,
    }
}

/// Plan putting the checkout back to the END of the turn a chat reset cuts at
/// (the last checkpoint that starts at or before `end_seq`).
pub fn plan_reset(session: &str, tab: &str, end_seq: u64) -> Result<ResetPlan> {
    locked(session, || {
        let entry_cwd = index::get(session)?.cwd;
        if !git::is_repo(Path::new(&entry_cwd)) {
            bail!("Files can't be reset: this chat's folder is not a Git repository. Nothing was reset.");
        }
        let state = load(session, tab)?;
        let missing = "This turn has no saved file checkpoint. Reset the chat without files.";
        let at = state.turns.iter().rposition(|t| t.seq <= end_seq).ok_or_else(|| anyhow::anyhow!(missing))?;
        let turn = &state.turns[at];
        let Some(end) = turn.end.clone() else { bail!(missing) };
        if let Some(reason) = &turn.unavailable_reason {
            bail!("{reason} Reset the chat without files.");
        }
        if root(&entry_cwd)? != turn.cwd {
            bail!("This checkpoint belongs to a workspace that is no longer attached.");
        }
        idle(&turn.cwd, false)?;
        let cwd = Path::new(&turn.cwd);
        if !trees::exists(cwd, session, &format!("{tab}-{}", turn.seq), "end")? {
            bail!("This checkpoint has expired under the workspace retention limit. Reset the chat without files.");
        }
        let end_index = turn.end_index.clone().ok_or_else(|| {
            anyhow::anyhow!("This turn ended with unresolved Git conflicts, so its files can't be reset automatically. Reset the chat without files.")
        })?;
        let snapshot = git::snapshot_tree(cwd)?;
        let now_index = index_tree(cwd)?;
        let mut paths: BTreeSet<String> = trees::paths(cwd, &end, &snapshot)?.into_iter().collect();
        paths.extend(trees::paths(cwd, &end_index, &now_index)?);
        let paths: Vec<String> = paths.into_iter().collect();
        let now = trees::current(cwd, &paths)?;
        // This chat's later turns account for their own files. Everything else
        // (other conversations in the checkout, edits by hand) needs confirmation.
        let mut own = BTreeSet::new();
        let mut others = BTreeSet::new();
        let mut unknown = false;
        for later in &state.turns[at + 1..] {
            own.extend(file_paths(later));
            others.extend(later.concurrent_paths.iter().cloned());
            unknown |= later.concurrent_unknown || uncertain(session, tab, later)?;
        }
        for (owner, peer_tab, peer_state) in workspace_states(&turn.cwd)? {
            if owner == session && peer_tab == tab {
                continue;
            }
            for peer in peer_state.turns.iter().filter(|peer| peer.cwd == turn.cwd && after_end(peer, turn)) {
                others.extend(file_paths(peer));
                unknown |= uncertain(&owner, &peer_tab, peer)?;
            }
        }
        let overlap = paths.iter().filter(|p| unknown || others.contains(*p) || !own.contains(*p)).cloned().collect();
        Ok(ResetPlan {
            cwd: turn.cwd.clone(),
            token: format!("reset:{end}:{end_index}:{now}:{now_index}"),
            paths,
            overlap,
            tree: end,
            index: end_index,
            undo: false,
        })
    })
}

/// Whether the reset `generation` restored files, so its Undo puts them back.
pub fn reset_has_files(session: &str, tab: &str, generation: &str) -> bool {
    load(session, tab).is_ok_and(|state| state.reset.is_some_and(|backup| backup.generation == generation))
}

/// Plan restoring the files the reset `generation` replaced. None when that
/// reset left the files alone.
pub fn plan_reset_undo(session: &str, tab: &str, generation: &str) -> Result<Option<ResetPlan>> {
    locked(session, || {
        let Some(backup) = load(session, tab)?.reset.filter(|backup| backup.generation == generation) else {
            return Ok(None);
        };
        if root(&index::get(session)?.cwd)? != backup.cwd {
            bail!("The files saved before the reset belong to a workspace that is no longer attached.");
        }
        idle(&backup.cwd, false)?;
        let cwd = Path::new(&backup.cwd);
        let group = reset_group(tab);
        if !trees::exists(cwd, session, &group, "before-reset")? || !trees::exists(cwd, session, &group, "before-reset-index")? {
            bail!("The files saved before the reset have expired under the workspace retention limit. Nothing was undone.");
        }
        let now = trees::current(cwd, &backup.paths)?;
        let now_index = index_tree(cwd)?;
        let mut changed: BTreeSet<String> = trees::paths(cwd, &backup.restored_tree, &now)?.into_iter().collect();
        changed.extend(trees::paths(cwd, &backup.restored_index, &now_index)?);
        let overlap = backup.paths.iter().filter(|p| changed.contains(*p)).cloned().collect();
        Ok(Some(ResetPlan {
            token: format!("undo-reset:{}:{}:{now}:{now_index}", backup.tree, backup.index),
            cwd: backup.cwd,
            paths: backup.paths,
            overlap,
            tree: backup.tree,
            index: backup.index,
            undo: true,
        }))
    })
}

type Confirmations = Mutex<std::collections::HashMap<String, String>>;
static RESET_CONFIRMATIONS: std::sync::LazyLock<Confirmations> = std::sync::LazyLock::new(Mutex::default);

/// A reset that overlaps other changes is refused once with the list; asking
/// again for exactly the same plan, with nothing changed since, confirms it.
pub fn confirm_overlap(session: &str, tab: &str, plan: &ResetPlan) -> bool {
    if plan.overlap.is_empty() {
        return true;
    }
    let key = format!("{session}/{tab}");
    let mut shown = RESET_CONFIRMATIONS.lock().unwrap_or_else(|error| error.into_inner());
    if shown.get(&key) == Some(&plan.token) {
        shown.remove(&key);
        true
    } else {
        shown.insert(key, plan.token.clone());
        false
    }
}

/// Write the planned files and staging, keeping what they replace for Undo.
/// Refuses if anything in the checkout changed since the plan was made.
pub fn apply_reset(session: &str, tab: &str, plan: &ResetPlan, generation: &str) -> Result<ResetApplied> {
    locked(session, || {
        let cwd = Path::new(&plan.cwd);
        let now = trees::current(cwd, &plan.paths)?;
        let now_index = index_tree(cwd)?;
        if !plan.token.ends_with(&format!(":{now}:{now_index}")) {
            bail!("Files changed during reset. Nothing was reset; try again.");
        }
        let mut state = load(session, tab)?;
        let previous = state.reset.clone();
        let edges = if plan.undo { ["before-undo", "before-undo-index"] } else { ["before-reset", "before-reset-index"] };
        // Retain the current contents first, so an I/O error never makes them unreachable.
        trees::pin_many(cwd, session, &reset_group(tab), &[(edges[0], &now), (edges[1], &now_index)])?;
        trees::restore_with_backup(cwd, &plan.tree, &plan.index, &plan.paths, &now, &now_index)?;
        state.reset = (!plan.undo).then(|| ResetBackup {
            generation: generation.into(),
            cwd: plan.cwd.clone(),
            paths: plan.paths.clone(),
            tree: now.clone(),
            index: now_index.clone(),
            restored_tree: plan.tree.clone(),
            restored_index: plan.index.clone(),
        });
        let applied = ResetApplied {
            cwd: plan.cwd.clone(),
            paths: plan.paths.clone(),
            tree: plan.tree.clone(),
            index: plan.index.clone(),
            before: now,
            before_index: now_index,
            previous,
        };
        if let Err(error) = save(session, tab, &state) {
            trees::restore_with_backup(cwd, &applied.before, &applied.before_index, &applied.paths, &applied.tree, &applied.index)?;
            return Err(error);
        }
        Ok(applied)
    })
}

/// Put back the files `apply_reset` replaced, when the chat itself could not be reset.
pub fn revert_reset(session: &str, tab: &str, applied: &ResetApplied) -> Result<()> {
    locked(session, || {
        let cwd = Path::new(&applied.cwd);
        trees::restore_with_backup(cwd, &applied.before, &applied.before_index, &applied.paths, &applied.tree, &applied.index)?;
        let mut state = load(session, tab)?;
        state.reset = applied.previous.clone();
        save(session, tab, &state)
    })
}

/// Keep retry context outside the user's visible message.
pub fn acknowledge_sent(session: &str, tab: &str, seq: u64, notes: &[Note]) -> Result<()> {
    if notes.is_empty() {
        return Ok(());
    }
    locked(session, || {
        let mut state = load(session, tab)?;
        state.sent_notes.insert(seq, notes.to_vec());
        while state.sent_notes.len() > 50 {
            state.sent_notes.pop_first();
        }
        state.notes.retain(|n| !notes.iter().any(|sent| sent.id == n.id));
        save(session, tab, &state)
    })
}

pub fn sent_context(session: &str, tab: &str, seq: u64) -> Result<String> {
    Ok(load(session, tab)?.sent_notes.get(&seq).map(|notes| context(notes)).unwrap_or_default())
}
pub fn requeue_sent(session: &str, tab: &str, seq: u64) -> Result<()> {
    locked(session, || {
        let mut state = load(session, tab)?;
        for note in state.sent_notes.get(&seq).cloned().unwrap_or_default() {
            if !state.notes.iter().any(|n| n.id == note.id) {
                state.notes.push(note);
            }
        }
        save(session, tab, &state)
    })
}

pub fn pending(session: &str, tab: &str) -> Result<Vec<Note>> {
    locked(session, || Ok(load(session, tab)?.notes))
}
pub fn context(notes: &[Note]) -> String {
    notes.iter().map(|n| n.text.as_str()).collect::<Vec<_>>().join("\n")
}
pub fn acknowledge(session: &str, tab: &str, notes: &[Note]) -> Result<()> {
    locked(session, || {
        if notes.is_empty() {
            return Ok(());
        }
        let mut state = load(session, tab)?;
        state.notes.retain(|n| !notes.iter().any(|sent| sent.id == n.id));
        save(session, tab, &state)
    })
}

pub fn prune(session: &index::SessionEntry) -> Result<()> {
    workspace_locked(&session.cwd, || {
        // Git stores these refs in the common directory, which outlives a removed worktree.
        // Keep its location even for quick chats, which have no project_path fallback.
        let mut repositories = std::collections::BTreeSet::new();
        let mut metadata = Vec::new();
        // Closed tabs can still own refs. Their metadata goes with the workspace too.
        trees::reference(&session.id, "validate", "start")?;
        let entries = match std::fs::read_dir(store::root()?.join("sessions").join(&session.id)) {
            Ok(entries) => Some(entries),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        for entry in entries.into_iter().flatten() {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(tab) = name.strip_prefix("checkpoints-").and_then(|name| name.strip_suffix(".json")) else {
                continue;
            };
            let mut state: State = serde_json::from_slice(&std::fs::read(entry.path())?)?;
            // Deleting a conversation can remove a running checkpoint without a
            // TurnCompleted event. Preserve that uncertainty before its evidence goes.
            for turn in state.turns.iter_mut().filter(|turn| turn.end.is_none()) {
                remember_concurrent(&session.id, tab, turn)?;
            }
            if let Some(repository) = state.repository {
                repositories.insert(repository);
            }
            metadata.push(entry.path());
        }
        for cwd in [&session.cwd, &session.project_path] {
            if let Ok(common) = git::run(Path::new(cwd), &["rev-parse", "--path-format=absolute", "--git-common-dir"]) {
                repositories.insert(common.trim().into());
            }
        }
        for repository in repositories {
            if Path::new(&repository).exists() {
                trees::prune(Path::new(&repository), &session.id)?;
            }
        }
        for path in metadata {
            match std::fs::remove_file(path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
        Ok(())
    })
}

#[cfg(test)]
#[path = "checkpoints_tests.rs"]
mod reset_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::TurnStatus;

    pub(super) fn fixture() -> (tempfile::TempDir, index::SessionEntry) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        git::run(p, &["init", "-q", "-b", "main"]).unwrap();
        git::run(p, &["config", "user.email", "test@example.com"]).unwrap();
        git::run(p, &["config", "user.name", "Test"]).unwrap();
        std::fs::write(p.join("a.txt"), "initial\n").unwrap();
        git::run(p, &["add", "."]).unwrap();
        git::run(p, &["commit", "-qm", "Initial"]).unwrap();
        let session = crate::session_ops::create_quick_chat_entry(crate::session_ops::NewQuickChat {
            cwd: Some(p.to_str().unwrap().into()),
            tab: Some(crate::session_ops::NewTab {
                transport: Default::default(),
                harness: "claude".into(),
                model: String::new(),
                effort: None,
                permission_mode: None,
            }),
            ..Default::default()
        })
        .unwrap();
        (dir, session)
    }
    pub(super) fn prompt(queued: bool) -> Payload {
        Payload::UserMessage {
            author: None,
            text: "Change it".into(),
            images: vec![],
            baseline: None,
            queued,
            cwd: None,
        }
    }
    fn started(prompt_seq: Option<u64>, auto: bool) -> Payload {
        Payload::TurnStarted {
            model: None,
            provider_session_id: None,
            prompt_seq,
            started_by: auto.then(|| "Scheduled task".into()),
            initiating_prompt: None,
        }
    }
    pub(super) fn done() -> Payload {
        Payload::TurnCompleted {
            status: TurnStatus::Ok,
            final_text: None,
            usage: None,
            duration_ms: None,
            head: None,
            auth_failed: false,
            detail: None,
        }
    }
    fn observe_at(session: &index::SessionEntry, seq: u64, mut event: Payload) {
        observe(&session.id, &session.tabs[0].id, seq, &mut event).unwrap();
    }

    #[test]
    fn captures_composer_queued_and_cli_started_turns_and_prunes_refs() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let tab = &session.tabs[0].id;
        observe_at(&session, 1, prompt(false));
        observe_at(&session, 2, started(None, false)); // provider acknowledgement
        std::fs::write(repo.path().join("a.txt"), "first\n").unwrap();
        observe_at(&session, 3, prompt(true));
        observe_at(&session, 4, done());
        observe_at(&session, 5, started(Some(3), false));
        std::fs::write(repo.path().join("a.txt"), "queued\n").unwrap();
        observe_at(&session, 6, done());
        observe_at(&session, 7, started(None, true));
        std::fs::write(repo.path().join("new.txt"), "autonomous\n").unwrap();
        observe_at(&session, 8, done());
        let state = load(&session.id, tab).unwrap();
        assert_eq!(state.turns.iter().map(|t| t.seq).collect::<Vec<_>>(), vec![1, 5, 7]);
        assert_eq!(state.turns[2].number, 3);
        git::run(repo.path(), &["gc", "--prune=now"]).unwrap();
        for turn in &state.turns {
            for (edge, tree) in [("start", &turn.start), ("end", turn.end.as_ref().unwrap())] {
                let name = trees::reference(&session.id, &format!("{tab}-{}", turn.seq), edge).unwrap();
                assert_eq!(git::run(repo.path(), &["rev-parse", &name]).unwrap().trim(), tree);
                git::run(repo.path(), &["cat-file", "-e", tree]).unwrap();
            }
        }
        prune(&session).unwrap();
        assert!(git::run(repo.path(), &["for-each-ref", "refs/raccoon-checkpoints"]).unwrap().is_empty());
        assert!(get(&session.id, tab, 1).unwrap().is_none());
    }

    #[test]
    fn latest_undo_is_exact_and_notes_survive_reload_and_are_acknowledged_once() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let tab = &session.tabs[0].id;
        observe_at(&session, 1, prompt(false));
        std::fs::write(repo.path().join("a.txt"), "changed\n").unwrap();
        observe_at(&session, 2, done());
        assert!(undo(&session.id, tab, 1, None).unwrap().undone);
        assert_eq!(std::fs::read_to_string(repo.path().join("a.txt")).unwrap(), "initial\n");
        assert!(get(&session.id, tab, 1).unwrap().unwrap().reviewed);
        let notes = pending(&session.id, tab).unwrap();
        assert_eq!(context(&notes), "The user reverted \"a.txt\" from turn 1.");
        assert_eq!(
            pending(&session.id, tab).unwrap().len(),
            1,
            "reading does not consume context on failed admission"
        );
        acknowledge(&session.id, tab, &notes).unwrap();
        acknowledge(&session.id, tab, &notes).unwrap();
        assert!(pending(&session.id, tab).unwrap().is_empty());
    }

    #[test]
    fn overlap_never_changes_files_until_confirmed_and_a_stale_confirmation_is_refused() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let tab = &session.tabs[0].id;
        observe_at(&session, 1, prompt(false));
        std::fs::write(repo.path().join("a.txt"), "first\n").unwrap();
        observe_at(&session, 2, done());
        observe_at(&session, 3, started(None, true));
        std::fs::write(repo.path().join("a.txt"), "later\n").unwrap();
        observe_at(&session, 4, done());
        let preview = undo(&session.id, tab, 1, None).unwrap();
        assert_eq!(preview.overlap, vec!["a.txt"]);
        assert!(!preview.undone);
        assert_eq!(std::fs::read_to_string(repo.path().join("a.txt")).unwrap(), "later\n");
        assert!(pending(&session.id, tab).unwrap().is_empty());
        std::fs::write(repo.path().join("a.txt"), "user edit\n").unwrap();
        let stale = undo(&session.id, tab, 1, Some(&preview.token)).unwrap();
        assert!(!stale.undone);
        assert!(undo(&session.id, tab, 1, Some(&stale.token)).unwrap().undone);
        assert_eq!(std::fs::read_to_string(repo.path().join("a.txt")).unwrap(), "initial\n");
    }

    #[test]
    fn keep_is_durable_and_discard_queues_provenance_without_consuming_other_notes() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let tab = &session.tabs[0].id;
        observe_at(&session, 1, prompt(false));
        std::fs::write(repo.path().join("a.txt"), "first\n").unwrap();
        observe_at(&session, 2, done());
        keep(&session.id, tab, 1).unwrap();
        assert!(get(&session.id, tab, 1).unwrap().unwrap().reviewed);
        assert!(undo(&session.id, tab, 1, None).is_err());
        discard(repo.path().to_str().unwrap(), "a.txt", None, None).unwrap();
        let first = pending(&session.id, tab).unwrap();
        assert!(context(&first).contains("from turn 1"));
        std::fs::write(repo.path().join("new.txt"), "user\n").unwrap();
        discard(repo.path().to_str().unwrap(), "new.txt", None, None).unwrap();
        assert!(!repo.path().join("new.txt").exists());
        acknowledge(&session.id, tab, &first).unwrap();
        assert!(pending(&session.id, tab).unwrap().is_empty(), "a user-created file has no agent provenance");
    }
    #[test]
    fn ignored_files_still_trigger_overlap_when_the_user_recreates_them() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let p = repo.path();
        let tab = &session.tabs[0].id;
        std::fs::write(p.join("before.txt"), "before\n").unwrap();
        observe_at(&session, 1, prompt(false));
        std::fs::remove_file(p.join("before.txt")).unwrap();
        std::fs::write(p.join(".gitignore"), "before.txt\n").unwrap();
        observe_at(&session, 2, done());
        std::fs::write(p.join("before.txt"), "user recreated\n").unwrap();
        let preview = undo(&session.id, tab, 1, None).unwrap();
        assert!(!preview.undone);
        assert!(preview.overlap.contains(&"before.txt".to_string()));
        assert_eq!(std::fs::read_to_string(p.join("before.txt")).unwrap(), "user recreated\n");
    }

    #[test]
    fn pruning_a_removed_worktree_uses_the_saved_common_git_directory() {
        let _home = store::temp_home();
        let (repo, mut session) = fixture();
        let worktrees = tempfile::tempdir().unwrap();
        let wt = worktrees.path().join("work");
        git::run(repo.path(), &["worktree", "add", "-q", "-b", "work", wt.to_str().unwrap()]).unwrap();
        session.cwd = wt.to_str().unwrap().to_string();
        index::update(|entries| {
            entries.iter_mut().find(|e| e.id == session.id).unwrap().cwd = session.cwd.clone();
            Ok(())
        })
        .unwrap();
        observe_at(&session, 1, prompt(false));
        observe_at(&session, 2, done());
        git::run(repo.path(), &["worktree", "remove", wt.to_str().unwrap()]).unwrap();
        prune(&session).unwrap();
        assert!(git::run(repo.path(), &["for-each-ref", "refs/raccoon-checkpoints"]).unwrap().is_empty());
    }
    pub(super) fn second_tab(session: &index::SessionEntry, other_session: bool) -> index::SessionEntry {
        let tab = crate::session_ops::NewTab {
            transport: Default::default(),
            harness: "claude".into(),
            model: String::new(),
            effort: None,
            permission_mode: None,
        };
        if other_session {
            crate::session_ops::create_quick_chat_entry(crate::session_ops::NewQuickChat {
                cwd: Some(session.cwd.clone()),
                tab: Some(tab),
                ..Default::default()
            })
            .unwrap()
        } else {
            let added = crate::session_ops::add_tab_entry(&session.id, &tab).unwrap();
            let mut peer = session.clone();
            peer.tabs = vec![added];
            peer
        }
    }

    #[test]
    fn concurrent_sibling_and_other_session_edits_need_confirmation_and_can_be_recovered() {
        let _home = store::temp_home();
        for other_session in [false, true] {
            let (repo, session) = fixture();
            let peer = second_tab(&session, other_session);
            let tab = &session.tabs[0].id;
            observe_at(&session, 1, prompt(false));
            std::fs::write(repo.path().join("a.txt"), "first agent\n").unwrap();
            observe_at(&peer, 1, prompt(false));
            std::fs::write(repo.path().join("b.txt"), "second agent\n").unwrap();
            observe_at(&peer, 2, done());
            // Even removing the other conversation before the first finishes must
            // not erase evidence that its work was included in the first snapshot.
            if other_session {
                crate::session_ops::remove_session_entries(std::slice::from_ref(&peer)).unwrap();
            }
            observe_at(&session, 2, done());
            let preview = undo(&session.id, tab, 1, None).unwrap();
            assert!(!preview.undone);
            assert!(preview.overlap.contains(&"b.txt".into()), "{other_session}");
            assert_eq!(std::fs::read_to_string(repo.path().join("b.txt")).unwrap(), "second agent\n");
            assert!(pending(&session.id, tab).unwrap().is_empty());
            let undone = undo(&session.id, tab, 1, Some(&preview.token)).unwrap();
            assert!(undone.undone);
            assert!(get(&session.id, tab, 1).unwrap().unwrap().backup_ref.is_some());
            assert!(!repo.path().join("b.txt").exists());
            assert!(restore_undo(&session.id, tab, 1, None).unwrap().undone);
            assert_eq!(std::fs::read_to_string(repo.path().join("b.txt")).unwrap(), "second agent\n");
            assert_eq!(std::fs::read_to_string(repo.path().join("a.txt")).unwrap(), "first agent\n");
            assert!(pending(&session.id, tab).unwrap().is_empty(), "an unsent revert note is cancelled by recovery");
        }
    }

    #[test]
    fn peer_turn_spanning_both_boundaries_is_reported_but_earlier_turns_are_not() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let peer = second_tab(&session, true);
        let tab = &session.tabs[0].id;
        observe_at(&peer, 1, prompt(false));
        std::fs::write(repo.path().join("a.txt"), "earlier\n").unwrap();
        observe_at(&peer, 2, done());
        observe_at(&session, 1, prompt(false));
        std::fs::write(repo.path().join("a.txt"), "first\n").unwrap();
        observe_at(&session, 2, done());
        assert!(undo(&session.id, tab, 1, None).unwrap().undone, "an earlier nonoverlapping peer is harmless");
        observe_at(&peer, 3, prompt(false));
        observe_at(&session, 3, prompt(false));
        std::fs::write(repo.path().join("b.txt"), "peer work\n").unwrap();
        observe_at(&session, 4, done());
        observe_at(&peer, 4, done());
        let preview = undo(&session.id, tab, 3, None).unwrap();
        assert!(!preview.undone);
        assert!(preview.overlap.contains(&"b.txt".into()));
    }

    #[test]
    fn backup_recovery_rechecks_newer_edits_and_stale_confirmations() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let tab = &session.tabs[0].id;
        observe_at(&session, 1, prompt(false));
        std::fs::write(repo.path().join("a.txt"), "staged agent\n").unwrap();
        git::run(repo.path(), &["add", "a.txt"]).unwrap();
        std::fs::write(repo.path().join("a.txt"), "agent\n").unwrap();
        observe_at(&session, 2, done());
        undo(&session.id, tab, 1, None).unwrap();
        // Existing Undo backups from before backup metadata was introduced remain recoverable.
        let mut state = load(&session.id, tab).unwrap();
        state.turns[0].backup = None;
        save(&session.id, tab, &state).unwrap();
        std::fs::write(repo.path().join("a.txt"), "later user\n").unwrap();
        let preview = restore_undo(&session.id, tab, 1, None).unwrap();
        assert!(!preview.undone);
        std::fs::write(repo.path().join("a.txt"), "newest user\n").unwrap();
        let stale = restore_undo(&session.id, tab, 1, Some(&preview.token)).unwrap();
        assert!(!stale.undone);
        assert_eq!(std::fs::read_to_string(repo.path().join("a.txt")).unwrap(), "newest user\n");
        assert!(restore_undo(&session.id, tab, 1, Some(&stale.token)).unwrap().undone);
        assert_eq!(std::fs::read_to_string(repo.path().join("a.txt")).unwrap(), "agent\n");
        assert_eq!(git::run(repo.path(), &["show", ":a.txt"]).unwrap(), "staged agent\n");
    }

    #[test]
    fn discard_allows_waiting_agents_and_only_notifies_conversations_with_provenance() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let peer = second_tab(&session, false);
        let tab = &session.tabs[0].id;
        observe_at(&session, 1, prompt(false));
        std::fs::write(repo.path().join("a.txt"), "agent\n").unwrap();
        observe_at(&session, 2, done());
        index::update_tab(&session.id, &peer.tabs[0].id, |t| {
            t.status = index::TabStatus::Waiting;
            Ok(())
        })
        .unwrap();
        discard(repo.path().to_str().unwrap(), "a.txt", None, None).unwrap();
        assert_eq!(pending(&session.id, tab).unwrap().len(), 1);
        assert!(pending(&peer.id, &peer.tabs[0].id).unwrap().is_empty());
        let notes = pending(&session.id, tab).unwrap();
        acknowledge_sent(&session.id, tab, 3, &notes).unwrap();
        assert!(pending(&session.id, tab).unwrap().is_empty());
        assert!(sent_context(&session.id, tab, 3).unwrap().contains("from turn 1"));
        requeue_sent(&session.id, tab, 3).unwrap();
        requeue_sent(&session.id, tab, 3).unwrap();
        assert_eq!(pending(&session.id, tab).unwrap().len(), 1);
    }

    #[test]
    fn discard_attributes_edits_from_an_unfinished_waiting_turn() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let tab = &session.tabs[0].id;
        observe_at(&session, 1, prompt(false));
        std::fs::write(repo.path().join("a.txt"), "agent\n").unwrap();
        index::update_tab(&session.id, tab, |t| {
            t.status = index::TabStatus::Waiting;
            Ok(())
        })
        .unwrap();
        discard(repo.path().to_str().unwrap(), "a.txt", None, None).unwrap();
        assert_eq!(std::fs::read_to_string(repo.path().join("a.txt")).unwrap(), "initial\n");
        assert!(context(&pending(&session.id, tab).unwrap()).contains("from turn 1"));
    }

    #[test]
    fn restoring_a_delivered_undo_note_queues_a_correction_and_removes_stale_retry_context() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let tab = &session.tabs[0].id;
        observe_at(&session, 1, prompt(false));
        std::fs::write(repo.path().join("a.txt"), "agent\n").unwrap();
        observe_at(&session, 2, done());
        undo(&session.id, tab, 1, None).unwrap();
        let notes = pending(&session.id, tab).unwrap();
        acknowledge_sent(&session.id, tab, 3, &notes).unwrap();
        restore_undo(&session.id, tab, 1, None).unwrap();
        assert!(context(&pending(&session.id, tab).unwrap()).contains("restored the files Undo removed"));
        assert!(sent_context(&session.id, tab, 3).unwrap().is_empty());
    }

    #[test]
    fn expiring_a_long_running_turn_does_not_prevent_future_checkpoints() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let tab = &session.tabs[0].id;
        observe_at(&session, 1, prompt(false));
        trees::prune_turn(repo.path(), &session.id, &format!("{tab}-1")).unwrap();
        observe_at(&session, 2, done());
        assert!(get(&session.id, tab, 1).unwrap().unwrap().unavailable_reason.is_some());
        observe_at(&session, 3, prompt(false));
        std::fs::write(repo.path().join("a.txt"), "agent\n").unwrap();
        observe_at(&session, 4, done());
        assert!(undo(&session.id, tab, 3, None).unwrap().undone);
    }

    #[test]
    fn expired_checkpoints_keep_their_summary_but_cannot_restore_unpinned_trees() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let tab = &session.tabs[0].id;
        observe_at(&session, 1, prompt(false));
        std::fs::write(repo.path().join("a.txt"), "agent\n").unwrap();
        observe_at(&session, 2, done());
        trees::prune_turn(repo.path(), &session.id, &format!("{tab}-1")).unwrap();
        assert!(get(&session.id, tab, 1).unwrap().unwrap().unavailable_reason.is_some());
        assert!(undo(&session.id, tab, 1, None).is_err());
        assert_eq!(std::fs::read_to_string(repo.path().join("a.txt")).unwrap(), "agent\n");
    }

    #[test]
    fn retention_protects_running_turns_and_newer_completed_turns_until_the_window_closes() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let peer = second_tab(&session, true);
        let tab = &session.tabs[0].id;
        let peer_tab = &peer.tabs[0].id;
        observe_at(&session, 1, prompt(false));
        observe_at(&session, 2, done()); // eligible, before the oldest running turn
        observe_at(&session, 3, prompt(false));
        observe_at(&peer, 1, prompt(false));
        std::fs::write(repo.path().join("b.txt"), "concurrent work\n").unwrap();
        observe_at(&peer, 2, done());
        observe_at(&peer, 3, prompt(false));
        observe_at(&peer, 4, done());
        // Both count and byte pressure must preserve A and every newer checkpoint,
        // including completed turns, even when that exceeds the configured limits.
        trees::enforce_retention(repo.path(), 1, 0).unwrap();
        assert!(!trees::exists(repo.path(), &session.id, &format!("{tab}-1"), "start").unwrap());
        for (owner, id) in [
            (&session.id, format!("{tab}-3")),
            (&peer.id, format!("{peer_tab}-1")),
            (&peer.id, format!("{peer_tab}-3")),
        ] {
            assert!(trees::exists(repo.path(), owner, &id, "start").unwrap());
        }
        git::run(repo.path(), &["gc", "--prune=now"]).unwrap();
        observe_at(&session, 4, done());
        let completed = get(&session.id, tab, 3).unwrap().unwrap();
        assert!(completed.unavailable_reason.is_none());
        assert!(file_paths(&completed).contains("b.txt"));
        // Once the interval is closed, retention resumes and evicts whole groups.
        trees::enforce_retention(repo.path(), 1, u64::MAX).unwrap();
        assert!(trees::exists(repo.path(), &session.id, &format!("{tab}-3"), "end").unwrap());
        assert!(!trees::exists(repo.path(), &peer.id, &format!("{peer_tab}-1"), "start").unwrap());
        assert!(!trees::exists(repo.path(), &peer.id, &format!("{peer_tab}-3"), "end").unwrap());
    }

    #[test]
    fn a_peer_checkpoint_lost_mid_turn_requires_confirmation_even_after_gc_or_session_deletion() {
        let _home = store::temp_home();
        for (other_session, collect) in [(false, false), (false, true), (true, true)] {
            let (repo, session) = fixture();
            let peer = second_tab(&session, other_session);
            let tab = &session.tabs[0].id;
            let peer_tab = &peer.tabs[0].id;
            // Make the peer's start tree unreachable from both HEAD and the target
            // turn, so GC really removes the evidence rather than leaving a diff.
            std::fs::write(repo.path().join("before.txt"), "only in peer start\n").unwrap();
            observe_at(&peer, 1, prompt(false));
            let start = load(&peer.id, peer_tab).unwrap().turns[0].start.clone();
            std::fs::remove_file(repo.path().join("before.txt")).unwrap();
            observe_at(&session, 1, prompt(false));
            std::fs::write(repo.path().join("b.txt"), "peer work\n").unwrap();
            trees::prune_turn(repo.path(), &peer.id, &format!("{peer_tab}-1")).unwrap();
            if collect {
                git::run(repo.path(), &["gc", "--prune=now"]).unwrap();
                assert!(git::run(repo.path(), &["cat-file", "-e", &start]).is_err());
            }
            observe_at(&peer, 2, done());
            let lost = load(&peer.id, peer_tab).unwrap();
            assert_eq!(lost.turns[0].files.is_empty(), collect);
            assert!(lost.turns[0].unavailable_reason.is_some());
            if other_session {
                crate::session_ops::remove_session_entries(std::slice::from_ref(&peer)).unwrap();
            }
            observe_at(&session, 2, done());
            let preview = undo(&session.id, tab, 1, None).unwrap();
            assert!(!preview.undone);
            assert_eq!(preview.overlap, vec!["b.txt"]);
            assert_eq!(std::fs::read_to_string(repo.path().join("b.txt")).unwrap(), "peer work\n");
            assert!(pending(&session.id, tab).unwrap().is_empty());
            assert!(undo(&session.id, tab, 1, Some(&preview.token)).unwrap().undone);
            assert!(!repo.path().join("b.txt").exists());
            assert!(restore_undo(&session.id, tab, 1, None).unwrap().undone);
            assert_eq!(std::fs::read_to_string(repo.path().join("b.txt")).unwrap(), "peer work\n");
        }
    }

    #[test]
    fn losing_a_completed_peers_refs_is_uncertain_even_with_an_empty_file_list() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let peer = second_tab(&session, false);
        let tab = &session.tabs[0].id;
        observe_at(&session, 1, prompt(false));
        observe_at(&peer, 1, prompt(false));
        observe_at(&peer, 2, done());
        std::fs::write(repo.path().join("a.txt"), "target edit\n").unwrap();
        observe_at(&session, 2, done());
        trees::prune_turn(repo.path(), &peer.id, &format!("{}-1", peer.tabs[0].id)).unwrap();
        let preview = undo(&session.id, tab, 1, None).unwrap();
        assert!(!preview.undone);
        assert_eq!(preview.overlap, vec!["a.txt"]);
        assert_eq!(std::fs::read_to_string(repo.path().join("a.txt")).unwrap(), "target edit\n");
    }

    #[test]
    fn reading_checkpoint_metadata_does_not_create_session_directories() {
        let _home = store::temp_home();
        let (_repo, session) = fixture();
        let directory = store::root().unwrap().join("sessions").join(&session.id);
        if directory.exists() {
            std::fs::remove_dir_all(&directory).unwrap();
        }
        assert!(get(&session.id, &session.tabs[0].id, 1).unwrap().is_none());
        assert!(workspace_states(&session.cwd).unwrap().is_empty());
        assert!(retention_state(&session.cwd).unwrap().owned.is_empty());
        assert!(!directory.exists());
    }

    #[test]
    fn deleting_a_running_peer_preserves_uncertainty_before_removing_its_checkpoint() {
        let _home = store::temp_home();
        let (repo, session) = fixture();
        let peer = second_tab(&session, true);
        observe_at(&peer, 1, prompt(false));
        observe_at(&session, 1, prompt(false));
        std::fs::write(repo.path().join("b.txt"), "peer work\n").unwrap();
        crate::session_ops::remove_session_entries(std::slice::from_ref(&peer)).unwrap();
        observe_at(&session, 2, done());
        let preview = undo(&session.id, &session.tabs[0].id, 1, None).unwrap();
        assert!(!preview.undone);
        assert_eq!(preview.overlap, vec!["b.txt"]);
        assert_eq!(std::fs::read_to_string(repo.path().join("b.txt")).unwrap(), "peer work\n");
    }
}
