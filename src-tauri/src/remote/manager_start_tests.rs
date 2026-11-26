//! PRO-546: a workspace manager on a `participate` connection (a phone is
//! always one, whoever holds it) starts a session or adds an agent tab, in a
//! narrow form, and nothing else a `manage` attachment does.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::{call, fixture, Fixture};
use crate::remote::protocol::{self, Authority, PROTOCOL};
use crate::remote::server::{Notifications, Peer, WorkspaceRpc};
use crate::store::index;

/// The workspace's people, as the API lists them on a refresh.
fn listed(f: &Fixture, members: Value) {
    f.rpc.set_collaboration(Some(serde_json::from_value(json!({ "v": 1, "members": members })).unwrap()));
}

/// One person's connection, granted everything this runtime offers. A
/// `participate` one says it is the phone app, as the app does.
async fn connect(rpc: &Arc<WorkspaceRpc>, device: &str, authority: Authority, user: &str) -> (Arc<Peer>, Notifications, Value) {
    let (peer, events) = Peer::for_user(device.into(), authority, Some(user.into()));
    let app = if authority == Authority::Participate { "terminalx-mobile" } else { "terminalx-desktop" };
    let hello = call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": protocol::CAPABILITIES, "client": { "app": app } })).await.unwrap();
    (peer, events, hello)
}

/// The refusal a call gets: its code, message and data.
async fn refused(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, method: &str, params: Value) -> Value {
    let response = rpc.handle(peer, &json!({ "id": "1", "method": method, "params": params })).await;
    assert_eq!(response["ok"], false, "{method} was not refused: {response}");
    response["error"].clone()
}

/// The next `collab.you` a connection is sent: who it is now.
async fn next_you(events: &mut Notifications) -> Value {
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let next = events.recv().await.expect("the connection is open");
            if next["event"] == "collab.you" {
                return next["params"]["you"].clone();
            }
        }
    })
    .await
    .expect("collab.you was sent")
}

/// What the stand-in Claude was started with for a new session's first prompt.
async fn launched(f: &Fixture, created: &Value) -> Vec<String> {
    assert!(created["startError"].is_null(), "the first prompt was not sent: {created}");
    let session = index::get(created["sessionId"].as_str().unwrap()).unwrap();
    let provider_id = session.tabs[0].provider_session_id.clone().expect("Claude conversation id");
    let marker = f._dir.path().join("agent.ran");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(args) = std::fs::read_to_string(&marker) {
            let args: Vec<String> = args.lines().map(str::to_string).collect();
            if args.windows(2).any(|pair| pair[0] == "--session-id" && pair[1] == provider_id) {
                std::fs::remove_file(&marker).unwrap();
                return args;
            }
        }
        assert!(tokio::time::Instant::now() < deadline, "stand-in Claude did not record --session-id {provider_id}: {:?}", std::fs::read_to_string(&marker));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn tab_mode(session_id: &str, tab_id: &str) -> String {
    index::get(session_id).unwrap().tabs.into_iter().find(|tab| tab.id == tab_id).expect("the tab is stored").permission_mode
}

#[tokio::test(flavor = "multi_thread")]
async fn a_manager_on_a_participate_connection_starts_a_session_and_adds_a_tab() {
    let f = fixture();
    listed(&f, json!([{ "userId": "owner", "role": "manager" }]));
    let (phone, _events, hello) = connect(&f.rpc, "phone", Authority::Participate, "owner").await;
    // Still a participant: only the two calls are new, and `you` says so.
    assert_eq!((hello["authority"].as_str(), hello["you"]["role"].as_str(), hello["you"]["canStart"].as_bool()), (Some("participate"), Some("manager"), Some(true)));

    // A new session with its first prompt, in the mode it names.
    let create = json!({ "clientRequestId": "phone-create-1", "agent": "claude", "model": "", "mode": "manual", "title": "From the phone", "prompt": "Say hello" });
    let created = call(&f.rpc, &phone, "session.create", create.clone()).await.unwrap();
    let args = launched(&f, &created).await;
    assert!(args.windows(2).any(|pair| pair[0] == "--permission-mode" && pair[1] == "manual"), "{args:?}");
    assert!(!args.iter().any(|arg| arg == "--dangerously-skip-permissions"), "{args:?}");
    let session_id = created["sessionId"].as_str().unwrap().to_string();
    let session = index::get(&session_id).unwrap();
    assert_eq!((session.title.as_str(), session.tabs.len(), session.tabs[0].permission_mode.as_str()), ("From the phone", 1, "manual"));
    assert!(session.worktree_name.is_none(), "it runs on the workspace's checkout");
    // A resend is answered from the cache: one session, not two.
    assert_eq!(call(&f.rpc, &phone, "session.create", create).await.unwrap(), created);
    assert_eq!(index::load().unwrap().len(), 1);

    // Another mode, with the model's effort, and no prompt.
    let planned = call(&f.rpc, &phone, "session.create", json!({ "clientRequestId": "phone-create-2", "agent": "claude", "mode": "plan", "effort": "high" })).await.unwrap();
    let stored = index::get(planned["sessionId"].as_str().unwrap()).unwrap();
    assert_eq!((stored.tabs[0].permission_mode.as_str(), stored.tabs[0].effort.as_deref()), ("plan", Some("high")));
    assert!(planned["outcome"].is_null() && planned["startError"].is_null(), "no prompt, so nothing was launched: {planned}");

    // A second agent tab in the first session.
    let add = json!({ "clientRequestId": "phone-tab-1", "sessionId": session_id, "agent": "claude", "mode": "acceptEdits" });
    let added = call(&f.rpc, &phone, "session.addTab", add.clone()).await.unwrap();
    assert_eq!(added["sessionId"], session_id.as_str());
    assert_eq!(tab_mode(&session_id, added["tabId"].as_str().unwrap()), "acceptEdits");
    assert_eq!(call(&f.rpc, &phone, "session.addTab", add).await.unwrap(), added);
    assert_eq!(index::get(&session_id).unwrap().tabs.len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_participate_connection_of_another_role_is_refused_and_told_its_role() {
    let f = fixture();
    // A driver who approves may change a tab's settings and type into a
    // shell, and still starts nothing: that is a manager's.
    listed(&f, json!([
        { "userId": "owner", "role": "manager" },
        { "userId": "dana", "role": "driver", "canApprove": true },
        { "userId": "vic", "role": "viewer", "canApprove": true },
    ]));
    let (desk, _desk_events, _) = connect(&f.rpc, "desk", Authority::Manage, "owner").await;
    let existing = call(&f.rpc, &desk, "session.create", json!({ "clientRequestId": "desk-create-1", "agent": "claude" })).await.unwrap();
    let session_id = existing["sessionId"].as_str().unwrap();
    for (user, role) in [("dana", "driver"), ("vic", "viewer"), ("nobody", "none")] {
        let (phone, _events, hello) = connect(&f.rpc, &format!("phone-{user}"), Authority::Participate, user).await;
        assert_eq!((hello["you"]["role"].as_str(), hello["you"]["canStart"].as_bool()), (Some(role), Some(false)), "{user}");
        for (method, params) in [
            ("session.create", json!({ "clientRequestId": format!("{user}-create"), "agent": "claude", "mode": "manual", "prompt": "Say hello" })),
            ("session.addTab", json!({ "clientRequestId": format!("{user}-tab-00"), "sessionId": session_id, "agent": "claude", "mode": "manual" })),
        ] {
            let error = refused(&f.rpc, &phone, method, params).await;
            assert_eq!(error["code"], "forbidden", "{user} {method}: {error}");
            assert_eq!(error["message"], format!("{method} needs a workspace manager"), "{user}: {error}");
            assert_eq!(error["data"]["role"], role, "{user} {method}: the refusal names the role");
        }
    }
    assert_eq!(index::load().unwrap().len(), 1, "nothing was started");
    assert_eq!(index::get(session_id).unwrap().tabs.len(), 1);
    assert!(!f._dir.path().join("agent.ran").exists(), "no agent was launched");
}

#[tokio::test(flavor = "multi_thread")]
async fn nothing_is_started_before_the_member_list_arrives() {
    let f = fixture();
    // After a restart nobody's role is known until the API's list arrives.
    let (phone, mut events, hello) = connect(&f.rpc, "phone", Authority::Participate, "owner").await;
    assert_eq!((hello["you"]["listed"].as_bool(), hello["you"]["canStart"].as_bool()), (Some(false), Some(false)));
    let create = json!({ "clientRequestId": "early-create-1", "agent": "claude", "mode": "manual" });
    for (method, params) in [
        ("session.create", create.clone()),
        ("session.addTab", json!({ "clientRequestId": "early-tab-0001", "sessionId": "any-session", "agent": "claude", "mode": "manual" })),
    ] {
        let error = refused(&f.rpc, &phone, method, params).await;
        assert_eq!((error["code"].as_str(), error["data"]["reason"].as_str(), error["data"]["role"].as_str()), (Some("forbidden"), Some("access-unknown"), Some("none")), "{method}: {error}");
    }
    assert!(index::load().unwrap().is_empty());

    // The list says they manage the workspace: the connection is told, and
    // the same request now runs (a refusal is never kept as its answer).
    listed(&f, json!([{ "userId": "owner", "role": "manager" }]));
    let you = next_you(&mut events).await;
    assert_eq!((you["role"].as_str(), you["listed"].as_bool(), you["canStart"].as_bool()), (Some("manager"), Some(true), Some(true)));
    call(&f.rpc, &phone, "session.create", create).await.unwrap();
    assert_eq!(index::load().unwrap().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_demoted_manager_is_refused_on_the_next_call() {
    let f = fixture();
    listed(&f, json!([{ "userId": "owner", "role": "manager" }, { "userId": "admin", "role": "manager" }]));
    let (phone, mut events, _) = connect(&f.rpc, "phone", Authority::Participate, "owner").await;
    let (desk, _desk_events, _) = connect(&f.rpc, "desk", Authority::Manage, "owner").await;
    let create = json!({ "clientRequestId": "before-demotion-1", "agent": "claude", "mode": "manual" });
    let created = call(&f.rpc, &phone, "session.create", create.clone()).await.unwrap();
    let session_id = created["sessionId"].as_str().unwrap();

    // No longer a manager, but still shared with as a driver who approves:
    // the most anyone who does not manage the workspace has.
    listed(&f, json!([{ "userId": "owner", "role": "driver", "canApprove": true }, { "userId": "admin", "role": "manager" }]));
    let you = next_you(&mut events).await;
    assert_eq!((you["role"].as_str(), you["canStart"].as_bool()), (Some("driver"), Some(false)));
    // Their phone, and their desktop's `manage` attachment from before.
    for (who, peer) in [("phone", &phone), ("desk", &desk)] {
        for (method, params) in [
            ("session.create", json!({ "clientRequestId": format!("{who}-demoted-1"), "agent": "claude", "mode": "manual" })),
            ("session.addTab", json!({ "clientRequestId": format!("{who}-demoted-2"), "sessionId": session_id, "agent": "claude", "mode": "manual" })),
        ] {
            let error = refused(&f.rpc, peer, method, params).await;
            assert_eq!((error["code"].as_str(), error["data"]["role"].as_str()), (Some("forbidden"), Some("driver")), "{who} {method}: {error}");
        }
    }
    // The request that ran while they managed is not answered from the cache.
    assert_eq!(refused(&f.rpc, &phone, "session.create", create).await["code"], "forbidden");
    assert_eq!(index::load().unwrap().len(), 1);
    assert_eq!(index::get(session_id).unwrap().tabs.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_manage_connection_starts_exactly_as_before() {
    let f = fixture();
    // Against an API from before sharing there is no member list: `manage`
    // keeps its meaning, and a new tab takes the default launch mode.
    let (old, _old_events, hello) = connect(&f.rpc, "old-desk", Authority::Manage, "owner").await;
    assert_eq!((hello["authority"].as_str(), hello["you"]["listed"].as_bool(), hello["you"]["canStart"].as_bool()), (Some("manage"), Some(false), Some(true)));
    let unlisted = call(&f.rpc, &old, "session.create", json!({ "clientRequestId": "old-create-1", "agent": "claude" })).await.unwrap();
    assert_eq!(index::get(unlisted["sessionId"].as_str().unwrap()).unwrap().tabs[0].permission_mode, index::DEFAULT_PERMISSION_MODE);

    listed(&f, json!([{ "userId": "owner", "role": "manager" }]));
    let (desk, _events, hello) = connect(&f.rpc, "desk", Authority::Manage, "owner").await;
    assert_eq!((hello["authority"].as_str(), hello["you"]["canStart"].as_bool()), (Some("manage"), Some(true)));
    // Every field a desktop sends is taken: a worktree, the pipeline switch,
    // the native Codex setting. No mode is the default launch mode.
    let created = call(&f.rpc, &desk, "session.create", json!({ "clientRequestId": "desk-create-1", "agent": "claude", "useWorktree": true, "worktreeName": "desk-work", "pipeline": false, "nativeCodex": true })).await.unwrap();
    let session = index::get(created["sessionId"].as_str().unwrap()).unwrap();
    assert!(session.worktree_name.is_some(), "a worktree was cut");
    assert_eq!(session.tabs[0].permission_mode, index::DEFAULT_PERMISSION_MODE);
    // Bypass by name, and a field `session.addTab` does not read is passed over.
    let bypass = call(&f.rpc, &desk, "session.create", json!({ "clientRequestId": "desk-create-2", "agent": "claude", "mode": "bypassPermissions" })).await.unwrap();
    assert_eq!(index::get(bypass["sessionId"].as_str().unwrap()).unwrap().tabs[0].permission_mode, "bypassPermissions");
    let added = call(&f.rpc, &desk, "session.addTab", json!({ "clientRequestId": "desk-tab-1", "sessionId": session.id, "agent": "claude", "mode": "bypassPermissions", "nativeCodex": true, "title": "passed over" })).await.unwrap();
    assert_eq!(tab_mode(&session.id, added["tabId"].as_str().unwrap()), "bypassPermissions");
    let plain = call(&f.rpc, &desk, "session.addTab", json!({ "clientRequestId": "desk-tab-2", "sessionId": session.id, "agent": "claude" })).await.unwrap();
    assert_eq!(tab_mode(&session.id, plain["tabId"].as_str().unwrap()), index::DEFAULT_PERMISSION_MODE);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_participate_connection_sends_only_the_narrow_fields() {
    let f = fixture();
    listed(&f, json!([{ "userId": "owner", "role": "manager" }]));
    let (desk, _desk_events, _) = connect(&f.rpc, "desk", Authority::Manage, "owner").await;
    let existing = call(&f.rpc, &desk, "session.create", json!({ "clientRequestId": "desk-create-1", "agent": "claude" })).await.unwrap();
    let session_id = existing["sessionId"].as_str().unwrap();
    // Every capability is granted, so none of this is a capability refusal.
    let (phone, _events, _) = connect(&f.rpc, "phone", Authority::Participate, "owner").await;

    let extras = [
        ("useWorktree", json!(true)),
        ("worktreeName", json!("phone-work")),
        ("repository", json!({ "identity": "github.com/acme/api", "directory": "api" })),
        ("baseRef", json!("main")),
        ("issue", super::issue()),
        ("issueBody", json!("Do it")),
        ("pipeline", json!(true)),
        ("pipelineOptions", json!({ "resolveConflicts": true })),
        ("pipelineSettings", json!({})),
        ("nativeCodex", json!(true)),
        ("projectId", json!("AAAAAAAAAAAAAAAA")),
        ("cwd", json!("/")),
        ("somethingNewer", json!(1)),
        // The name is refused, whatever it carries.
        ("repository", Value::Null),
        ("useWorktree", json!(false)),
    ];
    for (n, (field, value)) in extras.iter().enumerate() {
        let mut params = json!({ "clientRequestId": format!("extra-create-{n:02}"), "agent": "claude", "mode": "manual", "prompt": "Say hello" });
        params[*field] = value.clone();
        let error = refused(&f.rpc, &phone, "session.create", params).await;
        assert_eq!((error["code"].as_str(), error["data"]["reason"].as_str(), error["data"]["field"].as_str()), (Some("forbidden"), Some("field-needs-manage"), Some(*field)), "{field}: {error}");
    }
    // A tab is added with no prompt and no title: neither is dropped unsaid.
    for (n, field) in ["nativeCodex", "prompt", "title", "projectId", "useWorktree"].into_iter().enumerate() {
        let mut params = json!({ "clientRequestId": format!("extra-tab-{n:02}"), "sessionId": session_id, "agent": "claude", "mode": "manual" });
        params[field] = json!("x");
        let error = refused(&f.rpc, &phone, "session.addTab", params).await;
        assert_eq!((error["code"].as_str(), error["data"]["reason"].as_str(), error["data"]["field"].as_str()), (Some("forbidden"), Some("field-needs-manage"), Some(field)), "{field}: {error}");
    }

    assert_eq!(index::load().unwrap().len(), 1, "nothing was started");
    assert_eq!(index::get(session_id).unwrap().tabs.len(), 1);
    assert!(!f._dir.path().join("agent.ran").exists(), "no agent was launched");
}

/// A tab whose creator names no mode starts in Bypass, so for a `participate`
/// connection no mode would be Bypass by omission. It names one, by its exact
/// name, and not Bypass; nothing is filled in for it.
#[tokio::test(flavor = "multi_thread")]
async fn a_participate_start_names_a_permission_mode_that_is_not_bypass() {
    let f = fixture();
    listed(&f, json!([{ "userId": "owner", "role": "manager" }]));
    let (desk, _desk_events, _) = connect(&f.rpc, "desk", Authority::Manage, "owner").await;
    let existing = call(&f.rpc, &desk, "session.create", json!({ "clientRequestId": "desk-create-1", "agent": "claude" })).await.unwrap();
    let session_id = existing["sessionId"].as_str().unwrap();
    let (phone, _events, _) = connect(&f.rpc, "phone", Authority::Participate, "owner").await;
    let asks = json!(["plan", "manual", "auto", "acceptEdits"]);

    // Both calls, with `mode` as given; `None` sends no `mode` at all.
    let start = |n: usize, mode: Option<&Value>| {
        let mut create = json!({ "clientRequestId": format!("mode-create-{n:02}"), "agent": "claude", "prompt": "Say hello" });
        let mut add = json!({ "clientRequestId": format!("mode-tab-{n:02}"), "sessionId": session_id, "agent": "claude" });
        if let Some(mode) = mode {
            create["mode"] = mode.clone();
            add["mode"] = mode.clone();
        }
        [("session.create", create), ("session.addTab", add)]
    };
    let mut n = 0;
    // Missing or blank: refused, never read as the default launch mode.
    for mode in [None, Some(Value::Null), Some(json!("")), Some(json!("   ")), Some(json!("\n\t"))] {
        n += 1;
        for (method, params) in start(n, mode.as_ref()) {
            let error = refused(&f.rpc, &phone, method, params).await;
            assert_eq!((error["code"].as_str(), error["data"]["reason"].as_str()), (Some("invalid_params"), Some("mode-required")), "{method} with mode {mode:?}: {error}");
            assert_eq!(error["data"]["modes"], asks, "{method}: the refusal names the modes it takes");
        }
    }
    // Unknown: a name no tab is launched in, a near miss of one, or no string.
    for mode in [
        json!("bypass"), json!("dontAsk"), json!("default"), json!("yolo"), json!("Manual"), json!(" manual "),
        json!("BypassPermissions"), json!(" bypassPermissions "), json!("bypassPermissions\n"), json!(7), json!(true), json!(["bypassPermissions"]), json!({ "mode": "manual" }),
    ] {
        n += 1;
        for (method, params) in start(n, Some(&mode)) {
            let error = refused(&f.rpc, &phone, method, params).await;
            assert_eq!((error["code"].as_str(), error["data"]["reason"].as_str()), (Some("invalid_params"), Some("mode-unknown")), "{method} with mode {mode}: {error}");
            assert_eq!(error["data"]["modes"], asks, "{method}");
        }
    }
    // Bypass, by its name.
    n += 1;
    for (method, params) in start(n, Some(&json!("bypassPermissions"))) {
        let error = refused(&f.rpc, &phone, method, params).await;
        assert_eq!((error["code"].as_str(), error["data"]["reason"].as_str(), error["data"]["mode"].as_str()), (Some("forbidden"), Some("mode-needs-manage"), Some("bypassPermissions")), "{method}: {error}");
        assert_eq!(error["data"]["modes"], asks, "{method}");
    }
    assert_eq!(index::load().unwrap().len(), 1, "nothing was started");
    assert_eq!(index::get(session_id).unwrap().tabs.len(), 1);
    assert!(!f._dir.path().join("agent.ran").exists(), "no agent was launched");

    // Each mode that is not Bypass is taken, and is the mode the tab has.
    for (n, mode) in ["plan", "manual", "auto", "acceptEdits"].into_iter().enumerate() {
        let created = call(&f.rpc, &phone, "session.create", json!({ "clientRequestId": format!("named-create-{n}"), "agent": "claude", "mode": mode })).await.unwrap();
        assert_eq!(index::get(created["sessionId"].as_str().unwrap()).unwrap().tabs[0].permission_mode, mode);
        let added = call(&f.rpc, &phone, "session.addTab", json!({ "clientRequestId": format!("named-tab-{n:04}"), "sessionId": session_id, "agent": "claude", "mode": mode })).await.unwrap();
        assert_eq!(tab_mode(session_id, added["tabId"].as_str().unwrap()), mode);
    }
    assert_eq!(index::load().unwrap().len(), 5);
    assert_eq!(index::get(session_id).unwrap().tabs.len(), 5);
}

#[tokio::test(flavor = "multi_thread")]
async fn every_other_manage_method_is_still_refused_to_a_managers_participate_connection() {
    let f = fixture();
    listed(&f, json!([{ "userId": "owner", "role": "manager" }]));
    let (phone, _events, hello) = connect(&f.rpc, "phone", Authority::Participate, "owner").await;
    let granted: Vec<&str> = hello["capabilities"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    let mut refused_for_authority = Vec::new();
    for (n, method) in protocol::METHODS.iter().enumerate() {
        if method.authority != Authority::Manage || protocol::MANAGER_START.contains(&method.name) {
            continue;
        }
        let error = refused(&f.rpc, &phone, method.name, json!({ "clientRequestId": format!("stays-manage-{n:03}") })).await;
        if granted.contains(&method.capability) {
            assert_eq!(error["code"], "forbidden", "{}: {error}", method.name);
            assert_eq!(error["message"], format!("{} needs manage authority", method.name));
            refused_for_authority.push(method.name);
        } else {
            // A machine's methods: a workspace's runtime does not serve them at all.
            assert_eq!(error["code"], "capability_not_granted", "{}: {error}", method.name);
        }
    }
    for named in [
        "pty.create", "pty.kill", "fs.write", "fs.rename", "fs.delete", "git.commit", "git.push", "git.prMerge", "keys.rotate",
        "session.close", "session.delete", "session.update", "session.configure", "session.undoTurn", "session.restoreUndo",
        "session.reset", "session.fork", "session.handoff", "workspace.remove", "pipeline.act",
    ] {
        assert!(refused_for_authority.contains(&named), "{named} was not refused for want of manage authority");
    }
}

/// The stricter member list of PRO-167 (`collaboration-v2`, which no released
/// runtime advertises yet) stamps every call with its connection and admits a
/// configuration call by the person's row alone: their role, their approval
/// right and where their write access comes from. It asks nothing of the
/// attachment's authority, so a manager's phone is admitted where their
/// desktop is, and refused where it is.
#[tokio::test(flavor = "multi_thread")]
async fn the_runtime_policy_admits_a_managers_phone_where_it_admits_their_desktop() {
    // The runtime's cloud agents bound the policy store when the fixture
    // shared its collaboration state with them; the list is what is new.
    let f = fixture();
    let snapshot = json!({ "v": 2, "revision": "1", "members": [
        { "userId": "owner", "role": "manager", "canApprove": true, "approvalSource":"explicit", "writeSource": "explicit" },
        { "userId": "plain", "role": "manager", "canApprove": false, "writeSource": "explicit" },
    ]});
    f.rpc.collab.install_v2(serde_json::from_value(snapshot).unwrap()).unwrap();

    for (device, authority) in [("desk", Authority::Manage), ("phone", Authority::Participate)] {
        let (peer, _events, hello) = connect(&f.rpc, device, authority, "owner").await;
        assert_eq!(hello["you"]["canStart"], true, "{device}");
        let created = call(&f.rpc, &peer, "session.create", json!({ "clientRequestId": format!("{device}-create-1"), "agent": "claude", "mode": "manual", "prompt": "Say hello" })).await.unwrap();
        launched(&f, &created).await;
        call(&f.rpc, &peer, "session.addTab", json!({ "clientRequestId": format!("{device}-tab-0001"), "sessionId": created["sessionId"], "agent": "claude", "mode": "manual" })).await.unwrap();
    }
    assert_eq!(index::load().unwrap().len(), 2);

    // A manager without the approval right configures nothing under this
    // list, from either kind of connection.
    for (device, authority) in [("plain-desk", Authority::Manage), ("plain-phone", Authority::Participate)] {
        let (peer, _events, hello) = connect(&f.rpc, device, authority, "plain").await;
        assert_eq!((hello["you"]["role"].as_str(), hello["you"]["canStart"].as_bool()), (Some("manager"), Some(false)), "{device}");
        let error = refused(&f.rpc, &peer, "session.create", json!({ "clientRequestId": format!("{device}-create-1"), "agent": "claude", "mode": "manual" })).await;
        assert_eq!(error["code"], "forbidden", "{device}: {error}");
    }
    assert_eq!(index::load().unwrap().len(), 2);
}
