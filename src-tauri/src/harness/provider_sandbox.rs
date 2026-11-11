//! Whether a provider's own sandbox could keep a command from reading what
//! it names (PRO-330 review). TerminalX runs auto-approved discovery commands
//! itself, outside the provider's sandbox. That is the same access only while
//! that sandbox reads everywhere, as Claude Code's does when it is off and
//! Codex's `read-only` and `workspace-write` modes do by default. Neither CLI
//! tells a hook what its sandbox may read, so this reads the settings each
//! one loads and errs towards "it could": the command is then asked about on
//! a card, and the CLI runs it inside its sandbox if the person allows it.
//!
//! Every source that exists is consulted, whatever its precedence: a source
//! that turns a restriction on anywhere is enough. A file that cannot be read
//! or parsed could hold one, and so could a managed-preferences profile,
//! which is a property list this does not decode.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// Where each CLI's settings live. `from_env` is the real machine; tests
/// supply their own.
pub struct Sources {
    /// Claude Code's config directory: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
    pub claude_config: Option<PathBuf>,
    /// The Codex home TerminalX's Codex tabs run in.
    pub codex_home: Option<PathBuf>,
    /// The machine-wide roots: `/` in production.
    pub system: PathBuf,
    /// The account name, for per-user managed preferences.
    pub user: Option<String>,
}

impl Sources {
    pub fn from_env() -> Self {
        let claude_config = std::env::var_os("CLAUDE_CONFIG_DIR")
            .filter(|dir| !dir.is_empty())
            .map(PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".claude")));
        Self {
            claude_config,
            codex_home: crate::store::root().ok().map(|root| root.join("codex")),
            system: PathBuf::from("/"),
            user: std::env::var("USER").ok().filter(|user| !user.is_empty()),
        }
    }

    fn managed_preferences(&self, domain: &str) -> Vec<PathBuf> {
        let root = self.system.join("Library/Managed Preferences");
        let mut files = vec![root.join(format!("{domain}.plist"))];
        if let Some(user) = &self.user {
            files.push(root.join(user).join(format!("{domain}.plist")));
        }
        files
    }
}

/// Whether Claude Code's sandbox could be on for a command run in `cwd`.
pub fn claude_may_restrict(cwd: &Path, sources: &Sources) -> bool {
    let mut files = Vec::new();
    if let Some(config) = &sources.claude_config {
        for name in ["settings.json", "settings.local.json", "remote-settings.json"] {
            files.push(config.join(name));
        }
    }
    for managed in ["Library/Application Support/ClaudeCode", "etc/claude-code"] {
        let managed = sources.system.join(managed);
        files.push(managed.join("managed-settings.json"));
        files.extend(json_files_in(&managed.join("managed-settings.d")));
    }
    // Project settings belong to the directory Claude was started in, which
    // is `cwd` or one of its parents.
    for dir in cwd.ancestors() {
        files.push(dir.join(".claude/settings.json"));
        files.push(dir.join(".claude/settings.local.json"));
    }
    sources.managed_preferences("com.anthropic.claudecode").iter().any(|plist| plist.exists())
        || files.iter().any(|file| match std::fs::read(file) {
            Err(error) => error.kind() != std::io::ErrorKind::NotFound,
            Ok(bytes) => serde_json::from_slice::<Value>(&bytes).map_or(true, |settings| enables_sandbox(&settings)),
        })
}

/// Any `sandbox` setting that is on, at whatever depth a source keeps it
/// (cached remote settings wrap theirs). Claude's sandbox is off unless
/// `enabled` says otherwise.
fn enables_sandbox(value: &Value) -> bool {
    // Anything but an explicit `false` might be read as on.
    let on = |sandbox: &Value| {
        sandbox == &Value::Bool(true) || sandbox.get("enabled").is_some_and(|enabled| enabled != &Value::Bool(false))
    };
    match value {
        Value::Object(map) => map.iter().any(|(key, value)| (key == "sandbox" && on(value)) || enables_sandbox(value)),
        Value::Array(items) => items.iter().any(enables_sandbox),
        _ => false,
    }
}

/// Whether a Codex configuration layer could narrow what its sandbox reads:
/// a filesystem `deny_read`, explicit readable roots, or a permissions
/// profile, whose filesystem entries can do either.
pub fn codex_may_restrict(cwd: &Path, sources: &Sources) -> bool {
    let mut files = Vec::new();
    if let Some(home) = &sources.codex_home {
        for name in ["config.toml", "managed_config.toml", "requirements.toml"] {
            files.push(home.join(name));
        }
    }
    for name in ["config.toml", "managed_config.toml", "requirements.toml"] {
        files.push(sources.system.join("etc/codex").join(name));
    }
    for dir in cwd.ancestors() {
        files.push(dir.join(".codex/config.toml"));
    }
    let mut plists = sources.managed_preferences("com.openai.codex");
    plists.extend(sources.managed_preferences("com.openai.codex.user"));
    plists.iter().any(|plist| plist.exists())
        || files.iter().any(|file| match std::fs::read_to_string(file) {
            Err(error) => error.kind() != std::io::ErrorKind::NotFound,
            Ok(text) => text.parse::<toml::Table>().map_or(true, |table| narrows_reads(&toml::Value::Table(table))),
        })
}

fn narrows_reads(value: &toml::Value) -> bool {
    match value {
        toml::Value::Table(table) => table.iter().any(|(key, value)| {
            matches!(key.as_str(), "deny_read" | "readable_roots" | "permissions" | "default_permissions")
                || narrows_reads(value)
        }),
        toml::Value::Array(items) => items.iter().any(narrows_reads),
        _ => false,
    }
}

fn json_files_in(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Machine {
        _temp: tempfile::TempDir,
        sources: Sources,
        project: PathBuf,
    }

    fn machine() -> Machine {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_path_buf();
        let project = root.join("work/project/sub");
        std::fs::create_dir_all(&project).unwrap();
        let sources = Sources {
            claude_config: Some(root.join("home/.claude")),
            codex_home: Some(root.join("terminalx/codex")),
            system: root.join("system"),
            user: Some("reader".into()),
        };
        Machine { _temp: temp, sources, project }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn claude_sandbox_settings_anywhere_keep_commands_on_the_card() {
        let m = machine();
        assert!(!claude_may_restrict(&m.project, &m.sources), "no settings: Claude reads everywhere");
        let config = m.sources.claude_config.clone().unwrap();
        write(&config.join("settings.json"), r#"{"permissions":{"allow":["Bash(ls)"]},"sandbox":{"enabled":false}}"#);
        write(&config.join("remote-settings.json"), "{}");
        assert!(!claude_may_restrict(&m.project, &m.sources), "a disabled sandbox reads everywhere");
        for file in [
            config.join("settings.json"),
            config.join("remote-settings.json"),
            m.sources.system.join("Library/Application Support/ClaudeCode/managed-settings.json"),
            m.sources.system.join("etc/claude-code/managed-settings.d/10-policy.json"),
            m.project.parent().unwrap().join(".claude/settings.local.json"),
        ] {
            let before = std::fs::read(&file).ok();
            write(&file, r#"{"settings":{"sandbox":{"enabled":true,"filesystem":{"denyRead":["~/.ssh"]}}}}"#);
            assert!(claude_may_restrict(&m.project, &m.sources), "{file:?}");
            write(&file, "{ not json");
            assert!(claude_may_restrict(&m.project, &m.sources), "an unreadable {file:?} could hold one");
            match before {
                Some(bytes) => std::fs::write(&file, bytes).unwrap(),
                None => std::fs::remove_file(&file).unwrap(),
            }
        }
        assert!(!claude_may_restrict(&m.project, &m.sources));
        write(&m.sources.system.join("Library/Managed Preferences/reader/com.anthropic.claudecode.plist"), "binary");
        assert!(claude_may_restrict(&m.project, &m.sources), "a managed profile is not decoded, so it could");
    }

    #[test]
    fn codex_read_restrictions_in_any_layer_keep_commands_on_the_card() {
        let m = machine();
        let home = m.sources.codex_home.clone().unwrap();
        write(&home.join("config.toml"), "model = \"gpt-5\"\n[projects.\"/w\"]\ntrust_level = \"trusted\"\n");
        assert!(!codex_may_restrict(&m.project, &m.sources), "Codex's standard sandboxes read everywhere");
        for (file, text) in [
            (m.sources.system.join("etc/codex/requirements.toml"), "[permissions.filesystem]\ndeny_read = [\"~/.ssh\"]\n"),
            (m.sources.system.join("etc/codex/managed_config.toml"), "default_permissions = \"locked\"\n"),
            (home.join("config.toml"), "[sandbox_workspace_write]\nreadable_roots = [\"/w\"]\n"),
            (m.project.join(".codex/config.toml"), "[permissions.locked.filesystem]\n\":minimal\" = \"read\"\n"),
            (m.project.join(".codex/config.toml"), "not = [toml"),
        ] {
            let before = std::fs::read(&file).ok();
            write(&file, text);
            assert!(codex_may_restrict(&m.project, &m.sources), "{file:?}: {text}");
            match before {
                Some(bytes) => std::fs::write(&file, bytes).unwrap(),
                None => std::fs::remove_file(&file).unwrap(),
            }
        }
        assert!(!codex_may_restrict(&m.project, &m.sources));
        write(&m.sources.system.join("Library/Managed Preferences/com.openai.codex.plist"), "binary");
        assert!(codex_may_restrict(&m.project, &m.sources));
    }
}
