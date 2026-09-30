use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;

const ORG: &str = "org_1";
const WS: &str = "ws_1";
const USER: &str = "user_1";
const KEY_ID: &str = "key-aaaaaaaaaaaaaaaaaaaaaa";

/// The signed-in `(user, active organization)`, and the other member
/// Organizations reachable by membership (CS-18; empty on an older server).
struct Fixed(Mutex<Option<(String, String)>>, Mutex<Vec<String>>);

impl AccountSource for Fixed {
    fn context_in(&self, organization_id: &str) -> Result<Ctx, String> {
        let (user_id, active) = self.0.lock().unwrap().clone().ok_or("account_signed_out")?;
        if active != organization_id && !self.1.lock().unwrap().iter().any(|org| org == organization_id) {
            return Err("cloud_remote_organization_mismatch".into());
        }
        Ok(Ctx { user_id, organization_id: organization_id.into(), access_token: Zeroizing::new("token".into()) })
    }
}

fn kept(orgs: &[&str]) -> Option<KeptIdentity> {
    Some((USER.into(), orgs.iter().map(|org| org.to_string()).collect()))
}

type Handler = dyn Fn(&str, &str, Value) -> Option<(u16, Value)> + Send + Sync;

/// One request per connection. A handler answering `None` closes the
/// connection without a response, as a network drop after the request would.
fn serve(handler: Arc<Handler>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let mut parts = line.split_whitespace();
            let (method, target) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
            let mut length = 0;
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                if header.trim().is_empty() {
                    break;
                }
                if let Some((name, value)) = header.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") {
                        length = value.trim().parse().unwrap();
                    }
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let body = serde_json::from_slice(&body).unwrap_or(Value::Null);
            if let Some((status, reply)) = handler(&method, &target, body) {
                let bytes = reply.to_string();
                let _ = write!(stream, "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{bytes}", bytes.len());
            }
        }
    });
    base
}

struct Fixture {
    client: CloudAgentClient,
    keys: Arc<MemoryKeys>,
    account: Arc<Fixed>,
    _dir: tempfile::TempDir,
}

fn fixture(base: &str) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let keys = Arc::new(MemoryKeys::default());
    let account = Arc::new(Fixed(Mutex::new(Some((USER.into(), ORG.into()))), Mutex::new(Vec::new())));
    let client = CloudAgentClient::with(account.clone(), keys.clone(), Url::parse(base).unwrap(), dir.path().join("cloud-agent"));
    Fixture { client, keys, account, _dir: dir }
}

fn key() -> [u8; 32] {
    [7u8; 32]
}

fn give_key(fixture: &Fixture) {
    fixture
        .client
        .store_keys(USER, ORG, WS, &json!({ "currentKeyId": KEY_ID, "keys": [{ "keyId": KEY_ID, "key": crypto::b64(&key()), "createdAt": 1 }] }))
        .unwrap();
}

fn commands_path() -> String {
    format!("/v1/desktop/orgs/{ORG}/cloud-workspaces/{WS}/agent-commands")
}

fn command_json(envelope: &Value, state: &str) -> Value {
    json!({ "clientCommandId": envelope["clientCommandId"], "tabId": envelope["tabId"], "kind": envelope["kind"], "sequence": 1, "state": state })
}

#[test]
fn a_command_needs_a_workspace_key_first() {
    let fixture = fixture(&serve(Arc::new(|_, _, _| Some((500, json!({}))))));
    let error = fixture.client.enqueue(ORG, WS, "tab-1", "send", json!({ "text": "hi" })).unwrap_err();
    assert_eq!(error, "cloud_agent_key_missing");
    assert!(!fixture.client.has_key(ORG, WS).unwrap());
    give_key(&fixture);
    assert!(fixture.client.has_key(ORG, WS).unwrap());
}

#[test]
fn another_organization_is_refused() {
    let fixture = fixture(&serve(Arc::new(|_, _, _| None)));
    assert_eq!(fixture.client.outbox("org_2", WS, None).unwrap_err(), "cloud_remote_organization_mismatch");
    *fixture.account.0.lock().unwrap() = None;
    assert_eq!(fixture.client.outbox(ORG, WS, None).unwrap_err(), "account_signed_out");
}

#[test]
fn a_lost_response_is_resent_with_the_same_bytes_and_never_re_encrypted() {
    let received: Arc<Mutex<Vec<Value>>> = Arc::default();
    let calls = Arc::new(AtomicUsize::new(0));
    let (log, count) = (received.clone(), calls.clone());
    let base = serve(Arc::new(move |method, path, body| {
        if path.ends_with("/status") {
            let stored: Vec<Value> = log.lock().unwrap().iter().take(1).map(|envelope| command_json(envelope, "queued")).collect();
            return Some((200, json!({ "commands": stored })));
        }
        assert_eq!((method, path), ("POST", commands_path().as_str()));
        let first = count.fetch_add(1, Ordering::SeqCst) == 0;
        let existing = !log.lock().unwrap().is_empty();
        log.lock().unwrap().push(body.clone());
        // The first request is stored, but its answer is lost.
        (!first).then(|| (if existing { 200 } else { 202 }, json!({ "command": command_json(&body, "queued"), "existing": existing, "wake": "queued" })))
    }));
    let fixture = fixture(&base);
    give_key(&fixture);
    let entry = fixture.client.enqueue(ORG, WS, "tab-1", "send", json!({ "text": "run the tests", "model": "opus" })).unwrap();
    assert_eq!(entry.state, "unsent");
    assert_eq!(entry.error.as_deref(), Some("cloud_agent_command_pending_retry"));
    assert_eq!(entry.text.as_deref(), Some("run the tests"));

    let synced = fixture.client.outbox_sync(ORG, WS).unwrap();
    assert_eq!(synced.len(), 1);
    assert_eq!(synced[0].state, "queued");
    assert_eq!(synced[0].wake.as_deref(), Some("queued"));
    let received = received.lock().unwrap();
    assert_eq!(received.len(), 2);
    assert_eq!(received[0], received[1], "the resend is the same envelope, same iv and ciphertext");
    let envelope = &received[0];
    assert_eq!(envelope["clientCommandId"], json!(entry.client_command_id));
    assert!(uuid::Uuid::parse_str(&entry.client_command_id).is_ok());
    assert_eq!(entry.client_command_id, entry.client_command_id.to_lowercase());
    let aad = crypto::command_aad(ORG, WS, "tab-1", &entry.client_command_id, "send", KEY_ID);
    let plaintext = crypto::open(&key(), envelope["iv"].as_str().unwrap(), envelope["ciphertext"].as_str().unwrap(), &aad).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&plaintext).unwrap(), json!({ "v": 1, "text": "run the tests", "model": "opus" }));
    // Nothing secret in the stored view.
    let view = serde_json::to_value(&synced[0]).unwrap();
    assert!(view.get("ciphertext").is_none() && view.get("iv").is_none());
}

#[test]
fn an_unsent_command_survives_a_restart_of_the_client() {
    let base = serve(Arc::new(|_, _, _| None));
    let fixture = fixture(&base);
    give_key(&fixture);
    fixture.client.enqueue(ORG, WS, "tab-1", "stop", json!({})).unwrap();
    let reopened = CloudAgentClient::with(fixture.account.clone(), fixture.keys.clone(), Url::parse(&base).unwrap(), fixture._dir.path().join("cloud-agent"));
    let outbox = reopened.outbox(ORG, WS, Some("tab-1")).unwrap();
    assert_eq!(outbox.len(), 1);
    assert_eq!(outbox[0].state, "unsent");
}

#[test]
fn a_conflict_or_refusal_settles_the_command_as_rejected() {
    let base = serve(Arc::new(|_, _, _| Some((409, json!({ "error": "cloud_workspace_agent_command_conflict" })))));
    let fixture = fixture(&base);
    give_key(&fixture);
    let entry = fixture.client.enqueue(ORG, WS, "tab-1", "steer", json!({ "text": "focus on the parser" })).unwrap();
    assert_eq!(entry.state, "rejected");
    assert_eq!(entry.category.as_deref(), Some("cloud_workspace_agent_command_conflict"));
    // A settled command is not resent.
    let synced = fixture.client.outbox_sync(ORG, WS).unwrap();
    assert_eq!(synced[0].state, "rejected");
}

#[test]
fn a_rate_limit_keeps_the_command_for_a_resend_but_a_full_mailbox_is_final() {
    let full = Arc::new(Mutex::new(false));
    let seen = full.clone();
    let base = serve(Arc::new(move |_, _, _| {
        let error = if *seen.lock().unwrap() { "cloud_workspace_agent_mailbox_full" } else { "rate_limited" };
        Some((429, json!({ "error": error })))
    }));
    let fixture = fixture(&base);
    give_key(&fixture);
    let limited = fixture.client.enqueue(ORG, WS, "tab-1", "send", json!({ "text": "one" })).unwrap();
    assert_eq!(limited.state, "unsent", "a rate limit is not a refusal");
    for status in [408u16, 425, 401, 503] {
        assert!(retryable(status, "x"), "{status}");
    }
    assert!(!retryable(422, "cloud_workspace_request_invalid"));
    assert!(!retryable(409, "cloud_workspace_agent_command_conflict"));
    *full.lock().unwrap() = true;
    let refused = fixture.client.enqueue(ORG, WS, "tab-1", "send", json!({ "text": "two" })).unwrap();
    assert_eq!((refused.state.as_str(), refused.category.as_deref()), ("rejected", Some("cloud_workspace_agent_mailbox_full")));
}

#[test]
fn a_command_cancelled_before_the_api_has_it_is_never_posted_afterwards() {
    let posts = Arc::new(AtomicUsize::new(0));
    let counted = posts.clone();
    let base = serve(Arc::new(move |_, path, _| {
        if path.ends_with("/cancel") {
            return Some((404, json!({ "error": "cloud_workspace_agent_command_not_found" })));
        }
        if path.ends_with("/agent-commands") {
            counted.fetch_add(1, Ordering::SeqCst);
            // The first POST never gets an answer.
            return None;
        }
        Some((200, json!({ "commands": [] })))
    }));
    let fixture = fixture(&base);
    give_key(&fixture);
    let entry = fixture.client.enqueue(ORG, WS, "tab-1", "send", json!({ "text": "hi" })).unwrap();
    assert_eq!(entry.state, "unsent");
    assert_eq!(fixture.client.cancel(ORG, WS, &entry.client_command_id).unwrap().state, "cancelled");
    // A resend that took its snapshot before the cancel re-checks under the send lock.
    let dir = fixture.client.dir(&fixture.account.context_in(ORG).unwrap(), WS).unwrap();
    assert!(fixture.client.post_envelope(&fixture.account.context_in(ORG).unwrap(), WS, &dir, &entry.client_command_id).unwrap().is_none());
    fixture.client.outbox_sync(ORG, WS).unwrap();
    assert_eq!(posts.load(Ordering::SeqCst), 1, "only the original POST, never one after the cancel");
}

#[test]
fn invalid_commands_are_refused_before_anything_is_stored() {
    let fixture = fixture(&serve(Arc::new(|_, _, _| None)));
    give_key(&fixture);
    for (kind, payload) in [
        ("send", json!({ "text": "  " })),
        ("permission-decision", json!({ "optionId": "allow" })),
        ("permission-decision", json!({ "requestId": "r1" })),
        ("delete-everything", json!({})),
        ("send", json!("hi")),
    ] {
        assert_eq!(fixture.client.enqueue(ORG, WS, "tab-1", kind, payload).unwrap_err(), "cloud_agent_request_invalid");
    }
    assert_eq!(fixture.client.enqueue(ORG, WS, "../tab", "stop", json!({})).unwrap_err(), "cloud_agent_request_invalid");
    let big = "x".repeat(70 * 1024);
    assert_eq!(fixture.client.enqueue(ORG, WS, "tab-1", "send", json!({ "text": big })).unwrap_err(), "cloud_agent_command_too_large");
    assert!(fixture.client.outbox(ORG, WS, None).unwrap().is_empty());
}

#[test]
fn status_polling_settles_commands_and_decrypts_their_receipts() {
    let commands: Arc<Mutex<Vec<Value>>> = Arc::default();
    let stored = commands.clone();
    let base = serve(Arc::new(move |method, path, body| {
        if path == commands_path() {
            stored.lock().unwrap().push(body.clone());
            return Some((202, json!({ "command": command_json(&body, "queued"), "existing": false, "wake": "not-needed" })));
        }
        assert_eq!((method, path), ("POST", format!("{}/status", commands_path()).as_str()));
        let ids = body["clientCommandIds"].as_array().unwrap().clone();
        let settled: Vec<Value> = stored
            .lock()
            .unwrap()
            .iter()
            .filter(|envelope| ids.contains(&envelope["clientCommandId"]))
            .map(|envelope| {
                let id = envelope["clientCommandId"].as_str().unwrap();
                let aad = crypto::receipt_aad(ORG, WS, id, "applied", KEY_ID);
                let (iv, ciphertext) = crypto::seal(&key(), br#"{"v":1,"outcome":"applied","queued":true}"#, &aad).unwrap();
                let mut command = command_json(envelope, "applied");
                command["resultIv"] = json!(iv);
                command["resultCiphertext"] = json!(ciphertext);
                command
            })
            .collect();
        Some((200, json!({ "commands": settled })))
    }));
    let fixture = fixture(&base);
    give_key(&fixture);
    let entry = fixture.client.enqueue(ORG, WS, "tab-1", "permission-decision", json!({ "requestId": "perm-7", "optionId": "allow" })).unwrap();
    assert_eq!(entry.state, "queued");
    assert_eq!(entry.request_id.as_deref(), Some("perm-7"));
    let synced = fixture.client.outbox_sync(ORG, WS).unwrap();
    assert_eq!(synced[0].state, "applied");
    assert_eq!(synced[0].outcome.as_deref(), Some("applied"));
    assert_eq!(synced[0].receipt.as_ref().unwrap()["queued"], json!(true));
}

fn checkpoint_for(tab_id: &str, sealed_for_tab: &str, epoch: u64, version: u64) -> Value {
    let projection = json!({ "v": 1, "tabId": tab_id, "events": [{ "seq": 1 }], "status": "idle" });
    let packed = crypto::gzip(projection.to_string().as_bytes()).unwrap();
    let iv = crypto::random_bytes::<12>();
    let aad = crypto::checkpoint_aad(ORG, WS, sealed_for_tab, epoch, version, 1, KEY_ID);
    let ciphertext = crypto::seal_raw(&key(), &iv, &packed, &aad).unwrap();
    json!({ "tabId": tab_id, "epoch": epoch, "version": version, "schemaVersion": 1, "keyId": KEY_ID,
            "iv": crypto::b64(&iv), "ciphertext": crypto::b64(&ciphertext), "sha256": crypto::sha256_hex(&ciphertext) })
}

#[test]
fn checkpoints_are_verified_decrypted_and_only_taken_when_newer() {
    let base = serve(Arc::new(|method, path, _| {
        assert_eq!(method, "GET");
        let prefix = format!("/v1/desktop/orgs/{ORG}/cloud-workspaces/{WS}/transcript-checkpoints");
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        let tab = path.strip_prefix(&format!("{prefix}/"));
        Some(match tab {
            None => (200, json!({ "checkpoints": [{ "tabId": "tab-1", "epoch": 3, "version": 9 }] })),
            Some("tab-1") if query.contains("afterVersion=9") => (200, json!({ "checkpoint": null })),
            // A server that ignores `after` is still not believed.
            Some("tab-1") => (200, json!({ "checkpoint": checkpoint_for("tab-1", "tab-1", 3, 9) })),
            Some("tab-hash") => {
                let mut checkpoint = checkpoint_for("tab-hash", "tab-hash", 1, 1);
                checkpoint["sha256"] = json!("00".repeat(32));
                (200, json!({ "checkpoint": checkpoint }))
            }
            // Sealed for another tab and moved here by the server: refused.
            Some("tab-moved") => (200, json!({ "checkpoint": checkpoint_for("tab-moved", "tab-other", 1, 1) })),
            Some(_) => (404, json!({ "error": "cloud_workspace_transcript_checkpoint_not_found" })),
        })
    }));
    let fixture = fixture(&base);
    assert_eq!(fixture.client.checkpoint(ORG, WS, "tab-1", None).unwrap_err(), "cloud_agent_key_missing");
    give_key(&fixture);
    assert_eq!(fixture.client.checkpoints(ORG, WS).unwrap().len(), 1);
    let checkpoint = fixture.client.checkpoint(ORG, WS, "tab-1", None).unwrap().unwrap();
    assert_eq!((checkpoint.epoch, checkpoint.version), (3, 9));
    assert_eq!(checkpoint.projection["events"][0]["seq"], json!(1));
    assert_eq!(fixture.client.checkpoint(ORG, WS, "tab-1", Some((3, 9))).unwrap(), None);
    assert_eq!(fixture.client.checkpoint(ORG, WS, "tab-1", Some((3, 10))).unwrap(), None, "older than the cache");
    assert_eq!(fixture.client.checkpoint(ORG, WS, "tab-1", Some((2, 50))).unwrap().unwrap().version, 9);
    assert_eq!(fixture.client.checkpoint(ORG, WS, "tab-hash", None).unwrap_err(), "cloud_agent_checkpoint_hash_mismatch");
    assert_eq!(fixture.client.checkpoint(ORG, WS, "tab-moved", None).unwrap_err(), "cloud_agent_checkpoint_decrypt_failed");
    assert_eq!(fixture.client.checkpoint(ORG, WS, "tab-none", None).unwrap(), None);
}

#[test]
fn cancel_before_the_api_has_it_settles_locally() {
    let base = serve(Arc::new(|_, path, _| {
        if path.ends_with("/cancel") {
            return Some((404, json!({ "error": "cloud_workspace_agent_command_not_found" })));
        }
        None
    }));
    let fixture = fixture(&base);
    give_key(&fixture);
    let entry = fixture.client.enqueue(ORG, WS, "tab-1", "send", json!({ "text": "hi" })).unwrap();
    let cancelled = fixture.client.cancel(ORG, WS, &entry.client_command_id).unwrap();
    assert_eq!(cancelled.state, "cancelled");
    // A settled command is never resent.
    assert_eq!(fixture.client.outbox_sync(ORG, WS).unwrap()[0].state, "cancelled");
}

#[test]
fn the_cache_round_trips_and_is_bounded() {
    let fixture = fixture(&serve(Arc::new(|_, _, _| None)));
    fixture.client.cache_save(ORG, WS, "tab-1", Some(json!({ "events": [1, 2], "unread": true }))).unwrap();
    fixture.client.cache_save(ORG, WS, "tab-2", Some(json!({ "events": [] }))).unwrap();
    let loaded = fixture.client.cache_load(ORG, WS).unwrap();
    assert_eq!(loaded["tabs"]["tab-1"]["unread"], json!(true));
    fixture.client.cache_save(ORG, WS, "tab-2", None).unwrap();
    assert!(fixture.client.cache_load(ORG, WS).unwrap()["tabs"].get("tab-2").is_none());
    let huge = json!({ "blob": "x".repeat(CACHE_ENTRY_LIMIT) });
    assert_eq!(fixture.client.cache_save(ORG, WS, "tab-1", Some(huge)).unwrap_err(), "cloud_agent_cache_too_large");
}

#[test]
fn keys_are_replaced_by_what_the_runtime_lists_and_must_name_the_current_one() {
    let fixture = fixture(&serve(Arc::new(|_, _, _| None)));
    give_key(&fixture);
    let invalid = fixture.client.store_keys(USER, ORG, WS, &json!({ "currentKeyId": "key-other", "keys": [{ "keyId": KEY_ID, "key": crypto::b64(&key()) }] }));
    assert!(invalid.is_err());
    let newer = "key-bbbbbbbbbbbbbbbbbbbbbb";
    fixture.client.store_keys(USER, ORG, WS, &json!({ "currentKeyId": newer, "keys": [{ "keyId": newer, "key": crypto::b64(&[9u8; 32]) }] })).unwrap();
    assert!(fixture.keys.get(ORG, WS, KEY_ID).unwrap().is_none(), "a key the runtime no longer lists is forgotten");
    assert!(fixture.keys.get(ORG, WS, newer).unwrap().is_some());
    // Keys for an identity that is no longer signed in are refused.
    assert!(fixture.client.store_keys("user_2", ORG, WS, &json!({ "keys": [] })).is_err());
}

#[test]
fn an_identity_change_drops_the_previous_identitys_keys_outbox_and_cache() {
    let fixture = fixture(&serve(Arc::new(|_, _, _| None)));
    fixture.client.observe_identity(kept(&[ORG]));
    give_key(&fixture);
    fixture.client.enqueue(ORG, WS, "tab-1", "stop", json!({})).unwrap();
    fixture.client.cache_save(ORG, WS, "tab-1", Some(json!({}))).unwrap();
    // Unchanged or not yet loaded: nothing is dropped.
    fixture.client.observe_identity(kept(&[ORG]));
    assert!(fixture.keys.get(ORG, WS, KEY_ID).unwrap().is_some());

    fixture.client.observe_identity(kept(&["org_2"]));
    assert!(fixture.keys.get(ORG, WS, KEY_ID).unwrap().is_none());
    assert!(!fixture._dir.path().join("cloud-agent").join(USER).join(ORG).exists());
    assert!(fixture.client.outbox(ORG, WS, None).unwrap().is_empty());
}

const ORG_2: &str = "org_2";

/// Keys, one unsent command and a cached transcript in `org`.
fn fill(fixture: &Fixture, org: &str) {
    fixture
        .client
        .store_keys(USER, org, WS, &json!({ "currentKeyId": KEY_ID, "keys": [{ "keyId": KEY_ID, "key": crypto::b64(&key()), "createdAt": 1 }] }))
        .unwrap();
    fixture.client.enqueue(org, WS, "tab-1", "stop", json!({})).unwrap();
    fixture.client.cache_save(org, WS, "tab-1", Some(json!({ "seen": org }))).unwrap();
}

fn kept_everything(fixture: &Fixture, org: &str) -> bool {
    fixture.keys.get(org, WS, KEY_ID).unwrap().is_some()
        && fixture.client.outbox(org, WS, None).unwrap().iter().filter(|entry| !TERMINAL_STATES.contains(&entry.state.as_str())).count() == 1
        && fixture.client.cache_load(org, WS).unwrap()["tabs"].get("tab-1").is_some()
}

#[test]
fn a_member_organization_is_reachable_without_being_the_active_one() {
    let fixture = fixture(&serve(Arc::new(|_, _, _| None)));
    // An older server: only the active Organization.
    assert_eq!(fixture.client.outbox(ORG_2, WS, None).unwrap_err(), "cloud_remote_organization_mismatch");
    // CS-18: by membership.
    fixture.account.1.lock().unwrap().push(ORG_2.into());
    assert!(fixture.client.outbox(ORG_2, WS, None).unwrap().is_empty());
    assert_eq!(fixture.client.outbox("org_other", WS, None).unwrap_err(), "cloud_remote_organization_mismatch");
}

#[test]
fn changing_the_default_organization_keeps_both_organizations_cache_keys_and_unsent_outbox() {
    let fixture = fixture(&serve(Arc::new(|_, _, _| None)));
    fixture.account.1.lock().unwrap().push(ORG_2.into());
    fixture.client.observe_identity(kept(&[ORG, ORG_2]));
    fill(&fixture, ORG);
    fill(&fixture, ORG_2);

    // Another client makes org_2 the default. Every member Organization is
    // still kept, so the observed identity is unchanged and nothing is pruned.
    *fixture.account.0.lock().unwrap() = Some((USER.into(), ORG_2.into()));
    *fixture.account.1.lock().unwrap() = vec![ORG.into()];
    fixture.client.observe_identity(kept(&[ORG, ORG_2]));

    assert!(kept_everything(&fixture, ORG), "the previous default organization keeps its keys, outbox and cache");
    assert!(kept_everything(&fixture, ORG_2), "the new default organization keeps its keys, outbox and cache");
}

#[test]
fn losing_a_membership_purges_only_that_organization() {
    let fixture = fixture(&serve(Arc::new(|_, _, _| None)));
    fixture.account.1.lock().unwrap().push(ORG_2.into());
    fixture.client.observe_identity(kept(&[ORG, ORG_2]));
    fill(&fixture, ORG);
    fill(&fixture, ORG_2);

    fixture.account.1.lock().unwrap().clear();
    fixture.client.observe_identity(kept(&[ORG]));

    assert!(kept_everything(&fixture, ORG), "the organization still a member is untouched");
    assert!(fixture.keys.get(ORG_2, WS, KEY_ID).unwrap().is_none(), "the left organization's keys are deleted");
    assert!(!fixture._dir.path().join("cloud-agent").join(USER).join(ORG_2).exists(), "its outbox and cache are deleted");
    // And it can no longer be reached.
    assert_eq!(fixture.client.outbox(ORG_2, WS, None).unwrap_err(), "cloud_remote_organization_mismatch");
}

#[test]
fn settled_entries_are_pruned_to_the_newest_per_tab() {
    let entry = |id: usize, state: &str| Stored {
        client_command_id: format!("c{id}"),
        tab_id: "tab-1".into(),
        kind: "send".into(),
        key_id: KEY_ID.into(),
        iv: String::new(),
        ciphertext: String::new(),
        text: None,
        request_id: None,
        state: state.into(),
        wake: None,
        outcome: None,
        category: None,
        receipt: None,
        sequence: None,
        created_at: id as u64,
        updated_at: id as u64,
        error: None,
    };
    let mut entries: Vec<Stored> = (0..30).map(|id| entry(id, "applied")).collect();
    entries.push(entry(100, "queued"));
    prune(&mut entries);
    assert_eq!(entries.iter().filter(|entry| entry.state == "applied").count(), SETTLED_KEPT_PER_TAB);
    assert!(entries.iter().any(|entry| entry.state == "queued"), "pending entries always stay");
    assert!(entries.iter().any(|entry| entry.client_command_id == "c29") && !entries.iter().any(|entry| entry.client_command_id == "c9" && entry.state == "applied"));
}

#[test]
fn a_deleted_workspace_loses_its_outbox_cache_and_keys_and_only_its_own() {
    let fixture = fixture(&serve(Arc::new(|_, _, _| None)));
    give_key(&fixture);
    // Unsent: the API never answers.
    fixture.client.enqueue(ORG, WS, "tab-1", "send", json!({ "text": "not delivered" })).unwrap();
    fixture.client.cache_save(ORG, WS, "tab-1", Some(json!({ "events": [] }))).unwrap();
    fixture.client.cache_save(ORG, "ws_2", "tab-1", Some(json!({ "events": [] }))).unwrap();

    let purged = fixture.client.purge_workspace(ORG, WS).unwrap();
    assert_eq!(purged, Purged { removed: true, unsent_commands: 1, cached_tabs: 1 });
    assert!(fixture.keys.get(ORG, WS, KEY_ID).unwrap().is_none());
    assert!(fixture.client.outbox(ORG, WS, None).unwrap().is_empty());
    assert!(fixture.client.cache_load(ORG, WS).unwrap()["tabs"].as_object().unwrap().is_empty());
    assert!(!fixture.client.has_key(ORG, WS).unwrap());
    // Another workspace keeps its cache, and purging again is a no-op.
    assert!(fixture.client.cache_load(ORG, "ws_2").unwrap()["tabs"].get("tab-1").is_some());
    assert_eq!(fixture.client.purge_workspace(ORG, WS).unwrap(), Purged::default());
    // Only the signed-in organization's workspaces can be purged.
    assert_eq!(fixture.client.purge_workspace("org_2", WS).unwrap_err(), "cloud_remote_organization_mismatch");
}
