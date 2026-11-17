//! Host journal for the offline guest seed (design "Seeder contract" step 6),
//! kept beside the original provisioning record without changing its
//! `created` status: `seed-intent.json` (seedOutcomeUnknown), then either
//! `seed-receipt.json` (seeded) for an exact readback or `seed-fenced.json`.
//! An unknown outcome is resolved only by readback. Nothing here writes to a
//! guest disk, retries, reseeds, deletes or repairs; the privileged seeder
//! performs the write, and a person or later review resolves a fence.
use super::{journal, macos_provision};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
};

/// The design's production items: exact path, owner and mode.
const ITEMS: [(&str, &str, &str); 3] = [
    ("plist", "/Library/LaunchDaemons/com.terminalx.next.vm-bootstrap.plist", "0644"),
    ("program", "/Library/Application Support/TerminalX/VMBootstrap/terminalx-vm-bootstrap", "0755"),
    ("key", "/private/var/db/com.terminalx.next.vm-bootstrap/enrollment.json", "0600"),
];
/// The only extended attribute a provenance-tracked writer cannot avoid.
const ALLOWED_XATTRS: [&str; 1] = ["com.apple.provenance"];

fn hex64(value: &Value) -> bool {
    value.as_str().is_some_and(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Checks a host-built seed plan: the three production items, root-owned with
/// their exact modes, plus the ids the version-3 binding will carry.
fn validate_plan(plan: &Value) -> Result<()> {
    let ok_ids = plan["bootstrapId"].as_str().is_some_and(|v| journal::validate_id(v).is_ok())
        && plan["seedId"].as_str().is_some_and(|v| v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    let items = plan["items"].as_array().map(Vec::as_slice).unwrap_or_default();
    let ok_items = items.len() == ITEMS.len()
        && ITEMS.iter().zip(items).all(|((key, path, mode), item)| {
            item["key"] == *key && item["path"] == *path && item["uid"] == 0 && item["gid"] == 0 && item["mode"] == *mode
                && item["size"].as_u64().is_some_and(|s| s > 0) && hex64(&item["sha256"])
                && item.as_object().is_some_and(|o| o.len() == 7)
        });
    let keys_ok = plan.as_object().is_some_and(|o| o.len() == 4) && plan["version"] == 1;
    if !(ok_ids && ok_items && keys_ok) {
        bail!("Seed plan must name the three production items, root-owned with exact modes")
    }
    Ok(())
}

fn lock(dir: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir.join("operation.lock"))?;
    if !journal::try_exclusive(&file)? {
        bail!("Original provisioning actor is owned")
    }
    Ok(file)
}

fn write_new(dir: &Path, name: &str, value: &Value) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir.join(name))
        .with_context(|| format!("{name} already exists; the seed is never repeated or replaced"))?;
    file.write_all(&serde_json::to_vec(value)?)?;
    file.sync_all()?;
    File::open(dir)?.sync_all()?;
    Ok(())
}

fn read(dir: &Path, name: &str) -> Result<Option<Value>> {
    let path = dir.join(name);
    if !path.try_exists()? {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&super::macos_keys::private_read(&path, 64 * 1024)?)?))
}

/// The guest's `enrollment.json`, as the helper's `Seed::parse` reads it.
fn guest_key_file(bootstrap_id: &str, seed_id: &str, enrollment_key: &[u8]) -> Result<Vec<u8>> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    super::macos_owner_channel::canonical(&json!({"bootstrapId": bootstrap_id,
        "key": STANDARD.encode(enrollment_key), "seedId": seed_id, "version": 1}))
}

fn read_key(dir: &Path) -> Result<[u8; 32]> {
    let text = super::macos_keys::private_read(&dir.join("enrollment.key"), 128)?;
    let text = std::str::from_utf8(&text).context("Enrollment key is not text")?;
    let bytes = (0..text.len())
        .step_by(2)
        .map(|i| text.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()))
        .collect::<Option<Vec<u8>>>()
        .context("Enrollment key is not hex")?;
    bytes.try_into().ok().context("Enrollment key is not 32 bytes")
}

/// Records intent before the privileged seeder runs. The host generates the
/// per-VM enrollment key and seed id here and derives the guest key file and
/// every item digest itself; callers supply only the plist and helper digests.
/// The intent is durable first, then the owner-only `enrollment.key`; a crash
/// between them leaves an unresolved intent that can only fence, never reseed.
/// Requires the original completed restore with no run record.
pub(super) fn begin(root: &Path, key: &str, plist: (u64, &str), program: (u64, &str)) -> Result<Value> {
    use rand_core::RngCore;
    let dir = macos_provision::directory(root, key)?;
    let _lock = lock(&dir)?;
    macos_provision::created_for_bootstrap(root, key)?;
    if state_in(&dir)? != "notSeeded" || dir.join("enrollment.key").try_exists()? {
        bail!("This VM already has seed history; it is never reseeded or replaced")
    }
    let mut enrollment_key = [0u8; 32];
    let mut seed = [0u8; 16];
    rand_core::OsRng.fill_bytes(&mut enrollment_key);
    rand_core::OsRng.fill_bytes(&mut seed);
    let seed_id: String = seed.iter().map(|b| format!("{b:02x}")).collect();
    let guest = guest_key_file(key, &seed_id, &enrollment_key)?;
    let item = |(name, path, mode): (&str, &str, &str), size: u64, sha256: &str| {
        json!({"key": name, "path": path, "uid": 0, "gid": 0, "mode": mode, "size": size, "sha256": sha256})
    };
    let plan = json!({"version": 1, "bootstrapId": key, "seedId": seed_id, "items": [
        item(ITEMS[0], plist.0, plist.1), item(ITEMS[1], program.0, program.1),
        item(ITEMS[2], guest.len() as u64, &journal::digest(&guest))]});
    validate_plan(&plan)?;
    let intent = json!({"version": 1, "plan": plan, "planDigest": journal::digest(&serde_json::to_vec(&plan)?),
        "createdAt": journal::now(), "ready": false});
    write_new(&dir, "seed-intent.json", &intent)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir.join("enrollment.key"))?;
    let hex: String = enrollment_key.iter().map(|b| format!("{b:02x}")).collect();
    file.write_all(hex.as_bytes())?;
    file.sync_all()?;
    File::open(&dir)?.sync_all()?;
    Ok(json!({"seed": "seedOutcomeUnknown", "seedId": seed_id, "planDigest": intent["planDigest"], "ready": false}))
}

/// The exact guest `enrollment.json` bytes for the privileged seeder, rebuilt
/// from the private key and the recorded intent; their digest must match it.
pub(super) fn guest_material(root: &Path, key: &str) -> Result<Vec<u8>> {
    let dir = macos_provision::directory(root, key)?;
    let intent = read(&dir, "seed-intent.json")?.context("Seed intent missing")?;
    let seed_id = intent["plan"]["seedId"].as_str().context("Seed id missing")?;
    let bytes = guest_key_file(key, seed_id, &read_key(&dir)?)?;
    if intent["plan"]["items"][2]["sha256"] != journal::digest(&bytes) {
        bail!("Enrollment key no longer matches the recorded seed intent")
    }
    Ok(bytes)
}

/// The owner-only key text for the version-3 owner hand-off, only once seeded.
pub(super) fn owner_key(root: &Path, key: &str) -> Result<Vec<u8>> {
    seeded(root, key)?;
    let dir = macos_provision::directory(root, key)?;
    guest_material(root, key)?;
    super::macos_keys::private_read(&dir.join("enrollment.key"), 128)
}

/// Resolves the unknown outcome from the seeder's ownership-enabled readback.
/// An exact match records `seeded`; anything else fences for inspection.
pub(super) fn complete(root: &Path, key: &str, readback: &Value) -> Result<Value> {
    let dir = macos_provision::directory(root, key)?;
    let _lock = lock(&dir)?;
    if state_in(&dir)? != "seedOutcomeUnknown" {
        bail!("Only an unresolved seed intent can be completed")
    }
    let intent = read(&dir, "seed-intent.json")?.context("Seed intent missing")?;
    let expected = intent["plan"]["items"].as_array().context("Seed intent items missing")?;
    let observed = readback["items"].as_array().map(Vec::as_slice).unwrap_or_default();
    let matches = readback["profile"] == "production"
        && readback["matchesReceipt"] == true
        && observed.len() == expected.len()
        && expected.iter().zip(observed).all(|(want, got)| {
            ["key", "path", "uid", "gid", "mode", "size", "sha256"].iter().all(|field| want[field] == got[field])
                && got["xattrs"].as_array().is_some_and(|names| {
                    names.iter().all(|n| n.as_str().is_some_and(|n| ALLOWED_XATTRS.contains(&n)))
                })
        });
    let readback_digest = journal::digest(&serde_json::to_vec(readback)?);
    if !matches {
        write_new(&dir, "seed-fenced.json", &json!({"version": 1, "readbackDigest": readback_digest,
            "reason": "Seed readback differs from the recorded intent", "ready": false}))?;
        bail!("Seed readback differs from the recorded intent; the operation is fenced for inspection")
    }
    let receipt = json!({"version": 1, "planDigest": intent["planDigest"], "readbackDigest": readback_digest,
        "bootstrapId": intent["plan"]["bootstrapId"], "seedId": intent["plan"]["seedId"],
        "items": observed, "seeded": true, "ready": false});
    write_new(&dir, "seed-receipt.json", &receipt)?;
    Ok(json!({"seed": "seeded", "seedReceiptSha256": journal::digest(&serde_json::to_vec(&receipt)?), "ready": false}))
}

fn state_in(dir: &Path) -> Result<&'static str> {
    Ok(if dir.join("seed-fenced.json").try_exists()? {
        "fenced"
    } else if dir.join("seed-receipt.json").try_exists()? {
        "seeded"
    } else if dir.join("seed-intent.json").try_exists()? {
        "seedOutcomeUnknown"
    } else {
        "notSeeded"
    })
}

pub(super) fn state(root: &Path, key: &str) -> Result<Value> {
    Ok(json!({"seed": state_in(&macos_provision::directory(root, key)?)?, "ready": false}))
}

/// The version-3 launch precondition: the original created record and an
/// exact seed receipt for this operation. Returns the receipt and its digest.
pub(super) fn seeded(root: &Path, key: &str) -> Result<(Value, String)> {
    let dir = macos_provision::directory(root, key)?;
    macos_provision::created_for_bootstrap(root, key)?;
    if state_in(&dir)? != "seeded" {
        bail!("The guest must be seeded, with an exact readback receipt, before the bootstrap launch")
    }
    let bytes = super::macos_keys::private_read(&dir.join("seed-receipt.json"), 64 * 1024)?;
    let receipt: Value = serde_json::from_slice(&bytes)?;
    if receipt["seeded"] != true || receipt["bootstrapId"] != key {
        bail!("Seed receipt changed")
    }
    Ok((receipt, journal::digest(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    const PLIST: (u64, &str) = (492, "2d1e06367b671df7af1ab236ac107c3f706a6b5068e43f809440d83ec64474e9");
    const PROGRAM: (u64, &str) = (643392, "283ec5a8489d2a9330c13e229c38743f5bb2d1fbffb1d27feb4813df7067d1b1");

    fn intent_plan(root: &Path, key: &str) -> Value {
        read(&macos_provision::directory(root, key).unwrap(), "seed-intent.json").unwrap().unwrap()["plan"].clone()
    }

    /// What the seeder core's readback reports for an exact seed.
    fn readback(plan: &Value) -> Value {
        let items: Vec<Value> = plan["items"].as_array().unwrap().iter().map(|item| {
            let mut item = item.clone();
            item["xattrs"] = json!(["com.apple.provenance"]);
            item
        }).collect();
        json!({"version": 1, "profile": "production", "device": 7, "items": items, "matchesReceipt": true})
    }

    #[test]
    fn intent_then_exact_readback_seeds_once_and_gates_the_launch() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let (_dir, root, key) = macos_provision::created_for_tests();
        assert!(seeded(&root, &key).is_err(), "no launch before seeding");
        assert_eq!(state(&root, &key).unwrap()["seed"], "notSeeded");
        let begun = begin(&root, &key, PLIST, PROGRAM).unwrap();
        assert_eq!(begun["seed"], "seedOutcomeUnknown");
        let plan = intent_plan(&root, &key);
        assert_eq!(plan["seedId"], begun["seedId"]);
        let material = guest_material(&root, &key).unwrap();
        let record: Value = serde_json::from_slice(&material).unwrap();
        assert_eq!((record["bootstrapId"].as_str(), record["version"].as_u64()), (Some(key.as_str()), Some(1)));
        assert_eq!(plan["items"][2]["sha256"], journal::digest(&material));
        assert!(owner_key(&root, &key).is_err(), "no key hand-off before seeding");
        assert!(seeded(&root, &key).is_err(), "an unknown outcome never permits a launch");
        assert!(begin(&root, &key, PLIST, PROGRAM).is_err(), "never reseeds");
        let done = complete(&root, &key, &readback(&plan)).unwrap();
        assert_eq!(done["seed"], "seeded");
        let (receipt, digest) = seeded(&root, &key).unwrap();
        assert_eq!((digest.as_str(), &receipt["seedId"]), (done["seedReceiptSha256"].as_str().unwrap(), &plan["seedId"]));
        let hex = String::from_utf8(owner_key(&root, &key).unwrap()).unwrap();
        let key_bytes = STANDARD.decode(record["key"].as_str().unwrap()).unwrap();
        assert_eq!(hex, key_bytes.iter().map(|b| format!("{b:02x}")).collect::<String>());
        let dir = macos_provision::directory(&root, &key).unwrap();
        for name in ["seed-intent.json", "seed-receipt.json", "record.json"] {
            let text = std::fs::read_to_string(dir.join(name)).unwrap();
            assert!(!text.contains(&hex) && !text.contains(record["key"].as_str().unwrap()), "{name} holds no key");
        }
        assert!(complete(&root, &key, &readback(&plan)).is_err(), "never completes twice");
        assert_eq!(macos_provision::created_for_bootstrap(&root, &key).unwrap()["status"], "created");
    }

    #[test]
    fn a_differing_readback_fences_and_is_never_retried() {
        let cases: [fn(&mut Value); 5] = [
            |r| r["items"][1]["sha256"] = json!("f".repeat(64)),
            |r| r["items"][0]["uid"] = json!(501),
            |r| r["items"][2]["mode"] = json!("0644"),
            |r| r["items"][0]["xattrs"] = json!(["com.apple.quarantine"]),
            |r| r["profile"] = json!("validation"),
        ];
        for mutate in cases {
            let (_dir, root, key) = macos_provision::created_for_tests();
            begin(&root, &key, PLIST, PROGRAM).unwrap();
            let plan = intent_plan(&root, &key);
            let mut changed = readback(&plan);
            mutate(&mut changed);
            assert!(complete(&root, &key, &changed).is_err());
            assert_eq!(state(&root, &key).unwrap()["seed"], "fenced");
            assert!(complete(&root, &key, &readback(&plan)).is_err(), "a fence is not cleared by a later match");
            assert!(seeded(&root, &key).is_err() && owner_key(&root, &key).is_err());
            assert!(begin(&root, &key, PLIST, PROGRAM).is_err());
        }
    }

    #[test]
    fn malformed_artifact_digests_write_nothing() {
        let (_dir, root, key) = macos_provision::created_for_tests();
        for (plist, program) in [((0, PLIST.1), PROGRAM), (PLIST, (1, "F".repeat(64).leak() as &str)), (PLIST, (1, "abc"))] {
            assert!(begin(&root, &key, plist, program).is_err());
        }
        let dir = macos_provision::directory(&root, &key).unwrap();
        assert_eq!(state(&root, &key).unwrap()["seed"], "notSeeded");
        assert!(!dir.join("enrollment.key").exists(), "no key without an intent");
    }

    #[test]
    fn a_changed_private_key_never_reaches_the_seeder_or_owner() {
        let (_dir, root, key) = macos_provision::created_for_tests();
        begin(&root, &key, PLIST, PROGRAM).unwrap();
        let path = macos_provision::directory(&root, &key).unwrap().join("enrollment.key");
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600)).unwrap();
        std::fs::write(&path, "0".repeat(64)).unwrap();
        assert!(guest_material(&root, &key).is_err());
    }

    #[test]
    fn seeding_needs_the_original_completed_restore_without_a_run() {
        let dir = tempfile::tempdir().unwrap();
        let key = journal::new_id();
        assert!(begin(dir.path(), &key, PLIST, PROGRAM).is_err(), "no provisioning record");
    }
}
