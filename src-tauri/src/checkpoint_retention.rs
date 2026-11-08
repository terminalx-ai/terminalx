//! Bounded retention per checkout. Callers hold the checkpoint workspace lock.
use super::*;
use std::collections::BTreeMap;
use std::io::Write;
use std::process::Stdio;

const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_GROUPS: usize = 50;

#[derive(Default, Serialize, Deserialize)]
struct Ledger {
    clock: u64,
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
    Ok(Path::new(dir.trim()).join("raccoon-checkpoint-retention.json"))
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

pub fn pin(cwd: &Path, updates: &[(String, &str)]) -> Result<()> {
    if updates.is_empty() {
        return Ok(());
    }
    let path = ledger_path(cwd)?;
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
    let root = run(cwd, &["rev-parse", "--show-toplevel"])?;
    let state = crate::checkpoints::retention_state(root.trim())?;
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
    crate::store::write_json(&path, &ledger)?;
    run_input(cwd, &["update-ref", "--stdin"], &input)?;
    let mut protected = protected_groups(&ledger, &state);
    protected.extend(current);
    trim(cwd, &mut ledger, &protected, MAX_GROUPS, MAX_BYTES)?;
    crate::store::write_json(&path, &ledger)
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

fn trim(cwd: &Path, ledger: &mut Ledger, protected: &BTreeSet<String>, max_groups: usize, max_bytes: u64) -> Result<()> {
    // These are soft limits while a turn runs. Never sacrifice overlap evidence
    // or the current operation's backup to meet a storage target. A later pin
    // resumes eviction once the running window closes.
    while ledger.groups.len() > max_groups {
        if !evict_oldest(cwd, ledger, protected)? {
            break;
        }
    }
    while disk_bytes(cwd, ledger)? > max_bytes {
        if !evict_oldest(cwd, ledger, protected)? {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
pub fn enforce_for_test(cwd: &Path, max_groups: usize, max_bytes: u64) -> Result<()> {
    let path = ledger_path(cwd)?;
    let mut ledger = load(&path)?;
    let root = run(cwd, &["rev-parse", "--show-toplevel"])?;
    let state = crate::checkpoints::retention_state(root.trim())?;
    let protected = protected_groups(&ledger, &state);
    trim(cwd, &mut ledger, &protected, max_groups, max_bytes)?;
    crate::store::write_json(&path, &ledger)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
