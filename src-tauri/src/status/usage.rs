//! App-wide account usage, kept in memory only.
//!
//! Claude arrives for free in the status-line payload the CLI already builds
//! after a turn. Codex is one read-only question to a short-lived app-server.
//! Neither path introduces an HTTP client or persists account data.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

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

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub windows: Vec<UsageWindow>,
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
    let seconds = value.as_i64().or_else(|| value.as_f64().map(|n| n as i64)).or_else(|| value.as_str()?.parse().ok())?;
    seconds_to_ms(seconds)
}

fn claude_label(key: &str) -> (String, Option<u32>) {
    match key {
        "five_hour" => ("5h".into(), Some(300)),
        "seven_day" => ("7d".into(), Some(10_080)),
        "seven_day_opus" => ("7d Opus".into(), Some(10_080)),
        "seven_day_sonnet" => ("7d Sonnet".into(), Some(10_080)),
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

fn parse_claude(payload: &Value, updated_at: i64) -> Vec<UsageWindow> {
    let Some(rate_limits) = payload.get("rate_limits").and_then(Value::as_object) else { return Vec::new() };
    rate_limits
        .iter()
        .filter_map(|(key, raw)| {
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
                key: key.clone(),
                label,
                used_percent,
                resets_at: raw.get("resets_at").and_then(reset_ms),
                window_minutes,
                updated_at,
                plan: None,
                stale: false,
            })
        })
        .collect()
}

fn parse_codex(result: &Value, updated_at: i64) -> Vec<UsageWindow> {
    let limits = &result["rateLimits"];
    let plan = limits["planType"].as_str().map(str::to_string);
    ["primary", "secondary"]
        .into_iter()
        .filter_map(|slot| {
            let raw = limits.get(slot)?.as_object()?;
            let minutes = raw.get("windowDurationMins")?.as_u64()?.try_into().ok()?;
            let (key, label) = classify_codex(minutes);
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
        UsageSnapshot { windows }
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

        let answer = crate::harness::codex::appserver::ask(
            crate::harness::codex::appserver::Where::default(),
            "account/rateLimits/read",
            serde_json::json!({}),
        )
        .context("read Codex rate limits");

        let mut inner = self.inner.lock().unwrap();
        inner.codex.in_flight = false;
        match answer {
            Ok(result) => {
                let windows = parse_codex(&result, now);
                inner.windows.retain(|(agent, _), _| agent != "codex");
                for window in windows {
                    inner.windows.insert((window.agent.clone(), window.key.clone()), window);
                }
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
        let windows = parse_codex(
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
    fn claude_statusline_accepts_documented_and_fractional_usage() {
        let windows = parse_claude(
            &json!({"rate_limits": {
                "five_hour": {"used_percentage": 62, "resets_at": 1788757220},
                "seven_day_opus": {"utilization": 0.9, "resets_at": 1788981737}
            }}),
            456,
        );
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].used_percent, 62.0);
        assert_eq!(windows[1].label, "7d Opus");
        assert_eq!(windows[1].used_percent, 90.0);
    }
}
