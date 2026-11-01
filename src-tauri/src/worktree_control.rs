//! What the `terminalx` CLI shows of the sessions in a worktree, and checks
//! before it deletes one (#719).
//!
//! Which sessions a worktree holds is decided in one place,
//! [`crate::session_ops::sessions_within`]: every session in the index whose
//! folder is in the checkout, whatever project it belongs to, quick chats
//! included. `sessions list --worktree`, `worktrees list`, the delete's
//! preview and the delete itself all ask it, so what is listed is what goes.

use std::collections::BTreeSet;
use std::path::Path;

use serde::Serialize;

use crate::store::index::SessionEntry;

/// Whether two paths name the same folder, however they are spelled: through
/// a symlink, with a trailing slash or a `..`. A path that is not on disk
/// matches only itself, as written.
pub(crate) fn same_folder(a: &str, b: &str) -> bool {
    a == b
        || match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
}

/// How a session in a worktree stands to the worktree's project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Belonging {
    /// One of the project's own sessions: `sessions list --project` shows it.
    ThisProject,
    /// A session of another project that runs in this worktree.
    AnotherProject,
    /// A quick chat pointed at this worktree. It has no project.
    QuickChat,
}

/// A tab running something that deleting the worktree would stop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunningTab {
    pub id: String,
    pub harness: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// One session in a worktree as the CLI names it: enough to tell which
/// conversation it is without opening it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeSession {
    pub id: String,
    pub title: String,
    /// The project it belongs to; `None` for a quick chat.
    pub project: Option<String>,
    pub belongs_to: Belonging,
    /// Archived sessions show nowhere in the app, and go with the worktree too.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub archived: bool,
    /// Filled in only by the delete's preview.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub running_tabs: Vec<RunningTab>,
    /// Shells opened beside its tabs that are still running. Preview only.
    #[serde(skip_serializing_if = "is_zero")]
    pub running_shells: usize,
}

fn is_zero(count: &usize) -> bool {
    *count == 0
}

impl WorktreeSession {
    /// `session` as seen from a worktree of the project at `project`.
    pub(crate) fn of(session: &SessionEntry, project: &str) -> Self {
        let belongs_to = match session.project() {
            None => Belonging::QuickChat,
            Some(path) if same_folder(path, project) => Belonging::ThisProject,
            Some(_) => Belonging::AnotherProject,
        };
        Self {
            id: session.id.clone(),
            title: session.title.clone(),
            project: session.project().map(String::from),
            belongs_to,
            archived: session.archived,
            running_tabs: Vec::new(),
            running_shells: 0,
        }
    }

    /// The session for a person to read: id, title and where it belongs,
    /// then what it still runs.
    fn describe(&self) -> String {
        let place = match (self.belongs_to, self.project.as_deref()) {
            (Belonging::QuickChat, _) | (_, None) => "a quick chat, no project".to_string(),
            (Belonging::ThisProject, Some(project)) => crate::store::projects::project_name(project),
            (Belonging::AnotherProject, Some(project)) => format!("another project: {project}"),
        };
        let archived = if self.archived { ", archived" } else { "" };
        let mut text = format!("• {} \"{}\" ({place}{archived})", self.id, self.title);
        let mut running: Vec<String> = self
            .running_tabs
            .iter()
            .map(|tab| match &tab.title {
                Some(title) => format!("{} tab \"{title}\"", tab.harness),
                None => format!("{} tab", tab.harness),
            })
            .collect();
        if self.running_shells > 0 {
            running.push(plural(self.running_shells, "shell", "shells"));
        }
        if !running.is_empty() {
            text.push_str(&format!("\n  still running, would be stopped: {}", running.join(", ")));
        }
        text
    }
}

fn plural(count: usize, one: &str, many: &str) -> String {
    format!("{count} {}", if count == 1 { one } else { many })
}

/// The sessions among `sessions`, named as seen from a worktree of `project`.
pub(crate) fn summaries(sessions: &[SessionEntry], project: &str) -> Vec<WorktreeSession> {
    sessions.iter().map(|session| WorktreeSession::of(session, project)).collect()
}

fn listing(sessions: &[WorktreeSession]) -> String {
    if sessions.is_empty() {
        return "• (no sessions)".to_string();
    }
    sessions.iter().map(WorktreeSession::describe).collect::<Vec<_>>().join("\n")
}

/// What `worktrees delete` would do, worked out before anything is removed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeletePreview {
    /// Always true: this is what would happen, and nothing was removed.
    pub dry_run: bool,
    pub project: String,
    pub worktree: crate::workspaces::Workspace,
    /// The sessions that would be deleted, transcripts included.
    pub sessions: Vec<WorktreeSession>,
    /// The worktree's git state, checked as the delete checks it: the
    /// default branch is fetched first.
    pub landed: crate::landed::Landed,
    /// It is not clean and merged, so deleting it needs `--force` as well as
    /// `--yes`.
    pub needs_force: bool,
}

impl DeletePreview {
    pub(crate) fn new(project: &str, worktree: crate::workspaces::Workspace, sessions: Vec<WorktreeSession>, landed: crate::landed::Landed) -> Self {
        let needs_force = !landed.safe;
        Self { dry_run: true, project: project.to_string(), worktree, sessions, landed, needs_force }
    }

    /// The `--sessions` value that names exactly the sessions shown.
    pub(crate) fn sessions_flag(&self) -> String {
        let ids: Vec<&str> = self.sessions.iter().map(|session| session.id.as_str()).collect();
        if ids.is_empty() { "\"\"".to_string() } else { ids.join(",") }
    }

    /// The preview for a person to read.
    pub(crate) fn describe(&self) -> String {
        let mut out = vec![format!(
            "Deleting worktree {} ({}) would delete {}, transcripts included:",
            self.worktree.name,
            self.worktree.path,
            plural(self.sessions.len(), "session", "sessions"),
        )];
        out.push(listing(&self.sessions));
        let branch = self.landed.branch.as_deref().or(self.worktree.branch.as_deref());
        let branch = branch.map(|branch| format!("branch {branch}")).unwrap_or_else(|| "a detached HEAD".to_string());
        if self.needs_force {
            out.push(format!("Git: {branch}. Deleting it needs --force as well as --yes:"));
            out.extend(self.landed.losses.iter().map(|loss| format!("• {loss}")));
        } else {
            let base = self.landed.base.as_deref().unwrap_or("the default branch");
            out.push(format!("Git: {branch} is clean and merged into {base}."));
        }
        out.push("The branch itself is kept.".to_string());
        out.join("\n")
    }
}

/// How the refusal starts when `--sessions` does not name exactly the
/// sessions in the worktree.
pub(crate) const SESSIONS_DIFFER: &str = "The sessions in this worktree are not the ones --sessions names";

/// The full ids `--sessions` names, when they are exactly the sessions in
/// the worktree now. A name is a session's id, or the start of one that no
/// other session in the worktree shares. Otherwise the refusal says what
/// differs and what the worktree holds, and nothing may be removed: a
/// session the caller did not name is never deleted.
pub(crate) fn named_sessions(named: &[String], current: &[SessionEntry], project: &str) -> Result<Vec<String>, String> {
    let mut ids = BTreeSet::new();
    let (mut absent, mut ambiguous) = (Vec::new(), Vec::new());
    for name in named {
        let exact: Vec<&SessionEntry> = current.iter().filter(|session| session.id == *name).collect();
        let found = if exact.is_empty() { current.iter().filter(|session| session.id.starts_with(name.as_str())).collect() } else { exact };
        match found.as_slice() {
            [one] => {
                ids.insert(one.id.clone());
            }
            [] => absent.push(name.as_str()),
            _ => ambiguous.push(name.as_str()),
        }
    }
    let unnamed: Vec<SessionEntry> = current.iter().filter(|session| !ids.contains(&session.id)).cloned().collect();
    if absent.is_empty() && ambiguous.is_empty() && unnamed.is_empty() {
        return Ok(ids.into_iter().collect());
    }
    let mut out = vec![format!("{SESSIONS_DIFFER}. Nothing was removed.")];
    if !unnamed.is_empty() {
        out.push("In the worktree, not named:".to_string());
        out.push(listing(&summaries(&unnamed, project)));
    }
    if !absent.is_empty() {
        out.push(format!("Named, not in the worktree: {}", absent.join(", ")));
    }
    if !ambiguous.is_empty() {
        out.push(format!("Named, matching more than one of its sessions: {}", ambiguous.join(", ")));
    }
    out.push("It holds:".to_string());
    out.push(listing(&summaries(current, project)));
    Err(out.join("\n"))
}

/// The sessions among `sessions` that run in the worktree at `path`, by the
/// rule the delete uses.
pub(crate) fn sessions_in(sessions: &[SessionEntry], path: &str) -> Vec<SessionEntry> {
    crate::session_ops::sessions_within(sessions.to_vec(), Path::new(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, title: &str, project: &str, quick: bool) -> SessionEntry {
        let mut value = serde_json::json!({
            "id": id, "projectPath": project, "cwd": "/w", "title": title, "created": "x", "modified": "y",
        });
        if quick {
            value["kind"] = serde_json::json!("quick");
        }
        serde_json::from_value(value).unwrap()
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_is_the_same_however_it_is_spelled() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let (real, link) = (real.to_string_lossy().into_owned(), link.to_string_lossy().into_owned());
        assert!(same_folder(&real, &link));
        assert!(same_folder(&format!("{real}/"), &real));
        assert!(same_folder(&format!("{link}/../real"), &real));
        assert!(!same_folder(&real, &dir.path().to_string_lossy()));
        // Not on disk: only the same spelling.
        assert!(same_folder("/no/such/place", "/no/such/place"));
        assert!(!same_folder("/no/such/place/", "/no/such/place"));
    }

    #[test]
    fn each_session_says_whose_it_is() {
        let project = tempfile::tempdir().unwrap();
        let path = project.path().to_string_lossy().into_owned();
        let own = entry("a", "Own", &format!("{path}/"), false);
        let other = entry("b", "Other", "/elsewhere/api", false);
        let quick = entry("c", "Quick", "/scratch/c", true);
        let named = summaries(&[own, other, quick], &path);
        assert_eq!(named.iter().map(|s| s.belongs_to).collect::<Vec<_>>(), vec![Belonging::ThisProject, Belonging::AnotherProject, Belonging::QuickChat]);
        assert_eq!(named[2].project, None, "a quick chat has no project, whatever its folder");
        let json = serde_json::to_value(&named[1]).unwrap();
        assert_eq!(json, serde_json::json!({"id": "b", "title": "Other", "project": "/elsewhere/api", "belongsTo": "anotherProject"}));
        let text = listing(&named);
        assert!(text.contains("\"Other\" (another project: /elsewhere/api)"), "{text}");
        assert!(text.contains("\"Quick\" (a quick chat, no project)"), "{text}");
    }

    #[test]
    fn sessions_named_must_be_exactly_the_ones_there() {
        let current = vec![
            entry("01a1787e-0000-7000-8000-000000000001", "zero-comparison", "/p", false),
            entry("01a174ef-2919-7000-8000-000000000002", "#640 pipeline", "/p", false),
        ];
        let names = |list: &[&str]| list.iter().map(|name| name.to_string()).collect::<Vec<_>>();

        // Full ids, or the start of one only it has.
        let ids = named_sessions(&names(&["01a174ef-2919-7000-8000-000000000002", "01a1787e"]), &current, "/p").unwrap();
        assert_eq!(ids, vec!["01a174ef-2919-7000-8000-000000000002", "01a1787e-0000-7000-8000-000000000001"]);

        // One left out is named, and nothing may go.
        let error = named_sessions(&names(&["01a1787e"]), &current, "/p").unwrap_err();
        assert!(error.starts_with(SESSIONS_DIFFER), "{error}");
        let (missing, holds) = error.split_once("It holds:").unwrap();
        assert!(missing.contains("not named:\n• 01a174ef-2919-7000-8000-000000000002 \"#640 pipeline\""), "{error}");
        assert!(!missing.contains("zero-comparison"), "{error}");
        assert!(holds.contains("zero-comparison") && holds.contains("#640 pipeline"), "{error}");

        // One that is not there, or a start two share, is refused too.
        assert!(named_sessions(&names(&["01a1787e", "01a174ef", "gone"]), &current, "/p").unwrap_err().contains("Named, not in the worktree: gone"));
        assert!(named_sessions(&names(&["01a1"]), &current, "/p").unwrap_err().contains("more than one of its sessions: 01a1"));

        // Naming none expects none.
        assert_eq!(named_sessions(&[], &[], "/p").unwrap(), Vec::<String>::new());
        assert!(named_sessions(&[], &current, "/p").is_err());
    }
}
