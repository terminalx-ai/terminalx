//! macOS permission status and setup for the computer-use helper.
//!
//! TCC keys consent to the helper bundle, so every probe has to run *as* the
//! helper: status is read by launching the bundle through LaunchServices with
//! `--permission-status-file`, and the grant prompts are opened the same way
//! with `--permission <id>`. Executing the binary directly would make macOS
//! evaluate the calling app instead.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::ComputerError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionId {
    Accessibility,
    Screenshots,
}

impl PermissionId {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Accessibility => "accessibility",
            Self::Screenshots => "screenshots",
        }
    }

    pub fn human(self) -> &'static str {
        match self {
            Self::Accessibility => "Accessibility",
            Self::Screenshots => "Screen Recording",
        }
    }

    /// The TCC service name `tccutil reset` expects.
    pub fn tcc_service(self) -> &'static str {
        match self {
            Self::Accessibility => "Accessibility",
            Self::Screenshots => "ScreenCapture",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionState {
    pub id: PermissionId,
    /// `granted`, `not-granted`, or `unsupported` (non-macOS).
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatusResult {
    pub platform: String,
    pub helper_app_path: Option<String>,
    pub helper_unavailable_reason: Option<String>,
    pub permissions: Vec<PermissionState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSetupResult {
    pub platform: String,
    pub helper_app_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_id: Option<PermissionId>,
    pub opened_settings: bool,
    pub launched_helper: bool,
    pub permissions: Vec<PermissionState>,
    pub next_step: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResetResult {
    #[serde(flatten)]
    pub status: PermissionStatusResult,
    pub bundle_id: Option<String>,
}

fn platform() -> String {
    std::env::consts::OS.into()
}

fn unsupported_states() -> Vec<PermissionState> {
    [PermissionId::Accessibility, PermissionId::Screenshots]
        .into_iter()
        .map(|id| PermissionState {
            id,
            status: "unsupported".into(),
        })
        .collect()
}

fn not_granted_states() -> Vec<PermissionState> {
    [PermissionId::Accessibility, PermissionId::Screenshots]
        .into_iter()
        .map(|id| PermissionState {
            id,
            status: "not-granted".into(),
        })
        .collect()
}

pub fn next_step(permissions: &[PermissionState]) -> Option<String> {
    permissions
        .iter()
        .find(|permission| permission.status != "granted")
        .map(|missing| {
            format!(
                "Grant {} to TerminalX Computer Use, then retry get-app-state.",
                missing.id.human()
            )
        })
}

pub fn status(helper_app: Option<&Path>) -> Result<PermissionStatusResult, ComputerError> {
    if !cfg!(target_os = "macos") {
        return Ok(PermissionStatusResult {
            platform: platform(),
            helper_app_path: None,
            helper_unavailable_reason: None,
            permissions: unsupported_states(),
        });
    }
    let Some(app) = helper_app else {
        return Ok(unavailable(
            format!("{} was not found", super::HELPER_APP_NAME),
            None,
        ));
    };
    if super::helper_executable_in(app).is_none() {
        return Ok(unavailable(
            format!(
                "{}/Contents/MacOS/{} was not found",
                app.display(),
                super::HELPER_EXECUTABLE_NAME
            ),
            Some(app),
        ));
    }
    let raw = read_status_via_helper(app)?;
    let state = |id: PermissionId| PermissionState {
        id,
        status: raw
            .get(id.wire())
            .cloned()
            .unwrap_or_else(|| "not-granted".into()),
    };
    Ok(PermissionStatusResult {
        platform: platform(),
        helper_app_path: Some(app.to_string_lossy().into_owned()),
        helper_unavailable_reason: None,
        permissions: vec![state(PermissionId::Accessibility), state(PermissionId::Screenshots)],
    })
}

fn unavailable(reason: String, app: Option<&Path>) -> PermissionStatusResult {
    PermissionStatusResult {
        platform: platform(),
        helper_app_path: app.map(|p| p.to_string_lossy().into_owned()),
        helper_unavailable_reason: Some(reason),
        permissions: not_granted_states(),
    }
}

fn read_status_via_helper(app: &Path) -> Result<std::collections::HashMap<String, String>, ComputerError> {
    let dir = std::env::temp_dir().join(format!(
        "terminalx-computer-use-permissions-{}",
        uuid::Uuid::now_v7().simple()
    ));
    std::fs::create_dir_all(&dir)
        .map_err(|e| ComputerError::accessibility(format!("Could not check permissions: {e}")))?;
    let status_path = dir.join("status.json");
    let outcome = (|| {
        launch_status_probe(app, &status_path)?;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(text) = std::fs::read_to_string(&status_path) {
                return serde_json::from_str(&text).map_err(|e| {
                    ComputerError::accessibility(format!("Could not read permission status: {e}"))
                });
            }
            if Instant::now() >= deadline {
                return Err(ComputerError::accessibility("Timed out checking permissions"));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    })();
    let _ = std::fs::remove_dir_all(&dir);
    outcome
}

/// `open -g -j -n` launches a fresh helper instance in the background without
/// activating it, so a status probe never steals focus from the agent's app.
fn launch_status_probe(app: &Path, status_path: &Path) -> Result<(), ComputerError> {
    let mut child = std::process::Command::new("/usr/bin/open")
        .args(["-g", "-j", "-n"])
        .arg(app)
        .arg("--args")
        .arg("--permission-status-file")
        .arg(status_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|_| ComputerError::accessibility("Could not check permissions: failed to launch helper"))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                let output = child.wait_with_output().ok();
                let detail = output
                    .as_ref()
                    .map(|o| {
                        let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
                        if err.is_empty() {
                            String::from_utf8_lossy(&o.stdout).trim().to_string()
                        } else {
                            err
                        }
                    })
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| format!("exit {}", status.code().unwrap_or(-1)));
                return Err(ComputerError::accessibility(format!(
                    "Could not check permissions: {detail}"
                )));
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(ComputerError::accessibility("Timed out launching permission helper"));
            }
        }
    }
}

/// Open the system prompt (or the helper's setup window when no id is given).
pub fn open_setup(
    helper_app: Option<&Path>,
    permission: Option<PermissionId>,
) -> Result<PermissionSetupResult, ComputerError> {
    if !cfg!(target_os = "macos") {
        return Ok(PermissionSetupResult {
            platform: platform(),
            helper_app_path: None,
            permission_id: permission,
            opened_settings: false,
            launched_helper: false,
            permissions: unsupported_states(),
            next_step: None,
        });
    }
    let Some(app) = helper_app else {
        return Err(ComputerError::accessibility(format!(
            "{} was not found",
            super::HELPER_APP_NAME
        )));
    };
    let current = status(Some(app))?;
    if let Some(reason) = current.helper_unavailable_reason {
        return Err(ComputerError::accessibility(reason));
    }
    let next = next_step(&current.permissions);
    if permission.is_none() && next.is_none() {
        return Ok(PermissionSetupResult {
            platform: platform(),
            helper_app_path: current.helper_app_path,
            permission_id: None,
            opened_settings: false,
            launched_helper: false,
            permissions: current.permissions,
            next_step: None,
        });
    }
    close_setup_helpers(app);
    let mut command = std::process::Command::new("/usr/bin/open");
    command.arg("-n").arg(app).arg("--args");
    match permission {
        Some(id) => {
            command.arg("--permission").arg(id.wire());
        }
        None => {
            command.arg("--permissions");
        }
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| ComputerError::accessibility(format!("Could not open permission setup: {e}")))?;
    Ok(PermissionSetupResult {
        platform: platform(),
        helper_app_path: current.helper_app_path,
        permission_id: permission,
        opened_settings: permission.is_some(),
        launched_helper: true,
        permissions: current.permissions,
        next_step: next,
    })
}

/// Setup helpers are windowed; only one should be open. The pattern is
/// anchored on this helper's executable path so another TerminalX build's
/// setup window is left alone, and status probes (`--permission-status-file`)
/// are deliberately not matched.
fn close_setup_helpers(app: &Path) {
    let Some(executable) = super::helper_executable_in(app) else {
        return;
    };
    let executable = regex::escape(&executable.to_string_lossy());
    for pattern in [
        format!("^{executable}[[:space:]]+--permission([[:space:]]|$)"),
        format!("^{executable}[[:space:]]+--permissions([[:space:]]|$)"),
    ] {
        let _ = std::process::Command::new("/usr/bin/pkill")
            .args(["-f", &pattern])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Clear the helper's TCC rows so a stale denial can be re-prompted.
pub fn reset(helper_app: Option<&Path>) -> Result<PermissionResetResult, ComputerError> {
    if !cfg!(target_os = "macos") {
        return Ok(PermissionResetResult {
            status: PermissionStatusResult {
                platform: platform(),
                helper_app_path: None,
                helper_unavailable_reason: None,
                permissions: unsupported_states(),
            },
            bundle_id: None,
        });
    }
    let Some(app) = helper_app else {
        return Err(ComputerError::accessibility(format!(
            "{} was not found",
            super::HELPER_APP_NAME
        )));
    };
    let current = status(Some(app))?;
    if let Some(reason) = current.helper_unavailable_reason {
        return Err(ComputerError::accessibility(reason));
    }
    let bundle_id = read_bundle_id(app)?;
    close_setup_helpers(app);
    for id in [PermissionId::Accessibility, PermissionId::Screenshots] {
        let output = std::process::Command::new("/usr/bin/tccutil")
            .args(["reset", id.tcc_service(), &bundle_id])
            .output()
            .map_err(|e| ComputerError::accessibility(format!("Could not reset {}: {e}", id.tcc_service())))?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let detail = if detail.is_empty() {
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            } else {
                detail
            };
            return Err(ComputerError::accessibility(format!(
                "Could not reset {}: {}",
                id.tcc_service(),
                if detail.is_empty() { format!("exit {}", output.status.code().unwrap_or(-1)) } else { detail }
            )));
        }
    }
    Ok(PermissionResetResult {
        status: status(Some(app))?,
        bundle_id: Some(bundle_id),
    })
}

/// The bundle id is whatever the built helper declares; dev and release
/// helpers differ so their TCC rows stay apart, which is why a reset must
/// never guess: resetting the wrong identity would clear another build's
/// grants.
pub fn read_bundle_id(app: &Path) -> Result<String, ComputerError> {
    let plist: PathBuf = app.join("Contents/Info.plist");
    let output = std::process::Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleIdentifier"])
        .arg(&plist)
        .output()
        .map_err(|e| ComputerError::accessibility(format!("Could not read the helper bundle id: {e}")))?;
    let id = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || id.is_empty() {
        return Err(ComputerError::accessibility(format!(
            "Could not read the helper bundle id from {}",
            plist.display()
        )));
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_step_names_the_first_missing_permission() {
        let all = vec![
            PermissionState { id: PermissionId::Accessibility, status: "granted".into() },
            PermissionState { id: PermissionId::Screenshots, status: "granted".into() },
        ];
        assert_eq!(next_step(&all), None);
        let missing = vec![
            PermissionState { id: PermissionId::Accessibility, status: "granted".into() },
            PermissionState { id: PermissionId::Screenshots, status: "not-granted".into() },
        ];
        assert_eq!(
            next_step(&missing).unwrap(),
            "Grant Screen Recording to TerminalX Computer Use, then retry get-app-state."
        );
    }

    #[test]
    fn a_missing_helper_reports_unavailable_without_launching_anything() {
        let result = status(None).unwrap();
        if cfg!(target_os = "macos") {
            assert!(result.helper_unavailable_reason.unwrap().contains("was not found"));
            assert!(result.permissions.iter().all(|p| p.status == "not-granted"));
            assert_eq!(open_setup(None, None).unwrap_err().code, "accessibility_error");
        } else {
            assert!(result.permissions.iter().all(|p| p.status == "unsupported"));
        }
    }

    #[test]
    fn a_helper_without_a_readable_bundle_id_cannot_be_reset() {
        let dir = tempfile::tempdir().unwrap();
        let error = read_bundle_id(dir.path()).unwrap_err();
        assert_eq!(error.code, "accessibility_error");
        assert!(error.message.contains("bundle id"));
        let app = dir.path().join("Helper.app");
        std::fs::create_dir_all(app.join("Contents")).unwrap();
        std::fs::write(
            app.join("Contents/Info.plist"),
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>com.terminalx.next.dev.computer-use</string></dict></plist>\n",
        )
        .unwrap();
        if cfg!(target_os = "macos") {
            assert_eq!(read_bundle_id(&app).unwrap(), "com.terminalx.next.dev.computer-use");
        }
    }

    #[test]
    fn permission_results_serialize_in_the_legacy_shape() {
        let setup = PermissionSetupResult {
            platform: "macos".into(),
            helper_app_path: Some("/x.app".into()),
            permission_id: Some(PermissionId::Screenshots),
            opened_settings: true,
            launched_helper: true,
            permissions: vec![PermissionState { id: PermissionId::Screenshots, status: "not-granted".into() }],
            next_step: Some("step".into()),
        };
        let json = serde_json::to_value(&setup).unwrap();
        assert_eq!(json["permissionId"], "screenshots");
        assert_eq!(json["helperAppPath"], "/x.app");
        assert_eq!(json["permissions"][0]["id"], "screenshots");
        assert_eq!(json["launchedHelper"], true);
    }
}
