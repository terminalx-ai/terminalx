//! A phone's session controls (`sessionControls`): each is the desktop's own
//! operation behind the device checks a phone's send has.
use super::*;
use crate::local_runtime::{mobile::{self, Actor}, Lifetime};
use serde_json::{json, Value};
use std::time::Duration;

const CHANGES: &[&str] = &["stop", "interrupt", "setModel", "setEffort", "setMode", "resendUnsent", "continue"];

struct Phone {
    manager: SessionManager,
    lifetime: Arc<Lifetime>,
    actor: Actor,
    _home: store::TempHome,
}

impl Phone {
    /// A Claude tab in `auto`, and two paired phones: one that drives, one that only reads.
    fn paired() -> Self {
        let home = store::temp_home();
        let root = store::root().unwrap();
        let session: index::SessionEntry = serde_json::from_value(json!({
            "id":"phone-controls", "projectPath":root, "cwd":root, "title":"fixture", "created":index::now(), "modified":index::now(),
            "tabs":[{"id":"tab","harness":"claude","model":"opus","permissionMode":"auto","created":index::now()}]
        })).unwrap();
        index::save(&[session]).unwrap();
        // An answered exchange: context to continue from, and nothing unsent.
        let said = |seq: u64, payload: Value| json!({"id":format!("e{seq}"),"sessionId":"phone-controls","tabId":"tab","harness":"claude","seq":seq,"ts":index::now(),"payload":payload}).to_string();
        std::fs::write(store::log_path("phone-controls", "tab").unwrap(), format!("{}\n{}\n",
            said(1, json!({"type":"user_message","text":"fix the build","queued":false})),
            said(2, json!({"type":"assistant_text","text":"The build passes now."})))).unwrap();
        let device = |id: &str, scope: &str| json!({"id":id,"label":id,"platform":"test","token":format!("{id}-hash"),"scope":scope,"provenance":"explicit","bindingGeneration":0,"createdAt":index::now()});
        store::write_json(&root.join("devices.json"), &json!({"devices":[device("driver", "driver"), device("viewer", "viewer")]})).unwrap();
        let manager = SessionManager::new(Arc::new(crate::sink::BroadcastSink::new(256)),
            Arc::new(crate::sink::NoObserver), Arc::new(Host::new()), Arc::new(pty::Terminals::new()),
            Arc::new(Default::default()), Arc::new(Default::default()), crate::hooks::prepare_control().unwrap());
        let lifetime = Lifetime::new(Duration::from_secs(60));
        let lease = lifetime.command("runtime.attach", json!({"protocol":1})).unwrap();
        let actor: Actor = serde_json::from_value(json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
        manager.mobile.register(&lifetime, actor.clone(), "driving", "driver").unwrap();
        manager.mobile.register(&lifetime, actor.clone(), "reading", "viewer").unwrap();
        Phone { manager, lifetime, actor, _home: home }
    }

    fn call(&self, connection: &str, method: &str, mut params: Value) -> Result<Value> {
        params["actor"] = serde_json::to_value(&self.actor).unwrap();
        params["connection"] = json!(connection);
        params["sessionId"] = json!("phone-controls");
        params["tabId"] = json!("tab");
        mobile::execute(&self.manager, &self.lifetime, method, params)
    }

    fn tab(&self) -> index::TabEntry {
        index::get("phone-controls").unwrap().tab("tab").unwrap().clone()
    }
}

/// What each change carries beyond the tab.
fn params(method: &str) -> Value {
    match method {
        "setModel" => json!({"model":"sonnet"}),
        "setEffort" => json!({"effort":"high"}),
        "setMode" => json!({"mode":"plan"}),
        "continue" => json!({"tab":{"harness":"claude","model":"","permissionMode":"auto"},"prompt":"carry on"}),
        _ => json!({}),
    }
}

#[test]
fn a_phone_controls_a_tab_as_the_desktop_does() {
    let phone = Phone::paired();
    let tab = phone.call("driving", "tab", json!({})).unwrap();
    assert_eq!((&tab["harness"], &tab["model"], &tab["permissionMode"], &tab["status"]), (&json!("claude"), &json!("opus"), &json!("auto"), &json!("idle")));
    phone.call("driving", "setModel", params("setModel")).unwrap();
    phone.call("driving", "setEffort", params("setEffort")).unwrap();
    phone.call("driving", "setMode", params("setMode")).unwrap();
    let after = phone.tab();
    assert_eq!((after.model.as_str(), after.effort.as_deref(), after.permission_mode.as_str()), ("sonnet", Some("high"), "plan"));
    assert_eq!(phone.call("driving", "interrupt", json!({})).unwrap(), json!({"interrupted": false}), "nothing was running");
    assert_eq!(phone.call("driving", "stop", json!({})).unwrap(), Value::Null);
    let context = phone.call("driving", "prepareContinuation", json!({})).unwrap();
    assert_eq!((&context["sessionId"], &context["tabId"]), (&json!("phone-controls"), &json!("tab")));
    let refused = phone.call("driving", "resendUnsent", json!({})).unwrap_err();
    assert!(refused.to_string().contains("no unanswered prompt"), "{refused:#}");
}

#[test]
fn a_read_only_phone_reads_a_tab_but_changes_nothing() {
    let phone = Phone::paired();
    assert_eq!(phone.call("reading", "tab", json!({})).unwrap()["model"], "opus");
    phone.call("reading", "prepareContinuation", json!({})).unwrap();
    for method in CHANGES {
        let refused = phone.call("reading", method, params(method)).unwrap_err();
        assert!(refused.to_string().contains("read-only"), "{method}: {refused:#}");
    }
    let tab = phone.tab();
    assert_eq!((tab.model.as_str(), tab.permission_mode.as_str()), ("opus", "auto"));
    assert_eq!(index::get("phone-controls").unwrap().tabs.len(), 1, "no tab was added");
}

#[test]
fn a_revoked_phone_can_do_nothing() {
    let phone = Phone::paired();
    phone.manager.mobile.revoke_device(&phone.actor, "driver").unwrap();
    for method in CHANGES.iter().chain(&["tab", "prepareContinuation"]) {
        assert!(phone.call("driving", method, params(method)).is_err(), "{method} after revocation");
    }
    assert_eq!(phone.tab().model, "opus");
}

#[test]
fn a_tab_another_session_holds_is_refused() {
    let phone = Phone::paired();
    let mut call = json!({"actor": phone.actor, "connection": "driving", "sessionId": "phone-controls", "tabId": "elsewhere"});
    for method in ["stop", "tab"] {
        let refused = mobile::execute(&phone.manager, &phone.lifetime, method, call.clone()).unwrap_err();
        assert!(refused.to_string().contains("does not belong"), "{method}: {refused:#}");
    }
    call["tabId"] = json!("tab");
    assert!(mobile::execute(&phone.manager, &phone.lifetime, "tab", call).is_ok());
}

/// Resending to a tab that is mid-turn is a phone's send like any other: it
/// waits for the turn, under this phone's permit, instead of being refused.
#[test]
fn a_resend_to_a_busy_tab_waits_for_its_turn() {
    let phone = Phone::paired();
    let unanswered = json!({"id":"e1","sessionId":"phone-controls","tabId":"tab","harness":"claude","seq":1,"ts":index::now(),
        "payload":{"type":"user_message","text":"fix the build","queued":false}});
    std::fs::write(store::log_path("phone-controls", "tab").unwrap(), format!("{unanswered}\n")).unwrap();
    phone.manager.runtime("phone-controls", "tab").unwrap().lock().unwrap().turn_open = true;
    let outcome = phone.call("driving", "resendUnsent", json!({})).unwrap();
    assert_eq!(outcome["queued"], true);
    assert!(phone.manager.mobile.has_pending(), "held for the end of the turn");
}
