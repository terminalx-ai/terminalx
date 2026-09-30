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
    json!({
        "hooks": hooks,
        "statusLine": {
            "type": "command",
            "command": crate::hooks::statusline_command(exe),
        }
    })
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
    let mode = super::normalize_mode(opts.permission_mode);
    // Bypass is said with the flag the CLI documents for it; the CLI reads it
    // on a fresh start and on `--resume` alike (probed on 2.1.285), so a
    // resumed or respawned tab stays in bypass.
    if mode == "bypassPermissions" {
        c.push_str(" --dangerously-skip-permissions");
    } else {
        c.push_str(&format!(" --permission-mode {mode}"));
    }
    if let Some(t) = opts.title.filter(|t| !t.is_empty()) {
        c.push_str(&format!(" --name {}", quote(t)));
    }
    // Bypass mode otherwise opens on the CLI's own "Yes, I accept" disclaimer,
    // which nobody watching the chat can see. The reader accepted the same
    // warning in the app's bypass dialog before this mode could be chosen, so
    // this launch says so — per launch, never in the reader's own settings.
    let mut settings = opts.settings.clone();
    if mode == "bypassPermissions" {
        if let Some(obj) = settings.as_object_mut() {
            obj.insert("skipDangerousModePermissionPrompt".into(), json!(true));
        }
    }
    c.push_str(&format!(" --settings {}", quote(&settings.to_string())));
    Some(c)
}

/// The full-screen questions the CLI can open on before its composer, each
/// with what the reader should be told. The CLI draws with cursor moves rather
/// than spaces, so both sides are compared with all whitespace removed.
const BLOCKING_SCREENS: &[(&str, &str)] = &[
    (
        "Choose the text style that looks best with your terminal",
        "Claude Code is showing its first-run setup (theme picker) instead of taking the prompt. Open the terminal view to finish it, then send again.",
    ),
    (
        "Detected a custom API key in your environment",
        "Claude Code is asking whether to use the ANTHROPIC_API_KEY in its environment. Open the terminal view to answer, then send again.",
    ),
    (
        "Is this a project you created or one you trust",
        "Claude Code is asking whether to trust this folder. Open the terminal view to answer, then send again.",
    ),
    (
        "you accept all responsibility for actions taken while running in Bypass Permissions mode",
        "Claude Code is asking to confirm Bypass Permissions mode. Open the terminal view to answer, then send again.",
    ),
    (
        "Select login method",
        "Claude Code is not signed in on this machine. Open the terminal view to sign in, then send again.",
    ),
];

/// How much of the newest output to look at: a dialog is the last thing drawn.
const SCREEN_TAIL_BYTES: usize = 64 * 1024;

/// Printable text of terminal output: escape sequences (CSI, OSC, and
/// two-byte escapes) and all whitespace dropped.
fn screen_text(output: &[u8]) -> String {
    let tail = &output[output.len().saturating_sub(SCREEN_TAIL_BYTES)..];
    let text = String::from_utf8_lossy(tail);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            if !c.is_whitespace() && !c.is_control() {
                out.push(c);
            }
            continue;
        }
        match chars.next() {
            Some('[') => {
                // Parameters and intermediates, then one final byte.
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') | Some('P') | Some('_') | Some('^') => {
                // A string, ended by BEL or ST (ESC \).
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The message for a first-run screen the CLI is sitting on, if the newest
/// output shows one. Only meaningful before the CLI has said it is ready:
/// once a dialog is answered its text stays in the scrollback.
pub fn blocking_screen(output: &[u8]) -> Option<&'static str> {
    let text = screen_text(output);
    BLOCKING_SCREENS.iter().find_map(|(needle, message)| {
        let needle: String = needle.chars().filter(|c| !c.is_whitespace()).collect();
        text.contains(&needle).then_some(*message)
    })
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
        assert_eq!(v["statusLine"]["type"], "command");
        assert_eq!(v["statusLine"]["command"], "'/opt/raccoon' statusline");
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

    /// Bypass — the default, and what an unset mode means — launches with
    /// the CLI's documented flag and its disclaimer already accepted, on a
    /// fresh start, a resume, and a fork alike.
    #[test]
    fn bypass_is_the_default_launch_and_survives_resume() {
        if crate::binpath::resolve("claude").is_none() {
            return;
        }
        let settings = json!({"hooks": {}});
        let launch = |mode, resume, fork_from| {
            launch_command(LaunchOptions {
                provider_session_id: "s",
                resume,
                fork_from,
                model: "",
                effort: None,
                permission_mode: mode,
                title: None,
                settings: &settings,
            })
            .unwrap()
        };
        for mode in ["", crate::store::index::DEFAULT_PERMISSION_MODE, "bypass"] {
            for (resume, fork_from) in [(false, None), (true, None), (false, Some("parent"))] {
                let c = launch(mode, resume, fork_from);
                assert!(c.contains(" --dangerously-skip-permissions"), "{mode:?} resume={resume}: {c}");
                assert!(!c.contains("--permission-mode"), "{mode:?} resume={resume}: {c}");
                assert!(c.contains(r#""skipDangerousModePermissionPrompt":true"#), "{mode:?} resume={resume}");
            }
        }
        // An explicit other mode is kept, on resume too, and never bypasses.
        for mode in ["manual", "acceptEdits", "plan", "auto"] {
            for resume in [false, true] {
                let c = launch(mode, resume, None);
                assert!(c.contains(&format!("--permission-mode {mode}")), "{mode}");
                assert!(!c.contains("dangerously-skip-permissions"), "{mode}");
                assert!(!c.contains("skipDangerousModePermissionPrompt"), "{mode}");
            }
        }
    }

    /// The theme picker as the CLI draws it: words placed by cursor moves,
    /// colours, and a hidden cursor, not a line of spaced text.
    const THEME_PICKER: &[u8] = b"\x1b[?25l\x1b[2J\x1b[1;1HWelcome\x1b[1Cto\x1b[1CClaude\x1b[1CCode\r\n\x1b[1mLet's\x1b[1Cget\x1b[1Cstarted.\x1b[22m\r\n\x1b[1mChoose\x1b[1Cthe\x1b[1Ctext\x1b[1Cstyle\x1b[1Cthat\x1b[1Clooks\x1b[1Cbest\x1b[1Cwith\x1b[1Cyour\x1b[1Cterminal\x1b[22m\r\n\x1b]0;claude\x07\x1b[38;5;2m\xe2\x9d\xaf 2. Dark mode\x1b[39m";

    #[test]
    fn a_first_run_screen_is_recognised_through_the_terminal_escapes() {
        let message = blocking_screen(THEME_PICKER).expect("the theme picker blocks the prompt");
        assert!(message.contains("first-run setup"));

        let api_key = b"\x1b[33mDetected a custom API key in your environment\x1b[39m\r\n\r\nANTHROPIC_API_KEY: sk-ant-...abcd\r\n\r\nDo you want to use this API key?";
        assert!(blocking_screen(api_key).unwrap().contains("ANTHROPIC_API_KEY"));

        let trust = b"Quick\x1b[1Csafety\x1b[1Ccheck:\x1b[1CIs\x1b[1Cthis\x1b[1Ca\x1b[1Cproject\x1b[1Cyou\x1b[1Ccreated\x1b[1Cor\x1b[1Cone\x1b[1Cyou\x1b[1Ctrust?";
        assert!(blocking_screen(trust).unwrap().contains("trust this folder"));

        let bypass = b"By proceeding, you accept all responsibility for actions taken while running\r\nin Bypass Permissions mode.\r\n\xe2\x9d\xaf No, exit\r\n  Yes, I accept";
        assert!(blocking_screen(bypass).unwrap().contains("Bypass Permissions"));
    }

    #[test]
    fn the_composer_is_not_a_blocking_screen() {
        let composer = "\x1b[2m\u{2500}\u{2500}\u{2500}\x1b[22m\r\n\u{276f} \x1b[7m \x1b[27m\r\n\u{23f8} manual mode on \u{b7} ? for shortcuts";
        assert_eq!(blocking_screen(composer.as_bytes()), None);
        assert_eq!(blocking_screen(b""), None);
        // Half an escape at the end of a read is not a panic.
        assert_eq!(blocking_screen(b"\x1b[38;5"), None);
        assert_eq!(blocking_screen(b"\x1b]0;title"), None);
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
