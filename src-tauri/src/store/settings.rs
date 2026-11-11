//! User settings shared by the runtime and every window.

pub mod file;

use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::orchestration::routing::{Overrides as RoutingOverrides, Table as RoutingTable};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// User-facing webview preferences. Missing keys inherit app defaults.
    pub preferences: std::collections::BTreeMap<String, serde_json::Value>,
    /// The first window copied the legacy localStorage choices successfully.
    pub preferences_migrated: bool,
    // Keep layered keys written/reset by another window while an unrelated
    // settings control holds a previously loaded snapshot. Not persisted.
    #[serde(skip)]
    pub(crate) loaded_configuration: Option<(String, String)>,
    /// Where new worktrees go, relative to the project root.
    pub worktree_dir: String,
    /// Branch prefix for session worktrees.
    pub branch_prefix: String,
    /// Extra directories to search for agent binaries.
    pub extra_bin_dirs: Vec<String>,
    pub notifications: bool,
    /// None means the reader has not answered the first-quit choice yet.
    /// The effective default keeps work running; stopping requires an explicit choice.
    pub quit_behavior: Option<QuitBehavior>,
    /// Personal API key for Linear; the file is kept owner-readable only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linear_api_key: Option<String>,
    /// Who the key belonged to when it was saved, for the settings row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub linear_viewer: Option<String>,
    /// Dictation engine: "apple" for the system recogniser, or a catalog id.
    pub transcription_model: String,
    /// Microphone by name, or the system default when unset.
    pub transcription_input_device: Option<String>,
    /// Drop system output to zero while recording so playback stays out of the text.
    pub transcription_mute: bool,
    /// Bottom-chrome visibility and presentation. Unlike ordinary webview
    /// preferences this also drives the native View menu, so it lives here.
    pub status_bar: StatusBarSettings,
    /// The floating chat window. The system-wide shortcut is registered, and
    /// the window made, by the Rust side, so these live here.
    pub floating: FloatingSettings,
    /// Removing a workspace once its pull request has merged. The Rust side
    /// does the removing, and reads for itself which projects it is on for.
    pub merged_cleanup: MergedCleanupSettings,
    /// What this Mac says about the issues its sessions work on (#441,
    /// `work_claims.rs`). The Rust side publishes it, so it lives here.
    pub work_status: WorkStatusSettings,
    /// This Mac's name as the user typed it in Settings → Account (#686).
    /// None follows the computer's own name (`pairing::MachineName`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_name: Option<String>,
    /// When an agent nobody is using is stopped (`idle_agents.rs`). The
    /// runtime that owns the agents reads it for itself.
    pub agents: AgentSettings,
    /// When a finished conversation is archived (`session_archive.rs`). The
    /// runtime that knows what each session is doing reads it for itself.
    pub conversations: ConversationSettings,
    /// Settings → Experimental. Tabs are made by the Rust side, which reads
    /// these when it makes one, so they live here.
    pub experimental: ExperimentalSettings,
    /// What the runtime keeps about the warnings tabs raise (#815,
    /// `recovery_log.rs`). The runtime writes it, so it reads this itself.
    pub diagnostics: DiagnosticsSettings,
    /// The limits of an orchestration run (`orchestration`): the runtime that
    /// starts the workers reads them when a plan is stored and started.
    pub orchestrator: OrchestratorSettings,
}

/// What a lead's run of workers may do without asking (PRO-274). Each has an
/// app-wide value and may have one of a project's own, by the project's path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct OrchestratorSettings {
    /// A new run waits for a person to approve its plan before any worker starts.
    pub require_approval: bool,
    /// The most pieces a plan may have; a larger one is refused.
    #[serde(deserialize_with = "piece_limit")]
    pub piece_limit: u32,
    /// The permission mode of a worker whose piece names none.
    #[serde(deserialize_with = "worker_mode")]
    pub worker_mode: String,
    /// The rows of the routing table a person changed (PRO-275): which tier
    /// and effort a kind of piece starts on, per agent. A row that is not
    /// here is the built-in one (`orchestration::routing::default_route`).
    #[serde(skip_serializing_if = "RoutingOverrides::is_empty")]
    pub routing: RoutingOverrides,
    /// One project's own answers, by its path. A project without one, or
    /// without a value for a setting, follows the app-wide value.
    pub projects: std::collections::BTreeMap<String, ProjectOrchestratorSettings>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ProjectOrchestratorSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub require_approval: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "project_piece_limit")]
    pub piece_limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "project_worker_mode")]
    pub worker_mode: Option<String>,
    /// The project's own rows of the routing table; the rest follow the app's.
    #[serde(skip_serializing_if = "RoutingOverrides::is_empty")]
    pub routing: RoutingOverrides,
}

impl ProjectOrchestratorSettings {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// The settings in force for one project.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OrchestratorLimits {
    pub require_approval: bool,
    pub piece_limit: u32,
    pub worker_mode: String,
    /// The routing table in force: every kind, every agent.
    pub routing: RoutingTable,
}

/// Eight: a lead can still read eight reports and hold eight briefs apart;
/// past that a plan is usually a small task cut too fine.
pub const DEFAULT_PIECE_LIMIT: u32 = 8;
/// The most the setting accepts. A plan this size is already beyond what one
/// lead can check; the bound keeps a mistyped value from meaning "no limit".
pub const MAX_PIECE_LIMIT: u32 = 50;
/// The modes a worker may start in: the ones a new session may.
pub const WORKER_MODES: [&str; 5] = ["plan", "manual", "auto", "acceptEdits", "bypassPermissions"];
/// Bypass: a run is not held up by permission cards. What a card would have
/// caught is refused by deny rules instead (`orchestration::guard`).
pub const DEFAULT_WORKER_MODE: &str = "bypassPermissions";

fn valid_piece_limit(value: &serde_json::Value) -> Option<u32> {
    value.as_u64().and_then(|n| u32::try_from(n).ok()).filter(|n| (1..=MAX_PIECE_LIMIT).contains(n))
}

fn valid_worker_mode(value: &serde_json::Value) -> Option<String> {
    value.as_str().filter(|mode| WORKER_MODES.contains(mode)).map(str::to_owned)
}

/// A hand-edited or damaged value falls back to the default rather than
/// letting through a plan of a size nobody chose.
fn piece_limit<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<u32, D::Error> {
    Ok(valid_piece_limit(&serde_json::Value::deserialize(deserializer)?).unwrap_or(DEFAULT_PIECE_LIMIT))
}

fn worker_mode<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<String, D::Error> {
    Ok(valid_worker_mode(&serde_json::Value::deserialize(deserializer)?).unwrap_or_else(|| DEFAULT_WORKER_MODE.into()))
}

/// A project's damaged value is no value: the project follows the app-wide one.
fn project_piece_limit<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<u32>, D::Error> {
    Ok(valid_piece_limit(&serde_json::Value::deserialize(deserializer)?))
}

fn project_worker_mode<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Option<String>, D::Error> {
    Ok(valid_worker_mode(&serde_json::Value::deserialize(deserializer)?))
}

impl Default for OrchestratorSettings {
    fn default() -> Self {
        Self { require_approval: true, piece_limit: DEFAULT_PIECE_LIMIT, worker_mode: DEFAULT_WORKER_MODE.into(), routing: Default::default(), projects: Default::default() }
    }
}

impl OrchestratorSettings {
    /// What holds for the project at `path`: its own answer where it gave one.
    pub fn for_project(&self, path: &str) -> OrchestratorLimits {
        let project = self.projects.get(path);
        OrchestratorLimits {
            require_approval: project.and_then(|p| p.require_approval).unwrap_or(self.require_approval),
            piece_limit: project.and_then(|p| p.piece_limit).unwrap_or(self.piece_limit),
            worker_mode: project.and_then(|p| p.worker_mode.clone()).unwrap_or_else(|| self.worker_mode.clone()),
            routing: RoutingTable::resolved(&self.routing, project.map(|p| &p.routing)),
        }
    }
}

/// Private evidence kept on this Mac only, for reports the reader makes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct DiagnosticsSettings {
    /// Record when a tab's warning was raised, shown, acted on and cleared:
    /// labels, counts and times, never a message, code or a path.
    pub recovery_incidents: bool,
}

impl Default for DiagnosticsSettings {
    fn default() -> Self {
        Self { recovery_incidents: true }
    }
}

/// Agents the app started that sit idle are stopped after a while (#696),
/// and their next message starts them again on the same conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSettings {
    /// Skip Ask mode's card for built-in read-only discovery commands.
    pub read_only_commands: bool,
    /// Minutes an agent may sit idle before it is stopped; 0 never stops one
    /// for that alone.
    #[serde(deserialize_with = "idle_stop_minutes")]
    pub idle_stop_minutes: u32,
}

/// The idle limits the settings control offers; 0 is "never".
pub const IDLE_STOP_MINUTES: [u32; 7] = [0, 30, 60, 120, 240, 480, 1440];
/// An hour: by then a model's prompt cache has gone cold, so resuming the
/// conversation costs what keeping the agent up would have saved nothing on.
const DEFAULT_IDLE_STOP_MINUTES: u32 = 60;

/// A hand-edited or damaged value falls back to the default rather than
/// stopping agents at a pace nobody chose.
fn idle_stop_minutes<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<u32, D::Error> {
    let minutes = serde_json::Value::deserialize(deserializer)?.as_u64().and_then(|value| u32::try_from(value).ok());
    Ok(minutes.filter(|value| IDLE_STOP_MINUTES.contains(value)).unwrap_or(DEFAULT_IDLE_STOP_MINUTES))
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self { idle_stop_minutes: DEFAULT_IDLE_STOP_MINUTES, read_only_commands: true }
    }
}

impl AgentSettings {
    /// How long an agent may sit idle, or `None` when it may for ever.
    pub fn idle_limit(&self) -> Option<std::time::Duration> {
        (self.idle_stop_minutes > 0).then(|| std::time::Duration::from_secs(u64::from(self.idle_stop_minutes) * 60))
    }
}

/// Conversations nobody has written in for a while are archived (#718): out
/// of the sidebar's list, under its Show archived, and back at their next
/// message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ConversationSettings {
    /// Days a conversation may go without a message before it is archived;
    /// 0 never archives one by itself.
    #[serde(deserialize_with = "archive_idle_days")]
    pub archive_idle_days: u32,
}

/// The idle limits the settings control offers; 0 is "never".
pub const ARCHIVE_IDLE_DAYS: [u32; 6] = [0, 1, 3, 7, 14, 30];
/// A week: on 2026-11-01, 57 of 89 sessions were finished, idle for 2 to 58
/// days (median 7), and nothing had taken any of them out of the list.
const DEFAULT_ARCHIVE_IDLE_DAYS: u32 = 7;

/// A hand-edited or damaged value falls back to the default rather than
/// archiving at a pace nobody chose.
fn archive_idle_days<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<u32, D::Error> {
    let days = serde_json::Value::deserialize(deserializer)?.as_u64().and_then(|value| u32::try_from(value).ok());
    Ok(days.filter(|value| ARCHIVE_IDLE_DAYS.contains(value)).unwrap_or(DEFAULT_ARCHIVE_IDLE_DAYS))
}

impl Default for ConversationSettings {
    fn default() -> Self {
        Self { archive_idle_days: DEFAULT_ARCHIVE_IDLE_DAYS }
    }
}

impl ConversationSettings {
    /// How long a conversation may go without a message, or `None` when it
    /// is never archived for that.
    pub fn archive_after(&self) -> Option<chrono::Duration> {
        (self.archive_idle_days > 0).then(|| chrono::Duration::days(i64::from(self.archive_idle_days)))
    }
}

/// Features that are on only when the reader turns them on.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExperimentalSettings {
    /// New Codex conversations a person starts go through Codex's app server
    /// (#644) where it can serve them (`session_ops::prefer_native_codex`).
    pub native_codex: bool,
    /// Show orchestration runs in the app (PRO-274): a session's Run view,
    /// with the plan to approve, and Settings → Orchestrator. The `terminalx
    /// runs` commands work either way.
    pub orchestrator_runs: bool,
    /// The session header shows the session's estimated cost, with its
    /// tokens by model in a popover (PRO-273). The totals are recorded and
    /// `terminalx sessions usage` answers either way.
    pub session_cost: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum QuitBehavior {
    StopAll,
    // An unknown future value must never become permission to stop work.
    #[default]
    #[serde(other)]
    KeepRunning,
}

/// Who sees which issues this person's sessions are working on. Their own
/// other machines always do, once signed in on both.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkStatusSettings {
    /// Teammates in an organization that connected the repository see it too.
    pub share_with_team: bool,
}

impl Default for WorkStatusSettings {
    fn default() -> Self {
        Self { share_with_team: true }
    }
}

/// Whether a workspace is removed by itself once its pull request has merged
/// (`merged_cleanup.rs`). Off unless the reader turns it on.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct MergedCleanupSettings {
    /// The default for every project.
    pub enabled: bool,
    /// One project's own answer, by its key: the path of a project on this
    /// computer, or a cloud workspace's `cloud:<organization>:<workspace>`.
    /// A project without one follows the default.
    pub projects: std::collections::BTreeMap<String, bool>,
    /// Delete the conversations of the sessions in the workspace too. Off:
    /// they are kept and filed under the project.
    pub delete_conversations: bool,
    /// Minutes between the merge being seen (or the last thing done in the
    /// workspace, if later) and the removal.
    #[serde(deserialize_with = "grace_minutes")]
    pub grace_minutes: u32,
}

/// The grace periods the settings control offers.
pub const GRACE_MINUTES: [u32; 4] = [5, 10, 30, 60];
const DEFAULT_GRACE_MINUTES: u32 = 10;

/// A hand-edited or damaged value falls back to the default rather than
/// removing a workspace sooner than anyone chose.
fn grace_minutes<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<u32, D::Error> {
    let minutes = serde_json::Value::deserialize(deserializer)?.as_u64().and_then(|value| u32::try_from(value).ok());
    Ok(minutes.filter(|value| GRACE_MINUTES.contains(value)).unwrap_or(DEFAULT_GRACE_MINUTES))
}

impl Default for MergedCleanupSettings {
    fn default() -> Self {
        Self { enabled: false, projects: Default::default(), delete_conversations: false, grace_minutes: DEFAULT_GRACE_MINUTES }
    }
}

impl MergedCleanupSettings {
    /// Whether it is on for the project with this key.
    pub fn enabled_for(&self, key: &str) -> bool {
        self.projects.get(key).copied().unwrap_or(self.enabled)
    }
}

/// The longest an idle quick chat may be set to be kept, short of for ever.
pub const MAX_RETENTION_DAYS: u32 = 3650;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct FloatingSettings {
    /// The system-wide shortcut that shows and hides the window, written as
    /// the app writes bindings (`alt+shift+space`). `None` is turned off.
    pub shortcut: Option<String>,
    /// The window stays above other apps' windows.
    pub always_on_top: bool,
    /// How many days a quick chat nobody touches is kept before it and its
    /// scratch directory are deleted; 0 keeps them until deleted by hand.
    pub retention_days: u32,
}

impl Default for FloatingSettings {
    fn default() -> Self {
        Self { shortcut: Some("alt+shift+space".into()), always_on_top: true, retention_days: 30 }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StatusPercent {
    Used,
    Remaining,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StatusUsageMode {
    Detailed,
    Compact,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct StatusBarSettings {
    pub visible: bool,
    pub usage: bool,
    pub resources: bool,
    pub percent: StatusPercent,
    pub usage_mode: StatusUsageMode,
    /// Minutes between automatic provider usage refreshes; 0 turns the timer
    /// off and leaves focus, manual and reset-boundary refreshes in place.
    #[serde(deserialize_with = "usage_refresh_minutes")]
    pub usage_refresh_minutes: u32,
}

/// The intervals the settings control offers; 0 is "off".
pub const USAGE_REFRESH_MINUTES: [u32; 5] = [0, 1, 2, 5, 15];
const DEFAULT_USAGE_REFRESH_MINUTES: u32 = 1;

/// A hand-edited or damaged value falls back to the default rather than
/// polling a provider at a cadence nobody chose.
fn usage_refresh_minutes<'de, D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<u32, D::Error> {
    let minutes = serde_json::Value::deserialize(deserializer)?.as_u64().and_then(|value| u32::try_from(value).ok());
    Ok(minutes.filter(|value| USAGE_REFRESH_MINUTES.contains(value)).unwrap_or(DEFAULT_USAGE_REFRESH_MINUTES))
}

impl StatusBarSettings {
    /// The automatic refresh cadence, or `None` when the timer is off or
    /// nothing shows usage; returning to the app must not fetch at that
    /// cadence for an indicator that is hidden.
    pub fn usage_refresh_ms(&self) -> Option<i64> {
        (self.visible && self.usage && self.usage_refresh_minutes > 0).then(|| i64::from(self.usage_refresh_minutes) * 60_000)
    }
}

impl Default for StatusBarSettings {
    fn default() -> Self {
        Self {
            visible: true,
            usage: true,
            resources: true,
            percent: StatusPercent::Used,
            usage_mode: StatusUsageMode::Detailed,
            usage_refresh_minutes: DEFAULT_USAGE_REFRESH_MINUTES,
        }
    }
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            preferences: Default::default(),
            preferences_migrated: false,
            loaded_configuration: None,
            worktree_dir: ".raccoon/worktrees".into(),
            branch_prefix: "raccoon/".into(),
            extra_bin_dirs: Vec::new(),
            notifications: true,
            quit_behavior: None,
            linear_api_key: None,
            linear_viewer: None,
            transcription_model: "apple".into(),
            transcription_input_device: None,
            transcription_mute: false,
            status_bar: StatusBarSettings::default(),
            floating: FloatingSettings::default(),
            merged_cleanup: MergedCleanupSettings::default(),
            work_status: WorkStatusSettings::default(),
            machine_name: None,
            agents: AgentSettings::default(),
            conversations: ConversationSettings::default(),
            experimental: ExperimentalSettings::default(),
            diagnostics: DiagnosticsSettings::default(),
            orchestrator: OrchestratorSettings::default(),
        }
    }
}

pub(super) fn file_path() -> Result<PathBuf> {
    Ok(super::root()?.join("settings.json"))
}

pub fn load() -> Settings {
    let mut settings = file::load();
    settings.loaded_configuration = Some((settings.branch_prefix.clone(), settings.worktree_dir.clone()));
    settings
}

pub fn save(s: &Settings) -> Result<()> {
    file::save(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quit_keeps_work_by_default_and_only_an_explicit_choice_stops_it() {
        let legacy: Settings = serde_json::from_str(r#"{"notifications":false}"#).unwrap();
        assert_eq!(legacy.quit_behavior, None, "first quit must still offer the choice");
        assert_eq!(legacy.quit_behavior.unwrap_or_default(), QuitBehavior::KeepRunning);
        assert!(!legacy.notifications);
        for (wire, expected) in [("keepRunning", QuitBehavior::KeepRunning), ("stopAll", QuitBehavior::StopAll)] {
            let chosen: Settings = serde_json::from_value(serde_json::json!({"quitBehavior":wire})).unwrap();
            assert_eq!(chosen.quit_behavior, Some(expected));
            let saved = serde_json::to_value(&chosen).unwrap();
            assert_eq!(saved["quitBehavior"], wire);
            assert_eq!(serde_json::from_value::<Settings>(saved).unwrap().quit_behavior, Some(expected));
        }
        let future: Settings = serde_json::from_str(r#"{"quitBehavior":"new-policy"}"#).unwrap();
        assert_eq!(future.quit_behavior, Some(QuitBehavior::KeepRunning));
    }

    #[test]
    fn experimental_features_stay_off_until_turned_on() {
        let legacy: Settings = serde_json::from_str(r#"{"notifications":false}"#).unwrap();
        assert!(!legacy.experimental.native_codex);
        let on: Settings = serde_json::from_value(serde_json::json!({"experimental":{"nativeCodex":true}})).unwrap();
        assert!(on.experimental.native_codex);
        assert_eq!(serde_json::to_value(&on).unwrap()["experimental"], serde_json::json!({"nativeCodex":true,"orchestratorRuns":false,"sessionCost":false}));
        assert!(!legacy.experimental.orchestrator_runs);
        let runs: Settings = serde_json::from_value(serde_json::json!({"experimental":{"orchestratorRuns":true}})).unwrap();
        assert!(runs.experimental.orchestrator_runs && !runs.experimental.native_codex);
        assert!(!legacy.experimental.session_cost);
        let cost: Settings = serde_json::from_value(serde_json::json!({"experimental":{"sessionCost":true}})).unwrap();
        assert!(cost.experimental.session_cost && !cost.experimental.native_codex);
    }

    #[test]
    fn a_run_asks_first_takes_eight_pieces_and_runs_workers_in_bypass_unless_a_project_says_otherwise() {
        // A settings file written before the settings existed.
        let legacy: Settings = serde_json::from_str(r#"{"notifications":false}"#).unwrap();
        assert_eq!(legacy.orchestrator, OrchestratorSettings::default());
        let limits = legacy.orchestrator.for_project("/repo");
        assert_eq!((limits.require_approval, limits.piece_limit, limits.worker_mode.as_str()), (true, 8, "bypassPermissions"));

        // A project answers for itself, one setting at a time; the rest follow the app.
        let set: Settings = serde_json::from_value(serde_json::json!({"orchestrator": {
            "pieceLimit": 12, "workerMode": "acceptEdits",
            "projects": {"/repo": {"requireApproval": false, "pieceLimit": 3}, "/other": {"workerMode": "manual"}},
        }})).unwrap();
        let repo = set.orchestrator.for_project("/repo");
        assert_eq!((repo.require_approval, repo.piece_limit, repo.worker_mode.as_str()), (false, 3, "acceptEdits"));
        let other = set.orchestrator.for_project("/other");
        assert_eq!((other.require_approval, other.piece_limit, other.worker_mode.as_str()), (true, 12, "manual"));
        let unnamed = set.orchestrator.for_project("/elsewhere");
        assert_eq!((unnamed.require_approval, unnamed.piece_limit, unnamed.worker_mode.as_str()), (true, 12, "acceptEdits"));
        let written = serde_json::to_value(&set).unwrap();
        assert_eq!(written["orchestrator"]["projects"]["/repo"], serde_json::json!({"requireApproval": false, "pieceLimit": 3}));
        assert_eq!(serde_json::from_value::<Settings>(written).unwrap().orchestrator, set.orchestrator);

        // A damaged value is the default, and a project's damaged value is no value.
        let damaged: Settings = serde_json::from_value(serde_json::json!({"orchestrator": {
            "pieceLimit": 0, "workerMode": "yolo", "projects": {"/repo": {"pieceLimit": 900, "workerMode": 7}},
        }})).unwrap();
        assert_eq!((damaged.orchestrator.piece_limit, damaged.orchestrator.worker_mode.as_str()), (8, "bypassPermissions"));
        assert!(damaged.orchestrator.projects["/repo"].is_empty());
    }

    #[test]
    fn the_routing_table_is_the_built_in_one_until_a_row_is_changed_for_the_app_or_a_project() {
        use crate::orchestration::routing::{Route, Tier};
        let route = |tier, effort: Option<&str>| Route { tier, effort: effort.map(str::to_owned) };
        // Nothing stored: the built-in table, and nothing written for it.
        let legacy: Settings = serde_json::from_str(r#"{"notifications":false}"#).unwrap();
        assert_eq!(legacy.orchestrator.for_project("/repo").routing, RoutingTable::default());
        assert!(serde_json::to_value(&legacy).unwrap()["orchestrator"].get("routing").is_none());

        let set: Settings = serde_json::from_value(serde_json::json!({"orchestrator": {
            "routing": {"code": {"claude": {"tier": "mid", "effort": "high"}}},
            "projects": {"/repo": {"routing": {"code": {"claude": {"tier": "top"}}, "search": {"codex": {"tier": "mid", "effort": "low"}}}}},
        }})).unwrap();
        let repo = set.orchestrator.for_project("/repo").routing;
        assert_eq!(repo.route("code", "claude"), Some(&route(Tier::Top, None)));
        assert_eq!(repo.route("search", "codex"), Some(&route(Tier::Mid, Some("low"))));
        assert_eq!(repo.route("code", "codex"), Some(&route(Tier::Large, Some("medium"))));
        // Another project follows the app's row, then the built-in ones.
        let other = set.orchestrator.for_project("/other").routing;
        assert_eq!(other.route("code", "claude"), Some(&route(Tier::Mid, Some("high"))));
        assert_eq!(other.route("search", "codex"), Some(&route(Tier::Small, None)));
        // Only the changed rows are written, and they read back the same.
        let written = serde_json::to_value(&set).unwrap();
        assert_eq!(written["orchestrator"]["routing"], serde_json::json!({"code": {"claude": {"tier": "mid", "effort": "high"}}}));
        assert_eq!(serde_json::from_value::<Settings>(written).unwrap().orchestrator, set.orchestrator);
        // A project with a routing row of its own is not "following the app in everything".
        assert!(!set.orchestrator.projects["/repo"].is_empty());
    }

    #[test]
    fn the_floating_window_defaults_on_and_a_shortcut_turned_off_stays_off() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.floating, FloatingSettings::default());
        assert_eq!(settings.floating.shortcut.as_deref(), Some("alt+shift+space"));
        assert!(settings.floating.always_on_top);
        assert_eq!(settings.floating.retention_days, 30);

        // Turned off is written as null, and null is not "use the default".
        let off: Settings = serde_json::from_str(r#"{"floating":{"shortcut":null,"retentionDays":0}}"#).unwrap();
        assert_eq!(off.floating.shortcut, None);
        assert_eq!(off.floating.retention_days, 0);
        assert!(off.floating.always_on_top);
        let written = serde_json::to_value(&off).unwrap();
        assert!(written["floating"]["shortcut"].is_null());
        assert_eq!(serde_json::from_value::<Settings>(written).unwrap().floating, off.floating);
    }

    #[test]
    fn removing_merged_workspaces_is_off_until_turned_on_and_a_project_can_answer_for_itself() {
        // A settings file written before the setting existed.
        let older: Settings = serde_json::from_str(r#"{"notifications":true}"#).unwrap();
        assert_eq!(older.merged_cleanup, MergedCleanupSettings::default());
        assert!(!older.merged_cleanup.enabled && !older.merged_cleanup.delete_conversations);
        assert_eq!(older.merged_cleanup.grace_minutes, 10);
        assert!(!older.merged_cleanup.enabled_for("/repos/app"));

        let chosen: Settings = serde_json::from_str(r#"{"mergedCleanup":{"enabled":true,"projects":{"/repos/kept":false},"graceMinutes":30}}"#).unwrap();
        assert!(chosen.merged_cleanup.enabled_for("/repos/app"));
        assert!(!chosen.merged_cleanup.enabled_for("/repos/kept"));
        assert_eq!(chosen.merged_cleanup.grace_minutes, 30);
        let written = serde_json::to_value(&chosen).unwrap();
        assert_eq!(serde_json::from_value::<Settings>(written).unwrap().merged_cleanup, chosen.merged_cleanup);

        // On for one project only, with the default left off.
        let one: Settings = serde_json::from_str(r#"{"mergedCleanup":{"projects":{"/repos/app":true}}}"#).unwrap();
        assert!(one.merged_cleanup.enabled_for("/repos/app") && !one.merged_cleanup.enabled_for("/repos/other"));

        for invalid in ["0", "1", "-10", "7.5", "\"10\"", "null", "99999999999"] {
            let damaged: Settings = serde_json::from_str(&format!(r#"{{"mergedCleanup":{{"graceMinutes":{invalid}}}}}"#)).unwrap();
            assert_eq!(damaged.merged_cleanup.grace_minutes, 10, "{invalid}");
        }
    }

    #[test]
    fn read_only_commands_default_on_and_an_explicit_opt_out_round_trips() {
        assert!(serde_json::from_str::<Settings>(r#"{"agents":{"idleStopMinutes":30}}"#).unwrap().agents.read_only_commands);
        let chosen: Settings = serde_json::from_str(r#"{"agents":{"readOnlyCommands":false}}"#).unwrap();
        assert!(!chosen.agents.read_only_commands);
        assert!(!serde_json::from_value::<Settings>(serde_json::to_value(chosen).unwrap()).unwrap().agents.read_only_commands);
    }

    #[test]
    fn idle_agents_stop_after_an_hour_unless_another_offered_limit_is_chosen() {
        let read = |raw: &str| serde_json::from_str::<Settings>(raw).unwrap().agents;
        // A settings file written before the limit existed.
        let older = read(r#"{"notifications":true}"#);
        assert_eq!(older.idle_stop_minutes, 60);
        assert_eq!(older.idle_limit(), Some(std::time::Duration::from_secs(3600)));

        for minutes in IDLE_STOP_MINUTES {
            let chosen = read(&format!(r#"{{"agents":{{"idleStopMinutes":{minutes}}}}}"#));
            assert_eq!(chosen.idle_stop_minutes, minutes);
            let written = serde_json::to_value(&Settings { agents: chosen.clone(), ..Settings::default() }).unwrap();
            assert_eq!(serde_json::from_value::<Settings>(written).unwrap().agents, chosen);
        }
        assert_eq!(read(r#"{"agents":{"idleStopMinutes":0}}"#).idle_limit(), None);
        assert_eq!(read(r#"{"agents":{"idleStopMinutes":240}}"#).idle_limit(), Some(std::time::Duration::from_secs(4 * 3600)));

        for invalid in ["1", "-30", "59.5", "\"60\"", "null", "99999999999"] {
            assert_eq!(read(&format!(r#"{{"agents":{{"idleStopMinutes":{invalid}}}}}"#)).idle_stop_minutes, 60, "{invalid}");
        }
    }

    #[test]
    fn idle_conversations_are_archived_after_a_week_unless_another_offered_limit_is_chosen() {
        let read = |raw: &str| serde_json::from_str::<Settings>(raw).unwrap().conversations;
        // A settings file written before the limit existed.
        let older = read(r#"{"notifications":true}"#);
        assert_eq!(older.archive_idle_days, 7);
        assert_eq!(older.archive_after(), Some(chrono::Duration::days(7)));

        for days in ARCHIVE_IDLE_DAYS {
            let chosen = read(&format!(r#"{{"conversations":{{"archiveIdleDays":{days}}}}}"#));
            assert_eq!(chosen.archive_idle_days, days);
            let written = serde_json::to_value(&Settings { conversations: chosen.clone(), ..Settings::default() }).unwrap();
            assert_eq!(serde_json::from_value::<Settings>(written).unwrap().conversations, chosen);
        }
        assert_eq!(read(r#"{"conversations":{"archiveIdleDays":0}}"#).archive_after(), None, "Never");
        assert_eq!(read(r#"{"conversations":{"archiveIdleDays":30}}"#).archive_after(), Some(chrono::Duration::days(30)));

        for invalid in ["2", "-7", "7.5", "\"7\"", "null", "99999999999"] {
            assert_eq!(read(&format!(r#"{{"conversations":{{"archiveIdleDays":{invalid}}}}}"#)).archive_idle_days, 7, "{invalid}");
        }
    }

    #[test]
    fn status_bar_defaults_on_and_used() {
        let settings: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(settings.status_bar, StatusBarSettings::default());
        assert!(settings.status_bar.visible);
        assert_eq!(settings.status_bar.percent, StatusPercent::Used);
    }

    #[test]
    fn usage_refresh_defaults_to_a_minute_and_keeps_only_offered_intervals() {
        let read = |raw: &str| serde_json::from_str::<Settings>(raw).unwrap().status_bar;
        // A settings file written before the interval existed.
        let older = read(r#"{"statusBar":{"visible":false}}"#);
        assert!(!older.visible);
        assert_eq!(older.usage_refresh_minutes, 1);
        // Chosen, but with the bar hidden there is nothing to keep fresh.
        assert_eq!(older.usage_refresh_ms(), None);
        assert_eq!(read(r#"{"statusBar":{"usage":false}}"#).usage_refresh_ms(), None);
        assert_eq!(read("{}").usage_refresh_ms(), Some(60_000));

        for minutes in USAGE_REFRESH_MINUTES {
            let chosen = read(&format!(r#"{{"statusBar":{{"usageRefreshMinutes":{minutes}}}}}"#));
            assert_eq!(chosen.usage_refresh_minutes, minutes);
            let written = serde_json::to_value(&Settings { status_bar: chosen.clone(), ..Settings::default() }).unwrap();
            assert_eq!(serde_json::from_value::<Settings>(written).unwrap().status_bar, chosen);
        }
        assert_eq!(read(r#"{"statusBar":{"usageRefreshMinutes":0}}"#).usage_refresh_ms(), None);
        assert_eq!(read(r#"{"statusBar":{"usageRefreshMinutes":5}}"#).usage_refresh_ms(), Some(300_000));

        for invalid in ["3", "-1", "0.5", "\"1\"", "null", "99999999999"] {
            let damaged = read(&format!(r#"{{"statusBar":{{"usageRefreshMinutes":{invalid}}}}}"#));
            assert_eq!(damaged.usage_refresh_minutes, 1, "{invalid}");
        }
    }
}
