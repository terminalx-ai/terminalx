use super::*;
use base64::Engine;
use std::{os::unix::fs::PermissionsExt, path::PathBuf};

struct Fixture {
    temp: tempfile::TempDir,
    home: PathBuf,
    input: PathBuf,
    output: PathBuf,
    system: PathBuf,
    helper: PathBuf,
    channel: Channel,
    source: Source,
    manifest: Manifest,
}
fn public(byte: u8) -> String {
    let mut bytes = 11_u32.to_be_bytes().to_vec();
    bytes.extend(b"ssh-ed25519");
    bytes.extend(32_u32.to_be_bytes());
    bytes.extend([byte; 32]);
    format!(
        "ssh-ed25519 {}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    )
}
fn private_dir(path: &Path) {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(path).unwrap();
}
fn write(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let home = root.join("home");
        let input = root.join("input");
        let output = root.join("output");
        let system = root.join("synthetic-system-public-keys");
        let helper = root.join("helper");
        for path in [&home, &input, &output, &system, &helper] {
            private_dir(path);
        }
        let uid = std::fs::metadata(&home).unwrap().uid();
        let open = |path: &Path| Directory::open(path, uid, true).unwrap();
        write(
            &system.join("ssh_host_ed25519_key.pub"),
            format!("{} synthetic-host\n", public(1)).as_bytes(),
        );
        write(
            &helper.join("terminalx-bootstrap-helper"),
            b"synthetic helper executable, never a real key or binary",
        );
        std::fs::set_permissions(
            helper.join("terminalx-bootstrap-helper"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        let binding = Binding {
            bootstrap_id: journal::new_id(),
            target: Target {
                environment_id: journal::new_id(),
                generation: journal::new_id(),
                vm_fingerprint: "a".repeat(64),
                restore_sha256: "b".repeat(64),
                macos_major: 26,
            },
            owner_epoch: journal::new_id(),
            nonce: "c".repeat(64),
            parent_session: journal::new_id(),
            parent_tab: journal::new_id(),
            parent_conversation: "original".into(),
            input: Share {
                id: journal::new_id(),
                host: Node {
                    device: 100,
                    inode: 200,
                },
                mounted: open(&input).node().unwrap(),
                read_only: true,
            },
            output: Share {
                id: journal::new_id(),
                host: Node {
                    device: 100,
                    inode: 201,
                },
                mounted: open(&output).node().unwrap(),
                read_only: false,
            },
        };
        // ONLY this cfg(test) module constructs a channel. Mounted paths, public
        // keys, OS/account observations and the broker capability are synthetic.
        let channel = Channel {
            binding: binding.clone(),
            input: open(&input),
            output: open(&output),
            home: open(&home),
        };
        let source = Source {
            user: User {
                short_name: "personal".into(),
                uid,
                gid: 20,
                home: "/Users/personal".into(),
            },
            os_version: "26.0".into(),
            os_build: "Fixture26".into(),
            host_keys: open(&system),
            helper: open(&helper),
        };
        let manifest = Manifest {
            version: 1,
            binding,
            account_name: "personal".into(),
            account_home: "/Users/personal".into(),
            os_version: source.os_version.clone(),
            os_build: source.os_build.clone(),
            helper_sha256: journal::digest(
                b"synthetic helper executable, never a real key or binary",
            ),
            runtime_sha256: "d".repeat(64),
        };
        let f = Self {
            temp,
            home,
            input,
            output,
            system,
            helper,
            channel,
            source,
            manifest,
        };
        f.manifest(&f.manifest);
        f
    }
    fn manifest(&self, value: &Manifest) {
        write(
            &self.input.join("account-manifest.json"),
            &serde_json::to_vec(value).unwrap(),
        );
    }
    fn call(&self, action: &str) -> Result<Value> {
        execute(&self.channel, &self.source, action, |_| Ok(()))
    }
    fn observe_and_key(&self) -> KeyManifest {
        let observed = self.call("observe").unwrap();
        let key = KeyManifest {
            version: 1,
            binding: self.manifest.binding.clone(),
            observation_digest: observed["observationDigest"].as_str().unwrap().into(),
            key_reference: journal::new_id(),
            public_key: public(2),
        };
        self.key(&key);
        key
    }
    fn key(&self, key: &KeyManifest) {
        write(
            &self.input.join("public-key-manifest.json"),
            &serde_json::to_vec(key).unwrap(),
        );
    }
    fn authorized(&self) -> PathBuf {
        self.home.join(".ssh/authorized_keys")
    }
    fn existing(&self, bytes: &[u8]) {
        private_dir(&self.home.join(".ssh"));
        write(&self.authorized(), bytes);
    }
    fn reopen(&self) -> Channel {
        let uid = self.source.user.uid;
        Channel {
            binding: self.channel.binding.clone(),
            input: Directory::open(&self.input, uid, true).unwrap(),
            output: Directory::open(&self.output, uid, true).unwrap(),
            home: Directory::open(&self.home, uid, true).unwrap(),
        }
    }
}

#[test]
fn observes_exact_account_os_and_existing_public_host_key_without_creating_credentials() {
    let f = Fixture::new();
    let receipt = f.call("observe").unwrap();
    assert_eq!(receipt["stage"], "accountObserved");
    assert_eq!(receipt["ready"], false);
    assert_eq!(receipt["trustAccepted"], false);
    assert_eq!(receipt["observation"]["account"]["shortName"], "personal");
    assert_eq!(receipt["observation"]["hostPublicKey"], public(1));
    assert!(!f.home.join(".ssh").exists());
    assert!(!f.system.join("ssh_host_ed25519_key").exists());
    assert_eq!(f.call("observe").unwrap(), receipt);
    assert_eq!(std::fs::read_dir(&f.system).unwrap().count(), 1);
    for action in [
        "observe",
        "installPublicKey",
        "reconcilePublicKey",
        "unknown",
    ] {
        assert!(run(action)
            .unwrap_err()
            .to_string()
            .contains("broker is unavailable"));
    }
}

#[test]
fn installs_one_key_preserves_unrelated_bytes_and_reconciles_original_full_write() {
    for lost in [Step::Appended, Step::Receipt] {
        let f = Fixture::new();
        let original = format!(
            "# retained history\n{} someone-else\n# no trailing newline",
            public(3)
        );
        f.existing(original.as_bytes());
        let before = Node::of(&std::fs::metadata(f.authorized()).unwrap());
        let key = f.observe_and_key();
        assert!(execute(&f.channel, &f.source, "installPublicKey", |step| {
            if step == lost {
                bail!("fixture lost reply")
            }
            Ok(())
        })
        .is_err());
        let after = std::fs::read(f.authorized()).unwrap();
        assert!(after.starts_with(original.as_bytes()));
        let resumed = execute(&f.reopen(), &f.source, "reconcilePublicKey", |_| Ok(())).unwrap();
        assert_eq!(resumed["stage"], "publicKeyInstalled");
        assert_eq!(resumed["trustAccepted"], false);
        assert_eq!(resumed["keyReference"], key.key_reference);
        assert_eq!(
            resumed["beforeSha256"],
            journal::digest(original.as_bytes())
        );
        assert_eq!(f.call("installPublicKey").unwrap(), resumed);
        assert_eq!(std::fs::read(f.authorized()).unwrap(), after);
        assert_eq!(
            Node::of(&std::fs::metadata(f.authorized()).unwrap()),
            before
        );
        assert_eq!(
            String::from_utf8(after)
                .unwrap()
                .matches("terminalx-bootstrap:")
                .count(),
            1
        );
        assert_eq!(
            std::fs::metadata(f.authorized()).unwrap().mode() & 0o777,
            0o600
        );
        assert_eq!(
            serde_json::from_slice::<Value>(
                &std::fs::read(f.output.join("public-key-receipt.json")).unwrap()
            )
            .unwrap(),
            resumed
        );
    }
    let f = Fixture::new();
    f.observe_and_key();
    assert_eq!(
        f.call("installPublicKey").unwrap()["stage"],
        "publicKeyInstalled"
    );
    assert_eq!(
        std::fs::metadata(f.home.join(".ssh")).unwrap().mode() & 0o777,
        0o700
    );
}

#[test]
fn interrupted_preparation_and_partial_append_are_never_replayed() {
    for phase in ["prepare", "before-write", "partial-write"] {
        let f = Fixture::new();
        f.existing(b"# unrelated\n");
        f.observe_and_key();
        assert!(execute(&f.channel, &f.source, "installPublicKey", |step| {
            if phase == "prepare" && step == Step::Prepared {
                bail!("fixture interrupted before file effect")
            }
            if phase != "prepare" && step == Step::Intent {
                if phase == "partial-write" {
                    std::fs::OpenOptions::new()
                        .append(true)
                        .open(f.authorized())?
                        .write_all(b"restrict ssh-ed25519 partial")?;
                }
                bail!("fixture interrupted append")
            }
            Ok(())
        })
        .is_err());
        let bytes = std::fs::read(f.authorized()).unwrap();
        for action in ["reconcilePublicKey", "installPublicKey"] {
            let result = f.call(action);
            if phase == "prepare" {
                assert!(result.is_err());
            } else {
                assert_eq!(result.unwrap()["stage"], "outcomeUnknown");
            }
            assert_eq!(std::fs::read(f.authorized()).unwrap(), bytes);
        }
        assert!(!f.output.join("public-key-receipt.json").exists());
    }
}

#[test]
fn wrong_account_home_os_and_host_key_are_refused_before_effects() {
    for fault in [
        "name",
        "home",
        "uid",
        "os",
        "build",
        "host-key",
        "helper",
        "missing-host-key",
    ] {
        let mut f = Fixture::new();
        match fault {
            "name" => f.source.user.short_name = "another".into(),
            "home" => f.source.user.home = "/Users/another".into(),
            "uid" => f.source.user.uid += 1,
            "os" => f.source.os_version = "27.0".into(),
            "build" => f.source.os_build = "Changed".into(),
            "host-key" => write(
                &f.system.join("ssh_host_ed25519_key.pub"),
                b"not an SSH key",
            ),
            "helper" => write(&f.helper.join("terminalx-bootstrap-helper"), b"changed"),
            _ => std::fs::remove_file(f.system.join("ssh_host_ed25519_key.pub")).unwrap(),
        }
        assert!(f.call("observe").is_err(), "{fault}");
        assert!(!f.home.join(STATE).exists());
        assert!(!f.home.join(".ssh").exists());
    }
}

#[test]
fn changed_channel_identity_manifest_or_observation_cannot_rebind_history() {
    for fault in [
        "nonce",
        "epoch",
        "generation",
        "share",
        "parent",
        "host-key",
        "key-reference",
        "key-bytes",
        "observation",
        "runtime",
    ] {
        let mut f = Fixture::new();
        let mut key = f.observe_and_key();
        let mut manifest = f.manifest.clone();
        match fault {
            "nonce" => manifest.binding.nonce = "e".repeat(64),
            "epoch" => manifest.binding.owner_epoch = journal::new_id(),
            "generation" => manifest.binding.target.generation = journal::new_id(),
            "share" => manifest.binding.input.host.inode += 1,
            "parent" => manifest.binding.parent_conversation = "new".into(),
            "host-key" => write(
                &f.system.join("ssh_host_ed25519_key.pub"),
                public(4).as_bytes(),
            ),
            "runtime" => manifest.runtime_sha256 = "e".repeat(64),
            _ => {
                // Pin an original key intent, then attempt to replace it after
                // an uncertain preparation (no authorized key write occurred).
                assert!(execute(&f.channel, &f.source, "installPublicKey", |step| {
                    if step == Step::Prepared {
                        bail!("lost prepare")
                    }
                    Ok(())
                })
                .is_err());
                match fault {
                    "key-reference" => key.key_reference = journal::new_id(),
                    "key-bytes" => key.public_key = public(5),
                    _ => key.observation_digest = "f".repeat(64),
                }
                f.key(&key);
            }
        }
        // Even if a future backend presented a different valid channel, the
        // original home ledger must refuse a changed epoch/share/target.
        f.channel.binding = manifest.binding.clone();
        f.manifest(&manifest);
        assert!(f.call("installPublicKey").is_err(), "{fault}");
        assert!(!f.authorized().exists());
    }
}

#[test]
fn replaced_aliased_or_nonprivate_paths_never_receive_input() {
    for fault in [
        "ssh-symlink",
        "keys-symlink",
        "keys-hardlink",
        "keys-mode",
        "share-symlink",
        "share-replaced",
        "home-symlink",
        "host-key-hardlink",
        "receipt-symlink",
    ] {
        let f = Fixture::new();
        f.observe_and_key();
        let external = f.temp.path().canonicalize().unwrap().join("external");
        private_dir(&external);
        write(&external.join("preserved"), b"untouched");
        match fault {
            "ssh-symlink" => std::os::unix::fs::symlink(&external, f.home.join(".ssh")).unwrap(),
            "keys-symlink" => {
                private_dir(&f.home.join(".ssh"));
                std::os::unix::fs::symlink(external.join("preserved"), f.authorized()).unwrap();
            }
            "keys-hardlink" => {
                private_dir(&f.home.join(".ssh"));
                std::fs::hard_link(external.join("preserved"), f.authorized()).unwrap();
            }
            "keys-mode" => {
                f.existing(b"existing");
                std::fs::set_permissions(f.authorized(), std::fs::Permissions::from_mode(0o666))
                    .unwrap();
            }
            "share-symlink" | "share-replaced" => {
                let old = f.input.with_extension("original");
                std::fs::rename(&f.input, &old).unwrap();
                if fault == "share-symlink" {
                    std::os::unix::fs::symlink(&old, &f.input).unwrap();
                } else {
                    private_dir(&f.input);
                }
            }
            "home-symlink" => {
                let old = f.home.with_extension("original");
                std::fs::rename(&f.home, &old).unwrap();
                std::os::unix::fs::symlink(&old, &f.home).unwrap();
            }
            "host-key-hardlink" => std::fs::hard_link(
                f.system.join("ssh_host_ed25519_key.pub"),
                external.join("host-alias"),
            )
            .unwrap(),
            _ => {
                std::fs::remove_file(f.output.join("account-receipt.json")).unwrap();
                std::os::unix::fs::symlink(
                    external.join("preserved"),
                    f.output.join("account-receipt.json"),
                )
                .unwrap();
            }
        }
        assert!(f.call("installPublicKey").is_err(), "{fault}");
        assert_eq!(
            std::fs::read(external.join("preserved")).unwrap(),
            b"untouched"
        );
    }
}

#[test]
fn missing_history_changed_file_and_competing_actor_stay_fenced() {
    let f = Fixture::new();
    f.observe_and_key();
    f.call("installPublicKey").unwrap();
    let bytes = std::fs::read(f.authorized()).unwrap();
    let lock = f
        .channel
        .home
        .child(STATE, false)
        .unwrap()
        .lock("operation.lock", false)
        .unwrap();
    assert!(f.call("reconcilePublicKey").is_err());
    drop(lock);
    let old = f.authorized().with_extension("retained");
    std::fs::rename(f.authorized(), &old).unwrap();
    write(&f.authorized(), &bytes);
    assert!(f.call("reconcilePublicKey").is_err());
    assert_eq!(std::fs::read(f.authorized()).unwrap(), bytes);
    std::fs::remove_file(f.home.join(STATE).join("write-intent.json")).unwrap();
    assert!(f.call("installPublicKey").is_err());
    assert_eq!(std::fs::read(old).unwrap(), bytes);
    for missing in ["key-intent.json", "observation.json"] {
        let f = Fixture::new();
        f.observe_and_key();
        f.call("installPublicKey").unwrap();
        let keys = std::fs::read(f.authorized()).unwrap();
        let receipt = std::fs::read(f.output.join("public-key-receipt.json")).unwrap();
        let path = f.home.join(STATE).join(missing);
        std::fs::remove_file(&path).unwrap();
        for action in ["observe", "installPublicKey", "reconcilePublicKey"] {
            let result = f.call(action);
            if missing == "observation.json" || action != "observe" {
                assert!(result.is_err(), "{missing}/{action}");
            }
            assert!(!path.exists());
            assert_eq!(std::fs::read(f.authorized()).unwrap(), keys);
            assert_eq!(
                std::fs::read(f.output.join("public-key-receipt.json")).unwrap(),
                receipt
            );
        }
    }
}

#[test]
fn changes_between_intent_and_append_preserve_original_and_competing_bytes() {
    for fault in ["manifest", "key", "host-key", "competing-append", "share"] {
        let f = Fixture::new();
        f.existing(b"# unrelated\n");
        let key = f.observe_and_key();
        assert!(
            execute(&f.channel, &f.source, "installPublicKey", |step| {
                if step == Step::Intent {
                    match fault {
                        "manifest" => {
                            let mut manifest = f.manifest.clone();
                            manifest.runtime_sha256 = "f".repeat(64);
                            f.manifest(&manifest);
                        }
                        "key" => {
                            let mut changed = key.clone();
                            changed.public_key = public(4);
                            f.key(&changed);
                        }
                        "host-key" => write(
                            &f.system.join("ssh_host_ed25519_key.pub"),
                            public(4).as_bytes(),
                        ),
                        "competing-append" => std::fs::OpenOptions::new()
                            .append(true)
                            .open(f.authorized())?
                            .write_all(b"# concurrent unrelated change\n")?,
                        _ => {
                            std::fs::rename(&f.output, f.output.with_extension("retained"))?;
                            private_dir(&f.output);
                        }
                    }
                }
                Ok(())
            })
            .is_err(),
            "{fault}"
        );
        let bytes = std::fs::read(f.authorized()).unwrap();
        let expected: &[u8] = if fault == "competing-append" {
            b"# unrelated\n# concurrent unrelated change\n"
        } else {
            b"# unrelated\n"
        };
        assert_eq!(bytes, expected, "{fault}");
        let result = f.call("reconcilePublicKey");
        if fault == "competing-append" {
            assert_eq!(result.unwrap()["stage"], "outcomeUnknown");
        } else {
            assert!(result.is_err(), "{fault}");
        }
        assert_eq!(std::fs::read(f.authorized()).unwrap(), bytes);
        assert!(!f.output.join("public-key-receipt.json").exists());
    }
}

#[test]
fn partial_journals_and_receipt_publications_are_retained_without_repair_or_key_replay() {
    for name in [
        "key-intent.json",
        "write-intent.json",
        "key-receipt.json",
        "public-key-receipt.json",
    ] {
        let f = Fixture::new();
        f.observe_and_key();
        f.call("installPublicKey").unwrap();
        let keys = std::fs::read(f.authorized()).unwrap();
        let path = if name == "public-key-receipt.json" {
            f.output.join(name)
        } else {
            f.home.join(STATE).join(name)
        };
        // Simulate a persisted prefix left by interruption. Never retry the
        // original append to compensate for an incomplete journal/publication.
        let original = std::fs::read(&path).unwrap();
        let prefix = &original[..original.len() / 2];
        write(&path, prefix);
        for action in ["reconcilePublicKey", "installPublicKey"] {
            assert!(f.call(action).is_err(), "{name}/{action}");
            assert_eq!(std::fs::read(&path).unwrap(), prefix);
            assert_eq!(std::fs::read(f.authorized()).unwrap(), keys);
        }
    }
}

#[test]
fn request_supplied_binding_and_aliases_never_construct_an_authenticated_channel() {
    for fault in ["nonce", "epoch", "share", "mode", "target"] {
        let f = Fixture::new();
        let mut manifest = f.manifest.clone();
        match fault {
            "nonce" => manifest.binding.nonce = "e".repeat(64),
            "epoch" => manifest.binding.owner_epoch = journal::new_id(),
            "share" => manifest.binding.output.mounted.inode += 1,
            "mode" => manifest.binding.input.read_only = false,
            _ => manifest.binding.target.vm_fingerprint = "e".repeat(64),
        }
        f.manifest(&manifest);
        assert!(f.call("observe").is_err(), "{fault}");
        assert!(!f.home.join(STATE).exists());
        assert_eq!(std::fs::read_dir(&f.output).unwrap().count(), 0);
    }
    for name in ["account-manifest.json", "terminalx-bootstrap-helper"] {
        let f = Fixture::new();
        let parent = if name == "account-manifest.json" {
            &f.input
        } else {
            &f.helper
        };
        let path = parent.join(name);
        let original = parent.join("retained");
        std::fs::rename(&path, &original).unwrap();
        std::os::unix::fs::symlink(&original, &path).unwrap();
        assert!(f.call("observe").is_err(), "{name}");
        assert!(!f.home.join(STATE).exists());
    }
}

#[test]
fn rejects_oversized_unexpected_manifests_and_duplicate_preexisting_keys() {
    let f = Fixture::new();
    write(
        &f.input.join("account-manifest.json"),
        &vec![b' '; MANIFEST_LIMIT as usize + 1],
    );
    assert!(f.call("observe").is_err());
    assert!(!f.home.join(STATE).exists());
    let f = Fixture::new();
    let mut manifest = json!(f.manifest);
    manifest["proof"] = json!({"trusted":true});
    write(
        &f.input.join("account-manifest.json"),
        &serde_json::to_vec(&manifest).unwrap(),
    );
    assert!(f.call("observe").is_err());
    for original in [
        format!("{} existing-unrestricted\n", public(2)),
        "# terminalx-bootstrap:retained\n".into(),
    ] {
        let f = Fixture::new();
        f.existing(original.as_bytes());
        f.observe_and_key();
        assert!(f.call("installPublicKey").is_err());
        assert_eq!(std::fs::read(f.authorized()).unwrap(), original.as_bytes());
    }
    let f = Fixture::new();
    let mut key = f.observe_and_key();
    key.public_key = format!("{} injected\n{}", public(2), public(3));
    f.key(&key);
    assert!(f.call("installPublicKey").is_err());
    assert!(!f.home.join(".ssh").exists());
}

pub(super) fn owner_receipts(
    input: (u64, u64),
    output: (u64, u64),
) -> (Value, Value, Value, Value) {
    let mut f = Fixture::new();
    f.manifest.binding.input.host = Node {
        device: input.0,
        inode: input.1,
    };
    f.manifest.binding.output.host = Node {
        device: output.0,
        inode: output.1,
    };
    f.channel.binding = f.manifest.binding.clone();
    f.manifest(&f.manifest);
    let key = f.observe_and_key();
    let account = f.call("observe").unwrap();
    let installed = f.call("installPublicKey").unwrap();
    (json!(f.manifest), account, json!(key), installed)
}
