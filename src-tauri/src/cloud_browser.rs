//! Cloud browser for agents (PRO-209): an agent in a cloud tab opens pages,
//! clicks and types in Chrome on its workspace's cloud desktop, and everyone
//! watching the Desktop tab sees it happen.
//!
//! - The workspace switch reaches the runtime as the readiness flag
//!   `cloud.desktop.agent-browser.v1` (`cloud_bootstrap`). Off, or an image
//!   without the desktop packages, and the tool is not offered: the agent's
//!   launch carries no `cloud_browser` MCP server and its prompt says nothing.
//! - The MCP server is this binary (`cloud-browser-stdio`), a thin proxy: each
//!   tool call goes to the tab's TerminalX as a `CloudBrowser` hook frame, so
//!   the tab's launch token authenticates it and the tab's mode applies.
//! - Approval follows the tab's mode. A tab that asks first shows one card
//!   when a browser session opens, never per click; a tab that runs without
//!   asking does not ask.
//! - The runtime drives Chrome over its loopback DevTools port and tells
//!   desktop viewers, in `desktop.agent`, who drives and what it does. A viewer
//!   with control may take it; the agent then waits until it is handed back.

// The driving half runs only in a Linux cloud runtime.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// The MCP server's name: tools are `mcp__cloud_browser__<tool>`.
pub(crate) const SERVER: &str = "cloud_browser";
/// The tool that opens a browser session, and so the one that may ask.
pub(crate) const OPEN_TOOL: &str = "mcp__cloud_browser__open";
pub(crate) const SUBCOMMAND: &str = "cloud-browser-stdio";
pub(crate) const HOOK_EVENT: &str = "CloudBrowser";
/// An approval card, then up to `HELD_WAIT` behind a person's control.
pub(crate) const HOOK_WAIT: Duration = Duration::from_secs(45 * 60);
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const HELD_WAIT: Duration = Duration::from_secs(30 * 60);

/// The hook's environment, which Codex passes to an MCP server only by name.
const HOOK_ENV: [&str; 4] = ["RACCOON_TAB_ID", "RACCOON_SESSION_ID", crate::hooks::SOCKET_ENV, crate::hooks::TOKEN_ENV];

/// The workspace switch, from the bound runtime's readiness.
static SWITCH: AtomicBool = AtomicBool::new(false);
/// The cloud desktop's own readiness, generation-checked by the relay server.
static DESKTOP: AtomicBool = AtomicBool::new(false);

/// The bound runtime's readiness: literal true from a version 1 map only.
pub(crate) fn read_readiness(readiness: Option<&Value>) -> bool {
    readiness.is_some_and(|readiness| {
        readiness.get("version").and_then(Value::as_u64) == Some(1)
            && readiness.pointer("/flags/cloud.desktop.agent-browser.v1").and_then(Value::as_bool) == Some(true)
    })
}

fn ready() -> bool {
    SWITCH.load(Ordering::SeqCst) && DESKTOP.load(Ordering::SeqCst)
}

fn set(flag: &AtomicBool, value: bool) {
    let was = ready();
    flag.store(value, Ordering::SeqCst);
    if was != ready() {
        #[cfg(target_os = "linux")]
        if was {
            engine::withdraw();
        }
        changed();
    }
}

/// Replaced on every bootstrap redeem and refresh; off on a failed identity.
pub(crate) fn set_switch(on: bool) {
    set(&SWITCH, on);
}

/// Follows `cloud.desktop.v1`: no desktop, no browser on it.
#[cfg_attr(not(any(target_os = "linux", all(test, unix))), allow(dead_code))]
pub(crate) fn set_desktop(ready: bool) {
    set(&DESKTOP, ready);
}

/// What the runtime says of the tool: off, on, or on without the packages.
pub(crate) fn offer() -> &'static str {
    if !ready() {
        return "off";
    }
    #[cfg(target_os = "linux")]
    if !crate::remote::cloud_desktop::shared_pool().is_some_and(|pool| pool.tools_present()) {
        return "packages-missing";
    }
    #[cfg(not(target_os = "linux"))]
    return "off";
    #[cfg(target_os = "linux")]
    "on"
}

/// The tool, only while it is offered: `--mcp-config` or `-c mcp_servers`.
pub(crate) fn launch_args(harness: &str, exe: &str) -> String {
    if offer() != "on" {
        return String::new();
    }
    match harness {
        "claude" => {
            let config = json!({ "mcpServers": { SERVER: { "command": exe, "args": [SUBCOMMAND] } } });
            format!(" --mcp-config {}", crate::container_vm::shell_quote(&config.to_string()))
        }
        "codex" => {
            let mut table = toml::map::Map::new();
            table.insert("command".into(), toml::Value::String(exe.into()));
            table.insert("args".into(), toml::Value::Array(vec![toml::Value::String(SUBCOMMAND.into())]));
            table.insert("env_vars".into(), toml::Value::Array(HOOK_ENV.iter().map(|name| toml::Value::String((*name).into())).collect()));
            let inline = toml::Value::Table(table).to_string();
            format!(" -c {}", crate::container_vm::shell_quote(&format!("mcp_servers.{SERVER}={}", inline.trim())))
        }
        _ => String::new(),
    }
}

/// A tool of this server, which decides its own approval: the CLI's gates let it through.
pub(crate) fn is_tool(name: &str) -> bool {
    name.strip_prefix("mcp__cloud_browser__").is_some_and(|tool| TOOLS.iter().any(|(known, ..)| *known == tool))
}

/// Whether a tab's mode runs tools without asking. Every other mode asks.
pub(crate) fn runs_without_asking(mode: &str) -> bool {
    matches!(mode, "bypassPermissions" | "bypass" | "")
}

const TOOLS: [(&str, &str, fn() -> Value); 8] = [
    ("open", "Open a browser session in Chrome on this workspace's cloud desktop and go to a URL. Call this first; the session lasts until close. People watching the workspace's Desktop tab see every step.", || json!({
        "type": "object", "required": ["url"], "additionalProperties": false,
        "properties": {
            "url": { "type": "string", "description": "Where to start, such as http://localhost:3000." },
            "plan": { "type": "string", "description": "One line on what you will do in this session, shown on the approval card." }
        }
    })),
    ("navigate", "Go to a URL in the open browser session.", || json!({
        "type": "object", "required": ["url"], "additionalProperties": false,
        "properties": { "url": { "type": "string" } }
    })),
    ("click", "Click an element: by its visible text, by a CSS selector, or at page coordinates.", || json!({
        "type": "object", "additionalProperties": false,
        "properties": {
            "text": { "type": "string", "description": "Visible text of a button, link or field label." },
            "selector": { "type": "string" },
            "x": { "type": "number" }, "y": { "type": "number" }
        }
    })),
    ("type", "Type text into the focused field, or into the field a CSS selector names.", || json!({
        "type": "object", "required": ["text"], "additionalProperties": false,
        "properties": { "text": { "type": "string" }, "selector": { "type": "string" } }
    })),
    ("press", "Press one key: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft or ArrowRight.", || json!({
        "type": "object", "required": ["key"], "additionalProperties": false,
        "properties": { "key": { "type": "string" } }
    })),
    ("read", "Read the page: its title, URL and visible text.", || json!({ "type": "object", "additionalProperties": false, "properties": {} })),
    ("screenshot", "Take a screenshot of the page.", || json!({ "type": "object", "additionalProperties": false, "properties": {} })),
    ("close", "Close the browser session. A new session asks again in tabs that ask first.", || json!({ "type": "object", "additionalProperties": false, "properties": {} })),
];

fn tools_list() -> Value {
    Value::Array(TOOLS.iter().map(|(name, description, schema)| json!({ "name": name, "description": description, "inputSchema": schema() })).collect())
}

fn text_result(text: impl Into<String>, error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }], "isError": error })
}

/// One JSON-RPC message to the stdio MCP server's answer, or none for a notification.
fn answer(message: &Value, call: &dyn Fn(&str, Value) -> Value) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message["method"].as_str().unwrap_or_default();
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": message["params"]["protocolVersion"].as_str().unwrap_or("2025-06-18"),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": SERVER, "version": env!("CARGO_PKG_VERSION") }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools_list() })),
        "tools/call" => {
            let name = message["params"]["name"].as_str().unwrap_or_default();
            if TOOLS.iter().any(|(known, ..)| *known == name) {
                Ok(call(name, message["params"]["arguments"].clone()))
            } else {
                Err((-32602, format!("Unknown tool: {name}")))
            }
        }
        _ if id.is_none() => return None,
        _ => Err((-32601, format!("Method not found: {method}"))),
    };
    let id = id?;
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
    })
}

/// The `cloud-browser-stdio` subcommand: the MCP server an agent's CLI starts.
pub fn run_stdio_cli() -> Option<i32> {
    if std::env::args().nth(1).as_deref() != Some(SUBCOMMAND) {
        return None;
    }
    use std::io::{BufRead, Write};
    let call = |tool: &str, arguments: Value| {
        crate::hooks::ask_app_event(HOOK_EVENT, &json!({ "tool": tool, "arguments": arguments }))
            .filter(|result| result.get("content").is_some())
            .unwrap_or_else(|| text_result("TerminalX did not answer for this tab. The cloud browser is unavailable here.", true))
    };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(message) => answer(&message, &call),
            Err(_) => Some(json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -32700, "message": "Parse error" } })),
        };
        if let Some(reply) = reply {
            if writeln!(stdout, "{reply}").and_then(|()| stdout.flush()).is_err() {
                break;
            }
        }
    }
    Some(0)
}

/// Who asks, for the tab's `CloudBrowser` hook frame.
pub(crate) struct Caller<'a> {
    /// The tab's session and tab ids: one browser session per tab at a time.
    pub key: String,
    pub agent: &'a str,
    pub tab_title: Option<String>,
    /// The tab asks first: `approve` is asked once when a session opens.
    pub asks: bool,
}

/// A `CloudBrowser` frame's MCP tool result. `approve` shows the card.
pub(crate) fn call(caller: Caller<'_>, payload: &Value, approve: &dyn Fn(Value) -> bool) -> Value {
    let tool = payload["tool"].as_str().unwrap_or_default();
    if !TOOLS.iter().any(|(known, ..)| *known == tool) {
        return text_result(format!("Unknown tool: {tool}"), true);
    }
    match offer() {
        "on" => {}
        "packages-missing" => return text_result("The cloud browser is not offered here: this workspace's environment has no Linux desktop and Chrome.", true),
        _ => return text_result("The cloud browser is off for this workspace. The workspace owner or an admin can turn on Cloud browser for agents in the workspace details.", true),
    }
    #[cfg(target_os = "linux")]
    return engine::call(caller, tool, &payload["arguments"], approve);
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (caller, approve);
        text_result("The cloud browser runs only in a Linux cloud workspace.", true)
    }
}

/// `desktop.agent`'s params as the runtime stands now.
pub(crate) fn desktop_agent_state() -> Value {
    #[cfg(target_os = "linux")]
    return engine::state();
    #[cfg(not(target_os = "linux"))]
    json!({ "browser": offer(), "driving": null })
}

/// The runtime's Tokio runtime, which drives Chrome.
#[cfg(target_os = "linux")]
pub(crate) fn install_runtime(handle: tokio::runtime::Handle) {
    engine::install(handle);
}

/// A viewer with control takes it (the agent waits) or hands it back.
pub(crate) fn set_held(held: bool) {
    #[cfg(target_os = "linux")]
    engine::set_held(held);
    #[cfg(not(target_os = "linux"))]
    let _ = held;
}

/// Called with `desktop.agent`'s params whenever they change.
pub(crate) fn subscribe() -> tokio::sync::watch::Receiver<u64> {
    CHANGES.subscribe()
}

static CHANGES: std::sync::LazyLock<tokio::sync::watch::Sender<u64>> = std::sync::LazyLock::new(|| tokio::sync::watch::channel(0).0);

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn changed() {
    CHANGES.send_modify(|count| *count = count.wrapping_add(1));
}

/// What the Desktop tab says the agent is doing.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn describe(tool: &str, arguments: &Value) -> String {
    let quoted = |text: &str| {
        let text: String = text.trim().chars().take(40).collect();
        format!("“{text}”")
    };
    match tool {
        "open" | "navigate" => format!("Opening {}", arguments["url"].as_str().unwrap_or("a page")),
        "click" => match (arguments["text"].as_str(), arguments["selector"].as_str()) {
            (Some(text), _) => format!("Clicking {}", quoted(text)),
            (None, Some(selector)) => format!("Clicking {}", quoted(selector)),
            _ => "Clicking".into(),
        },
        "type" => "Typing".into(),
        "press" => format!("Pressing {}", arguments["key"].as_str().unwrap_or("a key")),
        "read" => "Reading the page".into(),
        "screenshot" => "Looking at the page".into(),
        _ => "Closing the browser".into(),
    }
}

#[cfg(any(target_os = "linux", all(test, unix)))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod engine;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readiness_is_literal_true_in_version_one_only() {
        assert!(read_readiness(Some(&json!({"version": 1, "flags": {"cloud.desktop.agent-browser.v1": true}}))));
        for held in [
            json!(null),
            json!({"version": 2, "flags": {"cloud.desktop.agent-browser.v1": true}}),
            json!({"version": 1, "flags": {"cloud.desktop.agent-browser.v1": "true"}}),
            json!({"version": 1, "flags": {"cloud.desktop.v1": true}}),
        ] {
            assert!(!read_readiness(Some(&held)), "{held}");
        }
        assert!(!read_readiness(None));
    }

    #[test]
    fn not_offered_and_not_launched_while_off() {
        set_switch(false);
        assert_eq!(offer(), "off");
        assert_eq!(launch_args("claude", "/opt/terminalx"), "");
        assert_eq!(launch_args("codex", "/opt/terminalx"), "");
        let result = call(Caller { key: "s/t".into(), agent: "Claude Code", tab_title: None, asks: true }, &json!({"tool": "open", "arguments": {"url": "http://localhost:3000"}}), &|_| panic!("never asks while off"));
        assert_eq!(result["isError"], true);
        assert!(result["content"][0]["text"].as_str().unwrap().contains("off for this workspace"));
    }

    #[test]
    fn its_tools_pass_the_cli_gates_and_only_bypass_runs_without_asking() {
        assert!(is_tool("mcp__cloud_browser__click"));
        assert!(is_tool(OPEN_TOOL));
        assert!(!is_tool("mcp__cloud_browser__eval"));
        assert!(!is_tool("mcp__other__click"));
        assert!(runs_without_asking("bypassPermissions"));
        for mode in ["manual", "default", "acceptEdits", "auto", "plan"] {
            assert!(!runs_without_asking(mode), "{mode}");
        }
    }

    #[test]
    fn serves_mcp_initialize_list_and_calls_through_the_hook() {
        let seen = std::cell::RefCell::new(Vec::new());
        let call = |tool: &str, arguments: Value| {
            seen.borrow_mut().push((tool.to_string(), arguments));
            text_result("done", false)
        };
        let init = answer(&json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}}), &call).unwrap();
        assert_eq!(init["result"]["serverInfo"]["name"], SERVER);
        assert!(answer(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}), &call).is_none());
        let list = answer(&json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}), &call).unwrap();
        let names: Vec<_> = list["result"]["tools"].as_array().unwrap().iter().map(|tool| tool["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["open", "navigate", "click", "type", "press", "read", "screenshot", "close"]);
        let called = answer(&json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "click", "arguments": {"text": "Sign in"}}}), &call).unwrap();
        assert_eq!(called["result"]["content"][0]["text"], "done");
        assert_eq!(seen.borrow().as_slice(), [("click".to_string(), json!({"text": "Sign in"}))]);
        let unknown = answer(&json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "eval"}}), &call).unwrap();
        assert_eq!(unknown["error"]["code"], -32602);
    }

    #[test]
    fn says_what_the_agent_does_in_few_words() {
        assert_eq!(describe("click", &json!({"text": "Sign in"})), "Clicking “Sign in”");
        assert_eq!(describe("open", &json!({"url": "http://localhost:3000"})), "Opening http://localhost:3000");
        assert_eq!(describe("press", &json!({"key": "Enter"})), "Pressing Enter");
    }
}
