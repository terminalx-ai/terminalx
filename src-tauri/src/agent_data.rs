//! What the agent CLIs keep for a session outside Raccoon's own store, and
//! removing it when the session is deleted.
//!
//! - **Claude Code** keeps one folder per working directory,
//!   `~/.claude/projects/<encoded cwd>/`, holding `<conversation id>.jsonl`
//!   and sometimes a `<conversation id>/` folder beside it.
//! - **Codex** runs in Raccoon's managed home (`$TERMINALX_HOME/codex`) and
//!   keeps one rollout per conversation under `sessions/YYYY/MM/DD/`.
//!
//! These files are what "resume" reads, so they go only when the session
//! itself is deleted, never when a worktree is removed and the session kept.
//!
//! Nothing here follows a symlink or leaves the two roots above. A deleted
//! session's own conversations are removed by id, except one a remaining
//! session still holds or is waiting to fork from.
//!
//! The whole Claude folder for a directory goes only when all of this holds:
//! the directory was the session's managed worktree and is known to be gone
//! (not merely unreadable); no remaining session uses it; and every
//! transcript in the folder is a conversation of the sessions being deleted
//! and says it was written there. The folder name is a lossy encoding, so the
//! name alone does not prove whose it is, and `~/.claude` is shared with the
//! person's own `claude` runs and with other installs of this app (a dev
//! build has its own index), so a conversation this delete does not know is
//! someone else's and keeps the folder.

use std::collections::HashSet;
use std::io::BufRead;
use std::path::{Path, PathBuf};

use crate::harness::claude::transcript::encoded_cwd;
use crate::store::index::SessionEntry;

/// How far into a transcript to look for the directory it was written in.
const CWD_SCAN_LINES: usize = 64;

/// `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects`. Under test this is never the real home: it resolves
/// inside the temporary `TERMINALX_HOME`, or nowhere when none is set.
pub(crate) fn claude_projects_root() -> Option<PathBuf> {
    #[cfg(not(test))]
    {
        // The CLI keeps everything under `CLAUDE_CONFIG_DIR` when it is set.
        match std::env::var("CLAUDE_CONFIG_DIR") {
            Ok(dir) if !dir.is_empty() => Some(PathBuf::from(dir).join("projects")),
            _ => dirs::home_dir().map(|home| home.join(".claude").join("projects")),
        }
    }
    #[cfg(test)]
    {
        crate::store::state_home_env().map(|home| PathBuf::from(home).join("test-user-home").join(".claude").join("projects"))
    }
}

/// Raccoon's managed Codex home, without creating it.
pub(crate) fn codex_managed_root() -> Option<PathBuf> {
    crate::store::root().ok().map(|root| root.join("codex"))
}

pub(crate) use crate::git::size_on_disk;

/// A name that is exactly one path component and cannot climb anywhere.
fn plain_component(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

/// `root/<name>` when it is a real directory (not a symlink) that still sits
/// directly under `root` once both are resolved. `root` must be canonical.
fn real_child_dir(root: &Path, name: &str) -> Option<PathBuf> {
    if !plain_component(name) {
        return None;
    }
    let path = root.join(name);
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return None;
    }
    let resolved = std::fs::canonicalize(&path).ok()?;
    (resolved.parent() == Some(root)).then_some(resolved)
}

/// Both CLIs name conversations with UUIDs. Anything else is not used to
/// build a path.
fn conversation_id(id: &str) -> Option<&str> {
    uuid::Uuid::parse_str(id).ok().map(|_| id)
}

/// Every directory a session's agents may have run in: where it works now
/// and the worktree it worked in before that was removed.
fn session_dirs(session: &SessionEntry) -> Vec<&str> {
    let mut dirs = vec![session.cwd.as_str()];
    if let Some(removed) = &session.removed_workspace {
        if removed.path != session.cwd {
            dirs.push(removed.path.as_str());
        }
    }
    dirs.retain(|dir| !dir.is_empty());
    dirs
}

fn conversation_ids<'a>(sessions: &'a [SessionEntry], harness: &str) -> HashSet<&'a str> {
    sessions
        .iter()
        .flat_map(|session| &session.tabs)
        .filter(|tab| tab.harness == harness)
        .filter_map(|tab| tab.provider_session_id.as_deref())
        .collect()
}

/// Conversations the remaining sessions need: the ones their tabs hold, and
/// the ones a forked tab has yet to fork from. A fork has no conversation of
/// its own until its first send, when the CLI resumes the parent's.
fn needed_conversation_ids<'a>(remaining: &'a [SessionEntry], harness: &str) -> HashSet<&'a str> {
    remaining
        .iter()
        .flat_map(|session| &session.tabs)
        .filter(|tab| tab.harness == harness)
        .flat_map(|tab| [tab.provider_session_id.as_deref(), tab.fork_from.as_deref()])
        .flatten()
        .collect()
}

/// How a folder name is compared with what remaining sessions use. Lower
/// case, so a session recorded as `/Users/Me/x` still protects the folder of
/// `/users/me/x` on a case-insensitive disk. Over-keeping is the safe side.
fn folder_key(dir: &str) -> String {
    encoded_cwd(dir).to_lowercase()
}

/// A worktree Raccoon made for this project that is known to be gone from
/// disk. Only such a directory can have had no other user of its Claude
/// folder. "Cannot be read" is not "gone": a project on a volume that is
/// not mounted right now still has its worktrees.
fn removed_managed_worktree(session: &SessionEntry, dir: &str) -> bool {
    let path = Path::new(dir);
    let root = crate::git::worktree_root(Path::new(&session.project_path));
    if !path.is_absolute() || path.parent() != Some(root.as_path()) {
        return false;
    }
    let gone = matches!(std::fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound);
    // The worktree is gone, and the project it was in can still be read.
    gone && std::fs::symlink_metadata(&session.project_path).is_ok()
}

/// The directory a Claude transcript says it was written in.
fn recorded_cwd(transcript: &Path) -> Option<String> {
    let file = std::fs::File::open(transcript).ok()?;
    std::io::BufReader::new(file)
        .lines()
        .take(CWD_SCAN_LINES)
        .map_while(|line| line.ok())
        .find_map(|line| serde_json::from_str::<serde_json::Value>(&line).ok()?.get("cwd")?.as_str().map(String::from))
}

/// Whether every transcript in a Claude folder was written in `cwd` (or
/// below it). A transcript naming another directory means the folder name is
/// shared with some other path; one that names none cannot be placed. Either
/// way the folder is not known to be ours.
fn transcripts_belong_to(folder: &Path, cwd: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(folder) else { return false };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        match recorded_cwd(&path) {
            Some(named) if Path::new(&named).starts_with(cwd) => {}
            _ => return false,
        }
    }
    true
}

/// Whether everything conversation-shaped in a Claude folder belongs to
/// `ours`: every transcript, and every side folder named for a conversation.
/// One this delete does not know belongs to someone else.
fn only_conversations_of(folder: &Path, ours: &HashSet<&str>) -> bool {
    let Ok(entries) = std::fs::read_dir(folder) else { return false };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { return false };
        let known = match name.strip_suffix(".jsonl") {
            Some(stem) => ours.contains(stem),
            None => conversation_id(name).is_none_or(|id| ours.contains(id)),
        };
        if !known {
            return false;
        }
    }
    true
}

fn remove_file_counted(path: &Path) -> u64 {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => {
            let size = size_on_disk(path);
            match std::fs::remove_file(path) {
                Ok(()) => size,
                Err(error) => {
                    log::warn!("delete {}: {error}", path.display());
                    0
                }
            }
        }
        _ => 0,
    }
}

fn remove_dir_counted(path: &Path) -> u64 {
    let size = size_on_disk(path);
    match std::fs::remove_dir_all(path) {
        Ok(()) => size,
        Err(error) => {
            log::warn!("delete {}: {error}", path.display());
            0
        }
    }
}

/// Remove what Claude Code kept for the deleted sessions under `root`
/// (`~/.claude/projects`). Returns the bytes freed.
pub(crate) fn remove_claude_data(root: &Path, doomed: &[SessionEntry], remaining: &[SessionEntry]) -> u64 {
    let Ok(root) = std::fs::canonicalize(root) else { return 0 };
    let needed = needed_conversation_ids(remaining, "claude");
    let ours: HashSet<&str> = conversation_ids(doomed, "claude").into_iter().filter(|id| conversation_id(id).is_some() && !needed.contains(id)).collect();
    let kept_folders: HashSet<String> = remaining.iter().flat_map(session_dirs).map(folder_key).collect();
    let mut freed = 0;
    for session in doomed {
        for dir in session_dirs(session) {
            let name = encoded_cwd(dir);
            let Some(folder) = real_child_dir(&root, &name) else { continue };
            let whole = !kept_folders.contains(&folder_key(dir))
                && removed_managed_worktree(session, dir)
                && only_conversations_of(&folder, &ours)
                && transcripts_belong_to(&folder, dir);
            if whole {
                freed += remove_dir_counted(&folder);
                continue;
            }
            for tab in session.tabs.iter().filter(|tab| tab.harness == "claude") {
                let Some(id) = tab.provider_session_id.as_deref().filter(|id| ours.contains(id)) else { continue };
                freed += remove_file_counted(&folder.join(format!("{id}.jsonl")));
                if let Some(side) = real_child_dir(&folder, id) {
                    freed += remove_dir_counted(&side);
                }
            }
        }
    }
    freed
}

/// Remove the deleted sessions' Codex rollouts from the managed home.
/// Returns the bytes freed.
pub(crate) fn remove_codex_data(home: &Path, doomed: &[SessionEntry], remaining: &[SessionEntry]) -> u64 {
    let Ok(sessions) = std::fs::canonicalize(home.join("sessions")) else { return 0 };
    let kept_ids = needed_conversation_ids(remaining, "codex");
    let mut freed = 0;
    for tab in doomed.iter().flat_map(|session| &session.tabs).filter(|tab| tab.harness == "codex") {
        let Some(id) = tab.provider_session_id.as_deref().and_then(conversation_id) else { continue };
        if kept_ids.contains(id) {
            continue;
        }
        let Some(rollout) = crate::harness::codex::home::find_rollout(home, id) else { continue };
        // The year, month and day folders must be real ones inside the home.
        let inside = rollout.parent().and_then(|day| std::fs::canonicalize(day).ok()).is_some_and(|day| day.starts_with(&sessions));
        if inside {
            freed += remove_file_counted(&rollout);
        }
    }
    freed
}

/// Remove the agent CLIs' data for sessions that were just deleted.
/// `remaining` is every session still in the index: what they use is kept.
pub(crate) fn remove_for_deleted_sessions(doomed: &[SessionEntry], remaining: &[SessionEntry]) -> u64 {
    let mut freed = 0;
    if let Some(root) = claude_projects_root() {
        freed += remove_claude_data(&root, doomed, remaining);
    }
    if let Some(home) = codex_managed_root() {
        freed += remove_codex_data(&home, doomed, remaining);
    }
    freed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::index::{self, RemovedWorkspace, TabEntry, TabStatus};
    use std::collections::BTreeMap;

    const CONV_A: &str = "11111111-1111-4111-8111-111111111111";
    const CONV_B: &str = "22222222-2222-4222-8222-222222222222";
    const CONV_C: &str = "33333333-3333-4333-8333-333333333333";

    fn tab(harness: &str, conversation: Option<&str>) -> TabEntry {
        TabEntry {
            id: uuid::Uuid::now_v7().to_string(),
            harness: harness.into(),
            title: None,
            model: String::new(),
            effort: None,
            permission_mode: "default".into(),
            provider_session_id: conversation.map(String::from),
            status: TabStatus::Idle,
            created: index::now(),
            modified: index::now(),
            context_used: None,
            context_max: None,
            fork_from: None,
            unknown: BTreeMap::new(),
        }
    }

    fn session(project: &Path, cwd: &Path, tabs: Vec<TabEntry>) -> SessionEntry {
        SessionEntry {
            id: uuid::Uuid::now_v7().to_string(),
            project_path: project.to_string_lossy().into_owned(),
            cwd: cwd.to_string_lossy().into_owned(),
            worktree_name: cwd.file_name().map(|name| name.to_string_lossy().into_owned()),
            branch: None,
            base_ref: None,
            worktree_removed: false,
            removed_workspace: None,
            issue: None,
            automation: None,
            title: "t".into(),
            created: index::now(),
            modified: index::now(),
            archived: false,
            pinned: false,
            active_tab: None,
            tabs,
            unknown: BTreeMap::new(),
        }
    }

    /// A temporary home with a Claude projects root, and a project whose
    /// worktree `gone` was never created on disk (so it reads as removed).
    struct Fixture {
        _home: crate::store::TempHome,
        dir: tempfile::TempDir,
        root: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let home = crate::store::temp_home();
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("home/.claude/projects");
            std::fs::create_dir_all(&root).unwrap();
            std::fs::create_dir_all(dir.path().join("project")).unwrap();
            Self { _home: home, root: std::fs::canonicalize(root).unwrap(), dir }
        }

        fn project(&self) -> PathBuf {
            std::fs::canonicalize(self.dir.path().join("project")).unwrap()
        }

        fn worktree(&self, name: &str) -> PathBuf {
            crate::git::worktree_path(&self.project(), name)
        }

        /// Write a transcript the way the CLI does, recording where it ran.
        fn transcript(&self, cwd: &Path, conversation: &str) -> PathBuf {
            self.transcript_saying(cwd, conversation, cwd)
        }

        fn transcript_saying(&self, cwd: &Path, conversation: &str, recorded: &Path) -> PathBuf {
            let folder = self.root.join(encoded_cwd(&cwd.to_string_lossy()));
            std::fs::create_dir_all(&folder).unwrap();
            let file = folder.join(format!("{conversation}.jsonl"));
            let line = serde_json::json!({ "type": "user", "cwd": recorded, "sessionId": conversation });
            std::fs::write(&file, format!("{{\"type\":\"summary\"}}\n{line}\n")).unwrap();
            file
        }
    }

    #[test]
    fn a_deleted_sessions_removed_worktree_loses_its_whole_claude_folder() {
        let f = Fixture::new();
        let gone = f.worktree("gone");
        let mine = f.transcript(&gone, CONV_A);
        let also_mine = f.transcript(&gone, CONV_B);
        let folder = mine.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(folder.join("memory")).unwrap();
        std::fs::create_dir_all(folder.join(CONV_A).join("subagents")).unwrap();
        let elsewhere = f.transcript(&f.project(), CONV_C);

        let doomed = session(&f.project(), &gone, vec![tab("claude", Some(CONV_A)), tab("claude", Some(CONV_B))]);
        let freed = remove_claude_data(&f.root, &[doomed], &[]);

        assert!(freed > 0);
        assert!(!folder.exists(), "the folder for the removed worktree is gone");
        assert!(!also_mine.exists());
        assert!(elsewhere.exists(), "the project's own folder is not the session's to remove");
    }

    #[test]
    fn a_conversation_this_install_does_not_know_keeps_the_folder() {
        let f = Fixture::new();
        let gone = f.worktree("gone");
        let mine = f.transcript(&gone, CONV_A);
        // Written by the person's own `claude`, or by another install of the
        // app with its own index: in the same folder, for the same directory.
        let not_ours = f.transcript(&gone, CONV_B);
        let folder = mine.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(folder.join(CONV_C)).unwrap();
        std::fs::create_dir_all(folder.join("memory")).unwrap();

        let doomed = session(&f.project(), &gone, vec![tab("claude", Some(CONV_A))]);
        remove_claude_data(&f.root, &[doomed], &[]);
        assert!(!mine.exists(), "the deleted session's own conversation goes");
        assert!(not_ours.exists());
        assert!(folder.join(CONV_C).exists());
        assert!(folder.join("memory").exists());
    }

    #[test]
    fn a_pending_forks_parent_conversation_is_kept() {
        let f = Fixture::new();
        let gone = f.worktree("gone");
        let parent = f.transcript(&gone, CONV_A);
        let other = f.transcript(&gone, CONV_B);
        // A fork lives in a worktree of its own and has no conversation yet:
        // its first send resumes the parent's.
        let mut fork_tab = tab("claude", None);
        fork_tab.fork_from = Some(CONV_A.into());
        let fork = session(&f.project(), &f.worktree("fork"), vec![fork_tab]);

        let doomed = session(&f.project(), &gone, vec![tab("claude", Some(CONV_A)), tab("claude", Some(CONV_B))]);
        remove_claude_data(&f.root, &[doomed], &[fork]);
        assert!(parent.exists(), "the fork still has to resume from it");
        assert!(!other.exists(), "the session's other conversation goes");
    }

    #[test]
    fn a_transcript_that_names_no_directory_keeps_the_folder() {
        let f = Fixture::new();
        let gone = f.worktree("gone");
        let mine = f.transcript(&gone, CONV_A);
        std::fs::write(&mine, "{\"type\":\"summary\"}\n").unwrap();
        let folder = mine.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(folder.join("memory")).unwrap();
        let doomed = session(&f.project(), &gone, vec![tab("claude", Some(CONV_A))]);
        remove_claude_data(&f.root, &[doomed], &[]);
        assert!(!mine.exists(), "it is still the session's own conversation, removed by id");
        assert!(folder.join("memory").exists(), "but where it was written is unknown, so the folder stays");
    }

    #[cfg(unix)]
    #[test]
    fn a_worktree_that_cannot_be_read_is_not_taken_for_gone() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let gone = f.worktree("gone");
        let mine = f.transcript(&gone, CONV_A);
        let folder = mine.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(folder.join("memory")).unwrap();
        let doomed = session(&f.project(), &gone, vec![tab("claude", Some(CONV_A))]);

        // The worktree folder cannot be searched: the stat fails, but not with "not found".
        let root = gone.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(&root).unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o000)).unwrap();
        let unreadable = matches!(std::fs::symlink_metadata(&gone), Err(e) if e.kind() != std::io::ErrorKind::NotFound);
        remove_claude_data(&f.root, std::slice::from_ref(&doomed), &[]);
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
        if unreadable {
            assert!(folder.join("memory").exists());
        }

        // Nor is it gone when the whole project is out of reach (an unmounted volume).
        let f = Fixture { root: f.root.clone(), ..f };
        let away = f.dir.path().join("not-mounted/project");
        let elsewhere = crate::git::worktree_path(&away, "gone");
        let theirs = f.transcript(&elsewhere, CONV_B);
        std::fs::create_dir_all(theirs.parent().unwrap().join("memory")).unwrap();
        let doomed = session(&away, &elsewhere, vec![tab("claude", Some(CONV_B))]);
        remove_claude_data(&f.root, &[doomed], &[]);
        assert!(theirs.parent().unwrap().join("memory").exists());
    }

    #[test]
    fn a_remaining_session_in_the_same_directory_under_another_case_keeps_the_folder() {
        let f = Fixture::new();
        let gone = f.worktree("gone");
        let mine = f.transcript(&gone, CONV_A);
        let folder = mine.parent().unwrap().to_path_buf();
        std::fs::create_dir_all(folder.join("memory")).unwrap();
        let doomed = session(&f.project(), &gone, vec![tab("claude", Some(CONV_A))]);
        // The same directory as another session recorded it on a case-insensitive disk.
        let shouted = PathBuf::from(gone.to_string_lossy().to_uppercase());
        let other = session(&f.project(), &shouted, vec![]);
        remove_claude_data(&f.root, &[doomed], &[other]);
        assert!(folder.join("memory").exists());
    }

    #[test]
    fn data_is_kept_while_another_session_uses_the_directory() {
        let f = Fixture::new();
        let gone = f.worktree("gone");
        let mine = f.transcript(&gone, CONV_A);
        let theirs = f.transcript(&gone, CONV_B);

        let doomed = session(&f.project(), &gone, vec![tab("claude", Some(CONV_A))]);
        let other = session(&f.project(), &gone, vec![tab("claude", Some(CONV_B))]);
        remove_claude_data(&f.root, &[doomed], std::slice::from_ref(&other));
        assert!(!mine.exists(), "the deleted session's own conversation goes");
        assert!(theirs.exists(), "the other session's conversation stays");
        assert!(theirs.parent().unwrap().exists());

    }

    #[test]
    fn a_session_settled_out_of_a_worktree_still_keeps_the_old_folder() {
        let f = Fixture::new();
        let gone = f.worktree("gone");
        let mine = f.transcript(&gone, CONV_A);
        let theirs = f.transcript(&gone, CONV_B);
        let doomed = session(&f.project(), &gone, vec![tab("claude", Some(CONV_A))]);
        let mut settled = session(&f.project(), &f.project(), vec![tab("claude", Some(CONV_B))]);
        settled.removed_workspace = Some(RemovedWorkspace { path: gone.to_string_lossy().into_owned(), name: "gone".into(), branch: None });
        remove_claude_data(&f.root, &[doomed], &[settled]);
        assert!(!mine.exists());
        assert!(theirs.exists());
    }

    #[test]
    fn a_conversation_another_session_also_holds_is_kept() {
        let f = Fixture::new();
        let gone = f.worktree("gone");
        let shared = f.transcript(&gone, CONV_A);
        let doomed = session(&f.project(), &gone, vec![tab("claude", Some(CONV_A))]);
        let other = session(&f.project(), &gone, vec![tab("claude", Some(CONV_A))]);
        assert_eq!(remove_claude_data(&f.root, &[doomed], &[other]), 0);
        assert!(shared.exists());
    }

    #[test]
    fn a_session_at_the_project_root_loses_only_its_own_conversations() {
        let f = Fixture::new();
        let project = f.project();
        let mine = f.transcript(&project, CONV_A);
        std::fs::create_dir_all(mine.with_extension("").join("subagents")).unwrap();
        let by_hand = f.transcript(&project, CONV_B);
        let mut doomed = session(&project, &project, vec![tab("claude", Some(CONV_A)), tab("claude", None)]);
        doomed.worktree_name = None;
        remove_claude_data(&f.root, &[doomed], &[]);
        assert!(!mine.exists());
        assert!(!mine.with_extension("").exists(), "the conversation's side folder goes too");
        assert!(by_hand.exists(), "a conversation the person ran themselves is not Raccoon's");
    }

    #[test]
    fn a_worktree_still_on_disk_keeps_its_folder() {
        let f = Fixture::new();
        let kept = f.worktree("kept");
        std::fs::create_dir_all(&kept).unwrap();
        let mine = f.transcript(&kept, CONV_A);
        let other = f.transcript(&kept, CONV_B);
        let doomed = session(&f.project(), &kept, vec![tab("claude", Some(CONV_A))]);
        remove_claude_data(&f.root, &[doomed], &[]);
        assert!(!mine.exists());
        assert!(other.exists(), "the worktree was kept, so only the session's own conversation goes");
    }

    #[test]
    fn a_folder_whose_transcripts_name_another_directory_is_not_removed_whole() {
        let f = Fixture::new();
        let gone = f.worktree("gone");
        // Another path encodes to the same folder name; its transcript says so.
        let mine = f.transcript(&gone, CONV_A);
        let look_alike = PathBuf::from(gone.to_string_lossy().replace("/.raccoon/", "/-raccoon/"));
        assert_eq!(encoded_cwd(&look_alike.to_string_lossy()), encoded_cwd(&gone.to_string_lossy()));
        let theirs = f.transcript_saying(&gone, CONV_B, &look_alike);
        let doomed = session(&f.project(), &gone, vec![tab("claude", Some(CONV_A))]);
        remove_claude_data(&f.root, &[doomed], &[]);
        assert!(!mine.exists());
        assert!(theirs.exists(), "an exact path match is needed, not just the same folder name");
    }

    #[test]
    fn nothing_outside_the_projects_root_is_reachable() {
        let f = Fixture::new();
        let outside = f.dir.path().join("home/.claude/keep.jsonl");
        std::fs::write(&outside, "keep").unwrap();
        let settings = f.dir.path().join("home/.claude/settings.json");
        std::fs::write(&settings, "{}").unwrap();

        // Names that are not one plain component never resolve.
        for name in ["", ".", "..", "../..", "a/b", "a\\b", "x\0y"] {
            assert!(real_child_dir(&f.root, name).is_none(), "{name:?}");
        }
        // Conversation ids that are not UUIDs never become a path.
        for id in ["", "..", "../keep", "../../settings", "a/b", "*"] {
            assert!(conversation_id(id).is_none(), "{id:?}");
        }

        // An empty or relative cwd, and hostile ids, delete nothing.
        let gone = f.worktree("gone");
        f.transcript(&gone, CONV_A);
        let mut hostile = session(&f.project(), Path::new(""), vec![tab("claude", Some("../keep")), tab("claude", Some(""))]);
        remove_claude_data(&f.root, std::slice::from_ref(&hostile), &[]);
        hostile.cwd = "..".into();
        remove_claude_data(&f.root, std::slice::from_ref(&hostile), &[]);
        hostile.cwd = gone.to_string_lossy().into_owned();
        hostile.worktree_name = None;
        hostile.project_path = String::new();
        remove_claude_data(&f.root, &[hostile], &[]);

        assert!(outside.exists());
        assert!(settings.exists());
        assert!(f.root.exists());
        assert!(f.root.join(encoded_cwd(&gone.to_string_lossy())).join(format!("{CONV_A}.jsonl")).exists());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_followed() {
        let f = Fixture::new();
        let gone = f.worktree("gone");
        let target = tempfile::tempdir().unwrap();
        let precious = target.path().join(format!("{CONV_A}.jsonl"));
        std::fs::write(&precious, "keep").unwrap();
        std::fs::create_dir_all(target.path().join(CONV_B)).unwrap();

        // The folder for the directory is a link to somewhere else.
        let link = f.root.join(encoded_cwd(&gone.to_string_lossy()));
        std::os::unix::fs::symlink(target.path(), &link).unwrap();
        let doomed = session(&f.project(), &gone, vec![tab("claude", Some(CONV_A))]);
        assert_eq!(remove_claude_data(&f.root, std::slice::from_ref(&doomed), &[]), 0);
        assert!(precious.exists());
        assert!(link.symlink_metadata().is_ok());

        // Inside a real folder, a linked transcript and a linked side folder are left alone.
        std::fs::remove_file(&link).unwrap();
        let other = f.worktree("other");
        std::fs::create_dir_all(&other).unwrap();
        let folder = f.root.join(encoded_cwd(&other.to_string_lossy()));
        std::fs::create_dir_all(&folder).unwrap();
        std::os::unix::fs::symlink(&precious, folder.join(format!("{CONV_A}.jsonl"))).unwrap();
        std::os::unix::fs::symlink(target.path().join(CONV_B), folder.join(CONV_B)).unwrap();
        let doomed = session(&f.project(), &other, vec![tab("claude", Some(CONV_A)), tab("claude", Some(CONV_B))]);
        remove_claude_data(&f.root, &[doomed], &[]);
        assert!(precious.exists());
        assert!(target.path().join(CONV_B).exists());
    }

    #[test]
    fn codex_rollouts_go_with_their_session_and_no_other() {
        let f = Fixture::new();
        let home = f.dir.path().join("codex");
        let day = home.join("sessions/2026/10/03");
        std::fs::create_dir_all(&day).unwrap();
        let mine = day.join(format!("rollout-2026-10-03T10-00-00-{CONV_A}.jsonl"));
        let theirs = day.join(format!("rollout-2026-10-03T11-00-00-{CONV_B}.jsonl"));
        let unrelated = day.join(format!("rollout-2026-10-03T12-00-00-{CONV_C}.jsonl"));
        for file in [&mine, &theirs, &unrelated] {
            std::fs::write(file, "{}\n").unwrap();
        }
        std::fs::write(home.join("auth.json"), "{}").unwrap();

        let gone = f.worktree("gone");
        // A Claude tab holding the same id is not a Codex conversation.
        let doomed = session(&f.project(), &gone, vec![tab("codex", Some(CONV_A)), tab("codex", Some(CONV_B)), tab("claude", Some(CONV_C)), tab("codex", Some("../auth"))]);
        let other = session(&f.project(), &gone, vec![tab("codex", Some(CONV_B))]);
        let freed = remove_codex_data(&home, &[doomed], &[other]);

        assert!(freed > 0);
        assert!(!mine.exists());
        assert!(theirs.exists(), "another session still resumes from it");
        assert!(unrelated.exists());
        assert!(home.join("auth.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_codex_day_folder_linked_elsewhere_is_left_alone() {
        let f = Fixture::new();
        let home = f.dir.path().join("codex");
        let month = home.join("sessions/2026/10");
        std::fs::create_dir_all(&month).unwrap();
        let target = tempfile::tempdir().unwrap();
        let precious = target.path().join(format!("rollout-2026-10-03T10-00-00-{CONV_A}.jsonl"));
        std::fs::write(&precious, "keep").unwrap();
        std::os::unix::fs::symlink(target.path(), month.join("03")).unwrap();
        let doomed = session(&f.project(), &f.worktree("gone"), vec![tab("codex", Some(CONV_A))]);
        assert_eq!(remove_codex_data(&home, &[doomed], &[]), 0);
        assert!(precious.exists());
    }

    #[test]
    fn the_test_roots_are_never_the_real_home() {
        let _home = crate::store::temp_home();
        let state = PathBuf::from(crate::store::state_home_env().unwrap());
        assert!(claude_projects_root().unwrap().starts_with(&state));
        assert!(codex_managed_root().unwrap().starts_with(&state));
    }
}
