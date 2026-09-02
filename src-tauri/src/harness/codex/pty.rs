//! Codex, PTY-first: the real interactive CLI is the tab.
//!
//! The same shape as the Claude harness — the CLI in a pane, its own
//! transcript projected into the chat, its own hooks carrying status and
//! permissions — with three differences that come from the CLI itself:
//!
//! - **hooks live in a file**, not on the command line. There is no
//!   `--settings`, so the hook definitions go in `$CODEX_HOME/hooks.json` and
//!   the home has to be one Raccoon owns (`home.rs`).
//! - **no matcher.** A Codex tool hook with no matcher runs for every tool;
//!   Claude's has to say `*` or it is never called.
//! - **two gates, not one.** `PermissionRequest` fires only when Codex itself
//!   wants approval (a command escalating out of the sandbox). `PreToolUse`
//!   fires for every tool and can return `deny`, which blocks the call and
//!   tells the model why — that is what "Ask every time" is built on.
//!
//! Every fact here was read out of the installed CLI (codex-cli 0.152.0): the
//! JSON schemas it embeds for each hook's stdin and stdout, `codex --help`,
//! and a real interactive turn driven through a PTY.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

/// The hook events a tab registers.
///
/// `PreCompact`/`PostCompact` are absent for the same reason as in the Claude
/// harness: the rollout says when a compaction happened. `SubagentStart`/
/// `SubagentStop` are absent because nothing in the app draws a Codex
/// subagent yet, and an installed hook that is never read is only noise.
pub const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "Stop",
    "Interrupt",
    "SessionEnd",
];

/// How long Codex waits for a hook. The two that can park on a person get the
/// ceiling Codex itself allows; the rest only report and must never hold a
/// turn up.
const DECIDING_TIMEOUT_SECS: u64 = 600;
const REPORT_TIMEOUT_SECS: u64 = 10;
/// The app-side wait must match, or a card would go on offering buttons for a
/// request the CLI has already given up on.
pub const PERMISSION_WAIT: Duration = Duration::from_secs(DECIDING_TIMEOUT_SECS);

fn timeout_for(event: &str) -> u64 {
    if matches!(event, "PermissionRequest" | "PreToolUse") {
        DECIDING_TIMEOUT_SECS
    } else {
        REPORT_TIMEOUT_SECS
    }
}

/// The `hooks.json` Raccoon writes into the home it manages. Every hook runs
/// this same binary as `raccoon hook <Event>`, which forwards the hook's
/// stdin over the socket.
pub fn hooks_json(exe: &Path) -> Value {
    let mut hooks = serde_json::Map::new();
    for event in HOOK_EVENTS {
        hooks.insert(
            (*event).to_string(),
            json!([{ "hooks": [{
                "type": "command",
                "command": crate::hooks::hook_command(exe, event),
                "timeout": timeout_for(event),
            }]}]),
        );
    }
    json!({ "hooks": hooks })
}

pub struct LaunchOptions<'a> {
    /// The rollout id to reopen. `None` starts a new conversation — Codex
    /// mints the id itself, and the `SessionStart` hook is how the app learns
    /// which one.
    pub resume: Option<&'a str>,
    pub model: &'a str,
    pub effort: Option<&'a str>,
    pub permission_mode: &'a str,
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The shell command line the pane runs. `Terminals::spawn` execs it from a
/// login shell, so it is one string rather than an argv.
pub fn launch_command(opts: LaunchOptions<'_>) -> Option<String> {
    let program = crate::binpath::resolve("codex")?;
    let mut c = quote(&program.to_string_lossy());
    if let Some(id) = opts.resume {
        c.push_str(&format!(" resume {}", quote(id)));
    }
    if !opts.model.is_empty() {
        c.push_str(&format!(" -m {}", quote(opts.model)));
    }
    if let Some(e) = opts.effort.filter(|e| !e.is_empty()) {
        c.push_str(&format!(" -c {}", quote(&format!("model_reasoning_effort={e}"))));
    }
    let (approval, sandbox) = super::stance(opts.permission_mode);
    if approval == BYPASS {
        c.push_str(" --dangerously-bypass-approvals-and-sandbox");
    } else {
        c.push_str(&format!(" -a {approval} -s {sandbox}"));
    }
    Some(c)
}

/// The stance that means "no sandbox, no questions"; it is a flag of its own
/// rather than an `-a`/`-s` pair.
pub const BYPASS: &str = "bypass";

/// The reply a `PermissionRequest` hook prints.
///
/// `updatedInput` and `updatedPermissions` exist in the schema but Codex
/// *fails closed* if either is present, so an allow says nothing but allow.
pub fn permission_decision(allow: bool) -> Value {
    let decision = if allow {
        json!({ "behavior": "allow" })
    } else {
        json!({ "behavior": "deny", "message": "The user declined this action." })
    };
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
}

/// The reply a `PreToolUse` hook prints to gate a tool the reader has been
/// asked about. A denial has to carry a reason — Codex rejects
/// `permissionDecision: "deny"` without one — and the model is shown it as
/// `Command blocked by PreToolUse hook: <reason>`.
pub fn pre_tool_decision(allow: bool) -> Value {
    let (decision, reason) = if allow {
        ("allow", "The user allowed this action.")
    } else {
        ("deny", "The user declined this action.")
    };
    json!({ "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": decision,
        "permissionDecisionReason": reason,
    }})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_hook_runs_this_binary_and_none_carries_a_matcher() {
        let v = hooks_json(Path::new("/opt/raccoon"));
        let hooks = v["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), HOOK_EVENTS.len());
        for event in HOOK_EVENTS {
            let group = &hooks[*event][0];
            // A Codex tool hook with no matcher runs for every tool; giving it
            // Claude's `*` would make it match a tool literally named `*`.
            assert!(group.get("matcher").is_none());
            let h = &group["hooks"][0];
            assert_eq!(h["type"], "command");
            assert_eq!(h["command"], format!("'/opt/raccoon' hook {event}"));
        }
        // The two that park on a person wait; the rest only report.
        assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["timeout"], 600);
        assert_eq!(hooks["PreToolUse"][0]["hooks"][0]["timeout"], 600);
        assert_eq!(hooks["Stop"][0]["hooks"][0]["timeout"], 10);
    }

    #[test]
    fn a_new_tab_starts_a_conversation_and_an_old_one_resumes_it() {
        if crate::binpath::resolve("codex").is_none() {
            return;
        }
        let fresh = launch_command(LaunchOptions { resume: None, model: "gpt-5.6-sol", effort: Some("high"), permission_mode: "auto" }).unwrap();
        assert!(!fresh.contains(" resume "));
        assert!(fresh.contains(" -m 'gpt-5.6-sol'"));
        assert!(fresh.contains(" -c 'model_reasoning_effort=high'"));
        assert!(fresh.contains(" -a on-request -s workspace-write"));

        let back = launch_command(LaunchOptions { resume: Some("01a0-uuid"), model: "", effort: None, permission_mode: "auto" }).unwrap();
        assert!(back.contains(" resume '01a0-uuid'"));
        assert!(!back.contains(" -m "));
        assert!(!back.contains("model_reasoning_effort"));
    }

    #[test]
    fn each_permission_mode_names_a_stance_the_cli_accepts() {
        if crate::binpath::resolve("codex").is_none() {
            return;
        }
        let line = |mode| launch_command(LaunchOptions { resume: None, model: "", effort: None, permission_mode: mode }).unwrap();
        // Plan reads but never writes.
        assert!(line("plan").contains(" -a on-request -s read-only"));
        // Ask every time still runs Codex on its own terms; the gate is the
        // PreToolUse hook, not a flag.
        assert!(line("manual").contains(" -a on-request -s workspace-write"));
        assert!(line("auto").contains(" -a on-request -s workspace-write"));
        assert!(line("acceptEdits").contains(" -a on-request -s workspace-write"));
        let yolo = line("bypassPermissions");
        assert!(yolo.contains("--dangerously-bypass-approvals-and-sandbox"));
        assert!(!yolo.contains(" -a "));
    }

    #[test]
    fn a_denial_is_said_in_json_and_carries_a_reason() {
        let deny = permission_decision(false);
        assert_eq!(deny["hookSpecificOutput"]["hookEventName"], "PermissionRequest");
        assert_eq!(deny["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert!(deny["hookSpecificOutput"]["decision"]["message"].is_string());
        // Codex fails closed on these two, so an allow must not carry them.
        let allow = permission_decision(true);
        let d = &allow["hookSpecificOutput"]["decision"];
        assert_eq!(d["behavior"], "allow");
        assert!(d.get("updatedInput").is_none());
        assert!(d.get("updatedPermissions").is_none());

        let block = pre_tool_decision(false);
        assert_eq!(block["hookSpecificOutput"]["permissionDecision"], "deny");
        assert!(!block["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap().is_empty());
        assert_eq!(pre_tool_decision(true)["hookSpecificOutput"]["permissionDecision"], "allow");
    }
}
