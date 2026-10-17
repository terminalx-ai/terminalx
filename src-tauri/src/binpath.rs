//! Finding agent binaries.
//!
//! A bundled `.app` launched from Finder inherits launchd's `PATH`
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), which holds none of the tools a developer
//! installs. Resolution escalates by cost: the inherited PATH, then the usual
//! install directories, then `$SHELL -lc 'command -v <name>'` — `-l` matters,
//! because zsh reads `.zshrc` only without it and misses `PATH` exported from
//! `.zprofile`. A hit is cached for the life of the process; a miss is looked
//! for again, in the directories only, once it is a moment old, so a CLI
//! installed while the app or runtime runs is found without a restart (#496).

use std::collections::HashMap;
use std::path::PathBuf;
#[cfg(unix)]
use std::path::Path;
#[cfg(unix)]
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How long a miss is believed before the directories are looked through
/// again. Every agent check resolves every CLI, so this bounds the cost.
const MISS_RECHECK: Duration = Duration::from_secs(2);

#[derive(Clone)]
enum Lookup {
    Found(PathBuf),
    /// Not found, as of this instant.
    Missing(Instant),
}

fn cache() -> &'static Mutex<HashMap<String, Lookup>> {
    static C: OnceLock<Mutex<HashMap<String, Lookup>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

fn home() -> Option<PathBuf> {
    dirs::home_dir()
}

/// Directories where CLIs commonly land, in priority order.
pub fn known_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(h) = home() {
        for rel in [
            ".local/bin",
            ".claude/local",
            ".local/share/claude",
            ".bun/bin",
            ".npm-global/bin",
            ".cargo/bin",
            ".opencode/bin",
            ".grok/bin",
            ".pi/bin",
            "n/bin",
            ".volta/bin",
            ".fnm/aliases/default/bin",
        ] {
            v.push(h.join(rel));
        }
        // nvm keeps one bin dir per node version; take them all, newest first.
        let nvm = h.join(".nvm/versions/node");
        if let Ok(rd) = std::fs::read_dir(&nvm) {
            let mut vers: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
            vers.sort();
            vers.reverse();
            v.extend(vers);
        }
    }
    for p in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/snap/bin"] {
        v.push(PathBuf::from(p));
    }
    for extra in crate::store::settings::load().extra_bin_dirs {
        v.push(PathBuf::from(extra));
    }
    v
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.is_file() && p.metadata().map(|m| m.permissions().mode() & 0o111 != 0).unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

static PRIORITY_DIR: OnceLock<String> = OnceLock::new();
#[cfg_attr(windows, allow(dead_code))]
static LOGIN_PATH: OnceLock<String> = OnceLock::new();

/// Put `dir` before every other directory in [`login_path`], so a shim in it
/// (the cloud workspace's `gh`, see `cloud_github`) wins over the real
/// binary. Only takes effect before `login_path` is first read; returns
/// whether it did.
pub fn set_priority_dir(dir: &std::path::Path) -> bool {
    LOGIN_PATH.get().is_none() && PRIORITY_DIR.set(dir.to_string_lossy().into_owned()).is_ok()
}

/// The user's login-shell `PATH`, read once. Everything the app spawns gets
/// this so agents can find `git`, `gh`, `node` and each other.
#[cfg(unix)]
pub fn login_path() -> String {
    LOGIN_PATH.get_or_init(|| {
        let inherited = std::env::var("PATH").unwrap_or_default();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let from_shell = Command::new(&shell)
            .args(["-lc", "printf %s \"$PATH\""])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        let mut seen = std::collections::HashSet::new();
        let mut parts: Vec<String> = Vec::new();
        let priority = PRIORITY_DIR.get().cloned();
        for dir in priority.into_iter().chain(known_dirs().iter().map(|p| p.to_string_lossy().into_owned())).chain(from_shell.split(':').map(String::from)).chain(inherited.split(':').map(String::from)) {
            if dir.is_empty() || !seen.insert(dir.clone()) {
                continue;
            }
            parts.push(dir);
        }
        parts.join(":")
    })
    .clone()
}

/// Absolute path of `name`, if it can be found. A hit is cached; a miss is
/// re-checked once it is [`MISS_RECHECK`] old, by the cheap directory scan
/// only, since the login shell already said no.
pub fn resolve(name: &str) -> Option<PathBuf> {
    resolve_at(name, Instant::now())
}

fn resolve_at(name: &str, now: Instant) -> Option<PathBuf> {
    let cached = cache().lock().unwrap().get(name).cloned();
    let found = match cached {
        Some(Lookup::Found(path)) => return Some(path),
        Some(Lookup::Missing(at)) if now.saturating_duration_since(at) < MISS_RECHECK => return None,
        Some(Lookup::Missing(_)) => scan(name),
        None => resolve_uncached(name),
    };
    let entry = found.clone().map_or(Lookup::Missing(now), Lookup::Found);
    cache().lock().unwrap().insert(name.to_string(), entry);
    found
}

/// Availability is user-controlled and can change while the app is open.
/// Settings' Re-check clears prior hits and misses before probing again.
pub fn invalidate() {
    cache().lock().unwrap().clear();
}

/// `name` itself when it is a path, else the first executable of that name in
/// [`login_path`]'s directories.
#[cfg(unix)]
fn scan(name: &str) -> Option<PathBuf> {
    if name.contains('/') {
        let p = PathBuf::from(name);
        return is_executable(&p).then_some(p);
    }
    login_path().split(':').map(|dir| PathBuf::from(dir).join(name)).find(|p| is_executable(p))
}

#[cfg(unix)]
fn resolve_uncached(name: &str) -> Option<PathBuf> {
    if let Some(found) = scan(name) {
        return Some(found);
    }
    if name.contains('/') {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = Command::new(shell).args(["-lc", &format!("command -v {name}")]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let p = PathBuf::from(s);
    is_executable(&p).then_some(p)
}

#[cfg(windows)]
pub fn login_path() -> String {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    let priority = PRIORITY_DIR.get().map(PathBuf::from);
    let paths = priority.into_iter().chain(known_dirs()).chain(std::env::split_paths(&inherited));
    std::env::join_paths(paths).unwrap_or(inherited).to_string_lossy().into_owned()
}

#[cfg(windows)]
fn resolve_uncached(name: &str) -> Option<PathBuf> {
    which::which_in(name, Some(login_path()), std::env::current_dir().ok()?).ok()
}

#[cfg(windows)]
fn scan(name: &str) -> Option<PathBuf> {
    resolve_uncached(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_git_and_misses_nonsense() {
        assert!(resolve("git").is_some());
        assert!(resolve("definitely-not-a-binary-raccoon").is_none());
        #[cfg(unix)]
        assert!(login_path().contains("/usr/bin"));
    }

    /// #496: a CLI installed after a miss is found once the miss has aged,
    /// with no restart and no Re-check.
    #[cfg(unix)]
    #[test]
    fn a_cli_installed_after_a_miss_is_found_once_the_miss_has_aged() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let cli = dir.path().join("late-cli");
        let name = cli.to_str().unwrap();
        let start = Instant::now();
        assert_eq!(resolve_at(name, start), None);
        std::fs::write(&cli, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A fresh miss is believed, so a burst of checks costs one scan.
        assert_eq!(resolve_at(name, start + MISS_RECHECK / 2), None);
        assert_eq!(resolve_at(name, start + MISS_RECHECK), Some(cli));
    }
}
