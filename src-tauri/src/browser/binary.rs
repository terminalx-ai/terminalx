//! Finding the bundled `agent-browser` executable and reporting its health.
//!
//! Resolution order: an explicit `TERMINALX_AGENT_BROWSER_BIN`, the Tauri
//! sidecar next to this executable (`agent-browser`, which the bundle and
//! `tauri dev` both place beside the main binary), then whatever is on the
//! reader's login `PATH`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::environment::ProcessEnvironment;
use super::process::{run, RunOptions};
use super::{BrowserError, BrowserResult};

pub const BINARY_ENV: &str = "TERMINALX_AGENT_BROWSER_BIN";
/// The agent-browser release the bridge was validated against. Newer
/// releases are accepted; the version is surfaced in Settings.
pub const EXPECTED_VERSION: &str = "0.27.0";

pub fn locate() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os(BINARY_ENV).filter(|v| !v.is_empty()) {
        let p = PathBuf::from(explicit);
        return executable(&p).then_some(p);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["agent-browser", "agent-browser.exe"] {
                let p = dir.join(name);
                if executable(&p) {
                    return Some(p);
                }
            }
        }
    }
    crate::binpath::resolve("agent-browser")
}

pub fn require() -> BrowserResult<PathBuf> {
    locate().ok_or_else(|| {
        BrowserError::new(
            "browser_unavailable",
            "The agent-browser runtime is not bundled with this build and is not on PATH.",
        )
    })
}

fn executable(p: &Path) -> bool {
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

/// What Settings shows: where the runtime is, which version, and whether it
/// can find a browser to drive.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub binary: Option<String>,
    pub version: Option<String>,
    pub expected_version: String,
    /// Chrome, Chromium or the Playwright download agent-browser would launch.
    pub browser: Option<String>,
    pub socket_dir: Option<String>,
    pub owns_socket_dir: bool,
    pub live_sessions: Vec<String>,
}

pub fn version(binary: &Path, env: &ProcessEnvironment) -> Option<String> {
    let out = run(binary, &["--version"], env, RunOptions { timeout: Duration::from_secs(5), stdin: None }).ok()?;
    let text = out.stdout.trim();
    let version = text.split_whitespace().last()?.trim_start_matches('v');
    (!version.is_empty()).then(|| version.to_string())
}

/// The browser agent-browser would launch, found the way it finds one: a
/// system Chrome/Chromium, else a Playwright-managed Chromium download.
pub fn detect_browser() -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "macos") {
        for app in ["/Applications/Google Chrome.app", "/Applications/Chromium.app", "/Applications/Google Chrome Canary.app", "/Applications/Brave Browser.app", "/Applications/Microsoft Edge.app"] {
            candidates.push(PathBuf::from(app));
        }
        if let Some(home) = dirs::home_dir() {
            candidates.push(home.join("Applications/Google Chrome.app"));
        }
    } else {
        for name in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"] {
            if let Some(p) = crate::binpath::resolve(name) {
                candidates.push(p);
            }
        }
    }
    if let Some(found) = candidates.into_iter().find(|p| p.exists()) {
        return Some(found.to_string_lossy().into_owned());
    }
    let caches = if cfg!(target_os = "macos") {
        dirs::home_dir().map(|h| h.join("Library/Caches/ms-playwright"))
    } else {
        dirs::home_dir().map(|h| h.join(".cache/ms-playwright"))
    };
    let dir = caches?;
    let mut builds: Vec<PathBuf> = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).map(|n| n.starts_with("chromium-")).unwrap_or(false))
        .collect();
    builds.sort();
    builds.pop().map(|p| p.to_string_lossy().into_owned())
}

/// `agent-browser install`: downloads a Playwright Chromium when no system
/// browser is available. Long-running; bounded generously.
pub fn install_browser(binary: &Path, env: &ProcessEnvironment) -> BrowserResult<String> {
    let out = run(binary, &["install"], env, RunOptions { timeout: Duration::from_secs(15 * 60), stdin: None })
        .map_err(|e| BrowserError::new("browser_error", format!("agent-browser install: {e}")))?;
    if out.timed_out {
        return Err(BrowserError::new("browser_timeout", "agent-browser install did not finish within 15 minutes."));
    }
    if out.status != Some(0) {
        let detail = if out.stderr.trim().is_empty() { out.stdout } else { out.stderr };
        return Err(BrowserError::new("browser_error", format!("agent-browser install failed: {}", detail.trim())));
    }
    Ok(out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_env_wins_and_a_missing_file_is_a_miss() {
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var(BINARY_ENV, tmp.path().join("nope"));
        assert!(locate().is_none());
        std::env::remove_var(BINARY_ENV);
    }
}
