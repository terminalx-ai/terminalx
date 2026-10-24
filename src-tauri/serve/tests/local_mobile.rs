//! Real local-owner RPC admission with disposable paired-device records. No
//! credentials, installed desktop, account service or mobile relay is used.
#![cfg(unix)]
mod common;
use common::agent::{count, AgentWorld, Serve};
use serde_json::{json, Value};

fn devices(world: &AgentWorld) {
    let records: Vec<_> = [("driver", "driver"), ("viewer", "viewer"), ("scoped", "session")]
        .into_iter().map(|(id, scope)| json!({
            "id":id,"label":"Disposable device","platform":"test","token":"fixture-hash",
            "scope":scope,"provenance":"explicit","bindingGeneration":0,"createdAt":"2026-01-01T00:00:00Z"
        })).collect();
    std::fs::write(world.data.join("devices.json"), serde_json::to_vec(&json!({"devices":records})).unwrap()).unwrap();
}
fn actor(serve: &Serve) -> Value {
    let lease = serve.control("runtime.attach", json!({"protocol":1}));
    json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})
}
fn register(serve: &Serve, actor: &Value, connection: &str, device: &str) {
    serve.control("runtime.mobile.register", json!({"actor":actor,"connection":connection,"deviceId":device}));
}

#[test]
fn paired_permissions_remain_owner_scoped_and_cannot_be_answered_by_a_viewer() {
    let world = AgentWorld::new();
    devices(&world);
    let serve = Serve::start(world.command(), &world.data);
    let actor = actor(&serve);
    register(&serve, &actor, "driver-connection", "driver");
    register(&serve, &actor, "viewer-connection", "viewer");
    let created = serve.control("sessions.create", json!({"project":world.project,"agent":"claude",
        "prompt":"ask:echo mobile-approval","mode":"manual","useWorktree":false,"onMain":true}));
    let tab = &created["tabId"];
    assert_eq!(serve.control("wait", json!({"target":tab,"timeoutSeconds":10}))["reason"], "permission");
    let pending = serve.control("permissions.list", json!({}));
    let mut answer = json!({"actor":actor,"connection":"viewer-connection","sessionId":created["sessionId"],
        "tabId":tab,"requestId":pending["permissions"][0]["requestId"],"optionId":"allow"});
    assert_eq!(serve.try_control("runtime.mobile.permission",answer.clone())["ok"],false);
    assert_eq!(pending,serve.control("permissions.list",json!({})));
    answer["connection"] = json!("driver-connection");
    answer["sessionId"] = json!("wrong-session");
    assert_eq!(serve.try_control("runtime.mobile.permission",answer.clone())["ok"],false);
    assert_eq!(pending,serve.control("permissions.list",json!({})));
    answer["sessionId"] = created["sessionId"].clone();
    serve.control("runtime.mobile.permission",answer.clone());
    serve.wait_events(tab.as_str().unwrap(),"mobile decision",|events|count(events,"turn_completed")==1);
    assert_eq!(serve.try_control("runtime.mobile.permission",answer)["ok"],false,"an answered request cannot be replayed");
}

#[test]
fn device_revocation_and_owner_detach_fence_registered_connections_without_replay() {
    let world = AgentWorld::new();
    devices(&world);
    let serve = Serve::start(world.command(), &world.data);
    let actor = actor(&serve);
    register(&serve,&actor,"first","driver");
    let check = json!({"actor":actor,"connection":"first"});
    serve.control("runtime.mobile.check",check.clone());
    serve.control("runtime.mobile.revoke",json!({"actor":actor,"deviceId":"driver"}));
    assert_eq!(serve.try_control("runtime.mobile.check",check)["ok"],false);
    // Even before the desktop commits its registry file, this lease cannot
    // recreate a revoked grant by presenting the same persisted device.
    assert_eq!(serve.try_control("runtime.mobile.register",json!({"actor":actor,"connection":"replacement","deviceId":"driver"}))["ok"],false);
    register(&serve,&actor,"viewer","viewer");
    serve.control("runtime.detach",actor.clone());
    assert_eq!(serve.try_control("runtime.mobile.check",json!({"actor":actor,"connection":"viewer"}))["ok"],false);
    assert_eq!(serve.try_control("runtime.mobile.register",json!({"actor":actor,"connection":"new-viewer","deviceId":"viewer"}))["ok"],false);
}

#[test]
fn mobile_registration_rejects_scoped_credentials_wrong_account_and_stale_generation() {
    let world = AgentWorld::new();
    devices(&world);
    std::fs::write(world.data.join("account.json"), serde_json::to_vec(&json!({"userId":"account-one",
        "email":"fixture@example.invalid","displayName":"Fixture","bindingGeneration":3})).unwrap()).unwrap();
    let serve = Serve::start(world.command(), &world.data);
    let mut actor = actor(&serve);
    actor["userId"] = json!("account-two");
    assert_eq!(serve.try_control("runtime.mobile.register",json!({"actor":actor,"connection":"bad-account","deviceId":"driver"}))["ok"],false);
    actor["userId"] = json!("account-one");
    assert_eq!(serve.try_control("runtime.mobile.register",json!({"actor":actor,"connection":"scoped","deviceId":"scoped"}))["ok"],false);
    register(&serve,&actor,"old","driver");
    serve.control("runtime.mobile.clear",json!({"actor":actor}));
    assert_eq!(serve.try_control("runtime.mobile.register",json!({"actor":actor,"connection":"replay","deviceId":"driver"}))["ok"],false);
    let old = actor.clone();
    actor["generation"] = json!(2);
    register(&serve,&actor,"current","driver");
    assert_eq!(serve.try_control("runtime.mobile.check",json!({"actor":old,"connection":"old"}))["ok"],false);
    assert_eq!(serve.try_control("runtime.mobile.register",json!({"actor":old,"connection":"late","deviceId":"driver"}))["ok"],false);
    serve.control("runtime.mobile.check",json!({"actor":actor,"connection":"current"}));
}

#[test]
fn queued_mobile_follow_up_is_delivered_by_the_owner_after_the_permission_pause() {
    let world = AgentWorld::new();
    devices(&world);
    let serve = Serve::start(world.command(), &world.data);
    let actor = actor(&serve);
    register(&serve,&actor,"driver","driver");
    let created = serve.control("sessions.create",json!({"project":world.project,"agent":"claude",
        "prompt":"ask:echo first-turn","mode":"manual","useWorktree":false,"onMain":true}));
    let tab = created["tabId"].as_str().unwrap();
    assert_eq!(serve.control("wait",json!({"target":tab,"timeoutSeconds":10}))["reason"],"permission");
    let queued = serve.control("runtime.mobile.send",json!({"actor":actor,"connection":"driver",
        "sessionId":created["sessionId"],"tabId":tab,"text":"mobile-follow-up","prompt":"mobile-follow-up","images":[]}));
    assert_eq!(queued["queued"],true);
    let pending = serve.control("permissions.list",json!({}));
    serve.control("permissions.allow",json!({"request":pending["permissions"][0]["requestId"]}));
    let events = serve.wait_events(tab,"queued mobile follow-up",|events| count(events,"turn_completed")==2);
    assert_eq!(common::agent::texts(&events,"user_message"),["ask:echo first-turn","mobile-follow-up"]);
}

#[test]
fn revocation_mode_changes_and_tab_stop_cancel_already_queued_mobile_input() {
    for fence in ["revoke","mode","mode-aba","stop"] {
        let world = AgentWorld::new();
        devices(&world);
        let serve = Serve::start(world.command(), &world.data);
        let actor = actor(&serve);
        register(&serve,&actor,"driver","driver");
        let created = serve.control("sessions.create",json!({"project":world.project,"agent":"claude",
            "prompt":"ask:echo blocked-turn","mode":"manual","useWorktree":false,"onMain":true}));
        let session = created["sessionId"].as_str().unwrap();
        let tab = created["tabId"].as_str().unwrap();
        assert_eq!(serve.control("wait",json!({"target":tab,"timeoutSeconds":10}))["reason"],"permission");
        assert_eq!(serve.control("runtime.mobile.send",json!({"actor":actor,"connection":"driver",
            "sessionId":session,"tabId":tab,"text":"must-not-be-delivered","prompt":"must-not-be-delivered","images":[]}))["queued"],true);
        match fence {
            "revoke" => { serve.control("runtime.mobile.revoke",json!({"actor":actor,"deviceId":"driver"})); }
            "mode" | "mode-aba" => {
                serve.control("runtime.session.mode",json!({"sessionId":session,"tabId":tab,"mode":"auto"}));
                if fence == "mode-aba" {
                    serve.control("runtime.session.mode",json!({"sessionId":session,"tabId":tab,"mode":"manual"}));
                }
            }
            _ => { serve.control("runtime.session.stop",json!({"sessionId":session,"tabId":tab})); }
        }
        if fence != "stop" {
            let pending = serve.control("permissions.list",json!({}));
            serve.control("permissions.allow",json!({"request":pending["permissions"][0]["requestId"]}));
            serve.wait_events(tab,"fenced first turn",|events|count(events,"turn_completed")==1);
        }
        // Drain is an explicit test synchronization point; it runs the same
        // owner delivery loop as the detached scheduler, with no test timer.
        serve.control("runtime.mobile.drain",json!({"actor":actor,"connection":"driver"}));
        let events = serve.events(tab);
        assert!(!common::agent::texts(&events,"user_message").iter().any(|text| text=="must-not-be-delivered"),"{fence}");
    }
}

#[test]
fn mobile_observation_replays_then_streams_only_its_admitted_tab_and_revocation_closes_it() {
    let world = AgentWorld::new();
    devices(&world);
    let serve = Serve::start(world.command(), &world.data);
    let actor = actor(&serve);
    register(&serve,&actor,"viewer","viewer");
    let created = serve.control("sessions.create",json!({"project":world.project,"agent":"claude",
        "prompt":"echo:before-mobile-observe","mode":"manual","useWorktree":false,"onMain":true}));
    let session = &created["sessionId"];
    let tab = created["tabId"].as_str().unwrap();
    serve.wait_events(tab,"initial observation output",|events|count(events,"turn_completed")==1);
    let mut request = json!({"actor":actor,"connection":"viewer","sessionId":session,"tabId":tab,
        "attachMode":"control","client":{"type":"mobile"},"capabilities":{}});
    assert_eq!(serve.try_control("runtime.mobile.observe",request.clone())["ok"],false);
    request["attachMode"] = json!("observe");
    request["sessionId"] = json!("other-session");
    assert_eq!(serve.try_control("runtime.mobile.observe",request.clone())["ok"],false);
    request["sessionId"] = session.clone();
    let observed = serve.control("runtime.mobile.observe",request);
    assert!(observed["serialized"].as_str().unwrap().contains("before-mobile-observe"));
    serve.control("send",json!({"target":tab,"text":"echo:after-mobile-observe"}));
    serve.wait_events(tab,"live observation output",|events|count(events,"turn_completed")==2);
    let mut output = String::new();
    common::agent::wait_until("ordered mobile output",|| {
        let packets = serve.control("runtime.mobile.output",json!({"actor":actor,"connection":"viewer"}));
        for packet in packets.as_array().unwrap() {
            assert_eq!(packet["subscriptionId"],observed["subscriptionId"]);
            output.push_str(packet["text"].as_str().unwrap());
        }
        output.contains("after-mobile-observe").then_some(())
    });
    assert!(!output.contains("before-mobile-observe"),"replayed history must not be sent again as live output");
    serve.control("runtime.mobile.revoke",json!({"actor":actor,"deviceId":"viewer"}));
    assert_eq!(serve.try_control("runtime.mobile.output",json!({"actor":actor,"connection":"viewer"}))["ok"],false);
}

// The Stop hook publishes turn completion before the fixture's finally block
// clears its input-loop busy flag. Observe that actual provider boundary instead
// of assuming that a persisted completion event means raw input starts a turn.
fn provider_idle_barrier(world: &AgentWorld) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let executable = world.bin.join("claude");
    let fixture = std::fs::canonicalize(&executable).unwrap();
    let ready = world.home.join("provider-idle.log");
    let wrapper = format!(r#"#!/usr/bin/env python3
import runpy
module = runpy.run_path({fixture})
original = module["Fake"].run_turn
def observed(self, prompt):
    original(self, prompt)
    with open({ready}, "a") as output:
        output.write("idle\n")
module["Fake"].run_turn = observed
module["main"]()
"#,fixture=serde_json::to_string(&fixture).unwrap(),ready=serde_json::to_string(&ready).unwrap());
    std::fs::remove_file(&executable).unwrap(); // Disposable fixture symlink only.
    std::fs::write(&executable,wrapper).unwrap();
    std::fs::set_permissions(&executable,std::fs::Permissions::from_mode(0o700)).unwrap();
    ready
}

fn wait_provider_idle(path: &std::path::Path, turns: usize) {
    common::agent::wait_until("provider input loop idle",|| {
        (std::fs::read_to_string(path).unwrap_or_default().lines().count() >= turns).then_some(())
    });
}

#[test]
fn terminal_driver_lease_is_authoritative_at_owner_and_cannot_be_taken_by_a_viewer() {
    use base64::Engine as _;
    let world = AgentWorld::new();
    devices(&world);
    let idle = provider_idle_barrier(&world);
    let serve = Serve::start(world.command(), &world.data);
    let actor = actor(&serve);
    for (connection,device) in [("viewer","viewer"),("first","driver"),("second","driver")] { register(&serve,&actor,connection,device); }
    let created = serve.control("sessions.create",json!({"project":world.project,"agent":"claude",
        "prompt":"echo:driver-ready","mode":"manual","useWorktree":false,"onMain":true}));
    let tab = created["tabId"].as_str().unwrap();
    serve.wait_events(tab,"driver ready",|events|count(events,"turn_completed")==1);
    wait_provider_idle(&idle,1);
    let mut input = json!({"actor":actor,"connection":"viewer","sessionId":created["sessionId"],"tabId":tab,"text":"echo:mobile-raw\r"});
    assert_eq!(serve.try_control("runtime.mobile.input",input.clone())["ok"],false);
    input["connection"] = json!("first");
    serve.control("runtime.mobile.input",input.clone());
    serve.wait_events(tab,"mobile raw input",|events|count(events,"turn_completed")==2);
    wait_provider_idle(&idle,2);
    input["connection"] = json!("second");
    assert_eq!(serve.try_control("runtime.mobile.input",input)["ok"],false);
    assert_eq!(serve.control("runtime.pty.mobileDrivers",json!({})),json!([tab]));
    let pane = serve.control("runtime.session.pane",json!({"sessionId":created["sessionId"],"tabId":tab}))["paneId"].clone();
    let native_input = json!({"id":pane,"data":base64::engine::general_purpose::STANDARD.encode(b"echo:native-after-release\r")});
    assert_eq!(serve.try_control("runtime.pty.write",native_input.clone())["ok"],false);
    serve.control("runtime.mobile.release",json!({"actor":actor,"connection":"first","sessionId":created["sessionId"],"tabId":tab}));
    assert_eq!(serve.control("runtime.pty.mobileDrivers",json!({})),json!([]));
    serve.control("runtime.pty.write",native_input);
    serve.wait_events(tab,"native control after release",|events|count(events,"turn_completed")==3);
}

#[test]
fn replacement_owner_rejects_previous_epoch_mobile_connections_and_registration() {
    let world = AgentWorld::new();
    devices(&world);
    let mut first = Serve::start(world.command(), &world.data);
    let old = actor(&first);
    register(&first,&old,"old-driver","driver");
    first.kill();
    let replacement = Serve::start(world.command(), &world.data);
    assert_eq!(replacement.try_control("runtime.mobile.check",json!({"actor":old,"connection":"old-driver"}))["ok"],false);
    assert_eq!(replacement.try_control("runtime.mobile.register",json!({"actor":old,"connection":"old-driver","deviceId":"driver"}))["ok"],false);
    let current = actor(&replacement);
    assert_ne!(old["epoch"],current["epoch"]);
    register(&replacement,&current,"new-driver","driver");
    replacement.control("runtime.mobile.check",json!({"actor":current,"connection":"new-driver"}));
}
