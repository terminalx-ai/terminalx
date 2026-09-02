//! Codex, PTY-first.
//!
//! A tab is the interactive `codex` TUI running in a terminal pane. What was
//! said comes from the rollout it writes (`rollout.rs`), what is happening
//! and what needs deciding come from its hooks (`pty.rs`), and both of those
//! need a home Raccoon owns (`home.rs`). The model list is still read from a
//! throwaway `codex app-server` (`models.rs`, `appserver.rs`), which is also
//! how the hook trust Codex demands is computed.

pub mod appserver;
pub mod home;
pub mod models;
pub mod pty;
pub mod rollout;

/// Our permission modes onto Codex's two knobs.
///
/// `-a` takes only `on-request` or `never` in codex-cli 0.152 — the older
/// `untrusted` and `on-failure` policies are gone, and naming one makes the
/// CLI refuse to start. "Ask every time" is therefore not a flag: it is
/// `on-request` plus the `PreToolUse` gate in `pty.rs`, which is the only way
/// to be asked about a tool Codex would have run without asking.
pub fn stance(mode: &str) -> (&'static str, &'static str) {
    match mode {
        "plan" => ("on-request", "read-only"),
        "bypassPermissions" => (pty::BYPASS, "danger-full-access"),
        _ => ("on-request", "workspace-write"),
    }
}

/// Whether this mode asks the reader about every tool, rather than only the
/// ones Codex itself would stop for.
pub fn asks_every_tool(mode: &str) -> bool {
    matches!(mode, "manual" | "default" | "ask")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stance_never_names_a_policy_the_cli_would_refuse() {
        for mode in ["plan", "manual", "default", "ask", "auto", "acceptEdits", "dontAsk", "bypassPermissions", "nonsense"] {
            let (approval, sandbox) = stance(mode);
            assert!(matches!(approval, "on-request" | "never" | pty::BYPASS), "{mode} asked for {approval}");
            assert!(matches!(sandbox, "read-only" | "workspace-write" | "danger-full-access"));
        }
        assert_eq!(stance("plan"), ("on-request", "read-only"));
        assert_eq!(stance("bypassPermissions"), (pty::BYPASS, "danger-full-access"));
    }

    #[test]
    fn only_ask_every_time_gates_every_tool() {
        assert!(asks_every_tool("manual"));
        assert!(asks_every_tool("ask"));
        assert!(!asks_every_tool("auto"));
        assert!(!asks_every_tool("plan"));
        assert!(!asks_every_tool("bypassPermissions"));
    }
}
