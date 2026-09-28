//! The memory baseline a cloud workspace runtime leaves for the worker
//! (terminalx-saas PRO-33, remote runtime contract section 9.5).
//!
//! Before relaunching a runtime on compute that kept running, the worker
//! probes the kernel's `boot_id` and `oom_kill` counter. The relaunch is
//! counted as an OOM kill only when the probe's boot id and the replaced
//! runtime generation match this baseline and `oom_kill` has risen since, so
//! the runtime records it once per boot and generation:
//!
//! `{"v":1,"bootId":"<boot_id>","runtimeGeneration":<n>,"oomKill":<n>,"recordedAt":<ms>}`

use std::path::Path;

use anyhow::{Context, Result};
use serde_json::{json, Value};

const BOOT_ID: &str = "/proc/sys/kernel/random/boot_id";
const VMSTAT: &str = "/proc/vmstat";

/// Record the baseline for `generation` at `path` unless it is already there
/// for this boot. Without `/proc` (not Linux) there is nothing to record.
pub fn record(path: &Path, generation: u64) -> Result<()> {
    let boot_id = match std::fs::read_to_string(BOOT_ID) {
        Ok(text) => text.trim().to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(anyhow::Error::new(error).context("read the kernel boot id")),
    };
    let vmstat = std::fs::read_to_string(VMSTAT).context("read /proc/vmstat")?;
    record_with(path, &boot_id, oom_kill(&vmstat), generation, now_ms())
}

fn record_with(path: &Path, boot_id: &str, oom_kill: u64, generation: u64, recorded_at: u64) -> Result<()> {
    let existing = std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    if existing.is_some_and(|baseline| baseline["bootId"] == boot_id && baseline["runtimeGeneration"] == generation) {
        return Ok(());
    }
    let baseline = json!({
        "v": 1,
        "bootId": boot_id,
        "runtimeGeneration": generation,
        "oomKill": oom_kill,
        "recordedAt": recorded_at,
    });
    crate::cloud_bootstrap::write_durable(path, baseline.to_string().as_bytes())
}

/// `oom_kill` from `/proc/vmstat`; 0 on a kernel too old to count it.
fn oom_kill(vmstat: &str) -> u64 {
    vmstat
        .lines()
        .find_map(|line| line.strip_prefix("oom_kill ").and_then(|value| value.trim().parse().ok()))
        .unwrap_or(0)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_oom_kill_from_vmstat() {
        assert_eq!(oom_kill("pgfault 12\noom_kill 3\npgmajfault 1\n"), 3);
        assert_eq!(oom_kill("pgfault 12\n"), 0);
        // Not a prefix match on a longer name.
        assert_eq!(oom_kill("oom_kill_total 9\n"), 0);
    }

    #[test]
    fn records_once_per_boot_and_generation() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory-baseline.json");
        let read = || serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap();
        record_with(&path, "boot-a", 2, 5, 1000).unwrap();
        assert_eq!(read(), json!({ "v": 1, "bootId": "boot-a", "runtimeGeneration": 5, "oomKill": 2, "recordedAt": 1000 }));
        // The same boot and generation keep the first counter: a later
        // restart must not hide an OOM kill that happened in between.
        record_with(&path, "boot-a", 3, 5, 2000).unwrap();
        assert_eq!(read()["oomKill"], 2);
        record_with(&path, "boot-a", 3, 6, 3000).unwrap();
        assert_eq!((read()["oomKill"].as_u64(), read()["runtimeGeneration"].as_u64()), (Some(3), Some(6)));
        record_with(&path, "boot-b", 0, 6, 4000).unwrap();
        assert_eq!(read()["bootId"], "boot-b");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn a_damaged_baseline_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory-baseline.json");
        std::fs::write(&path, b"{").unwrap();
        record_with(&path, "boot-a", 1, 1, 1).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap()["bootId"], "boot-a");
    }
}
