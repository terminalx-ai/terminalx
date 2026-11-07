//! Bounded retention per checkout. Callers hold the checkpoint workspace lock.
use super::*;
use std::collections::BTreeMap;

pub const MAX_TREE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_GROUPS: usize = 50;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct LimitExceeded(pub &'static str);

#[derive(Default, Serialize, Deserialize)]
struct Ledger {
    clock: u64,
    groups: BTreeMap<String, Group>,
}
#[derive(Default, Serialize, Deserialize)]
struct Group {
    touched: u64,
    refs: BTreeMap<String, u64>,
}

fn tree_bytes(cwd: &Path, tree: &str) -> Result<u64> {
    let entries = run(cwd, &["ls-tree", "-r", "-l", "-z", tree])?;
    Ok(entries
        .split('\0')
        .filter_map(|entry| entry.split('\t').next()?.split_whitespace().nth(3)?.parse::<u64>().ok())
        .fold(0, u64::saturating_add))
}

pub fn pin(cwd: &Path, name: &str, tree: &str) -> Result<()> {
    pin_with_tree_limit(cwd, name, tree, MAX_TREE_BYTES)
}

fn pin_with_tree_limit(cwd: &Path, name: &str, tree: &str, max_tree_bytes: u64) -> Result<()> {
    let bytes = tree_bytes(cwd, tree)?;
    if bytes > max_tree_bytes {
        return Err(LimitExceeded("This checkpoint exceeds the 256 MiB snapshot limit.").into());
    }
    let dir = run(cwd, &["rev-parse", "--absolute-git-dir"])?;
    let path = Path::new(dir.trim()).join("raccoon-checkpoint-retention.json");
    let mut ledger: Ledger = match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ledger::default(),
        Err(e) => return Err(e.into()),
    };
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
    let group_name = name.rsplit_once('/').ok_or_else(|| anyhow!("Invalid checkpoint ref"))?.0.to_string();
    let root = run(cwd, &["rev-parse", "--show-toplevel"])?;
    let mut owned = crate::checkpoints::ref_groups(root.trim())?;
    owned.insert(group_name.clone());
    let mut discard_prefixes = Vec::new();
    for session in crate::store::index::load()? {
        if run(Path::new(&session.cwd), &["rev-parse", "--show-toplevel"]).is_ok_and(|p| p.trim() == root.trim()) {
            discard_prefixes.push(format!("refs/raccoon-checkpoints/{}/discard-", session.id));
        }
    }
    // Refs are shared by Git worktrees; adopt only metadata belonging to this checkout.
    for name in present {
        let Some((parent, _)) = name.rsplit_once('/') else { continue };
        if owned.contains(parent) || discard_prefixes.iter().any(|prefix| name.starts_with(prefix)) {
            let group = ledger.groups.entry(parent.to_string()).or_default();
            if !group.refs.contains_key(name) {
                group.refs.insert(name.to_string(), tree_bytes(cwd, name)?);
            }
        }
    }
    ledger.clock = ledger.clock.saturating_add(1);
    let group = ledger.groups.entry(group_name.clone()).or_default();
    group.touched = ledger.clock;
    group.refs.insert(name.to_string(), bytes);
    if group.refs.values().copied().fold(0, u64::saturating_add) > MAX_BYTES {
        return Err(LimitExceeded("Checkpoint exceeds the workspace retention limit").into());
    }
    run(cwd, &["update-ref", name, tree])?;
    trim(cwd, &mut ledger, &group_name, MAX_GROUPS, MAX_BYTES)?;
    crate::store::write_json(&path, &ledger)
}

fn trim(cwd: &Path, ledger: &mut Ledger, current: &str, max_groups: usize, max_bytes: u64) -> Result<()> {
    while ledger.groups.len() > max_groups || ledger.groups.values().flat_map(|g| g.refs.values()).copied().fold(0, u64::saturating_add) > max_bytes {
        let oldest = ledger
            .groups
            .iter()
            .filter(|(name, _)| name.as_str() != current)
            .min_by_key(|(_, group)| group.touched)
            .map(|(name, _)| name.clone())
            .ok_or_else(|| anyhow!("Checkpoint exceeds the workspace retention limit"))?;
        let group = ledger.groups.remove(&oldest).unwrap();
        for name in group.refs.keys() {
            run(cwd, &["update-ref", "-d", name])?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_trees_are_not_pinned_and_legacy_refs_are_accounted_for() {
        let _home = crate::store::temp_home();
        let repo = super::super::super::tests::repo();
        std::fs::write(repo.path().join("large.txt"), "more than one byte").unwrap();
        let tree = snapshot_tree(repo.path()).unwrap();
        let start = "refs/raccoon-checkpoints/session/tab-1/start";
        let foreign = "refs/raccoon-checkpoints/another-worktree/tab-1/start";
        run(repo.path(), &["update-ref", foreign, &tree]).unwrap();
        assert!(pin_with_tree_limit(repo.path(), start, &tree, 1).is_err());
        assert!(!run_ok(repo.path(), &["show-ref", "--verify", start]));
        run(repo.path(), &["update-ref", start, &tree]).unwrap();
        pin(repo.path(), "refs/raccoon-checkpoints/session/tab-1/end", &tree).unwrap();
        let ledger: Ledger = serde_json::from_slice(&std::fs::read(repo.path().join(".git/raccoon-checkpoint-retention.json")).unwrap()).unwrap();
        let group = &ledger.groups["refs/raccoon-checkpoints/session/tab-1"];
        assert_eq!(group.refs.len(), 2);
        assert!(group.refs.values().all(|bytes| *bytes >= 18));
        assert_eq!(ledger.groups.len(), 1, "another checkout's refs are excluded");
        assert!(run_ok(repo.path(), &["show-ref", "--verify", foreign]));
    }

    #[test]
    fn retention_evicts_whole_oldest_groups_for_count_and_bytes() {
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
                    refs: BTreeMap::from([(name, 5), (end, 5)]),
                },
            );
        }
        let current = "refs/raccoon-checkpoints/session/tab-3";
        trim(cwd, &mut ledger, current, 3, 100).unwrap();
        assert_eq!(ledger.groups.len(), 3);
        assert!(!run_ok(cwd, &["show-ref", "--verify", "refs/raccoon-checkpoints/session/tab-0/start"]));
        assert!(!run_ok(cwd, &["show-ref", "--verify", "refs/raccoon-checkpoints/session/tab-0/end"]));
        trim(cwd, &mut ledger, current, 3, 15).unwrap();
        assert_eq!(ledger.groups.len(), 1);
        assert!(run_ok(cwd, &["show-ref", "--verify", &format!("{current}/start")]));
    }
}
