//! The fake mailbox API the relay end-to-end test leases from keeps the
//! server's rules (terminalx-saas contract §11.3, §12). Checked here over
//! HTTP, fast, so a drift in the fake shows up in CI and not as a
//! misleading end-to-end result.

#![cfg(unix)]

mod common;

use common::mailbox::{FakeMailbox, CREDENTIAL};
use raccoon_lib::cloud_agents::crypto;
use serde_json::{json, Value};

fn post(mailbox: &FakeMailbox, path: &str, body: Value) -> (u16, Value) {
    let request = ureq::post(&format!("{}/v1/cloud-workspace-bootstrap{path}", mailbox.origin)).set("authorization", &format!("Bearer {CREDENTIAL}"));
    match request.send_json(body) {
        Ok(response) => (response.status(), response.into_json().unwrap()),
        Err(ureq::Error::Status(status, response)) => (status, response.into_json().unwrap_or(Value::Null)),
        Err(error) => panic!("{error}"),
    }
}

const INCARNATION: &str = "incarnation-aaaaaaaaaaaa";

#[test]
fn lanes_leases_redelivery_and_acks_follow_the_contract() {
    let mailbox = FakeMailbox::start(7);
    let key = crypto::random_bytes::<32>();
    let first = mailbox.enqueue("k1", &key, "tab-a", "send", json!({"v": 1, "text": "one"}), "manage");
    let second = mailbox.enqueue("k1", &key, "tab-a", "send", json!({"v": 1, "text": "two"}), "manage");
    let other = mailbox.enqueue("k1", &key, "tab-b", "stop", json!({"v": 1}), "manage");

    let (status, leased) = post(&mailbox, "/agent-commands/lease", json!({"v": 1, "storageIncarnationId": INCARNATION}));
    assert_eq!(status, 200);
    let ids: Vec<&str> = leased["leases"].as_array().unwrap().iter().map(|l| l["clientCommandId"].as_str().unwrap()).collect();
    assert_eq!(ids, vec![first.as_str(), other.as_str()], "one per lane, in sequence order");
    let lease = leased["leases"][0].clone();
    assert_eq!(lease["redelivery"], false);
    assert_eq!(lease["runtimeGeneration"], 7);

    // The ciphertext is bound to its metadata and opens with the client's key.
    let aad = crypto::command_aad(common::mailbox::ORG, common::mailbox::WORKSPACE, "tab-a", &first, "send", "k1");
    let plain = crypto::open(&key, lease["iv"].as_str().unwrap(), lease["ciphertext"].as_str().unwrap(), &aad).unwrap();
    assert_eq!(serde_json::from_slice::<Value>(&plain).unwrap()["text"], "one");

    // Nothing more while the leases are live.
    let (_, again) = post(&mailbox, "/agent-commands/lease", json!({"v": 1, "storageIncarnationId": INCARNATION}));
    assert!(again["leases"].as_array().unwrap().is_empty());

    // Expired: redelivered as the same command with a new token; the old token is stale.
    mailbox.expire_leases();
    let (_, redelivered) = post(&mailbox, "/agent-commands/lease", json!({"v": 1, "storageIncarnationId": INCARNATION}));
    let again = redelivered["leases"].as_array().unwrap().iter().find(|l| l["clientCommandId"] == first).unwrap().clone();
    assert_eq!(again["redelivery"], true);
    assert_eq!(again["leaseCount"], 2);
    assert_ne!(again["leaseToken"], lease["leaseToken"]);
    let path = format!("/agent-commands/{}/ack", lease["commandId"].as_str().unwrap());
    let (status, stale) = post(&mailbox, &path, json!({"v": 1, "leaseToken": lease["leaseToken"], "outcome": "applied"}));
    assert_eq!((status, stale["code"].as_str()), (409, Some("stale-lease")));

    // The current token settles it; a repeat of the same ack is answered the same.
    let ack = json!({"v": 1, "leaseToken": again["leaseToken"], "outcome": "applied"});
    assert_eq!(post(&mailbox, &path, ack.clone()).0, 200);
    assert_eq!(post(&mailbox, &path, ack).0, 200);
    assert_eq!(mailbox.command(&first).state, "applied");

    // The lane moves on only now.
    let (_, next) = post(&mailbox, "/agent-commands/lease", json!({"v": 1, "storageIncarnationId": INCARNATION}));
    assert!(next["leases"].as_array().unwrap().iter().any(|l| l["clientCommandId"] == second));

    // A new generation: an ack of the old generation's lease is stale-generation.
    let second_lease = next["leases"].as_array().unwrap().iter().find(|l| l["clientCommandId"] == second).unwrap().clone();
    mailbox.state.lock().unwrap().generation = 8;
    let path = format!("/agent-commands/{}/ack", second_lease["commandId"].as_str().unwrap());
    let (status, stale) = post(&mailbox, &path, json!({"v": 1, "leaseToken": second_lease["leaseToken"], "outcome": "applied"}));
    assert_eq!((status, stale["code"].as_str()), (409, Some("stale-generation")));

    // Another receipt store: what it held leased is settled outcome-unknown, never redelivered.
    let (_, replaced) = post(&mailbox, "/agent-commands/lease", json!({"v": 1, "storageIncarnationId": "incarnation-bbbbbbbbbbbb"}));
    let unknown: Vec<&str> = replaced["outcomeUnknown"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(unknown.contains(&second.as_str()) && unknown.contains(&other.as_str()), "{replaced}");
    assert_eq!(mailbox.command(&second).category.as_deref(), Some("runtime-storage-replaced"));
    assert!(replaced["leases"].as_array().unwrap().is_empty());

    // A wrong credential is refused.
    let status = match ureq::post(&format!("{}/v1/cloud-workspace-bootstrap/agent-commands/lease", mailbox.origin)).send_json(json!({"v": 1})) {
        Err(ureq::Error::Status(status, _)) => status,
        other => panic!("{other:?}"),
    };
    assert_eq!(status, 401);
}

#[test]
fn checkpoints_are_monotonic_per_tab() {
    let mailbox = FakeMailbox::start(1);
    let put = |epoch: u64, version: u64, bytes: &[u8]| {
        let body = json!({"v": 1, "epoch": epoch, "version": version, "schemaVersion": 1, "keyId": "k1",
            "iv": crypto::b64(&[0u8; 12]), "ciphertext": crypto::b64(bytes), "sha256": crypto::sha256_hex(bytes)});
        match ureq::put(&format!("{}/v1/cloud-workspace-bootstrap/transcript-checkpoints/tab-a", mailbox.origin))
            .set("authorization", &format!("Bearer {CREDENTIAL}"))
            .send_json(body)
        {
            Ok(response) => (200, response.into_json::<Value>().unwrap()),
            Err(ureq::Error::Status(status, response)) => (status, response.into_json().unwrap_or(Value::Null)),
            Err(error) => panic!("{error}"),
        }
    };
    assert_eq!(put(1, 1, b"one").1["duplicate"], false);
    assert_eq!(put(1, 1, b"one").1["duplicate"], true);
    assert_eq!(put(1, 1, b"other").1["error"], "cloud_workspace_checkpoint_conflict");
    assert_eq!(put(1, 2, b"two").0, 200);
    assert_eq!(put(1, 1, b"old").1["error"], "cloud_workspace_checkpoint_stale");
    assert_eq!(put(2, 0, b"new epoch").0, 200);
    let stored = mailbox.state.lock().unwrap().checkpoints["tab-a"].clone();
    assert_eq!(stored.iter().map(|c| (c.epoch, c.version)).collect::<Vec<_>>(), vec![(1, 2), (2, 0)], "the two newest are kept");
}
