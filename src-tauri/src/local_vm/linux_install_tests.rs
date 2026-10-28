use super::*;
use std::os::{fd::AsRawFd, unix::fs::PermissionsExt};

struct Fixture {
    dir: tempfile::TempDir,
    driver: std::path::PathBuf,
    journal: Journal,
    binding: InstallBinding,
    artifact: linux_profile::VerifiedArtifact,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("guest");
        std::fs::create_dir(&home).unwrap();
        let target = Target::LinuxContainer {
            runtime: crate::computer_targets::Runtime::Docker,
            id: "a".repeat(64),
        };
        let account = Account {
            name: "cua".into(),
            uid: 1000,
            gid: 1000,
            home: "/home/cua".into(),
            home_device: 1,
            home_inode: 2,
            architecture: Architecture::Arm64,
        };
        std::fs::write(
            dir.path().join("account.json"),
            serde_json::to_vec(&account).unwrap(),
        )
        .unwrap();
        std::fs::write(dir.path().join("inspection.json"),json!({"Id":"a".repeat(64),"Config":{"Labels":{"ai.terminalx.computer":"1"}},"State":{"Running":true,"Paused":false,"Restarting":false},"Mounts":[],"HostConfig":{"Privileged":false,"PidMode":"private"}}).to_string()).unwrap();
        let driver = dir.path().join("engine-fixture");
        std::fs::write(&driver,r#"#!/usr/bin/env python3
import sys,json,pathlib,types
root=pathlib.Path(__file__).parent
args=sys.argv[1:]
if args[0]=='inspect':
 assert args==['inspect','--format','{{json .}}','a'*64]
 print((root/'inspection.json').read_text());sys.exit(0)
assert args[:10]==['exec','-i','--user','cua','--workdir','/home/cua','a'*64,'/usr/bin/python3','-I','-c']
assert len(args)==11
module=types.ModuleType('disposable_guest_installer')
exec(compile(args[10],'<installer-source>','exec'),module.__dict__)
header=json.loads(sys.stdin.buffer.readline())
observed=json.loads((root/'account.json').read_text())
if header=={'action':'account'}:
 result=observed
else:
 with (root/'calls').open('a') as out: out.write(header['action']+'\n')
 data=sys.stdin.buffer.read() if header['action']=='install' else None
 def interrupt():
  if (root/'interrupt').exists(): raise RuntimeError('fixture interruption after durable intent')
 result=module.transact(root/'guest',observed,header,data,interrupt)
 if header['action']=='install' and (root/'lose').exists(): sys.exit(73)
print(json.dumps({'ok':True,'result':result}))
"#).unwrap();
        std::fs::set_permissions(&driver, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut bytes = vec![0_u8; 64];
        bytes[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
        bytes[16] = 3;
        bytes[18] = 183;
        bytes[20] = 1;
        bytes[52] = 64;
        let path = dir.path().join("fixture.elf");
        std::fs::write(&path, &bytes).unwrap();
        let catalog=json!({"version":1,"profiles":[{"id":"fixture","sourceCommit":"a".repeat(40),"protocol":1,"architecture":"arm64","sha256":journal::digest(&bytes),"bytes":64}]}).to_string();
        let artifact = linux_profile::fixture(&catalog, &path, Architecture::Arm64).unwrap();
        let binding = InstallBinding {
            target,
            environment_id: journal::new_id(),
            generation: journal::new_id(),
            architecture: Architecture::Arm64,
            account: Some(account),
        };
        let journal = Journal::open(&dir.path().join("host")).unwrap();
        Self {
            dir,
            driver,
            journal,
            binding,
            artifact,
        }
    }
    fn root(&self) -> std::path::PathBuf {
        self.dir.path().join("host")
    }
    fn prepare(&self, key: &str) -> Value {
        linux_profile::prepare(&self.root(), key, &self.binding, &self.artifact).unwrap()
    }
    fn deliver(&self, key: &str) -> Value {
        linux_profile::execute_prepared(
            &self.root(),
            &self.journal,
            key,
            |binding, path, intent| {
                let bytes = std::fs::read(path)?;
                invoke_at(
                    &self.driver,
                    &binding.target,
                    &header("install", key, intent)?,
                    Some(&bytes),
                )?;
                invoke_at(
                    &self.driver,
                    &binding.target,
                    &header("receipt", key, intent)?,
                    None,
                )
            },
        )
        .unwrap()
    }
    fn reconcile(&self, key: &str) -> Result<Value> {
        linux_profile::reconcile_prepared(&self.root(), key, true, |binding, intent| {
            invoke_at(
                &self.driver,
                &binding.target,
                &header("receipt", key, intent)?,
                None,
            )
        })
    }
}

#[test]
fn serving_enrollment_requires_original_account_artifact_and_exclusive_ownership() {
    let f = Fixture::new();
    let key = "installed-serving";
    f.prepare(key);
    let installed = f.deliver(key);
    assert_eq!(installed["status"], "installed");
    f.journal
        .transaction(|s| {
            s.enabled = true;
            Ok(())
        })
        .unwrap();
    let observed = json!({"environmentId":f.binding.environment_id,"generation":f.binding.generation,"protocol":1,"platform":"linux",
        "runtimeSha256":installed["intent"]["runtimeSha256"],"taskMode":"shellFiles","manualControl":false,
        "identity":{"environmentId":f.binding.environment_id,"generation":f.binding.generation,"protocol":1,"account":f.binding.account}});
    for field in ["generation", "runtimeSha256", "identity", "manualControl"] {
        let mut changed = observed.clone();
        changed[field] = if field == "manualControl" {
            json!(true)
        } else {
            json!("changed")
        };
        assert!(
            enroll_serving_using(&f.root(), &f.journal, key, |_| Ok(changed)).is_err(),
            "{field}"
        );
    }
    assert!(f.journal.read().unwrap().environments.is_empty());
    let attached = Guard::attach(&f.root(), &f.binding.target, &f.journal).unwrap();
    assert!(enroll_serving_using(&f.root(), &f.journal, key, |_| panic!(
        "routed while desktop owned"
    ))
    .is_err());
    attached.completed().unwrap();
    let complete = enroll_serving_using(&f.root(), &f.journal, key, |env| {
        assert_eq!(env.transport.container(), Some(f.binding.target.clone()));
        Ok(observed.clone())
    })
    .unwrap();
    assert_eq!(complete["enrollment"]["status"], "verified");
    assert_eq!(complete["ready"], false);
    assert_eq!(
        complete["enrollment"]["environment"]["id"],
        f.binding.environment_id
    );
    // Model loss of the final local receipt after durable journal enrollment.
    journal::atomic_private_write(
        &linux_profile::directory(&f.root(), key)
            .unwrap()
            .join("receipt.json"),
        &serde_json::to_vec(&installed).unwrap(),
    )
    .unwrap();
    let reopened = Journal::open_existing(&f.root()).unwrap();
    enroll_serving_using(&f.root(), &reopened, key, |_| Ok(observed.clone())).unwrap();
    assert_eq!(reopened.read().unwrap().environments.len(), 1);
    let env = reopened.read().unwrap().environments[&f.binding.environment_id].clone();
    let task = reopened
        .submit_selected(
            "selected",
            journal::TaskInput {
                parent_session_id: journal::new_id(),
                parent_tab_id: journal::new_id(),
                parent_message_id: "selected".into(),
                environment_id: env.id.clone(),
                prompt: "fixture".into(),
                harness: "codex".into(),
                model: "gpt-6-astra".into(),
                effort: None,
                permission_mode: "manual".into(),
                files: vec![],
                desktop: false,
            },
            Some(&env.transport.target(&env.id, &env.generation)),
        )
        .unwrap();
    assert!(enroll_serving_using(&f.root(), &reopened, key, |_| panic!(
        "routed while task owned"
    ))
    .is_err());
    assert_eq!(reopened.read().unwrap().tasks[&task.target.task_id], task);
    // The public compiled-catalog boundary remains unavailable to fixtures.
    assert!(linux_profile::trusted_record(&f.root(), key).is_err());
}

#[test]
fn real_guest_installer_retains_lost_reply_and_reconciles_original_receipt_without_reinstall() {
    let fixture = Fixture::new();
    let prepared = fixture.prepare("once");
    std::fs::write(fixture.dir.path().join("lose"), "").unwrap();
    let lost = fixture.deliver("once");
    assert_eq!(lost["status"], "outcomeUnknown");
    assert!(Guard::attach(&fixture.root(), &fixture.binding.target, &fixture.journal).is_err());
    assert!(super::super::admission::inspect(&fixture.root(), &fixture.binding.target).is_err());
    assert_eq!(fixture.deliver("once"), lost);
    assert!(linux_profile::trusted_record(&fixture.root(), "once").is_err()); // Fixtures never enter production delivery.
    let account = fixture.binding.account.as_ref().unwrap();
    let mut replaced = account.clone();
    replaced.uid += 1;
    std::fs::write(
        fixture.dir.path().join("account.json"),
        serde_json::to_vec(&replaced).unwrap(),
    )
    .unwrap();
    assert!(fixture.reconcile("once").is_err());
    std::fs::write(
        fixture.dir.path().join("account.json"),
        serde_json::to_vec(account).unwrap(),
    )
    .unwrap();
    let lock = std::fs::OpenOptions::new()
        .write(true)
        .open(
            fixture
                .dir
                .path()
                .join("guest/.terminalx-installs/installer.lock"),
        )
        .unwrap();
    // SAFETY: lock owns the descriptor for this contention fixture.
    assert_eq!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    assert!(fixture.reconcile("once").is_err());
    drop(lock);
    let receipt = fixture.reconcile("once").unwrap();
    assert_eq!(receipt["status"], "installed");
    assert_eq!(receipt["ready"], false);
    assert_eq!(receipt["inputDigest"], prepared["inputDigest"]);
    assert_eq!(receipt["receipt"]["receipt"]["intent"], prepared["intent"]);
    Guard::acquire(&fixture.root(), &fixture.binding.target).unwrap();
    let calls = std::fs::read_to_string(fixture.dir.path().join("calls")).unwrap();
    assert_eq!(calls.lines().filter(|line| *line == "install").count(), 1);
    assert!(fixture
        .dir
        .path()
        .join("guest/.terminalx-local/account-binding.json")
        .exists());
}

#[test]
fn interrupted_guest_intent_and_competing_ownership_stay_fenced() {
    let fixture = Fixture::new();
    fixture.prepare("partial");
    let desktop =
        Guard::attach(&fixture.root(), &fixture.binding.target, &fixture.journal).unwrap();
    assert!(linux_profile::execute_prepared(
        &fixture.root(),
        &fixture.journal,
        "partial",
        |_, _, _| panic!("desktop conflict delivered install")
    )
    .is_err());
    desktop.completed().unwrap();
    std::fs::write(fixture.dir.path().join("interrupt"), "").unwrap();
    let unknown = fixture.deliver("partial");
    assert_eq!(unknown["status"], "outcomeUnknown");
    assert!(fixture.reconcile("partial").is_err());
    assert_eq!(fixture.deliver("partial"), unknown);
    assert!(!fixture.dir.path().join("guest/.terminalx-local").exists());
    let Target::LinuxContainer { runtime, id } = fixture.binding.target.clone() else {
        unreachable!()
    };
    let selected = Target::LinuxGuest {
        runtime,
        id,
        environment_id: fixture.binding.environment_id.clone(),
        generation: fixture.binding.generation.clone(),
    };
    let input = journal::TaskInput {
        parent_session_id: journal::new_id(),
        parent_tab_id: journal::new_id(),
        parent_message_id: "selected".into(),
        environment_id: fixture.binding.environment_id.clone(),
        prompt: "fixture".into(),
        harness: "codex".into(),
        model: "gpt-6-astra".into(),
        effort: None,
        permission_mode: "manual".into(),
        files: vec![],
        desktop: false,
    };
    assert!(fixture
        .journal
        .submit_selected("task", input, Some(&selected))
        .unwrap_err()
        .to_string()
        .contains("no confirmed exit"));
    let calls = std::fs::read_to_string(fixture.dir.path().join("calls")).unwrap();
    assert_eq!(calls.lines().filter(|line| *line == "install").count(), 1);
}

#[test]
fn target_artifact_account_and_production_catalog_fail_closed_before_installation() {
    let fixture = Fixture::new();
    let prepared = fixture.prepare("bound");
    assert!(available_profile("fixture").is_err());
    assert!(prepare(
        &fixture.root(),
        &fixture.journal,
        &fixture.binding.target,
        "production",
        "fixture"
    )
    .is_err());
    assert!(!fixture.dir.path().join("calls").exists());
    let mut target = fixture.binding.target.clone();
    if let Target::LinuxContainer { id, .. } = &mut target {
        *id = "b".repeat(64);
    }
    assert!(validate_target(&prepared, &target, None).is_err());
    assert!(validate_target(&prepared, &fixture.binding.target, Some("changed")).is_err());
    let mut account = fixture.binding.account.clone().unwrap();
    account.home = "/root".into();
    assert!(account.validate().is_err());
    assert!(invoke_at(
        &fixture.driver,
        &fixture.binding.target,
        &header("install", "bound", &prepared["intent"]).unwrap(),
        Some(b"changed artifact")
    )
    .is_err());
    assert!(!fixture.dir.path().join("guest/.terminalx-local").exists());
    let inspection = fixture.dir.path().join("inspection.json");
    let mut changed: Value = serde_json::from_slice(&std::fs::read(&inspection).unwrap()).unwrap();
    changed["Id"] = json!("b".repeat(64));
    std::fs::write(&inspection, changed.to_string()).unwrap();
    assert!(invoke_at(
        &fixture.driver,
        &fixture.binding.target,
        &json!({"action":"account"}),
        None
    )
    .is_err());
    changed["Id"] = json!("a".repeat(64));
    changed["Mounts"] = json!([{"Type":"bind","Source":"/host"}]);
    std::fs::write(&inspection, changed.to_string()).unwrap();
    assert!(invoke_at(
        &fixture.driver,
        &fixture.binding.target,
        &json!({"action":"account"}),
        None
    )
    .is_err());
    let known = Target::LinuxGuest {
        runtime: crate::computer_targets::Runtime::Docker,
        id: "a".repeat(64),
        environment_id: fixture.binding.environment_id.clone(),
        generation: fixture.binding.generation.clone(),
    };
    fixture
        .journal
        .enroll_container("retained", &known, &"e".repeat(64))
        .unwrap();
    assert!(linux_profile::execute_prepared(
        &fixture.root(),
        &fixture.journal,
        "bound",
        |_, _, _| panic!("replaced enrolled history")
    )
    .is_err());
}
