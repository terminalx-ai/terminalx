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
    /// What this launch's removal of older helpers' permissions reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_helper: Option<LegacyHelperCleanup>,
    pub permissions: Vec<PermissionState>,
}

/// Helpers released before PRO-90 trust whoever starts them and act on
/// TerminalX's own windows. macOS keys a permission to the signing identity,
/// not the version, so while one of these is still granted Accessibility any
/// program can run an old copy and use it. The current helper therefore has a
/// new bundle id, and the app takes the old ones' permissions away. This
/// module is the only code that may name the old ids.
pub const LEGACY_HELPER_BUNDLE_IDS: [&str; 2] = ["com.terminalx.next.computer-use", "com.terminalx.next.dev.computer-use"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyHelperCleanup {
    /// True when, in this launch, macOS reported every reset done. Never read
    /// from a file. False means the person has to remove the old entry in
    /// System Settings themselves.
    pub removed: bool,
    pub bundle_ids: Vec<String>,
}

pub fn is_legacy_helper(bundle_id: &str) -> bool {
    LEGACY_HELPER_BUNDLE_IDS.iter().any(|legacy| legacy.eq_ignore_ascii_case(bundle_id.trim()))
}

/// The released TerminalX app. Only it clears the released helper's old
/// permission.
pub const RELEASE_APP_IDENTIFIER: &str = "com.terminalx.next";

/// Which old identities this app clears, decided by the app's own bundle id
/// and not by how it was compiled: a Dev build, or any local build under
/// another id, leaves the released helper's permission alone, because an
/// older installed TerminalX may still be in use on that Mac. The old dev id
/// is cleared by every build. The id of the helper in use is never reset.
pub fn legacy_ids_to_reset(app_identifier: Option<&str>, current_helper: Option<&str>) -> Vec<&'static str> {
    let release_app = app_identifier.is_some_and(|id| id == RELEASE_APP_IDENTIFIER);
    LEGACY_HELPER_BUNDLE_IDS
        .into_iter()
        .filter(|id| release_app || id.contains(".dev."))
        .filter(|id| current_helper.is_none_or(|current| !current.eq_ignore_ascii_case(id)))
        .collect()
}

pub const TCCUTIL: &str = "/usr/bin/tccutil";
pub const LSREGISTER: &str =
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const STUB_APP_NAME: &str = "Old Helper Removal.app";

/// `tccutil reset` both services for one id. Both are attempted.
fn reset_both(id: &str, run: &mut dyn FnMut(&str, &[String]) -> bool) -> bool {
    let mut ok = true;
    for service in [PermissionId::Accessibility, PermissionId::Screenshots] {
        ok &= run(TCCUTIL, &["reset".into(), service.tcc_service().into(), id.into()]);
    }
    ok
}

/// A bundle that does nothing and declares `bundle_id`. `tccutil` refuses an
/// id LaunchServices cannot resolve, and after an update the old helper is no
/// longer on disk; this gives the id something to resolve to for the moment
/// of the reset. LaunchServices needs an executable in it, and ignores
/// bundles in temporary directories.
fn write_stub(app: &Path, bundle_id: &str) -> std::io::Result<()> {
    let macos = app.join("Contents/MacOS");
    std::fs::create_dir_all(&macos)?;
    std::fs::write(
        app.join("Contents/Info.plist"),
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>CFBundleIdentifier</key><string>{bundle_id}</string>\n<key>CFBundleName</key><string>Old Helper Removal</string>\n<key>CFBundleExecutable</key><string>stub</string>\n<key>CFBundlePackageType</key><string>APPL</string>\n<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>\n<key>CFBundleVersion</key><string>1</string>\n<key>LSUIElement</key><true/>\n</dict></plist>\n"
        ),
    )?;
    let executable = macos.join("stub");
    std::fs::write(&executable, "#!/bin/sh\nexit 0\n")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// Whether `path` lies inside `parent`, symlinks resolved (`/tmp` and
/// `/var` are links on macOS). The path need not exist yet: its nearest
/// existing ancestor is resolved and the rest appended.
pub fn is_under(path: &Path, parent: &Path) -> bool {
    fn resolve(path: &Path) -> PathBuf {
        let mut missing = Vec::new();
        let mut existing = path;
        loop {
            if let Ok(resolved) = existing.canonicalize() {
                return missing.iter().rev().fold(resolved, |joined, part| joined.join(part));
            }
            match (existing.parent(), existing.file_name()) {
                (Some(up), Some(name)) => {
                    missing.push(name.to_owned());
                    existing = up;
                }
                _ => return path.to_path_buf(),
            }
        }
    }
    resolve(path).starts_with(resolve(parent))
}

/// Register a stub for `id` under `base`, reset, then unregister and delete
/// it, whatever happened in between.
fn reset_through_stub(base: &Path, index: usize, id: &str, run: &mut dyn FnMut(&str, &[String]) -> bool) -> bool {
    let holder = base.join(format!("{}-{index}", std::process::id()));
    let app = holder.join(STUB_APP_NAME);
    let mut ok = write_stub(&app, id).is_ok();
    if ok {
        let path = app.to_string_lossy().into_owned();
        ok = run(LSREGISTER, &["-f".into(), path.clone()]) && reset_both(id, run);
        // Unregistered even when registering reported a failure or timed out.
        run(LSREGISTER, &["-u".into(), path]);
    }
    let _ = std::fs::remove_dir_all(&holder);
    ok
}

/// Remove the old helpers' permissions. `run(program, args)` is the only way
/// out to the system, so tests never run `tccutil`. `stub_base` must not be a
/// temporary directory (`None` when there is no such place: no stub is tried).
pub fn reset_legacy_helpers(
    stub_base: Option<&Path>,
    ids: &[&str],
    mut run: impl FnMut(&str, &[String]) -> bool,
) -> LegacyHelperCleanup {
    let mut removed = true;
    for (index, id) in ids.iter().enumerate() {
        // macOS still knows the old helper (a copy is on disk somewhere).
        let mut ok = reset_both(id, &mut run);
        if !ok {
            if let Some(base) = stub_base {
                ok = reset_through_stub(base, index, id, &mut run);
            }
        }
        removed &= ok;
    }
    if let Some(base) = stub_base {
        // Only if empty: another instance may be in the middle of its own.
        let _ = std::fs::remove_dir(base);
    }
    LegacyHelperCleanup {
        removed,
        bundle_ids: ids.iter().map(|id| id.to_string()).collect(),
    }
}

/// Where stubs are written: a folder of the app's own that is not temporary.
fn stub_base() -> Option<PathBuf> {
    let base = dirs::data_dir()?.join("TerminalX").join("old-helper-removal");
    (!is_under(&base, &std::env::temp_dir()) && !is_under(&base, Path::new("/tmp"))).then_some(base)
}

/// Run a system tool, giving it ten seconds. A tool that hangs is killed and
/// counts as failed.
fn run_with_timeout(program: &str, args: &[String]) -> bool {
    let Ok(mut child) = std::process::Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

static LEGACY_CLEANUP: std::sync::OnceLock<Option<LegacyHelperCleanup>> = std::sync::OnceLock::new();

/// Take the old helpers' permissions away. Runs at every launch (once per
/// launch): nothing on disk says "already done", because anything on disk
/// could be written by an agent to switch this off, and because an old
/// helper can be granted again at any time. Blocks until it has run; `None`
/// off macOS and in tests, which never run `tccutil`.
pub fn legacy_cleanup(app_identifier: Option<&str>, helper_app: Option<&Path>) -> Option<LegacyHelperCleanup> {
    if cfg!(test) || !cfg!(target_os = "macos") {
        return None;
    }
    LEGACY_CLEANUP
        .get_or_init(|| {
            let current = helper_app.and_then(|app| read_bundle_id(app).ok());
            let ids = legacy_ids_to_reset(app_identifier, current.as_deref());
            if ids.is_empty() {
                return None;
            }
            let cleanup = reset_legacy_helpers(stub_base().as_deref(), &ids, run_with_timeout);
            if cleanup.removed {
                log::info!("computer use: permissions of older helpers removed ({})", ids.join(", "));
            } else {
                log::warn!("computer use: macOS would not remove the permissions of older helpers ({}); trying again at the next launch", ids.join(", "));
            }
            Some(cleanup)
        })
        .clone()
}

/// What this launch's removal reported, without waiting for it: `None` while
/// it is still running (and where it never runs).
pub fn legacy_cleanup_result() -> Option<LegacyHelperCleanup> {
    LEGACY_CLEANUP.get().cloned().flatten()
}

/// Said wherever a failed removal must be visible: Settings, and the CLI.
pub const LEGACY_REMOVAL_FAILED: &str = "TerminalX could not remove the permission of the computer-use helper from an older version. Open System Settings > Privacy & Security and remove \"TerminalX Computer Use\" (not \"TerminalX Computer Use Helper\") from Accessibility and from Screen Recording: while it is listed, any program on this Mac can use that old helper.";

/// `terminalx computer capabilities` must not look fine while the helper has
/// no permission: add the permission states and, when one is missing, how to
/// give it.
pub fn attach_to_capabilities(capabilities: &mut serde_json::Value, status: &PermissionStatusResult) {
    let Some(object) = capabilities.as_object_mut() else {
        return;
    };
    object.insert("permissions".into(), serde_json::json!(status.permissions));
    if let Some(warning) = legacy_warning(status) {
        object.insert("warning".into(), serde_json::json!(warning));
    }
    if let Some(step) = next_step(&status.permissions) {
        object.insert(
            "nextStep".into(),
            serde_json::json!(format!("{step} Run `terminalx computer permissions`, or open TerminalX Settings > General > Computer use.")),
        );
    }
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
    /// Set when this launch could not remove an older helper's permission.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

fn legacy_warning(status: &PermissionStatusResult) -> Option<String> {
    status
        .legacy_helper
        .as_ref()
        .is_some_and(|legacy| !legacy.removed)
        .then(|| LEGACY_REMOVAL_FAILED.to_string())
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
                "Grant {} to TerminalX Computer Use Helper, then retry get-app-state. {UPGRADE_NOTE}",
                missing.id.human()
            )
        })
}

/// Why someone who granted computer use before is asked again.
pub const UPGRADE_NOTE: &str = "If you allowed computer use in an earlier TerminalX: its helper was replaced for security, macOS treats the new one as a new app, and the old helper's permission is removed, so grant it here once more.";

pub fn status(helper_app: Option<&Path>) -> Result<PermissionStatusResult, ComputerError> {
    if !cfg!(target_os = "macos") {
        return Ok(PermissionStatusResult {
            platform: platform(),
            helper_app_path: None,
            helper_unavailable_reason: None,
            legacy_helper: None,
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
        legacy_helper: legacy_cleanup_result(),
        permissions: vec![state(PermissionId::Accessibility), state(PermissionId::Screenshots)],
    })
}

fn unavailable(reason: String, app: Option<&Path>) -> PermissionStatusResult {
    PermissionStatusResult {
        platform: platform(),
        helper_app_path: app.map(|p| p.to_string_lossy().into_owned()),
        helper_unavailable_reason: Some(reason),
        legacy_helper: None,
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
            next_step: Some(desktop_preconditions().join("\n")),
            warning: None,
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
        let warning = legacy_warning(&current);
        return Ok(PermissionSetupResult {
            platform: platform(),
            helper_app_path: current.helper_app_path,
            permission_id: None,
            opened_settings: false,
            launched_helper: false,
            warning,
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
    let warning = legacy_warning(&current);
    Ok(PermissionSetupResult {
        platform: platform(),
        helper_app_path: current.helper_app_path,
        permission_id: permission,
        opened_settings: permission.is_some(),
        launched_helper: true,
        warning,
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
                legacy_helper: None,
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

/// Read-only prerequisites, shared by CLI setup output and Settings.
fn desktop_preconditions() -> Vec<String> {
    if cfg!(target_os = "linux") {
        let wayland = std::env::var("XDG_SESSION_TYPE").is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
            || std::env::var_os("WAYLAND_DISPLAY").is_some_and(|value| !value.is_empty());
        vec![
            "AT-SPI: install python3-gi gir1.2-atspi-2.0 at-spi2-core (and Gdk/GdkPixbuf for X11 screenshots).".into(),
            format!("Desktop session: XDG_RUNTIME_DIR={}, DBUS_SESSION_BUS_ADDRESS={}.",
                if std::env::var_os("XDG_RUNTIME_DIR").is_some_and(|v| !v.is_empty()) { "set" } else { "missing" },
                if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|v| !v.is_empty()) { "set" } else { "missing" }),
            format!("Session type: {}. Screenshots and hotkeys require X11; Wayland supports accessibility state and semantic actions.", if wayland { "Wayland" } else { "X11 or unspecified" }),
            format!("Optional X11 hotkeys, modifier clicks, and reliable text/key synthesis on older AT-SPI: xdotool {}.", if which::which("xdotool").is_ok() { "available" } else { "not found" }),
            format!("Optional clipboard paste: install wl-copy, xclip, or xsel ({}).", if ["wl-copy", "xclip", "xsel"].iter().any(|tool| which::which(tool).is_ok()) { "a clipboard tool is available" } else { "none found" }),
        ]
    } else if cfg!(windows) {
        vec!["UI Automation requires no permission grant. Windows PowerShell 5.1 or PowerShell 7 must be installed.".into(),
            "Elevated and UIPI-protected windows cannot be reached from a non-elevated TerminalX app.".into(),
            "Screenshots capture the desktop region: use --restore-window to bring the target forward.".into()]
    } else { vec!["Computer use has no provider for this platform.".into()] }
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
        assert!(next_step(&missing)
            .unwrap()
            .starts_with("Grant Screen Recording to TerminalX Computer Use Helper, then retry get-app-state."));
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
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>CFBundleIdentifier</key><string>com.terminalx.next.dev.computer-use.v2</string></dict></plist>\n",
        )
        .unwrap();
        if cfg!(target_os = "macos") {
            assert_eq!(read_bundle_id(&app).unwrap(), "com.terminalx.next.dev.computer-use.v2");
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
            warning: None,
        };
        let json = serde_json::to_value(&setup).unwrap();
        assert_eq!(json["permissionId"], "screenshots");
        assert_eq!(json["helperAppPath"], "/x.app");
        assert_eq!(json["permissions"][0]["id"], "screenshots");
        assert_eq!(json["launchedHelper"], true);
    }
    #[test]
    fn only_the_released_app_clears_the_released_helpers_old_permission() {
        let new_release = Some("com.terminalx.next.computer-use.v2");
        assert_eq!(
            legacy_ids_to_reset(Some("com.terminalx.next"), new_release),
            ["com.terminalx.next.computer-use", "com.terminalx.next.dev.computer-use"]
        );
        // A Dev build, a smoke build under its own id, and an app whose id is
        // unknown all leave the installed release helper alone, however they
        // were compiled.
        for app in [Some("com.terminalx.next.dev"), Some("dev.terminalx.smoke-a"), Some("COM.TERMINALX.NEXT"), None] {
            assert_eq!(legacy_ids_to_reset(app, new_release), ["com.terminalx.next.dev.computer-use"], "{app:?}");
        }
    }

    #[test]
    fn the_helper_in_use_is_never_reset_even_if_it_carries_an_old_id() {
        assert_eq!(
            legacy_ids_to_reset(Some("com.terminalx.next"), Some("com.terminalx.next.computer-use")),
            ["com.terminalx.next.dev.computer-use"]
        );
        assert!(legacy_ids_to_reset(Some("com.terminalx.next.dev"), Some("COM.terminalx.next.dev.computer-use")).is_empty());
    }

    #[test]
    fn old_identities_are_recognised_and_the_new_ones_are_not() {
        assert!(is_legacy_helper("com.terminalx.next.computer-use"));
        assert!(is_legacy_helper(" com.terminalx.next.dev.computer-use\n"));
        assert!(!is_legacy_helper("com.terminalx.next.computer-use.v2"));
        assert!(!is_legacy_helper("com.terminalx.next.dev.computer-use.v2"));
        assert!(!is_legacy_helper("com.terminalx.next"));
    }

    /// Records every command and answers from `answer`. Nothing real runs.
    fn recorder<'a>(log: &'a std::cell::RefCell<Vec<String>>, answer: impl Fn(&str, &[String]) -> bool + 'a) -> impl FnMut(&str, &[String]) -> bool + 'a {
        move |program, args| {
            let name = Path::new(program).file_name().unwrap().to_string_lossy().into_owned();
            log.borrow_mut().push(format!("{name} {}", args.join(" ")));
            answer(program, args)
        }
    }

    #[test]
    fn an_old_helper_macos_still_knows_is_reset_directly_without_a_stub() {
        let base = tempfile::tempdir().unwrap();
        let log = std::cell::RefCell::new(Vec::new());
        let done = reset_legacy_helpers(Some(base.path()), &["scratch.old"], recorder(&log, |_, _| true));
        assert!(done.removed);
        assert_eq!(*log.borrow(), ["tccutil reset Accessibility scratch.old", "tccutil reset ScreenCapture scratch.old"]);
        assert_eq!(done.bundle_ids, ["scratch.old"]);
    }

    #[test]
    fn an_old_helper_macos_no_longer_knows_is_reset_through_a_registered_stub_that_is_then_removed() {
        let home = tempfile::tempdir().unwrap();
        let base = home.path().join("old-helper-removal");
        let log = std::cell::RefCell::new(Vec::new());
        let registered = std::cell::Cell::new(false);
        let stub_seen = std::cell::RefCell::new(None::<(String, String)>);
        let done = reset_legacy_helpers(
            Some(&base),
            &["scratch.old.a", "scratch.old.b"],
            recorder(&log, |program, args| {
                if program == LSREGISTER {
                    let app = Path::new(&args[1]);
                    if args[0] == "-f" {
                        // The stub exists, declares the old id and has an executable.
                        let plist = std::fs::read_to_string(app.join("Contents/Info.plist")).unwrap();
                        let script = std::fs::read_to_string(app.join("Contents/MacOS/stub")).unwrap();
                        *stub_seen.borrow_mut() = Some((plist, script));
                    }
                    registered.set(args[0] == "-f");
                    return true;
                }
                // tccutil only works while the id resolves.
                registered.get()
            }),
        );
        assert!(done.removed);
        let log = log.borrow();
        let shape: Vec<String> = log.iter().map(|line| line.split(' ').take(3).collect::<Vec<_>>().join(" ")).collect();
        let per_id = |id: &str| vec![
            "tccutil reset Accessibility".to_string(), "tccutil reset ScreenCapture".into(),
            "lsregister -f".into(), "tccutil reset Accessibility".into(), "tccutil reset ScreenCapture".into(), "lsregister -u".into(),
        ].into_iter().map(move |line| (line, id.to_string())).collect::<Vec<_>>();
        let expected: Vec<(String, String)> = per_id("scratch.old.a").into_iter().chain(per_id("scratch.old.b")).collect();
        assert_eq!(shape.len(), expected.len());
        for (line, (prefix, id)) in log.iter().zip(&expected) {
            assert!(line.starts_with(prefix.as_str()), "{line}");
            if prefix.starts_with("tccutil") {
                assert!(line.ends_with(id.as_str()), "{line}");
            } else {
                assert!(line.ends_with("Old Helper Removal.app") && line.contains(&*base.to_string_lossy()), "{line}");
            }
        }
        let (plist, script) = stub_seen.borrow().clone().unwrap();
        assert!(plist.contains("<key>CFBundleIdentifier</key><string>scratch.old.b</string>"));
        assert!(plist.contains("<key>CFBundleExecutable</key><string>stub</string>"));
        assert_eq!(script, "#!/bin/sh\nexit 0\n");
        assert!(!base.exists(), "nothing is left on disk");
    }

    #[test]
    fn the_stub_is_unregistered_and_deleted_even_when_the_reset_fails_or_times_out() {
        let home = tempfile::tempdir().unwrap();
        let base = home.path().join("old-helper-removal");
        // A timed-out or failed tool is `false` to this code.
        for failing in ["tccutil", "lsregister -f"] {
            let log = std::cell::RefCell::new(Vec::new());
            let done = reset_legacy_helpers(
                Some(&base),
                &["scratch.old"],
                recorder(&log, |program, args| match failing {
                    "tccutil" => program == LSREGISTER,
                    _ => !(program == LSREGISTER && args[0] == "-f") && program != TCCUTIL,
                }),
            );
            assert!(!done.removed, "{failing}");
            let log = log.borrow();
            assert!(log.last().unwrap().starts_with("lsregister -u "), "{failing}: {log:?}");
            assert_eq!(log.iter().filter(|l| l.starts_with("lsregister -f")).count(), 1);
            assert!(!base.exists(), "{failing}: the stub is deleted");
        }
        // Without a place that is not temporary, no stub is tried at all.
        let log = std::cell::RefCell::new(Vec::new());
        assert!(!reset_legacy_helpers(None, &["scratch.old"], recorder(&log, |_, _| false)).removed);
        assert!(log.borrow().iter().all(|l| l.starts_with("tccutil")));
    }

    #[test]
    fn stubs_are_never_written_to_a_temporary_directory() {
        if let Some(base) = stub_base() {
            assert!(!is_under(&base, &std::env::temp_dir()), "{}", base.display());
            assert!(!is_under(&base, Path::new("/tmp")));
        }
        assert!(is_under(&std::env::temp_dir().join("x/y"), &std::env::temp_dir()));
        assert!(!is_under(Path::new("/Users/someone/Library/Application Support/TerminalX"), Path::new("/tmp")));
    }

    #[test]
    fn no_file_can_make_the_app_report_the_old_permission_removed() {
        // An agent writes what an earlier design read as "already done", in
        // the TerminalX home and next to the stubs. It changes nothing: the
        // reset still runs, and its failure is what gets reported.
        let home = tempfile::tempdir().unwrap();
        let base = home.path().join("old-helper-removal");
        std::fs::create_dir_all(&base).unwrap();
        let ids = legacy_ids_to_reset(Some(RELEASE_APP_IDENTIFIER), None);
        for dir in [home.path(), base.as_path()] {
            std::fs::write(dir.join("computer-use-legacy-helper-reset.json"), serde_json::to_vec(&ids).unwrap()).unwrap();
        }
        let mut calls = 0;
        let done = reset_legacy_helpers(Some(&base), &ids, |_, _| {
            calls += 1;
            false
        });
        assert!(calls >= 2 * ids.len(), "the reset ran");
        assert!(!done.removed);
        // And the code has nothing that reads a record of an earlier run.
        let source = include_str!("permissions.rs");
        let code = source.split("#[cfg(test)]").next().unwrap();
        assert!(!code.contains("read_json") && !code.contains("legacy-helper-reset"));
        assert!(legacy_cleanup(None, None).is_none(), "tests never run tccutil");
        assert!(legacy_cleanup_result().is_none());
    }

    #[test]
    fn capabilities_say_when_a_permission_is_missing_and_how_to_give_it() {
        let status = |a: &str, s: &str| PermissionStatusResult {
            platform: "macos".into(),
            helper_app_path: None,
            helper_unavailable_reason: None,
            legacy_helper: None,
            permissions: vec![
                PermissionState { id: PermissionId::Accessibility, status: a.into() },
                PermissionState { id: PermissionId::Screenshots, status: s.into() },
            ],
        };
        let mut missing = serde_json::json!({"provider": "x"});
        attach_to_capabilities(&mut missing, &status("not-granted", "granted"));
        assert_eq!(missing["permissions"][0]["status"], "not-granted");
        let step = missing["nextStep"].as_str().unwrap();
        assert!(step.starts_with("Grant Accessibility to TerminalX Computer Use Helper"));
        assert!(step.contains("replaced for security"));
        assert!(step.contains("terminalx computer permissions"));
        assert!(missing.get("warning").is_none());

        // A removal that failed in this launch is said here too.
        let mut failed = status("granted", "granted");
        failed.legacy_helper = Some(LegacyHelperCleanup { removed: false, bundle_ids: vec!["scratch.old".into()] });
        let mut warned = serde_json::json!({"provider": "x"});
        attach_to_capabilities(&mut warned, &failed);
        assert!(warned["warning"].as_str().unwrap().contains("could not remove"));

        let mut granted = serde_json::json!({"provider": "x"});
        attach_to_capabilities(&mut granted, &status("granted", "granted"));
        assert_eq!(granted["permissions"][1]["status"], "granted");
        assert!(granted.get("nextStep").is_none());
    }

    #[test]
    fn the_next_step_says_why_the_person_is_asked_again() {
        let step = next_step(&not_granted_states()).unwrap();
        assert!(step.contains("Grant Accessibility to TerminalX Computer Use Helper"));
        assert!(step.contains("If you allowed computer use in an earlier TerminalX"));
        assert!(step.contains("replaced for security"));
    }

}
