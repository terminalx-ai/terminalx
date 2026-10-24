//! Serialize checkout admission with resolver reservations. A reservation is
//! persisted before the resolver's prompt is sent, and survives app restarts.
use std::sync::{Mutex, MutexGuard};
use anyhow::{bail, Result};
use crate::store::index;

static ADMISSION: Mutex<()> = Mutex::new(());
pub fn lock() -> MutexGuard<'static, ()> {
    ADMISSION.lock().unwrap_or_else(|error| error.into_inner())
}

fn same_checkout(a: &str, b: &str) -> bool {
    let normalized = |path: &str| std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path));
    normalized(a) == normalized(b)
}

/// Called under the admission lock before dispatching a new prompt.
pub fn check(session_id: &str, tab_id: &str) -> Result<()> {
    let reservations: Vec<_> = super::store::list()?.into_iter()
        .filter(|pipeline| pipeline.checking_locally || pipeline.resolution.is_some()).collect();
    // Ordinary hooks also serve live conversations before index persistence.
    // There is no checkout restriction to enforce without a reservation.
    if reservations.is_empty() { return Ok(()); }
    let session = index::get(session_id)?;
    for pipeline in reservations {
        if pipeline.checking_locally && same_checkout(&index::get(&pipeline.author.session_id)?.cwd, &session.cwd) {
            bail!("TerminalX is running checks on this checkout. Wait for them to finish before starting another turn.");
        }
        if pipeline.resolution.is_none() { continue; }
        let Some(resolver) = pipeline.resolver.as_ref() else { continue };
        if resolver.session_id == session_id && resolver.tab_id == tab_id { continue; }
        let owner = index::get(&pipeline.author.session_id)?;
        if same_checkout(&owner.cwd, &session.cwd) {
            bail!("This checkout is reserved for conflict resolution. Wait for the resolver to finish before starting another turn.");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::issue_pipeline::{Pipeline, Resolution, SessionRef, Stage};

    #[test]
    fn no_reservation_leaves_unindexed_live_conversations_alone() {
        let _home = crate::store::temp_home();
        assert!(check("live-before-index", "t1").is_ok());
    }

    #[test]
    fn a_reservation_excludes_other_conversations_but_allows_its_resolver() {
        let _home = crate::store::temp_home();
        let session = |id: &str, cwd: &str| serde_json::from_value(serde_json::json!({
            "id": id, "projectPath": "/repo", "cwd": cwd, "title": id,
            "created": "2026-10-24T00:00:00Z", "modified": "2026-10-24T00:00:00Z",
            "tabs": [{"id":"t1", "harness":"claude", "created":"2026-10-24T00:00:00Z"}]
        })).unwrap();
        index::save(&[session("author", "/checkout"), session("other", "/checkout"), session("elsewhere", "/another")]).unwrap();
        let mut pipeline: Pipeline = serde_json::from_str(include_str!("../fixtures/issue_pipeline.json")).unwrap();
        pipeline.author = SessionRef { session_id: "author".into(), tab_id: "t1".into() };
        pipeline.resolver = Some(SessionRef { session_id: "author".into(), tab_id: "resolver".into() });
        pipeline.resolution = Some(Resolution { head: "head".into(), remote_head: None, base: "main".into(), base_commit: "base".into(), return_stage: Stage::Work });
        super::super::store::insert(&pipeline).unwrap();
        assert!(check("author", "t1").is_err());
        assert!(check("other", "t1").is_err());
        assert!(check("author", "resolver").is_ok());
        assert!(check("elsewhere", "t1").is_ok());
        pipeline.resolution = None;
        pipeline.checking_locally = true;
        super::super::store::commit(&mut pipeline).unwrap();
        assert!(check("author", "resolver").is_err());
        pipeline.checking_locally = false;
        super::super::store::commit(&mut pipeline).unwrap();
        assert!(check("other", "t1").is_ok());
    }
}
