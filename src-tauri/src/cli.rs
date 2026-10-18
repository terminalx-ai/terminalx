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
  terminalx sessions list [--project PROJECT|--quick] [--json]
  terminalx sessions create --project PROJECT --agent AGENT --prompt TEXT
      [--title TEXT] [--name NAME]
      [--worktree|--on-main] [--model MODEL] [--effort EFFORT] [--mode MODE] [--json]
  terminalx sessions create --project PROJECT --agent AGENT --issue ISSUE [--prompt TEXT]
      [--provider github|linear] [--auto-merge|--no-auto-merge] [--no-pipeline]
      [--title TEXT] [--name NAME] [--on-main] [--model MODEL] [--effort EFFORT] [--mode MODE] [--json]
  terminalx sessions create --quick --agent AGENT --prompt TEXT
      [--title TEXT] [--cwd DIRECTORY] [--model MODEL] [--effort EFFORT] [--mode MODE] [--json]
  terminalx floating show|hide|toggle [--session SESSION] [--json]
  terminalx sessions show SESSION [--json]
  terminalx share create SESSION [--read-only] [--people EMAIL,EMAIL]
      [--expires-in SECONDS] [--approve] [--can-approve] [--max-people COUNT]
      [--single-use] [--local-only] [--json]
  terminalx share list SESSION [--json]
  terminalx share edit SESSION LINK --settings JSON [--json]
  terminalx share revoke SESSION LINK [--keep-guests] [--json]
  terminalx share stop SESSION [--json]
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
  terminalx issues view ISSUE [--project PROJECT] [--provider github|linear] [--comments] [--json]
  terminalx issues comment ISSUE --body TEXT|--body-file PATH [--project PROJECT] [--json]
  terminalx issues status ISSUE --to STATE [--reason completed|not_planned] [--project PROJECT] [--json]
  terminalx issues assign ISSUE (--to USER... | --me | --none) [--project PROJECT] [--json]
  terminalx issues label ISSUE [--add LABEL...] [--remove LABEL...] [--project PROJECT] [--json]
  terminalx issues create --project PROJECT [--provider github|linear] --title TEXT
      [--body TEXT|--body-file PATH] [--team TEAM] [--assignee USER...] [--label LABEL...]
      [--state STATE] [--priority none|urgent|high|medium|low] [--json]
  terminalx pipelines list [--project PROJECT] [--json]
  terminalx pipelines show PIPELINE [--project PROJECT] [--json]
  terminalx pipelines auto-merge PIPELINE on|off [--project PROJECT] [--json]
  terminalx pipelines stop|resume|advance|review|refresh PIPELINE [--project PROJECT] [--json]
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
        "floating" => {
            let action = tokens.required_front("floating command")?;
            if !matches!(action.as_str(), "show" | "hide" | "toggle") {
                return Err(invalid(format!("Unknown floating command {action}. Use show, hide or toggle.")));
            }
            let session = tokens.option("--session")?;
            rpc(&format!("floating.{action}"), json!({"session": session}), &mut tokens)
        }
        "share" => parse_share(&mut tokens),
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
        "issues" => parse_issues(&mut tokens, stdin),
        "pipelines" => parse_pipelines(&mut tokens),
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

fn parse_share(tokens: &mut Tokens) -> Result<Action, ControlError> {
    let action = tokens.required_front("share action")?;
    let session = tokens.required_front("session")?;
    let mut params = json!({ "sessionId": session });
    match action.as_str() {
        "create" => {
            let role = if tokens.flag("--read-only")? { "viewer" } else { "driver" };
            let people = tokens.option("--people")?;
            let lifetime = tokens.option_u64("--expires-in")?.unwrap_or(3600);
            params["directOnly"] = json!(tokens.flag("--local-only")?);
            params["settings"] = json!({
                "audience": if people.is_some() { "people" } else { "anyone" }, "role": role,
                "people": people.map(|list| list.split(',').map(|email| json!({ "email": email, "role": role })).collect::<Vec<_>>()).unwrap_or_default(),
                "expiresAt": chrono::Utc::now().timestamp_millis().saturating_add(i64::try_from(lifetime.saturating_mul(1000)).unwrap_or(i64::MAX)),
                "approveEachPerson": tokens.flag("--approve")?, "canApprove": tokens.flag("--can-approve")?,
                "maximumPeople": tokens.option_u64("--max-people")?.unwrap_or(8), "singleUse": tokens.flag("--single-use")?
            });
        }
        "list" | "stop" => (),
        "edit" | "revoke" => {
            params["linkId"] = json!(tokens.required_front("link id")?);
            if action == "edit" {
                params["settings"] = serde_json::from_str(&tokens.option("--settings")?.ok_or_else(|| invalid("--settings JSON is required"))?).map_err(|_| invalid("Invalid settings JSON"))?;
            } else { params["removeGuests"] = json!(!tokens.flag("--keep-guests")?); }
        }
        _ => return Err(invalid("Unknown share action")),
    }
    rpc(&format!("share.{action}"), params, tokens)
}

fn parse_sessions(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("sessions command")?.as_str() {
        "list" => {
            let project = tokens.option("--project")?;
            let org = tokens.option("--org")?;
            let cloud = tokens.flag("--cloud")?;
            let quick = tokens.flag("--quick")?;
            let in_cloud = cloud || org.is_some() || project.as_deref().is_some_and(is_cloud_key);
            if quick && (in_cloud || project.is_some()) {
                return Err(invalid("--quick lists the chats that have no project; it cannot be combined with --project, --cloud or --org."));
            }
            if in_cloud {
                cloud_rpc("sessions.list", json!({"project": project, "org": org}), tokens)
            } else {
                rpc("sessions.list", json!({"project": project, "quick": quick}), tokens)
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
        // A quick chat: no project, a scratch directory of its own.
        "create" if tokens.peek_flag("--quick") => {
            let _quick = tokens.flag("--quick")?;
            let agent = tokens.required_option("--agent")?;
            let prompt = tokens.required_option("--prompt")?;
            let title = tokens.option("--title")?;
            let cwd = tokens.option("--cwd")?;
            let model = tokens.option("--model")?;
            let effort = tokens.option("--effort")?;
            let mode = tokens.option("--mode")?;
            for refused in ["--project", "--name"] {
                if tokens.option(refused)?.is_some() {
                    return Err(invalid(format!("{refused} does not apply to --quick: a quick chat has no project and no worktree.")));
                }
            }
            for refused in ["--worktree", "--on-main"] {
                if tokens.flag(refused)? {
                    return Err(invalid(format!("{refused} does not apply to --quick: a quick chat has no project and no worktree.")));
                }
            }
            rpc(
                "sessions.create",
                json!({
                    "quick": true,
                    "agent": agent,
                    "prompt": prompt,
                    "title": title,
                    "cwd": cwd,
                    "model": model.unwrap_or_default(),
                    "effort": effort,
                    "mode": mode,
                }),
                tokens,
            )
        }
        "create" => {
            let project = tokens.required_option("--project")?;
            let agent = tokens.required_option("--agent")?;
            // An issue is its own prompt; anything given with it is added after.
            let issue = tokens.option("--issue")?;
            let prompt = if issue.is_some() { tokens.option("--prompt")?.unwrap_or_default() } else { tokens.required_option("--prompt")? };
            let provider = tokens.option("--provider")?;
            let auto_merge = match (tokens.flag("--auto-merge")?, tokens.flag("--no-auto-merge")?) {
                (true, true) => return Err(invalid("--auto-merge and --no-auto-merge are mutually exclusive.")),
                (true, false) => Some(true),
                (false, true) => Some(false),
                (false, false) => None,
            };
            let no_pipeline = tokens.flag("--no-pipeline")?;
            if issue.is_none() && (provider.is_some() || auto_merge.is_some() || no_pipeline) {
                return Err(invalid("--provider, --auto-merge, --no-auto-merge and --no-pipeline apply to a session started with --issue."));
            }
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
            let mut params = json!({
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
            });
            // Only an issue start carries these, so every other request is
            // word for word what it was.
            if let Some(issue) = issue {
                params["issue"] = json!(issue);
                params["provider"] = json!(provider);
                params["autoMerge"] = json!(auto_merge);
                params["noPipeline"] = json!(no_pipeline);
                tokens.finish()?;
                // Reading the tracker comes before the session exists.
                return Ok(Action::Rpc { command: "sessions.create".into(), params, timeout: Duration::from_secs(60) });
            }
            rpc("sessions.create", params, tokens)
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

fn parse_issues(tokens: &mut Tokens, stdin: &mut dyn FnMut() -> Result<String, ControlError>) -> Result<Action, ControlError> {
    let command = tokens.required_front("issues command")?;
    if command == "list" {
        let project = tokens.required_option("--project")?;
        let provider = tokens.option("--provider")?;
        let assigned = tokens.flag("--assigned-to-me")?;
        let team = tokens.option("--team")?;
        let search = tokens.option("--search")?;
        return rpc(
            "issues.list",
            json!({"project": project, "provider": provider, "assignedToMe": assigned, "team": team, "search": search}),
            tokens,
        );
    }
    if !matches!(command.as_str(), "view" | "comment" | "status" | "assign" | "label" | "create") {
        return Err(invalid(format!("Unknown issues command {command}. Use list, view, comment, status, assign, label or create.")));
    }
    let provider = tokens.option("--provider")?;
    if let Some(provider) = provider.as_deref().filter(|provider| !matches!(*provider, "github" | "linear")) {
        return Err(invalid(format!("--provider takes github or linear, not {provider}.")));
    }
    let mut params = json!({"provider": provider});
    if command == "create" {
        params["project"] = json!(tokens.required_option("--project")?);
        let title = tokens.required_option("--title")?;
        if title.trim().is_empty() {
            return Err(invalid("--title cannot be empty."));
        }
        params["title"] = json!(title);
        params["body"] = json!(issue_body(tokens, stdin, false)?);
        params["team"] = json!(tokens.option("--team")?);
        params["assignees"] = json!(tokens.options("--assignee")?.iter().flat_map(|value| list_values(value)).collect::<Vec<_>>());
        params["labels"] = json!(tokens.options("--label")?);
        params["state"] = json!(tokens.option("--state")?);
        params["priority"] = json!(tokens.option("--priority")?.map(|value| issue_priority(&value)).transpose()?);
    } else {
        params["project"] = json!(tokens.option("--project")?);
    }
    match command.as_str() {
        "create" => (),
        "view" => params["comments"] = json!(tokens.flag("--comments")?),
        "comment" => params["body"] = json!(issue_body(tokens, stdin, true)?),
        "status" => {
            let to = tokens.required_option("--to")?;
            if to.trim().is_empty() {
                return Err(invalid("--to cannot be empty."));
            }
            let reason = tokens.option("--reason")?;
            if let Some(reason) = reason.as_deref().filter(|reason| !matches!(*reason, "completed" | "not_planned")) {
                return Err(invalid(format!("--reason takes completed or not_planned, not {reason}.")));
            }
            params["to"] = json!(to);
            params["reason"] = json!(reason);
        }
        "assign" => {
            let to: Vec<String> = tokens.options("--to")?.iter().flat_map(|value| list_values(value)).collect();
            let me = tokens.flag("--me")?;
            let none = tokens.flag("--none")?;
            if usize::from(!to.is_empty()) + usize::from(me) + usize::from(none) != 1 {
                return Err(invalid("assign takes exactly one of --to USER..., --me or --none."));
            }
            params["to"] = json!(to);
            params["me"] = json!(me);
            params["none"] = json!(none);
        }
        "label" => {
            let add = tokens.options("--add")?;
            let remove = tokens.options("--remove")?;
            if add.is_empty() && remove.is_empty() {
                return Err(invalid("label needs --add or --remove."));
            }
            if let Some(both) = add.iter().find(|label| remove.iter().any(|other| other.eq_ignore_ascii_case(label))) {
                return Err(invalid(format!("{both} is both added and removed.")));
            }
            params["add"] = json!(add);
            params["remove"] = json!(remove);
        }
        _ => unreachable!("checked above"),
    }
    if command != "create" {
        let issue = tokens.required_front("issue")?;
        let (provider, _) = crate::issues::parse_issue_reference(&issue, params["provider"].as_str()).map_err(invalid)?;
        if provider == "linear" && !params["reason"].is_null() {
            return Err(invalid("--reason is for closing a GitHub issue; a Linear issue moves to one of its team's states."));
        }
        params["issue"] = json!(issue);
    }
    tokens.finish()?;
    // Where it runs: the default project, and a session to name in the question.
    params["caller"] = issue_caller();
    Ok(Action::Rpc {
        command: format!("issues.{command}"),
        params,
        // A write may wait for the person's answer before the provider is asked.
        timeout: if command == "view" { Duration::from_secs(60) } else { ISSUE_WRITE_TIMEOUT },
    })
}

/// Longer than the app's question ([`crate::cloud_control::QUESTION_TTL`]),
/// the write and the read after it, so the app's answer is what is printed.
const ISSUE_WRITE_TIMEOUT: Duration = Duration::from_secs(120);

/// Where an issue command runs from. The app finds the project from it and
/// names the session in its question; it decides nothing, since any process
/// can say anything here. Every write is asked.
fn issue_caller() -> Value {
    let present = |name: &str| std::env::var(name).ok().filter(|value| !value.trim().is_empty());
    json!({
        "session": present("RACCOON_SESSION_ID"),
        "tab": present("RACCOON_TAB_ID"),
        "cwd": std::env::current_dir().ok().map(|cwd| cwd.to_string_lossy().into_owned()),
    })
}

/// `--body TEXT` or `--body-file PATH` (`-` for standard input).
fn issue_body(tokens: &mut Tokens, stdin: &mut dyn FnMut() -> Result<String, ControlError>, required: bool) -> Result<Option<String>, ControlError> {
    let body = match (tokens.option("--body")?, tokens.option("--body-file")?) {
        (Some(_), Some(_)) => return Err(invalid("--body and --body-file are mutually exclusive.")),
        (Some(body), None) => Some(body),
        (None, Some(path)) if path == "-" => Some(stdin()?),
        (None, Some(path)) => Some(std::fs::read_to_string(&path).map_err(|error| invalid(format!("Could not read --body-file {path}: {error}")))?),
        (None, None) if required => return Err(invalid("Missing --body or --body-file.")),
        (None, None) => None,
    };
    if required && body.as_deref().is_some_and(|body| body.trim().is_empty()) {
        return Err(invalid("The comment is empty."));
    }
    Ok(body)
}

/// Linear's priorities by name or number: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
fn issue_priority(value: &str) -> Result<u8, ControlError> {
    match value.to_ascii_lowercase().as_str() {
        "0" | "none" => Ok(0),
        "1" | "urgent" => Ok(1),
        "2" | "high" => Ok(2),
        "3" | "medium" => Ok(3),
        "4" | "low" => Ok(4),
        other => Err(invalid(format!("--priority takes none, urgent, high, medium or low (or 0-4), not {other}."))),
    }
}

/// `alice,bob` and `--to alice --to bob` both name two people.
fn list_values(value: &str) -> Vec<String> {
    value.split(',').map(str::trim).filter(|value| !value.is_empty()).map(str::to_string).collect()
}

/// Issue pipelines: what became of the sessions started from issues.
fn parse_pipelines(tokens: &mut Tokens) -> Result<Action, ControlError> {
    let command = tokens.required_front("pipelines command")?;
    match command.as_str() {
        "list" => {
            let project = tokens.option("--project")?;
            rpc("pipelines.list", json!({"project": project}), tokens)
        }
        "show" => {
            let project = tokens.option("--project")?;
            let pipeline = tokens.required_front("pipeline")?;
            rpc("pipelines.show", json!({"pipeline": pipeline, "project": project}), tokens)
        }
        "auto-merge" => {
            let project = tokens.option("--project")?;
            let pipeline = tokens.required_front("pipeline")?;
            let value = match tokens.required_front("on or off")?.as_str() {
                "on" => true,
                "off" => false,
                other => return Err(invalid(format!("auto-merge takes on or off, not {other}."))),
            };
            // Turning it on may merge there and then.
            tokens.finish()?;
            Ok(Action::Rpc { command: "pipelines.autoMerge".into(), params: json!({"pipeline": pipeline, "project": project, "value": value}), timeout: PIPELINE_TIMEOUT })
        }
        "stop" | "resume" | "advance" | "review" | "refresh" => {
            let project = tokens.option("--project")?;
            let pipeline = tokens.required_front("pipeline")?;
            tokens.finish()?;
            Ok(Action::Rpc { command: "pipelines.act".into(), params: json!({"pipeline": pipeline, "project": project, "action": command}), timeout: PIPELINE_TIMEOUT })
        }
        other => Err(invalid(format!("Unknown pipelines command {other}."))),
    }
}

/// A pipeline step pushes, opens a pull request or asks GitHub to merge
/// before it answers.
const PIPELINE_TIMEOUT: Duration = Duration::from_secs(180);

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

    /// Whether the flag `name` was passed, without consuming it.
    pub(crate) fn peek_flag(&self, name: &str) -> bool {
        self.values.iter().any(|value| value == name)
    }

    /// The value `name` would take, without consuming it.
    pub(crate) fn peek_option(&self, name: &str) -> Option<String> {
        let position = self.values.iter().position(|value| value == name)?;
        self.values.get(position + 1).cloned()
    }

    /// Every value of an option that may be repeated, in the order given.
    pub(crate) fn options(&mut self, name: &str) -> Result<Vec<String>, ControlError> {
        let mut values = Vec::new();
        while let Some(position) = self.values.iter().position(|value| value == name) {
            if position + 1 >= self.values.len() {
                return Err(invalid(format!("{name} needs a value.")));
            }
            self.values.remove(position);
            values.push(self.values.remove(position));
        }
        Ok(values)
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
    fn a_quick_chat_is_created_and_listed_without_a_project() {
        let (command, params, _) = rpc_of(&["sessions", "create", "--quick", "--agent", "claude", "--prompt", "What is a monad?", "--cwd", "/tmp/notes", "--mode", "plan"]);
        assert_eq!(command, "sessions.create");
        assert_eq!(params, json!({"quick": true, "agent": "claude", "prompt": "What is a monad?", "title": null, "cwd": "/tmp/notes", "model": "", "effort": null, "mode": "plan"}));
        // What belongs to a project or a worktree is refused rather than ignored.
        for extra in [&["--project", "api"][..], &["--name", "fix"], &["--worktree"], &["--on-main"]] {
            let mut values = vec!["sessions", "create", "--quick", "--agent", "claude", "--prompt", "hi"];
            values.extend_from_slice(extra);
            assert!(parse(&args(&values)).is_err(), "{extra:?}");
        }
        // Without --quick a project is still required, exactly as before.
        assert!(parse(&args(&["sessions", "create", "--agent", "claude", "--prompt", "hi"])).is_err());

        let (command, params, _) = rpc_of(&["sessions", "list", "--quick"]);
        assert_eq!((command.as_str(), params), ("sessions.list", json!({"project": null, "quick": true})));
        assert_eq!(rpc_of(&["sessions", "list", "--project", "api"]).1, json!({"project": "api", "quick": false}));
        assert!(parse(&args(&["sessions", "list", "--quick", "--project", "api"])).is_err());
        assert!(parse(&args(&["sessions", "list", "--quick", "--cloud"])).is_err());
    }

    #[test]
    fn the_floating_window_is_shown_hidden_and_toggled_from_the_command_line() {
        for action in ["show", "hide", "toggle"] {
            let (command, params, _) = rpc_of(&["floating", action]);
            assert_eq!((command, params), (format!("floating.{action}"), json!({"session": null})));
        }
        assert_eq!(rpc_of(&["floating", "show", "--session", "0198"]).1, json!({"session": "0198"}));
        assert!(parse(&args(&["floating"])).is_err());
        assert!(parse(&args(&["floating", "explode"])).is_err());
        assert!(help_text().contains("terminalx floating show|hide|toggle"));
        assert!(help_text().contains("terminalx sessions create --quick"));
    }

    #[test]
    fn sharing_cli_carries_explicit_access_policy_and_revocation_semantics() {
        let (command, params, _) = rpc_of(&["share", "create", "session", "--read-only", "--people", "alice@example.com,bob@example.com", "--approve", "--single-use", "--local-only"]);
        assert_eq!(command, "share.create");
        assert_eq!(params["sessionId"], "session");
        assert_eq!(params["directOnly"], true);
        assert_eq!(params["settings"]["role"], "viewer");
        assert_eq!(params["settings"]["canApprove"], false);
        assert_eq!(params["settings"]["audience"], "people");
        assert_eq!(params["settings"]["people"][1], json!({ "email": "bob@example.com", "role": "viewer" }));
        let (command, params, _) = rpc_of(&["share", "revoke", "session", "link", "--keep-guests"]);
        assert_eq!(command, "share.revoke");
        assert_eq!(params["removeGuests"], false);
        assert!(parse(&args(&["share", "edit", "session", "link"])).is_err());
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
    fn a_session_starts_from_an_issue_and_carries_the_merge_switch() {
        let (command, params, timeout) = rpc_of(&["sessions", "create", "--project", "raccoon", "--agent", "claude", "--issue", "433"]);
        assert_eq!(command, "sessions.create");
        // The issue is the prompt; the switch is the project's default unless named.
        assert_eq!((&params["issue"], &params["prompt"], &params["autoMerge"], &params["noPipeline"], &params["useWorktree"]), (&json!("433"), &json!(""), &json!(null), &json!(false), &json!(true)));
        assert!(timeout >= Duration::from_secs(60));
        let (_, params, _) = rpc_of(&["sessions", "create", "--issue", "ENG-42", "--provider", "linear", "--auto-merge", "--prompt", "Keep the public API.", "--project", "raccoon", "--agent", "codex"]);
        assert_eq!((&params["issue"], &params["provider"], &params["autoMerge"], &params["prompt"]), (&json!("ENG-42"), &json!("linear"), &json!(true), &json!("Keep the public API.")));
        let (_, params, _) = rpc_of(&["sessions", "create", "--issue", "433", "--no-auto-merge", "--no-pipeline", "--project", "raccoon", "--agent", "codex"]);
        assert_eq!((&params["autoMerge"], &params["noPipeline"]), (&json!(false), &json!(true)));

        // Without an issue the request is word for word what it was, and the issue's flags are refused.
        let (_, params, _) = rpc_of(&["sessions", "create", "--project", "raccoon", "--agent", "codex", "--prompt", "go"]);
        assert!(params.get("issue").is_none() && params.get("autoMerge").is_none() && params.get("noPipeline").is_none());
        for flag in ["--auto-merge", "--no-auto-merge", "--no-pipeline"] {
            let error = parse(&args(&["sessions", "create", "--project", "raccoon", "--agent", "codex", "--prompt", "go", flag])).unwrap_err();
            assert!(error.message.contains("apply to a session started with --issue"), "{flag}: {}", error.message);
        }
        assert!(parse(&args(&["sessions", "create", "--project", "raccoon", "--agent", "codex", "--prompt", "go", "--provider", "linear"])).is_err());
        assert!(parse(&args(&["sessions", "create", "--project", "raccoon", "--agent", "codex", "--issue", "433", "--auto-merge", "--no-auto-merge"])).is_err());
        assert!(parse(&args(&["sessions", "create", "--project", "raccoon", "--agent", "codex"])).is_err());
    }

    fn issue_rpc(values: &[&str]) -> (String, Value, Duration) {
        let (command, mut params, timeout) = rpc_of(values);
        // Where the test runs from is not what is being tested.
        assert!(params.as_object_mut().unwrap().remove("caller").is_some(), "every issue command says who asks");
        (command, params, timeout)
    }

    fn issue_error(values: &[&str]) -> String {
        let error = parse(&args(values)).unwrap_err();
        assert_eq!(error.code, "invalid_arguments", "{values:?}");
        error.message
    }

    #[test]
    fn an_issue_is_viewed_with_or_without_its_comments() {
        let (command, params, timeout) = issue_rpc(&["issues", "view", "#433"]);
        assert_eq!((command.as_str(), params), ("issues.view", json!({"issue": "#433", "provider": null, "project": null, "comments": false})));
        assert_eq!(timeout, Duration::from_secs(60));
        let (_, params, _) = issue_rpc(&["issues", "view", "--comments", "PRO-42", "--provider", "linear", "--project", "raccoon", "--json"]);
        assert_eq!(params, json!({"issue": "PRO-42", "provider": "linear", "project": "raccoon", "comments": true}));
        for reference in ["https://github.com/acme/api/issues/12", "https://linear.app/acme/issue/ENG-7/fix-it", "12"] {
            assert_eq!(issue_rpc(&["issues", "view", reference]).1["issue"], json!(reference));
        }
        assert!(issue_error(&["issues", "view"]).contains("Missing issue"));
        assert!(issue_error(&["issues", "view", "not an issue"]).contains("is not an issue"));
        assert!(issue_error(&["issues", "view", "PRO-42", "--provider", "github"]).contains("is a Linear issue"));
        assert!(issue_error(&["issues", "view", "12", "--provider", "jira"]).contains("github or linear"));
        assert!(issue_error(&["issues", "view", "12", "13"]).contains("Unexpected argument 13"));
        assert!(issue_error(&["issues", "close", "12"]).contains("Unknown issues command close"));
        // The list keeps its exact request.
        assert_eq!(rpc_of(&["issues", "list", "--project", "raccoon"]).1, json!({"project": "raccoon", "provider": null, "assignedToMe": false, "team": null, "search": null}));
    }

    #[test]
    fn a_comment_comes_from_the_command_line_a_file_or_standard_input() {
        let (command, params, timeout) = issue_rpc(&["issues", "comment", "#12", "--body", "PR: https://github.com/acme/api/pull/13"]);
        assert_eq!((command.as_str(), params), ("issues.comment", json!({"issue": "#12", "provider": null, "project": null, "body": "PR: https://github.com/acme/api/pull/13"})));
        assert!(timeout > crate::cloud_control::QUESTION_TTL + Duration::from_secs(30), "the person's answer and the write fit in the wait");

        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("comment.md");
        std::fs::write(&file, "## Done\n\nSee the PR.").unwrap();
        let path = file.to_string_lossy().into_owned();
        assert_eq!(issue_rpc(&["issues", "comment", "ENG-7", "--body-file", &path]).1["body"], json!("## Done\n\nSee the PR."));

        let mut stdin = || Ok::<_, ControlError>("from a pipe".to_string());
        let Action::Rpc { params, .. } = parse_with_stdin(&args(&["issues", "comment", "12", "--body-file", "-"]), &mut stdin).unwrap().action else { panic!("expected rpc") };
        assert_eq!(params["body"], json!("from a pipe"));

        assert!(issue_error(&["issues", "comment", "12"]).contains("Missing --body"));
        assert!(issue_error(&["issues", "comment", "12", "--body", "  "]).contains("empty"));
        assert!(issue_error(&["issues", "comment", "12", "--body", "a", "--body-file", &path]).contains("mutually exclusive"));
        assert!(issue_error(&["issues", "comment", "12", "--body-file", &format!("{path}.missing")]).contains("Could not read --body-file"));
        assert!(issue_error(&["issues", "comment", "12", "--body"]).contains("--body needs a value"));
    }

    #[test]
    fn a_status_move_names_its_state_and_a_github_close_its_reason() {
        let (command, params, _) = issue_rpc(&["issues", "status", "PRO-42", "--to", "In Review"]);
        assert_eq!((command.as_str(), params), ("issues.status", json!({"issue": "PRO-42", "provider": null, "project": null, "to": "In Review", "reason": null})));
        let (_, params, _) = issue_rpc(&["issues", "status", "#12", "--to", "closed", "--reason", "not_planned"]);
        assert_eq!((&params["to"], &params["reason"]), (&json!("closed"), &json!("not_planned")));
        assert_eq!(issue_rpc(&["issues", "status", "12", "--reason", "completed", "--to", "closed"]).1["reason"], json!("completed"));

        assert!(issue_error(&["issues", "status", "12"]).contains("Missing --to"));
        assert!(issue_error(&["issues", "status", "12", "--to", " "]).contains("--to cannot be empty"));
        assert!(issue_error(&["issues", "status", "12", "--to", "closed", "--reason", "duplicate"]).contains("completed or not_planned"));
        assert!(issue_error(&["issues", "status", "PRO-42", "--to", "Done", "--reason", "completed"]).contains("--reason is for closing a GitHub issue"));
        assert!(issue_error(&["issues", "status", "12", "--to", "open", "--to", "closed"]).contains("only once"));
    }

    #[test]
    fn assigning_takes_people_me_or_nobody_and_exactly_one_of_them() {
        let (command, params, _) = issue_rpc(&["issues", "assign", "#12", "--to", "alice", "--to", "bob,carol"]);
        assert_eq!((command.as_str(), params), ("issues.assign", json!({"issue": "#12", "provider": null, "project": null, "to": ["alice", "bob", "carol"], "me": false, "none": false})));
        assert_eq!(issue_rpc(&["issues", "assign", "PRO-42", "--me"]).1, json!({"issue": "PRO-42", "provider": null, "project": null, "to": [], "me": true, "none": false}));
        assert_eq!(issue_rpc(&["issues", "assign", "PRO-42", "--none"]).1["none"], json!(true));
        for values in [
            &["issues", "assign", "12"][..],
            &["issues", "assign", "12", "--me", "--none"],
            &["issues", "assign", "12", "--to", "alice", "--me"],
            &["issues", "assign", "12", "--to", "alice", "--none"],
            &["issues", "assign", "12", "--to", ","],
        ] {
            assert!(issue_error(values).contains("exactly one of"), "{values:?}");
        }
        assert!(issue_error(&["issues", "assign", "12", "--to"]).contains("--to needs a value"));
    }

    #[test]
    fn labels_are_added_and_removed_by_name() {
        let (command, params, _) = issue_rpc(&["issues", "label", "#12", "--add", "bug", "--add", "needs review", "--remove", "triage"]);
        assert_eq!((command.as_str(), params), ("issues.label", json!({"issue": "#12", "provider": null, "project": null, "add": ["bug", "needs review"], "remove": ["triage"]})));
        // A label's name may hold a comma: it is never split.
        assert_eq!(issue_rpc(&["issues", "label", "12", "--remove", "a, b"]).1, json!({"issue": "12", "provider": null, "project": null, "add": [], "remove": ["a, b"]}));
        assert!(issue_error(&["issues", "label", "12"]).contains("--add or --remove"));
        assert!(issue_error(&["issues", "label", "12", "--add", "Bug", "--remove", "bug"]).contains("both added and removed"));
    }

    #[test]
    fn an_issue_is_created_in_a_named_project() {
        let (command, params, timeout) = issue_rpc(&["issues", "create", "--project", "raccoon", "--title", "Crash on start"]);
        assert_eq!(
            (command.as_str(), params),
            ("issues.create", json!({"project": "raccoon", "provider": null, "title": "Crash on start", "body": null, "team": null, "assignees": [], "labels": [], "state": null, "priority": null}))
        );
        assert_eq!(timeout, ISSUE_WRITE_TIMEOUT);
        let (_, params, _) = issue_rpc(&[
            "issues", "create", "--provider", "linear", "--project", "raccoon", "--title", "Flaky test", "--body", "Seen twice.", "--team", "PRO",
            "--assignee", "ada", "--label", "bug", "--label", "ci", "--state", "Todo", "--priority", "high",
        ]);
        assert_eq!(
            params,
            json!({"project": "raccoon", "provider": "linear", "title": "Flaky test", "body": "Seen twice.", "team": "PRO", "assignees": ["ada"], "labels": ["bug", "ci"], "state": "Todo", "priority": 2})
        );
        assert_eq!(issue_rpc(&["issues", "create", "--project", "p", "--title", "t", "--priority", "0"]).1["priority"], json!(0));
        assert!(issue_error(&["issues", "create", "--title", "t"]).contains("Missing --project"));
        assert!(issue_error(&["issues", "create", "--project", "p"]).contains("Missing --title"));
        assert!(issue_error(&["issues", "create", "--project", "p", "--title", " "]).contains("--title cannot be empty"));
        assert!(issue_error(&["issues", "create", "--project", "p", "--title", "t", "--priority", "p0"]).contains("--priority takes"));
        assert!(issue_error(&["issues", "create", "--project", "p", "--title", "t", "#12"]).contains("Unexpected argument #12"));
    }

    #[test]
    fn an_issue_command_says_where_it_runs() {
        let (_, params, _) = rpc_of(&["issues", "view", "12"]);
        let caller = &params["caller"];
        for key in ["session", "tab", "cwd"] {
            assert!(caller.get(key).is_some(), "{key}");
        }
        assert!(caller.get("agentEnvironment").is_none(), "nothing the caller says decides whether it is asked");
        for text in [help_text(), GUIDE.to_string()] {
            for command in ["issues view", "issues comment", "issues status", "issues assign", "issues label", "issues create"] {
                assert!(text.contains(command), "missing {command}");
            }
        }
    }

    #[test]
    fn pipelines_are_listed_shown_and_steered_but_not_merged_from_the_command_line() {
        assert_eq!(rpc_of(&["pipelines", "list"]).0, "pipelines.list");
        assert_eq!(rpc_of(&["pipelines", "list", "--project", "raccoon"]).1, json!({"project": "raccoon"}));
        assert_eq!(rpc_of(&["pipelines", "show", "433"]), ("pipelines.show".to_string(), json!({"pipeline": "433", "project": null}), Duration::from_secs(30)));
        let (command, params, timeout) = rpc_of(&["pipelines", "auto-merge", "ENG-42", "off"]);
        assert_eq!((command.as_str(), params), ("pipelines.autoMerge", json!({"pipeline": "ENG-42", "project": null, "value": false})));
        assert_eq!(timeout, PIPELINE_TIMEOUT);
        assert_eq!(rpc_of(&["pipelines", "auto-merge", "ENG-42", "on"]).1["value"], json!(true));
        for action in ["stop", "resume", "advance", "review", "refresh"] {
            let (command, params, _) = rpc_of(&["pipelines", action, "433"]);
            assert_eq!((command.as_str(), params), ("pipelines.act", json!({"pipeline": "433", "project": null, "action": action})));
        }
        // Two projects can each have a #12: the project says which is meant.
        assert_eq!(rpc_of(&["pipelines", "auto-merge", "12", "on", "--project", "widgets"]).1, json!({"pipeline": "12", "project": "widgets", "value": true}));
        assert_eq!(rpc_of(&["pipelines", "stop", "--project", "widgets", "12"]).1["project"], json!("widgets"));
        assert_eq!(rpc_of(&["pipelines", "show", "12", "--project", "widgets"]).1["project"], json!("widgets"));
        // Merging by hand is done on the issue page.
        assert!(parse(&args(&["pipelines", "merge", "433"])).unwrap_err().message.contains("Unknown pipelines command merge"));
        assert!(parse(&args(&["pipelines", "auto-merge", "433", "maybe"])).is_err());
        assert!(parse(&args(&["pipelines", "auto-merge", "433"])).is_err());
        assert!(parse(&args(&["pipelines", "show"])).is_err());
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
