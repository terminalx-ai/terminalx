use super::*;

fn settings() -> LinkSettings {
    LinkSettings {
        audience: Audience::Anyone,
        role: Role::Driver,
        people: vec![],
        expires_at: 100_000,
        approve_each_person: false,
        can_approve: false,
        maximum_people: 4,
        single_use: false,
    }
}
pub(crate) fn fixture() -> Share {
    let mut share = Share::new("host".into(), "host-org".into(), String::new());
    share.links.insert(
        "link".into(),
        Link {
            id: "link".into(),
            settings: settings(),
            url: "secret".into(),
            direct_only: true,
            credential_expires_at: 100_000,
            join_attempts: VecDeque::new(),
            revoked: false,
            token_hash: "hash".into(),
            blocked: HashSet::new(),
            approved: HashSet::new(),
            used_by: None,
        },
    );
    share
}
pub(crate) fn guest(id: &str, user: &str) -> Guest {
    let (cancel, _) = tokio::sync::mpsc::unbounded_channel();
    Guest {
        connection_id: id.into(),
        link_id: "link".into(),
        person: Person {
            user_id: user.into(),
            display_name: format!("Person {user}"),
            email: format!("{user}@example.com"),
            email_verified: true,
            organization_ids: vec!["other-org".into()],
        },
        role: Role::Viewer,
        can_approve: false,
        admitted: false,
        verified_until: 100_000,
        active: Arc::new(AtomicBool::new(false)),
        cancel,
        viewing: None,
        typing: false,
        last_write: 0,
        write_revision: 0,
    }
}
#[test]
fn any_signed_in_identity_can_join_without_host_organization_membership() {
    let mut share = fixture();
    assert!(share.join(guest("one", "alice"), 1000).unwrap());
    assert_eq!(
        share
            .admit("one", Some("tab"), true, false, 2000)
            .unwrap()
            .user_id,
        "alice"
    );
    assert!(share.admit("one", Some("tab"), false, true, 3000).is_err());
}
#[test]
fn named_accounts_require_verified_email_and_supply_per_person_role() {
    let mut share = fixture();
    let link = share.links.get_mut("link").unwrap();
    link.settings.audience = Audience::People;
    link.settings.people = vec![NamedPerson {
        email: "alice@example.com".into(),
        role: Role::Viewer,
    }];
    link.settings.approve_each_person = true;
    assert!(share.join(guest("outsider", "bob"), 1000).is_err());
    let mut unverified = guest("unverified", "alice");
    unverified.person.email_verified = false;
    assert!(share.join(unverified, 1000).is_err());
    assert!(share.guests.is_empty());
    assert!(!share.join(guest("one", "alice"), 1000).unwrap());
    share.approve("link", "alice", true, 2000).unwrap();
    assert!(share.admit("one", Some("tab"), true, false, 3000).is_err());
    assert!(share.admit("one", None, false, false, 3000).is_ok());
}
#[test]
fn editing_live_access_releases_leases_and_drops_queue_and_outsiders() {
    let mut share = fixture();
    share.join(guest("one", "alice"), 1000).unwrap();
    share.join(guest("two", "bob"), 1000).unwrap();
    share.admit("one", Some("tab"), true, false, 2000).unwrap();
    share.queue.push_back(QueuedInput {
        connection_id: "one".into(),
        tab_id: "tab".into(),
        text: "follow up".into(),
    });
    let mut policy = settings();
    policy.audience = Audience::People;
    policy.people = vec![NamedPerson {
        email: "alice@example.com".into(),
        role: Role::Viewer,
    }];
    share.edit("link", policy, 3000).unwrap();
    assert!(share.leases.is_empty());
    assert!(share.queue.is_empty());
    assert!(!share.guests.contains_key("two"));
    assert_eq!(share.guests["one"].role, Role::Viewer);
    assert_eq!(share.activity.back().unwrap()["action"], "settings-changed");
}
#[test]
fn leases_serialize_people_aggregate_devices_lapse_and_allow_host_takeover() {
    let mut share = fixture();
    for (id, user) in [("one", "alice"), ("another", "alice"), ("two", "bob")] {
        share.join(guest(id, user), 1000).unwrap();
    }
    share.admit("one", Some("tab"), true, false, 2000).unwrap();
    assert!(share.admit("two", Some("tab"), true, false, 3000).is_err());
    assert!(share
        .admit("another", Some("tab"), true, false, 3000)
        .is_ok());
    assert_eq!(
        share.snapshot(3000, true)["people"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    share.host_takeover("tab", 4000);
    assert!(share.admit("two", Some("tab"), true, false, 5000).is_err());
    assert!(share
        .admit("one", Some("tab"), true, false, 5000 + LEASE_MS)
        .is_ok());
}
#[test]
fn removal_and_revocation_close_connections_invalidate_access_and_drop_inputs() {
    let mut share = fixture();
    let one = guest("one", "alice");
    let active = one.active.clone();
    share.join(one, 1000).unwrap();
    share.queue.push_back(QueuedInput {
        connection_id: "one".into(),
        tab_id: "tab".into(),
        text: "follow up".into(),
    });
    share.remove("link", "alice", 2000).unwrap();
    assert!(!active.load(Ordering::SeqCst));
    assert!(share.queue.is_empty());
    assert!(share.join(guest("new", "alice"), 3000).is_err());
    share.join(guest("two", "bob"), 3000).unwrap();
    share.revoke("link", true, 4000).unwrap();
    assert!(share.guests.is_empty());
    assert!(share.join(guest("three", "eve"), 5000).is_err());
}
#[test]
fn expiry_caps_single_use_and_identity_expiration_fail_closed() {
    let mut share = fixture();
    assert!(share.join(guest("late", "alice"), 100_000).is_err());
    share.links.get_mut("link").unwrap().settings.maximum_people = 1;
    share.join(guest("one", "alice"), 1000).unwrap();
    share.join(guest("another", "alice"), 1000).unwrap();
    assert!(share.join(guest("two", "bob"), 1000).is_err());
    assert!(share.admit("one", None, false, false, 100_000).is_err());
    let mut share = fixture();
    share.links.get_mut("link").unwrap().settings.single_use = true;
    share.join(guest("one", "alice"), 1000).unwrap();
    assert!(share.join(guest("another", "alice"), 1000).is_err());
    assert!(share.join(guest("two", "bob"), 1000).is_err());
}
#[test]
fn approval_and_organization_restrictions_are_independent_of_driving() {
    let mut share = fixture();
    share.links.get_mut("link").unwrap().settings.audience = Audience::Organization;
    assert!(share.join(guest("one", "alice"), 1000).is_err());
    let mut one = guest("one", "alice");
    one.person.organization_ids.push("host-org".into());
    share.join(one, 1000).unwrap();
    let mut policy = settings();
    policy.can_approve = true;
    policy.role = Role::Viewer;
    share.edit("link", policy, 2000).unwrap();
    assert!(share.admit("one", Some("tab"), false, true, 3000).is_ok());
    assert!(share.admit("one", Some("tab"), true, false, 4000).is_err());
}

#[test]
fn delayed_prompts_cannot_revive_after_demotion_promotion_or_host_lease_expiry() {
    let mut share = fixture();
    share.join(guest("one", "alice"), 1000).unwrap();
    share.admit("one", Some("tab"), true, false, 2000).unwrap();
    let permit = share.write_permit("one", "tab").unwrap();
    let mut policy = settings();
    policy.role = Role::Viewer;
    share.edit("link", policy, 3000).unwrap();
    share.edit("link", settings(), 4000).unwrap();
    assert!(share.admit_at_writer(&permit, "tab", 5000).is_err());
    let permit = share.write_permit("one", "tab").unwrap();
    share.host_takeover("tab", 6000);
    assert!(share
        .admit_at_writer(&permit, "tab", 6001 + LEASE_MS)
        .is_err());
    let fresh = share.write_permit("one", "tab").unwrap();
    assert!(share
        .admit_at_writer(&fresh, "tab", 6001 + LEASE_MS)
        .is_ok());
    share.revoke("link", true, 40_000).unwrap();
    assert!(share.admit_at_writer(&fresh, "tab", 40_001).is_err());
}

#[test]
fn live_single_use_setting_limits_existing_people_and_consumes_pending_admission() {
    let mut share = fixture();
    share.join(guest("one", "alice"), 1000).unwrap();
    share.join(guest("two", "bob"), 1000).unwrap();
    let mut policy = settings();
    policy.single_use = true;
    share.edit("link", policy, 2000).unwrap();
    assert_eq!(share.guests.len(), 1);
    assert!(share.join(guest("three", "eve"), 3000).is_err());

    let mut share = fixture();
    share
        .links
        .get_mut("link")
        .unwrap()
        .settings
        .approve_each_person = true;
    share.join(guest("one", "alice"), 1000).unwrap();
    let mut policy = settings();
    policy.single_use = true;
    share.edit("link", policy, 2000).unwrap();
    assert!(share.guests["one"].admitted);
    assert!(share.join(guest("two", "bob"), 3000).is_err());
}

#[test]
fn identity_renewal_cannot_change_person_or_keep_an_unverified_named_account() {
    let mut share = fixture();
    share.join(guest("one", "alice"), 1000).unwrap();
    assert!(share
        .refresh_identity("one", guest("two", "bob").person, 2000)
        .is_err());
    let mut policy = settings();
    policy.audience = Audience::People;
    policy.people = vec![NamedPerson {
        email: "alice@example.com".into(),
        role: Role::Driver,
    }];
    share.edit("link", policy, 2000).unwrap();
    let mut identity = guest("one", "alice").person;
    identity.email_verified = false;
    assert!(share.refresh_identity("one", identity, 3000).is_err());
}

#[test]
fn presence_keeps_one_person_and_exposes_pending_approval_without_promoting_the_viewer() {
    let mut share = fixture();
    share.links.get_mut("link").unwrap().settings.role = Role::Viewer;
    share.join(guest("viewer", "alice"), 1000).unwrap();
    let mut another = share.links["link"].clone();
    another.id = "pending-link".into();
    another.settings.role = Role::Driver;
    another.settings.approve_each_person = true;
    share.links.insert(another.id.clone(), another);
    let mut pending = guest("pending", "alice");
    pending.link_id = "pending-link".into();
    assert!(!share.join(pending, 1000).unwrap());
    let people = share.snapshot(2000, true)["people"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(people.len(), 1);
    assert_eq!(people[0]["role"], "viewer");
    assert_eq!(people[0]["pendingLinkIds"], json!(["pending-link"]));
    assert!(share.admit("pending", None, false, false, 2000).is_err());
    share.approve("pending-link", "alice", true, 2000).unwrap();
    assert_eq!(share.snapshot(3000, true)["people"][0]["role"], "driver");
}
