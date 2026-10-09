//! A tab's model and effort, kept in step from both sides (#404).
//!
//! The chat and the terminal are two views of one conversation, and the
//! model and effort can be changed from either: the composer's pickers, or
//! the CLI's own `/model`. So a tab holds two things, not one:
//!
//! - the **effective** value: what the provider process is running now, and
//!   so what the next prompt will run with. Every view draws this.
//! - the **requested** value: what the app asked for and the provider has
//!   not confirmed yet. It is drawn as pending, never as current.
//!
//! Two things move them. The app *requests* a change, and how that lands is
//! the harness's to say ([`Apply`]). The provider *signals* what it is
//! running ([`Signal`]), whoever changed it: that is the only thing that
//! moves the effective value while a process is up.
//!
//! Every harness has to answer both halves. [`HarnessId::settings`] has no
//! catch-all arm, so a new harness does not compile until it says how it
//! takes a change, and [`Signal`] is the one way any of them reports back.
//!
//! The permission mode is held the same way (#417), with two differences.
//! Neither CLI takes a mode from the app while it runs, so a change from the
//! chat is always a restart, and waits for a turn that is open. And what a
//! provider reports is its own [`Stance`], not one of the app's modes: which
//! mode that makes the tab is each harness's to say.

use serde::{Deserialize, Serialize};

use super::HarnessId;
use crate::models::Model;
use crate::store::index::TabEntry;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Setting {
    Model,
    Effort,
}

impl Setting {
    pub fn noun(self) -> &'static str {
        match self {
            Setting::Model => "model",
            Setting::Effort => "effort",
        }
    }
}

/// How a harness takes a change the app asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Apply {
    /// The running process takes it, and says so.
    Live,
    /// Only read at startup: the process is replaced on the same
    /// conversation, once the turn it would interrupt is over.
    Restart,
    /// The provider has no such setting.
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Support {
    pub model: Apply,
    pub effort: Apply,
}

impl Support {
    pub fn of(self, setting: Setting) -> Apply {
        match setting {
            Setting::Model => self.model,
            Setting::Effort => self.effort,
        }
    }
}

impl HarnessId {
    /// How this harness takes a model or effort change from the app.
    ///
    /// - Claude Code runs its own `/model <name>` and `/effort <level>`.
    /// - Codex has neither: `/model` only opens a picker, and `/model <name>`
    ///   is sent to the model as a prompt (checked on codex-cli 0.153.4). The
    ///   picker could be driven by keystrokes, but which row is which model
    ///   is only on the screen, so a change restarts the tab instead.
    /// - ACP takes `session/set_model`; OpenCode names the model on every
    ///   prompt. Neither has an effort setting.
    pub fn settings(&self) -> Support {
        match self {
            HarnessId::Claude => Support { model: Apply::Live, effort: Apply::Live },
            HarnessId::Codex => Support { model: Apply::Restart, effort: Apply::Restart },
            HarnessId::Acp(_) => Support { model: Apply::Live, effort: Apply::Unsupported },
            HarnessId::OpenCode => Support { model: Apply::Live, effort: Apply::Unsupported },
            HarnessId::Other(_) => Support { model: Apply::Unsupported, effort: Apply::Unsupported },
        }
    }
}

/// The mode every protection is off in.
pub const BYPASS_MODE: &str = "bypassPermissions";

/// The permission stance a provider says it is in, in its own terms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Stance {
    /// Claude Code names a mode.
    Mode { mode: String },
    /// Codex has no modes: an approval policy and a sandbox.
    Sandboxed { approval: String, sandbox: String },
}

impl Stance {
    /// The mode this makes a tab that was in `current`. The app's modes and
    /// a CLI's do not map one-to-one, so the tab keeps the mode it is in
    /// whenever that is one way of saying what was reported.
    pub fn mode(&self, current: &str) -> String {
        match self {
            Stance::Mode { mode } => super::claude::mode_reported(mode, current),
            Stance::Sandboxed { approval, sandbox } => super::codex::mode_reported(approval, sandbox, current),
        }
    }
}

/// Whether a tab in a shared session may be in `mode`. Bypass is the mode a
/// share refuses; a Codex stance with no sandbox is refused with it, whatever
/// it is called and whatever its approval policy.
pub fn allowed_while_shared(mode: &str) -> bool {
    mode != BYPASS_MODE && !mode.ends_with(super::codex::NO_SANDBOX)
}

/// A mode by the name the pickers give it, for a line in the chat. One the
/// app has no entry for is named as reported.
pub fn mode_label(mode: &str) -> &str {
    match mode {
        "plan" => "Plan",
        "manual" | "default" | "ask" => "Ask every time",
        "auto" => "Auto",
        "acceptEdits" => "Accept edits",
        BYPASS_MODE => "Bypass",
        other => other,
    }
}

/// What a provider says about its own settings. A decoder or an engine emits
/// it as [`crate::events::Payload::ProviderSettings`]; the session manager
/// takes it from there and it is never logged or sent to a window as is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "signal", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Signal {
    /// What it is running now. A field it did not mention is left alone.
    Current {
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        effort: Option<String>,
    },
    /// It took the last change to this setting, without naming the value in
    /// a form worth reading (Claude Code prints "Set model to Opus 5.5").
    Accepted { setting: Setting },
    /// It turned a change down, and why in its own words. `value` is what
    /// had been asked of it, where it says: a refusal of something other than
    /// what the app asked for is somebody else's, typed in the terminal.
    Refused {
        setting: Setting,
        #[serde(default)]
        value: Option<String>,
        message: String,
    },
    /// The permission stance it is in now, whoever put it there.
    Permissions { stance: Stance },
}

impl Signal {
    pub fn current(model: Option<&str>, effort: Option<&str>) -> Option<Self> {
        let clean = |v: Option<&str>| v.map(str::trim).filter(|v| !v.is_empty()).map(String::from);
        let (model, effort) = (clean(model), clean(effort));
        (model.is_some() || effort.is_some()).then_some(Signal::Current { model, effort })
    }
}

/// The fields of a tab this module owns.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Settings {
    pub model: String,
    pub effort: Option<String>,
    pub permission_mode: String,
    pub requested_model: Option<String>,
    pub requested_effort: Option<String>,
    pub requested_permission_mode: Option<String>,
}

impl Settings {
    pub fn of(tab: &TabEntry) -> Self {
        Self {
            model: tab.model.clone(),
            effort: tab.effort.clone(),
            permission_mode: tab.permission_mode.clone(),
            requested_model: tab.requested_model.clone(),
            requested_effort: tab.requested_effort.clone(),
            requested_permission_mode: tab.requested_permission_mode.clone(),
        }
    }

    pub fn write(&self, tab: &mut TabEntry) {
        tab.model = self.model.clone();
        tab.effort = self.effort.clone();
        tab.permission_mode = self.permission_mode.clone();
        tab.requested_model = self.requested_model.clone();
        tab.requested_effort = self.requested_effort.clone();
        tab.requested_permission_mode = self.requested_permission_mode.clone();
    }

    #[cfg(test)]
    fn pending(&self, setting: Setting) -> Option<&str> {
        match setting {
            Setting::Model => self.requested_model.as_deref(),
            Setting::Effort => self.requested_effort.as_deref(),
        }
    }

    /// The app asks for a model. With no process to confirm it (`confirmed_by_provider`
    /// false) the value is simply what the next launch will be given; with
    /// one, it waits.
    pub fn request_model(&mut self, model: &str, confirmed_by_provider: bool) {
        if !confirmed_by_provider || model == self.model {
            self.model = model.to_string();
            self.requested_model = None;
        } else {
            self.requested_model = Some(model.to_string());
        }
    }

    /// The same for effort. Asking for no effort in particular is not
    /// something a running CLI can be told, so it is only ever a launch
    /// setting.
    pub fn request_effort(&mut self, effort: Option<&str>, confirmed_by_provider: bool) {
        let effort = effort.filter(|e| !e.is_empty());
        match effort {
            Some(e) if confirmed_by_provider && Some(e) != self.effort.as_deref() => self.requested_effort = Some(e.to_string()),
            _ => {
                self.effort = effort.map(String::from);
                self.requested_effort = None;
            }
        }
    }

    /// Whether anything asked for is still waiting on the provider.
    pub fn waiting(&self) -> bool {
        self.requested_model.is_some() || self.requested_effort.is_some()
    }

    /// The app asks for a permission mode. It is what the next launch is
    /// given; `waits` says that launch is held up by a turn the restart would
    /// interrupt, and until then the tab is in the mode it was in.
    pub fn request_mode(&mut self, mode: &str, waits: bool) {
        if !waits || mode == self.permission_mode {
            self.permission_mode = mode.to_string();
            self.requested_permission_mode = None;
        } else {
            self.requested_permission_mode = Some(mode.to_string());
        }
    }

    /// The provider is in `mode`, already read through [`Stance::mode`]. As
    /// with a model: it is the truth about now, and a request for something
    /// else goes on waiting for the restart that applies it.
    pub fn reported_mode(&mut self, mode: &str) {
        if self.requested_permission_mode.as_deref() == Some(mode) {
            self.requested_permission_mode = None;
        }
        self.permission_mode = mode.to_string();
    }

    /// A process is being started, or the one that was running is gone:
    /// whatever was waiting rides with the launch, and is what the tab runs.
    pub fn launched(&mut self) {
        if let Some(model) = self.requested_model.take() {
            self.model = model;
        }
        if let Some(effort) = self.requested_effort.take() {
            self.effort = Some(effort);
        }
        if let Some(mode) = self.requested_permission_mode.take() {
            self.permission_mode = mode;
        }
    }

    /// The provider says what it is running. `model` has already been through
    /// [`canonical_model`]. A report that matches a request settles it; one
    /// that does not is still the truth about now, and the request goes on
    /// waiting for its own answer (the report may simply predate it).
    pub fn reported(&mut self, model: Option<&str>, effort: Option<&str>) {
        if let Some(model) = model {
            if self.requested_model.as_deref() == Some(model) {
                self.requested_model = None;
            }
            self.model = model.to_string();
        }
        if let Some(effort) = effort {
            if self.requested_effort.as_deref() == Some(effort) {
                self.requested_effort = None;
            }
            self.effort = Some(effort.to_string());
        }
    }

    /// The provider took the change it was asked for.
    pub fn accepted(&mut self, setting: Setting) {
        match setting {
            Setting::Model => {
                if let Some(model) = self.requested_model.take() {
                    self.model = model;
                }
            }
            Setting::Effort => {
                if let Some(effort) = self.requested_effort.take() {
                    self.effort = Some(effort);
                }
            }
        }
    }

    /// The provider turned the change down, or never answered. The effective
    /// value was never touched, so dropping the request is the whole revert.
    /// Returns what had been asked for, if anything was waiting.
    pub fn refused(&mut self, setting: Setting, value: Option<&str>) -> Option<String> {
        let waiting = match setting {
            Setting::Model => &mut self.requested_model,
            Setting::Effort => &mut self.requested_effort,
        };
        if value.is_some_and(|value| waiting.as_deref() != Some(value)) {
            return None;
        }
        waiting.take()
    }
}

/// Whether the picker entry `chosen` is what the provider means by `reported`.
///
/// A family alias (`opus`) is the same choice as the full id it runs. When
/// the list says which id that is, that id is the one — unless the provider
/// reports an id the list has never heard of, which means the list is stale
/// (the alias moved on) and the family name in the id is the better guide.
/// It is the only guide when the list could not say what the alias runs.
fn names(chosen: &str, reported: &str, models: &[Model]) -> bool {
    if chosen == reported {
        return true;
    }
    let Some(alias) = models.iter().find(|m| m.id == chosen && m.alias) else { return false };
    let family = reported.starts_with(&format!("claude-{}-", alias.id));
    match alias.resolved.as_deref() {
        Some(runs) if runs == reported => true,
        Some(_) => family && !models.iter().any(|m| m.id == reported || m.resolved.as_deref() == Some(reported)),
        None => family,
    }
}

/// The id to store for a model the provider reported.
///
/// Providers report full ids (`claude-opus-5-5`); the pickers also offer
/// aliases (`opus`). What was asked for, or what the tab is already on, is
/// kept when it names the same model, so a report never turns "latest Opus"
/// into a pinned version. Otherwise the alias that runs it — by the list's
/// word, or by family when the list could not say — and failing that the id
/// exactly as reported: a model this app has never heard of is still the
/// model in use.
pub fn canonical_model(current: &Settings, reported: &str, models: &[Model]) -> String {
    for chosen in [current.requested_model.as_deref(), Some(current.model.as_str())].into_iter().flatten() {
        if !chosen.is_empty() && names(chosen, reported, models) {
            return chosen.to_string();
        }
    }
    models
        .iter()
        .find(|m| m.alias && m.resolved.as_deref() == Some(reported))
        .or_else(|| models.iter().find(|m| m.alias && names(&m.id, reported, models)))
        .map(|m| m.id.clone())
        .unwrap_or_else(|| reported.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on(model: &str, effort: Option<&str>) -> Settings {
        Settings { model: model.into(), effort: effort.map(String::from), ..Default::default() }
    }

    fn claude_models() -> Vec<Model> {
        crate::harness::claude::models::parse(&serde_json::from_str(include_str!("claude/fixtures/initialize_models.json")).unwrap())
    }

    #[test]
    fn every_harness_says_how_it_takes_a_change() {
        assert_eq!(HarnessId::parse("claude").settings(), Support { model: Apply::Live, effort: Apply::Live });
        assert_eq!(HarnessId::parse("codex").settings(), Support { model: Apply::Restart, effort: Apply::Restart });
        for headless in ["cursor", "opencode"] {
            let support = HarnessId::parse(headless).settings();
            assert_eq!(support.of(Setting::Model), Apply::Live);
            assert_eq!(support.of(Setting::Effort), Apply::Unsupported, "{headless} has no effort setting");
        }
        assert_eq!(HarnessId::parse("something-newer").settings().model, Apply::Unsupported);
    }

    /// With nothing running there is nobody to confirm anything: the choice
    /// is what the next launch gets, and that is what "current" means.
    #[test]
    fn a_change_with_no_process_running_is_simply_the_setting() {
        let mut s = on("opus", Some("high"));
        s.request_model("sonnet", false);
        s.request_effort(Some("low"), false);
        assert_eq!(s, on("sonnet", Some("low")));
    }

    #[test]
    fn a_change_to_a_running_process_waits_for_its_answer() {
        let mut s = on("opus", Some("high"));
        s.request_model("sonnet", true);
        s.request_effort(Some("low"), true);
        // Nothing the views call current has moved.
        assert_eq!((s.model.as_str(), s.effort.as_deref()), ("opus", Some("high")));
        assert_eq!((s.pending(Setting::Model), s.pending(Setting::Effort)), (Some("sonnet"), Some("low")));

        // A status frame from before the command landed changes nothing.
        s.reported(Some("opus"), Some("high"));
        assert_eq!(s.pending(Setting::Model), Some("sonnet"));

        s.reported(Some("sonnet"), Some("high"));
        assert_eq!((s.model.as_str(), s.pending(Setting::Model)), ("sonnet", None));
        assert_eq!(s.pending(Setting::Effort), Some("low"), "each setting is settled on its own");
        s.reported(None, Some("low"));
        assert_eq!(s, on("sonnet", Some("low")));
    }

    #[test]
    fn a_refused_change_reverts_to_what_is_running() {
        let mut s = on("opus", Some("high"));
        s.request_model("claude-nope-9", true);
        // A refusal that names something else was typed in the terminal.
        assert_eq!(s.refused(Setting::Model, Some("haiku")), None);
        assert_eq!(s.pending(Setting::Model), Some("claude-nope-9"));
        assert_eq!(s.refused(Setting::Model, Some("claude-nope-9")).as_deref(), Some("claude-nope-9"));
        assert_eq!(s, on("opus", Some("high")));
        // Nothing waiting: a refusal of somebody else's command is not ours.
        assert_eq!(s.refused(Setting::Model, None), None);
        assert_eq!(s.refused(Setting::Effort, None), None);
    }

    #[test]
    fn an_accepted_change_becomes_current_without_a_report() {
        let mut s = on("opus", None);
        s.request_model("sonnet", true);
        s.request_effort(Some("max"), true);
        s.accepted(Setting::Model);
        assert_eq!((s.model.as_str(), s.pending(Setting::Model), s.pending(Setting::Effort)), ("sonnet", None, Some("max")));
        s.accepted(Setting::Effort);
        assert_eq!(s, on("sonnet", Some("max")));
        // Acceptance of a command typed in the terminal has nothing to promote.
        s.accepted(Setting::Model);
        assert_eq!(s, on("sonnet", Some("max")));
    }

    #[test]
    fn asking_for_what_is_already_running_cancels_the_wait() {
        let mut s = on("opus", Some("high"));
        s.request_model("sonnet", true);
        s.request_model("opus", true);
        s.request_effort(Some("low"), true);
        s.request_effort(Some("high"), true);
        assert_eq!(s, on("opus", Some("high")));
    }

    /// The reader changed it in the terminal while a change from the chat was
    /// still on its way: the terminal's is what is running, and the chat's is
    /// still to be answered.
    #[test]
    fn a_change_made_in_the_terminal_shows_while_another_is_pending() {
        let mut s = on("opus", Some("high"));
        s.request_model("sonnet", true);
        s.reported(Some("haiku"), None);
        assert_eq!((s.model.as_str(), s.pending(Setting::Model)), ("haiku", Some("sonnet")));
    }

    /// A restart-only harness (Codex) mid-turn: the request waits for the
    /// turn, then rides with the launch that replaces the process.
    #[test]
    fn a_waiting_change_rides_with_the_next_launch() {
        let mut s = on("gpt-5.6-sol", Some("low"));
        s.request_model("gpt-6-astra", true);
        s.request_effort(Some("high"), true);
        assert_eq!((s.model.as_str(), s.effort.as_deref()), ("gpt-5.6-sol", Some("low")), "still what the running turn is on");
        s.launched();
        assert_eq!(s, on("gpt-6-astra", Some("high")));
        // And what the new process then reports is the last word.
        s.reported(Some("gpt-5.6-terra"), Some("medium"));
        assert_eq!(s, on("gpt-5.6-terra", Some("medium")));
    }

    #[test]
    fn no_effort_in_particular_is_a_launch_setting() {
        let mut s = on("opus", Some("high"));
        s.request_effort(None, true);
        assert_eq!(s, on("opus", None));
        s.request_effort(Some(""), true);
        assert_eq!(s, on("opus", None));
    }

    #[test]
    fn a_report_keeps_the_alias_the_tab_is_on() {
        let models = claude_models();
        // `opus` runs claude-opus-5-5 in the captured list.
        assert_eq!(canonical_model(&on("opus", None), "claude-opus-5-5", &models), "opus");
        // A pinned version stays pinned.
        assert_eq!(canonical_model(&on("claude-opus-5-5", None), "claude-opus-5-5", &models), "claude-opus-5-5");
        // What was asked for wins over what the tab was on.
        let mut asked = on("claude-sonnet-5-5", None);
        asked.request_model("sonnet", true);
        assert_eq!(canonical_model(&asked, "claude-sonnet-5-5", &models), "sonnet");
    }

    #[test]
    fn a_model_changed_in_the_terminal_is_found_in_the_list() {
        let models = claude_models();
        // `/model sonnet` in the terminal, reported by its full id.
        assert_eq!(canonical_model(&on("opus", None), "claude-sonnet-5-5", &models), "sonnet");
        // An older version the reader pinned by hand is not "latest Opus".
        assert_eq!(canonical_model(&on("opus", None), "claude-opus-5", &models), "claude-opus-5");
        // A tab on the CLI's default learns what that is.
        assert_eq!(canonical_model(&on("", None), "claude-opus-5-5", &models), "opus");
    }

    #[test]
    fn an_unknown_model_is_kept_exactly_as_reported() {
        let models = claude_models();
        assert_eq!(canonical_model(&on("opus", None), "claude-nova-1-0", &models), "claude-nova-1-0");
        // A release of another family the list has not caught up with is that family's latest.
        assert_eq!(canonical_model(&on("opus", None), "claude-sonnet-9-1", &models), "sonnet");
        assert_eq!(canonical_model(&on("gpt-5.6-sol", None), "gpt-9-nova", &[]), "gpt-9-nova");
        // A newer release of the family the tab follows: the list is stale,
        // and the tab is still on "latest Opus".
        assert_eq!(canonical_model(&on("opus", None), "claude-opus-6", &models), "opus");
        // With no list at all there is nothing to map to.
        assert_eq!(canonical_model(&on("opus", None), "claude-opus-5-5", &[]), "claude-opus-5-5");
    }

    /// The built-in list, used when the CLI could not be asked, names no
    /// version for an alias.
    #[test]
    fn an_alias_the_cli_could_not_resolve_still_matches_its_family() {
        let models = crate::models::claude_fallback();
        assert!(models.iter().any(|m| m.id == "opus" && m.alias && m.resolved.is_none()));
        assert_eq!(canonical_model(&on("opus", None), "claude-opus-5-5", &models), "opus");
        assert_eq!(canonical_model(&on("opus", None), "claude-opus-9-9", &models), "opus");
        // Another family is that family's alias, and a tab on the CLI's
        // default goes on following a family rather than one version.
        assert_eq!(canonical_model(&on("opus", None), "claude-sonnet-5-5", &models), "sonnet");
        assert_eq!(canonical_model(&on("", None), "claude-opus-5-5", &models), "opus");
    }

    fn in_mode(mode: &str) -> Settings {
        Settings { permission_mode: mode.into(), ..Default::default() }
    }

    /// Mid-turn the mode waits for the restart; the turn in progress is still
    /// judged under the one it started in, and that is what is shown.
    #[test]
    fn a_mode_asked_for_mid_turn_waits_for_the_restart() {
        let mut s = in_mode("auto");
        s.request_mode("plan", true);
        assert_eq!((s.permission_mode.as_str(), s.requested_permission_mode.as_deref()), ("auto", Some("plan")));
        // What the running CLI reports meanwhile is still the truth.
        s.reported_mode("auto");
        assert_eq!(s.requested_permission_mode.as_deref(), Some("plan"));
        s.launched();
        assert_eq!(s, in_mode("plan"));
    }

    #[test]
    fn a_mode_asked_for_with_no_turn_open_is_the_setting() {
        let mut s = in_mode("auto");
        s.request_mode("plan", false);
        assert_eq!(s, in_mode("plan"));
        // Asking for the mode it is in takes back one that was waiting.
        s.request_mode("manual", true);
        s.request_mode("plan", true);
        assert_eq!(s, in_mode("plan"));
    }

    #[test]
    fn a_mode_changed_in_the_terminal_shows_while_another_is_pending() {
        let mut s = in_mode("auto");
        s.request_mode("plan", true);
        s.reported_mode("acceptEdits");
        assert_eq!((s.permission_mode.as_str(), s.requested_permission_mode.as_deref()), ("acceptEdits", Some("plan")));
        // The terminal getting there first settles the request.
        s.reported_mode("plan");
        assert_eq!(s, in_mode("plan"));
    }

    #[test]
    fn a_stance_is_read_by_the_harness_that_reported_it() {
        assert_eq!(Stance::Mode { mode: "default".into() }.mode("plan"), "manual");
        assert_eq!(Stance::Sandboxed { approval: "on-request".into(), sandbox: "read-only".into() }.mode("auto"), "plan");
    }

    #[test]
    fn a_share_refuses_bypass_and_any_stance_with_no_sandbox() {
        for mode in ["plan", "manual", "auto", "acceptEdits", "dontAsk", "never, workspace-write", "something-newer"] {
            assert!(allowed_while_shared(mode), "{mode}");
        }
        assert!(!allowed_while_shared(BYPASS_MODE));
        assert!(!allowed_while_shared("on-request, danger-full-access"));
    }

    #[test]
    fn a_mode_with_no_entry_is_named_as_reported() {
        assert_eq!(mode_label("acceptEdits"), "Accept edits");
        assert_eq!(mode_label(BYPASS_MODE), "Bypass");
        assert_eq!(mode_label("dontAsk"), "dontAsk");
        assert_eq!(mode_label("never, workspace-write"), "never, workspace-write");
    }

    #[test]
    fn a_signal_with_nothing_in_it_is_no_signal() {
        assert_eq!(Signal::current(None, None), None);
        assert_eq!(Signal::current(Some("  "), Some("")), None);
        assert_eq!(Signal::current(Some("gpt-5.6-sol"), None), Some(Signal::Current { model: Some("gpt-5.6-sol".into()), effort: None }));
    }
}
