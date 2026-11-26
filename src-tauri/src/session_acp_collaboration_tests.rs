//! Register directly under session (see B doc). ALL UNRUN in source-only B.
//! These fixtures use Host/LiveChild, real Python pipes, original A contexts,
//! and actual collaboration policy. No fixture substitutes a copied predicate.
use super::provider_authority::{Attempt, Correlation, OperationContext, ProviderBinding, RequiredAction, SenderAuthority};
use crate::harness::{acp::{self, Acp, Chunk, Delivery}, host::{Host, LiveChild, Sink, SpawnSpec}, Action, ProviderAction};
use crate::remote::collab::{Collaboration, v2::{Action as Right, Permit, Snapshot}};
use serde_json::{json, Value};
use std::{sync::{Arc, Mutex, mpsc}, time::{Duration, Instant}};

const AGENT: &str = r#"
import json, os, pathlib, sys, time
base = pathlib.Path(sys.argv[1])
def emit(value):
    print(json.dumps(value), flush=True)
def barrier(name):
    (base / ('seen-' + name)).touch()
    while (base / ('pause-' + name)).exists():
        time.sleep(.002)
emit({'fixtureReady':True})
barrier('read')
buffer = b''
held_prompt = None
while True:
    data = os.read(0, 4096)
    if not data:
        (base / 'eof').touch()
        break
    with (base / 'bytes').open('ab') as output:
        output.write(data)
    buffer += data
    while b'\n' in buffer:
        line, buffer = buffer.split(b'\n', 1)
        value = json.loads(line)
        with (base / 'requests').open('a') as output:
            output.write(json.dumps(value) + '\n')
        method = value.get('method', '')
        barrier(method.replace('/', '-') or 'answer')
        if not method:
            if held_prompt is not None:
                emit({'jsonrpc':'2.0','id':held_prompt,'result':{'stopReason':'end_turn'}})
                held_prompt = None
            continue
        if method == 'initialize':
            result = {'protocolVersion':1,'agentCapabilities':{'loadSession':True}}
            if (base / 'auth').exists(): result['authMethods'] = [{'id':'original-login'}]
        elif method == 'authenticate': result = {}
        elif method == 'session/load' and (base / 'fail-load').exists():
            emit({'jsonrpc':'2.0','id':value['id'],'error':{'code':-32000,'message':'missing'}})
            continue
        elif method in ('session/new', 'session/load'):
            result = {'sessionId':'same-provider-id','models':{'currentModelId':'base'},'modes':{'currentModeId':'normal','availableModes':[{'id':'normal'},{'id':'plan'}]}}
        elif method == 'session/prompt':
            if (base / 'ask').exists():
                held_prompt = value['id']
                emit({'jsonrpc':'2.0','id':77,'method':'session/request_permission','params':{'toolCall':{'toolCallId':'tool','kind':'execute'},'options':[{'optionId':'allow','kind':'allow_once'},{'optionId':'deny','kind':'reject_once'}]}})
                continue
            result = {'stopReason':'end_turn'}
        elif method == 'session/set_mode': result = {'modeId':value['params']['modeId']}
        elif method == 'session/set_model': result = {}
        else: continue
        emit({'jsonrpc':'2.0','id':value['id'],'result':result})
"#;

struct Lines(Mutex<mpsc::Sender<String>>);
impl Sink for Lines {
    fn stdout_line(&self, line: String) { let _ = self.0.lock().unwrap().send(line); }
    fn stderr_line(&self, line: String) { eprintln!("ACP fixture: {line}"); }
    fn exited(&self, _: u32, _: Option<i32>) {}
}
struct Wire {
    host: Host,
    child: Arc<LiveChild>,
    binding: ProviderBinding,
    lines: mpsc::Receiver<String>,
    dir: tempfile::TempDir,
}
impl Wire {
    fn new(paused: bool) -> Self {
        let dir = tempfile::tempdir().unwrap();
        if paused { std::fs::write(dir.path().join("pause-read"), b"").unwrap(); }
        let host = Host::new();
        let (tx, lines) = mpsc::channel();
        let program = crate::binpath::python3_path().expect("real ACP fixture needs python3");
        let args = vec!["-u".into(), "-c".into(), AGENT.into(), dir.path().to_string_lossy().into_owned()];
        let child = host.spawn("provider-acp-collaboration", SpawnSpec { program: &program, args: &args,
            cwd: dir.path(), env: &[], unset: &[] }, Arc::new(Lines(Mutex::new(tx)))).unwrap();
        assert!(lines.recv_timeout(Duration::from_secs(5)).unwrap().contains("fixtureReady"));
        let binding = ProviderBinding::owned("session", "tab", &child);
        Self { host, child, binding, lines, dir }
    }
    fn line(&self) -> String { self.lines.recv_timeout(Duration::from_secs(5)).expect("real ACP reply") }
    fn flag(&self, name: &str) { std::fs::write(self.dir.path().join(name), b"").unwrap(); }
    fn release(&self, name: &str) { std::fs::remove_file(self.dir.path().join(name)).unwrap(); }
    fn bytes(&self) -> Vec<u8> { std::fs::read(self.dir.path().join("bytes")).unwrap_or_default() }
    fn requests(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("requests")).unwrap_or_default().lines()
            .map(|line| serde_json::from_str(line).unwrap()).collect()
    }
    fn seen(&self, name: &str) { until(|| self.dir.path().join(format!("seen-{name}")).exists()); }
    /// Small frames only. Frame acquisition is OUTSIDE original admission;
    /// the short closure performs exactly one nonblocking syscall.
    fn send(&self, envelope: &ProviderAction) -> Attempt {
        let Some(line) = action_line(&envelope.action) else { return Attempt::Applied };
        let _frame = self.child.input_frame().unwrap();
        let bytes = format!("{line}\n");
        envelope.context.try_dispatch(&self.binding, envelope.context.correlation(), None, no_other_gates, || {
            let count = self.child.try_write_stdin(bytes.as_bytes())?;
            anyhow::ensure!(count == bytes.len(), "small fixture frame unexpectedly partial");
            Ok(())
        }).unwrap()
    }
    /// One callback admission consumes the WHOLE response, not every action.
    fn reply(&self, adapter: &mut Acp, line: &str) -> (Attempt, Vec<ProviderAction>) {
        let context = adapter.response_context(line).expect("original response sidecar");
        let mut actions = Vec::new();
        let result = context.try_callback(&self.binding, context.correlation(), None, no_other_gates, || {
            actions = adapter.handle_carried_response(line, &context)?;
            Ok(())
        }).unwrap();
        if result == Attempt::Withdrawn {
            let value: Value = serde_json::from_str(line).unwrap();
            adapter.retire_request(value["id"].as_u64().unwrap(), &context);
        }
        (result, actions)
    }
}
impl Drop for Wire { fn drop(&mut self) { self.host.kill_all(); } }
fn until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready() { assert!(Instant::now() < deadline, "ACP fixture barrier timed out"); std::thread::sleep(Duration::from_millis(2)); }
}
fn action_line(action: &Action) -> Option<&str> {
    match action { Action::Write(line) | Action::AcpMode { line: Some(line), .. } => Some(line),
        Action::AcpPrompt(write) => Some(&write.line), _ => None }
}
fn no_other_gates(sender: &SenderAuthority) -> anyhow::Result<()> {
    anyhow::ensure!(sender.mobile.is_none() && sender.local_share.is_none(), "fixture needs independent sender gates");
    Ok(())
}
fn delivery(seq: u64) -> Delivery { Delivery { seq, privacy: None, mobile: None, shared: None } }
fn local(binding: &ProviderBinding, seq: u64) -> OperationContext {
    OperationContext::new(SenderAuthority::capture(None, RequiredAction::Drive, None, None, None),
        RequiredAction::Drive, binding.clone(), Correlation::Prompt { seq, request: format!("ingress-{seq}") })
}
struct Policy { policy: Arc<Collaboration>, _dir: tempfile::TempDir }
impl Policy {
    fn new() -> Self {
        let policy = Arc::new(Collaboration::new());
        let dir = tempfile::tempdir().unwrap();
        policy.runtime_policy.bind(dir.path(), 1).unwrap();
        let this = Self { policy, _dir: dir };
        this.revision("1"); this
    }
    fn revision(&self, revision: &str) {
        let snapshot: Snapshot = serde_json::from_value(json!({"v":2,"revision":revision,"members":[
            {"userId":"explicit","role":"manager","canApprove":true,"approvalSource":"explicit", "writeSource":"explicit"},
            {"userId":"everyone","role":"driver","canApprove":false,"writeSource":"everyone"}]})).unwrap();
        self.policy.install_v2(snapshot).unwrap();
    }
    fn permit(&self, actor: &str, right: Right) -> Permit {
        Permit::new(self.policy.clone(), actor, self.policy.runtime_policy.stamp(actor), right)
    }
    fn operation(&self, binding: &ProviderBinding, actor: &str, required: RequiredAction, correlation: Correlation) -> OperationContext {
        let right = match required { RequiredAction::Drive => Right::Drive, RequiredAction::Configure => Right::Configure, RequiredAction::Approve => Right::Approve };
        OperationContext::new(SenderAuthority::capture(Some(self.permit(actor, right)), required, None, None, None), required, binding.clone(), correlation)
    }
    fn prompt(&self, binding: &ProviderBinding, actor: &str, seq: u64) -> OperationContext {
        self.operation(binding, actor, RequiredAction::Drive, Correlation::Prompt { seq, request: format!("ingress-{seq}") })
    }
}
fn ready(wire: &Wire, adapter: &mut Acp, context: OperationContext) {
    let mut actions = adapter.start_carried("first".into(), vec![], delivery(1), context).unwrap();
    loop {
        let count = actions.iter().filter(|action| action_line(&action.action).is_some()).count();
        for action in &actions {
            assert_eq!(wire.send(action), Attempt::Applied);
            if let Action::AcpPrompt(write) = &action.action { adapter.delivered(write.id); }
        }
        if count == 0 { break; }
        let line = wire.line();
        let (attempt, next) = wire.reply(adapter, &line);
        assert_eq!(attempt, Attempt::Applied);
        actions = next;
    }
    assert!(adapter.ready);
}

#[test]
fn provider_acp_collaboration_explicit_wire_auth_load_fallback_stash_and_no_drive_upgrade() {
    let wire = Wire::new(false); wire.flag("auth"); wire.flag("fail-load");
    let policy = Policy::new();
    let mut adapter = Acp::new("/tmp", Some("resume".into()), Some("wanted".into()), "plan");
    // Automatic opening model/mode would mutate configuration; Drive must not
    // supply their authority. The real prompt still traverses auth/load/new.
    ready(&wire, &mut adapter, policy.prompt(&wire.binding, "explicit", 1));
    let methods: Vec<_> = wire.requests().iter().filter_map(|value| value["method"].as_str().map(String::from)).collect();
    assert_eq!(methods, ["initialize", "authenticate", "session/load", "session/new", "session/prompt"]);
    assert!(!wire.bytes().is_empty());
}

#[test]
fn provider_acp_collaboration_everyone_denied_before_real_pipe_and_local_successor_keeps_local() {
    let wire = Wire::new(false); let policy = Policy::new();
    let mut denied = Acp::new("/tmp", None, None, "normal");
    let actions = denied.start_carried("forbidden".into(), vec![], delivery(1), policy.prompt(&wire.binding, "everyone", 1)).unwrap();
    assert_eq!(wire.send(&actions[0]), Attempt::Withdrawn);
    assert!(wire.bytes().is_empty());
    denied.withdraw_input();
    let mut successor = Acp::new("/tmp", None, None, "normal");
    policy.permit("everyone", Right::Drive).with(|| ready(&wire, &mut successor, local(&wire.binding, 2)));
    assert_eq!(wire.requests().iter().filter(|request| request["method"] == "session/prompt").count(), 1);
}

#[test]
fn provider_acp_collaboration_real_opening_barriers_revision_generation_disconnect_stop() {
    for stage in ["initialize", "authenticate", "session-load", "session-new"] {
        for change in ["revision", "generation", "disconnect", "stop"] {
            let wire = Wire::new(false); wire.flag("auth"); wire.flag(&format!("pause-{stage}"));
            let policy = Policy::new();
            let (peer, _notifications) = crate::remote::server::Peer::for_user("original".into(), crate::remote::protocol::Authority::Manage, Some("explicit".into()));
            let permit = Permit::new(policy.policy.clone(), "explicit", policy.policy.runtime_policy.stamp_for_peer("explicit", &peer), Right::Drive).for_peer(&peer);
            let context = OperationContext::new(SenderAuthority::capture(Some(permit), RequiredAction::Drive, None, None, None), RequiredAction::Drive,
                wire.binding.clone(), Correlation::Prompt { seq: 1, request: "ingress".into() });
            let resume = (stage == "session-load").then(|| "resume".into());
            let mut adapter = Acp::new("/tmp", resume, None, "normal");
            let mut actions = adapter.start_carried("stashed".into(), vec![], delivery(1), context).unwrap();
            loop {
                let reaches_stage = actions.iter().filter_map(|action| action_line(&action.action))
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                    .any(|value| value["method"].as_str().is_some_and(|method| method.replace('/', "-") == stage));
                for action in &actions { assert_eq!(wire.send(action), Attempt::Applied); }
                if reaches_stage { wire.seen(stage); break; }
                let line = wire.line(); actions = wire.reply(&mut adapter, &line).1;
            }
            match change {
                "revision" => policy.revision("2"),
                "generation" => policy.policy.runtime_policy.set_generation(2),
                "disconnect" => drop(peer),
                "stop" => { adapter.withdraw_input(); },
                _ => unreachable!(),
            }
            wire.release(&format!("pause-{stage}"));
            let line = wire.line();
            if change == "stop" { assert!(adapter.response_context(&line).is_none()); }
            else { assert_eq!(wire.reply(&mut adapter, &line).0, Attempt::Withdrawn); }
            assert!(!wire.requests().iter().any(|request| request["method"] == "session/prompt"), "{stage}/{change}");
            // A fresh native association has a separately captured Local.
            let successor = Wire::new(false);
            let mut local_adapter = Acp::new("/tmp", None, None, "normal");
            ready(&successor, &mut local_adapter, local(&successor.binding, 2));
        }
    }
}

#[test]
fn provider_acp_collaboration_wire_same_value_setting_ids_mode_and_deferred_originals() {
    use crate::harness::settings::Settings;
    let wire = Wire::new(false); let policy = Policy::new();
    let mut adapter = Acp::new("/tmp", None, None, "normal");
    ready(&wire, &mut adapter, local(&wire.binding, 1));
    let mut settings = Settings { model: "base".into(), permission_mode: "normal".into(), ..Default::default() };
    let setting = |key: &str, id: &str| Correlation::Setting { setting: key.into(), request_id: id.into(), adapter_request: "ingress".into() };
    let old_permit = policy.permit("explicit", Right::Configure);
    settings.request_model_explicit("same", true, Some(&old_permit), None);
    let old_id = settings.collaboration_requests()["model"].clone();
    let old = policy.operation(&wire.binding, "explicit", RequiredAction::Configure, setting("model", &old_id));
    let old_actions = adapter.set_model_carried("same", settings.model_request_id().map(String::from), old).unwrap();
    assert_eq!(wire.send(&old_actions[0]), Attempt::Applied);
    let old_reply = wire.line(); // Real ACK held while a newer same-value edit arrives.
    policy.revision("2");
    let new_permit = policy.permit("explicit", Right::Configure);
    settings.request_model_explicit("same", true, Some(&new_permit), None);
    settings.request_mode_explicit("plan", true, None, None); // Independent Local edit.
    let new_id = settings.collaboration_requests()["model"].clone();
    assert_ne!(old_id, new_id);
    let new = policy.operation(&wire.binding, "explicit", RequiredAction::Configure, setting("model", &new_id));
    let new_actions = adapter.set_model_carried("same", settings.model_request_id().map(String::from), new).unwrap();
    for action in new_actions { adapter.defer_carried(action); }
    assert_eq!(wire.reply(&mut adapter, &old_reply).0, Attempt::Withdrawn);
    assert!(!settings.settle_provider_request("model", &old_id));
    assert_eq!(settings.requested_model.as_deref(), Some("same"));
    assert_eq!(settings.requested_permission_mode.as_deref(), Some("plan"));
    // Unrelated Everyone callback TLS must not replace the deferred Configure.
    let deferred = adapter.take_deferred_carried();
    policy.permit("everyone", Right::Drive).with(|| {
        assert_eq!(wire.send(&deferred[0]), Attempt::Applied);
    });
    let line = wire.line();
    let context = adapter.response_context(&line).unwrap();
    assert!(matches!(context.correlation(), Correlation::Setting { request_id, adapter_request, .. }
        if request_id == &new_id && adapter_request != "ingress"));
    let mut accepted = Vec::new();
    assert_eq!(context.try_callback(&wire.binding, context.correlation(), None, no_other_gates, || {
        accepted = adapter.handle_carried_response(&line, &context)?;
        anyhow::ensure!(settings.settle_provider_request("model", &new_id), "exact model settlement");
        Ok(())
    }).unwrap(), Attempt::Applied);
    assert!(accepted.iter().any(|action| matches!(action.action, Action::Emit(crate::events::Payload::ProviderSettings { .. }))));
    assert_eq!(settings.model, "same");
    assert_eq!(settings.requested_permission_mode.as_deref(), Some("plan"));
    assert!(adapter.response_context(&line).is_none());
    let mode = policy.operation(&wire.binding, "explicit", RequiredAction::Configure, setting("mode", "mode-2"));
    let mode_actions = adapter.set_mode_carried("plan", mode).unwrap();
    assert_eq!(wire.send(&mode_actions[0]), Attempt::Applied);
    let line = wire.line(); let context = adapter.response_context(&line).unwrap();
    assert!(matches!(context.correlation(), Correlation::Setting { setting, request_id, .. } if setting == "mode" && request_id == "mode-2"));
    assert_eq!(wire.reply(&mut adapter, &line).0, Attempt::Applied);
}

#[test]
fn provider_acp_collaboration_real_approval_new_deny_survives_old_allow_attempt() {
    let wire = Wire::new(false); wire.flag("ask"); let policy = Policy::new();
    let mut adapter = Acp::new("/tmp", None, None, "normal");
    let mut actions = adapter.start_carried("permission".into(), vec![], delivery(1), local(&wire.binding, 1)).unwrap();
    let ask = loop {
        for action in &actions { assert_eq!(wire.send(action), Attempt::Applied); }
        let line = wire.line();
        let value: Value = serde_json::from_str(&line).unwrap();
        if value["method"] == "session/request_permission" { break line; }
        actions = wire.reply(&mut adapter, &line).1;
    };
    // Read-only/request delivery is association-scoped, rather than fenced by
    // the previous prompt's Drive permit. This fixture owns the exact child.
    adapter.handle(&ask);
    let approval = |attempt: &str| policy.operation(&wire.binding, "explicit", RequiredAction::Approve,
        Correlation::Approval { ask_id: "acp:77".into(), provider_request: "77".into(), attempt: attempt.into() });
    let allow = adapter.answer_carried("acp:77", "allow", approval("allow-1")).unwrap();
    adapter.defer_carried(allow);
    let deny = adapter.answer_carried("acp:77", "deny", approval("deny-2")).unwrap();
    let stale = adapter.take_deferred_carried().pop().unwrap();
    assert!(!adapter.answer_current(&stale.context));
    assert_eq!(wire.send(&stale), Attempt::Withdrawn);
    assert_eq!(adapter.answer_delivered(&stale.context), None);
    assert!(adapter.answer_current(&deny.context));
    assert_eq!(wire.send(&deny), Attempt::Applied);
    assert_eq!(adapter.answer_delivered(&deny.context), Some(false));
    assert_eq!(adapter.answer_delivered(&deny.context), None);
    let line = wire.line(); assert_eq!(wire.reply(&mut adapter, &line).0, Attempt::Applied);
    let answers: Vec<_> = wire.requests().into_iter().filter(|value| value["id"] == 77).collect();
    assert_eq!(answers.len(), 1);
    assert_eq!(answers[0]["result"]["outcome"]["optionId"], "deny");
}

#[test]
fn provider_acp_collaboration_blocked_partial_pipe_revocation_stop_replacement_original_only() {
    for change in ["revision", "generation", "stop", "replacement"] {
        let wire = Wire::new(true); let policy = Policy::new();
        let context = policy.prompt(&wire.binding, "explicit", 9);
        let sent = context.clone(); let child = wire.child.clone(); let binding = wire.binding.clone();
        let current = Arc::new(Mutex::new(binding.clone())); let worker_current = current.clone();
        let (full_tx, full_rx) = mpsc::channel(); let (resume_tx, resume_rx) = mpsc::channel();
        let payload = json!({"jsonrpc":"2.0","id":900,"method":"session/prompt","params":{"prompt":"x".repeat(4 * 1024 * 1024)}}).to_string();
        let worker = std::thread::spawn(move || {
            let mut notified = false;
            acp::write_carried_frame(&sent, &child, &payload, |original, exact_child, bytes| {
                // Current A's one-shot helper cannot be reused for chunks.
                // This fixture derives a fresh short child from the SAME
                // original per physical syscall; production streaming state
                // and final callback completion still require root glue.
                let chunk_context = original.derive_follow_on(original.correlation().clone())?;
                let mut result = Chunk::Withdrawn;
                let live = worker_current.lock().unwrap().clone();
                let attempt = chunk_context.try_dispatch(&live, original.correlation(), None, no_other_gates, || {
                    result = match exact_child.try_write_stdin(bytes) {
                        Ok(count) => Chunk::Written(count),
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Chunk::Capacity,
                        Err(error) => return Err(error.into()),
                    }; Ok(())
                })?;
                Ok(match attempt { Attempt::Applied => result, Attempt::Deferred => Chunk::Deferred, Attempt::Withdrawn => Chunk::Withdrawn })
            }, || {
                if !notified {
                    notified = true; full_tx.send(()).unwrap();
                    resume_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                }
                Ok(())
            })
        });
        full_rx.recv_timeout(Duration::from_secs(5)).expect("actual subprocess pipe filled after partial JSON");
        // This must be possible during capacity wait: no original policy or
        // runtime/currentness mutex may be held by the writer.
        let successor = Wire::new(false);
        match change {
            "revision" => policy.revision("2"),
            "generation" => policy.policy.runtime_policy.set_generation(2),
            "stop" => context.withdraw(),
            "replacement" => *current.lock().unwrap() = successor.binding.clone(),
            _ => unreachable!(),
        }
        resume_tx.send(()).unwrap();
        assert!(worker.join().unwrap().is_err(), "{change}");
        // The old child now drains its received prefix and sees EOF; there is
        // no complete JSON frame, and the successor never receives its tail.
        wire.release("pause-read"); until(|| wire.dir.path().join("eof").exists());
        assert!(!wire.bytes().is_empty());
        assert!(!wire.bytes().contains(&b'\n'));
        assert!(wire.requests().is_empty());
        assert!(successor.bytes().is_empty());
        let mut local_adapter = Acp::new("/tmp", None, None, "normal");
        ready(&successor, &mut local_adapter, local(&successor.binding, 10));
        assert_eq!(successor.requests().iter().filter(|value| value["method"] == "session/prompt").count(), 1);
        assert!(context.derive_follow_on(Correlation::Prompt { seq: 9, request: "replay".into() }).is_err());
    }
}

#[test]
fn provider_acp_collaboration_old_real_child_callback_cannot_write_replacement() {
    let old = Wire::new(false); let replacement = Wire::new(false);
    let policy = Policy::new(); let mut adapter = Acp::new("/tmp", None, None, "normal");
    let actions = adapter.start_carried("old".into(), vec![], delivery(1), policy.prompt(&old.binding, "explicit", 1)).unwrap();
    assert_eq!(old.send(&actions[0]), Attempt::Applied);
    let reply = old.line(); let original = adapter.response_context(&reply).unwrap();
    assert_eq!(original.try_callback(&replacement.binding, original.correlation(), None, no_other_gates,
        || { adapter.handle_carried_response(&reply, &original)?; Ok(()) }).unwrap(), Attempt::Withdrawn);
    assert!(replacement.bytes().is_empty());
    assert_eq!(old.requests().len(), 1);
    let mut successor = Acp::new("/tmp", None, None, "normal");
    ready(&replacement, &mut successor, local(&replacement.binding, 2));
}

#[test]
fn provider_acp_collaboration_frame_wait_revocation_has_no_admission_lock_or_bytes() {
    let wire = Wire::new(false); let policy = Policy::new();
    let context = policy.prompt(&wire.binding, "explicit", 1);
    let held_frame = wire.child.input_frame().unwrap();
    let child = wire.child.clone(); let binding = wire.binding.clone();
    let (entered, waiting) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        entered.send(()).unwrap();
        acp::write_carried_frame(&context, &child, r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            |original, exact_child, bytes| {
                let mut result = Chunk::Withdrawn;
                let attempt = original.try_dispatch(&binding, original.correlation(), None, no_other_gates, || {
                    result = Chunk::Written(exact_child.try_write_stdin(bytes)?); Ok(())
                })?;
                Ok(match attempt { Attempt::Applied => result, Attempt::Deferred => Chunk::Deferred, Attempt::Withdrawn => Chunk::Withdrawn })
            }, || Ok(()))
    });
    waiting.recv_timeout(Duration::from_secs(5)).unwrap();
    policy.revision("2"); // Would deadlock if frame wait held original policy.
    assert!(wire.bytes().is_empty());
    drop(held_frame);
    assert!(worker.join().unwrap().is_err());
    assert!(wire.bytes().is_empty());
}

#[test]
fn provider_acp_collaboration_explicit_local_keeps_privacy_and_share_denials_on_real_pipe() {
    for shared in [false, true] {
        let wire = Wire::new(false); let mut adapter = Acp::new("/tmp", None, None, "normal");
        let denied = crate::data_privacy::Ticket::denied();
        let sender = SenderAuthority::capture(None, RequiredAction::Drive,
            (!shared).then(|| denied.clone()), None,
            shared.then(|| crate::local_sharing::WritePermit { privacy: denied, share_generation: "original".into(),
                connection_id: "original".into(), revision: 1, tab_epoch: 1 }));
        let context = OperationContext::new(sender, RequiredAction::Drive, wire.binding.clone(),
            Correlation::Prompt { seq: 1, request: "local-original".into() });
        let actions = adapter.start_carried("private".into(), vec![], delivery(1), context).unwrap();
        assert_eq!(wire.send(&actions[0]), Attempt::Withdrawn);
        assert!(wire.bytes().is_empty());
    }
}
