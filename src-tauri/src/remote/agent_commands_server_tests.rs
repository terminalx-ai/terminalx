//! `agent-commands/1` (PRO-343): send, steer, stop and the permission
//! decision as live calls on a runtime with no cloud mailbox, each applied
//! once per device and `clientRequestId`.

use std::sync::atomic::AtomicBool;

use super::*;
use crate::cloud_agents::{AgentOps, AgentTabInfo, CloudAgents, DecisionError, Settings};
use crate::remote::agent_commands::{self, Journal};

/// What the agent was handed, in order.
#[derive(Default)]
struct Seen {
    configurations: usize,
    sends: Vec<String>,
    stops: usize,
    decisions: Vec<(String, String)>,
    /// Requests the agent is waiting on an answer to.
    pending: Vec<String>,
}

/// The agent side of one seeded tab: records what reaches it.
struct Agent {
    session_id: String,
    tab_id: String,
    busy: AtomicBool,
    seen: Mutex<Seen>,
}

impl Agent {
    fn new(session: &SessionEntry) -> Arc<Self> {
        Arc::new(Self { session_id: session.id.clone(), tab_id: session.tabs[0].id.clone(), busy: AtomicBool::new(false), seen: Mutex::default() })
    }

    fn sends(&self) -> Vec<String> {
        self.seen.lock().unwrap().sends.clone()
    }

    fn decide(&self, request_id: &str, answer: String) -> Result<(), DecisionError> {
        let mut seen = self.seen.lock().unwrap();
        let Some(index) = seen.pending.iter().position(|pending| pending == request_id) else { return Err(DecisionError::NotPending) };
        seen.pending.remove(index);
        seen.decisions.push((request_id.to_string(), answer));
        Ok(())
    }
}

/// `AgentOps` over [`Agent`], shared so a test keeps a handle.
struct Ops(Arc<Agent>);

impl AgentOps for Ops {
    fn tabs(&self) -> Vec<AgentTabInfo> {
        vec![AgentTabInfo {
            session_id: self.0.session_id.clone(),
            tab_id: self.0.tab_id.clone(),
            title: None,
            harness: "claude".into(),
            transport: Default::default(),
            model: String::new(),
            effort: None,
            requested_model: None,
            requested_effort: None,
            requested_permission_mode: None,
            permission_mode: "default".into(),
            status: crate::store::index::TabStatus::Idle,
            process: "running",
            pending_permissions: Vec::new(),
            follow_ups: Vec::new(),
            lease: None,
            sign_in: None,
            last_seq: 0,
            created: String::new(),
            modified: String::new(),
            last_message_at: None,
            has_messages: false,
            session_created: None,
            session_last_message_at: None,
            session_has_messages: false,
            history: None,
            reset: None,
        }]
    }
    fn busy(&self, _: &str, _: &str) -> bool {
        self.0.busy.load(Ordering::SeqCst)
    }
    fn send(&self, _: &str, _: &str, text: &str) -> anyhow::Result<()> {
        self.0.seen.lock().unwrap().sends.push(text.to_string());
        Ok(())
    }
    fn stop(&self, _: &str, _: &str) -> anyhow::Result<()> {
        self.0.seen.lock().unwrap().stops += 1;
        Ok(())
    }
    fn respond(&self, _: &str, _: &str, request_id: &str, option_id: &str) -> Result<(), DecisionError> {
        self.0.decide(request_id, option_id.to_string())
    }
    fn answer(&self, _: &str, _: &str, request_id: &str, answers: HashMap<String, String>) -> Result<(), DecisionError> {
        self.0.decide(request_id, serde_json::to_string(&answers).unwrap())
    }
    fn configure(&self, _: &str, _: &str, _: &Settings) -> anyhow::Result<()> {
        self.0.seen.lock().unwrap().configurations += 1;
        Ok(())
    }
    fn note(&self, _: &str, _: &str, _: &str) {}
    fn events(&self, _: &str, _: &str) -> anyhow::Result<Vec<Value>> {
        Ok(Vec::new())
    }
}

/// A mailbox that is never asked anything here: only its presence matters.
struct Mailbox;

impl crate::cloud_agents::api::MailboxApi for Mailbox {
    fn lease(&self, _: &str, _: u32) -> Result<crate::cloud_agents::api::Leased, crate::cloud_agents::api::CallError> {
        Ok(Default::default())
    }
    fn ack(&self, _: &str, _: &str, _: &crate::cloud_agents::api::Ack) -> Result<crate::cloud_agents::api::AckOutcome, crate::cloud_agents::api::CallError> {
        Ok(crate::cloud_agents::api::AckOutcome::Settled)
    }
    fn put_checkpoint(&self, _: &str, _: &crate::cloud_agents::api::Checkpoint) -> Result<crate::cloud_agents::api::PutOutcome, crate::cloud_agents::api::CallError> {
        Ok(crate::cloud_agents::api::PutOutcome::Stored)
    }
    fn delete_checkpoint(&self, _: &str) -> Result<(), crate::cloud_agents::api::CallError> {
        Ok(())
    }
}

/// A machine: agents without a mailbox, one seeded session and its tab.
struct Machine {
    f: Fixture,
    /// The runtime serving it now: `f.rpc` until [`Machine::restarted`].
    rpc: Arc<WorkspaceRpc>,
    agent: Arc<Agent>,
    agents: Arc<CloudAgents>,
    session_id: String,
    tab_id: String,
}

fn agents_dir(f: &Fixture) -> PathBuf {
    f._dir.path().join("agents")
}

fn machine() -> Machine {
    let f = fixture();
    let session = seed_session(&f.root, "Fix login", None);
    let agent = Agent::new(&session);
    let agents = CloudAgents::open(&agents_dir(&f), Arc::new(Ops(agent.clone())), None, None, 7).unwrap();
    f.rpc.set_agents(agents.clone());
    let rpc = f.rpc.clone();
    Machine { f, rpc, agent, agents, session_id: session.id.clone(), tab_id: session.tabs[0].id.clone() }
}

impl Machine {
    /// The same agent state, served by a runtime that was started again.
    fn restarted(self) -> Machine {
        let Machine { f, agent, session_id, tab_id, .. } = self;
        let rpc = WorkspaceRpc::new(&f.root, 7, f.sink.clone(), f.terminals.clone(), None).unwrap();
        let agents = CloudAgents::open(&agents_dir(&f), Arc::new(Ops(agent.clone())), None, None, 7).unwrap();
        rpc.set_agents(agents.clone());
        Machine { f, rpc, agent, agents, session_id, tab_id }
    }

    fn params(&self, request: &str, extra: Value) -> Value {
        let mut params = json!({ "sessionId": self.session_id, "tabId": self.tab_id, "clientRequestId": request });
        for (name, value) in extra.as_object().unwrap() {
            params[name] = value.clone();
        }
        params
    }
}

/// A paired computer's connection: manage authority, its own device.
async fn computer(rpc: &Arc<WorkspaceRpc>, device: &str) -> (Arc<Peer>, Notifications, Value) {
    let (peer, events) = Peer::new(device.into(), Authority::Manage);
    let hello = call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["session/1", "agent-commands/1"] })).await.unwrap();
    (peer, events, hello)
}

/// The whole reply: a refusal's `data` matters here.
async fn command(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, method: &str, params: Value) -> Result<Value, (String, Value)> {
    let response = rpc.handle(peer, &json!({ "id": "1", "method": method, "params": params })).await;
    if response["ok"] == true {
        Ok(response["result"].clone())
    } else {
        Err((response["error"]["code"].as_str().unwrap().to_string(), response["error"]["data"].clone()))
    }
}

fn refusal(result: Result<Value, (String, Value)>) -> (String, Value) {
    let (code, data) = result.expect_err("expected a refusal");
    (code, data["reason"].clone())
}

fn v2_policy(revision: &str, role: &str, approve: bool, source: Value) -> collab::v2::Snapshot {
    serde_json::from_value(json!({"v": 2, "revision": revision, "members": [
        {"userId": "admin", "role": role, "canApprove": approve, "writeSource": source}
    ]})).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn phase2_collaboration_v2_durable_rpc_preserves_independent_manager_approval_and_manage_reports() {
    let _home = crate::store::temp_home();
    let m = machine();
    m.rpc.collab.install_v2(v2_policy("1", "manager", false, json!("explicit"))).unwrap();
    let (peer, _events) = Peer::for_user("v2-manager".into(), Authority::Manage, Some("admin".into()));
    let hello = call(&m.rpc, &peer, "rpc.hello", json!({"protocol": PROTOCOL,
        "want": ["session/1", "agent-commands/1", "collab/1", "collab/2", "environment/1", "pty/1"]})).await.unwrap();
    assert_eq!(hello["authority"], "manage");
    assert_eq!(hello["you"]["role"], "manager");
    assert_eq!(hello["you"]["canApprove"], false);
    assert!(!hello["capabilities"].as_array().unwrap().iter().any(|v| v == "collab/2"));
    assert!(!crate::cloud_bootstrap::CAPABILITIES.split(',').any(|v| v == "collaboration-v2"));
    m.agent.seen.lock().unwrap().pending.push("r1".into());
    let decision = m.params("v2-decide-0001", json!({"requestId": "r1", "optionId": "allow"}));
    assert!(command(&m.rpc, &peer, "session.decide", decision).await.is_err());
    assert!(m.agent.seen.lock().unwrap().decisions.is_empty());
    let configure = m.params("v2-configure-0001", json!({"mode": "bypassPermissions"}));
    assert_eq!(code(call(&m.rpc, &peer, "session.configure", configure).await), "forbidden");
    assert_eq!(code(call(&m.rpc, &peer, "pty.create", json!({"clientRequestId": "v2-shell-0001"})).await), "forbidden");
    // Reports are a separate Manage authority, not approval or configuration.
    assert!(call(&m.rpc, &peer, "environment.cancel", json!({"requestId": uuid::Uuid::new_v4().to_string()})).await.is_ok());
    assert_eq!(code(call(&m.rpc, &peer, "environment.report", json!({"requestId": "bad", "command": "env"})).await), "invalid_params");
    let send = m.params("v2-send-0001", json!({"text": "review", "mode": "bypassPermissions"}));
    let first = command(&m.rpc, &peer, "session.send", send.clone()).await.unwrap();
    assert_eq!(first["settingsIgnored"], true);
    assert_eq!(command(&m.rpc, &peer, "session.send", send).await.unwrap(), first);
    assert_eq!(m.agent.sends(), vec!["review"]);
    assert_eq!(m.agent.seen.lock().unwrap().configurations, 0);
    assert!(command(&m.rpc, &peer, "session.send", m.params("v2-send-0001", json!({"text": "changed"}))).await.is_err());
    // Explicit and implicit approval remain distinct from the false grant.
    for (revision, source) in [("2", "explicit"), ("3", "implicit")] {
        m.rpc.collab.install_v2(v2_policy(revision, "manager", true, json!(source))).unwrap();
        let request = format!("request-{revision}");
        m.agent.seen.lock().unwrap().pending.push(request.clone());
        let params = m.params(&format!("v2-decision-000{revision}"), json!({"requestId": request, "optionId": "allow"}));
        command(&m.rpc, &peer, "session.decide", params).await.unwrap();
        call(&m.rpc, &peer, "session.configure", m.params(&format!("v2-configure-000{revision}"), json!({"mode": "plan"}))).await.unwrap();
    }
    assert_eq!(m.agent.seen.lock().unwrap().decisions.len(), 2);
    assert_eq!(m.agent.seen.lock().unwrap().configurations, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn phase2_collaboration_v2_durable_command_rejects_stale_stamp_before_journal_mark_or_agent_input() {
    let _home = crate::store::temp_home();
    let m = machine();
    m.rpc.collab.install_v2(v2_policy("10", "driver", false, json!("explicit"))).unwrap();
    let (peer, _events) = Peer::for_user("v2-driver".into(), Authority::Participate, Some("admin".into()));
    call(&m.rpc, &peer, "rpc.hello", json!({"protocol": PROTOCOL, "want": ["session/1", "agent-commands/1"]})).await.unwrap();
    let stamp = m.rpc.collab.runtime_policy.stamp("admin");
    m.rpc.collab.install_v2(v2_policy("11", "driver", false, json!("everyone"))).unwrap();
    let params = m.params("v2-stale-0001", json!({"text": "stale explicit input"}));
    assert!(m.rpc.agent_command(&peer, "session.send", params.clone(), stamp).is_err());
    let key = agent_commands::Key { device: peer.device_id.clone(), id: "v2-stale-0001".into() };
    assert!(matches!(m.rpc.agent_commands.get().unwrap().known(&key, crate::cloud_agents::now_ms()), agent_commands::Known::New));
    assert!(m.agent.sends().is_empty());
    // The production ManagerOps equivalent has no raw witness yet; no
    // inference from saved default mode or zero pending approvals is allowed.
    assert!(command(&m.rpc, &peer, "session.send", params).await.is_err());
    assert!(m.agent.sends().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn phase2_collaboration_v2_production_refresh_and_capabilities_stay_v1() {
    let _home = crate::store::temp_home();
    let m = machine();
    m.rpc.set_collaboration(members(json!([{"userId": "admin", "role": "manager", "canApprove": false}])));
    let (peer, _events) = Peer::for_user("v1-admin".into(), Authority::Manage, Some("admin".into()));
    let hello = call(&m.rpc, &peer, "rpc.hello", json!({"protocol": PROTOCOL, "want": ["collab/1", "collab/2", "session/1", "agent-commands/1"]})).await.unwrap();
    assert_eq!(hello["you"]["canApprove"], true, "v1 managers still always approve");
    assert!(!hello["capabilities"].as_array().unwrap().iter().any(|v| v == "collab/2"));
    assert!(!crate::cloud_bootstrap::CAPABILITIES.contains("collaboration-v2"));
    // The legacy-only entry point cannot silently interpret a v2 payload as v1.
    m.rpc.set_collaboration(Some(serde_json::from_value(json!({"v": 2, "revision": "1", "members": [
        {"userId": "admin", "role": "manager", "canApprove": false, "writeSource": "explicit"}
    ]})).unwrap()));
    assert_eq!(m.rpc.access(&peer), Access::NONE);
    assert!(command(&m.rpc, &peer, "session.send", m.params("v2-unsolicited-0001", json!({"text": "no"}))).await.is_err());
    assert!(m.agent.sends().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_send_repeated_after_a_dropped_connection_starts_one_turn_even_across_a_restart() {
    let _home = crate::store::temp_home();
    let m = machine();
    let (first, _events, hello) = computer(&m.rpc, "computer-a").await;
    assert_eq!(hello["capabilities"], json!(["session/1", "agent-commands/1"]), "a runtime with no mailbox offers it");
    let send = m.params("request-send-0001", json!({ "text": "fix the login form" }));
    let reply = command(&m.rpc, &first, "session.send", send.clone()).await.unwrap();
    assert_eq!(reply, json!({ "sessionId": m.session_id, "tabId": m.tab_id, "queued": false }));
    // The reply was lost with the connection; the same computer connects again and resends.
    m.rpc.disconnect(&first);
    let (again, _events, _) = computer(&m.rpc, "computer-a").await;
    assert_eq!(command(&m.rpc, &again, "session.send", send.clone()).await.unwrap(), reply);
    assert_eq!(m.agent.sends(), vec!["fix the login form"], "one turn, not two");
    // The same id with other text is another command: refused, and nothing is sent.
    let edited = m.params("request-send-0001", json!({ "text": "fix the signup form" }));
    assert_eq!(refusal(command(&m.rpc, &again, "session.send", edited.clone()).await), ("conflict".into(), json!("id-reused")));
    // Another computer's ids are its own.
    let (other, _events, _) = computer(&m.rpc, "computer-b").await;
    command(&m.rpc, &other, "session.send", edited).await.unwrap();
    assert_eq!(m.agent.sends().len(), 2);
    // A runtime restarted for an update still has the receipt: the ten-minute cache would not.
    let m = m.restarted();
    let (after, _events, _) = computer(&m.rpc, "computer-a").await;
    assert_eq!(command(&m.rpc, &after, "session.send", send).await.unwrap(), reply);
    assert_eq!(m.agent.sends().len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn sends_during_a_turn_queue_in_order_and_a_repeat_finds_its_queued_copy() {
    let _home = crate::store::temp_home();
    let m = machine();
    let (peer, _events, _) = computer(&m.rpc, "computer-a").await;
    m.agent.busy.store(true, Ordering::SeqCst);
    let first = m.params("request-queue-0001", json!({ "text": "first" }));
    let second = m.params("request-queue-0002", json!({ "text": "second" }));
    assert_eq!(command(&m.rpc, &peer, "session.send", first.clone()).await.unwrap()["queued"], true);
    assert_eq!(command(&m.rpc, &peer, "session.send", second).await.unwrap()["queued"], true);
    // Sent again after a drop: the queued copy answers, no second one is queued.
    assert_eq!(command(&m.rpc, &peer, "session.send", first).await.unwrap()["queued"], true);
    let queued: Vec<String> = m.agents.follow_ups.list(&m.tab_id).into_iter().map(|follow_up| follow_up.text).collect();
    assert_eq!(queued, vec!["first", "second"]);
    assert!(m.agent.sends().is_empty(), "nothing is typed into the running turn");
    // A steer goes into the running turn now, ahead of the queue.
    command(&m.rpc, &peer, "session.steer", m.params("request-steer-0001", json!({ "text": "also check mobile" }))).await.unwrap();
    assert_eq!(m.agent.sends(), vec!["also check mobile"]);
    // Each turn that ends takes the next queued send, in order.
    m.agent.busy.store(false, Ordering::SeqCst);
    for _ in 0..2 {
        m.agents.nudge_follow_ups(&m.tab_id);
        assert_eq!(m.agents.dispatch_follow_ups(), 1);
    }
    assert_eq!(m.agent.sends(), vec!["also check mobile", "first", "second"]);
    // A send while nothing is queued and no turn runs goes straight in.
    assert_eq!(command(&m.rpc, &peer, "session.send", m.params("request-queue-0003", json!({ "text": "third" }))).await.unwrap()["queued"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_drops_the_queue_and_is_answered_once() {
    let _home = crate::store::temp_home();
    let m = machine();
    let (peer, _events, _) = computer(&m.rpc, "computer-a").await;
    m.agent.busy.store(true, Ordering::SeqCst);
    command(&m.rpc, &peer, "session.send", m.params("request-queue-0001", json!({ "text": "later" }))).await.unwrap();
    let stop = m.params("request-stop-0001", json!({}));
    let stopped = command(&m.rpc, &peer, "session.stop", stop.clone()).await.unwrap();
    assert_eq!(stopped["droppedFollowUps"], json!(["request-queue-0001"]));
    assert!(m.agents.follow_ups.list(&m.tab_id).is_empty());
    assert_eq!(command(&m.rpc, &peer, "session.stop", stop).await.unwrap(), stopped);
    assert_eq!(m.agent.seen.lock().unwrap().stops, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_approval_unblocks_the_agent_once_and_a_stale_decision_is_refused() {
    let _home = crate::store::temp_home();
    let m = machine();
    let (peer, _events, _) = computer(&m.rpc, "computer-a").await;
    m.agent.seen.lock().unwrap().pending = vec!["permission-1".into(), "question-1".into()];
    let allow = m.params("request-decide-0001", json!({ "requestId": "permission-1", "optionId": "allow" }));
    let decided = command(&m.rpc, &peer, "session.decide", allow.clone()).await.unwrap();
    assert_eq!(decided, json!({ "sessionId": m.session_id, "tabId": m.tab_id, "requestId": "permission-1" }));
    // The reply was lost: the same decision again gets the first reply and answers nothing twice.
    assert_eq!(command(&m.rpc, &peer, "session.decide", allow).await.unwrap(), decided);
    // Answered again, from this computer or another, under a new id: refused.
    let again = m.params("request-decide-0002", json!({ "requestId": "permission-1", "optionId": "deny" }));
    let stale = command(&m.rpc, &peer, "session.decide", again).await;
    assert_eq!(stale.clone().unwrap_err().1, json!({ "reason": "request-not-pending", "requestId": "permission-1" }));
    assert_eq!(stale.unwrap_err().0, "conflict");
    let gone = m.params("request-decide-0003", json!({ "requestId": "permission-9", "optionId": "allow" }));
    assert_eq!(refusal(command(&m.rpc, &peer, "session.decide", gone).await), ("conflict".into(), json!("request-not-pending")));
    // A question is answered with its answers.
    let answer = m.params("request-decide-0004", json!({ "requestId": "question-1", "answers": { "Which form?": "Login" } }));
    command(&m.rpc, &peer, "session.decide", answer).await.unwrap();
    // A decision names the request it answers.
    let unnamed = m.params("request-decide-0005", json!({ "optionId": "allow" }));
    assert_eq!(command(&m.rpc, &peer, "session.decide", unnamed).await.unwrap_err().0, "invalid_params");
    assert_eq!(
        m.agent.seen.lock().unwrap().decisions,
        vec![("permission-1".to_string(), "allow".to_string()), ("question-1".to_string(), r#"{"Which form?":"Login"}"#.to_string())]
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_id_cut_off_mid_apply_is_outcome_unknown_but_a_stop_is_applied_again() {
    let _home = crate::store::temp_home();
    let m = machine();
    let send = m.params("request-send-0001", json!({ "text": "fix it" }));
    let stop = m.params("request-stop-0001", json!({}));
    // The runtime died after marking these and before their receipts.
    {
        let journal = Journal::open(&agents_dir(&m.f), crate::cloud_agents::now_ms()).unwrap();
        let key = |id: &str| agent_commands::Key { device: "computer-a".into(), id: id.into() };
        journal.applying(&key("request-send-0001"), &agent_commands::digest("session.send", &send), crate::cloud_agents::now_ms()).unwrap();
        journal.applying(&key("request-stop-0001"), &agent_commands::digest("session.stop", &stop), crate::cloud_agents::now_ms()).unwrap();
    }
    let m = m.restarted();
    let (peer, _events, _) = computer(&m.rpc, "computer-a").await;
    assert_eq!(refusal(command(&m.rpc, &peer, "session.send", send.clone()).await), ("outcome_unknown".into(), json!("runtime-interrupted")));
    // It stays unknown, and is never typed.
    assert_eq!(refusal(command(&m.rpc, &peer, "session.send", send).await).0, "outcome_unknown");
    assert!(m.agent.sends().is_empty());
    // A stop is safe to repeat: it is applied, then answered from its receipt.
    command(&m.rpc, &peer, "session.stop", stop.clone()).await.unwrap();
    command(&m.rpc, &peer, "session.stop", stop).await.unwrap();
    assert_eq!(m.agent.seen.lock().unwrap().stops, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refusal_before_the_applying_mark_is_decided_again_and_one_after_it_is_kept() {
    let _home = crate::store::temp_home();
    let m = machine();
    let (peer, _events, _) = computer(&m.rpc, "computer-a").await;
    // A slash command never waits in a running turn's queue: refused before
    // anything was marked, so the same id is decided afresh once the turn ends.
    m.agent.busy.store(true, Ordering::SeqCst);
    let compact = m.params("request-steer-0001", json!({ "text": "/compact" }));
    assert_eq!(refusal(command(&m.rpc, &peer, "session.steer", compact.clone()).await), ("conflict".into(), json!("command-not-queued")));
    m.agent.busy.store(false, Ordering::SeqCst);
    command(&m.rpc, &peer, "session.steer", compact).await.unwrap();
    assert_eq!(m.agent.sends(), vec!["/compact"]);
    // An image that never arrived is found missing while applying, as the
    // mailbox finds it: that refusal is the id's receipt.
    let missing = m.params("request-send-0001", json!({ "text": "look", "images": [{ "id": "attach-0001" }] }));
    assert_eq!(refusal(command(&m.rpc, &peer, "session.send", missing.clone()).await), ("invalid_params".into(), json!("attachment-missing")));
    assert_eq!(refusal(command(&m.rpc, &peer, "session.send", missing).await), ("invalid_params".into(), json!("attachment-missing")));
    let fixed = m.params("request-send-0001", json!({ "text": "look" }));
    assert_eq!(refusal(command(&m.rpc, &peer, "session.send", fixed).await), ("conflict".into(), json!("id-reused")));
    // Unknown tabs are not found.
    let elsewhere = json!({ "sessionId": m.session_id, "tabId": "tab-unknown", "clientRequestId": "request-send-0002", "text": "hi" });
    assert_eq!(command(&m.rpc, &peer, "session.send", elsewhere).await.unwrap_err().0, "not_found");
    assert_eq!(m.agent.sends(), vec!["/compact"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cloud_workspace_runtime_refuses_these_calls_as_method_not_found() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let session = seed_session(&f.root, "Fix login", None);
    let agent = Agent::new(&session);
    let identity = crate::cloud_agents::Identity { organization_id: "org".into(), workspace_id: "ws".into() };
    let agents = CloudAgents::open(&agents_dir(&f), Arc::new(Ops(agent.clone())), None, Some((Arc::new(Mailbox), identity)), 7).unwrap();
    f.rpc.set_agents(agents);
    let (peer, _events, hello) = computer(&f.rpc, "computer-a").await;
    assert_eq!(hello["capabilities"], json!(["session/1"]), "a runtime with a mailbox does not grant agent-commands/1");
    let params = json!({ "sessionId": session.id, "tabId": session.tabs[0].id, "clientRequestId": "request-cloud-0001", "text": "hi", "requestId": "r1", "optionId": "allow" });
    for method in ["session.steer", "session.stop", "session.decide"] {
        assert_eq!(command(&f.rpc, &peer, method, params.clone()).await.unwrap_err().0, "method_not_found", "{method}");
    }
    assert!(agent.sends().is_empty());
    assert!(!agents_dir(&f).join("agent-commands.jsonl").exists(), "no second receipt store beside the mailbox");
}


#[tokio::test(flavor = "multi_thread")]
async fn phase2_collaboration_v2_raw_terminal_final_writer_rejects_old_revision_and_everyone_configuration() {
    use crate::remote::collab::v2::{Action, Permit};
    let _home = crate::store::temp_home();
    let m = machine();
    let dir = tempfile::tempdir().unwrap();
    let terminals = crate::pty::Terminals::new();
    terminals.spawn(Arc::new(crate::sink::BroadcastSink::new(64)), "raw", crate::pty::PaneSpec {
        cwd: dir.path().to_str().unwrap(), cols:80, rows:24, command: Some("cat"), env:&[],
    }).unwrap();
    m.rpc.collab.install_v2(v2_policy("1", "manager", true, json!("explicit"))).unwrap();
    let stale = PtyInput { pid: terminals.pid("raw"), data: b"stale raw input\n".to_vec(), privacy: Default::default(),
        collaboration: Some(Permit::new(m.rpc.collab.clone(), "admin", m.rpc.collab.runtime_policy.stamp("admin"), Action::Configure)) };
    m.rpc.collab.install_v2(v2_policy("2", "driver", true, json!("everyone"))).unwrap();
    assert!(stale.write(&terminals, None, "raw").is_err());
    let current = PtyInput { collaboration: Some(Permit::new(m.rpc.collab.clone(), "admin", m.rpc.collab.runtime_policy.stamp("admin"), Action::Configure)), ..stale };
    assert!(current.write(&terminals, None, "raw").is_err(), "independent approval does not turn Everyone drive into raw configuration authority");
    assert!(!String::from_utf8_lossy(&terminals.read_output("raw").unwrap_or_default()).contains("stale raw input"));
    terminals.kill_all();
}


#[tokio::test(flavor = "multi_thread")]
async fn phase2_collaboration_v2_bigint_boundary_and_overflow_fence_actual_durable_rpc_input() {
    let _home = crate::store::temp_home();
    let m = machine();
    m.rpc.collab.install_v2(v2_policy("0", "manager", false, json!("explicit"))).unwrap();
    let (peer, _events) = Peer::for_user("bigint-manager".into(), Authority::Manage, Some("admin".into()));
    call(&m.rpc, &peer, "rpc.hello", json!({"protocol":PROTOCOL,"want":["session/1","agent-commands/1"]})).await.unwrap();
    for (at, revision) in ["0", "9007199254740993", "9223372036854775806", "9223372036854775807"].into_iter().enumerate() {
        m.rpc.collab.install_v2(v2_policy(revision, "manager", false, json!("explicit"))).unwrap();
        command(&m.rpc, &peer, "session.send", m.params(&format!("bigint-valid-{at:04}"),json!({"text":"valid boundary"}))).await.unwrap();
    }
    assert_eq!(m.agent.sends().len(),4);
    for (at, revision) in ["9223372036854775808", "9999999999999999999", "10000000000000000000"].into_iter().enumerate() {
        assert!(m.rpc.collab.install_v2(v2_policy(revision, "manager", false, json!("explicit"))).is_err());
        assert!(command(&m.rpc, &peer, "session.send", m.params(&format!("bigint-overflow-{at:04}"),json!({"text":"overflow must not arrive"}))).await.is_err());
    }
    assert_eq!(m.agent.sends().len(),4,"malformed revision must close admission before more native input");
}

#[tokio::test(flavor = "multi_thread")]
async fn phase2_collaboration_v2_observed_disconnect_fences_direct_rpc_and_durable_followups_without_refresh() {
    let _home = crate::store::temp_home();
    let m = machine();
    m.rpc.collab.install_v2(v2_policy("1", "manager", true, json!("explicit"))).unwrap();
    let (peer, _events) = Peer::for_user("revoked-attachment".into(), Authority::Manage, Some("admin".into()));
    call(&m.rpc, &peer, "rpc.hello", json!({"protocol":PROTOCOL,"want":["session/1","agent-commands/1"]})).await.unwrap();
    let (arrived, arrival) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    *BEFORE_REMOTE_WORK.lock().unwrap() = Some(Box::new(move || {
        arrived.send(()).unwrap(); released.recv_timeout(Duration::from_secs(5)).unwrap();
    }));
    let rpc = m.rpc.clone(); let original = peer.clone();
    let params = m.params("v2-disconnect-before-work", json!({"text":"must never apply"}));
    let pending = tokio::spawn(async move { command(&rpc, &original, "session.send", params).await });
    arrival.recv_timeout(Duration::from_secs(5)).unwrap();
    m.rpc.disconnect(&peer);
    release.send(()).unwrap();
    assert!(pending.await.unwrap().is_err());
    assert!(m.agent.sends().is_empty());
    assert_eq!(m.rpc.collab.access_of(Some("admin")).role, Role::Manager, "the policy snapshot has deliberately not refreshed");

    // A new connection can still send under this unchanged policy. Work
    // queued durably by it must retain that connection's native fence.
    let (again, _events) = Peer::for_user("revoked-attachment".into(), Authority::Manage, Some("admin".into()));
    call(&m.rpc, &again, "rpc.hello", json!({"protocol":PROTOCOL,"want":["session/1","agent-commands/1"]})).await.unwrap();
    m.agent.busy.store(true, Ordering::SeqCst);
    assert_eq!(command(&m.rpc, &again, "session.send", m.params("v2-queued-disconnect", json!({"text":"queued before revocation"}))).await.unwrap()["queued"], true);
    let agents = m.rpc.agents.get().unwrap();
    assert_eq!(agents.follow_ups.list(&m.tab_id).len(), 1);
    m.rpc.disconnect(&again);
    m.agent.busy.store(false, Ordering::SeqCst);
    agents.nudge_follow_ups(&m.tab_id);
    assert_eq!(agents.dispatch_follow_ups(), 0);
    assert!(agents.follow_ups.list(&m.tab_id).is_empty());
    assert!(m.agent.sends().is_empty(), "durable direct work must not be reinterpreted as a mailbox lease");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn phase2_collaboration_v2_observed_disconnect_fences_queued_raw_pty_before_snapshot_refresh() {
    let _home = crate::store::temp_home();
    let f = fixture();
    f.rpc.collab.runtime_policy.bind(f._dir.path(), 7).unwrap();
    f.rpc.collab.install_v2(v2_policy("1", "manager", true, json!("explicit"))).unwrap();
    let (peer, _events) = manager_peer(&f.rpc).await;
    let id = call(&f.rpc, &peer, "pty.create", json!({"cols":80,"rows":24,"clientRequestId":"v2-revoke-raw"})).await.unwrap()["ptyId"].as_str().unwrap().to_owned();
    call(&f.rpc, &peer, "pty.attach", json!({"ptyId":id})).await.unwrap();
    call(&f.rpc, &peer, "pty.control", json!({"ptyId":id})).await.unwrap();
    let input = f.root.join("received"); let ready = f.root.join("ready");
    f.terminals.write(&id, format!("stty raw -echo; touch '{}'; exec cat > '{}'\n", ready.display(), input.display()).as_bytes()).unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while !ready.exists() || !input.exists() { assert!(Instant::now() < until); tokio::time::sleep(Duration::from_millis(5)).await; }
    let (entered, arrival) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let terminals = f.terminals.clone(); let pane = id.clone();
    let blocker = std::thread::spawn(move || terminals.with_input_lock_for_test(&pane, || {
        entered.send(()).unwrap(); released.recv_timeout(Duration::from_secs(5)).unwrap();
    }));
    arrival.recv_timeout(Duration::from_secs(5)).unwrap();
    call(&f.rpc, &peer, "pty.write", json!({"ptyId":id,"data":"must not reach child","seq":1,"writerId":"revoked"})).await.unwrap();
    // No revision install. Disconnect must complete even while the raw
    // writer is waiting on capacity, and its original permit must then fail.
    f.rpc.disconnect(&peer);
    assert_eq!(f.rpc.collab.access_of(Some("admin")).role, Role::Manager);
    release.send(()).unwrap(); blocker.join().unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while f.rpc.ptys.lock().unwrap().get(&id).unwrap().input_pending.load(Ordering::SeqCst) != 0 {
        assert!(Instant::now() < until); tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(std::fs::read(&input).unwrap().is_empty(), "revoked raw queue reached a real PTY");
}

#[tokio::test(flavor = "multi_thread")]
async fn phase2_collaboration_v2_bootstrap_refresh_installs_before_actual_rpc_and_retires_source_changes() {
    let _home = crate::store::temp_home();
    let m = machine();
    async fn participant(rpc: &Arc<WorkspaceRpc>, device: &str) -> (Arc<Peer>, Notifications, Value) {
        let (peer, events) = Peer::for_user(device.into(), Authority::Manage, Some("admin".into()));
        let hello = call(rpc, &peer, "rpc.hello", json!({"protocol": PROTOCOL,
            "want": ["session/1", "agent-commands/1", "collab/1"]})).await.unwrap();
        (peer, events, hello)
    }
    let install = |session: &crate::remote::host::RelaySession, generation| crate::remote::host::install_session_collaboration(&m.rpc, session, generation);
    let refresh = |revision: &str, role: &str, approve: bool, source: Value| {
        // Exercise the actual BootstrapLink conversion, including the fields
        // the old Members parser silently discarded, then the host installer.
        let session = crate::cloud_bootstrap::Session {
            workspace_id: "ws".into(), organization_id: "org".into(), relay_host_id: "host".into(),
            relay_token: format!("e30.{}.sig", base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD,
                r#"{"runtimeGeneration":7,"sub":"host","cloudProfileId":"profile","organizationId":"org"}"#)), relay_token_expires_at: 0, director_url: String::new(),
            access_mode: crate::cloud_bootstrap::AccessMode::Private,
            attachments: vec![], revocations: vec![], quiesce: None, environment: None,
            collaboration: Some(serde_json::to_value(v2_policy(revision, role, approve, source)).unwrap()),
        };
        crate::remote::bootstrap_link::relay_session(&session, "collaboration-v2")
    };
    let mut unsolicited = refresh("1", "manager", false, json!("explicit"));
    unsolicited.collaboration_v2 = false;
    assert!(install(&unsolicited, 7).is_err());
    assert_eq!(m.rpc.collab.access_of(Some("admin")), Access::NONE);
    install(&refresh("1", "manager", false, json!("explicit")), 7).unwrap();
    let (peer, _events, hello) = participant(&m.rpc, "refresh-manager").await;
    assert_eq!(hello["you"]["canApprove"], false);
    m.agent.seen.lock().unwrap().pending.push("refresh-permission".into());
    assert!(command(&m.rpc, &peer, "session.decide", m.params("refresh-decide-0001",
        json!({"requestId":"refresh-permission","optionId":"allow"}))).await.is_err());
    command(&m.rpc, &peer, "session.send", m.params("refresh-send-0001", json!({"text":"explicit reaches agent"}))).await.unwrap();
    m.agent.busy.store(true, Ordering::SeqCst);
    command(&m.rpc, &peer, "session.send", m.params("refresh-queue-0001", json!({"text":"must not survive refresh"}))).await.unwrap();
    install(&refresh("2", "driver", false, json!("explicit")), 7).unwrap();
    assert!(peer.disconnected());
    let (driver, _events, _) = participant(&m.rpc, "refresh-driver").await;
    let (session_peer, _session_events) = Peer::for_user("refresh-session".into(), Authority::Participate, Some("admin".into()));
    call(&m.rpc, &session_peer, "rpc.hello", json!({"protocol":PROTOCOL,"want":["collab/1","session/1"]})).await.unwrap();
    install(&refresh("3", "driver", false, json!("everyone")), 7).unwrap();
    assert!(session_peer.disconnected(), "session-scoped attachment must retire too");
    assert!(driver.disconnected(), "same numeric role must still revoke its old attachment");
    m.agent.busy.store(false, Ordering::SeqCst);
    m.agents.nudge_follow_ups(&m.tab_id);
    m.agents.dispatch_follow_ups();
    let (everyone, _events, _) = participant(&m.rpc, "refresh-everyone").await;
    assert!(command(&m.rpc, &everyone, "session.send", m.params("refresh-unsafe-0001", json!({"text":"unknown tab"}))).await.is_err());
    assert!(install(&refresh("4", "manager", true, json!("implicit")), 6).is_err());
    assert_eq!(m.rpc.collab.access_of(Some("admin")).role, collab::Role::Driver);
    assert!(install(&refresh("3", "manager", true, json!("implicit")), 7).is_err());
    assert!(everyone.disconnected(), "equal revision conflicting authority fails closed");
    m.agents.set_generation(8);
    assert!(install(&refresh("4", "manager", true, json!("implicit")), 7).is_err(),
        "a mailbox generation advance also fences a late host response");
    assert_eq!(m.agent.sends(), vec!["explicit reaches agent"]);
    assert!(m.agent.seen.lock().unwrap().decisions.is_empty());
    assert!(!crate::cloud_bootstrap::CAPABILITIES.contains("collaboration-v2"));
}
