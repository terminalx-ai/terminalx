//! The browser verbs of the `terminalx` CLI: parsing into `browser.*`
//! control calls, and human-readable output for the results agents and
//! readers look at most.

use std::io::Read;
use std::time::Duration;

use serde_json::{Map, Value};

use crate::cli::{invalid, Action, Tokens};
use crate::control::ControlError;

pub const HELP: &str = r#"  Built-in browser (scoped to the caller's workspace; add --page ID, --worktree SELECTOR or --session ID to retarget):
  terminalx tab list [--worktree all] | tab create [--url URL] [--profile ID] | tab show --page ID
  terminalx tab current | tab switch (--page ID | --index N) [--focus] | tab close [--page ID | --index N]
  terminalx tab profile list | create --label TEXT [--id ID] | delete --profile ID | show | set --profile ID | use-default | clone --profile ID
  terminalx goto --url URL | back | forward | reload | snapshot [--interactive] [--compact] [--depth N] [--selector CSS]
  terminalx screenshot [--full] [--annotate] [--format png|jpeg] [--path FILE] | full-screenshot | pdf [--path FILE]
  terminalx click|dblclick|hover|focus|check|uncheck|scrollintoview --element @eN
  terminalx fill --element @eN (--value TEXT | --value-stdin) | type --input TEXT | inserttext --text TEXT
  terminalx select --element @eN --value VALUE | clear --element @eN | select-all --element @eN | keypress --key KEY
  terminalx drag --from @eA --to @eB | upload --element @eN --files A,B | download --selector @eN [--path FILE]
  terminalx get --what text|html|value|attr|title|url|count|box|styles [--element @eN] [--name ATTR]
  terminalx is --what visible|enabled|checked --element @eN | find --locator role|text|label|… --value TEXT --action click|…
  terminalx mouse move --x N --y N | mouse down|up [--button B] | mouse wheel --dy N [--dx N]
  terminalx scroll [--direction up|down|left|right] [--amount PX] [--selector CSS]
  terminalx wait (--text T | --url PATTERN | --selector CSS | --load STATE | --fn JS | --ms N | --download FILE) [--state S] [--timeout MS]
  terminalx eval (--expression JS | --stdin) | exec --command "AGENT-BROWSER COMMAND"
  terminalx cookie get [--url URL] | cookie set --name N (--value V | --value-stdin) [--domain D] [--path P] [--secure] [--httpOnly] [--sameSite S] [--expires TS]
  terminalx cookie delete --name N [--domain D] [--url URL] | cookie delete --all
  terminalx console [--limit N] [--clear] | network [--limit N] [--filter F] [--type T] [--method M] [--status S] [--clear]
  terminalx capture start | capture stop [--path FILE] | intercept enable [--patterns GLOB,…] [--abort | --body JSON] | intercept disable | intercept list
  terminalx viewport --width W --height H [--scale N] | geolocation --latitude LAT --longitude LNG
  terminalx set device --name D | set offline [--state on|off] | set headers --headers JSON | set credentials --user U (--pass P | --pass-stdin) | set media [--color-scheme dark|light] [--reduced-motion reduce|no-preference]
  terminalx clipboard read | clipboard write --text T | dialog accept [--text T] | dialog dismiss | dialog status
  terminalx storage local|session get [--key K] | set --key K --value V | clear
  terminalx browser status"#;

const BROWSER_TIMEOUT: Duration = Duration::from_secs(120);

/// Browser wait is picked over agent wait when a browser condition is given.
pub const WAIT_FLAGS: [&str; 7] = ["--text", "--url", "--selector", "--load", "--fn", "--ms", "--download"];

pub fn is_browser_wait(args: &[String]) -> bool {
    args.iter().any(|a| WAIT_FLAGS.contains(&a.as_str()) || WAIT_FLAGS.iter().any(|f| a.starts_with(&format!("{f}="))))
}

/// Parse a browser verb. `None` when `group` is not a browser verb.
pub(crate) fn parse(group: &str, tokens: &mut Tokens) -> Option<Result<Action, ControlError>> {
    let result = match group {
        "browser" => browser_group(tokens),
        "tab" => tab(tokens),
        "goto" => flags(tokens, "goto", &[("--url", "url", true)], &[]),
        "back" | "forward" | "reload" => flags(tokens, group, &[], &[]),
        "snapshot" => flags(tokens, "snapshot", &[("--depth", "depth", false), ("--selector", "selector", false)], &[("--interactive", "interactive"), ("--compact", "compact")]),
        "screenshot" | "full-screenshot" => flags(tokens, group, &[("--format", "format", false), ("--path", "path", false)], &[("--full", "full"), ("--annotate", "annotate")]),
        "pdf" => flags(tokens, "pdf", &[("--path", "path", false)], &[]),
        "eval" => eval(tokens),
        "scroll" => flags(tokens, "scroll", &[("--direction", "direction", false), ("--amount", "amount", false), ("--selector", "selector", false)], &[]),
        "wait" => flags(
            tokens,
            "wait",
            &[("--selector", "selector", false), ("--text", "text", false), ("--url", "url", false), ("--load", "load", false), ("--fn", "fn", false), ("--ms", "ms", false), ("--download", "download", false), ("--state", "state", false), ("--timeout", "timeout", false)],
            &[],
        ),
        "click" | "dblclick" | "hover" | "focus" | "check" | "uncheck" | "scrollintoview" => flags(tokens, group, &[("--element", "element", true)], &[]),
        "highlight" => highlight(tokens),
        "fill" => with_stdin_value(tokens, "fill", &[("--element", "element", true)], "--value", "value"),
        "type" => flags(tokens, "type", &[("--input", "input", false), ("--element", "element", false), ("--text", "text", false)], &[]),
        "inserttext" => flags(tokens, "inserttext", &[("--text", "text", true)], &[]),
        "select" => flags(tokens, "select", &[("--element", "element", true), ("--value", "value", true)], &[]),
        "clear" | "select-all" => flags(tokens, group, &[("--element", "element", true)], &[]),
        "keypress" => flags(tokens, "keypress", &[("--key", "key", true)], &[]),
        "drag" => flags(tokens, "drag", &[("--from", "from", true), ("--to", "to", true)], &[]),
        "upload" => flags(tokens, "upload", &[("--element", "element", true), ("--files", "files", true)], &[]),
        "download" => flags(tokens, "download", &[("--selector", "selector", false), ("--element", "element", false), ("--path", "path", false)], &[]),
        "get" => flags(tokens, "get", &[("--what", "what", true), ("--element", "element", false), ("--name", "name", false)], &[]),
        "is" => flags(tokens, "is", &[("--what", "what", true), ("--element", "element", true)], &[]),
        "find" => flags(tokens, "find", &[("--locator", "locator", true), ("--value", "value", true), ("--action", "action", true), ("--text", "text", false)], &[]),
        "mouse" => mouse(tokens),
        "exec" => flags(tokens, "exec", &[("--command", "command", true)], &[]),
        "cookie" => cookie(tokens),
        "console" => flags(tokens, "console", &[("--limit", "limit", false)], &[("--clear", "clear")]),
        "network" => flags(tokens, "network", &[("--limit", "limit", false), ("--filter", "filter", false), ("--type", "type", false), ("--method", "method", false), ("--status", "status", false)], &[("--clear", "clear")]),
        "capture" => capture(tokens),
        "intercept" => intercept(tokens),
        "viewport" => flags(tokens, "viewport", &[("--width", "width", true), ("--height", "height", true), ("--scale", "scale", false)], &[]),
        "geolocation" => flags(tokens, "geolocation", &[("--latitude", "latitude", true), ("--longitude", "longitude", true), ("--accuracy", "accuracy", false)], &[]),
        "set" => set(tokens),
        "clipboard" => clipboard(tokens),
        "dialog" => dialog(tokens),
        "storage" => storage(tokens),
        _ => return None,
    };
    Some(result)
}

/// Where the caller is, so unqualified commands land on its workspace.
fn caller_context() -> Map<String, Value> {
    let mut map = Map::new();
    if let Ok(session) = std::env::var("RACCOON_SESSION_ID") {
        if !session.trim().is_empty() {
            map.insert("callerSession".into(), Value::String(session));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        map.insert("callerCwd".into(), Value::String(cwd.to_string_lossy().into_owned()));
    }
    map
}

fn target_flags(tokens: &mut Tokens) -> Result<Map<String, Value>, ControlError> {
    let mut map = caller_context();
    for (flag, key) in [("--session", "session"), ("--worktree", "worktree"), ("--page", "page")] {
        if let Some(value) = tokens.option(flag)? {
            map.insert(key.into(), Value::String(value));
        }
    }
    Ok(map)
}

fn finish(command: &str, mut params: Map<String, Value>, tokens: &mut Tokens, timeout: Duration) -> Result<Action, ControlError> {
    let target = target_flags(tokens)?;
    params.extend(target);
    tokens.finish()?;
    Ok(Action::Rpc { command: format!("browser.{command}"), params: Value::Object(params), timeout })
}

/// `(flag, param key, required)` options plus boolean switches.
fn flags(tokens: &mut Tokens, command: &str, options: &[(&str, &str, bool)], switches: &[(&str, &str)]) -> Result<Action, ControlError> {
    let mut params = Map::new();
    for (flag, key, required) in options {
        match tokens.option(flag)? {
            Some(value) => {
                params.insert((*key).into(), Value::String(value));
            }
            None if *required => return Err(invalid(format!("Missing {flag}."))),
            None => {}
        }
    }
    for (flag, key) in switches {
        if tokens.flag(flag)? {
            params.insert((*key).into(), Value::Bool(true));
        }
    }
    let timeout = if command == "wait" {
        params.get("timeout").and_then(Value::as_str).and_then(|t| t.parse::<u64>().ok()).map(|ms| Duration::from_millis(ms) + Duration::from_secs(15)).unwrap_or(BROWSER_TIMEOUT).max(BROWSER_TIMEOUT)
    } else {
        BROWSER_TIMEOUT
    };
    finish(command, params, tokens, timeout)
}

fn read_stdin() -> Result<String, ControlError> {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).map_err(|e| invalid(format!("Could not read stdin: {e}")))?;
    Ok(text)
}

/// An option that may instead arrive on stdin (`--value-stdin`), keeping
/// secrets and large text out of argv and shell history.
fn with_stdin_value(tokens: &mut Tokens, command: &str, options: &[(&str, &str, bool)], flag: &str, key: &str) -> Result<Action, ControlError> {
    let mut params = Map::new();
    for (opt, k, required) in options {
        match tokens.option(opt)? {
            Some(value) => {
                params.insert((*k).into(), Value::String(value));
            }
            None if *required => return Err(invalid(format!("Missing {opt}."))),
            None => {}
        }
    }
    let inline = tokens.option(flag)?;
    let from_stdin = tokens.flag(&format!("{flag}-stdin"))?;
    let value = match (inline, from_stdin) {
        (Some(_), true) => return Err(invalid(format!("{flag} and {flag}-stdin are mutually exclusive."))),
        (Some(v), false) => v,
        (None, true) => read_stdin()?,
        (None, false) => return Err(invalid(format!("Missing {flag} (or {flag}-stdin)."))),
    };
    params.insert(key.into(), Value::String(value));
    finish(command, params, tokens, BROWSER_TIMEOUT)
}

fn eval(tokens: &mut Tokens) -> Result<Action, ControlError> {
    let inline = tokens.option("--expression")?;
    let from_stdin = tokens.flag("--stdin")? || tokens.flag("--expression-stdin")?;
    let expression = match (inline, from_stdin) {
        (Some(_), true) => return Err(invalid("--expression and --stdin are mutually exclusive.")),
        (Some(v), false) => v,
        (None, true) => read_stdin()?,
        (None, false) => return Err(invalid("Missing --expression (or --stdin).")),
    };
    let mut params = Map::new();
    params.insert("expression".into(), Value::String(expression));
    finish("eval", params, tokens, BROWSER_TIMEOUT)
}

fn highlight(tokens: &mut Tokens) -> Result<Action, ControlError> {
    let selector = tokens.option("--selector")?.or(tokens.option("--element")?).ok_or_else(|| invalid("Missing --selector."))?;
    let mut params = Map::new();
    params.insert("element".into(), Value::String(selector));
    finish("highlight", params, tokens, BROWSER_TIMEOUT)
}

fn browser_group(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("browser command")?.as_str() {
        "status" => finish("status", Map::new(), tokens, Duration::from_secs(30)),
        other => Err(invalid(format!("Unknown browser command {other}."))),
    }
}

fn tab(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("tab command")?.as_str() {
        "list" => flags(tokens, "tab.list", &[], &[]),
        "show" => flags(tokens, "tab.show", &[], &[]),
        "current" => flags(tokens, "tab.current", &[], &[]),
        "switch" => {
            let mut params = index_param(tokens)?;
            if tokens.flag("--focus")? {
                params.insert("focus".into(), Value::Bool(true));
            }
            finish("tab.switch", params, tokens, BROWSER_TIMEOUT)
        }
        "create" => flags(tokens, "tab.create", &[("--url", "url", false), ("--profile", "profile", false)], &[]),
        "close" => {
            let params = index_param(tokens)?;
            finish("tab.close", params, tokens, BROWSER_TIMEOUT)
        }
        "profile" => profile(tokens),
        other => Err(invalid(format!("Unknown tab command {other}."))),
    }
}

fn index_param(tokens: &mut Tokens) -> Result<Map<String, Value>, ControlError> {
    let mut params = Map::new();
    if let Some(index) = tokens.option_u64("--index")? {
        params.insert("index".into(), Value::from(index));
    }
    Ok(params)
}

fn profile(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("tab profile command")?.as_str() {
        "list" => finish("tab.profile.list", Map::new(), tokens, Duration::from_secs(30)),
        "create" => flags(tokens, "tab.profile.create", &[("--label", "label", true), ("--id", "id", false)], &[]),
        "delete" => flags(tokens, "tab.profile.delete", &[("--profile", "profile", true)], &[]),
        "show" => flags(tokens, "tab.profile.show", &[], &[]),
        "set" => flags(tokens, "tab.profile.set", &[("--profile", "profile", true)], &[]),
        "use-default" => flags(tokens, "tab.profile.use-default", &[], &[]),
        "clone" => flags(tokens, "tab.profile.clone", &[("--profile", "profile", true)], &[]),
        other => Err(invalid(format!("Unknown tab profile command {other}."))),
    }
}

fn mouse(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("mouse action")?.as_str() {
        "move" => flags(tokens, "mouse.move", &[("--x", "x", true), ("--y", "y", true)], &[]),
        "down" => flags(tokens, "mouse.down", &[("--button", "button", false)], &[]),
        "up" => flags(tokens, "mouse.up", &[("--button", "button", false)], &[]),
        "wheel" => flags(tokens, "mouse.wheel", &[("--dy", "dy", true), ("--dx", "dx", false)], &[]),
        other => Err(invalid(format!("Unknown mouse action {other}."))),
    }
}

fn cookie(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("cookie command")?.as_str() {
        "get" => flags(tokens, "cookie.get", &[("--url", "url", false)], &[]),
        "set" => with_stdin_value(
            tokens,
            "cookie.set",
            &[("--name", "name", true), ("--url", "url", false), ("--domain", "domain", false), ("--path", "path", false), ("--sameSite", "sameSite", false), ("--expires", "expires", false)],
            "--value",
            "value",
        )
        .and_then(|action| add_switches(action, tokens, &[("--secure", "secure"), ("--httpOnly", "httpOnly")])),
        "delete" => {
            let all = tokens.flag("--all")?;
            let mut params = Map::new();
            if all {
                params.insert("all".into(), Value::Bool(true));
                params.insert("name".into(), Value::String("*".into()));
            } else {
                params.insert("name".into(), Value::String(tokens.required_option("--name")?));
            }
            for (flag, key) in [("--domain", "domain"), ("--url", "url")] {
                if let Some(v) = tokens.option(flag)? {
                    params.insert(key.into(), Value::String(v));
                }
            }
            finish("cookie.delete", params, tokens, BROWSER_TIMEOUT)
        }
        other => Err(invalid(format!("Unknown cookie command {other}."))),
    }
}

/// Switches parsed after `finish` already ran (the value came from stdin
/// handling); they are folded into the built action.
fn add_switches(action: Action, tokens: &mut Tokens, switches: &[(&str, &str)]) -> Result<Action, ControlError> {
    let Action::Rpc { command, params, timeout } = action else { return Ok(action) };
    let mut params = params;
    for (flag, key) in switches {
        if tokens.flag(flag)? {
            params[*key] = Value::Bool(true);
        }
    }
    tokens.finish()?;
    Ok(Action::Rpc { command, params, timeout })
}

fn capture(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("capture command")?.as_str() {
        "start" => flags(tokens, "capture.start", &[], &[]),
        "stop" => flags(tokens, "capture.stop", &[("--path", "path", false)], &[]),
        other => Err(invalid(format!("Unknown capture command {other}."))),
    }
}

fn intercept(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("intercept command")?.as_str() {
        "enable" => flags(tokens, "intercept.enable", &[("--patterns", "patterns", false), ("--body", "body", false)], &[("--abort", "abort")]),
        "disable" => flags(tokens, "intercept.disable", &[], &[]),
        "list" => flags(tokens, "intercept.list", &[], &[]),
        other => Err(invalid(format!("Unknown intercept command {other}."))),
    }
}

fn set(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("set command")?.as_str() {
        "device" => flags(tokens, "set.device", &[("--name", "name", true)], &[]),
        "offline" => flags(tokens, "set.offline", &[("--state", "state", false)], &[]),
        "headers" => flags(tokens, "set.headers", &[("--headers", "headers", true)], &[]),
        "credentials" => with_stdin_value(tokens, "set.credentials", &[("--user", "user", true)], "--pass", "pass"),
        "media" => flags(tokens, "set.media", &[("--color-scheme", "colorScheme", false), ("--reduced-motion", "reducedMotion", false)], &[]),
        other => Err(invalid(format!("Unknown set command {other}."))),
    }
}

fn clipboard(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("clipboard command")?.as_str() {
        "read" => flags(tokens, "clipboard.read", &[], &[]),
        "write" => flags(tokens, "clipboard.write", &[("--text", "text", true)], &[]),
        other => Err(invalid(format!("Unknown clipboard command {other}."))),
    }
}

fn dialog(tokens: &mut Tokens) -> Result<Action, ControlError> {
    match tokens.required_front("dialog command")?.as_str() {
        "accept" => flags(tokens, "dialog.accept", &[("--text", "text", false)], &[]),
        "dismiss" => flags(tokens, "dialog.dismiss", &[], &[]),
        "status" => flags(tokens, "dialog.status", &[], &[]),
        other => Err(invalid(format!("Unknown dialog command {other}."))),
    }
}

fn storage(tokens: &mut Tokens) -> Result<Action, ControlError> {
    let kind = tokens.required_front("storage kind")?;
    if !matches!(kind.as_str(), "local" | "session") {
        return Err(invalid(format!("Unknown storage kind {kind}; use local or session.")));
    }
    match tokens.required_front("storage command")?.as_str() {
        "get" => flags(tokens, &format!("storage.{kind}.get"), &[("--key", "key", false)], &[]),
        "set" => flags(tokens, &format!("storage.{kind}.set"), &[("--key", "key", true), ("--value", "value", true)], &[]),
        "clear" => flags(tokens, &format!("storage.{kind}.clear"), &[], &[]),
        other => Err(invalid(format!("Unknown storage command {other}."))),
    }
}

// ------------------------------------------------------------------ output

/// Human-readable output for a browser result; `None` falls back to JSON.
pub fn format(command: &str, result: &Value) -> Option<String> {
    let verb = command.strip_prefix("browser.")?;
    let text = match verb {
        "snapshot" => {
            let title = result.get("title").and_then(Value::as_str).unwrap_or("");
            let url = result.get("url").and_then(Value::as_str).unwrap_or("");
            let snapshot = result.get("snapshot").and_then(Value::as_str).unwrap_or("");
            format!("page: {}\n{title} — {url}\n{snapshot}", result.get("browserPageId").and_then(Value::as_str).unwrap_or("?"))
        }
        "tab.list" => {
            let tabs = result.get("tabs").and_then(Value::as_array).cloned().unwrap_or_default();
            if tabs.is_empty() {
                "No browser tabs open.".into()
            } else {
                tabs.iter().map(tab_line).collect::<Vec<_>>().join("\n")
            }
        }
        "tab.create" => format!("Opened {}: {}", result.get("browserPageId").and_then(Value::as_str).unwrap_or("?"), result.get("url").and_then(Value::as_str).unwrap_or("")),
        "tab.show" | "tab.current" => {
            let tab = result.get("tab").cloned().unwrap_or(Value::Null);
            [
                format!("page: {}", tab.get("browserPageId").and_then(Value::as_str).unwrap_or("?")),
                format!("title: {}", tab.get("title").and_then(Value::as_str).unwrap_or("")),
                format!("url: {}", tab.get("url").and_then(Value::as_str).unwrap_or("")),
                format!("active: {}", tab.get("active").and_then(Value::as_bool).unwrap_or(false)),
                format!("workspace: {}", tab.get("workspacePath").and_then(Value::as_str).unwrap_or("unknown")),
                format!("profile: {}", tab.get("profileId").and_then(Value::as_str).unwrap_or("default")),
            ]
            .join("\n")
        }
        "tab.close" => format!("Closed {}{}", result.get("closed").and_then(Value::as_str).unwrap_or("?"), if result.get("closedBrowser").and_then(Value::as_bool).unwrap_or(false) { " (and its browser window)" } else { "" }),
        "screenshot" | "full-screenshot" => format!(
            "Screenshot saved to {} ({} bytes, {})",
            result.get("path").and_then(Value::as_str).unwrap_or("?"),
            result.get("bytes").and_then(Value::as_u64).unwrap_or(0),
            result.get("format").and_then(Value::as_str).unwrap_or("png")
        ),
        "pdf" => format!("PDF saved to {} ({} bytes)", result.get("path").and_then(Value::as_str).unwrap_or("?"), result.get("bytes").and_then(Value::as_u64).unwrap_or(0)),
        "goto" | "back" | "forward" | "reload" => format!("{} — {}", result.get("title").and_then(Value::as_str).unwrap_or(""), result.get("url").and_then(Value::as_str).unwrap_or("")),
        "tab.profile.list" => {
            let profiles = result.get("profiles").and_then(Value::as_array).cloned().unwrap_or_default();
            profiles
                .iter()
                .map(|p| {
                    format!(
                        "{}{}  {}  pages:{}",
                        if p.get("default").and_then(Value::as_bool).unwrap_or(false) { "* " } else { "  " },
                        p.get("id").and_then(Value::as_str).unwrap_or("?"),
                        p.get("label").and_then(Value::as_str).unwrap_or(""),
                        p.get("openPages").and_then(Value::as_u64).unwrap_or(0)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        "console" => {
            let messages = result.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
            if messages.is_empty() {
                "No console messages.".into()
            } else {
                messages.iter().map(|m| format!("[{}] {}", m.get("type").and_then(Value::as_str).unwrap_or("log"), m.get("text").and_then(Value::as_str).unwrap_or(""))).collect::<Vec<_>>().join("\n")
            }
        }
        "network" => {
            let requests = result.get("requests").and_then(Value::as_array).cloned().unwrap_or_default();
            if requests.is_empty() {
                "No requests captured.".into()
            } else {
                requests
                    .iter()
                    .map(|r| format!("{} {} {}", r.get("status").and_then(Value::as_u64).map(|s| s.to_string()).unwrap_or_else(|| "-".into()), r.get("method").and_then(Value::as_str).unwrap_or("GET"), r.get("url").and_then(Value::as_str).unwrap_or("")))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        }
        _ => return None,
    };
    Some(text)
}

fn tab_line(tab: &Value) -> String {
    format!(
        "{}[{}] {}  {} — {}  [{}]",
        if tab.get("active").and_then(Value::as_bool).unwrap_or(false) { "* " } else { "  " },
        tab.get("index").and_then(Value::as_u64).unwrap_or(0),
        tab.get("browserPageId").and_then(Value::as_str).unwrap_or("?"),
        tab.get("title").and_then(Value::as_str).unwrap_or(""),
        tab.get("url").and_then(Value::as_str).unwrap_or(""),
        tab.get("profileId").and_then(Value::as_str).unwrap_or("default"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| v.to_string()).collect()
    }

    fn rpc(values: &[&str]) -> (String, Value) {
        let mut tokens = Tokens::new(&args(values));
        let group = tokens.take_front().unwrap();
        match parse(&group, &mut tokens).expect("browser verb").expect("parses") {
            Action::Rpc { command, params, .. } => (command, params),
            other => panic!("expected rpc, got {other:?}"),
        }
    }

    #[test]
    fn browser_verbs_map_to_control_commands_with_caller_context() {
        let (command, params) = rpc(&["click", "--element", "@e3", "--page", "bp-1"]);
        assert_eq!(command, "browser.click");
        assert_eq!(params["element"], "@e3");
        assert_eq!(params["page"], "bp-1");
        assert!(params.get("callerCwd").is_some());

        let (command, params) = rpc(&["tab", "create", "--url", "https://example.com", "--worktree", "feature"]);
        assert_eq!(command, "browser.tab.create");
        assert_eq!(params["url"], "https://example.com");
        assert_eq!(params["worktree"], "feature");

        let (command, params) = rpc(&["snapshot", "--interactive", "--depth", "3"]);
        assert_eq!(command, "browser.snapshot");
        assert_eq!(params["interactive"], true);
        assert_eq!(params["depth"], "3");

        let (command, params) = rpc(&["storage", "local", "set", "--key", "k", "--value", "v"]);
        assert_eq!(command, "browser.storage.local.set");
        assert_eq!(params["key"], "k");

        let (command, params) = rpc(&["tab", "switch", "--index", "1", "--focus"]);
        assert_eq!(command, "browser.tab.switch");
        assert_eq!(params["index"], 1);
        assert_eq!(params["focus"], true);

        let (command, params) = rpc(&["cookie", "delete", "--all"]);
        assert_eq!(command, "browser.cookie.delete");
        assert_eq!(params["all"], true);
    }

    #[test]
    fn required_flags_and_unknown_arguments_are_refused() {
        let mut tokens = Tokens::new(&args(&["--url"]));
        let err = parse("goto", &mut tokens).unwrap().unwrap_err();
        assert_eq!(err.code, "invalid_arguments");
        let mut tokens = Tokens::new(&args(&["--element", "@e1", "--bogus"]));
        let err = parse("click", &mut tokens).unwrap().unwrap_err();
        assert!(err.message.contains("Unexpected argument"));
        let mut tokens = Tokens::new(&args(&[]));
        assert!(parse("status", &mut tokens).is_none());
    }

    #[test]
    fn wait_is_browser_wait_only_with_a_browser_condition() {
        assert!(is_browser_wait(&args(&["--text", "Welcome"])));
        assert!(is_browser_wait(&args(&["--load", "networkidle", "--json"])));
        assert!(!is_browser_wait(&args(&["tab-123", "--timeout", "30"])));
        let (command, params) = rpc(&["wait", "--url", "**/done", "--timeout", "5000"]);
        assert_eq!(command, "browser.wait");
        assert_eq!(params["timeout"], "5000");
    }

    #[test]
    fn readable_output_covers_snapshot_and_tab_list() {
        let snapshot = json!({"browserPageId": "bp-1", "title": "Smoke", "url": "https://x", "snapshot": "- heading \"Hi\" [ref=e1]"});
        let text = format("browser.snapshot", &snapshot).unwrap();
        assert!(text.starts_with("page: bp-1\nSmoke — https://x\n- heading"));
        let list = json!({"tabs": [{"active": true, "index": 0, "browserPageId": "bp-1", "title": "Smoke", "url": "https://x", "profileId": "default"}]});
        assert_eq!(format("browser.tab.list", &list).unwrap(), "* [0] bp-1  Smoke — https://x  [default]");
        assert_eq!(format("browser.tab.list", &json!({"tabs": []})).unwrap(), "No browser tabs open.");
        assert!(format("browser.click", &json!({"clicked": "@e1"})).is_none());
        assert!(format("status", &json!({})).is_none());
    }
}
