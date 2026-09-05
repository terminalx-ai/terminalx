//! Computer use: let agents observe and operate desktop apps through the
//! `terminalx computer …` command family.
//!
//! The agent-facing contract (commands, flags, result shapes, error codes)
//! is inherited from the Legacy TerminalX app so the `computer-use` skill
//! already installed on user machines keeps working unchanged. The runtime
//! is different: instead of a Node sidecar, a [`ComputerService`] owned by
//! the app picks a [`ComputerProvider`] for the platform and speaks to it
//! directly.
//!
//! On macOS the provider is a signed helper app, "TerminalX Computer Use.app",
//! which owns the Accessibility and Screen Recording grants. Because the
//! grants belong to that bundle rather than to whichever process asks, a
//! plain agent shell can drive desktop apps without holding any permission
//! itself. That permission architecture is the whole reason the helper is a
//! separate bundle and not a library linked into the app.

pub mod cli;
pub mod macos_native;
pub mod permissions;
pub mod screenshot;
pub mod validation;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Wire name of the helper app bundle inside `Contents/Resources`.
pub const HELPER_APP_NAME: &str = "TerminalX Computer Use.app";
/// Executable inside the helper bundle.
pub const HELPER_EXECUTABLE_NAME: &str = "terminalx-computer-use-macos";
/// Environment override for the helper location (dev builds, smoke tests).
pub const HELPER_APP_PATH_ENV: &str = "TERMINALX_COMPUTER_MACOS_HELPER_APP_PATH";
/// The helper protocol this app speaks; the handshake must agree.
pub const REQUIRED_PROTOCOL_VERSION: u64 = 1;

/// A failure the agent can act on: `code` is one of the guide's error codes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComputerError {
    pub code: String,
    pub message: String,
}

impl ComputerError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_argument", message)
    }

    pub fn accessibility(message: impl Into<String>) -> Self {
        Self::new("accessibility_error", message)
    }

    /// The recovery line printed under an error, mirroring the skill guide's
    /// error section so a pretty-output failure teaches the same next step.
    pub fn recovery(&self) -> String {
        recovery_for(&self.code).into()
    }
}

impl std::fmt::Display for ComputerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ComputerError {}

pub fn recovery_for(code: &str) -> &'static str {
    match code {
        "app_not_found" => "Run terminalx computer list-apps and retry with the bundle id or pid:<n>; website names are not desktop apps.",
        "app_blocked" => "Stop; this app is intentionally blocked from computer use.",
        "window_not_found" | "window_stale" => "Run terminalx computer list-windows --app <app>, choose a current selector, then rerun get-app-state.",
        "window_not_focused" => "Retry once with --restore-window; if restore was already requested, bring the app forward manually.",
        "element_not_found" => "Run get-app-state again and use a fresh element index from the returned tree.",
        "unsupported_capability" => "Use a semantic alternative; if the message names a missing helper, build or reinstall TerminalX.",
        "action_not_supported" => "Inspect the element's listed actions and retry with one of those names, or use click or set-value.",
        "value_not_settable" => "Focus the element and use type-text, then inspect the returned state before assuming it landed.",
        "element_not_clickable" => "Use a parent or child element with a frame, or window-local coordinates from the latest screenshot.",
        "invalid_argument" => "Fix the command flags; do not retry the same command unchanged.",
        "action_timeout" => "Inspect current state before retrying; use --no-screenshot if observation is slow.",
        "screenshot_failed" => "Use --no-screenshot if the tree is enough; if Screen Recording is named, run terminalx computer permissions --id screenshots.",
        "accessibility_error" => "Run terminalx computer capabilities; if Accessibility is named, run terminalx computer permissions --id accessibility.",
        "permission_denied" => "Run terminalx computer permissions --json, grant the named permission to TerminalX Computer Use, then retry.",
        "provider_incompatible" => "Update TerminalX so the app and its computer-use helper match, then retry.",
        _ => "Report this error and stop rather than guessing at desktop state.",
    }
}

/// The action methods every provider may implement. Observation methods
/// (`listApps`, `listWindows`, `getAppState`) are separate trait methods.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionMethod {
    Click,
    PerformSecondaryAction,
    Scroll,
    Drag,
    TypeText,
    PressKey,
    Hotkey,
    PasteText,
    SetValue,
}

impl ActionMethod {
    pub fn from_wire(name: &str) -> Option<Self> {
        Some(match name {
            "click" => Self::Click,
            "performSecondaryAction" => Self::PerformSecondaryAction,
            "scroll" => Self::Scroll,
            "drag" => Self::Drag,
            "typeText" => Self::TypeText,
            "pressKey" => Self::PressKey,
            "hotkey" => Self::Hotkey,
            "pasteText" => Self::PasteText,
            "setValue" => Self::SetValue,
            _ => return None,
        })
    }

    /// The helper's method name.
    pub fn wire(self) -> &'static str {
        match self {
            Self::Click => "click",
            Self::PerformSecondaryAction => "performSecondaryAction",
            Self::Scroll => "scroll",
            Self::Drag => "drag",
            Self::TypeText => "typeText",
            Self::PressKey => "pressKey",
            Self::Hotkey => "hotkey",
            Self::PasteText => "pasteText",
            Self::SetValue => "setValue",
        }
    }

    /// The `supports.actions` key that must be true before the action is sent.
    pub fn capability_key(self) -> &'static str {
        match self {
            Self::PerformSecondaryAction => "performAction",
            other => other.wire(),
        }
    }
}

/// One platform backend. Methods take `&mut self` because a provider owns a
/// connection; the service serialises calls with a mutex.
pub trait ComputerProvider: Send {
    fn capabilities(&mut self) -> Result<Value, ComputerError>;
    fn list_apps(&mut self) -> Result<Value, ComputerError>;
    fn list_windows(&mut self, params: Value) -> Result<Value, ComputerError>;
    fn snapshot(&mut self, params: Value) -> Result<Value, ComputerError>;
    fn action(&mut self, method: ActionMethod, params: Value) -> Result<Value, ComputerError>;
    fn shutdown(&mut self);
}

/// Where the helper bundle may live, most specific first.
pub fn helper_app_candidates(resource_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os(HELPER_APP_PATH_ENV) {
        candidates.push(PathBuf::from(path));
    }
    if let Some(dir) = resource_dir {
        candidates.push(dir.join(HELPER_APP_NAME));
    }
    if let Ok(exe) = std::env::current_exe() {
        // <App>.app/Contents/MacOS/<exe> → <App>.app/Contents/Resources
        if let Some(contents) = exe.parent().and_then(Path::parent) {
            candidates.push(contents.join("Resources").join(HELPER_APP_NAME));
        }
    }
    if cfg!(debug_assertions) {
        let package = Path::new(env!("CARGO_MANIFEST_DIR")).join("../native/computer-use-macos/.build");
        candidates.push(package.join("release-dev").join(HELPER_APP_NAME));
        candidates.push(package.join("release").join(HELPER_APP_NAME));
    }
    candidates
}

pub fn helper_app_path(resource_dir: Option<&Path>) -> Option<PathBuf> {
    helper_app_candidates(resource_dir)
        .into_iter()
        .find(|candidate| helper_executable_in(candidate).is_some())
}

pub fn helper_executable_in(app: &Path) -> Option<PathBuf> {
    let executable = app.join("Contents/MacOS").join(HELPER_EXECUTABLE_NAME);
    executable.is_file().then_some(executable)
}

pub fn provider_unavailable_message() -> String {
    if cfg!(target_os = "macos") {
        format!(
            "computer-use has no native provider for macOS because {HELPER_APP_NAME} was not found or this macOS version is older than 14. For local development, run pnpm build:computer-macos and restart TerminalX from this worktree."
        )
    } else {
        format!(
            "computer-use has no native provider for {}; only macOS is supported in this release.",
            std::env::consts::OS
        )
    }
}

/// The app-wide entry point. Lazily starts a provider on first use and tears
/// it down on shutdown so no helper outlives the app.
pub struct ComputerService {
    resource_dir: Mutex<Option<PathBuf>>,
    provider: Mutex<Option<Box<dyn ComputerProvider>>>,
}

impl ComputerService {
    pub fn new(resource_dir: Option<PathBuf>) -> Self {
        Self {
            resource_dir: Mutex::new(resource_dir),
            provider: Mutex::new(None),
        }
    }

    /// Tauri only knows `Contents/Resources` once the app is running. This
    /// is also the app-start hook, so stale socket directories from a
    /// previous crash are swept here.
    pub fn set_resource_dir(&self, dir: PathBuf) {
        *self.resource_dir.lock().unwrap_or_else(|p| p.into_inner()) = Some(dir);
        #[cfg(unix)]
        {
            let removed = macos_native::sweep_stale_socket_dirs();
            if removed > 0 {
                log::info!("removed {removed} stale computer-use socket director{}", if removed == 1 { "y" } else { "ies" });
            }
        }
    }

    pub fn helper_app_path(&self) -> Option<PathBuf> {
        let dir = self.resource_dir.lock().unwrap_or_else(|p| p.into_inner()).clone();
        helper_app_path(dir.as_deref())
    }

    /// Dispatch one control command (`computer.<method>`), validating action
    /// parameters before they reach a provider and normalising the result so
    /// every action carries verification metadata.
    pub fn call(&self, method: &str, params: Value, request_id: &str) -> Result<Value, ComputerError> {
        match method {
            "permissions" => {
                let id = params.get("id").and_then(Value::as_str).map(str::to_owned);
                let id = match id.as_deref() {
                    None => None,
                    Some("accessibility") => Some(permissions::PermissionId::Accessibility),
                    Some("screenshots") => Some(permissions::PermissionId::Screenshots),
                    Some(_) => {
                        return Err(ComputerError::invalid(
                            "--id must be \"accessibility\" or \"screenshots\"",
                        ))
                    }
                };
                return serde_json::to_value(permissions::open_setup(self.helper_app_path().as_deref(), id)?)
                    .map_err(|e| ComputerError::accessibility(e.to_string()));
            }
            "permissionsStatus" => {
                return serde_json::to_value(permissions::status(self.helper_app_path().as_deref())?)
                    .map_err(|e| ComputerError::accessibility(e.to_string()));
            }
            "permissionsReset" => {
                return serde_json::to_value(permissions::reset(self.helper_app_path().as_deref())?)
                    .map_err(|e| ComputerError::accessibility(e.to_string()));
            }
            _ => {}
        }
        let mut guard = self.provider.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_none() {
            *guard = self.start_provider()?;
        }
        let Some(provider) = guard.as_mut() else {
            return Err(ComputerError::new(
                "unsupported_capability",
                provider_unavailable_message(),
            ));
        };
        let outcome = match method {
            "capabilities" => provider.capabilities(),
            "listApps" => provider.list_apps(),
            "listWindows" => provider.list_windows(params),
            "getAppState" => provider
                .snapshot(params)
                .map(|mut result| {
                    screenshot::export_to_file(&mut result, request_id);
                    result
                }),
            other => match ActionMethod::from_wire(other) {
                Some(action) => {
                    validation::validate_action_params(action, &params)?;
                    provider.action(action, params).map(|mut result| {
                        normalize_action_result(&mut result);
                        screenshot::export_to_file(&mut result, request_id);
                        result
                    })
                }
                None => Err(ComputerError::invalid(format!(
                    "unknown computer method '{other}'"
                ))),
            },
        };
        outcome
    }

    pub fn shutdown(&self) {
        let mut guard = self.provider.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(mut provider) = guard.take() {
            provider.shutdown();
        }
    }

    fn start_provider(&self) -> Result<Option<Box<dyn ComputerProvider>>, ComputerError> {
        if !cfg!(target_os = "macos") || !macos_native::is_macos_14_or_newer() {
            return Ok(None);
        }
        let Some(app) = self.helper_app_path() else {
            return Ok(None);
        };
        let Some(executable) = helper_executable_in(&app) else {
            return Ok(None);
        };
        Ok(Some(Box::new(macos_native::MacosNativeProvider::new(executable))))
    }
}

impl Drop for ComputerService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ------------------------------------------------------- settings UI commands

#[tauri::command]
pub fn computer_permission_status(
    state: tauri::State<'_, crate::AppState>,
) -> Result<permissions::PermissionStatusResult, String> {
    permissions::status(state.computer.helper_app_path().as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn computer_open_permission(
    state: tauri::State<'_, crate::AppState>,
    id: Option<permissions::PermissionId>,
) -> Result<permissions::PermissionSetupResult, String> {
    permissions::open_setup(state.computer.helper_app_path().as_deref(), id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn computer_reset_permissions(
    state: tauri::State<'_, crate::AppState>,
) -> Result<permissions::PermissionResetResult, String> {
    let result = permissions::reset(state.computer.helper_app_path().as_deref()).map_err(|e| e.to_string())?;
    // A helper that already holds a session keeps its old TCC decision
    // cached; restart it so the next call sees the reset.
    state.computer.shutdown();
    Ok(result)
}

/// Every action must say how it was verified. A helper that reports the
/// delivery path but no verification gets the matching "unverified" reason so
/// agents never mistake silence for success.
pub fn normalize_action_result(result: &mut Value) {
    let Some(action) = result.get_mut("action").and_then(Value::as_object_mut) else {
        return;
    };
    if action.get("verification").is_some_and(|v| !v.is_null()) {
        return;
    }
    let reason = match action.get("path").and_then(Value::as_str) {
        Some("synthetic") => "synthetic_input",
        Some("clipboard") => "clipboard_paste",
        Some("accessibility") => "accessibility_action_unasserted",
        _ => return,
    };
    action.insert(
        "verification".into(),
        json!({"state": "unverified", "reason": reason}),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalization_adds_the_reason_that_matches_the_delivery_path() {
        let mut synthetic = json!({"action": {"path": "synthetic"}});
        normalize_action_result(&mut synthetic);
        assert_eq!(synthetic["action"]["verification"]["reason"], "synthetic_input");

        let mut clipboard = json!({"action": {"path": "clipboard"}});
        normalize_action_result(&mut clipboard);
        assert_eq!(clipboard["action"]["verification"]["reason"], "clipboard_paste");

        let mut ax = json!({"action": {"path": "accessibility"}});
        normalize_action_result(&mut ax);
        assert_eq!(
            ax["action"]["verification"]["reason"],
            "accessibility_action_unasserted"
        );
    }

    #[test]
    fn normalization_keeps_existing_verification_and_missing_action() {
        let mut verified = json!({"action": {"path": "accessibility", "verification": {"state": "verified", "property": "value"}}});
        normalize_action_result(&mut verified);
        assert_eq!(verified["action"]["verification"]["state"], "verified");

        let mut none = json!({"snapshot": {}});
        normalize_action_result(&mut none);
        assert!(none.get("action").is_none());
    }

    #[test]
    fn action_methods_round_trip_and_map_to_capability_keys() {
        for name in [
            "click",
            "performSecondaryAction",
            "scroll",
            "drag",
            "typeText",
            "pressKey",
            "hotkey",
            "pasteText",
            "setValue",
        ] {
            let method = ActionMethod::from_wire(name).unwrap();
            assert_eq!(method.wire(), name);
        }
        assert_eq!(
            ActionMethod::PerformSecondaryAction.capability_key(),
            "performAction"
        );
        assert_eq!(ActionMethod::Click.capability_key(), "click");
        assert!(ActionMethod::from_wire("open").is_none());
    }

    #[test]
    fn every_guide_error_code_has_recovery_copy_in_the_terminalx_identity() {
        for code in [
            "app_not_found",
            "app_blocked",
            "window_not_found",
            "window_stale",
            "window_not_focused",
            "element_not_found",
            "unsupported_capability",
            "action_not_supported",
            "value_not_settable",
            "element_not_clickable",
            "invalid_argument",
            "action_timeout",
            "screenshot_failed",
            "accessibility_error",
            "permission_denied",
        ] {
            let copy = recovery_for(code);
            assert!(!copy.is_empty());
            assert!(!copy.contains("terminalx-legacy"));
        }
    }

    #[test]
    fn helper_candidates_prefer_the_environment_override_then_resources() {
        let resources = Path::new("/tmp/Resources");
        let candidates = helper_app_candidates(Some(resources));
        assert!(candidates.contains(&resources.join(HELPER_APP_NAME)));
        assert!(helper_executable_in(Path::new("/definitely/missing.app")).is_none());
    }
}
