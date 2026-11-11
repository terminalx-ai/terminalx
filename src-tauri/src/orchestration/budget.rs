//! What a run may use, and what it has used (PRO-280).
//!
//! A run's budget has two forms, by how each worker's agent is signed in:
//!
//! - **API key**: dollars, the sum of the recorded cost of its workers on a
//!   key (`session_usage`, PRO-273).
//! - **Subscription**: nothing is billed per token, so the budget is a share
//!   of the plan's usage windows (`status::usage`). Two limits: the run's own
//!   points of a window (how far the window moved while the run was active),
//!   and a level no window it draws on may pass, whoever filled it.
//!
//! A run with workers on both keeps both and stops on whichever is reached
//! first. Everything here is arithmetic over what TerminalX already reads:
//! no model is asked, nothing is fetched.
//!
//! A run's own points are an estimate. The window is shared with everything
//! else the person runs, so the change while the run was active counts every
//! session's use, not only the run's; the UI says so.

use serde::{Deserialize, Serialize};

use super::{Piece, Run};
use crate::status::usage::UsageWindow;
use crate::store::settings::OrchestratorLimits;

/// How a worker's agent was signed in when it started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Login {
    /// A key saved in Settings → Agents: billed per token.
    ApiKey,
    /// The agent's own account login: limited by usage windows.
    Subscription,
}

/// What holds a run back. Taken from the project's settings when the run is
/// made, with the lead's budget where it asked for less; a person can change
/// them for this run while approving it, or when it stops to ask.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunLimits {
    /// Workers of this run in a turn at once.
    pub workers: u32,
    /// Dollars its workers on an API key may spend.
    pub dollars: f64,
    /// Points of one usage window the run itself may use.
    pub points: f64,
    /// No new piece starts once a window it draws on is this full.
    pub ceiling: f64,
}

impl Default for RunLimits {
    /// A run stored before PRO-280 holds to the defaults.
    fn default() -> Self {
        use crate::store::settings::{DEFAULT_BUDGET_DOLLARS, DEFAULT_BUDGET_POINTS, DEFAULT_WINDOW_CEILING, DEFAULT_WORKERS_PER_RUN};
        Self { workers: DEFAULT_WORKERS_PER_RUN, dollars: DEFAULT_BUDGET_DOLLARS, points: DEFAULT_BUDGET_POINTS, ceiling: DEFAULT_WINDOW_CEILING }
    }
}

impl RunLimits {
    /// The project's limits, with the lead's budget where it is lower. A lead
    /// may ask for less than the person allows, never more.
    pub fn new(settings: &OrchestratorLimits, asked: &super::Budget) -> Self {
        let lower = |asked: Option<f64>, allowed: f64| asked.filter(|value| value.is_finite() && *value > 0.0).map_or(allowed, |value| value.min(allowed));
        Self { workers: settings.workers_per_run, dollars: lower(asked.dollars, settings.budget_dollars), points: lower(asked.points, settings.budget_points), ceiling: settings.window_ceiling }
    }

    /// Whether every value is one the settings would take.
    pub fn valid(&self) -> Result<(), String> {
        use crate::store::settings::{valid_dollars, valid_percent, valid_workers, MAX_BUDGET_DOLLARS, MAX_WORKERS};
        if !valid_workers(self.workers) {
            return Err(format!("A run may have from 1 to {MAX_WORKERS} workers at once, not {}.", self.workers));
        }
        if !valid_dollars(self.dollars) {
            return Err(format!("A dollar budget is more than $0 and at most ${MAX_BUDGET_DOLLARS:.0}."));
        }
        if !valid_percent(self.points) {
            return Err("A points budget is more than 0 and at most 100 points of a window.".into());
        }
        if !valid_percent(self.ceiling) {
            return Err("A window level is more than 0% and at most 100%.".into());
        }
        Ok(())
    }
}

/// One usage window a run draws on, as the run has seen it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowUse {
    pub agent: String,
    pub key: String,
    /// As the status bar names it: `5h`, `7d`, `7d Opus`.
    pub label: String,
    /// How full the window is now, whoever filled it.
    pub percent: f64,
    /// How full it was when the run's first worker started in it; absent
    /// before then. A window that reset since starts again from 0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<f64>,
    /// When the window resets, in milliseconds since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<i64>,
    /// The run's own share: how far the window moved while it was active.
    #[serde(default)]
    pub points: f64,
}

/// What a run has used so far, as read at its last refresh.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunUsage {
    /// What its workers on an API key have spent.
    #[serde(default)]
    pub dollars: f64,
    /// It has, or will have, workers on an API key: the dollar budget holds.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub api_key: bool,
    /// It has, or will have, workers on a subscription: the window budget holds.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub subscription: bool,
    /// The windows its subscription workers draw on.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub windows: Vec<WindowUse>,
}

/// Which limit stopped a run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PauseKind {
    /// Its workers on an API key spent the dollar budget.
    Dollars,
    /// It used its points of a window.
    Points,
    /// A window it draws on passed the level, whoever filled it.
    Window,
}

/// Why a run starts nothing new until a person says so.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pause {
    pub kind: PauseKind,
    pub message: String,
    /// The window that stopped it, for a subscription limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<WindowUse>,
    /// The person asked for it to go on once the window resets: when, in
    /// milliseconds since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_at: Option<i64>,
}

/// Two observations this close name the same reset (`status::usage` allows
/// the same): one source gives whole seconds, another fractions that move.
const SAME_RESET_MS: i64 = 60_000;

/// The model name a model-scoped window is for, in lower case: `opus` for
/// `seven_day_opus`, the first word of its label for the rest. `None` for a
/// window of the whole account.
fn scoped_to(window_key: &str, label: &str) -> Option<String> {
    if let Some(model) = window_key.strip_prefix("seven_day_") {
        return Some(model.to_lowercase());
    }
    if window_key == "fable_weekly" {
        return Some("fable".into());
    }
    if window_key.starts_with("model_scoped_") {
        return label.split_whitespace().next().map(str::to_lowercase);
    }
    None
}

/// Whether a worker of `agent` on `model` uses up `window`: every window of
/// its agent's account, and the model-scoped ones of its own model. A worker
/// on the agent's default model draws on the account's windows; which model
/// that is, TerminalX does not know.
pub fn draws_on(window_agent: &str, window_key: &str, label: &str, agent: &str, model: &str) -> bool {
    if window_agent != agent {
        return false;
    }
    match scoped_to(window_key, label) {
        None => true,
        Some(scope) => !model.is_empty() && model.to_lowercase().contains(&scope),
    }
}

/// The login a piece's worker has, or would have if it started now.
fn login_of(piece: &Piece, login_now: &dyn Fn(&str) -> Login) -> Login {
    piece.login.unwrap_or_else(|| login_now(&piece.agent))
}

/// Pieces that still count: done ones used what they used, but a piece that
/// never starts again draws on nothing new. Every piece counts, so a window
/// the run will draw on is watched before its first worker starts in it.
fn counted(run: &Run) -> impl Iterator<Item = &Piece> {
    run.pieces.iter().filter(|piece| piece.state != super::PieceState::Stopped || piece.worker.is_some())
}

/// Bring `run.usage` up to date. `windows` are the usage windows as the
/// status bar has them now; `cost` is what a started worker's session has
/// cost so far (`None` when not read yet); `login_now` is how an agent is
/// signed in for a new tab; `active` is whether the run has workers started,
/// which is when its share of a window begins to count.
pub fn update(run: &mut Run, windows: &[UsageWindow], cost: &dyn Fn(&Piece) -> Option<f64>, login_now: &dyn Fn(&str) -> Login, active: bool) {
    let mut usage = RunUsage::default();
    for piece in counted(run) {
        match login_of(piece, login_now) {
            Login::ApiKey => {
                usage.api_key = true;
                if piece.worker.is_some() {
                    usage.dollars += cost(piece).unwrap_or(0.0);
                }
            }
            Login::Subscription => usage.subscription = true,
        }
    }
    let subscription_pieces: Vec<&Piece> = counted(run).filter(|piece| login_of(piece, login_now) == Login::Subscription).collect();
    for window in windows.iter().filter(|window| !window.stale) {
        if !subscription_pieces.iter().any(|piece| draws_on(&window.agent, &window.key, &window.label, &piece.agent, &piece.model)) {
            continue;
        }
        let before = run.usage.windows.iter().find(|seen| seen.agent == window.agent && seen.key == window.key);
        let percent = f64::from(window.used_percent);
        let reset = match (before.and_then(|seen| seen.resets_at), window.resets_at) {
            (Some(was), Some(now)) => now - was > SAME_RESET_MS,
            _ => false,
        };
        // The baseline is taken once, when the run first has workers; a new window starts from 0.
        let start = match before.and_then(|seen| seen.start) {
            Some(_) if reset => Some(0.0),
            Some(start) => Some(start),
            None if active => Some(percent),
            None => None,
        };
        let points = start.map_or(0.0, |start| (percent - start).max(0.0));
        usage.windows.push(WindowUse { agent: window.agent.clone(), key: window.key.clone(), label: window.label.clone(), percent, start, resets_at: window.resets_at, points });
    }
    // A window not read this time keeps what was last seen of it: not read is not empty.
    for seen in &run.usage.windows {
        if !usage.windows.iter().any(|window| window.agent == seen.agent && window.key == seen.key) {
            usage.windows.push(seen.clone());
        }
    }
    usage.windows.sort_by(|a, b| (&a.agent, &a.key).cmp(&(&b.agent, &b.key)));
    run.usage = usage;
}

/// `Claude 5h`: the agent and the window, as the message names it.
pub fn window_name(window: &WindowUse) -> String {
    let agent = match window.agent.as_str() {
        "claude" => "Claude",
        "codex" => "Codex",
        other => other,
    };
    format!("{agent} {}", window.label)
}

/// `16:10`, or `Tue 16:10` when it is not today, in the Mac's time zone.
pub fn reset_time(at_ms: i64, now_ms: i64) -> String {
    use chrono::{Local, TimeZone};
    let (Some(at), Some(now)) = (Local.timestamp_millis_opt(at_ms).single(), Local.timestamp_millis_opt(now_ms).single()) else { return "later".into() };
    if at.date_naive() == now.date_naive() {
        at.format("%H:%M").to_string()
    } else {
        at.format("%a %H:%M").to_string()
    }
}

fn resets(window: &WindowUse, now_ms: i64) -> String {
    match window.resets_at {
        Some(at) => format!(" It resets at {}.", reset_time(at, now_ms)),
        None => " Its reset time is not known yet.".into(),
    }
}

/// The limit a run has reached, if any: a window past its level first (it
/// stops every run on that window), then the run's own points, then dollars.
pub fn reached(run: &Run, now_ms: i64) -> Option<Pause> {
    let limits = &run.limits;
    if let Some(window) = run.usage.windows.iter().filter(|window| window.percent >= limits.ceiling).max_by(|a, b| a.percent.total_cmp(&b.percent)) {
        return Some(Pause {
            kind: PauseKind::Window,
            message: format!("The {} window is at {:.0}%, past the {:.0}% this run stops at.{}", window_name(window), window.percent, limits.ceiling, resets(window, now_ms)),
            window: Some(window.clone()),
            resume_at: None,
        });
    }
    if let Some(window) = run.usage.windows.iter().filter(|window| window.start.is_some() && window.points >= limits.points).max_by(|a, b| a.points.total_cmp(&b.points)) {
        return Some(Pause {
            kind: PauseKind::Points,
            message: format!(
                "This run has used about {:.0} points of the {} window, past its budget of {:.0}. The window is shared, so this counts everything you ran meanwhile.{}",
                window.points,
                window_name(window),
                limits.points,
                resets(window, now_ms)
            ),
            window: Some(window.clone()),
            resume_at: None,
        });
    }
    if run.usage.api_key && run.usage.dollars >= limits.dollars {
        return Some(Pause {
            kind: PauseKind::Dollars,
            message: format!("Its workers on an API key have spent ${:.2}, past this run's budget of ${:.2}.", run.usage.dollars, limits.dollars),
            window: None,
            resume_at: None,
        });
    }
    None
}

/// What the person approving a run is warned of: use that would not fit in
/// what is left. For a subscription the run's use is not known ahead, so its
/// points budget stands for it; for a key, the lead's estimate.
pub fn fit(run: &Run, now_ms: i64) -> Vec<String> {
    let limits = &run.limits;
    let mut warnings = Vec::new();
    for window in &run.usage.windows {
        let left = limits.ceiling - window.percent;
        if left <= 0.0 {
            warnings.push(format!("The {} window is already at {:.0}%, past {:.0}%: no worker would start.{}", window_name(window), window.percent, limits.ceiling, resets(window, now_ms)));
        } else if left < limits.points - window.points {
            warnings.push(format!(
                "The {} window is at {:.0}%. This run may use up to {:.0} points, but it stops at {:.0}%, about {:.0} points from now.{}",
                window_name(window),
                window.percent,
                limits.points,
                limits.ceiling,
                left,
                resets(window, now_ms)
            ));
        }
    }
    if run.usage.api_key {
        let (estimate, _) = run.estimate();
        if let Some(estimate) = estimate.filter(|estimate| estimate.high > limits.dollars - run.usage.dollars) {
            warnings.push(format!("The lead estimates up to ${:.2}; this run's budget for workers on an API key is ${:.2}.", estimate.high, limits.dollars));
        }
    }
    warnings
}
