//! `machine/8` (PRO-408): the account a machine session's tab runs on, and how
//! each agent there is billed, as the machine lists its accounts.

use serde_json::json;

use super::*;
use crate::agent_accounts::{Account, AgentAccounts};

fn account(id: &str, kind: Kind, label: &str, local: bool) -> Account {
    Account {
        id: id.into(),
        agent: "claude",
        kind,
        label: label.into(),
        email: None,
        plan: None,
        organization: None,
        local,
        is_default: local,
        missing: false,
        added_at: None,
    }
}

/// What the machine lists for Claude Code: its own login and the accounts given.
fn listed(accounts: Vec<Account>) -> Accounts {
    let mut held = Accounts::default();
    let all = std::iter::once(account(LOCAL, Kind::Subscription, "This Mac", true)).chain(accounts).collect();
    held.by_agent.insert(
        "claude".into(),
        Some(AgentAccounts { agent: "claude", accounts: all, default_account: LOCAL.into(), project_defaults: Default::default(), auto_switch: Default::default() }),
    );
    held
}

/// A session as the machine's index stores it, its tabs with the fields given.
fn session(tabs: serde_json::Value) -> SessionEntry {
    let timestamp = "2026-11-18T10:00:00Z";
    serde_json::from_value(json!({
        "id": "s1", "projectPath": "/srv/api", "cwd": "/srv/api", "title": "Work",
        "created": timestamp, "modified": timestamp, "tabs": tabs,
    })).unwrap()
}

fn usage(cost: f64) -> serde_json::Value {
    json!({ "models": [{ "model": "claude-opus-4-5", "inputTokens": 10, "outputTokens": 5, "cacheReadTokens": 0, "cacheWriteTokens": 0, "costUsd": cost }], "updated": "2026-11-18T10:05:00Z" })
}

#[test]
fn a_tab_names_the_account_it_ran_on_only_when_its_agent_has_several() {
    let entry = session(json!([
        { "id": "t1", "harness": "claude", "created": "x", "launchedAccount": "work-1" },
        { "id": "t2", "harness": "claude", "created": "x", "account": "work-1", "launchedAccount": "home-2" },
        { "id": "t3", "harness": "claude", "created": "x" },
        { "id": "t4", "harness": "claude", "created": "x", "front": "terminal" },
    ]));
    let mut accounts = listed(vec![account("work-1", Kind::Subscription, "work@acme.dev · max", false), account("home-2", Kind::ApiKey, "Home key", false)]);
    let mut wire = json!(entry);
    account_labels(&mut wire, &entry, &mut accounts);
    assert_eq!(wire["tabs"][0]["accountLabel"], "work@acme.dev · max");
    // What its last launch resolved comes before what it asks for.
    assert_eq!(wire["tabs"][1]["accountLabel"], "Home key");
    // A tab that names none is on the machine's own login, never named as this computer's.
    assert_eq!(wire["tabs"][2]["accountLabel"], MACHINE_LOGIN);
    assert!(wire["tabs"][3].get("accountLabel").is_none(), "a terminal has no account");

    let mut one = listed(vec![]);
    let mut wire = json!(entry);
    account_labels(&mut wire, &entry, &mut one);
    assert!(wire["tabs"].as_array().unwrap().iter().all(|tab| tab.get("accountLabel").is_none()), "one account: nothing is shown");

    // An account the machine no longer lists names nothing, rather than another's.
    let gone = session(json!([{ "id": "t1", "harness": "claude", "created": "x", "launchedAccount": "gone-3" }]));
    let mut wire = json!(gone);
    account_labels(&mut wire, &gone, &mut listed(vec![account("work-1", Kind::Subscription, "Work", false)]));
    assert!(wire["tabs"][0].get("accountLabel").is_none());
}

#[test]
fn usage_names_how_each_agent_is_billed_on_the_machine() {
    let own = |harness: &str| (harness == "claude").then(|| "Claude account".to_string());
    let entry = session(json!([
        { "id": "t1", "harness": "claude", "created": "x", "launchedAccount": "key-1", "usage": usage(0.25) },
        { "id": "t2", "harness": "claude", "created": "x", "launchedAccount": "key-1", "usage": usage(0.5) },
        // No usage: it says nothing of billing.
        { "id": "t3", "harness": "codex", "created": "x" },
    ]));
    let mut accounts = listed(vec![account("key-1", Kind::ApiKey, "Company key", false)]);
    let answer = usage_answer_with(&entry, Vec::new(), &mut accounts, &own);
    assert_eq!(answer["loginMethods"], json!({ "claude": "API key" }));
    assert_eq!(answer["usage"]["total"]["costUsd"], json!(0.75));
    assert_eq!(answer["usage"]["tabs"].as_array().unwrap().len(), 2);

    // One tab on a key and one on the machine's own subscription: not one kind.
    let mixed = session(json!([
        { "id": "t1", "harness": "claude", "created": "x", "launchedAccount": "key-1", "usage": usage(0.25) },
        { "id": "t2", "harness": "claude", "created": "x", "usage": usage(0.5) },
    ]));
    let answer = usage_answer_with(&mixed, Vec::new(), &mut listed(vec![account("key-1", Kind::ApiKey, "Company key", false)]), &own);
    assert_eq!(answer["loginMethods"], json!({ "claude": null }));

    // Its own login is what its CLI says; an added subscription is the agent's account kind.
    let subscription = session(json!([{ "id": "t1", "harness": "claude", "created": "x", "launchedAccount": "work-1", "usage": usage(0.25) }]));
    let answer = usage_answer_with(&subscription, Vec::new(), &mut listed(vec![account("work-1", Kind::Subscription, "Work", false)]), &|_| None);
    assert_eq!(answer["loginMethods"], json!({ "claude": "Claude account" }));
    let own_login = session(json!([{ "id": "t1", "harness": "claude", "created": "x", "usage": usage(0.25) }]));
    assert_eq!(usage_answer_with(&own_login, Vec::new(), &mut listed(vec![]), &own)["loginMethods"], json!({ "claude": "Claude account" }));
}

#[test]
fn usage_keeps_only_the_windows_of_agents_the_session_used() {
    let window = |agent: &str| -> crate::status::usage::UsageWindow {
        serde_json::from_value(json!({ "agent": agent, "key": "five_hour", "label": "5h", "usedPercent": 40.0, "resetsAt": null, "windowMinutes": 300, "updatedAt": 1, "stale": false, "source": "test" })).unwrap()
    };
    let entry = session(json!([{ "id": "t1", "harness": "claude", "created": "x", "usage": usage(0.25) }]));
    let answer = usage_answer_with(&entry, vec![window("claude"), window("codex")], &mut listed(vec![]), &|_| None);
    let windows = answer["windows"].as_array().unwrap();
    assert_eq!(windows.len(), 1, "{answer}");
    assert_eq!(windows[0]["agent"], "claude");
}

#[test]
fn check_failures_takes_only_a_pull_requests_https_url() {
    for url in ["file:///etc/passwd", "--repo=x", "http://github.com/acme/api/pull/1", ""] {
        assert_eq!(check_failures("s1", "t1", url).unwrap_err().code, "invalid_params", "{url}");
    }
}
