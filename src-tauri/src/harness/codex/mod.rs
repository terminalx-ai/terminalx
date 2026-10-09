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
    match mode.trim() {
        "plan" => ("on-request", "read-only"),
        // No mode at all is the product default launch mode.
        "bypassPermissions" | "bypass" | "" => (pty::BYPASS, NO_SANDBOX),
        _ => ("on-request", "workspace-write"),
    }
}

/// The sandbox that is no sandbox.
pub const NO_SANDBOX: &str = "danger-full-access";

/// The tab's mode for the approval policy and sandbox Codex reports it is
/// under (#417), which the reader can change in the terminal with
/// `/permissions`.
///
/// Several of our modes share a stance — "ask every time" is the app's own
/// gate on top of `on-request` — so a report cannot say which of them the tab
/// is in. The tab's mode is kept whenever it launches the stance reported.
/// Otherwise the stance is named by the mode that launches it, and one no
/// mode launches is kept as reported.
pub fn mode_reported(approval: &str, sandbox: &str, current: &str) -> String {
    // The rollout records the bypass flag as the pair it comes down to.
    let reported = if (approval, sandbox) == ("never", NO_SANDBOX) { (pty::BYPASS, NO_SANDBOX) } else { (approval, sandbox) };
    // `stance` launches a mode it does not know as `on-request` in the
    // workspace; that is not what such a tab is in.
    let known = matches!(current.trim(), "" | "plan" | "manual" | "default" | "ask" | "auto" | "acceptEdits" | "bypassPermissions" | "bypass");
    if known && stance(current) == reported {
        return current.to_string();
    }
    match reported {
        ("on-request", "read-only") => "plan".into(),
        ("on-request", "workspace-write") => "auto".into(),
        (pty::BYPASS, NO_SANDBOX) => "bypassPermissions".into(),
        _ => format!("{approval}, {sandbox}"),
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
        assert_eq!(stance(""), (pty::BYPASS, "danger-full-access"), "unset is the default, bypass");
        assert_eq!(stance(crate::store::index::DEFAULT_PERMISSION_MODE), (pty::BYPASS, "danger-full-access"));
    }

    #[test]
    fn a_reported_stance_is_read_back_into_the_tabs_own_mode() {
        // The three presets of `/permissions`, from a tab in another mode.
        assert_eq!(mode_reported("on-request", "read-only", "auto"), "plan");
        assert_eq!(mode_reported("on-request", "workspace-write", "plan"), "auto");
        assert_eq!(mode_reported("never", "danger-full-access", "auto"), "bypassPermissions");
        // A stance the tab's mode launches says nothing new: which of the
        // modes sharing it the tab is in is the app's to know.
        for mode in ["manual", "ask", "auto", "acceptEdits"] {
            assert_eq!(mode_reported("on-request", "workspace-write", mode), mode);
        }
        assert_eq!(mode_reported("on-request", "read-only", "plan"), "plan");
        assert_eq!(mode_reported("never", "danger-full-access", "bypassPermissions"), "bypassPermissions");
        assert_eq!(mode_reported("never", "danger-full-access", ""), "");
        // No mode launches these, so they are shown as they are, and go on
        // being shown that way while they are reported.
        assert_eq!(mode_reported("never", "workspace-write", "auto"), "never, workspace-write");
        assert_eq!(mode_reported("never", "workspace-write", "never, workspace-write"), "never, workspace-write");
        assert_eq!(mode_reported("on-request", "danger-full-access", "plan"), "on-request, danger-full-access");
        // And leaving one is a change like any other.
        assert_eq!(mode_reported("on-request", "workspace-write", "never, workspace-write"), "auto");
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
