use super::super::linux_install::tests::Fixture;
use super::*;
use std::os::unix::fs::PermissionsExt;
fn enabled(f: &Fixture) {
    f.journal
        .transaction(|s| {
            s.enabled = true;
            Ok(())
        })
        .unwrap();
}
fn observation(header: &Value, status: &str) -> Value {
    json!({"receipt":{"version":1,"binding":{"activationId":header["activationId"],"installation":header["installation"]},
        "status":status,"instance":"11111111-1111-4111-8111-111111111111","cancelRequested":false},"ownerLeaseHeld":true,"terminal":false})
}
#[test]
fn lost_delivery_reopen_and_duplicate_never_relaunch_or_clear_through_desktop_recovery() {
    let f = Fixture::new();
    let key = "activation-fixture";
    f.prepare(key);
    f.deliver(key);
    enabled(&f);
    let record = change_using(&f.root(), &f.journal, key, "start", |_, _| {
        bail!("lost detached reply")
    })
    .unwrap();
    assert_eq!(record["activation"]["status"], "outcomeUnknown");
    assert!(Guard::acquire(&f.root(), &f.binding.target).is_err());
    assert!(super::super::admission::inspect(&f.root(), &f.binding.target).is_err());
    let reopened = Journal::open_existing(&f.root()).unwrap();
    let duplicate = change_using(&f.root(), &reopened, key, "start", |_, _| {
        panic!("replayed activation")
    })
    .unwrap();
    assert_eq!(record, duplicate);
    let mut calls = 0;
    let observed = change_using(&f.root(), &reopened, key, "status", |target, header| {
        calls += 1;
        assert_eq!(target, &f.binding.target);
        assert_eq!(header["action"], "status");
        assert_eq!(header["activationId"], record["activation"]["id"]);
        Ok(observation(header, "running"))
    })
    .unwrap();
    assert_eq!(calls, 1);
    assert_eq!(observed["activation"]["status"], "owned");
    assert_eq!(observed["ready"], false);
    assert!(linux_profile::trusted_record(&f.root(), key).is_err());
    assert_eq!(capability()["available"], false);
    // An unproven owner cannot be canceled by PID or replaced after host restart.
    let failed = change_using(&f.root(), &reopened, key, "cancel", |_, _| {
        bail!("supervisor unavailable")
    })
    .unwrap();
    assert_eq!(failed["activation"]["status"], "outcomeUnknown");
    assert!(Guard::acquire(&f.root(), &f.binding.target).is_err());
}
#[test]
fn changed_receipts_and_competing_ownership_refuse_then_original_stop_releases() {
    let f = Fixture::new();
    let key = "activation-fixture";
    f.prepare(key);
    f.deliver(key);
    enabled(&f);
    let desktop = Guard::attach(&f.root(), &f.binding.target, &f.journal).unwrap();
    assert!(
        change_using(&f.root(), &f.journal, key, "start", |_, _| panic!(
            "desktop owned"
        ))
        .is_err()
    );
    desktop.completed().unwrap();
    change_using(&f.root(), &f.journal, key, "start", |_, _| bail!("lost")).unwrap();
    for field in ["activationId", "installation"] {
        assert!(change_using(&f.root(), &f.journal, key, "status", |_, h| {
            let mut proof = observation(h, "running");
            proof["receipt"]["binding"][field] = json!("changed");
            Ok(proof)
        })
        .is_err());
        assert!(Guard::acquire(&f.root(), &f.binding.target).is_err());
    }
    let stopped = change_using(&f.root(), &f.journal, key, "cancel", |_, h| {
        let mut v = observation(h, "canceled");
        v["receipt"]["exitProof"] = json!("originalChildWait");
        v["receipt"]["exitCode"] = json!(-15);
        v["receipt"]["cancelRequested"] = json!(true);
        v["ownerLeaseHeld"] = json!(false);
        v["terminal"] = json!(true);
        Ok(v)
    })
    .unwrap();
    assert_eq!(stopped["activation"]["status"], "stopped");
    drop(Guard::acquire(&f.root(), &f.binding.target).unwrap());
    assert_eq!(
        change_using(&f.root(), &f.journal, key, "start", |_, _| panic!(
            "replaced owner"
        ))
        .unwrap(),
        stopped
    );
}
#[test]
fn enrollment_requires_original_serving_instance_then_provider_readiness_remains_separate() {
    let f = Fixture::new();
    let key = "activation-fixture";
    f.prepare(key);
    f.deliver(key);
    enabled(&f);
    let record = change_using(&f.root(), &f.journal, key, "start", |_, h| {
        Ok(observation(h, "running"))
    })
    .unwrap();
    let mut description = json!({"environmentId":f.binding.environment_id,"generation":f.binding.generation,"protocol":1,"platform":"linux",
        "runtimeSha256":record["intent"]["runtimeSha256"],"taskMode":"shellFiles","manualControl":false,
        "identity":{"environmentId":f.binding.environment_id,"generation":f.binding.generation,"protocol":1,"account":f.binding.account},
        "activation":{"id":record["activation"]["id"],"instance":"replacement"}});
    assert!(
        linux_install::enroll_serving_using(
            &f.root(),
            &f.journal,
            key,
            |_| Ok(description.clone())
        )
        .is_err()
    );
    description["activation"]["instance"] =
        record["activation"]["observation"]["receipt"]["instance"].clone();
    let enrolled =
        linux_install::enroll_serving_using(
            &f.root(),
            &f.journal,
            key,
            |_| Ok(description.clone()),
        )
        .unwrap();
    assert_eq!(enrolled["enrollment"]["ready"], false);
    assert_eq!(enrolled["ready"], false);
    assert!(
        change_using(&f.root(), &f.journal, key, "cancel", |_, _| panic!(
            "enrolled owner stopped"
        ))
        .is_err()
    );
    drop(Guard::acquire(&f.root(), &f.binding.target).unwrap());
    // Owner reopened after journal enrollment but before final installer receipt.
    save(&f.root(), key, &record).unwrap();
    let reopened = Journal::open_existing(&f.root()).unwrap();
    change_using(&f.root(), &reopened, key, "status", |_, h| {
        Ok(observation(h, "running"))
    })
    .unwrap();
    linux_install::enroll_serving_using(&f.root(), &reopened, key, |_| Ok(description)).unwrap();
    assert_eq!(reopened.read().unwrap().environments.len(), 1);
    let env = reopened.read().unwrap().environments[&f.binding.environment_id].clone();
    let task = reopened
        .submit_selected(
            "activation-task-fixture",
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
    assert!(
        change_using(&f.root(), &reopened, key, "status", |_, _| panic!(
            "active task ownership bypassed"
        ))
        .is_err()
    );
    assert_eq!(reopened.read().unwrap().tasks[&task.target.task_id], task);
}
#[test]
fn engine_adapter_uses_exact_detached_route_and_never_treats_ack_as_owner_receipt() {
    let f = Fixture::new();
    let executable = f.dir.path().join("activation-engine");
    std::fs::write(&executable,r#"#!/usr/bin/env python3
import sys,json,base64
args=sys.argv[1:]
if args[0]=='inspect':
 assert args==['inspect','--format','{{json .}}','a'*64]
 import pathlib
 print((pathlib.Path(__file__).parent/'inspection.json').read_text());sys.exit(0)
assert args[:10]==['exec','--detach','--user','cua','--workdir','/home/cua','a'*64,'/usr/bin/python3','-I','-c']
assert len(args)==12
assert base64.b64decode(args[-1])==b'{"action":"start"}'
print('detached-engine-ack-is-not-a-runtime-receipt')
"#).unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(
        invoke_at(&executable, &f.binding.target, &json!({"action":"start"}))
            .unwrap()
            .is_null()
    );
    std::fs::write(f.dir.path().join("inspection.json"), "{}").unwrap();
    assert!(invoke_at(&executable, &f.binding.target, &json!({"action":"start"})).is_err());
}
#[test]
fn actual_guest_supervisor_protocol_with_disposable_process_fixtures() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("protocol.py");
    // __name__ differs so the production entrypoints never execute.
    let source = format!(
        "{}\n{}",
        script().replace("if __name__ == \"__main__\":", "if False:"),
        include_str!("guest_linux_activation_test.py")
    );
    std::fs::write(&path, source).unwrap();
    let output = Command::new("python3")
        .arg("-I")
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
