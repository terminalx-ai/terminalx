//! Settings the Rust side needs before the webview exists. Anything the
//! frontend can read for itself lives in localStorage instead.

use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Where new worktrees go, relative to the project root.
    pub worktree_dir: String,
    /// Branch prefix for session worktrees.
    pub branch_prefix: String,
    /// Extra directories to search for agent binaries.
    pub extra_bin_dirs: Vec<String>,
    pub notifications: bool,
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
    /// The automatic refresh cadence, or `None` when the timer is off.
    pub fn usage_refresh_ms(&self) -> Option<i64> {
        (self.usage_refresh_minutes > 0).then(|| i64::from(self.usage_refresh_minutes) * 60_000)
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
            worktree_dir: ".raccoon/worktrees".into(),
            branch_prefix: "raccoon/".into(),
            extra_bin_dirs: Vec::new(),
            notifications: true,
            linear_api_key: None,
            linear_viewer: None,
            transcription_model: "apple".into(),
            transcription_input_device: None,
            transcription_mute: false,
            status_bar: StatusBarSettings::default(),
            floating: FloatingSettings::default(),
        }
    }
}

fn file_path() -> Result<PathBuf> {
    Ok(super::root()?.join("settings.json"))
}

pub fn load() -> Settings {
    file_path()
        .ok()
        .and_then(|p| super::read_json::<Settings>(&p).ok().flatten())
        .unwrap_or_default()
}

pub fn save(s: &Settings) -> Result<()> {
    let path = file_path()?;
    super::write_json(&path, s)?;
    // A new file is already owner-only; this is what tightens one left loose
    // by an older build, which matters because the file can hold a tracker
    // API key. Raccoon owns this file, so narrowing it is ours to do.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(older.usage_refresh_ms(), Some(60_000));

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
