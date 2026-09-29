//! The API's agent command mailbox and transcript checkpoints, as the runtime
//! sees them (terminalx-saas `cloud-workspace-remote-runtime-contract.md`
//! §11.3, §12), played by the test on a local port. The test is the client:
//! it enqueues commands it encrypted itself and reads states, receipts and
//! checkpoints straight from here.
//!
//! What it keeps from the real server: per-tab lanes (a command is leased only
//! once every earlier command in its tab has settled), one live lease per
//! command, redelivery of an expired or older-generation lease as the same
//! command with a new token, `storageIncarnationId` changes settling leased
//! commands as `outcome-unknown`, stale-lease and stale-generation acks, a
//! repeated ack answered the same, and monotonic `(epoch, version)`
//! checkpoints with duplicate/conflict/stale detection.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use raccoon_lib::cloud_agents::crypto;
use serde_json::{json, Value};

pub const ORG: &str = "org_test";
pub const WORKSPACE: &str = "ws_test";
pub const CREDENTIAL: &str = "runtime-credential-runtime-credential-0001";

#[derive(Clone, Debug)]
pub struct Command {
    pub command_id: String,
    pub client_command_id: String,
    pub tab_id: String,
    pub kind: String,
    pub sequence: u64,
    pub key_id: String,
    pub iv: String,
    pub ciphertext: String,
    pub authority: String,
    pub state: String,
    pub lease_token: Option<String>,
    pub lease_expires: Option<Instant>,
    pub lease_generation: u64,
    pub lease_incarnation: Option<String>,
    pub lease_count: u64,
    pub category: Option<String>,
    pub result_iv: Option<String>,
    pub result_ciphertext: Option<String>,
    /// The token and outcome the command was settled with, so a repeated ack
    /// gets the same answer.
    pub settled_by: Option<(String, String)>,
}

impl Command {
    fn settled(&self) -> bool {
        !matches!(self.state.as_str(), "queued" | "leased")
    }

    fn json(&self) -> Value {
        json!({
            "clientCommandId": self.client_command_id, "tabId": self.tab_id, "kind": self.kind,
            "sequence": self.sequence, "state": self.state, "everLeased": self.lease_count > 0,
            "leaseCount": self.lease_count, "keyId": self.key_id, "iv": self.iv, "ciphertext": self.ciphertext,
            "outcomeCategory": self.category, "resultIv": self.result_iv, "resultCiphertext": self.result_ciphertext,
        })
    }
}

#[derive(Clone, Debug)]
pub struct Checkpoint {
    pub epoch: u64,
    pub version: u64,
    pub schema_version: u64,
    pub key_id: String,
    pub iv: String,
    pub ciphertext: String,
    pub sha256: String,
}

#[derive(Default)]
pub struct State {
    pub commands: Vec<Command>,
    pub generation: u64,
    pub checkpoints: HashMap<String, Vec<Checkpoint>>,
    pub lease_calls: u64,
    /// Every ack the runtime made: (client command id, outcome, HTTP status).
    pub acks: Vec<(String, String, u16)>,
    pub incarnations: Vec<String>,
    pub deleted_checkpoints: Vec<String>,
    pub lease_ttl: Duration,
    /// Acks of these commands answer 503 without settling, this many more
    /// times (`u32::MAX`: until cleared), as a lost ack response would.
    pub fail_acks: HashMap<String, u32>,
    /// The workspace's launch intent (contract §19.3), when it has one.
    pub launch: Option<Launch>,
    next: u64,
}

/// A launch intent as the server keeps it: one per workspace, claimed by a
/// receipt store's incarnation and settled once.
#[derive(Clone, Debug)]
pub struct Launch {
    /// The claim response's `launch` object while `deliver`able.
    pub intent: Value,
    pub state: String,
    pub claimed_by: Option<String>,
    pub claims: u32,
    pub phases: Vec<String>,
    /// Every completion the runtime reported, answered or not.
    pub completions: Vec<Value>,
    pub category: Option<String>,
}

pub struct FakeMailbox {
    pub origin: String,
    pub state: Arc<Mutex<State>>,
}

impl FakeMailbox {
    pub fn start(generation: u64) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let state = Arc::new(Mutex::new(State { generation, lease_ttl: Duration::from_secs(60), ..State::default() }));
        let shared = state.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let state = shared.clone();
                std::thread::spawn(move || serve(stream, &state));
            }
        });
        Self { origin, state }
    }

    /// The `mailbox` section of a `--relay-link` file.
    pub fn link_section(&self) -> Value {
        json!({ "origin": self.origin, "runtimeCredential": CREDENTIAL, "organizationId": ORG, "workspaceId": WORKSPACE })
    }

    /// Give the workspace a launch intent (§19): `intent` is the claim's
    /// `launch` object without `state` and `redelivery`.
    pub fn set_launch(&self, intent: Value) {
        self.state.lock().unwrap().launch = Some(Launch {
            intent,
            state: "pending".into(),
            claimed_by: None,
            claims: 0,
            phases: Vec::new(),
            completions: Vec::new(),
            category: None,
        });
    }

    pub fn launch(&self) -> Launch {
        self.state.lock().unwrap().launch.clone().expect("a launch intent")
    }

    /// Encrypt and queue a command as a client would. Returns its client id.
    pub fn enqueue(&self, key_id: &str, key: &[u8; 32], tab_id: &str, kind: &str, plaintext: Value, authority: &str) -> String {
        let client_command_id = uuid::Uuid::new_v4().to_string();
        let aad = crypto::command_aad(ORG, WORKSPACE, tab_id, &client_command_id, kind, key_id);
        let (iv, ciphertext) = crypto::seal(key, plaintext.to_string().as_bytes(), &aad).unwrap();
        let mut state = self.state.lock().unwrap();
        state.next += 1;
        let sequence = state.next;
        state.commands.push(Command {
            command_id: format!("command_{sequence}"),
            client_command_id: client_command_id.clone(),
            tab_id: tab_id.into(),
            kind: kind.into(),
            sequence,
            key_id: key_id.into(),
            iv,
            ciphertext,
            authority: authority.into(),
            state: "queued".into(),
            lease_token: None,
            lease_expires: None,
            lease_generation: 0,
            lease_incarnation: None,
            lease_count: 0,
            category: None,
            result_iv: None,
            result_ciphertext: None,
            settled_by: None,
        });
        client_command_id
    }

    pub fn command(&self, client_command_id: &str) -> Command {
        self.state.lock().unwrap().commands.iter().find(|c| c.client_command_id == client_command_id).cloned().expect("known command")
    }

    /// Poll until the command settles (or `deadline` passes).
    pub fn settled(&self, client_command_id: &str, deadline: Duration) -> Command {
        let until = Instant::now() + deadline;
        loop {
            let command = self.command(client_command_id);
            if command.settled() {
                return command;
            }
            assert!(Instant::now() < until, "command {client_command_id} never settled: {command:?}");
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// The runtime's receipt for a settled command, decrypted.
    pub fn receipt(&self, client_command_id: &str, keys: &HashMap<String, [u8; 32]>) -> Option<Value> {
        let command = self.command(client_command_id);
        let (iv, ciphertext) = (command.result_iv?, command.result_ciphertext?);
        for (key_id, key) in keys {
            let aad = crypto::receipt_aad(ORG, WORKSPACE, client_command_id, &command.state, key_id);
            if let Ok(plain) = crypto::open(key, &iv, &ciphertext, &aad) {
                return serde_json::from_slice(&plain).ok();
            }
        }
        panic!("no known key opens the receipt of {client_command_id}");
    }

    /// Make every live lease look expired, as if 60 s had passed.
    pub fn expire_leases(&self) {
        let mut state = self.state.lock().unwrap();
        for command in state.commands.iter_mut().filter(|c| c.state == "leased") {
            command.lease_expires = Some(Instant::now() - Duration::from_secs(1));
        }
    }

    pub fn fail_acks(&self, client_command_id: &str, times: u32) {
        self.state.lock().unwrap().fail_acks.insert(client_command_id.to_string(), times);
    }

    pub fn acks_for(&self, client_command_id: &str) -> Vec<(String, u16)> {
        self.state.lock().unwrap().acks.iter().filter(|(id, _, _)| id == client_command_id).map(|(_, outcome, status)| (outcome.clone(), *status)).collect()
    }

    /// The newest checkpoint of a tab, decrypted and inflated.
    pub fn checkpoint(&self, tab_id: &str, keys: &HashMap<String, [u8; 32]>) -> Option<(u64, u64, Value)> {
        let newest = self.state.lock().unwrap().checkpoints.get(tab_id)?.last().cloned()?;
        let key = keys.get(&newest.key_id).expect("the checkpoint's key was handed out");
        let aad = crypto::checkpoint_aad(ORG, WORKSPACE, tab_id, newest.epoch, newest.version, newest.schema_version, &newest.key_id);
        let packed = crypto::open(key, &newest.iv, &newest.ciphertext, &aad).expect("the checkpoint decrypts");
        let plain = crypto::gunzip(&packed, 8 * 1024 * 1024).unwrap();
        Some((newest.epoch, newest.version, serde_json::from_slice(&plain).unwrap()))
    }
}

fn serve(stream: TcpStream, state: &Mutex<State>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    let mut headers = HashMap::new();
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).is_err() || header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let length: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    let mut body = vec![0; length];
    let _ = reader.read_exact(&mut body);
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let (status, reply) = if headers.get("authorization").map(String::as_str) != Some(&format!("Bearer {CREDENTIAL}")) {
        (401, json!({ "error": "cloud_workspace_bootstrap_invalid" }))
    } else {
        route(&method, &path, &body, &mut state.lock().unwrap())
    };
    let text = reply.to_string();
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        503 => "Service Unavailable",
        404 => "Not Found",
        409 => "Conflict",
        _ => "Error",
    };
    let mut stream = stream;
    let _ = write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\ncontent-type: application/json\r\ncache-control: no-store\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{text}",
        text.len()
    );
    let _ = stream.flush();
}

const PREFIX: &str = "/v1/cloud-workspace-bootstrap";

fn route(method: &str, path: &str, body: &Value, state: &mut State) -> (u16, Value) {
    let Some(rest) = path.strip_prefix(PREFIX) else { return (404, json!({ "error": "not_found" })) };
    match (method, rest) {
        ("POST", "/agent-commands/lease") => lease(body, state),
        ("POST", rest) if rest.starts_with("/agent-commands/") && rest.ends_with("/ack") => {
            let id = &rest["/agent-commands/".len()..rest.len() - "/ack".len()];
            ack(id, body, state)
        }
        ("POST", "/launch-intent/claim") => claim_launch(body, state),
        ("POST", "/launch-intent/phase") => launch_phase(body, state),
        ("POST", "/launch-intent/complete") => complete_launch(body, state),
        ("PUT", rest) if rest.starts_with("/transcript-checkpoints/") => put_checkpoint(&rest["/transcript-checkpoints/".len()..], body, state),
        ("DELETE", rest) if rest.starts_with("/transcript-checkpoints/") => {
            let tab = rest["/transcript-checkpoints/".len()..].to_string();
            state.checkpoints.remove(&tab);
            state.deleted_checkpoints.push(tab);
            (200, json!({ "ok": true }))
        }
        _ => (404, json!({ "error": "not_found" })),
    }
}

fn claim_launch(body: &Value, state: &mut State) -> (u16, Value) {
    let Some(incarnation) = body["storageIncarnationId"].as_str().filter(|v| (16..=128).contains(&v.len())).map(String::from) else {
        return (401, json!({ "error": "cloud_workspace_bootstrap_invalid" }));
    };
    let Some(launch) = state.launch.as_mut() else { return (200, json!({ "v": 1, "launch": null })) };
    launch.claims += 1;
    let mut reply = launch.intent.clone();
    match launch.state.as_str() {
        "pending" => {
            launch.state = "claimed".into();
            launch.claimed_by = Some(incarnation);
            reply["state"] = json!("deliver");
            reply["redelivery"] = json!(false);
        }
        "claimed" if launch.claimed_by.as_deref() == Some(incarnation.as_str()) => {
            reply["state"] = json!("deliver");
            reply["redelivery"] = json!(true);
        }
        "claimed" => {
            launch.state = "outcome-unknown".into();
            launch.category = Some("runtime-storage-replaced".into());
            reply["state"] = json!("outcome-unknown");
        }
        settled => reply["state"] = json!(settled),
    }
    if reply["state"] != "deliver" {
        reply.as_object_mut().unwrap().remove("prompt");
        reply["redelivery"] = json!(false);
    }
    (200, json!({ "v": 1, "launch": reply }))
}

fn launch_phase(body: &Value, state: &mut State) -> (u16, Value) {
    let Some(launch) = state.launch.as_mut().filter(|launch| launch.intent["launchId"] == body["launchId"]) else {
        return (404, json!({ "error": "cloud_workspace_launch_intent_not_found" }));
    };
    let phase = body["phase"].as_str().unwrap_or_default();
    if !matches!(phase, "syncing-repository" | "starting-agent") {
        return (401, json!({ "error": "cloud_workspace_bootstrap_invalid" }));
    }
    if launch.state != "claimed" {
        return (409, json!({ "error": "cloud_workspace_launch_intent_settled", "state": launch.state }));
    }
    if !launch.phases.iter().any(|p| p == phase) {
        launch.phases.push(phase.into());
    }
    (200, json!({ "v": 1, "state": launch.state }))
}

fn complete_launch(body: &Value, state: &mut State) -> (u16, Value) {
    let Some(launch) = state.launch.as_mut().filter(|launch| launch.intent["launchId"] == body["launchId"]) else {
        return (404, json!({ "error": "cloud_workspace_launch_intent_not_found" }));
    };
    let outcome = body["outcome"].as_str().unwrap_or_default().to_string();
    if !matches!(outcome.as_str(), "started" | "failed" | "outcome-unknown") {
        return (401, json!({ "error": "cloud_workspace_bootstrap_invalid" }));
    }
    launch.completions.push(body.clone());
    if launch.state == "claimed" {
        launch.state = outcome;
        launch.category = body["category"].as_str().map(String::from);
        return (200, json!({ "v": 1, "state": launch.state }));
    }
    if launch.state == outcome {
        return (200, json!({ "v": 1, "state": launch.state }));
    }
    (409, json!({ "error": "cloud_workspace_launch_intent_settled", "state": launch.state }))
}

fn token() -> String {
    crypto::b64(&crypto::random_bytes::<32>())
}

fn lease(body: &Value, state: &mut State) -> (u16, Value) {
    let Some(incarnation) = body["storageIncarnationId"].as_str().filter(|v| (16..=128).contains(&v.len())).map(String::from) else {
        return (401, json!({ "error": "cloud_workspace_bootstrap_invalid" }));
    };
    let limit = body["limit"].as_u64().unwrap_or(16).clamp(1, 16) as usize;
    state.lease_calls += 1;
    if !state.incarnations.contains(&incarnation) {
        state.incarnations.push(incarnation.clone());
    }
    let now = Instant::now();
    let generation = state.generation;
    let mut outcome_unknown = Vec::new();
    for command in state.commands.iter_mut().filter(|c| c.state == "leased") {
        if command.lease_incarnation.as_deref() != Some(incarnation.as_str()) {
            command.state = "outcome-unknown".into();
            command.category = Some("runtime-storage-replaced".into());
            command.lease_token = None;
            outcome_unknown.push(command.client_command_id.clone());
        }
    }
    let mut leases = Vec::new();
    let mut lanes_seen: Vec<String> = Vec::new();
    let ttl = state.lease_ttl;
    let mut order: Vec<usize> = (0..state.commands.len()).collect();
    order.sort_by_key(|&i| state.commands[i].sequence);
    for i in order {
        if leases.len() >= limit {
            break;
        }
        let command = &mut state.commands[i];
        if command.settled() || lanes_seen.contains(&command.tab_id) {
            continue;
        }
        // The head of its lane: nothing behind it may be leased this round.
        lanes_seen.push(command.tab_id.clone());
        let live = command.state == "leased" && command.lease_expires.is_some_and(|at| at > now) && command.lease_generation == generation;
        if live {
            continue;
        }
        let redelivery = command.lease_count > 0;
        command.state = "leased".into();
        command.lease_count += 1;
        command.lease_token = Some(token());
        command.lease_expires = Some(now + ttl);
        command.lease_generation = generation;
        command.lease_incarnation = Some(incarnation.clone());
        leases.push(json!({
            "commandId": command.command_id, "clientCommandId": command.client_command_id, "tabId": command.tab_id,
            "kind": command.kind, "sequence": command.sequence, "keyId": command.key_id, "iv": command.iv,
            "ciphertext": command.ciphertext, "actor": { "userId": "user_test", "authority": command.authority },
            "createdAt": 0, "leaseCount": command.lease_count, "redelivery": redelivery,
            "leaseToken": command.lease_token, "leaseExpiresAt": 0, "runtimeGeneration": generation,
        }));
    }
    (200, json!({ "leases": leases, "outcomeUnknown": outcome_unknown, "leaseTtlMs": ttl.as_millis() as u64 }))
}

fn ack(command_id: &str, body: &Value, state: &mut State) -> (u16, Value) {
    let generation = state.generation;
    let Some(index) = state.commands.iter().position(|c| c.command_id == command_id) else {
        return (404, json!({ "error": "cloud_workspace_agent_command_not_found" }));
    };
    let token = body["leaseToken"].as_str().unwrap_or_default().to_string();
    let outcome = body["outcome"].as_str().unwrap_or_default().to_string();
    if !matches!(outcome.as_str(), "applied" | "rejected" | "outcome-unknown") {
        return (401, json!({ "error": "cloud_workspace_bootstrap_invalid" }));
    }
    let client_id = state.commands[index].client_command_id.clone();
    if let Some(left) = state.fail_acks.get_mut(&client_id).filter(|left| **left > 0) {
        *left = left.saturating_sub(if *left == u32::MAX { 0 } else { 1 });
        state.acks.push((client_id, outcome, 503));
        return (503, json!({ "error": "unavailable" }));
    }
    let command = &mut state.commands[index];
    let (status, reply) = if command.settled() {
        match &command.settled_by {
            Some((by, settled_outcome)) if *by == token && *settled_outcome == outcome => (200, json!({ "acknowledged": true, "command": command.json() })),
            _ => (409, json!({ "error": "cloud_workspace_agent_command_stale", "acknowledged": false, "code": "stale-lease", "command": command.json() })),
        }
    } else if command.lease_token.as_deref() != Some(token.as_str()) {
        (409, json!({ "error": "cloud_workspace_agent_command_stale", "acknowledged": false, "code": "stale-lease", "command": command.json() }))
    } else if command.lease_generation != generation {
        (409, json!({ "error": "cloud_workspace_agent_command_stale", "acknowledged": false, "code": "stale-generation", "command": command.json() }))
    } else {
        command.state = outcome.clone();
        command.category = body["category"].as_str().map(String::from);
        command.result_iv = body["resultIv"].as_str().map(String::from);
        command.result_ciphertext = body["resultCiphertext"].as_str().map(String::from);
        command.settled_by = Some((token, outcome.clone()));
        (200, json!({ "acknowledged": true, "command": command.json() }))
    };
    state.acks.push((client_id, outcome, status));
    (status, reply)
}

fn put_checkpoint(tab_id: &str, body: &Value, state: &mut State) -> (u16, Value) {
    let invalid = || (401, json!({ "error": "cloud_workspace_bootstrap_invalid" }));
    let (Some(epoch), Some(version), Some(schema_version), Some(key_id), Some(iv), Some(ciphertext), Some(sha)) = (
        body["epoch"].as_u64(),
        body["version"].as_u64(),
        body["schemaVersion"].as_u64(),
        body["keyId"].as_str(),
        body["iv"].as_str(),
        body["ciphertext"].as_str(),
        body["sha256"].as_str(),
    ) else {
        return invalid();
    };
    let Ok(decoded) = crypto::unb64(ciphertext) else { return invalid() };
    if decoded.len() > crypto::MAX_CHECKPOINT_CIPHERTEXT || crypto::sha256_hex(&decoded) != sha {
        return invalid();
    }
    let stored = state.checkpoints.entry(tab_id.to_string()).or_default();
    if let Some(newest) = stored.last() {
        match (epoch, version).cmp(&(newest.epoch, newest.version)) {
            std::cmp::Ordering::Less => return (409, json!({ "error": "cloud_workspace_checkpoint_stale" })),
            std::cmp::Ordering::Equal if newest.sha256 == sha => return (200, json!({ "ok": true, "duplicate": true })),
            std::cmp::Ordering::Equal => return (409, json!({ "error": "cloud_workspace_checkpoint_conflict" })),
            std::cmp::Ordering::Greater => {}
        }
    }
    stored.push(Checkpoint { epoch, version, schema_version, key_id: key_id.into(), iv: iv.into(), ciphertext: ciphertext.into(), sha256: sha.into() });
    if stored.len() > 2 {
        stored.remove(0);
    }
    (200, json!({ "ok": true, "duplicate": false }))
}
