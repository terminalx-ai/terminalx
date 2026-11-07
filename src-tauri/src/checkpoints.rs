//! Durable turn checkpoints, review decisions and one-shot revert context.
use crate::{
    events::Payload,
    git::{self, checkpoints as trees},
    store::{self, index},
};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::{
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

fn finish(session: &str, tab: &str, turn: &mut Checkpoint) -> Result<()> {
    let cwd = Path::new(&turn.cwd);
    let end = git::snapshot_tree(cwd)?;
    let end_index = index_tree(cwd).ok();
    let id = format!("{tab}-{}", turn.seq);
    trees::pin(cwd, session, &id, "end", &end)?;
    if let Some(index) = &end_index {
        trees::pin(cwd, session, &id, "end-index", index)?;
    }
    turn.files = git::changes_between(cwd, &turn.start, Some(&end))?;
    turn.end = Some(end);
    turn.end_index = end_index;
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
            let start = match payload {
                Payload::UserMessage { baseline: Some(tree), .. } if state.notes.is_empty() => tree.clone(),
                _ => git::snapshot_tree(Path::new(&cwd))?,
            };
            let index = index_tree(Path::new(&cwd)).ok();
            let id = format!("{tab}-{seq}");
            trees::pin(Path::new(&cwd), session, &id, "start", &start)?;
            if let Some(index) = &index {
                trees::pin(Path::new(&cwd), session, &id, "index", index)?;
            }
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
            });
        } else if let Payload::TurnCompleted { head, .. } = payload {
            if let Some(turn) = state.turns.last_mut().filter(|t| t.end.is_none()) {
                finish(session, tab, turn)?;
                *head = turn.end.clone();
                completed = Some(Completed {
                    seq: turn.seq,
                    base: turn.start.clone(),
                    head: turn.end.clone().unwrap(),
                });
            }
        } else {
            return Ok(None);
        }
        save(session, tab, &state)?;
        Ok(completed)
    })
}

pub fn get(session: &str, tab: &str, seq: u64) -> Result<Option<Checkpoint>> {
    locked(session, || Ok(load(session, tab)?.turns.into_iter().find(|t| t.seq == seq && t.end.is_some())))
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
fn idle(cwd: &str) -> Result<()> {
    for session in index::load()? {
        if session
            .tabs
            .iter()
            .any(|t| matches!(t.status, index::TabStatus::InProgress | index::TabStatus::Waiting))
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
        if turn.reviewed {
            bail!("This turn has already been reviewed.");
        }
        if root(&index::get(session)?.cwd)? != turn.cwd {
            bail!("This checkpoint belongs to a workspace that is no longer attached.");
        }
        idle(&turn.cwd)?;
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
        for later in &state.turns[at + 1..] {
            for f in &later.files {
                changed.push(f.path.clone());
                changed.extend(f.old_path.clone());
            }
        }
        let overlap: Vec<_> = paths.iter().filter(|p| changed.contains(p)).cloned().collect();
        if !overlap.is_empty() && confirmed != Some(token.as_str()) {
            return Ok(UndoResult { overlap, token, undone: false });
        }
        // Retain the current contents too, so an I/O error never makes them unreachable.
        let id = format!("{tab}-{seq}");
        trees::pin(cwd, session, &id, "before-undo", &now)?;
        trees::pin(cwd, session, &id, "before-undo-index", &now_index)?;
        trees::restore_with_backup(cwd, &turn.start, start_index, &paths, &now, &now_index)?;
        let number = turn.number;
        state.turns[at].reviewed = true;
        state.turns[at].undone = true;
        state.notes.push(note(&paths, Some(number)));
        save(session, tab, &state)?;
        Ok(UndoResult {
            overlap: Vec::new(),
            token,
            undone: true,
        })
    })
}

/// Discard from the displayed base (HEAD for Uncommitted). Notify each conversation
/// that edited the file; a file with no turn provenance is described without inventing one.
pub fn discard(cwd: &str, path: &str, base: Option<&str>, old_path: Option<&str>) -> Result<()> {
    workspace_locked(cwd, || {
        let cwd = root(cwd)?;
        idle(&cwd)?;
        let p = Path::new(&cwd);
        let base = base.map(String::from).map(Ok).unwrap_or_else(|| git::head_tree(p))?;
        let paths: Vec<_> = std::iter::once(path.to_string()).chain(old_path.map(String::from)).collect();
        // Read all affected metadata before modifying files, so unreadable state fails safely.
        let mut affected = Vec::new();
        for session in index::load()? {
            if !in_workspace(&session.cwd, &cwd) {
                continue;
            }
            for tab in &session.tabs {
                let state = load(&session.id, &tab.id)?;
                let number = state
                    .turns
                    .iter()
                    .rev()
                    .find(|t| {
                        t.files
                            .iter()
                            .any(|f| paths.contains(&f.path) || f.old_path.as_ref().is_some_and(|p| paths.contains(p)))
                    })
                    .map(|t| t.number);
                affected.push((session.id.clone(), tab.id.clone(), state, number));
            }
        }
        let before = trees::current(p, &paths)?;
        let before_index = index_tree(p)?;
        if let Some((session, _, _, _)) = affected.first() {
            let id = format!("discard-{}", uuid::Uuid::new_v4());
            trees::pin(p, session, &id, "start", &before)?;
            trees::pin(p, session, &id, "index", &before_index)?;
        }
        trees::restore_with_backup(p, &base, &base, &paths, &before, &before_index)?;
        for (session, tab, mut state, number) in affected {
            state.notes.push(note(&paths, number));
            save(&session, &tab, &state)?;
        }
        Ok(())
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
        assert_eq!(context(&pending(&session.id, tab).unwrap()), "The user reverted \"new.txt\".");
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
}
