//! GitHub access in a cloud workspace (PRO-14), end to end: the real
//! `terminalx-serve` boots against a fake API, installs the Git credential
//! helper and the `gh` shim, and then real `git` and the shim get tokens from
//! `/v1/cloud-workspace-bootstrap/github-token` through it.

#![cfg(unix)]

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

const TOKEN: &str = "tokentokentokentokentokentokentokentokentok";
const CREDENTIAL: &str = "credentialcredentialcredentialcredentialcre";
const BOOT_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct State {
    /// Every github-token request: (bearer, body).
    minted: Vec<(String, Value)>,
    /// Repository → the refusal the API answers for it.
    refusals: HashMap<String, (u16, &'static str)>,
}

fn start_server() -> (String, Arc<Mutex<State>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let state = Arc::new(Mutex::new(State::default()));
    let shared = state.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let state = shared.clone();
            std::thread::spawn(move || handle(stream, &state));
        }
    });
    (origin, state)
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

fn handle(stream: TcpStream, state: &Mutex<State>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let path = line.split_whitespace().nth(1).unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() {
            return;
        }
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let length: usize = headers.get("content-length").and_then(|value| value.parse().ok()).unwrap_or(0);
    let mut body = vec![0; length];
    let _ = reader.read_exact(&mut body);
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let bearer = headers.get("authorization").and_then(|value| value.strip_prefix("Bearer ")).unwrap_or_default().to_string();
    let session = json!({ "v": 1, "workspaceId": "ws_1", "organizationId": "org_1", "relayToken": "a.b.c", "relayTokenExpiresAt": 1, "directorUrl": "https://relay.invalid" });
    let (status, payload) = match path.as_str() {
        "/v1/cloud-workspace-bootstrap/redeem" if bearer == TOKEN => {
            let mut answer = session;
            answer["runtimeCredential"] = json!(CREDENTIAL);
            (200, answer)
        }
        "/v1/cloud-workspace-bootstrap/refresh" if bearer == CREDENTIAL => {
            let mut answer = session;
            answer["attachments"] = json!([]);
            answer["revocations"] = json!([]);
            (200, answer)
        }
        "/v1/cloud-workspace-bootstrap/github-token" if bearer == CREDENTIAL => {
            let mut state = state.lock().unwrap();
            state.minted.push((bearer.clone(), body.clone()));
            let repository = body["repository"].as_str().unwrap_or_default().to_string();
            match state.refusals.get(&repository) {
                Some((status, code)) => (*status, json!({ "error": code })),
                None => (
                    200,
                    json!({
                        "v": 1, "token": format!("ghs_{}", state.minted.len()), "expiresAt": now_ms() + 3_600_000,
                        "source": "github-app", "repositories": ["acme/api"],
                        "permissions": { "contents": "write", "metadata": "read", "pull_requests": "write" },
                    }),
                ),
            }
        }
        _ => (401, json!({ "error": "cloud_workspace_bootstrap_invalid" })),
    };
    let payload = payload.to_string();
    let mut stream = stream;
    let _ = write!(stream, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}", payload.len());
}

struct Vm {
    home: tempfile::TempDir,
    origin: String,
}

impl Vm {
    fn new(origin: &str) -> Self {
        // Short: the control socket path must fit in sun_path.
        let home = tempfile::Builder::new().prefix("txg").tempdir_in("/tmp").unwrap();
        for dir in ["d", "p", "shm", "real-bin"] {
            std::fs::create_dir_all(home.path().join(dir)).unwrap();
        }
        let gh = home.path().join("real-bin/gh");
        std::fs::write(&gh, "#!/bin/sh\necho \"GH_TOKEN=$GH_TOKEN args=$*\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self { home, origin: origin.to_string() }
    }

    fn path(&self, name: &str) -> PathBuf {
        std::fs::canonicalize(self.home.path()).unwrap().join(name)
    }

    fn gitconfig(&self) -> PathBuf {
        self.path("gitconfig")
    }

    /// Boot the runtime and wait for its ready line.
    fn boot(&self) -> Child {
        let token = self.path("bootstrap-token");
        std::fs::write(&token, TOKEN).unwrap();
        let path = format!("{}:{}", self.path("real-bin").display(), std::env::var("PATH").unwrap_or_default());
        let mut child = Command::new(env!("CARGO_BIN_EXE_terminalx-serve"))
            .args(["--runtime-kind", "cloud-workspace", "--project-root"])
            .arg(self.path("p"))
            .arg("--data-dir")
            .arg(self.path("d"))
            .env("TERMINALX_CLOUD_WORKSPACE_BOOTSTRAP_ORIGIN", &self.origin)
            .env("TERMINALX_CLOUD_WORKSPACE_BOOTSTRAP_TOKEN_PATH", &token)
            .env("TERMINALX_CLOUD_GRANT_DIR", self.path("shm"))
            .env("HOME", self.home.path())
            .env("GIT_CONFIG_GLOBAL", self.gitconfig())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("PATH", path)
            .env("SHELL", "/bin/sh")
            .env_remove("TERMINALX_HOME")
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if serde_json::from_str::<Value>(&line).is_ok_and(|value| value["type"] == "ready") {
                    let _ = sender.send(());
                }
            }
        });
        let started = Instant::now();
        if receiver.recv_timeout(BOOT_TIMEOUT).is_err() {
            let _ = child.kill();
            panic!("terminalx-serve did not become ready in {:?}", started.elapsed());
        }
        child
    }

    fn git_get_all(&self, key: &str) -> Vec<String> {
        let output = Command::new("git").args(["config", "--global", "--get-all", key]).env("GIT_CONFIG_GLOBAL", self.gitconfig()).output().unwrap();
        String::from_utf8(output.stdout).unwrap().lines().map(str::to_string).collect()
    }

    fn credential_fill(&self, url: &str) -> Output {
        let mut child = Command::new("git")
            .args(["credential", "fill"])
            .env("GIT_CONFIG_GLOBAL", self.gitconfig())
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ASKPASS", "/bin/false")
            .env("SSH_ASKPASS", "/bin/false")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(format!("url={url}\n\n").as_bytes()).unwrap();
        child.wait_with_output().unwrap()
    }

    fn shim_dir(&self) -> PathBuf {
        self.path("d/cloud-workspace/github-auth/bin")
    }
}

fn stop(mut child: Child) {
    let _ = Command::new("kill").arg("-TERM").arg(child.id().to_string()).status();
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn boot_installs_the_helper_and_git_and_gh_get_brokered_tokens() {
    let (origin, state) = start_server();
    let vm = Vm::new(&origin);
    // What a user's `gh auth setup-git` would have left behind.
    std::fs::write(vm.gitconfig(), "[credential \"https://github.com\"]\n\thelper = !gh auth git-credential\n").unwrap();
    let child = vm.boot();

    let helper = format!("{} credential", vm.shim_dir().join("terminalx-github-auth").display());
    assert_eq!(vm.git_get_all("credential.https://github.com.helper"), vec![String::new(), helper.clone()]);
    assert_eq!(vm.git_get_all("credential.https://github.com.usehttppath"), vec!["true"]);
    assert_eq!(vm.git_get_all("credential.https://github.com.username"), vec!["x-access-token"]);

    // Git: the repository comes from the path.
    let output = vm.credential_fill("https://github.com/acme/api.git");
    let answer = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(output.status.success(), "{answer}\n{}", String::from_utf8_lossy(&output.stderr));
    assert!(answer.contains("username=x-access-token\n") && answer.contains("password=ghs_1\n"), "{answer}");
    // Cached: a second fill does not mint again.
    let output = vm.credential_fill("https://github.com/acme/api.git");
    assert!(String::from_utf8_lossy(&output.stdout).contains("password=ghs_1\n"));
    {
        let state = state.lock().unwrap();
        assert_eq!(state.minted.len(), 1);
        assert_eq!(state.minted[0], (CREDENTIAL.to_string(), json!({ "v": 1, "repository": "acme/api" })));
    }
    // The token is in the tmpfs cache, not in the data directory or config.
    let config = std::fs::read_to_string(vm.gitconfig()).unwrap();
    assert!(!config.contains("ghs_"), "{config}");
    assert!(walk(&vm.path("d")).iter().all(|file| !std::fs::read(file).unwrap_or_default().windows(4).any(|window| window == b"ghs_")));

    // gh: the default token, in GH_TOKEN, over whatever the user set.
    // Outside a clone it asks for the workspace default.
    let output = Command::new(vm.shim_dir().join("gh")).args(["repo", "view"]).current_dir(vm.path("p")).env("GH_TOKEN", "user_token").output().unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "GH_TOKEN=ghs_2 args=repo view");
    assert_eq!(state.lock().unwrap().minted[1].1, json!({ "v": 1 }));

    // In a clone, for the repository its origin points at.
    let clone = vm.path("clone");
    assert!(Command::new("git").arg("init").arg("-q").arg(&clone).status().unwrap().success());
    assert!(Command::new("git").args(["remote", "add", "origin", "https://github.com/other-org/web.git"]).current_dir(&clone).status().unwrap().success());
    let output = Command::new(vm.shim_dir().join("gh")).args(["pr", "list"]).current_dir(&clone).env("GIT_CONFIG_GLOBAL", vm.gitconfig()).output().unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "GH_TOKEN=ghs_3 args=pr list");
    assert_eq!(state.lock().unwrap().minted[2].1, json!({ "v": 1, "repository": "other-org/web" }));

    // A refusal fails Git's credential request with the reason.
    state.lock().unwrap().refusals.insert("acme/gone".into(), (409, "github_installation_revoked"));
    let output = vm.credential_fill("https://github.com/acme/gone.git");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("password="));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("github_installation_revoked") && stderr.contains("acme/gone"), "{stderr}");

    // Another host is not ours to answer.
    let output = vm.credential_fill("https://gitlab.com/acme/api.git");
    assert!(!String::from_utf8_lossy(&output.stdout).contains("password="));
    assert_eq!(state.lock().unwrap().minted.len(), 4);

    // The next boot installs again, idempotently, and starts from an empty
    // cache.
    stop(child);
    let child = vm.boot();
    assert_eq!(vm.git_get_all("credential.https://github.com.helper"), vec![String::new(), helper]);
    let output = vm.credential_fill("https://github.com/acme/api.git");
    assert!(String::from_utf8_lossy(&output.stdout).contains("password=ghs_5\n"));
    stop(child);
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() && !path.is_symlink() {
            out.extend(walk(&path));
        } else if path.is_file() {
            out.push(path);
        }
    }
    out
}
