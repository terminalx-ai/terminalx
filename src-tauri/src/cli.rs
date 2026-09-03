//! Argument parsing and output for the `terminalx-next` thin client.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::control::{self, ControlError, ControlResponse};

pub const GUIDE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../skill-guides/terminalx-next-cli.md"
));
pub const SKILL_STUB: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../skills/terminalx-next-cli/SKILL.md"
));

const HELP: &str = r#"terminalx-next — control a running TerminalX app

Usage:
  terminalx-next status [--json]
  terminalx-next projects list [--json]
  terminalx-next sessions list [--project PROJECT] [--json]
  terminalx-next sessions create --project PROJECT --agent AGENT --prompt TEXT
      [--worktree|--on-main] [--model MODEL] [--effort EFFORT] [--mode MODE] [--json]
  terminalx-next sessions show SESSION [--json]
  terminalx-next tabs list SESSION [--json]
  terminalx-next send SESSION_OR_TAB TEXT [--json]
  terminalx-next read SESSION_OR_TAB [--since SEQ] [--tail COUNT] [--json]
  terminalx-next wait SESSION_OR_TAB [--timeout SECONDS] [--json]
  terminalx-next permissions list [--json]
  terminalx-next permissions allow REQUEST [--option OPTION] [--json]
  terminalx-next permissions deny REQUEST [--json]
  terminalx-next worktrees list [--project PROJECT] [--json]
  terminalx-next worktrees delete WORKTREE [--project PROJECT] --yes [--json]
  terminalx-next issues list --project PROJECT [--provider github|linear]
      [--assigned-to-me] [--team ID] [--search TEXT] [--json]
  terminalx-next skills get terminalx-next-cli [--full] [--json]

Use `terminalx-next skills get terminalx-next-cli` for the complete guide."#;

#[derive(Debug, Clone, PartialEq)]
enum Action {
    Rpc {
        command: String,
        params: Value,
        timeout: Duration,
    },
    Guide,
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
    let offset = if matches!(invoked, "terminalx-next" | "tnx") {
        1
    } else if all
        .get(1)
        .is_some_and(|arg| matches!(arg.as_str(), "terminalx-next" | "tnx"))
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
            if parsed.json {
                print_response(
                    &ControlResponse::success("local", json!({"help": HELP})),
                    true,
                );
            } else {
                println!("{HELP}");
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
        Action::Guide => {
            if parsed.json {
                print_response(
                    &ControlResponse::success(
                        "local",
                        json!({"name": "terminalx-next-cli", "version": env!("CARGO_PKG_VERSION"), "guide": GUIDE}),
                    ),
                    true,
                );
            } else {
                print!("{GUIDE}");
                if !GUIDE.ends_with('\n') {
                    println!();
                }
            }
            0
        }
        Action::Rpc {
            command,
            params,
            timeout,
        } => match control::call(&command, params, timeout) {
            Ok(response) => {
                let ok = response.ok;
                print_response(&response, parsed.json);
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
        "skills" => {
            expect_word(&mut tokens, "get", "skills")?;
            let name = tokens.required_front("skill name")?;
            if name != "terminalx-next-cli" {
                return Err(ControlError::new(
                    "not_found",
                    format!("This binary does not embed a guide named {name}."),
                    Some("Use terminalx-next-cli exactly.".into()),
                ));
            }
            let _full = tokens.flag("--full")?;
            tokens.finish()?;
            Ok(Action::Guide)
        }
        other => Err(invalid(format!("Unknown command group {other}."))),
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

fn invalid(message: impl Into<String>) -> ControlError {
    ControlError::new(
        "invalid_arguments",
        message,
        Some("Run terminalx-next --help and correct the named argument.".into()),
    )
}

struct Tokens {
    values: Vec<String>,
}

impl Tokens {
    fn new(args: &[String]) -> Self {
        Self {
            values: args.to_vec(),
        }
    }

    fn take_front(&mut self) -> Option<String> {
        (!self.values.is_empty()).then(|| self.values.remove(0))
    }

    fn required_front(&mut self, label: &str) -> Result<String, ControlError> {
        self.take_front()
            .ok_or_else(|| invalid(format!("Missing {label}.")))
    }

    fn flag(&mut self, name: &str) -> Result<bool, ControlError> {
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

    fn option(&mut self, name: &str) -> Result<Option<String>, ControlError> {
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

    fn required_option(&mut self, name: &str) -> Result<String, ControlError> {
        self.option(name)?
            .ok_or_else(|| invalid(format!("Missing {name}.")))
    }

    fn option_u64(&mut self, name: &str) -> Result<Option<u64>, ControlError> {
        self.option(name)?
            .map(|value| {
                value
                    .parse::<u64>()
                    .map_err(|_| invalid(format!("{name} must be a non-negative integer.")))
            })
            .transpose()
    }

    fn finish(&self) -> Result<(), ControlError> {
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
        let parsed = parse(&args(&["skills", "get", "terminalx-next-cli", "--full"])).unwrap();
        assert_eq!(parsed.action, Action::Guide);
        assert!(GUIDE.contains("TERMINALX_NEXT_SOCKET"));
        assert!(SKILL_STUB.contains("discovery stub"));
    }

    #[test]
    fn public_copy_uses_the_terminalx_next_identity() {
        assert!(HELP.starts_with("terminalx-next — control a running TerminalX app"));
        for copy in [HELP, GUIDE, SKILL_STUB] {
            assert!(!copy.contains("Raccoon app"));
            assert!(!copy.contains("Raccoon →"));
            assert!(!copy.contains("/Applications/Raccoon.app"));
        }
    }
}
