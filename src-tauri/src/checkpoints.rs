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
    Ok(store::session_dir(session)?.join(format!("checkpoints-{tab}.json")))
}
fn load(session: &str, tab: &str) -> Result<State> {
    match std::fs::read(file(session, tab)?) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(e) => Err(e.into()),
    }
}
fn save(session: &str, tab: &str, state: &State) -> Result<()> {
    store::write_json(&file(session, tab)?, state)
}
fn root(cwd: &str) -> Result<String> {
    Ok(git::run(Path::new(cwd), &["rev-parse", "--show-toplevel"])?.trim().into())
}
fn index_tree(cwd: &Path) -> Result<String> {
    Ok(git::run(cwd, &["write-tree"])?.trim().into())
}

fn retention_result(result: Result<()>) -> Result<Option<String>> {
    match result {
        Ok(()) => Ok(None),
        Err(error) if error.is::<trees::LimitExceeded>() => Ok(Some(error.to_string())),
        Err(error) => Err(error),
    }
}

fn file_paths(turn: &Checkpoint) -> BTreeSet<String> {
    turn.files
        .iter()
        .flat_map(|f| std::iter::once(f.path.clone()).chain(f.old_path.clone()))
        .collect()
}

/// Atomic state files include closed tabs; the index includes archived sessions.
fn workspace_states(cwd: &str) -> Result<Vec<(String, String, State)>> {
    let mut states = Vec::new();
    for session in index::load()? {
        for entry in std::fs::read_dir(store::session_dir(&session.id)?)? {
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

/// Recover ownership of refs created before the retention ledger existed.
pub(crate) fn ref_groups(cwd: &str) -> Result<BTreeSet<String>> {
    let mut groups = BTreeSet::new();
    for (session, tab, state) in workspace_states(cwd)? {
        for turn in state.turns.iter().filter(|turn| turn.cwd == cwd) {
            let name = trees::reference(&session, &format!("{tab}-{}", turn.seq), "start")?;
            groups.insert(name.trim_end_matches("/start").to_string());
        }
    }
    Ok(groups)
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
    for (owner, peer_tab, mut state) in workspace_states(&turn.cwd)? {
        if owner == session && peer_tab == tab {
            continue;
        }
        let mut changed = false;
        for peer in state.turns.iter_mut().filter(|p| p.cwd == target.cwd && concurrent(p, &target)) {
            peer.concurrent_paths.extend(own_paths.iter().cloned());
            if peer.end.is_none() {
                turn.concurrent_paths.extend(own_paths.iter().cloned());
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
        let limited = retention_result((|| {
            trees::pin(cwd, session, &id, "end", &end)?;
            if let Some(index) = &end_index {
                trees::pin(cwd, session, &id, "end-index", index)?;
            }
            Ok(())
        })())?;
        if limited.is_some() {
            turn.unavailable_reason = limited;
        }
    } else {
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
            let unavailable_reason = retention_result((|| {
                trees::pin(Path::new(&cwd), session, &id, "start", &start)?;
                if let Some(index) = &index {
                    trees::pin(Path::new(&cwd), session, &id, "index", index)?;
                }
                Ok(())
            })())?;
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
                backup: None,
                restored: false,
                backup_ref: None,
                unavailable_reason,
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
        for later in &state.turns[at + 1..] {
            changed.extend(file_paths(later));
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
                if peer.end.is_none() {
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
        trees::pin(cwd, session, &id, "before-undo", &now)?;
        trees::pin(cwd, session, &id, "before-undo-index", &now_index)?;
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
            trees::pin(p, session, id, "start", &before)?;
            trees::pin(p, session, id, "index", &before_index)?;
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
        trees::pin(cwd, session, &id, "before-restore", &now)?;
        trees::pin(cwd, session, &id, "before-restore-index", &now_index)?;
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

pub fn prune(session: &index::SessionEntry) {
    let result = workspace_locked(&session.cwd, || {
        // Git stores these refs in the common directory, which outlives a removed worktree.
        // Keep its location even for quick chats, which have no project_path fallback.
        let mut repositories = std::collections::BTreeSet::new();
        let mut metadata = Vec::new();
        // Closed tabs can still own refs. Their metadata goes with the workspace too.
        trees::reference(&session.id, "validate", "start")?;
        for entry in std::fs::read_dir(store::session_dir(&session.id)?)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with("checkpoints-") || !name.ends_with(".json") {
                continue;
            }
            let state: State = serde_json::from_slice(&std::fs::read(entry.path())?)?;
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
    });
    if let Err(error) = result {
        log::warn!("prune turn checkpoints: {error:#}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::TurnStatus;

    fn fixture() -> (tempfile::TempDir, index::SessionEntry) {
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
    fn prompt(queued: bool) -> Payload {
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
    fn done() -> Payload {
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
        prune(&session);
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
        prune(&session);
        assert!(git::run(repo.path(), &["for-each-ref", "refs/raccoon-checkpoints"]).unwrap().is_empty());
    }
    fn second_tab(session: &index::SessionEntry, other_session: bool) -> index::SessionEntry {
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
}
