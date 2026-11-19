//! Several machines on one host (PRO-358): the operating computer's own
//! runtime ("this Mac"), a second runtime as a machine ("Mac mini"), and a
//! headless Linux runtime in a container ("dev-server"), each in its own
//! process with its own data directory.
//!
//! - **This Mac** is the operating computer's local runtime: one project, the
//!   switch "Let other computers operate this Mac" off. Nothing the scenarios
//!   do may reach it.
//! - **Mac mini** is a second `terminalx-serve` in machine mode (no
//!   `--project-root`) with two projects and hosting on. It runs as its
//!   headless, with a file-owned host key. Guarded requests are sent by a
//!   helper in its own controlling terminal, with a consent witness.
//! - **dev-server** is `terminalx-serve` in a Linux container
//!   (`scripts/machine-e2e/Dockerfile`), headless, one project added with
//!   `terminalx-serve projects add`. It is paired the way a person pairs a
//!   server: `terminalx-serve pair` in a terminal on it (`docker exec -it`),
//!   answered `y`.
//!
//! The container needs the image named by [`LINUX_IMAGE`]. Without it the
//! dev-server is left out with a message, unless [`REQUIRE_LINUX`] is `1`
//! (CI), where its absence is a failure, never a skip. A named image that
//! cannot start is always a failure.
//!
//! The container sees the test's directories at the same absolute paths
//! (bind mounts of the world's temporary root, the binary and
//! `scripts/remote-runtime`), runs as this user's uid and gid, and publishes
//! its machine host port on 127.0.0.1. So the paths in its `ready` line, its
//! control socket and token, and its project ids are the same on both sides.
//!
//! The operating computer is the desktop's own code: the pairing client
//! (`raccoon_lib::machine_pair`, `src-tauri/src/machines/pair.rs`) and the
//! machine supervisor (`remote::machine_client::MachineSupervisor`), driven
//! here through [`Link`].

use std::io::{Read, Write};
use std::os::fd::{FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use raccoon_lib::machine_pair::{self as pair, Failure};
use raccoon_lib::machine_wire::{MachineCode, MachineIdentity};
use raccoon_lib::remote::client::{ClientEvent, ClientState};
use raccoon_lib::remote::machine_client::{
    MachineConnectionState, MachineConnectionView, MachineEnv, MachineRoute, MachineSupervisor, NetDialer, OnState, RelayCredential, RouteUsed, Target, Zeroizing,
};
use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

use super::agent::{wait_until, AgentWorld, Serve, AGENT_WAIT};
use super::machine::{free_port, listening, status};

/// The container image the dev-server runs in (`scripts/machine-e2e/run.py`
/// builds it as `terminalx-machine-e2e:local`).
pub const LINUX_IMAGE: &str = "TERMINALX_E2E_LINUX_IMAGE";
/// `1`: the dev-server must run; a missing image fails the test (CI).
pub const REQUIRE_LINUX: &str = "TERMINALX_E2E_REQUIRE_LINUX";

/// The operating computer's long-lived client key, one per installation: the
/// same on every connection to every machine (docs/MACHINES.md, PRO-342).
pub const OPERATOR_KEY: [u8; 32] = [7; 32];
/// Another computer's key: one that never paired.
pub const OTHER_KEY: [u8; 32] = [99; 32];
/// A third computer's key, for the declined approval.
pub const THIRD_KEY: [u8; 32] = [123; 32];
/// The name the operating computer gives in `e2ee_auth`.
pub const OPERATOR_LABEL: &str = "Test MacBook";

/// How long a test waits for the machine's answer to a pairing.
pub const PAIRING_WAIT: Duration = Duration::from_secs(150);

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git").args(args).current_dir(dir).output().expect("run git");
    assert!(output.status.success(), "git {args:?} in {}: {}", dir.display(), String::from_utf8_lossy(&output.stderr));
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// A Git project with one commit, as a person's checkout is.
pub fn git_project(path: &Path, readme: &str) -> PathBuf {
    std::fs::create_dir_all(path).unwrap();
    std::fs::write(path.join("README.md"), readme).unwrap();
    git(path, &["init", "-q", "-b", "main"]);
    git(path, &["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."]);
    git(path, &["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"]);
    std::fs::canonicalize(path).unwrap()
}

/// The projects registered in a machine's store.
fn register_projects(data: &Path, projects: &[&Path]) {
    let projects: Vec<Value> = projects
        .iter()
        .map(|path| json!({ "path": path.to_string_lossy(), "name": path.file_name().unwrap().to_string_lossy(), "kind": "git" }))
        .collect();
    std::fs::write(data.join("projects.json"), json!({ "projects": projects }).to_string()).unwrap();
}

/// The temporary root every directory of `world` is in.
fn root_of(world: &AgentWorld) -> PathBuf {
    world.data.parent().expect("the world's data directory has a parent").to_path_buf()
}

/// `projectId` of a project path, as the machine derives it.
pub fn project_id(path: &Path) -> String {
    raccoon_lib::remote::machine::project_id(&path.to_string_lossy())
}

// ---------------------------------------------------------------- this Mac

/// The operating computer's own runtime: one project, hosting off.
pub struct ThisMac {
    pub world: AgentWorld,
    pub serve: Serve,
    pub port: u16,
    pub project_id: String,
    head: String,
    projects_json: Vec<u8>,
}

impl ThisMac {
    pub fn start() -> Self {
        let world = AgentWorld::new();
        register_projects(&world.data, &[&world.project]);
        // A port of its own, so a host that wrongly turned on could be seen.
        let port = free_port();
        let mut command = world.machine_command();
        command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string());
        // Nothing attaches to this runtime, and one with nothing attached
        // stops itself after its idle grace: 60 seconds by default, which the
        // scenario now outlasts, so `assert_untouched` found its control
        // socket gone. It is asked at the end, however long that takes.
        command.args(["--idle-grace-seconds", "3600"]);
        let serve = Serve::start(command, &world.data);
        let head = git(&world.project, &["rev-parse", "HEAD"]);
        let projects_json = std::fs::read(world.data.join("projects.json")).unwrap();
        let project_id = project_id(&world.project);
        Self { world, serve, port, project_id, head, projects_json }
    }

    /// Nothing the scenarios did reached this Mac: it hosts nothing, no
    /// computer is paired with it, no session was made on it, and its
    /// project and project list are as they were.
    pub fn assert_untouched(&self) {
        let host = status(&self.serve);
        assert_eq!(host["enabled"], false, "this Mac's switch stays off: {host}");
        assert!(host["listening"].is_null(), "this Mac never listened: {host}");
        assert!(host["computers"].as_array().is_none_or(Vec::is_empty), "no computer is paired with this Mac: {host}");
        assert!(std::net::TcpStream::connect(("127.0.0.1", self.port)).is_err(), "nothing listens on this Mac's machine port");
        assert!(!self.world.data.join("machine-host/paired-computers.json").exists(), "this Mac has no paired-computer registry");
        let listed = self.serve.control("sessions.list", json!({}));
        let sessions = listed.as_array().or_else(|| listed["sessions"].as_array()).unwrap_or_else(|| panic!("sessions.list on this Mac: {listed}"));
        assert!(sessions.is_empty(), "no session was made on this Mac: {listed}");
        assert_eq!(git(&self.world.project, &["rev-parse", "HEAD"]), self.head, "this Mac's project has no new commit");
        assert_eq!(git(&self.world.project, &["status", "--porcelain"]), "", "this Mac's project has no changes");
        assert_eq!(std::fs::read(self.world.data.join("projects.json")).unwrap(), self.projects_json, "this Mac's project list is as it was");
    }
}

// ---------------------------------------------------------------- Mac mini

/// A second headless runtime as a machine: two projects and hosting on.
pub struct MacMini {
    pub world: AgentWorld,
    pub serve: Serve,
    pub port: u16,
    /// Its two projects, canonical: `world.project` and `web`.
    pub projects: Vec<PathBuf>,
}

impl MacMini {
    pub fn start() -> Self {
        let world = AgentWorld::new();
        let web = git_project(&root_of(&world).join("web"), "the web project\n");
        let projects = vec![world.project.clone(), web];
        register_projects(&world.data, &[&projects[0], &projects[1]]);
        std::fs::write(world.data.join("settings.json"), json!({ "machineName": "Mac mini", "machines": { "allowOperating": true } }).to_string()).unwrap();
        let port = free_port();
        let mut command = world.machine_command();
        command.env("TERMINALX_MACHINE_HOST_PORT", port.to_string());
        let serve = Serve::start(command, &world.data);
        let address = listening(&serve);
        assert!(address.ends_with(&format!(":{port}")), "Mac mini listens on {address}, not port {port}");
        Self { world, serve, port, projects }
    }

    pub fn endpoint(&self) -> String {
        format!("ws://127.0.0.1:{}/machine/1", self.port)
    }

    pub fn project_ids(&self) -> Vec<String> {
        self.projects.iter().map(|path| project_id(path)).collect()
    }

    /// A runtime IPC command with a fresh attachment. Guarded commands run
    /// in an independent controlling terminal, like a headless person.
    pub fn person(&self, command: &str, extra: Value) -> Value {
        let attached = self.serve.control("runtime.attach", json!({ "protocol": 1 }));
        let mut params = json!({ "epoch": attached["epoch"], "lease": attached["lease"] });
        for (name, value) in extra.as_object().expect("request params are an object") {
            params[name] = value.clone();
        }
        if !raccoon_lib::serve_cli::consent::guards(command) {
            return self.serve.try_control(command, params);
        }
        let mut helper = Command::new(std::env::current_exe().unwrap());
        helper.args(["--exact", "terminal_consent_helper", "--nocapture"])
            .env("TX_E2E_SOCKET", &self.serve.socket)
            .env("TX_E2E_TOKEN", &self.serve.token)
            .env("TX_E2E_RUN", self.world.data.join("run"))
            .env("TX_E2E_COMMAND", command)
            .env("TX_E2E_PARAMS", params.to_string());
        let mut terminal = Terminal::start(helper);
        assert_eq!(terminal.exit_code(), 0, "terminal helper failed: {}", terminal.screen());
        let screen = terminal.wait_for("test result:");
        let response = screen.lines().find_map(|line| line.split_once("TX_E2E_RESPONSE ").map(|(_, value)| value)).expect("terminal helper response");
        serde_json::from_str(response).expect("terminal helper returned JSON")
    }

    fn person_ok(&self, command: &str, extra: Value) -> Value {
        let response = self.person(command, extra);
        assert_eq!(response["ok"], true, "Mac mini's person: {command} failed: {response}");
        response["result"].clone()
    }

    /// Create a pairing code for this machine.
    pub fn create_code(&self) -> MachineCode {
        let created = self.person_ok("runtime.machineHost.createCode", json!({}));
        let code = created["code"].as_str().unwrap_or_else(|| panic!("createCode answered no code: {created}"));
        MachineCode::decode(code).unwrap_or_else(|error| panic!("Mac mini's code does not decode ({error:#}): {code}"))
    }

    /// The pending approval, once a computer asks.
    pub fn pending(&self) -> Value {
        wait_until("a computer to ask Mac mini for approval", || status(&self.serve)["pending"].as_object().map(|pending| Value::Object(pending.clone())))
    }

    pub fn approve(&self, request_id: &str) {
        let approved = self.person_ok("runtime.machineHost.approve", json!({ "requestId": request_id }));
        assert_eq!(approved["approved"], true, "{approved}");
    }

    pub fn decline(&self, request_id: &str) {
        let declined = self.person_ok("runtime.machineHost.decline", json!({ "requestId": request_id }));
        assert_eq!(declined["declined"], true, "{declined}");
    }

    pub fn revoke(&self, id: &str) {
        let revoked = self.person_ok("runtime.machineHost.revoke", json!({ "id": id }));
        assert_eq!(revoked["revoked"], true, "Mac mini revoked {id}: {revoked}");
    }

    pub fn computers(&self) -> Vec<Value> {
        status(&self.serve)["computers"].as_array().cloned().unwrap_or_default()
    }

    /// `git <args>` in one of its projects, on its own disk.
    pub fn git(&self, project: &Path, args: &[&str]) -> String {
        git(project, args)
    }

    pub fn read(&self, path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_else(|error| panic!("read {} on Mac mini: {error}", path.display()))
    }
}

// ---------------------------------------------------------------- dev-server

/// The image named for the dev-server, or `None` when it is left out.
/// Panics when [`REQUIRE_LINUX`] asks for it and none is named.
pub fn linux_image() -> Option<String> {
    let image = std::env::var(LINUX_IMAGE).ok().filter(|image| !image.trim().is_empty());
    if image.is_none() {
        assert!(
            std::env::var(REQUIRE_LINUX).as_deref() != Ok("1"),
            "{REQUIRE_LINUX}=1 but {LINUX_IMAGE} names no image: the dev-server (a Linux container) must run here. \
             Build it with scripts/machine-e2e/run.py, or unset {REQUIRE_LINUX} on a computer that cannot run it."
        );
        eprintln!("machines_e2e: {LINUX_IMAGE} is not set, so the dev-server (Linux container) scenarios are left out on this computer");
    }
    image
}

fn uid_gid() -> (u32, u32) {
    // SAFETY: getuid and getgid have no preconditions.
    unsafe { (libc::getuid(), libc::getgid()) }
}

/// A headless Linux runtime in a container, with one project.
pub struct DevServer {
    pub world: AgentWorld,
    serve: Option<Serve>,
    pub container: String,
    pub port: u16,
}

impl DevServer {
    pub fn start(image: &str) -> Self {
        let inspect = Command::new("docker").args(["image", "inspect", "--format", "{{.Id}}", image]).output();
        match inspect {
            Ok(output) if output.status.success() => {}
            Ok(output) => panic!("the dev-server image {image} is not there ({LINUX_IMAGE}): {}", String::from_utf8_lossy(&output.stderr)),
            Err(error) => panic!("docker cannot be run for the dev-server ({LINUX_IMAGE}={image}): {error}"),
        }
        let world = AgentWorld::new();
        let root = root_of(&world);
        let (uid, gid) = uid_gid();
        // The person on the server: a user with this uid, so git, the shell
        // and the runtime find a name and a home for it.
        std::fs::write(root.join("passwd"), format!("root:x:0:0:root:/root:/bin/bash\ntester:x:{uid}:{gid}:tester:{}:/bin/bash\n", world.home.display())).unwrap();
        std::fs::write(root.join("group"), format!("root:x:0:\ntester:x:{gid}:\n")).unwrap();
        let port = free_port();
        let container = format!("tx-e2e-dev-server-{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
        let binary = Path::new(env!("CARGO_BIN_EXE_terminalx-serve"));
        let scripts = std::fs::canonicalize(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../scripts/remote-runtime")).unwrap();
        let mount = |path: &Path, mode: &str| format!("{0}:{0}{1}", path.display(), mode);
        let mut command = Command::new("docker");
        command
            .args(["run", "--init", "--rm", "--name", &container, "--hostname", "dev-server"])
            .args(["--user", &format!("{uid}:{gid}")])
            .args(["-v", &mount(&root, "")])
            .args(["-v", &format!("{}:/etc/passwd:ro", root.join("passwd").display())])
            .args(["-v", &format!("{}:/etc/group:ro", root.join("group").display())])
            .args(["-v", &mount(binary, ":ro")])
            .args(["-v", &mount(&scripts, ":ro")])
            .args(["-p", &format!("127.0.0.1:{port}:{port}")])
            .args(["-w", &world.project.to_string_lossy()]);
        for (name, value) in Self::environment(&world) {
            command.args(["-e", &format!("{name}={value}")]);
        }
        command
            .args(["-e", &format!("TERMINALX_MACHINE_HOST_PORT={port}")])
            .arg(image)
            .arg(binary)
            .arg("--data-dir")
            .arg(&world.data)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        // Removed even when the test panics before the runtime is up.
        let mut server = Self { world, serve: None, container, port };
        server.serve = Some(Serve::start(command, &server.world.data));
        // A person adds the server's project, as on a fresh server.
        let added = server.exec(&["projects", "add", &server.world.project.to_string_lossy(), "--data-dir", &server.world.data.to_string_lossy()]);
        assert!(added.0 == 0, "terminalx-serve projects add on the dev-server: {}", added.1);
        server
    }

    /// The runtime's environment inside the container.
    fn environment(world: &AgentWorld) -> Vec<(&'static str, String)> {
        vec![
            ("HOME", world.home.display().to_string()),
            ("PATH", format!("{}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", world.bin.display())),
            ("CLAUDE_CONFIG_DIR", world.home.join(".claude").display().to_string()),
            ("SHELL", "/bin/bash".into()),
            ("LANG", "C.UTF-8".into()),
            ("RUST_LOG", "info".into()),
        ]
    }

    pub fn serve(&self) -> &Serve {
        self.serve.as_ref().expect("the dev-server runs")
    }

    pub fn endpoint(&self) -> String {
        format!("ws://127.0.0.1:{}/machine/1", self.port)
    }

    pub fn project_id(&self) -> String {
        project_id(&self.world.project)
    }

    /// `docker exec` into the server as the person, in their project.
    fn exec_command(&self, tty: bool, args: &[&str]) -> Command {
        let (uid, gid) = uid_gid();
        let mut command = Command::new("docker");
        command.arg("exec");
        if tty {
            command.arg("-it");
        }
        command.args(["-u", &format!("{uid}:{gid}"), "-w", &self.world.project.to_string_lossy()]);
        for (name, value) in Self::environment(&self.world) {
            command.args(["-e", &format!("{name}={value}")]);
        }
        command.arg(&self.container);
        command.args(args);
        command
    }

    /// `terminalx-serve <args>` on the server: its exit code and output.
    pub fn exec(&self, args: &[&str]) -> (i32, String) {
        let mut full = vec![env!("CARGO_BIN_EXE_terminalx-serve")];
        full.extend_from_slice(args);
        self.run(&full)
    }

    /// Any program on the server: its exit code and output.
    pub fn run(&self, args: &[&str]) -> (i32, String) {
        let output = self.exec_command(false, args).stdin(Stdio::null()).output().expect("docker exec");
        (output.status.code().unwrap_or(-1), format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)))
    }

    /// `terminalx-serve pair` in a terminal on the server, as a person runs it.
    pub fn pair_in_terminal(&self) -> Terminal {
        let data = self.world.data.to_string_lossy().into_owned();
        Terminal::start(self.exec_command(true, &[env!("CARGO_BIN_EXE_terminalx-serve"), "pair", "--data-dir", &data]))
    }

    /// `git <args>` in its project, on the server's own disk (inside the container).
    pub fn git(&self, project: &Path, args: &[&str]) -> String {
        let mut full = vec!["git", "-C"];
        let project = project.to_string_lossy().into_owned();
        full.push(&project);
        full.extend_from_slice(args);
        let (code, output) = self.run(&full);
        assert_eq!(code, 0, "git {args:?} on the dev-server: {output}");
        output
    }

    pub fn read(&self, path: &Path) -> String {
        let path = path.to_string_lossy().into_owned();
        let (code, output) = self.run(&["cat", &path]);
        assert_eq!(code, 0, "cat {path} on the dev-server: {output}");
        output
    }

    pub fn computers(&self) -> Vec<Value> {
        status(self.serve())["computers"].as_array().cloned().unwrap_or_default()
    }
}

impl Drop for DevServer {
    fn drop(&mut self) {
        // The runtime first (SIGTERM through `docker run`'s signal proxy and
        // `--init`), then whatever is left of the container.
        drop(self.serve.take());
        let _ = Command::new("docker").args(["rm", "-f", &self.container]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
}

// ---------------------------------------------------------------- a terminal

/// A program in a pseudo-terminal of its own, which it has as its
/// controlling terminal, as in a person's SSH session.
pub struct Terminal {
    master: std::fs::File,
    child: Child,
    screen: Arc<Mutex<Vec<u8>>>,
}

impl Terminal {
    pub fn start(mut command: Command) -> Self {
        let (mut master, mut slave) = (0, 0);
        let size = libc::winsize { ws_row: 40, ws_col: 120, ws_xpixel: 0, ws_ypixel: 0 };
        // SAFETY: openpty fills both descriptors and only reads `size` (macOS
        // declares it `*mut`, Linux `*const`); no name or termios is asked for.
        assert_eq!(unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::from_ref(&size).cast_mut()) }, 0);
        // SAFETY: both were just opened and are owned here alone.
        let (master, slave) = unsafe { (std::fs::File::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        command
            .stdin(Stdio::from(slave.try_clone().unwrap()))
            .stdout(Stdio::from(slave.try_clone().unwrap()))
            .stderr(Stdio::from(slave.try_clone().unwrap()));
        #[cfg(target_os = "macos")]
        const TIOCSCTTY: libc::c_ulong = 0x2000_7461;
        #[cfg(not(target_os = "macos"))]
        const TIOCSCTTY: libc::Ioctl = libc::TIOCSCTTY;
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 || libc::ioctl(0, TIOCSCTTY, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().expect("start the program in its terminal");
        drop(slave);
        let screen = Arc::new(Mutex::new(Vec::new()));
        let mut reader = master.try_clone().unwrap();
        let shown = screen.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            // The far end closing reads as an error on macOS, end of file on Linux.
            while let Ok(read) = reader.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                shown.lock().unwrap().extend_from_slice(&buffer[..read]);
            }
        });
        Self { master, child, screen }
    }

    pub fn screen(&self) -> String {
        String::from_utf8_lossy(&self.screen.lock().unwrap()).into_owned()
    }

    /// Everything shown so far, once it holds `text`.
    pub fn wait_for(&self, text: &str) -> String {
        let deadline = Instant::now() + AGENT_WAIT;
        loop {
            let screen = self.screen();
            if screen.contains(text) {
                return screen;
            }
            assert!(Instant::now() < deadline, "the terminal never showed {text:?}; it shows:\n{screen}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Type a line, as a person presses Return.
    pub fn type_line(&mut self, line: &str) {
        self.master.write_all(format!("{line}\r").as_bytes()).unwrap();
    }

    pub fn exit_code(&mut self) -> i32 {
        let deadline = Instant::now() + AGENT_WAIT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code().unwrap_or(-1);
            }
            assert!(Instant::now() < deadline, "the program never exited; it shows:\n{}", self.screen());
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// The pairing code `pair` shows.
    pub fn code(&self) -> MachineCode {
        let screen = self.wait_for("Waiting for a computer to pair");
        let printed = screen.split_whitespace().find(|word| word.starts_with("txm2.")).unwrap_or_else(|| panic!("no code on the screen:\n{screen}"));
        MachineCode::decode(printed).unwrap_or_else(|error| panic!("the code on the screen does not decode ({error:#}):\n{screen}"))
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------- the operating computer

/// Pair with the machine of `code` with the desktop's pairing client, as
/// `machines_pair` does: the computer named [`OPERATOR_LABEL`] with the
/// client key `secret`. `endpoint` (the machine's port on this host) is
/// tried first, then the code's own endpoints. `Ok` is what the machine
/// said about itself after Allow; `Err` is the refusal the dialog shows.
pub async fn pair_with(code: &MachineCode, endpoint: &str, secret: [u8; 32]) -> Result<Option<MachineIdentity>, Failure> {
    let mut code = code.clone();
    code.direct_endpoints.insert(0, endpoint.to_string());
    let (_cancel, cancelled) = watch::channel(false);
    let me = pair::Me { client_secret: &secret, label: OPERATOR_LABEL, platform: "macos" };
    let outcome = pair::pair(&code, me, PAIRING_WAIT, cancelled).await.unwrap_or_else(|error| panic!("the pairing client failed (not a refusal): {error:#}"));
    outcome.map(|paired| paired.described)
}

/// A paired machine as the operating computer keeps it: the record, the
/// device token and the client key, in memory.
pub struct Kept {
    target: Mutex<Target>,
    pub described: Mutex<Vec<Value>>,
}

impl Kept {
    pub fn new(code: &MachineCode, endpoint: &str, device_token: &str, secret: [u8; 32]) -> Arc<Self> {
        Arc::new(Self {
            target: Mutex::new(Target {
                machine_id: code.machine.machine_id.clone(),
                public_key_b64: code.public_key_b64.clone(),
                direct_endpoints: vec![endpoint.to_string()],
                route: MachineRoute::RelayAndNearby,
                last_route: None,
                last_seen_at: None,
                device_token: Zeroizing::new(device_token.to_string()),
                client_secret: Zeroizing::new(secret),
                label: OPERATOR_LABEL.into(),
                platform: "macos".into(),
                relay: None,
            }),
            described: Mutex::new(Vec::new()),
        })
    }

    fn machine_id(&self) -> String {
        self.target.lock().unwrap().machine_id.clone()
    }
}

impl MachineEnv for Kept {
    fn target(&self) -> anyhow::Result<Target> {
        Ok(self.target.lock().unwrap().clone())
    }
    fn signed_in_user(&self) -> Option<String> {
        None
    }
    fn described(&self, described: &Value, route: &RouteUsed) {
        self.described.lock().unwrap().push(described.clone());
        self.target.lock().unwrap().last_route = Some(route.clone());
    }
    fn save_relay(&self, _credential: &RelayCredential) -> anyhow::Result<()> {
        anyhow::bail!("no relay in the two-machine tests")
    }
    fn drop_relay(&self) {}
}

/// The operating computer's connection to one machine: the desktop's
/// [`MachineSupervisor`], with the web view's frames sent and answered as
/// JSON-RPC.
pub struct Link {
    pub name: String,
    kept: Arc<Kept>,
    supervisor: MachineSupervisor,
    states: mpsc::UnboundedReceiver<MachineConnectionState>,
    client: mpsc::UnboundedReceiver<ClientEvent>,
    seen: Vec<MachineConnectionState>,
    notifications: Vec<Value>,
    next: u64,
    pub granted: Vec<String>,
}

impl Link {
    /// Start the supervisor, wait for a direct connection and say hello
    /// with every namespace this build speaks.
    pub async fn open(name: &str, kept: Arc<Kept>) -> Self {
        let (supervisor, states, client) = Self::supervise(&kept);
        let mut link = Self { name: name.into(), kept, supervisor, states, client, seen: Vec::new(), notifications: Vec::new(), next: 1, granted: Vec::new() };
        link.connected().await;
        link
    }

    fn supervise(kept: &Arc<Kept>) -> (MachineSupervisor, mpsc::UnboundedReceiver<MachineConnectionState>, mpsc::UnboundedReceiver<ClientEvent>) {
        let (events, client) = mpsc::unbounded_channel();
        let (states_tx, states) = mpsc::unbounded_channel();
        let on_state: OnState = Arc::new(move |view: &MachineConnectionView| {
            let _ = states_tx.send(view.state.clone());
        });
        let supervisor = MachineSupervisor::start(&kept.machine_id(), kept.clone(), Arc::new(NetDialer), events, on_state);
        (supervisor, states, client)
    }

    async fn connected(&mut self) {
        self.state("connected directly", Duration::from_secs(60), |state| matches!(state, MachineConnectionState::Direct { .. })).await;
        let hello = self
            .ok("rpc.hello", json!({ "protocol": raccoon_lib::remote::protocol::PROTOCOL, "want": raccoon_lib::remote::protocol::served(true), "client": { "app": "terminalx-desktop" } }))
            .await;
        self.granted = serde_json::from_value(hello["capabilities"].clone()).unwrap_or_else(|_| panic!("{}: rpc.hello granted nothing readable: {hello}", self.name));
        // `agent-commands/1` (approvals, and with it the agents that answer
        // an interrupt) is checked where the scenarios need it, so a machine
        // without it still runs everything else.
        for needed in ["machine/1", "session/1", "session/3", "pty/1", "fs/1", "git/1"] {
            assert!(self.granted.iter().any(|granted| granted == needed), "{}: {needed} was not granted: {hello}", self.name);
        }
    }

    /// Whether `rpc.hello` granted `capability`.
    pub fn has(&self, capability: &str) -> bool {
        self.granted.iter().any(|granted| granted == capability)
    }

    /// The connection is dropped and made again, as after a network change:
    /// a new supervisor with the same record, and hello again.
    pub async fn reconnect(&mut self) {
        self.supervisor.stop();
        let (supervisor, states, client) = Self::supervise(&self.kept);
        self.supervisor = supervisor;
        self.states = states;
        self.client = client;
        self.notifications.clear();
        self.connected().await;
    }

    /// The next state that is `wanted`, within `within`.
    pub async fn state(&mut self, what: &str, within: Duration, wanted: impl Fn(&MachineConnectionState) -> bool) -> MachineConnectionState {
        let found = tokio::time::timeout(within, async {
            loop {
                let state = self.states.recv().await.expect("the supervisor runs");
                self.seen.push(state.clone());
                if wanted(&state) {
                    return state;
                }
            }
        })
        .await;
        found.unwrap_or_else(|_| panic!("{}: never {what}; states so far: {:?}", self.name, self.seen))
    }

    pub fn supervisor_state(&self) -> MachineConnectionState {
        self.supervisor.state()
    }

    /// One request, answered: the whole response.
    pub async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = format!("e2e-{}", self.next);
        self.next += 1;
        assert!(
            self.supervisor.send(json!({ "id": id, "method": method, "params": params })),
            "{}: {method} could not be sent; the supervisor is {:?} (states {:?})",
            self.name,
            self.supervisor.state(),
            self.seen
        );
        let deadline = tokio::time::Instant::now() + AGENT_WAIT;
        loop {
            let event = tokio::time::timeout_at(deadline, self.client.recv())
                .await
                .unwrap_or_else(|_| panic!("{}: no answer to {method} {params} within {AGENT_WAIT:?}; states {:?}", self.name, self.seen))
                .unwrap_or_else(|| panic!("{}: the supervisor stopped while {method} was waiting", self.name));
            match event {
                ClientEvent::Message(message) if message["id"] == id.as_str() => return message,
                ClientEvent::Message(message) => {
                    if self.notifications.len() >= 4096 {
                        self.notifications.drain(..2048);
                    }
                    self.notifications.push(message);
                }
                ClientEvent::State(ClientState::Connected { .. }) => {}
                ClientEvent::State(state) => eprintln!("{}: the web view was told {state:?} while {method} waited", self.name),
            }
        }
    }

    /// The result of a call that must succeed.
    pub async fn ok(&mut self, method: &str, params: Value) -> Value {
        let response = self.call(method, params.clone()).await;
        assert_eq!(response["ok"], true, "{}: {method} {params} failed: {response}", self.name);
        response["result"].clone()
    }

    /// The error code of a call that must be refused.
    pub async fn refused(&mut self, method: &str, params: Value) -> String {
        let response = self.call(method, params.clone()).await;
        assert_ne!(response["ok"], true, "{}: {method} {params} was served: {response}", self.name);
        response["error"]["code"].as_str().unwrap_or_default().to_string()
    }

    /// A tab's committed events, as `session.subscribe` replays them.
    pub async fn events(&mut self, session: &str, tab: &str) -> Vec<Value> {
        let subscribed = self.ok("session.subscribe", json!({ "sessionId": session, "tabId": tab })).await;
        if let Some(subscription) = subscribed["subscriptionId"].as_str() {
            self.ok("session.unsubscribe", json!({ "subscriptionId": subscription })).await;
        }
        self.notifications.retain(|message| message["event"] != "session.event");
        subscribed["events"].as_array().cloned().unwrap_or_default().into_iter().map(|item| item["event"].clone()).collect()
    }

    /// Poll a tab's events until `done` holds, within 90 s.
    pub async fn wait_events(&mut self, session: &str, tab: &str, what: &str, done: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let events = self.events(session, tab).await;
            if done(&events) {
                return events;
            }
            assert!(Instant::now() < deadline, "{}: timed out waiting for {what}; the tab's events: {:?}", self.name, summary(&events));
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    pub fn stop(&self) {
        self.supervisor.stop();
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.supervisor.stop();
    }
}

/// Each event's payload type and text, for a failure message.
pub fn summary(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .map(|event| {
            let payload = &event["payload"];
            match payload["text"].as_str() {
                Some(text) => format!("{}: {text}", payload["type"].as_str().unwrap_or("?")),
                None => payload["type"].as_str().unwrap_or("?").to_string(),
            }
        })
        .collect()
}

/// The texts of a tab's events of one payload type.
pub fn texts(events: &[Value], kind: &str) -> Vec<String> {
    events.iter().filter(|event| event["payload"]["type"] == kind).map(|event| event["payload"]["text"].as_str().unwrap_or("").to_string()).collect()
}

pub fn count(events: &[Value], kind: &str) -> usize {
    events.iter().filter(|event| event["payload"]["type"] == kind).count()
}
