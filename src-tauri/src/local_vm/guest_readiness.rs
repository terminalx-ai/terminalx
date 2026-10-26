//! Passive guest setup observations. No provider turns, credential refresh,
//! Driver startup, permission requests, screenshots, or host fallback.
//!
//! Driver contract verified against trycua/cua tag cua-driver-rs-v0.28.0:
//! `permissions status --json` calls check_permissions with prompt:false and
//! never launches a daemon. During the startup gate it returns unknown rather
//! than either permission boolean. Live capture can prompt on macOS Tahoe and
//! is deliberately not a readiness probe.
use super::{Identity, State};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const DRIVER: &str = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const PROBE_LIMIT: u64 = 64 * 1024;
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Harness {
    Codex,
    Claude,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReadinessParams {
    environment_id: String,
    generation: String,
    pub harness: Harness,
}

impl ReadinessParams {
    pub fn validate(&self) -> Result<()> {
        super::validate_id(&self.environment_id)?;
        super::validate_id(&self.generation)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Check {
    pub state: &'static str,
    pub reason_code: &'static str,
    pub action_code: Option<&'static str>,
}

impl Check {
    fn new(
        state: &'static str,
        reason_code: &'static str,
        action_code: Option<&'static str>,
    ) -> Self {
        Self {
            state,
            reason_code,
            action_code,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Driver {
    #[serde(flatten)]
    pub check: Check,
    pub installed_version: Option<String>,
    pub installed_executable_sha256: Option<String>,
    required_version: &'static str,
    /// Public status does not report the serving daemon's exact version.
    runtime_version: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Desktop {
    pub driver: Driver,
    pub accessibility: Check,
    pub screen_recording: Check,
    pub session: Check,
    pub desktop: Check,
    pub capture: Check,
}

impl Desktop {
    fn unavailable(
        state: &'static str,
        reason: &'static str,
        action: Option<&'static str>,
    ) -> Self {
        Self {
            driver: Driver {
                check: Check::new(state, reason, action),
                installed_version: None,
                installed_executable_sha256: None,
                required_version: super::super::desktop::DRIVER_VERSION,
                runtime_version: None,
            },
            accessibility: Check::new("unknown", "driver_permission_status_unavailable", action),
            screen_recording: Check::new("unknown", "driver_permission_status_unavailable", action),
            session: Check::new("unknown", "desktop_session_not_checked", None),
            desktop: Check::new(
                if state == "unknown" {
                    "unknown"
                } else {
                    "blocked"
                },
                reason,
                action,
            ),
            capture: Check::new(
                "notProbed",
                "live_capture_may_prompt",
                Some("driver.requestPermissions"),
            ),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Provider {
    pub harness: Harness,
    #[serde(flatten)]
    pub check: Check,
    /// Authentication here is the CLI's local file-backed login state; it
    /// does not prove token validity, entitlement, network or a provider turn.
    evidence: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    valid_until: Option<String>,
    #[serde(skip)]
    binding: Option<AccountBinding>,
}

/// Only local selection and file metadata, never credentials or keychain data.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AccountBinding {
    executable_sha256: String,
    selection_sha256: String,
}

pub(super) fn codex_program(home: &Path) -> Option<PathBuf> {
    [
        ".terminalx-local/bin",
        ".local/bin",
        ".cargo/bin",
        ".npm-global/bin",
        ".bun/bin",
    ]
    .into_iter()
    .map(|dir| home.join(dir).join("codex"))
    .chain(
        [
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
            "/usr/bin/codex",
        ]
        .into_iter()
        .map(PathBuf::from),
    )
    .find(|path| path.is_file())
}

pub(super) fn account_selection_valid(home: &Path) -> bool {
    std::env::var_os("CODEX_HOME").is_none_or(|p| Path::new(&p) == home.join(".codex"))
        && ![
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "OPENAI_FEDERATION_RULE_ID",
            "OPENAI_IDENTITY_TOKEN_FILE",
            "CODEX_PROFILE",
        ]
        .iter()
        .any(|key| std::env::var_os(key).is_some())
}

pub(super) fn account_binding(home: &Path) -> Result<AccountBinding> {
    let mut selection = Vec::new();
    for name in [".codex", ".codex/config.toml", ".codex/auth.json"] {
        match std::fs::symlink_metadata(home.join(name)) {
            Ok(meta) => {
                if meta.file_type().is_symlink() || meta.uid() != unsafe { libc::geteuid() } {
                    bail!("Guest account storage has an unsupported owner or link");
                }
                if name == ".codex" {
                    selection.extend_from_slice(
                        format!("{name}:{}:{}:{};", meta.dev(), meta.ino(), meta.mode()).as_bytes(),
                    );
                } else {
                    selection.extend_from_slice(
                        format!(
                            "{name}:{}:{}:{}:{}:{}:{}:{}:{};",
                            meta.dev(),
                            meta.ino(),
                            meta.mode(),
                            meta.len(),
                            meta.mtime(),
                            meta.mtime_nsec(),
                            meta.ctime(),
                            meta.ctime_nsec()
                        )
                        .as_bytes(),
                    );
                }
                if name.ends_with("config.toml") {
                    let mut bytes = super::read_bounded(&home.join(name), PROBE_LIMIT as usize)?;
                    let config: toml::Value = toml::from_str(std::str::from_utf8(&bytes)?)?;
                    if config.get("profile").is_some() {
                        use zeroize::Zeroize as _;
                        bytes.zeroize();
                        bail!("Guest account profile requires explicit review");
                    }
                    selection.extend_from_slice(super::digest(&bytes).as_bytes());
                    use zeroize::Zeroize as _;
                    bytes.zeroize();
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                selection.extend_from_slice(format!("{name}:absent;").as_bytes())
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(AccountBinding {
        executable_sha256: executable_sha256(&codex_program(home).context("Guest Codex missing")?)?,
        selection_sha256: super::digest(&selection),
    })
}

pub(super) struct Observed {
    desktop: Desktop,
    provider: Provider,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Readiness<'a> {
    protocol: u32,
    environment_id: &'a str,
    generation: &'a str,
    runtime: Runtime<'a>,
    #[serde(flatten)]
    observed: ObservedWire,
    manual_control: bool,
    active_task_targets: Vec<&'a super::TaskTarget>,
    action_admission: Check,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Runtime<'a> {
    version: &'static str,
    identity: &'a Identity,
    state: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ObservedWire {
    #[serde(flatten)]
    desktop: Desktop,
    provider: Provider,
}

impl<'a> Readiness<'a> {
    pub(super) fn new(
        identity: &'a Identity,
        state: &'a State,
        mut observed: Observed,
        owner_busy: bool,
    ) -> Self {
        if matches!(observed.provider.harness, Harness::Codex)
            && observed.provider.check.reason_code
                == "provider_credential_store_requires_interaction"
        {
            let boot = super::boot_identity();
            let latest = state
                .setup_operations
                .values()
                .filter(|op| {
                    op.environment_id == identity.environment_id
                        && op.generation == identity.generation
                        && op.receipt.action == super::setup::Action::AccountVerify
                })
                .max_by_key(|op| &op.started_at)
                .filter(|op| {
                    op.helper_exit_confirmed && op.receipt.status == super::setup::Status::Complete
                })
                .and_then(|op| op.receipt.account_verification.as_ref());
            if let Some(proof) = latest
                .filter(|proof| proof.current(boot.as_deref(), observed.provider.binding.as_ref()))
            {
                observed.provider.check = if proof.authenticated {
                    Check::new(
                        "authenticated",
                        "provider_explicit_local_account_confirmed",
                        None,
                    )
                } else {
                    Check::new(
                        "unauthenticated",
                        "provider_explicit_local_account_missing",
                        Some("provider.codexDeviceLogin.start"),
                    )
                };
                observed.provider.evidence = "recentExplicitLocalAccountReceipt";
                observed.provider.valid_until =
                    chrono::DateTime::parse_from_rfc3339(&proof.verified_at)
                        .ok()
                        .map(|at| (at + chrono::Duration::minutes(10)).to_rfc3339());
            }
        }
        let active_task_targets: Vec<_> = state
            .records
            .values()
            .filter(|record| !record.task.status.terminal())
            .map(|record| &record.task.target)
            .collect();
        let manual_control = state.manual_lease.is_some();
        let action_admission = if manual_control {
            Check::new(
                "blocked",
                "manual_desktop_lease_held",
                Some("desktop.release"),
            )
        } else if !active_task_targets.is_empty() {
            Check::new("blocked", "guest_task_unresolved", Some("task.resolve"))
        } else if owner_busy
            || super::setup::holds_admission(state, super::boot_identity().as_deref())
        {
            Check::new(
                "blocked",
                "guest_setup_helper_exit_unconfirmed",
                Some("provider.codexDeviceLogin.cancel"),
            )
        } else {
            Check::new("ready", "guest_setup_actions_admitted", None)
        };
        Self {
            protocol: 1,
            environment_id: &identity.environment_id,
            generation: &identity.generation,
            runtime: Runtime {
                version: env!("CARGO_PKG_VERSION"),
                identity,
                state: "ready",
            },
            observed: ObservedWire {
                desktop: observed.desktop,
                provider: observed.provider,
            },
            manual_control,
            active_task_targets,
            action_admission,
        }
    }
}

pub(super) fn observe(base: &Path, harness: Harness) -> Result<Observed> {
    super::super::desktop::check_identity()?;
    let home = base.parent().context("Guest home missing")?;
    let (desktop, provider) = std::thread::scope(|scope| {
        let desktop = scope.spawn(inspect_desktop);
        let provider = inspect_provider(home, harness);
        (
            desktop
                .join()
                .map_err(|_| anyhow::anyhow!("Desktop readiness probe failed")),
            provider,
        )
    });
    Ok(Observed {
        desktop: desktop??,
        provider,
    })
}

/// Only finite, locally inspected CLI verbs are passed here. Preserve exit
/// codes without exposing stdout/stderr (login status can include key bytes).
struct Probe {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Drop for Probe {
    fn drop(&mut self) {
        use zeroize::Zeroize as _;
        self.stdout.zeroize();
        self.stderr.zeroize();
    }
}

struct ProbeChild(std::process::Child);
impl Drop for ProbeChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command(program: &Path, home: &Path) -> Command {
    let mut command = Command::new(program);
    // No login shell, inherited credential selector, Driver override, control
    // token or auth helper can change this pinned guest observation.
    command
        .env_clear()
        .env("HOME", home)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("LANG", "en_US.UTF-8")
        .current_dir(home);
    command
}

fn probe(command: &mut Command, timeout: Duration) -> Result<Probe> {
    let mut child = ProbeChild(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Readiness probe could not start")?,
    );
    let deadline = Instant::now() + timeout;
    let read = |mut pipe: Box<dyn Read + Send>| {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let result = pipe
                .by_ref()
                .take(PROBE_LIMIT + 1)
                .read_to_end(&mut bytes)
                .map(|_| bytes)
                .and_then(|bytes| {
                    if bytes.len() as u64 > PROBE_LIMIT {
                        Err(std::io::Error::other("Readiness output exceeds limit"))
                    } else {
                        Ok(bytes)
                    }
                });
            let _ = tx.send(result);
        });
        rx
    };
    let stdout = read(Box::new(
        child.0.stdout.take().context("Missing probe stdout")?,
    ));
    let stderr = read(Box::new(
        child.0.stderr.take().context("Missing probe stderr")?,
    ));
    let status = loop {
        if let Some(status) = child.0.try_wait()? {
            break status;
        }
        if Instant::now() >= deadline {
            bail!("Readiness probe timed out");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    Ok(Probe {
        code: status.code(),
        stdout: stdout.recv_timeout(deadline.saturating_duration_since(Instant::now()))??,
        stderr: stderr.recv_timeout(deadline.saturating_duration_since(Instant::now()))??,
    })
}

pub(super) fn inspect_desktop() -> Result<Desktop> {
    inspect_desktop_with(
        Path::new(DRIVER),
        Path::new("/Users/lume"),
        session_observation,
    )
}

fn inspect_desktop_with(
    program: &Path,
    home: &Path,
    session: impl FnOnce() -> Check,
) -> Result<Desktop> {
    if !program.try_exists()? {
        return Ok(Desktop::unavailable(
            "missing",
            "driver_not_installed",
            Some("driver.install"),
        ));
    }
    let version = probe(command(program, home).arg("--version"), PROBE_TIMEOUT);
    let installed_version = version
        .as_ref()
        .ok()
        .filter(|p| p.code == Some(0))
        .and_then(|p| parse_version(&p.stdout));
    let Some(installed_version) = installed_version else {
        return Ok(Desktop::unavailable(
            "unknown",
            "driver_version_unreadable",
            Some("driver.inspect"),
        ));
    };
    if installed_version != super::super::desktop::DRIVER_VERSION {
        let mut result = Desktop::unavailable(
            "versionMismatch",
            "driver_version_mismatch",
            Some("driver.install"),
        );
        result.driver.installed_version = Some(installed_version);
        return Ok(result);
    }
    let status = probe(command(program, home).arg("status"), PROBE_TIMEOUT);
    let permissions = probe(
        command(program, home).args(["permissions", "status", "--json"]),
        PROBE_TIMEOUT,
    );
    let mut result =
        desktop_from_probes(installed_version, status.ok(), permissions.ok(), session());
    result.driver.installed_executable_sha256 = executable_sha256(program).ok();
    Ok(result)
}

pub(super) fn executable_sha256(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn parse_version(bytes: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(bytes).ok()?.trim();
    let mut parts = text.split_whitespace();
    if !matches!(parts.next(), Some("cua-driver" | "cua-driver-rs")) {
        return None;
    }
    let version = parts.next()?.trim_start_matches('v');
    if parts.next().is_some()
        || version.split('.').count() != 3
        || !version
            .split('.')
            .all(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some(version.into())
}

fn desktop_from_probes(
    version: String,
    status: Option<Probe>,
    permissions: Option<Probe>,
    session: Check,
) -> Desktop {
    let mut result = Desktop::unavailable(
        "unknown",
        "driver_status_unreadable",
        Some("driver.inspect"),
    );
    result.driver.installed_version = Some(version);
    result.session = session;
    let running = status.as_ref().is_some_and(|p| {
        p.code == Some(0)
            && std::str::from_utf8(&p.stdout)
                .is_ok_and(|s| s.lines().next() == Some("Cua Driver daemon is running"))
    });
    if !running {
        if status
            .as_ref()
            .is_some_and(|p| p.code == Some(1) && p.stderr == b"Cua Driver daemon is not running\n")
        {
            result.driver.check =
                Check::new("stopped", "driver_daemon_stopped", Some("driver.start"));
            result.desktop = Check::new("blocked", "driver_daemon_stopped", Some("driver.start"));
        }
        return result;
    }
    result.driver.check = Check::new("running", "driver_daemon_running_version_unverified", None);
    let payload = permissions
        .filter(|p| p.code == Some(0))
        .and_then(|p| serde_json::from_slice::<Value>(&p.stdout).ok());
    match payload {
        Some(value) if value["status"] == "unknown" && value["daemon_running"] == false => {
            result.accessibility = Check::new(
                "unknown",
                "driver_permission_status_blocked_or_unattributed",
                Some("driver.requestPermissions"),
            );
            result.screen_recording = Check::new(
                "unknown",
                "driver_permission_status_blocked_or_unattributed",
                Some("driver.requestPermissions"),
            );
        }
        Some(value)
            if value.pointer("/source/attribution").and_then(Value::as_str)
                == Some("driver-daemon")
                && value.pointer("/source/bundle_id").and_then(Value::as_str)
                    == Some("com.trycua.driver") =>
        {
            result.accessibility = permission(&value, "accessibility", "accessibility_required");
            result.screen_recording =
                permission(&value, "screen_recording", "screen_recording_required");
        }
        _ => {}
    }
    result.desktop = if result.accessibility.state == "required" {
        Check::new(
            "blocked",
            "accessibility_required",
            Some("driver.requestPermissions"),
        )
    } else if result.screen_recording.state == "required" {
        Check::new(
            "blocked",
            "screen_recording_required",
            Some("driver.requestPermissions"),
        )
    } else if result.session.state == "blocked" {
        Check::new(
            "blocked",
            result.session.reason_code,
            result.session.action_code,
        )
    } else {
        // TCC preflight and a current GUI session cannot prove live capture.
        Check::new(
            "unknown",
            "desktop_live_capture_unverified",
            Some("driver.requestPermissions"),
        )
    };
    if result.accessibility.state == "granted" && result.screen_recording.state == "granted" {
        let action = (result.session.state != "blocked").then_some("desktop.verify");
        result.capture.action_code = action;
        result.desktop.action_code = action.or(result.session.action_code);
    }
    result
}

fn permission(value: &Value, field: &str, reason: &'static str) -> Check {
    match value.get(field).and_then(Value::as_bool) {
        Some(true) => Check::new("granted", "driver_permission_granted", None),
        Some(false) => Check::new("required", reason, Some("driver.requestPermissions")),
        None => Check::new(
            "unknown",
            "driver_permission_status_invalid",
            Some("driver.inspect"),
        ),
    }
}

fn inspect_provider(home: &Path, harness: Harness) -> Provider {
    let mut result = Provider {
        harness,
        check: Check::new(
            "unknown",
            "provider_passive_auth_unsupported",
            Some("provider.inspect"),
        ),
        evidence: "notProbed",
        valid_until: None,
        binding: if matches!(harness, Harness::Codex) {
            account_binding(home).ok()
        } else {
            None
        },
    };
    let name = match harness {
        Harness::Codex => "codex",
        Harness::Claude => "claude",
    };
    let program = [
        ".terminalx-local/bin",
        ".local/bin",
        ".cargo/bin",
        ".npm-global/bin",
        ".bun/bin",
        ".claude/local",
    ]
    .into_iter()
    .map(|p| home.join(p).join(name))
    .chain(
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
            .into_iter()
            .map(|p| PathBuf::from(p).join(name)),
    )
    .find(|p| p.is_file());
    let Some(program) = program else {
        result.check = Check::new(
            "missing",
            "provider_cli_not_installed",
            Some("provider.install"),
        );
        return result;
    };
    if !matches!(harness, Harness::Codex) {
        return result;
    }
    if std::env::var_os("CODEX_HOME").is_some_and(|p| Path::new(&p) != home.join(".codex"))
        || [
            "OPENAI_API_KEY",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "OPENAI_FEDERATION_RULE_ID",
            "OPENAI_IDENTITY_TOKEN_FILE",
            "CODEX_PROFILE",
        ]
        .iter()
        .any(|key| std::env::var_os(key).is_some())
    {
        result.check = Check::new(
            "unknown",
            "provider_auth_selection_requires_explicit_inspection",
            Some("provider.inspect"),
        );
        return result;
    }
    // CLI status is local and performs no refresh in the inspected Codex
    // source. A keyring read or auth helper might prompt, so only an explicit
    // file-store configuration is eligible. Do not override a keyring login
    // and then incorrectly tell the person that they are signed out.
    let config = super::read_bounded(&home.join(".codex/config.toml"), PROBE_LIMIT as usize)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| toml::from_str::<toml::Value>(&s).ok());
    if config.as_ref().is_some_and(|c| c.get("profile").is_some())
        || config
            .as_ref()
            .and_then(|c| c.get("cli_auth_credentials_store"))
            .and_then(toml::Value::as_str)
            != Some("file")
    {
        result.check = Check::new(
            "unknown",
            "provider_credential_store_requires_interaction",
            Some("provider.codexAccount.verify"),
        );
        return result;
    }
    let auth = home.join(".codex/auth.json");
    if let Ok(meta) = std::fs::symlink_metadata(&auth) {
        // No symlink or shared auth file is admitted to this passive check.
        if !meta.is_file() || meta.mode() & 0o077 != 0 || meta.uid() != unsafe { libc::geteuid() } {
            result.check = Check::new(
                "unknown",
                "provider_auth_storage_invalid",
                Some("provider.inspect"),
            );
            return result;
        }
    }
    let reply = probe(
        command(&program, home)
            .env("CODEX_HOME", home.join(".codex"))
            .args([
                "login",
                "status",
                "-c",
                "cli_auth_credentials_store=\"file\"",
                "-c",
                "check_for_update_on_startup=false",
            ]),
        PROBE_TIMEOUT,
    );
    result.check = codex_auth_status(reply.ok());
    result.evidence = "localFileLoginStatus";
    result
}

fn codex_auth_status(reply: Option<Probe>) -> Check {
    match reply {
        Some(p)
            if p.code == Some(0)
                && matches!(
                    p.stderr.as_slice(),
                    b"Logged in using ChatGPT\n"
                        | b"Logged in using access token\n"
                        | b"Logged in using personal access token\n"
                ) =>
        {
            Check::new("authenticated", "provider_local_login_present", None)
        }
        Some(p) if p.code == Some(0) && p.stderr.starts_with(b"Logged in using an API key - ") => {
            Check::new("authenticated", "provider_local_login_present", None)
        }
        Some(p) if p.code == Some(1) && p.stderr == b"Not logged in\n" => Check::new(
            "unauthenticated",
            "provider_not_authenticated",
            Some("provider.codexDeviceLogin.start"),
        ),
        _ => Check::new(
            "unknown",
            "provider_auth_status_unreadable",
            Some("provider.inspect"),
        ),
    }
}

#[cfg(not(target_os = "macos"))]
fn session_observation() -> Check {
    Check::new("unknown", "guest_macos_session_required", None)
}

#[cfg(target_os = "macos")]
fn session_observation() -> Check {
    use std::ffi::c_void;
    type Ref = *const c_void;
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> Ref;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayPixelsWide(display: u32) -> usize;
        fn CGDisplayPixelsHigh(display: u32) -> usize;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(value: Ref);
        fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
        fn CFGetTypeID(value: Ref) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(value: Ref) -> u8;
        fn CFStringCreateWithBytes(
            allocator: Ref,
            bytes: *const u8,
            length: isize,
            encoding: u32,
            external: u8,
        ) -> Ref;
    }
    // These metadata queries do not request AX/TCC or capture pixels. A
    // logged-in/on-console session still does not prove an unlocked screen.
    unsafe {
        let session = CGSessionCopyCurrentDictionary();
        if session.is_null() {
            return Check::new(
                "blocked",
                "guest_gui_session_unavailable",
                Some("desktop.open"),
            );
        }
        let boolean = |key: &[u8]| {
            // CGSession.h defines its public keys with CFSTR macros, not
            // exported symbols. Construct equal CFStrings without relying on
            // an Objective-C/AppKit runtime or an undocumented lock key.
            let key = CFStringCreateWithBytes(
                std::ptr::null(),
                key.as_ptr(),
                key.len() as isize,
                0x08000100,
                0,
            );
            if key.is_null() {
                return None;
            }
            let value = CFDictionaryGetValue(session, key);
            let result = if value.is_null() || CFGetTypeID(value) != CFBooleanGetTypeID() {
                None
            } else {
                Some(CFBooleanGetValue(value) != 0)
            };
            CFRelease(key);
            result
        };
        let on_console = boolean(b"kCGSSessionOnConsoleKey");
        let logged_in = boolean(b"kCGSessionLoginDoneKey");
        CFRelease(session);
        let display = CGMainDisplayID();
        if on_console == Some(false)
            || logged_in == Some(false)
            || display == 0
            || CGDisplayPixelsWide(display) == 0
            || CGDisplayPixelsHigh(display) == 0
        {
            Check::new(
                "blocked",
                "guest_gui_session_unavailable",
                Some("desktop.open"),
            )
        } else {
            Check::new(
                "unknown",
                "guest_screen_unlock_unverified",
                Some("desktop.open"),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn reply(code: i32, stdout: Value) -> Probe {
        Probe {
            code: Some(code),
            stdout: serde_json::to_vec(&stdout).unwrap(),
            stderr: vec![],
        }
    }
    fn running() -> Probe {
        Probe {
            code: Some(0),
            stdout: b"Cua Driver daemon is running\n  pid: 12\n".to_vec(),
            stderr: vec![],
        }
    }
    fn session() -> Check {
        Check::new(
            "unknown",
            "guest_screen_unlock_unverified",
            Some("desktop.open"),
        )
    }
    fn permissions(ax: Value, sr: Value, attribution: &str, bundle: &str) -> Value {
        json!({"accessibility":ax,"screen_recording":sr,
            "source":{"attribution":attribution,"bundle_id":bundle}})
    }

    #[test]
    fn readiness_parameters_reject_prompt_and_target_or_provider_overrides() {
        let valid = json!({"environmentId":super::super::super::journal::new_id(),
            "generation":super::super::super::journal::new_id(),"harness":"codex"});
        let params: ReadinessParams = serde_json::from_value(valid.clone()).unwrap();
        params.validate().unwrap();
        for (key, value) in [
            ("prompt", json!(true)),
            ("host", json!(true)),
            ("target", json!({})),
            ("CODEX_HOME", json!("/tmp/other")),
        ] {
            let mut changed = valid.clone();
            changed[key] = value;
            assert!(
                serde_json::from_value::<ReadinessParams>(changed).is_err(),
                "{key}"
            );
        }
        let mut changed = valid;
        changed["harness"] = json!("arbitrary-command");
        assert!(serde_json::from_value::<ReadinessParams>(changed).is_err());
    }

    #[test]
    fn only_the_latest_bound_explicit_account_check_can_complete_unknown_auth() {
        use super::super::setup::{AccountVerification, Action, Operation, Params, Status};
        let Some(boot) = super::super::boot_identity() else {
            return;
        };
        let identity = Identity {
            environment_id: super::super::super::journal::new_id(),
            generation: super::super::super::journal::new_id(),
            protocol: 1,
        };
        let binding = AccountBinding {
            executable_sha256: "a".repeat(64),
            selection_sha256: "b".repeat(64),
        };
        let params = Params {
            environment_id: identity.environment_id.clone(),
            generation: identity.generation.clone(),
            action: Action::AccountVerify,
            idempotency_key: "first".into(),
            confirm: true,
            login_id: None,
        };
        let mut op = Operation::working(&params, Some(boot.clone())).unwrap();
        op.receipt.status = Status::Complete;
        op.helper_exit_confirmed = true;
        op.receipt.account_verification = Some(AccountVerification {
            boot_identity: boot,
            verified_at: super::super::now(),
            binding: binding.clone(),
            authenticated: true,
        });
        let mut state = State {
            identity: identity.clone(),
            records: Default::default(),
            canceled_targets: Default::default(),
            manual_lease: None,
            provisioning_baseline: None,
            setup_operations: std::collections::BTreeMap::from([("first".into(), op.clone())]),
        };
        let inspect = |state: &State, reason: &'static str| {
            let observed = Observed {
                desktop: Desktop::unavailable("missing", "driver_not_installed", None),
                provider: Provider {
                    harness: Harness::Codex,
                    check: Check::new("unknown", reason, Some("provider.codexAccount.verify")),
                    evidence: "notProbed",
                    valid_until: None,
                    binding: Some(binding.clone()),
                },
            };
            serde_json::to_value(Readiness::new(&identity, state, observed, false)).unwrap()
        };
        let confirmed = inspect(&state, "provider_credential_store_requires_interaction");
        assert_eq!(confirmed["provider"]["state"], "authenticated");
        assert!(confirmed["provider"]["validUntil"].is_string());
        assert_eq!(
            inspect(
                &state,
                "provider_auth_selection_requires_explicit_inspection"
            )["provider"]["state"],
            "unknown"
        );
        let mut newer = op.clone();
        newer.started_at =
            Some((chrono::Utc::now() + chrono::Duration::milliseconds(1)).to_rfc3339());
        newer.receipt.idempotency_key = "second".into();
        newer
            .receipt
            .account_verification
            .as_mut()
            .unwrap()
            .authenticated = false;
        state.setup_operations.insert("second".into(), newer);
        assert_eq!(
            inspect(&state, "provider_credential_store_requires_interaction")["provider"]["state"],
            "unauthenticated"
        );
        state
            .setup_operations
            .get_mut("second")
            .unwrap()
            .receipt
            .status = Status::Failed;
        assert_eq!(
            inspect(&state, "provider_credential_store_requires_interaction")["provider"]["state"],
            "unknown"
        );
        state.setup_operations.clear();
        op.generation = super::super::super::journal::new_id();
        state.setup_operations.insert("first".into(), op);
        assert_eq!(
            inspect(&state, "provider_credential_store_requires_interaction")["provider"]["state"],
            "unknown"
        );
    }

    #[test]
    fn readiness_binds_full_runtime_identity_and_observation_cannot_release_manual_control() {
        let identity = Identity {
            environment_id: "env-1".into(),
            generation: "gen-1".into(),
            protocol: 1,
        };
        let state = State {
            identity: identity.clone(),
            records: Default::default(),
            canceled_targets: Default::default(),
            provisioning_baseline: None,
            setup_operations: Default::default(),
            manual_lease: Some(super::super::ManualLease {
                target: super::super::TaskTarget {
                    environment_id: "env-1".into(),
                    generation: "gen-1".into(),
                    workspace_id: "workspace-1".into(),
                    task_id: "task-1".into(),
                },
                acquired_at: "retained".into(),
                ready: false,
            }),
        };
        let before = serde_json::to_value(&state).unwrap();
        let observed = Observed {
            desktop: Desktop::unavailable(
                "missing",
                "driver_not_installed",
                Some("driver.install"),
            ),
            provider: Provider {
                harness: Harness::Codex,
                check: Check::new(
                    "unknown",
                    "provider_credential_store_requires_interaction",
                    Some("provider.inspect"),
                ),
                evidence: "notProbed",
                valid_until: None,
                binding: None,
            },
        };
        let value =
            serde_json::to_value(Readiness::new(&identity, &state, observed, false)).unwrap();
        assert_eq!(value["protocol"], 1);
        assert_eq!(value["runtime"]["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(
            value["runtime"]["identity"],
            serde_json::to_value(identity).unwrap()
        );
        assert_eq!(value["manualControl"], true);
        assert_eq!(
            value["actionAdmission"]["reasonCode"],
            "manual_desktop_lease_held"
        );
        assert_eq!(value["capture"]["state"], "notProbed");
        assert_eq!(serde_json::to_value(&state).unwrap(), before);
    }

    #[test]
    fn installed_version_requires_exact_cli_output_not_incidental_version_text() {
        assert_eq!(
            parse_version(b"cua-driver 0.28.0\n").as_deref(),
            Some("0.28.0")
        );
        assert_eq!(
            parse_version(b"cua-driver-rs v0.28.0\n").as_deref(),
            Some("0.28.0")
        );
        for text in [
            "unrelated 0.28.0",
            "cua-driver 0.28.0-dev",
            "cua-driver 0.28.0 extra",
            "cua-driver 0.28",
        ] {
            assert!(parse_version(text.as_bytes()).is_none(), "{text}");
        }
    }

    #[test]
    fn actual_probe_sequence_is_only_version_status_and_promptless_permissions_status() {
        use std::os::unix::fs::PermissionsExt as _;
        let home = tempfile::tempdir().unwrap();
        let binary = home.path().join("driver");
        std::fs::write(&binary, r##"#!/bin/sh
printf '%s\n' "$*" >> "$HOME/invocations"
case "$*" in
  --version) printf 'cua-driver 0.28.0\n' ;;
  status) printf 'Cua Driver daemon is running\n' ;;
  'permissions status --json') printf '%s\n' '{"accessibility":true,"screen_recording":false,"source":{"attribution":"driver-daemon","bundle_id":"com.trycua.driver"}}' ;;
  *) exit 99 ;;
esac
"##).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let result = inspect_desktop_with(&binary, home.path(), session).unwrap();
        assert_eq!(result.screen_recording.state, "required");
        assert_eq!(
            std::fs::read_to_string(home.path().join("invocations")).unwrap(),
            "--version\nstatus\npermissions status --json\n"
        );
        assert_eq!(result.capture.state, "notProbed");
        let missing =
            inspect_desktop_with(&home.path().join("absent"), home.path(), session).unwrap();
        assert_eq!(missing.driver.check.state, "missing");
    }

    #[test]
    fn explicit_account_binding_accepts_a_real_toml_configuration_document() {
        let home = tempfile::tempdir().unwrap();
        let account = home.path().join(".codex");
        let bin = home.path().join(".local/bin");
        std::fs::create_dir_all(&account).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        std::os::unix::fs::symlink(std::env::current_exe().unwrap(), bin.join("codex")).unwrap();
        let config = b"cli_auth_credentials_store = \"keyring\"\n[features]\nresponses_websockets_v2 = true\n";
        std::fs::write(account.join("config.toml"), config).unwrap();
        assert!(
            account_binding(home.path()).is_ok(),
            "Valid configuration must be parsed as a TOML document"
        );
        assert_eq!(std::fs::read(account.join("config.toml")).unwrap(), config);
        // The binding observes absence; it must not create or read credentials.
        assert!(!account.join("auth.json").exists());
        std::fs::write(account.join("config.toml"), b"profile = \"other\"\n").unwrap();
        assert!(account_binding(home.path()).is_err());
    }

    #[test]
    fn keyring_provider_configuration_and_login_remain_untouched_without_running_cli() {
        use std::os::unix::fs::PermissionsExt as _;
        let home = tempfile::tempdir().unwrap();
        let bin = home.path().join(".local/bin");
        let auth = home.path().join(".codex");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&auth).unwrap();
        std::fs::write(
            bin.join("codex"),
            "#!/bin/sh\nprintf touched > \"$HOME/ran-provider\"\n",
        )
        .unwrap();
        std::fs::set_permissions(bin.join("codex"), std::fs::Permissions::from_mode(0o700))
            .unwrap();
        let config = b"cli_auth_credentials_store = \"keyring\"\n";
        let cache = b"retained-auth-placeholder";
        std::fs::write(auth.join("config.toml"), config).unwrap();
        std::fs::write(auth.join("auth.json"), cache).unwrap();
        let result = inspect_provider(home.path(), Harness::Codex);
        assert_eq!(result.check.state, "unknown");
        assert_eq!(std::fs::read(auth.join("config.toml")).unwrap(), config);
        assert_eq!(std::fs::read(auth.join("auth.json")).unwrap(), cache);
        assert!(!home.path().join("ran-provider").exists());
    }

    #[test]
    fn stopped_is_distinct_from_unreadable_or_startup_gate_unknown() {
        let stopped = Probe {
            code: Some(1),
            stdout: vec![],
            stderr: b"Cua Driver daemon is not running\n".to_vec(),
        };
        let result = desktop_from_probes("0.28.0".into(), Some(stopped), None, session());
        assert_eq!(result.driver.check.state, "stopped");
        assert_eq!(result.accessibility.state, "unknown");
        let result = desktop_from_probes("0.28.0".into(), None, None, session());
        assert_eq!(result.driver.check.state, "unknown");
        assert_eq!(result.desktop.state, "unknown");
        let result = desktop_from_probes(
            "0.28.0".into(),
            Some(running()),
            Some(reply(0, json!({"daemon_running":false,"status":"unknown"}))),
            session(),
        );
        assert_eq!(result.driver.check.state, "running");
        assert_eq!(
            result.accessibility.reason_code,
            "driver_permission_status_blocked_or_unattributed"
        );
        assert_eq!(result.accessibility.state, "unknown");
        assert_eq!(result.screen_recording.state, "unknown");
        assert_eq!(result.driver.runtime_version, None);
    }

    #[test]
    fn only_exact_standalone_driver_identity_can_supply_permission_evidence() {
        for (attribution, bundle) in [
            ("host", "com.trycua.driver"),
            ("caller", "com.trycua.driver"),
            ("driver-daemon", "com.trycua.driver.local"),
            ("driver-daemon", ""),
        ] {
            let result = desktop_from_probes(
                "0.28.0".into(),
                Some(running()),
                Some(reply(
                    0,
                    permissions(json!(true), json!(true), attribution, bundle),
                )),
                session(),
            );
            assert_eq!(
                result.accessibility.state, "unknown",
                "{attribution}/{bundle}"
            );
            assert_eq!(result.screen_recording.state, "unknown");
        }
    }

    #[test]
    fn permission_denial_is_specific_and_nonzero_or_malformed_receipts_never_grant() {
        let result = desktop_from_probes(
            "0.28.0".into(),
            Some(running()),
            Some(reply(
                0,
                permissions(
                    json!(true),
                    json!(false),
                    "driver-daemon",
                    "com.trycua.driver",
                ),
            )),
            session(),
        );
        assert_eq!(result.accessibility.state, "granted");
        assert_eq!(result.screen_recording.state, "required");
        assert_eq!(result.desktop.reason_code, "screen_recording_required");
        for receipt in [
            reply(
                75,
                permissions(
                    json!(true),
                    json!(true),
                    "driver-daemon",
                    "com.trycua.driver",
                ),
            ),
            reply(
                0,
                permissions(
                    json!("true"),
                    Value::Null,
                    "driver-daemon",
                    "com.trycua.driver",
                ),
            ),
        ] {
            let result =
                desktop_from_probes("0.28.0".into(), Some(running()), Some(receipt), session());
            assert_eq!(result.accessibility.state, "unknown");
            assert_eq!(result.screen_recording.state, "unknown");
        }
    }

    #[test]
    fn historical_capture_and_preflight_do_not_claim_fresh_desktop_or_running_version() {
        let mut status = permissions(
            json!(true),
            json!(true),
            "driver-daemon",
            "com.trycua.driver",
        );
        status["direct_capture_verification"] =
            json!({"verified_at":"2026-10-01","bundle_id":"com.trycua.driver"});
        status["screen_recording_capturable"] = json!(true);
        let result = desktop_from_probes(
            "0.28.0".into(),
            Some(running()),
            Some(reply(0, status)),
            session(),
        );
        assert_eq!(result.accessibility.state, "granted");
        assert_eq!(result.screen_recording.state, "granted");
        assert_eq!(result.desktop.state, "unknown");
        assert_eq!(result.capture.state, "notProbed");
        assert_eq!(result.driver.runtime_version, None);
        assert_eq!(result.capture.action_code, Some("desktop.verify"));
        assert_eq!(result.desktop.action_code, Some("desktop.verify"));
    }

    #[test]
    fn auth_status_requires_recognized_local_cli_evidence_and_redacts_output() {
        let make = |code, text: &[u8]| {
            Some(Probe {
                code: Some(code),
                stdout: vec![],
                stderr: text.to_vec(),
            })
        };
        assert_eq!(
            codex_auth_status(make(0, b"Logged in using ChatGPT\n")).state,
            "authenticated"
        );
        assert_eq!(
            codex_auth_status(make(1, b"Not logged in\n")).state,
            "unauthenticated"
        );
        for value in [
            None,
            make(0, b""),
            make(1, b"Error checking login status: blocked\n"),
            make(0, b"Logged in using workload identity\n"),
        ] {
            assert_eq!(codex_auth_status(value).state, "unknown");
        }
        let check = codex_auth_status(make(
            0,
            b"Logged in using an API key - sk-private-fragment\n",
        ));
        assert_eq!(check.state, "authenticated");
        assert!(!serde_json::to_string(&check)
            .unwrap()
            .contains("private-fragment"));
    }

    #[test]
    fn probe_preserves_failure_exit_but_never_waits_indefinitely_or_accepts_excess_output() {
        // Disposable local processes only: no actual Driver, provider or GUI.
        let value = probe(
            Command::new("/bin/sh").args(["-c", "printf data; exit 75"]),
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(value.code, Some(75));
        assert_eq!(value.stdout, b"data");
        let start = Instant::now();
        assert!(probe(
            Command::new("/bin/sleep").arg("30"),
            Duration::from_millis(40)
        )
        .is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(probe(
            Command::new("/bin/sh").args(["-c", "head -c 65537 /dev/zero"]),
            Duration::from_secs(1)
        )
        .is_err());
    }

    #[test]
    fn passive_command_has_no_inherited_auth_or_driver_control_environment() {
        let command = command(Path::new(DRIVER), Path::new("/Users/lume"));
        let env: std::collections::BTreeMap<_, _> = command.get_envs().collect();
        for key in [
            "OPENAI_API_KEY",
            "CODEX_HOME",
            "CUA_DRIVER_EMBEDDED",
            "CUA_DRIVER_SOCKET",
            "TERMINALX_NEXT_TOKEN",
            "TERMINALX_NEXT_SOCKET",
            "ANTHROPIC_API_KEY",
        ] {
            assert!(!env.contains_key(std::ffi::OsStr::new(key)), "{key}");
        }
        assert_eq!(
            env[std::ffi::OsStr::new("HOME")],
            Some(std::ffi::OsStr::new("/Users/lume"))
        );
        assert!(format!("{command:?}").contains("env -i"));
    }
}
