//! Finding agent binaries.
//!
//! A bundled `.app` launched from Finder inherits launchd's `PATH`
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), which holds none of the tools a developer
//! installs. Resolution escalates by cost: the inherited PATH, then the usual
//! install directories, then `$SHELL -lc 'command -v <name>'` — `-l` matters,
//! because zsh reads `.zshrc` only without it and misses `PATH` exported from
//! `.zprofile`. Answers are cached for the life of the process.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};

fn cache() -> &'static Mutex<HashMap<String, Option<PathBuf>>> {
    static C: OnceLock<Mutex<HashMap<String, Option<PathBuf>>>> = OnceLock::new();
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

/// The user's login-shell `PATH`, read once. Everything the app spawns gets
/// this so agents can find `git`, `gh`, `node` and each other.
pub fn login_path() -> String {
    static P: OnceLock<String> = OnceLock::new();
    P.get_or_init(|| {
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
        for dir in known_dirs().iter().map(|p| p.to_string_lossy().into_owned()).chain(from_shell.split(':').map(String::from)).chain(inherited.split(':').map(String::from)) {
            if dir.is_empty() || !seen.insert(dir.clone()) {
                continue;
            }
            parts.push(dir);
        }
        parts.join(":")
    })
    .clone()
}

/// Absolute path of `name`, if it can be found. The result is cached, including
/// a miss, so a CLI installed while the app runs reads as missing until restart.
pub fn resolve(name: &str) -> Option<PathBuf> {
    if let Some(hit) = cache().lock().unwrap().get(name) {
        return hit.clone();
    }
    let found = resolve_uncached(name);
    cache().lock().unwrap().insert(name.to_string(), found.clone());
    found
}

fn resolve_uncached(name: &str) -> Option<PathBuf> {
    if name.contains('/') {
        let p = PathBuf::from(name);
        return is_executable(&p).then_some(p);
    }
    for dir in login_path().split(':') {
        let p = PathBuf::from(dir).join(name);
        if is_executable(&p) {
            return Some(p);
        }
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

#[allow(dead_code)]
pub fn available(name: &str) -> bool {
    resolve(name).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_git_and_misses_nonsense() {
        assert!(resolve("git").is_some());
        assert!(resolve("definitely-not-a-binary-raccoon").is_none());
        assert!(login_path().contains("/usr/bin"));
    }
}
