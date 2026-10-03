//! How much memory and disk the machine under a workspace has left, as its
//! runtime sees it (`lifecycle.resources`, PRO-33).
//!
//! A full disk and exhausted memory both end work in ways that look like
//! something else: a save that fails, an agent that stops mid-turn. The
//! runtime reports the numbers and the client decides what to say, so the
//! thresholds can change without a new runtime. Reading them costs one small
//! file and one `statvfs`, never wakes anything and holds no state.
//!
//! `{"v":1,"memory":{"totalBytes","availableBytes"}|null,
//!   "storage":{"totalBytes","availableBytes","totalInodes","availableInodes"}|null,
//!   "observedAt":<ms>}`
//!
//! `memory` is null where the kernel has no `/proc/meminfo` (not Linux), and
//! `storage` where the filesystem cannot be asked.

use std::path::Path;

use serde_json::{json, Value};

const MEMINFO: &str = "/proc/meminfo";

/// The machine's memory and the disk that holds `root`, now.
pub fn observe(root: &Path) -> Value {
    let memory = std::fs::read_to_string(MEMINFO).ok().and_then(|text| memory(&text));
    json!({
        "v": 1,
        "memory": memory.map(|(total, available)| json!({ "totalBytes": total, "availableBytes": available })),
        "storage": storage(root),
        "observedAt": crate::cloud_agents::now_ms(),
    })
}

/// `(MemTotal, MemAvailable)` in bytes from `/proc/meminfo`. A kernel too
/// old to report `MemAvailable` (before 3.14) gives nothing rather than a
/// guess.
fn memory(meminfo: &str) -> Option<(u64, u64)> {
    let kib = |name: &str| {
        meminfo.lines().find_map(|line| {
            let value = line.strip_prefix(name)?.strip_prefix(':')?.trim();
            value.strip_suffix("kB").unwrap_or(value).trim().parse::<u64>().ok()
        })
    };
    let total = kib("MemTotal")?;
    let available = kib("MemAvailable")?;
    (total > 0).then(|| (total.saturating_mul(1024), available.saturating_mul(1024)))
}

/// The filesystem under `path`: what an unprivileged process may still
/// write (`f_bavail`), and its inodes, whose exhaustion also reads "no space
/// left on device".
#[cfg(unix)]
fn storage(path: &Path) -> Option<Value> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: `path` is a valid C string and `stats` is writable for one
    // `statvfs`; it is read only after the call reports success.
    let stats = unsafe {
        if libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) != 0 {
            return None;
        }
        stats.assume_init()
    };
    #[allow(clippy::unnecessary_cast)]
    let (block, blocks, free, inodes, free_inodes) =
        (stats.f_frsize as u64, stats.f_blocks as u64, stats.f_bavail as u64, stats.f_files as u64, stats.f_favail as u64);
    (blocks > 0).then(|| {
        json!({
            "totalBytes": block.saturating_mul(blocks),
            "availableBytes": block.saturating_mul(free),
            "totalInodes": inodes,
            "availableInodes": free_inodes,
        })
    })
}

#[cfg(not(unix))]
fn storage(_path: &Path) -> Option<Value> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_is_read_in_bytes_and_never_guessed() {
        let meminfo = "MemTotal:        4000000 kB\nMemFree:          100000 kB\nMemAvailable:     300000 kB\nBuffers: 1 kB\n";
        assert_eq!(memory(meminfo), Some((4_000_000 * 1024, 300_000 * 1024)));
        assert_eq!(memory("MemTotal: 4000000 kB\nMemFree: 100000 kB\n"), None, "no MemAvailable");
        assert_eq!(memory("MemTotal: 0 kB\nMemAvailable: 0 kB\n"), None);
        assert_eq!(memory("MemTotalish: 5 kB\nMemAvailable: nonsense kB\n"), None);
        assert_eq!(memory(""), None);
    }

    #[cfg(unix)]
    #[test]
    fn the_disk_under_a_directory_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let observed = observe(dir.path());
        assert_eq!(observed["v"], 1);
        let storage = &observed["storage"];
        let (total, available) = (storage["totalBytes"].as_u64().unwrap(), storage["availableBytes"].as_u64().unwrap());
        assert!(total > 0 && available <= total, "{storage}");
        assert!(storage["totalInodes"].is_u64() && storage["availableInodes"].is_u64());
        assert!(observed["observedAt"].as_u64().unwrap() > 0);
        // A path that is not there is reported as unknown, not as a full disk.
        assert_eq!(observe(&dir.path().join("missing"))["storage"], Value::Null);
    }
}
