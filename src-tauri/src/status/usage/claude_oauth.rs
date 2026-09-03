//! Read-only access to the usage endpoint Claude Code already authenticates.

use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde_json::Value;

use super::{parse_claude_window, parse_scoped_claude_window, upsert_window, UsageWindow};

const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(3);

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

#[cfg(target_os = "macos")]
fn read_keychain_token() -> Option<String> {
    let account = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).ok()?;
    let mut child = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", &account, "-w"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + KEYCHAIN_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut raw = String::new();
                child.stdout.take()?.read_to_string(&mut raw).ok()?;
                return status.success().then(|| parse_token(&raw)).flatten();
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn read_keychain_token() -> Option<String> {
    None
}

pub(super) fn read_token() -> Option<String> {
    read_keychain_token().or_else(|| {
        let path = dirs::home_dir()?.join(".claude/.credentials.json");
        parse_token(&std::fs::read_to_string(path).ok()?)
    })
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
        Err(ureq::Error::Status(code, _)) => bail!("Claude OAuth usage request failed with HTTP {code}"),
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
        assert_eq!(five_hour.used_percent, 12.0);
        assert_eq!(five_hour.resets_at, Some(1_788_757_220_000));
        let sonnet = windows.iter().find(|window| window.key == "seven_day_sonnet").unwrap();
        assert_eq!(sonnet.label, "7d Sonnet");
        assert_eq!(sonnet.used_percent, 70.0);
        let fable = windows.iter().find(|window| window.key == "fable_weekly").unwrap();
        assert_eq!(fable.label, "Fable");
        assert_eq!(fable.used_percent, 82.0);
        assert_eq!(fable.resets_at, Some(1_788_789_600_000));
        let scoped = windows.iter().find(|window| window.key == "model_scoped_sonnet_4_5").unwrap();
        assert_eq!(scoped.label, "Sonnet 4.5");
        assert_eq!(scoped.used_percent, 24.0);
        assert_eq!(scoped.window_minutes, Some(10_080));
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
