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
      [--worktree|--on-main] [--model MODEL] [--effort EFFORT] [--mode MODE] [--json]
  terminalx sessions show SESSION [--json]
  terminalx tabs list SESSION [--json]
  terminalx send SESSION_OR_TAB TEXT [--json]
  terminalx read SESSION_OR_TAB [--since SEQ] [--tail COUNT] [--json]
  terminalx wait SESSION_OR_TAB [--timeout SECONDS] [--json]
  terminalx permissions list [--json]
  terminalx permissions allow REQUEST [--option OPTION] [--json]
  terminalx permissions deny REQUEST [--json]
  terminalx worktrees list [--project PROJECT] [--json]
  terminalx worktrees delete WORKTREE [--project PROJECT] --yes [--json]
  terminalx issues list --project PROJECT [--provider github|linear]
      [--assigned-to-me] [--team ID] [--search TEXT] [--json]
  terminalx skills get terminalx-cli|computer-use [--full] [--json]

Computer use (desktop apps, macOS 14+):
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
        .and_then(|arg| Path::new(arg).file_name())
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
        } => match control::call(&command, params.clone(), timeout) {
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
            rpc("projects.list", json!({}), &mut tokens)
        }
        "sessions" => parse_sessions(&mut tokens),
        "tabs" => {
            expect_word(&mut tokens, "list", "tabs")?;
            let session = tokens.required_front("session")?;
            rpc("tabs.list", json!({"session": session}), &mut tokens)
        }
        "send" => {
            let target = tokens.required_front("session or tab")?;
            let text = tokens.required_front("text")?;
            rpc("send", json!({"target": target, "text": text}), &mut tokens)
        }
        "read" => {
            let since = tokens.option_u64("--since")?;
            let tail = tokens.option_u64("--tail")?;
            let target = tokens.required_front("session or tab")?;
            rpc(
                "read",
                json!({"target": target, "since": since, "tail": tail}),
                &mut tokens,
            )
        }
        "wait" if crate::browser::cli::is_browser_wait(&tokens.values) => {
            crate::browser::cli::parse("wait", &mut tokens).expect("wait is a browser verb")
        }
        "wait" => {
            let seconds = tokens.option_u64("--timeout")?.unwrap_or(600);
            let target = tokens.required_front("session or tab")?;
            tokens.finish()?;
            Ok(Action::Rpc {
                command: "wait".into(),
                params: json!({"target": target, "timeoutSeconds": seconds}),
                timeout: Duration::from_secs(seconds.saturating_add(10).max(30)),
            })
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
            rpc("sessions.list", json!({"project": project}), tokens)
        }
        "show" => {
            let session = tokens.required_front("session")?;
            rpc("sessions.show", json!({"session": session}), tokens)
        }
        "create" => {
            let project = tokens.required_option("--project")?;
            let agent = tokens.required_option("--agent")?;
            let prompt = tokens.required_option("--prompt")?;
            let model = tokens.option("--model")?;
            let effort = tokens.option("--effort")?;
            let mode = tokens.option("--mode")?;
            let worktree = tokens.flag("--worktree")?;
            let on_main = tokens.flag("--on-main")?;
            if worktree && on_main {
                return Err(invalid("--worktree and --on-main are mutually exclusive."));
            }
            rpc(
                "sessions.create",
                json!({
                    "project": project,
                    "agent": agent,
                    "prompt": prompt,
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
        "delete" => {
            let project = tokens.option("--project")?;
            let confirmed = tokens.flag("--yes")?;
            let worktree = tokens.required_front("worktree")?;
            rpc(
                "worktrees.delete",
                json!({"project": project, "worktree": worktree, "confirmed": confirmed}),
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
