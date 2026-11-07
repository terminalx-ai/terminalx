//! Admission for Claude's documented host-owned provider routing contract.
//! Keep normal settings/instructions; the CLI filters their provider env.
//! Version coverage and remaining execution gates are in PRO-200-BEDROCK.md.

use std::path::{Path, PathBuf};
#[cfg(not(test))]
use std::time::Duration;

use anyhow::{Context, Result};

pub const SUPPORTED_VERSION: &str = "2.1.319";
const POLICY_ERROR: &str = "Amazon Bedrock route conflicts with Claude managed settings. Ask an administrator to reconcile the runtime policy before starting this route.";

/// Only nonsecret settings go on argv. The selected credentials and host flag
/// come from the structured child environment; host filtering discards even
/// flag-settings credentials, so it must never be used to deliver secrets.
pub fn apply_settings(settings: &mut serde_json::Value, env: &[(String, String)]) {
    for helper in ["apiKeyHelper", "awsAuthRefresh", "awsCredentialExport"] {
        settings[helper] = serde_json::Value::String(String::new());
    }
    settings["env"] = env
        .iter()
        .map(|(key, value)| (key.clone(), serde_json::Value::String(value.clone())))
        .collect::<serde_json::Map<_, _>>()
        .into();
}

pub fn resolve(identity: &super::configuration::Identity) -> Result<PathBuf> {
    identity.admit()?;
    #[cfg(test)]
    {
        // The integration fixture substitutes only the external executable
        // and system policy directory. Admission/trust/launch stay real.
        let system = PathBuf::from(crate::store::state_home_env().context("no test home")?)
            .join("test-system-policy");
        admit_policy(&system, &identity.user_dir())?;
        super::pty::test_program()
            .context("Bedrock integration test requires an explicit fixture executable")
    }
    #[cfg(not(test))]
    {
        resolve_installed(&identity.user_dir())
    }
}

#[cfg(not(test))]
fn resolve_installed(user_config: &Path) -> Result<PathBuf> {
    // Cloud runs Linux. MDM/registry sources on other platforms need their own
    // admission; a Linux file check must not pretend to verify them.
    anyhow::ensure!(
        cfg!(target_os = "linux"),
        "Amazon Bedrock routes require a Linux cloud runtime."
    );
    admit_policy(Path::new("/etc/claude-code"), user_config)?;
    let program = crate::binpath::resolve("claude")
        .context("Claude Code is not installed")?
        .canonicalize()
        .context("Cannot resolve the Claude Code executable")?;
    let mut probe = std::process::Command::new(&program);
    probe
        .arg("--version")
        .env_clear()
        .env("PATH", crate::binpath::login_path())
        .env("NO_COLOR", "1");
    let version = crate::git::output_within(probe, Duration::from_secs(5)).map_err(|_| {
        anyhow::anyhow!(
            "Could not verify Claude Code's Bedrock credential isolation. No agent was started."
        )
    })?;
    anyhow::ensure!(supported(&version), "This Bedrock route requires Claude Code {SUPPORTED_VERSION}; this CLI's host-routing contract has not been verified. No agent was started.");
    Ok(program)
}

fn supported(version: &str) -> bool {
    version.trim() == format!("{SUPPORTED_VERSION} (Claude Code)")
}

fn admit_policy(system: &Path, user: &Path) -> Result<()> {
    // Do not suppress managed routing/model policy by turning host mode on.
    // Presence includes invalid documents and symlinks; values are never read
    // or copied into an error. Direct AWS skips server policy delivery, and an
    // existing remote-policy cache needs reconciliation before host mode.
    for path in [
        system.join("managed-settings.json"),
        system.join("managed-settings.d"),
        user.join("remote-settings.json"),
    ] {
        match std::fs::symlink_metadata(path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => anyhow::bail!(POLICY_ERROR),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_older_and_unparseable_clis_fail_closed() {
        assert!(supported("2.1.319 (Claude Code)\n"));
        for output in [
            "",
            "2.1.318 (Claude Code)",
            "2.1.320 (Claude Code)",
            "2.1.319",
            "warning\n2.1.319 (Claude Code)",
        ] {
            assert!(!supported(output));
        }
    }

    #[test]
    fn managed_policy_and_remote_cache_are_not_silently_overridden() {
        for name in [
            "managed-settings.json",
            "managed-settings.d",
            "remote-settings.json",
        ] {
            let root = tempfile::tempdir().unwrap();
            let system = root.path().join("system");
            let user = root.path().join("user");
            std::fs::create_dir_all(&system).unwrap();
            std::fs::create_dir_all(&user).unwrap();
            admit_policy(&system, &user).unwrap();
            let path = if name == "remote-settings.json" {
                user.join(name)
            } else {
                system.join(name)
            };
            std::fs::write(&path, "synthetic private or malformed policy").unwrap();
            assert_eq!(
                admit_policy(&system, &user).unwrap_err().to_string(),
                POLICY_ERROR
            );
            assert!(path.exists());
        }
    }

    #[test]
    fn user_project_instructions_and_permission_settings_are_retained() {
        let root = tempfile::tempdir().unwrap();
        let system = root.path().join("system");
        let user = root.path().join("user");
        std::fs::create_dir_all(&user).unwrap();
        let path = user.join("settings.json");
        let controls = r#"{"permissions":{"deny":["Read(.env)"]},"env":{"AWS_BEARER_TOKEN_BEDROCK":"synthetic-stale"}}"#;
        std::fs::write(&path, controls).unwrap();
        std::fs::write(user.join("CLAUDE.md"), "Retain project instructions").unwrap();
        admit_policy(&system, &user).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), controls);
        assert!(user.join("CLAUDE.md").exists());
    }
}
