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

/// `git` in `dir`, which must succeed.
fn git(dir: &Path, args: &[&str]) {
    let status = std::process::Command::new("git").arg("-C").arg(dir).args(args).status().unwrap();
    assert!(status.success(), "git {args:?}");
}

/// New session on a machine (PRO-348): `session.create` cuts a worktree of the
/// named project from the chosen branch (`session-base/1`), and a resend of
/// the same request is the same session, never a second one.
#[tokio::test(flavor = "multi_thread")]
async fn a_new_session_is_cut_from_the_chosen_branch_once() {
    let m = machine_rpc();
    let (path, id) = project(&m.path("code"), "api");
    git(&path, &["add", "README.md"]);
    git(&path, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "readme"]);
    git(&path, &["checkout", "-qb", "feature"]);
    std::fs::write(path.join("FEATURE.md"), "only on feature\n").unwrap();
    git(&path, &["add", "FEATURE.md"]);
    git(&path, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "feature"]);
    git(&path, &["checkout", "-q", "main"]);
    let (peer, _events, hello) = computer(&m.rpc).await;
    assert!(hello["capabilities"].as_array().unwrap().iter().any(|granted| granted == "session-base/1"), "{hello}");
    let request = json!({ "agent": "claude", "model": "opus", "title": "From feature", "projectId": id, "useWorktree": true, "baseRef": "feature", "clientRequestId": "create-from-feature" });
    let made = call(&m.rpc, &peer, "session.create", request.clone()).await.unwrap();
    let cwd = PathBuf::from(made["session"]["cwd"].as_str().unwrap());
    assert_ne!(cwd, path, "a worktree of its own: {made}");
    assert!(cwd.join("FEATURE.md").is_file(), "cut from feature: {made}");
    assert!(!path.join("FEATURE.md").exists(), "the project's own checkout stays on main");
    // The same request again (a resend after a dropped connection) is answered with the same session.
    let again = call(&m.rpc, &peer, "session.create", request).await.unwrap();
    assert_eq!(again["sessionId"], made["sessionId"]);
    let sessions = call(&m.rpc, &peer, "session.list", json!({})).await.unwrap();
    assert_eq!(sessions["sessions"].as_array().unwrap().len(), 1, "{sessions}");
    assert_eq!(sessions["sessions"][0]["worktreeBase"]["from"], "feature");
    // Without a worktree there is nothing to cut, and the base is not used.
    let here = call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "projectId": id, "baseRef": "feature", "clientRequestId": "create-on-main" })).await.unwrap();
    assert_eq!(PathBuf::from(here["session"]["cwd"].as_str().unwrap()), path);
    assert_eq!(here["session"]["fileRoot"], "");
    assert_eq!(here["session"]["fileRepository"], ".");
    // Never something git could read as an option or a revision expression.
    for bad in ["-x", "main..feature", "feature@{1}", "a b", "", "HEAD~1"] {
        let refused = call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "projectId": id, "useWorktree": true, "baseRef": bad, "clientRequestId": format!("create-bad-{}", bad.len()) })).await;
        assert_eq!(code(refused), "invalid_params", "{bad:?}");
    }
    // A client that did not ask for `session-base/1` cannot name a base.
    let (older, _) = Peer::new("computer-2".into(), Authority::Manage);
    let want: Vec<&str> = protocol::served(true).into_iter().filter(|name| *name != "session-base/1").collect();
    call(&m.rpc, &older, "rpc.hello", json!({ "protocol": PROTOCOL, "want": want })).await.unwrap();
    let refused = call(&m.rpc, &older, "session.create", json!({ "agent": "claude", "projectId": id, "useWorktree": true, "baseRef": "feature", "clientRequestId": "create-older" })).await;
    assert_eq!(code(refused), "capability_not_granted");
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
    assert!(status["files"].as_array().unwrap().iter().any(|file| file["path"] == "notes.md"), "{status}");
    let web_one = std::fs::canonicalize(shared.join("web-one")).unwrap();
    assert_eq!(code(call(&m.rpc, &peer, "git.status", json!({ "projectId": api_id, "repo": web_one })).await), "not_found");
    // Writes, listings and searches hold to the same rule.
    assert_eq!(code(call(&m.rpc, &peer, "fs.write", json!({ "projectId": api_id, "path": "../web/new.txt", "text": "x", "clientRequestId": "write-request-1" })).await), "path_forbidden");
    assert_eq!(code(call(&m.rpc, &peer, "fs.list", json!({ "projectId": api_id, "path": web.to_string_lossy() })).await), "path_forbidden");
    let found = call(&m.rpc, &peer, "fs.search", json!({ "projectId": api_id, "searchId": "search-0001", "query": "worktree", "path": shared.join("api-one") })).await.unwrap();
    let hits: Vec<&str> = found["hits"].as_array().unwrap().iter().filter_map(|hit| hit["path"].as_str()).collect();
    assert_eq!(hits, vec![api_worktree.as_str()], "{found}");
    // Moving the creation setting leaves existing, registered worktrees accessible.
    let future = m.path("future-worktrees");
    std::fs::create_dir(&future).unwrap();
    settings.worktree_dir = future.to_string_lossy().into_owned();
    crate::store::settings::save(&settings).unwrap();
    let repositories = call(&m.rpc, &peer, "git.repositories", json!({ "projectId": api_id })).await.unwrap();
    assert!(repositories["repositories"].as_array().unwrap().iter().any(|repo| repo["repo"] == json!(api_one)));
    assert_eq!(read(&api_id, &api_worktree).await.unwrap()["text"], "api worktree");
    #[cfg(unix)]
    {
        let alias = m.path("worktree-alias");
        std::os::unix::fs::symlink(&shared, &alias).unwrap();
        let made = call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "projectId": api_id, "clientRequestId": "session-aliased-worktree" })).await.unwrap();
        let session_id = made["sessionId"].as_str().unwrap();
        std::fs::create_dir(api_one.join("src")).unwrap();
        let cwd = alias.join("api-one/src");
        crate::store::index::update_session(session_id, |session| {
            session.cwd = cwd.to_string_lossy().into_owned();
            Ok(())
        }).unwrap();
        let session = call(&m.rpc, &peer, "session.get", json!({ "sessionId": session_id })).await.unwrap();
        assert_eq!(session["session"]["cwd"], json!(cwd));
        assert_eq!(session["session"]["fileRoot"], json!(api_one));
        assert_eq!(session["session"]["fileRepository"], json!(api_one));
        let listing = call(&m.rpc, &peer, "fs.list", json!({ "projectId": api_id, "path": session["session"]["fileRoot"] })).await.unwrap();
        assert!(listing["entries"].as_array().unwrap().iter().any(|entry| entry["path"] == api_worktree));

        let unrelated = m.path("unrelated");
        std::fs::create_dir_all(unrelated.join("api-one/src")).unwrap();
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&unrelated, &alias).unwrap();
        let session = call(&m.rpc, &peer, "session.get", json!({ "sessionId": session_id })).await.unwrap();
        assert_eq!(session["session"]["cwd"], json!(cwd));
        assert!(session["session"]["fileRoot"].is_null(), "{session}");
        assert!(session["session"]["fileRepository"].is_null(), "{session}");
        let listed = call(&m.rpc, &peer, "session.list", json!({})).await.unwrap();
        let row = listed["sessions"].as_array().unwrap().iter().find(|row| row["id"] == session_id).unwrap();
        assert!(row["fileRoot"].is_null(), "{row}");

        let internal = api.join("nested/inside/src");
        std::fs::create_dir(&internal).unwrap();
        index::update_session(session_id, |session| {
            session.cwd = internal.to_string_lossy().into_owned();
            Ok(())
        }).unwrap();
        let session = call(&m.rpc, &peer, "session.get", json!({ "sessionId": session_id })).await.unwrap();
        assert_eq!(session["session"]["fileRoot"], "nested/inside");
        assert_eq!(session["session"]["fileRepository"], "nested/inside");
    }
    // Verify the file service with its current cached registration, before
    // the next project lookup can refresh that cache.
    let files = m.rpc.project(&peer, &json!({ "projectId": api_id })).unwrap().files.clone();
    let request = json!({ "path": api_worktree });
    assert!(files.read(&request).is_ok());
    let admin = crate::git::run(&api_one, &["rev-parse", "--absolute-git-dir"]).unwrap();
    let common_file = Path::new(admin.trim()).join("commondir");
    let common = std::fs::read(&common_file).unwrap();
    std::fs::write(&common_file, format!("{}\n", web.join(".git").display())).unwrap();
    assert_eq!(files.read(&request).unwrap_err().code, "path_forbidden");
    assert_eq!(code(call(&m.rpc, &peer, "git.status", json!({ "projectId": api_id, "repo": api_one })).await), "not_found");
    std::fs::write(&common_file, common).unwrap();
    // Warm the authorization cache again after restoring the checkout.
    assert!(call(&m.rpc, &peer, "git.repositories", json!({ "projectId": api_id })).await.is_ok());
    assert!(files.read(&request).is_ok());
    git(&api, &["config", "extensions.worktreeConfig", "true"]);
    git(&api_one, &["config", "--worktree", "core.worktree", web.to_str().unwrap()]);
    assert_eq!(code(call(&m.rpc, &peer, "git.status", json!({ "projectId": api_id, "repo": api_one })).await), "not_found");
    let repositories = call(&m.rpc, &peer, "git.repositories", json!({ "projectId": api_id })).await.unwrap();
    assert!(repositories["repositories"].as_array().unwrap().iter().all(|repo| repo["repo"] != json!(api_one)));
    git(&api_one, &["config", "--worktree", "--unset", "core.worktree"]);
    std::fs::rename(&api_one, shared.join("saved-api-one")).unwrap();
    std::fs::create_dir(&api_one).unwrap();
    std::fs::write(&api_worktree, "replacement").unwrap();
    assert_eq!(files.read(&request).unwrap_err().code, "path_forbidden");
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
async fn a_folder_project_does_not_inherit_its_enclosing_repository() {
    let m = machine_rpc();
    let parent = m.path("unregistered");
    std::fs::create_dir(&parent).unwrap();
    crate::cloud_agents::launch::init_blank_repository(&parent, "main").unwrap();
    let folder = parent.join("folder");
    std::fs::create_dir(&folder).unwrap();
    std::fs::write(folder.join("local.txt"), "in the registered folder").unwrap();
    let project = crate::store::projects::add(folder.to_str().unwrap()).unwrap();
    let id = machine::project_id(&project.path);
    let external = m.path("parent-worktree");
    git(&parent, &["worktree", "add", "--quiet", "--detach", external.to_str().unwrap()]);
    let (peer, _events, _) = computer(&m.rpc).await;

    let projects = call(&m.rpc, &peer, "machine.projects", json!({})).await.unwrap();
    assert_eq!(projects["projects"][0]["kind"], "folder");
    assert!(projects["projects"][0]["defaultBranch"].is_null());
    let listed = call(&m.rpc, &peer, "git.repositories", json!({ "projectId": id })).await.unwrap();
    assert_eq!(listed["repositories"], json!([]));
    assert_eq!(code(call(&m.rpc, &peer, "git.status", json!({ "projectId": id, "repo": "." })).await), "not_found");
    assert_eq!(code(call(&m.rpc, &peer, "fs.list", json!({ "projectId": id, "path": external })).await), "path_forbidden");
    let visible = call(&m.rpc, &peer, "fs.read", json!({ "projectId": id, "path": "local.txt" })).await.unwrap();
    assert_eq!(visible["text"], "in the registered folder");
}

#[tokio::test(flavor = "multi_thread")]
async fn directory_mutations_preserve_contained_checkouts_and_projects() {
    let m = machine_rpc();
    let (api, id) = project(&m.path("code"), "api");
    let outer = m.path("outer");
    git(&api, &["worktree", "add", "--quiet", "--detach", outer.to_str().unwrap()]);
    let (peer, _events, _) = computer(&m.rpc).await;
    // Establish the scope before the nested checkout appears.
    call(&m.rpc, &peer, "fs.list", json!({ "projectId": id, "path": outer })).await.unwrap();
    let container = outer.join("container");
    let inner = container.join("inner");
    std::fs::create_dir(&container).unwrap();
    git(&api, &["worktree", "add", "--quiet", "--detach", inner.to_str().unwrap()]);
    let registered_parent = outer.join("registered");
    let registered = registered_parent.join("folder");
    std::fs::create_dir_all(&registered).unwrap();
    crate::store::projects::add(registered.to_str().unwrap()).unwrap();

    for (index, path) in [&container, &registered_parent].into_iter().enumerate() {
        let refused = call(&m.rpc, &peer, "fs.delete", json!({
            "projectId": id, "path": path, "recursive": true, "clientRequestId": format!("delete-protected-{index}")
        })).await;
        assert_eq!(code(refused), "path_forbidden");
        let refused = call(&m.rpc, &peer, "fs.rename", json!({
            "projectId": id, "from": path, "to": outer.join("moved"), "clientRequestId": format!("move-protected-{index}")
        })).await;
        assert_eq!(code(refused), "path_forbidden");
    }
    assert!(inner.join(".git").is_file());
    assert!(registered.is_dir());

    let marker = inner.join(".git");
    let git_link = std::fs::read(&marker).unwrap();
    std::fs::remove_file(&marker).unwrap();
    let refused = call(&m.rpc, &peer, "fs.delete", json!({
        "projectId": id, "path": container, "recursive": true, "clientRequestId": "delete-damaged-checkout"
    })).await;
    assert_eq!(code(refused), "path_forbidden");
    let refused = call(&m.rpc, &peer, "fs.rename", json!({
        "projectId": id, "from": container, "to": outer.join("moved"), "clientRequestId": "move-damaged-checkout"
    })).await;
    assert_eq!(code(refused), "path_forbidden");
    std::fs::write(&marker, git_link).unwrap();

    let linked = crate::store::projects::add(inner.to_str().unwrap()).unwrap();
    let linked_id = machine::project_id(&linked.path);
    call(&m.rpc, &peer, "fs.list", json!({ "projectId": linked_id, "path": outer })).await.unwrap();
    let refused = call(&m.rpc, &peer, "fs.delete", json!({
        "projectId": linked_id, "path": container, "recursive": true, "clientRequestId": "delete-linked-project"
    })).await;
    assert_eq!(code(refused), "path_forbidden");
    assert!(inner.join(".git").is_file());

    let ordinary = outer.join("ordinary");
    std::fs::create_dir(&ordinary).unwrap();
    call(&m.rpc, &peer, "fs.delete", json!({
        "projectId": id, "path": ordinary, "recursive": true, "clientRequestId": "delete-ordinary"
    })).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_start_directory_keeps_its_saved_checkout() {
    let m = machine_rpc();
    let (api, id) = project(&m.path("code"), "api");
    let checkout = m.path("worktree");
    git(&api, &["worktree", "add", "--quiet", "--detach", checkout.to_str().unwrap()]);
    let cwd = checkout.join("src");
    std::fs::create_dir(&cwd).unwrap();
    let (peer, _events, _) = computer(&m.rpc).await;
    let made = call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "projectId": id, "clientRequestId": "session-saved-checkout" })).await.unwrap();
    let session_id = made["sessionId"].as_str().unwrap();
    index::update_session(session_id, |session| {
        session.cwd = cwd.to_string_lossy().into_owned();
        session.set_checkout_root(checkout.to_str());
        Ok(())
    }).unwrap();
    std::fs::remove_dir(&cwd).unwrap();

    let session = call(&m.rpc, &peer, "session.get", json!({ "sessionId": session_id })).await.unwrap();
    assert_eq!(session["session"]["cwd"], json!(cwd));
    assert_eq!(session["session"]["fileRoot"], json!(checkout));
    assert_eq!(session["session"]["fileRepository"], json!(checkout));
    std::fs::write(&cwd, "a file at the previous starting directory").unwrap();
    let session = call(&m.rpc, &peer, "session.get", json!({ "sessionId": session_id })).await.unwrap();
    assert_eq!(session["session"]["fileRoot"], json!(checkout));
    assert_eq!(session["session"]["fileRepository"], json!(checkout));
    std::fs::remove_file(&cwd).unwrap();
    git(&api, &["worktree", "remove", checkout.to_str().unwrap()]);
    let session = call(&m.rpc, &peer, "session.get", json!({ "sessionId": session_id })).await.unwrap();
    assert!(session["session"]["fileRoot"].is_null());
    assert!(session["session"]["fileRepository"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_checkout_remains_addressable_beyond_repository_discovery_limit() {
    use super::super::git::MAX_PROJECT_REPOSITORIES;

    let m = machine_rpc();
    let (api, api_id) = project(&m.path("code"), "api");
    let pool = m.path("worktrees");
    std::fs::create_dir(&pool).unwrap();
    for index in 0..MAX_PROJECT_REPOSITORIES {
        let path = pool.join(format!("{index:03}"));
        git(&api, &["worktree", "add", "--quiet", "--detach", "--no-checkout", path.to_str().unwrap()]);
    }
    let checkout = pool.join(format!("{:03}", MAX_PROJECT_REPOSITORIES - 1));
    let (peer, _events, _) = computer(&m.rpc).await;
    let made = call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "projectId": api_id, "clientRequestId": "session-last-checkout" })).await.unwrap();
    let session_id = made["sessionId"].as_str().unwrap();
    index::update_session(session_id, |session| {
        session.cwd = checkout.to_string_lossy().into_owned();
        Ok(())
    }).unwrap();

    let listed = call(&m.rpc, &peer, "git.repositories", json!({ "projectId": api_id })).await.unwrap();
    assert_eq!(listed["truncated"], true);
    let repositories = listed["repositories"].as_array().unwrap();
    assert_eq!(repositories.len(), MAX_PROJECT_REPOSITORIES);
    assert!(repositories.iter().all(|repo| repo["repo"] != json!(checkout)));

    let session = call(&m.rpc, &peer, "session.get", json!({ "sessionId": session_id })).await.unwrap();
    assert_eq!(session["session"]["fileRoot"], json!(checkout));
    assert_eq!(session["session"]["fileRepository"], json!(checkout));
    let status = call(&m.rpc, &peer, "git.status", json!({ "projectId": api_id, "repo": checkout })).await.unwrap();
    assert_eq!(status["repo"], json!(checkout));
    assert!(call(&m.rpc, &peer, "fs.list", json!({ "projectId": api_id, "path": checkout })).await.is_ok());

    let preferred = call(&m.rpc, &peer, "git.repositories", json!({ "projectId": api_id, "preferredRepo": checkout })).await.unwrap();
    assert_eq!(preferred["truncated"], true);
    let repositories = preferred["repositories"].as_array().unwrap();
    assert_eq!(repositories.len(), MAX_PROJECT_REPOSITORIES);
    assert!(repositories.iter().any(|repo| repo["repo"] == json!(checkout)));
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

// ------------------------------------------------- machine/3 (PRO-354)

use crate::remote::machine_update::{self as updates, Blocker, Environment, MachineUpdates, OtherComputer, Progress, Record};

/// The host side of `machine/3` a test controls: who else is connected and
/// whether a window is attached, as `machine_host`'s `HostAccess` reports.
struct Host {
    others: Vec<OtherComputer>,
    window: bool,
}

impl machine::MachineAccess for Host {
    fn direct_endpoints(&self) -> Vec<String> {
        Vec::new()
    }
    fn relay_access(&self, _device_id: &str) -> futures_util::future::BoxFuture<'static, Result<Value, RpcError>> {
        Box::pin(async { Ok(json!({ "relay": null })) })
    }
    fn other_computers(&self, caller: Option<&str>) -> Vec<OtherComputer> {
        self.others.iter().filter(|computer| Some(computer.id.as_str()) != caller).cloned().collect()
    }
    fn window_available(&self) -> bool {
        self.window
    }
}

fn no_blockers() -> Vec<Blocker> {
    Vec::new()
}

/// What `runtime.handover.plan` names for an agent mid-turn.
fn an_agent_mid_turn() -> Vec<Blocker> {
    vec![Blocker::of(&json!({ "kind": "turn", "sessionId": "s1", "tabId": "t1", "harness": "claude" }))]
}

fn no_network(_: &semver::Version) -> anyhow::Result<Option<semver::Version>> {
    anyhow::bail!("this test checks no releases")
}

/// A headless install of 0.0.1 (`~/.terminalx/current -> versions/0.0.1`).
fn installer(m: &Machine) -> PathBuf {
    let root = m.path("install");
    std::fs::create_dir_all(root.join("versions/0.0.1")).unwrap();
    std::fs::write(root.join("versions/0.0.1/terminalx-serve"), "old").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("versions/0.0.1", root.join("current")).unwrap();
    root
}

fn environment(m: &Machine, install_root: Option<PathBuf>, has_window: bool, blockers: fn() -> Vec<Blocker>) -> Environment {
    let data_dir = m.path("data");
    std::fs::create_dir_all(data_dir.join("run")).unwrap();
    Environment { data_dir, install_root, has_window, helper: None, blockers, check: no_network }
}

/// `m` serving `machine/3` from `env`, with `host` as its machine host.
fn serving(m: &Machine, env: Environment, host: Host) -> Arc<MachineUpdates> {
    m.rpc.set_machine_updates_for_tests(MachineUpdates::new(env, m.sink.clone()));
    m.rpc.set_machine_access(Arc::new(host));
    m.rpc.machine_updates_for_tests()
}

fn refused(result: Result<Value, (String, String)>) -> (String, String) {
    result.expect_err("expected a refusal")
}

/// The whole error, with its data.
async fn failure(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, method: &str, params: Value) -> Value {
    let response = rpc.handle(peer, &json!({ "id": "1", "method": method, "params": params })).await;
    assert_eq!(response["ok"], false, "{response}");
    response["error"].clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn update_status_has_the_contract_s_shape() {
    let m = machine_rpc();
    let root = installer(&m);
    let served = serving(&m, environment(&m, Some(root.clone()), false, no_blockers), Host { others: Vec::new(), window: false });
    served.offer_for_tests(Some("9.9.9"));
    let (peer, _events, hello) = computer(&m.rpc).await;
    assert!(hello["capabilities"].as_array().unwrap().contains(&json!("machine/3")), "{hello}");
    let status = call(&m.rpc, &peer, "machine.updateStatus", json!({})).await.unwrap();
    let fields: std::collections::BTreeSet<&str> = status.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(fields, ["available", "blockers", "checkedAt", "current", "kept", "method", "otherComputers", "progress"].into_iter().collect());
    assert_eq!(status["method"], "installer");
    assert_eq!(status["current"], env!("CARGO_PKG_VERSION"));
    assert_eq!(status["available"], json!({ "version": "9.9.9" }));
    assert!(status["checkedAt"].is_i64());
    assert_eq!(status["blockers"], json!([]));
    assert_eq!(status["otherComputers"], json!([]));
    assert_eq!(status["kept"], json!(["0.0.1"]));
    assert_eq!(status["progress"], json!({ "phase": "idle" }));

    // Not installed by the installer: unmanaged, and no update from here.
    // The first machine holds the test home's lock: end it before the next.
    drop((served, peer, m));
    let m2 = machine_rpc();
    serving(&m2, environment(&m2, Some(m2.path("no-install")), false, no_blockers), Host { others: Vec::new(), window: false });
    let (peer2, _events2, _) = computer(&m2.rpc).await;
    let status = call(&m2.rpc, &peer2, "machine.updateStatus", json!({})).await.unwrap();
    assert_eq!((status["method"].as_str(), status["available"].is_null(), status["checkedAt"].is_null()), (Some("unmanaged"), true, true));
    assert_eq!(status["kept"], json!([env!("CARGO_PKG_VERSION")]));
    let error = failure(&m2.rpc, &peer2, "machine.update", json!({ "version": "9.9.9" })).await;
    assert_eq!(error["code"], "update_unavailable", "{error}");
    assert_eq!(error["data"]["method"], "unmanaged", "the refusal carries the status");
}

#[tokio::test(flavor = "multi_thread")]
async fn machine_3_is_granted_only_when_asked_for() {
    let m = machine_rpc();
    let (older, _events) = Peer::new("computer-old".into(), Authority::Manage);
    let hello = call(&m.rpc, &older, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["machine/1", "machine/2", "session/1"] })).await.unwrap();
    assert_eq!(hello["capabilities"], json!(["session/1", "machine/1", "machine/2"]), "a machine/2 desktop is served exactly as before");
    assert_eq!(code(call(&m.rpc, &older, "machine.updateStatus", json!({})).await), "capability_not_granted");
    // A newer desktop asking for a namespace this runtime does not have
    // learns its version and what it offers.
    let (newer, _events) = Peer::new("computer-new".into(), Authority::Manage);
    let error = failure(&m.rpc, &newer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["machine/9"] })).await;
    assert_eq!(error["code"], "update_required");
    assert_eq!(error["data"]["runtimeVersion"], env!("CARGO_PKG_VERSION"));
    assert!(error["data"]["offered"].as_array().unwrap().contains(&json!("machine/3")), "{error}");
    // A participant reads the status but does not update.
    let (viewer, _events) = Peer::new("viewer".into(), Authority::Participate);
    call(&m.rpc, &viewer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["machine/3"] })).await.unwrap();
    assert_eq!(code(call(&m.rpc, &viewer, "machine.update", json!({ "version": "9.9.9" })).await), "forbidden");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_update_asks_first_about_work_it_stops_and_other_computers() {
    let m = machine_rpc();
    let root = installer(&m);
    let others = vec![OtherComputer { id: "studio".into(), label: "Studio's MacBook".into() }];
    let served = serving(&m, environment(&m, Some(root), false, an_agent_mid_turn), Host { others, window: false });
    served.offer_for_tests(Some("9.9.9"));
    let (peer, _events, _) = computer(&m.rpc).await;
    let status = call(&m.rpc, &peer, "machine.updateStatus", json!({})).await.unwrap();
    assert_eq!(status["blockers"], json!([{ "id": "tab:s1/t1", "kind": "turn", "title": "claude in tab t1" }]));
    assert_eq!(status["otherComputers"], json!([{ "id": "studio", "label": "Studio's MacBook" }]), "every connected computer but the caller");

    let error = failure(&m.rpc, &peer, "machine.update", json!({ "version": "9.9.9" })).await;
    assert_eq!(error["code"], "update_confirm");
    assert!(error["message"].as_str().unwrap().contains("claude in tab t1"), "{error}");
    assert_eq!(error["data"]["blockers"][0]["id"], "tab:s1/t1", "the refusal carries the status");
    let error = failure(&m.rpc, &peer, "machine.update", json!({ "version": "9.9.9", "stop": ["tab:s1/t1"] })).await;
    assert_eq!(error["code"], "update_confirm", "the other computers are asked about too");
    assert!(error["message"].as_str().unwrap().contains("Studio's MacBook"), "{error}");
    // Confirmed before Studio connected: the computers shown then were others, so it asks again.
    let error = failure(&m.rpc, &peer, "machine.update", json!({ "version": "9.9.9", "stop": ["tab:s1/t1"], "confirmedOthers": ["air"] })).await;
    assert_eq!(error["code"], "update_confirm", "a computer not shown before is named first");
    assert!(error["message"].as_str().unwrap().contains("Studio's MacBook"), "{error}");
    assert_eq!(code(call(&m.rpc, &peer, "machine.update", json!({ "version": "9.9.9", "confirmedOthers": "studio" })).await), "invalid_params");
    assert_eq!(code(call(&m.rpc, &peer, "machine.update", json!({ "version": "9.8.0", "stop": ["tab:s1/t1"], "confirmedOthers": ["studio"] })).await), "update_unavailable", "only the release on offer");
    assert_eq!(code(call(&m.rpc, &peer, "machine.update", json!({ "stop": "tab:s1/t1" })).await), "invalid_params");
    assert!(read_update_record(&m).progress == Progress::Idle, "nothing was started");

    // Agreed to both: it starts. This runtime has no binary of its own to
    // run the helper from, so it says the update could not start.
    let (code, message) = refused(call(&m.rpc, &peer, "machine.update", json!({ "version": "9.9.9", "stop": ["tab:s1/t1"], "confirmedOthers": ["studio"] })).await);
    assert_eq!(code, "internal", "{message}");
    match read_update_record(&m).progress {
        Progress::Failed { version, running, rolled_back, .. } => assert_eq!((version.as_str(), running.as_str(), rolled_back), ("9.9.9", env!("CARGO_PKG_VERSION"), false)),
        other => panic!("expected failed, got {other:?}"),
    }
}

fn read_update_record(m: &Machine) -> Record {
    updates::read_record(&updates::status_path(&m.path("data")))
}

#[tokio::test(flavor = "multi_thread")]
async fn one_update_at_a_time() {
    let m = machine_rpc();
    let root = installer(&m);
    let served = serving(&m, environment(&m, Some(root), false, no_blockers), Host { others: Vec::new(), window: false });
    served.offer_for_tests(Some("9.9.9"));
    // A helper of this machine's runs (this process stands in for its pid).
    let running = Record { progress: Progress::Trial { version: "9.9.9".into(), since: updates::now_ms() }, from: Some("0.0.1".into()), helper_pid: Some(std::process::id()), ..Record::default() };
    updates::write_record(&updates::status_path(&m.path("data")), &running).unwrap();
    let (peer, _events, _) = computer(&m.rpc).await;
    let error = failure(&m.rpc, &peer, "machine.update", json!({ "version": "9.9.9" })).await;
    assert_eq!(error["code"], "update_busy");
    assert_eq!(error["data"]["progress"], json!({ "phase": "trial", "version": "9.9.9", "since": running_since(&running) }));
}

fn running_since(record: &Record) -> i64 {
    match record.progress {
        Progress::Trial { since, .. } => since,
        _ => unreachable!(),
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_desktop_machine_asks_its_window_to_update_the_app() {
    let m = machine_rpc();
    serving(&m, environment(&m, None, true, no_blockers), Host { others: Vec::new(), window: false });
    let (peer, mut events, _) = computer(&m.rpc).await;
    let status = call(&m.rpc, &peer, "machine.updateStatus", json!({})).await.unwrap();
    assert_eq!((status["method"].as_str(), status["available"].is_null()), (Some("app"), true), "nothing offered until the window has checked");
    // Let the watcher read what is there before anything changes.
    tokio::time::sleep(Duration::from_millis(300)).await;
    // The window checked: nothing newer.
    updates::report(&m.path("data"), &json!({ "phase": "upToDate" })).unwrap();
    let changed = next_event(&mut events, "machine.updateChanged").await;
    assert!(changed["status"]["checkedAt"].is_i64(), "{changed}");
    assert_eq!(changed["status"]["available"], Value::Null);

    // No window attached: the app cannot update itself now.
    assert_eq!(code(call(&m.rpc, &peer, "machine.update", json!({ "version": "0.9.0" })).await), "update_unavailable");

    // The first machine holds the test home's lock: end it before the next.
    drop((events, peer, m));
    let m2 = machine_rpc();
    let mut published2 = m2.sink.subscribe();
    serving(&m2, environment(&m2, None, true, no_blockers), Host { others: Vec::new(), window: true });
    let (peer2, _events2, _) = computer(&m2.rpc).await;
    let started = call(&m2.rpc, &peer2, "machine.update", json!({ "version": "0.9.0" })).await.unwrap();
    assert_eq!(started["progress"]["phase"], "appUpdating");
    assert_eq!(started["progress"]["version"], "0.9.0");
    let requested = loop {
        match published2.recv().await {
            Ok(event) if &*event.event == updates::REQUESTED_EVENT => break event.payload.to_string(),
            Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            Err(error) => panic!("the event stream ended: {error}"),
        }
    };
    assert_eq!(requested, r#"{"version":"0.9.0"}"#);
    assert_eq!(code(call(&m2.rpc, &peer2, "machine.update", json!({ "version": "0.9.0" })).await), "update_busy");
    // The window reports each step; a failure is said, with what runs.
    updates::report(&m2.path("data"), &json!({ "phase": "installing" })).unwrap();
    let status = call(&m2.rpc, &peer2, "machine.updateStatus", json!({})).await.unwrap();
    assert_eq!(status["progress"]["step"], "installing");
    updates::report(&m2.path("data"), &json!({ "phase": "failed", "message": "The download was interrupted." })).unwrap();
    let status = call(&m2.rpc, &peer2, "machine.updateStatus", json!({})).await.unwrap();
    assert_eq!(status["progress"], json!({ "phase": "failed", "version": "0.9.0", "at": status["progress"]["at"], "message": "The download was interrupted.", "running": env!("CARGO_PKG_VERSION"), "rolledBack": false }));
}

#[tokio::test(flavor = "multi_thread")]
async fn each_connection_is_told_of_changes_without_itself_as_another_computer() {
    let m = machine_rpc();
    let root = installer(&m);
    let others = vec![OtherComputer { id: "computer-1".into(), label: "This one".into() }, OtherComputer { id: "studio".into(), label: "Studio".into() }];
    serving(&m, environment(&m, Some(root), false, no_blockers), Host { others, window: false });
    let (_peer, mut events, _) = computer(&m.rpc).await;
    let (older, mut older_events) = Peer::new("computer-old".into(), Authority::Manage);
    call(&m.rpc, &older, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["machine/1", "machine/2"] })).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let failed = Record {
        progress: Progress::Failed { version: "9.9.9".into(), at: 1, message: "TerminalX 9.9.9 did not come up after the handover.".into(), running: "0.0.1".into(), rolled_back: true },
        ..Record::default()
    };
    updates::write_record(&updates::status_path(&m.path("data")), &failed).unwrap();
    // A notification from connection setup can still report idle progress.
    let changed = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let changed = next_event(&mut events, "machine.updateChanged").await;
            if changed["status"]["progress"]["phase"] == "failed" {
                break changed;
            }
        }
    })
    .await
    .expect("no failed machine update notification");
    assert_eq!(changed["status"]["progress"]["rolledBack"], true, "{changed}");
    assert_eq!(changed["status"]["otherComputers"], json!([{ "id": "studio", "label": "Studio" }]), "{changed}");
    assert!(tokio::time::timeout(Duration::from_millis(300), async {
        loop {
            match older_events.recv().await {
                Some(value) if value["event"] == "machine.updateChanged" => return,
                Some(_) => continue,
                None => std::future::pending::<()>().await,
            }
        }
    })
    .await
    .is_err(), "a connection without machine/3 is not told");
}

/// PRO-350: the machine's page reads each agent's version and login there,
/// and the agents with no CLI there, from `runtime.agents`.
#[tokio::test(flavor = "multi_thread")]
async fn runtime_agents_reports_each_agents_sign_in_and_the_missing_ones() {
    use crate::harness::readiness::State;
    let m = machine_rpc();
    // A path of this test's own: kept logins are per agent and path.
    m.rpc.set_offered_for_tests(
        crate::harness::catalog()
            .into_iter()
            .map(|mut agent| {
                agent.available = agent.id == "claude";
                agent.path = agent.available.then(|| format!("/opt/pro-350/{}", agent.binary));
                agent
            })
            .collect(),
    );
    m.rpc.set_sign_ins_for_tests(HashMap::from([("claude".to_string(), (State::Ready, Some("2.4.1".to_string())))]));
    let (peer, _events, _) = computer(&m.rpc).await;
    let listed = call(&m.rpc, &peer, "runtime.agents", json!({ "refresh": true })).await.unwrap();
    let claude = &listed["agents"][0];
    assert_eq!(claude["id"], "claude");
    assert_eq!(claude["signIn"], "signedIn");
    assert_eq!(claude["version"], "2.4.1");
    assert!(claude["signInCheckedAt"].as_u64().unwrap() > 0);
    let missing = listed["missing"].as_array().unwrap();
    let codex = missing.iter().find(|agent| agent["id"] == "codex").expect("codex has no CLI there");
    assert_eq!(codex["name"], "Codex");
    assert_eq!(codex["installable"], cfg!(unix));
    assert!(missing.iter().all(|agent| agent["id"] != "claude"), "an installed agent is not missing");

    // Signed out since: a kept answer is used for a minute, `refresh` asks again.
    m.rpc.set_sign_ins_for_tests(HashMap::from([("claude".to_string(), (State::SignedOut, Some("2.4.1".to_string())))]));
    let kept = call(&m.rpc, &peer, "runtime.agents", json!({})).await.unwrap();
    assert_eq!(kept["agents"][0]["signIn"], "signedIn");
    // A participant's refresh starts no probe: it is answered from the kept
    // check. A participant is served only once the members are listed
    // (#475), and then a manage connection names its person too.
    m.rpc.set_collaboration(Some(
        serde_json::from_value(json!({ "v": 1, "members": [{ "userId": "admin", "role": "manager" }, { "userId": "viewer", "role": "viewer" }] })).unwrap(),
    ));
    let (manager, _manager_events) = Peer::for_user("manager-350".into(), Authority::Manage, Some("admin".into()));
    call(&m.rpc, &manager, "rpc.hello", json!({ "protocol": PROTOCOL, "want": protocol::served(true) })).await.unwrap();
    let (viewer, _viewer_events) = Peer::for_user("viewer-350".into(), Authority::Participate, Some("viewer".into()));
    call(&m.rpc, &viewer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["agents/1"] })).await.unwrap();
    let viewed = call(&m.rpc, &viewer, "runtime.agents", json!({ "refresh": true })).await.unwrap();
    assert_eq!(viewed["agents"][0]["signIn"], "signedIn");
    let asked = call(&m.rpc, &manager, "runtime.agents", json!({ "refresh": true })).await.unwrap();
    assert_eq!(asked["agents"][0]["signIn"], "signedOut");

    // A probe that cannot tell is unknown, never signed out.
    m.rpc.set_sign_ins_for_tests(HashMap::from([("claude".to_string(), (State::Unknown, None))]));
    let unknown = call(&m.rpc, &manager, "runtime.agents", json!({ "refresh": true })).await.unwrap();
    assert_eq!(unknown["agents"][0]["signIn"], "unknown");
    assert_eq!(unknown["agents"][0]["version"], Value::Null);
}

/// A runtime serving one workspace starts no login probe and lists nothing
/// missing: its agents are shown as an older runtime's are, without a state.
#[tokio::test(flavor = "multi_thread")]
async fn a_one_root_runtime_reports_agents_without_sign_in() {
    let _home = crate::store::temp_home();
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let terminals = Arc::new(Terminals::new());
    let rpc = WorkspaceRpc::new(&root, 1, Arc::new(BroadcastSink::new(16)), terminals.clone(), None).unwrap();
    rpc.set_offered_for_tests(crate::harness::catalog().into_iter().map(|mut agent| { agent.available = agent.id == "claude"; agent }).collect());
    rpc.set_sign_ins_for_tests(HashMap::from([("claude".to_string(), (crate::harness::readiness::State::Ready, None))]));
    let (peer, _events) = Peer::new("device".into(), Authority::Manage);
    call(&rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["agents/1"] })).await.unwrap();
    let listed = call(&rpc, &peer, "runtime.agents", json!({ "refresh": true })).await.unwrap();
    assert_eq!(listed["agents"][0]["id"], "claude");
    assert!(listed["agents"][0].get("signIn").is_none() && listed["agents"][0].get("version").is_none());
    assert!(listed.get("missing").is_none());
    terminals.kill_all();
}

/// PRO-350: Sign in and Install run in a terminal on the machine, one step at
/// a time per agent; the terminal is not a shell of `pty.list`, and its exit
/// code is the setup wrapper's.
#[tokio::test(flavor = "multi_thread")]
async fn an_agents_setup_runs_in_a_terminal_on_the_machine_one_at_a_time() {
    let m = machine_rpc();
    // Stands in for `codex login --device-auth`, which would wait for a person.
    m.rpc.set_setup_command_for_tests("sh -c 'sleep 2; exit 74'");
    let (peer, mut events, hello) = computer(&m.rpc).await;
    assert!(hello["capabilities"].as_array().unwrap().contains(&json!("machine/4")), "{hello}");

    let started = call(&m.rpc, &peer, "machine.agentSetup", json!({ "harness": "codex", "step": "login", "cols": 90, "rows": 20 })).await.unwrap();
    let pty_id = started["ptyId"].as_str().unwrap().to_string();
    assert_eq!(started["setup"], json!({ "harness": "codex", "step": "login" }));
    assert_eq!(started["cols"], 90);

    // Another start of the same agent follows the one that runs.
    let busy = call(&m.rpc, &peer, "machine.agentSetup", json!({ "harness": "codex", "step": "install", "cols": 90, "rows": 20 })).await;
    assert_eq!(code(busy), "setup_busy");
    let running = call(&m.rpc, &peer, "machine.agentSetupRunning", json!({ "harness": "codex" })).await.unwrap();
    assert_eq!(running["run"], json!({ "ptyId": pty_id, "step": "login" }));
    let other = call(&m.rpc, &peer, "machine.agentSetupRunning", json!({ "harness": "claude" })).await.unwrap();
    assert_eq!(other["run"], Value::Null);

    // Not one of the machine's shells.
    let listed = call(&m.rpc, &peer, "pty.list", json!({})).await.unwrap();
    assert!(listed["terminals"].as_array().unwrap().iter().all(|pty| pty["ptyId"] != pty_id.as_str()));

    // Attached as any terminal; its exit says how the step ended.
    call(&m.rpc, &peer, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    let exit = next_event(&mut events, "pty.exit").await;
    assert_eq!(exit["ptyId"], pty_id.as_str());
    assert_eq!(exit["code"], 74);
    let after = call(&m.rpc, &peer, "machine.agentSetupRunning", json!({ "harness": "codex" })).await.unwrap();
    assert_eq!(after["run"], Value::Null);

    // Bad input is refused before anything runs; a viewer cannot start one.
    assert_eq!(code(call(&m.rpc, &peer, "machine.agentSetup", json!({ "harness": "codex", "step": "uninstall", "cols": 90, "rows": 20 })).await), "invalid_params");
    let (viewer, _viewer_events) = Peer::new("viewer".into(), Authority::Participate);
    call(&m.rpc, &viewer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["machine/4", "pty/1"] })).await.unwrap();
    assert!(call(&m.rpc, &viewer, "machine.agentSetup", json!({ "harness": "codex", "step": "login", "cols": 90, "rows": 20 })).await.is_err());
    // Nor follow one: a sign-in's device code chooses whose account the CLI uses.
    assert!(call(&m.rpc, &viewer, "machine.agentSetupRunning", json!({ "harness": "codex" })).await.is_err());
    assert_eq!(code(call(&m.rpc, &viewer, "pty.attach", json!({ "ptyId": pty_id })).await), "forbidden");
    assert_eq!(code(call(&m.rpc, &viewer, "pty.write", json!({ "ptyId": pty_id, "data": "eA==", "seq": 1 })).await), "forbidden");
}

/// The command a machine's page runs: the registry's, and for Codex the
/// sign-in that needs no browser on the machine.
#[test]
fn a_sign_in_started_from_another_computer_uses_the_device_code_where_there_is_one() {
    if cfg!(windows) || crate::binpath::resolve("codex").is_none() {
        return;
    }
    let step = crate::harness::setup::Step::Login;
    let here = crate::harness::setup::command("codex", step).unwrap();
    let elsewhere = crate::harness::setup::command_elsewhere("codex", step).unwrap();
    assert!(!here.contains("--device-auth"));
    assert!(elsewhere.ends_with("'login' '--device-auth'"), "{elsewhere}");
}

// ------------------------------------------------- machine/6 (PRO-351)

/// PRO-351: a paired computer browses the machine's home, adds a folder as
/// a project and removes it again; each change reaches `machine.changed`,
/// and the folder stays. A session-scoped participant can do none of it.
#[tokio::test(flavor = "multi_thread")]
async fn a_paired_computer_adds_and_removes_a_machines_projects() {
    let m = machine_rpc();
    let home = m.path("home");
    let api = home.join("code/api");
    std::fs::create_dir_all(&api).unwrap();
    std::fs::write(api.join("README.md"), "api\n").unwrap();
    m.rpc.set_home_for_tests(&home);
    let (peer, mut events, hello) = computer(&m.rpc).await;
    assert!(hello["capabilities"].as_array().unwrap().contains(&json!("machine/6")), "{hello}");
    // Let the watcher read what is there before anything changes.
    tokio::time::sleep(Duration::from_millis(300)).await;

    let listing = call(&m.rpc, &peer, "machine.browse", json!({})).await.unwrap();
    assert_eq!(listing["home"], home.to_string_lossy().as_ref());
    assert_eq!(listing["entries"][0]["name"], "code");
    let code_dir = call(&m.rpc, &peer, "machine.browse", json!({ "path": home.join("code") })).await.unwrap();
    assert_eq!(code_dir["entries"][0]["path"], api.to_string_lossy().as_ref());
    assert_eq!(code(call(&m.rpc, &peer, "machine.browse", json!({ "path": m.path("") })).await), "path_forbidden");

    let added = call(&m.rpc, &peer, "machine.addProject", json!({ "path": api })).await.unwrap();
    let id = added["project"]["projectId"].as_str().unwrap().to_string();
    let changed = next_event(&mut events, "machine.changed").await;
    assert!(changed["projects"].as_array().unwrap().iter().any(|project| project["projectId"] == id.as_str()), "{changed}");
    let again = call(&m.rpc, &peer, "machine.browse", json!({ "path": home.join("code") })).await.unwrap();
    assert_eq!(again["entries"][0]["projectId"], id.as_str());

    assert_eq!(call(&m.rpc, &peer, "machine.removeProject", json!({ "projectId": id })).await.unwrap(), json!({ "removed": true }));
    let changed = next_event(&mut events, "machine.changed").await;
    assert!(!changed["projects"].as_array().unwrap().iter().any(|project| project["projectId"] == id.as_str()), "{changed}");
    assert!(api.join("README.md").exists(), "the folder stays");
    assert_eq!(code(call(&m.rpc, &peer, "machine.removeProject", json!({ "projectId": id })).await), "not_found");
    assert_eq!(code(call(&m.rpc, &peer, "machine.cloneStatus", json!({ "cloneId": "clone-unknown" })).await), "not_found");

    let (viewer, _viewer_events) = Peer::new("viewer".into(), Authority::Participate);
    call(&m.rpc, &viewer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["machine/6"] })).await.unwrap();
    for (method, params) in [
        ("machine.browse", json!({})),
        ("machine.addProject", json!({ "path": api })),
        ("machine.removeProject", json!({ "projectId": id })),
        ("machine.cloneProject", json!({ "repository": "acme/api", "parent": home })),
        ("machine.cloneStatus", json!({ "cloneId": "clone-unknown" })),
        ("machine.cloneCancel", json!({ "cloneId": "clone-unknown" })),
    ] {
        assert!(call(&m.rpc, &viewer, method, params).await.is_err(), "{method} is the manager's");
    }
    assert!(crate::store::projects::list().unwrap().0.is_empty(), "the viewer added nothing");
}

/// A one-root runtime has no machine/6: it never lists folders outside its root.
#[tokio::test(flavor = "multi_thread")]
async fn a_one_root_runtime_has_no_machine_6() {
    let _home = crate::store::temp_home();
    let dir = tempfile::tempdir().unwrap();
    let terminals = Arc::new(Terminals::new());
    let rpc = WorkspaceRpc::new(dir.path(), 1, Arc::new(BroadcastSink::new(16)), terminals.clone(), None).unwrap();
    let (peer, _events) = Peer::new("device".into(), Authority::Manage);
    let hello = call(&rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["machine/6", "fs/1"] })).await.unwrap();
    assert_eq!(hello["capabilities"], json!(["fs/1"]));
    assert_eq!(code(call(&rpc, &peer, "machine.browse", json!({})).await), "capability_not_granted");
    terminals.kill_all();
}

// ------------------------------------------------- machine/7 (PRO-403)

/// A workspace session of `project` on the machine: its own checkout inside
/// the project's folder, as a worktree session has.
fn workspace_session(project: &Path, id: &str) -> SessionEntry {
    let cwd = project.join(".worktrees").join(id);
    std::fs::create_dir_all(&cwd).unwrap();
    let entry: SessionEntry = serde_json::from_value(json!({
        "id": id, "projectPath": project, "cwd": cwd, "title": id,
        "worktreeName": id, "branch": "main", "created": "", "modified": "", "tabs": [],
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
async fn listed_until(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, what: &str, found: impl Fn(&Value) -> bool) -> Value {
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

/// What a terminal printed, from its first byte.
async fn output_of(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, pty_id: &str) -> String {
    let attached = call(rpc, peer, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    String::from_utf8_lossy(&STANDARD.decode(attached["data"].as_str().unwrap()).unwrap()).into_owned()
}

/// PRO-403: a machine session's Setup and Run come from the machine. Its
/// project's actions and setup script are read from the machine's store; each
/// run is the machine runtime's own pane in the session's folder there, with
/// the machine's ports, listed with its session and attached as a terminal.
/// A non-concurrent action is not started twice; Restart replaces it.
#[tokio::test(flavor = "multi_thread")]
async fn a_machine_sessions_setup_and_actions_run_on_the_machine() {
    let m = machine_rpc();
    let (path, _project_id) = project(&m.path("code"), "api");
    let action = |id: &str, command: &str, run_after_setup: bool| crate::store::projects::RepositoryActionEntry {
        id: id.into(), name: format!("{id} action"), command: command.into(), run_after_setup, ..Default::default()
    };
    crate::store::projects::update(&path.to_string_lossy(), crate::store::projects::ProjectPatch {
        scripts: Some(crate::store::projects::RepositoryScripts { setup: "printf 'set up in %s\\n' \"$PWD\"".into(), archive: String::new(), archive_timeout_minutes: None }),
        actions: Some(vec![
            action("hello", "printf 'hello %s on %s\\n' \"$TERMINALX_ACTION_ID\" \"$TERMINALX_PORT\"; exit 3", false),
            action("serve", "printf serving; exec sleep 60", false),
            action("after", "printf after-setup", true),
        ]),
        preview_urls: Some(vec![crate::store::projects::PreviewUrlEntry { id: "web".into(), name: "Web".into(), url: "http://localhost:$PORT".into() }]),
        ..Default::default()
    })
    .unwrap();
    let session = workspace_session(&path, "machine-run");
    let (peer, _events, hello) = computer(&m.rpc).await;
    assert!(hello["capabilities"].as_array().unwrap().contains(&json!("machine/7")), "{hello}");

    let saved = call(&m.rpc, &peer, "machine.sessionActions", json!({ "sessionId": session.id })).await.unwrap();
    let names: Vec<&str> = saved["actions"].as_array().unwrap().iter().map(|action| action["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["hello action", "serve action", "after action"], "{saved}");
    assert_eq!(saved["previewUrls"][0]["url"], "http://localhost:$PORT");
    assert_eq!(saved["setupScript"], "printf 'set up in %s\\n' \"$PWD\"");
    assert_eq!(saved["setupApplies"], true);
    assert_eq!(saved["setup"], Value::Null, "nothing has run yet");
    let ports = saved["ports"].as_array().expect("the machine's port block").clone();
    let port = ports[0].as_u64().unwrap();

    // Setup runs on the machine, in the session's folder; its pane is listed as the session's setup, and its end starts "Run after setup".
    let rerun = call(&m.rpc, &peer, "machine.setupRerun", json!({ "sessionId": session.id })).await.unwrap();
    let pane = rerun["setup"]["paneId"].as_str().unwrap().to_string();
    let setup = listed_until(&m.rpc, &peer, "setup terminal", |terminal| terminal["run"]["kind"] == "setup").await;
    assert_eq!(setup["ptyId"], pane.as_str());
    assert_eq!(setup["sessionId"], session.id.as_str());
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let now = call(&m.rpc, &peer, "machine.sessionActions", json!({ "sessionId": session.id })).await.unwrap();
        if now["setup"]["status"] == "succeeded" {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "setup did not finish: {now}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(output_of(&m.rpc, &peer, &pane).await.contains(&format!("set up in {}", std::fs::canonicalize(&session.cwd).unwrap().display())));
    assert_eq!(code(call(&m.rpc, &peer, "pty.kill", json!({ "ptyId": pane })).await), "forbidden", "setup is stopped as setup");
    let after = listed_until(&m.rpc, &peer, "Run after setup", |terminal| terminal["run"]["actionId"] == "after").await;
    assert_eq!(after["run"]["name"], "after action");

    // An action the paired computer starts: in the session's folder, with the machine's port, its exit code heard.
    let ran = call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": session.id, "actionId": "hello" })).await.unwrap();
    assert_eq!(ran["started"], true, "{ran}");
    let hello_pty = ran["run"]["ptyId"].as_str().unwrap().to_string();
    assert_eq!(ran["terminal"]["run"], json!({ "kind": "action", "actionId": "hello", "name": "hello action" }));
    assert_eq!(ran["terminal"]["control"], "you", "the person who ran it types into it");
    let exited = listed_until(&m.rpc, &peer, "hello's exit", |terminal| terminal["ptyId"] == hello_pty.as_str() && terminal["exited"] == true).await;
    assert_eq!(exited["exitCode"], 3);
    assert!(output_of(&m.rpc, &peer, &hello_pty).await.contains(&format!("hello hello on {port}")));

    // Non-concurrent: a second start shows the running one; Restart replaces it.
    let serving = call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": session.id, "actionId": "serve" })).await.unwrap();
    let first = serving["run"]["ptyId"].as_str().unwrap().to_string();
    let again = call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": session.id, "actionId": "serve" })).await.unwrap();
    assert_eq!((again["started"].clone(), again["run"]["ptyId"].clone()), (json!(false), json!(first)));
    let restarted = call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": session.id, "actionId": "serve", "restart": true })).await.unwrap();
    assert_eq!(restarted["started"], true);
    assert_ne!(restarted["run"]["ptyId"], json!(first));
    let restarted_pty = restarted["run"]["ptyId"].as_str().unwrap().to_string();
    assert!(m.terminals.is_running(&restarted_pty), "it runs in the machine's runtime");

    // Closing a run's tab ends it on the machine, and it is not listed again.
    call(&m.rpc, &peer, "pty.kill", json!({ "ptyId": restarted_pty })).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let listed = call(&m.rpc, &peer, "pty.list", json!({})).await.unwrap();
    assert!(!listed["terminals"].as_array().unwrap().iter().any(|terminal| terminal["ptyId"] == restarted_pty.as_str()), "{listed}");
    assert!(!m.terminals.is_running(&restarted_pty));

    // Not an action the machine has saved, and not the viewer's to start.
    assert_eq!(code(call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": session.id, "actionId": "nope" })).await), "conflict");
    assert_eq!(code(call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": "no-such-session", "actionId": "hello" })).await), "not_found");
    let (viewer, _viewer_events) = Peer::new("viewer".into(), Authority::Participate);
    call(&m.rpc, &viewer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["machine/1", "machine/7", "pty/1", "pty/2"] })).await.unwrap();
    for method in ["machine.runAction", "machine.setupRerun", "machine.setupStop"] {
        assert!(call(&m.rpc, &viewer, method, json!({ "sessionId": session.id, "actionId": "hello", "paneId": pane })).await.is_err(), "{method} is the manager's");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn exited_machine_runs_stay_evicted_when_their_runtime_panes_are_listed() {
    let m = machine_rpc();
    let (path, _) = project(&m.path("code"), "api");
    crate::store::projects::update(&path.to_string_lossy(), crate::store::projects::ProjectPatch {
        actions: Some(vec![crate::store::projects::RepositoryActionEntry {
            id: "quick".into(),
            name: "Quick".into(),
            command: "printf run-output; exit 0".into(),
            ..Default::default()
        }]),
        ..Default::default()
    }).unwrap();
    let session = workspace_session(&path, "retention");
    let (peer, _events, _) = computer(&m.rpc).await;

    // The three oldest exits are runs. The next oldest is a shell whose
    // output should survive both listing and the eleventh exit.
    let mut ids = Vec::new();
    for n in 0..11 {
        let id = if matches!(n, 0..=2 | 4 | 6 | 8) {
            let ran = call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": session.id, "actionId": "quick" })).await.unwrap();
            ran["run"]["ptyId"].as_str().unwrap().to_string()
        } else {
            let shell = call(&m.rpc, &peer, "pty.create", json!({ "sessionId": session.id, "clientRequestId": format!("retention-{n}") })).await.unwrap();
            let id = shell["ptyId"].as_str().unwrap().to_string();
            let data = "printf '%s%s\\n' retained- shell; exit 0\n";
            call(&m.rpc, &peer, "pty.write", json!({ "ptyId": id, "data": data, "seq": 1 })).await.unwrap();
            id
        };
        listed_until(&m.rpc, &peer, "terminal exit", |terminal| terminal["ptyId"] == id.as_str() && terminal["exitCode"] == 0).await;
        ids.push(id);

        if n >= 9 {
            let first_retained = ids.len() - 8;
            for id in &ids[..first_retained] {
                assert!(m.terminals.shell(id).is_some(), "runtime still owns {id}");
            }
            for _ in 0..3 {
                let listed = call(&m.rpc, &peer, "pty.list", json!({})).await.unwrap();
                let mut retained: Vec<_> = listed["terminals"].as_array().unwrap().iter().map(|terminal| {
                    assert_eq!(terminal["exited"], true);
                    terminal["ptyId"].as_str().unwrap()
                }).collect();
                retained.sort_unstable();
                let mut expected: Vec<_> = ids[first_retained..].iter().map(String::as_str).collect();
                expected.sort_unstable();
                assert_eq!(retained, expected);
            }
            assert!(output_of(&m.rpc, &peer, &ids[3]).await.contains("retained-shell"));
        }
    }

    // Even with a free retention slot, the evicted panes stay undiscoverable.
    call(&m.rpc, &peer, "pty.kill", json!({ "ptyId": ids[3] })).await.unwrap();
    let listed = call(&m.rpc, &peer, "pty.list", json!({})).await.unwrap();
    assert_eq!(listed["terminals"].as_array().unwrap().len(), 7, "{listed}");
}

#[tokio::test(flavor = "multi_thread")]
async fn delayed_run_exit_gets_observed_priority_after_backfill_eviction() {
    let m = machine_rpc();
    let (path, _) = project(&m.path("code"), "api");
    let session = workspace_session(&path, "delayed-exit");
    let (peer, _events, _) = computer(&m.rpc).await;

    let exit_shell = |n| {
        let rpc = &m.rpc;
        let peer = &peer;
        let session_id = &session.id;
        async move {
            let shell = call(rpc, peer, "pty.create", json!({ "sessionId": session_id, "clientRequestId": format!("delayed-exit-{n}") })).await.unwrap();
            let id = shell["ptyId"].as_str().unwrap().to_string();
            call(rpc, peer, "pty.write", json!({ "ptyId": id, "data": "exit 0\n", "seq": 1 })).await.unwrap();
            listed_until(rpc, peer, "shell exit", |terminal| terminal["ptyId"] == id.as_str() && terminal["exitCode"] == 0).await;
            id
        }
    };
    let oldest = exit_shell(0).await;
    for n in 1..MAX_EXITED_PTYS - 1 {
        exit_shell(n).await;
    }

    // Capture the runtime's actual exit on a separate sink so the RPC sees
    // the finished pane on listing before it receives the exit event.
    let pane = format!("{}:action-{}-717569636b", session.id, uuid::Uuid::now_v7().simple());
    let delayed = Arc::new(BroadcastSink::new(16));
    let mut events = delayed.subscribe_app();
    m.terminals.spawn(delayed, &pane, crate::pty::PaneSpec {
        cwd: &session.cwd, cols: 80, rows: 24, command: Some("/bin/sh -c 'printf delayed-run-output; exit 7'"), env: &[],
    }).unwrap();
    let exit: PtyExit = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            let event = events.recv().await.unwrap();
            if event.event.as_ref() == "pty_exit" {
                break serde_json::from_str(&event.payload).unwrap();
            }
        }
    }).await.expect("the run exited");
    assert!(!m.terminals.is_running(&pane));
    let backfilled = listed_until(&m.rpc, &peer, "backfilled run", |terminal| terminal["ptyId"] == pane.as_str()).await;
    assert_eq!(backfilled["exited"], true);
    assert_eq!(backfilled["exitCode"], Value::Null);

    exit_shell(MAX_EXITED_PTYS - 1).await;
    let listed = call(&m.rpc, &peer, "pty.list", json!({})).await.unwrap();
    assert!(listed["terminals"].as_array().unwrap().iter().all(|terminal| terminal["ptyId"] != pane.as_str()));
    assert!(m.terminals.shell(&pane).is_some());

    m.rpc.on_pty_exit(exit);
    let listed = call(&m.rpc, &peer, "pty.list", json!({})).await.unwrap();
    let terminals = listed["terminals"].as_array().unwrap();
    assert_eq!(terminals.len(), MAX_EXITED_PTYS);
    assert!(terminals.iter().all(|terminal| terminal["ptyId"] != oldest.as_str()));
    let restored = terminals.iter().find(|terminal| terminal["ptyId"] == pane.as_str()).expect("the observed exit displaced the oldest shell");
    assert_eq!(restored["exitCode"], 7);
    assert!(output_of(&m.rpc, &peer, &pane).await.contains("delayed-run-output"));
}

/// A one-root runtime has no machine/7: its sessions' scripts are its own window's.
#[tokio::test(flavor = "multi_thread")]
async fn a_one_root_runtime_has_no_machine_7() {
    assert!(!protocol::served(false).contains(&"machine/7"));
    assert!(protocol::served(true).contains(&"machine/7"));
    for name in ["machine.sessionActions", "machine.runAction", "machine.setupRerun", "machine.setupStop"] {
        assert_eq!(protocol::find_method(name).unwrap().capability, "machine/7", "{name}");
    }
}

// ------------------------------------------------- machine/8 (PRO-408)

/// PRO-408: a machine session's cost chip, Continue in a new tab and Fix
/// check errors read on the machine. `session.usage` reports the totals the
/// machine keeps for its tabs, `session.prepareContinuation` a tab's context
/// with the machine's own paths, and `session.checkFailures` refuses what it
/// cannot read before running `gh`.
#[tokio::test(flavor = "multi_thread")]
async fn a_machine_session_reports_its_usage_and_continuation_on_the_machine() {
    let m = machine_rpc();
    let (path, id) = project(&m.path("code"), "api");
    let (peer, _events, hello) = computer(&m.rpc).await;
    assert!(hello["capabilities"].as_array().unwrap().contains(&json!("machine/8")), "{hello}");
    let made = call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "model": "opus", "title": "Usage", "projectId": id, "clientRequestId": "create-usage" }))
        .await
        .unwrap();
    let session_id = made["sessionId"].as_str().unwrap().to_string();
    let tab_id = made["session"]["tabs"][0]["id"].as_str().unwrap().to_string();
    let row = crate::session_usage::ModelUsage { model: "claude-opus-4-5".into(), input_tokens: 1200, output_tokens: 300, cache_read_tokens: 5000, cache_write_tokens: 0, cost_usd: Some(0.42) };
    index::update_session(&session_id, |session| {
        session.tab_mut(&tab_id).unwrap().usage = Some(crate::session_usage::TabUsage { models: vec![row.clone()], updated: index::now() });
        Ok(())
    })
    .unwrap();

    let usage = call(&m.rpc, &peer, "session.usage", json!({ "sessionId": session_id })).await.unwrap();
    assert_eq!(usage["usage"]["sessionId"], json!(session_id), "{usage}");
    assert_eq!(usage["usage"]["models"][0]["model"], "claude-opus-4-5", "{usage}");
    assert_eq!(usage["usage"]["total"]["costUsd"], json!(0.42), "{usage}");
    assert_eq!(usage["usage"]["tabs"][0]["tabId"], json!(tab_id), "{usage}");
    assert!(usage["loginMethods"].as_object().unwrap().contains_key("claude"), "each agent with usage is named: {usage}");
    assert!(usage["windows"].is_array(), "{usage}");
    // The listed session carries the totals too, for the header's chip.
    let listed = call(&m.rpc, &peer, "session.get", json!({ "sessionId": session_id })).await.unwrap();
    assert_eq!(listed["session"]["tabs"][0]["usage"]["models"][0]["costUsd"], json!(0.42), "{listed}");
    assert!(listed["session"]["tabs"][0].get("accountLabel").is_none(), "one account: no label: {listed}");

    let prepare = || call(&m.rpc, &peer, "session.prepareContinuation", json!({ "sessionId": session_id, "tabId": tab_id }));
    let refused = prepare().await.unwrap_err();
    assert_eq!(refused.0, "internal");
    assert!(refused.1.contains("No usable saved context"), "{refused:?}");

    // The runtime can hand off recent messages from the saved app log when
    // the provider has no complete transcript for this tab.
    let prompt = "Review usage";
    let reply = "The machine retained this exchange.";
    let log = crate::store::log_path(&session_id, &tab_id).unwrap();
    for (seq, payload) in [
        (1, json!({ "type": "user_message", "text": prompt, "images": [], "queued": false })),
        (2, json!({ "type": "assistant_text", "text": reply })),
    ] {
        let event = json!({
            "id": format!("saved-{seq}"),
            "seq": seq,
            "ts": index::now(),
            "sessionId": session_id,
            "tabId": tab_id,
            "harness": "claude",
            "payload": payload,
        });
        crate::store::append_line(&log, &event.to_string()).unwrap();
    }
    let context = prepare().await.unwrap();
    assert_eq!(context["tabId"], json!(tab_id), "{context}");
    assert_eq!(context["provider"], "claude", "{context}");
    assert_eq!(context["cwd"], json!(path), "the machine's own folder: {context}");
    assert_eq!(context["lastPrompt"], prompt, "{context}");
    assert_eq!(context["lastUpdate"], reply, "{context}");
    assert!(context["transcriptPath"].is_null(), "{context}");
    let capture = context["partialCapture"].as_str().unwrap();
    assert!(capture.ends_with(&format!("User: {prompt}\n\nAssistant: {reply}")), "{context}");
    assert_eq!(code(call(&m.rpc, &peer, "session.prepareContinuation", json!({ "sessionId": session_id, "tabId": "tab-nope" })).await), "not_found");
    assert_eq!(code(call(&m.rpc, &peer, "session.usage", json!({ "sessionId": "session-nope" })).await), "not_found");

    assert_eq!(code(call(&m.rpc, &peer, "session.checkFailures", json!({ "sessionId": session_id, "tabId": tab_id, "prUrl": "file:///etc/passwd" })).await), "invalid_params");
    assert_eq!(code(call(&m.rpc, &peer, "session.checkFailures", json!({ "sessionId": session_id, "tabId": "tab-nope", "prUrl": "https://github.com/acme/api/pull/1" })).await), "not_found");

    // A session-scoped participant reads no logs.
    let (viewer, _viewer_events) = Peer::new("viewer".into(), Authority::Participate);
    call(&m.rpc, &viewer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["machine/1", "machine/8"] })).await.unwrap();
    assert_eq!(code(call(&m.rpc, &viewer, "session.checkFailures", json!({ "sessionId": session_id, "tabId": tab_id, "prUrl": "https://github.com/acme/api/pull/1" })).await), "forbidden");
}

/// A one-root runtime has no machine/8: its sessions' parity is the cloud's.
#[tokio::test(flavor = "multi_thread")]
async fn a_one_root_runtime_has_no_machine_8() {
    let _home = crate::store::temp_home();
    let dir = tempfile::tempdir().unwrap();
    let terminals = Arc::new(Terminals::new());
    let rpc = WorkspaceRpc::new(dir.path(), 1, Arc::new(BroadcastSink::new(16)), terminals.clone(), None).unwrap();
    let (peer, _events) = Peer::new("device".into(), Authority::Manage);
    let hello = call(&rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["machine/8", "fs/1"] })).await.unwrap();
    assert_eq!(hello["capabilities"], json!(["fs/1"]));
    assert_eq!(code(call(&rpc, &peer, "session.usage", json!({ "sessionId": "s" })).await), "capability_not_granted");
    terminals.kill_all();
}
