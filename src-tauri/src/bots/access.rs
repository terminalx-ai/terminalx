//! What a bot's access lets its chats do (PRO-478), enforced outside the
//! agent's own judgment.
//!
//! A session that acts for a bot runs in a permission mode no wider than the
//! bot's access allows (`chat::permission_mode`, held by `chat::mode_limit`
//! and `enforce::reconcile`, PRO-468). On top of that mode, every tool call
//! its agent makes passes through this gate ([`session_gate`]): the hooks'
//! `PreToolUse` and `PermissionRequest`, and native Codex's approval
//! requests, which read the bot's access as it is now.
//!
//! | Access | Mode | The gate |
//! | -- | -- | -- |
//! | Full access | the owner's default (bypass) | leaves every call to the agent |
//! | Ask before outward actions | Ask every time (native Codex: plan) | lets reads through; asks before anything else |
//! | Read and report | plan | lets reads through; asks before a report leaves; refuses the rest |
//! | Paused, or unreadable | plan | lets reads through; refuses the rest |
//!
//! The mode is the barrier and the gate only adds to it. A read is a named
//! read tool, a shell command vetted read-only, or a `terminalx` read; a
//! connected server's (MCP) tool is never taken for one.
//!
//! At every level a bot is refused a write to `bots.json` or the app's
//! `settings.json` (resolved against its folder, through links, in any letter
//! case), and a shell command naming either. Who may change a bot, approve a
//! card or write to the runtime is settled where the command arrives, by who
//! sent it (`control::Caller`), not here.
//!
//! None of this is a sandbox. Like the run worker's limits
//! (`orchestration::guard`), it stops what a bot not trying to get around it
//! would do by habit or because text it read told it to; a bot with full
//! access can still write any file on this Mac by other means.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use super::{chat, BotAccess};
use crate::orchestration::guard;
use crate::store::bots as bot_store;
use crate::store::index;

/// What becomes of one tool call of a bot's chat.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Gate {
    /// The agent's own permission mode decides.
    Leave,
    /// The owner is asked first; the reason is shown to them.
    Ask(String),
    /// Refused; the reason is what the agent is told.
    Refuse(String),
}

/// The gate for one tool call of `session_id`, whose frame carried its
/// launch's token, as the bot it acts for is now (`chat::acting_bot`: its
/// chats and the sessions they started). Nothing for any other session, nor
/// while Bots is off (its chats are stopped, `enforce::reconcile`), nor for a
/// bot that is gone (the mode it was held to stays). A paused bot, or one
/// that cannot be read, is gated as read and report with nothing asked: not
/// knowing never reads as full access.
pub fn session_gate(session_id: &str, payload: &Value) -> Gate {
    if !super::enabled() {
        return Gate::Leave;
    }
    let Some(bot_id) = index::get(session_id).ok().as_ref().and_then(chat::acting_bot) else {
        return Gate::Leave;
    };
    match bot_store::get(&bot_id) {
        Ok(Some(bot)) if bot.paused.is_some() => held(payload, &format!("{} is paused", bot.name)),
        Ok(Some(bot)) => gate(&bot.access, payload),
        Ok(None) => Gate::Leave,
        Err(error) => {
            log::warn!("bot {bot_id}'s access cannot be read, so its session is held to read and report: {error:#}");
            held(payload, "its bot cannot be read")
        }
    }
}

/// [`session_gate`] for an approval native Codex asks for: it runs no hooks,
/// so its requests to run a command or change files are where its calls meet
/// the gate. Plan mode's read-only sandbox runs the rest without asking.
pub fn approval_gate(session_id: &str, method: &str, params: &Value, cwd: Option<&str>) -> Gate {
    let payload = match method {
        "item/commandExecution/requestApproval" => json!({"tool_name": "Bash", "tool_input": {"command": params["command"]}, "cwd": cwd}),
        "item/fileChange/requestApproval" => json!({"tool_name": "apply_patch", "tool_input": params, "cwd": cwd}),
        other => json!({"tool_name": other, "tool_input": params, "cwd": cwd}),
    };
    session_gate(session_id, &payload)
}

/// A paused bot, or one that cannot be read: it reads, and nothing else runs, nor is asked.
fn held(payload: &Value, why: &str) -> Gate {
    match gate(&BotAccess::ReadReport, payload) {
        Gate::Ask(_) => Gate::Refuse(format!("TerminalX refused {}: {why}, so it only reads until your owner resumes it. This did not run. Say in the chat what you wanted to do.", describe(payload["tool_name"].as_str().unwrap_or_default(), &payload["tool_input"]))),
        gate => gate,
    }
}

/// What a tool call with `payload` comes to at `access`.
///
/// The session's permission mode is the barrier (`chat::permission_mode`,
/// held by `chat::mode_limit`); this adds to it and never widens it. It lets through unasked only what is known to read:
/// a named read tool, a shell command vetted read-only, a `terminalx` read.
pub fn gate(access: &BotAccess, payload: &Value) -> Gate {
    let tool = payload["tool_name"].as_str().unwrap_or_default();
    let input = &payload["tool_input"];
    let cwd = payload["cwd"].as_str();
    if let Some(what) = own_settings(tool, input, cwd) {
        return Gate::Refuse(format!("TerminalX refused this: it names {what}, where your owner keeps your access, your reporting line and whether you are paused. A bot does not change them, and runs no command on them; read them with the Read tool if you must. Ask your owner in the chat if something there should change."));
    }
    let access = access.effective();
    if access == BotAccess::Full || reads(tool, input, cwd) {
        return Gate::Leave;
    }
    let what = describe(tool, input);
    match access {
        BotAccess::AskOutward => Gate::Ask(format!("This bot reads freely and asks before it changes anything or runs a command: {what}.")),
        _ => match single(tool, input, |program, args| report_command(program, args).is_some()) {
            true => Gate::Ask(format!("This bot reads and reports only, and asks before a report leaves this computer: {what}.")),
            false => Gate::Refuse(format!("TerminalX refused {what}: this bot is set to Read and report, so it changes nothing and runs only commands known to read. This did not run. Read with Read, Grep or Glob or with commands that only read, and report what you found in the chat.")),
        },
    }
}

/// The tools that only read, or only talk to the owner, by the names the
/// agents give them. A connected server's (MCP) tool is never one: what it
/// does cannot be told from its name.
const READ_TOOLS: &[&str] = &["Read", "Grep", "Glob", "LS", "NotebookRead", "WebSearch", "WebFetch", "TodoWrite", "Task", "Agent", "ExitPlanMode", "AskUserQuestion", "BashOutput", "view_image", "update_plan"];

/// Whether a call only reads.
fn reads(tool: &str, input: &Value, cwd: Option<&str>) -> bool {
    if READ_TOOLS.contains(&tool) {
        return true;
    }
    if !guard::SHELL_TOOLS.contains(&tool) {
        return false;
    }
    let scope = crate::harness::read_only::explicit_cwd(input).or_else(|| crate::harness::read_only::reported_scope(input, cwd));
    if crate::harness::read_only::vetted(tool, input, scope).is_ok() {
        return true;
    }
    // A `terminalx` read on its own: `terminalx sessions list --json`.
    single(tool, input, terminalx_read)
}

/// A shell call's program and arguments when it is one plain command.
fn single(tool: &str, input: &Value, check: impl Fn(&str, &[&str]) -> bool) -> bool {
    let Some(words) = shell_command(tool, input).as_deref().and_then(guard::single_command) else { return false };
    let Some((program, args)) = words.split_first() else { return false };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    check(program.rsplit('/').next().unwrap_or(program), &args)
}

/// The `terminalx` groups and the verbs that only read in them.
fn terminalx_read(program: &str, args: &[&str]) -> bool {
    const GROUPS: &[&str] = &["sessions", "projects", "tabs", "issues", "worktrees", "pipelines", "runs", "bots", "permissions", "machines", "cloud", "review"];
    const VERBS: &[&str] = &["list", "show", "status", "view", "transcript", "get", "read", "help"];
    if !matches!(program, "terminalx" | "tnx") {
        return false;
    }
    let plain: Vec<&str> = args.iter().copied().filter(|arg| !arg.starts_with('-')).collect();
    let Some(at) = plain.iter().take(3).position(|word| GROUPS.contains(word)) else { return false };
    plain.get(at + 1).is_some_and(|verb| VERBS.contains(verb))
}

/// A call as the card and the agent are told it.
fn describe(tool: &str, input: &Value) -> String {
    match shell_command(tool, input) {
        Some(command) => {
            let short: String = command.chars().take(120).collect();
            format!("`{short}{}`", if short.len() < command.len() { "…" } else { "" })
        }
        None => format!("`{tool}`"),
    }
}

/// A shell tool's command as one line: Claude's string, or Codex's words.
fn shell_command(tool: &str, input: &Value) -> Option<String> {
    if !guard::SHELL_TOOLS.contains(&tool) {
        return None;
    }
    input["command"].as_str().map(str::to_owned).or_else(|| input["command"].as_array().map(|words| words.iter().filter_map(Value::as_str).map(quote).collect::<Vec<_>>().join(" ")))
}

/// A report: a comment, an issue or a message, which says something and changes nothing else.
fn report_command(program: &str, args: &[&str]) -> Option<String> {
    let plain: Vec<&str> = args.iter().copied().filter(|arg| !arg.starts_with('-')).collect();
    match (program, plain.as_slice()) {
        ("gh", ["pr" | "issue", "comment", ..] | ["issue", "create", ..]) => Some(format!("gh {} {}", plain[0], plain[1])),
        ("terminalx" | "tnx", ["sessions", "send", ..] | ["issues", "comment" | "create", ..]) => Some(format!("{program} {} {}", plain[0], plain[1])),
        _ => None,
    }
}

/// A word as a shell reads it back as one word.
fn quote(word: &str) -> String {
    if !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c)) {
        word.into()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// The app's own record a call names, if it names one: the bots' definitions
/// or the settings. A file tool is refused one only to write it; a shell
/// command is refused one whatever it does with it, since what it does
/// cannot be told for certain.
fn own_settings(tool: &str, input: &Value, cwd: Option<&str>) -> Option<&'static str> {
    let root = crate::store::root().ok()?;
    let guarded = Guarded::new(&root);
    if READ_TOOLS.contains(&tool) {
        return None;
    }
    if !guard::SHELL_TOOLS.contains(&tool) {
        for key in ["file_path", "path", "notebook_path"] {
            if let Some(what) = input[key].as_str().and_then(|path| guarded.names(path, cwd)) {
                return Some(what);
            }
        }
        // `apply_patch` names its files inside the patch.
        let patch = input["patch"].as_str().or(input["input"].as_str()).or(input["command"].as_str());
        return patch.and_then(|patch| patch.split_whitespace().find_map(|word| guarded.names(word, cwd)));
    }
    let command = shell_command(tool, input)?;
    guard::find_command(&command, &|program, args| std::iter::once(program).chain(args.iter().copied()).find_map(|word| guarded.word(word, cwd)))
}

/// `bots.json` and `settings.json` in the app's data folder, as they are
/// found through links and in any letter case.
struct Guarded {
    files: [(String, &'static str); 2],
}

impl Guarded {
    fn new(root: &Path) -> Self {
        let root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let key = |name: &str| root.join(name).to_string_lossy().to_lowercase();
        Self { files: [(key("bots.json"), "bots.json"), (key("settings.json"), "TerminalX's settings.json")] }
    }

    /// The record `path` is, against `cwd` when it is relative.
    fn names(&self, path: &str, cwd: Option<&str>) -> Option<&'static str> {
        let path = path.trim_matches(|c| matches!(c, '"' | '\'' | ',' | ';' | ':'));
        let name = Path::new(path).file_name()?.to_string_lossy().to_lowercase();
        if name != "bots.json" && name != "settings.json" {
            return None;
        }
        let key = resolved(&expand_home(path), cwd).to_string_lossy().to_lowercase();
        if let Some((_, what)) = self.files.iter().find(|(file, _)| *file == key) {
            return Some(what);
        }
        // Where a relative path starts cannot be told: `bots.json` is the app's until shown otherwise.
        (name == "bots.json" && cwd.is_none() && Path::new(path).is_relative()).then_some("bots.json")
    }

    /// One shell word: a path, a redirection's target, or an option's value.
    fn word(&self, word: &str, cwd: Option<&str>) -> Option<&'static str> {
        let word = word.trim_start_matches(|c: char| c.is_ascii_digit() || matches!(c, '>' | '<' | '&'));
        self.names(word, cwd).or_else(|| word.split_once('=').and_then(|(_, value)| self.names(value, cwd)))
    }
}

/// `~/…`, `$HOME/…` and `${HOME}/…` as the home folder.
fn expand_home(path: &str) -> PathBuf {
    let rest = path.strip_prefix("~/").or_else(|| path.strip_prefix("$HOME/")).or_else(|| path.strip_prefix("${HOME}/"));
    match (rest, dirs::home_dir()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

/// `path` against `cwd`, with `.` and `..` taken out and the folders it
/// passes through followed where they are links.
fn resolved(path: &Path, cwd: Option<&str>) -> PathBuf {
    let joined = match cwd {
        Some(cwd) if path.is_relative() => Path::new(cwd).join(path),
        _ => path.to_path_buf(),
    };
    if let Ok(real) = std::fs::canonicalize(&joined) {
        return real;
    }
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::ParentDir => {
                out = std::fs::canonicalize(&out).unwrap_or(out);
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    match (out.parent().and_then(|parent| std::fs::canonicalize(parent).ok()), out.file_name()) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => out,
    }
}

/// What a refused ask tells the agent: no answer, a lapsed card, or the owner's no.
const NOT_ALLOWED: &str = "Your owner did not allow this. It did not run. Say in the chat what you wanted to do and why, and let them decide.";

/// Claude Code's `PreToolUse` answer to a gate that asks: Claude raises its
/// own permission request, which the app's card answers.
pub fn claude_ask(reason: &str) -> Value {
    json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "ask", "permissionDecisionReason": reason } })
}

/// The owner's answer on the card, as Codex's `PreToolUse` hook prints it.
/// The card answers in that form already; what is not an answer at all (a
/// lapsed card, a tab whose agent moved on) would read to Codex as "go
/// ahead", so it is a refusal here.
pub fn codex_answer(answer: Option<Value>) -> Value {
    answer.unwrap_or_else(|| guard::refusal_output(NOT_ALLOWED))
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;
