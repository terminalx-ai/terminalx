//! The version-3 key claim with a synthetic producer in disposable
//! directories: one original key per binding through lost replies, concurrent
//! claims, crashes, changed bindings and missing or corrupt history.
use super::*;
use std::os::unix::fs::PermissionsExt;

struct Claim {
    _temp: tempfile::TempDir,
    planned: String,
    base: PathBuf,
    keys: PathBuf,
    journal: Directory,
    utility: PathBuf,
    public: String,
}
fn public_key(fill: u8) -> String {
    let mut bytes = 11_u32.to_be_bytes().to_vec();
    bytes.extend(b"ssh-ed25519");
    bytes.extend(32_u32.to_be_bytes());
    bytes.extend([fill; 32]);
    format!("ssh-ed25519 {}", STANDARD.encode(bytes))
}
fn binding(account: &str) -> Value {
    json!({"version": 3, "bootstrapId": "boot", "bindingDigest": "a".repeat(64), "ownerEpoch": "epoch",
        "account": {"name": account, "uid": 501}, "answerSha256": "b".repeat(64),
        "parentSession": "session", "parentTab": "tab", "parentConversation": "original"})
}
impl Claim {
    fn new() -> Self {
        let temp = tempfile::Builder::new().prefix("txk").tempdir_in("/private/tmp").unwrap();
        let base = temp.path().canonicalize().unwrap();
        let (keys, journal) = (base.join("root"), base.join("bo"));
        for dir in [&keys, &journal] {
            std::fs::create_dir(dir).unwrap();
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let public = public_key(9);
        std::fs::write(base.join("public-key"), &public).unwrap();
        let utility = base.join("synthetic-ssh-keygen");
        std::fs::write(&utility, r#"#!/usr/bin/python3
import os,sys,pathlib,time
root=pathlib.Path(__file__).parent;a=sys.argv[1:]
assert not any(k in os.environ for k in ['SSH_AUTH_SOCK','SSH_ASKPASS'])
if a[:2]==['-y','-f']:
 assert pathlib.Path(a[2]).read_bytes()==b'synthetic fixture material, never a real key'
 print((root/'public-key').read_text());sys.exit(0)
assert a[:8]==['-q','-t','ed25519','-N','','-C','terminalx-local-vm','-f'] and len(a)==9
with (root/'generation-count').open('a') as out:out.write('once\n')
if (root/'slow').exists():time.sleep(0.4)
p=pathlib.Path(a[8]);p.write_bytes(b'synthetic fixture material, never a real key')
if (root/'partial-output').exists():sys.exit(71)
p.with_name(p.name+'.pub').write_text((root/'public-key').read_text()+' terminalx-local-vm\n')
"#).unwrap();
        std::fs::set_permissions(&utility, std::fs::Permissions::from_mode(0o700)).unwrap();
        // SAFETY: geteuid has no preconditions.
        let journal = Directory::open(&journal, unsafe { libc::geteuid() }, true).unwrap();
        Self { _temp: temp, planned: journal::new_id(), base, keys, journal, utility, public }
    }
    fn claim(&self, binding: &Value) -> Result<(String, String)> {
        original_key(&self.journal, &self.keys, &self.planned, binding, &self.utility, Duration::from_secs(5))
    }
    fn generations(&self) -> usize {
        std::fs::read_to_string(self.base.join("generation-count")).map(|s| s.lines().count()).unwrap_or(0)
    }
    fn references(&self) -> Vec<String> {
        let parent = self.keys.join("macos-personalization-keys");
        let mut names: Vec<String> = std::fs::read_dir(parent).map(|d| d.map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
        names.sort();
        names
    }
    fn intent(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.base.join("bo/key-intent.json")).unwrap()).unwrap()
    }
}

#[test]
fn the_original_key_is_generated_once_and_a_lost_reply_or_retry_returns_it() {
    let c = Claim::new();
    let (reference, public) = c.claim(&binding("personal")).unwrap();
    assert_eq!((reference.as_str(), public.as_str()), (c.planned.as_str(), c.public.as_str()), "the planned reference, never a fresh one");
    assert_eq!((c.generations(), c.references()), (1, vec![reference.clone()]));
    for _ in 0..3 {
        assert_eq!(c.claim(&binding("personal")).unwrap(), (reference.clone(), public.clone()), "a retry returns the original");
    }
    assert_eq!(c.generations(), 1);
    assert_eq!(c.intent(), json!({"binding": binding("personal"), "keyReference": reference}));
    let intent = std::fs::read_to_string(c.base.join("bo/key-intent.json")).unwrap();
    assert!(!intent.contains("synthetic fixture material") && !intent.contains("ssh-ed25519"), "the intent names no key material");
    let private = c.keys.join("macos-personalization-keys").join(&reference).join("private_key");
    assert_eq!(std::fs::metadata(&private).unwrap().mode() & 0o777, 0o600);
    let record: Value = serde_json::from_slice(&std::fs::read(private.with_file_name("record.json")).unwrap()).unwrap();
    assert_eq!(record["binding"]["keyReference"], reference.as_str());
    assert_eq!(record["binding"]["account"], binding("personal")["account"]);
}

#[test]
fn concurrent_claims_produce_one_key_and_only_its_reference() {
    let c = Claim::new();
    std::fs::write(c.base.join("slow"), b"").unwrap();
    let barrier = std::sync::Barrier::new(4);
    let results: Vec<Result<(String, String)>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4).map(|_| scope.spawn(|| {
            barrier.wait();
            c.claim(&binding("personal"))
        })).collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert_eq!(c.generations(), 1, "one generation");
    let original = c.claim(&binding("personal")).unwrap();
    assert_eq!(original.0, c.intent()["keyReference"]);
    for result in results {
        match result {
            Ok(found) => assert_eq!(found, original),
            Err(error) => assert!(format!("{error:#}").contains("in use"), "{error:#}"),
        }
    }
    assert_eq!(c.references(), vec![c.planned.clone()], "only the planned reference");
    assert_eq!(c.generations(), 1);
}

#[test]
fn a_changed_or_replaced_binding_never_creates_or_replaces_a_key() {
    let c = Claim::new();
    let original = c.claim(&binding("personal")).unwrap();
    let mut epoch = binding("personal");
    epoch["ownerEpoch"] = json!("replaced");
    let mut parent = binding("personal");
    parent["parentTab"] = json!("another-tab");
    for changed in [binding("other"), epoch, parent] {
        let error = c.claim(&changed).unwrap_err();
        assert!(format!("{error:#}").contains("belongs to another"), "{error:#}");
    }
    assert_eq!((c.generations(), c.references()), (1, vec![original.0.clone()]));
    assert_eq!(c.claim(&binding("personal")).unwrap(), original);
}

#[test]
fn missing_or_corrupt_key_history_stays_fenced_and_is_never_regenerated() {
    for mode in ["missingReference", "corruptRecord", "corruptIntent", "changedPrivate", "extraIntentField"] {
        let c = Claim::new();
        let (reference, _) = c.claim(&binding("personal")).unwrap();
        let dir = c.keys.join("macos-personalization-keys").join(&reference);
        let replace = |path: PathBuf, bytes: &[u8]| {
            std::fs::remove_file(&path).unwrap();
            std::fs::write(&path, bytes).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        };
        match mode {
            "missingReference" => std::fs::rename(&dir, c.base.join("moved-away")).unwrap(),
            "corruptRecord" => replace(dir.join("record.json"), b"{"),
            "corruptIntent" => replace(c.base.join("bo/key-intent.json"), b"{"),
            "changedPrivate" => replace(dir.join("private_key"), b"changed synthetic bytes"),
            _ => {
                let mut intent = c.intent();
                intent["publicKey"] = json!(public_key(7));
                replace(c.base.join("bo/key-intent.json"), &canonical(&intent).unwrap());
            }
        }
        for _ in 0..2 {
            assert!(c.claim(&binding("personal")).is_err(), "{mode}");
        }
        assert_eq!(c.generations(), 1, "{mode}");
        assert!(c.references().iter().all(|r| *r == c.planned), "{mode}: no second reference");
    }
}

#[test]
fn an_interrupted_generation_is_never_repeated() {
    let c = Claim::new();
    std::fs::write(c.base.join("partial-output"), b"").unwrap();
    assert!(c.claim(&binding("personal")).is_err());
    let reference = c.intent()["keyReference"].as_str().unwrap().to_string();
    std::fs::remove_file(c.base.join("partial-output")).unwrap();
    for _ in 0..2 {
        let error = c.claim(&binding("personal")).unwrap_err();
        assert!(!format!("{error:#}").is_empty());
    }
    assert_eq!((c.generations(), c.references()), (1, vec![reference.clone()]));
    let record: Value = serde_json::from_slice(&std::fs::read(c.keys.join("macos-personalization-keys").join(&reference).join("record.json")).unwrap()).unwrap();
    assert_eq!(record["state"], "outcomeUnknown");
}

#[test]
fn a_crash_before_publication_or_before_generation_still_yields_one_key() {
    // Reserved but never published (also with only the lock created): the
    // claim publishes the same planned reference and generates once.
    for lock_only in [false, true] {
        let c = Claim::new();
        let mut bound = binding("personal");
        bound["keyReference"] = json!(c.planned);
        if lock_only {
            let dir = c.keys.join("macos-personalization-keys").join(&c.planned);
            std::fs::create_dir_all(&dir).unwrap();
            for path in [dir.parent().unwrap(), dir.as_path()] {
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            std::fs::write(dir.join("operation.lock"), b"").unwrap();
            std::fs::set_permissions(dir.join("operation.lock"), std::fs::Permissions::from_mode(0o600)).unwrap();
        } else {
            crate::local_vm::macos_keys::reserve(&c.keys, &c.planned, &crate::local_vm::macos_keys::Bound::of(&bound).unwrap()).unwrap();
        }
        assert_eq!(c.claim(&binding("personal")).unwrap().0, c.planned);
        assert_eq!((c.generations(), c.references()), (1, vec![c.planned.clone()]));
    }

    // Published but not yet generated: generated once, then only returned.
    let c = Claim::new();
    let mut bound = binding("personal");
    bound["keyReference"] = json!(c.planned);
    crate::local_vm::macos_keys::reserve(&c.keys, &c.planned, &crate::local_vm::macos_keys::Bound::of(&bound).unwrap()).unwrap();
    c.journal.write_new("key-intent.json", &canonical(&json!({"binding": binding("personal"), "keyReference": c.planned})).unwrap()).unwrap();
    assert_eq!(c.claim(&binding("personal")).unwrap().0, c.planned);
    assert_eq!(c.claim(&binding("personal")).unwrap().0, c.planned);
    assert_eq!(c.generations(), 1);

    // The planned reference already holds another binding's history: fenced.
    let c = Claim::new();
    let mut other = binding("other");
    other["keyReference"] = json!(c.planned);
    crate::local_vm::macos_keys::reserve(&c.keys, &c.planned, &crate::local_vm::macos_keys::Bound::of(&other).unwrap()).unwrap();
    assert!(c.claim(&binding("personal")).is_err());
    assert!(c.claim(&binding("personal")).is_err());
    assert_eq!(c.generations(), 0);
}
