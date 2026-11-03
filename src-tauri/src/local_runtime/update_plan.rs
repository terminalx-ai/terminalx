//! What the person decided, before an update, about the runtime it leaves
//! behind (#766).
//!
//! The update itself replaces only the app. The runtime outlives it (#467),
//! so the relaunched app attaches to the one that was running, older than
//! itself, and replaces it (`replace.rs`). Asking then would be a second
//! decision after the restart; it is asked before the update instead, once,
//! and the app that installs the update leaves the answer here for the one it
//! relaunches into:
//!
//! - **Update now**: the runtime is replaced as soon as the new app attaches,
//!   whatever it runs, which the update card listed before installing.
//! - **Update when they're done**: it is replaced by itself once nothing it
//!   runs would be cut short, without asking again.
//! - Nothing was under way when the update was asked for, and still nothing
//!   once it was installed: it is replaced as the new app attaches, if
//!   nothing has started meanwhile, without waiting from the start for it to
//!   settle (`replace::SETTLE`).
//!
//! A plan is for the runtime that was attached when it was made, by its
//! epoch, and only for a while: a relaunch that did not happen, and an app
//! opened much later, start from what that app finds.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// How long a plan holds after it was made. A relaunch takes seconds, or a
/// minute or two while macOS checks the updated app for the first time.
pub const VALID_FOR: Duration = Duration::from_secs(10 * 60);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// The runtime attached when the update was installed.
    pub epoch: String,
    /// Update now: whatever it runs stops with it.
    pub forced: bool,
    /// Since when every reading before the relaunch found nothing under way,
    /// in milliseconds since the Unix epoch; `None` when one found something.
    pub quiet_since: Option<u64>,
    /// When the plan was made, just before the relaunch.
    pub made_at: u64,
    /// The app process that made it, which never acts on its own plan.
    pub made_by: u32,
}

impl Plan {
    /// Whether the plan still holds at `now`.
    pub fn current(&self, now: SystemTime) -> bool {
        let made = UNIX_EPOCH + Duration::from_millis(self.made_at);
        // A plan from the future is from a clock that moved: not to be trusted.
        now.duration_since(made).is_ok_and(|age| age <= VALID_FOR)
    }

    /// How long before `now` nothing was found under way, when every reading
    /// before the relaunch found nothing.
    pub fn quiet_for(&self, now: SystemTime) -> Option<Duration> {
        now.duration_since(UNIX_EPOCH + Duration::from_millis(self.quiet_since?)).ok()
    }
}

/// Milliseconds since the Unix epoch, as plans record time.
pub fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map_or(0, |since| since.as_millis().try_into().unwrap_or(u64::MAX))
}

fn path(home: &Path) -> PathBuf { home.join("runtime-update.json") }

/// Leave `plan` for the app the update relaunches into.
pub fn save(home: &Path, plan: &Plan) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(plan)?;
    crate::store::write_atomic(&path(home), &bytes).context("save the runtime update plan")
}

/// The plan another app process left, if any. One this process made is the
/// next one's to act on. One that cannot be read is no plan.
pub fn load(home: &Path) -> Option<Plan> {
    let bytes = match std::fs::read(path(home)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            log::warn!("read the runtime update plan: {error}");
            return None;
        }
    };
    match serde_json::from_slice::<Plan>(&bytes) {
        Ok(plan) if plan.made_by == std::process::id() => None,
        Ok(plan) => Some(plan),
        Err(error) => {
            log::warn!("the runtime update plan is not one this app reads: {error}");
            None
        }
    }
}

/// The plan was acted on, or has nothing left to act on: the next app starts
/// from what it finds.
pub fn clear(home: &Path) {
    match std::fs::remove_file(path(home)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("remove the runtime update plan: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(made_by: u32) -> Plan {
        Plan { epoch: "old".into(), forced: false, quiet_since: Some(1_000), made_at: 2_000, made_by }
    }

    #[test]
    fn a_plan_is_left_for_the_next_app_process_and_cleared_once_acted_on() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(load(home.path()), None, "no update made one");
        save(home.path(), &plan(std::process::id())).unwrap();
        assert_eq!(load(home.path()), None, "the app that made it relaunches; it never acts on its own plan");
        save(home.path(), &plan(1)).unwrap();
        assert_eq!(load(home.path()), Some(plan(1)), "the relaunched app reads it");
        clear(home.path());
        assert_eq!(load(home.path()), None);
        clear(home.path());
        std::fs::write(path(home.path()), b"{\"epoch\": 3}").unwrap();
        assert_eq!(load(home.path()), None, "one it cannot read is no plan");
    }

    #[test]
    fn a_plan_holds_for_a_while_and_says_how_long_nothing_was_under_way() {
        let made = UNIX_EPOCH + Duration::from_millis(2_000);
        let plan = plan(1);
        assert!(plan.current(made));
        assert!(plan.current(made + VALID_FOR));
        assert!(!plan.current(made + VALID_FOR + Duration::from_millis(1)), "an app opened much later starts from what it finds");
        assert!(!plan.current(made - Duration::from_secs(1)), "nor from a clock that moved back");
        assert_eq!(plan.quiet_for(made), Some(Duration::from_secs(1)));
        assert_eq!(Plan { quiet_since: None, ..plan.clone() }.quiet_for(made), None);
        assert_eq!(plan.quiet_for(UNIX_EPOCH), None);
        assert_eq!(millis(made), 2_000);
    }
}
