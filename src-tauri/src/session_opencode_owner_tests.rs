//! Actual session owner + frozen C loopback integration. ALL UNRUN until a
//! fresh explicit serial allocation. Tests select the dormant owner privately;
//! public V2 entry refusals and Everyone unsupported witnesses remain intact.
use super::*;
use super::provider_authority::{Attempt, Correlation, OperationContext, RequiredAction, SenderAuthority};
use crate::remote::collab::{Collaboration, v2::{Action as Right, Permit, Snapshot}};
use serde_json::json;
use std::{io::Write, net::TcpStream, sync::mpsc};

const SESSION: &str = "provider-integration-e";
const TAB: &str = "opencode";
const SERVER: &str = r#"
import json,pathlib,socketserver,sys,threading,time
root=pathlib.Path(sys.argv[1]); lock=threading.Lock()
class Handler(socketserver.BaseRequestHandler):
 def handle(self):
  data=b''
  while b'\r\n\r\n' not in data:
   chunk=self.request.recv(1024)
   if not chunk:return
   data+=chunk
   with lock:
    with (root/'bytes').open('ab') as f:f.write(chunk)
  header,body=data.split(b'\r\n\r\n',1); method,path,_=header.split(b'\r\n')[0].decode().split(' ')
  length=next((int(x.split(b':',1)[1]) for x in header.split(b'\r\n')[1:] if x.lower().startswith(b'content-length:')),0)
  if path=='/event':
   self.request.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n')
   (root/'sse-connected').touch()
   while not (root/'sse-release').exists():time.sleep(.002)
   self.request.sendall(b'data: '+(root/'sse-line').read_bytes()+b'\n\n')
   return
  while len(body)<length:
   chunk=self.request.recv(min(4096,length-len(body)))
   if not chunk:
    (root/'partial').write_text(str(len(body)));return
   body+=chunk
   with lock:
    with (root/'bytes').open('ab') as f:f.write(chunk)
  with lock:
   with (root/'requests').open('a') as f:f.write(json.dumps({'path':path,'method':method,'body':json.loads(body) if body else None})+'\n')
  if path.startswith('/session/') and method=='GET' and (root/'hold-open').exists():
   (root/'open-held').touch()
   while not (root/'release-open').exists():time.sleep(.002)
  if (root/'drop-response').exists():return
  status=404 if method=='GET' and (root/'missing').exists() else 200
  payload=json.dumps({'id':'same-provider-id'} if path=='/session' or method=='GET' else {}).encode()
  self.request.sendall(('HTTP/1.1 %d OK\r\nContent-Length: %d\r\nConnection: close\r\n\r\n'%(status,len(payload))).encode()+payload)
class Server(socketserver.ThreadingTCPServer):
 allow_reuse_address=True
 daemon_threads=True
server=Server(('127.0.0.1',0),Handler)
(root/'port').write_text(str(server.server_address[1]));print('ready',flush=True)
server.serve_forever()
"#;
struct Inbox(Mutex<mpsc::Sender<String>>);
impl Sink for Inbox {
    fn stdout_line(&self, line: String) { let _ = self.0.lock().unwrap().send(line); }
    fn stderr_line(&self, _: String) {}
    fn exited(&self, _: u32, _: Option<i32>) {}
}
struct Rig {
    manager: SessionManager,
    rt: Arc<Mutex<TabRuntime>>,
    child: Arc<LiveChild>,
    dir: tempfile::TempDir,
    policy: Arc<Collaboration>,
    port: u16,
    _home: store::TempHome,
}
fn until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(6);
    while !predicate() {
        assert!(Instant::now() < deadline, "OpenCode owner barrier timed out");
        std::thread::sleep(Duration::from_millis(2));
    }
}
impl Rig {
    fn new(resume: Option<String>) -> Self {
        let home = store::temp_home(); let dir = tempfile::tempdir().unwrap();
        index::save(&[serde_json::from_value(json!({"id":SESSION,"projectPath":dir.path(),"cwd":dir.path(),
            "title":"E owner","created":index::now(),"modified":index::now(),
            "tabs":[{"id":TAB,"harness":"opencode","model":"base","permissionMode":"auto","created":index::now()}]})).unwrap()]).unwrap();
        let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)), Arc::new(crate::sink::NoObserver),
            Arc::new(Host::new()), Arc::new(pty::Terminals::new()), Arc::default(), Arc::default(), crate::hooks::prepare_control().unwrap());
        let rt = manager.runtime(SESSION, TAB).unwrap();
        let python = crate::binpath::resolve("python3").expect("real loopback fixture requires Python");
        let args = vec!["-u".into(), "-c".into(), SERVER.into(), dir.path().to_string_lossy().into_owned()];
        let (tx, rx) = mpsc::channel();
        let child = manager.host.spawn(&uuid::Uuid::new_v4().to_string(), SpawnSpec { program:&python,args:&args,
            cwd:dir.path(),env:&[],unset:&[] }, Arc::new(Inbox(Mutex::new(tx)))).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), "ready");
        let port = std::fs::read_to_string(dir.path().join("port")).unwrap().parse().unwrap();
        {
            let mut runtime = rt.lock().unwrap(); runtime.child = Some(child.clone()); runtime.child_pid = Some(child.pid);
            runtime.engine = Engine::OpenCode(opencode::OpenCode::new(port, dir.path().to_str().unwrap(), resume, Some("base".into()), "auto"));
            manager.with_provider_state(&runtime, |s| s.opencode.carried = true);
        }
        let policy = Arc::new(Collaboration::new()); policy.runtime_policy.bind(dir.path(), 1).unwrap();
        let rig = Self { manager, rt, child, dir, policy, port, _home:home }; rig.revision("1", "explicit"); rig
    }
    fn revision(&self, revision: &str, source: &str) {
        self.policy.install_v2(serde_json::from_value::<Snapshot>(json!({"v":2,"revision":revision,"members":[
            {"userId":"actor","role":"manager","canApprove":true,"approvalSource":"explicit", "writeSource":source},
            {"userId":"approver","role":"viewer","canApprove":true,"approvalSource":"explicit", "writeSource":null}]})).unwrap()).unwrap();
    }
    fn permit(&self, actor: &str, right: Right) -> Permit {
        Permit::new(self.policy.clone(), actor, self.policy.runtime_policy.stamp(actor), right)
    }
    fn context(&self, seq: u64, permit: Option<Permit>) -> OperationContext {
        let binding = self.manager.provider_binding(&self.rt.lock().unwrap()).unwrap();
        OperationContext::new(SenderAuthority::capture(permit, RequiredAction::Drive, None, None, None), RequiredAction::Drive,
            binding, Correlation::Prompt { seq, request:format!("ingress-{seq}") })
    }
    fn send(&self, seq: u64, text: &str, original: OperationContext) {
        let mut rt = self.rt.lock().unwrap();
        self.manager.send_opencode_carried(&mut rt, text.into(), vec![], seq, original).unwrap(); rt.open_turn();
    }
    fn requests(&self) -> Vec<Value> {
        std::fs::read_to_string(self.dir.path().join("requests")).unwrap_or_default().lines().map(|s| serde_json::from_str(s).unwrap()).collect()
    }
    fn done(&self) { until(|| self.manager.with_provider_state(&self.rt.lock().unwrap(), |s| s.opencode.requests.is_empty() && s.opencode.preparing.is_none())); }
    fn ready(&self) {
        self.send(1, "initial", self.context(1, None)); self.done();
        self.event(json!({"type":"session.status","properties":{"sessionID":"same-provider-id","status":{"type":"busy"}}}));
        self.event(json!({"type":"session.status","properties":{"sessionID":"same-provider-id","status":{"type":"idle"}}}));
        until(|| !self.rt.lock().unwrap().turn_open);
    }
    fn event(&self, value: Value) {
        let binding = self.manager.provider_binding(&self.rt.lock().unwrap()).unwrap();
        self.manager.on_opencode_event_from(&self.rt, &self.child, &binding, &value.to_string());
    }
    fn barrier(&self) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (ready, seen) = mpsc::channel(); let (release, waiting) = mpsc::channel();
        self.manager.with_provider_state(&self.rt.lock().unwrap(), |s| s.opencode.before_writes.push_back(Box::new(move || {
            ready.send(()).unwrap(); waiting.recv_timeout(Duration::from_secs(6)).unwrap();
        })));
        (seen, release)
    }
    fn queue(&self, seq: u64, text: &str, original: OperationContext) {
        let mut rt = self.rt.lock().unwrap();
        let id = self.manager.with_provider_state(&rt, |s| s.queue.insert(seq, original));
        rt.queued.push(PendingMessage { message:QueuedMessage { id,text:text.into(),images:vec![] }, privacy:None,seq });
    }
    fn settings(&self) -> Settings { Settings::of(index::get(SESSION).unwrap().tab(TAB).unwrap()) }
    fn configure(&self, setting: &str, value: &str, permit: Option<&Permit>) -> OperationContext {
        let mut rt = self.rt.lock().unwrap();
        let (_, settings) = self.manager.update_settings(&mut rt, |s| {
            if setting=="model" { s.request_model_explicit(value, true, permit, None); }
            else { s.request_mode_explicit(value, true, permit, None); }
            s.retain_provider_request(setting, permit, None);
        }).unwrap();
        SessionManager::remember_configuration(&mut rt, &settings, setting, permit);
        self.manager.capture_acp_setting(&mut rt, &settings, setting, permit).unwrap()
    }
}
impl Drop for Rig { fn drop(&mut self) { self.manager.host.kill_all(); } }

#[test]
fn provider_integration_e_original_queue_remote_refused_and_local_runs_under_unrelated_tls() {
    let rig = Rig::new(None); rig.ready();
    rig.queue(2, "old remote", rig.context(2, Some(rig.permit("actor", Right::Drive))));
    rig.queue(3, "independent local", rig.context(3, None));
    rig.revision("2", "explicit");
    let unrelated = rig.permit("approver", Right::Approve);
    unrelated.with(|| rig.manager.drain_carried_acp_queue(&rig.rt)); rig.done();
    let requests = rig.requests();
    assert!(!requests.iter().any(|r| r["body"]["parts"][0]["text"]=="old remote"));
    assert_eq!(requests.iter().filter(|r| r["body"]["parts"][0]["text"]=="independent local").count(), 1);
}

#[test]
fn provider_integration_e_source_generation_and_native_association_change_before_tcp_bytes() {
    for change in ["source", "runtime", "association", "stop"] {
        let rig = Rig::new(None);
        let context = rig.context(2, Some(rig.permit("actor", Right::Drive)));
        let (seen, release) = rig.barrier(); rig.send(2, "must never reach HTTP", context);
        seen.recv_timeout(Duration::from_secs(5)).unwrap();
        match change {
            "source" => rig.revision("2", "implicit"),
            "runtime" => { rig.policy.runtime_policy.set_generation(2); },
            "association" => { rig.manager.with_provider_state(&rig.rt.lock().unwrap(), |s| s.binding = None); },
            "stop" => { rig.rt.lock().unwrap().stopping = true; },
            _ => unreachable!(),
        }
        release.send(()).unwrap(); rig.done();
        assert_eq!(std::fs::read(rig.dir.path().join("bytes")).unwrap_or_default().len(), 0, "{change}");
    }
}

#[test]
fn provider_integration_e_partial_http_is_unknown_no_replay_or_resume_fallback() {
    let rig = Rig::new(Some("resume".into())); rig.ready();
    let context = rig.context(2, Some(rig.permit("actor", Right::Drive)));
    // Let one physical syscall through, then revoke before the next one.
    rig.manager.with_provider_state(&rig.rt.lock().unwrap(), |s| s.opencode.before_writes.push_back(Box::new(|| {})));
    let (seen, release) = rig.barrier();
    rig.send(2, &"x".repeat(128*1024), context);
    seen.recv_timeout(Duration::from_secs(5)).unwrap(); rig.revision("2", "explicit"); release.send(()).unwrap(); rig.done();
    until(|| rig.dir.path().join("partial").exists());
    assert!(std::fs::read_to_string(rig.dir.path().join("partial")).unwrap().parse::<usize>().unwrap() > 0);
    assert!(!rig.requests().iter().any(|r| r["body"]["parts"][0]["text"].as_str().is_some_and(|t| t.len()>1000)));
    let before = rig.requests().len();
    rig.send(3, "local successor", rig.context(3, None)); rig.done();
    assert_eq!(rig.requests().len(), before+1, "independent local turn is its own HTTP request");
}

#[test]
fn provider_integration_e_unknown_opening_never_falls_back_and_known_failure_does_once() {
    for unknown in [true, false] {
        let rig = Rig::new(Some("old".into()));
        std::fs::write(rig.dir.path().join(if unknown {"drop-response"} else {"missing"}), "").unwrap();
        rig.send(1, "original stash", rig.context(1, None)); rig.done();
        let requests = rig.requests();
        assert_eq!(requests.iter().filter(|r| r["method"]=="GET").count(), 1);
        assert_eq!(requests.iter().filter(|r| r["path"]=="/session").count(), usize::from(!unknown));
        assert_eq!(requests.iter().filter(|r| r["body"]["parts"][0]["text"]=="original stash").count(), usize::from(!unknown));
    }
}

#[test]
fn provider_integration_e_cancel_held_opening_keeps_local_successor_original() {
    let rig = Rig::new(Some("held".into()));
    std::fs::write(rig.dir.path().join("hold-open"), "").unwrap();
    rig.send(1, "cancelled stash", rig.context(1, Some(rig.permit("actor", Right::Drive))));
    until(|| rig.dir.path().join("open-held").exists());
    rig.queue(2, "local after cancel", rig.context(2, None));
    let old = rig.manager.with_provider_state(&rig.rt.lock().unwrap(), |s| s.opencode.requests.values().next().unwrap().clone());
    rig.manager.retire_opencode_original(&rig.rt, &rig.child, &old.context, old.generation, &old.tag);
    rig.revision("2", "explicit");
    std::fs::write(rig.dir.path().join("release-open"), "").unwrap();
    rig.manager.drain_carried_acp_queue(&rig.rt); rig.done();
    let requests = rig.requests();
    assert!(!requests.iter().any(|r| r["body"]["parts"][0]["text"]=="cancelled stash"));
    assert_eq!(requests.iter().filter(|r| r["body"]["parts"][0]["text"]=="local after cancel").count(), 1);
}

#[test]
fn provider_integration_e_same_value_configure_new_native_id_retires_old_confirmation() {
    let rig = Rig::new(None); rig.ready();
    let permit = rig.permit("actor", Right::Configure);
    for setting in ["model", "mode"] {
        let value = if setting=="model" {"same"} else {"plan"};
        let old = rig.configure(setting, value, Some(&permit));
        let current = rig.configure(setting, value, Some(&permit));
        assert_ne!(old.operation_id(), current.operation_id());
        let new_id = rig.settings().collaboration_requests()[setting].clone();
        rig.manager.confirm_opencode_setting(&rig.rt, &old);
        assert_eq!(rig.settings().collaboration_requests()[setting], new_id);
        rig.manager.confirm_opencode_setting(&rig.rt, &current);
        assert!(!rig.settings().collaboration_requests().contains_key(setting));
        assert!(!rig.manager.with_provider_state(&rig.rt.lock().unwrap(), |s| s.settings.contains_key(setting)));
    }
    assert_eq!(rig.settings().model, "same"); assert_eq!(rig.settings().permission_mode, "plan");
}

#[test]
fn provider_integration_e_approve_attempt_is_independent_of_drive_and_old_allow() {
    let rig = Rig::new(None); rig.ready();
    rig.event(json!({"type":"permission.asked","properties":{"sessionID":"same-provider-id","id":"ask","permission":"bash"}}));
    let approve = rig.permit("approver", Right::Approve);
    let (seen, release) = rig.barrier();
    approve.with(|| rig.manager.respond_permission(SESSION, TAB, "oc:ask", "once")).unwrap();
    seen.recv_timeout(Duration::from_secs(5)).unwrap();
    approve.with(|| rig.manager.respond_permission(SESSION, TAB, "oc:ask", "reject")).unwrap();
    release.send(()).unwrap(); rig.done();
    let answers = rig.requests().into_iter().filter(|r| r["path"].as_str().is_some_and(|p| p.contains("/permissions/"))).collect::<Vec<_>>();
    assert_eq!(answers.len(), 1); assert_eq!(answers[0]["body"]["response"], "reject");
    assert!(!rig.rt.lock().unwrap().pending.contains_key("oc:ask"));
}

#[test]
fn provider_integration_e_sse_old_drive_revoked_local_output_survives_exact_association_only() {
    for replace in [false, true] {
        let rig = Rig::new(None); rig.ready();
        let old = rig.context(2, Some(rig.permit("actor", Right::Drive)));
        rig.send(2, "remote", old); rig.done(); rig.revision("2", "explicit");
        // A different local turn shares the same native process. The SSE
        // reader must never borrow the previous prompt's revoked Drive.
        rig.send(3, "local", rig.context(3, None)); rig.done();
        std::fs::write(rig.dir.path().join("sse-line"), json!({"type":"permission.asked","properties":{
            "sessionID":"same-provider-id","id":"from-stream","permission":"bash"}}).to_string()).unwrap();
        let captured = rig.manager.provider_binding(&rig.rt.lock().unwrap()).unwrap();
        let manager = rig.manager.clone(); let runtime = rig.rt.clone(); let child = rig.child.clone(); let port = rig.port;
        let pump = std::thread::spawn(move || opencode::pump_events(&format!("http://127.0.0.1:{port}"),
            || { let rt=runtime.lock().unwrap(); !rt.stopping && manager.provider_binding(&rt).is_some_and(|live| captured.current(&live)) },
            |line| manager.on_opencode_event_from(&runtime, &child, &captured, &line)));
        until(|| rig.dir.path().join("sse-connected").exists());
        if replace { rig.manager.with_provider_state(&rig.rt.lock().unwrap(), |s| s.binding = None); }
        std::fs::write(rig.dir.path().join("sse-release"), "").unwrap();
        if !replace { until(|| rig.rt.lock().unwrap().pending.contains_key("oc:from-stream")); }
        // Wake a blocked/reconnecting read before joining; exact fence must
        // make every released old line inert after replacement/Stop.
        rig.rt.lock().unwrap().stopping = true;
        let _ = TcpStream::connect(("127.0.0.1",rig.port)).and_then(|mut s| s.write_all(b"GET /event HTTP/1.1\r\nHost: localhost\r\n\r\n"));
        pump.join().unwrap();
        assert_eq!(rig.rt.lock().unwrap().pending.contains_key("oc:from-stream"), !replace);
    }
}

#[test]
fn provider_integration_e_actual_reply_deferred_batch_and_duplicate_are_once_only() {
    let rig = Rig::new(None);
    let (reply_tx, reply_rx) = mpsc::channel(); let (release, waiting) = mpsc::channel();
    rig.manager.with_provider_state(&rig.rt.lock().unwrap(), |s| s.opencode.before_callbacks.push_back(Box::new(move |reply| {
        let opencode::PhysicalOutcome::Response { status, body } = &reply.outcome else { panic!("fixture must return an actual response") };
        reply_tx.send(opencode::NativeHttpReply { context:reply.context.clone(),generation:reply.generation,tag:reply.tag.clone(),
            outcome:opencode::PhysicalOutcome::Response {status:*status,body:body.clone()} }).unwrap();
        waiting.recv_timeout(Duration::from_secs(6)).unwrap();
    })));
    rig.send(1, "one original child", rig.context(1, Some(rig.permit("actor", Right::Drive))));
    let reply = reply_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let policy = rig.policy.clone(); let (ready_tx, ready_rx) = mpsc::channel(); let (unlock, locked) = mpsc::channel();
    let holder = std::thread::spawn(move || {
        let _guard = policy.enter_admission(); ready_tx.send(()).unwrap(); locked.recv_timeout(Duration::from_secs(6)).unwrap();
    });
    ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(rig.manager.opencode_response_batch(&rig.rt, &rig.child, &reply).unwrap(), Attempt::Deferred);
    assert_eq!(rig.requests().len(), 1);
    unlock.send(()).unwrap(); holder.join().unwrap();
    assert_eq!(rig.manager.opencode_response_batch(&rig.rt, &rig.child, &reply).unwrap(), Attempt::Applied);
    assert_eq!(rig.manager.opencode_response_batch(&rig.rt, &rig.child, &reply).unwrap(), Attempt::Withdrawn);
    release.send(()).unwrap(); rig.done();
    assert_eq!(rig.requests().iter().filter(|r| r["body"]["parts"][0]["text"]=="one original child").count(), 1);
}

#[test]
fn provider_integration_e_direct_peer_disconnect_before_actual_http_syscall() {
    use crate::remote::{server::{Peer, WorkspaceRpc}, protocol::Authority};
    let rig = Rig::new(None);
    let rpc = WorkspaceRpc::new(rig.dir.path(), 1, rig.manager.sink.clone(), rig.manager.terminals.clone(), Some(rig.manager.clone())).unwrap();
    let (peer, _events) = Peer::new("owner-e-peer".into(), Authority::Manage);
    let permit = rig.permit("actor", Right::Drive).for_peer(&peer);
    let (seen, release) = rig.barrier(); rig.send(1, "disconnected", rig.context(1, Some(permit)));
    seen.recv_timeout(Duration::from_secs(5)).unwrap(); rpc.disconnect(&peer);
    release.send(()).unwrap(); rig.done();
    assert!(std::fs::read(rig.dir.path().join("bytes")).unwrap_or_default().is_empty());
}

#[test]
fn provider_integration_e_independent_local_privacy_mobile_and_share_refuse_before_tcp_bytes() {
    for gate in ["privacy", "mobile", "share"] {
        let rig = Rig::new(None); rig.ready();
        let before = std::fs::read(rig.dir.path().join("bytes")).unwrap().len();
        let mut mobile = None; let mut shared = None;
        let lifetime = crate::local_runtime::Lifetime::new(Duration::from_secs(60));
        if gate=="mobile" {
            store::write_json(&store::root().unwrap().join("devices.json"), &json!({"devices":[{
                "id":"driver","label":"Fixture","platform":"test","token":"fixture-hash",
                "scope":"driver","provenance":"explicit","bindingGeneration":0,"createdAt":index::now()
            }]})).unwrap();
            let lease = lifetime.command("runtime.attach", json!({"protocol":1})).unwrap();
            let actor:crate::local_runtime::mobile::Actor = serde_json::from_value(json!({
                "epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
            rig.manager.mobile.register(&lifetime, actor.clone(), "connection", "driver").unwrap();
            mobile = Some(rig.manager.mobile.permit(&actor, "connection", SESSION, TAB).unwrap());
        }
        if gate=="share" {
            let mut share = crate::local_sharing::tests::fixture();
            let link = share.links.get_mut("link").unwrap(); link.settings.expires_at = i64::MAX; link.credential_expires_at = i64::MAX;
            let mut guest = crate::local_sharing::tests::guest("connection", "guest"); guest.verified_until = i64::MAX;
            let now = chrono::Utc::now().timestamp_millis(); share.join(guest, now).unwrap();
            share.admit("connection", Some(TAB), true, false, now).unwrap();
            shared = Some(share.write_permit("connection", TAB).unwrap());
            rig.manager.sharing.lock().unwrap().sessions.insert(SESSION.into(), share);
        }
        let binding = rig.manager.provider_binding(&rig.rt.lock().unwrap()).unwrap();
        let context = OperationContext::new(SenderAuthority::capture(None, RequiredAction::Drive,
            (gate=="privacy").then(crate::data_privacy::Ticket::denied), mobile, shared), RequiredAction::Drive,
            binding, Correlation::Prompt {seq:1,request:gate.into()});
        let (seen, release) = rig.barrier(); rig.send(1, "independently constrained local", context);
        seen.recv_timeout(Duration::from_secs(5)).unwrap();
        if gate=="mobile" { rig.manager.mobile.invalidate_tab(SESSION, TAB); }
        if gate=="share" { rig.manager.sharing.lock().unwrap().sessions.remove(SESSION); }
        release.send(()).unwrap(); rig.done();
        assert_eq!(std::fs::read(rig.dir.path().join("bytes")).unwrap().len(), before, "{gate}");
    }
}

#[test]
fn provider_integration_e_old_native_callback_cannot_settle_replaced_association() {
    let rig = Rig::new(None);
    let (ready, seen) = mpsc::channel(); let (release, waiting) = mpsc::channel();
    rig.manager.with_provider_state(&rig.rt.lock().unwrap(), |s| s.opencode.before_callbacks.push_back(Box::new(move |_| {
        ready.send(()).unwrap(); waiting.recv_timeout(Duration::from_secs(6)).unwrap();
    })));
    rig.send(1, "old stash", rig.context(1, None)); seen.recv_timeout(Duration::from_secs(5)).unwrap();
    {
        let mut rt = rig.rt.lock().unwrap();
        // Same process and provider ID, different native engine incarnation.
        rig.manager.with_provider_state(&rt, |s| s.binding = None);
        rt.engine = Engine::OpenCode(opencode::OpenCode::new(rig.port, rig.dir.path().to_str().unwrap(), None, Some("replacement".into()), "plan"));
    }
    release.send(()).unwrap(); rig.done();
    assert_eq!(rig.requests().len(), 1);
    assert!(matches!(&rig.rt.lock().unwrap().engine, Engine::OpenCode(e) if !e.ready && e.model.as_deref()==Some("replacement")));
}

#[test]
fn provider_integration_e_pending_configure_snapshot_precedes_original_prompt_body() {
    let rig = Rig::new(None); rig.ready();
    let configure = rig.permit("actor", Right::Configure);
    let model = rig.configure("model", "provider/new-model", Some(&configure));
    let mode = rig.configure("mode", "plan", Some(&configure));
    {
        let mut rt = rig.rt.lock().unwrap();
        rig.manager.stage_opencode_setting(&mut rt, model.clone());
        rig.manager.stage_opencode_setting(&mut rt, mode.clone());
    }
    rig.send(2, "new snapshot", rig.context(2, Some(rig.permit("actor", Right::Drive)))); rig.done();
    let request = rig.requests().into_iter().find(|r| r["body"]["parts"][0]["text"]=="new snapshot").unwrap();
    assert_eq!(request["body"]["model"], json!({"providerID":"provider","modelID":"new-model"}));
    assert_eq!(request["body"]["agent"], "plan");
    assert!(model.callback_finished() && mode.callback_finished());
    assert_eq!(rig.settings().model, "provider/new-model"); assert_eq!(rig.settings().permission_mode, "plan");
}
