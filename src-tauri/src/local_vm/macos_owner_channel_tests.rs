use super::*;
use std::{
    fs::Permissions,
    os::unix::{
        fs::{DirBuilderExt, PermissionsExt},
        process::CommandExt,
    },
    process::{Child, Command, Stdio},
};

struct Fixture {
    _temp: tempfile::TempDir,
    op: PathBuf,
    reference: Reference,
    account: Value,
    installed: Value,
}
fn private(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, Permissions::from_mode(0o600)).unwrap();
}
fn pin(path: &Path) -> Pin {
    let meta = std::fs::metadata(path).unwrap();
    Pin {
        path: path.into(),
        device: meta.dev(),
        inode: meta.ino(),
    }
}
impl Fixture {
    fn new(binary: Option<&Path>) -> Self {
        let temp = tempfile::Builder::new()
            .prefix("txo-")
            .tempdir_in("/private/tmp")
            .unwrap();
        let base = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&base, Permissions::from_mode(0o700)).unwrap();
        let op = base.join("op");
        let vm = base.join("vm");
        for path in [&op, &vm, &op.join("input"), &op.join("receipt")] {
            std::fs::DirBuilder::new().mode(0o700).create(path).unwrap();
        }
        private(&vm.join("config.json"), b"{\"os\":\"macOS\"}");
        for name in ["disk.img", "nvram.bin"] {
            private(&vm.join(name), b"synthetic fixture bytes");
        }
        let paths: BTreeMap<String, Pin> = [
            ("operation", op.clone()),
            ("storage", base.clone()),
            ("vm", vm.clone()),
            ("config", vm.join("config.json")),
            ("disk", vm.join("disk.img")),
            ("nvram", vm.join("nvram.bin")),
            ("input", op.join("input")),
            ("output", op.join("receipt")),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), pin(&v)))
        .collect();
        let (manifest, account, key, installed) = macos_bootstrap_helper::owner_test_receipts(
            (paths["input"].device, paths["input"].inode),
            (paths["output"].device, paths["output"].inode),
        );
        let h = &manifest["binding"];
        let get = |v: &Value| v.as_str().unwrap().to_owned();
        let helper_bytes = serde_json::to_vec(&manifest).unwrap();
        let binding = Binding {
            version: 1,
            macos_major: 26,
            bootstrap_id: get(&h["bootstrapId"]),
            owner_epoch: get(&h["ownerEpoch"]),
            nonce: get(&h["nonce"]),
            environment_id: get(&h["target"]["environmentId"]),
            generation: get(&h["target"]["generation"]),
            vm_fingerprint: get(&h["target"]["vmFingerprint"]),
            restore_sha256: get(&h["target"]["restoreSha256"]),
            runtime_sha256: get(&manifest["runtimeSha256"]),
            helper_manifest_sha256: journal::digest(&helper_bytes),
            executable_sha256: binary
                .map(|p| journal::digest(&std::fs::read(p).unwrap()))
                .unwrap_or_else(|| "a".repeat(64)),
            parent_session: get(&h["parentSession"]),
            parent_tab: get(&h["parentTab"]),
            parent_conversation: get(&h["parentConversation"]),
            input_share_id: get(&h["input"]["id"]),
            output_share_id: get(&h["output"]["id"]),
            config_sha256: journal::digest(&std::fs::read(vm.join("config.json")).unwrap()),
            paths,
        };
        private(
            &op.join("owner-intent.json"),
            &canonical(&json!(binding)).unwrap(),
        );
        private(&op.join("expected-helper.json"), &helper_bytes);
        private(
            &op.join("expected-key.json"),
            &serde_json::to_vec(&key).unwrap(),
        );
        private(&op.join("control.capability"), &[17; 32]);
        private(
            &op.join("receipt/account-receipt.json"),
            &serde_json::to_vec(&account).unwrap(),
        );
        private(
            &op.join("receipt/public-key-receipt.json"),
            &serde_json::to_vec(&installed).unwrap(),
        );
        private(&op.join("fixture-view.json"),&canonical(&json!({"running":true,"shares":[{"name":"input","path":op.join("input"),"readOnly":true},{"name":"receipt","path":op.join("receipt"),"readOnly":false}]})).unwrap());
        let reference = Reference::reopen(&op).unwrap();
        Self {
            _temp: temp,
            op,
            reference,
            account,
            installed,
        }
    }
    fn spawn(&self, binary: &Path, count: usize) -> Child {
        let (mut parent, child) = UnixStream::pair().unwrap();
        let fd = child.as_raw_fd();
        let mut command = Command::new(binary);
        command
            .arg(fd.to_string())
            .arg(count.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        // SAFETY: after fork, only async-signal-safe fcntl is called on the
        // one socket descriptor retained for this disposable fixture child.
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let spawned = command.spawn().unwrap();
        drop(child);
        send(&mut parent, &self.reference.launch_packet()).unwrap();
        if let Err(error) = self.reference.accept_launch(&mut parent, spawned.id()) {
            let output = spawned.wait_with_output().unwrap();
            panic!(
                "Fixture handshake: {error:?}; fixture diagnostics: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        spawned
    }
}

#[test]
fn production_acquisition_and_unbound_files_do_not_create_proof() {
    assert!(Reference::acquire_production()
        .err()
        .unwrap()
        .to_string()
        .contains("no approved artifact"));
    let f = Fixture::new(None);
    assert!(f.reference.admit("accountReceipt").is_err());
    assert!(f.op.join("accountReceipt/intent.json").exists());
    assert!(!f.op.join("accountReceipt/receipt.json").exists());
    assert!(!f.op.join("owner.sock").exists());
    assert!(f
        .reference
        .observe("consoleInput", &journal::new_id())
        .is_err());
}

#[test]
fn original_reference_rejects_changed_manifest_capability_history_and_aliases() {
    for fault in [
        "manifest",
        "capability",
        "intent",
        "alias",
        "mode",
        "unknown",
    ] {
        let f = Fixture::new(None);
        match fault {
            "manifest" => private(&f.op.join("expected-helper.json"), b"{}"),
            "capability" => private(&f.op.join("control.capability"), b"partial"),
            "intent" => private(&f.op.join("owner-intent.json"), b"{}"),
            "alias" => {
                let p = f.op.join("control.capability");
                std::fs::rename(&p, f.op.join("retained")).unwrap();
                std::os::unix::fs::symlink(f.op.join("retained"), p).unwrap();
            }
            "mode" => std::fs::set_permissions(
                f.op.join("control.capability"),
                Permissions::from_mode(0o644),
            )
            .unwrap(),
            _ => {
                let mut v = json!(f.reference.binding);
                v["proof"] = json!({"trusted":true});
                private(&f.op.join("owner-intent.json"), &canonical(&v).unwrap());
            }
        }
        assert!(Reference::reopen(&f.op).is_err(), "{fault}");
        assert!(f.reference.check(&f.op).is_err(), "{fault}");
    }
}

#[test]
fn local_receipt_content_requires_original_account_key_and_strict_manifest() {
    let f = Fixture::new(None);
    assert!(macos_bootstrap_helper::validate_owner_receipt(
        &serde_json::to_vec(&f.account).unwrap(),
        &f.reference.manifest,
        None,
        None
    )
    .is_ok());
    let key: Value =
        serde_json::from_slice(&std::fs::read(f.op.join("expected-key.json")).unwrap()).unwrap();
    assert!(macos_bootstrap_helper::validate_owner_receipt(
        &serde_json::to_vec(&f.installed).unwrap(),
        &f.reference.manifest,
        Some(&f.account),
        Some(&key)
    )
    .is_ok());
    for field in [
        "ready",
        "trustAccepted",
        "proof",
        "account",
        "hostPublicKey",
        "keyReference",
    ] {
        let mut changed = f.installed.clone();
        changed[field] = json!(true);
        assert!(
            macos_bootstrap_helper::validate_owner_receipt(
                &serde_json::to_vec(&changed).unwrap(),
                &f.reference.manifest,
                Some(&f.account),
                Some(&key)
            )
            .is_err(),
            "{field}"
        );
    }
    let mut another = key;
    another["keyReference"] = json!(journal::new_id());
    assert!(macos_bootstrap_helper::validate_owner_receipt(
        &serde_json::to_vec(&f.installed).unwrap(),
        &f.reference.manifest,
        Some(&f.account),
        Some(&another)
    )
    .is_err());
    let mut account = f.account;
    account["observation"]["account"]["home"] = json!("/Users/other");
    assert!(macos_bootstrap_helper::validate_owner_receipt(
        &serde_json::to_vec(&account).unwrap(),
        &f.reference.manifest,
        None,
        None
    )
    .is_err());
}

#[test]
fn lost_or_partial_admission_history_cannot_be_replaced() {
    for fault in ["lock", "intent", "partial"] {
        let f = Fixture::new(None);
        assert!(f.reference.admit("accountReceipt").is_err());
        let dir = f.op.join("accountReceipt");
        match fault {
            "lock" => std::fs::remove_file(dir.join("operation.lock")).unwrap(),
            "intent" => std::fs::remove_file(dir.join("intent.json")).unwrap(),
            _ => private(&dir.join("intent.json"), b"{partial"),
        }
        assert!(f.reference.admit("accountReceipt").is_err());
        if fault == "lock" {
            assert!(!dir.join("operation.lock").exists());
        }
        if fault == "intent" {
            assert!(!dir.join("intent.json").exists());
        }
        if fault == "partial" {
            assert_eq!(std::fs::read(dir.join("intent.json")).unwrap(), b"{partial");
        }
    }
}

#[test]
#[ignore = "Explicit offline Swift fixture build required; never launches a VM or real owner"]
fn cross_language_owner_receipt_admission_reopen_and_conflict_fencing() {
    let binary = PathBuf::from(
        std::env::var_os("TERMINALX_BOOTSTRAP_FIXTURE")
            .expect("Build integrations/lume-bootstrap fixture first"),
    )
    .canonicalize()
    .unwrap();
    let f = Fixture::new(Some(&binary));
    let child = f.spawn(&binary, 4);
    let first = f.reference.admit("accountReceipt").unwrap();
    assert_eq!(first["stage"], "candidateReceiptAdmitted");
    assert_eq!(first["trustAccepted"], false);
    let reopened = Reference::reopen(&f.op).unwrap();
    assert_eq!(reopened.admit("accountReceipt").unwrap(), first);
    assert_eq!(
        reopened.admit("keyReceipt").unwrap()["guestReceipt"],
        f.installed
    );
    let before = std::fs::read(f.op.join("keyReceipt/receipt.json")).unwrap();
    let mut key: Value =
        serde_json::from_slice(&std::fs::read(f.op.join("expected-key.json")).unwrap()).unwrap();
    key["keyReference"] = json!(journal::new_id());
    private(
        &f.op.join("expected-key.json"),
        &serde_json::to_vec(&key).unwrap(),
    );
    assert!(reopened.admit("keyReceipt").is_err());
    assert_eq!(
        std::fs::read(f.op.join("keyReceipt/receipt.json")).unwrap(),
        before
    );
    assert!(child.wait_with_output().unwrap().status.success());
    assert!(reopened.admit("accountReceipt").is_err()); // socket/PID alone never releases or proves live ownership
    assert_eq!(
        std::fs::read(f.op.join("accountReceipt/receipt.json")).unwrap(),
        serde_json::to_vec(&first).unwrap()
    );

    let f = Fixture::new(Some(&binary));
    let child = f.spawn(&binary, 2);
    let mut changed = f.account.clone();
    changed["observation"]["account"]["home"] = json!("/Users/replaced");
    let original = serde_json::to_vec(&changed).unwrap();
    private(&f.op.join("receipt/account-receipt.json"), &original);
    assert!(f.reference.admit("accountReceipt").is_err());
    private(
        &f.op.join("receipt/account-receipt.json"),
        &serde_json::to_vec(&f.account).unwrap(),
    );
    assert!(f.reference.admit("accountReceipt").is_err());
    assert_eq!(
        std::fs::read(f.op.join("accountReceipt/authenticated-receipt.json")).unwrap(),
        original
    );
    assert!(!f.op.join("accountReceipt/receipt.json").exists());
    assert!(child.wait_with_output().unwrap().status.success());
}

#[test]
fn bounded_native_frames_allow_successive_reads_and_refuse_oversized_lengths() {
    let (mut reader, mut writer) = UnixStream::pair().unwrap();
    let actor = std::thread::spawn(move || {
        send(&mut writer, &json!({"first":true})).unwrap();
        send(&mut writer, &json!({"second":true})).unwrap();
        writer.write_all(&u32::MAX.to_be_bytes()).unwrap();
    });
    assert_eq!(
        serde_json::from_slice::<Value>(&read(&mut reader).unwrap()).unwrap(),
        json!({"first":true})
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&read(&mut reader).unwrap()).unwrap(),
        json!({"second":true})
    );
    assert!(read(&mut reader).unwrap_err().to_string().contains("bound"));
    actor.join().unwrap();
}
