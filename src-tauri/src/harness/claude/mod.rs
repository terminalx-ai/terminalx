//! Claude Code. A tab runs the interactive CLI in a PTY (`pty.rs`) and reads
//! it back through its transcript (`transcript.rs`) and its hooks; the pieces
//! here are what both halves share, plus the one-shot control line the slash
//! command listing sends to a short-lived headless child (`commands.rs`).

pub mod commands;
pub mod mapper;
pub mod pty;
pub mod transcript;
pub mod trust;

use serde_json::{json, Value};

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

pub fn control_line(request_id: &str, request: Value) -> String {
    json!({"type": "control_request", "request_id": request_id, "request": request}).to_string()
}

pub fn initialize_line(request_id: &str) -> String {
    control_line(request_id, json!({"subtype": "initialize"}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_modes_fall_back_to_asking() {
        assert_eq!(normalize_mode("ask"), "manual");
        assert_eq!(normalize_mode("accept_edits"), "acceptEdits");
        assert_eq!(normalize_mode("whatever"), "manual");
        assert_eq!(normalize_mode("bypass"), "bypassPermissions");
    }

    #[test]
    fn a_control_request_is_one_tagged_line() {
        let v: Value = serde_json::from_str(&initialize_line("r1")).unwrap();
        assert_eq!(v["type"], "control_request");
        assert_eq!(v["request_id"], "r1");
        assert_eq!(v["request"]["subtype"], "initialize");
    }
}
