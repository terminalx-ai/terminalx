//! The process environment every `agent-browser` invocation runs under.
//!
//! `agent-browser` is a client/daemon CLI: the app only ever spawns the
//! short-lived client, which forks a daemon the app holds no handle on and
//! that re-parents to pid 1 at once. Nothing here can reap it, and a
//! SIGKILLed app never runs teardown. Two environment variables are what
//! keep that daemon from outliving its usefulness:
//!
//! - `AGENT_BROWSER_SOCKET_DIR`: a private, owner-only directory derived from
//!   this app's data dir. Unix socket paths are capped at 104 bytes, so it
//!   lives under `/tmp` rather than under `RACCOON_HOME`, and its name is a
//!   hash of that home so two homes never see each other's daemons. Owning
//!   the directory is what makes `session list` a safe enumeration for the
//!   orphan sweep.
//! - `AGENT_BROWSER_IDLE_TIMEOUT_MS`: the daemon's own idle bound, the only
//!   bound that survives every way the app can die. The app keeps live
//!   sessions warm with a periodic `tab list`, so the bound only fires once
//!   nobody is left to send one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Idle bound for a daemon nobody is talking to. Ten minutes is more than six
/// times the command timeout, so no command or retry chain is cut short, and
/// well under the keepalive interval's failure horizon.
pub const IDLE_TIMEOUT_MS: u64 = 10 * 60 * 1000;

/// How often the app pings each live session so the idle bound never fires
/// while the app is running.
pub const KEEPALIVE_INTERVAL_SECS: u64 = 120;

const SOCKET_DIRECTORY_PREFIX: &str = "terminalx-ab-";

/// The environment agent-browser children inherit, and whether the socket
/// directory is one this app derived (and may therefore sweep).
#[derive(Debug, Clone)]
pub struct ProcessEnvironment {
    pub vars: Vec<(String, String)>,
    pub socket_dir: Option<PathBuf>,
    /// True only when the app derived the socket directory itself. An
    /// inherited `AGENT_BROWSER_SOCKET_DIR` may be shared with another app
    /// instance, so it is no proof that `session list` sees only ours.
    pub owns_socket_directory: bool,
}

impl ProcessEnvironment {
    pub fn get(&self, name: &str) -> Option<&str> {
        self.vars.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

/// Derive the environment for the app whose data lives at `home`.
pub fn create(inherited: &HashMap<String, String>, home: &Path) -> ProcessEnvironment {
    let mut vars: Vec<(String, String)> = Vec::new();
    if inherited
        .get("AGENT_BROWSER_IDLE_TIMEOUT_MS")
        .map(|v| v.trim().is_empty())
        .unwrap_or(true)
    {
        vars.push(("AGENT_BROWSER_IDLE_TIMEOUT_MS".into(), IDLE_TIMEOUT_MS.to_string()));
    }
    if let Some(dir) = inherited.get("AGENT_BROWSER_SOCKET_DIR").filter(|v| !v.trim().is_empty()) {
        return ProcessEnvironment { vars, socket_dir: Some(PathBuf::from(dir)), owns_socket_directory: false };
    }
    if cfg!(windows) {
        return ProcessEnvironment { vars, socket_dir: None, owns_socket_directory: false };
    }
    let dir = socket_directory_for(home);
    match ensure_private_dir(&dir) {
        Ok(()) => {
            vars.push(("AGENT_BROWSER_SOCKET_DIR".into(), dir.to_string_lossy().into_owned()));
            ProcessEnvironment { vars, socket_dir: Some(dir), owns_socket_directory: true }
        }
        Err(e) => {
            log::warn!("agent-browser socket dir {}: {e}", dir.display());
            ProcessEnvironment { vars, socket_dir: None, owns_socket_directory: false }
        }
    }
}

/// `/tmp/terminalx-ab-<16 hex of sha256(home)>`.
pub fn socket_directory_for(home: &Path) -> PathBuf {
    let digest = Sha256::digest(home.to_string_lossy().as_bytes());
    let key: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    PathBuf::from("/tmp").join(format!("{SOCKET_DIRECTORY_PREFIX}{key}"))
}

fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_directory_is_short_stable_and_home_specific() {
        let a = socket_directory_for(Path::new("/Users/someone/.raccoon"));
        let b = socket_directory_for(Path::new("/Users/someone/.raccoon"));
        let c = socket_directory_for(Path::new("/Users/someone/.raccoon-dev"));
        assert_eq!(a, b);
        assert_ne!(a, c);
        let text = a.to_string_lossy();
        assert!(text.starts_with("/tmp/terminalx-ab-"));
        // Enough room for `<dir>/terminalx-<32 char profile>.sock` inside
        // the 104-byte sun_path limit.
        assert!(text.len() + 1 + "terminalx-".len() + 32 + ".sock".len() < 104, "{text}");
    }

    #[test]
    fn derives_a_private_socket_dir_and_idle_bound_when_nothing_is_inherited() {
        let tmp = tempfile::tempdir().unwrap();
        let env = create(&HashMap::new(), tmp.path());
        assert!(env.owns_socket_directory);
        assert_eq!(env.get("AGENT_BROWSER_IDLE_TIMEOUT_MS"), Some("600000"));
        let dir = env.socket_dir.clone().unwrap();
        assert!(dir.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(dir.metadata().unwrap().permissions().mode() & 0o777, 0o700);
        }
        let _ = std::fs::remove_dir(dir);
    }

    #[test]
    fn an_inherited_socket_dir_is_used_but_never_owned() {
        let mut inherited = HashMap::new();
        inherited.insert("AGENT_BROWSER_SOCKET_DIR".to_string(), "/tmp/elsewhere".to_string());
        inherited.insert("AGENT_BROWSER_IDLE_TIMEOUT_MS".to_string(), "1234".to_string());
        let env = create(&inherited, Path::new("/nowhere"));
        assert!(!env.owns_socket_directory);
        assert_eq!(env.socket_dir.as_deref(), Some(Path::new("/tmp/elsewhere")));
        // The operator's own bound is respected.
        assert_eq!(env.get("AGENT_BROWSER_IDLE_TIMEOUT_MS"), None);
        assert_eq!(env.get("AGENT_BROWSER_SOCKET_DIR"), None);
    }
}
