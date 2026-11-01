//! App-wide account usage, kept in memory only.
//!
//! Claude's status-line payload is the live source after a turn. A read-only
//! OAuth usage request fills model-scoped windows that payload omits. Codex is
//! one read-only question to a short-lived app-server. Nothing is persisted.
//!
//! The status bar asks again at the user's automatic interval; the gates here
//! decide whether an ask becomes a provider request.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod claude_oauth;

pub const EVENT: &str = "status_usage";
const STATUSLINE_THROTTLE_MS: i64 = 15_000;
/// How recent an answer ordinary (focus, visibility) refreshes reuse when the
/// automatic timer is off. With it on, the configured interval takes over.
const BACKGROUND_REFRESH_MS: i64 = 15 * 60_000;
/// A tick counts as due this far ahead of the interval, so a timer that fires
/// a moment early against the previous request's start is not skipped whole.
const REFRESH_SLACK_MS: i64 = 5_000;
const MANUAL_REFRESH_MS: i64 = 5 * 60_000;
const STALE_MS: i64 = 30 * 60_000;
const MAX_BACKOFF_MS: i64 = 15 * 60_000;
const CLAUDE_MAX_BACKOFF_MS: i64 = 4 * 60 * 60_000;
/// Reset deadlines this close name one window (#729). The status line gives
/// whole epoch seconds; the usage endpoint gives an RFC 3339 time with
/// fractions that moves between requests. Successive windows are hours apart.
const RESET_TOLERANCE_MS: i64 = 60_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexCredits {
    pub has_credits: bool,
    pub unlimited: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub balance: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexResetCredits {
    pub available_count: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credits: Option<CodexCredits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset_credits: Option<CodexResetCredits>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub revision: u64,
    pub claude: ClaudeRefresh,
    pub codex_refresh: CodexRefresh,
    pub claude_account: Option<String>,
    pub windows: Vec<UsageWindow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex: Option<CodexUsage>,
}

impl UsageSnapshot {
    /// Read a snapshot from the background runtime, which may predate #729.
    /// Such a runtime sends no `lastUpdatedAt`: every answer it got counted as
    /// an update, so its last answer stands in rather than reading as one that
    /// changed nothing.
    pub fn from_runtime(value: Value) -> Result<Self> {
        let predates_outcomes = value.pointer("/claude/lastUpdatedAt").is_none();
        let mut snapshot: Self = serde_json::from_value(value).context("read the runtime's usage snapshot")?;
        if predates_outcomes {
            snapshot.claude.last_updated_at = snapshot.claude.last_success_at;
        }
        Ok(snapshot)
    }
}

/// Fields added after a release carry `serde(default)`: the desktop app reads
/// this snapshot from a background runtime that may be older than it.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ClaudeRefresh {
    pub retry_at: Option<i64>,
    pub revalidate_at: Option<i64>,
    pub error: Option<String>,
    /// When the provider last answered.
    pub last_success_at: Option<i64>,
    /// When an answer last replaced at least one shown window. Older than
    /// `last_success_at` when the latest answer changed nothing.
    pub last_updated_at: Option<i64>,
    /// Windows in the latest answer that did not replace the shown ones.
    pub refused: Vec<RefusedWindow>,
    /// The latest manual refresh that did not reach the provider.
    pub skipped: Option<RefreshSkip>,
    /// Live usage from a Claude turn that was not used, newer than any that was.
    pub live_refused: Option<LiveRefused>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CodexRefresh {
    pub retry_at: Option<i64>,
    pub error: Option<String>,
    pub last_success_at: Option<i64>,
    /// The latest manual refresh that did not reach the provider.
    pub skipped: Option<RefreshSkip>,
}

/// Why a received window did not replace the one shown under its key.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Refusal {
    /// Its reset deadline is earlier: a late receipt of the previous window.
    /// From the endpoint, that window had already ended when it was asked.
    EarlierWindow,
    /// The same window, observed no later than the one shown.
    OlderObservation,
    /// No reset deadline while the shown window still runs, from a status
    /// line that may be repeating a tab's sample from before that window.
    NoDeadline,
}

impl Refusal {
    fn describe(self) -> &'static str {
        match self {
            Refusal::EarlierWindow => "earlier reset than the shown window",
            Refusal::OlderObservation => "not newer than the shown window",
            Refusal::NoDeadline => "no reset time while the shown window runs",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefusedWindow {
    pub key: String,
    pub label: String,
    pub reason: Refusal,
}

/// Why a refresh did not reach the provider.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SkipReason {
    /// A request is already out; its answer will be published.
    InFlight,
    /// A failure or the provider's Retry-After is still holding requests.
    RetryPending,
    /// The last answer is recent enough to reuse.
    Recent,
    /// A Codex reset is being redeemed.
    ResetInFlight,
}

impl SkipReason {
    fn describe(self) -> &'static str {
        match self {
            SkipReason::InFlight => "a request is already in flight",
            SkipReason::RetryPending => "waiting out a retry pause",
            SkipReason::Recent => "the last answer is recent",
            SkipReason::ResetInFlight => "a Codex reset is in progress",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefreshSkip {
    pub at: i64,
    pub reason: SkipReason,
    /// When the button will reach the provider again, if that is known.
    pub next_at: Option<i64>,
}

/// Why live usage from a Claude turn was not used.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LiveRefusal {
    /// The system Claude account could not be identified.
    Unidentified,
    /// The tab started under a different Claude account than the current one.
    LaunchMismatch,
    /// The status line reported a different Claude account.
    StatuslineMismatch,
}

impl LiveRefusal {
    fn describe(self) -> &'static str {
        match self {
            LiveRefusal::Unidentified => "the system Claude account could not be identified",
            LiveRefusal::LaunchMismatch => "the tab started under a different Claude account",
            LiveRefusal::StatuslineMismatch => "the status line reported a different Claude account",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LiveRefused {
    pub at: i64,
    pub reason: LiveRefusal,
}

#[derive(Default)]
struct PollState {
    last_success: Option<i64>,
    last_updated: Option<i64>,
    last_attempt: Option<i64>,
    last_manual: Option<i64>,
    retry_at: Option<i64>,
    /// The pause in `retry_at` follows a failure on this machine, before any
    /// request reached the provider, so a manual refresh may clear it.
    local_failure: bool,
    failures: u32,
    in_flight: bool,
    /// The request in flight was asked for with the button.
    manual_in_flight: bool,
    error: Option<String>,
    refused: Vec<RefusedWindow>,
    skipped: Option<RefreshSkip>,
}

/// Live usage from Claude turns: when a sample was last used or refused.
#[derive(Default)]
struct LiveState {
    accepted_at: Option<i64>,
    refused: Option<LiveRefused>,
}

impl LiveState {
    /// A refusal matters while nothing newer was used: what is shown is then
    /// older than usage that arrived and was turned away.
    fn showing(&self) -> Option<&LiveRefused> {
        self.refused.as_ref().filter(|refused| self.accepted_at.is_none_or(|at| refused.at > at))
    }
}

#[derive(Default)]
struct Inner {
    windows: HashMap<(String, String), UsageWindow>,
    revision: u64,
    claude_account: Option<String>,
    claude_generation: u64,
    claude_reset_checks: HashMap<String, (i64, u8)>,
    claude: PollState,
    claude_live: LiveState,
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

fn same_deadline(a: i64, b: i64) -> bool {
    a.abs_diff(b) <= RESET_TOLERANCE_MS.unsigned_abs()
}

/// Why a received window replaced the one shown under its key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Taken {
    /// Nothing was shown under its key.
    First,
    /// Its reset deadline is later: the next window.
    NextWindow,
    /// The same window, observed later.
    Newer,
    /// The shown window is over and the provider has none running yet.
    NotStarted,
    /// An earlier deadline the endpoint gave while that window still ran: the
    /// shown window, with its later deadline, had not started (#737).
    Running,
}

impl Taken {
    fn describe(self) -> &'static str {
        match self {
            Taken::First => "first window under this key",
            Taken::NextWindow => "later reset: the next window",
            Taken::Newer => "same window, newer observation",
            Taken::NotStarted => "shown window is over; none started",
            Taken::Running => "earlier reset, still running when asked",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Take(Taken),
    Refuse(Refusal),
}

/// One received window and what became of it.
#[derive(Debug, Clone)]
struct Decision {
    received: UsageWindow,
    verdict: Verdict,
}

/// The later of two observations of one window. OAuth observation time is
/// request start, so a reply loses to a turn that arrived while it was out;
/// a turn wins a tie.
fn later_observation(incoming: &UsageWindow, current: &UsageWindow) -> bool {
    incoming.updated_at > current.updated_at
        || (incoming.updated_at == current.updated_at && !(incoming.source == "oauth" && current.source == "statusline"))
}

/// Reset deadlines tell successive windows apart, so a late receipt of the
/// previous window (an idle tab repeating its last sample) never beats the
/// next one. Deadlines within `RESET_TOLERANCE_MS` are one window, where the
/// later observation wins.
///
/// An earlier deadline is not always the previous window. Windows under one
/// key follow each other without overlapping, so when the endpoint says at
/// request start that a window runs until a later moment, no later window had
/// started then (#737). Unlike a status line, which may repeat an old sample,
/// that answer is fresh: it replaces the shown window if observed later.
fn judge(incoming: &UsageWindow, current: Option<&UsageWindow>) -> Verdict {
    let Some(current) = current else { return Verdict::Take(Taken::First) };
    match (incoming.resets_at, current.resets_at) {
        (Some(next), Some(shown)) if !same_deadline(next, shown) => {
            if next > shown {
                Verdict::Take(Taken::NextWindow)
            } else if incoming.source != "oauth" || next <= incoming.updated_at {
                Verdict::Refuse(Refusal::EarlierWindow)
            } else if later_observation(incoming, current) {
                Verdict::Take(Taken::Running)
            } else {
                // What is shown arrived after the request started.
                Verdict::Refuse(Refusal::OlderObservation)
            }
        }
        // What is shown was observed after this window had already ended.
        (Some(next), None) if next <= current.updated_at.saturating_add(RESET_TOLERANCE_MS) => {
            Verdict::Refuse(Refusal::EarlierWindow)
        }
        (None, Some(shown)) if shown <= incoming.updated_at => Verdict::Take(Taken::NotStarted),
        // Only the endpoint's fresh answer can say a running window has no
        // deadline; a status line may be repeating a sample from before it.
        (None, Some(_)) if incoming.source != "oauth" => Verdict::Refuse(Refusal::NoDeadline),
        _ if later_observation(incoming, current) => Verdict::Take(Taken::Newer),
        _ => Verdict::Refuse(Refusal::OlderObservation),
    }
}

/// What to show for a window the judge took.
fn settled(mut window: UsageWindow, current: Option<&UsageWindow>) -> UsageWindow {
    let over_when_asked = window.resets_at.is_some_and(|reset| reset.saturating_add(RESET_TOLERANCE_MS) <= window.updated_at);
    if window.source == "oauth" && over_when_asked {
        // The endpoint answered with a window that had ended before it was
        // asked: none has started since, so none of its usage still counts.
        window.used_percent = 0.0;
        window.resets_at = None;
    } else if expired(&window, window.updated_at)
        && current.is_some_and(|shown| shown.resets_at.zip(window.resets_at).is_some_and(|(a, b)| same_deadline(a, b)))
    {
        // A status line repeating an expired window does not confirm a reset.
        window.updated_at = current.map_or(window.updated_at, |shown| shown.updated_at);
    }
    window
}

fn same_sample(a: &UsageWindow, b: &UsageWindow) -> bool {
    a.used_percent == b.used_percent && a.resets_at == b.resets_at
        && a.label == b.label && a.window_minutes == b.window_minutes
}

/// Judge each received window against the one shown under its key and put
/// those taken in its place. Windows the answer omits stay as they are.
fn merge_claude_windows(received: Vec<UsageWindow>, shown: &mut HashMap<String, UsageWindow>) -> Vec<Decision> {
    received.into_iter().map(|window| {
        let current = shown.get(&window.key);
        let verdict = judge(&window, current);
        if matches!(verdict, Verdict::Take(_)) {
            let show = settled(window.clone(), current);
            shown.insert(window.key.clone(), show);
        }
        Decision { received: window, verdict }
    }).collect()
}

fn format_reset(reset: Option<i64>) -> String {
    reset.and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
        .map_or_else(|| "no reset".into(), |at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn format_received(window: &UsageWindow) -> String {
    format!("{} {}% {}", window.key, window.used_percent, format_reset(window.resets_at))
}

/// One line per refresh: what arrived, what became of each window, the result.
fn decisions_log(decisions: &[Decision]) -> String {
    let taken = decisions.iter().filter(|d| matches!(d.verdict, Verdict::Take(_))).count();
    let each = decisions.iter().map(|decision| {
        let outcome = match decision.verdict {
            Verdict::Take(why) => format!("replaced ({})", why.describe()),
            Verdict::Refuse(why) => format!("kept shown ({})", why.describe()),
        };
        format!("{}: {outcome}", format_received(&decision.received))
    }).collect::<Vec<_>>();
    let result = if taken == 0 { "no newer usage".to_string() } else { format!("updated {taken} of {}", decisions.len()) };
    format!("received [{}]; {result}", each.join("; "))
}

fn trigger(manual: bool) -> &'static str {
    if manual { "manual" } else { "automatic" }
}

/// A refresh that did not reach the provider. The button's are kept for the
/// popover to explain; the timer's are routine.
fn note_skip(poll: &mut PollState, provider: &str, manual: bool, now: i64, reason: SkipReason, next_at: Option<i64>) {
    if manual {
        log::info!("{provider} usage refresh (manual) skipped: {}", reason.describe());
        poll.skipped = Some(RefreshSkip { at: now, reason, next_at });
    } else {
        log::debug!("{provider} usage refresh (automatic) skipped: {}", reason.describe());
    }
}

/// One immediate reset check and one follow-up, then ordinary polling. The
/// provider's retry gate always takes precedence, including on focus/manual.
fn claude_revalidate_at(inner: &Inner) -> Option<i64> {
    inner.windows.values().filter(|w| w.agent == "claude").filter_map(|w| {
        let reset = w.resets_at?;
        let attempts = inner.claude_reset_checks.get(&w.key)
            .filter(|(checked, _)| same_deadline(*checked, reset)).map_or(0, |(_, count)| *count);
        let at = match attempts {
            0 => reset,
            1 => inner.claude.last_attempt?.saturating_add(60_000).max(reset),
            _ => return None,
        };
        Some(at.max(inner.claude.retry_at.unwrap_or(at)))
    }).min()
}

/// How long an ordinary refresh keeps reusing the last answer. `cadence` is
/// the configured automatic interval; the status-bar timer and this floor move
/// together, so each tick is allowed to reach the provider.
fn background_floor(cadence: Option<i64>) -> i64 {
    cadence.unwrap_or(BACKGROUND_REFRESH_MS).saturating_sub(REFRESH_SLACK_MS).max(0)
}

fn begin_claude_refresh(inner: &mut Inner, now: i64, manual: bool, cadence: Option<i64>) -> bool {
    let reset_due = claude_revalidate_at(inner).is_some_and(|at| at <= now);
    let floor = background_floor(cadence);
    let poll = &mut inner.claude;
    // Reading Claude Code's login asks nothing of the provider, so the button
    // starts that backoff over; only the timer is held by it.
    if manual && poll.local_failure && !poll.in_flight {
        poll.retry_at = None;
        poll.failures = 0;
        poll.local_failure = false;
    }
    let recent = poll.last_attempt.filter(|at| !manual && !reset_due && now.saturating_sub(*at) < floor);
    let skip = if poll.in_flight {
        Some((SkipReason::InFlight, None))
    } else if let Some(at) = poll.retry_at.filter(|at| now < *at) {
        Some((SkipReason::RetryPending, Some(at)))
    } else {
        recent.map(|at| (SkipReason::Recent, Some(at.saturating_add(floor))))
    };
    if let Some((reason, next_at)) = skip {
        note_skip(poll, "Claude", manual, now, reason, next_at);
        return false;
    }
    poll.in_flight = true;
    poll.manual_in_flight = manual;
    poll.last_attempt = Some(now);
    poll.skipped = None;
    for window in inner.windows.values().filter(|w| w.agent == "claude" && expired(w, now)) {
        let reset = window.resets_at.unwrap();
        let check = inner.claude_reset_checks.entry(window.key.clone()).or_insert((reset, 0));
        if !same_deadline(check.0, reset) { *check = (reset, 0); }
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

/// The timer and the popover's button each have their own debounce; a manual
/// refresh is never held back longer than a timer tick would be. An in-flight
/// request and the failure backoff gate both.
fn begin_codex_refresh(inner: &mut Inner, now: i64, manual: bool, cadence: Option<i64>) -> bool {
    let floor = background_floor(cadence);
    let poll = &mut inner.codex;
    let recent = |at: Option<i64>, within: i64| at.is_some_and(|at| now.saturating_sub(at) < within);
    let skip = if poll.in_flight {
        Some((SkipReason::InFlight, None))
    } else if inner.codex_reset_in_flight {
        Some((SkipReason::ResetInFlight, None))
    } else if let Some(at) = poll.retry_at.filter(|at| now < *at) {
        Some((SkipReason::RetryPending, Some(at)))
    } else if recent(poll.last_success, floor) && !(manual && !recent(poll.last_manual, MANUAL_REFRESH_MS)) {
        // The timer asks again once its floor has passed; the button also
        // once its own debounce has.
        let floor_at = poll.last_success.map(|at| at.saturating_add(floor));
        let button_at = poll.last_manual.filter(|_| manual).map(|at| at.saturating_add(MANUAL_REFRESH_MS));
        Some((SkipReason::Recent, floor_at.into_iter().chain(button_at).min()))
    } else {
        None
    };
    if let Some((reason, next_at)) = skip {
        note_skip(poll, "Codex", manual, now, reason, next_at);
        return false;
    }
    poll.in_flight = true;
    poll.manual_in_flight = manual;
    poll.skipped = None;
    if manual {
        poll.last_manual = Some(now);
    }
    true
}

fn finish_codex_refresh(inner: &mut Inner, answer: Result<Value>, now: i64) -> Result<()> {
    inner.codex.in_flight = false;
    inner.codex.skipped = None;
    let manual = inner.codex.manual_in_flight;
    match answer {
        Ok(result) => {
            let received = apply_codex(inner, &result, now);
            log::info!("Codex usage refresh ({}): received [{received}]; replaced all", trigger(manual));
            inner.codex.last_success = Some(now);
            inner.codex.last_updated = Some(now);
            inner.codex.retry_at = None;
            inner.codex.error = None;
            inner.codex.failures = 0;
            Ok(())
        }
        Err(error) => {
            inner.codex.failures = inner.codex.failures.saturating_add(1);
            let shift = inner.codex.failures.saturating_sub(1).min(5);
            let backoff = (30_000_i64.saturating_mul(1_i64 << shift)).min(MAX_BACKOFF_MS);
            inner.codex.retry_at = Some(now.saturating_add(backoff));
            inner.codex.error = Some(format!("{error:#}"));
            log::warn!("Codex usage refresh ({}) failed: {error:#}; retry in {} s", trigger(manual), backoff / 1000);
            Err(error)
        }
    }
}

/// Codex answers with its whole account state, so every window is replaced.
/// Returns what arrived, for the log.
fn apply_codex(inner: &mut Inner, result: &Value, updated_at: i64) -> String {
    let windows = parse_codex_windows(result, updated_at);
    let (usage, reset_credit_id) = parse_codex_usage(result);
    let received = windows.iter().map(format_received).collect::<Vec<_>>().join("; ");
    inner.windows.retain(|(agent, _), _| agent != "codex");
    for window in windows {
        inner.windows.insert((window.agent.clone(), window.key.clone()), window);
    }
    inner.codex_usage = usage;
    inner.codex_reset_credit_id = reset_credit_id;
    received
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
    inner.claude_live = LiveState::default();
    true
}

/// Returns whether the snapshot changed: a window, the account, or the card's
/// notice that live usage is being refused.
fn ingest_attributed_claude(inner: &mut Inner, account: Option<String>, launch_account: Option<&str>, payload: &Value, now: i64) -> bool {
    let switched = select_claude_account(inner, account.clone());
    let reported = payload.get("_raccoon_usage_account").and_then(Value::as_str);
    let refusal = if account.is_none() {
        Some(LiveRefusal::Unidentified)
    } else if account.as_deref() != launch_account {
        Some(LiveRefusal::LaunchMismatch)
    } else if reported != account.as_deref() {
        Some(LiveRefusal::StatuslineMismatch)
    } else {
        None
    };
    // A frame without usage in it (before the first reply) loses nothing.
    if parse_claude(payload, now).is_empty() {
        return switched;
    }
    let before = inner.claude_live.showing().map(|refused| refused.reason);
    if let Some(reason) = refusal {
        if before != Some(reason) {
            log::info!("Claude live usage refused: {}", reason.describe());
        }
        inner.claude_live.refused = Some(LiveRefused { at: now, reason });
        return switched || before != Some(reason);
    }
    inner.claude_live.accepted_at = Some(now);
    apply_claude_live(inner, payload, now) || switched || before.is_some()
}

fn apply_claude_live(inner: &mut Inner, payload: &Value, now: i64) -> bool {
    let mut changed = false;
    for window in parse_claude(payload, now) {
        let key = (window.agent.clone(), window.key.clone());
        let current = inner.windows.get(&key);
        if let Verdict::Refuse(why) = judge(&window, current) {
            log::debug!("Claude live usage {}: kept shown ({})", format_received(&window), why.describe());
            continue;
        }
        if let Some(previous) = current {
            if same_sample(&window, previous)
                && (expired(&window, now) || now.saturating_sub(previous.updated_at) < STATUSLINE_THROTTLE_MS) {
                continue;
            }
        }
        let show = settled(window, current);
        inner.windows.insert(key, show);
        changed = true;
    }
    changed
}

fn finish_claude_refresh(inner: &mut Inner, generation: u64, answer: Result<Vec<UsageWindow>>, now: i64, completed_at: i64) -> Result<()> {
    if generation != inner.claude_generation {
        log::info!("Claude usage refresh: discarded, the Claude account changed while it was out");
        return Ok(());
    }
    let manual = trigger(inner.claude.manual_in_flight);
    inner.claude.in_flight = false;
    inner.claude.skipped = None;
    match answer {
        Ok(received) => {
            let mut shown: HashMap<String, UsageWindow> = inner.windows.values().filter(|w| w.agent == "claude").map(|w| (w.key.clone(), w.clone())).collect();
            // A shown window the reply leaves out stays as it was; say which.
            let mut omitted: Vec<_> = shown.keys().filter(|key| !received.iter().any(|w| &w.key == *key)).cloned().collect();
            omitted.sort();
            let decisions = merge_claude_windows(received, &mut shown);
            for window in shown.into_values() {
                inner.windows.insert((window.agent.clone(), window.key.clone()), window);
            }
            let omitted = if omitted.is_empty() { String::new() } else { format!("; not in the reply, kept: {}", omitted.join(", ")) };
            log::info!("Claude usage refresh ({manual}): {}{omitted}", decisions_log(&decisions));
            if decisions.iter().any(|decision| matches!(decision.verdict, Verdict::Take(_))) {
                inner.claude.last_updated = Some(now);
            }
            inner.claude.refused = decisions.iter().filter_map(|decision| match decision.verdict {
                Verdict::Refuse(reason) => Some(RefusedWindow {
                    key: decision.received.key.clone(),
                    label: decision.received.label.clone(),
                    reason,
                }),
                Verdict::Take(_) => None,
            }).collect();
            inner.claude.last_success = Some(now);
            inner.claude.retry_at = None;
            inner.claude.local_failure = false;
            inner.claude.error = None;
            inner.claude.failures = 0;
            Ok(())
        }
        Err(error) => {
            inner.claude.failures = inner.claude.failures.saturating_add(1);
            let shift = inner.claude.failures.saturating_sub(1).min(8);
            let backoff = (60_000_i64.saturating_mul(1_i64 << shift)).min(CLAUDE_MAX_BACKOFF_MS);
            let retry_at = error.downcast_ref::<claude_oauth::RetryAfter>().map(|retry| retry.0).unwrap_or(0);
            let retry_at = completed_at.saturating_add(backoff).max(retry_at);
            inner.claude.retry_at = Some(retry_at);
            inner.claude.local_failure = error.is::<claude_oauth::CredentialError>();
            inner.claude.error = Some(format!("{error:#}"));
            log::warn!("Claude usage refresh ({manual}) failed: {error:#}; retry in {} s", retry_at.saturating_sub(completed_at) / 1000);
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
                last_success_at: inner.claude.last_success,
                last_updated_at: inner.claude.last_updated,
                refused: inner.claude.refused.clone(),
                skipped: inner.claude.skipped.clone(),
                live_refused: inner.claude_live.showing().cloned(),
            },
            codex_refresh: CodexRefresh {
                retry_at: inner.codex.retry_at.filter(|at| *at > now),
                error: inner.codex.error.clone(),
                last_success_at: inner.codex.last_success,
                skipped: inner.codex.skipped.clone(),
            },
        }
    }

    /// Manual and reset-boundary refreshes bypass the ordinary poll debounce,
    /// while failures and Retry-After still gate every request. `cadence` is
    /// the automatic refresh interval, `None` when that timer is off.
    pub fn refresh_claude(&self, manual: bool, cadence: Option<i64>) -> Result<()> {
        let now = now_ms();
        let account = claude_account_identity();
        let generation = {
            let mut inner = self.inner.lock().unwrap();
            select_claude_account(&mut inner, account.clone());
            if !begin_claude_refresh(&mut inner, now, manual, cadence) { return Ok(()); }
            inner.claude_generation
        };
        let answer = account.as_ref().context("Claude account attribution is unavailable; check the system Claude login")
            .and_then(|_| claude_oauth::read_token().map_err(anyhow::Error::from))
            .and_then(|token| claude_oauth::fetch(&token, now));
        let current_account = claude_account_identity();
        let mut inner = self.inner.lock().unwrap();
        select_claude_account(&mut inner, current_account);
        finish_claude_refresh(&mut inner, generation, answer, now, now_ms())
    }

    /// Refresh through the local Codex app-server. Ordinary calls reuse the
    /// last answer for the automatic interval (fifteen minutes with the timer
    /// off); the popover's button has its own five-minute debounce. Failures
    /// back off from 30 seconds to fifteen minutes while leaving the last
    /// snapshot intact.
    pub fn refresh_codex(&self, manual: bool, cadence: Option<i64>) -> Result<()> {
        let now = now_ms();
        if !begin_codex_refresh(&mut self.inner.lock().unwrap(), now, manual, cadence) {
            return Ok(());
        }
        let answer = read_codex();
        finish_codex_refresh(&mut self.inner.lock().unwrap(), answer, now)
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
                    let received = apply_codex(&mut inner, &result, now_ms());
                    log::info!("Codex usage after a reset: received [{received}]; replaced all");
                    inner.codex.last_success = Some(now_ms());
                    inner.codex.last_updated = inner.codex.last_success;
                    inner.codex.skipped = None;
                    inner.codex.retry_at = None;
                    inner.codex.error = None;
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

    /// What is shown after merging `received` over `current`.
    fn merged(received: Vec<UsageWindow>, current: Vec<UsageWindow>) -> Vec<UsageWindow> {
        let mut shown = current.into_iter().map(|window| (window.key.clone(), window)).collect();
        merge_claude_windows(received, &mut shown);
        shown.into_values().collect()
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
        let shown = merged(oauth, current.clone());
        assert_eq!(shown, current);
        // Reverse source order: a more recently RECEIVED old live window must
        // not mask the next window from an OAuth request that started earlier.
        let merged = merged(current, parse_claude(&session_sample(100, 10), 14_000));
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
        assert!(begin_claude_refresh(&mut inner, 10_000, false, None));
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
        assert!(!begin_claude_refresh(&mut inner, 9_999, false, None));
        assert!(begin_claude_refresh(&mut inner, 10_000, false, None));
        assert!(!begin_claude_refresh(&mut inner, 10_000, true, None));
        let old = parse_claude(&session_sample(100, 10), 10_000);
        finish_claude_refresh(&mut inner, 0, Ok(old), 10_000, 11_000).unwrap();
        assert_eq!(inner.windows[&("claude".into(), "five_hour".into())].updated_at, 9_000);
        assert_eq!(claude_revalidate_at(&inner), Some(70_000));
        assert!(!begin_claude_refresh(&mut inner, 69_999, false, None));
        assert!(begin_claude_refresh(&mut inner, 70_000, false, None));
        finish_claude_refresh(&mut inner, 0, Ok(vec![]), 70_000, 71_000).unwrap();
        assert_eq!(claude_revalidate_at(&inner), None);
        assert!(!begin_claude_refresh(&mut inner, 72_000, false, None));
        assert!(begin_claude_refresh(&mut inner, 70_000 + BACKGROUND_REFRESH_MS, false, None));
    }

    #[test]
    fn manual_refresh_bypasses_polling_but_respects_retry_after() {
        let mut inner = Inner::default();
        inner.claude.last_attempt = Some(1000);
        assert!(!begin_claude_refresh(&mut inner, 2000, false, None));
        assert!(begin_claude_refresh(&mut inner, 2000, true, None));
        let error = claude_oauth::RetryAfter(180_000).into();
        assert!(finish_claude_refresh(&mut inner, 0, Err(error), 2000, 3000).is_err());
        assert_eq!(inner.claude.retry_at, Some(180_000));
        assert!(inner.claude.error.is_some());
        assert!(!begin_claude_refresh(&mut inner, 4000, true, None));
        apply_claude_live(&mut inner, &session_sample(100, 10), 9_000);
        assert_eq!(claude_revalidate_at(&inner), Some(180_000));
        assert!(!begin_claude_refresh(&mut inner, 10_000, false, None));
        assert!(begin_claude_refresh(&mut inner, 180_000, false, None));
    }

    /// #664: a credential read that failed on this machine kept the button
    /// from retrying for up to four hours. The timer still backs off; the
    /// button starts the backoff over. A provider's Retry-After holds both.
    #[test]
    fn manual_refresh_clears_a_local_credential_backoff_but_not_a_provider_one() {
        use claude_oauth::CredentialError;
        let mut inner = Inner::default();
        let cadence = Some(MINUTE);
        // Many failures in, as on the machine in the issue.
        inner.claude.failures = 9;
        assert!(begin_claude_refresh(&mut inner, 0, false, cadence));
        let timed_out = CredentialError::TimedOut(Duration::from_secs(3)).into();
        assert!(finish_claude_refresh(&mut inner, 0, Err(timed_out), 0, 3_000).is_err());
        assert_eq!(inner.claude.retry_at, Some(3_000 + CLAUDE_MAX_BACKOFF_MS));
        assert_eq!(inner.claude.error.as_deref(), Some("Claude Code keychain read timed out after 3 s"));
        assert!(!begin_claude_refresh(&mut inner, MINUTE, false, cadence));
        assert!(begin_claude_refresh(&mut inner, MINUTE, true, cadence));
        // In flight, a second press is still refused and clears nothing.
        assert!(!begin_claude_refresh(&mut inner, MINUTE, true, cadence));
        let failed = CredentialError::Failed(Some(51)).into();
        finish_claude_refresh(&mut inner, 0, Err(failed), MINUTE, MINUTE + 100).unwrap_err();
        // The ladder started over: one minute, not the four-hour ceiling.
        assert_eq!(inner.claude.retry_at, Some(2 * MINUTE + 100));
        assert_eq!(inner.claude.error.as_deref(), Some("Claude Code keychain read failed (exit 51)"));
        assert!(begin_claude_refresh(&mut inner, MINUTE + 200, true, cadence));
        let limited = claude_oauth::RetryAfter(30 * MINUTE).into();
        finish_claude_refresh(&mut inner, 0, Err(limited), MINUTE + 200, MINUTE + 300).unwrap_err();
        assert!(!begin_claude_refresh(&mut inner, 2 * MINUTE, true, cadence));
        assert!(begin_claude_refresh(&mut inner, 30 * MINUTE, true, cadence));
        // A request that reached the provider and failed holds the button too.
        finish_claude_refresh(&mut inner, 0, Err(anyhow::anyhow!("Claude OAuth usage request failed with HTTP 500")), 30 * MINUTE, 30 * MINUTE).unwrap_err();
        assert!(!begin_claude_refresh(&mut inner, 30 * MINUTE + 1, true, cadence));
    }

    const MINUTE: i64 = 60_000;

    fn codex_sample(used: u32) -> Value {
        json!({"rateLimits": {"primary": {"usedPercent": used, "windowDurationMins": 300, "resetsAt": 1_788_757_220}}})
    }

    /// The frontend timer re-arms when a refresh settles, so its next tick
    /// lands one interval after that; the provider request it asks for must
    /// then be allowed, not swallowed by a longer backend throttle.
    #[test]
    fn a_provider_refresh_is_eligible_at_the_configured_cadence() {
        for (cadence, interval) in [(Some(MINUTE), MINUTE), (Some(2 * MINUTE), 2 * MINUTE), (Some(5 * MINUTE), 5 * MINUTE), (Some(15 * MINUTE), 15 * MINUTE), (None, BACKGROUND_REFRESH_MS)] {
            let mut inner = Inner::default();
            let mut now = 1_000;
            for _ in 0..3 {
                assert!(begin_claude_refresh(&mut inner, now, false, cadence), "Claude at {cadence:?}");
                assert!(begin_codex_refresh(&mut inner, now, false, cadence), "Codex at {cadence:?}");
                let settled = now + 400;
                finish_claude_refresh(&mut inner, 0, Ok(vec![]), now, settled).unwrap();
                finish_codex_refresh(&mut inner, Ok(codex_sample(10)), now).unwrap();
                // Focus or a second window asking again mid-interval reuses the answer.
                assert!(!begin_claude_refresh(&mut inner, settled + interval / 2, false, cadence));
                assert!(!begin_codex_refresh(&mut inner, settled + interval / 2, false, cadence));
                now = settled + interval;
            }
        }
        // The default minute is a real fetch, where the timer-off floor still declines.
        let mut inner = Inner::default();
        assert!(begin_claude_refresh(&mut inner, 0, false, Some(MINUTE)));
        finish_claude_refresh(&mut inner, 0, Ok(vec![]), 0, 0).unwrap();
        assert!(!begin_claude_refresh(&mut inner, MINUTE, false, None));
        assert!(begin_claude_refresh(&mut inner, MINUTE, false, Some(MINUTE)));
    }

    #[test]
    fn a_slow_request_is_never_overlapped_and_the_next_tick_follows_it() {
        let mut inner = Inner::default();
        assert!(begin_claude_refresh(&mut inner, 0, false, Some(MINUTE)));
        assert!(begin_codex_refresh(&mut inner, 0, false, Some(MINUTE)));
        for (at, manual) in [(MINUTE, false), (3 * MINUTE, false), (3 * MINUTE, true)] {
            assert!(!begin_claude_refresh(&mut inner, at, manual, Some(MINUTE)));
            assert!(!begin_codex_refresh(&mut inner, at, manual, Some(MINUTE)));
        }
        finish_claude_refresh(&mut inner, 0, Ok(vec![]), 0, 4 * MINUTE).unwrap();
        finish_codex_refresh(&mut inner, Ok(codex_sample(10)), 0).unwrap();
        assert!(begin_claude_refresh(&mut inner, 4 * MINUTE, false, Some(MINUTE)));
        assert!(begin_codex_refresh(&mut inner, 4 * MINUTE, false, Some(MINUTE)));
    }

    #[test]
    fn backoff_outranks_the_interval_and_a_failure_keeps_the_last_known_usage() {
        let store = UsageStore::default();
        let cadence = Some(MINUTE);
        store.ingest_claude_at(&session_sample(40, 9_000), 1_000);
        {
            let mut inner = store.inner.lock().unwrap();
            assert!(begin_claude_refresh(&mut inner, 1_000, false, cadence));
            finish_claude_refresh(&mut inner, 0, Ok(parse_claude(&session_sample(41, 9_000), 1_000)), 1_000, 1_200).unwrap();
            // First failure: one minute. The tick that lands inside it is refused,
            // manual included; the first tick after expiry goes out.
            assert!(begin_claude_refresh(&mut inner, MINUTE + 1_200, false, cadence));
            assert!(finish_claude_refresh(&mut inner, 0, Err(anyhow::anyhow!("offline")), MINUTE + 1_200, MINUTE + 2_000).is_err());
            assert_eq!(inner.claude.retry_at, Some(2 * MINUTE + 2_000));
            assert!(!begin_claude_refresh(&mut inner, 2 * MINUTE + 1_999, false, cadence));
            assert!(!begin_claude_refresh(&mut inner, 2 * MINUTE + 1_999, true, cadence));
        }
        let failed = store.snapshot_at(&HashSet::new(), MINUTE + 3_000);
        assert_eq!(failed.windows[0].used_percent, 41.0);
        assert_eq!(failed.claude.last_success_at, Some(1_000));
        assert_eq!(failed.claude.retry_at, Some(2 * MINUTE + 2_000));
        assert!(failed.claude.error.as_deref().is_some_and(|error| error.contains("offline")));
        {
            let mut inner = store.inner.lock().unwrap();
            assert!(begin_claude_refresh(&mut inner, 2 * MINUTE + 2_000, false, cadence));
            // A second failure doubles the pause; a provider Retry-After extends it further.
            let limited = claude_oauth::RetryAfter(20 * MINUTE).into();
            assert!(finish_claude_refresh(&mut inner, 0, Err(limited), 2 * MINUTE + 2_000, 2 * MINUTE + 3_000).is_err());
            for tick in 3..20 {
                assert!(!begin_claude_refresh(&mut inner, tick * MINUTE, false, cadence));
            }
            assert!(begin_claude_refresh(&mut inner, 20 * MINUTE, false, cadence));
            finish_claude_refresh(&mut inner, 0, Ok(parse_claude(&session_sample(55, 9_000), 20 * MINUTE)), 20 * MINUTE, 20 * MINUTE + 300).unwrap();
        }
        let recovered = store.snapshot_at(&HashSet::new(), 20 * MINUTE + 300);
        assert_eq!(recovered.windows[0].used_percent, 55.0);
        assert_eq!(recovered.claude.last_success_at, Some(20 * MINUTE));
        assert_eq!((recovered.claude.retry_at, recovered.claude.error), (None, None));
        // Recovered, so the ordinary cadence resumes.
        let mut inner = store.inner.lock().unwrap();
        assert!(begin_claude_refresh(&mut inner, 21 * MINUTE + 300, false, cadence));
    }

    #[test]
    fn codex_failures_back_off_keep_the_snapshot_and_recover() {
        let store = UsageStore::default();
        let cadence = Some(MINUTE);
        let running = HashSet::from(["codex".to_string()]);
        {
            let mut inner = store.inner.lock().unwrap();
            assert!(begin_codex_refresh(&mut inner, 0, false, cadence));
            finish_codex_refresh(&mut inner, Ok(codex_sample(17)), 0).unwrap();
            assert!(begin_codex_refresh(&mut inner, MINUTE, false, cadence));
            assert!(finish_codex_refresh(&mut inner, Err(anyhow::anyhow!("codex is not signed in")), MINUTE).is_err());
            // Thirty seconds, then a minute: the second pause swallows a tick.
            assert!(!begin_codex_refresh(&mut inner, MINUTE + 29_999, true, cadence));
            assert!(begin_codex_refresh(&mut inner, 2 * MINUTE, false, cadence));
            assert!(finish_codex_refresh(&mut inner, Err(anyhow::anyhow!("codex is not signed in")), 2 * MINUTE).is_err());
            assert!(!begin_codex_refresh(&mut inner, 3 * MINUTE - 1, false, cadence));
        }
        let failed = store.snapshot_at(&running, 2 * MINUTE + 1);
        assert_eq!(failed.windows[0].used_percent, 17.0);
        assert_eq!(failed.codex_refresh.last_success_at, Some(0));
        assert_eq!(failed.codex_refresh.retry_at, Some(3 * MINUTE));
        assert!(failed.codex_refresh.error.as_deref().is_some_and(|error| error.contains("not signed in")));
        {
            let mut inner = store.inner.lock().unwrap();
            assert!(begin_codex_refresh(&mut inner, 3 * MINUTE, false, cadence));
            finish_codex_refresh(&mut inner, Ok(codex_sample(19)), 3 * MINUTE).unwrap();
        }
        let recovered = store.snapshot_at(&running, 3 * MINUTE);
        assert_eq!(recovered.windows[0].used_percent, 19.0);
        assert_eq!(recovered.codex_refresh, CodexRefresh { retry_at: None, error: None, last_success_at: Some(3 * MINUTE), skipped: None });
    }

    #[test]
    fn the_codex_button_keeps_its_debounce_but_never_waits_longer_than_the_timer() {
        let mut inner = Inner::default();
        assert!(begin_codex_refresh(&mut inner, 0, true, None));
        finish_codex_refresh(&mut inner, Ok(codex_sample(10)), 0).unwrap();
        // Timer off: a second press inside five minutes is still debounced.
        assert!(!begin_codex_refresh(&mut inner, 2 * MINUTE, true, None));
        // Timer on: by then a tick would fetch, so the button does too.
        assert!(!begin_codex_refresh(&mut inner, 30_000, true, Some(MINUTE)));
        assert!(begin_codex_refresh(&mut inner, 2 * MINUTE, true, Some(MINUTE)));
        finish_codex_refresh(&mut inner, Ok(codex_sample(10)), 2 * MINUTE).unwrap();
        // A press bypasses the timer's floor once its own debounce has passed.
        assert!(begin_codex_refresh(&mut inner, 7 * MINUTE + 1, true, None));
        finish_codex_refresh(&mut inner, Ok(codex_sample(10)), 7 * MINUTE + 1).unwrap();
        // A redemption in progress is not read over.
        inner.codex_reset_in_flight = true;
        assert!(!begin_codex_refresh(&mut inner, 30 * MINUTE, false, Some(MINUTE)));
    }

    #[test]
    fn a_new_account_starts_its_own_cadence_and_freshness() {
        let store = UsageStore::default();
        {
            let mut inner = store.inner.lock().unwrap();
            select_claude_account(&mut inner, Some("account-a".into()));
            assert!(begin_claude_refresh(&mut inner, 0, false, Some(MINUTE)));
            let generation = inner.claude_generation;
            finish_claude_refresh(&mut inner, generation, Err(anyhow::anyhow!("offline")), 0, 100).unwrap_err();
            select_claude_account(&mut inner, Some("account-b".into()));
            // Neither A's backoff nor A's recent attempt holds B's first read.
            assert!(begin_claude_refresh(&mut inner, 200, false, Some(MINUTE)));
        }
        let snapshot = store.snapshot_at(&HashSet::new(), 300);
        assert_eq!(snapshot.claude, ClaudeRefresh::default());
    }

    #[test]
    fn account_switch_rejects_old_tabs_unknown_identity_and_inflight_responses() {
        let mut inner = Inner::default();
        let mut a = session_sample(100, 100);
        a["_raccoon_usage_account"] = json!("account-a");
        ingest_attributed_claude(&mut inner, Some("account-a".into()), Some("account-a"), &a, 1000);
        assert_eq!(inner.windows.len(), 1);
        let generation = inner.claude_generation;
        assert!(begin_claude_refresh(&mut inner, 1000, false, None));
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
        // A's sample through B's tab changes no window; it only raises the
        // card's notice that live usage is being refused (#729), once.
        assert!(ingest_attributed_claude(&mut inner, Some("account-b".into()), Some("account-b"), &a, 5000));
        assert!(!ingest_attributed_claude(&mut inner, Some("account-b".into()), Some("account-b"), &a, 5500));
        assert_eq!(inner.windows[&("claude".into(), "five_hour".into())].used_percent, 12.0);
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

        let merged = merged(oauth, statusline);
        assert_eq!(merged.len(), 4);
        let five_hour = merged.iter().find(|window| window.key == "five_hour").unwrap();
        assert_eq!(five_hour.used_percent, 23.0);
        assert_eq!(five_hour.updated_at, 200);
        assert_eq!(merged.iter().find(|window| window.key == "seven_day").unwrap().used_percent, 44.0);
        assert_eq!(merged.iter().find(|window| window.key == "fable_weekly").unwrap().used_percent, 82.0);
        assert_eq!(merged.iter().find(|window| window.key == "model_scoped_sonnet_4_5").unwrap().label, "Sonnet 4.5");
    }

    const HOUR: i64 = 60 * MINUTE;
    const DAY: i64 = 24 * HOUR;
    /// A seven-day deadline in whole epoch seconds, as the status line sends it.
    const WEEK_RESET: i64 = 1_788_757_220;
    /// Three days into that week, when the status line reported it.
    const WEEK_SEEN: i64 = WEEK_RESET * 1000 - 3 * DAY;

    fn shown(inner: &Inner, key: &str) -> UsageWindow {
        inner.windows[&("claude".to_string(), key.to_string())].clone()
    }

    fn week_sample(used: u32, reset: i64) -> Value {
        json!({"rate_limits": {"seven_day": {"used_percentage": used, "resets_at": reset}}})
    }

    /// The 7d window at 24% until `WEEK_RESET`, from a status line at `WEEK_SEEN`.
    fn week_shown() -> Inner {
        let mut inner = Inner::default();
        assert!(apply_claude_live(&mut inner, &week_sample(24, WEEK_RESET), WEEK_SEEN));
        inner
    }

    fn week_reply(resets_at: &str, at: i64) -> Vec<UsageWindow> {
        claude_oauth::parse_response(&json!({"seven_day": {"utilization": 30.0, "resets_at": resets_at}}), at)
    }

    /// #729: the endpoint's fractional deadline for the window the status line
    /// reported in whole seconds, half a second earlier, read as the previous
    /// window and was dropped on every refresh until that window reset.
    #[test]
    fn an_endpoint_reply_half_a_second_earlier_replaces_the_status_line_window() {
        let mut inner = Inner::default();
        apply_claude_live(&mut inner, &json!({"rate_limits": {"seven_day": {"used_percentage": 24, "resets_at": WEEK_RESET}}}), 1_000);
        let now = 24 * HOUR;
        assert!(begin_claude_refresh(&mut inner, now, true, None));
        let reply = claude_oauth::parse_response(&json!({"seven_day": {"utilization": 31.0, "resets_at": "2026-09-07T05:00:19.500000+00:00"}}), now);
        finish_claude_refresh(&mut inner, 0, Ok(reply), now, now + 300).unwrap();
        let week = shown(&inner, "seven_day");
        assert_eq!((week.used_percent, week.resets_at, week.updated_at), (31.0, Some(WEEK_RESET * 1000 - 500), now));
        assert_eq!(week.source, "oauth");
        assert_eq!((inner.claude.last_updated, inner.claude.refused.clone()), (Some(now), vec![]));

        // The other way round: the next turn's whole seconds now sit 0.5 s
        // before the endpoint's deadline. Live updates were dropped the same way.
        assert!(apply_claude_live(&mut inner, &json!({"rate_limits": {"seven_day": {"used_percentage": 33, "resets_at": WEEK_RESET - 1}}}), now + MINUTE));
        let week = shown(&inner, "seven_day");
        assert_eq!((week.used_percent, week.updated_at), (33.0, now + MINUTE));
        // Hours apart is still another window: an idle tab's old sample loses.
        assert!(!apply_claude_live(&mut inner, &json!({"rate_limits": {"seven_day": {"used_percentage": 90, "resets_at": WEEK_RESET - 7 * 24 * 3600}}}), now + 2 * MINUTE));
        assert_eq!(shown(&inner, "seven_day").used_percent, 33.0);
    }

    /// #729: a 5-hour window not yet started has no deadline. It replaces the
    /// expired one, as 0% with no countdown, instead of "awaiting update".
    #[test]
    fn a_window_not_yet_started_replaces_an_expired_one() {
        for reply in [
            json!({"five_hour": {"utilization": 0.0, "resets_at": null}, "seven_day": {"utilization": 24.0, "resets_at": WEEK_RESET}}),
            json!({"five_hour": null, "seven_day": {"utilization": 24.0, "resets_at": WEEK_RESET}}),
        ] {
            let store = UsageStore::default();
            store.ingest_claude_at(&session_sample(1, 10), 9_000);
            let now = 19 * HOUR;
            let mut inner = store.inner.lock().unwrap();
            assert!(begin_claude_refresh(&mut inner, now, true, None));
            finish_claude_refresh(&mut inner, 0, Ok(claude_oauth::parse_response(&reply, now)), now, now + 300).unwrap();
            drop(inner);
            let snapshot = store.snapshot_at(&HashSet::new(), now + 300);
            let session = snapshot.windows.iter().find(|window| window.key == "five_hour").unwrap();
            assert_eq!((session.used_percent, session.resets_at, session.updated_at, session.stale), (0.0, None, now, false), "{reply}");
            assert_eq!(snapshot.claude.revalidate_at, Some(WEEK_RESET * 1000), "only the weekly deadline is left to revalidate");
            // A tab still repeating the expired window does not bring it back.
            assert!(!store.ingest_claude_at(&session_sample(1, 10), now + MINUTE));
            assert_eq!(store.snapshot_at(&HashSet::new(), now + MINUTE).windows.iter().find(|w| w.key == "five_hour").unwrap().used_percent, 0.0);
        }
    }

    /// #729: the endpoint answering with the expired window itself: its
    /// deadline had passed before the request, so none of it still counts.
    #[test]
    fn an_endpoint_reply_with_a_window_already_over_shows_it_not_started() {
        let mut inner = Inner::default();
        apply_claude_live(&mut inner, &session_sample(1, 10), 9_000);
        let now = 19 * HOUR;
        assert!(begin_claude_refresh(&mut inner, now, false, None));
        let reply = claude_oauth::parse_response(&json!({"five_hour": {"utilization": 1.0, "resets_at": 10}}), now);
        finish_claude_refresh(&mut inner, 0, Ok(reply), now, now + 300).unwrap();
        let session = shown(&inner, "five_hour");
        assert_eq!((session.used_percent, session.resets_at, session.updated_at), (0.0, None, now));
        // Within the tolerance of its deadline the window may not have rolled
        // yet: seeing it again is still not confirmation, so the follow-up runs.
        let mut inner = Inner::default();
        apply_claude_live(&mut inner, &session_sample(100, 10), 9_000);
        assert!(begin_claude_refresh(&mut inner, 10_000, false, None));
        let reply = claude_oauth::parse_response(&json!({"five_hour": {"utilization": 100.0, "resets_at": 10}}), 10_000);
        finish_claude_refresh(&mut inner, 0, Ok(reply), 10_000, 10_300).unwrap();
        assert_eq!((shown(&inner, "five_hour").used_percent, shown(&inner, "five_hour").updated_at), (100.0, 9_000));
        assert_eq!(claude_revalidate_at(&inner), Some(70_000));
    }

    /// #737: the endpoint's 7d deadline was two hours before the shown one and
    /// still ahead when the request started. No later window had started then,
    /// so the shown one was wrong, yet the reply was refused as the previous
    /// window until the shown deadline passed.
    #[test]
    fn an_endpoint_window_still_running_when_asked_replaces_a_later_shown_one() {
        const RUNNING: &str = "2026-09-07T03:00:20.373000+00:00";
        let running = WEEK_RESET * 1000 - 2 * HOUR + 373;
        let mut inner = week_shown();
        let now = WEEK_SEEN + HOUR;
        assert!(begin_claude_refresh(&mut inner, now, true, None));
        let reply = week_reply(RUNNING, now);
        assert_eq!(judge(&reply[0], Some(&shown(&inner, "seven_day"))), Verdict::Take(Taken::Running));
        finish_claude_refresh(&mut inner, 0, Ok(reply), now, now + 300).unwrap();
        let week = shown(&inner, "seven_day");
        assert_eq!((week.used_percent, week.resets_at, week.updated_at, week.source.as_str()), (30.0, Some(running), now, "oauth"));
        assert_eq!((inner.claude.last_updated, inner.claude.refused.clone()), (Some(now), vec![]));
        assert_eq!(claude_revalidate_at(&inner), Some(running), "the reply's deadline is the one checked next");

        // The reply must be the later observation. A sample that arrived while
        // the request was out is newer, and the next request settles it.
        let mut inner = week_shown();
        assert!(begin_claude_refresh(&mut inner, now, true, None));
        assert!(apply_claude_live(&mut inner, &week_sample(25, WEEK_RESET), now + 100));
        finish_claude_refresh(&mut inner, 0, Ok(week_reply(RUNNING, now)), now, now + 300).unwrap();
        assert_eq!((shown(&inner, "seven_day").used_percent, inner.claude.last_updated), (25.0, None));
        assert_eq!(inner.claude.refused, vec![RefusedWindow { key: "seven_day".into(), label: "7d".into(), reason: Refusal::OlderObservation }]);
        let next = now + MINUTE;
        assert!(begin_claude_refresh(&mut inner, next, true, None));
        finish_claude_refresh(&mut inner, 0, Ok(week_reply(RUNNING, next)), next, next + 300).unwrap();
        assert_eq!((shown(&inner, "seven_day").used_percent, shown(&inner, "seven_day").resets_at), (30.0, Some(running)));
    }

    /// #737: the same earlier window from a status line is still the previous
    /// one. Its time is when it arrived, and an idle tab repeats old samples.
    #[test]
    fn the_same_earlier_window_from_a_status_line_is_still_refused() {
        let mut inner = week_shown();
        let now = WEEK_SEEN + HOUR;
        let sample = week_sample(30, WEEK_RESET - 2 * 3600);
        let received = parse_claude(&sample, now);
        assert_eq!(judge(&received[0], Some(&shown(&inner, "seven_day"))), Verdict::Refuse(Refusal::EarlierWindow));
        assert!(!apply_claude_live(&mut inner, &sample, now));
        let week = shown(&inner, "seven_day");
        assert_eq!((week.used_percent, week.resets_at, week.updated_at), (24.0, Some(WEEK_RESET * 1000), WEEK_SEEN));
    }

    /// #737: an endpoint window whose deadline had passed when the request
    /// started is over. The later shown window is the next one and stays.
    #[test]
    fn an_endpoint_window_over_before_the_request_does_not_replace_a_later_one() {
        let now = WEEK_SEEN + HOUR;
        let at_request = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now).unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Micros, false);
        // Last week's window, and one whose deadline is the request's start.
        for over in ["2026-08-31T05:00:20.000000+00:00", at_request.as_str()] {
            let mut inner = week_shown();
            assert!(begin_claude_refresh(&mut inner, now, true, None));
            finish_claude_refresh(&mut inner, 0, Ok(week_reply(over, now)), now, now + 300).unwrap();
            let week = shown(&inner, "seven_day");
            assert_eq!((week.used_percent, week.resets_at, week.source.as_str()), (24.0, Some(WEEK_RESET * 1000), "statusline"), "{over}");
            assert_eq!(inner.claude.refused, vec![RefusedWindow { key: "seven_day".into(), label: "7d".into(), reason: Refusal::EarlierWindow }], "{over}");
            assert_eq!(inner.claude.last_updated, None, "{over}");
        }
    }

    /// #729: "Last refreshed just now" came from an answer that replaced
    /// nothing. Such an answer leaves `lastUpdatedAt` alone and says why.
    #[test]
    fn a_refresh_that_replaces_nothing_says_so_and_why() {
        let store = UsageStore::default();
        let mut inner = store.inner.lock().unwrap();
        let start = WEEK_SEEN;
        apply_claude_live(&mut inner, &week_sample(24, WEEK_RESET), start);
        assert!(begin_claude_refresh(&mut inner, start, false, None));
        finish_claude_refresh(&mut inner, 0, Ok(parse_claude(&week_sample(24, WEEK_RESET), start + 1)), start + 1, start + 300).unwrap();
        assert_eq!(inner.claude.last_updated, Some(start + 1));
        let now = start + HOUR;
        assert!(begin_claude_refresh(&mut inner, now, true, None));
        // A turn lands while the request is out, and the reply's 7d window is
        // last week's, over before the request started (#737).
        apply_claude_live(&mut inner, &session_sample(5, WEEK_RESET), now + 100);
        let reply = claude_oauth::parse_response(&json!({
            "five_hour": {"utilization": 4.0, "resets_at": "2026-09-07T05:00:20.373000+00:00"},
            "seven_day": {"utilization": 30.0, "resets_at": "2026-08-31T05:00:20.000000+00:00"}
        }), now);
        finish_claude_refresh(&mut inner, 0, Ok(reply), now, now + 300).unwrap();
        drop(inner);
        let snapshot = store.snapshot_at(&HashSet::new(), now + 300);
        assert_eq!(snapshot.claude.last_success_at, Some(now));
        assert_eq!(snapshot.claude.last_updated_at, Some(start + 1));
        let mut refused = snapshot.claude.refused.clone();
        refused.sort_by(|a, b| a.key.cmp(&b.key));
        assert_eq!(refused, vec![
            RefusedWindow { key: "five_hour".into(), label: "5h".into(), reason: Refusal::OlderObservation },
            RefusedWindow { key: "seven_day".into(), label: "7d".into(), reason: Refusal::EarlierWindow },
        ]);
        let value = serde_json::to_value(&snapshot.claude).unwrap();
        let mut reasons: Vec<_> = value["refused"].as_array().unwrap().iter().map(|refused| refused["reason"].clone()).collect();
        reasons.sort_by_key(|reason| reason.to_string());
        assert_eq!(reasons, vec![json!("earlierWindow"), json!("olderObservation")]);
        assert_eq!(value["lastUpdatedAt"], json!(start + 1));
    }

    /// #729: live usage turned away for an account mismatch went stale
    /// silently. The snapshot carries the refusal until a sample is used.
    #[test]
    fn live_usage_refused_for_an_account_mismatch_is_reported_until_one_is_used() {
        let store = UsageStore::default();
        let sample = |used: u32, account: &str| {
            let mut payload = session_sample(used, 100);
            payload["_raccoon_usage_account"] = json!(account);
            payload
        };
        let refused = |at: i64| store.snapshot_at(&HashSet::new(), at).claude.live_refused;
        {
            let mut inner = store.inner.lock().unwrap();
            assert!(ingest_attributed_claude(&mut inner, Some("account-a".into()), Some("account-a"), &sample(10, "account-a"), 1_000));
        }
        assert_eq!(refused(1_000), None);
        {
            // Claude Code signed in again: the tabs still carry their launch identity.
            let mut inner = store.inner.lock().unwrap();
            assert!(ingest_attributed_claude(&mut inner, Some("account-b".into()), Some("account-a"), &sample(20, "account-b"), 2_000));
            assert!(!ingest_attributed_claude(&mut inner, Some("account-b".into()), Some("account-a"), &sample(21, "account-b"), 3_000));
        }
        assert_eq!(refused(3_000), Some(LiveRefused { at: 3_000, reason: LiveRefusal::LaunchMismatch }));
        assert_eq!(serde_json::to_value(refused(3_000)).unwrap(), json!({"at": 3_000, "reason": "launchMismatch"}));
        {
            // A frame with no usage in it turns nothing away.
            let mut inner = store.inner.lock().unwrap();
            assert!(!ingest_attributed_claude(&mut inner, Some("account-b".into()), Some("account-a"), &json!({"_raccoon_usage_account": "account-b"}), 3_500));
            assert_eq!(inner.claude_live.refused.as_ref().map(|r| r.at), Some(3_000));
            // A tab started under B is used, and the notice goes.
            assert!(ingest_attributed_claude(&mut inner, Some("account-b".into()), Some("account-b"), &sample(22, "account-b"), 4_000));
        }
        assert_eq!(refused(4_000), None);
        {
            let mut inner = store.inner.lock().unwrap();
            assert!(ingest_attributed_claude(&mut inner, Some("account-b".into()), Some("account-b"), &sample(23, "account-a"), 5_000));
        }
        assert_eq!(refused(5_000).map(|r| r.reason), Some(LiveRefusal::StatuslineMismatch));
    }

    /// #729: within its debounce the Codex button did nothing visible. The
    /// press is now recorded with when it can fetch again.
    #[test]
    fn a_debounced_codex_press_says_when_it_can_fetch_again() {
        let store = UsageStore::default();
        let running = HashSet::from(["codex".to_string()]);
        {
            let mut inner = store.inner.lock().unwrap();
            assert!(begin_codex_refresh(&mut inner, 0, true, None));
            finish_codex_refresh(&mut inner, Ok(codex_sample(98)), 0).unwrap();
            assert!(!begin_codex_refresh(&mut inner, 2 * MINUTE, true, None));
        }
        let snapshot = store.snapshot_at(&running, 2 * MINUTE);
        assert_eq!(snapshot.codex_refresh.last_success_at, Some(0));
        assert_eq!(snapshot.codex_refresh.skipped, Some(RefreshSkip { at: 2 * MINUTE, reason: SkipReason::Recent, next_at: Some(5 * MINUTE) }));
        assert_eq!(serde_json::to_value(&snapshot.codex_refresh.skipped).unwrap()["reason"], json!("recent"));
        {
            let mut inner = store.inner.lock().unwrap();
            // The timer's own skips are routine and replace nothing.
            assert!(!begin_codex_refresh(&mut inner, 3 * MINUTE, false, None));
            assert_eq!(inner.codex.skipped.as_ref().map(|skip| skip.at), Some(2 * MINUTE));
            // Once the debounce passes, the press fetches and the note goes.
            assert!(begin_codex_refresh(&mut inner, 5 * MINUTE, true, None));
            assert_eq!(inner.codex.skipped, None);
            // A press while that request is out says so, until it lands.
            assert!(!begin_codex_refresh(&mut inner, 5 * MINUTE + 1, true, None));
            assert_eq!(inner.codex.skipped.as_ref().map(|skip| skip.reason), Some(SkipReason::InFlight));
            finish_codex_refresh(&mut inner, Ok(codex_sample(99)), 5 * MINUTE).unwrap();
            assert_eq!(inner.codex.skipped, None);
            // Claude's button is held only by a request out or a retry pause.
            assert!(begin_claude_refresh(&mut inner, 0, true, None));
            assert!(!begin_claude_refresh(&mut inner, 1, true, None));
            assert_eq!(inner.claude.skipped.as_ref().map(|skip| skip.reason), Some(SkipReason::InFlight));
        }
    }

    /// #729: every refresh is logged with what arrived, what became of each
    /// window and the result.
    #[test]
    fn the_refresh_log_names_each_window_its_fate_and_the_result() {
        let mut shown = HashMap::new();
        let first = merge_claude_windows(parse_claude(&json!({"rate_limits": {
            "seven_day": {"used_percentage": 24, "resets_at": WEEK_RESET}
        }}), 2_000), &mut shown);
        assert_eq!(decisions_log(&first), "received [seven_day 24% 2026-09-07T05:00:20.000Z: replaced (first window under this key)]; updated 1 of 1");
        let reply = claude_oauth::parse_response(&json!({
            "five_hour": null,
            "seven_day": {"utilization": 24.5, "resets_at": "2026-09-07T05:00:19.500000+00:00"}
        }), 1_000);
        let line = decisions_log(&merge_claude_windows(reply, &mut shown));
        assert!(line.contains("seven_day 24.5% 2026-09-07T05:00:19.500Z: kept shown (not newer than the shown window)"), "{line}");
        assert!(line.contains("five_hour 0% no reset: replaced (first window under this key)"), "{line}");
        assert!(line.ends_with("; updated 1 of 2"), "{line}");
        let line = decisions_log(&merge_claude_windows(parse_claude(&json!({"rate_limits": {"seven_day": {"used_percentage": 50}}}), 3_000), &mut shown));
        assert_eq!(line, "received [seven_day 50% no reset: kept shown (no reset time while the shown window runs)]; no newer usage");
    }

    /// The desktop app reads snapshots from a background runtime that may
    /// predate #729. Its every answer counted as an update; a current
    /// runtime's `null` means none has.
    #[test]
    fn a_snapshot_from_a_runtime_before_729_keeps_its_last_answer_as_the_update() {
        let old = json!({
            "revision": 3, "claudeAccount": "a", "windows": [],
            "claude": {"retryAt": null, "revalidateAt": null, "error": null, "lastSuccessAt": 5_000},
            "codexRefresh": {"retryAt": null, "error": null, "lastSuccessAt": 4_000}
        });
        let snapshot = UsageSnapshot::from_runtime(old).unwrap();
        assert_eq!((snapshot.claude.last_updated_at, snapshot.claude.refused.len(), snapshot.codex_refresh.skipped), (Some(5_000), 0, None));
        let mut current = serde_json::to_value(UsageSnapshot { claude: ClaudeRefresh { last_success_at: Some(5_000), ..Default::default() }, ..Default::default() }).unwrap();
        assert_eq!(current["claude"]["lastUpdatedAt"], Value::Null);
        assert_eq!(UsageSnapshot::from_runtime(current.clone()).unwrap().claude.last_updated_at, None);
        current["claude"]["lastUpdatedAt"] = json!(4_000);
        assert_eq!(UsageSnapshot::from_runtime(current).unwrap().claude.last_updated_at, Some(4_000));
    }
}
