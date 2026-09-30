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
//! - **A custom API key** (`customApiKeyResponses.approved`): "Detected a
//!   custom API key in your environment" whenever `ANTHROPIC_API_KEY` is set
//!   and has never been answered. It is approved only when the reader has not
//!   refused it before and has no signed-in account the key would displace —
//!   on a cloud runtime the key is the machine's credential, not a choice.
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

fn config_path() -> Option<PathBuf> {
    match std::env::var("CLAUDE_CONFIG_DIR") {
        Ok(dir) if !dir.is_empty() => Some(PathBuf::from(dir).join(".claude.json")),
        _ => dirs::home_dir().map(|h| h.join(".claude.json")),
    }
}

/// What the CLI keeps of an API key to remember its answer: the last 20
/// characters of the trimmed key.
fn key_fingerprint(key: &str) -> String {
    let key = key.trim();
    let start = key.char_indices().rev().nth(19).map(|(i, _)| i).unwrap_or(0);
    key[start..].to_string()
}

fn string_list_contains(v: &Value, needle: &str) -> bool {
    v.as_array().is_some_and(|a| a.iter().any(|x| x.as_str() == Some(needle)))
}

/// The config with every first-run screen for `cwd` answered, or `None` when
/// nothing had to change.
fn prepared(mut config: Value, cwd: &str, api_key: Option<&str>) -> Option<Value> {
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

    if let Some(key) = api_key.map(str::trim).filter(|k| !k.is_empty()) {
        let fp = key_fingerprint(key);
        let responses = &config["customApiKeyResponses"];
        let answered = string_list_contains(&responses["approved"], &fp) || string_list_contains(&responses["rejected"], &fp);
        // A signed-in account is a billing choice the reader made; an env key
        // must not quietly take its place. The CLI will ask, and the tab says
        // so (see `pty::blocking_screen`).
        let signed_in = config["oauthAccount"].is_object();
        if !answered && !signed_in {
            if !config["customApiKeyResponses"].is_object() {
                config["customApiKeyResponses"] = json!({});
            }
            if !config["customApiKeyResponses"]["approved"].is_array() {
                config["customApiKeyResponses"]["approved"] = json!([]);
            }
            if !config["customApiKeyResponses"]["rejected"].is_array() {
                config["customApiKeyResponses"]["rejected"] = json!([]);
            }
            config["customApiKeyResponses"]["approved"].as_array_mut().expect("just made an array").push(json!(fp));
            changed = true;
        }
    }

    changed.then_some(config)
}

/// Answer the CLI's first-run screens for a launch in `cwd`: onboarding done,
/// `cwd` trusted, and the environment's API key approved where that is safe.
/// Creates the config when the CLI has never run on this machine.
pub fn prepare(cwd: &str) -> Result<()> {
    let Some(path) = config_path() else { return Ok(()) };
    let api_key = std::env::var("ANTHROPIC_API_KEY").ok();
    prepare_at(&path, cwd, api_key.as_deref())
}

fn prepare_at(path: &Path, cwd: &str, api_key: Option<&str>) -> Result<()> {
    let config: Value = match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).context("read the Claude Code config")?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e).context("read the Claude Code config"),
    };
    let Some(next) = prepared(config, cwd, api_key) else { return Ok(()) };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).context("create the Claude Code config directory")?;
    }
    // The CLI rewrites this file whole too, so the window for a lost write is
    // real but narrow: this only runs when a key is missing, which is once
    // per checkout, before that checkout's CLI has started.
    crate::store::write_atomic(path, &serde_json::to_vec_pretty(&next)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "sk-ant-api03-not-a-real-key-000000000abcdefghijklmnop";

    fn ready(cwd: &str) -> Value {
        json!({"hasCompletedOnboarding": true, "projects": {cwd: {"hasTrustDialogAccepted": true}}})
    }

    #[test]
    fn trusting_a_checkout_leaves_the_rest_of_the_config_alone() {
        let before: Value = serde_json::from_str(r#"{"numStartups":7,"hasCompletedOnboarding":true,"projects":{"/a":{"allowedTools":["Bash"],"hasTrustDialogAccepted":true}}}"#).unwrap();
        let after = prepared(before, "/b/worktree", None).unwrap();
        assert_eq!(after["numStartups"], 7);
        assert_eq!(after["projects"]["/a"]["allowedTools"][0], "Bash");
        assert_eq!(after["projects"]["/a"]["hasTrustDialogAccepted"], true);
        assert_eq!(after["projects"]["/b/worktree"]["hasTrustDialogAccepted"], true);
    }

    #[test]
    fn an_untrusted_entry_is_flipped_without_losing_its_other_keys() {
        let before: Value = serde_json::from_str(r#"{"hasCompletedOnboarding":true,"projects":{"/a":{"allowedTools":["Read"],"hasTrustDialogAccepted":false}}}"#).unwrap();
        let after = prepared(before, "/a", None).unwrap();
        assert_eq!(after["projects"]["/a"]["hasTrustDialogAccepted"], true);
        assert_eq!(after["projects"]["/a"]["allowedTools"][0], "Read");
    }

    #[test]
    fn a_config_the_cli_wrote_before_onboarding_is_finished_gets_past_the_theme_picker() {
        // What a fresh cloud VM held: the CLI's own bookkeeping, no onboarding.
        let before = json!({"numStartups": 1, "firstStartTime": "2026-09-30T00:00:00Z", "userID": "u", "migrationVersion": 14});
        let after = prepared(before, "/srv/terminalx/state/workspace", None).unwrap();
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
        let after = prepared(before, "/a", None).unwrap();
        assert_eq!(after["theme"], "light-daltonized");
        assert_eq!(after["hasCompletedOnboarding"], true);
    }

    #[test]
    fn an_already_prepared_config_is_not_rewritten() {
        assert!(prepared(ready("/a"), "/a", None).is_none());

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(&path, ready("/a").to_string()).unwrap();
        let before = std::fs::metadata(&path).unwrap().modified().unwrap();
        prepare_at(&path, "/a", None).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().modified().unwrap(), before);
    }

    #[test]
    fn a_missing_config_is_created_already_past_every_first_run_screen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/.claude.json");
        prepare_at(&path, "/a", None).unwrap();
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
        assert!(prepare_at(&path, "/a", None).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }

    #[test]
    fn the_environments_api_key_is_approved_by_the_fingerprint_the_cli_keeps() {
        assert_eq!(key_fingerprint(KEY), "0000abcdefghijklmnop");
        assert_eq!(key_fingerprint(&format!("  {KEY}\n")), &KEY[KEY.len() - 20..]);
        assert_eq!(key_fingerprint("short"), "short");

        let after = prepared(ready("/a"), "/a", Some(KEY)).unwrap();
        assert_eq!(after["customApiKeyResponses"]["approved"], json!([&KEY[KEY.len() - 20..]]));
        assert_eq!(after["customApiKeyResponses"]["rejected"], json!([]));
        // Answered once, never again.
        assert!(prepared(after, "/a", Some(KEY)).is_none());
    }

    #[test]
    fn a_refused_key_or_a_signed_in_reader_is_left_to_the_cli_to_ask() {
        let fp = &KEY[KEY.len() - 20..];
        let mut refused = ready("/a");
        refused["customApiKeyResponses"] = json!({"approved": [], "rejected": [fp]});
        assert!(prepared(refused, "/a", Some(KEY)).is_none());

        let mut signed_in = ready("/a");
        signed_in["oauthAccount"] = json!({"emailAddress": "someone@example.com"});
        assert!(prepared(signed_in, "/a", Some(KEY)).is_none());

        let mut other_keys = ready("/a");
        other_keys["customApiKeyResponses"] = json!({"approved": ["an-older-key-000000"], "rejected": ["another-one-0000000"]});
        let after = prepared(other_keys, "/a", Some(KEY)).unwrap();
        assert_eq!(after["customApiKeyResponses"]["approved"], json!(["an-older-key-000000", fp]));
        assert_eq!(after["customApiKeyResponses"]["rejected"], json!(["another-one-0000000"]));

        assert!(prepared(ready("/a"), "/a", Some("  ")).is_none(), "an empty key is no key");
    }
}
