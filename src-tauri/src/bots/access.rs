//! What a bot's access lets its chats do (PRO-478), enforced outside the
//! agent's own judgment.
//!
//! A bot's chat starts in the permission mode its access maps to
//! ([`launch_mode`]), and every tool call its agent makes passes through the
//! app's `PreToolUse` gate ([`session_gate`]), which reads the bot's access
//! as it is now: a change on the settings page reaches the very next call,
//! in a conversation already running or the next one.
//!
//! | Access | Mode | The gate |
//! | -- | -- | -- |
//! | Full access | the owner's default (bypass) | leaves every call to the agent |
//! | Ask before outward actions | ask | asks the owner before a push, merge, deploy, post or message |
//! | Read and report | plan / read-only | refuses every change; asks before a report leaves |
//!
//! At every level a bot is refused a change to its own record or to the
//! app's settings: a bot never raises its own access, changes whom it
//! reports to, or resumes itself.
//!
//! Like the run worker's limits (`orchestration::guard`), none of this is a
//! sandbox: it reads a command as a shell would and stops what a bot that is
//! not trying to get around it would otherwise do by habit or because text
//! it read told it to.

use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use super::BotAccess;
use crate::orchestration::guard::{self, Limit};
use crate::store::bots as bot_store;
use crate::store::index::{self, SessionEntry};

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

/// The permission mode a bot's chat runs in at `access`. A level this build
/// does not know runs as read and report.
pub fn launch_mode(access: &BotAccess) -> &'static str {
    match access.effective() {
        BotAccess::Full => index::DEFAULT_PERMISSION_MODE,
        BotAccess::AskOutward => "manual",
        BotAccess::ReadReport | BotAccess::Other(_) => guard::VERIFIER_MODE,
    }
}

/// The bot a session is a chat of: the id its entry carries under `bot`
/// (PRO-468). An entry that carries none, or one this build cannot read, is
/// no bot's.
pub fn session_bot_id(entry: &SessionEntry) -> Option<String> {
    entry.unknown.get("bot")?.get("id")?.as_str().filter(|id| !id.is_empty()).map(str::to_owned)
}

/// The agent tabs of `bot_id`'s chats not yet in `mode`, as (session, tab).
/// An access change switches them, so the next conversation in any of them
/// starts in the mode the new access maps to.
pub fn tabs_to_switch(bot_id: &str, mode: &str) -> Vec<(String, String)> {
    let sessions = index::load().unwrap_or_else(|error| {
        log::warn!("bot {bot_id}'s chats cannot be read to switch their mode: {error:#}");
        Vec::new()
    });
    sessions
        .iter()
        .filter(|entry| !entry.archived && session_bot_id(entry).as_deref() == Some(bot_id))
        .flat_map(|entry| entry.tabs.iter().filter(|tab| !tab.is_terminal() && tab.permission_mode != mode).map(|tab| (entry.id.clone(), tab.id.clone())))
        .collect()
}

/// The gate for a `PreToolUse` of `session_id`, whose frame carried its
/// launch's token. Nothing for a session that is no bot's chat, nor while
/// Bots is off, nor for a bot that is gone. Bots that cannot be read are
/// gated as read and report: not knowing never reads as full access.
pub fn session_gate(session_id: &str, payload: &Value) -> Gate {
    if !super::enabled() {
        return Gate::Leave;
    }
    let Some(bot_id) = index::get(session_id).ok().as_ref().and_then(session_bot_id) else {
        return Gate::Leave;
    };
    match bot_store::get(&bot_id) {
        Ok(Some(bot)) => gate(&bot.access, payload),
        Ok(None) => Gate::Leave,
        Err(error) => {
            log::warn!("bot {bot_id}'s access cannot be read, so its chat is held to read and report: {error:#}");
            gate(&BotAccess::ReadReport, payload)
        }
    }
}

/// What a `PreToolUse` with `payload` comes to at `access`.
pub fn gate(access: &BotAccess, payload: &Value) -> Gate {
    let tool = payload["tool_name"].as_str().unwrap_or_default();
    let input = &payload["tool_input"];
    if let Some(what) = own_settings(tool, input, payload["cwd"].as_str()) {
        return Gate::Refuse(format!("TerminalX refused this: it names {what}, where your owner keeps your access, your reporting line and whether you are paused. A bot does not change them, and runs no command on them; read them with the Read tool if you must. Ask your owner in the chat if something there should change."));
    }
    match access.effective() {
        BotAccess::Full => Gate::Leave,
        BotAccess::AskOutward => match outward(tool, input) {
            Some(found) => Gate::Ask(format!("This bot asks before anything that leaves this computer: {}.", found.what)),
            None => Gate::Leave,
        },
        BotAccess::ReadReport | BotAccess::Other(_) => read_report(tool, input, payload["cwd"].as_str()),
    }
}

/// Read and report: a call that changes anything is refused; a report (a
/// comment, an issue, a message) is asked about; a read goes ahead.
fn read_report(tool: &str, input: &Value, cwd: Option<&str>) -> Gate {
    let refuse = |what: &str| Gate::Refuse(format!("TerminalX refused {what}: this bot is set to Read and report, so it changes nothing. This did not run. Read with Read, Grep or Glob or with commands that only read, and report what you found in the chat."));
    if guard::EDIT_TOOLS.contains(&tool) {
        return refuse(&format!("`{tool}`"));
    }
    if let Some(found) = outward(tool, input) {
        return match found.kind {
            Outward::Report => Gate::Ask(format!("This bot reads and reports only, and asks before a report leaves this computer: {}.", found.what)),
            Outward::Change => refuse(&format!("`{}`", found.what)),
        };
    }
    if let Some(server_tool) = tool.strip_prefix("mcp__") {
        // A connected server's tool that only reads goes ahead; `outward` asked about the rest.
        return if reads_by_name(server_tool) { Gate::Leave } else { refuse(&format!("`{tool}`")) };
    }
    if !guard::SHELL_TOOLS.contains(&tool) {
        return Gate::Leave;
    }
    let cwd = crate::harness::read_only::explicit_cwd(input).or_else(|| crate::harness::read_only::reported_scope(input, cwd));
    match crate::harness::read_only::vetted(tool, input, cwd) {
        Ok(_) => Gate::Leave,
        Err(reason) => refuse(&format!("this command ({reason})")),
    }
}

/// What kind of outward call one is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Outward {
    /// Says something to someone: a comment, an issue, a message, a request with a body.
    Report,
    /// Changes something elsewhere: a push, a merge, a deploy, a repository's settings.
    Change,
}

struct Found {
    kind: Outward,
    what: String,
}

/// Whether a tool call reaches past this computer, and how.
fn outward(tool: &str, input: &Value) -> Option<Found> {
    if let Some(server_tool) = tool.strip_prefix("mcp__") {
        if reads_by_name(server_tool) {
            return None;
        }
        // Writing a file through a server is a change; anything else a server does may be a post or a message.
        let changes = ["__write_file", "__edit_file", "__create_or_update_file", "__push_files", "__merge_pull_request"].iter().any(|suffix| tool.ends_with(suffix));
        return Some(Found { kind: if changes { Outward::Change } else { Outward::Report }, what: format!("`{tool}`") });
    }
    if !guard::SHELL_TOOLS.contains(&tool) {
        return None;
    }
    let command = input["command"].as_str().map(str::to_owned).or_else(|| {
        // Codex's `exec_command` and `shell` give the command as its words.
        input["command"].as_array().map(|words| words.iter().filter_map(Value::as_str).map(quote).collect::<Vec<_>>().join(" "))
    })?;
    guard::find_command(&command, &outward_command)
}

/// A word as a shell reads it back as one word.
fn quote(word: &str) -> String {
    if !word.is_empty() && word.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c)) {
        word.into()
    } else {
        format!("'{}'", word.replace('\'', "'\\''"))
    }
}

/// A connected server's tool whose name says it only reads (`mcp__linear__list_issues`).
fn reads_by_name(server_tool: &str) -> bool {
    let name = server_tool.rsplit("__").next().unwrap_or(server_tool).to_ascii_lowercase();
    ["get", "list", "search", "read", "fetch", "query", "find", "view", "describe", "show"].iter().any(|verb| name == *verb || name.starts_with(&format!("{verb}_")) || name.starts_with(&format!("{verb}-")))
}

/// Whether one program and its arguments reach past this computer.
fn outward_command(program: &str, args: &[&str]) -> Option<Found> {
    let change = |what: String| Some(Found { kind: Outward::Change, what });
    let report = |what: String| Some(Found { kind: Outward::Report, what });
    // A run worker's limits: a push, a merge, a deploy. Starting a session or a run stays on this computer.
    if let Some((_, said)) = guard::rule_broken(program, args).filter(|(rule, _)| rule.limit != Limit::Delegate) {
        return change(said);
    }
    let plain: Vec<&str> = args.iter().copied().filter(|arg| !arg.starts_with('-')).collect();
    match program {
        "gh" => match plain.as_slice() {
            ["pr" | "issue", "comment", ..] | ["issue", "create", ..] => report(format!("gh {} {}", plain[0], plain[1])),
            ["pr", "review", ..] => report("gh pr review".into()),
            ["pr" | "issue", verb @ ("close" | "reopen" | "edit" | "ready" | "lock" | "unlock" | "delete" | "transfer" | "pin" | "unpin" | "develop"), ..] => change(format!("gh {} {verb}", plain[0])),
            ["release" | "repo" | "gist" | "label" | "secret" | "variable" | "ruleset" | "project", verb, ..] if !matches!(*verb, "list" | "view" | "download" | "clone" | "status") => change(format!("gh {} {verb}", plain[0])),
            ["api", ..] if api_writes(args) => report("gh api with a request body or a method other than GET".into()),
            _ => None,
        },
        "curl" if curl_sends(args) => report("curl sending a request body or a method other than GET".into()),
        "wget" if args.iter().any(|arg| ["--post-data", "--post-file", "--method", "--body-data", "--body-file"].iter().any(|flag| arg.starts_with(flag))) => report("wget sending a request".into()),
        "ssh" | "scp" | "sftp" => change(program.into()),
        "rsync" if plain.iter().any(|arg| remote_path(arg)) => change("rsync to another machine".into()),
        "osascript" => report("osascript, which can message and post as you".into()),
        "terminalx" | "tnx" => match plain.as_slice() {
            ["sessions", "send", ..] | ["issues", "comment" | "create", ..] => report(format!("{program} {} {}", plain[0], plain[1])),
            _ => None,
        },
        _ => None,
    }
}

/// `host:path` or `user@host:path`, not a local path with a colon in a later part.
fn remote_path(arg: &str) -> bool {
    arg.split_once(':').is_some_and(|(host, _)| !host.is_empty() && !host.contains('/'))
}

/// `gh api` sends a body or uses a method other than GET.
fn api_writes(args: &[&str]) -> bool {
    method_not_get(args, &["-X", "--method"]) || args.iter().any(|arg| ["-f", "-F", "--field", "--raw-field", "--input"].iter().any(|flag| arg == flag || arg.starts_with(&format!("{flag}="))) || (arg.starts_with("-f") || arg.starts_with("-F")) && arg.len() > 2 && !arg.starts_with("--"))
}

/// `curl` sends a body, a file or a method other than GET or HEAD.
fn curl_sends(args: &[&str]) -> bool {
    const BODY: &[&str] = &["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "--json", "-F", "--form", "--form-string", "-T", "--upload-file"];
    method_not_get(args, &["-X", "--request"]) || args.iter().any(|arg| BODY.iter().any(|flag| arg == flag || arg.starts_with(&format!("{flag}=")) || (flag.len() == 2 && arg.starts_with(flag) && !arg.starts_with("--"))))
}

/// Whether one of `flags` names a method other than GET or HEAD: `-X POST`, `-XPOST`, `--method=PATCH`.
fn method_not_get(args: &[&str], flags: &[&str]) -> bool {
    let mut words = args.iter();
    while let Some(arg) = words.next() {
        for flag in flags {
            let value = if arg == flag {
                words.clone().next().copied()
            } else if let Some(value) = arg.strip_prefix(&format!("{flag}=")) {
                Some(value)
            } else if flag.len() == 2 && arg.starts_with(flag) && !arg.starts_with("--") {
                Some(&arg[2..])
            } else {
                None
            };
            if value.is_some_and(|method| !method.eq_ignore_ascii_case("GET") && !method.eq_ignore_ascii_case("HEAD")) {
                return true;
            }
        }
    }
    false
}

/// The app's own record a call names, if it names one: the bots' definitions
/// or the settings. A file tool is refused one only to write it; a shell
/// command is refused one whatever it does with it, since what it does
/// cannot be told for certain.
fn own_settings(tool: &str, input: &Value, cwd: Option<&str>) -> Option<&'static str> {
    let root = crate::store::root().ok()?;
    let guarded = [(root.join("bots.json"), "bots.json"), (root.join("settings.json"), "TerminalX's settings.json")];
    if guard::EDIT_TOOLS.contains(&tool) || tool.starts_with("mcp__") {
        for key in ["file_path", "path", "notebook_path"] {
            if let Some(path) = input[key].as_str() {
                let path = lexical(Path::new(path), cwd);
                if let Some((_, what)) = guarded.iter().find(|(guarded, _)| path == *guarded) {
                    return Some(*what);
                }
            }
        }
        // `apply_patch` names its files inside the patch.
        if let Some(patch) = input["patch"].as_str().or(input["input"].as_str()).or(input["command"].as_str()) {
            if names_guarded(patch, &root) {
                return Some("the app's own settings");
            }
        }
        return None;
    }
    if guard::SHELL_TOOLS.contains(&tool) {
        let command = input["command"].as_str().map(str::to_owned).or_else(|| input["command"].as_array().map(|words| words.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")))?;
        if names_guarded(&command, &root) {
            return Some("the app's own settings");
        }
    }
    None
}

/// Text that names `bots.json` or `settings.json` in the app's data folder.
fn names_guarded(text: &str, root: &Path) -> bool {
    let folder = root.to_string_lossy();
    let name = root.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let in_root = text.contains(folder.as_ref()) || (!name.is_empty() && text.contains(&format!("{name}/")));
    in_root && (text.contains("bots.json") || text.contains("settings.json"))
}

/// `path` with `.` and `..` taken out, against `cwd` when it is relative.
fn lexical(path: &Path, cwd: Option<&str>) -> PathBuf {
    let joined = match cwd {
        Some(cwd) if path.is_relative() => Path::new(cwd).join(path),
        _ => path.to_path_buf(),
    };
    let mut out = PathBuf::new();
    for part in joined.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// The owner's answer on the card, as Claude Code's `PreToolUse` hook prints
/// it. `permission` is that card's answer in `PermissionRequest` form; only
/// its explicit allow lets the call go ahead.
pub fn claude_answer(permission: Option<&Value>) -> Value {
    let allowed = permission.is_some_and(|output| output["hookSpecificOutput"]["decision"]["behavior"] == "allow");
    if allowed {
        json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "allow", "permissionDecisionReason": "Your owner allowed this." } })
    } else {
        guard::refusal_output("Your owner did not allow this. It did not run. Say in the chat what you wanted to do and why, and let them decide.")
    }
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;
