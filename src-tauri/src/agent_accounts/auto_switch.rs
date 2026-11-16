//! Switch accounts automatically (#981, docs/AGENT-ACCOUNTS.md "Switching
//! automatically").
//!
//! With several subscription accounts for one agent (#980), a person may turn
//! on automatic switching: when the account a tab runs on, or a new session
//! would start on, reaches a threshold of a usage window, the tab moves to
//! another account that has room, through #980's own "Continue with …".
//!
//! This module holds the setting, the one function that decides
//! ([`decide`]), what the runtime remembers between decisions ([`Memory`]),
//! and the switch log. [`decide`] has no side effects: it is given the
//! accounts, their windows, the setting and the tab's state, and says "stay"
//! or "switch to X" with a reason. The session manager gathers its input and
//! carries out what it says (`session_account_switch.rs`).
//!
//! Labels are display data. They are in the conversation line and the
//! switch log, which are the person's own; never in a diagnostic log.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::Kind;
use crate::status::usage::UsageWindow;

/// The default threshold, in percent of a window.
pub const DEFAULT_THRESHOLD: u8 = 90;
pub const MIN_THRESHOLD: u8 = 50;
pub const MAX_THRESHOLD: u8 = 100;
/// An account left because it was full is chosen again only below the
/// threshold by this many points, or once its window resets.
pub const MARGIN: f32 = 10.0;
/// A tab is switched at most once in this long.
pub const COOLDOWN_MS: i64 = 5 * 60_000;
/// Usage not heard from in this long is stale, as the usage store says.
pub const FRESH_MS: i64 = 30 * 60_000;
/// Accounts within this many points of the threshold are polled every minute.
pub const HOT_BAND: f32 = 15.0;
/// How long a tab switched onto an account counts against it when several
/// tabs are spread at once, and by how many points each.
const ARRIVAL_MS: i64 = 5 * 60_000;
const ARRIVAL_WEIGHT: f32 = 10.0;
/// The switch log keeps this long.
pub const LOG_DAYS: i64 = 30;
pub const LOG_FILE: &str = "agent-account-switches.jsonl";

// ------------------------------------------------------------------ setting

/// How the next account is chosen.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Order {
    /// The available account with the most room left.
    #[default]
    MostRoom,
    /// The first available account in the person's order.
    InOrder,
}

/// One account in the person's list: whether it may be switched onto.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pick {
    pub id: String,
    #[serde(rename = "use")]
    pub used: bool,
}

/// One agent's automatic switching, kept in `agent-logins.json` beside its
/// accounts. Off by default.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Setting {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_threshold")]
    pub threshold: u8,
    /// The person's priority order, each account checked or not. An account
    /// not named here follows these in Settings' order, checked when it is a
    /// subscription and unchecked when it is an API key.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub accounts: Vec<Pick>,
    #[serde(default)]
    pub order: Order,
    /// A notification for each switch on a tab out of view.
    #[serde(default = "yes")]
    pub notify_switch: bool,
    /// A notification when no account has room.
    #[serde(default = "yes")]
    pub notify_none_left: bool,
    /// Projects whose tabs are never switched ("Never switch accounts in this project").
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub never_projects: Vec<String>,
    /// What a newer build wrote here: kept as it is.
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

fn default_threshold() -> u8 {
    DEFAULT_THRESHOLD
}

fn yes() -> bool {
    true
}

impl Default for Setting {
    fn default() -> Self {
        Self { enabled: false, threshold: DEFAULT_THRESHOLD, accounts: Vec::new(), order: Order::MostRoom, notify_switch: true, notify_none_left: true, never_projects: Vec::new(), rest: Map::new() }
    }
}

impl Setting {
    /// The threshold, kept to its range whatever the file says.
    pub fn threshold(&self) -> f32 {
        f32::from(self.threshold.clamp(MIN_THRESHOLD, MAX_THRESHOLD))
    }

    /// Whether tabs of project `project` may be switched.
    pub fn switches_in(&self, project: Option<&str>) -> bool {
        self.enabled && !project.is_some_and(|project| self.never_projects.iter().any(|never| never == project))
    }
}

/// One account as the setting lists it: in the person's order, with whether
/// it may be switched onto.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listed {
    pub id: String,
    pub label: String,
    pub kind: Kind,
    #[serde(rename = "use")]
    pub used: bool,
    /// Signed in: its directory is there.
    pub signed_in: bool,
}

/// `accounts` (Settings' order) in the setting's order, each checked or not.
pub fn ordered(setting: &Setting, accounts: &[super::Account]) -> Vec<Listed> {
    let listed = |account: &super::Account, used: bool| Listed { id: account.id.clone(), label: account.label.clone(), kind: account.kind, used, signed_in: !account.missing };
    let mut out: Vec<Listed> = setting.accounts.iter()
        .filter_map(|pick| accounts.iter().find(|account| account.id == pick.id).map(|account| listed(account, pick.used)))
        .collect();
    for account in accounts {
        if !out.iter().any(|listed| listed.id == account.id) {
            out.push(listed(account, account.kind == Kind::Subscription));
        }
    }
    out
}

/// Whether the setting is offered: two or more subscription accounts.
pub fn offered(accounts: &[super::Account]) -> bool {
    accounts.iter().filter(|account| account.kind == Kind::Subscription).count() >= 2
}

/// A setting as Settings sends it back, checked: the threshold in range,
/// each account listed once, and only ids `exists` knows.
pub fn checked(mut setting: Setting, exists: impl Fn(&str) -> bool) -> Result<Setting> {
    anyhow::ensure!((MIN_THRESHOLD..=MAX_THRESHOLD).contains(&setting.threshold), "The threshold must be between {MIN_THRESHOLD}% and {MAX_THRESHOLD}%.");
    let mut seen = HashSet::new();
    setting.accounts.retain(|pick| exists(&pick.id) && seen.insert(pick.id.clone()));
    setting.never_projects.retain(|project| !project.trim().is_empty());
    setting.never_projects.sort();
    setting.never_projects.dedup();
    Ok(setting)
}

// ---------------------------------------------------------------- deciding

/// What a decision is asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
    /// A new session or tab is starting: which account it starts on.
    Launch,
    /// A running tab whose turn has ended: whether it moves before the next prompt.
    Between,
    /// A running tab hit its usage limit in the middle of a turn.
    LimitHit,
}

/// A usage-limit error a tab on an account received.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Limited {
    pub at: i64,
    /// When the limit lifts, if the agent said.
    pub resets_at: Option<i64>,
}

/// An account a tab was switched away from because it was full.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Left {
    pub at: i64,
    /// The reset of the window that was full, if known.
    pub resets_at: Option<i64>,
}

/// One account of the agent, as a decision sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub label: String,
    pub kind: Kind,
    /// Its sign-in is there, and a switch to it has not just failed.
    pub signed_in: bool,
    /// Checked in the setting's list.
    pub checked: bool,
    /// Its windows as last polled; none for an API key.
    pub windows: Vec<UsageWindow>,
    /// Its usage could not be read.
    pub unreadable: bool,
    /// A tab on it received a usage-limit error.
    pub limited: Option<Limited>,
    /// A tab was switched away from it because it was full.
    pub left: Option<Left>,
    /// Its plan is known not to run the tab's model.
    pub lacks_model: bool,
    /// Tabs switched onto it in the last few minutes.
    pub arrivals: u32,
}

/// Everything [`decide`] reads.
#[derive(Clone, Debug)]
pub struct Ask<'a> {
    pub why: Why,
    /// The account the tab runs on, or a launch would start on.
    pub current: &'a str,
    /// The tab's model, for windows of one model.
    pub model: Option<&'a str>,
    /// The agent's accounts, in the setting's order.
    pub candidates: &'a [Candidate],
    pub threshold: f32,
    pub order: Order,
    /// When the tab was last switched, automatically or by hand.
    pub last_switch_at: Option<i64>,
    pub now: i64,
}

/// Why an account counts as full.
#[derive(Clone, Debug, PartialEq)]
pub struct Full {
    /// The window's key (`five_hour`, `seven_day`, `seven_day_opus`, …), or
    /// `limit` for a usage-limit error.
    pub window: String,
    pub used: f32,
    pub resets_at: Option<i64>,
    /// At its limit, not only past the threshold.
    pub at_limit: bool,
}

/// What a switch says it was for.
#[derive(Clone, Debug, PartialEq)]
pub struct Reason {
    pub from_label: String,
    pub full: Full,
    /// Every account was above the threshold and this one has the most room.
    pub most_room: bool,
}

impl Reason {
    /// "Work reached 91% of its 5-hour limit", "Work hit its usage limit".
    pub fn text(&self, launch: bool) -> String {
        let name = &self.from_label;
        if self.full.window == "limit" {
            return format!("{name} hit its usage limit");
        }
        let window = window_name(&self.full.window);
        let used = self.full.used.round() as i64;
        if self.most_room {
            format!("every account is above the threshold and {name} is at {used}% of its {window}")
        } else if launch {
            format!("{name} is at {used}% of its {window}")
        } else {
            format!("{name} reached {used}% of its {window}")
        }
    }
}

/// Why a tab stays where it is.
#[derive(Clone, Debug, PartialEq)]
pub enum Stay {
    /// Its account is not full.
    NotFull,
    /// It was switched less than [`COOLDOWN_MS`] ago, until then.
    Cooldown { until: i64 },
    /// Its account is not one of the agent's.
    Unknown,
    /// Every other account is above the threshold, and none is at its limit.
    AllAboveThreshold,
    /// No account has room. `earliest_reset`: the soonest any account's full
    /// window resets. `lacking_model`: an account had room but not the model.
    NoneAvailable { full: Option<Full>, earliest_reset: Option<i64>, lacking_model: bool },
}

#[derive(Clone, Debug, PartialEq)]
pub enum Decision {
    Stay(Stay),
    Switch { to: String, reason: Reason },
}

/// The model a window is for: `seven_day_opus` is Opus's, `five_hour` everyone's.
fn window_model(key: &str) -> Option<&str> {
    ["five_hour_", "seven_day_"].iter().find_map(|prefix| key.strip_prefix(prefix)).filter(|model| !model.is_empty())
}

/// Whether window `key` counts for a tab on `model`. Without a model, every one does.
pub fn applies(key: &str, model: Option<&str>) -> bool {
    match (window_model(key), model) {
        (None, _) | (_, None) => true,
        (Some(scope), Some(model)) => model.to_ascii_lowercase().contains(&scope.to_ascii_lowercase()),
    }
}

/// "5-hour limit", "weekly limit", "weekly Opus limit".
pub fn window_name(key: &str) -> String {
    match key {
        "five_hour" => "5-hour limit".into(),
        "seven_day" => "weekly limit".into(),
        "limit" => "usage limit".into(),
        other => match window_model(other) {
            Some(model) => {
                let mut name = model.to_string();
                if let Some(first) = name.get_mut(..1) { first.make_ascii_uppercase(); }
                if other.starts_with("five_hour_") { format!("5-hour {name} limit") } else { format!("weekly {name} limit") }
            }
            None => "usage limit".into(),
        },
    }
}

/// A window's share used at `now`: nothing once it has reset.
fn used_now(window: &UsageWindow, now: i64) -> f32 {
    if window.resets_at.is_some_and(|reset| reset <= now) { 0.0 } else { window.used_percent }
}

/// The fullest window that counts for `model`, at `now`.
fn fullest<'a>(candidate: &'a Candidate, model: Option<&str>, now: i64) -> Option<&'a UsageWindow> {
    candidate.windows.iter()
        .filter(|window| applies(&window.key, model))
        .max_by(|a, b| used_now(a, now).total_cmp(&used_now(b, now)))
}

/// The most used share of a window that counts, at `now`: 0 with none.
pub fn used(candidate: &Candidate, model: Option<&str>, now: i64) -> f32 {
    fullest(candidate, model, now).map_or(0.0, |window| used_now(window, now))
}

/// Whether a usage-limit error on `candidate` still holds: until its reset,
/// or, with no reset known, until usage polled after it shows room.
fn limit_holds(candidate: &Candidate, limited: &Limited, now: i64) -> bool {
    match limited.resets_at {
        Some(reset) => reset > now,
        None => {
            let polled_since = !candidate.windows.is_empty() && candidate.windows.iter().all(|window| window.updated_at > limited.at);
            !(polled_since && candidate.windows.iter().all(|window| used_now(window, now) < 100.0))
        }
    }
}

/// Why `candidate` is full for a tab on `model`, if it is: a usage-limit
/// error that still holds, or a window that counts at or past `threshold`.
pub fn full(candidate: &Candidate, model: Option<&str>, threshold: f32, now: i64) -> Option<Full> {
    if let Some(limited) = candidate.limited.filter(|limited| limit_holds(candidate, limited, now)) {
        return Some(Full { window: "limit".into(), used: 100.0, resets_at: limited.resets_at, at_limit: true });
    }
    let window = fullest(candidate, model, now)?;
    let used = used_now(window, now);
    (used >= threshold).then(|| Full { window: window.key.clone(), used, resets_at: window.resets_at, at_limit: used >= 100.0 })
}

/// Whether `candidate`'s usage can be trusted: read, and heard from lately.
/// An API key has no windows to read and counts as known.
fn fresh(candidate: &Candidate, now: i64) -> bool {
    if candidate.kind == Kind::ApiKey {
        return !candidate.unreadable;
    }
    !candidate.unreadable && !candidate.windows.is_empty() && candidate.windows.iter().all(|window| now.saturating_sub(window.updated_at) < FRESH_MS)
}

/// Whether an account left because it was full may be chosen again: its
/// window has reset, or it is below the threshold by [`MARGIN`].
fn recovered(candidate: &Candidate, model: Option<&str>, threshold: f32, now: i64) -> bool {
    match candidate.left {
        None => true,
        Some(left) => left.resets_at.is_some_and(|reset| reset <= now) || used(candidate, model, now) < threshold - MARGIN,
    }
}

/// Whether `candidate` may be switched onto, and if not, whether only the
/// tab's model kept it out.
fn available(candidate: &Candidate, model: Option<&str>, threshold: f32, now: i64) -> (bool, bool) {
    let otherwise = candidate.signed_in
        && candidate.checked
        && fresh(candidate, now)
        && full(candidate, model, threshold, now).is_none()
        && recovered(candidate, model, threshold, now);
    (otherwise && !candidate.lacks_model, otherwise && candidate.lacks_model)
}

/// The room an account has for the choice "Most room left": what is left
/// under its fullest window, less a share for each tab sent to it lately, so
/// that several tabs at once spread over the accounts.
fn room(candidate: &Candidate, model: Option<&str>, now: i64) -> f32 {
    100.0 - used(candidate, model, now) - ARRIVAL_WEIGHT * candidate.arrivals as f32
}

/// The account `ask`'s tab should run on, and why. The one place it is decided.
pub fn decide(ask: &Ask<'_>) -> Decision {
    let Some(current) = ask.candidates.iter().find(|candidate| candidate.id == ask.current) else {
        return Decision::Stay(Stay::Unknown);
    };
    let (model, threshold, now) = (ask.model, ask.threshold, ask.now);
    if ask.why != Why::Launch {
        if let Some(until) = ask.last_switch_at.map(|at| at + COOLDOWN_MS).filter(|until| *until > now) {
            return Decision::Stay(Stay::Cooldown { until });
        }
    }
    let current_full = full(current, model, threshold, now);
    let Some(from_full) = current_full.clone() else { return Decision::Stay(Stay::NotFull) };

    let others: Vec<&Candidate> = ask.candidates.iter().filter(|candidate| candidate.id != current.id).collect();
    let judged: Vec<(&Candidate, bool, bool)> = others.iter().map(|candidate| {
        let (yes, model_only) = available(candidate, model, threshold, now);
        (*candidate, yes, model_only)
    }).collect();
    let open: Vec<&Candidate> = judged.iter().filter(|(_, yes, _)| *yes).map(|(candidate, _, _)| *candidate).collect();
    // Subscriptions first; an API key, billed per request, only when none has room.
    let subscriptions: Vec<&Candidate> = open.iter().copied().filter(|candidate| candidate.kind == Kind::Subscription).collect();
    let pool = if subscriptions.is_empty() { open } else { subscriptions };
    let chosen = match ask.order {
        Order::InOrder => pool.first().copied(),
        Order::MostRoom => pool.iter().copied().enumerate()
            // The first in the person's order wins a tie.
            .max_by(|(ia, a), (ib, b)| room(a, model, now).total_cmp(&room(b, model, now)).then(ib.cmp(ia)))
            .map(|(_, candidate)| candidate),
    };
    if let Some(to) = chosen {
        return Decision::Switch { to: to.id.clone(), reason: Reason { from_label: current.label.clone(), full: from_full, most_room: false } };
    }

    // Nothing has room under the threshold. The usable accounts past it
    // but not at their limit can still take a turn.
    let usable: Vec<&Candidate> = others.iter().copied()
        .filter(|candidate| candidate.signed_in && candidate.checked && candidate.kind == Kind::Subscription && fresh(candidate, now) && !candidate.lacks_model)
        .collect();
    let at_limit = |candidate: &Candidate| full(candidate, model, threshold, now).is_some_and(|full| full.at_limit);
    let below_limit: Vec<&Candidate> = usable.iter().copied().filter(|candidate| !at_limit(candidate)).collect();
    let best = below_limit.iter().copied().max_by(|a, b| room(a, model, now).total_cmp(&room(b, model, now)));
    let most_room = |best: &Candidate| Decision::Switch { to: best.id.clone(), reason: Reason { from_label: current.label.clone(), full: from_full.clone(), most_room: true } };
    if from_full.at_limit {
        // Its own account cannot go on (a limit error, or a window at 100 %):
        // it has no room, so any account below its limit is better, and an
        // unattended run keeps going.
        if let Some(best) = best {
            return most_room(best);
        }
    } else if let Some(best) = best {
        // Past the threshold but able to go on: no cycling between full
        // accounts. A new session starts where there is the most room; a
        // running tab stays.
        if ask.why == Why::Launch && room(best, model, now) > room(current, model, now) {
            return most_room(best);
        }
        return Decision::Stay(Stay::AllAboveThreshold);
    }
    let earliest_reset = std::iter::once(current).chain(others.iter().copied())
        .filter(|candidate| candidate.checked && candidate.signed_in)
        .filter_map(|candidate| full(candidate, model, threshold, now).and_then(|full| full.resets_at))
        .filter(|reset| *reset > now)
        .min();
    let lacking_model = judged.iter().any(|(_, _, model_only)| *model_only);
    Decision::Stay(Stay::NoneAvailable { full: current_full, earliest_reset, lacking_model })
}

/// The accounts worth polling every minute: within [`HOT_BAND`] points of
/// the threshold, or past it.
pub fn hot(candidates: &[Candidate], threshold: f32, now: i64) -> Vec<String> {
    candidates.iter()
        .filter(|candidate| candidate.checked && candidate.kind == Kind::Subscription)
        .filter(|candidate| used(candidate, None, now) >= threshold - HOT_BAND)
        .map(|candidate| candidate.id.clone())
        .collect()
}

// ------------------------------------------------------------------ memory

/// What a tab remembers between decisions.
#[derive(Clone, Debug, Default)]
pub struct TabMemory {
    /// When it was last switched, automatically or by hand.
    pub last_switch_at: Option<i64>,
    /// It hit its usage limit; a switch is owed once its turn has ended.
    pub limit_pending: bool,
    /// A compaction is running in it.
    pub compacting: bool,
    /// When the person last typed in it (the composer or its terminal).
    pub typed_at: Option<i64>,
    /// The switch just made, while its new account proves itself.
    pub just_switched: Option<JustSwitched>,
    /// When "no account has room" was last said in it.
    pub none_told_at: Option<i64>,
    /// The model its agent last reported.
    pub reported_model: Option<String>,
    /// Since when its held follow-ups wait for a switch being decided, so
    /// the next goes on the account it moves to.
    pub queue_held_at: Option<i64>,
    /// The switch was looked at for this turn's end and did not happen:
    /// held follow-ups go where the tab is, until a new turn starts.
    pub queue_passed: bool,
}

#[derive(Clone, Debug)]
pub struct JustSwitched {
    pub agent: String,
    pub from: String,
    pub to: String,
    pub at: i64,
    /// The model before the switch, to learn a plan that lacks it.
    pub model_before: Option<String>,
    /// The model the tab's own settings ask for (not the agent's default):
    /// the resumed agent is started with it, so another one reported after
    /// the switch is the plan's fallback, not a default of that account.
    pub model_asked: Option<String>,
    /// The switch followed a limit hit: a continue message is owed.
    pub limit_hit: bool,
    /// The one other account already tried after a failure.
    pub retried: bool,
}

/// How long a switch's new account is watched for a refused sign-in.
pub const PROVING_MS: i64 = 2 * 60_000;
/// How long a failed switch keeps an account from being chosen again.
pub const FAILED_MS: i64 = 30 * 60_000;
/// How long a plan seen falling back from a model is kept from it.
pub const LACKS_MS: i64 = 6 * 60 * 60_000;

/// What the runtime remembers about tabs and accounts between decisions.
/// Lost when the runtime restarts, which is safe: each fact only holds a
/// switch back.
#[derive(Debug, Default)]
pub struct Memory {
    pub tabs: HashMap<String, TabMemory>,
    /// (agent, account) → a usage-limit error on it.
    limited: HashMap<(String, String), Limited>,
    /// (agent, account) → left because full.
    left: HashMap<(String, String), Left>,
    /// (agent, account, when) for tabs switched onto it.
    arrivals: Vec<(String, String, i64)>,
    /// (agent, account) whose switch failed: not chosen until signed in again.
    failed: HashMap<(String, String), i64>,
    /// (agent, account) → models its plan fell back from, and when.
    lacks: HashMap<(String, String), HashMap<String, i64>>,
    /// Pane id → when the person last typed into it.
    typed_panes: HashMap<String, i64>,
    /// What the usage store would say, set by a test in its place.
    #[cfg(test)]
    pub usage_for_tests: Option<Vec<crate::status::usage::AccountUsage>>,
}

fn key(agent: &str, id: &str) -> (String, String) {
    (agent.to_string(), id.to_string())
}

impl Memory {
    pub fn tab(&mut self, tab: &str) -> &mut TabMemory {
        self.tabs.entry(tab.to_string()).or_default()
    }

    pub fn limit_hit(&mut self, agent: &str, account: &str, at: i64, resets_at: Option<i64>) {
        self.limited.insert(key(agent, account), Limited { at, resets_at });
    }

    pub fn typed_in_pane(&mut self, pane: &str, at: i64) {
        self.typed_panes.insert(pane.to_string(), at);
    }

    pub fn pane_typed_at(&self, pane: &str) -> Option<i64> {
        self.typed_panes.get(pane).copied()
    }

    /// A switch from `from` to `to` was made in `tab` at `now`.
    pub fn switched(&mut self, tab: &str, agent: &str, from: &str, to: &str, left_reset: Option<i64>, now: i64) {
        self.left.insert(key(agent, from), Left { at: now, resets_at: left_reset });
        self.arrivals.push((agent.into(), to.into(), now));
        self.tab(tab).last_switch_at = Some(now);
    }

    /// The person moved `tab` by hand: it stays there until that account is full.
    pub fn moved_by_hand(&mut self, tab: &str, now: i64) {
        let tab = self.tab(tab);
        tab.last_switch_at = Some(now);
        tab.limit_pending = false;
        tab.just_switched = None;
    }

    /// A switch to `account` failed: its sign-in needs the person.
    pub fn failed(&mut self, agent: &str, account: &str, now: i64) {
        self.failed.insert(key(agent, account), now);
    }

    /// The person moved a tab onto it by hand and it took: it may be chosen again.
    pub fn signed_in(&mut self, agent: &str, account: &str) {
        self.failed.remove(&key(agent, account));
    }

    /// `account`'s plan answered with another model than `model`.
    pub fn lacks(&mut self, agent: &str, account: &str, model: &str, now: i64) {
        self.lacks.entry(key(agent, account)).or_default().insert(model.to_ascii_lowercase(), now);
    }

    pub fn forget_tab(&mut self, tab: &str) {
        self.tabs.remove(tab);
    }

    /// Drop what no longer holds at `now`.
    pub fn prune(&mut self, now: i64) {
        self.arrivals.retain(|(_, _, at)| now - at < ARRIVAL_MS);
        self.limited.retain(|_, limited| limited.resets_at.is_none_or(|reset| reset > now) && now - limited.at < 24 * 60 * 60_000);
        self.left.retain(|_, left| now - left.at < 7 * 24 * 60 * 60_000);
        self.typed_panes.retain(|_, at| now - *at < 60_000);
        // A sign-in renewed in Settings is not seen here: try a failed account again after a while.
        self.failed.retain(|_, at| now - *at < FAILED_MS);
        // A plan can change, and one fallback is thin evidence: learn it again.
        for models in self.lacks.values_mut() {
            models.retain(|_, at| now - *at < LACKS_MS);
        }
        self.lacks.retain(|_, models| !models.is_empty());
    }

    /// What a candidate of `agent` carries from memory.
    pub fn annotate(&self, agent: &str, candidate: &mut Candidate, model: Option<&str>, now: i64) {
        let k = key(agent, &candidate.id);
        candidate.limited = self.limited.get(&k).copied();
        candidate.left = self.left.get(&k).copied();
        candidate.arrivals = self.arrivals.iter().filter(|(of, id, at)| of == agent && *id == candidate.id && now - at < ARRIVAL_MS).count() as u32;
        if self.failed.contains_key(&k) {
            candidate.signed_in = false;
        }
        if let Some(model) = model {
            candidate.lacks_model = self.lacks.get(&k).and_then(|models| models.get(&model.to_ascii_lowercase())).is_some_and(|at| now - at < LACKS_MS);
        }
    }
}

// --------------------------------------------------------------------- log

/// What a log line records.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    /// A running tab moved to another account.
    Switched,
    /// A new session or tab started on another account than it would have.
    Started,
    /// No account had room.
    NoneAvailable,
    /// A switch was tried and did not work.
    Failed,
}

/// One line of the switch log. Labels and ids only, never a token.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// Milliseconds since the epoch.
    pub at: i64,
    pub agent: String,
    pub session_id: String,
    pub tab_id: String,
    /// The session's title when it was written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub from: String,
    pub from_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_label: Option<String>,
    pub outcome: Outcome,
    pub reason: String,
}

pub fn log_path(root: &Path) -> PathBuf {
    root.join(LOG_FILE)
}

fn log_lock() -> &'static std::sync::Mutex<()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    &LOCK
}

/// The log's lines in `root`, oldest first, those within [`LOG_DAYS`] of `now`.
pub fn read_log_in(root: &Path, now: i64) -> Vec<LogEntry> {
    let Ok(text) = std::fs::read_to_string(log_path(root)) else { return Vec::new() };
    let horizon = now - LOG_DAYS * 24 * 60 * 60_000;
    text.lines().filter_map(|line| serde_json::from_str::<LogEntry>(line).ok()).filter(|entry| entry.at >= horizon).collect()
}

/// Add `entry` to the log in `root`, dropping lines older than [`LOG_DAYS`].
pub fn append_log_in(root: &Path, entry: &LogEntry) -> Result<()> {
    let _held = log_lock().lock().unwrap_or_else(|error| error.into_inner());
    let mut entries = read_log_in(root, entry.at);
    entries.push(entry.clone());
    let mut text = String::new();
    for entry in &entries {
        text.push_str(&serde_json::to_string(entry)?);
        text.push('\n');
    }
    crate::store::write_atomic(&log_path(root), text.as_bytes())
}

/// The switch log of this Mac, newest first.
pub fn read_log(now: i64) -> Result<Vec<LogEntry>> {
    let mut entries = read_log_in(&crate::store::root()?, now);
    entries.reverse();
    Ok(entries)
}

pub fn append_log(entry: &LogEntry) {
    match crate::store::root() {
        Ok(root) => {
            if let Err(error) = append_log_in(&root, entry) {
                log::warn!("write the account switch log: {error:#}");
            }
        }
        Err(error) => log::warn!("write the account switch log: {error:#}"),
    }
}

#[cfg(test)]
#[path = "auto_switch_tests.rs"]
mod tests;
