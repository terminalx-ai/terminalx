//! App-wide account usage, kept in memory only.
//!
//! Claude's status-line payload is the live source after a turn. A read-only
//! OAuth usage request fills model-scoped windows that payload omits. Codex is
//! one read-only question to a short-lived app-server. Nothing is persisted.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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
    pub stale: bool,
    pub source: String,
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
    pub revision: u64,
    pub claude: ClaudeRefresh,
    pub claude_account: Option<String>,
    pub windows: Vec<UsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex: Option<CodexUsage>,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeRefresh {
    pub retry_at: Option<i64>,
    pub revalidate_at: Option<i64>,
    pub error: Option<String>,
}

#[derive(Default)]
struct PollState {
    last_success: Option<i64>,
    last_attempt: Option<i64>,
    last_manual: Option<i64>,
    retry_at: Option<i64>,
    failures: u32,
    in_flight: bool,
    error: Option<String>,
}

#[derive(Default)]
struct Inner {
    windows: HashMap<(String, String), UsageWindow>,
    revision: u64,
    claude_account: Option<String>,
    claude_generation: u64,
    claude_reset_checks: HashMap<String, (i64, u8)>,
    claude: PollState,
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

fn claude_used_percent(raw: &Value) -> Option<f32> {
    // All supported Claude fields are percentages, including utilization: 1.
    // Inferring fractions from magnitude turns genuine post-reset 1% into 100%.
    raw.get("used_percentage").and_then(numeric)
        .or_else(|| raw.get("percent").and_then(numeric))
        .or_else(|| raw.get("utilization").and_then(numeric))
        .map(|value| value.clamp(0.0, 100.0))
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
        stale: false,
        source: "statusline".into(),
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

fn expired(window: &UsageWindow, now: i64) -> bool {
    window.resets_at.is_some_and(|reset| reset <= now)
}

/// Reset deadlines identify successive windows. A late receipt of the previous
/// window never beats a confirmed next window; within one window, observation
/// time wins (OAuth uses request start, not response completion).
fn newer_window(incoming: &UsageWindow, current: &UsageWindow) -> bool {
    match (incoming.resets_at, current.resets_at) {
        (Some(next), Some(previous)) if next != previous => next > previous,
        (None, Some(_)) => false,
        _ => incoming.updated_at > current.updated_at
            || (incoming.updated_at == current.updated_at && !(incoming.source == "oauth" && current.source == "statusline")),
    }
}

fn same_sample(a: &UsageWindow, b: &UsageWindow) -> bool {
    a.used_percent == b.used_percent && a.resets_at == b.resets_at
        && a.label == b.label && a.window_minutes == b.window_minutes
}

fn merge_claude_windows(oauth: Vec<UsageWindow>, current: Vec<UsageWindow>) -> Vec<UsageWindow> {
    let mut merged: HashMap<String, UsageWindow> = current.into_iter().map(|w| (w.key.clone(), w)).collect();
    for mut window in oauth {
        if let Some(previous) = merged.get(&window.key) {
            if !newer_window(&window, previous) { continue; }
            // Seeing the same expired window again is not confirmation of a reset.
            if expired(&window, window.updated_at) && window.resets_at == previous.resets_at {
                window.updated_at = previous.updated_at;
            }
        }
        merged.insert(window.key.clone(), window);
    }
    merged.into_values().collect()
}

/// One immediate reset check and one follow-up, then ordinary polling. The
/// provider's retry gate always takes precedence, including on focus/manual.
fn claude_revalidate_at(inner: &Inner) -> Option<i64> {
    inner.windows.values().filter(|w| w.agent == "claude").filter_map(|w| {
        let reset = w.resets_at?;
        let attempts = inner.claude_reset_checks.get(&w.key)
            .filter(|(checked, _)| *checked == reset).map_or(0, |(_, count)| *count);
        let at = match attempts {
            0 => reset,
            1 => inner.claude.last_attempt?.saturating_add(60_000).max(reset),
            _ => return None,
        };
        Some(at.max(inner.claude.retry_at.unwrap_or(at)))
    }).min()
}

fn begin_claude_refresh(inner: &mut Inner, now: i64, manual: bool) -> bool {
    let reset_due = claude_revalidate_at(inner).is_some_and(|at| at <= now);
    let poll = &mut inner.claude;
    if poll.in_flight || poll.retry_at.is_some_and(|at| now < at)
        || (!manual && !reset_due && poll.last_attempt.is_some_and(|at| now.saturating_sub(at) < BACKGROUND_REFRESH_MS)) {
        return false;
    }
    poll.in_flight = true;
    poll.last_attempt = Some(now);
    for window in inner.windows.values().filter(|w| w.agent == "claude" && expired(w, now)) {
        let reset = window.resets_at.unwrap();
        let check = inner.claude_reset_checks.entry(window.key.clone()).or_insert((reset, 0));
        if check.0 != reset { *check = (reset, 0); }
        check.1 = check.1.saturating_add(1);
    }
    true
}

/// The account-level windows of one Codex limit block. The block's `limitName`
/// and `planType` are deliberately ignored: the bar shows usage, not the
/// account's tier or which model the limit is scoped to.
fn parse_codex_limit(limits: &Value, updated_at: i64) -> Vec<UsageWindow> {
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
                stale: false,
                source: "app-server".into(),
            })
        })
        .collect()
}

/// Only the account limit reaches the store. `rateLimitsByLimitId` repeats it
/// under the `codex` id and adds one entry per model-specific sub-limit; those
/// sub-limits almost always sit at 0% and would crowd out the number that
/// matters, so they are dropped here rather than hidden by every consumer.
fn parse_codex_windows(result: &Value, updated_at: i64) -> Vec<UsageWindow> {
    let windows = parse_codex_limit(&result["rateLimits"], updated_at);
    if !windows.is_empty() {
        return windows;
    }
    result
        .pointer("/rateLimitsByLimitId/codex")
        .map(|limits| parse_codex_limit(limits, updated_at))
        .unwrap_or_default()
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

/// Only compare windows attributed to the same system Claude account. Tokens
/// never leave the credential reader; this opaque identity hashes config path
/// and account UUID, and is also captured when the CLI starts.
pub fn claude_account_identity() -> Option<String> {
    use sha2::{Digest, Sha256};
    if ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].iter()
        .any(|key| std::env::var(key).is_ok_and(|value| !value.is_empty())) { return None; }
    let path = match std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|v| !v.is_empty()) {
        Some(dir) => std::path::PathBuf::from(dir).join(".claude.json"),
        None => dirs::home_dir()?.join(".claude.json"),
    };
    let path = path.canonicalize().ok()?;
    let config: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    let account = config.pointer("/oauthAccount/accountUuid")?.as_str()?;
    if account.is_empty() { return None; }
    let organization = config.pointer("/oauthAccount/organizationUuid").and_then(Value::as_str).unwrap_or_default();
    Some(format!("{:x}", Sha256::digest(format!("{}\0{account}\0{organization}", path.display()).as_bytes())))
}

fn select_claude_account(inner: &mut Inner, account: Option<String>) -> bool {
    if inner.claude_account == account { return false; }
    inner.claude_account = account;
    inner.claude_generation += 1;
    inner.windows.retain(|(agent, _), _| agent != "claude");
    inner.claude_reset_checks.clear();
    inner.claude = PollState::default();
    true
}

fn ingest_attributed_claude(inner: &mut Inner, account: Option<String>, launch_account: Option<&str>, payload: &Value, now: i64) -> bool {
    let switched = select_claude_account(inner, account.clone());
    if account.is_none() || account.as_deref() != launch_account
        || payload.get("_raccoon_usage_account").and_then(Value::as_str) != account.as_deref() {
        return switched;
    }
    apply_claude_live(inner, payload, now) || switched
}

fn apply_claude_live(inner: &mut Inner, payload: &Value, now: i64) -> bool {
    let mut changed = false;
    for mut window in parse_claude(payload, now) {
        let key = (window.agent.clone(), window.key.clone());
        if let Some(previous) = inner.windows.get(&key) {
            if !newer_window(&window, previous) { continue; }
            if same_sample(&window, previous)
                && (expired(&window, now) || now.saturating_sub(previous.updated_at) < STATUSLINE_THROTTLE_MS) {
                continue;
            }
            if expired(&window, now) && window.resets_at == previous.resets_at {
                window.updated_at = previous.updated_at;
            }
        }
        inner.windows.insert(key, window);
        changed = true;
    }
    changed
}

fn finish_claude_refresh(inner: &mut Inner, generation: u64, answer: Result<Vec<UsageWindow>>, now: i64, completed_at: i64) -> Result<()> {
    if generation != inner.claude_generation { return Ok(()); }
    inner.claude.in_flight = false;
    match answer {
        Ok(oauth) => {
            let current = inner.windows.values().filter(|w| w.agent == "claude").cloned().collect();
            for window in merge_claude_windows(oauth, current) {
                inner.windows.insert((window.agent.clone(), window.key.clone()), window);
            }
            inner.claude.last_success = Some(now);
            inner.claude.retry_at = None;
            inner.claude.error = None;
            inner.claude.failures = 0;
            Ok(())
        }
        Err(error) => {
            inner.claude.failures = inner.claude.failures.saturating_add(1);
            let shift = inner.claude.failures.saturating_sub(1).min(8);
            let backoff = (60_000_i64.saturating_mul(1_i64 << shift)).min(CLAUDE_MAX_BACKOFF_MS);
            let retry_at = error.downcast_ref::<claude_oauth::RetryAfter>().map(|retry| retry.0).unwrap_or(0);
            inner.claude.retry_at = Some(completed_at.saturating_add(backoff).max(retry_at));
            inner.claude.error = Some(format!("{error:#}"));
            Err(error)
        }
    }
}

impl UsageStore {
    /// Deduplicate identical windows only. Changed percentages and deadlines
    /// publish immediately, even when another tab just supplied the old window.
    pub fn ingest_claude(&self, launch_account: Option<&str>, payload: &Value) -> bool {
        let account = claude_account_identity();
        ingest_attributed_claude(&mut self.inner.lock().unwrap(), account, launch_account, payload, now_ms())
    }

    #[cfg(test)]
    fn ingest_claude_at(&self, payload: &Value, now: i64) -> bool {
        apply_claude_live(&mut self.inner.lock().unwrap(), payload, now)
    }

    pub fn snapshot(&self, running_agents: &HashSet<String>) -> UsageSnapshot {
        self.snapshot_at(running_agents, now_ms())
    }

    fn snapshot_at(&self, running_agents: &HashSet<String>, now: i64) -> UsageSnapshot {
        let mut inner = self.inner.lock().unwrap();
        inner.windows.retain(|_, window| window.agent == "claude" || now.saturating_sub(window.updated_at) < STALE_MS || running_agents.contains(&window.agent));
        let mut windows: Vec<_> = inner.windows.values().map(|window| {
            let mut window = window.clone();
            window.stale = now.saturating_sub(window.updated_at) >= STALE_MS
                || (window.agent == "claude" && expired(&window, now));
            window
        }).collect();
        windows.sort_by(|a, b| b.used_percent.total_cmp(&a.used_percent).then_with(|| a.agent.cmp(&b.agent)).then_with(|| a.key.cmp(&b.key)));
        inner.revision += 1;
        UsageSnapshot {
            revision: inner.revision,
            claude_account: inner.claude_account.clone(),
            windows,
            codex: inner.codex_usage.clone(),
            claude: ClaudeRefresh {
                retry_at: inner.claude.retry_at.filter(|at| *at > now),
                revalidate_at: claude_revalidate_at(&inner),
                error: inner.claude.error.clone(),
            },
        }
    }

    /// Manual and reset-boundary refreshes bypass the ordinary poll debounce,
    /// while failures and Retry-After still gate every request.
    pub fn refresh_claude(&self, manual: bool) -> Result<()> {
        let now = now_ms();
        let account = claude_account_identity();
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            select_claude_account(&mut inner, account.clone());
            if !begin_claude_refresh(&mut inner, now, manual) { return Ok(()); }
            inner.claude_generation
        };
        let answer = account.as_ref().context("Claude account attribution is unavailable; check the system Claude login")
            .and_then(|_| claude_oauth::read_token().context("Claude Code OAuth credentials were not found"))
            .and_then(|token| claude_oauth::fetch(&token, now));
        let current_account = claude_account_identity();
        let mut inner = self.inner.lock().unwrap();
        select_claude_account(&mut inner, current_account);
        finish_claude_refresh(&mut inner, generation, answer, now, now_ms())
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

    fn session_sample(used: u32, reset: i64) -> Value {
        json!({"rate_limits": {"five_hour": {"used_percentage": used, "resets_at": reset}}})
    }

    #[test]
    fn changed_percent_is_immediate_but_identical_receipts_are_deduplicated() {
        let store = UsageStore::default();
        assert!(store.ingest_claude_at(&session_sample(10, 100), 1000));
        assert!(!store.ingest_claude_at(&session_sample(10, 100), 2000));
        assert!(store.ingest_claude_at(&session_sample(11, 100), 2000));
        assert!(!store.ingest_claude_at(&session_sample(11, 100), 3000));
        assert!(store.ingest_claude_at(&session_sample(11, 100), 17_000));
    }

    #[test]
    fn expiration_is_stale_even_after_a_recent_receipt_and_does_not_make_zero() {
        let store = UsageStore::default();
        store.ingest_claude_at(&session_sample(100, 10), 9_000);
        let before = store.snapshot_at(&HashSet::new(), 9_999);
        assert!(!before.windows[0].stale);
        let after = store.snapshot_at(&HashSet::new(), 10_000);
        assert!(after.windows[0].stale);
        assert_eq!(after.windows[0].used_percent, 100.0);
        assert_eq!(after.claude.revalidate_at, Some(10_000));
        assert!(!store.ingest_claude_at(&session_sample(100, 10), 30_000));
        assert_eq!(store.snapshot_at(&HashSet::new(), 30_000).windows[0].updated_at, 9_000);
        assert!(after.revision > before.revision);
    }

    #[test]
    fn old_tab_or_oauth_window_cannot_replace_a_confirmed_rollover() {
        let store = UsageStore::default();
        store.ingest_claude_at(&session_sample(1, 200), 11_000);
        assert!(!store.ingest_claude_at(&session_sample(100, 10), 12_000));
        let oauth = parse_claude(&session_sample(100, 10), 13_000);
        let current = store.snapshot_at(&HashSet::new(), 13_000).windows;
        let merged = merge_claude_windows(oauth, current.clone());
        assert_eq!(merged, current);
        // Reverse source order: a more recently RECEIVED old live window must
        // not mask the next window from an OAuth request that started earlier.
        let merged = merge_claude_windows(current, parse_claude(&session_sample(100, 10), 14_000));
        assert_eq!(merged[0].used_percent, 1.0);
        assert_eq!(merged[0].resets_at, Some(200_000));
    }

    #[test]
    fn oauth_preserves_omitted_windows_and_live_data_arriving_in_flight() {
        let mut inner = Inner::default();
        apply_claude_live(&mut inner, &json!({"rate_limits": {
            "five_hour": {"used_percentage": 100, "resets_at": 10},
            "seven_day": {"used_percentage": 45, "resets_at": 500},
            "fable_weekly": {"used_percentage": 72, "resets_at": 600}
        }}), 9_000);
        assert!(begin_claude_refresh(&mut inner, 10_000, false));
        apply_claude_live(&mut inner, &session_sample(1, 200), 11_000);
        let old = parse_claude(&session_sample(100, 10), 10_000);
        finish_claude_refresh(&mut inner, 0, Ok(old), 10_000, 12_000).unwrap();
        assert_eq!(inner.windows.len(), 3);
        assert_eq!(inner.windows[&("claude".into(), "five_hour".into())].used_percent, 1.0);
        // A delayed response for the SAME window also loses to the live turn.
        let old = parse_claude(&session_sample(0, 200), 10_000);
        finish_claude_refresh(&mut inner, 0, Ok(old), 10_000, 13_000).unwrap();
        assert_eq!(inner.windows[&("claude".into(), "five_hour".into())].used_percent, 1.0);
        assert!(finish_claude_refresh(&mut inner, 0, Err(anyhow::anyhow!("offline")), 10_000, 14_000).is_err());
        assert_eq!(inner.windows[&("claude".into(), "five_hour".into())].used_percent, 1.0);
        assert_eq!(inner.windows[&("claude".into(), "fable_weekly".into())].used_percent, 72.0);
    }

    #[test]
    fn expiry_bypasses_recent_poll_once_then_gets_one_bounded_followup() {
        let mut inner = Inner::default();
        apply_claude_live(&mut inner, &session_sample(100, 10), 9_000);
        inner.claude.last_attempt = Some(9_500);
        assert!(!begin_claude_refresh(&mut inner, 9_999, false));
        assert!(begin_claude_refresh(&mut inner, 10_000, false));
        assert!(!begin_claude_refresh(&mut inner, 10_000, true));
        let old = parse_claude(&session_sample(100, 10), 10_000);
        finish_claude_refresh(&mut inner, 0, Ok(old), 10_000, 11_000).unwrap();
        assert_eq!(inner.windows[&("claude".into(), "five_hour".into())].updated_at, 9_000);
        assert_eq!(claude_revalidate_at(&inner), Some(70_000));
        assert!(!begin_claude_refresh(&mut inner, 69_999, false));
        assert!(begin_claude_refresh(&mut inner, 70_000, false));
        finish_claude_refresh(&mut inner, 0, Ok(vec![]), 70_000, 71_000).unwrap();
        assert_eq!(claude_revalidate_at(&inner), None);
        assert!(!begin_claude_refresh(&mut inner, 72_000, false));
        assert!(begin_claude_refresh(&mut inner, 70_000 + BACKGROUND_REFRESH_MS, false));
    }

    #[test]
    fn manual_refresh_bypasses_polling_but_respects_retry_after() {
        let mut inner = Inner::default();
        inner.claude.last_attempt = Some(1000);
        assert!(!begin_claude_refresh(&mut inner, 2000, false));
        assert!(begin_claude_refresh(&mut inner, 2000, true));
        let error = claude_oauth::RetryAfter(180_000).into();
        assert!(finish_claude_refresh(&mut inner, 0, Err(error), 2000, 3000).is_err());
        assert_eq!(inner.claude.retry_at, Some(180_000));
        assert!(inner.claude.error.is_some());
        assert!(!begin_claude_refresh(&mut inner, 4000, true));
        apply_claude_live(&mut inner, &session_sample(100, 10), 9_000);
        assert_eq!(claude_revalidate_at(&inner), Some(180_000));
        assert!(!begin_claude_refresh(&mut inner, 10_000, false));
        assert!(begin_claude_refresh(&mut inner, 180_000, false));
    }

    #[test]
    fn account_switch_rejects_old_tabs_unknown_identity_and_inflight_responses() {
        let mut inner = Inner::default();
        let mut a = session_sample(100, 100);
        a["_raccoon_usage_account"] = json!("account-a");
        ingest_attributed_claude(&mut inner, Some("account-a".into()), Some("account-a"), &a, 1000);
        assert_eq!(inner.windows.len(), 1);
        let generation = inner.claude_generation;
        assert!(begin_claude_refresh(&mut inner, 1000, false));
        // The old tab's next hook observes the selected account B, but it was
        // launched for A; its windows must not be reassigned to B.
        ingest_attributed_claude(&mut inner, Some("account-b".into()), Some("account-a"), &a, 2000);
        assert!(inner.windows.is_empty());
        let mut b = session_sample(12, 90);
        b["_raccoon_usage_account"] = json!("account-b");
        ingest_attributed_claude(&mut inner, Some("account-b".into()), Some("account-b"), &b, 3000);
        // Generation protects even a response with a later reset deadline.
        finish_claude_refresh(&mut inner, generation, Ok(parse_claude(&a, 1000)), 1000, 4000).unwrap();
        assert_eq!(inner.windows[&("claude".into(), "five_hour".into())].used_percent, 12.0);
        assert!(inner.claude.retry_at.is_none());
        assert!(!ingest_attributed_claude(&mut inner, Some("account-b".into()), Some("account-b"), &a, 5000));
        ingest_attributed_claude(&mut inner, None, None, &b, 6000);
        assert!(inner.windows.is_empty());
    }

    #[test]
    fn changed_live_rollover_is_published_inside_dedup_interval() {
        let store = UsageStore::default();
        let reset = 1_788_757_220;
        let before_at = reset * 1000 - 1000;
        let after_at = reset * 1000 + 1000;
        let before = json!({"rate_limits": {
            "five_hour": {"used_percentage": 100, "resets_at": reset},
            "seven_day": {"used_percentage": 45},
            "fable_weekly": {"used_percentage": 72}
        }});
        assert!(store.ingest_claude_at(&before, before_at));
        assert!(!store.ingest_claude_at(&before, before_at));
        let after = json!({"rate_limits": {
            "five_hour": {"used_percentage": 1, "resets_at": reset + 18_000}
        }});
        assert!(store.ingest_claude_at(&after, after_at), "changed post-reset sample must publish immediately");
        let snapshot = store.snapshot_at(&HashSet::new(), after_at);
        assert_eq!(snapshot.windows.len(), 3);
        assert_eq!(snapshot.windows.iter().find(|w| w.key == "five_hour").unwrap().used_percent, 1.0);
    }

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
        assert_eq!(windows[1].used_percent, 43.0);
    }

    #[test]
    fn codex_drops_per_model_limits_and_keeps_the_account_window() {
        let windows = parse_codex_windows(
            &json!({
                "rateLimits": {
                    "primary": {"usedPercent": 41, "windowDurationMins": 10080, "resetsAt": 1788981737},
                    "planType": "pro"
                },
                "rateLimitsByLimitId": {
                    "codex": {
                        "primary": {"usedPercent": 41, "windowDurationMins": 10080, "resetsAt": 1788981737},
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
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].key, "weekly");
        assert_eq!(windows[0].label, "weekly");
        assert_eq!(windows[0].used_percent, 41.0);
        assert_eq!(windows[0].resets_at, Some(1_788_981_737_000));
    }

    #[test]
    fn codex_falls_back_to_the_codex_limit_id_when_the_account_block_is_missing() {
        let windows = parse_codex_windows(
            &json!({
                "rateLimitsByLimitId": {
                    "codex": {"primary": {"usedPercent": 12, "windowDurationMins": 300}},
                    "codex_bengalfox": {
                        "limitName": "GPT-5.3-Codex-Spark",
                        "primary": {"usedPercent": 5, "windowDurationMins": 300}
                    }
                }
            }),
            123,
        );
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].key, "five_hour");
        assert_eq!(windows[0].used_percent, 12.0);
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
    fn claude_statusline_accepts_percentage_fields() {
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
        assert_eq!(opus.used_percent, 0.9);
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
