//! Claude Code: a pipe. Spawn it, write JSON lines, read JSON lines back.

pub mod commands;
pub mod mapper;
pub mod parser;
pub mod transcript;

use serde_json::{json, Value};

#[allow(dead_code)]
pub const HARNESS_ID: &str = "claude";

pub struct SpawnPlan {
    pub program: std::path::PathBuf,
    pub args: Vec<String>,
}

pub struct SpawnOptions<'a> {
    pub provider_session_id: &'a str,
    pub resume: bool,
    pub fork_from: Option<&'a str>,
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub permission_mode: &'a str,
}

/// The argument list for a child. `--permission-prompt-tool stdio` is what
/// routes every permission question through the pipe; without it the CLI
/// auto-denies and reports `permission_denied`.
pub fn spawn_plan(opts: SpawnOptions<'_>) -> Option<SpawnPlan> {
    let program = crate::binpath::resolve("claude")?;
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        "--include-partial-messages".into(),
        "--permission-prompt-tool".into(),
        "stdio".into(),
        "--permission-mode".into(),
        normalize_mode(opts.permission_mode).into(),
    ];
    if let Some(parent) = opts.fork_from {
        args.extend(["--resume".into(), parent.into(), "--fork-session".into(), "--session-id".into(), opts.provider_session_id.into()]);
    } else if opts.resume {
        args.extend(["--resume".into(), opts.provider_session_id.into()]);
    } else {
        args.extend(["--session-id".into(), opts.provider_session_id.into()]);
    }
    if let Some(m) = opts.model.filter(|m| !m.is_empty()) {
        args.extend(["--model".into(), m.into()]);
    }
    if let Some(e) = opts.effort.filter(|e| !e.is_empty()) {
        args.extend(["--effort".into(), e.into()]);
    }
    Some(SpawnPlan { program, args })
}

/// What `--permission-mode` accepts. Anything unknown falls back to asking,
/// never to bypassing.
pub fn normalize_mode(mode: &str) -> &'static str {
    match mode {
        "plan" => "plan",
        "manual" | "default" | "ask" => "manual",
        "auto" => "auto",
        "acceptEdits" | "accept_edits" => "acceptEdits",
        "dontAsk" | "dont_ask" => "dontAsk",
        "bypassPermissions" | "bypass" => "bypassPermissions",
        _ => "manual",
    }
}

/// One prompt as a stdin line. Images ride as base64 content blocks.
pub fn user_line(session_id: &str, text: &str, images: &[(String, String)]) -> String {
    let mut content = Vec::new();
    for (media_type, data) in images {
        content.push(json!({"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}));
    }
    content.push(json!({"type": "text", "text": text}));
    json!({
        "type": "user",
        "message": {"role": "user", "content": content},
        "session_id": session_id,
        "parent_tool_use_id": null
    })
    .to_string()
}

pub fn control_line(request_id: &str, request: Value) -> String {
    json!({"type": "control_request", "request_id": request_id, "request": request}).to_string()
}

pub fn interrupt_line(request_id: &str) -> String {
    control_line(request_id, json!({"subtype": "interrupt"}))
}

pub fn set_model_line(request_id: &str, model: &str) -> String {
    control_line(request_id, json!({"subtype": "set_model", "model": model}))
}

pub fn set_mode_line(request_id: &str, mode: &str) -> String {
    control_line(request_id, json!({"subtype": "set_permission_mode", "mode": normalize_mode(mode)}))
}

pub fn initialize_line(request_id: &str) -> String {
    control_line(request_id, json!({"subtype": "initialize"}))
}

/// The reply to a `can_use_tool`. Double-wrapped: a wrongly shaped reply is
/// ignored silently and presents as a hung turn.
pub fn permission_response(request_id: &str, allow: bool, updated_input: Option<Value>, updated_permissions: Vec<Value>, deny_message: Option<&str>) -> String {
    let inner = if allow {
        let mut r = json!({"behavior": "allow"});
        if let Some(i) = updated_input {
            r["updatedInput"] = i;
        }
        if !updated_permissions.is_empty() {
            r["updatedPermissions"] = Value::Array(updated_permissions);
        }
        r
    } else {
        json!({"behavior": "deny", "message": deny_message.unwrap_or("The user declined this action.")})
    };
    json!({
        "type": "control_response",
        "response": {"subtype": "success", "request_id": request_id, "response": inner}
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_uses_session_id_for_new_and_resume_for_existing() {
        if crate::binpath::resolve("claude").is_none() {
            return;
        }
        let p = spawn_plan(SpawnOptions { provider_session_id: "abc", resume: false, fork_from: None, model: Some("haiku"), effort: None, permission_mode: "auto" }).unwrap();
        assert!(p.args.windows(2).any(|w| w == ["--session-id", "abc"]));
        assert!(p.args.windows(2).any(|w| w == ["--permission-prompt-tool", "stdio"]));
        assert!(p.args.windows(2).any(|w| w == ["--model", "haiku"]));
        let p = spawn_plan(SpawnOptions { provider_session_id: "abc", resume: true, fork_from: None, model: None, effort: Some("high"), permission_mode: "weird" }).unwrap();
        assert!(p.args.windows(2).any(|w| w == ["--resume", "abc"]));
        assert!(p.args.windows(2).any(|w| w == ["--permission-mode", "manual"]));
        assert!(p.args.windows(2).any(|w| w == ["--effort", "high"]));
    }

    #[test]
    fn permission_reply_shape() {
        let s = permission_response("r", true, Some(json!({"a":1})), vec![json!({"type":"setMode"})], None);
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["response"]["request_id"], "r");
        assert_eq!(v["response"]["response"]["behavior"], "allow");
        assert_eq!(v["response"]["response"]["updatedInput"]["a"], 1);
        let s = permission_response("r", false, None, vec![], None);
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["response"]["response"]["behavior"], "deny");
    }
}
