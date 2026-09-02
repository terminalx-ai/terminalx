//! Claude Code, PTY-first: the real interactive CLI is the tab.
//!
//! There is no wire protocol to read, so the three things the app needs come
//! from three places:
//! - **what was said** from the CLI's own transcript file (`transcript.rs`),
//!   followed as it is appended;
//! - **what is happening** from the CLI's hooks, which reach the app over the
//!   hook socket (`crate::hooks`);
//! - **what the reader types** goes back in as keystrokes on the PTY.
//!
//! Every fact below about flags, hook names, hook payloads and hook decision
//! shapes was read out of the installed CLI (2.1.258): `claude --help` and the
//! zod schemas embedded in the binary.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

/// The hook events a tab registers, with the matcher each one takes. A tool
/// event without a matcher is never called, so `*` is explicit.
///
/// `PreCompact` is deliberately absent: it fires before a compaction is known
/// to have happened, and the transcript's own `compact_boundary` record is the
/// honest signal.
pub const HOOK_EVENTS: &[(&str, Option<&str>)] = &[
    ("SessionStart", None),
    ("UserPromptSubmit", None),
    ("PermissionRequest", Some("*")),
    ("PreToolUse", Some("*")),
    ("PostToolUse", Some("*")),
    ("Notification", None),
    ("Stop", None),
    ("SubagentStop", None),
    ("SessionEnd", None),
];

/// How long the CLI waits for a hook. A permission card is answered by a
/// person, so that one is given the CLI's own default ceiling; the rest only
/// report and must never hold a turn up.
const PERMISSION_TIMEOUT_SECS: u64 = 600;
const REPORT_TIMEOUT_SECS: u64 = 10;
/// The app-side wait must match the CLI's, or a card would go on offering
/// buttons for a request the CLI has already given up on.
pub const PERMISSION_WAIT: Duration = Duration::from_secs(PERMISSION_TIMEOUT_SECS);

fn timeout_for(event: &str) -> u64 {
    if event == "PermissionRequest" {
        PERMISSION_TIMEOUT_SECS
    } else {
        REPORT_TIMEOUT_SECS
    }
}

/// The `--settings` payload: every hook runs this same binary as
/// `raccoon hook <Event>`, which forwards the hook's stdin over the socket.
///
/// Passing settings per launch rather than writing the reader's
/// `~/.claude/settings.json` means Raccoon never edits a file it does not own,
/// and a CLI started outside Raccoon is untouched.
pub fn settings_json(exe: &Path) -> Value {
    let mut hooks = serde_json::Map::new();
    for (event, matcher) in HOOK_EVENTS {
        let mut group = json!({ "hooks": [{
            "type": "command",
            "command": crate::hooks::hook_command(exe, event),
            "timeout": timeout_for(event),
        }]});
        if let Some(m) = matcher {
            group["matcher"] = json!(m);
        }
        hooks.insert((*event).to_string(), json!([group]));
    }
    json!({ "hooks": hooks })
}

pub struct LaunchOptions<'a> {
    pub provider_session_id: &'a str,
    /// True once the conversation exists; the CLI then picks the file up by id
    /// instead of being told to create one.
    pub resume: bool,
    /// A conversation to branch from, for a forked tab: the CLI reopens the
    /// parent and writes on under the id minted here.
    pub fork_from: Option<&'a str>,
    pub model: &'a str,
    pub effort: Option<&'a str>,
    pub permission_mode: &'a str,
    /// Shown in the CLI's own title and picker, so a tab is recognisable.
    pub title: Option<&'a str>,
    pub settings: &'a Value,
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The shell command line the pane runs. `Terminals::spawn` execs it from a
/// login shell, so it is one string rather than an argv.
pub fn launch_command(opts: LaunchOptions<'_>) -> Option<String> {
    let program = crate::binpath::resolve("claude")?;
    let mut c = quote(&program.to_string_lossy());
    match (opts.fork_from, opts.resume) {
        (Some(parent), _) => c.push_str(&format!(" --resume {} --fork-session --session-id {}", quote(parent), quote(opts.provider_session_id))),
        (None, true) => c.push_str(&format!(" --resume {}", quote(opts.provider_session_id))),
        (None, false) => c.push_str(&format!(" --session-id {}", quote(opts.provider_session_id))),
    }
    if !opts.model.is_empty() {
        c.push_str(&format!(" --model {}", quote(opts.model)));
    }
    if let Some(e) = opts.effort.filter(|e| !e.is_empty()) {
        c.push_str(&format!(" --effort {}", quote(e)));
    }
    c.push_str(&format!(" --permission-mode {}", super::normalize_mode(opts.permission_mode)));
    if let Some(t) = opts.title.filter(|t| !t.is_empty()) {
        c.push_str(&format!(" --name {}", quote(t)));
    }
    c.push_str(&format!(" --settings {}", quote(&opts.settings.to_string())));
    Some(c)
}

/// The reply a `PermissionRequest` hook prints. Its shape differs from
/// `PreToolUse`'s `permissionDecision`: this event carries a decision object,
/// and it ignores exit code 2, so a denial has to be said in JSON.
pub fn permission_decision(allow: bool, updated_input: Option<Value>, updated_permissions: Vec<Value>) -> Value {
    let decision = if allow {
        let mut d = json!({ "behavior": "allow" });
        if let Some(i) = updated_input {
            d["updatedInput"] = i;
        }
        if !updated_permissions.is_empty() {
            d["updatedPermissions"] = Value::Array(updated_permissions);
        }
        d
    } else {
        json!({ "behavior": "deny", "message": "The user declined this action." })
    };
    json!({ "hookSpecificOutput": { "hookEventName": "PermissionRequest", "decision": decision } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_point_every_hook_at_this_binary() {
        let v = settings_json(Path::new("/opt/raccoon"));
        let hooks = v["hooks"].as_object().unwrap();
        assert_eq!(hooks.len(), HOOK_EVENTS.len());
        for (event, matcher) in HOOK_EVENTS {
            let group = &hooks[*event][0];
            assert_eq!(group["matcher"].as_str(), *matcher);
            let h = &group["hooks"][0];
            assert_eq!(h["type"], "command");
            assert_eq!(h["command"], format!("'/opt/raccoon' hook {event}"));
        }
        // A person answers the permission card; the rest only report.
        assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["timeout"], 600);
        assert_eq!(hooks["Stop"][0]["hooks"][0]["timeout"], 10);
    }


    #[test]
    fn permission_replies_carry_the_events_own_decision_shape() {
        let allow = permission_decision(true, Some(json!({"command": "ls"})), vec![json!({"type": "addRules"})]);
        let d = &allow["hookSpecificOutput"];
        assert_eq!(d["hookEventName"], "PermissionRequest");
        assert_eq!(d["decision"]["behavior"], "allow");
        assert_eq!(d["decision"]["updatedInput"]["command"], "ls");
        assert_eq!(d["decision"]["updatedPermissions"][0]["type"], "addRules");
        let deny = permission_decision(false, None, vec![]);
        assert_eq!(deny["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert!(deny["hookSpecificOutput"]["decision"]["message"].is_string());
    }

    #[test]
    fn a_new_tab_names_its_session_and_a_resumed_one_reopens_it() {
        if crate::binpath::resolve("claude").is_none() {
            return;
        }
        let settings = json!({});
        let fresh = launch_command(LaunchOptions {
            provider_session_id: "abc",
            resume: false,
            fork_from: None,
            model: "opus",
            effort: Some("high"),
            permission_mode: "ask",
            title: Some("fix login"),
            settings: &settings,
        })
        .unwrap();
        assert!(fresh.contains("--session-id 'abc'"));
        assert!(fresh.contains("--model 'opus'"));
        assert!(fresh.contains("--effort 'high'"));
        assert!(fresh.contains("--permission-mode manual"));
        assert!(fresh.contains("--name 'fix login'"));
        assert!(fresh.contains("--settings '{}'"));

        let back = launch_command(LaunchOptions {
            provider_session_id: "abc",
            resume: true,
            fork_from: None,
            model: "",
            effort: None,
            permission_mode: "plan",
            title: None,
            settings: &settings,
        })
        .unwrap();
        assert!(back.contains("--resume 'abc'"));
        assert!(!back.contains("--model"));
        assert!(back.contains("--permission-mode plan"));

        let forked = launch_command(LaunchOptions {
            provider_session_id: "new",
            resume: false,
            fork_from: Some("parent"),
            model: "",
            effort: None,
            permission_mode: "auto",
            title: None,
            settings: &settings,
        })
        .unwrap();
        assert!(forked.contains("--resume 'parent' --fork-session --session-id 'new'"));
    }

    /// Changing the permission mode restarts the CLI as a fork, because the
    /// CLI restores a resumed session's own mode and ignores the flag.
    #[test]
    fn a_settings_restart_forks_the_conversation_and_carries_the_new_mode() {
        if crate::binpath::resolve("claude").is_none() {
            return;
        }
        let settings = json!({});
        let c = launch_command(LaunchOptions {
            provider_session_id: "minted",
            resume: false,
            fork_from: Some("the-conversation-so-far"),
            model: "opus",
            effort: None,
            permission_mode: "plan",
            title: None,
            settings: &settings,
        })
        .unwrap();
        assert!(c.contains("--resume 'the-conversation-so-far' --fork-session --session-id 'minted'"));
        assert!(c.contains("--permission-mode plan"));
        // Never both: a plain resume would silently keep the old mode.
        assert!(!c.contains("--resume 'minted'"));
    }





}
