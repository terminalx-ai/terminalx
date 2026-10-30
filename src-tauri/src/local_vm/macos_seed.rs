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
        && plan["seedId"].as_str().is_some_and(|v| v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
        && plan["keyReference"].as_str().is_some_and(|v| journal::validate_id(v).is_ok());
    let items = plan["items"].as_array().map(Vec::as_slice).unwrap_or_default();
    let ok_items = items.len() == ITEMS.len()
        && ITEMS.iter().zip(items).all(|((key, path, mode), item)| {
            item["key"] == *key && item["path"] == *path && item["uid"] == 0 && item["gid"] == 0 && item["mode"] == *mode
                && item["size"].as_u64().is_some_and(|s| s > 0) && hex64(&item["sha256"])
                && item.as_object().is_some_and(|o| o.len() == 7)
        });
    let keys_ok = plan.as_object().is_some_and(|o| o.len() == 5) && plan["version"] == 1;
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

/// Records intent before the privileged seeder runs. Requires the original
/// completed restore with no run record, and refuses any earlier seed state.
pub(super) fn begin(root: &Path, key: &str, plan: &Value) -> Result<Value> {
    validate_plan(plan)?;
    if plan["bootstrapId"] != key {
        bail!("Seed plan belongs to another bootstrap operation")
    }
    let dir = macos_provision::directory(root, key)?;
    let _lock = lock(&dir)?;
    macos_provision::created_for_bootstrap(root, key)?;
    if state_in(&dir)? != "notSeeded" {
        bail!("This VM already has seed history; it is never reseeded or replaced")
    }
    let intent = json!({"version": 1, "plan": plan, "planDigest": journal::digest(&serde_json::to_vec(plan)?),
        "createdAt": journal::now(), "ready": false});
    write_new(&dir, "seed-intent.json", &intent)?;
    Ok(json!({"seed": "seedOutcomeUnknown", "planDigest": intent["planDigest"], "ready": false}))
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
        "keyReference": intent["plan"]["keyReference"], "items": observed, "seeded": true, "ready": false});
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

    fn plan(key: &str) -> Value {
        let items: Vec<Value> = ITEMS.iter().enumerate().map(|(i, (name, path, mode))| json!({"key": name, "path": path,
            "uid": 0, "gid": 0, "mode": mode, "size": 10 + i, "sha256": format!("{i}").repeat(64)})).collect();
        json!({"version": 1, "bootstrapId": key, "seedId": "ab".repeat(16), "keyReference": journal::new_id(), "items": items})
    }

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
        let (_dir, root, key) = macos_provision::created_for_tests();
        let plan = plan(&key);
        assert!(seeded(&root, &key).is_err(), "no launch before seeding");
        assert_eq!(state(&root, &key).unwrap()["seed"], "notSeeded");
        assert_eq!(begin(&root, &key, &plan).unwrap()["seed"], "seedOutcomeUnknown");
        assert!(seeded(&root, &key).is_err(), "an unknown outcome never permits a launch");
        assert!(begin(&root, &key, &plan).is_err(), "never reseeds");
        let done = complete(&root, &key, &readback(&plan)).unwrap();
        assert_eq!(done["seed"], "seeded");
        let (receipt, digest) = seeded(&root, &key).unwrap();
        assert_eq!(digest, done["seedReceiptSha256"]);
        assert_eq!(receipt["seedId"], plan["seedId"]);
        assert!(complete(&root, &key, &readback(&plan)).is_err(), "never completes twice");
        let created = macos_provision::created_for_bootstrap(&root, &key).unwrap();
        assert_eq!(created["status"], "created", "the provisioning record is unchanged");
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
            let plan = plan(&key);
            begin(&root, &key, &plan).unwrap();
            let mut changed = readback(&plan);
            mutate(&mut changed);
            assert!(complete(&root, &key, &changed).is_err());
            assert_eq!(state(&root, &key).unwrap()["seed"], "fenced");
            assert!(complete(&root, &key, &readback(&plan)).is_err(), "a fence is not cleared by a later match");
            assert!(seeded(&root, &key).is_err());
            assert!(begin(&root, &key, &plan).is_err());
        }
    }

    #[test]
    fn plans_must_be_exact_production_items_for_this_operation() {
        let (_dir, root, key) = macos_provision::created_for_tests();
        let mutations: [fn(&mut Value); 6] = [
            |p| p["items"][0]["path"] = json!("/Library/LaunchAgents/x.plist"),
            |p| p["items"][1]["uid"] = json!(501),
            |p| p["items"][2]["mode"] = json!("0644"),
            |p| p["seedId"] = json!("AB".repeat(16)),
            |p| p["extra"] = json!(1),
            |p| p["bootstrapId"] = json!(journal::new_id()),
        ];
        for mutate in mutations {
            let mut changed = plan(&key);
            mutate(&mut changed);
            assert!(begin(&root, &key, &changed).is_err(), "{changed}");
        }
        assert_eq!(state(&root, &key).unwrap()["seed"], "notSeeded", "refusals write nothing");
    }

    #[test]
    fn seeding_needs_the_original_completed_restore_without_a_run() {
        let dir = tempfile::tempdir().unwrap();
        let key = journal::new_id();
        assert!(begin(dir.path(), &key, &plan(&key)).is_err(), "no provisioning record");
    }
}
