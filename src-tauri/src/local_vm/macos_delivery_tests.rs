use super::super::macos_transport::tests::Fixture;
use super::*;
use std::os::unix::fs::PermissionsExt;
pub(in crate::local_vm) struct Delivery {
    f: Fixture,
    artifact: Artifact,
    pub(in crate::local_vm) intent: Intent,
    pub(in crate::local_vm) home: tempfile::TempDir,
}
impl Delivery {
    pub(in crate::local_vm) fn new() -> Self {
        let mut f = Fixture::build(false);
        let mut bytes = vec![0; 64];
        bytes[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        bytes[4..8].copy_from_slice(&0x0100000c_u32.to_le_bytes());
        let sha = journal::digest(&bytes);
        let super::super::transport::Transport::MacosPersonalized { binding } =
            &mut f.env.transport
        else {
            panic!()
        };
        binding.runtime_sha256 = sha.clone();
        f.journal
            .transaction(|s| {
                s.environments.insert(f.env.id.clone(), f.env.clone());
                Ok(())
            })
            .unwrap();
        f.prepare();
        let intent = Intent {
            version: 1,
            request_id: f.pinned().bootstrap_id.clone(),
            environment: f.env.clone(),
            plan: macos_transport::install_plan(&f.env, &sha).unwrap(),
            runtime_bytes: 64,
        };
        Self {
            f,
            artifact: Artifact::verify(bytes, &sha).unwrap(),
            intent,
            home: tempfile::tempdir().unwrap(),
        }
    }
    pub(in crate::local_vm) fn dir(&self) -> PathBuf {
        self.home
            .path()
            .join(".terminalx-bootstrap")
            .join(&self.intent.request_id)
    }
    pub(in crate::local_vm) fn uploaded(&self) -> Value {
        journal::private_directory(&self.home.path().join(".terminalx-bootstrap")).unwrap();
        journal::private_directory(&self.dir()).unwrap();
        macos_keys::write_new(&self.dir().join("loader"), &self.artifact.bytes).unwrap();
        std::fs::set_permissions(
            self.dir().join("loader"),
            std::fs::Permissions::from_mode(0o700),
        )
        .unwrap();
        for file in ["intent", "loader-complete"] {
            macos_keys::write_new(
                &self.dir().join(file),
                self.intent.digest().unwrap().as_bytes(),
            )
            .unwrap();
        }
        json!({"stage":"loaderVerified","inputDigest":self.intent.digest().unwrap(),"runtimeSha256":self.intent.plan.runtime_sha256})
    }
    pub(in crate::local_vm) fn guest(&self, action: &str) -> Result<Value> {
        guest_using(
            self.home.path(),
            &self.f.pinned().account,
            &self.dir().join("loader"),
            &self.intent,
            action,
            |_| Ok(()),
        )
    }
    fn change(&self, action: &str, call: impl FnMut(&str) -> Result<Value>) -> Result<Value> {
        change_using(
            self.f.root.path(),
            &self.f.journal,
            &self.intent,
            &self.artifact,
            action,
            call,
        )
    }
}
#[test]
fn upload_and_installer_lost_replies_reconcile_original_receipts_without_replay() {
    let d = Delivery::new();
    let uploaded = d
        .change("upload", |_| {
            d.uploaded();
            bail!("lost upload reply")
        })
        .unwrap();
    assert_eq!(uploaded["status"], "loaderOutcomeUnknown");
    assert_eq!(uploaded["ready"], false);
    assert_eq!(
        d.change("upload", |_| panic!("upload replayed")).unwrap(),
        uploaded
    );
    assert!(d
        .change("install", |_| panic!("uncertain loader executed"))
        .is_err());
    let proof = json!({"stage":"loaderVerified","inputDigest":d.intent.digest().unwrap(),"runtimeSha256":d.intent.plan.runtime_sha256});
    d.change("loaderReceipt", |action| {
        assert_eq!(action, "loaderReceipt");
        Ok(proof.clone())
    })
    .unwrap();
    let lost = d
        .change("install", |action| {
            d.guest(action)?;
            bail!("lost installer reply")
        })
        .unwrap();
    assert_eq!(lost["status"], "installOutcomeUnknown");
    assert!(d
        .change("install", |_| panic!("installer replayed"))
        .is_err());
    let reopened = Journal::open_existing(d.f.root.path()).unwrap();
    let done = change_using(
        d.f.root.path(),
        &reopened,
        &d.intent,
        &d.artifact,
        "receipt",
        |action| d.guest(action),
    )
    .unwrap();
    assert_eq!(done["status"], "installed");
    assert_eq!(done["ready"], false);
    assert_eq!(done["receipt"]["identity"], d.intent.plan.identity);
    assert!(!d.home.path().join("Library/LaunchAgents").exists());
    assert!(d
        .home
        .path()
        .join(".terminalx-local/com.terminalx.local-guest.plist")
        .exists());
    drop(
        Guard::acquire(
            d.f.root.path(),
            &d.f.env.transport.target(&d.f.env.id, &d.f.env.generation),
        )
        .unwrap(),
    );
    assert_eq!(
        d.change("upload", |_| panic!("completed delivery replayed"))
            .unwrap(),
        done
    );
}
#[test]
fn partial_install_changed_account_runtime_or_receipt_never_release_original_fence() {
    let d = Delivery::new();
    d.change("upload", |_| Ok(d.uploaded())).unwrap();
    let calls = std::cell::Cell::new(0);
    d.change("install", |action| {
        guest_using(
            d.home.path(),
            &d.f.pinned().account,
            &d.dir().join("loader"),
            &d.intent,
            action,
            |_| {
                calls.set(calls.get() + 1);
                if calls.get() > 1 {
                    bail!("fixture signature failure after durable intent")
                }
                Ok(())
            },
        )
    })
    .unwrap();
    assert_eq!(calls.get(), 2);
    assert!(d.guest("receipt").is_err());
    assert!(d.guest("install").is_err());
    assert!(d.change("receipt",|_|Ok(json!({"stage":"installed","inputDigest":"changed","runtimeSha256":d.intent.plan.runtime_sha256}))).is_err());
    assert!(Guard::acquire(
        d.f.root.path(),
        &d.f.env.transport.target(&d.f.env.id, &d.f.env.generation)
    )
    .is_err());
    let mut account = d.f.pinned().account.clone();
    account.home_inode += 1;
    assert!(guest_using(
        d.home.path(),
        &account,
        &d.dir().join("loader"),
        &d.intent,
        "receipt",
        |_| panic!("changed account")
    )
    .is_err());
    let mut intent = d.intent.clone();
    intent.plan.runtime_sha256 = "f".repeat(64);
    assert!(guest_using(
        d.home.path(),
        &d.f.pinned().account,
        &d.dir().join("loader"),
        &intent,
        "receipt",
        |_| panic!("changed runtime")
    )
    .is_err());
}
#[test]
fn host_admission_refuses_competing_ownership_changed_generation_and_unsealed_artifacts() {
    let d = Delivery::new();
    let target = d.f.env.transport.target(&d.f.env.id, &d.f.env.generation);
    let guard = Guard::lock(d.f.root.path(), &target).unwrap();
    journal::atomic_private_write(&guard.marker, b"{\"kind\":\"desktop\"}").unwrap();
    drop(guard);
    assert!(d.change("upload", |_| panic!("competing desktop")).is_err());
    assert!(Artifact::verify(b"not a MachO".to_vec(), &d.intent.plan.runtime_sha256).is_err());
    let mut changed = d.intent.clone();
    changed.environment.generation = journal::new_id();
    assert!(change_using(
        d.f.root.path(),
        &d.f.journal,
        &changed,
        &d.artifact,
        "upload",
        |_| panic!("changed generation")
    )
    .is_err());
    assert!(deliver(
        &d.f.env,
        Path::new("/must-not-read-runtime-or-credentials"),
        "upload"
    )
    .is_err());
}
#[test]
fn actual_ssh_adapter_pins_original_account_and_sends_only_verified_loader_or_intent() {
    let d = Delivery::new();
    let fake = d.f.root.path().join("fake-bootstrap-ssh");
    std::fs::write(&fake,r#"#!/usr/bin/python3
import sys,os,json,base64,pathlib
p=pathlib.Path(__file__).parent;a=sys.argv[1:]
assert a[:2]==['-F','none'] and a[a.index('-l')+1]=='personal'
for flag in ['StrictHostKeyChecking=yes','IdentityAgent=none','PasswordAuthentication=no','ClearAllForwardings=yes','ControlMaster=no']:
 assert flag in a
assert not any(k in os.environ for k in ['SSH_AUTH_SOCK','OPENAI_API_KEY','TERMINALX_NEXT_TOKEN'])
command=a[-1];assert command.startswith('/bin/sh -c ')
for token in ['stat -f %i','stat -f %d','dscl . -read /Users/personal','codesign --verify --strict']:
 assert token in command,token
packet=sys.stdin.buffer.read()
if 'base64 -D' in command:
 assert base64.b64decode(packet)[:4]==b'\xcf\xfa\xed\xfe'
 assert '/bin/mkdir -m 700' in command
else:
 if 'local-vm-bootstrap tools' in command:
  header,body=packet.split(b'\n',1);envelope=json.loads(header)
  assert envelope['intent']['plan']['identity']['macosAccount']['shortName']=='personal'
  assert [s['name'] for s in envelope['profiles']]==['cua-driver','codex']
  assert body==(b'synthetic fixture archives' if 'toolsInstall' in command else b'')
 elif 'local-vm-bootstrap' in command: assert json.loads(packet)['plan']['identity']['macosAccount']['shortName']=='personal'
assert 'sudo' not in command and 'launchctl' not in command
print((p/'bootstrap-reply.json').read_text())
"#).unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(
        d.f.root.path().join("bootstrap-reply.json"),
        "{\"ok\":true,\"result\":{\"fixture\":true}}",
    )
    .unwrap();
    for action in [
        "upload",
        "loaderReceipt",
        "install",
        "receipt",
        "toolsReceipt",
    ] {
        assert_eq!(
            invoke(
                d.f.root.path(),
                &d.intent,
                &d.f.endpoint(),
                &Programs {
                    ssh: &fake,
                    keygen: &d.f.keygen
                },
                action,
                Some(&d.artifact)
            )
            .unwrap()["fixture"],
            true
        );
    }
    // Exercise the real transport/command framing without reading a host tool
    // cache. Catalog-bound archive validation is covered in native tool fixtures.
    let mut packet = serde_json::to_vec(
        &json!({"intent":d.intent,"profiles":super::super::macos_tools::profiles()}),
    )
    .unwrap();
    packet.extend(b"\nsynthetic fixture archives");
    assert_eq!(
        transmit(
            d.f.root.path(),
            &d.intent,
            &d.f.endpoint(),
            &Programs {
                ssh: &fake,
                keygen: &d.f.keygen
            },
            "toolsInstall",
            &packet
        )
        .unwrap()["fixture"],
        true
    );
    let mut endpoint = d.f.endpoint();
    endpoint.target.vm_fingerprint = "c".repeat(64);
    assert!(invoke(
        d.f.root.path(),
        &d.intent,
        &endpoint,
        &Programs {
            ssh: &fake,
            keygen: &d.f.keygen
        },
        "upload",
        Some(&d.artifact)
    )
    .is_err());
}

#[test]
fn tools_delivery_lost_reply_is_its_own_stage_and_catalog_receipt_cannot_change() {
    let d = Delivery::new();
    d.change("upload", |_| Ok(d.uploaded())).unwrap();
    d.change("install", |action| d.guest(action)).unwrap();
    let unknown = d
        .change("toolsInstall", |_| bail!("lost tool installer reply"))
        .unwrap();
    assert_eq!(unknown["status"], "toolsOutcomeUnknown");
    assert!(d
        .change("toolsInstall", |_| panic!("tool install replayed"))
        .is_err());
    assert!(d
        .change("receipt", |_| panic!("runtime receipt cleared tools"))
        .is_err());
    let proof = json!({"stage":"toolsInstalled","inputDigest":d.intent.digest().unwrap(),"runtimeSha256":d.intent.plan.runtime_sha256,"identity":d.intent.plan.identity,"profiles":super::super::macos_tools::profiles(),"exitProof":"terminalReceiptUnderOriginalLock","ready":false});
    let mut changed = proof.clone();
    changed["profiles"] = json!([]);
    assert!(d.change("toolsReceipt", |_| Ok(changed.clone())).is_err());
    let complete = d.change("toolsReceipt", |_| Ok(proof.clone())).unwrap();
    assert_eq!(complete["status"], "complete");
    assert_eq!(complete["ready"], false);
    drop(
        Guard::acquire(
            d.f.root.path(),
            &d.f.env.transport.target(&d.f.env.id, &d.f.env.generation),
        )
        .unwrap(),
    );
}
