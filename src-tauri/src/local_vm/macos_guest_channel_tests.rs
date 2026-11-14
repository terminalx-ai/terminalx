use super::*;
use std::{
    os::unix::{
        fs::{DirBuilderExt, PermissionsExt},
        net::UnixStream,
    },
    process::{Command, Stdio},
};

fn private(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}
fn dir(path: &Path) {
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .unwrap();
}
fn open(path: &Path) -> Directory {
    Directory::open(path, unsafe { libc::geteuid() }, true).unwrap()
}

// Real Swift protocol process plus Rust guest client; no VM/vsock invocation.
#[test]
#[ignore = "Requires explicitly compiled synthetic native owner fixture"]
fn native_guest_observation_is_not_account_authentication_and_never_replays() {
    for fault in [
        "",
        "wrong-account",
        "wrong-helper",
        "replaced-input",
        "lost-reply",
    ] {
        let temp = tempfile::Builder::new()
            .prefix("txg")
            .tempdir_in("/private/tmp")
            .unwrap();
        let root = temp.path().canonicalize().unwrap();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).unwrap();
        let op = root.join("op");
        let vm = root.join("vm");
        for p in [
            &op,
            &vm,
            &op.join("input"),
            &op.join("receipt"),
            &root.join("helper"),
            &root.join("host-keys"),
        ] {
            dir(p)
        }
        for n in ["config.json", "disk.img", "nvram.bin"] {
            private(&vm.join(n), b"synthetic")
        }
        private(
            &root.join("helper/terminalx-bootstrap-helper"),
            b"synthetic helper bytes, not executable",
        );
        let user = User {
            short_name: if fault == "wrong-account" {
                "other"
            } else {
                "personal"
            }
            .into(),
            uid: unsafe { libc::geteuid() },
            gid: 20,
            home: "/Users/personal".into(),
        };
        let source = Source {
            user,
            os_version: "26.0".into(),
            os_build: "25A001".into(),
            host_keys: open(&root.join("host-keys")),
            helper: open(&root.join("helper")),
        };
        let node = |p: &Path| json!(Node::of(&std::fs::metadata(p).unwrap()));
        let epoch = journal::new_id();
        let plan = json!({"version":2,"accountName":"personal","accountHome":"/Users/personal","macosMajor":26,
            "helperSha256":if fault=="wrong-helper" {"c".repeat(64)}else{journal::digest(b"synthetic helper bytes, not executable")},
            "runtimeSha256":"a".repeat(64),"accountIntentDigest":"b".repeat(64),
            "binding":{"bootstrapId":journal::new_id(),"target":{"environmentId":journal::new_id(),"generation":journal::new_id(),"vmFingerprint":"a".repeat(64),"restoreSha256":"a".repeat(64),"macosMajor":26},
                "ownerEpoch":epoch,"nonce":"b".repeat(64),"parentSession":journal::new_id(),"parentTab":journal::new_id(),"parentConversation":"original",
                "input":{"id":journal::new_id(),"host":node(&op.join("input")),"readOnly":true},
                "output":{"id":journal::new_id(),"host":node(&op.join("receipt")),"readOnly":false}}});
        let canonical = super::super::super::macos_owner_channel::canonical;
        let plan_bytes = canonical(&plan).unwrap();
        private(&op.join("expected-helper.json"), &plan_bytes);
        private(&op.join("input/host-plan.json"), &plan_bytes);
        let binary =
            std::env::var_os("TERMINALX_BOOTSTRAP_FIXTURE").expect("Native fixture required");
        let mut paths = serde_json::Map::new();
        for (role, p) in [
            ("operation", op.clone()),
            ("storage", root.clone()),
            ("vm", vm.clone()),
            ("config", vm.join("config.json")),
            ("disk", vm.join("disk.img")),
            ("nvram", vm.join("nvram.bin")),
            ("input", op.join("input")),
            ("output", op.join("receipt")),
        ] {
            let n = node(&p);
            paths.insert(
                role.into(),
                json!({"path":p,"device":n["device"],"inode":n["inode"]}),
            );
        }
        let h = &plan["binding"];
        let t = &h["target"];
        let binding = json!({"version":2,"macosMajor":26,"bootstrapId":h["bootstrapId"],"ownerEpoch":epoch,"nonce":h["nonce"],
            "environmentId":t["environmentId"],"generation":t["generation"],"vmFingerprint":t["vmFingerprint"],"restoreSha256":t["restoreSha256"],
            "runtimeSha256":plan["runtimeSha256"],"helperManifestSha256":journal::digest(&plan_bytes),"executableSha256":journal::digest(&std::fs::read(&binary).unwrap()),
            "parentSession":h["parentSession"],"parentTab":h["parentTab"],"parentConversation":h["parentConversation"],"inputShareId":h["input"]["id"],"outputShareId":h["output"]["id"],
            "configSha256":journal::digest(b"synthetic"),"paths":paths});
        private(&op.join("owner-intent.json"), &canonical(&binding).unwrap());
        private(&op.join("fixture-view.json"),&canonical(&json!({"running":true,"shares":[{"name":"input","path":op.join("input"),"readOnly":true},{"name":"receipt","path":op.join("receipt"),"readOnly":false}]})).unwrap());
        let (control, control_child) = UnixStream::pair().unwrap();
        let (guest, guest_child) = UnixStream::pair().unwrap();
        use std::os::unix::process::CommandExt;
        let cf = control_child.as_raw_fd();
        let gf = guest_child.as_raw_fd();
        let mut cmd = Command::new(binary);
        cmd.args([cf.to_string(), "guest-observe".into(), gf.to_string()])
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        // SAFETY: only the two fixture socket descriptors are inherited by exec.
        unsafe {
            cmd.pre_exec(move || {
                if libc::fcntl(cf, libc::F_SETFD, 0) < 0 || libc::fcntl(gf, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = cmd.spawn().unwrap();
        drop(control_child);
        drop(guest_child);
        let mut control = File::from(std::os::fd::OwnedFd::from(control));
        let mut guest = File::from(std::os::fd::OwnedFd::from(guest));
        configure(&control).unwrap();
        send(&mut control,&json!({"binding":STANDARD.encode(canonical(&binding).unwrap()),"capability":STANDARD.encode([17;32])})).unwrap();
        let input = open(&op.join("input"));
        let output = open(&op.join("receipt"));
        if fault == "replaced-input" {
            std::fs::rename(op.join("input"), op.join("retained-input")).unwrap();
            dir(&op.join("input"));
        }
        if fault == "lost-reply" {
            configure(&guest).unwrap();
            send(
                &mut guest,
                &json!({"version":1,"clientNonce":"a".repeat(64)}),
            )
            .unwrap();
            let _: Offer = serde_json::from_slice(&read(&mut guest).unwrap()).unwrap();
            // Disconnect after original durable challenge, with no claimed result.
        } else {
            let result = observe(&mut guest, &input, &output, &source);
            if fault.is_empty() {
                let receipt = result.unwrap();
                assert_eq!(receipt["accountAuthenticated"], false);
                assert_eq!(receipt["ready"], false);
                let original = std::fs::read(op.join("guest-observation-intent.json")).unwrap();
                assert!(observe(&mut guest, &input, &output, &source).is_err());
                assert_eq!(
                    std::fs::read(op.join("guest-observation-intent.json")).unwrap(),
                    original
                );
                assert!(op.join("guest-observation.json").exists());
                assert!(!op.join("input/account-manifest.json").exists());
            } else {
                assert!(result.is_err(), "{fault}");
                assert!(!op.join("guest-observation.json").exists());
            }
        }
        drop(guest);
        // Retain parent identity until the child has consumed inherited IPC;
        // early peer close legitimately removes LOCAL_PEERPID on Darwin.
        let outcome = child.wait_with_output().unwrap();
        drop(control);
        assert!(
            outcome.status.success() || fault == "replaced-input",
            "{fault}: {}",
            String::from_utf8_lossy(&outcome.stderr)
        );
        if fault == "lost-reply" {
            assert!(op.join("guest-observation-intent.json").exists());
            assert!(!op.join("guest-observation.json").exists());
        }
        assert!(!root.join("host-keys/ssh_host_ed25519_key.pub").exists());
    }
}

#[test]
fn guest_socket_metadata_cannot_acquire_helper_authority() {
    let error = match acquire_authenticated() {
        Ok(_) => panic!("No production authority"),
        Err(e) => e,
    };
    assert!(error.to_string().contains("not guest UID/process/helper"));
}
