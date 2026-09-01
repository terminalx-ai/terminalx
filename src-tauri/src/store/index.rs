//! The session index: one entry per session, each holding its tabs.
//!
//! A session is a place (a worktree or a project checkout) with a title; a tab
//! is one conversation with one agent in that place. The index is what the
//! sidebar draws and what resume reads, so it is written **before** any child
//! is spawned — a session whose agent fails to start is still visible.

use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum TabStatus {
    #[default]
    Idle,
    InProgress,
    /// Finished and not yet looked at.
    Completed,
    /// Waiting on the reader (permission or a question).
    Waiting,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabEntry {
    pub id: String,
    /// Harness name, kept verbatim so an entry written by a newer build survives.
    pub harness: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default = "default_mode")]
    pub permission_mode: String,
    /// The harness's own conversation id (Claude session id, Codex thread id).
    #[serde(default)]
    pub provider_session_id: Option<String>,
    #[serde(default)]
    pub status: TabStatus,
    pub created: String,
    #[serde(default)]
    pub modified: String,
    /// Context window occupancy as last reported, so the ring survives restart.
    #[serde(default)]
    pub context_used: Option<u64>,
    #[serde(default)]
    pub context_max: Option<u64>,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

fn default_mode() -> String {
    "auto".into()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub id: String,
    pub project_path: String,
    /// Where agents run. The worktree for a worktree session, else the project.
    pub cwd: String,
    #[serde(default)]
    pub worktree_name: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    /// Base the worktree forked from, for the first turn's changes baseline.
    #[serde(default)]
    pub base_ref: Option<String>,
    #[serde(default)]
    pub worktree_removed: bool,
    pub title: String,
    pub created: String,
    pub modified: String,
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub tabs: Vec<TabEntry>,
    #[serde(default)]
    pub active_tab: Option<String>,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

impl SessionEntry {
    pub fn tab(&self, tab_id: &str) -> Option<&TabEntry> {
        self.tabs.iter().find(|t| t.id == tab_id)
    }
    pub fn tab_mut(&mut self, tab_id: &str) -> Option<&mut TabEntry> {
        self.tabs.iter_mut().find(|t| t.id == tab_id)
    }
    /// A session is busy when any tab is.
    pub fn status(&self) -> TabStatus {
        let mut out = TabStatus::Idle;
        for t in &self.tabs {
            match t.status {
                TabStatus::Waiting => return TabStatus::Waiting,
                TabStatus::InProgress => out = TabStatus::InProgress,
                TabStatus::Completed if out == TabStatus::Idle => out = TabStatus::Completed,
                _ => {}
            }
        }
        out
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexFile {
    #[serde(default)]
    sessions: Vec<SessionEntry>,
}

fn file_path() -> Result<PathBuf> {
    Ok(super::sessions_dir()?.join("index.json"))
}

pub fn load() -> Result<Vec<SessionEntry>> {
    Ok(super::read_json::<IndexFile>(&file_path()?)?.unwrap_or_default().sessions)
}

pub fn save(sessions: &[SessionEntry]) -> Result<()> {
    super::write_json(&file_path()?, &IndexFile { sessions: sessions.to_vec() })
}

/// Apply `f` to the whole index under the write lock and persist it.
pub fn update<R>(f: impl FnOnce(&mut Vec<SessionEntry>) -> Result<R>) -> Result<R> {
    let mut sessions = load()?;
    let r = f(&mut sessions)?;
    save(&sessions)?;
    Ok(r)
}

pub fn get(session_id: &str) -> Result<SessionEntry> {
    load()?
        .into_iter()
        .find(|s| s.id == session_id)
        .ok_or_else(|| anyhow!("session {session_id} not found"))
}

pub fn update_session<R>(session_id: &str, f: impl FnOnce(&mut SessionEntry) -> Result<R>) -> Result<R> {
    update(|sessions| {
        let s = sessions
            .iter_mut()
            .find(|s| s.id == session_id)
            .ok_or_else(|| anyhow!("session {session_id} not found"))?;
        s.modified = now();
        f(s)
    })
}

pub fn update_tab<R>(session_id: &str, tab_id: &str, f: impl FnOnce(&mut TabEntry) -> Result<R>) -> Result<R> {
    update_session(session_id, |s| {
        let t = s.tab_mut(tab_id).ok_or_else(|| anyhow!("tab {tab_id} not found"))?;
        t.modified = now();
        f(t)
    })
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Worktree names taken by sessions that still hold (or lazily expect) one.
pub fn claimed_worktree_names(sessions: &[SessionEntry]) -> Vec<String> {
    sessions.iter().filter_map(|s| s.worktree_name.clone()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> SessionEntry {
        SessionEntry {
            id: id.into(),
            project_path: "/p".into(),
            cwd: "/p".into(),
            worktree_name: None,
            branch: None,
            base_ref: None,
            worktree_removed: false,
            title: "t".into(),
            created: now(),
            modified: now(),
            archived: false,
            pinned: false,
            tabs: vec![],
            active_tab: None,
            unknown: BTreeMap::new(),
        }
    }

    #[test]
    fn unknown_fields_survive_a_round_trip() {
        let _home = crate::store::temp_home();
        let raw = r#"{"sessions":[{"id":"a","projectPath":"/p","cwd":"/p","title":"t","created":"x","modified":"y","futureField":{"deep":true},"tabs":[{"id":"t1","harness":"claude","created":"x","extra":1}]}]}"#;
        std::fs::write(file_path().unwrap(), raw).unwrap();
        let loaded = load().unwrap();
        assert_eq!(loaded[0].unknown["futureField"]["deep"], true);
        assert_eq!(loaded[0].tabs[0].unknown["extra"], 1);
        save(&loaded).unwrap();
        let text = std::fs::read_to_string(file_path().unwrap()).unwrap();
        assert!(text.contains("futureField"));
        assert!(text.contains("\"extra\": 1"));
    }

    #[test]
    fn status_folds_across_tabs() {
        let mut s = entry("a");
        assert_eq!(s.status(), TabStatus::Idle);
        s.tabs.push(TabEntry {
            id: "1".into(),
            harness: "claude".into(),
            title: None,
            model: String::new(),
            effort: None,
            permission_mode: "auto".into(),
            provider_session_id: None,
            status: TabStatus::Completed,
            created: now(),
            modified: now(),
            context_used: None,
            context_max: None,
            unknown: BTreeMap::new(),
        });
        assert_eq!(s.status(), TabStatus::Completed);
        s.tabs[0].status = TabStatus::InProgress;
        s.tabs.push(s.tabs[0].clone());
        s.tabs[1].status = TabStatus::Waiting;
        assert_eq!(s.status(), TabStatus::Waiting);
    }

    #[test]
    fn update_session_touches_modified() {
        let _home = crate::store::temp_home();
        save(&[entry("a")]).unwrap();
        update_session("a", |s| {
            s.title = "renamed".into();
            Ok(())
        })
        .unwrap();
        assert_eq!(get("a").unwrap().title, "renamed");
        assert!(get("zzz").is_err());
    }
}
