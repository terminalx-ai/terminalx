//! Stable, machine-local port blocks. These are assignments, not listening
//! sockets: commands must use TERMINALX_PORT (or a port from TERMINALX_PORTS).
use std::{collections::{BTreeMap, BTreeSet}, path::{Path, PathBuf}};
use anyhow::{bail, ensure, Result};
use super::{IndexFile, SessionEntry};

const FIRST: u16 = 20000;
const LAST: u16 = 49000;
const COUNT: u16 = 10;

fn canonical(path: &str) -> String {
    // A worktree has already moved when its sessions are renamed. Resolve its
    // existing ancestors too (notably /var -> /private/var on macOS).
    let path = Path::new(path);
    for parent in path.ancestors() {
        if let Ok(root) = std::fs::canonicalize(parent) {
            return root.join(path.strip_prefix(parent).unwrap()).to_string_lossy().into_owned();
        }
    }
    PathBuf::from(path).to_string_lossy().into_owned()
}

pub(super) fn locations(sessions: &[SessionEntry]) -> BTreeMap<String, String> {
    sessions.iter().map(|session| (session.id.clone(), session.cwd.clone())).collect()
}

/// Carry an allocation with a renamed checkout. Moving a deleted workspace's
/// sessions back to main uses main's block. Blocks of removed sessions can be
/// reclaimed on the next allocation; archived sessions retain theirs.
pub(super) fn relocate(file: &mut IndexFile, previous: &BTreeMap<String, String>) {
    for session in &file.sessions {
        let Some(old) = previous.get(&session.id) else { continue };
        if old == &session.cwd || session.worktree_removed || file.sessions.iter().any(|s| &s.cwd == old) { continue; }
        let old = canonical(old);
        if file.sessions.iter().any(|s| canonical(&s.cwd) == old) { continue; }
        if let Some(port) = file.workspace_ports.remove(&old) {
            file.workspace_ports.entry(canonical(&session.cwd)).or_insert(port);
        }
    }
}

fn allocate(blocks: &mut BTreeMap<String, u16>, workspace: &str) -> Result<u16> {
    let mut used = BTreeSet::new();
    for &port in blocks.values() {
        ensure!((FIRST..=LAST).contains(&port) && (port - FIRST).is_multiple_of(COUNT) && used.insert(port),
            "The workspace port assignments are invalid; no process was started.");
    }
    if let Some(&port) = blocks.get(workspace) { return Ok(port); }
    let Some(port) = (FIRST..=LAST).step_by(COUNT as usize).find(|port| !used.contains(port)) else {
        bail!("All workspace port blocks are assigned. Remove an unused workspace before starting another.");
    };
    blocks.insert(workspace.into(), port);
    Ok(port)
}

/// Allocate before launch and persist before returning. Re-read under the
/// index lock so simultaneous launches (including in different runtimes) cannot
/// choose the same block. Subdirectories inherit their closest workspace.
pub fn environment(cwd: &str) -> Result<Vec<(String, String)>> {
    super::with_file_lock(|| {
        let mut file = super::load_file()?;
        let cwd = canonical(cwd);
        let paths: BTreeSet<_> = file.sessions.iter().map(|session| canonical(&session.cwd)).collect();
        let Some(workspace) = paths.iter().filter(|path| Path::new(&cwd).starts_with(path))
            .max_by_key(|path| path.len()) else { return Ok(Vec::new()); };
        let previous = file.workspace_ports.clone();
        file.workspace_ports.retain(|path, _| paths.contains(path));
        let first = allocate(&mut file.workspace_ports, workspace)?;
        if file.workspace_ports != previous { super::save_file(&mut file)?; }
        Ok(vec![
            ("TERMINALX_PORT".into(), first.to_string()),
            ("TERMINALX_PORTS".into(), (first..first + COUNT).map(|port| port.to_string()).collect::<Vec<_>>().join(",")),
        ])
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session(id: &str, cwd: &str) -> SessionEntry {
        serde_json::from_value(json!({ "id": id, "projectPath": "/repo", "cwd": cwd,
            "title": id, "created": "now", "modified": "now" })).unwrap()
    }

    #[test]
    fn workspaces_keep_distinct_blocks_across_reload_and_other_index_writes() {
        let _home = crate::store::temp_home();
        super::super::save(&[session("a", "/repo/a"), session("b", "/repo/b"), session("a2", "/repo/a")]).unwrap();
        let a = environment("/repo/a").unwrap();
        let b = environment("/repo/b").unwrap();
        assert_ne!(a, b);
        assert!(a[1].1.split(',').all(|port| !b[1].1.split(',').any(|other| other == port)));
        assert_eq!(a[1].1.split(',').count(), COUNT as usize);
        assert_eq!(a[0].1, a[1].1.split(',').next().unwrap());
        assert_eq!(environment("/repo/a/src").unwrap(), a);
        super::super::update_session("a", |session| { session.title = "renamed".into(); Ok(()) }).unwrap();
        assert_eq!(environment("/repo/a").unwrap(), a);
        assert_eq!(environment("/repo/b").unwrap(), b);
        assert_eq!(super::super::load_file().unwrap().workspace_ports.len(), 2);
        assert!(environment("/repo/another").unwrap().is_empty());
    }

    #[test]
    fn renaming_keeps_the_block_and_deleted_workspaces_release_it() {
        let _home = crate::store::temp_home();
        super::super::save(&[session("a", "/repo/a"), session("b", "/repo/b")]).unwrap();
        let a = environment("/repo/a").unwrap();
        let b = environment("/repo/b").unwrap();
        super::super::update_session("a", |session| { session.cwd = "/repo/renamed".into(); Ok(()) }).unwrap();
        assert_eq!(environment("/repo/renamed").unwrap(), a);
        super::super::update(|sessions| { sessions.retain(|s| s.id != "a"); sessions.push(session("c", "/repo/c")); Ok(()) }).unwrap();
        assert_eq!(environment("/repo/c").unwrap(), a);
        assert_eq!(environment("/repo/b").unwrap(), b);
    }

    #[test]
    fn exhaustion_and_corruption_fail_without_reassigning_existing_blocks() {
        let mut blocks = BTreeMap::new();
        for port in (FIRST..=LAST).step_by(COUNT as usize) { blocks.insert(port.to_string(), port); }
        assert!(allocate(&mut blocks, "new").is_err());
        assert_eq!(allocate(&mut blocks, &FIRST.to_string()).unwrap(), FIRST);
        blocks.insert("duplicate".into(), FIRST);
        assert!(allocate(&mut blocks, "new").is_err());
        blocks.clear();
        blocks.insert("invalid".into(), 65535);
        assert!(allocate(&mut blocks, "new").is_err());
    }

    #[test]
    fn simultaneous_launches_allocate_once_per_workspace() {
        let _home = crate::store::temp_home();
        let sessions: Vec<_> = (0..8).map(|n| session(&n.to_string(), &format!("/repo/{n}"))).collect();
        super::super::save(&sessions).unwrap();
        let workers: Vec<_> = sessions.into_iter().map(|session| std::thread::spawn(move || {
            let first = environment(&session.cwd).unwrap();
            assert_eq!(environment(&session.cwd).unwrap(), first);
            first[0].1.clone()
        })).collect();
        let ports: BTreeSet<_> = workers.into_iter().map(|worker| worker.join().unwrap()).collect();
        assert_eq!(ports.len(), 8);
        assert_eq!(super::super::load_file().unwrap().workspace_ports.len(), 8);
    }

    #[cfg(unix)]
    #[test]
    fn a_real_pane_receives_the_assignment_and_detects_its_printed_url() {
        use std::{sync::Arc, time::{Duration, Instant}};
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        super::super::save(&[session("s", cwd)]).unwrap();
        let env = environment(cwd).unwrap();
        let terminals = crate::pty::Terminals::new();
        let sink = Arc::new(crate::sink::BroadcastSink::new(16));
        terminals.spawn(sink, "s:dock-test", crate::pty::PaneSpec { cwd, cols: 100, rows: 24,
            command: Some("/bin/sh -c 'printf \"http://localhost:%s/\\n%s\\n\" \"$TERMINALX_PORT\" \"$TERMINALX_PORTS\"'"), env: &env }).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while terminals.is_running("s:dock-test") && Instant::now() < deadline { std::thread::sleep(Duration::from_millis(10)); }
        let output = terminals.read_output("s:dock-test").unwrap();
        let urls = terminals.local_urls("s:dock-test");
        terminals.kill_and_wait("s:dock-test", Duration::from_secs(5));
        assert!(String::from_utf8_lossy(&output).contains(&env[1].1));
        assert_eq!(urls, [format!("http://localhost:{}/", env[0].1)]);
    }

    #[cfg(unix)]
    #[test]
    fn aliases_share_one_block_and_nested_workspaces_get_their_own() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        let nested = root.join("worktree");
        std::fs::create_dir_all(&nested).unwrap();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        super::super::save(&[session("a", root.to_str().unwrap()), session("alias", alias.to_str().unwrap()), session("nested", nested.to_str().unwrap())]).unwrap();
        let a = environment(root.to_str().unwrap()).unwrap();
        assert_eq!(environment(alias.to_str().unwrap()).unwrap(), a);
        assert_ne!(environment(nested.to_str().unwrap()).unwrap(), a);
    }
}
