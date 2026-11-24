//! Switch accounts automatically (#981): the runtime's part.
//!
//! [`crate::agent_accounts::auto_switch::decide`] says whether a tab moves
//! and where; this gathers what it reads (the setting, each account's usage
//! as the usage store last polled it, what the runtime remembers about tabs
//! and accounts) and carries out what it says, with #980's own switch
//! ([`SessionManager::switch_account`]'s restart and resume). Nothing here
//! restarts an agent any other way.
//!
//! When it is asked:
//! - a tab's turn has ended ([`SessionManager::account_switch_after_turn`]);
//! - a tab hit its usage limit, at once if its turn is already over;
//! - every half minute, for every running tab of an agent that has it on
//!   ([`SessionManager::start_account_switching`], the runtime's own loop:
//!   it keeps going with the desktop window closed);
//! - a new session or tab is starting ([`SessionManager::launch_account`]).
//!
//! A running tab is never switched in a turn, while it waits on a permission
//! or a question, while it compacts, while the person is typing in it, or
//! (between turns) while a background task it started is still out.

use super::*;
use crate::agent_accounts::auto_switch::{self, Candidate, Decision, Outcome, Stay, Why};
use crate::agent_accounts::{Kind, LOCAL};
use crate::agent_keys::Agent;

/// A tab the person typed in this recently is left alone.
const TYPING_QUIET_MS: i64 = 20_000;
/// How often the runtime looks at every running tab.
const LOOP_INTERVAL: Duration = Duration::from_secs(30);
/// A turn's end is looked at a moment later: whatever the turn's end itself
/// restarts or delivers goes first.
const AFTER_TURN: Duration = Duration::from_millis(1_500);
/// Held follow-ups wait for a switch being decided at most this long.
const QUEUE_HOLD_MS: i64 = 2 * 60_000;
/// A switch this recent is the one a held queue waited for.
const JUST_NOW_MS: i64 = 10_000;
/// "No account has room" is said again in a tab no sooner than this.
const NONE_TOLD_AGAIN_MS: i64 = 30 * 60_000;
/// The event the desktop raises its notifications from.
pub const NOTICE_EVENT: &str = "account_switch";

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// What a switch, or the lack of one, tells the desktop: it raises a
/// notification for a tab out of view, if the setting asks for one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwitchNotice {
    pub session_id: String,
    pub tab_id: String,
    pub agent: String,
    pub outcome: Outcome,
    /// The conversation line, as the tab shows it.
    pub text: String,
    /// The setting asks for a notification of this.
    pub notify: bool,
}

/// The account a new session or tab of an agent would start on now, and
/// why, for the launch settings (#981).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchChoice {
    pub account: String,
    pub label: String,
    /// Why it is not the one asked for, or `None` when it is.
    pub reason: Option<String>,
}

/// One agent's accounts and setting, while the setting is on and offered.
struct Switching {
    agent: Agent,
    setting: auto_switch::Setting,
    listed: Vec<auto_switch::Listed>,
}

impl Switching {
    /// `harness`'s, when its automatic switching is on and offered.
    fn of(harness: &str) -> Option<Self> {
        let agent = Agent::of(harness)?;
        let store = crate::agent_keys::store().ok()?;
        let entry = store.entry(agent).ok()?;
        let setting = entry.auto_switch.clone().filter(|setting| setting.enabled)?;
        let view = crate::agent_accounts::list_in(&store, agent).ok()?;
        if !view.auto_switch.offered {
            return None;
        }
        Some(Self { agent, listed: auto_switch::ordered(&setting, &view.accounts), setting })
    }

    fn label(&self, id: &str) -> String {
        self.listed.iter().find(|listed| listed.id == id).map_or_else(|| id.to_string(), |listed| listed.label.clone())
    }
}

/// What a tab's switch needs to know about it, read off its runtime.
struct TabFacts {
    harness: String,
    project: Option<String>,
    title: String,
    current: String,
    model: Option<String>,
    /// The model the tab's settings ask for, if not the agent's default.
    model_asked: Option<String>,
}

impl SessionManager {
    /// The memory automatic switching keeps between decisions.
    fn switch_memory(&self) -> MutexGuard<'_, auto_switch::Memory> {
        self.account_switch.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// The tab's account changed: every window draws its account mark again.
    fn tab_account_changed(&self, session_id: &str) {
        match index::get(session_id) {
            Ok(entry) => self.sink.emit("session_updated", &entry),
            Err(error) => log::warn!("read {session_id} after its account changed: {error:#}"),
        }
    }

    /// The person typed in the composer of `tab` (#981): it is not switched for a little while.
    pub fn note_typing(&self, session_id: &str, tab_id: &str) {
        self.switch_memory().tab(&key_of(session_id, tab_id)).typed_at = Some(now_ms());
    }

    /// The person typed into terminal `pane`: its tab is not switched for a little while.
    pub(crate) fn note_pane_typing(&self, pane: &str) {
        self.switch_memory().typed_in_pane(pane, now_ms());
    }

    /// The person moved `tab` to another account by hand: it stays there
    /// until that account is full, and anything owed to the last is forgotten.
    pub(super) fn account_moved_by_hand(&self, session_id: &str, tab_id: &str, account: &str) {
        let mut memory = self.switch_memory();
        memory.moved_by_hand(&key_of(session_id, tab_id), now_ms());
        // The person chose it, and its restart went through: a failure
        // remembered against it no longer keeps it from being chosen.
        if let Some(agent) = index::get(session_id).ok().and_then(|entry| entry.tabs.iter().find(|tab| tab.id == tab_id).map(|tab| tab.harness.clone())) {
            memory.signed_in(&agent, account);
        }
    }

    /// Each of `switching`'s accounts as a decision sees it, in the setting's order.
    fn switch_candidates(&self, switching: &Switching, model: Option<&str>, now: i64) -> Vec<Candidate> {
        #[cfg(test)]
        let usage = self.switch_memory().usage_for_tests.clone().unwrap_or_else(|| self.status.usage.accounts_now());
        #[cfg(not(test))]
        let usage = self.status.usage.accounts_now();
        let memory = self.switch_memory();
        switching.listed.iter().map(|listed| {
            let read = usage.iter().find(|account| account.agent == switching.agent.id() && account.usage.account_id == listed.id);
            let mut candidate = Candidate {
                id: listed.id.clone(),
                label: listed.label.clone(),
                kind: listed.kind,
                signed_in: listed.signed_in,
                checked: listed.used,
                windows: read.map(|account| account.usage.windows.clone()).unwrap_or_default(),
                unreadable: listed.kind == Kind::Subscription && read.is_none_or(|account| account.usage.error.is_some() && account.usage.windows.is_empty()),
                limited: None,
                left: None,
                lacks_model: false,
                arrivals: 0,
            };
            memory.annotate(switching.agent.id(), &mut candidate, model, now);
            candidate
        }).collect()
    }

    // ------------------------------------------------------------ launches

    /// The account a new launch of `harness` in `project` starts on when
    /// automatic switching moves it off `asked` (or the defaults' choice),
    /// and why. `None`: it starts where it would have.
    fn launch_decision(&self, harness: &str, project: Option<&str>, asked: Option<&str>, last_switch_at: Option<i64>) -> Option<(Switching, String, String, auto_switch::Reason)> {
        let switching = Switching::of(harness)?;
        if !switching.setting.switches_in(project) {
            return None;
        }
        let entry = crate::agent_keys::store().ok()?.entry(switching.agent).ok()?;
        let current = crate::agent_accounts::choose(&entry, asked, project);
        let now = now_ms();
        let candidates = self.switch_candidates(&switching, None, now);
        let decision = auto_switch::decide(&auto_switch::Ask {
            why: Why::Launch,
            current: &current,
            model: None,
            candidates: &candidates,
            threshold: switching.setting.threshold(),
            order: switching.setting.order,
            last_switch_at,
            now,
        });
        match decision {
            Decision::Switch { to, reason } => Some((switching, current, to, reason)),
            Decision::Stay(_) => None,
        }
    }

    /// What the launch settings show (#981): the account a new session of
    /// `harness` in `project`, asking for `asked`, starts on, and why when
    /// automatic switching chose another. `None` with the setting off.
    pub fn launch_account_choice(&self, harness: &str, project: Option<&str>, asked: Option<&str>) -> Option<LaunchChoice> {
        let (switching, _current, to, reason) = self.launch_decision(harness, project, asked, None)?;
        Some(LaunchChoice { label: switching.label(&to), account: to, reason: Some(reason.text(true)) })
    }

    /// The account a tab starting now runs on (#981): `asked`, or another
    /// when automatic switching finds `asked` (or the default it stands for)
    /// full. A move is recorded on the tab, written in the switch log and
    /// returned with the line its conversation shows.
    pub(super) fn launch_account(&self, session_id: &str, tab_id: &str, harness: &str, project: Option<&str>, title: &str, asked: Option<String>) -> (Option<String>, Option<String>) {
        let key = key_of(session_id, tab_id);
        let last = self.switch_memory().tabs.get(&key).and_then(|tab| tab.last_switch_at);
        // A tab switched lately keeps the account it was switched to.
        if last.is_some_and(|at| now_ms() - at < auto_switch::COOLDOWN_MS) {
            return (asked, None);
        }
        let Some((switching, from, to, reason)) = self.launch_decision(harness, project, asked.as_deref(), last) else { return (asked, None) };
        let (from_label, to_label) = (switching.label(&from), switching.label(&to));
        let text = format!("Started on {to_label}: {}.", reason.text(true));
        if let Err(error) = index::update_tab(session_id, tab_id, |tab| {
            crate::session_ops::set_tab_account(tab, Some(&to));
            Ok(())
        }) {
            log::warn!("record the account {session_id}/{tab_id} starts on: {error:#}");
        } else {
            self.tab_account_changed(session_id);
        }
        let now = now_ms();
        self.switch_memory().switched(&key, switching.agent.id(), &from, &to, None, now);
        // Not a switch of a running tab: no pause before the next.
        self.switch_memory().tab(&key).last_switch_at = last;
        auto_switch::append_log(&auto_switch::LogEntry {
            at: now, agent: switching.agent.id().into(), session_id: session_id.into(), tab_id: tab_id.into(), title: Some(title.into()),
            from, from_label, to: Some(to.clone()), to_label: Some(to_label), outcome: Outcome::Started, reason: reason.text(true),
        });
        (Some(to), Some(text))
    }

    // ------------------------------------------------------- running tabs

    /// What a payload of a tab's own agent tells automatic switching:
    /// compaction starting and ending, the model it reports, a usage limit,
    /// a refused sign-in just after a switch. Called with the tab's lock
    /// held, so it only notes things; anything it starts runs off the lock.
    pub(super) fn account_switch_observe(&self, rt: &TabRuntime, payload: &Payload) {
        let key = key_of(&rt.session_id, &rt.tab_id);
        let now = now_ms();
        match payload {
            Payload::ContextCompactionStarted => { self.switch_memory().tab(&key).compacting = true; }
            Payload::ContextCompacted { .. } | Payload::TurnCompleted { .. } => { self.switch_memory().tab(&key).compacting = false; }
            // The person, or a run, prompted the tab: a limit hit before is
            // no longer owed a switch, and its next end is looked at afresh.
            Payload::UserMessage { queued: false, .. } => {
                let mut memory = self.switch_memory();
                let tab = memory.tab(&key);
                if tab.just_switched.as_ref().is_none_or(|just| now - just.at > JUST_NOW_MS) {
                    tab.limit_pending = false;
                }
                tab.queue_passed = false;
            }
            Payload::TurnStarted { model: Some(model), .. } | Payload::UsageUpdate(crate::events::Usage { model: Some(model), .. }) => {
                self.account_model_reported(&key, model, now);
            }
            _ => {}
        }
        match recovery::failure(payload) {
            Some(RecoveryKind::UsageLimit) => {
                let resets_at = match payload {
                    Payload::RateLimited { resets_at, .. } => resets_at.and_then(|at| i64::try_from(at).ok()),
                    _ => None,
                };
                self.account_limit_hit(rt, resets_at, now);
            }
            Some(RecoveryKind::SignedOut) => {
                let proving = self.switch_memory().tabs.get(&key).and_then(|tab| tab.just_switched.clone()).filter(|just| now - just.at < auto_switch::PROVING_MS);
                if let Some(just) = proving {
                    let (manager, session, tab) = (self.clone(), rt.session_id.clone(), rt.tab_id.clone());
                    std::thread::spawn(move || {
                        std::thread::sleep(AFTER_TURN);
                        manager.switch_failed(&session, &tab, just, "its sign-in was refused");
                    });
                }
            }
            _ => {}
        }
    }

    /// The model `tab`'s agent reports. After a switch, one other than the
    /// model before says the new account's plan lacks that one, but only
    /// when the tab's settings ask for a model: the resumed agent was then
    /// started with it, so the account's own `/model` default cannot explain
    /// the change. The lesson expires ([`auto_switch::LACKS_MS`]).
    fn account_model_reported(&self, key: &str, model: &str, now: i64) {
        let mut memory = self.switch_memory();
        let tab = memory.tab(key);
        let learned = tab.just_switched.as_ref()
            .filter(|just| now - just.at < auto_switch::PROVING_MS && just.model_asked.is_some())
            .and_then(|just| just.model_before.as_ref().filter(|before| !before.eq_ignore_ascii_case(model)).map(|before| (just.agent.clone(), just.to.clone(), before.clone())));
        tab.reported_model = Some(model.to_string());
        if let Some((agent, account, before)) = learned {
            memory.lacks(&agent, &account, &before, now);
        }
    }

    /// `rt`'s agent hit its usage limit: its account is full whatever the
    /// polled numbers say, and the tab is owed a switch once its turn is over.
    fn account_limit_hit(&self, rt: &TabRuntime, resets_at: Option<i64>, now: i64) {
        let Some(agent) = Agent::of(&rt.harness) else { return };
        let account = index::get(&rt.session_id).ok()
            .and_then(|entry| entry.tab(&rt.tab_id).and_then(crate::session_ops::tab_running_account).map(str::to_owned))
            .unwrap_or_else(|| LOCAL.into());
        {
            let mut memory = self.switch_memory();
            memory.limit_hit(agent.id(), &account, now, resets_at);
            memory.tab(&key_of(&rt.session_id, &rt.tab_id)).limit_pending = true;
        }
        if !rt.turn_open {
            self.account_switch_soon(&rt.session_id, &rt.tab_id);
        }
    }

    /// Whether `rt`'s held follow-ups wait (#981): a switch is owed at this
    /// turn's end (its account hit its limit, or is full), so the next one
    /// is sent once the tab is on the account it moves to. Asked, under the
    /// tab's lock, before held follow-ups are scheduled and delivered; a
    /// hold starts the switch at once when the turn is over, and the queue
    /// is let go when the switch is decided ([`Self::account_switch_settled`]).
    pub(super) fn account_switch_holds_queue(&self, rt: &TabRuntime) -> bool {
        // "Send now": the person's choice goes where the tab is.
        if rt.held_queue.next.is_some() || !matches!(rt.engine, Engine::Cli(_) | Engine::CodexStdio(_)) {
            return false;
        }
        let key = key_of(&rt.session_id, &rt.tab_id);
        let now = now_ms();
        let (limit_pending, last_switch_at, reported) = {
            let memory = self.switch_memory();
            let tab = memory.tabs.get(&key);
            if tab.is_some_and(|tab| tab.queue_passed) {
                return false;
            }
            if tab.and_then(|tab| tab.queue_held_at).is_some_and(|at| now - at < QUEUE_HOLD_MS) {
                return true;
            }
            (tab.is_some_and(|tab| tab.limit_pending), tab.and_then(|tab| tab.last_switch_at), tab.and_then(|tab| tab.reported_model.clone()))
        };
        let Some(switching) = Switching::of(&rt.harness) else { return false };
        let Ok(entry) = index::get(&rt.session_id) else { return false };
        if !switching.setting.switches_in(crate::session_ops::project_key(&entry)) {
            return false;
        }
        let owed = limit_pending || entry.tab(&rt.tab_id).is_some_and(|tab| {
            let model = reported.or_else(|| (!tab.model.is_empty() && tab.model != "default").then(|| tab.model.clone()));
            let candidates = self.switch_candidates(&switching, model.as_deref(), now);
            matches!(auto_switch::decide(&auto_switch::Ask {
                why: Why::Between,
                current: crate::session_ops::tab_running_account(tab).unwrap_or(LOCAL),
                model: model.as_deref(),
                candidates: &candidates,
                threshold: switching.setting.threshold(),
                order: switching.setting.order,
                last_switch_at,
                now,
            }), Decision::Switch { .. })
        });
        if !owed {
            return false;
        }
        self.switch_memory().tab(&key).queue_held_at = Some(now);
        if !rt.turn_open {
            let (manager, session, tab) = (self.clone(), rt.session_id.clone(), rt.tab_id.clone());
            std::thread::spawn(move || manager.consider_account_switch(&session, &tab));
        }
        true
    }

    /// A switch held `tab`'s follow-ups and is now decided: let them go. Not
    /// switched, they go where the tab is. Switched, they go on the new
    /// account once its agent is back (after the `continue` a limit hit is
    /// owed): the restart's own end schedules them, or this does when the
    /// restart is over already.
    fn account_switch_settled(&self, session_id: &str, tab_id: &str) {
        let key = key_of(session_id, tab_id);
        let now = now_ms();
        let switched = {
            let mut memory = self.switch_memory();
            let Some(tab) = memory.tabs.get_mut(&key) else { return };
            if tab.queue_held_at.take().is_none() {
                return;
            }
            let switched = tab.just_switched.as_ref().is_some_and(|just| now - just.at < JUST_NOW_MS);
            if !switched {
                tab.queue_passed = true;
            }
            switched
        };
        let Ok(rt_arc) = self.runtime(session_id, tab_id) else { return };
        let rt = rt_arc.lock().unwrap();
        // A restart still under way would refuse them: its end schedules them.
        if switched && (rt.restart_claim.is_some() || rt.stdio_starting) {
            return;
        }
        self.schedule_held(&rt);
    }

    /// A turn of `rt`'s agent has ended: whether it moves is looked at
    /// shortly, off the tab's lock, when its agent has the setting on.
    pub(super) fn account_switch_after_turn(&self, rt: &TabRuntime) {
        if Switching::of(&rt.harness).is_some() {
            self.account_switch_soon(&rt.session_id, &rt.tab_id);
        }
    }

    fn account_switch_soon(&self, session_id: &str, tab_id: &str) {
        let (manager, session, tab) = (self.clone(), session_id.to_string(), tab_id.to_string());
        std::thread::spawn(move || {
            std::thread::sleep(AFTER_TURN);
            manager.consider_account_switch(&session, &tab);
        });
    }

    /// Whether `tab` moves to another account now, and if so, move it.
    pub(crate) fn consider_account_switch(&self, session_id: &str, tab_id: &str) {
        if let Err(error) = self.try_account_switch(session_id, tab_id, false) {
            log::warn!("automatic account switch of {session_id}/{tab_id}: {error:#}");
        }
        self.account_switch_settled(session_id, tab_id);
    }

    /// What `tab` is, when it may be switched now; `None` when it is busy
    /// or not a tab that switches.
    fn switchable(&self, session_id: &str, tab_id: &str, limit_hit: bool) -> Result<Option<TabFacts>> {
        let key = key_of(session_id, tab_id);
        let Some(rt_arc) = self.tabs.lock().unwrap().get(&key).cloned() else { return Ok(None) };
        let pane = {
            let rt = rt_arc.lock().unwrap();
            // A turn, a permission or a question, a stop, a restart, a CLI started by hand.
            let asking = !rt.pending.is_empty() || (rt.status == TabStatus::Waiting && rt.recovery.is_none());
            if rt.turn_open || asking || rt.stopping || rt.restart_claim.is_some() || Self::by_hand_refusal(&rt, "its account").is_some() {
                return Ok(None);
            }
            match &rt.engine {
                Engine::Cli(cli) => Some(cli.pane_id.clone()),
                Engine::CodexStdio(_) => None,
                _ => return Ok(None),
            }
        };
        let now = now_ms();
        {
            let memory = self.switch_memory();
            let tab = memory.tabs.get(&key);
            if tab.is_some_and(|tab| tab.compacting) { return Ok(None); }
            let typed = tab.and_then(|tab| tab.typed_at).into_iter().chain(pane.as_deref().and_then(|pane| memory.pane_typed_at(pane))).max();
            if typed.is_some_and(|at| now - at < TYPING_QUIET_MS) { return Ok(None); }
        }
        // Between turns, a sub-agent or background task it started waits;
        // a limit hit has stopped it already.
        if !limit_hit && self.background_work(session_id, tab_id).is_some() {
            return Ok(None);
        }
        let entry = index::get(session_id)?;
        let tab = entry.tab(tab_id).context("tab gone")?;
        let reported = self.switch_memory().tabs.get(&key).and_then(|tab| tab.reported_model.clone());
        let model_asked = (!tab.model.is_empty() && tab.model != "default").then(|| tab.model.clone());
        Ok(Some(TabFacts {
            harness: tab.harness.clone(),
            project: crate::session_ops::project_key(&entry).map(str::to_owned),
            title: entry.title.clone(),
            current: crate::session_ops::tab_running_account(tab).unwrap_or(LOCAL).to_string(),
            model: reported.or_else(|| model_asked.clone()),
            model_asked,
        }))
    }

    /// `retry`: the one more account tried after a switch failed.
    fn try_account_switch(&self, session_id: &str, tab_id: &str, retry: bool) -> Result<()> {
        let key = key_of(session_id, tab_id);
        let limit_hit = self.switch_memory().tabs.get(&key).is_some_and(|tab| tab.limit_pending);
        let Some(facts) = self.switchable(session_id, tab_id, limit_hit)? else { return Ok(()) };
        // Off, or never in this project: nothing switches, and nothing is owed.
        let Some(switching) = Switching::of(&facts.harness).filter(|switching| switching.setting.switches_in(facts.project.as_deref())) else {
            self.switch_memory().tab(&key).limit_pending = false;
            return Ok(());
        };
        let now = now_ms();
        let candidates = self.switch_candidates(&switching, facts.model.as_deref(), now);
        let last_switch_at = self.switch_memory().tabs.get(&key).and_then(|tab| tab.last_switch_at);
        let decision = auto_switch::decide(&auto_switch::Ask {
            why: if limit_hit { Why::LimitHit } else { Why::Between },
            current: &facts.current,
            model: facts.model.as_deref(),
            candidates: &candidates,
            threshold: switching.setting.threshold(),
            order: switching.setting.order,
            last_switch_at: if retry { None } else { last_switch_at },
            now,
        });
        match decision {
            Decision::Switch { to, reason } => self.switch_tab_now(session_id, tab_id, &switching, &facts, &to, &reason, limit_hit, retry, last_switch_at),
            Decision::Stay(Stay::NoneAvailable { full, earliest_reset, lacking_model }) if limit_hit => {
                self.none_available(session_id, tab_id, &switching, &facts, full, earliest_reset, lacking_model);
                Ok(())
            }
            Decision::Stay(_) => Ok(()),
        }
    }

    /// Move `tab` to account `to` with #980's switch, and say so.
    #[allow(clippy::too_many_arguments)]
    fn switch_tab_now(&self, session_id: &str, tab_id: &str, switching: &Switching, facts: &TabFacts, to: &str, reason: &auto_switch::Reason, limit_hit: bool, retry: bool, last_switch_at: Option<i64>) -> Result<()> {
        let key = key_of(session_id, tab_id);
        let agent = switching.agent.id();
        let (from_label, to_label) = (switching.label(&facts.current), switching.label(to));
        let now = now_ms();
        {
            let mut memory = self.switch_memory();
            memory.switched(&key, agent, &facts.current, to, reason.full.resets_at, now);
            let tab = memory.tab(&key);
            tab.limit_pending = false;
            tab.just_switched = Some(auto_switch::JustSwitched {
                agent: agent.into(), from: facts.current.clone(), to: to.into(), at: now,
                model_before: tab.reported_model.clone(), model_asked: facts.model_asked.clone(), limit_hit, retried: retry,
            });
        }
        let log = |outcome: Outcome, reason: String, to: Option<(&str, &str)>| auto_switch::append_log(&auto_switch::LogEntry {
            at: now_ms(), agent: agent.into(), session_id: session_id.into(), tab_id: tab_id.into(), title: Some(facts.title.clone()),
            from: facts.current.clone(), from_label: from_label.clone(), to: to.map(|(id, _)| id.to_string()), to_label: to.map(|(_, label)| label.to_string()), outcome, reason,
        });
        if let Err(error) = self.switch_account_on(session_id, tab_id, to) {
            log::warn!("automatic switch of {session_id}/{tab_id} to account {to}: {error:#}");
            log(Outcome::Failed, format!("{to_label} could not take the conversation over"), Some((to, &to_label)));
            {
                let mut memory = self.switch_memory();
                memory.failed(agent, to, now);
                let tab = memory.tab(&key);
                tab.last_switch_at = last_switch_at;
                tab.just_switched = None;
                tab.limit_pending = limit_hit;
            }
            // Back on the account it was on, as it was; then the next one, once.
            let _ = index::update_tab(session_id, tab_id, |tab| {
                crate::session_ops::set_tab_account(tab, Some(&facts.current));
                Ok(())
            });
            self.tab_account_changed(session_id);
            if !retry {
                return self.try_account_switch(session_id, tab_id, true);
            }
            return Ok(());
        }
        self.tab_account_changed(session_id);
        let text = format!("Switched from {from_label} to {to_label}: {}.", reason.text(false));
        if let Err(error) = self.publish_external(session_id, tab_id, Payload::Status { text: text.clone(), handoff: None }) {
            log::warn!("note the account switch in {session_id}/{tab_id}: {error:#}");
        }
        log(Outcome::Switched, reason.text(false), Some((to, &to_label)));
        self.sink.emit(NOTICE_EVENT, &SwitchNotice {
            session_id: session_id.into(), tab_id: tab_id.into(), agent: agent.into(), outcome: Outcome::Switched, text, notify: switching.setting.notify_switch,
        });
        if limit_hit {
            // The turn the limit stopped goes on, with nobody there to ask it to.
            if let Err(error) = self.send(session_id, tab_id, crate::recovery::CONTINUE_PROMPT.into(), Vec::new()) {
                log::warn!("continue {session_id}/{tab_id} after the account switch: {error:#}");
            }
        }
        Ok(())
    }

    /// The account a tab was just switched to did not hold (its sign-in was
    /// refused): it is marked as needing sign-in, the next account is tried
    /// once, and with none the tab goes back to the account it was on.
    fn switch_failed(&self, session_id: &str, tab_id: &str, just: auto_switch::JustSwitched, why: &str) {
        let key = key_of(session_id, tab_id);
        let now = now_ms();
        {
            let mut memory = self.switch_memory();
            memory.failed(&just.agent, &just.to, now);
            let tab = memory.tab(&key);
            if tab.just_switched.as_ref().is_none_or(|current| current.at != just.at) {
                return;
            }
            tab.just_switched = None;
            tab.limit_pending = just.limit_hit;
        }
        let Some(switching) = Switching::of(just.agent.as_str()) else { return };
        let (from_label, to_label) = (switching.label(&just.from), switching.label(&just.to));
        let title = index::get(session_id).map(|entry| entry.title).unwrap_or_default();
        auto_switch::append_log(&auto_switch::LogEntry {
            at: now, agent: just.agent.clone(), session_id: session_id.into(), tab_id: tab_id.into(), title: Some(title),
            from: just.from.clone(), from_label: from_label.clone(), to: Some(just.to.clone()), to_label: Some(to_label.clone()), outcome: Outcome::Failed,
            reason: format!("{to_label}: {why}; it needs signing in again"),
        });
        if just.retried {
            self.switch_back(session_id, tab_id, &just, &from_label, &to_label);
            return;
        }
        let _ = self.publish_external(session_id, tab_id, Payload::Status { text: format!("{to_label} needs signing in again, so this tab could not continue on it."), handoff: None });
        // The tab is on the failed account now: decide again as if from the
        // one it left, without the pause a switch starts.
        let _ = index::update_tab(session_id, tab_id, |tab| {
            crate::session_ops::set_tab_account(tab, Some(&just.from));
            crate::session_ops::set_launched_account(tab, &just.from);
            Ok(())
        });
        match self.try_account_switch(session_id, tab_id, true) {
            Ok(()) if self.switch_memory().tabs.get(&key).is_some_and(|tab| tab.just_switched.is_some()) => {}
            Ok(()) => self.switch_back(session_id, tab_id, &just, &from_label, &to_label),
            Err(error) => {
                log::warn!("retry the account switch of {session_id}/{tab_id}: {error:#}");
                self.switch_back(session_id, tab_id, &just, &from_label, &to_label);
            }
        }
    }

    /// Put `tab` back on the account it was switched from.
    fn switch_back(&self, session_id: &str, tab_id: &str, just: &auto_switch::JustSwitched, from_label: &str, to_label: &str) {
        if let Err(error) = self.switch_account_on(session_id, tab_id, &just.from) {
            log::warn!("return {session_id}/{tab_id} to its account: {error:#}");
        }
        self.tab_account_changed(session_id);
        let _ = self.publish_external(session_id, tab_id, Payload::Status { text: format!("{to_label} could not continue this conversation. Back on {from_label}."), handoff: None });
    }

    /// No account has room for a tab at its limit: say so once, with the
    /// soonest reset, in the conversation, the log and a notification.
    #[allow(clippy::too_many_arguments)]
    fn none_available(&self, session_id: &str, tab_id: &str, switching: &Switching, facts: &TabFacts, full: Option<auto_switch::Full>, earliest_reset: Option<i64>, lacking_model: bool) {
        let key = key_of(session_id, tab_id);
        let now = now_ms();
        {
            let mut memory = self.switch_memory();
            let tab = memory.tab(&key);
            if tab.none_told_at.is_some_and(|at| now - at < NONE_TOLD_AGAIN_MS) {
                return;
            }
            tab.none_told_at = Some(now);
        }
        let label = switching.label(&facts.current);
        let reset = earliest_reset.and_then(chrono::DateTime::from_timestamp_millis)
            .map(|at| at.with_timezone(&chrono::Local).format("%a %-d %b, %H:%M").to_string());
        let mut text = format!("No other {} account has room", switching.agent.label());
        if lacking_model {
            text.push_str(" for this conversation's model");
        }
        match reset {
            Some(reset) => text.push_str(&format!(". The earliest limit resets {reset}.")),
            None => text.push('.'),
        }
        let reason = full.map_or_else(|| format!("{label} is full"), |full| auto_switch::Reason { from_label: label.clone(), full, most_room: false }.text(false));
        let _ = self.publish_external(session_id, tab_id, Payload::Status { text: text.clone(), handoff: None });
        auto_switch::append_log(&auto_switch::LogEntry {
            at: now, agent: switching.agent.id().into(), session_id: session_id.into(), tab_id: tab_id.into(), title: Some(facts.title.clone()),
            from: facts.current.clone(), from_label: label, to: None, to_label: None, outcome: Outcome::NoneAvailable, reason,
        });
        self.sink.emit(NOTICE_EVENT, &SwitchNotice {
            session_id: session_id.into(), tab_id: tab_id.into(), agent: switching.agent.id().into(), outcome: Outcome::NoneAvailable, text, notify: switching.setting.notify_none_left,
        });
    }

    // ---------------------------------------------------------------- loop

    /// The runtime's own look at every running tab, every half minute while
    /// any agent has automatic switching on: accounts near their threshold
    /// are polled every minute, and each running tab is asked whether it
    /// moves. It ends with the runtime.
    pub fn start_account_switching(&self) {
        let manager = self.clone();
        let spawned = std::thread::Builder::new().name("account-switching".into()).spawn(move || {
            while !manager.shutting_down.load(std::sync::atomic::Ordering::Acquire) {
                std::thread::sleep(LOOP_INTERVAL);
                manager.account_switch_pass();
            }
        });
        if let Err(error) = spawned {
            log::warn!("start automatic account switching: {error}");
        }
    }

    fn account_switch_pass(&self) {
        let now = now_ms();
        self.switch_memory().prune(now);
        let mut on = Vec::new();
        for agent in [Agent::Claude, Agent::Codex] {
            let hot = match Switching::of(agent.id()) {
                Some(switching) => {
                    let candidates = self.switch_candidates(&switching, None, now);
                    on.push(agent.id());
                    auto_switch::hot(&candidates, switching.setting.threshold(), now).into_iter().collect()
                }
                None => std::collections::HashSet::new(),
            };
            self.status.usage.set_hot(agent.id(), hot);
        }
        if on.is_empty() {
            return;
        }
        self.refresh_usage(false);
        let running = self.running_tabs();
        {
            // A tab no longer running keeps only what its next start needs: its pause after a switch.
            let live: std::collections::HashSet<String> = running.iter().map(|tab| key_of(&tab.session_id, &tab.tab_id)).collect();
            let mut memory = self.switch_memory();
            let gone: Vec<String> = memory.tabs.iter()
                .filter(|(key, tab)| !live.contains(*key) && !tab.limit_pending && tab.last_switch_at.is_none_or(|at| now - at >= auto_switch::COOLDOWN_MS))
                .map(|(key, _)| key.clone())
                .collect();
            for key in gone {
                memory.forget_tab(&key);
            }
        }
        for tab in running {
            if on.iter().any(|agent| Agent::of(&tab.harness).is_some_and(|of| of.id() == *agent)) {
                self.consider_account_switch(&tab.session_id, &tab.tab_id);
            }
        }
    }
}

// Its Claude Code is a stand-in `#!/bin/sh` CLI.
#[cfg(test)]
#[path = "session_account_switch_tests.rs"]
mod tests;
