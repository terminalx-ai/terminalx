//! One question for a throwaway `codex app-server`.
//!
//! Three things the app needs are only knowable by asking the CLI itself:
//! which models this account may run, the hash Codex computes for a hook, and
//! the signed-in account's rate-limit windows. All are
//! read-only questions with an answer that changes when Codex is upgraded, so
//! neither is worth reimplementing — the same binary is asked, over the
//! JSON-RPC it already speaks on stdio, and the child is killed as soon as it
//! has answered.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

/// A cold `codex app-server` takes a moment to come up; past this the answer
/// is not worth blocking a picker (or a tab starting) for.
pub const TIMEOUT: Duration = Duration::from_secs(15);

/// Where the server should run and whose home it should read.
#[derive(Default)]
pub struct Where<'a> {
    pub codex_home: Option<&'a Path>,
    pub cwd: Option<&'a Path>,
}

/// Ask one method and return its `result`. Everything is sent at once — the
/// server ignores anything before `initialize` and answers in whatever order
/// it likes — and the reply is matched by id.
pub fn ask(place: Where<'_>, method: &str, params: Value) -> Result<Value> {
    let program = crate::binpath::resolve("codex").context("codex is not installed")?;
    let mut cmd = Command::new(&program);
    cmd.arg("app-server")
        .env("PATH", crate::binpath::login_path())
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(home) = place.codex_home {
        cmd.env("CODEX_HOME", home);
    }
    if let Some(cwd) = place.cwd {
        cmd.current_dir(cwd);
    }
    // Its own group, so terminating it takes any helper it forked with it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().with_context(|| format!("spawn {}", program.display()))?;
    let pid = child.id();

    let result = (|| -> Result<Value> {
        let mut stdin = child.stdin.take().context("no stdin")?;
        let stdout = child.stdout.take().context("no stdout")?;
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::Builder::new().name("codex-app-server".into()).spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        })?;

        let hello = json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "raccoon", "title": "TerminalX", "version": env!("CARGO_PKG_VERSION")}}});
        writeln!(stdin, "{hello}")?;
        writeln!(stdin, "{}", json!({"method": "initialized", "params": {}}))?;
        writeln!(stdin, "{}", json!({"id": 2, "method": method, "params": params}))?;
        stdin.flush()?;

        let deadline = Instant::now() + TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                bail!("timed out after {}s", TIMEOUT.as_secs());
            }
            let line = rx.recv_timeout(left).map_err(|_| anyhow::anyhow!("codex app-server closed without answering"))?;
            let v: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("id").and_then(Value::as_u64) != Some(2) {
                continue;
            }
            if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
                bail!("{}", err.get("message").and_then(Value::as_str).unwrap_or("request failed"));
            }
            return Ok(v["result"].clone());
        }
    })();

    // Whatever happened, the child has served its purpose.
    let _ = child.kill();
    let _ = child.wait();
    crate::harness::host::terminate(pid);
    result
}
