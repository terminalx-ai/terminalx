//! Workspace trust and the CLI's other first-run screens.
//!
//! The interactive CLI stops on a full-screen question before its composer in
//! a few situations, and each one would take the first prompt instead of the
//! composer while the reader looking at the chat never saw it:
//!
//! - **Onboarding** (`hasCompletedOnboarding`): the "Let's get started. Choose
//!   the text style…" theme picker on a machine that has never finished it —
//!   every fresh cloud VM. The CLI falls back to its default theme when none
//!   is set, so only the flag is needed and a reader's own `theme` is never
//!   touched.
//! - **Workspace trust** (`projects[<dir>].hasTrustDialogAccepted`): asked the
//!   first time the CLI runs anywhere new, and a session's worktree is always
//!   somewhere new. The reader adopted the checkout when they made the session.
//!
//! Other screens — "Detected a custom API key" when `ANTHROPIC_API_KEY` is
//! set, a login prompt — are the reader's to answer and are left alone; the
//! tab says so if one is showing (`pty::blocking_screen`).
//!
//! Bypass-permissions acceptance is not kept here: it is said per launch in
//! the `--settings` payload (`pty::launch_command`), because the reader
//! accepted it in the app's own dialog for that tab, not for every CLI.
//!
//! Every key above was read out of the installed CLI (2.1.285) and probed in
//! a PTY against an empty config dir. Nothing else in the file is touched.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde_json::{json, Value};

/// The CLI's config file, and the directory it keeps timestamped backups of
/// that file in.
fn config_paths() -> Option<(PathBuf, PathBuf)> {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => {
            let dir = PathBuf::from(dir);
            Some((dir.join(".claude.json"), dir.join("backups")))
        }
        _ => dirs::home_dir().map(|h| (h.join(".claude.json"), h.join(".claude").join("backups"))),
    }
}

/// Whether the CLI has a backup it would offer to restore a missing config
/// from. It looks for `<name>.backup.<stamp>` in its backups directory and
/// beside the config, and for a plain `<name>.backup` (read out of 2.1.285).
fn has_backup(path: &Path, backups: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    let stamped = format!("{name}.backup.");
    let any_stamped = |dir: &Path| {
        std::fs::read_dir(dir).is_ok_and(|entries| entries.flatten().any(|e| e.file_name().to_str().is_some_and(|n| n.starts_with(&stamped))))
    };
    any_stamped(backups) || path.parent().is_some_and(any_stamped) || path.with_file_name(format!("{name}.backup")).exists()
}

/// Held across the whole read-change-write of the config. Tabs launch in
/// parallel, and two new worktrees preparing at once would otherwise each
/// write back the file they read, dropping the other's trust entry.
static PREPARE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The config with every first-run screen for `cwd` answered, or `None` when
/// nothing had to change.
fn prepared(mut config: Value, cwd: &str) -> Option<Value> {
    if !config.is_object() {
        config = json!({});
    }
    let mut changed = false;

    if config["hasCompletedOnboarding"] != json!(true) {
        config["hasCompletedOnboarding"] = json!(true);
        changed = true;
    }

    if config["projects"][cwd]["hasTrustDialogAccepted"] != json!(true) {
        if !config["projects"].is_object() {
            config["projects"] = json!({});
        }
        if !config["projects"][cwd].is_object() {
            config["projects"][cwd] = json!({});
        }
        config["projects"][cwd]["hasTrustDialogAccepted"] = json!(true);
        changed = true;
    }

    changed.then_some(config)
}

/// Answer the CLI's first-run screens for a launch in `cwd`: onboarding done,
/// `cwd` trusted.
/// Creates the config when the CLI has never run on this machine.
pub fn prepare(cwd: &str) -> Result<()> {
    let Some((path, backups)) = config_paths() else { return Ok(()) };
    prepare_at(&path, &backups, cwd)
}

fn prepare_at(path: &Path, backups: &Path, cwd: &str) -> Result<()> {
    let _held = PREPARE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let config: Value = match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).context("read the Claude Code config")?,
        // A lost config with a backup is the CLI's to restore: it offers to,
        // and a stub written here would hide that. Only a machine with no
        // config and no backup — a fresh one — is given a new file.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && has_backup(path, backups) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e).context("read the Claude Code config"),
    };
    let Some(next) = prepared(config, cwd) else { return Ok(()) };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context("create the Claude Code config directory")?;
    }
    // The CLI rewrites this file whole too, so the window for a lost write
    // against *it* is real but narrow: this only runs when a key is missing,
    // which is once per checkout, before that checkout's CLI has started.
    crate::store::write_atomic(path, &serde_json::to_vec_pretty(&next)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(cwd: &str) -> Value {
        json!({"hasCompletedOnboarding": true, "projects": {cwd: {"hasTrustDialogAccepted": true}}})
    }

    #[test]
    fn trusting_a_checkout_leaves_the_rest_of_the_config_alone() {
        let before: Value = serde_json::from_str(r#"{"numStartups":7,"hasCompletedOnboarding":true,"projects":{"/a":{"allowedTools":["Bash"],"hasTrustDialogAccepted":true}}}"#).unwrap();
        let after = prepared(before, "/b/worktree").unwrap();
        assert_eq!(after["numStartups"], 7);
        assert_eq!(after["projects"]["/a"]["allowedTools"][0], "Bash");
        assert_eq!(after["projects"]["/a"]["hasTrustDialogAccepted"], true);
        assert_eq!(after["projects"]["/b/worktree"]["hasTrustDialogAccepted"], true);
    }

    #[test]
    fn an_untrusted_entry_is_flipped_without_losing_its_other_keys() {
        let before: Value = serde_json::from_str(r#"{"hasCompletedOnboarding":true,"projects":{"/a":{"allowedTools":["Read"],"hasTrustDialogAccepted":false}}}"#).unwrap();
        let after = prepared(before, "/a").unwrap();
        assert_eq!(after["projects"]["/a"]["hasTrustDialogAccepted"], true);
        assert_eq!(after["projects"]["/a"]["allowedTools"][0], "Read");
    }

    #[test]
    fn a_config_the_cli_wrote_before_onboarding_is_finished_gets_past_the_theme_picker() {
        // What a fresh cloud VM held: the CLI's own bookkeeping, no onboarding.
        let before = json!({"numStartups": 1, "firstStartTime": "2026-09-30T00:00:00Z", "userID": "u", "migrationVersion": 14});
        let after = prepared(before, "/srv/terminalx/state/workspace").unwrap();
        assert_eq!(after["hasCompletedOnboarding"], true);
        assert_eq!(after["projects"]["/srv/terminalx/state/workspace"]["hasTrustDialogAccepted"], true);
        assert_eq!(after["userID"], "u");
        assert_eq!(after["migrationVersion"], 14);
        // The CLI defaults the theme itself; none is invented.
        assert!(after.get("theme").is_none());
    }

    #[test]
    fn a_readers_theme_is_never_touched() {
        let mut before = json!({"theme": "light-daltonized", "hasCompletedOnboarding": false});
        before["projects"] = json!({"/a": {"hasTrustDialogAccepted": true}});
        let after = prepared(before, "/a").unwrap();
        assert_eq!(after["theme"], "light-daltonized");
        assert_eq!(after["hasCompletedOnboarding"], true);
    }

    #[test]
    fn an_already_prepared_config_is_not_rewritten() {
        assert!(prepared(ready("/a"), "/a").is_none());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(&path, ready("/a").to_string()).unwrap();
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        prepare_at(&path, &dir.path().join("backups"), "/a").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn a_missing_config_is_created_already_past_every_first_run_screen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/.claude.json");
        prepare_at(&path, &dir.path().join("backups"), "/a").unwrap();
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written, ready("/a"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o077, 0, "the config is private");
        }
    }

    #[test]
    fn an_unreadable_config_is_an_error_not_an_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(prepare_at(&path, &dir.path().join("backups"), "/a").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn existing_api_key_answers_are_left_exactly_as_they_are() {
        let mut before = json!({"customApiKeyResponses": {"approved": ["a-key-000000000000"], "rejected": ["b-key-000000000000"]}});
        before["oauthAccount"] = json!({"emailAddress": "someone@example.com"});
        let after = prepared(before.clone(), "/a").unwrap();
        assert_eq!(after["customApiKeyResponses"], before["customApiKeyResponses"]);
        assert_eq!(after["oauthAccount"], before["oauthAccount"]);
        // Nothing is ever added for a key in the environment.
        assert!(prepared(ready("/a"), "/a").is_none());
    }

    #[test]
    fn parallel_launches_keep_every_checkouts_trust() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(&path, json!({"numStartups": 3}).to_string()).unwrap();
        let backups = dir.path().join("backups");
        let cwds: Vec<String> = (0..16).map(|i| format!("/w/{i}")).collect();
        std::thread::scope(|scope| {
            for cwd in &cwds {
                let (path, backups) = (&path, &backups);
                scope.spawn(move || prepare_at(path, backups, cwd).unwrap());
            }
        });
        let written: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for cwd in &cwds {
            assert_eq!(written["projects"][cwd]["hasTrustDialogAccepted"], true, "{cwd} lost its trust entry");
        }
        assert_eq!(written["numStartups"], 3);
    }

    #[test]
    fn a_missing_config_with_a_backup_is_left_for_the_cli_to_restore() {
        // The CLI's timestamped backups, in its backups directory or beside
        // the config, and its plain `.backup` file each count.
        for place in ["backups/.claude.json.backup.1790000000000", ".claude.json.backup.1790000000000", ".claude.json.backup"] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(".claude.json");
            let backup = dir.path().join(place);
            std::fs::create_dir_all(backup.parent().unwrap()).unwrap();
            std::fs::write(&backup, "{}").unwrap();
            prepare_at(&path, &dir.path().join("backups"), "/a").unwrap();
            assert!(!path.exists(), "a stub would hide the restore of {place}");
        }
        // Something else in the backups directory is not a config backup.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("backups")).unwrap();
        std::fs::write(dir.path().join("backups/other.json"), "{}").unwrap();
        let path = dir.path().join(".claude.json");
        prepare_at(&path, &dir.path().join("backups"), "/a").unwrap();
        assert!(path.exists());
    }
}
