//! Guest side of TXGuestProtocol version 2 (design "Enrollment protocol"):
//! the helper proves possession of the seeded per-VM key with an HMAC over a
//! fresh owner challenge, then both sides tag every later frame with an
//! HKDF-derived session key. Success means only that guest root in this VM
//! holds the key: never binary attestation, account consent, trust or Ready.
//! The key and session key never appear in frames, logs, Debug output or argv.
use crate::{
    sha256,
    wire::{read_frame, write_frame, Stream},
};
use hmac::{Hmac, Mac};
use serde_json::{json, Map, Value};
use sha2::Sha256;
use std::{
    io,
    time::{Duration, Instant},
};

/// Distinct from the owner channel's `terminalx-lume-owner-v1`, so tags can
/// never be replayed across the two protocols.
pub const PREFIX: &str = "terminalx-vm-enrollment-v2";
pub const VERSION: u64 = 2;
const CLAIMS_LIMIT: usize = 16;

fn refused(reason: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, reason.into())
}

/// Length-prefixed, domain-separated HMAC-SHA256, the same construction as the
/// owner channel's `tag` with this protocol's prefix.
pub fn tag(key: &[u8], domain: &str, parts: &[&str]) -> String {
    crate::hex(&mac(key, domain, parts).finalize().into_bytes())
}

fn mac(key: &[u8], domain: &str, parts: &[&str]) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    for part in [PREFIX, domain].into_iter().chain(parts.iter().copied()) {
        mac.update(&(part.len() as u32).to_be_bytes());
        mac.update(part.as_bytes());
    }
    mac
}

/// Constant-time check of a lowercase-hex tag.
fn verify(key: &[u8], domain: &str, parts: &[&str], value: &str) -> io::Result<()> {
    let bytes = unhex(value, 32).ok_or_else(|| refused("tag is not 32 bytes of lowercase hex"))?;
    mac(key, domain, parts)
        .verify_slice(&bytes)
        .map_err(|_| refused("tag does not verify"))
}

fn unhex(value: &str, bytes: usize) -> Option<Vec<u8>> {
    if value.len() != bytes * 2
        || !value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).ok())
        .collect()
}

/// HKDF-SHA256: the seeded key, salted with both nonces; the challenge digest
/// in the info binds the session to the binding, epoch, seed and both ids.
pub fn session_key(
    key: &[u8],
    client_nonce: &str,
    server_nonce: &str,
    challenge_sha256: &str,
) -> io::Result<[u8; 32]> {
    let mut salt = unhex(client_nonce, 32).ok_or_else(|| refused("client nonce"))?;
    salt.extend(unhex(server_nonce, 32).ok_or_else(|| refused("server nonce"))?);
    let info = format!("{PREFIX} session {challenge_sha256}");
    let mut out = [0u8; 32];
    hkdf::Hkdf::<Sha256>::new(Some(&salt), key)
        .expand(info.as_bytes(), &mut out)
        .map_err(|_| refused("session key"))?;
    Ok(out)
}

/// The seeded enrollment record. Debug never prints the key.
pub struct Seed {
    pub bootstrap_id: String,
    pub seed_id: String,
    key: [u8; 32],
}

impl std::fmt::Debug for Seed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Seed")
            .field("bootstrap_id", &self.bootstrap_id)
            .field("seed_id", &self.seed_id)
            .finish_non_exhaustive()
    }
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
}

impl Seed {
    /// Parses the seeded `enrollment.json`: `{bootstrapId, key, seedId, version}`
    /// with a base64 32-byte key. Extra fields such as the target digest are kept
    /// by the seeder's receipt, not interpreted here.
    pub fn parse(bytes: &[u8]) -> io::Result<Seed> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let value: Value =
            serde_json::from_slice(bytes).map_err(|_| refused("enrollment record is not JSON"))?;
        let text = |name: &str| {
            value[name]
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| refused(format!("enrollment record has no {name}")))
        };
        let (bootstrap_id, seed_id) = (text("bootstrapId")?, text("seedId")?);
        if value["version"] != 1 || !identifier(&bootstrap_id) || unhex(&seed_id, 16).is_none() {
            return Err(refused("enrollment record identifiers are malformed"));
        }
        let key: [u8; 32] = STANDARD
            .decode(text("key")?)
            .ok()
            .and_then(|k| k.try_into().ok())
            .ok_or_else(|| refused("enrollment key is not 32 bytes"))?;
        Ok(Seed {
            bootstrap_id,
            seed_id,
            key,
        })
    }

    #[cfg(test)]
    pub(crate) fn fixture(bootstrap_id: &str, seed_id: &str, key: [u8; 32]) -> Seed {
        Seed {
            bootstrap_id: bootstrap_id.into(),
            seed_id: seed_id.into(),
            key,
        }
    }
}

/// One direction's tagged, strictly sequenced frames under the session key.
pub struct Session {
    key: [u8; 32],
    sent: u64,
    received: u64,
    deadline: Duration,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("sent", &self.sent)
            .field("received", &self.received)
            .finish_non_exhaustive()
    }
}

const HELPER: &str = "helper";
const OWNER: &str = "owner";

fn canonical(value: &Value) -> Vec<u8> {
    serde_json::to_vec(value).expect("JSON values always serialize")
}

impl Session {
    /// Bounds the next waits, such as for a person's confirmation; frames keep
    /// their sequence and tag checks whatever the wait.
    pub fn set_wait(&mut self, wait: Duration) {
        self.deadline = wait;
    }

    #[cfg(test)]
    pub(crate) fn fixture(key: [u8; 32]) -> Session {
        Session {
            key,
            sent: 0,
            received: 0,
            deadline: Duration::from_secs(2),
        }
    }

    /// Test owner side: a tagged owner frame, and a checked helper frame.
    #[cfg(test)]
    pub(crate) fn owner_frame(key: &[u8; 32], seq: u64, body: &Value) -> Vec<u8> {
        canonical(
            &json!({"body": body, "seq": seq, "tag": tag(key, "frame", &[OWNER, &seq.to_string(), &sha256(&canonical(body))])}),
        )
    }
    #[cfg(test)]
    pub(crate) fn helper_body(key: &[u8; 32], seq: u64, frame: &[u8]) -> io::Result<Value> {
        let frame: Value = serde_json::from_slice(frame)?;
        verify(
            key,
            "frame",
            &[
                HELPER,
                &seq.to_string(),
                &sha256(&canonical(&frame["body"])),
            ],
            frame["tag"].as_str().unwrap_or(""),
        )?;
        Ok(frame["body"].clone())
    }

    fn frame_tag(&self, direction: &str, seq: u64, body: &Value) -> String {
        tag(
            &self.key,
            "frame",
            &[direction, &seq.to_string(), &sha256(&canonical(body))],
        )
    }

    pub fn send(&mut self, stream: &mut impl Stream, body: Value) -> io::Result<()> {
        if !body.is_object() {
            return Err(refused("session bodies are objects"));
        }
        let tag = self.frame_tag(HELPER, self.sent, &body);
        let frame = json!({"body": body, "seq": self.sent, "tag": tag});
        write_frame(stream, &canonical(&frame), Instant::now() + self.deadline)?;
        self.sent += 1;
        Ok(())
    }

    /// The next owner frame: exactly `{body, seq, tag}`, the expected sequence
    /// number and a valid tag. Anything else ends the session.
    pub fn receive(&mut self, stream: &mut impl Stream) -> io::Result<Value> {
        let bytes = read_frame(stream, Instant::now() + self.deadline)?;
        let frame =
            crate::wire::canonical_object(&bytes, &["body", "seq", "tag"]).map_err(refused)?;
        if frame["seq"].as_u64() != Some(self.received) {
            return Err(refused("owner frame out of sequence"));
        }
        let body = frame["body"].clone();
        if !body.is_object() {
            return Err(refused("owner frame body is not an object"));
        }
        let expected = frame["tag"]
            .as_str()
            .ok_or_else(|| refused("owner frame tag"))?;
        verify(
            &self.key,
            "frame",
            &[
                OWNER,
                &self.received.to_string(),
                &sha256(&canonical(&body)),
            ],
            expected,
        )?;
        self.received += 1;
        Ok(body)
    }
}

fn hex64(value: &Value) -> bool {
    value.as_str().is_some_and(|v| unhex(v, 32).is_some())
}

/// Checks the owner's challenge against this seed and hello before anything
/// is computed from the key.
fn check_challenge(
    challenge: &Map<String, Value>,
    seed: &Seed,
    client_nonce: &str,
) -> io::Result<()> {
    let epoch = challenge["ownerEpoch"].as_str().unwrap_or("");
    if challenge["version"] != VERSION
        || challenge["bootstrapId"] != seed.bootstrap_id.as_str()
        || challenge["seedId"] != seed.seed_id.as_str()
        || challenge["clientNonce"] != client_nonce
        || !hex64(&challenge["serverNonce"])
        || !hex64(&challenge["bindingDigest"])
        || !hex64(&challenge["seedReceiptSha256"])
        || epoch.is_empty()
        || epoch.len() > 128
        || !epoch.bytes().all(|b| (0x21..0x7f).contains(&b))
    {
        return Err(refused("challenge is not for this seed, hello and binding"));
    }
    Ok(())
}

/// The owner's acceptance after a successful proof. Only helper key possession
/// is established; account, trust and readiness remain false.
pub fn acceptance(challenge_sha256: &str) -> Value {
    json!({"accountAuthenticated": false, "challengeSha256": challenge_sha256, "helperAuthenticated": true,
        "ready": false, "trustAccepted": false})
}

/// Runs one enrollment over a connected stream: hello, challenge check, proof,
/// and the owner's tagged acceptance. Returns the session and the challenge
/// digest. Errors leave nothing to retry on this connection.
pub fn enroll(
    stream: &mut impl Stream,
    seed: &Seed,
    claims: &Value,
    timeout: Duration,
) -> io::Result<(Session, String)> {
    let claims_object = claims
        .as_object()
        .ok_or_else(|| refused("claims are an object"))?;
    if claims_object.len() > CLAIMS_LIMIT
        || claims_object
            .values()
            .any(|v| !(v.is_string() || v.is_number() || v.is_boolean()))
    {
        return Err(refused("claims are a small flat object"));
    }
    let deadline = Instant::now() + timeout;
    let client_nonce = crate::hex(&crate::random::<32>()?);
    let hello = json!({"bootstrapId": seed.bootstrap_id, "clientNonce": client_nonce, "seedId": seed.seed_id, "version": VERSION});
    write_frame(stream, &canonical(&hello), deadline)?;
    let challenge_bytes = read_frame(stream, deadline)?;
    let challenge = crate::wire::canonical_object(
        &challenge_bytes,
        &[
            "bindingDigest",
            "bootstrapId",
            "clientNonce",
            "ownerEpoch",
            "seedId",
            "seedReceiptSha256",
            "serverNonce",
            "version",
        ],
    )
    .map_err(refused)?;
    check_challenge(&challenge, seed, &client_nonce)?;
    let challenge_sha256 = sha256(&challenge_bytes);
    let claims_sha256 = sha256(&canonical(claims));
    let proof = tag(
        &seed.key,
        "enrollment",
        &[&challenge_sha256, &claims_sha256],
    );
    write_frame(
        stream,
        &canonical(&json!({"challengeSha256": challenge_sha256, "claims": claims, "proof": proof})),
        deadline,
    )?;
    let server_nonce = challenge["serverNonce"].as_str().unwrap_or_default();
    let mut session = Session {
        key: session_key(&seed.key, &client_nonce, server_nonce, &challenge_sha256)?,
        sent: 0,
        received: 0,
        deadline: timeout,
    };
    let accepted = session.receive(stream)?;
    if accepted != acceptance(&challenge_sha256) {
        return Err(refused("owner acceptance changed or promoted trust"));
    }
    Ok((session, challenge_sha256))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::FRAME_LIMIT;
    use std::{io::Write, os::unix::net::UnixStream, thread};

    const KEY: [u8; 32] = [0x42; 32];
    const BOOT: &str = "6f1d7c2e-0b9a-4c55-9d1e-2a3b4c5d6e7f";
    const SEED: &str = "00112233445566778899aabbccddeeff";

    fn seed() -> Seed {
        Seed::fixture(BOOT, SEED, KEY)
    }

    /// Independent vectors computed by the Python reference in
    /// integrations/lume-bootstrap/Tests/enrollment_test.py.
    #[test]
    fn tag_and_session_key_match_reference_vectors() {
        assert_eq!(
            tag(
                &KEY,
                "enrollment",
                &["a".repeat(64).as_str(), "b".repeat(64).as_str()]
            ),
            reference_tag()
        );
        assert_eq!(
            crate::hex(
                &session_key(&KEY, &"1".repeat(64), &"2".repeat(64), &"3".repeat(64)).unwrap()
            ),
            reference_session()
        );
    }

    // Filled from the reference implementation (see the Python test's VECTORS).
    fn reference_tag() -> String {
        include_str!("../tests/vectors/enrollment-tag.txt")
            .trim()
            .to_owned()
    }
    fn reference_session() -> String {
        include_str!("../tests/vectors/session-key.txt")
            .trim()
            .to_owned()
    }

    /// A conforming owner written against the spec, for in-crate fixtures.
    /// The real owner is the Swift implementation, covered cross-language.
    fn owner(mut stream: UnixStream, key: [u8; 32], tamper: fn(&mut Value)) -> io::Result<Value> {
        let deadline = || Instant::now() + Duration::from_secs(3);
        let hello: Value = serde_json::from_slice(&read_frame(&mut stream, deadline())?).unwrap();
        let mut challenge = json!({"bindingDigest": "d".repeat(64), "bootstrapId": hello["bootstrapId"],
            "clientNonce": hello["clientNonce"], "ownerEpoch": "epoch-7", "seedId": hello["seedId"],
            "seedReceiptSha256": "e".repeat(64), "serverNonce": crate::hex(&crate::random::<32>().unwrap()), "version": 2});
        tamper(&mut challenge);
        let bytes = canonical(&challenge);
        write_frame(&mut stream, &bytes, deadline())?;
        let proof: Value = serde_json::from_slice(&read_frame(&mut stream, deadline())?).unwrap();
        let challenge_sha256 = sha256(&bytes);
        verify(
            &key,
            "enrollment",
            &[&challenge_sha256, &sha256(&canonical(&proof["claims"]))],
            proof["proof"].as_str().unwrap(),
        )?;
        let session = session_key(
            &key,
            challenge["clientNonce"].as_str().unwrap(),
            challenge["serverNonce"].as_str().unwrap(),
            &challenge_sha256,
        )?;
        let body = acceptance(&challenge_sha256);
        let frame_tag = tag(&session, "frame", &[OWNER, "0", &sha256(&canonical(&body))]);
        write_frame(
            &mut stream,
            &canonical(&json!({"body": body, "seq": 0, "tag": frame_tag})),
            deadline(),
        )?;
        // Echo one helper frame back as owner frame 1.
        let frame: Value = serde_json::from_slice(&read_frame(&mut stream, deadline())?).unwrap();
        verify(
            &session,
            "frame",
            &[HELPER, "0", &sha256(&canonical(&frame["body"]))],
            frame["tag"].as_str().unwrap(),
        )?;
        let echo = json!({"echo": frame["body"]});
        let echo_tag = tag(&session, "frame", &[OWNER, "1", &sha256(&canonical(&echo))]);
        write_frame(
            &mut stream,
            &canonical(&json!({"body": echo, "seq": 1, "tag": echo_tag})),
            deadline(),
        )?;
        Ok(proof)
    }

    fn claims() -> Value {
        json!({"euid": 0, "osBuild": "25A354"})
    }

    #[test]
    fn enrolls_and_exchanges_tagged_frames() {
        let (mut helper, owner_end) = UnixStream::pair().unwrap();
        let owner = thread::spawn(move || owner(owner_end, KEY, |_| {}));
        let (mut session, challenge) =
            enroll(&mut helper, &seed(), &claims(), Duration::from_secs(3)).unwrap();
        assert_eq!(challenge.len(), 64);
        session.send(&mut helper, json!({"accounts": []})).unwrap();
        assert_eq!(
            session.receive(&mut helper).unwrap(),
            json!({"echo": {"accounts": []}})
        );
        let proof = owner.join().unwrap().unwrap();
        assert_eq!(proof["claims"], claims());
        let wire = serde_json::to_string(&proof).unwrap();
        assert!(
            !wire.contains(&crate::hex(&KEY)),
            "the key never crosses the wire"
        );
    }

    #[test]
    fn a_wrong_key_is_refused_by_the_owner_and_the_helper_learns_nothing() {
        let (mut helper, owner_end) = UnixStream::pair().unwrap();
        let owner = thread::spawn(move || owner(owner_end, [0x43; 32], |_| {}));
        assert!(enroll(&mut helper, &seed(), &claims(), Duration::from_secs(1)).is_err());
        assert_eq!(
            owner.join().unwrap().unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
    }

    #[test]
    fn challenges_for_another_seed_binding_or_hello_get_no_proof() {
        let cases: [fn(&mut Value); 6] = [
            |c| c["seedId"] = json!("ffeeddccbbaa99887766554433221100"),
            |c| c["bootstrapId"] = json!("other"),
            |c| c["clientNonce"] = json!("0".repeat(64)),
            |c| c["version"] = json!(1),
            |c| c["bindingDigest"] = json!("D".repeat(64)),
            |c| c["ownerEpoch"] = json!(""),
        ];
        for tamper in cases {
            let (mut helper, mut owner_end) = UnixStream::pair().unwrap();
            let owner = thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(2);
                let hello: Value =
                    serde_json::from_slice(&read_frame(&mut owner_end, deadline).unwrap()).unwrap();
                let mut challenge = json!({"bindingDigest": "d".repeat(64), "bootstrapId": hello["bootstrapId"],
                    "clientNonce": hello["clientNonce"], "ownerEpoch": "e", "seedId": hello["seedId"],
                    "seedReceiptSha256": "e".repeat(64), "serverNonce": "f".repeat(64), "version": 2});
                tamper(&mut challenge);
                write_frame(&mut owner_end, &canonical(&challenge), deadline).unwrap();
                // The helper must close without sending a proof.
                read_frame(&mut owner_end, deadline).err().map(|e| e.kind())
            });
            assert!(enroll(&mut helper, &seed(), &claims(), Duration::from_secs(1)).is_err());
            drop(helper);
            assert_eq!(owner.join().unwrap(), Some(io::ErrorKind::UnexpectedEof));
        }
    }

    #[test]
    fn replayed_tampered_and_out_of_sequence_owner_frames_end_the_session() {
        // Build a valid session by hand, then feed it bad owner frames.
        let key = session_key(&KEY, &"1".repeat(64), &"2".repeat(64), &"3".repeat(64)).unwrap();
        let body = json!({"x": 1});
        let good = |seq: u64, body: &Value| json!({"body": body, "seq": seq, "tag": tag(&key, "frame", &[OWNER, &seq.to_string(), &sha256(&canonical(body))])});
        let cases = vec![
            (vec![good(0, &body), good(0, &body)], "replay"),
            (vec![good(1, &body)], "skipped sequence"),
            (
                vec![{
                    let mut f = good(0, &body);
                    f["body"] = json!({"x": 2});
                    f
                }],
                "tampered body",
            ),
            (
                vec![{
                    let mut f = good(0, &body);
                    f["tag"] = json!(tag(
                        &key,
                        "frame",
                        &[HELPER, "0", &sha256(&canonical(&body))]
                    ));
                    f
                }],
                "reflected helper tag",
            ),
            (vec![json!({"body": body, "seq": 0})], "missing tag"),
        ];
        for (frames, name) in cases {
            let (mut helper, mut owner_end) = UnixStream::pair().unwrap();
            let mut session = Session {
                key,
                sent: 0,
                received: 0,
                deadline: Duration::from_secs(1),
            };
            for frame in &frames {
                write_frame(
                    &mut owner_end,
                    &canonical(frame),
                    Instant::now() + Duration::from_secs(1),
                )
                .unwrap();
            }
            let results: Vec<bool> = frames
                .iter()
                .map(|_| session.receive(&mut helper).is_ok())
                .collect();
            assert_eq!(results.last(), Some(&false), "{name}: {results:?}");
        }
    }

    #[test]
    fn closed_streams_and_oversized_frames_fail_within_the_deadline() {
        let (mut helper, owner_end) = UnixStream::pair().unwrap();
        drop(owner_end);
        let started = Instant::now();
        assert!(enroll(&mut helper, &seed(), &claims(), Duration::from_millis(300)).is_err());
        assert!(started.elapsed() < Duration::from_secs(2));

        let (mut helper, mut owner_end) = UnixStream::pair().unwrap();
        owner_end
            .write_all(&(FRAME_LIMIT as u32 + 1).to_be_bytes())
            .unwrap();
        assert_eq!(
            enroll(&mut helper, &seed(), &claims(), Duration::from_millis(300))
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );

        let (mut helper, _silent) = UnixStream::pair().unwrap();
        let started = Instant::now();
        assert_eq!(
            enroll(&mut helper, &seed(), &claims(), Duration::from_millis(200))
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn seed_records_and_claims_are_validated_and_the_key_is_never_printed() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let record =
            json!({"bootstrapId": BOOT, "key": STANDARD.encode(KEY), "seedId": SEED, "version": 1});
        let parsed = Seed::parse(&canonical(&record)).unwrap();
        assert_eq!(
            (parsed.bootstrap_id.as_str(), parsed.seed_id.as_str()),
            (BOOT, SEED)
        );
        let debug = format!("{parsed:?}");
        assert!(
            !debug.contains(&STANDARD.encode(KEY)) && !debug.contains(&crate::hex(&KEY)),
            "{debug}"
        );
        for bad in [
            json!({"bootstrapId": BOOT, "key": STANDARD.encode([1u8; 31]), "seedId": SEED, "version": 1}),
            json!({"bootstrapId": BOOT, "key": STANDARD.encode(KEY), "seedId": "short", "version": 1}),
            json!({"bootstrapId": "../x", "key": STANDARD.encode(KEY), "seedId": SEED, "version": 1}),
            json!({"bootstrapId": BOOT, "key": STANDARD.encode(KEY), "seedId": SEED, "version": 2}),
        ] {
            assert!(Seed::parse(&canonical(&bad)).is_err(), "{bad}");
        }
        let (mut helper, _owner) = UnixStream::pair().unwrap();
        assert!(enroll(
            &mut helper,
            &seed(),
            &json!({"nested": {"a": 1}}),
            Duration::from_millis(100)
        )
        .is_err());
        assert!(enroll(
            &mut helper,
            &seed(),
            &json!([1]),
            Duration::from_millis(100)
        )
        .is_err());
    }

    #[test]
    fn an_account_confirmation_counts_only_when_tagged_under_the_session() {
        use std::os::unix::fs::MetadataExt;
        let key = session_key(&KEY, &"1".repeat(64), &"2".repeat(64), &"3".repeat(64)).unwrap();
        let user = std::env::var("USER").unwrap();
        let home = format!("/Users/{user}");
        let meta = std::fs::metadata(&home).unwrap();
        // SAFETY: no preconditions.
        let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
        let body = json!({"accountConfirmation": {"confirmed": true, "confirmationSha256": "c".repeat(64), "gid": gid,
            "home": home, "homeDevice": meta.dev(), "homeInode": meta.ino(), "name": user, "uid": uid}});
        for (signing_key, ok) in [(key, true), ([0x55; 32], false)] {
            let (mut helper, mut owner) = UnixStream::pair().unwrap();
            let frame = json!({"body": body, "seq": 0, "tag": tag(&signing_key, "frame", &[OWNER, "0", &sha256(&canonical(&body))])});
            write_frame(
                &mut owner,
                &canonical(&frame),
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
            let mut session = Session {
                key,
                sent: 0,
                received: 0,
                deadline: Duration::from_secs(1),
            };
            let confirmed = session.receive_confirmation(&mut helper);
            assert_eq!(confirmed.is_ok(), ok, "{confirmed:?}");
            if ok {
                assert_eq!(confirmed.unwrap().uid, uid);
            }
        }
    }
}
