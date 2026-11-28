//! Short-lived idle-pooled `codex app-server` JSON-RPC client.
//!
//! Three things the app needs are only knowable by asking the CLI itself:
//! which models this account may run, the hash Codex computes for a hook, and
//! the signed-in account's rate-limit windows. The usage surface also redeems
//! a user-confirmed reset credit through the protocol. None is worth
//! reimplementing — the same binary is asked over the JSON-RPC it already
//! speaks on stdio. Processes are pooled briefly per `(program, CODEX_HOME, cwd)`
//! to avoid cold-spawning on every 60s usage/readiness poll, and reaped once
//! idle or whenever auth/config metadata changes.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

/// A cold `codex app-server` takes a moment to come up; past this the answer
/// is not worth blocking a picker (or a tab starting) for.
pub const TIMEOUT: Duration = Duration::from_secs(15);

/// Keep warm app-servers around slightly longer than the 60s usage cadence so
/// steady-state polling avoids cold-spawning, then reap idle processes.
const IDLE_TTL: Duration = Duration::from_secs(90);
const MAX_POOLED: usize = 8;

/// Where the server should run and whose home it should read.
#[derive(Default)]
pub struct Where<'a> {
    pub codex_home: Option<&'a Path>,
    pub cwd: Option<&'a Path>,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct PoolKey {
    program: PathBuf,
    codex_home: Option<PathBuf>,
    cwd: Option<PathBuf>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileStamp {
    modified: Option<SystemTime>,
    len: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct HomeStamp {
    auth: Option<FileStamp>,
    config: Option<FileStamp>,
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some(FileStamp { modified: meta.modified().ok(), len: meta.len() })
}

fn home_stamp(codex_home: Option<&Path>) -> HomeStamp {
    let root = codex_home.map(Path::to_path_buf).or_else(super::home::user_root);
    match root {
        Some(dir) => HomeStamp {
            auth: file_stamp(&dir.join("auth.json")),
            config: file_stamp(&dir.join("config.toml")),
        },
        None => HomeStamp { auth: None, config: None },
    }
}

struct LiveServer {
    child: Child,
    pid: u32,
    stdin: ChildStdin,
    rx: std::sync::mpsc::Receiver<String>,
    next_id: u64,
    initialized: bool,
    /// True once the child has answered JSON-RPC `initialize` (`id: 1`).
    /// Real `codex app-server` processes always answer `initialize` and handle
    /// multiple requests; one-shot test fixtures that only print a canned
    /// `id: 2` reply are not pooled.
    saw_init_reply: bool,
    stamp: HomeStamp,
    last_used: Instant,
}

impl LiveServer {
    fn spawn(key: &PoolKey, stamp: HomeStamp) -> Result<Self> {
        let mut cmd = Command::new(&key.program);
        cmd.arg("app-server")
            .env("PATH", crate::binpath::login_path())
            .env("TERM", "dumb")
            .env("NO_COLOR", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(home) = key.codex_home.as_deref() {
            cmd.env("CODEX_HOME", home);
        }
        if let Some(cwd) = key.cwd.as_deref() {
            cmd.current_dir(cwd);
        }
        // Its own group, so terminating it takes any helper it forked with it.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().with_context(|| format!("spawn {}", key.program.display()))?;
        let pid = child.id();
        let stdin = child.stdin.take().context("no stdin")?;
        let stdout = child.stdout.take().context("no stdout")?;
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::Builder::new().name("codex-app-server".into()).spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        })?;
        Ok(Self {
            child,
            pid,
            stdin,
            rx,
            next_id: 2,
            initialized: false,
            saw_init_reply: false,
            stamp,
            last_used: Instant::now(),
        })
    }

    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn call(&mut self, method: &str, params: &Value, timeout: Duration) -> std::result::Result<Value, CallError> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        if !self.initialized {
            let hello = json!({"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "raccoon", "title": "TerminalX", "version": env!("CARGO_PKG_VERSION")}}});
            writeln!(self.stdin, "{hello}").map_err(CallError::Io)?;
            writeln!(self.stdin, "{}", json!({"method": "initialized", "params": {}})).map_err(CallError::Io)?;
            self.initialized = true;
        }
        writeln!(self.stdin, "{}", json!({"id": id, "method": method, "params": params})).map_err(CallError::Io)?;
        self.stdin.flush().map_err(CallError::Io)?;

        let deadline = Instant::now() + timeout;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(CallError::Timeout);
            }
            let line = match self.rx.recv_timeout(left) {
                Ok(line) => line,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => return Err(CallError::Timeout),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Err(CallError::Closed),
            };
            let v: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if v.get("id").and_then(Value::as_u64) == Some(1) {
                self.saw_init_reply = true;
                continue;
            }
            if v.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            self.last_used = Instant::now();
            if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
                return Err(CallError::Rpc(err.get("message").and_then(Value::as_str).unwrap_or("request failed").to_owned()));
            }
            return Ok(v["result"].clone());
        }
    }
}

impl Drop for LiveServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        crate::harness::host::terminate(self.pid);
    }
}

enum CallError {
    Io(std::io::Error),
    Closed,
    Timeout,
    Rpc(String),
}

struct Pool {
    entries: Mutex<HashMap<PoolKey, Arc<Mutex<Option<LiveServer>>>>>,
    reaper_running: Mutex<bool>,
    reaper_wake: Condvar,
}

impl Pool {
    fn global() -> &'static Arc<Self> {
        static POOL: OnceLock<Arc<Pool>> = OnceLock::new();
        POOL.get_or_init(|| Arc::new(Pool {
            entries: Mutex::new(HashMap::new()),
            reaper_running: Mutex::new(false),
            reaper_wake: Condvar::new(),
        }))
    }

    fn slot(&self, key: PoolKey) -> Arc<Mutex<Option<LiveServer>>> {
        let mut map = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = map.get(&key) {
            return existing.clone();
        }
        if map.len() >= MAX_POOLED {
            // Evict any idle/empty slot, or the oldest unused one we can lock without blocking.
            let mut oldest: Option<(PoolKey, Instant)> = None;
            let mut empty_keys = Vec::new();
            for (k, slot) in map.iter() {
                if let Ok(guard) = slot.try_lock() {
                    match guard.as_ref() {
                        None => empty_keys.push(k.clone()),
                        Some(srv) => {
                            if oldest.as_ref().is_none_or(|(_, t)| srv.last_used < *t) {
                                oldest = Some((k.clone(), srv.last_used));
                            }
                        }
                    }
                }
            }
            for k in empty_keys {
                map.remove(&k);
            }
            if map.len() >= MAX_POOLED {
                if let Some((evict_key, _)) = oldest {
                    map.remove(&evict_key);
                }
            }
        }
        let slot = Arc::new(Mutex::new(None));
        map.insert(key, slot.clone());
        drop(map);
        self.ensure_reaper();
        slot
    }

    fn ensure_reaper(&self) {
        let mut running = self.reaper_running.lock().unwrap_or_else(|e| e.into_inner());
        if *running {
            self.reaper_wake.notify_one();
            return;
        }
        *running = true;
        let pool = Self::global().clone();
        let _ = std::thread::Builder::new().name("codex-appserver-reaper".into()).spawn(move || {
            let mut running = pool.reaper_running.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                let (guard, _) = pool.reaper_wake.wait_timeout(running, Duration::from_secs(15)).unwrap_or_else(|e| e.into_inner());
                running = guard;
                let mut map = pool.entries.lock().unwrap_or_else(|e| e.into_inner());
                map.retain(|_, slot| {
                    if let Ok(mut srv_guard) = slot.try_lock() {
                        if let Some(srv) = srv_guard.as_mut() {
                            if srv.last_used.elapsed() >= IDLE_TTL || !srv.is_alive() {
                                *srv_guard = None;
                            }
                        }
                        // Keep slot only while it still holds a live server or has active callers.
                        srv_guard.is_some() || Arc::strong_count(slot) > 1
                    } else {
                        true
                    }
                });
                if map.is_empty() {
                    *running = false;
                    return;
                }
            }
        });
    }
}

/// Ask one method and return its `result`. Everything is sent at once — the
/// server ignores anything before `initialize` and answers in whatever order
/// it likes — and the reply is matched by id.
pub fn ask(place: Where<'_>, method: &str, params: Value) -> Result<Value> {
    ask_with_timeout(place, method, params, TIMEOUT)
}

/// Ask one method with a caller-owned deadline. Interactive mutations can
/// take longer than the short reads used by model and usage refreshes.
pub fn ask_with_timeout(place: Where<'_>, method: &str, params: Value, timeout: Duration) -> Result<Value> {
    let program = super::pty::program().context("codex is not installed")?;
    ask_program_with_timeout(program, place, method, params, timeout)
}

fn ask_program_with_timeout(program: PathBuf, place: Where<'_>, method: &str, params: Value, timeout: Duration) -> Result<Value> {
    let key = PoolKey {
        program,
        codex_home: place.codex_home.map(Path::to_path_buf),
        cwd: place.cwd.map(Path::to_path_buf),
    };
    let stamp = home_stamp(place.codex_home);
    let slot = Pool::global().slot(key.clone());
    let mut guard = slot.lock().unwrap_or_else(|e| e.into_inner());

    // Try reusing an existing warm server if it is still alive and config/auth did not change.
    let mut reused = false;
    if let Some(srv) = guard.as_mut() {
        if srv.last_used.elapsed() >= IDLE_TTL || srv.stamp != stamp || !srv.is_alive() {
            *guard = None;
        } else {
            reused = true;
        }
    }

    if reused {
        let result = guard.as_mut().unwrap().call(method, &params, timeout);
        match result {
            Ok(value) => return Ok(value),
            Err(CallError::Rpc(msg)) => {
                // Keep the server alive if it is still healthy after a normal RPC error.
                if !guard.as_mut().unwrap().is_alive() {
                    *guard = None;
                }
                bail!("{msg}");
            }
            Err(CallError::Timeout) => {
                *guard = None;
                bail!("timed out after {}s", timeout.as_secs());
            }
            Err(CallError::Io(_) | CallError::Closed) => {
                // Warm server died between requests (or was a one-shot fixture); retry once fresh.
                *guard = None;
            }
        }
    }

    let mut fresh = LiveServer::spawn(&key, stamp)?;
    match fresh.call(method, &params, timeout) {
        Ok(value) => {
            if fresh.saw_init_reply && fresh.is_alive() {
                *guard = Some(fresh);
            }
            Ok(value)
        }
        Err(CallError::Rpc(msg)) => {
            if fresh.saw_init_reply && fresh.is_alive() {
                *guard = Some(fresh);
            }
            bail!("{msg}");
        }
        Err(CallError::Timeout) => bail!("timed out after {}s", timeout.as_secs()),
        Err(CallError::Closed) => bail!("codex app-server closed without answering"),
        Err(CallError::Io(e)) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn reuses_warm_app_server_across_requests_for_same_home() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codex-home");
        std::fs::create_dir_all(&home).unwrap();
        let spawns = dir.path().join("spawns.log");
        let script = dir.path().join("codex");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n\
                 printf 'spawn\\n' >> '{}'\n\
                 while IFS= read -r line; do\n\
                   id=$(printf '%s' \"$line\" | sed -n 's/.*\"id\":\\([0-9]*\\).*/\\1/p')\n\
                   case \"$line\" in\n\
                     *'\"method\":\"initialize\"'*) printf '{{\"id\":1,\"result\":{{}}}}\\n' ;;\n\
                     *'\"method\":\"account/read\"'*) printf '{{\"id\":%s,\"result\":{{\"ok\":true,\"id\":%s}}}}\\n' \"$id\" \"$id\" ;;\n\
                   esac\n\
                 done\n",
                spawns.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let r1 = ask_program_with_timeout(script.clone(), Where { codex_home: Some(&home), cwd: None }, "account/read", json!({}), Duration::from_secs(5)).unwrap();
        let r2 = ask_program_with_timeout(script, Where { codex_home: Some(&home), cwd: None }, "account/read", json!({}), Duration::from_secs(5)).unwrap();
        assert_eq!(r1["ok"], true);
        assert_eq!(r2["ok"], true);
        let count = std::fs::read_to_string(&spawns).unwrap().lines().count();
        assert_eq!(count, 1, "expected second request to reuse warm app-server, got {count} spawns");
    }
}
