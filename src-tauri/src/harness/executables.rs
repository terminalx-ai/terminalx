//! The program an agent runs as, when the person chose one (PRO-157).
//!
//! Someone with several installs of an agent (Homebrew, npm, a dev build)
//! picks one in Settings → Agents or Advanced. The choice is kept in
//! `settings.json` under `agents.executables`, by harness id, and
//! [`crate::binpath::resolve`] reads it before it looks anywhere else, so
//! every place that starts or asks an agent (a new tab, readiness, sign-in,
//! setup) runs the chosen program without knowing about the choice.
//!
//! A program is only kept once it answers `--version`: a path that fails is
//! refused and the earlier choice stays. One that disappears later is not
//! stood in for by whatever the PATH has, since that is the program the
//! person chose not to run: the agent reads as not installed, and the row
//! says why.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

/// How long `--version` may take. A cold Node CLI on a slow disk takes a
/// few seconds; a program that has not answered by then will not start a tab.
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);

/// One agent's executable, as Settings shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Executable {
    pub harness: String,
    /// The path the person chose; `None` uses the PATH.
    pub chosen: Option<String>,
    /// What a new tab runs: the chosen program, or the PATH's.
    pub path: Option<String>,
    /// What the PATH has, whatever was chosen: "Use system default" goes back to it.
    pub system: Option<String>,
    /// `--version` of [`Self::path`], when it answered.
    pub version: Option<String>,
    /// Why the chosen program cannot be used now.
    pub problem: Option<String>,
}

/// A program that answered `--version`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub path: PathBuf,
    pub version: String,
}

/// The chosen program for the agent CLI called `binary`: `None` when the
/// name is not an agent's or no program was chosen for it, `Some(None)` when
/// the chosen one is no longer an executable file.
pub fn chosen_for_binary(binary: &str) -> Option<Option<PathBuf>> {
    let id = super::id_for_binary(binary)?;
    let chosen = crate::store::settings::load().agents.executables.get(id).cloned()?;
    Some(usable(Path::new(&chosen)).then(|| PathBuf::from(chosen)))
}

/// `~/` expanded; anything else must already be absolute.
fn expand(raw: &str) -> Result<PathBuf, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Enter the path to a program, or leave it empty to use the one on your PATH.".into());
    }
    let path = match raw.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().ok_or("No home directory to expand ~ in.")?.join(rest),
        None => PathBuf::from(raw),
    };
    if !path.is_absolute() {
        return Err(format!("{raw} is not a full path. Choose the program with Browse…, or type a path that starts with / or ~/."));
    }
    Ok(path)
}

#[cfg(unix)]
fn usable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file() && path.metadata().is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn usable(path: &Path) -> bool {
    path.is_file()
}

/// The version an agent printed, without anything else it said.
pub(crate) fn version_token(text: &str) -> Option<String> {
    text.split_whitespace()
        .find(|s| s.starts_with(|c: char| c.is_ascii_digit()) && s.len() <= 40 && s.chars().all(|c| c.is_ascii_alphanumeric() || ".-_+".contains(c)))
        .map(str::to_owned)
}

/// Run `path --version` and keep its version, or say why it cannot be used.
pub fn check(raw: &str) -> Result<Checked, String> {
    let path = expand(raw)?;
    let shown = path.display().to_string();
    if !path.exists() {
        return Err(format!("{shown} does not exist."));
    }
    if !usable(&path) {
        return Err(if path.is_dir() { format!("{shown} is a folder, not a program.") } else { format!("{shown} is not executable.") });
    }
    let mut command = std::process::Command::new(&path);
    command.arg("--version").env("PATH", crate::binpath::login_path()).env("NO_COLOR", "1");
    let output = crate::git::capture_within(command, VERSION_TIMEOUT).map_err(|error| match error.kind() {
        std::io::ErrorKind::TimedOut => format!("{shown} --version did not answer within {} seconds.", VERSION_TIMEOUT.as_secs()),
        _ => format!("{shown} could not be started: {error}"),
    })?;
    let said = |bytes: &[u8]| String::from_utf8_lossy(bytes).lines().map(str::trim).find(|line| !line.is_empty()).map(|line| line.chars().take(160).collect::<String>());
    if !output.status.success() {
        let code = output.status.code().map_or_else(|| "was stopped".to_owned(), |code| format!("exited with {code}"));
        return Err(match said(&output.stderr).or_else(|| said(&output.stdout)) {
            Some(line) => format!("{shown} --version {code}: {line}"),
            None => format!("{shown} --version {code}."),
        });
    }
    let text = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    let version = version_token(&text).ok_or_else(|| format!("{shown} --version printed no version, so it is not an agent CLI TerminalX can run."))?;
    Ok(Checked { path, version })
}

/// What Settings shows for `harness`.
pub fn state(harness: &str) -> Result<Executable, String> {
    let binary = super::binary_of(harness).ok_or_else(|| format!("Unknown agent: {}", harness.chars().take(40).collect::<String>()))?;
    let chosen = crate::store::settings::load().agents.executables.get(harness).cloned();
    let system = crate::binpath::resolve_system(binary).map(|path| path.to_string_lossy().into_owned());
    let (path, problem) = match &chosen {
        Some(chosen) if usable(Path::new(chosen)) => (Some(chosen.clone()), None),
        Some(chosen) => (None, Some(format!("{chosen} is gone or no longer executable. New tabs can’t start until you choose another or use the one on your PATH."))),
        None => (system.clone(), None),
    };
    let version = path.as_deref().and_then(|path| check(path).ok()).map(|checked| checked.version);
    Ok(Executable { harness: harness.to_owned(), chosen, path, system, version, problem })
}

/// Choose `path` for `harness`, or go back to the PATH with `None`. A program
/// that fails `--version` is refused and the earlier choice is kept.
pub fn set(harness: &str, path: Option<&str>) -> Result<Executable, String> {
    super::binary_of(harness).ok_or_else(|| format!("Unknown agent: {}", harness.chars().take(40).collect::<String>()))?;
    let checked = path.map(check).transpose()?;
    let mut settings = crate::store::settings::load();
    match &checked {
        Some(checked) => { settings.agents.executables.insert(harness.to_owned(), checked.path.to_string_lossy().into_owned()); }
        None => { settings.agents.executables.remove(harness); }
    }
    crate::store::settings::save(&settings).map_err(|error| format!("{error:#}"))?;
    crate::binpath::invalidate();
    state(harness)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn a_program_must_answer_version_to_be_chosen() {
        let dir = tempfile::tempdir().unwrap();
        let good = script(dir.path(), "claude-dev", "echo '2.3.41 (Claude Code)'");
        assert_eq!(check(good.to_str().unwrap()), Ok(Checked { path: good.clone(), version: "2.3.41".into() }));

        let failing = script(dir.path(), "broken", "echo 'dyld: Library not loaded' >&2; exit 3");
        let error = check(failing.to_str().unwrap()).unwrap_err();
        assert!(error.contains("exited with 3") && error.contains("dyld: Library not loaded"), "{error}");

        let silent = script(dir.path(), "silent", "echo 'usage: silent'");
        assert!(check(silent.to_str().unwrap()).unwrap_err().contains("printed no version"));

        let plain = dir.path().join("plain");
        std::fs::write(&plain, "not a program").unwrap();
        assert!(check(plain.to_str().unwrap()).unwrap_err().contains("is not executable"));
        assert!(check(dir.path().to_str().unwrap()).unwrap_err().contains("is a folder"));
        assert!(check(dir.path().join("missing").to_str().unwrap()).unwrap_err().contains("does not exist"));
        assert!(check("bin/claude").unwrap_err().contains("not a full path"));
        assert!(check("  ").is_err());
    }

    #[test]
    fn a_tilde_path_is_the_home_directorys() {
        let home = dirs::home_dir().unwrap();
        assert_eq!(expand("~/.local/bin/claude").unwrap(), home.join(".local/bin/claude"));
        assert_eq!(expand(" /opt/homebrew/bin/codex ").unwrap(), PathBuf::from("/opt/homebrew/bin/codex"));
    }

    /// The chosen program is what a new tab runs, a failing one keeps the old
    /// choice, and Reset goes back to PATH lookup.
    #[test]
    fn the_chosen_program_is_what_resolve_runs_until_reset() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let first = script(dir.path(), "claude-a", "echo '2.3.40 (Claude Code)'");
        let second = script(dir.path(), "claude-b", "echo '2.3.41 (Claude Code)'");
        let broken = script(dir.path(), "claude-c", "exit 1");

        let system = crate::binpath::resolve_system("claude");
        let chosen = set("claude", Some(first.to_str().unwrap())).unwrap();
        assert_eq!(chosen.chosen.as_deref(), first.to_str());
        assert_eq!(chosen.path.as_deref(), first.to_str());
        assert_eq!(chosen.version.as_deref(), Some("2.3.40"));
        assert_eq!(crate::binpath::resolve("claude"), Some(first.clone()));
        // The catalog (what readiness and new tabs read) follows too.
        assert_eq!(super::super::catalog().into_iter().find(|h| h.id == "claude").and_then(|h| h.path).as_deref(), first.to_str());

        let refused = set("claude", Some(broken.to_str().unwrap())).unwrap_err();
        assert!(refused.contains("exited with 1"), "{refused}");
        assert_eq!(crate::binpath::resolve("claude"), Some(first.clone()), "a refused program keeps the earlier choice");

        set("claude", Some(second.to_str().unwrap())).unwrap();
        assert_eq!(crate::binpath::resolve("claude"), Some(second.clone()));
        // Other agents and other programs are untouched.
        assert_eq!(crate::binpath::resolve("codex"), crate::binpath::resolve_system("codex"));
        assert!(crate::binpath::resolve("git").is_some());

        // A chosen program that disappears is not stood in for by the PATH's.
        std::fs::remove_file(&second).unwrap();
        assert_eq!(crate::binpath::resolve("claude"), None);
        let gone = state("claude").unwrap();
        assert_eq!(gone.path, None);
        assert!(gone.problem.as_deref().is_some_and(|problem| problem.contains("no longer executable")));

        let reset = set("claude", None).unwrap();
        assert_eq!(reset.chosen, None);
        assert_eq!(reset.problem, None);
        assert_eq!(crate::binpath::resolve("claude"), system);
        assert!(crate::store::settings::load().agents.executables.is_empty());
    }

    #[test]
    fn only_known_agents_take_a_program() {
        let _home = crate::store::temp_home();
        assert!(set("vim", None).unwrap_err().contains("Unknown agent"));
        assert!(state("vim").is_err());
        assert_eq!(chosen_for_binary("git"), None);
    }
}
