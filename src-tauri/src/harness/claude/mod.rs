//! Claude Code. A tab runs the interactive CLI in a PTY (`pty.rs`) and reads
//! it back through its transcript (`transcript.rs`) and its hooks; the pieces
//! here are what both halves share, plus the one-shot control line the slash
//! command listing sends to a short-lived headless child (`commands.rs`).

pub mod commands;
pub mod mapper;
pub mod models;
pub mod pty;
pub mod transcript;
pub mod trust;

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde_json::{json, Value};

/// What `--permission-mode` accepts. No mode at all is the product default
/// (bypass); anything *unknown* falls back to asking, never to bypassing.
pub fn normalize_mode(mode: &str) -> &'static str {
    match mode.trim() {
        "" => "bypassPermissions",
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

/// The CLI's answer to `initialize`, from a throwaway child run in `cwd`. It
/// answers before any turn, so there is no model call: the child is spawned,
/// asked once, and killed (~1.5s). The reply names the slash commands and the
/// models this account may run.
pub fn ask_initialize(cwd: &Path) -> Result<Value> {
    let program = crate::binpath::resolve("claude").ok_or_else(|| anyhow!("Claude Code is not installed"))?;
    let mut child = Command::new(program)
        .args(["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"])
        .current_dir(cwd)
        .env("PATH", crate::binpath::login_path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("spawn claude for its initialize reply")?;
    let mut stdin = child.stdin.take().context("stdin")?;
    let line = initialize_line("raccoon-init");
    stdin.write_all(line.as_bytes())?;
    stdin.write_all(b"\n")?;
    stdin.flush()?;
    let stdout = child.stdout.take().context("stdout")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for l in BufReader::new(stdout).lines().map_while(Result::ok) {
            if l.contains("\"control_response\"") && tx.send(l).is_err() {
                break;
            }
        }
    });
    let reply = rx.recv_timeout(Duration::from_secs(15));
    let _ = child.kill();
    let _ = child.wait();
    let line = reply.context("no initialize reply from Claude Code")?;
    Ok(serde_json::from_str(&line)?)
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
        // Unset is not unknown: it is the default launch mode.
        assert_eq!(normalize_mode(""), "bypassPermissions");
        assert_eq!(normalize_mode(crate::store::index::DEFAULT_PERMISSION_MODE), "bypassPermissions");
    }

    #[test]
    fn a_control_request_is_one_tagged_line() {
        let v: Value = serde_json::from_str(&initialize_line("r1")).unwrap();
        assert_eq!(v["type"], "control_request");
        assert_eq!(v["request_id"], "r1");
        assert_eq!(v["request"]["subtype"], "initialize");
    }
}
