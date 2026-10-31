//! The first strict connection with a synthetic SSH stand-in in disposable
//! fixture roots. Nothing here starts a real ssh, reads a real key or reaches
//! a guest; the stand-in checks the argv and stdin it is given and answers as
//! the test's mode file says.
use super::super::macos_transport::tests::Fixture;
use super::*;
use std::{os::unix::fs::PermissionsExt, path::PathBuf};

/// Checks the strict plan and its single pinned `known_hosts` line, records
/// the command and stdin, then replies per `first-mode`.
const STAND_IN: &str = r#"#!/usr/bin/python3
import json,sys,pathlib,os,time
p=pathlib.Path(__file__).parent
a=sys.argv[1:]
assert a[:2]==['-F','none'] and a[a.index('-l')+1]=='personal'
for flag in ['BatchMode=yes','StrictHostKeyChecking=yes','IdentitiesOnly=yes','IdentityAgent=none','PasswordAuthentication=no',
  'KbdInteractiveAuthentication=no','UpdateHostKeys=no','GlobalKnownHostsFile=/dev/null','ForwardAgent=no','ClearAllForwardings=yes',
  'ProxyCommand=none','ControlPath=none','PermitLocalCommand=no','HostKeyAlgorithms=ssh-ed25519']:
 assert flag in a,flag
for bad in ['accept-new','StrictHostKeyChecking=no','ssh-keyscan','-A']:
 assert not any(bad==x or ('=' in bad and bad in x) for x in a),bad
assert a.count('-i')==1 and a[a.index('-i')+1].endswith('/private_key')
assert not any(k in os.environ for k in ['SSH_AUTH_SOCK','SSH_ASKPASS','TERMINALX_NEXT_TOKEN','OPENAI_API_KEY','ANTHROPIC_API_KEY'])
known=next(x for x in a if x.startswith('UserKnownHostsFile='))[len('UserKnownHostsFile='):].strip('"')
alias=next(x for x in a if x.startswith('HostKeyAlias='))[len('HostKeyAlias='):]
assert pathlib.Path(known).read_text().splitlines()==[alias+' '+(p/'public-key').read_text()]
command=a[-1]
(p/'first-command').write_text(command)
nonce=sys.stdin.read()
(p/'first-stdin').write_text(nonce)
mode=(p/'first-mode').read_text() if (p/'first-mode').exists() else 'exact'
with (p/'first-runs').open('a') as f:f.write(mode+'\n')
binding=json.loads((p/'first-binding.json').read_text())
result={'bootstrapId':binding['bootstrapId'],'nonce':nonce.strip(),'stage':'firstConnectionVerified','uid':binding['uid']}
if mode=='exit':sys.exit(3)
if mode=='slow':time.sleep(30)
if mode=='otherNonce':result['nonce']='0'*64
if mode=='otherAccount':result['uid']=502
if mode=='otherBootstrap':result['bootstrapId']='another'
if mode=='extra':result['ready']=True
if mode=='refusal':print(json.dumps({'ok':False,'error':'refused'}));sys.exit(0)
if mode=='notJson':print('verified');sys.exit(0)
if mode=='oversize':result['padding']='x'*5000
print(json.dumps({'ok':True,'result':result}))
"#;

pub(in crate::local_vm) struct First {
    pub(in crate::local_vm) f: Fixture,
    ssh: PathBuf,
}
impl First {
    pub(in crate::local_vm) fn new() -> Self {
        Self::with(Fixture::new())
    }
    pub(in crate::local_vm) fn with(f: Fixture) -> Self {
        let ssh = f.root.path().join("fake-first-ssh");
        std::fs::write(&ssh, STAND_IN).unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o700)).unwrap();
        let pinned = f.pinned();
        std::fs::write(
            f.root.path().join("first-binding.json"),
            json!({"bootstrapId": pinned.bootstrap_id, "uid": pinned.account.uid}).to_string(),
        )
        .unwrap();
        Self { f, ssh }
    }
    fn file(&self, name: &str) -> PathBuf {
        self.f.root.path().join(name)
    }
    fn mode(&self, mode: &str) {
        std::fs::write(self.file("first-mode"), mode).unwrap();
    }
    pub(in crate::local_vm) fn run(&self, budget: Duration) -> Result<Value> {
        verify_using(
            self.f.root.path(),
            &self.f.env,
            &self.f.endpoint(),
            &Programs {
                ssh: &self.ssh,
                keygen: &self.f.keygen,
            },
            budget,
        )
    }
    fn runs(&self) -> usize {
        std::fs::read_to_string(self.file("first-runs"))
            .unwrap_or_default()
            .lines()
            .count()
    }
    fn receipt(&self) -> PathBuf {
        directory(self.f.root.path(), self.f.pinned()).join(RECEIPT)
    }
    fn known_hosts(&self) -> PathBuf {
        directory(self.f.root.path(), self.f.pinned()).join("known_hosts")
    }
}

#[test]
fn production_entries_refuse_at_admission_before_any_process_key_or_network_effect() {
    let first = First::new();
    let error = verify(&first.f.env).unwrap_err();
    assert!(format!("{error:#}").contains("unavailable"), "{error:#}");
    let error = super::super::macos_delivery::deliver(&first.f.env, Path::new("/nonexistent"), "upload").unwrap_err();
    assert!(format!("{error:#}").contains("unavailable"), "{error:#}");
    assert_eq!(first.runs(), 0);
    assert!(!first.receipt().exists());
    assert!(!first.known_hosts().exists(), "no pin is even written before admission");
}

#[test]
fn the_strict_pinned_connection_records_only_the_exact_echoed_check_once() {
    let first = First::new();
    let receipt = first.run(Duration::from_secs(10)).unwrap();
    let pinned = first.f.pinned();
    let nonce = receipt["nonce"].as_str().unwrap().to_owned();
    assert_eq!(std::fs::read_to_string(first.file("first-stdin")).unwrap(), format!("{nonce}\n"));
    let command = std::fs::read_to_string(first.file("first-command")).unwrap();
    assert_eq!(receipt, json!({"version": 1, "bootstrapId": pinned.bootstrap_id, "target": pinned.target,
        "account": pinned.account, "trustDigest": pinned.trust_digest, "keyReference": pinned.key_reference,
        "knownHostsSha256": journal::digest(&std::fs::read(first.known_hosts()).unwrap()), "evidence": EVIDENCE,
        "ready": false, "nonce": nonce, "publicKeySha256": journal::digest(first.f.public.as_bytes()),
        "remoteSha256": journal::digest(command.as_bytes())}));
    // The remote check names exactly this account, home, key line and host key.
    assert!(command.starts_with("/bin/sh -c "));
    for token in [
        "test \"$(/usr/bin/id -u)\" = 501".to_string(),
        "test \"$(/usr/bin/id -g)\" = 20".into(),
        "test \"$(/usr/bin/id -un)\" = personal".into(),
        "NFSHomeDirectory: /Users/personal".into(),
        "/usr/bin/stat -f %d '\\''/Users/personal'\\'')\" = 1".into(),
        "/usr/bin/stat -f %i '\\''/Users/personal'\\'')\" = 42".into(),
        format!("restrict {} terminalx-bootstrap:{}", first.f.public, pinned.bootstrap_id),
        "/usr/bin/grep -c -x -F -e".into(),
        format!("/etc/ssh/ssh_host_ed25519_key.pub)\" = '\\''{}'\\''", first.f.public),
        "IFS= read -r nonce".into(),
    ] {
        assert!(command.contains(&token), "{token} in {command}");
    }
    for effect in ["sudo", "launchctl", "rm ", "mkdir", "chmod", "chown", "mv ", "ssh-keygen", "ssh-keyscan", "known_hosts", ">"] {
        assert!(!command.contains(effect), "{effect} in {command}");
    }
    assert_eq!(verified(first.f.root.path(), pinned).unwrap(), receipt);
    assert_eq!(first.run(Duration::from_secs(10)).unwrap(), receipt, "recorded once");
    assert_eq!(first.runs(), 1, "no second connection");
}

#[test]
fn a_failed_slow_oversized_or_different_reply_records_nothing_and_may_run_again() {
    let first = First::new();
    let modes = ["exit", "slow", "oversize", "notJson", "refusal", "otherNonce", "otherAccount", "otherBootstrap", "extra"];
    for mode in modes {
        first.mode(mode);
        // The slow stand-in outlives its budget and is stopped there.
        let budget = Duration::from_secs(if mode == "slow" { 2 } else { 10 });
        let error = first.run(budget).unwrap_err();
        assert!(!first.receipt().exists(), "{mode}: {error:#}");
        assert!(verified(first.f.root.path(), first.f.pinned()).is_err(), "{mode}");
    }
    // One bounded run per attempt, never a retry. A slow run stopped before the
    // stand-in started leaves no line.
    let runs = std::fs::read_to_string(first.file("first-runs")).unwrap();
    for mode in modes {
        let count = runs.lines().filter(|line| *line == mode).count();
        assert!(count == 1 || (mode == "slow" && count == 0), "{mode}: {runs}");
    }
    first.mode("exact");
    assert_eq!(first.run(Duration::from_secs(10)).unwrap()["evidence"], EVIDENCE);
}

#[test]
fn changed_target_pin_or_receipt_is_refused_and_never_replaced() {
    // A changed VM or pin is refused before any process starts.
    let first = First::new();
    let mut endpoint = first.f.endpoint();
    endpoint.target.vm_fingerprint = "c".repeat(64);
    let programs = Programs {
        ssh: &first.ssh,
        keygen: &first.f.keygen,
    };
    assert!(verify_using(first.f.root.path(), &first.f.env, &endpoint, &programs, Duration::from_secs(10)).is_err());
    assert_eq!(first.runs(), 0);
    let receipt = first.run(Duration::from_secs(10)).unwrap();
    let pinned = first.f.pinned();
    let bytes = std::fs::read(first.receipt()).unwrap();

    // A receipt that no longer describes this binding stays fenced.
    for (name, change) in [
        ("another trust", json!({"trustDigest": "0".repeat(64)})),
        ("another key", json!({"keyReference": journal::new_id()})),
        ("claimed readiness", json!({"ready": true})),
        ("malformed nonce", json!({"nonce": "not hex"})),
    ] {
        let mut altered = receipt.clone();
        for (k, v) in change.as_object().unwrap() {
            altered[k] = v.clone();
        }
        std::fs::remove_file(first.receipt()).unwrap();
        macos_keys::write_new(&first.receipt(), &serde_json::to_vec(&altered).unwrap()).unwrap();
        assert!(first.run(Duration::from_secs(10)).is_err(), "{name}");
        assert!(verified(first.f.root.path(), pinned).is_err(), "{name}");
        assert_eq!(std::fs::read(first.receipt()).unwrap(), serde_json::to_vec(&altered).unwrap(), "{name}: never replaced");
    }
    std::fs::remove_file(first.receipt()).unwrap();
    macos_keys::write_new(&first.receipt(), &bytes).unwrap();
    assert_eq!(verified(first.f.root.path(), pinned).unwrap(), receipt);

    // A changed pin makes the recorded check stale and refuses a new one.
    std::fs::remove_file(first.known_hosts()).unwrap();
    macos_keys::write_new(&first.known_hosts(), b"another pin\n").unwrap();
    assert!(verified(first.f.root.path(), pinned).is_err());
    std::fs::remove_file(first.receipt()).unwrap();
    assert!(first.run(Duration::from_secs(10)).is_err());
    assert_eq!(first.runs(), 1, "no connection over a changed pin");
    assert_eq!(std::fs::read(first.known_hosts()).unwrap(), b"another pin\n");
}
