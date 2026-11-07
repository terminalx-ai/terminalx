//! Listening servers for sidebar rows. One bounded, cached probe for the whole
//! window, including servers an agent detached from its terminal.
#[cfg(any(unix, test))]
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

#[cfg(any(unix, test))]
fn listener_pids(output: &str) -> Vec<u32> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix('p')?.parse().ok())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .take(256)
        .collect()
}

#[cfg(any(unix, test))]
fn working_directories(output: &str) -> Vec<PathBuf> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix('n'))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .collect()
}

fn read_directories() -> Vec<PathBuf> {
    #[cfg(unix)]
    {
        use std::process::Command;
        let binary = if cfg!(target_os = "macos") {
            "/usr/sbin/lsof"
        } else {
            "lsof"
        };
        let mut command = Command::new(binary);
        command.args([
            "-w",
            "-nP",
            "-a",
            "-u",
            &unsafe { libc::geteuid() }.to_string(),
            "-iTCP",
            "-sTCP:LISTEN",
            "-Fp",
        ]);
        let pids = crate::git::output_within(command, Duration::from_secs(2))
            .map(|output| listener_pids(&output))
            .unwrap_or_default();
        if pids.is_empty() {
            return Vec::new();
        }
        let mut command = Command::new(binary);
        command.args([
            "-w",
            "-a",
            "-p",
            &pids
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(","),
            "-d",
            "cwd",
            "-Fn",
        ]);
        crate::git::output_within(command, Duration::from_secs(2))
            .map(|output| working_directories(&output))
            .unwrap_or_default()
    }
    #[cfg(not(unix))]
    {
        Vec::new()
    }
}

// A main checkout must not inherit a listener in one of its nested worktrees.
fn serves(cwd: &Path, roots: &[PathBuf], listeners: &[PathBuf]) -> bool {
    listeners.iter().any(|listener| {
        listener.starts_with(cwd)
            && !roots
                .iter()
                .any(|root| root != cwd && root.starts_with(cwd) && listener.starts_with(root))
    })
}

struct ListenerCache {
    at: Instant,
    directories: Vec<PathBuf>,
}

pub fn listening_sessions() -> anyhow::Result<Vec<String>> {
    static CACHE: OnceLock<Mutex<Option<ListenerCache>>> = OnceLock::new();
    let sessions = crate::store::index::load()?;
    let rows: Vec<_> = sessions
        .iter()
        .filter(|session| !session.worktree_removed)
        .filter_map(|session| {
            std::fs::canonicalize(&session.cwd)
                .ok()
                .map(|cwd| (session.id.clone(), cwd))
        })
        .collect();
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
    if cache
        .as_ref()
        .is_none_or(|cache| cache.at.elapsed() >= Duration::from_secs(10))
    {
        *cache = Some(ListenerCache {
            at: Instant::now(),
            directories: read_directories()
                .into_iter()
                .filter_map(|path| std::fs::canonicalize(path).ok())
                .collect(),
        });
    }
    let roots: Vec<_> = rows.iter().map(|(_, cwd)| cwd.clone()).collect();
    let listeners = &cache.as_ref().unwrap().directories;
    Ok(rows
        .into_iter()
        .filter(|(_, cwd)| serves(cwd, &roots, listeners))
        .map(|(id, _)| id)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_process_ids_and_absolute_working_directories() {
        assert_eq!(
            listener_pids("p12\np34\np12\npinvalid\nn127.0.0.1:8080\n"),
            [12, 34]
        );
        assert_eq!(
            working_directories("p12\nfcwd\nn/repo/a folder\np34\nnrelative\n"),
            [PathBuf::from("/repo/a folder")]
        );
    }

    #[test]
    fn attributes_ports_to_the_deepest_checkout_without_prefix_collisions() {
        let roots: Vec<_> = [
            "/repo",
            "/repo/.raccoon/worktrees/a",
            "/repo/.raccoon/worktrees/ab",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect();
        let listeners = vec![PathBuf::from("/repo/.raccoon/worktrees/ab/server")];
        assert!(!serves(&roots[0], &roots, &listeners));
        assert!(!serves(&roots[1], &roots, &listeners));
        assert!(serves(&roots[2], &roots, &listeners));
        assert!(!serves(&roots[2], &roots, &[]));
    }
}
