//! Bounded retention per checkout. Callers hold the checkpoint workspace lock.
use super::*;
use std::collections::BTreeMap;
use std::io::Write;
use std::process::Stdio;

const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_GROUPS: usize = 50;
/// Run expensive `git rev-list --objects --disk-usage` periodically in the
/// background rather than synchronously on every turn start/end.
const BYTE_TRIM_EVERY_PINS: u64 = 10;
const BYTE_TRIM_INTERVAL_SECS: i64 = 300;

static IN_FLIGHT_BYTE_TRIMS: std::sync::LazyLock<std::sync::Mutex<BTreeSet<PathBuf>>> =
    std::sync::LazyLock::new(Default::default);

#[cfg(test)]
thread_local! {
    static TEST_DISK_BYTES_CALLS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

#[derive(Default, Serialize, Deserialize)]
struct Ledger {
    clock: u64,
    #[serde(default)]
    last_byte_trim_clock: u64,
    #[serde(default)]
    last_byte_trim_at: i64,
    groups: BTreeMap<String, Group>,
}
#[derive(Default, Serialize, Deserialize)]
struct Group {
    touched: u64,
    // Keep the old ledger shape readable. Values used to be logical tree sizes;
    // only the ref names matter now. Git counts unique on-disk objects below.
    refs: BTreeMap<String, u64>,
}

fn run_input(cwd: &Path, args: &[&str], input: &str) -> Result<String> {
    let mut child = git()
        .current_dir(cwd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let written = child.stdin.take().unwrap().write_all(input.as_bytes());
    let output = child.wait_with_output()?;
    written?;
    if !output.status.success() {
        bail!("git {}: {}", args.join(" "), String::from_utf8_lossy(&output.stderr));
    }
    Ok(String::from_utf8(output.stdout)?)
}

fn disk_bytes(cwd: &Path, ledger: &Ledger) -> Result<u64> {
    #[cfg(test)]
    TEST_DISK_BYTES_CALLS.with(|c| c.set(c.get() + 1));
    let refs: Vec<_> = ledger.groups.values().flat_map(|group| group.refs.keys().map(String::as_str)).collect();
    if refs.is_empty() {
        return Ok(0);
    }
    // Tree refs share unchanged blobs and subtrees. Count their union once, using
    // Git's on-disk sizes, rather than charging the whole checkout for every ref.
    Ok(run_input(cwd, &["rev-list", "--objects", "--disk-usage", "--stdin"], &refs.join("\n"))?
        .trim()
        .parse()?)
}

fn ledger_path(cwd: &Path) -> Result<PathBuf> {
    let dir = run(cwd, &["rev-parse", "--absolute-git-dir"])?;
    Ok(Path::new(crate::git::path_line(&dir)).join("raccoon-checkpoint-retention.json"))
}

fn root_and_ledger_path(cwd: &Path) -> Result<(String, PathBuf)> {
    let raw = run(cwd, &["rev-parse", "--show-toplevel", "--absolute-git-dir"])?;
    let mut lines = raw.split('\n');
    let root = crate::git::path_line(lines.next().context("missing checkout root")?).to_string();
    let git_dir = crate::git::path_line(lines.next().context("missing git dir")?);
    Ok((root, Path::new(git_dir).join("raccoon-checkpoint-retention.json")))
}

fn load(path: &Path) -> Result<Ledger> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Ledger::default()),
        Err(error) => Err(error.into()),
    }
}

fn protected_groups(ledger: &Ledger, state: &crate::checkpoints::RetentionState) -> BTreeSet<String> {
    let mut protected = state.protected.clone();
    if state.running {
        // Unknown legacy groups cannot be safely dated relative to a running turn.
        protected.extend(ledger.groups.keys().filter(|group| !state.owned.contains(*group)).cloned());
    }
    protected
}

fn byte_trim_due(ledger: &Ledger, now_secs: i64) -> bool {
    if ledger.groups.len() <= 1 {
        return false;
    }
    if ledger.clock.saturating_sub(ledger.last_byte_trim_clock) >= BYTE_TRIM_EVERY_PINS {
        return true;
    }
    ledger.last_byte_trim_at > 0 && now_secs.saturating_sub(ledger.last_byte_trim_at) >= BYTE_TRIM_INTERVAL_SECS
}

fn run_byte_trim_locked(cwd: &Path, max_bytes: u64) -> Result<bool> {
    if !cwd.exists() {
        return Ok(false);
    }
    let (root, path) = root_and_ledger_path(cwd)?;
    let mut ledger = load(&path)?;
    if ledger.groups.is_empty() {
        return Ok(false);
    }
    let state = crate::checkpoints::retention_state(&root)?;
    let protected = protected_groups(&ledger, &state);
    let evicted = trim_bytes(cwd, &mut ledger, &protected, max_bytes)?;
    ledger.last_byte_trim_clock = ledger.clock;
    ledger.last_byte_trim_at = chrono::Utc::now().timestamp();
    crate::store::write_json_nosync(&path, &ledger)?;
    Ok(evicted)
}

fn schedule_async_byte_trim(root: PathBuf) {
    {
        let mut inflight = IN_FLIGHT_BYTE_TRIMS.lock().unwrap_or_else(|e| e.into_inner());
        if !inflight.insert(root.clone()) {
            return;
        }
    }
    let root_for_thread = root.clone();
    let spawn = std::thread::Builder::new()
        .name("checkpoint-byte-trim".into())
        .spawn(move || {
            struct Guard(PathBuf);
            impl Drop for Guard {
                fn drop(&mut self) {
                    IN_FLIGHT_BYTE_TRIMS
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&self.0);
                }
            }
            let _guard = Guard(root_for_thread.clone());
            let Some(root_str) = root_for_thread.to_str() else { return };
            if !root_for_thread.exists() {
                return;
            }
            if let Err(error) = crate::checkpoints::workspace_locked(root_str, || {
                run_byte_trim_locked(&root_for_thread, MAX_BYTES).map(|_| ())
            }) {
                if root_for_thread.exists() {
                    log::debug!("async checkpoint byte trim skipped for {}: {error:#}", root_for_thread.display());
                }
            }
        });
    if spawn.is_err() {
        IN_FLIGHT_BYTE_TRIMS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&root);
    }
}

pub fn pin(cwd: &Path, updates: &[(String, &str)]) -> Result<()> {
    if updates.is_empty() {
        return Ok(());
    }
    let (root, path) = root_and_ledger_path(cwd)?;
    let mut ledger = load(&path)?;
    let refs = run(cwd, &["for-each-ref", "--format=%(refname)", "refs/raccoon-checkpoints/"])?;
    let present: BTreeSet<_> = refs.lines().collect();
    ledger.groups.retain(|group_name, group| {
        group.refs.retain(|name, _| {
            name.starts_with("refs/raccoon-checkpoints/")
                && name.rsplit_once('/').is_some_and(|(parent, _)| parent == group_name)
                && present.contains(name.as_str())
        });
        !group.refs.is_empty()
    });
    let state = crate::checkpoints::retention_state(&root)?;
    let mut owned = state.owned.clone();
    let current: BTreeSet<_> = updates.iter().map(|(name, _)| name.rsplit_once('/').unwrap().0.to_string()).collect();
    owned.extend(current.iter().cloned());
    // Git worktrees share refs. Adopt only refs owned by this checkout.
    for name in present {
        let Some((parent, _)) = name.rsplit_once('/') else { continue };
        if owned.contains(parent) || state.discard_prefixes.iter().any(|prefix| name.starts_with(prefix)) {
            ledger.groups.entry(parent.to_string()).or_default().refs.insert(name.to_string(), 0);
        }
    }
    ledger.clock = ledger.clock.saturating_add(1);
    let mut input = String::from("start\n");
    for (name, tree) in updates {
        let group = ledger.groups.entry(name.rsplit_once('/').unwrap().0.to_string()).or_default();
        group.touched = ledger.clock;
        group.refs.insert(name.clone(), 0);
        input.push_str(&format!("update {name} {tree}\n"));
    }
    input.push_str("prepare\ncommit\n");
    // Record ownership before publishing refs so a failed write cannot orphan them.
    crate::store::write_json_nosync(&path, &ledger)?;
    run_input(cwd, &["update-ref", "--stdin"], &input)?;
    let mut protected = protected_groups(&ledger, &state);
    protected.extend(current);
    if trim_groups(cwd, &mut ledger, &protected, MAX_GROUPS)? {
        crate::store::write_json_nosync(&path, &ledger)?;
    }
    if byte_trim_due(&ledger, chrono::Utc::now().timestamp()) {
        schedule_async_byte_trim(PathBuf::from(root));
    }
    Ok(())
}

/// How many more turns in this checkout `group` lasts before the count limit
/// removes it: each new turn adds a group, and past [`MAX_GROUPS`] the least
/// recently touched one goes. So with `newer` groups touched after it, it
/// goes on the `MAX_GROUPS - newer`th. None when the ledger does not hold it,
/// or when it outlived the limit already, which only a protected group does.
/// The size limit cannot be foreseen without asking Git, so it is not counted.
pub fn remaining(cwd: &Path, group: &str) -> Result<Option<usize>> {
    let ledger = load(&ledger_path(cwd)?)?;
    Ok(remaining_in(&ledger, group, MAX_GROUPS))
}

fn remaining_in(ledger: &Ledger, group: &str, max_groups: usize) -> Option<usize> {
    let touched = ledger.groups.get(group)?.touched;
    let newer = ledger.groups.values().filter(|other| other.touched > touched).count();
    max_groups.checked_sub(newer).filter(|left| *left > 0)
}

fn evict_oldest(cwd: &Path, ledger: &mut Ledger, protected: &BTreeSet<String>) -> Result<bool> {
    let Some(oldest) = ledger
        .groups
        .iter()
        .filter(|(name, _)| !protected.contains(*name))
        .min_by_key(|(_, group)| group.touched)
        .map(|(name, _)| name.clone())
    else {
        return Ok(false);
    };
    let group = &ledger.groups[&oldest];
    let mut input = String::from("start\n");
    for name in group.refs.keys() {
        input.push_str(&format!("delete {name}\n"));
    }
    input.push_str("prepare\ncommit\n");
    run_input(cwd, &["update-ref", "--stdin"], &input)?;
    ledger.groups.remove(&oldest);
    Ok(true)
}

fn trim_groups(cwd: &Path, ledger: &mut Ledger, protected: &BTreeSet<String>, max_groups: usize) -> Result<bool> {
    let mut evicted = false;
    while ledger.groups.len() > max_groups {
        if !evict_oldest(cwd, ledger, protected)? {
            break;
        }
        evicted = true;
    }
    Ok(evicted)
}

fn trim_bytes(cwd: &Path, ledger: &mut Ledger, protected: &BTreeSet<String>, max_bytes: u64) -> Result<bool> {
    let mut evicted = false;
    while disk_bytes(cwd, ledger)? > max_bytes {
        if !evict_oldest(cwd, ledger, protected)? {
            break;
        }
        evicted = true;
    }
    Ok(evicted)
}

#[cfg(test)]
fn trim(cwd: &Path, ledger: &mut Ledger, protected: &BTreeSet<String>, max_groups: usize, max_bytes: u64) -> Result<()> {
    // These are soft limits while a turn runs. Never sacrifice overlap evidence
    // or the current operation's backup to meet a storage target. A later pin
    // resumes eviction once the running window closes.
    trim_groups(cwd, ledger, protected, max_groups)?;
    trim_bytes(cwd, ledger, protected, max_bytes)?;
    Ok(())
}

#[cfg(test)]
pub fn enforce_for_test(cwd: &Path, max_groups: usize, max_bytes: u64) -> Result<()> {
    let path = ledger_path(cwd)?;
    let mut ledger = load(&path)?;
    let root = run(cwd, &["rev-parse", "--show-toplevel"])?;
    let state = crate::checkpoints::retention_state(crate::git::path_line(&root))?;
    let protected = protected_groups(&ledger, &state);
    trim(cwd, &mut ledger, &protected, max_groups, max_bytes)?;
    crate::store::write_json(&path, &ledger)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_checkpoint_says_how_many_turns_remain_before_it_expires() {
        let mut ledger = Ledger::default();
        for (n, name) in ["old", "middle", "new"].into_iter().enumerate() {
            ledger.groups.insert(name.into(), Group { touched: n as u64 + 1, refs: BTreeMap::new() });
        }
        // With room for 3, the oldest goes on the next turn, the newest in 3.
        assert_eq!(remaining_in(&ledger, "old", 3), Some(1));
        assert_eq!(remaining_in(&ledger, "middle", 3), Some(2));
        assert_eq!(remaining_in(&ledger, "new", 3), Some(3));
        assert_eq!(remaining_in(&ledger, "gone", 3), None, "a group the ledger does not hold");
        assert_eq!(remaining_in(&ledger, "old", 2), None, "one already past the limit is protected, not about to go");
    }

    #[test]
    fn counts_shared_objects_once_and_adopts_legacy_refs_without_other_worktrees() {
        let _home = crate::store::temp_home();
        let repo = super::super::super::tests::repo();
        std::fs::write(repo.path().join("large.txt"), vec![b'x'; 1024 * 1024]).unwrap();
        let tree = snapshot_tree(repo.path()).unwrap();
        let start = "refs/raccoon-checkpoints/session/tab-1/start";
        let foreign = "refs/raccoon-checkpoints/another-worktree/tab-1/start";
        run(repo.path(), &["update-ref", foreign, &tree]).unwrap();
        run(repo.path(), &["update-ref", start, &tree]).unwrap();
        pin(repo.path(), &[("refs/raccoon-checkpoints/session/tab-1/end".into(), &tree)]).unwrap();
        let ledger = load(&ledger_path(repo.path()).unwrap()).unwrap();
        assert_eq!(ledger.groups["refs/raccoon-checkpoints/session/tab-1"].refs.len(), 2);
        let single: u64 = run(repo.path(), &["rev-list", "--objects", "--disk-usage", &tree])
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert_eq!(
            disk_bytes(repo.path(), &ledger).unwrap(),
            single,
            "two refs must not count identical objects twice"
        );
        assert!(single < 1024 * 1024, "use disk storage, not logical file size");
        std::fs::write(repo.path().join("a.txt"), "a new version\n").unwrap();
        let changed = snapshot_tree(repo.path()).unwrap();
        pin(repo.path(), &[("refs/raccoon-checkpoints/session/tab-2/end".into(), &changed)]).unwrap();
        let combined = load(&ledger_path(repo.path()).unwrap()).unwrap();
        let changed_bytes: u64 = run(repo.path(), &["rev-list", "--objects", "--disk-usage", &changed])
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let shared_bytes = disk_bytes(repo.path(), &combined).unwrap();
        assert!(shared_bytes > single);
        assert!(
            shared_bytes < single + changed_bytes,
            "different snapshots must share the unchanged objects too"
        );
        assert_eq!(ledger.groups.len(), 1);
        assert_eq!(combined.groups.len(), 2);
        assert!(run_ok(repo.path(), &["show-ref", "--verify", foreign]));
    }

    #[test]
    fn retention_evicts_whole_oldest_groups_for_count_and_unique_bytes() {
        let _home = crate::store::temp_home();
        let repo = super::super::super::tests::repo();
        let cwd = repo.path();
        let tree = snapshot_tree(cwd).unwrap();
        let mut ledger = Ledger::default();
        for i in 0..4 {
            let group = format!("refs/raccoon-checkpoints/session/tab-{i}");
            let name = format!("{group}/start");
            let end = format!("{group}/end");
            run(cwd, &["update-ref", &name, &tree]).unwrap();
            run(cwd, &["update-ref", &end, &tree]).unwrap();
            ledger.groups.insert(
                group,
                Group {
                    touched: i,
                    refs: BTreeMap::from([(name, 0), (end, 0)]),
                },
            );
        }
        let current = "refs/raccoon-checkpoints/session/tab-3";
        let protected = BTreeSet::from([current.to_string()]);
        trim(cwd, &mut ledger, &protected, 3, u64::MAX).unwrap();
        assert_eq!(ledger.groups.len(), 3);
        assert!(!run_ok(cwd, &["show-ref", "--verify", "refs/raccoon-checkpoints/session/tab-0/start"]));
        assert!(!run_ok(cwd, &["show-ref", "--verify", "refs/raccoon-checkpoints/session/tab-0/end"]));
        trim(cwd, &mut ledger, &protected, 3, 0).unwrap();
        assert_eq!(ledger.groups.len(), 1, "even an undersized budget cannot evict the protected current group");
        assert!(run_ok(cwd, &["show-ref", "--verify", &format!("{current}/start")]));
    }

    #[cfg_attr(windows, ignore = "Windows does not allow a file name that ends in a space")]
    #[test]
    fn the_ledger_lives_in_a_git_dir_whose_name_ends_in_a_space() {
        let dir = tempfile::tempdir().unwrap();
        let (work, git_dir) = (dir.path().join("work "), dir.path().join("git dir "));
        crate::git::run(dir.path(), &["init", "-q", "--separate-git-dir", git_dir.to_str().unwrap(), work.to_str().unwrap()]).unwrap();
        let ledger = ledger_path(&work).unwrap();
        assert_eq!(crate::paths::canonicalize(ledger.parent().unwrap()).unwrap(), crate::paths::canonicalize(&git_dir).unwrap());
    }

    #[test]
    fn pin_skips_synchronous_disk_usage_and_throttles_periodic_byte_trim() {
        let _home = crate::store::temp_home();
        let repo = super::super::super::tests::repo();
        let cwd = repo.path();
        let tree = snapshot_tree(cwd).unwrap();

        TEST_DISK_BYTES_CALLS.with(|c| c.set(0));
        for i in 0..4 {
            pin(cwd, &[(format!("refs/raccoon-checkpoints/session/tab-{i}/start"), &tree)]).unwrap();
        }
        assert_eq!(
            TEST_DISK_BYTES_CALLS.with(|c| c.get()),
            0,
            "pin() must not synchronously run git rev-list --disk-usage on every turn"
        );

        let mut ledger = load(&ledger_path(cwd).unwrap()).unwrap();
        assert!(!byte_trim_due(&ledger, 1_000), "below pin threshold on fresh ledger");
        ledger.clock = BYTE_TRIM_EVERY_PINS;
        assert!(byte_trim_due(&ledger, 1_000), "due once pin threshold reached");
        ledger.last_byte_trim_clock = ledger.clock;
        ledger.last_byte_trim_at = 1_000;
        assert!(!byte_trim_due(&ledger, 1_100), "throttled before interval elapses");
        assert!(byte_trim_due(&ledger, 1_000 + BYTE_TRIM_INTERVAL_SECS), "due after interval elapses");

        // Explicit byte trim runs disk_bytes and updates ledger timestamps.
        assert!(run_byte_trim_locked(cwd, 0).unwrap());
        assert!(TEST_DISK_BYTES_CALLS.with(|c| c.get()) >= 1);
        let after = load(&ledger_path(cwd).unwrap()).unwrap();
        assert_eq!(after.last_byte_trim_clock, after.clock);
        assert!(after.last_byte_trim_at > 0);
    }
}
