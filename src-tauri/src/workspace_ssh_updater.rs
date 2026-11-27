//! Negotiated readiness and the bounded status projection for PRO-215.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const CAPABILITY: &str = "workspace-ssh-updater-v1";
const MAX_WINDOW_MS: u64 = 5 * 60 * 1000;
const UPDATE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(6 * 60 * 60);
const MAX_JITTER_SECS: u64 = 90 * 60;

/// Runs inside the workspace service. Attempts are serial and sleep between
/// completions, so a slow update cannot queue concurrent installs.
pub(crate) fn spawn_periodic(
    attempt: impl Fn() + Send + Sync + 'static,
) -> tokio::task::JoinHandle<()> {
    use rand_core::{OsRng, RngCore};
    use std::sync::Arc;
    use std::time::Duration;

    let attempt = Arc::new(attempt);
    tokio::spawn(async move {
        let mut initial = true;
        loop {
            let delay = Duration::from_secs(OsRng.next_u64() % (MAX_JITTER_SECS + 1));
            tokio::time::sleep(if initial {
                delay
            } else {
                UPDATE_INTERVAL + delay
            })
            .await;
            initial = false;
            let run = Arc::clone(&attempt);
            if tokio::task::spawn_blocking(move || run()).await.is_err() {
                log::warn!("workspace SSH updater attempt failed unexpectedly");
            }
        }
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Decision {
    v: u8,
    workspace_id: String,
    runtime_generation: u64,
    enabled: bool,
    valid_until: Option<u64>,
}

impl Decision {
    pub(crate) fn read(
        value: Option<&Value>,
        requested: &str,
        workspace: &str,
        generation: u64,
        now_ms: u64,
    ) -> Option<Self> {
        if generation == 0 || !requested.split(',').any(|item| item == CAPABILITY) {
            return None;
        }
        let decision: Self = serde_json::from_value(value?.clone()).ok()?;
        let lifetime = decision.valid_until?.checked_sub(now_ms)?;
        (decision.v == 1
            && decision.enabled
            && decision.workspace_id == workspace
            && decision.runtime_generation == generation
            && (1..=MAX_WINDOW_MS).contains(&lifetime))
        .then_some(decision)
    }
}

/// Run the staging closure only with a fresh gate. The caller obtains the
/// second decision through an authenticated refresh and supplies it to the
/// activation closure, which must check it again under its install lock.
pub(crate) fn with_update_gate<T, U>(
    decision: impl FnOnce() -> Option<Decision>,
    stage: impl FnOnce() -> anyhow::Result<T>,
    refresh_before_switch: impl FnOnce() -> Option<Decision>,
    activate: impl FnOnce(T, Decision) -> anyhow::Result<U>,
) -> anyhow::Result<Option<U>> {
    let Some(initial) = decision() else {
        return Ok(None);
    };
    let candidate = stage()?;
    let Some(current) = refresh_before_switch() else {
        return Ok(None);
    };
    if initial.workspace_id != current.workspace_id
        || initial.runtime_generation != current.runtime_generation
    {
        return Ok(None);
    }
    activate(candidate, current).map(Some)
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Outcome {
    UpToDate,
    Updated,
    VerificationFailed,
    CandidateFailed,
    RolledBack,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    installed_version: Option<String>,
    result: Outcome,
    attempted_at: u64,
}

impl Status {
    #[cfg(unix)]
    pub(crate) fn new(
        version: Option<String>,
        result: Outcome,
        attempted_at: u64,
    ) -> anyhow::Result<Self> {
        anyhow::ensure!(
            attempted_at > 0 && attempted_at < (1u64 << 53),
            "invalid SSH updater attempt time"
        );
        if let Some(version) = version.as_deref() {
            crate::workspace_ssh_payload::Version::parse(version)?;
        }
        Ok(Self {
            installed_version: version,
            result,
            attempted_at,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspace_ssh_updater_decision_requires_current_bound_affirmative_negotiation() {
        let decision = json!({"v":1, "workspaceId":"workspace-a", "runtimeGeneration":7,
            "enabled":true, "validUntil":301000});
        let read = |value: &Value| Decision::read(Some(value), CAPABILITY, "workspace-a", 7, 1000);
        assert!(read(&decision).is_some());
        assert!(
            Decision::read(Some(&decision), "workspace-ssh-v2", "workspace-a", 7, 1000).is_none()
        );
        assert!(Decision::read(Some(&decision), CAPABILITY, "workspace-b", 7, 1000).is_none());
        assert!(Decision::read(Some(&decision), CAPABILITY, "workspace-a", 8, 1000).is_none());
        for (field, bad) in [
            ("v", json!(2)),
            ("enabled", json!(false)),
            ("enabled", json!("true")),
            ("validUntil", json!(null)),
            ("validUntil", json!(1000)),
            ("validUntil", json!(301001)),
        ] {
            let mut invalid = decision.clone();
            invalid[field] = bad;
            assert!(read(&invalid).is_none(), "{field}");
        }
    }

    #[test]
    fn workspace_ssh_updater_holds_staging_and_switch_on_rollout_loss() {
        let none = with_update_gate(
            || None,
            || -> anyhow::Result<()> { panic!("held updater staged a payload") },
            || panic!("held updater refreshed unnecessarily"),
            |_, _| -> anyhow::Result<()> { panic!("held updater activated a payload") },
        )
        .unwrap();
        assert!(none.is_none());

        let fresh = || {
            Decision::read(
                Some(&json!({
                    "v":1,"workspaceId":"workspace-a","runtimeGeneration":7,"enabled":true,"validUntil":2000
                })),
                CAPABILITY,
                "workspace-a",
                7,
                1000,
            )
        };
        let none = with_update_gate(
            fresh,
            || Ok("candidate"),
            || None,
            |_, _| -> anyhow::Result<()> { panic!("revoked updater activated a payload") },
        )
        .unwrap();
        assert!(none.is_none());
        let updated = with_update_gate(
            fresh,
            || Ok("candidate"),
            fresh,
            |candidate, _| Ok(candidate),
        )
        .unwrap();
        assert_eq!(updated, Some("candidate"));
    }

    #[test]
    #[cfg(unix)]
    fn workspace_ssh_updater_status_is_exact_and_has_no_unbounded_output() {
        let status =
            Status::new(Some("9.6p1-terminalx.1".into()), Outcome::RolledBack, 1000).unwrap();
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({
                "installedVersion":"9.6p1-terminalx.1","result":"rolled_back","attemptedAt":1000
            })
        );
        assert!(Status::new(Some("unknown".into()), Outcome::Updated, 1000).is_err());
        assert!(
            serde_json::to_value(Status::new(None, Outcome::CandidateFailed, 1000).unwrap())
                .unwrap()["installedVersion"]
                .is_null()
        );
    }
}
