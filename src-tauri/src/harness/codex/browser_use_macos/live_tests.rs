//! Opt-in regression against real Codex, uv, browser-use, PTYs and Launch Services.
//! No model turn, account, user configuration or existing browser is used.

use std::collections::HashSet;
use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use objc2_app_kit::{NSApplicationActivationPolicy, NSRunningApplication};
use serde_json::json;

use crate::pty::{PaneSpec, Terminals};

struct Rig(Terminals);
impl Drop for Rig {
    fn drop(&mut self) {
        self.0.kill_all();
    }
}

fn descendants(root: u32) -> Vec<(u32, String)> {
    let output = Command::new("ps").args(["-axo", "pid=,ppid=,comm="]).output().unwrap();
    assert!(output.status.success());
    let rows: Vec<_> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((
                fields.next()?.parse::<u32>().ok()?,
                fields.next()?.parse::<u32>().ok()?,
                fields.collect::<Vec<_>>().join(" "),
            ))
        })
        .collect();
    let mut ours = HashSet::from([root]);
    loop {
        let before = ours.len();
        for (pid, parent, _) in &rows {
            if ours.contains(parent) {
                ours.insert(*pid);
            }
        }
        if ours.len() == before {
            break;
        }
    }
    rows.into_iter()
        .filter(|(pid, _, _)| ours.contains(pid))
        .map(|(pid, _, name)| (pid, name))
        .collect()
}

fn assert_background(pids: &[u32]) {
    for pid in pids {
        assert!(crate::harness::host::is_alive(*pid), "helper {pid} exited unexpectedly");
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(*pid as i32).expect("Python should be registered after the screen probe");
        assert_eq!(
            app.activationPolicy(),
            NSApplicationActivationPolicy::Prohibited,
            "helper {pid} appeared in the Dock"
        );
        assert!(!app.isActive(), "helper {pid} took focus");
    }
}

fn start(terminals: &Terminals, id: &str, home: &Path) -> Vec<u32> {
    let codex = crate::binpath::resolve("codex").expect("install codex for the live regression");
    let command = format!("'{}' app-server", codex.to_string_lossy().replace('\'', "'\\''"));
    let env = vec![("CODEX_HOME".into(), home.to_string_lossy().into_owned())];
    terminals
        .spawn(
            Arc::new(crate::sink::BroadcastSink::new(64)),
            id,
            PaneSpec {
                cwd: home.to_str().unwrap(),
                cols: 240,
                rows: 24,
                command: Some(&command),
                env: &env,
            },
        )
        .unwrap();
    for request in [
        json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"pro116-test","version":"1"}}}),
        json!({"method":"initialized","params":{}}),
        json!({"id":2,"method":"thread/start","params":{"cwd":home,"approvalPolicy":"never","sandbox":"danger-full-access"}}),
    ] {
        terminals.write(id, format!("{request}\n").as_bytes()).unwrap();
    }
    let deadline = Instant::now() + Duration::from_secs(40);
    loop {
        let output = terminals.read_output(id).unwrap();
        let output = String::from_utf8_lossy(&output);
        if output.contains("\"status\":\"ready\"") {
            break;
        }
        assert!(Instant::now() < deadline, "MCP did not become ready: {output}");
        assert!(!output.contains("\"status\":\"failed\""), "MCP startup failed: {output}");
        std::thread::sleep(Duration::from_millis(50));
    }
    let pids: Vec<_> = descendants(terminals.pid(id).unwrap())
        .into_iter()
        .filter(|(_, name)| name.ends_with("/Python"))
        .map(|(pid, _)| pid)
        .collect();
    assert!(!pids.is_empty(), "use framework Python to exercise the original Dock bug");
    assert_background(&pids);
    pids
}

fn assert_gone(pids: &[u32]) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while pids.iter().any(|pid| crate::harness::host::is_alive(*pid)) {
        assert!(Instant::now() < deadline, "session left helpers alive: {pids:?}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
#[ignore = "requires Codex, uv, cached browser-use 0.13.11 and TERMINALX_BROWSER_USE_PYTHON pointing to framework Python 3.12"]
fn real_codex_helpers_stay_background_and_exit_only_with_their_session() {
    let python = std::env::var("TERMINALX_BROWSER_USE_PYTHON").expect("set TERMINALX_BROWSER_USE_PYTHON");
    let uv = crate::binpath::resolve("uv").expect("install uv for the live regression");
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    // Exercise both plain requirements and the extras form that originally
    // bypassed configuration matching, through the real uv entry point.
    for (home, package) in [(a.path(), "browser-use[cli]==0.13.11"), (b.path(), "browser-use==0.13.11")] {
        let config = toml::to_string(&json!({"mcp_servers":{"browser":{
            "command":uv,"args":["tool","uvx","--offline","--python",python,package,"--cli-mcp"]
        }}}))
        .unwrap();
        std::fs::write(home.join("config.toml"), super::configure(&config, home, None).unwrap()).unwrap();
    }
    let rig = Rig(Terminals::new());
    let survivor = start(&rig.0, "b", b.path());
    for cycle in 0..3 {
        let helpers = start(&rig.0, "a", a.path());
        assert_background(&survivor);
        // Both single-tab close and the wait-before-restart path.
        if cycle == 0 {
            rig.0.kill("a");
        } else {
            rig.0.kill_and_wait("a", Duration::from_secs(5));
        }
        assert_gone(&helpers);
        assert_background(&survivor);
    }
    let helpers = start(&rig.0, "a", a.path());
    // The same shutdown operation used on window destruction and Cmd+Q.
    rig.0.kill_all();
    assert_gone(&helpers);
    assert_gone(&survivor);
}
