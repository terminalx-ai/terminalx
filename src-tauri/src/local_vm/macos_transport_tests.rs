use super::super::{
    macos_keys,
    macos_personalization::{AccountPlan, AccountReceipt, TrustReceipt},
    transport::Transport,
};
use super::*;
use base64::Engine as _;
use std::os::unix::fs::PermissionsExt;

struct Fixture {
    root: tempfile::TempDir,
    journal: Journal,
    env: Environment,
    ssh: PathBuf,
    keygen: PathBuf,
    public: String,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let journal = Journal::open(root.path()).unwrap();
        let mut env = journal
            .enroll("Personalized fixture", "local:fixture-only")
            .unwrap();
        let target = Target {
            environment_id: env.id.clone(),
            generation: env.generation.clone(),
            vm_fingerprint: "a".repeat(64),
            restore_sha256: "b".repeat(64),
            macos_major: 26,
        };
        let plan = AccountPlan {
            short_name: "personal".into(),
            password_reference: journal::new_id(),
            ssh_key_reference: journal::new_id(),
        };
        let key = journal::new_id();
        let account = Account {
            short_name: plan.short_name.clone(),
            uid: 501,
            gid: 20,
            home: "/Users/personal".into(),
            home_device: 1,
            home_inode: 42,
        };
        let begun = macos_personalization::begin(root.path(), &key, &target, &plan).unwrap();
        let observed = macos_personalization::create_account_using(
            root.path(),
            &key,
            begun["inputDigest"].as_str().unwrap(),
            |_, _| {
                Ok(AccountReceipt {
                    target: target.clone(),
                    account: account.clone(),
                    bootstrap_observation_digest: "c".repeat(64),
                })
            },
        )
        .unwrap();
        let mut bytes = Vec::new();
        bytes.extend(11_u32.to_be_bytes());
        bytes.extend(b"ssh-ed25519");
        bytes.extend(32_u32.to_be_bytes());
        bytes.extend([7_u8; 32]);
        let public = format!(
            "ssh-ed25519 {}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        );
        let trust = TrustReceipt {
            target: target.clone(),
            account_receipt_digest: journal::digest(
                &serde_json::to_vec(&observed["accountReceipt"]).unwrap(),
            ),
            host_key: public.clone(),
            host_key_fingerprint: macos_personalization::public_key(&public).unwrap(),
            bootstrap_observation_digest: "d".repeat(64),
        };
        macos_personalization::retain_trust(root.path(), &key, &trust).unwrap();
        env.transport = Transport::MacosPersonalized {
            binding: Box::new(Binding {
                bootstrap_id: key,
                target,
                account,
                runtime_sha256: "e".repeat(64),
                trust_digest: journal::digest(&serde_json::to_vec(&trust).unwrap()),
                key_reference: plan.ssh_key_reference,
            }),
        };
        journal
            .transaction(|state| {
                state.enabled = true;
                state.environments.insert(env.id.clone(), env.clone());
                Ok(())
            })
            .unwrap();
        let keygen = root.path().join("fake-key-verifier");
        script(
            &keygen,
            r#"#!/usr/bin/python3
import sys,pathlib,os
assert sys.argv[1:3]==['-y','-f']
assert pathlib.Path(sys.argv[3]).read_bytes()==b'synthetic fixture material, never a real key'
assert 'SSH_AUTH_SOCK' not in os.environ
print((pathlib.Path(__file__).parent/'public-key').read_text())
"#,
        );
        std::fs::write(root.path().join("public-key"), &public).unwrap();
        let ssh = root.path().join("fake-ssh");
        script(
            &ssh,
            r#"#!/usr/bin/python3
import json,sys,pathlib,os
p=pathlib.Path(__file__).parent
a=sys.argv[1:]
assert a[:2]==['-F','none'] and a[a.index('-l')+1]=='personal'
assert a[-1]=='/Users/personal/.terminalx-local/bin/terminalx-serve local-vm-rpc -'
for flag in ['StrictHostKeyChecking=yes','IdentityAgent=none','PasswordAuthentication=no','KbdInteractiveAuthentication=no','ForwardAgent=no','ClearAllForwardings=yes','ProxyCommand=none','ControlPath=none','PermitLocalCommand=no','GlobalKnownHostsFile=/dev/null']:
 assert flag in a,flag
assert not any(k in os.environ for k in ['SSH_AUTH_SOCK','SSH_ASKPASS','TERMINALX_NEXT_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY'])
known=next(x for x in a if x.startswith('UserKnownHostsFile='))[len('UserKnownHostsFile='):].strip('"')
assert (p/'public-key').read_text() in pathlib.Path(known).read_text()
request=json.load(sys.stdin)
assert request['expectedRuntimeSha256']=='e'*64
assert request['expectedMacosAccount']['shortName']=='personal'
with (p/'deliveries').open('a') as f:f.write(request['method']+'\n')
(p/'request.json').write_text(json.dumps(request))
if (p/'lose-next').exists():
 (p/'lose-next').unlink();sys.exit(72)
print((p/'reply.json').read_text())
"#,
        );
        let fixture = Self {
            root,
            journal,
            env,
            ssh,
            keygen,
            public,
        };
        fixture.prepare();
        fixture
    }
    fn pinned(&self) -> &Binding {
        binding(&self.env).unwrap()
    }
    fn programs(&self) -> Programs<'_> {
        Programs {
            ssh: &self.ssh,
            keygen: &self.keygen,
        }
    }
    fn endpoint(&self) -> Endpoint {
        Endpoint {
            target: self.pinned().target.clone(),
            sandbox: self.env.sandbox.clone(),
            ip: Ipv4Addr::new(192, 168, 64, 2),
            running: true,
        }
    }
    fn prepare(&self) -> Value {
        macos_keys::prepare_using(self.root.path(), self.pinned(), &self.keygen, || {
            Ok(macos_keys::GeneratedKey {
                private: zeroize::Zeroizing::new(
                    b"synthetic fixture material, never a real key".to_vec(),
                ),
                public: self.public.clone(),
            })
        })
        .unwrap()
    }
    fn task(&self) -> journal::Task {
        self.journal
            .submit_selected(
                "selected-task",
                journal::TaskInput {
                    parent_session_id: journal::new_id(),
                    parent_tab_id: journal::new_id(),
                    parent_message_id: "selected".into(),
                    environment_id: self.env.id.clone(),
                    prompt: "Fixture only".into(),
                    harness: "codex".into(),
                    model: "gpt-6-astra".into(),
                    effort: Some("xhigh".into()),
                    permission_mode: "manual".into(),
                    files: vec![],
                    desktop: true,
                },
                Some(
                    &self
                        .env
                        .transport
                        .target(&self.env.id, &self.env.generation),
                ),
            )
            .unwrap()
    }
    fn reply(&self, value: Value) {
        std::fs::write(
            self.root.path().join("reply.json"),
            json!({"ok":true,"result":value}).to_string(),
        )
        .unwrap();
    }
    fn call(&self, method: &str, params: Value) -> Result<Value> {
        rpc_using(
            self.root.path(),
            &self.journal,
            &self.env,
            method,
            params,
            &self.endpoint(),
            &self.programs(),
            Duration::from_secs(10),
        )
    }
    fn deliveries(&self) -> usize {
        std::fs::read_to_string(self.root.path().join("deliveries"))
            .unwrap_or_default()
            .lines()
            .count()
    }
}
fn script(path: &Path, text: &str) {
    std::fs::write(path, text).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
}

#[test]
fn missing_trust_and_changed_known_hosts_or_serving_receipt_are_not_accepted() {
    let f = Fixture::new();
    let valid = json!({"environmentId":f.env.id,"generation":f.env.generation,"protocol":1,"platform":"macos","runtimeSha256":f.pinned().runtime_sha256,"identity":{"macosAccount":f.pinned().account}});
    let record = f
        .root
        .path()
        .join("macos-personalization")
        .join(&f.pinned().bootstrap_id)
        .join("record.json");
    let bytes = std::fs::read(&record).unwrap();
    std::fs::remove_file(&record).unwrap();
    assert!(f.call("describe", json!({})).is_err());
    assert_eq!(f.deliveries(), 0);
    journal::atomic_private_write(&record, &bytes).unwrap();
    f.reply(valid.clone());
    assert_eq!(f.call("describe", json!({})).unwrap(), valid);
    let mut wrong = valid;
    wrong["identity"]["macosAccount"]["uid"] = json!(502);
    f.reply(wrong);
    assert!(f.call("describe", json!({})).is_err());
    assert_eq!(f.deliveries(), 2);
    let known = record.parent().unwrap().join("known_hosts");
    journal::atomic_private_write(&known, b"different host key pin\n").unwrap();
    assert!(f.call("describe", json!({})).is_err());
    assert_eq!(f.deliveries(), 2);
    assert_eq!(std::fs::read(&known).unwrap(), b"different host key pin\n");
}

#[test]
fn actual_host_executor_carries_bound_task_and_never_replays_a_lost_receipt() {
    let f = Fixture::new();
    let task = f.task();
    f.reply(json!(task));
    assert!(task
        .guest_cwd
        .starts_with("/Users/personal/.terminalx-local/workspaces/"));
    assert_eq!(task.transport_binding.as_ref(), Some(&f.env.transport));
    std::fs::write(f.root.path().join("lose-next"), "").unwrap();
    assert!(f
        .call("task.start", json!({"task":task,"files":[]}))
        .is_err());
    assert_eq!(f.deliveries(), 1);
    let reopened = Journal::open_existing(f.root.path()).unwrap();
    assert_eq!(
        reopened
            .submit_selected(
                "selected-task",
                task.input.clone(),
                Some(&f.env.transport.target(&f.env.id, &f.env.generation))
            )
            .unwrap(),
        task
    );
    assert_eq!(f.deliveries(), 1);
    assert_eq!(
        f.call("task.poll", json!({"target":task.target,"after":0}))
            .unwrap(),
        json!(task)
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("deliveries")).unwrap(),
        "task.start\ntask.poll\n"
    );
    let request: super::super::guest::Request =
        serde_json::from_slice(&std::fs::read(f.root.path().join("request.json")).unwrap())
            .unwrap();
    assert_eq!(
        request.expected_macos_account.as_ref(),
        Some(&f.pinned().account)
    );
    assert_eq!(request.params["environmentId"], f.env.id);
    assert_eq!(request.params["generation"], f.env.generation);
    let mut wrong = task.clone();
    wrong.input.parent_tab_id = journal::new_id();
    assert!(f
        .call("task.start", json!({"task":wrong,"files":[]}))
        .is_err());
    assert_eq!(f.deliveries(), 2);
    f.reply(json!(wrong));
    assert!(f.call("task.poll", json!({"target":task.target})).is_err());
    let mut changed = f.env.clone();
    let Transport::MacosPersonalized { binding } = &mut changed.transport else {
        unreachable!()
    };
    binding.runtime_sha256 = "f".repeat(64);
    f.journal
        .transaction(|s| {
            s.environments.insert(changed.id.clone(), changed.clone());
            Ok(())
        })
        .unwrap();
    assert!(f.journal.claim(&task.target).is_err());
    assert!(f.call("task.poll", json!({"target":task.target})).is_err());
    assert_eq!(f.journal.read().unwrap().tasks.len(), 1);
}

#[test]
fn changed_target_trust_key_account_and_private_file_are_refused_before_ssh() {
    let f = Fixture::new();
    f.reply(json!({"available":false}));
    for field in [
        "runtimeSha256",
        "trustDigest",
        "keyReference",
        "account",
        "target",
    ] {
        let mut value = json!(f.env);
        let b = &mut value["transport"]["binding"];
        match field {
            "keyReference" => b[field] = json!(journal::new_id()),
            "account" => b[field]["homeInode"] = json!(43),
            "target" => b[field]["vmFingerprint"] = json!("f".repeat(64)),
            _ => b[field] = json!("f".repeat(64)),
        }
        let changed: Environment = serde_json::from_value(value).unwrap();
        assert!(
            rpc_using(
                f.root.path(),
                &f.journal,
                &changed,
                "describe",
                json!({}),
                &f.endpoint(),
                &f.programs(),
                Duration::from_secs(2)
            )
            .is_err(),
            "{field}"
        );
    }
    let mut endpoint = f.endpoint();
    endpoint.target.generation = journal::new_id();
    assert!(rpc_using(
        f.root.path(),
        &f.journal,
        &f.env,
        "describe",
        json!({}),
        &endpoint,
        &f.programs(),
        Duration::from_secs(2)
    )
    .is_err());
    let private = f
        .root
        .path()
        .join("macos-personalization-keys")
        .join(&f.pinned().key_reference)
        .join("private_key");
    std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(f.call("describe", json!({})).is_err());
    std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(&private, "changed synthetic fixture").unwrap();
    assert!(f.call("describe", json!({})).is_err());
    std::fs::remove_file(&private).unwrap();
    std::os::unix::fs::symlink(f.root.path().join("public-key"), &private).unwrap();
    assert!(f.call("describe", json!({})).is_err());
    assert_eq!(f.deliveries(), 0);
}

#[test]
fn key_reference_unknown_retired_and_missing_history_never_generate_again() {
    let f = Fixture::new();
    let record = f.prepare();
    assert_eq!(record["state"], "ready");
    assert_eq!(
        macos_keys::prepare_using(f.root.path(), f.pinned(), &f.keygen, || panic!(
            "key regenerated"
        ))
        .unwrap(),
        record
    );
    let path = f
        .root
        .path()
        .join("macos-personalization-keys")
        .join(&f.pinned().key_reference)
        .join("record.json");
    let mut unknown = record.clone();
    unknown["state"] = json!("outcomeUnknown");
    unknown.as_object_mut().unwrap().remove("receipt");
    journal::atomic_private_write(&path, &serde_json::to_vec(&unknown).unwrap()).unwrap();
    assert_eq!(
        macos_keys::prepare_using(f.root.path(), f.pinned(), &f.keygen, || panic!(
            "uncertain key regenerated"
        ))
        .unwrap(),
        unknown
    );
    assert!(
        macos_keys::resolve(f.root.path(), f.pinned(), &f.keygen, Duration::from_secs(2)).is_err()
    );
    journal::atomic_private_write(&path, &serde_json::to_vec(&record).unwrap()).unwrap();
    macos_keys::resolve(f.root.path(), f.pinned(), &f.keygen, Duration::from_secs(2)).unwrap();
    macos_keys::retire(f.root.path(), f.pinned()).unwrap();
    assert!(
        macos_keys::resolve(f.root.path(), f.pinned(), &f.keygen, Duration::from_secs(2)).is_err()
    );
    std::fs::remove_file(&path).unwrap();
    assert!(
        macos_keys::prepare_using(f.root.path(), f.pinned(), &f.keygen, || panic!(
            "missing history reset"
        ))
        .is_err()
    );
}

#[test]
fn personalized_setup_installer_supervisor_and_desktop_preserve_binding_and_gates() {
    let f = Fixture::new();
    let plan = install_plan(&f.env, &f.pinned().runtime_sha256).unwrap();
    assert_eq!(plan.identity["macosAccount"], json!(f.pinned().account));
    assert!(plan
        .plist
        .contains("/Users/personal/.terminalx-local/runtime"));
    assert!(!plan.plist.contains("/Users/lume"));
    assert!(install_plan(&f.env, &"f".repeat(64)).is_err());
    let report = super::super::setup::initial(&f.env, "codex", "guided").unwrap();
    assert_eq!(report["transportBinding"], json!(f.env.transport));
    assert_ne!(report["status"], "complete");
    assert!(rpc(&f.env, "describe", json!({}), Duration::from_secs(1)).is_err());
    assert!(super::super::host::guest_rpc(&f.env, "describe", json!({})).is_err());
    assert!(install(&f.env, Path::new("/must-not-read-credential-or-runtime")).is_err());
    let before=f.journal.read().unwrap();
    assert!(super::super::setup::action(&f.journal,json!({"environmentId":f.env.id,"generation":f.env.generation,"action":"provider.codexAccount.verify","idempotencyKey":"not-dispatched","confirm":true})).is_err());
    assert_eq!(json!(f.journal.read().unwrap()),json!(before));
    let lease = super::super::attachment::Binding {
        environment_id: f.env.id.clone(),
        generation: f.env.generation.clone(),
        lease_id: journal::new_id(),
        session_id: journal::new_id(),
        tab_id: journal::new_id(),
        conversation: Some("original".into()),
    };
    let mut rpc = |_: &Environment, method: &str, params: Value| -> Result<Value> {
        Ok(match method {
            "desktop.attachmentCapabilities" => {
                json!({"attachmentProtocol":1,"platform":"macos","environmentId":f.env.id,"generation":f.env.generation,"available":true,"runtimeSha256":f.pinned().runtime_sha256})
            }
            "desktop.attachmentAcquire" => json!({"binding":params,"releasedAt":null,"calls":{}}),
            _ => bail!("fixture must refuse before desktop routing"),
        })
    };
    let mut adapter = super::super::attachment::Adapter::begin(
        f.root.path(),
        &f.journal,
        lease.clone(),
        &mut rpc,
    )
    .unwrap();
    let mut wrong = json!(lease);
    wrong["conversation"] = json!("replaced");
    assert!(f.call("desktop.attachmentTools", wrong).is_err());
    let mut changed = f.env.clone();
    let Transport::MacosPersonalized { binding } = &mut changed.transport else {
        unreachable!()
    };
    binding.account.home_inode += 1;
    f.journal
        .transaction(|s| {
            s.environments.insert(changed.id.clone(), changed.clone());
            Ok(())
        })
        .unwrap();
    assert!(adapter.tools(&mut rpc).is_err());
    assert!(super::super::admission::has_reservations(f.root.path()).unwrap());
    assert_eq!(f.deliveries(), 0);
    let mut legacy = f.env.clone();
    legacy.transport = Transport::MacosLume;
    assert!(json!(legacy).get("transport").is_none());
    assert!(super::super::supervisor::guest_plist(&legacy)
        .unwrap()
        .contains("/Users/lume/.terminalx-local"));
}
