//! Closing agent-browser daemons a previous app run left behind.
//!
//! A crash (or SIGKILL) leaves one daemon per launched profile with nobody
//! holding its name. This closes them through agent-browser's own CLI rather
//! than by walking pids, and only when the app derived the socket directory
//! itself: that private per-home directory is what proves the enumeration
//! can only see this home's daemons. An inherited directory may be shared
//! with a second app instance, and Windows has none at all, so both skip the
//! sweep and stay bounded by the idle timeout instead.
//!
//! `TERMINALX_DISABLE_AGENT_BROWSER_SWEEP=1` turns it off in the field.

use std::path::Path;
use std::time::Duration;

use serde_json::Value;

use super::environment::ProcessEnvironment;
use super::process::{run, RunOptions};

/// Session-name namespace the app gives its daemons: one per profile.
pub const SESSION_PREFIX: &str = "terminalx-";

const SWEEP_TIMEOUT: Duration = Duration::from_secs(5);

/// The session names a `session list --json` reply carries.
pub fn parse_session_names(stdout: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(stdout) else {
        return Vec::new();
    };
    value
        .get("data")
        .and_then(|d| d.get("sessions"))
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(Value::as_str)
                .filter(|n| !n.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Which of the listed sessions the sweep should close: ours by prefix, and
/// not currently live in this process.
pub fn select_orphans(listed: &[String], is_live: impl Fn(&str) -> bool) -> Vec<&str> {
    listed
        .iter()
        .map(String::as_str)
        .filter(|name| name.starts_with(SESSION_PREFIX) && !is_live(name))
        .collect()
}

pub fn disabled_by_env() -> bool {
    std::env::var("TERMINALX_DISABLE_AGENT_BROWSER_SWEEP").map(|v| v == "1").unwrap_or(false)
}

/// Close every orphaned session; returns the names closed.
pub fn sweep(binary: &Path, env: &ProcessEnvironment, is_live: impl Fn(&str) -> bool) -> Vec<String> {
    if !env.owns_socket_directory || disabled_by_env() {
        return Vec::new();
    }
    let listed = match run(binary, &["session", "list", "--json"], env, RunOptions { timeout: SWEEP_TIMEOUT, stdin: None }) {
        Ok(out) if !out.timed_out => parse_session_names(&out.stdout),
        _ => return Vec::new(),
    };
    let mut closed = Vec::new();
    for name in select_orphans(&listed, &is_live) {
        match run(binary, &["--session", name, "close"], env, RunOptions { timeout: SWEEP_TIMEOUT, stdin: None }) {
            Ok(_) => closed.push(name.to_string()),
            Err(e) => log::warn!("sweep {name}: {e}"),
        }
    }
    closed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_names_and_ignores_garbage() {
        assert_eq!(
            parse_session_names(r#"{"success":true,"data":{"sessions":["terminalx-default","other",""]}}"#),
            vec!["terminalx-default".to_string(), "other".to_string()]
        );
        assert!(parse_session_names("not json").is_empty());
        assert!(parse_session_names(r#"{"success":true,"data":{}}"#).is_empty());
    }

    #[test]
    fn only_our_dead_sessions_are_selected() {
        let listed = vec![
            "terminalx-default".to_string(),
            "terminalx-work".to_string(),
            "default".to_string(),
            "someone-elses".to_string(),
        ];
        let live = |name: &str| name == "terminalx-work";
        assert_eq!(select_orphans(&listed, live), vec!["terminalx-default"]);
    }
}
