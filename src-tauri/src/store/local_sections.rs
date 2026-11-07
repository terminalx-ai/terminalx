//! Personal sections span local projects and hold sessions, never branches.
//! Membership and section order share the session index's transaction lock.
use super::{load_file, update_file, IndexFile, SessionEntry};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSection {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(default)]
    pub sessions: Vec<String>,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SectionState {
    pub revision: u64,
    /// Array order is the reader's section order.
    pub sections: Vec<LocalSection>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SectionEdit {
    Create { name: String, emoji: Option<String>, #[serde(default)] session_ids: Vec<String> },
    Rename { id: String, name: String },
    Emoji { id: String, emoji: Option<String> },
    Delete { id: String },
    Reorder { id: String, by: i32 },
    Move { session_ids: Vec<String>, section_id: Option<String> },
}

fn snapshot(file: &IndexFile) -> SectionState {
    SectionState { revision: file.local_sections_revision, sections: file.local_sections.clone() }
}

pub fn load() -> Result<SectionState> {
    Ok(snapshot(&load_file()?))
}

fn name(value: String) -> Result<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 60 || value.chars().any(char::is_control) {
        bail!("Section names must contain 1 to 60 characters, without line breaks.");
    }
    Ok(value.into())
}

fn emoji(value: Option<String>) -> Result<Option<String>> {
    let value = value.map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    if value.as_ref().is_some_and(|value| value.chars().count() > 32 || value.chars().any(char::is_control)) {
        bail!("Choose a short emoji without line breaks.");
    }
    Ok(value)
}

fn position(file: &IndexFile, id: &str) -> Result<usize> {
    file.local_sections.iter().position(|section| section.id == id).ok_or_else(|| anyhow::anyhow!("This section no longer exists."))
}

fn move_sessions(file: &mut IndexFile, ids: &[String], target: Option<&str>) -> Result<()> {
    if let Some(id) = target { position(file, id)?; }
    if ids.iter().any(|id| !file.sessions.iter().any(|session| &session.id == id)) {
        bail!("One of these sessions no longer exists.");
    }
    for section in &mut file.local_sections {
        section.sessions.retain(|id| !ids.contains(id));
        if Some(section.id.as_str()) == target {
            for id in ids { if !section.sessions.contains(id) { section.sessions.push(id.clone()); } }
        }
    }
    Ok(())
}

pub fn edit(edit: SectionEdit) -> Result<SectionState> {
    update_file(|file| {
        match edit {
            SectionEdit::Create { name: value, emoji: mark, session_ids } => {
                let id = uuid::Uuid::now_v7().to_string();
                file.local_sections.push(LocalSection { id: id.clone(), name: name(value)?, emoji: emoji(mark)?, sessions: vec![], unknown: BTreeMap::new() });
                move_sessions(file, &session_ids, Some(&id))?;
            }
            SectionEdit::Rename { id, name: value } => {
                let at = position(file, &id)?;
                file.local_sections[at].name = name(value)?;
            }
            SectionEdit::Emoji { id, emoji: mark } => {
                let at = position(file, &id)?;
                file.local_sections[at].emoji = emoji(mark)?;
            }
            SectionEdit::Delete { id } => { let at = position(file, &id)?; file.local_sections.remove(at); }
            SectionEdit::Reorder { id, by } => {
                if ![-1, 1].contains(&by) { bail!("Move a section one place up or down."); }
                let at = position(file, &id)?;
                let to = at as i64 + i64::from(by);
                if to >= 0 && (to as usize) < file.local_sections.len() { file.local_sections.swap(at, to as usize); }
            }
            SectionEdit::Move { session_ids, section_id } => move_sessions(file, &session_ids, section_id.as_deref())?,
        }
        prune(file);
        file.local_sections_revision += 1;
        Ok(snapshot(file))
    })
}

/// Create the session and its membership in one commit. If its destination
/// was deleted while the composer was open, the session goes to the main list.
pub fn insert_session(entry: &SessionEntry, section_id: Option<&str>) -> Result<()> {
    update_file(|file| {
        file.sessions.push(entry.clone());
        if let Some(section) = file.local_sections.iter_mut().find(|section| Some(section.id.as_str()) == section_id) {
            section.sessions.push(entry.id.clone());
            file.local_sections_revision += 1;
        }
        Ok(())
    })
}

/// Session deletion prunes memberships; archival deliberately keeps them.
pub(super) fn prune(file: &mut IndexFile) {
    let live: HashSet<_> = file.sessions.iter().map(|session| session.id.as_str()).collect();
    let mut placed = HashSet::new();
    let mut changed = false;
    for section in &mut file.local_sections {
        let before = section.sessions.len();
        section.sessions.retain(|id| live.contains(id.as_str()) && placed.insert(id.clone()));
        changed |= before != section.sessions.len();
    }
    if changed { file.local_sections_revision += 1; }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session(id: &str, archived: bool) -> SessionEntry {
        serde_json::from_value(json!({ "id": id, "projectPath": format!("/{id}"), "cwd": format!("/{id}"), "title": id, "created": "before", "modified": "before", "archived": archived, "tabs": [] })).unwrap()
    }
    fn create(name: &str, ids: &[&str]) -> SectionState {
        edit(SectionEdit::Create { name: name.into(), emoji: Some("🚀".into()), session_ids: ids.iter().map(|id| (*id).into()).collect() }).unwrap()
    }

    #[test]
    fn old_index_migrates_without_changing_sessions_or_unknown_fields() {
        let _home = crate::store::temp_home();
        let entry = session("old", false);
        crate::store::write_json(&super::super::file_path().unwrap(), &json!({ "sessions": [entry], "future": 7 })).unwrap();
        assert!(load().unwrap().sections.is_empty());
        create("Release", &["old"]);
        let reopened = super::super::load_file().unwrap();
        assert_eq!(reopened.sessions, [entry]);
        assert_eq!(reopened.unknown["future"], 7);
        assert_eq!(reopened.local_sections[0].sessions, ["old"]);
    }

    #[test]
    fn edits_persist_order_membership_and_keep_deleted_sections_sessions_unchanged() {
        let _home = crate::store::temp_home();
        let entries = [session("one", false), session("two", true)];
        super::super::save(&entries).unwrap();
        let a = create(" Release ", &["one", "two"]).sections[0].id.clone();
        let b = create("Bugs", &[]).sections[1].id.clone();
        edit(SectionEdit::Rename { id: a.clone(), name: "Ship it".into() }).unwrap();
        edit(SectionEdit::Emoji { id: a.clone(), emoji: None }).unwrap();
        edit(SectionEdit::Move { session_ids: vec!["one".into(), "one".into()], section_id: Some(b.clone()) }).unwrap();
        edit(SectionEdit::Reorder { id: b.clone(), by: -1 }).unwrap();
        let reopened = load().unwrap();
        assert_eq!(reopened.sections[0].id, b);
        assert_eq!(reopened.sections[0].sessions, ["one"]);
        assert_eq!(reopened.sections[1].name, "Ship it");
        assert_eq!(reopened.sections[1].emoji, None);
        assert_eq!(reopened.sections[1].sessions, ["two"]);
        edit(SectionEdit::Delete { id: a }).unwrap();
        edit(SectionEdit::Move { session_ids: vec!["one".into()], section_id: None }).unwrap();
        assert!(load().unwrap().sections[0].sessions.is_empty());
        assert_eq!(super::super::load_file().unwrap().sessions, entries);
    }

    #[test]
    fn invalid_edits_commit_nothing_and_session_deletion_prunes_only_membership() {
        let _home = crate::store::temp_home();
        super::super::save(&[session("one", false)]).unwrap();
        let before = create("Release", &["one"]);
        for edit in [
            SectionEdit::Create { name: " ".into(), emoji: None, session_ids: vec![] },
            SectionEdit::Create { name: "Bugs".into(), emoji: None, session_ids: vec!["gone".into()] },
            SectionEdit::Move { session_ids: vec!["one".into()], section_id: Some("gone".into()) },
            SectionEdit::Move { session_ids: vec!["one".into(), "gone".into()], section_id: None },
            SectionEdit::Rename { id: before.sections[0].id.clone(), name: "x".repeat(61) },
        ] { assert!(super::edit(edit).is_err()); assert_eq!(load().unwrap(), before); }
        super::super::update(|entries| { entries.clear(); Ok(()) }).unwrap();
        let after = load().unwrap();
        assert!(after.sections[0].sessions.is_empty());
        assert!(after.revision > before.revision);
    }

    #[test]
    fn creation_membership_is_atomic_and_a_deleted_destination_falls_back_to_main_list() {
        let _home = crate::store::temp_home();
        let id = create("Release", &[]).sections[0].id.clone();
        insert_session(&session("one", false), Some(&id)).unwrap();
        assert_eq!(load().unwrap().sections[0].sessions, ["one"]);
        edit(SectionEdit::Delete { id: id.clone() }).unwrap();
        insert_session(&session("two", false), Some(&id)).unwrap();
        assert_eq!(super::super::load_file().unwrap().sessions.len(), 2);
        assert!(load().unwrap().sections.is_empty());
    }
}
