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
use crate::store::settings::{Cap, OrchestratorLimits};

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
    /// Dollars its workers on an API key may spend, or No limit.
    pub dollars: Cap,
    /// Points of one usage window the run itself may use, or No limit.
    pub points: Cap,
    /// No new piece starts once a window it draws on is this full; off, the
    /// run may use the whole window.
    pub ceiling: Cap,
}

impl Default for RunLimits {
    /// A run stored before PRO-280 holds to the defaults.
    fn default() -> Self {
        use crate::store::settings::{DEFAULT_BUDGET_DOLLARS, DEFAULT_BUDGET_POINTS, DEFAULT_WINDOW_CEILING, DEFAULT_WORKERS_PER_RUN};
        Self { workers: DEFAULT_WORKERS_PER_RUN, dollars: Cap::At(DEFAULT_BUDGET_DOLLARS), points: Cap::At(DEFAULT_BUDGET_POINTS), ceiling: Cap::At(DEFAULT_WINDOW_CEILING) }
    }
}

impl RunLimits {
    /// The project's limits, with the lead's budget where it is lower. A lead
    /// may ask for less than the person allows, never more: its No limit is
    /// the person's limit, and under the person's No limit its bound holds.
    pub fn new(settings: &OrchestratorLimits, asked: &super::Budget) -> Self {
        use crate::store::settings::{valid_dollars, valid_percent};
        let lower = |asked: Option<Cap>, allowed: Cap, valid: fn(f64) -> bool| match (asked.and_then(Cap::at).filter(|value| valid(*value)), allowed) {
            (Some(value), Cap::At(allowed)) => Cap::At(value.min(allowed)),
            (Some(value), Cap::NoLimit) => Cap::At(value),
            (None, allowed) => allowed,
        };
        Self {
            workers: settings.workers_per_run,
            dollars: lower(asked.dollars, settings.budget_dollars, valid_dollars),
            points: lower(asked.points, settings.budget_points, valid_percent),
            ceiling: settings.window_ceiling,
        }
    }

    /// Whether every value is one the settings would take.
    pub fn valid(&self) -> Result<(), String> {
        use crate::store::settings::{valid_dollars, valid_percent, valid_workers, MAX_BUDGET_DOLLARS, MAX_WORKERS};
        if !valid_workers(self.workers) {
            return Err(format!("A run may have from 1 to {MAX_WORKERS} workers at once, not {}.", self.workers));
        }
        if !self.dollars.valid(valid_dollars) {
            return Err(format!("A dollar budget is more than $0 and at most ${MAX_BUDGET_DOLLARS:.0}."));
        }
        if !self.points.valid(valid_percent) {
            return Err("A points budget is more than 0 and at most 100 points of a window.".into());
        }
        if !self.ceiling.valid(valid_percent) {
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
/// status bar has them now; `cost` is what a piece's tries have cost so far, every
/// try included (`None` when none was read); `login_now` is how an agent is
/// signed in for a new tab; `active` is whether the run has workers started,
/// which is when its share of a window begins to count.
pub fn update(run: &mut Run, windows: &[UsageWindow], cost: &dyn Fn(&Piece) -> Option<f64>, login_now: &dyn Fn(&str) -> Login, active: bool) {
    let mut usage = RunUsage::default();
    for piece in counted(run) {
        match login_of(piece, login_now) {
            Login::ApiKey => {
                usage.api_key = true;
                usage.dollars += cost(piece).unwrap_or(0.0);
            }
            Login::Subscription => usage.subscription = true,
        }
    }
    // The lead resolving a conflict a person gave it is a model call of the run's too (`merge`).
    if let Some(merge) = &run.merge {
        let dollars = merge.key_dollars();
        match merge.resolving.as_ref().map(|resolving| resolving.login) {
            Some(Login::Subscription) => usage.subscription = true,
            Some(Login::ApiKey) => usage.api_key = true,
            None => {}
        }
        if dollars > 0.0 {
            usage.api_key = true;
            usage.dollars += dollars;
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
/// A limit set to No limit is never reached.
pub fn reached(run: &Run, now_ms: i64) -> Option<Pause> {
    let limits = &run.limits;
    if let Some((ceiling, window)) = limits.ceiling.at().and_then(|ceiling| run.usage.windows.iter().filter(|window| window.percent >= ceiling).max_by(|a, b| a.percent.total_cmp(&b.percent)).map(|window| (ceiling, window))) {
        return Some(Pause {
            kind: PauseKind::Window,
            message: format!("The {} window is at {:.0}%, past the {:.0}% this run stops at.{}", window_name(window), window.percent, ceiling, resets(window, now_ms)),
            window: Some(window.clone()),
            resume_at: None,
        });
    }
    if let Some((points, window)) = limits.points.at().and_then(|points| run.usage.windows.iter().filter(|window| window.start.is_some() && window.points >= points).max_by(|a, b| a.points.total_cmp(&b.points)).map(|window| (points, window))) {
        return Some(Pause {
            kind: PauseKind::Points,
            message: format!(
                "This run has used about {:.0} points of the {} window, past its budget of {:.0}. The window is shared, so this counts everything you ran meanwhile.{}",
                window.points,
                window_name(window),
                points,
                resets(window, now_ms)
            ),
            window: Some(window.clone()),
            resume_at: None,
        });
    }
    if let Some(dollars) = limits.dollars.at().filter(|dollars| run.usage.api_key && run.usage.dollars >= *dollars) {
        return Some(Pause {
            kind: PauseKind::Dollars,
            message: format!("Its workers on an API key have spent ${:.2}, past this run's budget of ${dollars:.2}.", run.usage.dollars),
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
        let Some(ceiling) = limits.ceiling.at() else { break };
        let left = ceiling - window.percent;
        if left <= 0.0 {
            warnings.push(format!("The {} window is already at {:.0}%, past {ceiling:.0}%: no worker would start.{}", window_name(window), window.percent, resets(window, now_ms)));
        } else if let Some(points) = limits.points.at().filter(|points| left < points - window.points) {
            warnings.push(format!(
                "The {} window is at {:.0}%. This run may use up to {points:.0} points, but it stops at {ceiling:.0}%, about {left:.0} points from now.{}",
                window_name(window),
                window.percent,
                resets(window, now_ms)
            ));
        }
    }
    if let Some(dollars) = limits.dollars.at().filter(|_| run.usage.api_key) {
        let (estimate, _) = run.estimate();
        if let Some(estimate) = estimate.filter(|estimate| estimate.high > dollars - run.usage.dollars) {
            warnings.push(format!("The lead estimates up to ${:.2}; this run's budget for workers on an API key is ${dollars:.2}.", estimate.high));
        }
    }
    warnings.extend(no_limit(run));
    warnings
}

/// The one warning for a run that some limit will not stop: the budgets
/// set to No limit that its workers' logins draw on, and the window level
/// when that is off too.
fn no_limit(run: &Run) -> Option<String> {
    let (limits, usage) = (&run.limits, &run.usage);
    let dollars = usage.api_key && limits.dollars == Cap::NoLimit;
    let points = usage.subscription && limits.points == Cap::NoLimit;
    let ceiling = usage.subscription && limits.ceiling == Cap::NoLimit;
    let unbounded = match (dollars, points) {
        (true, true) => Some("dollars or points"),
        (true, false) => Some("dollars"),
        (false, true) => Some("points of a window"),
        (false, false) => None,
    };
    let level = limits.ceiling.at().filter(|_| usage.subscription);
    match (unbounded, ceiling) {
        (None, false) => None,
        (Some(what), false) => Some(match level {
            Some(level) => format!("This run has no limit on {what}: it goes on until its work is done, or until a window it draws on passes {level:.0}%. What it uses is still recorded."),
            None => format!("This run has no limit on {what}: it goes on until its work is done. What it spends is still recorded."),
        }),
        (Some(what), true) => Some(format!("This run has no limit on {what}, and the window level is off: it goes on until its work is done and can use the whole of a window.")),
        (None, true) => Some("The window level is off for this run: it can use the whole of a window before its points budget stops it.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestration::{Budget, RunState, SessionRef};

    /// A fixed clock: no message here depends on today.
    const NOW: i64 = 1_794_000_000_000;

    /// A run with no pieces that has spent `dollars` on a key and used `points`
    /// of a 5h window now at `percent`.
    fn run(limits: RunLimits, dollars: f64, points: f64, percent: f64) -> Run {
        Run {
            id: "run-1".into(),
            lead: SessionRef { session_id: "lead".into(), tab_id: None },
            ladder: Default::default(),
            project_path: "/repo".into(),
            goal: "g".into(),
            state: RunState::Running,
            budget: Budget::default(),
            pieces: Vec::new(),
            worker_mode: "bypassPermissions".into(),
            plan_edited: false,
            approval: None,
            reason: None,
            integration_check: None,
            merge: None,
            limits,
            usage: RunUsage {
                dollars,
                api_key: true,
                subscription: true,
                windows: vec![WindowUse { agent: "claude".into(), key: "five_hour".into(), label: "5h".into(), percent, start: Some(percent - points), resets_at: None, points }],
            },
            pause: None,
            created: "2026-11-12T00:00:00Z".into(),
            modified: "2026-11-12T00:00:00Z".into(),
        }
    }

    fn limits(dollars: Cap, points: Cap, ceiling: Cap) -> RunLimits {
        RunLimits { workers: 4, dollars, points, ceiling }
    }

    fn kind(run: &Run) -> Option<PauseKind> {
        reached(run, NOW).map(|pause| pause.kind)
    }

    #[test]
    fn a_budget_set_to_no_limit_is_never_reached_and_the_others_still_are() {
        use Cap::{At, NoLimit};
        // Past $10,000 (the most a bound takes) and past every points bound, under the ceiling.
        let (dollars, points, percent) = (12_500.0, 80.0, 80.0);
        let cases = [
            // dollars, points, ceiling → what stops it
            (At(15.0), At(25.0), At(85.0), Some(PauseKind::Points)),
            (NoLimit, At(25.0), At(85.0), Some(PauseKind::Points)),
            (At(15.0), NoLimit, At(85.0), Some(PauseKind::Dollars)),
            (NoLimit, NoLimit, At(85.0), None),
            (NoLimit, NoLimit, NoLimit, None),
            (At(15.0), NoLimit, NoLimit, Some(PauseKind::Dollars)),
            (NoLimit, At(25.0), NoLimit, Some(PauseKind::Points)),
        ];
        for (d, p, c, expected) in cases {
            assert_eq!(kind(&run(limits(d, p, c), dollars, points, percent)), expected, "dollars {d:?}, points {p:?}, ceiling {c:?}");
        }
    }

    #[test]
    fn with_both_budgets_off_the_window_ceiling_still_pauses_a_run_unless_it_is_off_too() {
        use Cap::{At, NoLimit};
        let past = run(limits(NoLimit, NoLimit, At(85.0)), 20_000.0, 90.0, 90.0);
        let pause = reached(&past, NOW).unwrap();
        assert_eq!(pause.kind, PauseKind::Window);
        assert!(pause.message.contains("90%") && pause.message.contains("85%"), "{}", pause.message);
        assert_eq!(kind(&run(limits(NoLimit, NoLimit, NoLimit), 20_000.0, 99.0, 99.0)), None, "off, a run may use the whole window");
    }

    #[test]
    fn no_limit_is_stored_as_none_and_a_run_stored_before_it_loads_its_numbers() {
        let old: RunLimits = serde_json::from_value(serde_json::json!({"workers": 2, "dollars": 15.0, "points": 25.0, "ceiling": 85.0})).unwrap();
        assert_eq!(old, RunLimits { workers: 2, ..limits(Cap::At(15.0), Cap::At(25.0), Cap::At(85.0)) });
        let off = limits(Cap::NoLimit, Cap::At(25.0), Cap::NoLimit);
        let written = serde_json::to_value(&off).unwrap();
        assert_eq!(written, serde_json::json!({"workers": 4, "dollars": "none", "points": 25.0, "ceiling": "none"}));
        assert_eq!(serde_json::from_value::<RunLimits>(written).unwrap(), off);
        assert!(off.valid().is_ok());
        assert!(limits(Cap::At(10_001.0), Cap::NoLimit, Cap::NoLimit).valid().is_err(), "a bound is still checked");
        // A value lost on the way arrives as null: it is refused, never read as No limit.
        assert!(serde_json::from_value::<RunLimits>(serde_json::json!({"workers": 2, "dollars": null, "points": 25.0, "ceiling": 85.0})).is_err());
        assert!(serde_json::from_value::<RunLimits>(serde_json::json!({"workers": 2, "dollars": "lots", "points": 25.0, "ceiling": 85.0})).is_err());
    }

    #[test]
    fn a_lead_may_not_lift_a_limit_but_its_own_bound_holds_under_no_limit() {
        let mut settings = crate::store::settings::OrchestratorSettings::default().for_project("/repo");
        let asked = |dollars: Option<Cap>| Budget { dollars, points: None };
        assert_eq!(RunLimits::new(&settings, &asked(Some(Cap::NoLimit))).dollars, Cap::At(15.0));
        settings.budget_dollars = Cap::NoLimit;
        assert_eq!(RunLimits::new(&settings, &asked(None)).dollars, Cap::NoLimit);
        assert_eq!(RunLimits::new(&settings, &asked(Some(Cap::At(40.0)))).dollars, Cap::At(40.0));
        assert_eq!(RunLimits::new(&settings, &asked(Some(Cap::At(1e9)))).dollars, Cap::NoLimit, "a bound no setting takes is not asked for");
    }

    #[test]
    fn the_approval_view_warns_once_of_a_run_with_no_limit() {
        use Cap::{At, NoLimit};
        let fresh = |limits: RunLimits| run(limits, 0.0, 0.0, 20.0);
        let warnings = |limits: RunLimits| fit(&fresh(limits), NOW);
        assert!(warnings(limits(At(15.0), At(25.0), At(85.0))).is_empty());

        let both = warnings(limits(NoLimit, NoLimit, At(85.0)));
        assert_eq!(both, vec!["This run has no limit on dollars or points: it goes on until its work is done, or until a window it draws on passes 85%. What it uses is still recorded.".to_string()]);
        let all = warnings(limits(NoLimit, NoLimit, NoLimit));
        assert_eq!(all.len(), 1);
        assert!(all[0].contains("window level is off") && all[0].contains("whole of a window"), "{}", all[0]);
        let ceiling = warnings(limits(At(15.0), At(25.0), NoLimit));
        assert_eq!(ceiling.len(), 1);
        assert!(ceiling[0].contains("whole of a window"), "{}", ceiling[0]);

        // A key-only run is not warned of the points it does not draw on.
        let mut key = fresh(limits(At(15.0), NoLimit, NoLimit));
        key.usage.subscription = false;
        key.usage.windows.clear();
        assert!(fit(&key, NOW).is_empty());
        key.limits.dollars = NoLimit;
        assert_eq!(fit(&key, NOW), vec!["This run has no limit on dollars: it goes on until its work is done. What it spends is still recorded.".to_string()]);
    }
}
