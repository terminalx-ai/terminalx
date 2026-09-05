//! The `terminalx computer …` command group: flag parsing into control
//! requests and pretty output, ported from Legacy's `specs/computer.ts`,
//! `handlers/computer.ts`, and `computer-format.ts` so the installed skill's
//! flag names and reading habits carry over unchanged.

use std::time::Duration;

use serde_json::{Map, Value};

use super::validation::{
    click_modifiers_validation_message, hotkey_validation_message, press_key_validation_message,
};
use super::{recovery_for, ActionMethod};
use crate::cli::{Action, Tokens};
use crate::control::ControlError;

/// Computer commands wait longer than other control calls: the helper may
/// spend up to 60 s on one request and 10 s more starting up.
pub const CLI_TIMEOUT: Duration = Duration::from_secs(90);

pub const HELP: &str = r#"  terminalx computer permissions [--id accessibility|screenshots] [--json]
  terminalx computer capabilities [--json]
  terminalx computer list-apps [--json]
  terminalx computer list-windows --app <name|bundle|pid:N> [--json]
  terminalx computer get-app-state --app <app> [--window-id <id> | --window-index <n>]
      [--restore-window] [--no-screenshot] [--json]
  terminalx computer click --app <app> (--element-index <n> | --x <x> --y <y>)
      [--click-count <n>] [--mouse-button left|right|middle] [--modifiers <chord>] [--json]
  terminalx computer perform-secondary-action --app <app> --element-index <n> --action <name> [--json]
  terminalx computer set-value --app <app> --element-index <n> (--value <text> | --value-stdin) [--json]
  terminalx computer type-text --app <app> (--text <text> | --text-stdin) [--json]
  terminalx computer press-key --app <app> --key <Return|Escape|Tab|ArrowDown|…> [--json]
  terminalx computer hotkey --app <app> --key <CmdOrCtrl+A> [--json]
  terminalx computer paste-text --app <app> (--text <text> | --text-stdin) [--json]
  terminalx computer scroll --app <app> (--element-index <n> | --x <x> --y <y>)
      --direction up|down|left|right [--pages <n>] [--json]
  terminalx computer drag --app <app> (--from-element-index <n> --to-element-index <n>
      | --from-x <x> --from-y <y> --to-x <x> --to-y <y>) [--json]
  Action commands also accept --window-id|--window-index, --restore-window, --no-screenshot."#;

fn invalid(message: impl Into<String>) -> ControlError {
    ControlError::new(
        "invalid_argument",
        message,
        Some(recovery_for("invalid_argument").into()),
    )
}

/// Reads the whole of stdin for `--text-stdin` / `--value-stdin`.
pub fn read_stdin_payload() -> Result<String, ControlError> {
    use std::io::{IsTerminal, Read};
    let stdin = std::io::stdin();
    if stdin.is_terminal() {
        return Err(invalid("stdin payload requested but stdin is a TTY"));
    }
    let mut payload = String::new();
    stdin
        .lock()
        .read_to_string(&mut payload)
        .map_err(|e| invalid(format!("could not read stdin: {e}")))?;
    Ok(payload)
}

/// Parse `computer <command> …`. `stdin` supplies the payload for the
/// `--text-stdin` / `--value-stdin` flags so tests can inject one.
pub(crate) fn parse(
    tokens: &mut Tokens,
    stdin: &mut dyn FnMut() -> Result<String, ControlError>,
) -> Result<Action, ControlError> {
    let command = tokens.required_front("computer command")?;
    let outcome = parse_command(&command, tokens, stdin);
    // Every computer error is invalid_argument: that is the code the skill
    // guide teaches, and the generic invalid_arguments recovery would send
    // the agent to --help instead of to the flag it got wrong.
    outcome.map_err(|error| {
        if error.code == "invalid_arguments" {
            invalid(error.message)
        } else {
            error
        }
    })
}

fn parse_command(
    command: &str,
    tokens: &mut Tokens,
    stdin: &mut dyn FnMut() -> Result<String, ControlError>,
) -> Result<Action, ControlError> {
    let (method, params) = match command {
        "permissions" => {
            let id = tokens.option("--id")?;
            if let Some(id) = &id {
                if id != "accessibility" && id != "screenshots" {
                    return Err(invalid("--id must be \"accessibility\" or \"screenshots\""));
                }
            }
            let mut params = Map::new();
            if let Some(id) = id {
                params.insert("id".into(), Value::String(id));
            }
            ("permissions", params)
        }
        "capabilities" => ("capabilities", Map::new()),
        "list-apps" => ("listApps", Map::new()),
        "list-windows" => {
            let mut params = Map::new();
            params.insert("app".into(), Value::String(required_app(tokens)?));
            ("listWindows", params)
        }
        "get-app-state" => {
            let mut params = observe_flags(tokens)?;
            params.insert("app".into(), Value::String(required_app(tokens)?));
            ("getAppState", params)
        }
        "click" => {
            let mut params = observe_flags(tokens)?;
            params.insert("app".into(), Value::String(required_app(tokens)?));
            insert_opt(&mut params, "elementIndex", option_non_negative_integer(tokens, "--element-index")?);
            insert_opt(&mut params, "x", option_number(tokens, "--x")?);
            insert_opt(&mut params, "y", option_number(tokens, "--y")?);
            insert_opt(&mut params, "clickCount", option_positive_integer(tokens, "--click-count")?);
            if let Some(button) = tokens.option("--mouse-button")? {
                if !matches!(button.as_str(), "left" | "right" | "middle") {
                    return Err(invalid("Unsupported mouseButton; expected left, right, or middle"));
                }
                params.insert("mouseButton".into(), Value::String(button));
            }
            if let Some(modifiers) = tokens.option("--modifiers")? {
                if let Some(message) = click_modifiers_validation_message(&modifiers) {
                    return Err(invalid(message));
                }
                params.insert("modifiers".into(), Value::String(modifiers));
            }
            element_or_coordinates("Click", &params)?;
            ("click", params)
        }
        "perform-secondary-action" => {
            let mut params = observe_flags(tokens)?;
            params.insert("app".into(), Value::String(required_app(tokens)?));
            params.insert("elementIndex".into(), required_non_negative_integer(tokens, "--element-index")?);
            params.insert("action".into(), Value::String(required_string(tokens, "--action")?));
            ("performSecondaryAction", params)
        }
        "scroll" => {
            let mut params = observe_flags(tokens)?;
            params.insert("app".into(), Value::String(required_app(tokens)?));
            insert_opt(&mut params, "elementIndex", option_non_negative_integer(tokens, "--element-index")?);
            insert_opt(&mut params, "x", option_number(tokens, "--x")?);
            insert_opt(&mut params, "y", option_number(tokens, "--y")?);
            let direction = required_string(tokens, "--direction")?;
            if !matches!(direction.as_str(), "up" | "down" | "left" | "right") {
                return Err(invalid("Unsupported direction; expected up, down, left, or right"));
            }
            params.insert("direction".into(), Value::String(direction));
            insert_opt(&mut params, "pages", option_positive_number(tokens, "--pages")?);
            element_or_coordinates("Scroll", &params)?;
            ("scroll", params)
        }
        "drag" => {
            let mut params = observe_flags(tokens)?;
            params.insert("app".into(), Value::String(required_app(tokens)?));
            insert_opt(&mut params, "fromElementIndex", option_non_negative_integer(tokens, "--from-element-index")?);
            insert_opt(&mut params, "toElementIndex", option_non_negative_integer(tokens, "--to-element-index")?);
            insert_opt(&mut params, "fromX", option_number(tokens, "--from-x")?);
            insert_opt(&mut params, "fromY", option_number(tokens, "--from-y")?);
            insert_opt(&mut params, "toX", option_number(tokens, "--to-x")?);
            insert_opt(&mut params, "toY", option_number(tokens, "--to-y")?);
            super::validation::validate_action_params(ActionMethod::Drag, &Value::Object(params.clone()))
                .map_err(|e| invalid(e.message))?;
            ("drag", params)
        }
        "type-text" | "paste-text" => {
            let mut params = observe_flags(tokens)?;
            params.insert("app".into(), Value::String(required_app(tokens)?));
            params.insert("text".into(), Value::String(text_payload(tokens, "text", stdin)?));
            (if command == "type-text" { "typeText" } else { "pasteText" }, params)
        }
        "press-key" => {
            let mut params = observe_flags(tokens)?;
            params.insert("app".into(), Value::String(required_app(tokens)?));
            let key = required_string(tokens, "--key")?;
            if let Some(message) = press_key_validation_message(&key) {
                return Err(invalid(message));
            }
            params.insert("key".into(), Value::String(key));
            ("pressKey", params)
        }
        "hotkey" => {
            let mut params = observe_flags(tokens)?;
            params.insert("app".into(), Value::String(required_app(tokens)?));
            let key = required_string(tokens, "--key")?;
            if let Some(message) = hotkey_validation_message(&key) {
                return Err(invalid(message));
            }
            params.insert("key".into(), Value::String(key));
            ("hotkey", params)
        }
        "set-value" => {
            let mut params = observe_flags(tokens)?;
            params.insert("app".into(), Value::String(required_app(tokens)?));
            params.insert("elementIndex".into(), required_non_negative_integer(tokens, "--element-index")?);
            params.insert("value".into(), Value::String(text_payload(tokens, "value", stdin)?));
            ("setValue", params)
        }
        other => return Err(invalid(format!("Unknown computer command {other}."))),
    };
    tokens.finish()?;
    Ok(Action::Rpc {
        command: format!("computer.{method}"),
        params: Value::Object(params),
        timeout: CLI_TIMEOUT,
    })
}

fn observe_flags(tokens: &mut Tokens) -> Result<Map<String, Value>, ControlError> {
    let mut params = Map::new();
    let window_id = option_non_negative_integer(tokens, "--window-id")?;
    let window_index = option_non_negative_integer(tokens, "--window-index")?;
    if window_id.is_some() && window_index.is_some() {
        return Err(invalid(
            "Window targeting accepts either --window-id or --window-index, not both",
        ));
    }
    insert_opt(&mut params, "windowId", window_id);
    insert_opt(&mut params, "windowIndex", window_index);
    if tokens.flag("--restore-window")? {
        params.insert("restoreWindow".into(), Value::Bool(true));
    }
    if tokens.flag("--no-screenshot")? {
        params.insert("noScreenshot".into(), Value::Bool(true));
    }
    Ok(params)
}

fn element_or_coordinates(action: &str, params: &Map<String, Value>) -> Result<(), ControlError> {
    let has_element = params.contains_key("elementIndex");
    let has_x = params.contains_key("x");
    let has_y = params.contains_key("y");
    if !has_element && !(has_x && has_y) {
        return Err(invalid(format!(
            "{action} requires --element-index or both --x and --y"
        )));
    }
    if has_x != has_y {
        return Err(invalid(format!("{action} coordinates require both --x and --y")));
    }
    if has_element && (has_x || has_y) {
        return Err(invalid(format!(
            "{action} accepts either --element-index or coordinate flags, not both"
        )));
    }
    Ok(())
}

fn text_payload(
    tokens: &mut Tokens,
    name: &str,
    stdin: &mut dyn FnMut() -> Result<String, ControlError>,
) -> Result<String, ControlError> {
    let flag = format!("--{name}");
    let stdin_flag = format!("--{name}-stdin");
    let inline = tokens.option(&flag)?;
    if tokens.flag(&stdin_flag)? {
        if inline.is_some() {
            return Err(invalid(format!("Use either {flag} or {stdin_flag}, not both")));
        }
        let payload = stdin()?;
        if name == "text" && payload.is_empty() {
            return Err(invalid("Missing text from stdin"));
        }
        return Ok(payload);
    }
    match inline {
        Some(value) if name == "value" || !value.is_empty() => Ok(value),
        _ => Err(invalid(format!("Missing required {flag}"))),
    }
}

fn required_app(tokens: &mut Tokens) -> Result<String, ControlError> {
    required_string(tokens, "--app")
}

fn required_string(tokens: &mut Tokens, name: &str) -> Result<String, ControlError> {
    tokens
        .option(name)?
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("Missing required {name}")))
}

fn option_non_negative_integer(tokens: &mut Tokens, name: &str) -> Result<Option<Value>, ControlError> {
    tokens
        .option(name)?
        .map(|value| {
            value
                .parse::<u64>()
                .map(Value::from)
                .map_err(|_| invalid(format!("Invalid non-negative integer for {name}")))
        })
        .transpose()
}

fn required_non_negative_integer(tokens: &mut Tokens, name: &str) -> Result<Value, ControlError> {
    option_non_negative_integer(tokens, name)?
        .ok_or_else(|| invalid(format!("Missing required {name}")))
}

fn option_positive_integer(tokens: &mut Tokens, name: &str) -> Result<Option<Value>, ControlError> {
    match option_non_negative_integer(tokens, name)? {
        Some(value) if value.as_u64() == Some(0) => {
            Err(invalid(format!("Invalid positive integer for {name}")))
        }
        other => Ok(other),
    }
}

fn option_number(tokens: &mut Tokens, name: &str) -> Result<Option<Value>, ControlError> {
    tokens
        .option(name)?
        .map(|value| {
            value
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
                .and_then(|n| serde_json::Number::from_f64(n).map(Value::Number))
                .ok_or_else(|| invalid(format!("Invalid number for {name}")))
        })
        .transpose()
}

fn option_positive_number(tokens: &mut Tokens, name: &str) -> Result<Option<Value>, ControlError> {
    match option_number(tokens, name)? {
        Some(value) if value.as_f64().is_some_and(|n| n <= 0.0) => {
            Err(invalid(format!("Invalid positive number for {name}")))
        }
        other => Ok(other),
    }
}

fn insert_opt(params: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        params.insert(key.into(), value);
    }
}

// ------------------------------------------------------------ pretty output

/// Human output for a successful `computer.*` call; `None` means "print the
/// JSON", which only happens for methods this module does not know.
pub fn format_result(command: &str, params: &Value, result: &Value) -> Option<String> {
    let method = command.strip_prefix("computer.")?;
    Some(match method {
        "capabilities" => format_capabilities(result),
        "permissions" => format_permissions(result),
        "permissionsStatus" | "permissionsReset" => format_permission_status(result),
        "listApps" => format_list_apps(result),
        "listWindows" => format_list_windows(result),
        "getAppState" => format_get_app_state(result),
        other => {
            let verb = ActionMethod::from_wire(other)?;
            format_action(verb, result, params)
        }
    })
}

fn s<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn n(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn b(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn fmt_num(value: f64) -> String {
    if value.fract() == 0.0 {
        format!("{}", value as i64)
    } else {
        let text = format!("{value:.3}");
        text.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn flag_bool(value: &Value, path: &[&str]) -> bool {
    let mut cursor = value;
    for key in path {
        let Some(next) = cursor.get(key) else { return false };
        cursor = next;
    }
    cursor.as_bool().unwrap_or(false)
}

pub fn format_capabilities(value: &Value) -> String {
    let actions: Vec<&str> = value
        .get("supports")
        .and_then(|s| s.get("actions"))
        .and_then(Value::as_object)
        .map(|actions| {
            actions
                .iter()
                .filter(|(_, enabled)| enabled.as_bool() == Some(true))
                .map(|(name, _)| name.as_str())
                .collect()
        })
        .unwrap_or_default();
    [
        format!(
            "{} ({}, protocol {})",
            s(value, "provider").unwrap_or("unknown provider"),
            s(value, "platform").unwrap_or("unknown platform"),
            value.get("protocolVersion").and_then(Value::as_u64).unwrap_or(0)
        ),
        format!(
            "  Apps: list={} bundleIds={} pids={}",
            flag_bool(value, &["supports", "apps", "list"]),
            flag_bool(value, &["supports", "apps", "bundleIds"]),
            flag_bool(value, &["supports", "apps", "pids"])
        ),
        format!(
            "  Windows: list={} targetById={} targetByIndex={}",
            flag_bool(value, &["supports", "windows", "list"]),
            flag_bool(value, &["supports", "windows", "targetById"]),
            flag_bool(value, &["supports", "windows", "targetByIndex"])
        ),
        format!(
            "  Observation: screenshot={} elementFrames={} annotatedScreenshot={}",
            flag_bool(value, &["supports", "observation", "screenshot"]),
            flag_bool(value, &["supports", "observation", "elementFrames"]),
            flag_bool(value, &["supports", "observation", "annotatedScreenshot"])
        ),
        format!("  Actions: {}", actions.join(", ")),
    ]
    .join("\n")
}

fn format_permission_list(value: &Value) -> String {
    value
        .get("permissions")
        .and_then(Value::as_array)
        .map(|permissions| {
            permissions
                .iter()
                .map(|p| format!("{}={}", s(p, "id").unwrap_or("?"), s(p, "status").unwrap_or("?")))
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_else(|| "unknown".into())
}

pub fn format_permissions(value: &Value) -> String {
    if s(value, "platform") != Some("macos") {
        return "Computer-use permission setup is only required on macOS.".into();
    }
    let launched = b(value, "launchedHelper");
    let mut lines = vec![
        if launched {
            "Opened TerminalX Computer Use permission setup.".to_string()
        } else {
            "Computer Use permissions checked.".to_string()
        },
        format!("Helper app: {}", s(value, "helperAppPath").unwrap_or("not found")),
        format!("Permissions: {}", format_permission_list(value)),
        match s(value, "nextStep") {
            Some(step) => format!("Next: {step}"),
            None => "Computer Use permissions are already granted.".into(),
        },
    ];
    if launched {
        lines.push(
            "Use the Allow buttons or drag \"TerminalX Computer Use\" into the macOS permission list."
                .into(),
        );
    }
    lines.join("\n")
}

pub fn format_permission_status(value: &Value) -> String {
    let mut lines = vec![
        format!("Helper app: {}", s(value, "helperAppPath").unwrap_or("not found")),
        format!("Permissions: {}", format_permission_list(value)),
    ];
    if let Some(reason) = s(value, "helperUnavailableReason") {
        lines.push(format!("Helper unavailable: {reason}"));
    }
    if let Some(bundle) = s(value, "bundleId") {
        lines.push(format!("Reset TCC rows for {bundle}."));
    }
    lines.join("\n")
}

pub fn format_list_apps(value: &Value) -> String {
    let apps = value.get("apps").and_then(Value::as_array);
    match apps {
        Some(apps) if !apps.is_empty() => apps
            .iter()
            .map(|app| {
                let bundle = s(app, "bundleId")
                    .map(|id| format!("  {id}"))
                    .unwrap_or_default();
                format!(
                    "{}  pid:{}{bundle}",
                    s(app, "name").unwrap_or("?"),
                    app.get("pid").and_then(Value::as_i64).unwrap_or(0)
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => "No apps found.".into(),
    }
}

fn format_origin(window: &Value) -> String {
    match (n(window, "x"), n(window, "y")) {
        (Some(x), Some(y)) => format!(" @ {},{}", fmt_num(x), fmt_num(y)),
        _ => String::new(),
    }
}

pub fn format_list_windows(value: &Value) -> String {
    let app_name = value
        .get("app")
        .and_then(|app| s(app, "name"))
        .unwrap_or("the app");
    let windows = value.get("windows").and_then(Value::as_array);
    match windows {
        Some(windows) if !windows.is_empty() => windows
            .iter()
            .map(|window| {
                let id = window
                    .get("id")
                    .and_then(Value::as_i64)
                    .map(|id| id.to_string())
                    .unwrap_or_else(|| "none".into());
                let screen = window
                    .get("screenIndex")
                    .and_then(Value::as_i64)
                    .map(|index| format!(" screen:{index}"))
                    .unwrap_or_default();
                let mut state = Vec::new();
                if b(window, "isMinimized") {
                    state.push("minimized");
                }
                if b(window, "isOffscreen") {
                    state.push("offscreen");
                }
                let state = if state.is_empty() {
                    String::new()
                } else {
                    format!(" {}", state.join(","))
                };
                format!(
                    "[{}] id:{id} \"{}\" ({}x{}{}){screen}{state}",
                    window.get("index").and_then(Value::as_i64).unwrap_or(0),
                    s(window, "title").unwrap_or(""),
                    fmt_num(n(window, "width").unwrap_or(0.0)),
                    fmt_num(n(window, "height").unwrap_or(0.0)),
                    format_origin(window)
                )
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => format!("No windows found for {app_name}."),
    }
}

fn format_screenshot_status(result: &Value) -> String {
    let status = result.get("screenshotStatus").cloned().unwrap_or(Value::Null);
    match s(&status, "state") {
        Some("captured") if result.get("screenshot").is_some_and(|v| !v.is_null()) => {
            let shot = &result["screenshot"];
            let bytes = match s(shot, "path") {
                Some(path) => format!("saved to {path}"),
                None => s(shot, "data")
                    .map(|data| format!("{} bytes", base64_byte_count(data)))
                    .unwrap_or_else(|| "inline".into()),
            };
            let dimensions = format!(
                "{}x{}",
                fmt_num(n(shot, "width").unwrap_or(0.0)),
                fmt_num(n(shot, "height").unwrap_or(0.0))
            );
            let scale = n(shot, "scale").unwrap_or(1.0);
            let scale_detail = if scale.is_finite() && scale > 0.0 && scale != 1.0 {
                format!(
                    ", scale {0}; coordinate x/y = screenshot pixels / {0}",
                    fmt_num(scale)
                )
            } else {
                String::new()
            };
            let engine = status
                .get("metadata")
                .and_then(|m| s(m, "engine"))
                .map(|engine| format!(", {engine}"))
                .unwrap_or_default();
            format!(
                "Screenshot captured ({}, {bytes}, {dimensions}{scale_detail}{engine})",
                s(shot, "format").unwrap_or("png")
            )
        }
        Some("skipped") => "Screenshot skipped (--no-screenshot)".into(),
        Some("failed") => format!(
            "Screenshot failed ({}): {}",
            s(&status, "code").unwrap_or("screenshot_failed"),
            s(&status, "message").unwrap_or("")
        ),
        _ => "Screenshot was not captured".into(),
    }
}

fn base64_byte_count(data: &str) -> usize {
    let padding = data.bytes().rev().take_while(|b| *b == b'=').count();
    data.len() * 3 / 4 - padding
}

pub fn format_get_app_state(result: &Value) -> String {
    let snapshot = result.get("snapshot").cloned().unwrap_or(Value::Null);
    let app = snapshot.get("app").cloned().unwrap_or(Value::Null);
    let window = snapshot.get("window").cloned().unwrap_or(Value::Null);
    let bundle = s(&app, "bundleId")
        .map(|id| format!(", {id}"))
        .unwrap_or_default();
    let focused = snapshot
        .get("focusedElementId")
        .and_then(Value::as_i64)
        .map(|id| format!("#{id}"))
        .unwrap_or_else(|| "none".into());
    let window_id = window
        .get("id")
        .and_then(Value::as_i64)
        .map(|id| format!(" id:{id}"))
        .unwrap_or_default();
    let window_index = window
        .get("index")
        .and_then(Value::as_i64)
        .map(|index| format!(" index:{index}"))
        .unwrap_or_default();
    let truncation = match snapshot.get("truncation") {
        Some(t) if b(t, "truncated") => format!(
            "  Truncated: yes (max nodes {}, max depth {})",
            t.get("maxNodes")
                .and_then(Value::as_i64)
                .map(|v| v.to_string())
                .unwrap_or_else(|| "unknown".into()),
            t.get("maxDepth")
                .and_then(Value::as_i64)
                .map(|v| v.to_string())
                .unwrap_or_else(|| "unknown".into())
        ),
        _ => "  Truncated: no".into(),
    };
    [
        format!(
            "{} (pid {}{bundle})",
            s(&app, "name").unwrap_or("?"),
            app.get("pid").and_then(Value::as_i64).unwrap_or(0)
        ),
        format!(
            "  Window:{window_id}{window_index} \"{}\" ({}x{}{})",
            s(&window, "title").unwrap_or(""),
            fmt_num(n(&window, "width").unwrap_or(0.0)),
            fmt_num(n(&window, "height").unwrap_or(0.0)),
            format_origin(&window)
        ),
        format!(
            "  Visible elements: {}  Focused: {focused}  Coordinates: {}",
            snapshot.get("elementCount").and_then(Value::as_i64).unwrap_or(0),
            s(&snapshot, "coordinateSpace").unwrap_or("window")
        ),
        truncation,
        format!("  {}", format_screenshot_status(result)),
        String::new(),
        s(&snapshot, "treeText").unwrap_or("").to_string(),
    ]
    .join("\n")
}

fn verb_name(method: ActionMethod) -> &'static str {
    match method {
        ActionMethod::Click => "Click",
        ActionMethod::PerformSecondaryAction => "Perform Secondary Action",
        ActionMethod::Scroll => "Scroll",
        ActionMethod::Drag => "Drag",
        ActionMethod::TypeText => "Type Text",
        ActionMethod::PressKey => "Press Key",
        ActionMethod::Hotkey => "Hotkey",
        ActionMethod::PasteText => "Paste Text",
        ActionMethod::SetValue => "Set Value",
    }
}

fn format_verification(action: Option<&Value>) -> String {
    let Some(action) = action.filter(|a| !a.is_null()) else {
        return ", unverified (verification metadata unavailable)".into();
    };
    match action.get("verification").filter(|v| !v.is_null()) {
        None => {
            let reason = match s(action, "path") {
                Some("accessibility") => "accessibility action unasserted",
                Some("clipboard") => "clipboard paste",
                Some("synthetic") => "synthetic input",
                _ => "verification metadata unavailable",
            };
            format!(", unverified ({reason})")
        }
        Some(verification) if s(verification, "state") == Some("verified") => {
            format!(", verified {}", s(verification, "property").unwrap_or("value"))
        }
        Some(verification) => format!(
            ", unverified ({})",
            s(verification, "reason").unwrap_or("unknown").replace('_', " ")
        ),
    }
}

/// Quote for a POSIX shell only when needed, so follow-up commands can be
/// pasted as printed.
pub fn shell_quote(value: &str) -> String {
    let safe = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | ':' | '@' | '%' | '+' | '=' | '-'));
    if safe {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
}

fn follow_up_command(result: &Value, params: &Value) -> String {
    let snapshot = result.get("snapshot").cloned().unwrap_or(Value::Null);
    let app = snapshot.get("app").cloned().unwrap_or(Value::Null);
    let selector = s(&app, "bundleId")
        .or_else(|| s(&app, "name"))
        .unwrap_or("<app>");
    let mut args = vec![
        "terminalx".to_string(),
        "computer".into(),
        "get-app-state".into(),
        "--app".into(),
        shell_quote(selector),
    ];
    let action = result.get("action");
    let window_changed = action
        .and_then(|a| a.get("verification"))
        .is_some_and(|v| s(v, "state") == Some("unverified") && s(v, "reason") == Some("window_changed"));
    let requested_id = params.get("windowId").and_then(Value::as_i64);
    let requested_index = params.get("windowIndex").and_then(Value::as_i64);
    let requested = if window_changed {
        None
    } else {
        requested_id
            .map(|id| ("--window-id", id))
            .or(requested_index.map(|index| ("--window-index", index)))
    };
    if let Some((flag, value)) = requested {
        args.push(flag.into());
        args.push(value.to_string());
    } else {
        let window = snapshot.get("window").cloned().unwrap_or(Value::Null);
        let window_id = action
            .and_then(|a| a.get("targetWindowId"))
            .and_then(Value::as_i64)
            .or_else(|| window.get("id").and_then(Value::as_i64));
        let window_index = action
            .and_then(|a| a.get("targetWindowIndex"))
            .and_then(Value::as_i64)
            .or_else(|| window.get("index").and_then(Value::as_i64));
        if let Some(id) = window_id {
            args.push("--window-id".into());
            args.push(id.to_string());
        } else if let Some(index) = window_index {
            args.push("--window-index".into());
            args.push(index.to_string());
        }
    }
    if b(params, "restoreWindow") {
        args.push("--restore-window".into());
    }
    args.join(" ")
}

pub fn format_action(method: ActionMethod, result: &Value, params: &Value) -> String {
    let action = result.get("action").filter(|a| !a.is_null());
    let path = action
        .and_then(|a| s(a, "path"))
        .map(|path| format!(" via {path}"))
        .unwrap_or_default();
    let verification = format_verification(action);
    let verified = action
        .and_then(|a| a.get("verification"))
        .is_some_and(|v| s(v, "state") == Some("verified"));
    let outcome = if verified { "completed" } else { "attempted" };
    let elements = result
        .get("snapshot")
        .and_then(|snapshot| snapshot.get("elementCount"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let screenshot_failure = match result.get("screenshotStatus") {
        Some(status) if s(status, "state") == Some("failed") => format!(
            " Screenshot failed ({}): {}.",
            s(status, "code").unwrap_or("screenshot_failed"),
            s(status, "message").unwrap_or("")
        ),
        _ => String::new(),
    };
    let screenshot_path = result
        .get("screenshot")
        .and_then(|shot| s(shot, "path"))
        .map(|path| format!(" Screenshot saved to {path}."))
        .unwrap_or_default();
    let tail = if verified {
        "Use the --json result or rerun state before choosing the next element index."
    } else {
        "Inspect with the command above or use the --json result before assuming it worked."
    };
    format!(
        "{} {outcome}{path}{verification}; {elements} visible elements in current window.{screenshot_failure}{screenshot_path} Use `{}` to inspect. {tail}",
        verb_name(method),
        follow_up_command(result, params)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse_args(values: &[&str]) -> Result<Action, ControlError> {
        parse_with_stdin(values, || Err(invalid("stdin not provided")))
    }

    fn parse_with_stdin(
        values: &[&str],
        stdin: impl Fn() -> Result<String, ControlError>,
    ) -> Result<Action, ControlError> {
        let args: Vec<String> = values.iter().map(|v| v.to_string()).collect();
        let mut tokens = Tokens::new(&args);
        let mut stdin = stdin;
        parse(&mut tokens, &mut stdin)
    }

    fn rpc(action: Action) -> (String, Value) {
        match action {
            Action::Rpc { command, params, timeout } => {
                assert_eq!(timeout, CLI_TIMEOUT);
                (command, params)
            }
            other => panic!("expected rpc, got {other:?}"),
        }
    }

    #[test]
    fn get_app_state_carries_window_and_observe_flags_in_camel_case() {
        let (command, params) = rpc(
            parse_args(&["get-app-state", "--app", "com.apple.finder", "--window-index", "2", "--restore-window", "--no-screenshot"]).unwrap(),
        );
        assert_eq!(command, "computer.getAppState");
        assert_eq!(params, json!({"app": "com.apple.finder", "windowIndex": 2, "restoreWindow": true, "noScreenshot": true}));
        let both = parse_args(&["get-app-state", "--app", "x", "--window-id", "1", "--window-index", "2"]).unwrap_err();
        assert_eq!(both.code, "invalid_argument");
        assert_eq!(both.recovery.as_deref(), Some(recovery_for("invalid_argument")));
    }

    #[test]
    fn click_accepts_an_element_or_coordinates_with_modifiers() {
        let (command, params) = rpc(parse_args(&["click", "--app", "Finder", "--element-index", "7", "--mouse-button", "right", "--click-count", "2", "--modifiers", "CmdOrCtrl+Shift"]).unwrap());
        assert_eq!(command, "computer.click");
        assert_eq!(params["elementIndex"], 7);
        assert_eq!(params["mouseButton"], "right");
        assert_eq!(params["clickCount"], 2);
        assert_eq!(params["modifiers"], "CmdOrCtrl+Shift");
        let (_, coords) = rpc(parse_args(&["click", "--app", "Finder", "--x", "10.5", "--y", "20"]).unwrap());
        assert_eq!(coords["x"], 10.5);
        assert_eq!(coords["y"], 20.0);
        assert!(parse_args(&["click", "--app", "Finder"]).is_err());
        assert!(parse_args(&["click", "--app", "Finder", "--x", "1"]).is_err());
        assert!(parse_args(&["click", "--app", "Finder", "--element-index", "1", "--x", "1", "--y", "1"]).is_err());
        assert!(parse_args(&["click", "--app", "Finder", "--element-index", "1", "--modifiers", "Shift+A"]).is_err());
        assert!(parse_args(&["click", "--app", "Finder", "--element-index", "1", "--mouse-button", "back"]).is_err());
        assert!(parse_args(&["click", "--app", "Finder", "--element-index", "1", "--click-count", "0"]).is_err());
        assert!(parse_args(&["click", "--element-index", "1"]).is_err(), "--app is required");
    }

    #[test]
    fn keys_scroll_and_drag_follow_the_key_spec_and_pairing_rules() {
        let (command, params) = rpc(parse_args(&["hotkey", "--app", "a", "--key", "CmdOrCtrl+A"]).unwrap());
        assert_eq!(command, "computer.hotkey");
        assert_eq!(params["key"], "CmdOrCtrl+A");
        assert!(parse_args(&["hotkey", "--app", "a", "--key", "A"]).unwrap_err().message.contains("Hotkey requires"));
        let (command, _) = rpc(parse_args(&["press-key", "--app", "a", "--key", "Return"]).unwrap());
        assert_eq!(command, "computer.pressKey");
        assert!(parse_args(&["press-key", "--app", "a", "--key", "Cmd+A"]).is_err());
        let (_, scroll) = rpc(parse_args(&["scroll", "--app", "a", "--x", "1", "--y", "2", "--direction", "down", "--pages", "0.5"]).unwrap());
        assert_eq!(scroll["direction"], "down");
        assert_eq!(scroll["pages"], 0.5);
        assert!(parse_args(&["scroll", "--app", "a", "--element-index", "1", "--direction", "sideways"]).is_err());
        let (command, drag) = rpc(parse_args(&["drag", "--app", "a", "--from-x", "1", "--from-y", "1", "--to-x", "5", "--to-y", "5"]).unwrap());
        assert_eq!(command, "computer.drag");
        assert_eq!(drag["toY"], 5.0);
        assert!(parse_args(&["drag", "--app", "a", "--from-element-index", "1"]).is_err());
        let (_, secondary) = rpc(parse_args(&["perform-secondary-action", "--app", "a", "--element-index", "3", "--action", "AXShowMenu"]).unwrap());
        assert_eq!(secondary["action"], "AXShowMenu");
        assert!(parse_args(&["perform-secondary-action", "--app", "a", "--action", "AXShowMenu"]).is_err());
    }

    #[test]
    fn text_payloads_come_from_flags_or_stdin_but_not_both() {
        let (command, params) = rpc(parse_args(&["type-text", "--app", "a", "--text", "hello"]).unwrap());
        assert_eq!(command, "computer.typeText");
        assert_eq!(params["text"], "hello");
        let (command, params) = rpc(parse_with_stdin(&["paste-text", "--app", "a", "--text-stdin"], || Ok("secret\n".into())).unwrap());
        assert_eq!(command, "computer.pasteText");
        assert_eq!(params["text"], "secret\n");
        assert!(parse_with_stdin(&["type-text", "--app", "a", "--text-stdin"], || Ok(String::new())).is_err());
        assert!(parse_with_stdin(&["type-text", "--app", "a", "--text", "x", "--text-stdin"], || Ok("y".into())).is_err());
        assert!(parse_args(&["type-text", "--app", "a", "--text", ""]).is_err());
        let (command, params) = rpc(parse_args(&["set-value", "--app", "a", "--element-index", "4", "--value", ""]).unwrap());
        assert_eq!(command, "computer.setValue");
        assert_eq!(params["value"], "");
        assert_eq!(params["elementIndex"], 4);
        let (_, params) = rpc(parse_with_stdin(&["set-value", "--app", "a", "--element-index", "4", "--value-stdin"], || Ok(String::new())).unwrap());
        assert_eq!(params["value"], "");
        assert!(parse_args(&["set-value", "--app", "a", "--value", "x"]).is_err());
    }

    #[test]
    fn permissions_and_listing_commands_parse() {
        let (command, params) = rpc(parse_args(&["permissions", "--id", "screenshots"]).unwrap());
        assert_eq!(command, "computer.permissions");
        assert_eq!(params, json!({"id": "screenshots"}));
        let (_, params) = rpc(parse_args(&["permissions"]).unwrap());
        assert_eq!(params, json!({}));
        assert!(parse_args(&["permissions", "--id", "camera"]).is_err());
        assert_eq!(rpc(parse_args(&["capabilities"]).unwrap()).0, "computer.capabilities");
        assert_eq!(rpc(parse_args(&["list-apps"]).unwrap()).0, "computer.listApps");
        let (command, params) = rpc(parse_args(&["list-windows", "--app", "pid:42"]).unwrap());
        assert_eq!(command, "computer.listWindows");
        assert_eq!(params["app"], "pid:42");
        let unknown = parse_args(&["list-apps", "--invented"]).unwrap_err();
        assert_eq!(unknown.code, "invalid_argument");
        assert!(parse_args(&["open"]).unwrap_err().message.contains("Unknown computer command"));
    }

    fn sample_action() -> Value {
        json!({
            "snapshot": {
                "id": "s1",
                "app": {"name": "Finder", "bundleId": "com.apple.finder", "pid": 12},
                "window": {"id": 77, "index": 0, "title": "Desktop", "x": 10, "y": 20, "width": 800, "height": 600},
                "coordinateSpace": "window",
                "treeText": "0 window Desktop\n  1 button Close",
                "elementCount": 2,
                "focusedElementId": 1
            },
            "screenshot": {"format": "png", "width": 1280, "height": 700, "scale": 0.667, "path": "/tmp/x-screenshot.png"},
            "screenshotStatus": {"state": "captured", "metadata": {"engine": "screenCaptureKit"}},
            "action": {"path": "accessibility", "verification": {"state": "verified", "property": "value"}}
        })
    }

    #[test]
    fn get_app_state_output_leads_with_the_window_and_ends_with_the_tree() {
        let text = format_get_app_state(&sample_action());
        assert!(text.starts_with("Finder (pid 12, com.apple.finder)\n  Window: id:77 index:0 \"Desktop\" (800x600 @ 10,20)\n"));
        assert!(text.contains("Visible elements: 2  Focused: #1  Coordinates: window"));
        assert!(text.contains("Screenshot captured (png, saved to /tmp/x-screenshot.png, 1280x700, scale 0.667; coordinate x/y = screenshot pixels / 0.667, screenCaptureKit)"));
        assert!(text.ends_with("0 window Desktop\n  1 button Close"));
    }

    #[test]
    fn action_output_reports_verification_and_a_pasteable_follow_up() {
        let verified = format_action(ActionMethod::SetValue, &sample_action(), &json!({"app": "Finder", "windowId": 77, "restoreWindow": true}));
        assert!(verified.starts_with("Set Value completed via accessibility, verified value; 2 visible elements in current window."));
        assert!(verified.contains("Use `terminalx computer get-app-state --app com.apple.finder --window-id 77 --restore-window` to inspect."));
        assert!(verified.contains("Screenshot saved to /tmp/x-screenshot.png."));

        let mut synthetic = sample_action();
        synthetic["action"] = json!({"path": "synthetic"});
        synthetic["snapshot"]["app"]["bundleId"] = Value::Null;
        synthetic["snapshot"]["app"]["name"] = json!("My App");
        let text = format_action(ActionMethod::TypeText, &synthetic, &json!({"app": "My App"}));
        assert!(text.starts_with("Type Text attempted via synthetic, unverified (synthetic input);"));
        assert!(text.contains("--app 'My App' --window-id 77`"));
        assert!(text.ends_with("before assuming it worked."));

        let mut failed = sample_action();
        failed["screenshotStatus"] = json!({"state": "failed", "code": "screenshot_failed", "message": "Screen Recording denied"});
        failed["screenshot"] = Value::Null;
        failed["action"] = Value::Null;
        let text = format_action(ActionMethod::Click, &failed, &json!({}));
        assert!(text.contains("unverified (verification metadata unavailable)"));
        assert!(text.contains("Screenshot failed (screenshot_failed): Screen Recording denied."));
    }

    #[test]
    fn listing_and_capability_output_match_the_legacy_layout() {
        let apps = format_list_apps(&json!({"apps": [{"name": "Finder", "bundleId": "com.apple.finder", "pid": 1}, {"name": "raccoon", "bundleId": null, "pid": 2}]}));
        assert_eq!(apps, "Finder  pid:1  com.apple.finder\nraccoon  pid:2");
        assert_eq!(format_list_apps(&json!({"apps": []})), "No apps found.");
        let windows = format_list_windows(&json!({"app": {"name": "Finder"}, "windows": [{"index": 0, "id": 5, "title": "Desktop", "x": 0, "y": 0, "width": 10, "height": 20, "screenIndex": 1, "isMinimized": true}]}));
        assert_eq!(windows, "[0] id:5 \"Desktop\" (10x20 @ 0,0) screen:1 minimized");
        let caps = format_capabilities(&json!({"provider": "macos-native", "platform": "macos", "protocolVersion": 1, "supports": {"apps": {"list": true, "bundleIds": true, "pids": true}, "windows": {"list": true, "targetById": true, "targetByIndex": true}, "observation": {"screenshot": true, "elementFrames": true, "annotatedScreenshot": false}, "actions": {"click": true, "drag": false}}}));
        assert!(caps.starts_with("macos-native (macos, protocol 1)\n  Apps: list=true bundleIds=true pids=true"));
        assert!(caps.ends_with("  Actions: click"));
        let permissions = format_permissions(&json!({"platform": "macos", "helperAppPath": "/h.app", "launchedHelper": true, "permissions": [{"id": "accessibility", "status": "granted"}, {"id": "screenshots", "status": "not-granted"}], "nextStep": "Grant Screen Recording"}));
        assert!(permissions.contains("Permissions: accessibility=granted, screenshots=not-granted"));
        assert!(permissions.contains("Next: Grant Screen Recording"));
        assert_eq!(format_permissions(&json!({"platform": "linux"})), "Computer-use permission setup is only required on macOS.");
    }

    #[test]
    fn shell_quoting_only_wraps_what_a_shell_would_split() {
        assert_eq!(shell_quote("com.apple.finder"), "com.apple.finder");
        assert_eq!(shell_quote("pid:42"), "pid:42");
        assert_eq!(shell_quote("Google Chrome"), "'Google Chrome'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(base64_byte_count("aGVsbG8="), 5);
    }
}
