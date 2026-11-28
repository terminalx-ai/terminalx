//! Table tests for [`decide`] (#981): each row is the accounts, the tab and
//! what it should do.

use super::*;

const NOW: i64 = 1_800_000_000_000;
const HOUR: i64 = 60 * 60_000;

fn window(key: &str, used: f32) -> UsageWindow {
    UsageWindow {
        agent: "claude".into(),
        key: key.into(),
        label: key.into(),
        used_percent: used,
        resets_at: Some(NOW + HOUR),
        window_minutes: None,
        updated_at: NOW - 60_000,
        stale: false,
        source: "test".into(),
        endpoint_running: false,
    }
}

fn account(id: &str, windows: &[(&str, f32)]) -> Candidate {
    Candidate {
        id: id.into(),
        label: id.to_uppercase(),
        kind: Kind::Subscription,
        signed_in: true,
        checked: true,
        windows: windows.iter().map(|(key, used)| window(key, *used)).collect(),
        unreadable: false,
        limited: None,
        left: None,
        lacks_model: false,
        arrivals: 0,
    }
}

fn ask<'a>(why: Why, current: &'a str, candidates: &'a [Candidate]) -> Ask<'a> {
    Ask { why, current, model: Some("claude-sonnet-4-5"), candidates, threshold: 90.0, order: Order::MostRoom, last_switch_at: None, now: NOW }
}

fn to(decision: &Decision) -> Option<&str> {
    match decision {
        Decision::Switch { to, .. } => Some(to),
        Decision::Stay(_) => None,
    }
}

/// Window key and its used percent.
type Windows<'a> = &'a [(&'a str, f32)];

#[test]
fn auto_switch_selection_and_cooldown_rules() {
    thresholds_per_window();
    model_scoped_windows_count_only_for_their_model();
    accounts_that_are_never_chosen();
    an_api_key_is_a_last_resort_when_checked();
    an_account_just_left_waits_for_the_margin_or_its_reset();
    one_switch_per_tab_per_five_minutes();
    most_room_against_my_order();
}

#[test]
fn auto_switch_fallback_and_limit_rules() {
    every_account_above_the_threshold_stops_switching();
    a_usage_limit_error_outranks_the_numbers();
    several_tabs_at_once_spread_over_the_accounts();
    a_plan_without_the_model_is_not_chosen();
    a_reason_reads_as_a_sentence();
}

#[test]
fn auto_switch_settings_log_and_memory() {
    the_setting_orders_accounts_and_keys_start_unchecked();
    the_setting_is_off_by_default_and_reads_old_files();
    the_log_keeps_thirty_days();
    hot_accounts_are_near_the_threshold();
    a_plan_seen_lacking_a_model_is_forgotten_after_a_while();
}

fn thresholds_per_window() {
    // (current's windows, expected target)
    let rows: &[(Windows, Option<&str>)] = &[
        (&[("five_hour", 89.0), ("seven_day", 40.0)], None),
        (&[("five_hour", 90.0), ("seven_day", 40.0)], Some("b")),
        (&[("five_hour", 10.0), ("seven_day", 95.0)], Some("b")),
        // A window past its reset no longer counts.
        (&[("five_hour", 99.0)], Some("b")),
    ];
    for (i, (windows, expected)) in rows.iter().enumerate() {
        let mut a = account("a", windows);
        if i == 3 {
            a.windows[0].resets_at = Some(NOW - 1);
        }
        let candidates = [a, account("b", &[("five_hour", 20.0)])];
        let expected = if i == 3 { None } else { *expected };
        assert_eq!(to(&decide(&ask(Why::Between, "a", &candidates))), expected, "row {i}");
    }
}

fn model_scoped_windows_count_only_for_their_model() {
    let candidates = [account("a", &[("five_hour", 20.0), ("seven_day_opus", 97.0)]), account("b", &[("five_hour", 20.0)])];
    let mut sonnet = ask(Why::Between, "a", &candidates);
    assert_eq!(decide(&sonnet), Decision::Stay(Stay::NotFull), "an Opus window does not fill a Sonnet tab");
    sonnet.model = Some("claude-opus-4-1");
    assert_eq!(to(&decide(&sonnet)), Some("b"));
    sonnet.model = None;
    assert_eq!(to(&decide(&sonnet)), Some("b"), "with no model known, every window counts");
    assert_eq!(window_name("seven_day_opus"), "weekly Opus limit");
}

fn accounts_that_are_never_chosen() {
    let full = account("a", &[("five_hour", 95.0)]);
    let mut stale = account("stale", &[("five_hour", 5.0)]);
    stale.windows[0].updated_at = NOW - FRESH_MS - 1;
    let mut unread = account("unread", &[]);
    unread.unreadable = true;
    let mut excluded = account("excluded", &[("five_hour", 5.0)]);
    excluded.checked = false;
    let mut signed_out = account("out", &[("five_hour", 5.0)]);
    signed_out.signed_in = false;
    let mut key = account("key", &[]);
    key.kind = Kind::ApiKey;
    key.checked = false;
    let candidates = [full, stale, unread, excluded, signed_out, key];
    assert!(matches!(decide(&ask(Why::Between, "a", &candidates)), Decision::Stay(Stay::NoneAvailable { .. })));
}

fn an_api_key_is_a_last_resort_when_checked() {
    let mut key = account("key", &[]);
    key.kind = Kind::ApiKey;
    let candidates = [account("a", &[("five_hour", 95.0)]), key.clone(), account("b", &[("five_hour", 50.0)])];
    assert_eq!(to(&decide(&ask(Why::Between, "a", &candidates))), Some("b"), "a subscription with room comes first");
    let candidates = [account("a", &[("five_hour", 95.0)]), key, account("b", &[("five_hour", 100.0)])];
    assert_eq!(to(&decide(&ask(Why::Between, "a", &candidates))), Some("key"));
}

fn an_account_just_left_waits_for_the_margin_or_its_reset() {
    let mut left = account("b", &[("five_hour", 85.0)]);
    left.left = Some(Left { at: NOW - 60_000, resets_at: Some(NOW + HOUR) });
    let candidates = [account("a", &[("five_hour", 92.0)]), left.clone()];
    assert!(matches!(decide(&ask(Why::Between, "a", &candidates)), Decision::Stay(_)), "85% is not 10 points under 90%");
    left.windows[0].used_percent = 79.0;
    let candidates = [account("a", &[("five_hour", 92.0)]), left.clone()];
    assert_eq!(to(&decide(&ask(Why::Between, "a", &candidates))), Some("b"));
    left.windows[0].used_percent = 85.0;
    left.left = Some(Left { at: NOW - 2 * HOUR, resets_at: Some(NOW - 1) });
    let candidates = [account("a", &[("five_hour", 92.0)]), left];
    assert_eq!(to(&decide(&ask(Why::Between, "a", &candidates))), Some("b"), "its window reset since");
}

fn one_switch_per_tab_per_five_minutes() {
    let candidates = [account("a", &[("five_hour", 95.0)]), account("b", &[("five_hour", 10.0)])];
    let mut asked = ask(Why::Between, "a", &candidates);
    asked.last_switch_at = Some(NOW - 4 * 60_000);
    assert_eq!(decide(&asked), Decision::Stay(Stay::Cooldown { until: NOW + 60_000 }));
    asked.why = Why::LimitHit;
    assert!(matches!(decide(&asked), Decision::Stay(Stay::Cooldown { .. })), "a limit hit waits too");
    asked.last_switch_at = Some(NOW - 5 * 60_000);
    assert_eq!(to(&decide(&asked)), Some("b"));
    asked.why = Why::Launch;
    asked.last_switch_at = Some(NOW);
    assert_eq!(to(&decide(&asked)), Some("b"), "a launch interrupts nothing");
}

fn most_room_against_my_order() {
    let candidates = [account("a", &[("five_hour", 95.0)]), account("b", &[("five_hour", 60.0)]), account("c", &[("five_hour", 20.0)])];
    let mut asked = ask(Why::Between, "a", &candidates);
    assert_eq!(to(&decide(&asked)), Some("c"));
    asked.order = Order::InOrder;
    assert_eq!(to(&decide(&asked)), Some("b"));
    // A tie goes to the first in the person's order.
    let tie = [account("a", &[("five_hour", 95.0)]), account("b", &[("five_hour", 30.0)]), account("c", &[("five_hour", 30.0)])];
    assert_eq!(to(&decide(&ask(Why::Between, "a", &tie))), Some("b"));
}

fn every_account_above_the_threshold_stops_switching() {
    let candidates = [account("a", &[("five_hour", 93.0)]), account("b", &[("five_hour", 91.0)])];
    assert_eq!(decide(&ask(Why::Between, "a", &candidates)), Decision::Stay(Stay::AllAboveThreshold));
    // A new session starts where there is the most room.
    let decision = decide(&ask(Why::Launch, "a", &candidates));
    assert_eq!(to(&decision), Some("b"));
    let Decision::Switch { reason, .. } = decision else { unreachable!() };
    assert!(reason.most_room);
    // At its limit it cannot go on: it moves where there is the most room,
    // though that account is above the threshold too (an unattended run
    // keeps going).
    let at_limit = [account("a", &[("five_hour", 100.0)]), account("b", &[("five_hour", 91.0)]), account("c", &[("five_hour", 95.0)])];
    for why in [Why::LimitHit, Why::Between] {
        let decision = decide(&ask(why, "a", &at_limit));
        assert_eq!(to(&decision), Some("b"), "{why:?}");
        let Decision::Switch { reason, .. } = decision else { unreachable!() };
        assert!(reason.most_room);
    }
    // A limit error on it says the same, however little its windows show:
    // at its limit it has no room.
    let mut limited = account("a", &[("five_hour", 60.0)]);
    limited.limited = Some(Limited { at: NOW - 30_000, resets_at: Some(NOW + HOUR) });
    assert_eq!(to(&decide(&ask(Why::LimitHit, "a", &[limited, account("b", &[("five_hour", 91.0)])]))), Some("b"));
    // Another account at its limit too does not stop it: a third still has room.
    let one_left = [account("a", &[("five_hour", 100.0)]), account("b", &[("five_hour", 100.0)]), account("c", &[("five_hour", 91.0)])];
    assert_eq!(to(&decide(&ask(Why::LimitHit, "a", &one_left))), Some("c"));
    // Past the threshold but not at its limit, with another at its limit and
    // a third past the threshold: a running tab stays.
    let running = [account("a", &[("five_hour", 93.0)]), account("b", &[("five_hour", 100.0)]), account("c", &[("five_hour", 91.0)])];
    assert_eq!(decide(&ask(Why::Between, "a", &running)), Decision::Stay(Stay::AllAboveThreshold));
    // Every other account at its limit as well: none is available, and the earliest reset is said.
    let all_out = [account("a", &[("five_hour", 100.0)]), account("b", &[("five_hour", 100.0)])];
    let Decision::Stay(Stay::NoneAvailable { earliest_reset, .. }) = decide(&ask(Why::LimitHit, "a", &all_out)) else { panic!("none available") };
    assert_eq!(earliest_reset, Some(NOW + HOUR));
}

fn a_usage_limit_error_outranks_the_numbers() {
    let mut a = account("a", &[("five_hour", 40.0)]);
    a.limited = Some(Limited { at: NOW - 30_000, resets_at: Some(NOW + HOUR) });
    let candidates = [a.clone(), account("b", &[("five_hour", 10.0)])];
    let decision = decide(&ask(Why::LimitHit, "a", &candidates));
    assert_eq!(to(&decision), Some("b"));
    let Decision::Switch { reason, .. } = decision else { unreachable!() };
    assert_eq!(reason.text(false), "A hit its usage limit");
    // Without a reset time, a poll after it showing room lifts it.
    a.limited = Some(Limited { at: NOW - 30_000, resets_at: None });
    assert!(full(&a, None, 90.0, NOW).is_some(), "the poll was before the error");
    a.windows[0].updated_at = NOW;
    assert!(full(&a, None, 90.0, NOW).is_none());
}

fn several_tabs_at_once_spread_over_the_accounts() {
    let mut b = account("b", &[("five_hour", 20.0)]);
    let c = account("c", &[("five_hour", 25.0)]);
    let candidates = [account("a", &[("five_hour", 95.0)]), b.clone(), c.clone()];
    assert_eq!(to(&decide(&ask(Why::Between, "a", &candidates))), Some("b"));
    // After one tab went to b, the next goes to c.
    b.arrivals = 1;
    let candidates = [account("a", &[("five_hour", 95.0)]), b, c];
    assert_eq!(to(&decide(&ask(Why::Between, "a", &candidates))), Some("c"));
}

fn a_plan_without_the_model_is_not_chosen() {
    let mut b = account("b", &[("five_hour", 10.0)]);
    b.lacks_model = true;
    let candidates = [account("a", &[("five_hour", 95.0)]), b];
    assert!(matches!(decide(&ask(Why::Between, "a", &candidates)), Decision::Stay(Stay::NoneAvailable { lacking_model: true, .. })));
}

fn a_reason_reads_as_a_sentence() {
    let candidates = [account("work", &[("five_hour", 91.4)]), account("home", &[("five_hour", 10.0)])];
    let Decision::Switch { reason, .. } = decide(&ask(Why::Between, "work", &candidates)) else { panic!("switch") };
    assert_eq!(reason.text(false), "WORK reached 91% of its 5-hour limit");
    assert_eq!(reason.text(true), "WORK is at 91% of its 5-hour limit");
}

fn the_setting_orders_accounts_and_keys_start_unchecked() {
    let mk = |id: &str, kind: Kind| super::super::Account {
        id: id.into(), agent: "claude", kind, label: id.into(), email: None, plan: None, organization: None,
        local: id == "local", is_default: false, missing: false, added_at: None,
    };
    let accounts = [mk("local", Kind::Subscription), mk("api-key", Kind::ApiKey), mk("aaaa", Kind::Subscription)];
    let setting = Setting { accounts: vec![Pick { id: "aaaa".into(), used: true }, Pick { id: "gone".into(), used: true }], ..Setting::default() };
    let listed = ordered(&setting, &accounts);
    assert_eq!(listed.iter().map(|l| (l.id.as_str(), l.used)).collect::<Vec<_>>(), [("aaaa", true), ("local", true), ("api-key", false)]);
    assert!(offered(&accounts));
    assert!(!offered(&accounts[..2]));
    assert!(checked(Setting { threshold: 49, ..Setting::default() }, |_| true).is_err());
    let kept = checked(Setting { accounts: vec![Pick { id: "aaaa".into(), used: true }, Pick { id: "aaaa".into(), used: false }, Pick { id: "gone".into(), used: true }], ..Setting::default() }, |id| id != "gone").unwrap();
    assert_eq!(kept.accounts, [Pick { id: "aaaa".into(), used: true }]);
}

fn the_setting_is_off_by_default_and_reads_old_files() {
    let setting: Setting = serde_json::from_str("{}").unwrap();
    assert!(!setting.enabled);
    assert_eq!(setting.threshold, 90);
    assert_eq!(setting.order, Order::MostRoom);
    assert!(setting.notify_switch && setting.notify_none_left);
    let kept: Setting = serde_json::from_str(r#"{"enabled":true,"future":1,"neverProjects":["/p"]}"#).unwrap();
    assert_eq!(serde_json::to_value(&kept).unwrap()["future"], 1);
    assert!(!kept.switches_in(Some("/p")));
    assert!(kept.switches_in(Some("/q")));
}

fn the_log_keeps_thirty_days() {
    let dir = tempfile::tempdir().unwrap();
    let entry = |at: i64| LogEntry {
        at, agent: "claude".into(), session_id: "s".into(), tab_id: "t".into(), title: None, from: "a".into(), from_label: "A".into(),
        to: Some("b".into()), to_label: Some("B".into()), outcome: Outcome::Switched, reason: "A reached 91% of its 5-hour limit".into(),
    };
    append_log_in(dir.path(), &entry(NOW - (LOG_DAYS + 1) * 24 * HOUR)).unwrap();
    append_log_in(dir.path(), &entry(NOW)).unwrap();
    let kept = read_log_in(dir.path(), NOW);
    assert_eq!(kept, [entry(NOW)]);
    assert_eq!(std::fs::read_to_string(log_path(dir.path())).unwrap().lines().count(), 1, "the old line is gone from the file too");
}

fn hot_accounts_are_near_the_threshold() {
    let candidates = [account("a", &[("five_hour", 74.0)]), account("b", &[("five_hour", 76.0)]), account("c", &[("seven_day", 99.0)])];
    assert_eq!(hot(&candidates, 90.0, NOW), ["b", "c"]);
}

fn a_plan_seen_lacking_a_model_is_forgotten_after_a_while() {
    let mut memory = Memory::default();
    memory.lacks("claude", "b", "Claude-Opus-4-1", NOW);
    let mut b = account("b", &[("five_hour", 10.0)]);
    memory.annotate("claude", &mut b, Some("claude-opus-4-1"), NOW + HOUR);
    assert!(b.lacks_model, "the same model, in any case");
    memory.annotate("claude", &mut b, Some("claude-sonnet-4-5"), NOW + HOUR);
    assert!(!b.lacks_model, "another model is not affected");
    memory.prune(NOW + LACKS_MS);
    memory.annotate("claude", &mut b, Some("claude-opus-4-1"), NOW + LACKS_MS);
    assert!(!b.lacks_model, "learned again, not kept forever");
}
