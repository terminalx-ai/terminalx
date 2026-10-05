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
//! Memory is what the runtime may actually use: where a cgroup limit is
//! tighter than the machine (a container), the limit and what is left under
//! it, not the host's numbers.
//!
//! `memory` is null where the kernel has no `/proc/meminfo` (not Linux), and
//! `storage` where the filesystem cannot be asked.

use std::path::Path;

use serde_json::{json, Value};

const MEMINFO: &str = "/proc/meminfo";
const SELF_CGROUP: &str = "/proc/self/cgroup";
const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// The machine's memory and the disk that holds `root`, now.
pub fn observe(root: &Path) -> Value {
    let host = std::fs::read_to_string(MEMINFO).ok().and_then(|text| memory(&text));
    let memory = within_limit(host, cgroup_limit());
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

/// A cgroup's memory limit as `(limit, in use)` in bytes, where "in use"
/// leaves out the file cache the kernel gives back under pressure.
type Limit = (u64, u64);

/// Memory as the runtime may actually use it. In a container (local Docker,
/// and any provider that runs the workspace in one) `/proc/meminfo` is the
/// host's, so a workspace can be killed for memory while the host has
/// plenty: when a cgroup limit is tighter than the machine, the limit is the
/// total and what is left under it is what is available.
fn within_limit(host: Option<(u64, u64)>, limit: Option<Limit>) -> Option<(u64, u64)> {
    let Some((limit, used)) = limit else { return host };
    let left = limit.saturating_sub(used);
    match host {
        Some((total, available)) if limit < total => Some((limit, left.min(available))),
        Some(host) => Some(host),
        None => Some((limit, left)),
    }
}

/// The tightest memory limit on this process: its own cgroup's or any
/// ancestor's, cgroup v2 (`memory.max`) or v1 (`memory.limit_in_bytes`).
/// `None` when nothing limits it, or off Linux.
fn cgroup_limit() -> Option<Limit> {
    let membership = std::fs::read_to_string(SELF_CGROUP).ok()?;
    let root = Path::new(CGROUP_ROOT);
    let mut tightest: Option<Limit> = None;
    for (dir, base, files) in [(cgroup_path(&membership, None), root.to_path_buf(), V2), (cgroup_path(&membership, Some("memory")), root.join("memory"), V1)] {
        let Some(dir) = dir else { continue };
        let mut relative = Path::new(dir.trim_start_matches('/'));
        loop {
            if let Some(limit) = read_limit(&base.join(relative), files) {
                if tightest.is_none_or(|(current, _)| limit.0 < current) {
                    tightest = Some(limit);
                }
            }
            match relative.parent() {
                Some(parent) if !relative.as_os_str().is_empty() => relative = parent,
                _ => break,
            }
        }
    }
    tightest
}

/// `(limit file, usage file, the reclaimable-cache key in memory.stat)`.
type Files = (&'static str, &'static str, &'static str);
const V2: Files = ("memory.max", "memory.current", "inactive_file");
const V1: Files = ("memory.limit_in_bytes", "memory.usage_in_bytes", "total_inactive_file");

fn read_limit(dir: &Path, files: Files) -> Option<Limit> {
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).ok();
    parse_limit(&read(files.0)?, &read(files.1)?, read("memory.stat").as_deref().unwrap_or(""), files.2)
}

/// `max` (v2) is no limit; so is v1's page-rounded `i64::MAX`, which is
/// larger than any machine and is ruled out by the caller's comparison with
/// the machine's memory.
fn parse_limit(limit: &str, usage: &str, stat: &str, cache_key: &str) -> Option<Limit> {
    let limit: u64 = limit.trim().parse().ok()?;
    let usage: u64 = usage.trim().parse().ok()?;
    let cache = stat
        .lines()
        .find_map(|line| line.strip_prefix(cache_key).and_then(|rest| rest.strip_prefix(' ')).and_then(|value| value.trim().parse::<u64>().ok()))
        .unwrap_or(0);
    (limit > 0).then(|| (limit, usage.saturating_sub(cache)))
}

/// This process's cgroup path from `/proc/self/cgroup`: the unified (v2)
/// line `0::/path`, or the v1 line of `controller`.
fn cgroup_path<'a>(membership: &'a str, controller: Option<&str>) -> Option<&'a str> {
    membership.lines().find_map(|line| {
        let mut parts = line.splitn(3, ':');
        let (id, controllers, path) = (parts.next()?, parts.next()?, parts.next()?);
        match controller {
            None => (id == "0" && controllers.is_empty()).then_some(path),
            Some(name) => controllers.split(',').any(|listed| listed == name).then_some(path),
        }
    })
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

    #[test]
    fn a_cgroup_limit_tighter_than_the_machine_is_the_memory() {
        const GIB: u64 = 1 << 30;
        let host = Some((64 * GIB, 40 * GIB));
        // A 4 GiB container using 3.7 GiB on a roomy host: 0.3 GiB is left, not 40.
        let used = 37 * GIB / 10;
        assert_eq!(within_limit(host, Some((4 * GIB, used))), Some((4 * GIB, 4 * GIB - used)));
        // The host itself is shorter than what the limit leaves.
        assert_eq!(within_limit(Some((64 * GIB, GIB / 2)), Some((4 * GIB, GIB))), Some((4 * GIB, GIB / 2)));
        // No limit, or one larger than the machine (v1's "unlimited"): the machine's own numbers.
        assert_eq!(within_limit(host, None), host);
        assert_eq!(within_limit(host, Some((u64::MAX / 4096 * 4096, GIB))), host);
        // Over the limit already: nothing left, never an underflow.
        assert_eq!(within_limit(host, Some((4 * GIB, 5 * GIB))), Some((4 * GIB, 0)));
        assert_eq!(within_limit(None, Some((4 * GIB, GIB))), Some((4 * GIB, 3 * GIB)));
        assert_eq!(within_limit(None, None), None);
    }

    #[test]
    fn cgroup_files_are_read_for_both_versions() {
        // v2: `max` is no limit; reclaimable file cache is not memory in use.
        assert_eq!(parse_limit("max\n", "100\n", "", "inactive_file"), None);
        assert_eq!(parse_limit("4096\n", "3000\n", "anon 1000\ninactive_file 500\nactive_file 9\n", "inactive_file"), Some((4096, 2500)));
        assert_eq!(parse_limit("4096", "3000", "inactive_file_extra 500\n", "inactive_file"), Some((4096, 3000)));
        // v1 names it differently.
        assert_eq!(parse_limit("4096", "3000", "inactive_file 1\ntotal_inactive_file 700\n", "total_inactive_file"), Some((4096, 2300)));
        assert_eq!(parse_limit("nonsense", "3000", "", "inactive_file"), None);
        assert_eq!(parse_limit("0", "0", "", "inactive_file"), None);

        let v2 = "0::/system.slice/terminalx-serve.service\n";
        assert_eq!(cgroup_path(v2, None), Some("/system.slice/terminalx-serve.service"));
        assert_eq!(cgroup_path(v2, Some("memory")), None);
        let v1 = "12:cpu,cpuacct:/a\n7:memory:/docker/abc\n1:name=systemd:/b\n";
        assert_eq!(cgroup_path(v1, Some("memory")), Some("/docker/abc"));
        assert_eq!(cgroup_path(v1, None), None);
        assert_eq!(cgroup_path("0::/\n", None), Some("/"));
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
