//! `machines::account` against a local fake of the account API: a loopback
//! HTTP server that keeps its state in memory and seals offers as a machine
//! host does.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use hpke::{aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, Deserializable, OpModeS, Serializable};
use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};
use serde_json::{json, Value};

use super::*;
use crate::keychain::testing::MemorySecrets;
use crate::machine_wire::{MachineIdentity, MachineOs};
use crate::machines::secrets::MachineSecrets;
use crate::machines::store::{MachineRoute, MachineStore, PairedMachine};

// ---------------------------------------------------------------- the fake account API

#[derive(Clone, Debug)]
struct Recorded {
    method: String,
    path: String,
    authorization: String,
    body: Option<Value>,
}

type Responder = dyn Fn(&Recorded) -> (u16, Value) + Send + Sync;

struct FakeAccount {
    base: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
    stopped: Arc<AtomicBool>,
}

impl FakeAccount {
    fn start(respond: impl Fn(&Recorded) -> (u16, Value) + Send + Sync + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stopped = Arc::new(AtomicBool::new(false));
        let respond: Arc<Responder> = Arc::new(respond);
        let (log, stop) = (requests.clone(), stopped.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(stream) = stream else { continue };
                let (log, respond) = (log.clone(), respond.clone());
                std::thread::spawn(move || serve(stream, &log, &*respond));
            }
        });
        Self { base, requests, stopped }
    }

    fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }

    fn find(&self, method: &str, path_contains: &str) -> Vec<Recorded> {
        self.requests().into_iter().filter(|request| request.method == method && request.path.contains(path_contains)).collect()
    }
}

impl Drop for FakeAccount {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(self.base.trim_start_matches("http://"));
    }
}

fn serve(stream: TcpStream, requests: &Mutex<Vec<Recorded>>, respond: &Responder) {
    stream.set_read_timeout(Some(Duration::from_secs(30))).unwrap();
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let mut parts = line.split_whitespace();
        let (method, path) = (parts.next().unwrap_or_default().to_string(), parts.next().unwrap_or_default().to_string());
        let (mut length, mut authorization) = (0, String::new());
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header).unwrap_or(0) == 0 {
                return;
            }
            if header == "\r\n" {
                break;
            }
            let lower = header.to_lowercase();
            if let Some(value) = lower.strip_prefix("content-length:") {
                length = value.trim().parse::<usize>().unwrap();
            }
            if lower.starts_with("authorization:") {
                authorization = header["authorization:".len()..].trim().to_string();
            }
        }
        let mut payload = vec![0; length];
        reader.read_exact(&mut payload).unwrap();
        let request = Recorded { method, path, authorization, body: (length > 0).then(|| serde_json::from_slice(&payload).unwrap()) };
        requests.lock().unwrap().push(request.clone());
        let (status, body) = respond(&request);
        let body = body.to_string();
        if write!(writer, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{body}", body.len()).is_err() {
            return;
        }
    }
}

// ---------------------------------------------------------------- fixtures

const USER: &str = "user_synthetic_1";
const TOKEN: &str = "synthetic-access-token";
const AAD_JSON: &str = r#"{"v":1,"requestedScope":"runtime"}"#;

fn context() -> AccountContext {
    AccountContext {
        access_token: TOKEN.into(),
        user_id: USER.into(),
        email: "fixture@example.invalid".into(),
        display_name: "Fixture".into(),
        profile_id: "synthetic-profile".into(),
        organization_id: "synthetic-org".into(),
        relay_entitled: true,
        generation: 1,
    }
}

/// A machine's host key: 32 bytes, its id and its standard base64.
struct HostKey {
    bytes: [u8; 32],
    id: String,
    b64: String,
}

fn host_key(seed: u8) -> HostKey {
    let bytes = [seed; 32];
    HostKey { bytes, id: crate::relay_e2ee::host_id_of(&bytes), b64: STANDARD.encode(bytes) }
}

fn host(key: &HostKey, name: &str, capabilities: &[&str], reachability: &str, last_seen: Option<&str>) -> Value {
    json!({
        "hostId": key.id,
        "hostPublicKeyB64": key.b64,
        "bindingGeneration": 3,
        "displayName": name,
        "platform": "macos",
        "environmentKind": "native",
        "capabilities": capabilities,
        "state": "active",
        "reachability": reachability,
        "lastSeenAt": last_seen,
    })
}

const BOTH: &[&str] = &[PAIRING_CAPABILITY, OPERATING_CAPABILITY];

/// The machine's offer: a `txm2.` code's JSON for `key`.
fn offer_bytes(key: &HostKey, machine_id: &str) -> Vec<u8> {
    let identity = MachineIdentity { machine_id: machine_id.into(), name: "Mac mini".into(), os: MachineOs { family: "macos".into(), version: Some("26.1".into()) }, version: "0.2.33".into() };
    let code = MachineCode::new(URL_SAFE_NO_PAD.encode([7u8; 32]), key.b64.clone(), identity, vec!["ws://192.168.1.20:6768/machine/1".into()], 4_102_444_800_000);
    serde_json::to_vec(&code).unwrap()
}

/// Seal `plaintext` line for line as `pairing::crypto::seal_account_offer`
/// does (that module is private to `pairing`), to the grant's one-request
/// key, with the grant's associated data.
fn seal(recipient_b64url: &str, associated_data: &str, plaintext: &[u8]) -> Value {
    type Kem = X25519HkdfSha256;
    let public = <Kem as hpke::Kem>::PublicKey::from_bytes(&URL_SAFE_NO_PAD.decode(recipient_b64url).unwrap()).unwrap();
    let (encapped, mut sender) = hpke::setup_sender::<ChaCha20Poly1305, HkdfSha256, Kem>(&OpModeS::Base, &public, b"").unwrap();
    let ciphertext = sender.seal(plaintext, &URL_SAFE_NO_PAD.decode(associated_data).unwrap()).unwrap();
    json!({ "version": 1, "algorithm": HPKE_ALGORITHM, "encapsulatedKey": URL_SAFE_NO_PAD.encode(encapped.to_bytes()), "ciphertext": URL_SAFE_NO_PAD.encode(ciphertext) })
}

struct Rig {
    pairing: Arc<AccountPairing>,
    store_dir: tempfile::TempDir,
    _home: crate::store::TempHome,
}

fn rig(base: &str, signed_in: bool, this_mac: Vec<String>) -> Rig {
    let home = crate::store::temp_home();
    let store_dir = tempfile::tempdir().unwrap();
    let machines = Arc::new(Machines::for_test(MachineSecrets::with_store(Arc::new(MemorySecrets::default())), store_dir.path().to_path_buf(), Duration::from_secs(1)));
    machines.secrets.configure("ai.terminalx.test").unwrap();
    let pairing = AccountPairing::for_test(machines, signed_in.then(context), this_mac, base.into(), Duration::from_secs(10), Duration::from_millis(20));
    Rig { pairing: Arc::new(pairing), store_dir, _home: home }
}

fn trusted() -> (u16, Value) {
    (200, json!({ "installation": { "clientInstallationId": "x", "trustState": "trusted", "generation": 1 }, "reauthenticationRequired": false }))
}

/// The registration's P-256 key, from the recorded PUT, as ring verifies with it.
fn registered_key(account: &FakeAccount) -> Vec<u8> {
    let put = account.find("PUT", "/v1/account/client-installations/").pop().expect("a registration");
    let jwk = &put.body.as_ref().unwrap()["publicKeyJwk"];
    let mut point = vec![4u8];
    point.extend(URL_SAFE_NO_PAD.decode(jwk["x"].as_str().unwrap()).unwrap());
    point.extend(URL_SAFE_NO_PAD.decode(jwk["y"].as_str().unwrap()).unwrap());
    point
}

/// A fake that grants every request: the first poll still pending, the next
/// granted with `offer(request body)` sealed to its key.
fn granting_account(hosts: Value, offer: impl Fn(&Value) -> Vec<u8> + Send + Sync + 'static) -> FakeAccount {
    let request: Arc<Mutex<Option<Value>>> = Arc::default();
    let polls = Arc::new(Mutex::new(0));
    FakeAccount::start(move |recorded| {
        let aad = URL_SAFE_NO_PAD.encode(AAD_JSON);
        let grant = |body: &Value, state: &str, envelope: Option<Value>| {
            let mut grant = json!({
                "userId": body["userId"],
                "hostId": body["hostId"],
                "clientInstallationId": body["clientInstallationId"],
                "grantRequestId": body["grantRequestId"],
                "bindingGeneration": body["bindingGeneration"],
                "installationGeneration": 1,
                "requestedScope": body["requestedScope"],
                "associatedDataVersion": 1,
                "associatedData": aad,
                "state": state,
                "expiresAt": "2099-01-01T00:00:00.000Z",
            });
            if let Some(envelope) = envelope {
                grant["envelope"] = envelope;
            }
            json!({ "grant": grant })
        };
        match (recorded.method.as_str(), recorded.path.as_str()) {
            ("PUT", path) if path.starts_with("/v1/account/client-installations/") => trusted(),
            ("GET", "/v1/account/hosts") => (200, hosts.clone()),
            ("POST", "/v1/account/pairing-grant-requests") => {
                let body = recorded.body.clone().unwrap();
                *request.lock().unwrap() = Some(body.clone());
                (201, grant(&body, "pending", None))
            }
            ("GET", path) if path.starts_with("/v1/account/pairing-grant-requests/") => {
                let body = request.lock().unwrap().clone().unwrap();
                let mut polls = polls.lock().unwrap();
                *polls += 1;
                if *polls == 1 {
                    return (200, grant(&body, "pending", None));
                }
                let envelope = seal(body["clientEphemeralPublicKey"].as_str().unwrap(), &aad, &offer(&body));
                (200, grant(&body, "granted", Some(envelope)))
            }
            ("POST", path) if path.ends_with("/consume") || path.ends_with("/revoke") => (200, json!({ "ok": true })),
            _ => (404, json!({ "error": "not_found" })),
        }
    })
}

// ---------------------------------------------------------------- the directory

#[test]
fn the_directory_maps_online_offline_not_available_this_mac_and_paired() {
    let (online, offline, off, mine) = (host_key(1), host_key(2), host_key(3), host_key(4));
    let hosts = json!({ "hosts": [
        host(&online, "Mac mini", BOTH, "live", Some("2026-11-16T10:00:00.000Z")),
        host(&offline, "Build box", BOTH, "unverifiable", Some("2026-11-15T08:30:00.000Z")),
        host(&off, "Studio", &[PAIRING_CAPABILITY], "live", None),
        host(&mine, "This Mac", BOTH, "live", None),
        host(&host_key(5), "Phone-paired server", &[crate::machine_account::directory::PHONE_PAIRING_CAPABILITY], "live", None),
    ]});
    let account = FakeAccount::start(move |recorded| match recorded.path.as_str() {
        path if path.starts_with("/v1/account/client-installations/") => trusted(),
        "/v1/account/hosts" => (200, hosts.clone()),
        _ => (404, json!({})),
    });
    let rig = rig(&account.base, true, vec![mine.id.clone()]);
    MachineStore::in_dir(rig.store_dir.path())
        .put(PairedMachine {
            machine_id: online.id.clone(),
            name: "Mac mini".into(),
            os: MachineOs { family: "macos".into(), version: None },
            version: "0.2.33".into(),
            public_key_b64: online.b64.clone(),
            direct_endpoints: Vec::new(),
            route: MachineRoute::RelayAndNearby,
            paired_at: 1,
            last_seen_at: None,
            last_route: None,
            relay: None,
            named_here: false,
            other: Default::default(),
        })
        .unwrap();

    let directory = serde_json::to_value(rig.pairing.list().unwrap()).unwrap();
    let machine = |id: &str| directory["machines"].as_array().unwrap().iter().find(|machine| machine["machineId"] == id).unwrap().clone();
    assert_eq!(directory["signedIn"], true);
    assert_eq!(directory["installation"], "ready");
    assert_eq!(directory["machines"].as_array().unwrap().len(), 4);
    assert_eq!(
        machine(&online.id),
        json!({
            "hostId": online.id, "machineId": online.id, "name": "Mac mini", "platform": "macos", "environmentKind": "native",
            "availability": "online", "lastSeenAt": 1_794_823_200_000i64, "thisMac": false, "paired": true,
        })
    );
    assert_eq!(machine(&offline.id)["availability"], "offline");
    assert_eq!(machine(&offline.id)["lastSeenAt"], 1_794_731_400_000i64);
    assert_eq!(machine(&offline.id)["paired"], false);
    assert_eq!(machine(&off.id)["availability"], "notAvailable");
    assert_eq!(machine(&off.id)["lastSeenAt"], Value::Null);
    assert_eq!(machine(&mine.id)["thisMac"], true);
    assert_eq!(machine(&mine.id)["availability"], "online");

    // The installation registered with both capabilities, signed as the server checks it.
    let put = account.find("PUT", "/v1/account/client-installations/").pop().unwrap();
    assert_eq!(put.authorization, format!("Bearer {TOKEN}"));
    let body = put.body.unwrap();
    assert_eq!(body["capabilities"], json!([PAIRING_CAPABILITY, OPERATING_CAPABILITY]));
    assert_eq!(body["platform"], std::env::consts::OS);
    assert_eq!(body["userId"], USER);
    let installation_id = put.path.trim_start_matches("/v1/account/client-installations/").to_string();
    let jwk = &body["publicKeyJwk"];
    let thumbprint = URL_SAFE_NO_PAD.encode(Sha256::digest(format!(r#"{{"crv":"P-256","kty":"EC","x":"{}","y":"{}"}}"#, jwk["x"].as_str().unwrap(), jwk["y"].as_str().unwrap())));
    let transcript = [
        "terminalx-client-installation-registration/v1",
        USER,
        &installation_id,
        &thumbprint,
        body["deviceLabel"].as_str().unwrap(),
        std::env::consts::OS,
        "account-bound-host-pairing.v1,machine-operating.v1",
        body["proofNonce"].as_str().unwrap(),
    ]
    .join("\n");
    let signature = URL_SAFE_NO_PAD.decode(body["proofSignature"].as_str().unwrap()).unwrap();
    assert_eq!(signature.len(), 64, "IEEE-P1363, 86 base64url characters");
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, registered_key(&account)).verify(transcript.as_bytes(), &signature).expect("the registration verifies");

    // The installation is kept: a second listing registers the same one.
    rig.pairing.list().unwrap();
    let puts = account.find("PUT", "/v1/account/client-installations/");
    assert_eq!(puts.len(), 2);
    assert_eq!(puts[0].path, puts[1].path);
    assert_eq!(puts[0].body.as_ref().unwrap()["publicKeyJwk"], puts[1].body.as_ref().unwrap()["publicKeyJwk"]);
}

#[test]
fn signed_out_and_untrusted_installations_list_no_machines() {
    let rig_out = rig("http://127.0.0.1:9", false, Vec::new());
    assert_eq!(serde_json::to_value(rig_out.pairing.list().unwrap()).unwrap(), json!({ "signedIn": false }));
    assert!(rig_out.pairing.request("abc").unwrap_err().starts_with("not_signed_in:"));
    drop(rig_out);

    let account = FakeAccount::start(|recorded| match recorded.path.as_str() {
        path if path.starts_with("/v1/account/client-installations/") => {
            (200, json!({ "installation": { "clientInstallationId": "x", "trustState": "pending", "generation": 1 }, "reauthenticationRequired": true }))
        }
        _ => (500, json!({})),
    });
    let rig = rig(&account.base, true, Vec::new());
    assert_eq!(serde_json::to_value(rig.pairing.list().unwrap()).unwrap(), json!({ "signedIn": true, "installation": "reauthenticationRequired", "machines": [] }));
    assert!(account.find("GET", "/v1/account/hosts").is_empty(), "no directory for an untrusted installation");
}

// ---------------------------------------------------------------- the grant

#[test]
fn a_runtime_grant_is_signed_opened_and_answered_as_a_txm2_code_then_consumed() {
    let machine = host_key(9);
    let hosts = json!({ "hosts": [host(&machine, "Mac mini", BOTH, "live", None)] });
    let (offered_key, offered_id) = (host_key(9), machine.id.clone());
    let account = granting_account(hosts, move |_| offer_bytes(&offered_key, &offered_id));
    let rig = rig(&account.base, true, Vec::new());

    let offer = rig.pairing.request(&machine.id).unwrap();
    assert_eq!(offer.code, format!("txm2.{}", URL_SAFE_NO_PAD.encode(offer_bytes(&machine, &machine.id))), "the offer's bytes, unchanged");
    let decoded = MachineCode::decode(&offer.code).unwrap();
    assert_eq!(decoded.machine.machine_id, machine.id);
    assert_eq!(decoded.public_key_b64, machine.b64);

    // The request: scope runtime, signed with the registered key, `runtime` the last line.
    let post = account.find("POST", "/v1/account/pairing-grant-requests").into_iter().find(|request| !request.path.contains("/consume")).unwrap();
    let body = post.body.unwrap();
    assert_eq!(body["requestedScope"], "runtime");
    assert_eq!(body["grantRequestId"], offer.grant_request_id);
    assert_eq!(body["hostId"], machine.id);
    assert_eq!(body["bindingGeneration"], 3);
    assert_eq!(URL_SAFE_NO_PAD.decode(body["clientEphemeralPublicKey"].as_str().unwrap()).unwrap().len(), 32);
    let generation = body["bindingGeneration"].to_string();
    let lines = [
        "terminalx-pairing-grant-request/v1",
        body["userId"].as_str().unwrap(),
        body["hostId"].as_str().unwrap(),
        body["clientInstallationId"].as_str().unwrap(),
        body["grantRequestId"].as_str().unwrap(),
        generation.as_str(),
        body["clientEphemeralPublicKey"].as_str().unwrap(),
        body["nonce"].as_str().unwrap(),
        "runtime",
    ];
    assert_eq!(lines.last(), Some(&"runtime"));
    let signature = URL_SAFE_NO_PAD.decode(body["proofSignature"].as_str().unwrap()).unwrap();
    let key = UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, registered_key(&account));
    key.verify(lines.join("\n").as_bytes(), &signature).expect("the grant request verifies with runtime as its last line");
    let mobile = [&lines[..8], &["mobile"]].concat().join("\n");
    assert!(key.verify(mobile.as_bytes(), &signature).is_err(), "and not as a mobile request");
    let polls = account.find("GET", &format!("/v1/account/pairing-grant-requests/{}?clientInstallationId=", offer.grant_request_id));
    assert_eq!(polls.len(), 2, "polled until granted");

    // Paired: consumed with the grant's installation and generation.
    rig.pairing.finish(&offer.grant_request_id, true).unwrap();
    let consume = account.find("POST", &format!("/{}/consume", offer.grant_request_id));
    assert_eq!(consume.len(), 1);
    assert_eq!(consume[0].body, Some(json!({ "userId": USER, "clientInstallationId": body["clientInstallationId"], "bindingGeneration": 3 })));
    assert!(account.find("POST", "/revoke").is_empty());
    assert!(rig.pairing.finish(&offer.grant_request_id, true).is_err(), "a grant finishes once");
}

#[test]
fn a_grant_not_paired_is_revoked() {
    let machine = host_key(10);
    let hosts = json!({ "hosts": [host(&machine, "Mac mini", BOTH, "live", None)] });
    let (offered_key, offered_id) = (host_key(10), machine.id.clone());
    let account = granting_account(hosts, move |_| offer_bytes(&offered_key, &offered_id));
    let rig = rig(&account.base, true, Vec::new());
    let offer = rig.pairing.request(&machine.id).unwrap();
    rig.pairing.finish(&offer.grant_request_id, false).unwrap();
    let revoke = account.find("POST", &format!("/{}/revoke", offer.grant_request_id));
    assert_eq!(revoke.len(), 1);
    let body = revoke[0].body.clone().unwrap();
    assert_eq!(body["reason"], "user-request");
    assert_eq!(body["userId"], USER);
    assert!(body["clientInstallationId"].is_string());
    assert!(account.find("POST", "/consume").is_empty());
}

#[test]
fn an_offer_for_another_key_or_machine_is_refused_as_key_mismatch_and_revoked() {
    let machine = host_key(11);
    let hosts = json!({ "hosts": [host(&machine, "Mac mini", BOTH, "live", None)] });
    let (other, machine_id) = (host_key(12), machine.id.clone());
    let account = granting_account(hosts, move |_| offer_bytes(&other, &crate::relay_e2ee::host_id_of(&other.bytes)));
    let rig = rig(&account.base, true, Vec::new());
    let refused = rig.pairing.request(&machine_id).unwrap_err();
    assert!(refused.starts_with("key_mismatch:"), "{refused}");
    assert_eq!(account.find("POST", "/revoke").len(), 1, "the grant is not left usable");

    // Directly: the right key under another machine id, and another key.
    let right = host_key(13);
    let wrong_id = offer_bytes(&right, &host_key(14).id);
    assert!(offer_code(&wrong_id, &right.bytes).unwrap_err().starts_with("key_mismatch:"));
    assert!(offer_code(&offer_bytes(&host_key(14), &host_key(14).id), &right.bytes).unwrap_err().starts_with("key_mismatch:"));
    assert!(offer_code(&offer_bytes(&right, &right.id), &right.bytes).unwrap().starts_with("txm2."));
}

#[test]
fn a_host_whose_listed_key_is_not_its_id_is_refused_as_key_mismatch() {
    let (machine, other) = (host_key(15), host_key(16));
    let mut listed = host(&machine, "Mac mini", BOTH, "live", None);
    listed["hostPublicKeyB64"] = json!(other.b64);
    let account = granting_account(json!({ "hosts": [listed] }), |_| Vec::new());
    let rig = rig(&account.base, true, Vec::new());
    assert!(rig.pairing.request(&machine.id).unwrap_err().starts_with("key_mismatch:"));
    assert!(account.find("POST", "/v1/account/pairing-grant-requests").is_empty(), "nothing is asked");
}

#[test]
fn an_envelope_sealed_as_the_machine_seals_opens_as_a_txm2_code() {
    let (recipient, public) = X25519HkdfSha256::gen_keypair();
    let aad = URL_SAFE_NO_PAD.encode(AAD_JSON);
    let machine = host_key(18);
    let bytes = offer_bytes(&machine, &machine.id);
    let envelope: Envelope = serde_json::from_value(seal(&URL_SAFE_NO_PAD.encode(public.to_bytes()), &aad, &bytes)).unwrap();
    let opened = open_envelope(&recipient, &envelope, &aad).unwrap();
    assert_eq!(opened.as_slice(), bytes.as_slice());
    assert_eq!(offer_code(&opened, &machine.bytes).unwrap(), format!("txm2.{}", URL_SAFE_NO_PAD.encode(&bytes)));
    assert!(open_envelope(&recipient, &envelope, &URL_SAFE_NO_PAD.encode("other")).is_err(), "bound to the grant's associated data");
    let (stranger, _) = X25519HkdfSha256::gen_keypair();
    assert!(open_envelope(&stranger, &envelope, &aad).is_err(), "only the request's key opens it");
    let other_suite = Envelope { algorithm: "HPKE-Base-P256".into(), ..envelope };
    assert!(open_envelope(&recipient, &other_suite, &aad).is_err(), "one suite only");
}

#[test]
fn refusals_carry_the_prefixes_the_dialog_reads() {
    let (live, asleep, off) = (host_key(20), host_key(21), host_key(22));
    let hosts = json!({ "hosts": [
        host(&live, "Mac mini", BOTH, "live", None),
        host(&asleep, "Build box", BOTH, "exited", None),
        host(&off, "Studio", &[PAIRING_CAPABILITY], "live", None),
    ]});
    let refused_id = live.id.clone();
    let account = FakeAccount::start(move |recorded| match (recorded.method.as_str(), recorded.path.as_str()) {
        (_, path) if path.starts_with("/v1/account/client-installations/") => trusted(),
        ("GET", "/v1/account/hosts") => (200, hosts.clone()),
        ("POST", "/v1/account/pairing-grant-requests") => (409, json!({ "error": "host_binding_operating_unavailable" })),
        _ => (404, json!({})),
    });
    let rig = rig(&account.base, true, Vec::new());
    assert!(rig.pairing.request(&asleep.id).unwrap_err().starts_with("machine_offline:"));
    assert!(rig.pairing.request(&off.id).unwrap_err().starts_with("machine_not_available:"));
    assert!(rig.pairing.request("AAAAAAAAAAAAAAAA").unwrap_err().starts_with("machine_not_available:"));
    assert!(rig.pairing.request(&refused_id).unwrap_err().starts_with("machine_not_available:"), "409 host_binding_operating_unavailable");
}

/// A fake whose grant answers `state` on its first poll.
/// The grant id this computer minted for its request (the server echoes it;
/// the fake answers "g", so the revoke is matched on the posted id).
fn requested_grant(account: &FakeAccount) -> String {
    let posted = account.find("POST", "/v1/account/pairing-grant-requests").into_iter().find(|request| !request.path.ends_with("/revoke")).expect("a grant request");
    posted.body.as_ref().unwrap()["grantRequestId"].as_str().unwrap().to_string()
}

fn grant_ending(state: &'static str) -> (FakeAccount, String) {
    let machine = host_key(30);
    let hosts = json!({ "hosts": [host(&machine, "Mac mini", BOTH, "live", None)] });
    let account = FakeAccount::start(move |recorded| {
        let grant = |state: &str| {
            json!({ "grant": {
                "grantRequestId": "g", "clientInstallationId": "c", "bindingGeneration": 3, "state": state,
                "associatedData": URL_SAFE_NO_PAD.encode(AAD_JSON), "expiresAt": "2099-01-01T00:00:00.000Z",
            }})
        };
        match (recorded.method.as_str(), recorded.path.as_str()) {
            (_, path) if path.starts_with("/v1/account/client-installations/") => trusted(),
            ("GET", "/v1/account/hosts") => (200, hosts.clone()),
            ("POST", "/v1/account/pairing-grant-requests") => (201, grant("pending")),
            ("GET", path) if path.starts_with("/v1/account/pairing-grant-requests/") => (200, grant(state)),
            ("POST", path) if path.ends_with("/revoke") => (200, json!({})),
            _ => (404, json!({})),
        }
    });
    (account, machine.id)
}

#[test]
fn a_rejected_or_expired_grant_is_refused() {
    let (account, id) = grant_ending("rejected");
    let rejected = rig(&account.base, true, Vec::new());
    assert!(rejected.pairing.request(&id).unwrap_err().starts_with("grant_refused:"));
    drop(rejected);
    let (account, id) = grant_ending("expired");
    let expired = rig(&account.base, true, Vec::new());
    assert!(expired.pairing.request(&id).unwrap_err().starts_with("grant_expired:"));
}

#[test]
fn waiting_is_cancelled_and_the_grant_revoked() {
    let (account, id) = grant_ending("pending");
    let rig = rig(&account.base, true, Vec::new());
    let waiting = {
        let pairing = rig.pairing.clone();
        std::thread::spawn(move || pairing.request(&id))
    };
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while account.find("GET", "/v1/account/pairing-grant-requests/").is_empty() {
        assert!(std::time::Instant::now() < deadline, "the request never polled");
        std::thread::sleep(Duration::from_millis(5));
    }
    rig.pairing.cancel();
    assert!(waiting.join().unwrap().unwrap_err().starts_with("cancelled:"));
    assert_eq!(account.find("POST", &format!("/{}/revoke", requested_grant(&account))).len(), 1);
}

#[test]
fn a_grant_still_pending_at_the_deadline_expires() {
    let (account, id) = grant_ending("pending");
    let mut rig = rig(&account.base, true, Vec::new());
    Arc::get_mut(&mut rig.pairing).unwrap().wait = Duration::from_millis(60);
    assert!(rig.pairing.request(&id).unwrap_err().starts_with("grant_expired:"));
    assert_eq!(account.find("POST", &format!("/{}/revoke", requested_grant(&account))).len(), 1);
}
