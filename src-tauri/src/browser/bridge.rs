//! The agent-browser bridge: one named daemon session per browser profile,
//! commands serialized per session, each bounded by a timeout, and a stuck
//! daemon restarted after repeated timeouts.
//!
//! Every invocation re-asserts the launch options (`--profile`, `--headed`,
//! `--download-path`): a daemon that idled out and was relaunched by the next
//! command would otherwise open a headless, profile-less browser.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::Value;

use super::environment::ProcessEnvironment;
use super::process::{run, RunOptions};
use super::{BrowserError, BrowserResult};

/// Must exceed agent-browser's own internal waits (navigation 30 s, wait
/// 30–60 s) so the bridge never kills a command before its own timeout fires.
pub const EXEC_TIMEOUT: Duration = Duration::from_secs(90);
/// Three timeouts in a row means the daemon is wedged; it is closed and the
/// next command starts a fresh one.
pub const CONSECUTIVE_TIMEOUT_LIMIT: u32 = 3;
/// A close runs inside the app's quit path and must finish well inside it.
pub const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
/// agent-browser passes text through argv; keep single arguments bounded and
/// stream anything larger over stdin.
pub const TEXT_ARGUMENT_MAX_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone)]
pub struct ExecOptions {
    pub timeout: Duration,
    pub stdin: Option<String>,
}

impl Default for ExecOptions {
    fn default() -> Self {
        Self { timeout: EXEC_TIMEOUT, stdin: None }
    }
}

/// Per-session bookkeeping, only touched while the session lane is held.
#[derive(Debug, Default)]
pub struct Lane {
    pub consecutive_timeouts: u32,
    /// The tab agent-browser last confirmed as active, so page commands only
    /// pay for a `tab <id>` switch when they have to.
    pub active_tab: Option<String>,
    /// Whether a command has succeeded since the last close, i.e. a daemon is
    /// (or was) running for this name.
    pub launched: bool,
    pub last_command_at: Option<Instant>,
    /// Route patterns the agent enabled, restored after a restart.
    pub intercept_patterns: Vec<String>,
    pub capture_active: bool,
}

pub struct Session {
    pub name: String,
    pub profile_id: String,
    pub profile_dir: PathBuf,
    pub download_dir: PathBuf,
    lane: Mutex<Lane>,
}

/// One command's view of its session: the lane is held for the closure's
/// whole duration, which is what serializes commands per daemon.
pub struct Ctx<'a> {
    bridge: &'a Bridge,
    pub session: &'a Session,
    pub lane: MutexGuard<'a, Lane>,
}

pub struct Bridge {
    pub env: ProcessEnvironment,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl Bridge {
    pub fn new(env: ProcessEnvironment) -> Self {
        Self { env, sessions: Mutex::new(HashMap::new()) }
    }

    /// The session for a profile, created lazily; creation does not launch
    /// anything.
    pub fn session(&self, profile_id: &str, profile_dir: PathBuf, download_dir: PathBuf) -> Arc<Session> {
        let name = super::profiles::session_name(profile_id);
        let mut sessions = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions
            .entry(name.clone())
            .or_insert_with(|| {
                Arc::new(Session { name, profile_id: profile_id.to_string(), profile_dir, download_dir, lane: Mutex::new(Lane::default()) })
            })
            .clone()
    }

    pub fn existing_session(&self, profile_id: &str) -> Option<Arc<Session>> {
        let name = super::profiles::session_name(profile_id);
        self.sessions.lock().unwrap_or_else(|e| e.into_inner()).get(&name).cloned()
    }

    /// Names of sessions a daemon has been launched for.
    pub fn live_session_names(&self) -> Vec<String> {
        let sessions: Vec<Arc<Session>> = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
        sessions
            .into_iter()
            .filter(|s| s.lane.lock().map(|l| l.launched).unwrap_or(false))
            .map(|s| s.name.clone())
            .collect()
    }

    pub fn launched_sessions(&self) -> Vec<Arc<Session>> {
        let sessions: Vec<Arc<Session>> = self.sessions.lock().unwrap_or_else(|e| e.into_inner()).values().cloned().collect();
        sessions.into_iter().filter(|s| s.lane.lock().map(|l| l.launched).unwrap_or(false)).collect()
    }

    /// Run `f` with the session lane held.
    pub fn with_session<R>(&self, session: &Session, f: impl FnOnce(&mut Ctx<'_>) -> R) -> R {
        let lane = session.lane.lock().unwrap_or_else(|e| e.into_inner());
        let mut ctx = Ctx { bridge: self, session, lane };
        f(&mut ctx)
    }

    /// Close a session's daemon (and with it the whole browser for that
    /// profile). Bounded; a daemon that is already gone needs no closing.
    pub fn close_session(&self, session: &Session) -> BrowserResult<()> {
        self.with_session(session, |ctx| ctx.close())
    }

    /// Close every launched session, a few at a time, inside the quit budget.
    pub fn close_all(&self) {
        let live = self.launched_sessions();
        let mut handles = Vec::new();
        for chunk in live.chunks(4) {
            for session in chunk {
                let session = session.clone();
                let env = self.env.clone();
                handles.push(std::thread::spawn(move || {
                    if let Ok(binary) = super::binary::require() {
                        let _ = run(&binary, &["--session", &session.name, "close"], &env, RunOptions { timeout: CLEANUP_TIMEOUT, stdin: None });
                    }
                    if let Ok(mut lane) = session.lane.lock() {
                        lane.launched = false;
                        lane.active_tab = None;
                    }
                }));
            }
            for handle in handles.drain(..) {
                let _ = handle.join();
            }
        }
    }
}

impl Ctx<'_> {
    /// Run one agent-browser command in this session and translate its JSON
    /// envelope. `args` are the command and its own arguments; the session,
    /// launch options and `--json` are added here.
    pub fn run(&mut self, args: &[&str], options: ExecOptions) -> BrowserResult<Value> {
        let binary = super::binary::require()?;
        let mut argv: Vec<&str> = vec!["--session", &self.session.name];
        let profile_dir = self.session.profile_dir.to_string_lossy().into_owned();
        let download_dir = self.session.download_dir.to_string_lossy().into_owned();
        argv.extend(["--profile", &profile_dir, "--headed", "--download-path", &download_dir]);
        argv.extend_from_slice(args);
        argv.push("--json");
        self.lane.last_command_at = Some(Instant::now());
        let out = run(&binary, &argv, &self.bridge.env, RunOptions { timeout: options.timeout, stdin: options.stdin.as_deref() })
            .map_err(|e| BrowserError::new("browser_error", format!("could not start agent-browser: {e}")))?;
        if out.timed_out {
            self.lane.consecutive_timeouts += 1;
            if self.lane.consecutive_timeouts >= CONSECUTIVE_TIMEOUT_LIMIT {
                log::warn!("agent-browser session {} timed out {} times; restarting", self.session.name, self.lane.consecutive_timeouts);
                let _ = self.close();
            }
            return Err(BrowserError::new("browser_timeout", format!("Browser command timed out after {} s.", options.timeout.as_secs())));
        }
        self.lane.consecutive_timeouts = 0;
        let translated = translate_result(&out.stdout, &out.stderr, out.status);
        if translated.is_ok() {
            self.lane.launched = true;
        }
        translated
    }

    /// Make `tab_id` the daemon's current page, unless it already is.
    pub fn ensure_tab(&mut self, tab_id: &str) -> BrowserResult<()> {
        if self.lane.active_tab.as_deref() == Some(tab_id) {
            return Ok(());
        }
        match self.run(&["tab", tab_id], ExecOptions::default()) {
            Ok(_) => {
                self.lane.active_tab = Some(tab_id.to_string());
                Ok(())
            }
            Err(e) => {
                self.lane.active_tab = None;
                if is_tab_missing(&e.message) {
                    Err(BrowserError::new("browser_tab_not_found", format!("Browser tab {tab_id} is no longer open.")))
                } else {
                    Err(e)
                }
            }
        }
    }

    /// After anything that may have changed which page is current.
    pub fn forget_active_tab(&mut self) {
        self.lane.active_tab = None;
    }

    pub fn close(&mut self) -> BrowserResult<()> {
        let binary = super::binary::require()?;
        let out = run(&binary, &["--session", &self.session.name, "close"], &self.bridge.env, RunOptions { timeout: CLEANUP_TIMEOUT, stdin: None });
        self.lane.launched = false;
        self.lane.active_tab = None;
        self.lane.consecutive_timeouts = 0;
        self.lane.capture_active = false;
        match out {
            Ok(_) => Ok(()),
            Err(e) => Err(BrowserError::new("browser_error", format!("could not close session {}: {e}", self.session.name))),
        }
    }
}

/// The daemon's socket-directory pid file, when the bridge owns the
/// directory; used to find the browser window to focus.
pub fn daemon_pid(env: &ProcessEnvironment, session_name: &str) -> Option<u32> {
    let dir = env.socket_dir.as_ref()?;
    std::fs::read_to_string(dir.join(format!("{session_name}.pid"))).ok()?.trim().parse().ok()
}

fn is_tab_missing(message: &str) -> bool {
    let m = message.to_ascii_lowercase();
    (m.contains("tab") && (m.contains("not found") || m.contains("no tab") || m.contains("unknown"))) || m.contains("expected a tab id")
}

/// agent-browser exits non-zero on failure but still writes a structured
/// envelope to stdout; parse that first, fall back to stderr.
pub fn translate_result(stdout: &str, stderr: &str, status: Option<i32>) -> BrowserResult<Value> {
    match serde_json::from_str::<Value>(stdout.trim()) {
        Ok(envelope) => {
            if envelope.get("success").and_then(Value::as_bool).unwrap_or(false) {
                return Ok(envelope.get("data").cloned().unwrap_or(Value::Null));
            }
            let message = envelope.get("error").and_then(Value::as_str).unwrap_or("Unknown browser error").to_string();
            Err(BrowserError::new(classify_error(&message), message))
        }
        Err(_) => {
            if status == Some(0) && stdout.trim().is_empty() {
                return Ok(Value::Null);
            }
            let detail = if !stderr.trim().is_empty() {
                stderr.trim().to_string()
            } else if !stdout.trim().is_empty() {
                format!("Unexpected output from agent-browser: {}", &stdout[..stdout.len().min(1000)])
            } else {
                format!("agent-browser exited with status {status:?} and no output")
            };
            Err(BrowserError::new(classify_error(&detail), detail))
        }
    }
}

/// agent-browser returns generic errors for stale or unknown refs; agents
/// need a specific code so they know to re-snapshot.
pub fn classify_error(message: &str) -> &'static str {
    let m = message.to_ascii_lowercase();
    // agent-browser keeps a ref's role/name across navigation; an element it
    // can no longer locate is the same staleness from the agent's side.
    if m.contains("unknown ref") || m.contains("ref not found") || m.contains("element not found: @e") || m.contains("no snapshot") || m.contains("could not locate element") {
        "browser_stale_ref"
    } else if m.contains("timeout") || m.contains("timed out") {
        "browser_timeout"
    } else if m.contains("no browser") && m.contains("install") || m.contains("executable doesn't exist") {
        "browser_unavailable"
    } else {
        "browser_error"
    }
}

/// Split an `exec --command` string on whitespace, honouring single and
/// double quotes so quoted arguments stay intact.
pub fn parse_shell_args(input: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_double = false;
    let mut in_single = false;
    let mut pending = false;
    for ch in input.chars() {
        match ch {
            '"' if !in_single => {
                in_double = !in_double;
                pending = true;
            }
            '\'' if !in_double => {
                in_single = !in_single;
                pending = true;
            }
            c if c.is_whitespace() && !in_double && !in_single => {
                if pending || !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                    pending = false;
                }
            }
            c => {
                current.push(c);
                pending = true;
            }
        }
    }
    if pending || !current.is_empty() {
        args.push(current);
    }
    args
}

/// Options only the app may set: they decide which daemon, which browser and
/// which profile a command reaches.
const OWNER_OPTIONS: [&str; 8] = ["--session", "--cdp", "--profile", "--executable-path", "--config", "--args", "--extension", "--init-script"];
/// Commands that address the daemon or the machine rather than a page.
const OWNER_COMMANDS: [&str; 12] = ["close", "connect", "install", "upgrade", "dashboard", "chat", "session", "doctor", "skills", "auth", "confirm", "deny"];

/// Refuse passthrough arguments that would re-target or re-own the session.
pub fn guard_exec_args(args: &[String]) -> BrowserResult<()> {
    if args.is_empty() {
        return Err(BrowserError::new("invalid_arguments", "exec needs a non-empty agent-browser command."));
    }
    if OWNER_COMMANDS.contains(&args[0].as_str()) {
        return Err(BrowserError::new(
            "invalid_arguments",
            format!("exec may not run `{}`; use the typed tab, profile and settings commands instead.", args[0]),
        ));
    }
    for arg in args {
        let name = arg.split('=').next().unwrap_or(arg);
        if OWNER_OPTIONS.contains(&name) {
            return Err(BrowserError::new("invalid_arguments", format!("exec may not pass {name}; the app owns session targeting.")));
        }
    }
    Ok(())
}

pub fn check_text_argument(name: &str, value: &str) -> BrowserResult<()> {
    if value.len() > TEXT_ARGUMENT_MAX_BYTES {
        return Err(BrowserError::new(
            "invalid_arguments",
            format!("{name} is {} bytes; the limit for one argument is {TEXT_ARGUMENT_MAX_BYTES}.", value.len()),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_success_and_failure_envelopes() {
        let ok = translate_result(r#"{"success":true,"data":{"clicked":"@e2"},"error":null}"#, "", Some(0)).unwrap();
        assert_eq!(ok["clicked"], "@e2");
        let stale = translate_result(r#"{"success":false,"data":null,"error":"Unknown ref: e3"}"#, "", Some(1)).unwrap_err();
        assert_eq!(stale.code, "browser_stale_ref");
        let raw = translate_result("", "boom", Some(2)).unwrap_err();
        assert_eq!(raw.code, "browser_error");
        assert_eq!(raw.message, "boom");
        assert!(translate_result("", "", Some(0)).unwrap().is_null());
    }

    #[test]
    fn classifies_errors_agents_must_react_to() {
        assert_eq!(classify_error("Element not found: @e9"), "browser_stale_ref");
        assert_eq!(classify_error("Could not locate element with role=textbox name=Name"), "browser_stale_ref");
        assert_eq!(classify_error("Timeout 30000ms exceeded"), "browser_timeout");
        assert_eq!(classify_error("Executable doesn't exist at /x"), "browser_unavailable");
        assert_eq!(classify_error("navigation failed"), "browser_error");
    }

    #[test]
    fn splits_exec_commands_like_a_shell() {
        assert_eq!(parse_shell_args(r##"click "#main button" --force"##), vec!["click", "#main button", "--force"]);
        assert_eq!(parse_shell_args("fill @e1 'two words'  extra"), vec!["fill", "@e1", "two words", "extra"]);
        assert_eq!(parse_shell_args("eval \"\""), vec!["eval", ""]);
        assert!(parse_shell_args("   ").is_empty());
    }

    #[test]
    fn exec_guard_refuses_retargeting_and_owner_commands() {
        let owned = |args: &[&str]| guard_exec_args(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert!(owned(&["click", "@e1"]).is_ok());
        assert!(owned(&["get", "text", "@e1"]).is_ok());
        assert_eq!(owned(&["click", "--session", "other"]).unwrap_err().code, "invalid_arguments");
        assert_eq!(owned(&["click", "--cdp=9222"]).unwrap_err().code, "invalid_arguments");
        assert_eq!(owned(&["snapshot", "--profile", "/tmp/x"]).unwrap_err().code, "invalid_arguments");
        assert_eq!(owned(&["close"]).unwrap_err().code, "invalid_arguments");
        assert_eq!(owned(&["install"]).unwrap_err().code, "invalid_arguments");
        assert_eq!(owned(&[]).unwrap_err().code, "invalid_arguments");
    }

    #[test]
    fn tab_missing_messages_are_recognised() {
        assert!(is_tab_missing("Tab not found: t9"));
        assert!(is_tab_missing("Expected a tab id like `t0` or a label"));
        assert!(!is_tab_missing("Unknown ref: e3"));
    }

    #[test]
    fn text_arguments_are_bounded() {
        assert!(check_text_argument("--value", "short").is_ok());
        assert_eq!(check_text_argument("--value", &"x".repeat(TEXT_ARGUMENT_MAX_BYTES + 1)).unwrap_err().code, "invalid_arguments");
    }

    /// A session lane serializes commands and counts timeouts toward a
    /// restart, using a stand-in binary so no daemon is involved.
    #[cfg(unix)]
    #[test]
    fn three_timeouts_close_the_session_and_reset_the_lane() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = tmp.path().join("agent-browser");
        // Sleeps unless asked to close, and records every argv it sees.
        std::fs::write(&fake, "#!/bin/sh\necho \"$@\" >> \"$AB_LOG\"\ncase \"$*\" in *close*) echo '{\"success\":true,\"data\":{\"closed\":true}}';; *) sleep 5;; esac\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let log_path = tmp.path().join("log");
        std::env::set_var(super::super::binary::BINARY_ENV, &fake);
        let mut env = ProcessEnvironment { vars: Vec::new(), socket_dir: None, owns_socket_directory: false };
        env.vars.push(("AB_LOG".into(), log_path.to_string_lossy().into_owned()));
        let bridge = Bridge::new(env);
        let session = bridge.session("default", tmp.path().join("profile"), tmp.path().join("downloads"));
        for _ in 0..CONSECUTIVE_TIMEOUT_LIMIT {
            let err = bridge
                .with_session(&session, |ctx| ctx.run(&["snapshot"], ExecOptions { timeout: Duration::from_millis(1200), stdin: None }))
                .unwrap_err();
            assert_eq!(err.code, "browser_timeout");
        }
        std::env::remove_var(super::super::binary::BINARY_ENV);
        let log = std::fs::read_to_string(&log_path).unwrap();
        assert_eq!(log.matches("snapshot").count(), 3);
        assert!(log.lines().last().unwrap().contains("close"), "{log}");
        bridge.with_session(&session, |ctx| {
            assert_eq!(ctx.lane.consecutive_timeouts, 0);
            assert!(!ctx.lane.launched);
            assert!(ctx.lane.active_tab.is_none());
        });
        assert!(bridge.live_session_names().is_empty());
    }
}
