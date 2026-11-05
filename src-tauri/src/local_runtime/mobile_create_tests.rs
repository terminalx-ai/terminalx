//! A paired phone starting sessions and changing this Mac's settings. Each
//! case runs in a child of its own: stand-in agent CLIs go first on the
//! lookup path, which a process fixes once.
use super::*;
use crate::{harness::host::Host, pty, session::SessionManager, sink, store};
use serde_json::json;
use std::time::{Duration, Instant};

const CASE: &str = "TERMINALX_TEST_PHONE_CREATE_CASE";

#[test]
fn a_phone_starts_sessions_and_changes_settings_as_the_desktop_does() {
    for case in ["create", "settings", "refused"] {
        let dir = tempfile::tempdir().unwrap();
        let log = std::fs::File::create(dir.path().join("child.log")).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "local_runtime::mobile::create_tests::phone_create_child", "--nocapture"])
            .env(CASE, case).env("TERMINALX_HOME", dir.path().join("store"))
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log)
            .spawn().unwrap();
        let until = Instant::now() + Duration::from_secs(60);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() { break status; }
            if Instant::now() >= until {
                child.kill().unwrap(); child.wait().unwrap();
                panic!("{case}: phone session creation exceeded its deadline");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(status.success(), "{case}: {}", std::fs::read_to_string(dir.path().join("child.log")).unwrap());
    }
}

fn git(dir: &std::path::Path, args: &[&str]) {
    let status = std::process::Command::new("git").args(args).current_dir(dir)
        .env("GIT_AUTHOR_NAME", "Fixture").env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture").env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
        .status().unwrap();
    assert!(status.success(), "git {args:?}");
}

#[test]
fn phone_create_child() {
    use std::os::unix::fs::PermissionsExt;
    let Ok(case) = std::env::var(CASE) else { return };
    let _home = store::temp_home();
    let root = store::root().unwrap();
    // Installed agents, as far as this Mac can tell: no turn ever runs here.
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    for agent in ["codex", "claude"] {
        std::fs::write(bin.join(agent), "#!/bin/sh\nexit 0\n").unwrap();
        std::fs::set_permissions(bin.join(agent), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(crate::binpath::set_priority_dir(&bin));
    store::write_json(&root.join("devices.json"), &json!({"devices":[
        {"id":"driver","label":"Phone","platform":"test","token":"fixture-hash","scope":"driver","provenance":"explicit","bindingGeneration":0,"createdAt":store::index::now()},
        {"id":"viewer","label":"Tablet","platform":"test","token":"fixture-hash-2","scope":"viewer","provenance":"explicit","bindingGeneration":0,"createdAt":store::index::now()},
    ]})).unwrap();
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["commit", "-q", "--allow-empty", "-m", "init"]);
    let repo = store::projects::add(repo.to_str().unwrap()).unwrap();
    let folder = root.join("notes");
    std::fs::create_dir_all(&folder).unwrap();
    let folder = store::projects::add(folder.to_str().unwrap()).unwrap();
    assert_eq!(folder.kind, store::projects::ProjectKind::Folder);

    let broadcast = Arc::new(sink::BroadcastSink::new(256));
    let mut events = broadcast.subscribe();
    let manager = SessionManager::new(broadcast, Arc::new(sink::NoObserver),
        Arc::new(Host::new()), Arc::new(pty::Terminals::new()), Arc::new(Default::default()),
        Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
    let lifetime = Lifetime::new(Duration::from_secs(60));
    let lease = lifetime.command("runtime.attach", json!({"protocol":1})).unwrap();
    let actor = json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null});
    let owner: Actor = serde_json::from_value(actor.clone()).unwrap();
    manager.mobile.register(&lifetime, owner.clone(), "phone", "driver").unwrap();
    manager.mobile.register(&lifetime, owner.clone(), "tablet", "viewer").unwrap();
    let call = |connection: &str, method: &str, mut params: Value| {
        params["actor"] = actor.clone();
        params["connection"] = json!(connection);
        execute(&manager, &lifetime, method, params)
    };
    let tab_of = |created: &Value| {
        let session = store::index::get(created["sessionId"].as_str().unwrap()).unwrap();
        let tab = session.tab(created["tabId"].as_str().unwrap()).unwrap().clone();
        (session, tab)
    };

    match case.as_str() {
        "create" => {
            // A quick chat, titled by its prompt's first line, as the window titles one.
            let quick = call("phone", "create", json!({"quick":true,"agent":"codex","model":"gpt-5","effort":"high","mode":"auto","prompt":"What is a monad?\nIn one line."})).unwrap();
            let (session, tab) = tab_of(&quick);
            assert!(session.is_quick());
            assert_eq!(session.title, "What is a monad?");
            assert_eq!((tab.harness.as_str(), tab.model.as_str(), tab.effort.as_deref(), tab.permission_mode.as_str()), ("codex", "gpt-5", Some("high"), "auto"));
            assert_eq!(tab.transport, store::index::AgentTransport::Pty, "Native Codex is off");
            assert_eq!(quick["native"], false);

            // A worktree of a Git project, named for the work as the desktop names one.
            let worktree = call("phone", "create", json!({"projectId":store::projects::public_id(&repo.path),"useWorktree":true,"agent":"claude","prompt":"Please fix the login redirect"})).unwrap();
            let (session, tab) = tab_of(&worktree);
            assert_eq!(session.project_path, repo.path);
            assert_eq!(session.worktree_name.as_deref(), Some("fix-login-redirect"));
            assert_ne!(session.cwd, repo.path);
            assert_eq!(tab.harness, "claude");

            // On the project's own checkout.
            let on_main = call("phone", "create", json!({"projectId":store::projects::public_id(&repo.path),"agent":"claude","prompt":"Look around"})).unwrap();
            assert_eq!(tab_of(&on_main).0.cwd, repo.path);
            let folder_session = call("phone", "create", json!({"projectId":store::projects::public_id(&folder.path),"agent":"claude","prompt":"Tidy"})).unwrap();
            assert_eq!(tab_of(&folder_session).0.cwd, folder.path);

            // Settings → Experimental → Native Codex reaches the phone's Codex
            // sessions as it reaches the desktop's, Ask every time excepted.
            let mut settings = store::settings::load();
            settings.experimental.native_codex = true;
            store::settings::save(&settings).unwrap();
            let native = call("phone", "create", json!({"quick":true,"agent":"codex","prompt":"Hi"})).unwrap();
            assert_eq!(tab_of(&native).1.transport, store::index::AgentTransport::ExperimentalCodexStdio);
            assert_eq!(native["native"], true);
            let asks = call("phone", "create", json!({"quick":true,"agent":"codex","mode":"manual","prompt":"Hi"})).unwrap();
            assert_eq!(tab_of(&asks).1.transport, store::index::AgentTransport::Pty);
            let claude = call("phone", "create", json!({"quick":true,"agent":"claude","prompt":"Hi"})).unwrap();
            assert_eq!(tab_of(&claude).1.transport, store::index::AgentTransport::Pty);
        }
        "settings" => {
            assert_eq!(call("tablet", "settings", json!({})).unwrap(), json!({"nativeCodex":false}));
            assert_eq!(call("phone", "setSettings", json!({"nativeCodex":true})).unwrap(), json!({"nativeCodex":true}));
            assert!(store::settings::load().experimental.native_codex);
            // The desktop's Settings → Experimental follows it while open.
            let published = std::iter::from_fn(|| events.try_recv().ok()).find(|published| &*published.event == "experimental_settings_changed").unwrap();
            assert_eq!(&*published.payload, r#"{"nativeCodex":true}"#);
            assert_eq!(call("tablet", "settings", json!({})).unwrap(), json!({"nativeCodex":true}));
            assert!(call("phone", "setSettings", json!({"nativeCodex":"yes"})).is_err());
        }
        "refused" => {
            let read_only = |result: Result<Value>| result.unwrap_err().to_string();
            assert!(read_only(call("tablet", "create", json!({"quick":true,"agent":"codex","prompt":"Hi"}))).contains("read-only"));
            assert!(read_only(call("tablet", "setSettings", json!({"nativeCodex":true}))).contains("read-only"));
            assert!(!store::settings::load().experimental.native_codex);
            let refused = |params: Value| call("phone", "create", params).unwrap_err().to_string();
            assert!(refused(json!({"projectId":store::projects::public_id(&folder.path),"useWorktree":true,"agent":"claude","prompt":"Tidy"})).contains("not a Git repository"));
            assert!(refused(json!({"projectId":"no-such-project","agent":"claude","prompt":"Hi"})).contains("no longer on this Mac"));
            assert!(refused(json!({"projectId":repo.path,"agent":"claude","prompt":"Hi"})).contains("no longer on this Mac"), "a path is not an id");
            assert!(refused(json!({"agent":"claude","prompt":"Hi"})).contains("Choose a project or a quick chat"));
            assert!(refused(json!({"quick":true,"projectId":store::projects::public_id(&repo.path),"agent":"claude","prompt":"Hi"})).contains("Choose a project or a quick chat"));
            assert!(refused(json!({"quick":true,"agent":"nobody","prompt":"Hi"})).contains("not an agent this Mac offers"));
            assert!(refused(json!({"quick":true,"agent":"claude","mode":"yolo","prompt":"Hi"})).contains("Unknown permission mode"));
            // An archived project is not offered, so it cannot be named.
            let archived = store::projects::update(&folder.path, store::projects::ProjectPatch { archived: Some(true), ..Default::default() }).unwrap();
            assert!(archived.archived);
            assert!(refused(json!({"projectId":store::projects::public_id(&archived.path),"agent":"claude","prompt":"Hi"})).contains("no longer on this Mac"));
            // A revoked phone starts nothing.
            let before = store::index::load().unwrap().len();
            manager.mobile.revoke_device(&owner, "driver").unwrap();
            assert!(call("phone", "create", json!({"quick":true,"agent":"claude","prompt":"Hi"})).is_err());
            assert!(call("phone", "setSettings", json!({"nativeCodex":true})).is_err());
            assert_eq!(store::index::load().unwrap().len(), before);
            assert!(!store::settings::load().experimental.native_codex);
        }
        _ => unreachable!(),
    }
    assert!(manager.terminals().panes().is_empty(), "creating a session starts no agent");
    lifetime.command("runtime.detach", lease).unwrap();
}
