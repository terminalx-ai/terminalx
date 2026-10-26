//! MCP boundary running inside the macOS guest. The worker receives guest
//! native and browser tools only; no VM selectors, fleet management, shell or host API.
use super::{journal::TaskTarget, process};
use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::Stdio;
use std::time::Duration;

pub const DRIVER_VERSION: &str = "0.28.0";
const ALLOWED: &[&str] = &[
    "list_apps",
    "list_windows",
    "get_app_state",
    "get_app_windows",
    "get_window_state",
    "get_screen_state",
    "get_current_window",
    "get_window",
    "get_desktop_state",
    "screenshot",
    "capture_window",
    "capture_desktop",
    "click",
    "double_click",
    "right_click",
    "type_text",
    "press_key",
    "hotkey",
    "scroll",
    "drag",
    "move",
    "set_value",
    "perform_action",
    "launch_app",
    "activate_app",
    "focus_window",
    // Exact Driver 0.28.0 names. Discovery mints the session-bound target/tab
    // IDs used by actions; preparation retains the driver's authorization gates.
    "get_browser_state",
    "browser_prepare",
    "browser_navigate",
    "browser_click",
    "browser_type",
];
fn identity(target: Option<&TaskTarget>) -> Result<()> {
    if std::env::consts::OS != "macos" || std::env::consts::ARCH != "aarch64" {
        bail!("Guest desktop requires macOS arm64");
    }
    let home = dirs::home_dir().context("Guest home unavailable")?;
    if home.to_str() != Some("/Users/lume") {
        bail!("This tool only runs in the dedicated macOS guest account");
    }
    let value: Value =
        serde_json::from_slice(&std::fs::read(home.join(".terminalx-local/identity.json"))?)?;
    if let Some(target) = target {
        if value.get("environmentId").and_then(Value::as_str) != Some(&target.environment_id)
            || value.get("generation").and_then(Value::as_str) != Some(&target.generation)
        {
            bail!("Guest desktop identity mismatch");
        }
        super::guest::desktop_authorized(target)?;
    }
    Ok(())
}

pub(super) fn check_identity() -> Result<()> {
    identity(None)
}
pub fn ready() -> Result<()> {
    identity(None)?;
    let version = process::run(
        process::command("cua-driver")?.arg("--version"),
        b"",
        Duration::from_secs(10),
    )?;
    if !String::from_utf8_lossy(&version)
        .split_whitespace()
        .any(|s| s.trim_start_matches('v') == DRIVER_VERSION)
    {
        bail!("Install guest Cua Driver {DRIVER_VERSION} and grant its guest desktop permissions");
    }
    let apps = process::run(
        process::command("cua-driver")?.args(["call", "get_desktop_state"]),
        b"",
        Duration::from_secs(15),
    )?;
    let state: Value =
        serde_json::from_slice(&apps).context("Guest driver returned invalid readiness state")?;
    // A process existing or a zero exit status alone proves no GUI readiness.
    let text = state.to_string();
    if text.contains("screen_locked")
        || text.contains("permission_denied")
        || text.contains("permission_required")
        || text.contains("display_unavailable")
        || state.get("ok") == Some(&Value::Bool(false))
        || state.get("isError") == Some(&Value::Bool(true))
    {
        bail!("Guest desktop unavailable or locked; recover it in the guest. No host fallback");
    }
    Ok(())
}

pub fn run_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("local-vm-computer") {
        return None;
    }
    let result = (|| {
        if args.len() != 4 || args[1] != "--stdio" || args[2] != "--task" {
            bail!("Expected local-vm-computer --stdio --task <bound target>");
        }
        let target: TaskTarget =
            serde_json::from_slice(&base64::engine::general_purpose::STANDARD.decode(&args[3])?)?;
        std::env::set_var("TERMINALX_HOME", "/Users/lume/.terminalx-local/runtime");
        serve(&target)
    })();
    if let Err(error) = &result {
        eprintln!("Guest desktop tool: {error:#}");
    }
    Some(if result.is_ok() { 0 } else { 1 })
}

fn allowed(name: &str) -> bool {
    ALLOWED.contains(&name)
}
fn filter_response(mut value: Value) -> Value {
    if let Some(tools) = value
        .pointer_mut("/result/tools")
        .and_then(Value::as_array_mut)
    {
        tools.retain(|tool| {
            tool.get("name")
                .and_then(Value::as_str)
                .is_some_and(allowed)
        });
    }
    value
}
fn check_request(target: &TaskTarget, value: &Value) -> Result<()> {
    identity(Some(target))?;
    check_capability_request(value)
}

fn check_capability_request(value: &Value) -> Result<()> {
    match value
        .get("method")
        .and_then(Value::as_str)
        .context("MCP method required")?
    {
        "initialize" | "notifications/initialized" | "ping" | "tools/list" => Ok(()),
        "tools/call" => {
            let name = value
                .pointer("/params/name")
                .and_then(Value::as_str)
                .context("Tool name required")?;
            if !allowed(name) {
                bail!("Tool is outside this task's guest desktop capability");
            }
            let arguments = value.pointer("/params/arguments");
            if arguments.is_some_and(|a| {
                [
                    "sandbox",
                    "environment",
                    "host",
                    "machine",
                    "endpoint",
                    "urlOverride",
                    "permissionMode",
                ]
                .iter()
                .any(|key| a.get(key).is_some())
            }) {
                bail!("Desktop target switching is unavailable");
            }
            Ok(())
        }
        _ => bail!("MCP method is outside the guest desktop capability"),
    }
}
fn serve(target: &TaskTarget) -> Result<()> {
    identity(Some(target))?;
    ready()?;
    let mut child = process::command("cua-driver")?
        .arg("mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let result = (|| {
        let mut stdin = child.stdin.take().context("Driver input missing")?;
        let mut stdout = BufReader::new(child.stdout.take().context("Driver output missing")?);
        let mut out = std::io::stdout().lock();
        let mut input = std::io::stdin().lock();
        loop {
            let mut line = String::new();
            let count = input.by_ref().take(1024 * 1024 + 1).read_line(&mut line)?;
            if count == 0 {
                break;
            }
            if count > 1024 * 1024 || !line.ends_with('\n') {
                bail!("MCP request exceeds 1 MiB");
            }
            let value: Value = serde_json::from_str(&line)?;
            if let Err(error) = check_request(target, &value) {
                if let Some(id) = value.get("id") {
                    writeln!(
                        out,
                        "{}",
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32602,"message":error.to_string()}})
                    )?;
                    out.flush()?;
                }
                continue;
            }
            stdin.write_all(line.as_bytes())?;
            stdin.flush()?;
            if value.get("id").is_none() {
                continue;
            }
            loop {
                let mut reply = String::new();
                if stdout
                    .by_ref()
                    .take(16 * 1024 * 1024 + 1)
                    .read_line(&mut reply)?
                    == 0
                {
                    bail!("Guest driver disconnected; outcome unknown");
                }
                if reply.len() > 16 * 1024 * 1024 {
                    bail!("Guest driver response exceeds limit");
                }
                let reply: Value = serde_json::from_str(&reply)?;
                let matched = reply.get("id") == value.get("id");
                writeln!(out, "{}", filter_response(reply))?;
                out.flush()?;
                if matched {
                    break;
                }
            }
        }
        Ok(())
    })();
    let _ = child.kill();
    let _ = child.wait();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pinned_native_window_catalog_preserves_discovery_without_routing_overrides() {
        let catalog: Value =
            serde_json::from_str(include_str!("fixtures/cua-driver-0.28.0-list-windows.json"))
                .unwrap();
        assert_eq!(catalog["driverVersion"], DRIVER_VERSION);
        let descriptor = &catalog["tool"];
        let response = filter_response(
            json!({"jsonrpc":"2.0","id":9,"result":{"tools":[descriptor,{"name":"shell"},{"name":"create_vm"},{"name":"permissions_grant"}]}}),
        );
        assert_eq!(response["result"]["tools"], json!([descriptor]));
        let request = json!({"method":"tools/call","params":{"name":descriptor["name"],"arguments":{"pid":15115,"on_screen_only":false}}});
        check_capability_request(&request).unwrap();
        for field in [
            "host",
            "environment",
            "sandbox",
            "machine",
            "endpoint",
            "permissionMode",
        ] {
            let mut overridden = request.clone();
            overridden["params"]["arguments"][field] = json!("forbidden");
            assert!(check_capability_request(&overridden).is_err(), "{field}");
        }
        assert_eq!(descriptor["inputSchema"]["additionalProperties"], false);
        assert!(descriptor["inputSchema"]["properties"]["pid"].is_object());
        assert!(descriptor["inputSchema"]["properties"]["on_screen_only"].is_object());
    }

    fn browser_catalog() -> Value {
        serde_json::from_str(include_str!(
            "fixtures/cua-driver-0.28.0-browser-tools.json"
        ))
        .unwrap()
    }

    #[test]
    fn pinned_browser_catalog_exposes_discovery_setup_and_actions_with_original_schemas() {
        let catalog = browser_catalog();
        assert_eq!(catalog["driverVersion"], DRIVER_VERSION);
        let descriptors = catalog["tools"].as_array().unwrap();
        let mut tools = descriptors.clone();
        for name in [
            "browser_tabs",
            "browser_snapshot",
            "browser_fill",
            "browser_evaluate",
            "browser_download",
            "browser_set_input_files",
            "browser_dialog",
            "browser_pointer",
            "page",
            "set_config",
            "shell",
            "create_vm",
            "permissions_grant",
        ] {
            tools.push(json!({"name":name}));
        }
        let response = filter_response(json!({"jsonrpc":"2.0","id":7,"result":{"tools":tools}}));
        // These descriptors come from the pinned guest binary's describe
        // command, not a synthetic catalog copied from ALLOWED. Exact equality
        // also preserves the driver's binding and preparation permission rules.
        assert_eq!(response["result"]["tools"], catalog["tools"]);
        assert_eq!(response["id"], 7);
        let names: Vec<_> = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "get_browser_state",
                "browser_prepare",
                "browser_type",
                "browser_click",
                "browser_navigate"
            ]
        );
    }

    #[test]
    fn pinned_browser_arguments_pass_without_allowing_target_or_permission_overrides() {
        let catalog = browser_catalog();
        let requests = [
            (
                "get_browser_state",
                json!({"pid":123,"window_id":456,"session":"task-browser"}),
            ),
            (
                "get_browser_state",
                json!({"target_id":"target-1","tab_id":"tab-1","session":"task-browser","snapshot_format":"semantic_v2"}),
            ),
            (
                "browser_prepare",
                json!({"allow_launch":true,"profile":{"mode":"isolated_new"},"session":"task-browser"}),
            ),
            (
                "browser_prepare",
                json!({"pid":123,"window_id":456,"strategy":{"kind":"existing_profile"},"session":"task-browser"}),
            ),
            (
                "browser_type",
                json!({"target_id":"target-1","tab_id":"tab-1","ref":"p1:2","text":"new text","replace":true,"session":"task-browser"}),
            ),
            (
                "browser_click",
                json!({"target_id":"target-1","tab_id":"tab-1","ref":"p1:2","session":"task-browser"}),
            ),
            (
                "browser_navigate",
                json!({"target_id":"target-1","tab_id":"tab-1","url":"https://example.test/","session":"task-browser"}),
            ),
        ];
        for (name, arguments) in requests {
            let descriptor = catalog["tools"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == name)
                .unwrap();
            for key in arguments.as_object().unwrap().keys() {
                assert!(
                    descriptor["inputSchema"]["properties"].get(key).is_some(),
                    "{name}.{key}"
                );
            }
            let request =
                json!({"method":"tools/call","params":{"name":name,"arguments":arguments}});
            // Only validates proxy admission; no browser setup or action runs.
            // Existing-profile authorization still belongs to the driver.
            check_capability_request(&request).unwrap();
            for field in [
                "sandbox",
                "environment",
                "host",
                "machine",
                "endpoint",
                "urlOverride",
                "permissionMode",
            ] {
                let mut overridden = request.clone();
                overridden["params"]["arguments"][field] = json!("forbidden-override");
                assert!(
                    check_capability_request(&overridden).is_err(),
                    "{name}.{field}"
                );
            }
        }
        for name in [
            "browser_tabs",
            "browser_snapshot",
            "browser_fill",
            "browser_evaluate",
            "browser_download",
            "browser_set_input_files",
            "set_config",
            "permissions_grant",
            "shell",
            "create_vm",
        ] {
            assert!(
                check_capability_request(
                    &json!({"method":"tools/call","params":{"name":name,"arguments":{}}})
                )
                .is_err(),
                "{name}"
            );
        }
    }

    #[test]
    fn discovery_only_exposes_native_desktop_capabilities() {
        let response = filter_response(
            json!({"result":{"tools":[{"name":"click"},{"name":"shell"},{"name":"create_vm"},{"name":"settings"}]}}),
        );
        assert_eq!(response["result"]["tools"], json!([{"name":"click"}]));
        assert!(!allowed("computer_shell"));
        assert!(!allowed("browser_evaluate"));
    }
}
