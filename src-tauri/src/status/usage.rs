//! App-wide account usage, kept in memory only.
//!
//! Claude arrives for free in the status-line payload the CLI already builds
//! after a turn. Codex is one read-only question to a short-lived app-server.
//! Neither path introduces an HTTP client or persists account data.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;

pub const EVENT: &str = "status_usage";
const STATUSLINE_THROTTLE_MS: i64 = 15_000;
const BACKGROUND_REFRESH_MS: i64 = 15 * 60_000;
const MANUAL_REFRESH_MS: i64 = 5 * 60_000;
const STALE_MS: i64 = 30 * 60_000;
const MAX_BACKOFF_MS: i64 = 15 * 60_000;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub agent: String,
    pub key: String,
    pub label: String,
    pub used_percent: f32,
    pub resets_at: Option<i64>,
    pub window_minutes: Option<u32>,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexCredits {
    pub has_credits: bool,
    pub unlimited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexResetCredits {
    pub available_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<CodexCredits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_credits: Option<CodexResetCredits>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub windows: Vec<UsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex: Option<CodexUsage>,
}

#[derive(Default)]
struct PollState {
    last_success: Option<i64>,
    last_manual: Option<i64>,
    retry_at: Option<i64>,
    failures: u32,
    in_flight: bool,
}

#[derive(Default)]
struct Inner {
    windows: HashMap<(String, String), UsageWindow>,
    statusline_by_tab: HashMap<String, i64>,
    codex: PollState,
    codex_usage: Option<CodexUsage>,
    codex_reset_credit_id: Option<String>,
    codex_reset_in_flight: bool,
}

#[derive(Default)]
pub struct UsageStore {
    inner: Mutex<Inner>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().min(i64::MAX as u128) as i64
}

fn seconds_to_ms(value: i64) -> Option<i64> {
    value.checked_mul(1000)
}

fn numeric(value: &Value) -> Option<f32> {
    value.as_f64().map(|n| n as f32).or_else(|| value.as_str()?.parse().ok())
}

fn reset_ms(value: &Value) -> Option<i64> {
    if let Some(seconds) = value.as_i64().or_else(|| value.as_f64().map(|n| n as i64)) {
        return seconds_to_ms(seconds);
    }
    let raw = value.as_str()?.trim();
    if let Ok(seconds) = raw.parse() {
        return seconds_to_ms(seconds);
    }
    chrono::DateTime::parse_from_rfc3339(raw).ok().map(|timestamp| timestamp.timestamp_millis())
}

fn claude_label(key: &str) -> (String, Option<u32>) {
    match key {
        "five_hour" => ("5h".into(), Some(300)),
        "seven_day" => ("7d".into(), Some(10_080)),
        "seven_day_opus" => ("7d Opus".into(), Some(10_080)),
        "seven_day_sonnet" => ("7d Sonnet".into(), Some(10_080)),
        "fable_weekly" => ("Fable".into(), Some(10_080)),
        _ => {
            let label = key.split('_').filter(|part| !part.is_empty()).map(|part| {
                let mut chars = part.chars();
                chars.next().map(|first| first.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default()
            }).collect::<Vec<_>>().join(" ");
            (label, None)
        }
    }
}

fn classify_codex(minutes: u32) -> (String, String) {
    if minutes.abs_diff(300) <= 1 {
        ("five_hour".into(), "5h".into())
    } else if minutes.abs_diff(10_080) <= 1 {
        ("weekly".into(), "weekly".into())
    } else {
        (format!("{minutes}_minutes"), format!("{minutes}m"))
    }
}

fn parse_claude_window(key: &str, raw: &Value, updated_at: i64) -> Option<UsageWindow> {
    let usage = raw.get("used_percentage").or_else(|| raw.get("utilization"))?;
    let utilization = numeric(usage)?;
    let used_percent = if raw.get("used_percentage").is_none() && utilization <= 1.0 {
        utilization * 100.0
    } else {
        utilization
    }
    .clamp(0.0, 100.0);
    let (label, window_minutes) = claude_label(key);
    Some(UsageWindow {
        agent: "claude".into(),
        key: key.into(),
        label,
        used_percent,
        resets_at: raw.get("resets_at").and_then(reset_ms),
        window_minutes,
        updated_at,
        plan: None,
        stale: false,
    })
}

fn parse_claude(payload: &Value, updated_at: i64) -> Vec<UsageWindow> {
    let Some(rate_limits) = payload.get("rate_limits").and_then(Value::as_object) else { return Vec::new() };
    let mut windows: Vec<_> = rate_limits
        .iter()
        .filter_map(|(key, raw)| parse_claude_window(key, raw, updated_at))
        .collect();
    let fable = rate_limits.get("model_scoped").and_then(Value::as_array).and_then(|scoped| {
        scoped.iter().find_map(|raw| {
            raw.get("display_name")
                .and_then(Value::as_str)
                .filter(|name| name.eq_ignore_ascii_case("Fable"))
                .and_then(|_| parse_claude_window("fable_weekly", raw, updated_at))
        })
    });
    if let Some(fable) = fable {
        windows.retain(|window| window.key != "fable_weekly");
        windows.push(fable);
    }
    windows
}

fn parse_codex_limit(limits: &Value, key_prefix: Option<&str>, updated_at: i64) -> Vec<UsageWindow> {
    let plan = limits["planType"].as_str().map(str::to_string);
    let limit_name = limits["limitName"].as_str();
    ["primary", "secondary"]
        .into_iter()
        .filter_map(|slot| {
            let raw = limits.get(slot)?.as_object()?;
            let minutes = raw.get("windowDurationMins")?.as_u64()?.try_into().ok()?;
            let (window_key, window_label) = classify_codex(minutes);
            let key = key_prefix.map(|prefix| format!("{prefix}_{window_key}")).unwrap_or(window_key);
            let label = limit_name.map(|name| format!("{name} {window_label}")).unwrap_or(window_label);
            Some(UsageWindow {
                agent: "codex".into(),
                key,
                label,
                used_percent: numeric(raw.get("usedPercent")?)?.clamp(0.0, 100.0),
                resets_at: raw.get("resetsAt").and_then(reset_ms),
                window_minutes: Some(minutes),
                updated_at,
                plan: plan.clone(),
                stale: false,
            })
        })
        .collect()
}

fn parse_codex_windows(result: &Value, updated_at: i64) -> Vec<UsageWindow> {
    let mut windows = parse_codex_limit(&result["rateLimits"], None, updated_at);
    let mut additional: Vec<_> = result
        .get("rateLimitsByLimitId")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter(|(limit_id, _)| limit_id.as_str() != "codex")
        .flat_map(|(limit_id, limits)| parse_codex_limit(limits, Some(limit_id), updated_at))
        .collect();
    additional.sort_by(|a, b| a.key.cmp(&b.key));
    windows.extend(additional);
    windows
}

fn parse_codex_usage(result: &Value) -> (Option<CodexUsage>, Option<String>) {
    let credits = result["rateLimits"].get("credits").and_then(Value::as_object).and_then(|raw| {
        Some(CodexCredits {
            has_credits: raw.get("hasCredits")?.as_bool()?,
            unlimited: raw.get("unlimited").and_then(Value::as_bool).unwrap_or(false),
            balance: raw.get("balance").and_then(Value::as_str).map(str::to_string),
        })
    });
    let reset = result.get("rateLimitResetCredits").and_then(Value::as_object);
    let reset_credits = reset.and_then(|raw| {
        let available_count = raw.get("availableCount")?.as_u64()?;
        let next_expires_at = raw
            .get("credits")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|credit| credit.get("status").and_then(Value::as_str) == Some("available"))
            .filter_map(|credit| credit.get("expiresAt").and_then(reset_ms))
            .min();
        Some(CodexResetCredits { available_count, next_expires_at })
    });
    let reset_credit_id = reset
        .and_then(|raw| raw.get("credits"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|credit| credit.get("status").and_then(Value::as_str) == Some("available"))
        .min_by_key(|credit| credit.get("expiresAt").and_then(reset_ms).unwrap_or(i64::MAX))
        .and_then(|credit| credit.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let usage = (credits.is_some() || reset_credits.is_some()).then_some(CodexUsage { credits, reset_credits });
    (usage, reset_credit_id)
}

fn read_codex() -> Result<Value> {
    crate::harness::codex::appserver::ask(
        crate::harness::codex::appserver::Where::default(),
        "account/rateLimits/read",
        serde_json::json!({}),
    )
    .context("read Codex rate limits")
}

fn apply_codex(inner: &mut Inner, result: &Value, updated_at: i64) {
    let windows = parse_codex_windows(result, updated_at);
    let (usage, reset_credit_id) = parse_codex_usage(result);
    inner.windows.retain(|(agent, _), _| agent != "codex");
    for window in windows {
        inner.windows.insert((window.agent.clone(), window.key.clone()), window);
    }
    inner.codex_usage = usage;
    inner.codex_reset_credit_id = reset_credit_id;
}

impl UsageStore {
    /// Accept at most one status-line sample per pane in a fifteen-second
    /// window. The forwarder processes are intentionally stateless; the app
    /// can enforce the throttle without a sidecar file or a second transport.
    pub fn ingest_claude(&self, tab_id: &str, payload: &Value) -> bool {
        let now = now_ms();
        let mut inner = self.inner.lock().unwrap();
        if inner.statusline_by_tab.get(tab_id).is_some_and(|last| now.saturating_sub(*last) < STATUSLINE_THROTTLE_MS) {
            return false;
        }
        let windows = parse_claude(payload, now);
        if windows.is_empty() {
            return false;
        }
        inner.statusline_by_tab.insert(tab_id.to_string(), now);
        for window in windows {
            inner.windows.insert((window.agent.clone(), window.key.clone()), window);
        }
        true
    }

    pub fn snapshot(&self, running_agents: &HashSet<String>) -> UsageSnapshot {
        let now = now_ms();
        let mut inner = self.inner.lock().unwrap();
        inner.windows.retain(|_, window| now.saturating_sub(window.updated_at) < STALE_MS || running_agents.contains(&window.agent));
        let mut windows: Vec<_> = inner
            .windows
            .values()
            .map(|window| {
                let stale = now.saturating_sub(window.updated_at) >= STALE_MS;
                let mut window = window.clone();
                window.stale = stale;
                window
            })
            .collect();
        windows.sort_by(|a, b| b.used_percent.total_cmp(&a.used_percent).then_with(|| a.agent.cmp(&b.agent)).then_with(|| a.key.cmp(&b.key)));
        UsageSnapshot { windows, codex: inner.codex_usage.clone() }
    }

    /// Refresh through the local Codex app-server. Ordinary calls are cached
    /// for fifteen minutes; the popover's button has its own five-minute
    /// debounce. Failures back off from 30 seconds to fifteen minutes while
    /// leaving the last snapshot intact.
    pub fn refresh_codex(&self, manual: bool) -> Result<()> {
        let now = now_ms();
        {
            let mut inner = self.inner.lock().unwrap();
            let poll = &mut inner.codex;
            if poll.in_flight
                || poll.retry_at.is_some_and(|at| now < at)
                || (!manual && poll.last_success.is_some_and(|at| now.saturating_sub(at) < BACKGROUND_REFRESH_MS))
                || (manual && poll.last_manual.is_some_and(|at| now.saturating_sub(at) < MANUAL_REFRESH_MS))
            {
                return Ok(());
            }
            poll.in_flight = true;
            if manual {
                poll.last_manual = Some(now);
            }
        }

        let answer = read_codex();

        let mut inner = self.inner.lock().unwrap();
        inner.codex.in_flight = false;
        match answer {
            Ok(result) => {
                apply_codex(&mut inner, &result, now);
                inner.codex.last_success = Some(now);
                inner.codex.retry_at = None;
                inner.codex.failures = 0;
                Ok(())
            }
            Err(error) => {
                inner.codex.failures = inner.codex.failures.saturating_add(1);
                let shift = inner.codex.failures.saturating_sub(1).min(5);
                let backoff = (30_000_i64.saturating_mul(1_i64 << shift)).min(MAX_BACKOFF_MS);
                inner.codex.retry_at = Some(now.saturating_add(backoff));
                Err(error)
            }
        }
    }

    /// Redeem the next available Codex reset credit through the same local
    /// app-server that reported it. Only one attempt may be live at a time.
    pub fn reset_codex(&self) -> Result<()> {
        let credit_id = {
            let mut inner = self.inner.lock().unwrap();
            if inner.codex_reset_in_flight || inner.codex.in_flight {
                anyhow::bail!("Codex usage is already refreshing or resetting.");
            }
            let available = inner
                .codex_usage
                .as_ref()
                .and_then(|usage| usage.reset_credits.as_ref())
                .is_some_and(|reset| reset.available_count > 0);
            if !available {
                anyhow::bail!("No Codex rate-limit reset is available.");
            }
            let credit_id = inner.codex_reset_credit_id.clone();
            inner.codex_reset_in_flight = true;
            credit_id
        };
        let mut params = serde_json::json!({"idempotencyKey": uuid::Uuid::new_v4().to_string()});
        if let Some(credit_id) = credit_id {
            params["creditId"] = Value::String(credit_id);
        }
        let answer = crate::harness::codex::appserver::ask_with_timeout(
            crate::harness::codex::appserver::Where::default(),
            "account/rateLimitResetCredit/consume",
            params,
            Duration::from_secs(30),
        )
        .context("reset Codex rate limits");

        {
            let mut inner = self.inner.lock().unwrap();
            inner.codex_reset_in_flight = false;
        }

        let answer = answer?;
        let outcome = answer.get("outcome").and_then(Value::as_str).context("Codex returned no reset outcome")?;
        match outcome {
            "reset" => {
                if let Ok(result) = read_codex() {
                    let mut inner = self.inner.lock().unwrap();
                    apply_codex(&mut inner, &result, now_ms());
                    inner.codex.last_success = Some(now_ms());
                    inner.codex.retry_at = None;
                    inner.codex.failures = 0;
                } else {
                    // The consume succeeded, so do not offer the same opaque
                    // credit again if the follow-up read happens to fail.
                    let mut inner = self.inner.lock().unwrap();
                    inner.codex_reset_credit_id = None;
                    if let Some(reset) = inner.codex_usage.as_mut().and_then(|usage| usage.reset_credits.as_mut()) {
                        reset.available_count = 0;
                        reset.next_expires_at = None;
                    }
                }
                Ok(())
            }
            "nothingToReset" => anyhow::bail!("Codex has no eligible usage window to reset."),
            "noCredit" | "alreadyRedeemed" => {
                let mut inner = self.inner.lock().unwrap();
                inner.codex_reset_credit_id = None;
                if let Some(reset) = inner.codex_usage.as_mut().and_then(|usage| usage.reset_credits.as_mut()) {
                    reset.available_count = 0;
                    reset.next_expires_at = None;
                }
                if outcome == "noCredit" {
                    anyhow::bail!("No Codex rate-limit reset is available.");
                }
                anyhow::bail!("That Codex rate-limit reset was already used.");
            }
            other => anyhow::bail!("Codex returned an unknown reset outcome: {other}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn codex_classifies_known_windows_with_one_minute_tolerance() {
        assert_eq!(classify_codex(299), ("five_hour".into(), "5h".into()));
        assert_eq!(classify_codex(300), ("five_hour".into(), "5h".into()));
        assert_eq!(classify_codex(301), ("five_hour".into(), "5h".into()));
        assert_eq!(classify_codex(10_080), ("weekly".into(), "weekly".into()));
        assert_eq!(classify_codex(10_081), ("weekly".into(), "weekly".into()));
        assert_eq!(classify_codex(60), ("60_minutes".into(), "60m".into()));
    }

    #[test]
    fn reset_seconds_become_milliseconds_without_overflow() {
        assert_eq!(seconds_to_ms(1_788_757_220), Some(1_788_757_220_000));
        assert_eq!(seconds_to_ms(i64::MAX), None);
    }

    #[test]
    fn codex_primary_and_secondary_parse_as_one_window_list() {
        let windows = parse_codex_windows(
            &json!({"rateLimits": {
                "primary": {"usedPercent": 17, "windowDurationMins": 300, "resetsAt": 1788757220},
                "secondary": {"usedPercent": 43, "windowDurationMins": 10080, "resetsAt": 1788981737},
                "planType": "pro"
            }}),
            123,
        );
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].label, "5h");
        assert_eq!(windows[0].resets_at, Some(1_788_757_220_000));
        assert_eq!(windows[1].label, "weekly");
        assert_eq!(windows[1].plan.as_deref(), Some("pro"));
    }

    #[test]
    fn codex_keeps_named_limit_windows_separate_from_the_account_windows() {
        let windows = parse_codex_windows(
            &json!({
                "rateLimits": {
                    "primary": {"usedPercent": 41, "windowDurationMins": 10080},
                    "planType": "pro"
                },
                "rateLimitsByLimitId": {
                    "codex": {
                        "primary": {"usedPercent": 41, "windowDurationMins": 10080},
                        "planType": "pro"
                    },
                    "codex_bengalfox": {
                        "limitName": "GPT-5.3-Codex-Spark",
                        "primary": {"usedPercent": 5, "windowDurationMins": 300},
                        "secondary": {"usedPercent": 9, "windowDurationMins": 10080},
                        "planType": "pro"
                    }
                }
            }),
            123,
        );
        assert_eq!(windows.len(), 3);
        assert_eq!(windows[0].key, "weekly");
        assert_eq!(windows[1].key, "codex_bengalfox_five_hour");
        assert_eq!(windows[1].label, "GPT-5.3-Codex-Spark 5h");
        assert_eq!(windows[2].key, "codex_bengalfox_weekly");
    }

    #[test]
    fn codex_credits_and_next_available_reset_parse_from_the_rpc_payload() {
        let (usage, credit_id) = parse_codex_usage(&json!({
            "rateLimits": {"credits": {"hasCredits": true, "unlimited": false, "balance": "1652.0941250000"}},
            "rateLimitResetCredits": {
                "availableCount": 2,
                "credits": [
                    {"id": "later", "status": "available", "expiresAt": 1_800_000_000},
                    {"id": "spent", "status": "redeemed", "expiresAt": 1_700_000_000},
                    {"id": "sooner", "status": "available", "expiresAt": 1_790_000_000}
                ]
            }
        }));
        assert_eq!(credit_id.as_deref(), Some("sooner"));
        assert_eq!(usage.as_ref().and_then(|value| value.credits.as_ref()).and_then(|value| value.balance.as_deref()), Some("1652.0941250000"));
        assert_eq!(usage.and_then(|value| value.reset_credits).and_then(|value| value.next_expires_at), Some(1_790_000_000_000));
    }

    #[test]
    fn claude_statusline_accepts_documented_and_fractional_usage() {
        let windows = parse_claude(
            &json!({"rate_limits": {
                "five_hour": {"used_percentage": 62, "resets_at": 1788757220},
                "seven_day_opus": {"utilization": 0.9, "resets_at": 1788981737},
                "model_scoped": [{
                    "display_name": "Fable",
                    "utilization": 82,
                    "resets_at": "2026-09-07T14:00:00.000Z"
                }]
            }}),
            456,
        );
        assert_eq!(windows.len(), 3);
        let five_hour = windows.iter().find(|window| window.key == "five_hour").unwrap();
        assert_eq!(five_hour.used_percent, 62.0);
        let opus = windows.iter().find(|window| window.key == "seven_day_opus").unwrap();
        assert_eq!(opus.label, "7d Opus");
        assert_eq!(opus.used_percent, 90.0);
        let fable = windows.iter().find(|window| window.key == "fable_weekly").unwrap();
        assert_eq!(fable.label, "Fable");
        assert_eq!(fable.used_percent, 82.0);
        assert_eq!(fable.window_minutes, Some(10_080));
        assert_eq!(fable.resets_at, Some(1_788_789_600_000));
    }
}
