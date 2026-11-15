//! `machine/1` (PRO-340): one runtime serving every project of its machine,
//! held to docs/MACHINES.md "Project scoping".

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::sink::{BroadcastSink, EventSink};

/// The machine id of a host key of 32 bytes `0x01` (docs/MACHINES.md).
const MACHINE_ID: &str = "cs1uhCLEB_ttCYaQ";

/// Fields drop in order: the runtime before the store it reads.
struct Machine {
    rpc: Arc<WorkspaceRpc>,
    terminals: Arc<Terminals>,
    sink: Arc<BroadcastSink>,
    dir: tempfile::TempDir,
    _home: crate::store::TempHome,
}

impl Drop for Machine {
    fn drop(&mut self) {
        self.terminals.kill_all();
    }
}

impl Machine {
    fn path(&self, name: &str) -> PathBuf {
        std::fs::canonicalize(self.dir.path()).unwrap().join(name)
    }
}

/// A git checkout with one commit on `main`, registered as a project.
fn project(parent: &Path, name: &str) -> (PathBuf, String) {
    let dir = parent.join(name);
    std::fs::create_dir_all(&dir).unwrap();
    crate::cloud_agents::launch::init_blank_repository(&dir, "main").unwrap();
    std::fs::write(dir.join("README.md"), format!("{name}\n")).unwrap();
    let path = crate::store::projects::add(&dir.to_string_lossy()).unwrap().path;
    (PathBuf::from(&path), machine::project_id(&path))
}

/// A machine runtime over a fresh store, with the agents a test may start.
fn machine_rpc() -> Machine {
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
    Machine { rpc, terminals, sink, dir, _home: home }
}

async fn call(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, method: &str, params: Value) -> Result<Value, (String, String)> {
    let response = rpc.handle(peer, &json!({ "id": "1", "method": method, "params": params })).await;
    if response["ok"] == true {
        Ok(response["result"].clone())
    } else {
        Err((response["error"]["code"].as_str().unwrap().to_string(), response["error"]["message"].as_str().unwrap().to_string()))
    }
}

fn code(result: Result<Value, (String, String)>) -> String {
    result.expect_err("expected a refusal").0
}

/// A paired computer: full operating rights (decision 5), asking for every
/// namespace a machine serves.
async fn computer(rpc: &Arc<WorkspaceRpc>) -> (Arc<Peer>, Notifications, Value) {
    let (peer, events) = Peer::new("computer-1".into(), Authority::Manage);
    let hello = call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": protocol::served(true) })).await.unwrap();
    (peer, events, hello)
}

async fn next_event(events: &mut Notifications, event: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let value = events.recv().await.expect("the connection stays open");
            if value["event"] == event {
                return value["params"].clone();
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("no {event}"))
}

#[tokio::test(flavor = "multi_thread")]
async fn one_connection_lists_three_projects_and_starts_a_session_in_each() {
    let m = machine_rpc();
    let root = m.path("code");
    let projects: Vec<(PathBuf, String)> = ["api", "web", "docs"].iter().map(|name| project(&root, name)).collect();
    // A folder the machine has no project for: none of its sessions are served.
    let stray = root.join("stray");
    std::fs::create_dir_all(&stray).unwrap();
    let (peer, _events, hello) = computer(&m.rpc).await;
    let granted: Vec<&str> = hello["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(granted.contains(&"machine/1"), "{hello}");
    for withheld in ["keys/1", "mirror/1", "collab/1"] {
        assert!(!granted.contains(&withheld), "{withheld} is a cloud workspace's");
    }
    let described = call(&m.rpc, &peer, "machine.describe", json!({})).await.unwrap();
    assert_eq!(described["machineId"], MACHINE_ID);
    assert_eq!(described["version"], env!("CARGO_PKG_VERSION"));
    assert_eq!(described["hasWindow"], false);
    assert_eq!(described["arch"], std::env::consts::ARCH);
    assert!(described["name"].as_str().is_some_and(|name| !name.is_empty()));
    assert!(matches!(described["os"]["family"].as_str(), Some("macos" | "linux")), "{described}");
    let listed = call(&m.rpc, &peer, "machine.projects", json!({})).await.unwrap();
    let listed = listed["projects"].as_array().unwrap();
    assert_eq!(listed.len(), 3);
    for ((path, id), entry) in projects.iter().zip(listed) {
        assert_eq!(entry["projectId"], json!(id));
        assert_eq!(entry["path"], json!(path));
        assert_eq!(entry["kind"], "git");
        assert_eq!(entry["defaultBranch"], "main");
        assert_eq!(entry["archived"], false);
    }
    let mut created = Vec::new();
    for (index, (path, id)) in projects.iter().enumerate() {
        let made = call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "model": "opus", "title": format!("Work {index}"), "projectId": id, "clientRequestId": format!("create-session-{index}") }))
            .await
            .unwrap();
        assert_eq!(made["session"]["projectId"], json!(id), "{made}");
        assert_eq!(made["session"]["projectPath"], json!(path));
        created.push((made["sessionId"].as_str().unwrap().to_string(), id.clone()));
    }
    crate::session_ops::create_session_entry(crate::session_ops::NewSession {
        parent: None, section_id: None, project_path: stray.to_string_lossy().into_owned(), checkout_branch: None, checkout_pr: None,
        title: Some("Not a project here".into()), use_worktree: false, base_ref: None, worktree_name: None, on_main: true,
        issue: None, automation: None, cwd: None, tab: None, orchestrate: false,
    })
    .unwrap();
    let sessions = call(&m.rpc, &peer, "session.list", json!({})).await.unwrap();
    let sessions = sessions["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 3, "every project's sessions, and only theirs: {sessions:?}");
    for (session_id, id) in &created {
        let session = sessions.iter().find(|session| session["id"] == json!(session_id)).unwrap();
        assert_eq!(session["projectId"], json!(id));
    }
    // A call that names a session takes no projectId; a wrong one is refused.
    let (first, first_project) = &created[0];
    assert!(call(&m.rpc, &peer, "session.get", json!({ "sessionId": first })).await.is_ok());
    assert!(call(&m.rpc, &peer, "session.get", json!({ "sessionId": first, "projectId": first_project })).await.is_ok());
    assert_eq!(code(call(&m.rpc, &peer, "session.get", json!({ "sessionId": first, "projectId": created[1].1 })).await), "invalid_params");
    // Creating names a project the machine has.
    assert_eq!(code(call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "clientRequestId": "create-session-x" })).await), "invalid_params");
    assert_eq!(code(call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "projectId": "AAAAAAAAAAAAAAAA", "clientRequestId": "create-session-y" })).await), "not_found");
    let repository = json!({ "identity": "github.com/acme/api", "directory": "api" });
    assert_eq!(code(call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "projectId": first_project, "repository": repository, "clientRequestId": "create-session-z" })).await), "invalid_params");
    // Each worktree clean-up row names its project.
    let scan = call(&m.rpc, &peer, "cleanup.scan", json!({})).await.unwrap();
    let rows = scan["projects"].as_array().unwrap();
    assert_eq!(rows.len(), 3, "{scan}");
    assert!(rows.iter().all(|row| projects.iter().any(|(path, id)| row["path"] == json!(path) && row["projectId"] == json!(id))), "{scan}");
    // A machine has no mailbox to wake and nothing archives it.
    assert_eq!(code(call(&m.rpc, &peer, "session.nudge", json!({})).await), "method_not_found");
    assert_eq!(code(call(&m.rpc, &peer, "lifecycle.dispositionFacts", json!({})).await), "method_not_found");
    assert!(call(&m.rpc, &peer, "lifecycle.resources", json!({})).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_call_stays_inside_the_project_it_names_and_its_own_worktrees() {
    let m = machine_rpc();
    let root = m.path("code");
    let (api, api_id) = project(&root, "api");
    let (web, web_id) = project(&root, "web");
    std::fs::write(web.join("secret.txt"), "web only").unwrap();
    std::fs::write(m.path("outside.txt"), "no project").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&web, api.join("to-web")).unwrap();
    // Worktrees in an absolute folder, beside each other: each project
    // reaches its own, never its neighbour's.
    let shared = m.path("worktrees");
    std::fs::create_dir_all(&shared).unwrap();
    let mut settings = crate::store::settings::load();
    settings.worktree_dir = shared.to_string_lossy().into_owned();
    crate::store::settings::save(&settings).unwrap();
    crate::git::run(&api, &["worktree", "add", "-q", "-b", "api-one", &shared.join("api-one").to_string_lossy()]).unwrap();
    crate::git::run(&web, &["worktree", "add", "-q", "-b", "web-one", &shared.join("web-one").to_string_lossy()]).unwrap();
    crate::git::run(&api, &["worktree", "add", "-q", "-b", "api-inside", &api.join("nested/inside").to_string_lossy()]).unwrap();
    std::fs::write(shared.join("api-one/notes.md"), "api worktree").unwrap();
    std::fs::write(shared.join("web-one/notes.md"), "web worktree").unwrap();
    let (peer, _events, _) = computer(&m.rpc).await;
    let read = |project: &str, path: &str| {
        let rpc = m.rpc.clone();
        let peer = peer.clone();
        let params = json!({ "projectId": project, "path": path });
        async move { call(&rpc, &peer, "fs.read", params).await }
    };
    assert_eq!(read(&api_id, "README.md").await.unwrap()["text"], "api\n");
    assert_eq!(read(&web_id, "secret.txt").await.unwrap()["text"], "web only");
    let web_secret = web.join("secret.txt").to_string_lossy().into_owned();
    let outside = m.path("outside.txt").to_string_lossy().into_owned();
    let web_worktree = shared.join("web-one/notes.md").to_string_lossy().into_owned();
    for path in ["../web/secret.txt", web_secret.as_str(), outside.as_str(), "/etc/hosts", web_worktree.as_str(), "nested/../../web/secret.txt"] {
        assert_eq!(code(read(&api_id, path).await), "path_forbidden", "{path}");
    }
    #[cfg(unix)]
    assert_eq!(code(read(&api_id, "to-web/secret.txt").await), "path_forbidden");
    // Its own worktree outside its folder is named absolutely, as
    // git.repositories lists it; one inside is a relative path as before.
    let api_worktree = shared.join("api-one/notes.md").to_string_lossy().into_owned();
    assert_eq!(read(&api_id, &api_worktree).await.unwrap()["text"], "api worktree");
    assert_eq!(read(&web_id, &web_worktree).await.unwrap()["text"], "web worktree");
    let repositories = call(&m.rpc, &peer, "git.repositories", json!({ "projectId": api_id })).await.unwrap();
    let names: Vec<&str> = repositories["repositories"].as_array().unwrap().iter().filter_map(|repo| repo["repo"].as_str()).collect();
    let api_one = std::fs::canonicalize(shared.join("api-one")).unwrap();
    // The checkout, then its worktrees by path.
    assert_eq!(names, vec![".", "nested/inside", api_one.to_str().unwrap()], "{repositories}");
    let status = call(&m.rpc, &peer, "git.status", json!({ "projectId": api_id, "repo": api_one })).await.unwrap();
    assert_eq!(status["branch"], "api-one", "{status}");
    let web_one = std::fs::canonicalize(shared.join("web-one")).unwrap();
    assert_eq!(code(call(&m.rpc, &peer, "git.status", json!({ "projectId": api_id, "repo": web_one })).await), "not_found");
    // Writes, listings and searches hold to the same rule.
    assert_eq!(code(call(&m.rpc, &peer, "fs.write", json!({ "projectId": api_id, "path": "../web/new.txt", "text": "x", "clientRequestId": "write-request-1" })).await), "path_forbidden");
    assert_eq!(code(call(&m.rpc, &peer, "fs.list", json!({ "projectId": api_id, "path": web.to_string_lossy() })).await), "path_forbidden");
    let found = call(&m.rpc, &peer, "fs.search", json!({ "projectId": api_id, "searchId": "search-0001", "query": "worktree", "path": shared.join("api-one") })).await.unwrap();
    let hits: Vec<&str> = found["hits"].as_array().unwrap().iter().filter_map(|hit| hit["path"].as_str()).collect();
    assert_eq!(hits, vec![api_worktree.as_str()], "{found}");
    // A file call names its project.
    assert_eq!(code(call(&m.rpc, &peer, "fs.read", json!({ "path": "README.md" })).await), "invalid_params");
    assert_eq!(code(call(&m.rpc, &peer, "fs.read", json!({ "projectId": "AAAAAAAAAAAAAAAA", "path": "README.md" })).await), "not_found");
    // A shell outside a session opens in the project it names.
    let shell = call(&m.rpc, &peer, "pty.create", json!({ "projectId": web_id, "clientRequestId": "shell-request-1" })).await.unwrap();
    assert_eq!((shell["projectId"].clone(), shell["cwd"].clone()), (json!(web_id), json!("")));
    assert_eq!(code(call(&m.rpc, &peer, "pty.resize", json!({ "ptyId": shell["ptyId"], "cols": 90, "rows": 30, "projectId": api_id })).await), "invalid_params");
    assert_eq!(code(call(&m.rpc, &peer, "pty.create", json!({ "projectId": api_id, "cwd": "../web", "clientRequestId": "shell-request-2" })).await), "path_forbidden");
    // A project removed from the machine is no longer served.
    crate::store::projects::remove(&web.to_string_lossy()).unwrap();
    assert_eq!(code(read(&web_id, "secret.txt").await), "not_found");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_client_without_machine_1_is_served_only_what_names_no_project() {
    let m = machine_rpc();
    let (_api, api_id) = project(&m.path("code"), "api");
    // Today's desktop and phone ask for the namespaces they know.
    let (peer, _events) = Peer::new("desktop-today".into(), Authority::Manage);
    let hello = call(&m.rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": protocol::CAPABILITIES })).await.unwrap();
    let granted: Vec<&str> = hello["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(!granted.contains(&"machine/1") && granted.contains(&"session/2") && !granted.contains(&"keys/1"));
    assert!(call(&m.rpc, &peer, "session.list", json!({})).await.is_ok());
    assert!(call(&m.rpc, &peer, "runtime.agents", json!({})).await.is_ok());
    assert_eq!(code(call(&m.rpc, &peer, "fs.list", json!({ "projectId": api_id })).await), "capability_not_granted");
    assert_eq!(code(call(&m.rpc, &peer, "git.status", json!({})).await), "capability_not_granted");
    assert_eq!(code(call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "projectId": api_id, "clientRequestId": "create-session-1" })).await), "capability_not_granted");
    assert_eq!(code(call(&m.rpc, &peer, "pty.create", json!({ "clientRequestId": "shell-request-1" })).await), "capability_not_granted");
    assert_eq!(code(call(&m.rpc, &peer, "machine.describe", json!({})).await), "capability_not_granted");
    assert_eq!(code(call(&m.rpc, &peer, "keys.get", json!({})).await), "capability_not_granted");
    // Nothing in common at all is the only reason to say update.
    let (other, _other_events) = Peer::new("only-keys".into(), Authority::Manage);
    assert_eq!(code(call(&m.rpc, &other, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["keys/1", "mirror/1"] })).await), "update_required");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_one_root_runtime_never_offers_machine_1_and_serves_as_before() {
    let _home = crate::store::temp_home();
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    std::fs::write(root.join("a.txt"), "workspace").unwrap();
    let terminals = Arc::new(Terminals::new());
    let rpc = WorkspaceRpc::new(&root, 1, Arc::new(BroadcastSink::new(16)), terminals.clone(), None).unwrap();
    let (peer, _events) = Peer::new("device".into(), Authority::Manage);
    assert_eq!(code(call(&rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["machine/1"] })).await), "update_required");
    let hello = call(&rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["machine/1", "fs/1", "keys/1"] })).await.unwrap();
    assert_eq!(hello["capabilities"], json!(["fs/1", "keys/1"]));
    let read = call(&rpc, &peer, "fs.read", json!({ "path": "a.txt" })).await.unwrap();
    assert_eq!(read["text"], "workspace");
    assert_eq!(code(call(&rpc, &peer, "machine.projects", json!({})).await), "capability_not_granted");
    terminals.kill_all();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_new_project_or_name_is_announced_to_machine_connections() {
    let m = machine_rpc();
    project(&m.path("code"), "api");
    let (_peer, mut events, _) = computer(&m.rpc).await;
    let (today, mut today_events) = Peer::new("desktop-today".into(), Authority::Manage);
    call(&m.rpc, &today, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["session/1"] })).await.unwrap();
    // Let the watcher read what is there before anything changes.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let (web, web_id) = project(&m.path("code"), "web");
    (&*m.sink as &dyn EventSink).emit("projects_changed", &());
    let changed = next_event(&mut events, "machine.changed").await;
    assert_eq!(changed["machine"]["machineId"], MACHINE_ID);
    let ids: Vec<&Value> = changed["projects"].as_array().unwrap().iter().map(|project| &project["projectId"]).collect();
    assert!(ids.contains(&&json!(web_id)), "{changed}");
    let mut settings = crate::store::settings::load();
    settings.machine_name = Some("Studio".into());
    crate::store::settings::save(&settings).unwrap();
    (&*m.sink as &dyn EventSink).emit("settings_file_changed", &());
    let renamed = next_event(&mut events, "machine.changed").await;
    assert_eq!(renamed["machine"]["name"], "Studio");
    assert!(tokio::time::timeout(Duration::from_millis(200), async {
        loop {
            match today_events.recv().await {
                Some(value) if value["event"] == "machine.changed" => return,
                Some(_) => continue,
                None => std::future::pending::<()>().await,
            }
        }
    })
    .await
    .is_err(), "a connection without machine/1 is not told");
    drop(web);
}
