//! App-wide account usage, kept in memory only.
//!
//! Claude's status-line payload is the live source after a turn. A read-only
//! OAuth usage request fills model-scoped windows that payload omits. Codex is
//! one read-only question to a short-lived app-server. Nothing is persisted.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;

mod claude_oauth;

pub const EVENT: &str = "status_usage";
const STATUSLINE_THROTTLE_MS: i64 = 15_000;
const BACKGROUND_REFRESH_MS: i64 = 15 * 60_000;
const MANUAL_REFRESH_MS: i64 = 5 * 60_000;
const STALE_MS: i64 = 30 * 60_000;
const MAX_BACKOFF_MS: i64 = 15 * 60_000;
const CLAUDE_MAX_BACKOFF_MS: i64 = 4 * 60 * 60_000;

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
    last_attempt: Option<i64>,
    last_manual: Option<i64>,
    retry_at: Option<i64>,
    failures: u32,
    in_flight: bool,
}

#[derive(Default)]
struct Inner {
    windows: HashMap<(String, String), UsageWindow>,
    statusline_by_tab: HashMap<String, i64>,
    claude_statusline_by_key: HashMap<String, i64>,
    claude: PollState,
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
    if let Some(seconds) = value.as_i64().or_else(|| value.as_f64().map(|n| n as i64)) {
        return seconds_to_ms(seconds);
    }
    let raw = value.as_str()?.trim();
    if let Ok(seconds) = raw.parse() {
        return seconds_to_ms(seconds);
    }
    chrono::DateTime::parse_from_rfc3339(raw).ok().map(|timestamp| timestamp.timestamp_millis())
}

fn claude_used_percent(raw: &Value) -> Option<f32> {
    if let Some(value) = raw.get("used_percentage").and_then(numeric).or_else(|| raw.get("percent").and_then(numeric)) {
        return Some(value.clamp(0.0, 100.0));
    }
    let utilization = raw.get("utilization").and_then(numeric)?;
    Some(if utilization <= 1.0 { utilization * 100.0 } else { utilization }.clamp(0.0, 100.0))
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
    let (label, window_minutes) = claude_label(key);
    Some(UsageWindow {
        agent: "claude".into(),
        key: key.into(),
        label,
        used_percent: claude_used_percent(raw)?,
        resets_at: raw.get("resets_at").and_then(reset_ms),
        window_minutes,
        updated_at,
        plan: None,
        stale: false,
    })
}

fn scoped_model_key(display_name: &str) -> String {
    if display_name.eq_ignore_ascii_case("Fable") {
        return "fable_weekly".into();
    }
    let mut slug = String::new();
    let mut separator = false;
    for character in display_name.chars() {
        if character.is_alphanumeric() {
            if separator && !slug.is_empty() {
                slug.push('_');
            }
            slug.extend(character.to_lowercase());
            separator = false;
        } else {
            separator = true;
        }
    }
    format!("model_scoped_{}", slug.trim_matches('_'))
}

fn parse_scoped_claude_window(raw: &Value, updated_at: i64) -> Option<UsageWindow> {
    let display_name = raw
        .get("display_name")
        .and_then(Value::as_str)
        .or_else(|| raw.pointer("/scope/model/display_name").and_then(Value::as_str))?
        .trim();
    if display_name.is_empty() {
        return None;
    }
    let mut window = parse_claude_window(&scoped_model_key(display_name), raw, updated_at)?;
    window.label = display_name.to_string();
    window.window_minutes = Some(10_080);
    Some(window)
}

fn upsert_window(windows: &mut Vec<UsageWindow>, window: UsageWindow) {
    windows.retain(|current| current.key != window.key);
    windows.push(window);
}

fn parse_claude(payload: &Value, updated_at: i64) -> Vec<UsageWindow> {
    let Some(rate_limits) = payload.get("rate_limits").and_then(Value::as_object) else { return Vec::new() };
    let mut windows: Vec<_> = rate_limits
        .iter()
        .filter_map(|(key, raw)| parse_claude_window(key, raw, updated_at))
        .collect();
    if let Some(scoped) = rate_limits.get("model_scoped").and_then(Value::as_array) {
        for window in scoped.iter().filter_map(|raw| parse_scoped_claude_window(raw, updated_at)) {
            upsert_window(&mut windows, window);
        }
    }
    windows
}

fn merge_claude_windows(oauth: Vec<UsageWindow>, statusline: Vec<UsageWindow>) -> Vec<UsageWindow> {
    let mut merged: HashMap<String, UsageWindow> = oauth.into_iter().map(|window| (window.key.clone(), window)).collect();
    for window in statusline {
        merged.insert(window.key.clone(), window);
    }
    merged.into_values().collect()
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
            inner.claude_statusline_by_key.insert(window.key.clone(), now);
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

    /// Fill Claude windows that the status line has not supplied recently.
    /// Credentials are read for this request only, and even a manual refresh
    /// cannot call the endpoint more than once every fifteen minutes.
    pub fn refresh_claude(&self) -> Result<()> {
        let now = now_ms();
        {
            let mut inner = self.inner.lock().unwrap();
            let fable_is_live = inner
                .claude_statusline_by_key
                .get("fable_weekly")
                .is_some_and(|last| now.saturating_sub(*last) < BACKGROUND_REFRESH_MS);
            let poll = &mut inner.claude;
            if fable_is_live
                || poll.in_flight
                || poll.retry_at.is_some_and(|at| now < at)
                || poll.last_attempt.is_some_and(|at| now.saturating_sub(at) < BACKGROUND_REFRESH_MS)
            {
                return Ok(());
            }
            poll.in_flight = true;
            poll.last_attempt = Some(now);
        }

        let answer = claude_oauth::read_token()
            .context("Claude Code OAuth credentials were not found")
            .and_then(|token| claude_oauth::fetch(&token, now));

        let mut inner = self.inner.lock().unwrap();
        inner.claude.in_flight = false;
        match answer {
            Ok(oauth) => {
                let live_statusline = inner
                    .windows
                    .values()
                    .filter(|window| window.agent == "claude")
                    .filter(|window| {
                        inner
                            .claude_statusline_by_key
                            .get(&window.key)
                            .is_some_and(|seen| now.saturating_sub(*seen) < BACKGROUND_REFRESH_MS)
                    })
                    .cloned()
                    .collect();
                let windows = merge_claude_windows(oauth, live_statusline);
                inner.windows.retain(|(agent, _), _| agent != "claude");
                for window in windows {
                    inner.windows.insert((window.agent.clone(), window.key.clone()), window);
                }
                inner.claude.last_success = Some(now);
                inner.claude.retry_at = None;
                inner.claude.failures = 0;
                Ok(())
            }
            Err(error) => {
                inner.claude.failures = inner.claude.failures.saturating_add(1);
                let shift = inner.claude.failures.saturating_sub(1).min(4);
                let backoff = (BACKGROUND_REFRESH_MS.saturating_mul(1_i64 << shift)).min(CLAUDE_MAX_BACKOFF_MS);
                inner.claude.retry_at = Some(now.saturating_add(backoff));
                Err(error)
            }
        }
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

    #[test]
    fn statusline_windows_win_while_oauth_fills_missing_windows() {
        let oauth = claude_oauth::parse_response(
            &json!({
                "five_hour": {"utilization": 12},
                "seven_day": {"utilization": 44},
                "limits": [
                    {
                        "kind": "weekly_scoped",
                        "percent": 82,
                        "scope": {"model": {"display_name": "Fable"}}
                    },
                    {
                        "kind": "weekly_scoped",
                        "percent": 24,
                        "scope": {"model": {"display_name": "Sonnet 4.5"}}
                    }
                ]
            }),
            100,
        );
        let statusline = parse_claude(
            &json!({"rate_limits": {
                "five_hour": {"used_percentage": 23, "resets_at": 1788757220}
            }}),
            200,
        );

        let merged = merge_claude_windows(oauth, statusline);
        assert_eq!(merged.len(), 4);
        let five_hour = merged.iter().find(|window| window.key == "five_hour").unwrap();
        assert_eq!(five_hour.used_percent, 23.0);
        assert_eq!(five_hour.updated_at, 200);
        assert_eq!(merged.iter().find(|window| window.key == "seven_day").unwrap().used_percent, 44.0);
        assert_eq!(merged.iter().find(|window| window.key == "fable_weekly").unwrap().used_percent, 82.0);
        assert_eq!(merged.iter().find(|window| window.key == "model_scoped_sonnet_4_5").unwrap().label, "Sonnet 4.5");
    }
}
