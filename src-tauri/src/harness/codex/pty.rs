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
//! The original hook contract was read from codex-cli 0.152.0. Launch
//! isolation and unchanged PreToolUse acknowledgements are verified against
//! 0.164.0; the resolved executable must advertise `--no-daemon` before use.

use std::path::{Path, PathBuf};
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
/// default timeout; the rest only report and must never hold a
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
    hooks_json_for_owner(exe, crate::local_runtime::permissions::enabled())
}

fn hooks_json_for_owner(exe: &Path, local_owner: bool) -> Value {
    let mut hooks = serde_json::Map::new();
    for event in HOOK_EVENTS {
        hooks.insert(
            (*event).to_string(),
            json!([{ "hooks": [{
                "type": "command",
                "command": crate::hooks::decision_hook_command(exe, event, local_owner && matches!(*event, "PermissionRequest" | "PreToolUse")),
                "timeout": if local_owner && matches!(*event, "PermissionRequest" | "PreToolUse") { crate::local_runtime::permissions::PROVIDER_SECONDS } else { timeout_for(event) },
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

/// A resolved CLI admitted for an isolated session launch.
pub struct Launcher {
    program: PathBuf,
}

impl Launcher {
    pub fn resolve() -> anyhow::Result<Self> {
        let program = crate::binpath::resolve("codex")
            .ok_or_else(|| anyhow::anyhow!("Codex is not installed. Install it and log in, then try again."))?;
        Self::inspect(program, Duration::from_secs(5))
    }

    fn inspect(program: PathBuf, timeout: Duration) -> anyhow::Result<Self> {
        // Probe each launch: upgrades can replace the executable at the same
        // path. A stale positive cache must not admit an incompatible CLI.
        let mut probe = std::process::Command::new(&program);
        probe.arg("--help").env("PATH", crate::binpath::login_path()).env("NO_COLOR", "1");
        let help = crate::git::output_within(probe, timeout).map_err(|error| {
            let reason = match error {
                crate::git::RunError::TimedOut => "the help command timed out",
                crate::git::RunError::Stopped => "the help command was stopped",
                crate::git::RunError::Failed(_) => "the help command exited unsuccessfully",
                crate::git::RunError::Spawn(_) => "the help command could not start",
            };
            anyhow::anyhow!("Could not verify Codex's --no-daemon support: {reason}. Check that `codex --help` completes successfully, or update Codex (0.164.0 is verified), then retry. No agent was started.")
        })?;
        if !help.lines().any(|line| line.split_whitespace().next() == Some("--no-daemon")) {
            anyhow::bail!("TerminalX requires Codex's --no-daemon option to keep each session isolated. Update Codex to a version with this option (0.164.0 is verified), then retry. No agent was started.");
        }
        Ok(Self { program })
    }

    /// The shell command line the pane runs. `Terminals::spawn` execs it from
    /// a login shell, so it is one string rather than an argv.
    pub fn command(&self, opts: LaunchOptions<'_>) -> String {
        // Hooks authenticate this launch with its tab, socket and token. A shared
        // Codex daemon inherits those from whichever tab started it, including a
        // retired owner after an app restart (#638). Keep the engine in this
        // launch so every hook inherits the same identity as its TUI.
        let mut c = format!("{} --no-daemon", quote(&self.program.to_string_lossy()));
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
        c
    }
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
/// `Command blocked by PreToolUse hook: <reason>`. An unchanged allowed tool
/// is acknowledged with an empty object: Codex 0.164.0 only accepts
/// `permissionDecision: "allow"` when it also carries rewritten input.
pub fn pre_tool_decision(allow: bool) -> Value {
    if allow {
        return json!({});
    }
    json!({ "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "The user declined this action.",
    }})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    #[ignore = "requires installed Codex with daemon support; isolated home, loopback provider, no model or account"]
    fn fresh_and_resumed_tabs_keep_their_hook_routing_with_a_shared_daemon() {
        let launcher = Launcher::resolve().expect("install a supported Codex to run its live routing regression");
        let fresh = launcher.command(LaunchOptions { resume: None, model: "", effort: None, permission_mode: "bypassPermissions" });
        let resumed = launcher.command(LaunchOptions { resume: Some("fixture-resume-id"), model: "", effort: None, permission_mode: "bypassPermissions" });
        let probe = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/local-runtime/codex-routing-probe.py");
        let output = std::process::Command::new("python3")
            .arg(probe)
            .arg("--codex").arg(&launcher.program)
            .arg("--fresh-command").arg(fresh)
            .arg("--resume-command").arg(resumed)
            .output().expect("run the real Codex routing regression");
        assert!(output.status.success(), "{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }

    #[test]
    fn only_local_owner_deciding_hooks_use_the_extended_wait() {
        let local = hooks_json_for_owner(Path::new("/opt/runtime"), true);
        let default = hooks_json_for_owner(Path::new("/opt/runtime"), false);
        for event in ["PermissionRequest", "PreToolUse"] {
            let hook = &local["hooks"][event][0]["hooks"][0];
            assert_eq!(hook["timeout"], crate::local_runtime::permissions::PROVIDER_SECONDS);
            assert!(hook["command"].as_str().unwrap().ends_with(" --local-owner-decision"));
            assert_eq!(default["hooks"][event][0]["hooks"][0]["timeout"], 600);
            assert!(!default["hooks"][event][0]["hooks"][0]["command"].as_str().unwrap().contains("--local-owner-decision"));
        }
        assert_eq!(local["hooks"]["Stop"][0]["hooks"][0]["timeout"], 10);
        assert!(!local["hooks"]["Stop"][0]["hooks"][0]["command"].as_str().unwrap().contains("--local-owner-decision"));
    }

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
        let launcher = Launcher { program: PathBuf::from("/opt/codex") };
        let fresh = launcher.command(LaunchOptions { resume: None, model: "gpt-5.6-sol", effort: Some("high"), permission_mode: "auto" });
        assert!(fresh.starts_with("'/opt/codex' --no-daemon "));
        assert!(!fresh.contains(" resume "));
        assert!(fresh.contains(" -m 'gpt-5.6-sol'"));
        assert!(fresh.contains(" -c 'model_reasoning_effort=high'"));
        assert!(fresh.contains(" -a on-request -s workspace-write"));

        let back = launcher.command(LaunchOptions { resume: Some("01a0-uuid"), model: "", effort: None, permission_mode: "auto" });
        assert!(back.starts_with("'/opt/codex' --no-daemon resume '01a0-uuid' "));
        assert!(back.contains(" resume '01a0-uuid'"));
        assert!(!back.contains(" -m "));
        assert!(!back.contains("model_reasoning_effort"));
    }

    #[test]
    fn each_permission_mode_names_a_stance_the_cli_accepts() {
        let launcher = Launcher { program: PathBuf::from("/opt/codex") };
        let line = |mode| launcher.command(LaunchOptions { resume: None, model: "", effort: None, permission_mode: mode });
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

    /// No mode named is the default launch mode, bypass (`--yolo` is Codex's
    /// undocumented alias for the documented flag used here), and a resumed
    /// thread is launched in its tab's mode like a fresh one.
    #[test]
    fn an_unset_mode_launches_in_bypass_fresh_and_resumed() {
        let launcher = Launcher { program: PathBuf::from("/opt/codex") };
        for resume in [None, Some("01a0-uuid")] {
            for mode in ["", crate::store::index::DEFAULT_PERMISSION_MODE] {
                let c = launcher.command(LaunchOptions { resume, model: "", effort: None, permission_mode: mode });
                assert!(c.contains(" --dangerously-bypass-approvals-and-sandbox"), "{mode:?} {resume:?}: {c}");
                assert!(!c.contains(" -a "), "{mode:?} {resume:?}");
            }
            let manual = launcher.command(LaunchOptions { resume, model: "", effort: None, permission_mode: "manual" });
            assert!(manual.contains(" -a on-request -s workspace-write"));
            assert!(!manual.contains("dangerously"));
        }
    }

    #[cfg(unix)]
    fn help_program(directory: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let program = directory.join("codex");
        std::fs::write(&program, format!("#!/bin/sh\n[ \"$*\" = '--help' ] || exit 91\n{body}\n")).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
        program
    }

    #[cfg(unix)]
    #[test]
    fn unsupported_codex_cannot_produce_a_fresh_or_resume_command() {
        let directory = tempfile::tempdir().unwrap();
        let program = help_program(directory.path(), "printf 'Usage: codex [OPTIONS]\nOptions:\n  --no-alt-screen\n'");
        for resume in [None, Some("saved-conversation")] {
            let result = Launcher::inspect(program.clone(), Duration::from_secs(5))
                .map(|launcher| launcher.command(LaunchOptions { resume, model: "", effort: None, permission_mode: "bypassPermissions" }));
            let error = result.expect_err("a CLI without isolation support must be rejected before building an agent command").to_string();
            assert!(error.contains("--no-daemon"));
            assert!(error.contains("Update Codex"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn supported_codex_keeps_isolation_and_permissions_fresh_and_resumed() {
        let directory = tempfile::tempdir().unwrap();
        let program = help_program(directory.path(), "printf 'Options:\n  --no-daemon\n    Run without the shared background server.\n'");
        let launcher = Launcher::inspect(program.clone(), Duration::from_secs(5)).unwrap();
        for resume in [None, Some("saved-conversation")] {
            for mode in ["bypassPermissions", "manual", "plan"] {
                let command = launcher.command(LaunchOptions { resume, model: "", effort: None, permission_mode: mode });
                let prefix = format!("{} --no-daemon{}", quote(&program.to_string_lossy()), if resume.is_some() { " resume 'saved-conversation'" } else { "" });
                assert!(command.starts_with(&prefix));
                assert_eq!(command.contains("--dangerously-bypass-approvals-and-sandbox"), mode == "bypassPermissions");
                if mode == "manual" { assert!(command.ends_with(" -a on-request -s workspace-write")); }
                if mode == "plan" { assert!(command.ends_with(" -a on-request -s read-only")); }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn failed_or_ambiguous_capability_checks_never_enable_a_launch() {
        let directory = tempfile::tempdir().unwrap();
        for (body, timeout, reason) in [
            ("printf '  --no-daemon\n'; exit 2", Duration::from_secs(5), "exited unsuccessfully"),
            ("printf '  --no-daemon-other\n'", Duration::from_secs(5), "Update Codex"),
            ("exec sleep 30", Duration::from_millis(50), "timed out"),
            ("sleep 2 2>/dev/null & printf '  --no-daemon\\n'; exit 0", Duration::from_millis(50), "timed out"),
            ("sleep 2 >/dev/null & printf '  --no-daemon\\n'; exit 0", Duration::from_millis(50), "timed out"),
        ] {
            let program = help_program(directory.path(), body);
            let error = Launcher::inspect(program, timeout).err().expect("an unsuccessful probe must reject launch");
            assert!(error.to_string().contains(reason), "{body}: {error}");
        }
        let error = Launcher::inspect(directory.path().join("missing"), Duration::from_secs(5)).err().unwrap();
        assert!(error.to_string().contains("could not start"));
    }

    #[cfg(unix)]
    #[test]
    fn replacing_codex_at_the_same_path_refreshes_its_capability() {
        let directory = tempfile::tempdir().unwrap();
        let program = help_program(directory.path(), "printf '  --no-alt-screen\n'");
        assert!(Launcher::inspect(program.clone(), Duration::from_secs(5)).is_err());
        help_program(directory.path(), "printf '  --no-daemon\n'");
        assert!(Launcher::inspect(program.clone(), Duration::from_secs(5)).is_ok());
        help_program(directory.path(), "printf '  --no-alt-screen\n'");
        assert!(Launcher::inspect(program, Duration::from_secs(5)).is_err());
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
        assert_eq!(pre_tool_decision(true), json!({}));
    }
}
