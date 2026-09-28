//! A `terminalx-serve` whose `claude` is `scripts/remote-runtime/fake-claude`,
//! with its home, data directory and project in throwaway directories, and
//! a client for its control socket.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// Deadline for anything the fake agent does; generous for a slow CI runner.
pub const AGENT_WAIT: Duration = Duration::from_secs(60);

/// Throwaway directories shared by every launch of one runtime, so a restart
/// finds the same data directory, home and project.
pub struct AgentWorld {
    _dir: tempfile::TempDir,
    pub home: PathBuf,
    pub data: PathBuf,
    pub project: PathBuf,
    pub bin: PathBuf,
}

impl AgentWorld {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        // Canonical, so the transcript path the harness derives from the
        // project and the one the fake CLI derives from its cwd agree
        // (`/var` is `/private/var` on macOS).
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let (home, data, project, bin) = (root.join("home"), root.join("data"), root.join("project"), root.join("bin"));
        for path in [&home, &data, &project, &bin] {
            std::fs::create_dir_all(path).unwrap();
        }
        let fake = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/remote-runtime/fake-claude");
        std::os::unix::fs::symlink(std::fs::canonicalize(fake).unwrap(), bin.join("claude")).unwrap();
        std::fs::write(project.join("README.md"), "fake agent project\n").unwrap();
        for args in [
            &["init", "-q", "-b", "main"][..],
            &["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."][..],
            &["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"][..],
        ] {
            assert!(Command::new("git").args(args).current_dir(&project).status().unwrap().success());
        }
        Self { _dir: dir, home, data, project, bin }
    }

    /// The runtime's environment: the fake `claude` first on PATH, and a
    /// home of its own so nothing reads or writes the reader's `~/.claude`.
    pub fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_terminalx-serve"));
        let path = format!("{}:{}", self.bin.display(), std::env::var("PATH").unwrap_or_default());
        command
            .arg("--project-root")
            .arg(&self.project)
            .arg("--data-dir")
            .arg(&self.data)
            .env("HOME", &self.home)
            .env("PATH", path)
            .env("CLAUDE_CONFIG_DIR", self.home.join(".claude"))
            .env_remove("TERMINALX_HOME")
            .env_remove("ANTHROPIC_API_KEY")
            .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
            .env("RUST_LOG", "info")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        command
    }
}

/// One running runtime, its JSON stdout lines and its control socket.
pub struct Serve {
    pub child: Child,
    pub lines: Arc<Mutex<Vec<Value>>>,
    pub socket: PathBuf,
    pub token: String,
}

impl Serve {
    pub fn start(mut command: Command, data: &Path) -> Self {
        let mut child = command.spawn().expect("start terminalx-serve");
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        let stdout = child.stdout.take().unwrap();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    sink.lock().unwrap().push(value);
                }
            }
        });
        let ready = wait_until("the ready line", || lines.lock().unwrap().iter().find(|line| line["type"] == "ready").cloned());
        let socket = PathBuf::from(ready["socket"].as_str().expect("ready names the socket"));
        let token = std::fs::read_to_string(data.join("run").join("control.token")).unwrap().trim().to_string();
        Self { child, lines, socket, token }
    }

    pub fn control(&self, command: &str, params: Value) -> Value {
        let mut stream = UnixStream::connect(&self.socket).expect("connect the control socket");
        stream.set_read_timeout(Some(AGENT_WAIT)).unwrap();
        let request = json!({ "id": "t", "token": self.token, "command": command, "params": params });
        stream.write_all(format!("{request}\n").as_bytes()).unwrap();
        let mut line = String::new();
        BufReader::new(stream).read_line(&mut line).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap_or_else(|_| panic!("{command}: {line:?}"));
        assert_eq!(response["ok"], true, "{command} failed: {response}");
        response["result"].clone()
    }

    pub fn events(&self, tab: &str) -> Vec<Value> {
        self.control("read", json!({ "target": tab }))["events"].as_array().cloned().unwrap_or_default()
    }

    /// Poll the tab's committed events until `done` holds.
    pub fn wait_events(&self, tab: &str, what: &str, done: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        wait_until(what, || {
            let events = self.events(tab);
            done(&events).then_some(events)
        })
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for Serve {
    fn drop(&mut self) {
        unsafe {
            kill(self.child.id() as i32, 15);
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.kill();
    }
}

extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

pub fn wait_until<T>(what: &str, mut check: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + AGENT_WAIT;
    loop {
        if let Some(found) = check() {
            return found;
        }
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// The payload types of a tab's events, in order.
pub fn kinds(events: &[Value]) -> Vec<String> {
    events.iter().map(|event| event["payload"]["type"].as_str().unwrap_or("").to_string()).collect()
}

pub fn texts(events: &[Value], kind: &str) -> Vec<String> {
    events
        .iter()
        .filter(|event| event["payload"]["type"] == kind)
        .map(|event| event["payload"]["text"].as_str().unwrap_or("").to_string())
        .collect()
}

pub fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|event| event["payload"]["type"] == kind).count()
}
