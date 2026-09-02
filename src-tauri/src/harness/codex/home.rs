//! The Codex home Raccoon runs its tabs in.
//!
//! Codex has no `--settings`: hooks are read from `$CODEX_HOME/hooks.json`,
//! and each of them only runs if `$CODEX_HOME/config.toml` holds a hash for
//! it. Installing that in the reader's own `~/.codex` would edit two files
//! Raccoon does not own and would fire our hooks at every `codex` they run in
//! their own terminal, so Raccoon keeps a home of its own at
//! `$RACCOON_HOME/codex` and points `CODEX_HOME` at it.
//!
//! A separate home must not become a separate Codex. It gets:
//!
//! - **the same account** — `auth.json` is a symlink to the reader's, so a
//!   login (or a refreshed token) is shared and no credential is ever copied;
//! - **the same content** — `skills`, `prompts`, `plugins` and `AGENTS.md`
//!   are symlinks too;
//! - **the same settings**, for an explicit list of `config.toml` keys.
//!   `notify` is deliberately not among them (it runs the reader's own
//!   desktop helper, which has nothing to do with a Raccoon tab), nor is
//!   `projects` (Raccoon trusts only the checkouts it opened).
//!
//! Nothing here writes to the reader's home. It is only ever read.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// `config.toml` keys carried over from the reader's home. Everything not
/// named here is either Raccoon's own (`hooks`, `projects`) or something that
/// should not follow a tab (`notify`, `desktop`).
const MIRRORED: &[&str] = &[
    "model",
    "model_reasoning_effort",
    "model_reasoning_summary",
    "model_verbosity",
    "model_provider",
    "model_providers",
    "personality",
    "approvals_reviewer",
    "features",
    "mcp_servers",
    "plugins",
    "marketplaces",
    "history",
    "shell_environment_policy",
    "tui",
    "notice",
];

/// Things a tab should see that live as files, linked rather than copied so
/// the reader editing them takes effect at once.
const LINKED: &[&str] = &["auth.json", "AGENTS.md", "skills", "prompts", "plugins"];

/// What Raccoon remembers about the home it built, so a tab starting does not
/// have to ask Codex anything when nothing has changed.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    /// Digest of the `hooks.json` the trust below was computed for.
    hooks_digest: String,
    /// `hooks.state` key → `trusted_hash`, exactly as Codex named them.
    trust: BTreeMap<String, String>,
}

pub fn managed_root() -> Result<PathBuf> {
    crate::store::ensure_dir(crate::store::root()?.join("codex"))
}

/// The reader's own Codex home: `$CODEX_HOME`, else `~/.codex`.
pub fn user_root() -> Option<PathBuf> {
    match std::env::var("CODEX_HOME") {
        Ok(p) if !p.trim().is_empty() => Some(PathBuf::from(p)),
        _ => dirs::home_dir().map(|h| h.join(".codex")),
    }
}

fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

// ----------------------------------------------------------------- the config

/// The managed `config.toml`: the mirrored keys, the checkouts Raccoon has
/// opened marked trusted, and the hook trust Codex asked for.
///
/// Trust is per checkout and additive: a home that already trusts three
/// worktrees keeps all three when a fourth tab opens.
pub fn mirrored_config(user_toml: &str, previous: &str, cwd: &str, trust: &BTreeMap<String, String>) -> Result<String> {
    let user: toml::Table = toml::from_str(user_toml).unwrap_or_default();
    let old: toml::Table = toml::from_str(previous).unwrap_or_default();
    let mut out = toml::Table::new();
    for key in MIRRORED {
        if let Some(v) = user.get(*key) {
            out.insert((*key).to_string(), v.clone());
        }
    }

    let mut projects = old.get("projects").and_then(|p| p.as_table()).cloned().unwrap_or_default();
    let mut entry = toml::Table::new();
    entry.insert("trust_level".into(), toml::Value::String("trusted".into()));
    projects.insert(cwd.to_string(), toml::Value::Table(entry));
    out.insert("projects".into(), toml::Value::Table(projects));

    let mut state = toml::Table::new();
    for (key, hash) in trust {
        let mut entry = toml::Table::new();
        entry.insert("trusted_hash".into(), toml::Value::String(hash.clone()));
        state.insert(key.clone(), toml::Value::Table(entry));
    }
    let mut hooks = toml::Table::new();
    hooks.insert("state".into(), toml::Value::Table(state));
    out.insert("hooks".into(), toml::Value::Table(hooks));

    Ok(format!("# Written by Raccoon. Edit ~/.codex/config.toml instead.\n\n{}", toml::to_string_pretty(&out)?))
}

// ------------------------------------------------------------------ hook trust

/// The `hooks.state` entries for our own hooks, out of a `hooks/list` reply.
///
/// Codex computes the hash; replicating it would be one more thing to get
/// wrong on every upgrade. Only hooks that came from the file Raccoon wrote
/// are trusted — a hook discovered anywhere else is not ours to vouch for.
pub fn trust_entries(result: &Value, hooks_file: &Path) -> BTreeMap<String, String> {
    let ours = hooks_file.to_string_lossy();
    let mut out = BTreeMap::new();
    for group in result["data"].as_array().into_iter().flatten() {
        for hook in group["hooks"].as_array().into_iter().flatten() {
            let (Some(key), Some(hash)) = (hook["key"].as_str(), hook["currentHash"].as_str()) else { continue };
            if hook["sourcePath"].as_str() != Some(ours.as_ref()) {
                continue;
            }
            out.insert(key.to_string(), hash.to_string());
        }
    }
    out
}

// ------------------------------------------------------------------- rollouts

/// The rollout file for a conversation, under `<home>/sessions/YYYY/MM/DD/`.
/// The name ends `-<session id>.jsonl`, which is what identifies it; the
/// timestamp in front only orders the directory.
pub fn find_rollout(home: &Path, session_id: &str) -> Option<PathBuf> {
    let suffix = format!("-{session_id}.jsonl");
    let mut found: Option<PathBuf> = None;
    let sessions = home.join("sessions");
    for year in read_dir(&sessions) {
        for month in read_dir(&year) {
            for day in read_dir(&month) {
                for file in read_dir(&day) {
                    if file.file_name().is_some_and(|n| n.to_string_lossy().ends_with(&suffix)) {
                        found = Some(file);
                    }
                }
            }
        }
    }
    found
}

fn read_dir(path: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = std::fs::read_dir(path).into_iter().flatten().flatten().map(|e| e.path()).collect();
    v.sort();
    v
}

/// Bring a conversation started before Raccoon managed a home into it.
///
/// Tabs made by the old headless engine hold a thread id whose rollout is in
/// the reader's `~/.codex/sessions`, where a `codex resume` run against the
/// managed home will not look. The file is *copied*, not linked or moved: the
/// resumed conversation carries on in Raccoon's home and the reader's own
/// copy is left exactly as it was.
///
/// Returns true when a copy was made.
pub fn adopt_rollout(managed: &Path, user: &Path, session_id: &str) -> Result<bool> {
    if find_rollout(managed, session_id).is_some() {
        return Ok(false);
    }
    let Some(source) = find_rollout(user, session_id) else { return Ok(false) };
    let relative = source.strip_prefix(user).unwrap_or(&source);
    let target = managed.join(relative);
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    std::fs::copy(&source, &target).with_context(|| format!("copy {} into the managed Codex home", source.display()))?;
    Ok(true)
}

// -------------------------------------------------------------------- linking

/// Point `<managed>/<name>` at the reader's copy. A link already pointing
/// there is left alone; anything else in the way is replaced, because the
/// only thing that puts a file there is this function.
#[cfg(unix)]
fn link(managed: &Path, user: &Path, name: &str) -> Result<()> {
    let source = user.join(name);
    if !source.exists() {
        return Ok(());
    }
    let target = managed.join(name);
    if std::fs::read_link(&target).is_ok_and(|t| t == source) {
        return Ok(());
    }
    if target.exists() || target.symlink_metadata().is_ok() {
        let _ = std::fs::remove_file(&target);
        let _ = std::fs::remove_dir_all(&target);
    }
    std::os::unix::fs::symlink(&source, &target).with_context(|| format!("link {name} into the managed Codex home"))
}

#[cfg(not(unix))]
fn link(managed: &Path, user: &Path, name: &str) -> Result<()> {
    let source = user.join(name);
    if !source.exists() || source.is_dir() {
        return Ok(());
    }
    std::fs::copy(&source, managed.join(name))?;
    Ok(())
}

// ------------------------------------------------------------------- updates

/// Stop the TUI's "Update available" dialog from taking the first prompt.
///
/// When Codex has already seen that a newer version exists it opens a modal
/// on startup whose default choice is "Update now", so the Enter that submits
/// the first prompt runs `npm install -g @openai/codex` instead. Recording
/// the version it found as dismissed — the same thing its own "Skip until
/// next version" option does — leaves a passive banner and no modal. This is
/// written only inside the managed home; a `codex` the reader runs themselves
/// still offers them the update.
fn dismiss_update_prompt(managed: &Path) {
    let path = managed.join("version.json");
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let Ok(mut v) = serde_json::from_str::<Value>(&text) else { return };
    let Some(latest) = v["latest_version"].as_str().map(String::from) else { return };
    if v["dismissed_version"].as_str() == Some(&latest) {
        return;
    }
    v["dismissed_version"] = json!(latest);
    if let Ok(bytes) = serde_json::to_vec_pretty(&v) {
        let _ = crate::store::write_atomic(&path, &bytes);
    }
}

// ------------------------------------------------------------------- assembly

/// Build (or refresh) the managed home for a tab about to run in `cwd`, and
/// return the path to put in `CODEX_HOME`.
///
/// Asking Codex for the hook hashes costs a short-lived child, so it only
/// happens when `hooks.json` has actually changed — which is when Raccoon
/// moves, or is upgraded, and not on every tab.
pub fn prepare(cwd: &str, exe: &Path) -> Result<PathBuf> {
    let managed = managed_root()?;
    if let Some(user) = user_root().filter(|u| u.is_dir()) {
        for name in LINKED {
            if let Err(e) = link(&managed, &user, name) {
                log::warn!("codex home: {e:#}");
            }
        }
    }

    let hooks_path = managed.join("hooks.json");
    let hooks = serde_json::to_vec_pretty(&super::pty::hooks_json(exe))?;
    if std::fs::read(&hooks_path).ok().as_deref() != Some(hooks.as_slice()) {
        crate::store::write_atomic(&hooks_path, &hooks)?;
    }

    let state_path = managed.join("raccoon-state.json");
    let mut state: State = std::fs::read_to_string(&state_path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let want = digest(&hooks);

    let config_path = managed.join("config.toml");
    let previous = std::fs::read_to_string(&config_path).unwrap_or_default();
    let user_toml = user_root().map(|u| u.join("config.toml")).and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
    // The config has to exist before Codex is asked about the home, because
    // discovery reads it; the hook trust is filled in on the second write.
    crate::store::write_atomic(&config_path, mirrored_config(&user_toml, &previous, cwd, &state.trust)?.as_bytes())?;

    if state.hooks_digest != want || state.trust.is_empty() {
        match super::appserver::ask(
            super::appserver::Where { codex_home: Some(&managed), cwd: Some(Path::new(cwd)) },
            "hooks/list",
            json!({}),
        ) {
            Ok(result) => {
                let trust = trust_entries(&result, &hooks_path);
                if trust.is_empty() {
                    log::warn!("codex named no hooks of ours; the tab will run without status or permission cards");
                } else {
                    state = State { hooks_digest: want, trust };
                    let previous = std::fs::read_to_string(&config_path).unwrap_or_default();
                    crate::store::write_atomic(&config_path, mirrored_config(&user_toml, &previous, cwd, &state.trust)?.as_bytes())?;
                    let _ = crate::store::write_json(&state_path, &state);
                }
            }
            // Without trust Codex simply skips the hooks: the CLI still runs
            // and the terminal view is unaffected, the chat just loses status
            // and permission cards.
            Err(e) => log::warn!("could not trust the Codex hooks ({e:#}); this tab runs without them"),
        }
    }

    dismiss_update_prompt(&managed);
    Ok(managed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trust() -> BTreeMap<String, String> {
        BTreeMap::from([("/h/hooks.json:stop:0:0".to_string(), "sha256:abc".to_string())])
    }

    #[test]
    fn mirroring_carries_settings_but_not_the_readers_notifier_or_trust() {
        let user = r#"
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
notify = ["/Applications/Something.app/helper", "turn-ended"]

[features]
steer = true

[projects."/Users/x/secret"]
trust_level = "trusted"

[mcp_servers.docs]
url = "https://example.test/mcp"
"#;
        let out = mirrored_config(user, "", "/w/one", &trust()).unwrap();
        let t: toml::Table = toml::from_str(&out).unwrap();
        assert_eq!(t["model"].as_str(), Some("gpt-5.6-sol"));
        assert_eq!(t["model_reasoning_effort"].as_str(), Some("xhigh"));
        assert_eq!(t["features"]["steer"].as_bool(), Some(true));
        assert!(t["mcp_servers"]["docs"]["url"].is_str());
        // Their notifier is theirs; their trusted folders are theirs.
        assert!(t.get("notify").is_none());
        assert!(t["projects"].get("/Users/x/secret").is_none());
        assert_eq!(t["projects"]["/w/one"]["trust_level"].as_str(), Some("trusted"));
        assert_eq!(t["hooks"]["state"]["/h/hooks.json:stop:0:0"]["trusted_hash"].as_str(), Some("sha256:abc"));
    }

    #[test]
    fn a_second_tab_adds_its_checkout_without_dropping_the_first() {
        let first = mirrored_config("", "", "/w/one", &trust()).unwrap();
        let second = mirrored_config("", &first, "/w/two", &trust()).unwrap();
        let t: toml::Table = toml::from_str(&second).unwrap();
        assert_eq!(t["projects"]["/w/one"]["trust_level"].as_str(), Some("trusted"));
        assert_eq!(t["projects"]["/w/two"]["trust_level"].as_str(), Some("trusted"));
    }

    #[test]
    fn a_checkout_with_a_dot_or_a_quote_in_it_still_parses_back() {
        let odd = "/w/it's a \"repo\".git/sub.dir";
        let out = mirrored_config("", "", odd, &BTreeMap::new()).unwrap();
        let t: toml::Table = toml::from_str(&out).unwrap();
        assert_eq!(t["projects"][odd]["trust_level"].as_str(), Some("trusted"));
    }

    #[test]
    fn only_the_hooks_raccoon_wrote_are_trusted() {
        let result = json!({"data": [{"hooks": [
            {"key": "/h/hooks.json:stop:0:0", "currentHash": "sha256:aa", "sourcePath": "/h/hooks.json", "trustStatus": "untrusted"},
            {"key": "/elsewhere/hooks.json:stop:0:0", "currentHash": "sha256:bb", "sourcePath": "/elsewhere/hooks.json", "trustStatus": "untrusted"}
        ]}]});
        let entries = trust_entries(&result, Path::new("/h/hooks.json"));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries["/h/hooks.json:stop:0:0"], "sha256:aa");
    }

    #[test]
    fn a_rollout_is_found_by_the_id_at_the_end_of_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let day = dir.path().join("sessions/2026/09/02");
        std::fs::create_dir_all(&day).unwrap();
        let id = "01a061f1-16d4-7c01-9900-e3903aa4d5ae";
        std::fs::write(day.join(format!("rollout-2026-09-02T15-46-25-{id}.jsonl")), "{}\n").unwrap();
        std::fs::write(day.join("rollout-2026-09-02T15-50-41-other.jsonl"), "{}\n").unwrap();
        assert!(find_rollout(dir.path(), id).is_some());
        assert!(find_rollout(dir.path(), "nobody").is_none());
    }

    #[test]
    fn an_old_conversation_is_copied_in_and_the_readers_own_file_is_untouched() {
        let user = tempfile::tempdir().unwrap();
        let managed = tempfile::tempdir().unwrap();
        let day = user.path().join("sessions/2026/09/02");
        std::fs::create_dir_all(&day).unwrap();
        let id = "abc-123";
        let source = day.join(format!("rollout-2026-09-02T15-46-25-{id}.jsonl"));
        std::fs::write(&source, "{\"type\":\"session_meta\"}\n").unwrap();

        assert!(adopt_rollout(managed.path(), user.path(), id).unwrap());
        let copied = find_rollout(managed.path(), id).unwrap();
        assert_eq!(std::fs::read_to_string(&copied).unwrap(), "{\"type\":\"session_meta\"}\n");
        assert_eq!(copied.strip_prefix(managed.path()).unwrap(), source.strip_prefix(user.path()).unwrap());
        assert!(source.exists());
        // Once it is here it is ours; a second tab does not copy over it.
        std::fs::write(&copied, "grown\n").unwrap();
        assert!(!adopt_rollout(managed.path(), user.path(), id).unwrap());
        assert_eq!(std::fs::read_to_string(&copied).unwrap(), "grown\n");
        assert!(!adopt_rollout(managed.path(), user.path(), "never-existed").unwrap());
    }

    #[test]
    fn the_update_modal_is_dismissed_only_when_a_version_is_named() {
        let dir = tempfile::tempdir().unwrap();
        // No file yet: nothing to say.
        dismiss_update_prompt(dir.path());
        assert!(!dir.path().join("version.json").exists());

        let path = dir.path().join("version.json");
        std::fs::write(&path, r#"{"latest_version":"0.152.1","last_checked_at":"x","dismissed_version":null}"#).unwrap();
        dismiss_update_prompt(dir.path());
        let v: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["dismissed_version"], "0.152.1");
        assert_eq!(v["last_checked_at"], "x");
    }

    #[cfg(unix)]
    #[test]
    fn linking_is_idempotent_and_never_writes_through_to_the_readers_home() {
        let user = tempfile::tempdir().unwrap();
        let managed = tempfile::tempdir().unwrap();
        std::fs::write(user.path().join("auth.json"), "{\"token\":\"t\"}").unwrap();
        link(managed.path(), user.path(), "auth.json").unwrap();
        link(managed.path(), user.path(), "auth.json").unwrap();
        let target = managed.path().join("auth.json");
        assert_eq!(std::fs::read_link(&target).unwrap(), user.path().join("auth.json"));
        // Nothing that is not there gets a dangling link.
        link(managed.path(), user.path(), "skills").unwrap();
        assert!(!managed.path().join("skills").exists());
    }
}
