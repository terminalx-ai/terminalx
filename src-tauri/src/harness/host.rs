//! Child process host: spawn an agent CLI with piped stdio, stream its lines,
//! and never let a dead or superseded child be mistaken for the live one.
//!
//! Each spawn carries an epoch (per key) and the global kill generation. After
//! the fork returns, both are re-checked; if either moved — a kill or a newer
//! spawn won the race — the fresh child is terminated and the caller gets an
//! error without a single line being delivered. Exits are reported with the
//! pid so a late exit from an old child can be told apart from the current one.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};

pub struct LiveChild {
    pub pid: u32,
    pub epoch: u64,
    stdin: Mutex<Option<ChildStdin>>,
}

impl LiveChild {
    pub fn write_line(&self, line: &str) -> Result<()> {
        let mut guard = self.stdin.lock().unwrap_or_else(|e| e.into_inner());
        let stdin = guard.as_mut().context("child stdin closed")?;
        stdin.write_all(line.as_bytes())?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(())
    }
    pub fn close_stdin(&self) {
        let mut guard = self.stdin.lock().unwrap_or_else(|e| e.into_inner());
        guard.take();
    }
}

/// What a spawn wants to be told about its child.
pub trait Sink: Send + Sync + 'static {
    fn stdout_line(&self, line: String);
    fn stderr_line(&self, line: String);
    fn exited(&self, pid: u32, code: Option<i32>);
}

type ChildMap = Arc<Mutex<HashMap<String, Arc<LiveChild>>>>;

#[derive(Default)]
pub struct Host {
    children: ChildMap,
    epochs: Mutex<HashMap<String, u64>>,
    kill_gen: AtomicU64,
}

pub struct SpawnSpec<'a> {
    pub program: &'a Path,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub env: &'a [(String, String)],
}

impl Host {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &str) -> Option<Arc<LiveChild>> {
        self.children.lock().unwrap().get(key).cloned()
    }

    fn bump_epoch(&self, key: &str) -> u64 {
        let mut e = self.epochs.lock().unwrap();
        let v = e.entry(key.to_string()).or_insert(0);
        *v += 1;
        *v
    }

    /// Spawn a child for `key`, evicting any previous one.
    pub fn spawn(&self, key: &str, spec: SpawnSpec<'_>, sink: Arc<dyn Sink>) -> Result<Arc<LiveChild>> {
        if let Some(old) = self.children.lock().unwrap().remove(key) {
            terminate(old.pid);
        }
        let epoch = self.bump_epoch(key);
        let gen = self.kill_gen.load(Ordering::SeqCst);

        let mut cmd = Command::new(spec.program);
        cmd.args(spec.args)
            .current_dir(spec.cwd)
            .env("PATH", crate::binpath::login_path())
            .env("TERM", "dumb")
            .env("NO_COLOR", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in spec.env {
            cmd.env(k, v);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().with_context(|| format!("spawn {}", spec.program.display()))?;
        let pid = child.id();

        // A kill or a newer spawn may have raced the fork.
        let stale = self.kill_gen.load(Ordering::SeqCst) != gen
            || self.epochs.lock().unwrap().get(key).copied() != Some(epoch);
        if stale {
            terminate(pid);
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            bail!("start was cancelled");
        }

        let stdout = child.stdout.take().context("no stdout")?;
        let stderr = child.stderr.take().context("no stderr")?;
        let stdin = child.stdin.take().context("no stdin")?;
        let live = Arc::new(LiveChild { pid, epoch, stdin: Mutex::new(Some(stdin)) });
        self.children.lock().unwrap().insert(key.to_string(), live.clone());

        {
            let sink = sink.clone();
            std::thread::Builder::new().name(format!("stdout-{key}")).spawn(move || {
                let reader = BufReader::with_capacity(1 << 16, stdout);
                for line in reader.split(b'\n').flatten() {
                    let s = String::from_utf8_lossy(&line).trim_end_matches('\r').to_string();
                    if !s.is_empty() {
                        sink.stdout_line(s);
                    }
                }
            })?;
        }
        {
            let sink = sink.clone();
            std::thread::Builder::new().name(format!("stderr-{key}")).spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines().map_while(Result::ok) {
                    sink.stderr_line(line);
                }
            })?;
        }
        {
            let key = key.to_string();
            let children = self.children.clone();
            std::thread::Builder::new().name(format!("wait-{key}")).spawn(move || {
                let code = wait_child(child);
                // Only forget the child if it is still the one registered.
                let mut map = children.lock().unwrap();
                if map.get(&key).map(|c| c.pid) == Some(pid) {
                    map.remove(&key);
                }
                drop(map);
                sink.exited(pid, code);
            })?;
        }
        Ok(live)
    }

    pub fn kill(&self, key: &str) {
        if let Some(c) = self.children.lock().unwrap().remove(key) {
            c.close_stdin();
            terminate(c.pid);
        }
    }

    pub fn kill_all(&self) {
        self.kill_gen.fetch_add(1, Ordering::SeqCst);
        let all: Vec<Arc<LiveChild>> = self.children.lock().unwrap().drain().map(|(_, c)| c).collect();
        for c in all {
            c.close_stdin();
            terminate(c.pid);
        }
    }

    pub fn is_live(&self, key: &str) -> bool {
        self.children.lock().unwrap().contains_key(key)
    }
}

fn wait_child(mut child: Child) -> Option<i32> {
    child.wait().ok().and_then(|s| s.code())
}

/// SIGTERM the group and the pid, then SIGKILL whatever is left after 2s. The
/// group goes first: looking it up through a dead leader would lose
/// descendants that ignored the first signal.
pub fn terminate(pid: u32) {
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
            libc::kill(pid as i32, libc::SIGTERM);
        }
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
                libc::kill(pid as i32, libc::SIGKILL);
            }
        });
    }
    #[cfg(not(unix))]
    {
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).output();
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        self.kill_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    struct S(Mutex<mpsc::Sender<String>>);
    impl Sink for S {
        fn stdout_line(&self, line: String) {
            let _ = self.0.lock().unwrap().send(format!("out:{line}"));
        }
        fn stderr_line(&self, line: String) {
            let _ = self.0.lock().unwrap().send(format!("err:{line}"));
        }
        fn exited(&self, _pid: u32, code: Option<i32>) {
            let _ = self.0.lock().unwrap().send(format!("exit:{code:?}"));
        }
    }

    #[test]
    fn echo_round_trip_and_exit() {
        let host = Host::new();
        let (tx, rx) = mpsc::channel();
        let sink = Arc::new(S(Mutex::new(tx)));
        let args = vec!["-c".to_string(), "read l; echo got:$l; echo oops 1>&2; exit 3".to_string()];
        let child = host
            .spawn("k", SpawnSpec { program: Path::new("/bin/sh"), args: &args, cwd: Path::new("/"), env: &[] }, sink)
            .unwrap();
        child.write_line("hello").unwrap();
        let mut got = Vec::new();
        for _ in 0..3 {
            got.push(rx.recv_timeout(Duration::from_secs(5)).unwrap());
        }
        assert!(got.contains(&"out:got:hello".to_string()));
        assert!(got.contains(&"err:oops".to_string()));
        assert!(got.contains(&"exit:Some(3)".to_string()));
        std::thread::sleep(Duration::from_millis(50));
        assert!(!host.is_live("k"));
    }

    #[test]
    fn respawn_evicts_previous() {
        let host = Host::new();
        let (tx, rx) = mpsc::channel();
        let sink = Arc::new(S(Mutex::new(tx)));
        let args = vec!["-c".to_string(), "sleep 30".to_string()];
        let a = host
            .spawn("k", SpawnSpec { program: Path::new("/bin/sh"), args: &args, cwd: Path::new("/"), env: &[] }, sink.clone())
            .unwrap();
        let b = host
            .spawn("k", SpawnSpec { program: Path::new("/bin/sh"), args: &args, cwd: Path::new("/"), env: &[] }, sink)
            .unwrap();
        assert_ne!(a.pid, b.pid);
        assert_eq!(host.get("k").unwrap().pid, b.pid);
        // The first child's exit must not evict the second.
        let msg = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(msg.starts_with("exit:"), "{msg}");
        assert_eq!(host.get("k").map(|c| c.pid), Some(b.pid));
        host.kill_all();
    }
}
