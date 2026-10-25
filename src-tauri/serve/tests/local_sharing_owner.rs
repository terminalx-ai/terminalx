//! Real owner processes with disposable stores and verified-identity fixtures.
//! Internal owner RPC never receives an admission boolean or a guest's role.
#![cfg(unix)]
mod common;
use common::agent::{count, texts, AgentWorld, Serve};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;

struct Fixture {
    serve: Serve,
    world: AgentWorld,
    actor: Value,
    window: UnixStream,
    session: String,
    tab: String,
}

impl Fixture {
    fn new(prompt: &str) -> Self {
        Self::with_readiness_gate(prompt, false)
    }

    fn with_readiness_gate(prompt: &str, gated: bool) -> Self {
        let world = AgentWorld::new();
        if gated {
            use std::os::unix::fs::PermissionsExt;
            let cli = world.bin.join("claude");
            std::fs::rename(&cli, world.bin.join("claude-real")).unwrap();
            std::fs::write(&cli, "#!/bin/sh\nwhile [ ! -e \"$HOME/agent-go\" ]; do /bin/sleep 0.02; done\nexec \"$(dirname \"$0\")/claude-real\" \"$@\"\n").unwrap();
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        // An existing idle tab is a fixture, not an empty CLI launch request:
        // sessions.create intentionally requires a prompt or issue.
        let idle = if prompt.is_empty() {
            let session = uuid::Uuid::new_v4().to_string();
            let tab = uuid::Uuid::new_v4().to_string();
            let entry = json!({"id":session,"projectPath":world.project,"cwd":world.project,
                "title":"Sharing fixture","created":"2026-01-01T00:00:00Z","modified":"2026-01-01T00:00:00Z",
                "tabs":[{"id":tab,"harness":"claude","permissionMode":"default","created":"2026-01-01T00:00:00Z"}]});
            std::fs::create_dir_all(world.data.join("sessions")).unwrap();
            std::fs::write(
                world.data.join("sessions/index.json"),
                serde_json::to_vec(&json!({"sessions":[entry]})).unwrap(),
            )
            .unwrap();
            Some(json!({"sessionId":session,"tabId":tab}))
        } else {
            None
        };
        let serve = Serve::start(world.command(), &world.data);
        let status = serve.control("status", json!({}));
        let mut window =
            UnixStream::connect(status["localRuntime"]["eventSocket"].as_str().unwrap()).unwrap();
        window
            .set_read_timeout(Some(std::time::Duration::from_secs(10)))
            .unwrap();
        writeln!(window, "{}", json!({"protocol":1,"token":serve.token})).unwrap();
        let mut ready = String::new();
        BufReader::new(window.try_clone().unwrap())
            .read_line(&mut ready)
            .unwrap();
        let ready: Value = serde_json::from_str(&ready).unwrap();
        assert_eq!(ready["type"], "ready");
        let lease = ready["attachment"].clone();
        let actor = json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,
            "userId":"host","profileId":"profile","organizationId":"org"});
        serve.control("runtime.sharing.register", json!({"actor":actor}));
        let mut create = json!({"project":world.project, "agent":"claude",
            "useWorktree":false,"onMain":true,"mode":"manual"});
        if !prompt.is_empty() {
            create["prompt"] = json!(prompt);
        }
        let created = idle.unwrap_or_else(|| serve.control("sessions.create", create));
        Self {
            world,
            serve,
            actor,
            window,
            session: created["sessionId"].as_str().unwrap().into(),
            tab: created["tabId"].as_str().unwrap().into(),
        }
    }

    fn params(&self, mut params: Value) -> Value {
        params["actor"] = self.actor.clone();
        params["sessionId"] = json!(self.session);
        params
    }

    fn call(&self, method: &str, params: Value) -> Value {
        self.serve
            .control(&format!("runtime.sharing.{method}"), self.params(params))
    }

    fn refused(&self, method: &str, params: Value) {
        assert_eq!(
            self.serve
                .try_control(&format!("runtime.sharing.{method}"), self.params(params))["ok"],
            false
        );
    }

    fn link(&self, role: &str, approval: bool) {
        let expiry = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64
            + 60_000;
        self.call("create", json!({"linkId":"link","url":"https://terminalx.ai/join#fixture",
            "tokenHash":"fixture-hash","credentialExpiresAt":expiry,"directOnly":true,
            "host":{"userId":"host","displayName":"Host","email":"host@example.invalid","organizationIds":["org"]},
            "settings":{"audience":"anyone","role":role,"people":[],"expiresAt":expiry,
                "approveEachPerson":approval,"canApprove":false,"maximumPeople":4,"singleUse":false}}));
    }

    fn join(&self) -> Value {
        self.call(
            "join",
            json!({"linkId":"link","connectionId":"guest",
            "person":{"userId":"guest-user","displayName":"Guest","email":"guest@example.invalid",
                "emailVerified":true,"organizationIds":[]}}),
        )
    }

    fn guest(&self, method: &str, mut params: Value) -> Value {
        params["sessionId"] = json!(self.session);
        params["tabId"] = json!(self.tab);
        json!({"connectionId":"guest","method":method,"params":params})
    }
}

#[test]
fn owner_enforces_viewer_approval_account_and_session_scope() {
    let fixture = Fixture::new("");
    fixture.link("viewer", true);
    assert_eq!(fixture.join()["admitted"], false);
    fixture.refused("guest", fixture.guest("session.tail", json!({})));
    fixture.call(
        "approve",
        json!({"linkId":"link","userId":"guest-user","allow":true}),
    );
    fixture.call("guest", fixture.guest("session.tail", json!({})));
    fixture.refused(
        "guest",
        fixture.guest("session.send", json!({"text":"not-authorized"})),
    );
    fixture.refused(
        "guest",
        fixture.guest(
            "permission.respond",
            json!({"requestId":"pending","optionId":"allow"}),
        ),
    );
    let mut wrong = fixture.params(json!({}));
    wrong["actor"]["userId"] = json!("another-account");
    assert_eq!(
        fixture.serve.try_control("runtime.sharing.status", wrong)["ok"],
        false
    );
    let mut wrong = fixture.guest("session.tail", json!({}));
    wrong["params"]["sessionId"] = json!("another-session");
    fixture.refused("guest", wrong);
    let mut wrong_tab = fixture.guest("session.tail", json!({}));
    wrong_tab["params"]["tabId"] = json!("another-tab");
    fixture.refused("guest", wrong_tab);
    fixture.refused(
        "guest",
        json!({"connectionId":"guest","method":"runtime.session.send",
        "params":{"sessionId":fixture.session,"tabId":fixture.tab,"text":"not-authorized"}}),
    );
    assert!(texts(&fixture.serve.events(&fixture.tab), "user_message").is_empty());
}

#[test]
fn revocation_cancels_a_queued_followup_before_the_turn_can_finish() {
    let fixture = Fixture::new("ask:echo wait-for-owner");
    assert_eq!(
        fixture
            .serve
            .control("wait", json!({"target":fixture.tab,"timeoutSeconds":10}))["reason"],
        "permission"
    );
    fixture.link("driver", false);
    fixture.join();
    assert_eq!(
        fixture.call(
            "guest",
            fixture.guest("session.queue", json!({"text":"echo:revoked-followup"}))
        )["queued"],
        true
    );
    assert_eq!(
        fixture.serve.try_control(
            "runtime.session.mode",
            json!({"sessionId":fixture.session,"tabId":fixture.tab,"mode":"bypassPermissions"})
        )["ok"],
        false
    );
    fixture.call("revoke", json!({"linkId":"link","removeGuests":true}));
    let pending = fixture.serve.control("permissions.list", json!({}));
    fixture.serve.control(
        "permissions.allow",
        json!({"request":pending["permissions"][0]["requestId"]}),
    );
    fixture
        .serve
        .wait_events(&fixture.tab, "the original turn to finish", |events| {
            count(events, "turn_completed") == 1
        });
    fixture.call("drain", json!({}));
    let events = fixture.serve.events(&fixture.tab);
    assert_eq!(texts(&events, "user_message"), ["ask:echo wait-for-owner"]);
    assert_eq!(fixture.call("status", json!({}))["queue"], json!([]));
    fixture.refused(
        "guest",
        fixture.guest("session.send", json!({"text":"echo:revoked"})),
    );
}

#[test]
fn account_clear_and_attachment_loss_cannot_reanimate_grants() {
    let fixture = Fixture::new("");
    fixture.link("driver", false);
    fixture.join();
    fixture.call("clear", json!({}));
    fixture.refused("register", json!({}));
    fixture.refused(
        "guest",
        fixture.guest("session.send", json!({"text":"echo:stale-account"})),
    );
    let mut next = fixture.actor.clone();
    next["generation"] = json!(2);
    fixture
        .serve
        .control("runtime.sharing.register", json!({"actor":next}));
    fixture.refused("register", json!({}));
    fixture.serve.control(
        "runtime.detach",
        json!({"epoch":fixture.actor["epoch"],"lease":fixture.actor["lease"]}),
    );
    assert_eq!(
        fixture
            .serve
            .try_control("runtime.sharing.register", json!({"actor":next}))["ok"],
        false
    );
    assert!(texts(&fixture.serve.events(&fixture.tab), "user_message").is_empty());
    // Keep the private world alive through the owner teardown.
    assert!(fixture.world.data.is_dir());
}

#[test]
fn sign_out_before_registration_fences_late_registration_without_revoking_a_newer_account() {
    let mut fixture = Fixture::new("");
    fixture.actor["generation"] = json!(2);
    // Generation 2 has never registered: its sign-out arrived first.
    fixture.call("clear", json!({}));
    fixture.call("clear", json!({}));
    fixture.refused("register", json!({}));
    fixture.actor["generation"] = json!(3);
    fixture.call("register", json!({}));
    fixture.link("viewer", false);
    let mut stale = fixture.actor.clone();
    stale["generation"] = json!(2);
    assert_eq!(
        fixture
            .serve
            .try_control("runtime.sharing.clear", json!({"actor":stale}))["ok"],
        false
    );
    // A stale sign-out must not remove the newer account's grant.
    assert_eq!(fixture.join()["admitted"], true);
    fixture.call("guest", fixture.guest("session.tail", json!({})));
}

#[test]
fn revocation_while_the_provider_is_not_ready_prevents_the_actual_pty_write() {
    for operation in ["revoke", "clear", "detach"] {
        let fixture = Fixture::with_readiness_gate("", true);
        fixture.link("driver", false);
        fixture.join();
        fixture.call(
            "guest",
            fixture.guest("session.send", json!({"text":"echo:revoked-before-ready"})),
        );
        match operation {
            "detach" => {
                fixture.window.shutdown(std::net::Shutdown::Both).unwrap();
            }
            "clear" => {
                fixture.call("clear", json!({}));
            }
            _ => {
                fixture.call("revoke", json!({"linkId":"link","removeGuests":true}));
            }
        }
        let cancelled = fixture.serve.wait_events(
            &fixture.tab,
            "the pending shared write to abort",
            |events| {
                events.iter().any(|event| {
                    event["payload"]["type"] == "turn_completed"
                        && event["payload"]["status"] == "aborted"
                })
            },
        );
        assert!(texts(&cancelled, "assistant_text").is_empty());
        std::fs::write(fixture.world.home.join("agent-go"), b"ready").unwrap();
        fixture.serve.control(
            "send",
            json!({"target":fixture.tab,"text":"echo:host-after-revocation"}),
        );
        let completed = fixture.serve.wait_events(
            &fixture.tab,
            "the host turn after revoked delivery",
            |events| {
                texts(events, "assistant_text")
                    .iter()
                    .any(|text| text.contains("host-after-revocation"))
                    && count(events, "turn_completed") == 2
            },
        );
        assert!(!texts(&completed, "assistant_text")
            .iter()
            .any(|text| text.contains("revoked-before-ready")));
    }
}

#[test]
fn a_restarted_owner_refuses_the_previous_accounts_attachment() {
    let mut fixture = Fixture::new("");
    fixture.link("driver", false);
    fixture.join();
    fixture
        .serve
        .control("runtime.stopAll", json!({"epoch":fixture.actor["epoch"]}));
    common::agent::wait_until("the old owner to stop", || {
        fixture.serve.child.try_wait().unwrap()
    });
    let replacement = Serve::start(fixture.world.command(), &fixture.world.data);
    assert_eq!(
        replacement.try_control("runtime.sharing.register", json!({"actor":fixture.actor}))["ok"],
        false
    );
    assert_eq!(
        replacement.try_control(
            "runtime.sharing.guest",
            fixture.params(fixture.guest("session.send", json!({"text":"echo:stale-owner"})))
        )["ok"],
        false
    );
    assert!(texts(&replacement.events(&fixture.tab), "user_message").is_empty());
}

#[test]
fn invitation_lookup_is_owner_scoped_rate_limited_and_revoked_atomically() {
    let fixture = Fixture::new("");
    fixture.link("viewer", false);
    fixture.refused("lookup", json!({"tokenHash":"wrong-hash"}));
    fixture.refused("lookup", json!({"tokenHash":"fixture-hash","expectedLink":"another-link"}));
    let mut wrong = fixture.params(json!({"tokenHash":"fixture-hash"}));
    wrong["actor"]["profileId"] = json!("another-profile");
    assert_eq!(fixture.serve.try_control("runtime.sharing.lookup", wrong)["ok"], false);
    for _ in 0..60 {
        let found = fixture.call("lookup", json!({"tokenHash":"fixture-hash","expectedLink":"link"}));
        assert_eq!(found["sessionId"], fixture.session);
        assert_eq!(found["linkId"], "link");
    }
    fixture.refused("lookup", json!({"tokenHash":"fixture-hash"}));
    fixture.call("revoke", json!({"linkId":"link","removeGuests":true}));
    fixture.refused("lookup", json!({"tokenHash":"fixture-hash"}));
}

#[test]
fn host_notes_and_guest_visibility_stay_at_the_owner_after_revocation() {
    let fixture = Fixture::new("");
    assert_eq!(fixture.call("status", json!({}))["active"], false);
    fixture.link("viewer", true);
    assert_eq!(fixture.join()["admitted"], false);
    assert_eq!(fixture.call("guest", json!({"connectionId":"guest","method":"session.status","params":{"sessionId":fixture.session}}))["admitted"], false);
    fixture.call("approve", json!({"linkId":"link","userId":"guest-user","allow":true}));
    let state = fixture.call("note", json!({"text":"A note retained by the owner."}));
    assert_eq!(state["notes"][0]["text"], "A note retained by the owner.");
    assert_eq!(fixture.call("guest", json!({"connectionId":"guest","method":"session.status","params":{"sessionId":fixture.session}}))["admitted"], true);
    fixture.call("remove", json!({"linkId":"link","userId":"guest-user"}));
    fixture.refused("guest", json!({"connectionId":"guest","method":"session.status","params":{"sessionId":fixture.session}}));
    let stopped = fixture.call("stop", json!({}));
    assert_eq!(stopped["revokeLinks"], json!(["link"]));
    let closed = fixture.call("status", json!({}));
    assert_eq!(closed["active"], false);
    assert!(closed["activity"].as_array().unwrap().iter().any(|event| event["action"] == "note"));
}
