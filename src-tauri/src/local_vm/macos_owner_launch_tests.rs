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
            &canonical(&json!({"requests":24,"fault":fault})).unwrap(),
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
    assert!(error.to_string().contains("no approved"));
    assert!(
        macos_provision::request("environment.runPersonalizedProvision", &json!({}))
            .unwrap_err()
            .to_string()
            .contains("no approved")
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
