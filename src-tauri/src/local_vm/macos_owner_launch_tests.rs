use super::*;
use crate::local_vm::{bootstrap, macos_endpoint};
use std::{
    os::unix::fs::{DirBuilderExt, PermissionsExt},
    sync::{Arc, Barrier},
    time::{Duration, Instant},
};

fn private(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}
fn directory(path: &Path) {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .unwrap();
}
struct Fixture {
    temp: tempfile::TempDir,
    root: PathBuf,
    key: String,
    artifact: Artifact,
}
impl Fixture {
    fn new() -> Self {
        let binary = std::env::var_os("TERMINALX_BOOTSTRAP_FIXTURE")
            .expect("Explicit native fixture required");
        let bytes = std::fs::read(binary).unwrap();
        let temp = tempfile::Builder::new()
            .prefix("txl")
            .tempdir_in("/private/tmp")
            .unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let key = journal::new_id();
        let storage = root.join("macos-vms").join(&key);
        let name = format!("terminalx-{key}");
        let vm = storage.join(&name);
        directory(&vm);
        let config = json!({"os":"macOS","networkMode":"nat","macAddress":"02:00:00:00:00:01","machineIdentifier":"YWJj","hardwareModel":"ZGVm","cpuCount":4,"display":"1024x768"});
        private(
            &vm.join("config.json"),
            &serde_json::to_vec(&config).unwrap(),
        );
        for name in ["disk.img", "nvram.bin"] {
            private(&vm.join(name), b"synthetic fixture only");
        }
        let env = journal::new_id();
        let generation = journal::new_id();
        let restore = "a".repeat(64);
        let target = macos_endpoint::capture_created(
            &root,
            &key,
            &env,
            &generation,
            &restore,
            &storage,
            &name,
        )
        .unwrap();
        let intent = json!({"requestId":key,"storage":storage,"name":name,"restoreSha256":restore,"restoreBytes":25,"macosMajor":26,
            "lumeVersion":bootstrap::LUME.version,"lumeSha256":bootstrap::LUME.executable_sha256,"cpu":4,"memory":"8GB","disk":"160GB"});
        let digest = journal::digest(&serde_json::to_vec(&intent).unwrap());
        let provision = root.join("macos-provision-operations").join(&key);
        directory(&provision);
        private(&provision.join("operation.lock"), b"");
        private(&provision.join("record.json"),&serde_json::to_vec(&json!({"intent":intent,"inputDigest":digest,"environmentId":env,"generation":generation,"status":"created","ready":false,"target":target,
            "createReceipt":{"kind":"originalChildSuccess","inputDigest":digest,"ready":false}})).unwrap());
        macos_personalization::begin(
            &root,
            &key,
            &target,
            &macos_personalization::AccountPlan {
                short_name: "personal".into(),
                password_reference: journal::new_id(),
                ssh_key_reference: journal::new_id(),
            },
        )
        .unwrap();
        super::super::plan::retain_host_intent(
            &open(&provision).unwrap(),
            &super::super::plan::HostIntent {
                parent_session: journal::new_id(),
                parent_tab: journal::new_id(),
                parent_conversation: "original".into(),
                helper_sha256: "b".repeat(64),
                runtime_sha256: "c".repeat(64),
            },
        )
        .unwrap();
        let sha = journal::digest(&bytes);
        let artifact_path = root.join("bootstrap-artifacts").join(&sha).join("lume");
        directory(artifact_path.parent().unwrap());
        private(&artifact_path, &bytes);
        std::fs::set_permissions(&artifact_path, std::fs::Permissions::from_mode(0o700)).unwrap();
        let artifact = Artifact {
            pin: ArtifactPin {
                profile: PROFILE.into(),
                source_commit: UPSTREAM.into(),
                patch_sha256: journal::digest(PATCH),
                executable_sha256: sha,
                node: Node::of(&std::fs::metadata(artifact_path).unwrap()),
            },
        };
        Self {
            temp,
            root,
            key,
            artifact,
        }
    }
    fn op(&self) -> PathBuf {
        self.root.join("bo").join(&self.key)
    }
    fn provision(&self) -> PathBuf {
        self.root.join("macos-provision-operations").join(&self.key)
    }
    fn setup_fixture(&self, fault: &str) {
        let op = self.op();
        private(
            &op.join("fixture-control.json"),
            &canonical(&json!({"requests":64,"fault":fault})).unwrap(),
        );
        private(&op.join("fixture-view.json"),&canonical(&json!({"running":true,"shares":[{"name":"input","path":op.join("input"),"readOnly":true},{"name":"receipt","path":op.join("receipt"),"readOnly":false}]})).unwrap());
    }
    fn run(&self) -> Result<Value> {
        execute(
            &self.root,
            &self.key,
            &self.artifact,
            |stage| {
                if stage == "prepared" {
                    self.setup_fixture("");
                }
                Ok(())
            },
            || [23; 32],
        )
    }
    fn drain(&self) {
        let deadline = Instant::now() + Duration::from_secs(13);
        while self.op().join("spawn-armed.json").exists()
            && !self.op().join("process-exit.json").exists()
            && Instant::now() < deadline
        {
            if let Ok(reference) = Reference::reopen(&self.op()) {
                let _ = reference.observe("observe", &journal::new_id());
            }
            // No owner was spawned when the durable fence was interrupted.
            if !self.op().join("spawned.json").exists()
                && !self.op().join("fixture-exec.json").exists()
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.drain();
        let _ = &self.temp;
    }
}

#[test]
fn production_launch_cannot_acquire_an_unapproved_artifact_or_request_path() {
    let error = request(
        &json!({"idempotencyKey":journal::new_id(),"executable":"/usr/bin/true","proof":true}),
    )
    .unwrap_err();
    // A release has no approved artifact; a validation build refuses until a
    // dedicated home supplies its pins (every profile refusal says so, whatever
    // TERMINALX_HOME the test inherits). Neither takes a request-supplied
    // executable or proof.
    let expected = if cfg!(feature = "vm-validation") { "Validation" } else { "no approved" };
    assert!(error.to_string().contains(expected), "{error}");
    assert!(
        macos_provision::request("environment.runPersonalizedProvision", &json!({}))
            .unwrap_err()
            .to_string()
            .contains(expected)
    );
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_original_launch_sanitizes_process_and_reopens_same_owner() {
    let f = Fixture::new();
    let result = f.run().unwrap();
    assert_eq!(result["stage"], "originalOwnerConnected");
    assert_eq!(result["ready"], false);
    assert_eq!(result["trustAccepted"], false);
    let plan: Value =
        serde_json::from_slice(&std::fs::read(f.op().join("expected-helper.json")).unwrap())
            .unwrap();
    assert_eq!(plan["version"], 2);
    assert!(plan["binding"]["input"].get("mounted").is_none());
    assert!(plan.get("osBuild").is_none());
    assert!(!f.op().join("input/account-manifest.json").exists());
    assert!(Reference::reopen(&f.op())
        .unwrap()
        .admit("accountReceipt")
        .unwrap_err()
        .to_string()
        .contains("cannot authenticate"));
    let cap = std::fs::read(f.op().join("control.capability")).unwrap();
    assert_eq!(cap, [23; 32]);
    assert_eq!(
        std::fs::metadata(f.op().join("control.capability"))
            .unwrap()
            .mode()
            & 0o777,
        0o600
    );
    let reference = Reference::reopen(&f.op()).unwrap();
    let observation = json!({"version":1,"bindingDigest":journal::digest(&reference.raw),"ownerEpoch":reference.binding.owner_epoch,
        "challengeSha256":"a".repeat(64),"claims":{"accountName":plan["accountName"],"accountHome":plan["accountHome"],"helperSha256":plan["helperSha256"]},
        "vmRouteObserved":true,"shareRoundTripObserved":true,"accountAuthenticated":false,"helperAuthenticated":false,"trustAccepted":false,"ready":false});
    private(
        &f.op().join("guest-observation.json"),
        &canonical(&observation).unwrap(),
    );
    assert_eq!(reference.guest_observation().unwrap(), observation);
    assert_eq!(reference.guest_observation().unwrap(), observation);
    let mut forged = observation.clone();
    forged["helperAuthenticated"] = json!(true);
    private(
        &f.op().join("guest-observation.json"),
        &canonical(&forged).unwrap(),
    );
    assert!(reference.guest_observation().is_err());
    private(
        &f.op().join("guest-observation.json"),
        &canonical(&observation).unwrap(),
    );
    let before = std::fs::read(f.op().join("spawned.json")).unwrap();
    let observed: Value =
        serde_json::from_slice(&std::fs::read(f.op().join("fixture-exec.json")).unwrap()).unwrap();
    assert_eq!(observed["argv"][0], "run");
    assert_eq!(observed["argv"][3], "none");
    assert_eq!(observed["argv"][5], "disabled");
    assert_eq!(observed["environment"]["HOME"], json!(f.op().join("home")));
    for forbidden in [
        "SSH_AUTH_SOCK",
        "TERMINALX_NEXT_TOKEN",
        "OPENAI_API_KEY",
        "DYLD_INSERT_LIBRARIES",
    ] {
        assert!(observed["environment"].get(forbidden).is_none());
    }
    assert!(!observed.to_string().contains(&base64::Engine::encode(
        &base64::engine::general_purpose::STANDARD,
        &cap
    )));
    for _ in 0..3 {
        assert_eq!(f.run().unwrap()["stage"], "originalOwnerConnected");
    }
    assert_eq!(std::fs::read(f.op().join("spawned.json")).unwrap(), before);
    assert_eq!(
        std::fs::read(f.op().join("control.capability")).unwrap(),
        cap
    );
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_interrupted_launch_never_replays_or_regenerates_original_reference() {
    for stop in ["intent", "prepared", "armed", "spawned", "announcement"] {
        let f = Fixture::new();
        let _ = execute(
            &f.root,
            &f.key,
            &f.artifact,
            |stage| {
                if stage == "prepared" {
                    f.setup_fixture("");
                }
                if stage == stop {
                    bail!("synthetic interruption")
                }
                Ok(())
            },
            || [23; 32],
        );
        let cap = std::fs::read(f.op().join("control.capability")).ok();
        let armed = std::fs::read(f.op().join("spawn-armed.json")).ok();
        let result = f.run();
        if stop == "announcement" {
            assert_eq!(result.unwrap()["stage"], "originalOwnerConnected");
        } else {
            assert!(
                result.is_err() || result.as_ref().unwrap()["stage"] != "originalOwnerConnected",
                "{stop}"
            );
        }
        assert_eq!(
            std::fs::read(f.op().join("control.capability")).ok(),
            cap,
            "{stop}"
        );
        assert_eq!(
            std::fs::read(f.op().join("spawn-armed.json")).ok(),
            armed,
            "{stop}"
        );
    }
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_missing_or_partial_original_history_never_starts_an_owner() {
    for fault in [
        "intent",
        "capability",
        "prepared",
        "lock",
        "source",
        "parent",
        "account",
        "account-reference",
        "artifact",
        "artifact-inode",
    ] {
        let f = Fixture::new();
        assert!(execute(
            &f.root,
            &f.key,
            &f.artifact,
            |stage| {
                if stage == "prepared" {
                    bail!("before spawn")
                }
                Ok(())
            },
            || [23; 32]
        )
        .is_err());
        let op = f.op();
        match fault {
            "intent" => private(
                &f.provision().join("restricted-owner-intent.json"),
                b"partial",
            ),
            "capability" => private(&op.join("control.capability"), &[24; 32]),
            "prepared" => private(&op.join("prepared.json"), b"partial"),
            "lock" => std::fs::remove_file(op.join("launch.lock")).unwrap(),
            "source" => private(&f.provision().join("record.json"), b"{}"),
            "account-reference" => {
                let p = f
                    .root
                    .join("macos-personalization")
                    .join(&f.key)
                    .join("record.json");
                let mut value: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
                value["intent"]["account"]["sshKeyReference"] = json!(journal::new_id());
                value["inputDigest"] = json!(journal::digest(
                    &serde_json::to_vec(&value["intent"]).unwrap()
                ));
                private(&p, &serde_json::to_vec(&value).unwrap());
            }
            "parent" | "account" => {
                let p = f.provision().join("owner-helper-plan.json");
                let mut value: Value = serde_json::from_slice(&std::fs::read(&p).unwrap()).unwrap();
                if fault == "parent" {
                    value["binding"]["parentSession"] = json!(journal::new_id());
                } else {
                    value["accountName"] = json!("someoneelse");
                    value["accountHome"] = json!("/Users/someoneelse");
                }
                private(&p, &serde_json::to_vec(&value).unwrap());
            }
            "artifact" => private(&f.artifact.path(&f.root), b"changed executable"),
            _ => {
                let path = f.artifact.path(&f.root);
                let bytes = std::fs::read(&path).unwrap();
                std::fs::rename(&path, path.with_extension("retained")).unwrap();
                private(&path, &bytes);
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        assert!(f.run().is_err(), "{fault}");
        assert!(!op.join("fixture-exec.json").exists(), "{fault}");
        assert!(!op.join("spawned.json").exists(), "{fault}");
    }
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_competing_launchers_use_original_provisioning_lock_and_single_child() {
    let f = Arc::new(Fixture::new());
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let (worker, started, finish) = (f.clone(), entered.clone(), release.clone());
    let thread = std::thread::spawn(move || {
        execute(
            &worker.root,
            &worker.key,
            &worker.artifact,
            |stage| {
                if stage == "prepared" {
                    worker.setup_fixture("");
                    started.wait();
                    finish.wait();
                }
                Ok(())
            },
            || [23; 32],
        )
    });
    entered.wait();
    assert!(f.run().unwrap_err().to_string().contains("still owned"));
    release.wait();
    assert_eq!(
        thread.join().unwrap().unwrap()["stage"],
        "originalOwnerConnected"
    );
    let first = std::fs::read(f.op().join("spawned.json")).unwrap();
    assert_eq!(f.run().unwrap()["stage"], "originalOwnerConnected");
    assert_eq!(std::fs::read(f.op().join("spawned.json")).unwrap(), first);
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_changed_vm_at_dispatch_is_refused_without_process_effect() {
    for name in ["config.json", "disk.img", "nvram.bin"] {
        let f = Fixture::new();
        let result = execute(
            &f.root,
            &f.key,
            &f.artifact,
            |stage| {
                if stage == "prepared" {
                    f.setup_fixture("");
                }
                if stage == "armed" {
                    let path = f
                        .root
                        .join("macos-vms")
                        .join(&f.key)
                        .join(format!("terminalx-{}", f.key))
                        .join(name);
                    std::fs::rename(&path, path.with_extension("retained"))?;
                    private(&path, b"replaced");
                }
                Ok(())
            },
            || [23; 32],
        );
        assert!(result.is_err());
        assert!(f.op().join("spawn-armed.json").exists());
        assert!(!f.op().join("fixture-exec.json").exists());
        assert!(f.run().is_err());
    }
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_exit_or_lost_startup_announcement_is_recorded_without_replacement() {
    for fault in ["beforeReceive", "afterReceive", ""] {
        let f = Fixture::new();
        let _ = execute(
            &f.root,
            &f.key,
            &f.artifact,
            |stage| {
                if stage == "prepared" {
                    f.setup_fixture(fault);
                }
                Ok(())
            },
            || [23; 32],
        );
        f.drain();
        let spawn = std::fs::read(f.op().join("spawned.json")).unwrap();
        assert_eq!(f.run().unwrap()["stage"], "originalChildExited");
        assert_eq!(std::fs::read(f.op().join("spawned.json")).unwrap(), spawn);
        assert_eq!(f.run().unwrap()["replacementAllowed"], false);
    }
}

/// Exact seed readback for the recorded intent, as the seeder core reports it.
fn seed(f: &Fixture) {
    use crate::local_vm::macos_seed;
    macos_seed::begin(&f.root, &f.key, (492, &"a".repeat(64)), (643392, &"b".repeat(64))).unwrap();
    let intent: Value = serde_json::from_slice(&std::fs::read(f.provision().join("seed-intent.json")).unwrap()).unwrap();
    let items: Vec<Value> = intent["plan"]["items"].as_array().unwrap().iter().map(|item| {
        let mut item = item.clone();
        item["xattrs"] = json!([]);
        item
    }).collect();
    macos_seed::complete(&f.root, &f.key, &json!({"version":1,"profile":"production","device":1,"items":items,"matchesReceipt":true})).unwrap();
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_unresolved_seed_never_launches() {
    let f = Fixture::new();
    crate::local_vm::macos_seed::begin(&f.root, &f.key, (492, &"a".repeat(64)), (643392, &"b".repeat(64))).unwrap();
    assert!(f.run().unwrap_err().to_string().contains("unresolved or fenced"));
    assert!(!f.op().join("owner-intent.json").exists());
    assert!(!f.op().join("enrollment.key").exists());
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_seeded_launch_binds_version_3_and_accepts_only_exact_helper_enrollment() {
    let f = Fixture::new();
    seed(&f);
    let result = f.run().unwrap();
    assert_eq!((result["stage"].as_str(), result["ready"].as_bool()), (Some("originalOwnerConnected"), Some(false)));
    let reference = Reference::reopen(&f.op()).unwrap();
    let (receipt, receipt_digest) = crate::local_vm::macos_seed::seeded(&f.root, &f.key).unwrap();
    assert_eq!(reference.binding.version, 3);
    assert_eq!(reference.binding.seed_id.as_deref(), receipt["seedId"].as_str());
    assert_eq!(reference.binding.seed_receipt_sha256.as_deref(), Some(receipt_digest.as_str()));
    let handed = std::fs::read(f.op().join("enrollment.key")).unwrap();
    assert_eq!(handed, crate::local_vm::macos_seed::owner_key(&f.root, &f.key).unwrap());
    assert_eq!(std::fs::metadata(f.op().join("enrollment.key")).unwrap().mode() & 0o777, 0o600);
    let observed = std::fs::read_to_string(f.op().join("fixture-exec.json")).unwrap();
    assert!(!observed.contains(std::str::from_utf8(&handed).unwrap()), "the key never reaches argv or environment");
    let raw = std::fs::read(f.op().join("owner-intent.json")).unwrap();
    assert!(!String::from_utf8_lossy(&raw).contains(std::str::from_utf8(&handed).unwrap()), "nor the binding");

    let enrollment = json!({"version":2,"bindingDigest":journal::digest(&reference.raw),"ownerEpoch":reference.binding.owner_epoch,
        "bootstrapId":f.key,"seedId":receipt["seedId"],"seedReceiptSha256":receipt_digest,"attempt":0,
        "challengeSha256":"c".repeat(64),"claimsSha256":"d".repeat(64),
        "helperAuthenticated":true,"accountAuthenticated":false,"trustAccepted":false,"ready":false});
    private(&f.op().join("enrollment.json"), &canonical(&enrollment).unwrap());
    let enrolled = reference.enrollment().unwrap();
    assert_eq!(enrolled.challenge_sha256, "c".repeat(64));
    assert_eq!(enrolled, reference.enrollment().unwrap(), "rereading never changes it");
    assert!(reference.guest_observation().is_err(), "version 3 has no share observation");
    for (field, value) in [("trustAccepted", json!(true)), ("accountAuthenticated", json!(true)), ("ready", json!(true)),
        ("seedId", json!("0".repeat(32))), ("bindingDigest", json!("e".repeat(64))), ("helperAuthenticated", json!(false))] {
        let mut forged = enrollment.clone();
        forged[field] = value;
        std::fs::remove_file(f.op().join("enrollment.json")).unwrap();
        private(&f.op().join("enrollment.json"), &canonical(&forged).unwrap());
        assert!(reference.enrollment().is_err(), "{field}");
    }
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_owner_mediated_stop_is_recorded_once_and_exit_comes_from_the_child_wait() {
    let f = Fixture::new();
    seed(&f);
    assert_eq!(f.run().unwrap()["stage"], "originalOwnerConnected");
    let reference = Reference::reopen(&f.op()).unwrap();
    let stopped = reference.stop().unwrap();
    assert_eq!((stopped["stopRequested"].as_bool(), stopped["exitConfirmed"].as_bool()), (Some(true), Some(false)));
    let recorded = std::fs::read(f.op().join("stop-requested.json")).unwrap();
    f.drain();
    assert_eq!(f.run().unwrap()["stage"], "originalChildExited");
    assert_eq!(f.run().unwrap()["replacementAllowed"], false);
    assert!(reference.stop().is_err(), "no owner remains to stop again");
    assert_eq!(std::fs::read(f.op().join("stop-requested.json")).unwrap(), recorded);
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_version_2_owner_has_no_stop() {
    let f = Fixture::new();
    assert_eq!(f.run().unwrap()["stage"], "originalOwnerConnected");
    let reference = Reference::reopen(&f.op()).unwrap();
    assert!(reference.stop().is_err());
    assert!(!f.op().join("stop-requested.json").exists());
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_only_the_persons_confirmation_from_the_original_parent_is_relayed_once() {
    let f = Fixture::new();
    seed(&f);
    assert_eq!(f.run().unwrap()["stage"], "originalOwnerConnected");
    let reference = Reference::reopen(&f.op()).unwrap();
    let digest = journal::digest(&reference.raw);
    let account = |name: &str, uid: u32| json!({"gid": 20, "home": format!("/Users/{name}"), "homeDevice": 1, "homeInode": uid + 100, "name": name, "uid": uid});
    let observation = canonical(&json!({"version": 1, "bindingDigest": digest, "ownerEpoch": reference.binding.owner_epoch,
        "challengeSha256": "c".repeat(64), "accounts": [account("personal", 501), account("other", 502)],
        "helperAuthenticated": true, "accountAuthenticated": false, "trustAccepted": false, "ready": false})).unwrap();
    private(&f.op().join("account-observation.json"), &observation);
    let (bytes, observed) = reference.account_observation().unwrap();
    assert_eq!(bytes, observation);
    let confirmation = |chosen: Value, session: &str| super::super::AccountConfirmation {
        confirm: true, observation_sha256: journal::digest(&observation), account: chosen,
        parent_session: session.into(), parent_tab: reference.binding.parent_tab.clone(),
        parent_conversation: reference.binding.parent_conversation.clone(),
    };
    let original = reference.binding.parent_session.clone();
    assert!(reference.confirm_account(&confirmation(observed["accounts"][0].clone(), &journal::new_id())).is_err(), "another parent");
    assert!(reference.confirm_account(&confirmation(account("ghost", 503), &original)).is_err(), "unobserved account");
    let mut unconfirmed = confirmation(observed["accounts"][0].clone(), &original);
    unconfirmed.confirm = false;
    assert!(reference.confirm_account(&unconfirmed).is_err());
    assert!(!f.op().join("account-confirmation.json").exists(), "refusals record nothing");
    let relay = reference.confirm_account(&confirmation(observed["accounts"][0].clone(), &original)).unwrap();
    assert_eq!((relay["relayed"].as_bool(), relay["accountAuthenticated"].as_bool()), (Some(true), Some(false)));
    let recorded = std::fs::read(f.op().join("account-confirmation.json")).unwrap();
    assert_eq!(reference.confirm_account(&confirmation(observed["accounts"][0].clone(), &original)).unwrap(), relay, "a retry relays the same record");
    assert!(reference.confirm_account(&confirmation(observed["accounts"][1].clone(), &original)).is_err(), "never re-chosen");
    assert_eq!(std::fs::read(f.op().join("account-confirmation.json")).unwrap(), recorded);
    let answer = json!({"version": 1, "bindingDigest": digest, "ownerEpoch": reference.binding.owner_epoch,
        "confirmationSha256": journal::digest(&recorded), "account": observed["accounts"][0], "outcome": "confirmed",
        "accountAuthenticated": true, "trustAccepted": false, "ready": false});
    private(&f.op().join("account-confirmation-answer.json"), &canonical(&answer).unwrap());
    assert_eq!(reference.account_answer().unwrap(), answer);
    let mut forged = answer.clone();
    forged["trustAccepted"] = json!(true);
    std::fs::remove_file(f.op().join("account-confirmation-answer.json")).unwrap();
    private(&f.op().join("account-confirmation-answer.json"), &canonical(&forged).unwrap());
    assert!(reference.account_answer().is_err());
}

/// A synthetic OpenSSH producer next to `public-key`; counts generations.
fn producer(f: &Fixture, fill: u8) -> (PathBuf, String) {
    use base64::Engine;
    let mut bytes = 11_u32.to_be_bytes().to_vec();
    bytes.extend(b"ssh-ed25519");
    bytes.extend(32_u32.to_be_bytes());
    bytes.extend([fill; 32]);
    let public = format!("ssh-ed25519 {}", base64::engine::general_purpose::STANDARD.encode(bytes));
    let dir = f.root.join("synthetic-producer");
    directory(&dir);
    std::fs::write(dir.join("public-key"), &public).unwrap();
    let utility = dir.join("ssh-keygen");
    std::fs::write(&utility, r#"#!/usr/bin/python3
import sys,pathlib
root=pathlib.Path(__file__).parent;a=sys.argv[1:]
if a[:2]==['-y','-f']:
 assert pathlib.Path(a[2]).read_bytes()==b'synthetic fixture material, never a real key'
 print((root/'public-key').read_text());sys.exit(0)
assert a[:8]==['-q','-t','ed25519','-N','','-C','terminalx-local-vm','-f'] and len(a)==9
with (root/'generation-count').open('a') as out:out.write('once\n')
p=pathlib.Path(a[8]);p.write_bytes(b'synthetic fixture material, never a real key')
if (root/'partial-output').exists():sys.exit(71)
p.with_name(p.name+'.pub').write_text((root/'public-key').read_text()+' terminalx-local-vm\n')
"#).unwrap();
    std::fs::set_permissions(&utility, std::fs::Permissions::from_mode(0o700)).unwrap();
    (utility, public)
}
fn generations(f: &Fixture) -> usize {
    std::fs::read_to_string(f.root.join("synthetic-producer/generation-count")).map(|s| s.lines().count()).unwrap_or(0)
}
fn replace(path: &Path, bytes: &[u8]) {
    let _ = std::fs::remove_file(path);
    private(path, bytes);
}
/// The owner's enrollment and the helper's account observation, then the
/// person's confirmation of `personal` from the original parent. Returns the
/// chosen account and the recorded confirmation.
fn confirmed_choice(f: &Fixture, reference: &Reference) -> (Value, Vec<u8>) {
    choose(f, reference, 0)
}
/// As `confirmed_choice`, choosing the `pick`th reported account (`personal`, `other`).
fn choose(f: &Fixture, reference: &Reference, pick: usize) -> (Value, Vec<u8>) {
    let digest = journal::digest(&reference.raw);
    let (receipt, receipt_digest) = crate::local_vm::macos_seed::seeded(&f.root, &f.key).unwrap();
    private(&f.op().join("enrollment.json"), &canonical(&json!({"version":2,"bindingDigest":digest,"ownerEpoch":reference.binding.owner_epoch,
        "bootstrapId":f.key,"seedId":receipt["seedId"],"seedReceiptSha256":receipt_digest,"attempt":0,
        "challengeSha256":"c".repeat(64),"claimsSha256":"d".repeat(64),
        "helperAuthenticated":true,"accountAuthenticated":false,"trustAccepted":false,"ready":false})).unwrap());
    let account = |name: &str, uid: u32| json!({"gid": 20, "home": format!("/Users/{name}"), "homeDevice": 1, "homeInode": uid + 100, "name": name, "uid": uid});
    let observation = canonical(&json!({"version": 1, "bindingDigest": digest, "ownerEpoch": reference.binding.owner_epoch,
        "challengeSha256": "c".repeat(64), "accounts": [account("personal", 501), account("other", 502)], "helperAuthenticated": true,
        "accountAuthenticated": false, "trustAccepted": false, "ready": false})).unwrap();
    private(&f.op().join("account-observation.json"), &observation);
    let chosen = [account("personal", 501), account("other", 502)][pick].clone();
    reference.confirm_account(&super::super::AccountConfirmation {
        confirm: true, observation_sha256: journal::digest(&observation), account: chosen.clone(),
        parent_session: reference.binding.parent_session.clone(), parent_tab: reference.binding.parent_tab.clone(),
        parent_conversation: reference.binding.parent_conversation.clone(),
    }).unwrap();
    (chosen, std::fs::read(f.op().join("account-confirmation.json")).unwrap())
}
fn answer(reference: &Reference, recorded: &[u8], account: &Value, outcome: &str) -> Vec<u8> {
    canonical(&json!({"version": 1, "bindingDigest": journal::digest(&reference.raw), "ownerEpoch": reference.binding.owner_epoch,
        "confirmationSha256": journal::digest(recorded), "account": account, "outcome": outcome,
        "accountAuthenticated": outcome == "confirmed", "trustAccepted": false, "ready": false})).unwrap()
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_the_vms_original_key_follows_only_the_helpers_acknowledgement_and_is_granted_once() {
    let f = Fixture::new();
    seed(&f);
    assert_eq!(f.run().unwrap()["stage"], "originalOwnerConnected");
    let reference = Reference::reopen(&f.op()).unwrap();
    let digest = journal::digest(&reference.raw);
    let (utility, public) = producer(&f, 7);
    let budget = Duration::from_secs(5);
    let grant = |reference: &Reference| reference.grant_guest_key_using(&f.root, &utility, budget);
    let (account, recorded) = confirmed_choice(&f, &reference);
    let parents = json!({"parentSession": reference.binding.parent_session, "parentTab": reference.binding.parent_tab,
        "parentConversation": reference.binding.parent_conversation});
    let stage = || super::super::confirmations_in(&f.root.join("bo"), &parents).unwrap()["bootstraps"][0]["key"].clone();

    // Before the helper's acknowledgement, and after its refusal, nothing is bound or generated.
    assert!(grant(&reference).is_err(), "no acknowledgement yet");
    assert_eq!(stage(), Value::Null);
    private(&f.op().join("account-confirmation-answer.json"), &answer(&reference, &recorded, &account, "refused"));
    assert!(grant(&reference).is_err(), "the helper refused the account");
    assert!(!f.op().join("key-intent.json").exists() && !f.root.join("macos-personalization-keys").exists());
    assert_eq!(generations(&f), 0);

    replace(&f.op().join("account-confirmation-answer.json"), &answer(&reference, &recorded, &account, "confirmed"));
    assert_eq!(stage()["stage"], "notGranted");
    let relay = grant(&reference).unwrap();
    let intent: Value = serde_json::from_slice(&std::fs::read(f.op().join("key-intent.json")).unwrap()).unwrap();
    let key_reference = intent["keyReference"].as_str().unwrap().to_string();
    let plan: Value = serde_json::from_slice(&std::fs::read(f.root.join("macos-personalization").join(&f.key).join("record.json")).unwrap()).unwrap();
    assert_eq!(plan["intent"]["account"]["sshKeyReference"], key_reference.as_str(), "the provisioning plan's original reference");
    assert_eq!(intent["binding"]["accountIntentDigest"], journal::digest(&serde_json::to_vec(&plan["intent"]).unwrap()).as_str());
    assert_eq!(intent["binding"]["account"], account);
    assert_eq!(intent["binding"]["seedId"], reference.binding.seed_id.as_deref().unwrap());
    assert_eq!(intent["binding"]["enrollment"]["challengeSha256"], "c".repeat(64));
    assert_eq!(intent["binding"]["parentConversation"], reference.binding.parent_conversation.as_str());
    assert_eq!(relay, json!({"version": 1, "bindingDigest": digest, "ownerEpoch": reference.binding.owner_epoch,
        "grantSha256": journal::digest(&std::fs::read(f.op().join("key-grant.json")).unwrap()), "keyReference": key_reference,
        "publicKey": public, "account": {"name": "personal", "uid": 501}, "relayed": true, "installed": false,
        "trustAccepted": false, "ready": false}));
    assert_eq!(stage()["stage"], "grantPending");
    let granted = std::fs::read(f.op().join("key-grant.json")).unwrap();

    // Lost replies and retries return the same grant; nothing is generated again.
    for _ in 0..2 {
        assert_eq!(grant(&Reference::reopen(&f.op()).unwrap()).unwrap(), relay);
    }
    assert_eq!(generations(&f), 1);
    assert_eq!(std::fs::read(f.op().join("key-grant.json")).unwrap(), granted);

    // A replaced enrollment or answer is refused; the original key is never re-bound.
    let enrollment = std::fs::read(f.op().join("enrollment.json")).unwrap();
    let mut changed: Value = serde_json::from_slice(&enrollment).unwrap();
    changed["challengeSha256"] = json!("e".repeat(64));
    replace(&f.op().join("enrollment.json"), &canonical(&changed).unwrap());
    assert!(format!("{:#}", grant(&reference).unwrap_err()).contains("belongs to another"));
    replace(&f.op().join("enrollment.json"), &enrollment);
    let other = json!({"gid": 20, "home": "/Users/other", "homeDevice": 1, "homeInode": 602, "name": "other", "uid": 502});
    replace(&f.op().join("account-confirmation-answer.json"), &answer(&reference, &recorded, &other, "confirmed"));
    assert!(grant(&reference).is_err(), "another account");
    replace(&f.op().join("account-confirmation-answer.json"), &answer(&reference, &recorded, &account, "confirmed"));
    assert_eq!(grant(&reference).unwrap(), relay);
    assert_eq!(generations(&f), 1);

    // The private key stays in its owner-only reference: no journal or relay names it.
    let private = std::fs::read(f.root.join("macos-personalization-keys").join(&key_reference).join("private_key")).unwrap();
    for entry in std::fs::read_dir(f.op()).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            let text = std::fs::read(&path).unwrap();
            assert!(!text.windows(private.len()).any(|w| w == private.as_slice()), "{path:?}");
        }
    }

    // Only the helper's own result counts; unknown or refused never becomes success.
    let result = |stage: &str, installed: bool| canonical(&json!({"version": 1, "bindingDigest": digest, "ownerEpoch": reference.binding.owner_epoch,
        "grantSha256": journal::digest(&granted), "keyReference": key_reference, "stage": stage, "installed": installed,
        "trustAccepted": false, "ready": false})).unwrap();
    for (outcome, installed) in [("refused", false), ("outcomeUnknown", false), ("publicKeyInstalled", true)] {
        replace(&f.op().join("key-install-result.json"), &result(outcome, installed));
        let reported = stage();
        assert_eq!((reported["stage"].as_str(), reported["installed"].as_bool()), (Some(outcome), Some(installed)));
        assert_eq!((reported["trustAccepted"].as_bool(), reported["ready"].as_bool()), (Some(false), Some(false)));
    }
    replace(&f.op().join("key-install-result.json"), &result("outcomeUnknown", true));
    assert!(reference.key_result().is_err(), "an unknown outcome never reads as installed");
    let mut elsewhere = parents.clone();
    elsewhere["parentTab"] = json!(journal::new_id());
    assert_eq!(super::super::confirmations_in(&f.root.join("bo"), &elsewhere).unwrap()["bootstraps"], json!([]), "another tab sees nothing");
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_an_interrupted_key_creation_is_pending_and_never_repeated_or_granted() {
    let f = Fixture::new();
    seed(&f);
    assert_eq!(f.run().unwrap()["stage"], "originalOwnerConnected");
    let reference = Reference::reopen(&f.op()).unwrap();
    let (utility, _) = producer(&f, 7);
    let (account, recorded) = confirmed_choice(&f, &reference);
    private(&f.op().join("account-confirmation-answer.json"), &answer(&reference, &recorded, &account, "confirmed"));
    std::fs::write(f.root.join("synthetic-producer/partial-output"), b"").unwrap();
    assert!(reference.grant_guest_key_using(&f.root, &utility, Duration::from_secs(5)).is_err());
    std::fs::remove_file(f.root.join("synthetic-producer/partial-output")).unwrap();
    for _ in 0..2 {
        assert!(reference.grant_guest_key_using(&f.root, &utility, Duration::from_secs(5)).is_err());
    }
    assert_eq!(generations(&f), 1);
    assert!(!f.op().join("key-grant.json").exists(), "an unknown key is never granted");
    let parents = json!({"parentSession": reference.binding.parent_session, "parentTab": reference.binding.parent_tab,
        "parentConversation": reference.binding.parent_conversation});
    let listed = super::super::confirmations_in(&f.root.join("bo"), &parents).unwrap();
    assert_eq!(listed["bootstraps"][0]["key"]["stage"], "keyPending");
}

/// Through the produced grant and the helper's own `publicKeyInstalled`.
fn installed(f: &Fixture, pick: usize) -> (Reference, Vec<u8>) {
    seed(f);
    assert_eq!(f.run().unwrap()["stage"], "originalOwnerConnected");
    let reference = Reference::reopen(&f.op()).unwrap();
    let (utility, _) = producer(f, 7);
    let (account, recorded) = choose(f, &reference, pick);
    private(&f.op().join("account-confirmation-answer.json"), &answer(&reference, &recorded, &account, "confirmed"));
    let relay = reference.grant_guest_key_using(&f.root, &utility, Duration::from_secs(5)).unwrap();
    let grant = std::fs::read(f.op().join("key-grant.json")).unwrap();
    let result = canonical(&json!({"version": 1, "bindingDigest": journal::digest(&reference.raw), "ownerEpoch": reference.binding.owner_epoch,
        "grantSha256": journal::digest(&grant), "keyReference": relay["keyReference"], "stage": "publicKeyInstalled", "installed": true,
        "trustAccepted": false, "ready": false})).unwrap();
    private(&f.op().join("key-install-result.json"), &result);
    (reference, result)
}
fn host_key_observation(f: &Fixture, reference: &Reference, result: &[u8], fill: u8) -> (Vec<u8>, String) {
    use base64::Engine;
    let mut bytes = 11_u32.to_be_bytes().to_vec();
    bytes.extend(b"ssh-ed25519");
    bytes.extend(32_u32.to_be_bytes());
    bytes.extend([fill; 32]);
    let host_key = format!("ssh-ed25519 {}", base64::engine::general_purpose::STANDARD.encode(bytes));
    let grant = std::fs::read(f.op().join("key-grant.json")).unwrap();
    let observation = canonical(&json!({"version": 1, "bindingDigest": journal::digest(&reference.raw), "ownerEpoch": reference.binding.owner_epoch,
        "grantSha256": journal::digest(&grant), "keyResultSha256": journal::digest(result),
        "keyReference": serde_json::from_slice::<Value>(result).unwrap()["keyReference"], "hostKey": host_key, "observed": true,
        "trustAccepted": false, "ready": false})).unwrap();
    replace(&f.op().join("host-key-observation.json"), &observation);
    (observation, host_key)
}
fn host_key_confirmation(reference: &Reference, observation: &[u8], fingerprint: &str) -> super::super::HostKeyConfirmation {
    super::super::HostKeyConfirmation {
        confirm: true, observation_sha256: journal::digest(observation), fingerprint: fingerprint.into(),
        parent_session: reference.binding.parent_session.clone(), parent_tab: reference.binding.parent_tab.clone(),
        parent_conversation: reference.binding.parent_conversation.clone(),
    }
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_the_persons_review_pins_only_the_owner_observed_host_key_once_and_a_changed_key_is_never_pinned() {
    let f = Fixture::new();
    let (reference, result) = installed(&f, 0);
    let parents = json!({"parentSession": reference.binding.parent_session, "parentTab": reference.binding.parent_tab,
        "parentConversation": reference.binding.parent_conversation});
    let status = || super::super::confirmations_in(&f.root.join("bo"), &parents).unwrap()["bootstraps"][0]["hostKey"].clone();
    assert_eq!(status()["stage"], "awaitingHostKey");
    let (observation, host_key) = host_key_observation(&f, &reference, &result, 9);
    let fingerprint = crate::local_vm::macos_personalization::public_key(&host_key).unwrap();
    let pending = status();
    assert_eq!((pending["stage"].as_str(), pending["fingerprint"].as_str(), pending["sshVerified"].as_bool(), pending["ready"].as_bool()),
        (Some("awaitingReview"), Some(fingerprint.as_str()), Some(false), Some(false)));

    // Nothing is pinned without the exact fingerprint shown, from the original parent.
    let mut refused = vec![host_key_confirmation(&reference, &observation, "SHA256:another"),
        host_key_confirmation(&reference, b"another observation", &fingerprint)];
    let mut unconfirmed = host_key_confirmation(&reference, &observation, &fingerprint);
    unconfirmed.confirm = false;
    let mut elsewhere = host_key_confirmation(&reference, &observation, &fingerprint);
    elsewhere.parent_tab = journal::new_id();
    refused.extend([unconfirmed, elsewhere]);
    for confirmation in &refused {
        assert!(reference.confirm_host_key(&f.root, confirmation).is_err());
    }
    assert!(!f.op().join("host-key-confirmation.json").exists());
    let ledger = |f: &Fixture| serde_json::from_slice::<Value>(&std::fs::read(f.root.join("macos-personalization").join(&f.key).join("record.json")).unwrap()).unwrap();
    assert_eq!(ledger(&f)["status"], "planned");

    let confirmed = reference.confirm_host_key(&f.root, &host_key_confirmation(&reference, &observation, &fingerprint)).unwrap();
    assert_eq!((confirmed["hostKeyConfirmed"].as_bool(), confirmed["sshVerified"].as_bool(), confirmed["ready"].as_bool(),
        confirmed["ledgerStatus"].as_str()), (Some(true), Some(false), Some(false), Some("trustObserved")));
    assert_eq!(reference.confirm_host_key(&f.root, &host_key_confirmation(&reference, &observation, &fingerprint)).unwrap()["confirmation"],
        confirmed["confirmation"], "a retry returns the same confirmation");
    assert_eq!(status()["stage"], "confirmed");

    // The existing strict plan pins exactly this key; no accept-new, no other source.
    let record = ledger(&f);
    let target: crate::local_vm::macos_personalization::Target = serde_json::from_value(record["intent"]["target"].clone()).unwrap();
    let retained = crate::local_vm::macos_personalization::retained(&f.root, &f.key, &target).unwrap();
    assert_eq!((retained.trust.host_key.as_str(), retained.account.account.short_name.as_str()), (host_key.as_str(), "personal"));
    let plan = crate::local_vm::macos_personalization::ssh_plan(&f.root, &f.key, &target, "192.168.64.7".parse().unwrap(), &"c".repeat(64), "status", json!({})).unwrap();
    assert!(plan.known_hosts.ends_with(&format!(" {host_key}\n")) && plan.known_hosts.lines().count() == 1);
    assert!(plan.args.iter().any(|a| a == "StrictHostKeyChecking=yes") && !plan.args.iter().any(|a| a.contains("accept-new") || a.contains("StrictHostKeyChecking=no")));
    assert!(plan.args.iter().any(|a| a.ends_with(&format!("{}/private_key", record["intent"]["account"]["sshKeyReference"].as_str().unwrap()))),
        "the produced original key is the only identity");

    // A changed observation is shown as changed and is never pinned.
    let (changed, changed_key) = host_key_observation(&f, &reference, &result, 10);
    assert_eq!(status()["stage"], "changed");
    let changed_fingerprint = crate::local_vm::macos_personalization::public_key(&changed_key).unwrap();
    let error = reference.confirm_host_key(&f.root, &host_key_confirmation(&reference, &changed, &changed_fingerprint)).unwrap_err();
    assert!(format!("{error:#}").contains("never replaced"), "{error:#}");
    assert_eq!(ledger(&f)["trustReceipt"], record["trustReceipt"]);
    assert_eq!(crate::local_vm::macos_personalization::retained(&f.root, &f.key, &target).unwrap().trust.host_key, host_key);
}

#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_no_host_key_is_pinned_before_the_helpers_install_or_for_an_unplanned_account() {
    let f = Fixture::new();
    seed(&f);
    assert_eq!(f.run().unwrap()["stage"], "originalOwnerConnected");
    let reference = Reference::reopen(&f.op()).unwrap();
    let (utility, _) = producer(&f, 7);
    let (account, recorded) = confirmed_choice(&f, &reference);
    private(&f.op().join("account-confirmation-answer.json"), &answer(&reference, &recorded, &account, "confirmed"));
    let relay = reference.grant_guest_key_using(&f.root, &utility, Duration::from_secs(5)).unwrap();
    let grant = std::fs::read(f.op().join("key-grant.json")).unwrap();
    let refused = canonical(&json!({"version": 1, "bindingDigest": journal::digest(&reference.raw), "ownerEpoch": reference.binding.owner_epoch,
        "grantSha256": journal::digest(&grant), "keyReference": relay["keyReference"], "stage": "refused", "installed": false,
        "trustAccepted": false, "ready": false})).unwrap();
    private(&f.op().join("key-install-result.json"), &refused);
    let (observation, host_key) = host_key_observation(&f, &reference, &refused, 9);
    let fingerprint = crate::local_vm::macos_personalization::public_key(&host_key).unwrap();
    assert!(reference.confirm_host_key(&f.root, &host_key_confirmation(&reference, &observation, &fingerprint)).is_err(), "after a refused install");
    assert!(!f.op().join("host-key-confirmation.json").exists());
    drop(reference);

    // The person confirmed `other`, not the account planned at Create.
    let g = Fixture::new();
    let (reference, result) = installed(&g, 1);
    let (observation, host_key) = host_key_observation(&g, &reference, &result, 9);
    let fingerprint = crate::local_vm::macos_personalization::public_key(&host_key).unwrap();
    let error = reference.confirm_host_key(&g.root, &host_key_confirmation(&reference, &observation, &fingerprint)).unwrap_err();
    assert!(format!("{error:#}").contains("not the account planned"), "{error:#}");
    assert!(!g.op().join("host-key-confirmation.json").exists());
}
