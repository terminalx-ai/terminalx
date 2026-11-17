//! A machine runtime over a fresh store, and a paired computer connected to
//! it, for the tests of the `machine/N` session parity namespaces
//! (`machine_files`, `machine_runs`, `machine_session`). It is the same rig as
//! `machine_tests.rs` (`remote::server::machine_tests`), kept beside the
//! modules it tests so `cargo test --lib remote::machine` runs them.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::machine;
use super::protocol::{self, Authority, PROTOCOL};
use super::server::{Notifications, Peer, WorkspaceRpc};
use crate::pty::Terminals;
use crate::session::SessionManager;
use crate::sink::BroadcastSink;
use crate::store::index::SessionEntry;

/// The machine id of a host key of 32 bytes `0x01` (docs/MACHINES.md).
pub const MACHINE_ID: &str = "cs1uhCLEB_ttCYaQ";

/// Fields drop in order: the runtime before the store it reads.
pub struct Machine {
    pub rpc: Arc<WorkspaceRpc>,
    pub terminals: Arc<Terminals>,
    _sink: Arc<BroadcastSink>,
    pub dir: tempfile::TempDir,
    _home: crate::store::TempHome,
}

impl Drop for Machine {
    fn drop(&mut self) {
        self.terminals.kill_all();
    }
}

impl Machine {
    /// A canonical path under the test's own folder.
    pub fn path(&self, name: &str) -> PathBuf {
        std::fs::canonicalize(self.dir.path()).unwrap().join(name)
    }
}

/// A git checkout with one commit on `main`, registered as a project.
pub fn project(parent: &Path, name: &str) -> (PathBuf, String) {
    let dir = parent.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    crate::cloud_agents::launch::init_blank_repository(&dir, "main").unwrap();
    std::fs::write(dir.join("README.md"), format!("{name}\n")).unwrap();
    let path = crate::store::projects::add(&dir.to_string_lossy()).unwrap().path;
    (PathBuf::from(&path), machine::project_id(&path))
}

/// A machine runtime over a fresh store, with Claude Code the one agent
/// installed there.
pub fn machine_rpc() -> Machine {
    let home = crate::store::temp_home();
    let dir = tempfile::tempdir().unwrap();
    let terminals = Arc::new(Terminals::new());
    let sink = Arc::new(BroadcastSink::new(256));
    let manager = SessionManager::new(
        sink.clone(), Arc::new(crate::sink::NoObserver), Arc::new(crate::harness::host::Host::new()),
        terminals.clone(), Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap(),
    );
    let identity = machine::Identity { machine_id: MACHINE_ID.into(), has_window: false };
    let rpc = WorkspaceRpc::machine(identity, 7, sink.clone(), terminals.clone(), Some(manager)).unwrap();
    rpc.set_offered_for_tests(
        crate::harness::catalog()
            .into_iter()
            .map(|mut agent| {
                agent.available = agent.id == "claude";
                agent.path = agent.available.then(|| format!("/opt/agents/{}", agent.binary));
                agent
            })
            .collect(),
    );
    Machine { rpc, terminals, _sink: sink, dir, _home: home }
}

/// One call; a refusal is its code and message.
pub async fn call(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, method: &str, params: Value) -> Result<Value, (String, String)> {
    let response = rpc.handle(peer, &json!({ "id": "1", "method": method, "params": params })).await;
    if response["ok"] == true {
        Ok(response["result"].clone())
    } else {
        Err((response["error"]["code"].as_str().unwrap().to_string(), response["error"]["message"].as_str().unwrap().to_string()))
    }
}

/// The code of a call that must be refused.
pub fn code(result: Result<Value, (String, String)>) -> String {
    result.expect_err("expected a refusal").0
}

/// A paired computer: full operating rights (decision 5), asking for every
/// namespace a machine serves.
pub async fn computer(rpc: &Arc<WorkspaceRpc>) -> (Arc<Peer>, Notifications, Value) {
    connect(rpc, "computer-1", Authority::Manage, protocol::served(true)).await
}

/// A connection of `device` with `authority`, granted what it asks of `want`.
pub async fn connect(rpc: &Arc<WorkspaceRpc>, device: &str, authority: Authority, want: Vec<&str>) -> (Arc<Peer>, Notifications, Value) {
    let (peer, events) = Peer::new(device.into(), authority);
    let hello = call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": want })).await.unwrap();
    (peer, events, hello)
}

/// Whether the hello granted `capability`.
pub fn granted(hello: &Value, capability: &str) -> bool {
    hello["capabilities"].as_array().unwrap().iter().any(|granted| granted == capability)
}

/// A session of `project` in `cwd`, written to the machine's index as a
/// worktree session (`worktree` names its worktree) or one in the project's
/// own folder.
pub fn session(project: &Path, cwd: &Path, id: &str, worktree: Option<&str>, branch: &str) -> SessionEntry {
    let entry: SessionEntry = serde_json::from_value(json!({
        "id": id, "projectPath": project, "cwd": cwd, "title": id,
        "worktreeName": worktree, "branch": branch, "created": "", "modified": "", "tabs": [],
    }))
    .unwrap();
    crate::store::index::update(|entries| {
        entries.push(entry.clone());
        Ok(())
    })
    .unwrap();
    entry
}

/// `pty.list` until `found` picks a terminal out of it.
pub async fn listed_until(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, what: &str, found: impl Fn(&Value) -> bool) -> Value {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let listed = call(rpc, peer, "pty.list", json!({})).await.unwrap();
        if let Some(terminal) = listed["terminals"].as_array().unwrap().iter().find(|terminal| found(terminal)) {
            return terminal.clone();
        }
        assert!(std::time::Instant::now() < deadline, "no {what} in {listed}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
