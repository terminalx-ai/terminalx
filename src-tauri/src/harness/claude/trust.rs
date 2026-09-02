//! Workspace trust.
//!
//! The interactive CLI asks "is this a folder you trust?" the first time it
//! runs anywhere new, and a session's worktree is always somewhere new. That
//! dialog would take the first prompt instead of the composer, and the reader
//! looking at the chat would never see it.
//!
//! The CLI names the alternative itself: `projects[<dir>].hasTrustDialogAccepted`
//! in its config. Raccoon sets it for a checkout the reader has already
//! adopted — they added the project and asked for the session — and touches
//! nothing else in the file.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{json, Value};

fn config_path() -> Option<PathBuf> {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => Some(PathBuf::from(dir).join(".claude.json")),
        _ => dirs::home_dir().map(|h| h.join(".claude.json")),
    }
}

/// The config with `cwd` trusted, or `None` when it already was.
fn trusting(mut config: Value, cwd: &str) -> Option<Value> {
    if config["projects"][cwd]["hasTrustDialogAccepted"] == json!(true) {
        return None;
    }
    if !config["projects"].is_object() {
        config["projects"] = json!({});
    }
    if !config["projects"][cwd].is_object() {
        config["projects"][cwd] = json!({});
    }
    config["projects"][cwd]["hasTrustDialogAccepted"] = json!(true);
    Some(config)
}

/// Mark `cwd` trusted if it is not already. Does nothing when the CLI has no
/// config yet — there is no file to add a project to, and the dialog on a
/// first-ever run is the reader's to answer.
pub fn ensure_trusted(cwd: &str) -> Result<()> {
    let Some(path) = config_path() else { return Ok(()) };
    ensure_trusted_at(&path, cwd)
}

fn ensure_trusted_at(path: &Path, cwd: &str) -> Result<()> {
    let Ok(text) = std::fs::read_to_string(path) else { return Ok(()) };
    let config: Value = serde_json::from_str(&text).context("read the Claude Code config")?;
    let Some(next) = trusting(config, cwd) else { return Ok(()) };
    // The CLI rewrites this file whole too, so the window for a lost write is
    // real but narrow: this only runs when the key is missing, which is once
    // per checkout, before that checkout's CLI has started.
    crate::store::write_atomic(path, &serde_json::to_vec_pretty(&next)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusting_a_checkout_leaves_the_rest_of_the_config_alone() {
        let before: Value = serde_json::from_str(r#"{"numStartups":7,"projects":{"/a":{"allowedTools":["Bash"],"hasTrustDialogAccepted":true}}}"#).unwrap();
        let after = trusting(before, "/b/worktree").unwrap();
        assert_eq!(after["numStartups"], 7);
        assert_eq!(after["projects"]["/a"]["allowedTools"][0], "Bash");
        assert_eq!(after["projects"]["/a"]["hasTrustDialogAccepted"], true);
        assert_eq!(after["projects"]["/b/worktree"]["hasTrustDialogAccepted"], true);
    }

    #[test]
    fn an_untrusted_entry_is_flipped_without_losing_its_other_keys() {
        let before: Value = serde_json::from_str(r#"{"projects":{"/a":{"allowedTools":["Read"],"hasTrustDialogAccepted":false}}}"#).unwrap();
        let after = trusting(before, "/a").unwrap();
        assert_eq!(after["projects"]["/a"]["hasTrustDialogAccepted"], true);
        assert_eq!(after["projects"]["/a"]["allowedTools"][0], "Read");
    }

    #[test]
    fn a_config_with_no_projects_gains_one() {
        let after = trusting(json!({"theme": "dark"}), "/a").unwrap();
        assert_eq!(after["theme"], "dark");
        assert_eq!(after["projects"]["/a"]["hasTrustDialogAccepted"], true);
    }

    #[test]
    fn an_already_trusted_checkout_is_not_rewritten() {
        let before: Value = serde_json::from_str(r#"{"projects":{"/a":{"hasTrustDialogAccepted":true}}}"#).unwrap();
        assert!(trusting(before, "/a").is_none());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(&path, r#"{"projects":{"/a":{"hasTrustDialogAccepted":true}}}"#).unwrap();
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        ensure_trusted_at(&path, "/a").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn a_missing_config_is_left_for_the_cli_to_create() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        assert!(ensure_trusted_at(&path, "/a").is_ok());
        assert!(!path.exists());
    }
}
