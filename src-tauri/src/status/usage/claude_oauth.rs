//! Read-only access to the usage endpoint Claude Code already authenticates.

use std::path::Path;
#[cfg(any(target_os = "macos", test))]
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};

use super::{claude_used_percent, parse_claude_window, parse_scoped_claude_window, upsert_window, UsageWindow};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// The rolling windows every account has, whether or not one is running.
const ACCOUNT_WINDOWS: [&str; 2] = ["five_hour", "seven_day"];
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
#[cfg(target_os = "macos")]
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(3);
/// What `security find-generic-password` exits with when there is no such
/// item: the low byte of `errSecItemNotFound` (-25300).
#[cfg(any(target_os = "macos", test))]
const SECURITY_NOT_FOUND: i32 = 44;

/// Why Claude Code's OAuth access token could not be read. No variant carries
/// any part of the credentials; only exit codes and payload sizes.
#[derive(Debug, thiserror::Error)]
// Only the macOS keychain reader times out, fails or cannot start.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(super) enum CredentialError {
    #[error("Claude Code OAuth credentials were not found")]
    NotFound,
    #[error("Claude Code keychain read timed out after {} s", .0.as_secs_f32())]
    TimedOut(Duration),
    #[error("Claude Code keychain read failed ({})", exit_label(*.0))]
    Failed(Option<i32>),
    #[error("Claude Code keychain read could not start ({0})")]
    Spawn(std::io::Error),
    #[error("Claude Code {0} has no OAuth access token ({1} bytes)")]
    NoToken(&'static str, usize),
}

fn exit_label(code: Option<i32>) -> String {
    code.map_or_else(|| "ended by a signal".into(), |code| format!("exit {code}"))
}

pub(super) fn parse_response(payload: &Value, updated_at: i64) -> Vec<UsageWindow> {
    let Some(response) = payload.as_object() else { return Vec::new() };
    let fable_aliases = ["fable_weekly", "fable_seven_day", "seven_day_fable"];
    let mut windows: Vec<_> = response
        .iter()
        .filter(|(key, _)| key.as_str() != "limits" && !fable_aliases.contains(&key.as_str()))
        .filter_map(|(key, raw)| parse_claude_window(key, raw, updated_at))
        .collect();

    if let Some(window) = fable_aliases
        .iter()
        .find_map(|key| response.get(*key).and_then(|raw| parse_claude_window("fable_weekly", raw, updated_at)))
    {
        upsert_window(&mut windows, window);
    }
    if let Some(limits) = response.get("limits").and_then(Value::as_array) {
        for window in limits.iter().filter_map(|raw| {
            (raw.get("kind").and_then(Value::as_str) == Some("weekly_scoped"))
                .then(|| parse_scoped_claude_window(raw, updated_at))
                .flatten()
        }) {
            upsert_window(&mut windows, window);
        }
    }
    // An account window with no running instance comes back as `null`, or
    // with neither a percentage nor a deadline: one not yet started (#729).
    // Dropping it left an expired window on screen for hours.
    for key in ACCOUNT_WINDOWS {
        let idle = response.get(key).is_some_and(|raw| {
            raw.is_null() || (claude_used_percent(raw).is_none() && raw.get("resets_at").is_none_or(Value::is_null))
        });
        if idle && !windows.iter().any(|window| window.key == key) {
            windows.extend(parse_claude_window(key, &json!({"utilization": 0}), updated_at));
        }
    }
    for window in &mut windows { window.source = "oauth".into(); }
    windows
}

fn parse_token(raw: &str) -> Option<String> {
    serde_json::from_str::<Value>(raw)
        .ok()?
        .pointer("/claudeAiOauth/accessToken")?
        .as_str()
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

/// Run a `security find-generic-password -w` style `command` and take the
/// token from what it prints. `security` writes the whole item before it
/// exits, and the item grows with every MCP server Claude Code signs in to;
/// its output is drained while it runs, or a payload larger than the pipe
/// buffer would block it until the deadline.
#[cfg(any(target_os = "macos", test))]
fn read_command_token(command: Command, timeout: Duration) -> Result<String, CredentialError> {
    let output = crate::git::capture_within(command, timeout).map_err(|error| match error.kind() {
        std::io::ErrorKind::TimedOut => CredentialError::TimedOut(timeout),
        _ => CredentialError::Spawn(error),
    })?;
    let code = output.status.code();
    log::debug!("Claude Code keychain read: {}, {} bytes", exit_label(code), output.stdout.len());
    match code {
        Some(0) => parse_token(&String::from_utf8_lossy(&output.stdout))
            .ok_or(CredentialError::NoToken("keychain item", output.stdout.len())),
        Some(SECURITY_NOT_FOUND) => Err(CredentialError::NotFound),
        _ => Err(CredentialError::Failed(code)),
    }
}

#[cfg(target_os = "macos")]
fn read_keychain_token() -> Result<String, CredentialError> {
    let account = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).map_err(|_| CredentialError::NotFound)?;
    let mut command = Command::new("/usr/bin/security");
    command.args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", &account, "-w"]);
    read_command_token(command, KEYCHAIN_TIMEOUT)
}

#[cfg(not(target_os = "macos"))]
fn read_keychain_token() -> Result<String, CredentialError> {
    Err(CredentialError::NotFound)
}

fn read_file_token(path: &Path) -> Result<String, CredentialError> {
    let raw = std::fs::read(path).map_err(|_| CredentialError::NotFound)?;
    parse_token(&String::from_utf8_lossy(&raw)).ok_or(CredentialError::NoToken("credentials file", raw.len()))
}

/// The keychain's token, else the credentials file's. When neither has one,
/// the keychain's reason wins unless it simply had no item: Claude Code keeps
/// its macOS login there, and a timed-out read must not be reported as a
/// missing login because an old file was emptied.
fn keychain_then_file(
    keychain: Result<String, CredentialError>,
    file: impl FnOnce() -> Result<String, CredentialError>,
) -> Result<String, CredentialError> {
    let keychain_error = match keychain {
        Ok(token) => return Ok(token),
        Err(error) => error,
    };
    file().map_err(|file_error| match keychain_error {
        CredentialError::NotFound => file_error,
        keychain_error => keychain_error,
    })
}

pub(super) fn read_token() -> Result<String, CredentialError> {
    if let Some(dir) = std::env::var("CLAUDE_CONFIG_DIR").ok().filter(|v| !v.is_empty()) {
        // A custom config must never fall back to another account's keychain.
        return read_file_token(&Path::new(&dir).join(".credentials.json"));
    }
    keychain_then_file(read_keychain_token(), || {
        read_file_token(&dirs::home_dir().ok_or(CredentialError::NotFound)?.join(".claude/.credentials.json"))
    })
}

#[derive(Debug, thiserror::Error)]
#[error("Claude usage is rate limited; waiting for the provider retry deadline")]
pub(super) struct RetryAfter(pub i64);

fn retry_deadline(raw: &str, now: i64) -> Option<i64> {
    if let Ok(seconds) = raw.trim().parse::<i64>() {
        return Some(now.saturating_add(seconds.max(0).saturating_mul(1000)));
    }
    chrono::DateTime::parse_from_rfc2822(raw).ok().map(|at| at.timestamp_millis())
}

pub(super) fn fetch(token: &str, updated_at: i64) -> Result<Vec<UsageWindow>> {
    let agent = ureq::AgentBuilder::new().timeout(Duration::from_secs(10)).build();
    let response = agent
        .get(USAGE_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", "oauth-2025-04-20")
        .set("User-Agent", "claude-code/2.1.0")
        .call();
    let payload: Value = match response {
        Ok(response) => response.into_json().context("Claude OAuth usage reply was not JSON")?,
        Err(ureq::Error::Status(code, response)) => {
            if let Some(at) = response.header("retry-after").and_then(|raw| retry_deadline(raw, super::now_ms())) {
                return Err(RetryAfter(at).into());
            }
            bail!("Claude OAuth usage request failed with HTTP {code}");
        },
        Err(error) => bail!("Could not reach Claude OAuth usage endpoint: {error}"),
    };
    let windows = parse_response(&payload, updated_at);
    if windows.is_empty() {
        bail!("Claude OAuth usage reply contained no usage windows");
    }
    Ok(windows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retry_after_accepts_seconds_and_http_dates() {
        assert_eq!(retry_deadline("120", 1000), Some(121_000));
        assert_eq!(retry_deadline("Wed, 02 Sep 2026 12:00:00 GMT", 1000), Some(1_788_350_400_000));
        assert_eq!(retry_deadline("invalid", 1000), None);
    }

    #[test]
    fn oauth_one_percent_after_rollover_is_one_percent_not_one_hundred() {
        let windows = parse_response(&json!({"five_hour": {"utilization": 1, "resets_at": 1788757220}}), 789);
        assert_eq!(windows[0].used_percent, 1.0);
    }

    #[test]
    fn maps_standard_and_all_scoped_weekly_windows() {
        let windows = parse_response(
            &json!({
                "five_hour": {"utilization": 0.12, "resets_at": 1788757220},
                "seven_day": {"utilization": 44},
                "seven_day_opus": {"used_percentage": 31},
                "seven_day_sonnet": {"utilization": 0.7},
                "fable_weekly": {"utilization": 11},
                "limits": [
                    {"kind": "weekly_scoped", "percent": 55, "scope": null},
                    {
                        "kind": "weekly_scoped",
                        "percent": 82,
                        "resets_at": "2026-09-07T14:00:00.000Z",
                        "scope": {"model": {"display_name": "Fable"}}
                    },
                    {
                        "kind": "weekly_scoped",
                        "percent": 24,
                        "scope": {"model": {"display_name": "Sonnet 4.5"}}
                    }
                ]
            }),
            789,
        );

        assert_eq!(windows.len(), 6);
        let five_hour = windows.iter().find(|window| window.key == "five_hour").unwrap();
        assert_eq!(five_hour.used_percent, 0.12);
        assert_eq!(five_hour.resets_at, Some(1_788_757_220_000));
        let sonnet = windows.iter().find(|window| window.key == "seven_day_sonnet").unwrap();
        assert_eq!(sonnet.label, "7d Sonnet");
        assert_eq!(sonnet.used_percent, 0.7);
        let fable = windows.iter().find(|window| window.key == "fable_weekly").unwrap();
        assert_eq!(fable.label, "Fable");
        assert_eq!(fable.used_percent, 82.0);
        assert_eq!(fable.resets_at, Some(1_788_789_600_000));
        let scoped = windows.iter().find(|window| window.key == "model_scoped_sonnet_4_5").unwrap();
        assert_eq!(scoped.label, "Sonnet 4.5");
        assert_eq!(scoped.used_percent, 24.0);
        assert_eq!(scoped.window_minutes, Some(10_080));
    }

    #[cfg(unix)]
    fn stub(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }

    /// #664: `security` writes the whole item before it exits, and Claude
    /// Code's item keeps an entry for every MCP server it signed in to. Read
    /// only once the child had exited, a payload larger than the pipe buffer
    /// held it in its write until the deadline killed it.
    #[cfg(unix)]
    #[test]
    fn a_credentials_payload_larger_than_a_pipe_buffer_is_read_whole() {
        let script = r#"printf '{"claudeAiOauth":{"accessToken":"oauth-token"},"mcpOAuth":"'
            head -c 70000 /dev/zero | tr '\000' a
            printf '"}\n'"#;
        let token = read_command_token(stub(script), Duration::from_secs(20));
        assert_eq!(token.unwrap(), "oauth-token");
    }

    #[cfg(unix)]
    #[test]
    fn a_keychain_read_names_its_failure_and_never_the_payload() {
        let read = |script: &str, timeout: Duration| read_command_token(stub(script), timeout).unwrap_err();
        let patient = Duration::from_secs(20);
        assert!(matches!(read("exit 44", patient), CredentialError::NotFound));
        assert_eq!(read("printf partial-secret; exit 51", patient).to_string(), "Claude Code keychain read failed (exit 51)");
        assert_eq!(read("kill -9 $$", patient).to_string(), "Claude Code keychain read failed (ended by a signal)");
        assert_eq!(read("sleep 30", Duration::from_millis(200)).to_string(), "Claude Code keychain read timed out after 0.2 s");
        let payload = r#"{"claudeAiOauth":{"accessToken":"","refreshToken":"partial-secret"}}"#;
        let no_token = read(&format!("printf '{payload}'"), patient).to_string();
        assert_eq!(no_token, format!("Claude Code keychain item has no OAuth access token ({} bytes)", payload.len()));
        let missing = read_command_token(Command::new("/nonexistent/security"), patient).unwrap_err();
        assert!(matches!(missing, CredentialError::Spawn(_)), "{missing}");
    }

    #[test]
    fn a_keychain_failure_outranks_an_emptied_credentials_file() {
        use CredentialError::*;
        let emptied = || Err(NoToken("credentials file", 40));
        assert_eq!(keychain_then_file(Ok("keychain".into()), || panic!("the file is not read")).unwrap(), "keychain");
        assert_eq!(keychain_then_file(Err(TimedOut(Duration::from_secs(3))), || Ok("file".into())).unwrap(), "file");
        // #664: the read timed out and the old file's token had been emptied.
        assert!(matches!(keychain_then_file(Err(TimedOut(Duration::from_secs(3))), emptied), Err(TimedOut(_))));
        assert!(matches!(keychain_then_file(Err(Failed(Some(51))), || Err(NotFound)), Err(Failed(Some(51)))));
        // With no item in the keychain, the file says why.
        assert!(matches!(keychain_then_file(Err(NotFound), emptied), Err(NoToken("credentials file", 40))));
        assert!(matches!(keychain_then_file(Err(NotFound), || Err(NotFound)), Err(NotFound)));
    }

    #[test]
    fn a_credentials_file_is_missing_emptied_or_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".credentials.json");
        assert!(matches!(read_file_token(&path), Err(CredentialError::NotFound)));
        let emptied = r#"{"claudeAiOauth":{"accessToken":""}}"#;
        std::fs::write(&path, emptied).unwrap();
        assert!(matches!(read_file_token(&path), Err(CredentialError::NoToken("credentials file", n)) if n == emptied.len()));
        std::fs::write(&path, r#"{"claudeAiOauth":{"accessToken":"file-token"}}"#).unwrap();
        assert_eq!(read_file_token(&path).unwrap(), "file-token");
    }

    #[test]
    fn credentials_accept_only_a_non_empty_access_token() {
        assert_eq!(
            parse_token(r#"{"claudeAiOauth":{"accessToken":"  oauth-token  ","refreshToken":"unused"}}"#),
            Some("oauth-token".into())
        );
        assert_eq!(parse_token(r#"{"claudeAiOauth":{"refreshToken":"unused"}}"#), None);
        assert_eq!(parse_token("not json"), None);
    }
}
