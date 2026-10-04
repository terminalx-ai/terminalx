//! Argument parsing and output for the `terminalx` thin client.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::control::{self, ControlError, ControlResponse};

pub const GUIDE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../skill-guides/terminalx-cli.md"
));
pub const SKILL_STUB: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../skills/terminalx-cli/SKILL.md"
));
pub const COMPUTER_GUIDE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../skill-guides/computer-use.md"
));
pub const COMPUTER_SKILL_STUB: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../skills/computer-use/SKILL.md"
));

/// Every guide this binary can serve through `terminalx skills get <name>`,
/// with the discovery stub "Install skills" writes for it.
pub const SKILLS: [(&str, &str, &str); 2] = [
    ("terminalx-cli", GUIDE, SKILL_STUB),
    ("computer-use", COMPUTER_GUIDE, COMPUTER_SKILL_STUB),
];

const HELP: &str = r#"terminalx — control a running TerminalX app

Usage:
  terminalx status [--json]
  terminalx projects list [--json]
  terminalx sessions list [--project PROJECT] [--json]
  terminalx sessions create --project PROJECT --agent AGENT --prompt TEXT
      [--title TEXT] [--name NAME]
      [--worktree|--on-main] [--model MODEL] [--effort EFFORT] [--mode MODE] [--json]
  terminalx sessions show SESSION [--json]
  terminalx sessions rename SESSION --title TEXT [--json]
  terminalx tabs list SESSION [--json]
  terminalx send SESSION_OR_TAB TEXT [--json]
  terminalx read SESSION_OR_TAB [--since SEQ] [--tail COUNT] [--json]
  terminalx wait SESSION_OR_TAB [--timeout SECONDS] [--json]
  terminalx permissions list [--json]
  terminalx permissions allow REQUEST [--option OPTION] [--json]
  terminalx permissions deny REQUEST [--json]
  terminalx projects list --cloud [--org ORG] [--json]
  terminalx sessions list --cloud [--project CLOUD_PROJECT] [--org ORG] [--json]
  terminalx sessions create --project CLOUD_PROJECT --prompt TEXT [--agent AGENT]
      [--model MODEL] [--effort EFFORT] [--mode MODE] [--on-main]
      [--wake] [--confirm-spend] [--idempotency-key KEY] [--json]
  terminalx send CLOUD_SESSION TEXT [--tab TAB] [--idempotency-key KEY] [--json]
  terminalx read CLOUD_SESSION [--tab TAB] [--since SEQ] [--tail COUNT] [--json]
  terminalx wait CLOUD_SESSION [--tab TAB] [--timeout SECONDS] [--json]
  terminalx cloud status [--json]
  terminalx cloud stop CLOUD_WORKSPACE --yes [--json]
  terminalx cloud resume CLOUD_WORKSPACE [--json]
  terminalx worktrees list [--project PROJECT] [--json]
  terminalx worktrees rename WORKTREE --name NAME [--project PROJECT] [--json]
  terminalx worktrees delete WORKTREE [--project PROJECT] --yes [--force] [--json]
  terminalx issues list --project PROJECT [--provider github|linear]
      [--assigned-to-me] [--team ID] [--search TEXT] [--json]
  terminalx skills get terminalx-cli|computer-use [--full] [--json]

Computer use (desktop apps on macOS, Linux and Windows):
COMPUTER_HELP
BROWSER_HELP

Use `terminalx skills get terminalx-cli` for the complete guide and
`terminalx skills get computer-use` for desktop automation."#;

/// The help text with the computer and browser verbs spliced in from their
/// own modules.
fn help_text() -> String {
    HELP.replace("COMPUTER_HELP", crate::computer::cli::HELP)
        .replace("BROWSER_HELP", crate::browser::cli::HELP)
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Action {
    Rpc {
        command: String,
        params: Value,
        timeout: Duration,
    },
    Guide {
        name: &'static str,
        guide: &'static str,
    },
    Help,
    Version,
}

#[derive(Debug, Clone, PartialEq)]
struct Parsed {
    json: bool,
    action: Action,
}

/// Returns an exit code when this invocation is the CLI, otherwise lets the
/// desktop app continue into Tauri.
pub fn run_cli() -> Option<i32> {
    let all: Vec<String> = std::env::args().collect();
    let invoked = all
        .first()
        .and_then(|arg| Path::new(arg).file_stem())
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let offset = if matches!(invoked, "terminalx" | "tnx") {
        1
    } else if all
        .get(1)
        .is_some_and(|arg| matches!(arg.as_str(), "terminalx" | "tnx"))
    {
        2
    } else {
        return None;
    };
    Some(run(&all[offset..]))
}

fn run(args: &[String]) -> i32 {
    let wants_json = args.iter().any(|arg| arg == "--json");
    let parsed = match parse(args) {
        Ok(parsed) => parsed,
        Err(error) => {
            print_error(error, wants_json);
            return 2;
        }
    };
    match parsed.action {
        Action::Help => {
            let help = help_text();
            if parsed.json {
                print_response(
                    &ControlResponse::success("local", json!({"help": help})),
                    true,
                );
            } else {
                println!("{help}");
            }
            0
        }
        Action::Version => {
            if parsed.json {
                print_response(
                    &ControlResponse::success(
                        "local",
                        json!({"version": env!("CARGO_PKG_VERSION")}),
                    ),
                    true,
                );
            } else {
                println!("{}", env!("CARGO_PKG_VERSION"));
            }
            0
        }
        Action::Guide { name, guide } => {
            if parsed.json {
                print_response(
                    &ControlResponse::success(
                        "local",
                        json!({"name": name, "version": env!("CARGO_PKG_VERSION"), "guide": guide}),
                    ),
                    true,
                );
            } else {
                print!("{guide}");
                if !guide.ends_with('\n') {
                    println!();
                }
            }
            0
        }
        Action::Rpc {
            command,
            params,
            timeout,
        } => match if command == "cloud.wait" { cloud_wait(&params, timeout, &mut |command, params, timeout| control::call(command, params, timeout)) } else { control::call(&command, params.clone(), timeout) } {
            Ok(response) => {
                let ok = response.ok;
                let readable = (!parsed.json && ok)
                    .then(|| {
                        response.result.as_ref().and_then(|result| {
                            crate::computer::cli::format_result(&command, &params, result)
                                .or_else(|| crate::browser::cli::format(&command, result))
                        })
                    })
                    .flatten();
                match readable {
                    Some(text) => println!("{text}"),
                    None => print_response(&response, parsed.json),
                }
                if ok {
                    0
                } else {
                    1
                }
            }
            Err(error) => {
                print_error(error, parsed.json);
                1
            }
        },
    }
}

/// `wait` on a cloud session: the app waits at most
/// [`crate::cloud_control::WAIT_CHUNK_SECONDS`] per call, so the wait is asked
/// for again until the tab settles or the caller's timeout passes. When this
/// process is interrupted, at most one short wait is left behind in the app.
fn cloud_wait(
    params: &Value,
    timeout: Duration,
    call: &mut dyn FnMut(&str, Value, Duration) -> Result<ControlResponse, ControlError>,
) -> Result<ControlResponse, ControlError> {
    let mut left = params.get("timeoutSeconds").and_then(Value::as_u64).unwrap_or(600);
    loop {
        let chunk = left.min(crate::cloud_control::WAIT_CHUNK_SECONDS);
        let mut asked = params.clone();
        asked["timeoutSeconds"] = json!(chunk);
        let response = call("cloud.wait", asked, timeout)?;
        left -= chunk;
        let timed_out = response.ok && response.result.as_ref().and_then(|result| result.get("reason")).and_then(Value::as_str) == Some("timeout");
        if !timed_out || left == 0 {
            return Ok(response);
        }
    }
}

fn print_response(response: &ControlResponse, json_output: bool) {
    if json_output {
        println!(
            "{}",
            serde_json::to_string_pretty(response).unwrap_or_else(|_| "{\"ok\":false}".into())
        );
    } else if response.ok {
        let result = response.result.as_ref().unwrap_or(&Value::Null);
        match result {
            Value::String(text) => println!("{text}"),
            _ => println!(
                "{}",
                serde_json::to_string_pretty(result).unwrap_or_else(|_| "null".into())
            ),
        }
    } else if let Some(error) = &response.error {
        eprintln!("{}: {}", error.code, error.message);
        if let Some(recovery) = &error.recovery {
            eprintln!("Recovery: {recovery}");
        }
    }
}

fn print_error(error: ControlError, json_output: bool) {
    print_response(&ControlResponse::failure("local", error), json_output);
}

fn parse(args: &[String]) -> Result<Parsed, ControlError> {
    parse_with_stdin(args, &mut crate::computer::cli::read_stdin_payload)
}

/// `stdin` is only consulted for `--text-stdin` / `--value-stdin`, so the
/// parser can be tested without a real standard input.
fn parse_with_stdin(
    args: &[String],
    stdin: &mut dyn FnMut() -> Result<String, ControlError>,
) -> Result<Parsed, ControlError> {
    let mut tokens = Tokens::new(args);
    let json = tokens.flag("--json")?;
    if tokens.flag("--help")? || tokens.flag("-h")? {
        tokens.finish()?;
        return Ok(Parsed {
            json,
            action: Action::Help,
        });
    }
    if tokens.flag("--version")? || tokens.flag("-V")? {
        tokens.finish()?;
        return Ok(Parsed {
            json,
            action: Action::Version,
        });
    }
    let group = match tokens.take_front() {
        Some(group) => group,
        None => {
            return Ok(Parsed {
                json,
                action: Action::Help,
            })
        }
    };
    let action = match group.as_str() {
        "status" => rpc("status", json!({}), &mut tokens),
        "projects" => {
            expect_word(&mut tokens, "list", "projects")?;
            let org = tokens.option("--org")?;
            if tokens.flag("--cloud")? || org.is_some() {
                cloud_rpc("projects.list", json!({"org": org}), &mut tokens)
            } else {
                rpc("projects.list", json!({}), &mut tokens)
            }
        }
        "cloud" => parse_cloud(&mut tokens),
        "sessions" => parse_sessions(&mut tokens),
        "tabs" => {
            expect_word(&mut tokens, "list", "tabs")?;
            let session = tokens.required_front("session")?;
            rpc("tabs.list", json!({"session": session}), &mut tokens)
        }
        "send" => {
            let tab = tokens.option("--tab")?;
            let idempotency_key = tokens.option("--idempotency-key")?;
            let target = tokens.required_front("session or tab")?;
            let text = tokens.required_front("text")?;
            if is_cloud_key(&target) {
                cloud_rpc("send", json!({"target": target, "text": text, "tab": tab, "idempotencyKey": idempotency_key}), &mut tokens)
            } else {
                local_only(&tab, "--tab")?;
                local_only(&idempotency_key, "--idempotency-key")?;
                rpc("send", json!({"target": target, "text": text}), &mut tokens)
            }
        }
        "read" => {
            let since = tokens.option_u64("--since")?;
            let tail = tokens.option_u64("--tail")?;
            let tab = tokens.option("--tab")?;
            let target = tokens.required_front("session or tab")?;
            if is_cloud_key(&target) {
                cloud_rpc("read", json!({"target": target, "since": since, "tail": tail, "tab": tab}), &mut tokens)
            } else {
                local_only(&tab, "--tab")?;
                rpc(
                    "read",
                    json!({"target": target, "since": since, "tail": tail}),
                    &mut tokens,
                )
            }
        }
        "wait" if crate::browser::cli::is_browser_wait(&tokens.values) => {
            crate::browser::cli::parse("wait", &mut tokens).expect("wait is a browser verb")
        }
        "wait" => {
            let seconds = tokens.option_u64("--timeout")?.unwrap_or(600);
            let tab = tokens.option("--tab")?;
            let target = tokens.required_front("session or tab")?;
            tokens.finish()?;
            if is_cloud_key(&target) {
                // Asked in short calls until the timeout (see `cloud_wait`), so nothing outlives this process in the app.
                Ok(Action::Rpc {
                    command: "cloud.wait".into(),
                    params: json!({"target": target, "timeoutSeconds": seconds, "tab": tab}),
                    timeout: CLOUD_TIMEOUT,
                })
            } else {
                local_only(&tab, "--tab")?;
                Ok(Action::Rpc {
                    command: "wait".into(),
                    params: json!({"target": target, "timeoutSeconds": seconds}),
                    timeout: Duration::from_secs(seconds.saturating_add(10).max(30)),
                })
            }
        }
        "permissions" => parse_permissions(&mut tokens),
        "worktrees" => parse_worktrees(&mut tokens),
        "issues" => parse_issues(&mut tokens),
        "computer" => crate::computer::cli::parse(&mut tokens, stdin),
        "skills" => {
            expect_word(&mut tokens, "get", "skills")?;
            let name = tokens.required_front("skill name")?;
            let Some((name, guide, _)) = SKILLS.iter().find(|(known, _, _)| *known == name) else {
                return Err(ControlError::new(
                    "not_found",
                    format!("This binary does not embed a guide named {name}."),
                    Some("Use terminalx-cli or computer-use exactly.".into()),
                ));
            };
            let _full = tokens.flag("--full")?;
            tokens.finish()?;
            Ok(Action::Guide { name, guide })
        }
        other => match crate::browser::cli::parse(other, &mut tokens) {
            Some(action) => action,
            None => Err(invalid(format!("Unknown command group {other}."))),
        },
    }?;
    Ok(Parsed { json, action })
}

fn parse_sessions(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("sessions command")?.as_str() {
        "list" => {
            let project = tokens.option("--project")?;
            let org = tokens.option("--org")?;
            let cloud = tokens.flag("--cloud")?;
            if cloud || org.is_some() || project.as_deref().is_some_and(is_cloud_key) {
                cloud_rpc("sessions.list", json!({"project": project, "org": org}), tokens)
            } else {
                rpc("sessions.list", json!({"project": project}), tokens)
            }
        }
        "show" => {
            let session = tokens.required_front("session")?;
            rpc("sessions.show", json!({"session": session}), tokens)
        }
        "create" if tokens.peek_option("--project").is_some_and(|project| is_cloud_key(&project)) => parse_cloud_session_create(tokens),
        "rename" => {
            let title = tokens.required_option("--title")?;
            let session = tokens.required_front("session")?;
            rpc("sessions.rename", json!({"session": session, "title": title}), tokens)
        }
        "create" => {
            let project = tokens.required_option("--project")?;
            let agent = tokens.required_option("--agent")?;
            let prompt = tokens.required_option("--prompt")?;
            let title = tokens.option("--title")?;
            let name = tokens.option("--name")?;
            let model = tokens.option("--model")?;
            let effort = tokens.option("--effort")?;
            let mode = tokens.option("--mode")?;
            let worktree = tokens.flag("--worktree")?;
            let on_main = tokens.flag("--on-main")?;
            if worktree && on_main {
                return Err(invalid("--worktree and --on-main are mutually exclusive."));
            }
            if name.is_some() && on_main {
                return Err(invalid("--name requires a new worktree and cannot be used with --on-main."));
            }
            rpc(
                "sessions.create",
                json!({
                    "project": project,
                    "agent": agent,
                    "prompt": prompt,
                    "title": title,
                    "name": name,
                    "useWorktree": !on_main,
                    "onMain": on_main,
                    "model": model.unwrap_or_default(),
                    "effort": effort,
                    "mode": mode,
                }),
                tokens,
            )
        }
        other => Err(invalid(format!("Unknown sessions command {other}."))),
    }
}

/// A cloud project, workspace or session is named by its key (`cloud:…`).
fn is_cloud_key(value: &str) -> bool {
    value.starts_with("cloud:")
}

/// An option that only a cloud target takes.
fn local_only(option: &Option<String>, name: &str) -> Result<(), ControlError> {
    match option {
        Some(_) => Err(invalid(format!("{name} applies to a cloud session (cloud:…) only."))),
        None => Ok(()),
    }
}

/// How long the CLI waits on the socket for a `cloud.*` command: a little
/// longer than the app waits for its window, so the app's answer is printed.
const CLOUD_TIMEOUT: Duration = Duration::from_secs(60);
const CLOUD_CREATE_TIMEOUT: Duration = Duration::from_secs(340);

fn cloud_rpc(action: &str, params: Value, tokens: &mut Tokens) -> Result<Action, ControlError> {
    tokens.finish()?;
    Ok(Action::Rpc {
        command: format!("cloud.{action}"),
        params,
        timeout: if action == "sessions.create" { CLOUD_CREATE_TIMEOUT } else { CLOUD_TIMEOUT },
    })
}

/// A new session in a cloud project. It runs in the project's running
/// workspace; resuming a stopped one (`--wake`) and creating a new machine
/// (`--confirm-spend`) cost money, so each must be asked for by name.
fn parse_cloud_session_create(tokens: &mut Tokens) -> Result<Action, ControlError> {
    let project = tokens.required_option("--project")?;
    let prompt = tokens.required_option("--prompt")?;
    let agent = tokens.option("--agent")?;
    let model = tokens.option("--model")?;
    let effort = tokens.option("--effort")?;
    let mode = tokens.option("--mode")?;
    let idempotency_key = tokens.option("--idempotency-key")?;
    let worktree = tokens.flag("--worktree")?;
    let on_main = tokens.flag("--on-main")?;
    let wake = tokens.flag("--wake")?;
    let confirm_spend = tokens.flag("--confirm-spend")?;
    if worktree && on_main {
        return Err(invalid("--worktree and --on-main are mutually exclusive."));
    }
    if prompt.trim().is_empty() {
        return Err(invalid("--prompt cannot be empty."));
    }
    cloud_rpc(
        "sessions.create",
        json!({
            "project": project,
            "prompt": prompt,
            "agent": agent,
            "model": model,
            "effort": effort,
            "mode": mode,
            "useWorktree": !on_main,
            "wake": wake,
            "confirmSpend": confirm_spend,
            "idempotencyKey": idempotency_key,
        }),
        tokens,
    )
}

fn parse_cloud(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("cloud command")?.as_str() {
        "status" => cloud_rpc("status", json!({}), tokens),
        "stop" => {
            let confirmed = tokens.flag("--yes")?;
            let workspace = tokens.required_front("cloud workspace")?;
            cloud_rpc("stop", json!({"workspace": workspace, "confirmed": confirmed}), tokens)
        }
        "resume" => {
            let workspace = tokens.required_front("cloud workspace")?;
            cloud_rpc("resume", json!({"workspace": workspace}), tokens)
        }
        other => Err(invalid(format!("Unknown cloud command {other}."))),
    }
}

fn parse_permissions(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("permissions command")?.as_str() {
        "list" => rpc("permissions.list", json!({}), tokens),
        "allow" => {
            let option = tokens.option("--option")?;
            let request = tokens.required_front("request id")?;
            rpc(
                "permissions.allow",
                json!({"request": request, "option": option}),
                tokens,
            )
        }
        "deny" => {
            let request = tokens.required_front("request id")?;
            rpc("permissions.deny", json!({"request": request}), tokens)
        }
        other => Err(invalid(format!("Unknown permissions command {other}."))),
    }
}

fn parse_worktrees(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("worktrees command")?.as_str() {
        "list" => {
            let project = tokens.option("--project")?;
            rpc("worktrees.list", json!({"project": project}), tokens)
        }
        "rename" => {
            let project = tokens.option("--project")?;
            let name = tokens.required_option("--name")?;
            let worktree = tokens.required_front("worktree")?;
            rpc("worktrees.rename", json!({"project": project, "worktree": worktree, "name": name}), tokens)
        }
        "delete" => {
            let project = tokens.option("--project")?;
            let confirmed = tokens.flag("--yes")?;
            let force = tokens.flag("--force")?;
            let worktree = tokens.required_front("worktree")?;
            rpc(
                "worktrees.delete",
                json!({"project": project, "worktree": worktree, "confirmed": confirmed, "force": force}),
                tokens,
            )
        }
        other => Err(invalid(format!("Unknown worktrees command {other}."))),
    }
}

fn parse_issues(tokens: &mut Tokens) -> Result<Action, ControlError> {
    expect_word(tokens, "list", "issues")?;
    let project = tokens.required_option("--project")?;
    let provider = tokens.option("--provider")?;
    let assigned = tokens.flag("--assigned-to-me")?;
    let team = tokens.option("--team")?;
    let search = tokens.option("--search")?;
    rpc(
        "issues.list",
        json!({"project": project, "provider": provider, "assignedToMe": assigned, "team": team, "search": search}),
        tokens,
    )
}

fn rpc(command: &str, params: Value, tokens: &mut Tokens) -> Result<Action, ControlError> {
    tokens.finish()?;
    Ok(Action::Rpc {
        command: command.into(),
        params,
        timeout: Duration::from_secs(30),
    })
}

fn expect_word(tokens: &mut Tokens, expected: &str, group: &str) -> Result<(), ControlError> {
    let actual = tokens.required_front(&format!("{group} command"))?;
    if actual == expected {
        Ok(())
    } else {
        Err(invalid(format!("Unknown {group} command {actual}.")))
    }
}

pub(crate) fn invalid(message: impl Into<String>) -> ControlError {
    ControlError::new(
        "invalid_arguments",
        message,
        Some("Run terminalx --help and correct the named argument.".into()),
    )
}

pub(crate) struct Tokens {
    pub(crate) values: Vec<String>,
}

impl Tokens {
    pub(crate) fn new(args: &[String]) -> Self {
        Self {
            values: args.to_vec(),
        }
    }

    pub(crate) fn take_front(&mut self) -> Option<String> {
        (!self.values.is_empty()).then(|| self.values.remove(0))
    }

    pub(crate) fn required_front(&mut self, label: &str) -> Result<String, ControlError> {
        self.take_front()
            .ok_or_else(|| invalid(format!("Missing {label}.")))
    }

    pub(crate) fn flag(&mut self, name: &str) -> Result<bool, ControlError> {
        let positions: Vec<_> = self
            .values
            .iter()
            .enumerate()
            .filter_map(|(i, value)| (value == name).then_some(i))
            .collect();
        if positions.len() > 1 {
            return Err(invalid(format!("{name} may be passed only once.")));
        }
        if let Some(position) = positions.first() {
            self.values.remove(*position);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub(crate) fn option(&mut self, name: &str) -> Result<Option<String>, ControlError> {
        let positions: Vec<_> = self
            .values
            .iter()
            .enumerate()
            .filter_map(|(i, value)| (value == name).then_some(i))
            .collect();
        if positions.len() > 1 {
            return Err(invalid(format!("{name} may be passed only once.")));
        }
        let Some(position) = positions.first().copied() else {
            return Ok(None);
        };
        if position + 1 >= self.values.len() {
            return Err(invalid(format!("{name} needs a value.")));
        }
        self.values.remove(position);
        Ok(Some(self.values.remove(position)))
    }

    /// The value `name` would take, without consuming it.
    pub(crate) fn peek_option(&self, name: &str) -> Option<String> {
        let position = self.values.iter().position(|value| value == name)?;
        self.values.get(position + 1).cloned()
    }

    pub(crate) fn required_option(&mut self, name: &str) -> Result<String, ControlError> {
        self.option(name)?
            .ok_or_else(|| invalid(format!("Missing {name}.")))
    }

    pub(crate) fn option_u64(&mut self, name: &str) -> Result<Option<u64>, ControlError> {
        self.option(name)?
            .map(|value| {
                value
                    .parse::<u64>()
                    .map_err(|_| invalid(format!("{name} must be a non-negative integer.")))
            })
            .transpose()
    }

    pub(crate) fn finish(&self) -> Result<(), ControlError> {
        if self.values.is_empty() {
            Ok(())
        } else {
            Err(invalid(format!("Unexpected argument {}.", self.values[0])))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn rpc_of(values: &[&str]) -> (String, Value, Duration) {
        match parse(&args(values)).unwrap().action {
            Action::Rpc { command, params, timeout } => (command, params, timeout),
            other => panic!("expected rpc, got {other:?}"),
        }
    }

    #[test]
    fn a_cloud_key_or_flag_sends_the_same_verbs_to_the_cloud_commands() {
        let (command, params, _) = rpc_of(&["projects", "list", "--cloud"]);
        assert_eq!((command.as_str(), params), ("cloud.projects.list", json!({"org": null})));
        let (command, params, _) = rpc_of(&["sessions", "list", "--cloud", "--org", "Acme"]);
        assert_eq!((command.as_str(), params), ("cloud.sessions.list", json!({"project": null, "org": "Acme"})));
        // A cloud project key alone is enough.
        let (command, _, _) = rpc_of(&["sessions", "list", "--project", "cloud:org-a:github.com/acme/api"]);
        assert_eq!(command, "cloud.sessions.list");

        let (command, params, _) = rpc_of(&["send", "cloud:org-a:ws-1:s1", "run the tests", "--tab", "t2"]);
        assert_eq!((command.as_str(), params), ("cloud.send", json!({"target": "cloud:org-a:ws-1:s1", "text": "run the tests", "tab": "t2", "idempotencyKey": null})));
        assert_eq!(rpc_of(&["send", "cloud:org-a:ws-1:s1", "again", "--idempotency-key", "k-7"]).1["idempotencyKey"], json!("k-7"));
        let (command, params, _) = rpc_of(&["read", "cloud:org-a:ws-1:s1", "--tail", "5"]);
        assert_eq!((command.as_str(), params), ("cloud.read", json!({"target": "cloud:org-a:ws-1:s1", "since": null, "tail": 5, "tab": null})));
        let (command, params, timeout) = rpc_of(&["wait", "cloud:org-a:ws-1:s1", "--timeout", "30"]);
        assert_eq!((command.as_str(), params), ("cloud.wait", json!({"target": "cloud:org-a:ws-1:s1", "timeoutSeconds": 30, "tab": null})));
        // The CLI outlasts the app's own wait for its window (one chunk plus 20 s).
        assert!(timeout > crate::cloud_control::timeout_for("wait", &json!({"timeoutSeconds": 30})));

        let (command, params, _) = rpc_of(&["cloud", "stop", "cloud:org-a:ws-1", "--yes"]);
        assert_eq!((command.as_str(), params), ("cloud.stop", json!({"workspace": "cloud:org-a:ws-1", "confirmed": true})));
        // Without --yes the app is still asked: it answers what stopping would do.
        assert_eq!(rpc_of(&["cloud", "stop", "cloud:org-a:ws-1"]).1["confirmed"], json!(false));
        let (command, params, _) = rpc_of(&["cloud", "resume", "cloud:org-a:ws-1"]);
        assert_eq!((command.as_str(), params), ("cloud.resume", json!({"workspace": "cloud:org-a:ws-1"})));
        assert_eq!(rpc_of(&["cloud", "status"]).0, "cloud.status");
        assert!(parse(&args(&["cloud", "delete", "cloud:org-a:ws-1"])).is_err());
    }

    #[test]
    fn a_cloud_wait_is_asked_in_short_calls_until_the_tab_settles_or_the_timeout_passes() {
        let params = json!({"target": "cloud:org-a:ws-1:s1", "timeoutSeconds": 70, "tab": null});
        let answer = |reason: &str| ControlResponse::success("1", json!({"reason": reason, "status": "in_progress"}));

        // Still working for the whole 70 s: 30 + 30 + 10, then the timeout is reported.
        let mut asked = Vec::new();
        let response = cloud_wait(&params, CLOUD_TIMEOUT, &mut |command, params, _| {
            assert_eq!(command, "cloud.wait");
            asked.push(params["timeoutSeconds"].as_u64().unwrap());
            Ok(answer("timeout"))
        })
        .unwrap();
        assert_eq!(asked, vec![30, 30, 10]);
        assert_eq!(response.result.unwrap()["reason"], "timeout");

        // It settles during the second call: nothing more is asked.
        let mut calls = 0;
        let response = cloud_wait(&params, CLOUD_TIMEOUT, &mut |_, _, _| {
            calls += 1;
            Ok(answer(if calls == 2 { "permission" } else { "timeout" }))
        })
        .unwrap();
        assert_eq!(calls, 2);
        assert_eq!(response.result.unwrap()["reason"], "permission");

        // A refusal ends it at once.
        let mut calls = 0;
        let refused = cloud_wait(&params, CLOUD_TIMEOUT, &mut |_, _, _| {
            calls += 1;
            Err(ControlError::new("forbidden", "no", None::<String>))
        });
        assert_eq!((calls, refused.unwrap_err().code.as_str()), (1, "forbidden"));
    }

    #[test]
    fn local_targets_keep_their_commands_and_refuse_cloud_only_options() {
        assert_eq!(rpc_of(&["projects", "list"]).0, "projects.list");
        assert_eq!(rpc_of(&["sessions", "list", "--project", "raccoon"]).0, "sessions.list");
        assert_eq!(rpc_of(&["send", "raccoon-session", "hello"]).0, "send");
        assert_eq!(rpc_of(&["read", "raccoon-session"]).0, "read");
        assert_eq!(rpc_of(&["wait", "raccoon-session"]).0, "wait");
        let error = parse(&args(&["send", "raccoon-session", "hello", "--tab", "t1"])).unwrap_err();
        assert!(error.message.contains("--tab applies to a cloud session"), "{}", error.message);
    }

    #[test]
    fn a_cloud_session_is_created_without_waking_or_spending_unless_asked() {
        let project = "cloud:org-a:github.com/acme/api";
        let (command, params, timeout) = rpc_of(&["sessions", "create", "--project", project, "--prompt", "fix the login"]);
        assert_eq!(command, "cloud.sessions.create");
        assert_eq!(
            params,
            json!({"project": project, "prompt": "fix the login", "agent": null, "model": null, "effort": null, "mode": null, "useWorktree": true, "wake": false, "confirmSpend": false, "idempotencyKey": null})
        );
        assert!(timeout > crate::cloud_control::timeout_for("sessions.create", &json!({})));
        let (_, params, _) = rpc_of(&["sessions", "create", "--wake", "--confirm-spend", "--on-main", "--agent", "codex", "--idempotency-key", "k-1", "--prompt", "go", "--project", project]);
        assert_eq!((&params["wake"], &params["confirmSpend"], &params["useWorktree"], &params["agent"], &params["idempotencyKey"]), (&json!(true), &json!(true), &json!(false), &json!("codex"), &json!("k-1")));
        assert!(parse(&args(&["sessions", "create", "--project", project, "--prompt", " "])).is_err());
        // A local project still needs its agent named, and takes no cloud flag.
        assert!(parse(&args(&["sessions", "create", "--project", "raccoon", "--prompt", "go"])).is_err());
        assert!(parse(&args(&["sessions", "create", "--project", "raccoon", "--agent", "codex", "--prompt", "go", "--wake"])).is_err());
    }

    #[test]
    fn parses_names_and_rename_commands() {
        for (argv, expected_command, expected_params) in [
            (vec!["sessions", "create", "--title", "#203 fix", "--name", "fix-203", "--project", "p", "--agent", "codex", "--prompt", "fix it"],
             "sessions.create", json!({"title": "#203 fix", "name": "fix-203", "useWorktree": true})),
            (vec!["sessions", "rename", "s1", "--title", "#203 review"],
             "sessions.rename", json!({"session": "s1", "title": "#203 review"})),
            (vec!["worktrees", "rename", "--name", "fix-203", "old", "--project", "p"],
             "worktrees.rename", json!({"worktree": "old", "name": "fix-203", "project": "p"})),
            (vec!["worktrees", "rename", "old", "--name", "fix-203"],
             "worktrees.rename", json!({"worktree": "old", "name": "fix-203", "project": null})),
        ] {
            let Action::Rpc { command, params, .. } = parse(&args(&argv)).unwrap().action else { panic!("expected rpc") };
            assert_eq!(command, expected_command);
            for (key, value) in expected_params.as_object().unwrap() {
                assert_eq!(&params[key], value, "{key}");
            }
        }
        for argv in [
            vec!["sessions", "rename", "s1"],
            vec!["sessions", "rename", "--title", "t"],
            vec!["worktrees", "rename", "old"],
            vec!["worktrees", "rename", "old", "--name"],
            vec!["sessions", "create", "--project", "p", "--agent", "codex", "--prompt", "fix", "--name", "fix-203", "--on-main"],
        ] {
            assert_eq!(parse(&args(&argv)).unwrap_err().code, "invalid_arguments");
        }
        for text in [help_text(), GUIDE.to_string()] {
            for command in ["sessions rename", "worktrees rename", "--title", "--name"] {
                assert!(text.contains(command), "missing {command}");
            }
        }
    }

    #[test]
    fn parses_session_creation_independent_of_flag_order() {
        let parsed = parse(&args(&[
            "sessions",
            "create",
            "--prompt",
            "reply once",
            "--json",
            "--agent",
            "codex",
            "--on-main",
            "--project",
            "raccoon",
            "--effort",
            "high",
        ]))
        .unwrap();
        assert!(parsed.json);
        let Action::Rpc {
            command, params, ..
        } = parsed.action
        else {
            panic!("expected rpc")
        };
        assert_eq!(command, "sessions.create");
        assert_eq!(params["project"], "raccoon");
        assert_eq!(params["agent"], "codex");
        assert_eq!(params["prompt"], "reply once");
        assert_eq!(params["useWorktree"], false);
        assert_eq!(params["onMain"], true);
        assert_eq!(params["effort"], "high");
    }

    #[test]
    fn session_creation_defaults_to_a_worktree_without_on_main_acknowledgement() {
        let parsed = parse(&args(&[
            "sessions",
            "create",
            "--project",
            "raccoon",
            "--agent",
            "codex",
            "--prompt",
            "reply once",
        ]))
        .unwrap();
        let Action::Rpc { params, .. } = parsed.action else {
            panic!("expected rpc")
        };
        assert_eq!(params["useWorktree"], true);
        assert_eq!(params["onMain"], false);
    }

    #[test]
    fn destructive_worktree_command_carries_confirmation() {
        let parsed = parse(&args(&[
            "worktrees",
            "delete",
            "feature",
            "--project",
            "raccoon",
            "--yes",
        ]))
        .unwrap();
        let Action::Rpc {
            command, params, ..
        } = parsed.action
        else {
            panic!("expected rpc")
        };
        assert_eq!(command, "worktrees.delete");
        assert_eq!(params["confirmed"], true);
        assert_eq!(params["worktree"], "feature");
    }

    #[test]
    fn rejects_conflicting_session_locations_and_unknown_flags() {
        let conflict = parse(&args(&[
            "sessions",
            "create",
            "--project",
            "p",
            "--agent",
            "codex",
            "--prompt",
            "hi",
            "--worktree",
            "--on-main",
        ]))
        .unwrap_err();
        assert_eq!(conflict.code, "invalid_arguments");

        let unknown = parse(&args(&["status", "--invented"])).unwrap_err();
        assert!(unknown.message.contains("Unexpected argument"));
    }

    #[test]
    fn skills_get_is_local_and_version_matched() {
        let parsed = parse(&args(&["skills", "get", "terminalx-cli", "--full"])).unwrap();
        assert!(matches!(parsed.action, Action::Guide { name: "terminalx-cli", .. }));
        assert!(GUIDE.contains("TERMINALX_NEXT_SOCKET"));
        assert!(SKILL_STUB.contains("discovery stub"));

        let computer = parse(&args(&["skills", "get", "computer-use"])).unwrap();
        let Action::Guide { name, guide } = computer.action else {
            panic!("expected guide")
        };
        assert_eq!(name, "computer-use");
        assert!(guide.contains("terminalx computer get-app-state"));
        assert!(COMPUTER_SKILL_STUB.contains("terminalx skills get computer-use"));

        let unknown = parse(&args(&["skills", "get", "browser-use"])).unwrap_err();
        assert_eq!(unknown.code, "not_found");
    }

    #[test]
    fn computer_commands_route_through_the_computer_parser() {
        let parsed = parse(&args(&["computer", "click", "--app", "Finder", "--element-index", "3", "--json"])).unwrap();
        assert!(parsed.json);
        let Action::Rpc { command, params, timeout } = parsed.action else {
            panic!("expected rpc")
        };
        assert_eq!(command, "computer.click");
        assert_eq!(params["elementIndex"], 3);
        assert_eq!(timeout, crate::computer::cli::CLI_TIMEOUT);

        let mut stdin = || Ok::<_, ControlError>("hunter2".to_string());
        let parsed = parse_with_stdin(&args(&["computer", "set-value", "--app", "Finder", "--element-index", "1", "--value-stdin"]), &mut stdin).unwrap();
        let Action::Rpc { params, .. } = parsed.action else {
            panic!("expected rpc")
        };
        assert_eq!(params["value"], "hunter2");
    }

    #[test]
    fn public_copy_uses_the_terminalx_identity() {
        assert!(HELP.starts_with("terminalx — control a running TerminalX app"));
        let help = help_text();
        assert!(help.contains("terminalx computer get-app-state --app <app>"));
        assert!(help.contains("snapshot [--interactive]"));
        assert!(!help.contains("BROWSER_HELP"));
        assert!(!help.contains("COMPUTER_HELP"));
        for copy in [help.as_str(), GUIDE, SKILL_STUB, COMPUTER_GUIDE, COMPUTER_SKILL_STUB] {
            assert!(!copy.contains("Raccoon app"));
            assert!(!copy.contains("Raccoon →"));
            assert!(!copy.contains("/Applications/Raccoon.app"));
            assert!(!copy.contains("terminalx-legacy"));
            assert!(!copy.contains("terminalx-dev"));
            assert!(!copy.contains("TERMINALX_CLI_COMMAND"));
        }
    }
}
