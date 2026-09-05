//! One private operation file and one interpreter process per request.
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::Value;

use super::super::ComputerError;

const TIMEOUT: Duration = Duration::from_secs(30);
const KILL_GRACE: Duration = Duration::from_secs(1);
const MAX_OUTPUT: u64 = 20 * 1024 * 1024;
pub const PATH_ENV: &str = "TERMINALX_COMPUTER_DESKTOP_SCRIPT_PROVIDER_PATH";

#[derive(Clone, Copy)]
pub enum Platform {
    Linux,
    Windows,
}

impl Platform {
    pub fn current() -> Option<Self> {
        match std::env::consts::OS {
            "linux" => Some(Self::Linux),
            "windows" => Some(Self::Windows),
            _ => None,
        }
    }

    fn resource(self) -> &'static str {
        match self {
            Self::Linux => "computer-use-linux/runtime.py",
            Self::Windows => "computer-use-windows/runtime.ps1",
        }
    }

    fn command(self) -> Command {
        match self {
            Self::Linux => {
                let mut command = Command::new("python3");
                command.arg("-c").arg(include_str!(
                    "../../../../native/computer-use-linux/launcher.py"
                ));
                command
            }
            Self::Windows => {
                // Windows PowerShell ships with Windows 10/11. Accept a pwsh-only install too.
                let mut command = Command::new(if which::which("powershell.exe").is_ok() {
                    "powershell.exe"
                } else {
                    "pwsh.exe"
                });
                command.args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ]);
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
                }
                command
            }
        }
    }
}

pub fn script_candidates(platform: Platform, resources: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os(PATH_ENV) {
        paths.push(PathBuf::from(path));
    }
    if let Some(resources) = resources {
        paths.push(resources.join(platform.resource()));
    }
    if cfg!(debug_assertions) {
        paths.push(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../native")
                .join(platform.resource()),
        );
    }
    paths
}

pub fn script_path(platform: Platform, resources: Option<&Path>) -> Option<PathBuf> {
    script_candidates(platform, resources)
        .into_iter()
        .find(|path| path.is_file())
}

pub fn call(platform: Platform, script: &Path, request: &Value) -> Result<Value, ComputerError> {
    execute(platform.command(), script, request, TIMEOUT, None)
}

fn io_error(error: std::io::Error) -> ComputerError {
    ComputerError::accessibility(format!("desktop provider I/O failed: {error}"))
}

fn private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// Drop kills/reaps before the operation directory is removed, including on I/O errors.
struct RunningChild(Child);
impl Drop for RunningChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        // try_wait is deliberately not called between timeout and SIGTERM: an
        // unreaped child retains its pid, so this cannot signal a reused pid.
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        let deadline = Instant::now() + KILL_GRACE;
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[cfg(not(unix))]
    let _ = KILL_GRACE;
    let _ = child.kill();
    let _ = child.wait();
}

fn execute(
    mut command: Command,
    script: &Path,
    request: &Value,
    timeout: Duration,
    temp_root: Option<&Path>,
) -> Result<Value, ComputerError> {
    let mut builder = tempfile::Builder::new();
    builder.prefix("tx-cu-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(std::fs::Permissions::from_mode(0o700));
    }
    // Explicit permissions create owner-only directories on Unix. The default Windows
    // user temp directory supplies the inherited user ACL.
    let directory = match temp_root {
        Some(root) => builder.tempdir_in(root),
        None => builder.tempdir(),
    }
    .map_err(io_error)?;
    let operation = directory.path().join("op.json");
    let out = directory.path().join("out");
    let err = directory.path().join("err");
    private_file(&operation)
        .map_err(io_error)?
        .write_all(
            &serde_json::to_vec(request)
                .map_err(|e| ComputerError::accessibility(e.to_string()))?,
        )
        .map_err(io_error)?;
    // File-backed output cannot deadlock a full pipe or leave reader threads
    // hung on inherited descriptors. Bound its size while the child runs.
    let stdout = private_file(&out).map_err(io_error)?;
    let stderr = private_file(&err).map_err(io_error)?;
    let mut child = RunningChild(
        command
            .arg(script)
            .arg(&operation)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .spawn()
            .map_err(|error| map_error(&error.to_string()))?,
    );
    let deadline = Instant::now() + timeout;
    let status = loop {
        if std::fs::metadata(&out).map_err(io_error)?.len() > MAX_OUTPUT
            || std::fs::metadata(&err).map_err(io_error)?.len() > MAX_OUTPUT
        {
            terminate(&mut child.0);
            return Err(ComputerError::accessibility(
                "desktop provider output exceeded 20 MiB",
            ));
        }
        if let Some(status) = child.0.try_wait().map_err(io_error)? {
            break status;
        }
        if Instant::now() >= deadline {
            terminate(&mut child.0);
            return Err(ComputerError::new(
                "action_timeout",
                format!("desktop provider timed out after {}ms", timeout.as_millis()),
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let read = |path: &Path| -> Result<String, ComputerError> {
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(io_error)?
            .take(MAX_OUTPUT + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() as u64 > MAX_OUTPUT {
            return Err(ComputerError::accessibility(
                "desktop provider output exceeded 20 MiB",
            ));
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    };
    let stdout = read(&out)?;
    let stderr = read(&err)?;
    if !status.success() {
        return Err(map_error(if stderr.trim().is_empty() {
            &stdout
        } else {
            &stderr
        }));
    }
    let response: Value =
        serde_json::from_str(stdout.trim_start_matches('\u{feff}')).map_err(|e| {
            ComputerError::accessibility(format!("desktop provider returned invalid JSON: {e}"))
        })?;
    if response["ok"] != true {
        return Err(map_error(response["error"].as_str().unwrap_or(&stderr)));
    }
    Ok(response)
}

// Ordered exactly like Legacy: broad AT-SPI/session matching comes after
// specific argument, missing dependency, stale window, and screenshot errors.
static ERRORS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (r"appNotFound|app not found", "app_not_found"),
        (r"appBlocked|app blocked", "app_blocked"),
        (r"unsupported capability|hotkey.*require|paste_text requires|modified clicks require xdotool|GDK is required for non-character key synthesis", "unsupported_capability"),
        (r"unsupported mouse button|unsupported scroll direction|unsupported (?:key|modifier)|windowId is not supported|must be a positive|must be a finite number|\b(?:x|y|from_x|from_y|to_x|to_y|pages|click_count|text|key|direction) is required\b", "invalid_argument"),
        (r"ModuleNotFoundError: No module named 'gi'|PyGObject|python3-gi", "missing_gi"),
        (r"not a valid secondary action|action.*not supported", "action_not_supported"),
        (r"value is not settable|not settable", "value_not_settable"),
        (r"stale element|fresh element index", "element_not_found"),
        (r"windowStale|window stale", "window_stale"),
        (r"window_not_focused|keyboard input requires.*window.*focused|target window.*focused", "window_not_focused"),
        (r"screenshot_failed|screenshot.*failed|screen recording|payload cap", "screenshot_failed"),
        (r"window_not_found|No top-level(?: AT-SPI| UI Automation)? window|has no (?:on-screen |accessibility )?window|could not match accessibility window|unknown window(?:_index| id)?", "window_not_found"),
        (r"permission|desktop session|DBUS|XDG_RUNTIME_DIR|AT-SPI", "permission_denied"),
        (r"element_not_found|stale element|fresh element index|unknown element_index|element \d+ is stale|element indexes require|element \d+ changed since|element \d+ is not in the current cached snapshot", "element_not_found"),
    ].into_iter().map(|(pattern, code)| (Regex::new(&format!("(?i){pattern}")).unwrap(), code)).collect()
});

pub fn map_error(message: &str) -> ComputerError {
    let message = match message.trim() {
        "" => "desktop provider failed",
        text => text,
    };
    for (pattern, code) in ERRORS.iter() {
        if pattern.is_match(message) {
            if *code == "missing_gi" {
                return ComputerError::new("unsupported_capability", "Linux Computer Use requires python3-gi and AT-SPI packages. Install python3-gi gir1.2-atspi-2.0 at-spi2-core, then retry.");
            }
            return ComputerError::new(code, message);
        }
    }
    ComputerError::accessibility(message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_legacy_errors_in_priority_order() {
        for (text, code) in [
            ("appNotFound: editor", "app_not_found"),
            ("app blocked: Bitwarden", "app_blocked"),
            ("hotkey requires xdotool", "unsupported_capability"),
            ("unsupported mouse button", "invalid_argument"),
            ("not a valid secondary action", "action_not_supported"),
            ("value is not settable", "value_not_settable"),
            ("stale element AT-SPI", "element_not_found"),
            ("windowStale", "window_stale"),
            (
                "keyboard input requires the window to be focused",
                "window_not_focused",
            ),
            ("screenshot failed: permission", "screenshot_failed"),
            ("No top-level AT-SPI window", "window_not_found"),
            (
                "XDG_RUNTIME_DIR required for desktop session",
                "permission_denied",
            ),
            ("element 9 changed since snapshot", "element_not_found"),
            ("unexpected failure", "accessibility_error"),
        ] {
            assert_eq!(map_error(text).code, code, "{text}");
        }
        let missing = map_error("ModuleNotFoundError: No module named 'gi'");
        assert_eq!(missing.code, "unsupported_capability");
        assert!(missing
            .message
            .contains("python3-gi gir1.2-atspi-2.0 at-spi2-core"));
    }

    fn fake(script: &str, timeout: Duration) -> (Result<Value, ComputerError>, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        let script_path = root.path().join("fake.py");
        std::fs::write(&script_path, script).unwrap();
        let operations = root.path().join("operations");
        std::fs::create_dir(&operations).unwrap();
        let result = execute(
            Command::new(if cfg!(windows) { "python" } else { "python3" }),
            &script_path,
            &json!({"tool": "test", "text": "private payload\n✓"}),
            timeout,
            Some(&operations),
        );
        assert_eq!(
            std::fs::read_dir(&operations).unwrap().count(),
            0,
            "operation directories must be removed"
        );
        (result, root)
    }

    #[test]
    fn operation_files_are_private_payloads_never_enter_argv_and_success_cleans_up() {
        let (result, _) = fake(
            r#"
import json, os, pathlib, stat, sys
p = pathlib.Path(sys.argv[1])
if os.name != 'nt':
    assert stat.S_IMODE(p.stat().st_mode) == 0o600
    assert stat.S_IMODE(p.parent.stat().st_mode) == 0o700
assert len(sys.argv) == 2
op = json.loads(p.read_text())
print(json.dumps({'ok': True, 'text': op['text']}))
"#,
            Duration::from_secs(5),
        );
        assert_eq!(result.unwrap()["text"], "private payload\n✓");
    }

    #[test]
    fn failures_and_bad_json_clean_up() {
        for (script, code) in [
            ("print('not JSON')", "accessibility_error"),
            (
                "print('{\"ok\":false,\"error\":\"appBlocked\"}')",
                "app_blocked",
            ),
            (
                "import sys; print('app not found', file=sys.stderr); sys.exit(1)",
                "app_not_found",
            ),
        ] {
            assert_eq!(
                fake(script, Duration::from_secs(5)).0.unwrap_err().code,
                code
            );
        }
        let root = tempfile::tempdir().unwrap();
        let failure = execute(
            Command::new(root.path().join("missing-interpreter")),
            Path::new("ignored"),
            &json!({}),
            Duration::from_secs(1),
            Some(root.path()),
        );
        assert!(failure.is_err());
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn timeout_kills_even_a_child_ignoring_sigterm_and_reaps_before_cleanup() {
        let (result, root) = fake(
            r#"
import os, pathlib, signal, sys, time
pathlib.Path(__file__).with_suffix('.pid').write_text(str(os.getpid()))
if os.name != 'nt': signal.signal(signal.SIGTERM, signal.SIG_IGN)
time.sleep(60)
"#,
            Duration::from_secs(1),
        );
        assert_eq!(result.unwrap_err().code, "action_timeout");
        #[cfg(unix)]
        {
            let pid: i32 = std::fs::read_to_string(root.path().join("fake.pid"))
                .unwrap()
                .parse()
                .unwrap();
            assert_eq!(
                unsafe { libc::kill(pid, 0) },
                -1,
                "timed-out child is still alive"
            );
        }
        #[cfg(not(unix))]
        drop(root);
    }

    #[test]
    fn resources_resolve_by_platform() {
        let root = tempfile::tempdir().unwrap();
        let linux = root.path().join("computer-use-linux/runtime.py");
        assert!(script_candidates(Platform::Linux, Some(root.path())).contains(&linux));
        assert!(script_candidates(Platform::Windows, Some(root.path()))
            .contains(&root.path().join("computer-use-windows/runtime.ps1")));
    }
}
