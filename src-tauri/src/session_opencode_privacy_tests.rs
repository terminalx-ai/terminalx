//! Real relay send, SessionManager queues, and a loopback OpenCode HTTP/SSE
//! provider. The refused opening never reaches the server and never replies.
use super::*;
use crate::remote::{protocol::{Authority, PROTOCOL}, server::{Peer, WorkspaceRpc}};

const CASE: &str = "TERMINALX_TEST_OPENCODE_PRIVACY";

#[test]
fn privacy_opencode_denied_opening_preserves_local_followups() {
    for kind in ["personal-on", "personal-cycle", "managed-on", "managed-cycle"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "session::watch_tests::prompts::privacy::opencode_privacy::opening_child", "--nocapture"])
            .env(CASE, kind).output().unwrap();
        assert!(output.status.success(), "{kind}: {}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
}

#[test]
fn opening_child() {
    let Ok(kind) = std::env::var(CASE) else { return };
    let managed = kind.starts_with("managed");
    let cycle = kind.ends_with("cycle");
    let rig = Rig::of(CliKind::Claude, "");
    let policy = |enabled| {
        if managed && enabled { std::env::set_var("TERMINALX_TEST_MANAGED_PRIVACY", "1"); }
        else { std::env::remove_var("TERMINALX_TEST_MANAGED_PRIVACY"); }
        store::write_json(&store::root().unwrap().join("data-privacy.json"), &json!({"enabled":enabled && !managed})).unwrap();
        assert_eq!(crate::data_privacy::refresh().enabled, enabled);
    };
    policy(false);
    let root = rig._dir.path().canonicalize().unwrap();
    index::save(&[serde_json::from_value(json!({"id":SESSION,"projectPath":root,"cwd":root,
        "title":"OpenCode privacy","created":index::now(),"modified":index::now(),
        "tabs":[{"id":TAB,"harness":"opencode","permissionMode":"default","created":index::now()}]})).unwrap()]).unwrap();
    let script = root.join("provider.py");
    let port_file = root.join("port");
    let records = root.join("requests");
    std::fs::write(&script, r#"
import http.server, json, pathlib, queue
root = pathlib.Path(__file__).parent
news = queue.Queue()
class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        if self.path == '/session':
            self.send_response(200); self.send_header('Content-Length', '2'); self.end_headers(); self.wfile.write(b'[]'); return
        assert self.path == '/event'
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        while True:
            self.wfile.write(('data: '+json.dumps(news.get())+'\n\n').encode()); self.wfile.flush()
    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        with (root/'requests').open('a') as f:
            f.write(json.dumps({'path':self.path, 'body':data})+'\n')
        body = b'{"id":"local-session"}' if self.path == '/session' else b'{}'
        self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers()
        self.wfile.write(body); self.wfile.flush()
        if self.path.endswith('/message'):
            for status in ['busy', 'idle']:
                news.put({'type':'session.status','properties':{'sessionID':'local-session','status':{'type':status}}})
server = http.server.ThreadingHTTPServer(('127.0.0.1',0), Provider)
(root/'port').write_text(str(server.server_address[1]))
server.serve_forever()
"#).unwrap();
    let python = crate::binpath::resolve("python3").expect("python3 fixture provider");
    {
        let mut rt = rig.rt.lock().unwrap();
        rt.engine = Engine::OpenCode(opencode::OpenCode::new(0, root.to_str().unwrap(), None, None, "default"));
        rt.harness = "opencode".into();
        rig.manager.spawn_child(&mut rt, &rig.rt, &python, &[script.to_string_lossy().into_owned()], root.to_str().unwrap()).unwrap();
    }
    struct ProviderOwner(SessionManager);
    impl Drop for ProviderOwner {
        fn drop(&mut self) { let _ = self.0.stop(SESSION, TAB); }
    }
    let _provider = ProviderOwner(rig.manager.clone());
    wait_for("fixture HTTP provider listening", || port_file.exists());
    let port: u16 = std::fs::read_to_string(&port_file).unwrap().parse().unwrap();
    {
        let mut rt = rig.rt.lock().unwrap();
        rt.engine = Engine::OpenCode(opencode::OpenCode::new(port, root.to_str().unwrap(), None, None, "default"));
    }
    let manager = rig.manager.clone(); let rt = rig.rt.clone();
    let pid = rt.lock().unwrap().child_pid;
    let pump = std::thread::spawn(move || opencode::pump_events(&format!("http://127.0.0.1:{port}"),
        || rt.lock().unwrap().child_pid == pid, |line| manager.on_line(&rt, &line)));
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).max_blocking_threads(2).enable_all().build().unwrap();
    let rpc = WorkspaceRpc::new(&root, 1, rig.manager.sink.clone(), rig.manager.terminals.clone(), Some(rig.manager.clone())).unwrap();
    let (peer, _events) = Peer::new("opencode-privacy".into(), Authority::Manage);
    assert_eq!(runtime.block_on(rpc.handle(&peer, &json!({"id":"hello","method":"rpc.hello","params":{"protocol":PROTOCOL,"want":["session/1"]}})))["ok"], true);
    let send = |text: &str| runtime.block_on(rpc.handle(&peer, &json!({"id":"send","method":"session.send","params":{
        "sessionId":SESSION,"tabId":TAB,"text":text,"clientRequestId":uuid::Uuid::new_v4().to_string()}})));
    let (entered, arrived) = mpsc::channel(); let (release, released) = mpsc::channel();
    *BEFORE_OPENCODE_HTTP.lock().unwrap() = Some(Box::new(move || {
        entered.send(()).unwrap(); released.recv_timeout(WAIT).unwrap();
    }));
    let remote = send("expired remote");
    assert_eq!(remote["ok"], true, "{remote}");
    arrived.recv_timeout(WAIT).unwrap();
    let old_actions = { // a duplicate old opening callback must not touch a replacement
        let rt = rig.rt.lock().unwrap();
        let Engine::OpenCode(o) = &rt.engine else { panic!("OpenCode") };
        o.generation()
    };
    let first = rig.manager.send(SESSION, TAB, "local first".into(), vec![]).unwrap();
    let second = rig.manager.send(SESSION, TAB, "local second".into(), vec![]).unwrap();
    assert!(first.queued && second.queued);
    assert_eq!(rig.rt.lock().unwrap().queued.len(), 2);
    policy(true); if cycle { policy(false); }
    assert!(!records.exists(), "the denied opening has not contacted HTTP");
    release.send(()).unwrap();
    let read = || std::fs::read_to_string(&records).unwrap_or_default().lines().map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()).collect::<Vec<_>>();
    wait_for("both queued local prompts physically delivered", || read().len() >= 3);
    wait_for("local turns settled", || !rig.rt.lock().unwrap().turn_open);
    let rows = read();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[0]["path"], "/session");
    assert_eq!(rows[1]["body"]["parts"][0]["text"], "local first");
    assert_eq!(rows[2]["body"]["parts"][0]["text"], "local second");
    assert!(rig.rt.lock().unwrap().queued.is_empty());
    let remote_seq = rig.events().iter().find_map(|event| matches!(&event.payload, Payload::UserMessage { text, .. } if text == "expired remote").then_some(event.seq)).unwrap();
    assert_eq!(rig.events().iter().filter(|event| matches!(event.payload, Payload::PromptWithdrawn { prompt_seq } if prompt_seq == remote_seq)).count(), 1);
    for text in ["local first", "local second"] {
        assert_eq!(rig.events().iter().filter(|event| matches!(&event.payload, Payload::UserMessage { text: sent, .. } if sent == text)).count(), 1);
    }
    // Execute a genuinely obsolete asynchronous opening request. Its worker
    // has the same child but must reject the retired generation before HTTP.
    let (entered, arrived) = mpsc::channel();
    *BEFORE_OPENCODE_HTTP.lock().unwrap() = Some(Box::new(move || { entered.send(()).unwrap(); }));
    {
        let mut rt = rig.rt.lock().unwrap();
        rig.manager.apply_actions(&mut rt, vec![Action::Http { generation: old_actions, tag:"session_new".into(), method:"POST".into(), url:format!("http://127.0.0.1:{port}/session"), body:Some(json!({})) }]);
    }
    arrived.recv_timeout(WAIT).unwrap();
    policy(false);
    assert_eq!(send("fresh remote")["ok"], true);
    wait_for("fresh remote physically delivered", || read().len() >= 4);
    wait_for("fresh turn settled", || !rig.rt.lock().unwrap().turn_open);
    let rows = read();
    assert_eq!(rows.len(), 4, "expired opening/prompt replayed: {rows:?}");
    assert_eq!(rows[3]["body"]["parts"][0]["text"], "fresh remote");
    rig.manager.stop(SESSION, TAB).unwrap();
    pump.join().unwrap();
}
