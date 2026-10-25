//! Hidden, previously-created ACP/OpenCode tabs retain their headless peers,
//! queue and permission authority when the desktop detaches. These are fixture
//! peers using the existing harness protocol examples, not real-provider tests.
#![cfg(unix)]
mod common;
use common::agent::{count, texts, AgentWorld, Serve};
use serde_json::json;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::Path;

#[test]
fn legacy_peers_deliver_queued_turns_and_retain_permissions_without_a_view() {
    for (harness, option) in [("cursor", "allow"), ("opencode", "once")] {
        let world = AgentWorld::new();
        // Known per-user binary directories precede PATH. All three fixture
        // peers must win over any globally installed provider executable.
        std::fs::create_dir_all(world.home.join(".local")).unwrap();
        symlink(&world.bin, world.home.join(".local/bin")).unwrap();
        for (name, fixture) in [
            ("cursor-agent", "local-acp.py"),
            ("opencode", "local-opencode.py"),
        ] {
            let source = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures")
                .join(fixture);
            let destination = world.bin.join(name);
            std::fs::copy(source, &destination).unwrap();
            std::fs::set_permissions(destination, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let mut serve = Serve::start(world.command(), &world.data);
        let created = serve.control(
            "sessions.create",
            json!({
                "project":world.project,"agent":"claude","prompt":"echo:fixture-workspace",
                "useWorktree":false,"onMain":true,"mode":"manual"
            }),
        );
        let session = created["sessionId"].as_str().unwrap();
        serve.wait_events(
            created["tabId"].as_str().unwrap(),
            "initial fixture turn",
            |events| count(events, "turn_completed") == 1,
        );
        // The normal CLI deliberately does not offer these legacy harnesses.
        // Seed a tab through the same internal operation used to retain them.
        let tab = serve.control(
            "runtime.session.addTab",
            json!({
                "sessionId":session,"tab":{"harness":harness,"permissionMode":"manual"}
            }),
        )["id"]
            .as_str()
            .unwrap()
            .to_string();
        let attached = serve.control("runtime.attach", json!({"protocol":1}));
        serve.control("send", json!({"target":tab,"text":"slow:6:250"}));
        let queued = serve.control("send", json!({"target":tab,"text":"queued-after-detach"}));
        assert_eq!(queued["outcome"]["queued"], true);
        serve.control("runtime.detach", attached.clone());
        let events = serve.wait_events(&tab, "queued headless follow-up", |events| {
            count(events, "turn_completed") == 2
        });
        let said = texts(&events, "assistant_text").join("");
        assert!(
            said.contains("chunk 6 of 6") && said.contains("queued-after-detach"),
            "{harness}: {said}"
        );
        serve.control(
            "send",
            json!({"target":tab,"text":"ask:echo private-fixture"}),
        );
        assert_eq!(
            serve.control("wait", json!({"target":tab,"timeoutSeconds":10}))["reason"],
            "permission"
        );
        let pending = serve.control("permissions.list", json!({}));
        let reattached = serve.control("runtime.attach", json!({"protocol":1}));
        assert_eq!(reattached["epoch"], attached["epoch"]);
        assert_eq!(serve.control("permissions.list", json!({})), pending);
        let request = &pending["permissions"][0]["requestId"];
        serve.control(
            "permissions.allow",
            json!({"request":request,"option":option}),
        );
        let events = serve.wait_events(&tab, "retained headless permission", |events| {
            count(events, "turn_completed") == 3
        });
        assert!(texts(&events, "assistant_text")
            .join("")
            .contains("allowed: echo private-fixture"));
        assert_eq!(
            serve.try_control(
                "permissions.allow",
                json!({"request":request,"option":option})
            )["ok"],
            false
        );
        assert!(!events
            .iter()
            .any(|event| event["payload"]["type"] == "recovery"));
        assert_eq!(serve.control("status", json!({}))["pid"], serve.child.id());
        serve.control("runtime.stopAll", json!({"epoch":attached["epoch"]}));
        assert!(common::agent::wait_until("legacy owner stop-all", || serve
            .child
            .try_wait()
            .unwrap())
        .success());
    }
}
