//! The no-remote part of a cloud-to-local transfer. A bundle contains one
//! pinned branch and never supplies a destination path or updates a ref.

use anyhow::{bail, ensure, Context, Result};
use std::path::{Path, PathBuf};
use std::time::Duration;

const BUNDLE_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BranchCommit {
    branch_ref: String,
    commit: String,
}

impl BranchCommit {
    pub(crate) fn new(branch: &str, commit: &str) -> Result<Self> {
        ensure!(
            crate::remote::git::valid_ref_name(branch),
            "invalid transfer branch"
        );
        ensure!(
            matches!(commit.len(), 40 | 64) && commit.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "transfer needs a full commit id"
        );
        Ok(Self {
            branch_ref: format!("refs/heads/{branch}"),
            commit: commit.to_ascii_lowercase(),
        })
    }
}

pub(crate) struct TransferBundle {
    _directory: tempfile::TempDir,
    pub(crate) path: PathBuf,
}

fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let mut command = crate::git::git_in(repo, args);
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1");
    crate::git::output_within(command, BUNDLE_TIMEOUT)
        .map_err(|error| anyhow::anyhow!("transfer bundle: {error}"))
}

fn path_argument(path: &Path) -> Result<&str> {
    ensure!(
        path.is_absolute(),
        "transfer bundle needs a native storage path"
    );
    path.to_str().context("unsupported transfer bundle path")
}

pub(crate) fn export(repo: &Path, expected: &BranchCommit) -> Result<TransferBundle> {
    let head = git(repo, &["rev-parse", "--verify", &expected.branch_ref])?;
    ensure!(
        head.trim() == expected.commit,
        "cloud branch changed before export"
    );
    let directory = tempfile::Builder::new()
        .prefix("terminalx-transfer-")
        .tempdir()?;
    let path = directory.path().join("workspace.bundle");
    git(
        repo,
        &[
            "bundle",
            "create",
            path_argument(&path)?,
            &expected.branch_ref,
        ],
    )?;
    check_head(repo, &path, expected)?;
    Ok(TransferBundle {
        _directory: directory,
        path,
    })
}

fn check_head(repo: &Path, bundle: &Path, expected: &BranchCommit) -> Result<()> {
    let heads = git(repo, &["bundle", "list-heads", path_argument(bundle)?])?;
    let mut heads = heads.lines();
    let Some((commit, reference)) = heads.next().and_then(|line| line.split_once(' ')) else {
        bail!("the transfer bundle has no branch");
    };
    ensure!(
        commit == expected.commit && reference == expected.branch_ref && heads.next().is_none(),
        "the transfer bundle does not match the selected branch and commit"
    );
    Ok(())
}

/// Load Git objects only. The caller can create the named branch and
/// worktree after the transcript and destination have both been validated.
pub(crate) fn import_objects(repo: &Path, bundle: &Path, expected: &BranchCommit) -> Result<()> {
    check_head(repo, bundle, expected)?;
    let bundle = path_argument(bundle)?;
    git(repo, &["bundle", "verify", bundle])?;
    git(repo, &["bundle", "unbundle", bundle])?;
    git(
        repo,
        &["cat-file", "-e", &format!("{}^{{commit}}", expected.commit)],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository(path: &Path) {
        std::fs::create_dir(path).unwrap();
        git(path, &["init", "-q", "-b", "main"]).unwrap();
        git(path, &["config", "user.name", "Fixture"]).unwrap();
        git(path, &["config", "user.email", "fixture@example.test"]).unwrap();
    }

    fn commit(repo: &Path) -> String {
        git(
            repo,
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "--allow-empty",
                "-m",
                "fixture",
            ],
        )
        .unwrap();
        git(repo, &["rev-parse", "HEAD"]).unwrap().trim().into()
    }

    #[test]
    fn exports_the_branch_without_a_remote_and_imports_its_objects_without_moving_a_local_ref() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&cloud);
        repository(&local);
        git(&cloud, &["switch", "-c", "topic/one"]).unwrap();
        let source = BranchCommit::new("topic/one", &commit(&cloud)).unwrap();
        let local_head = commit(&local);
        let bundle = export(&cloud, &source).unwrap();
        import_objects(&local, &bundle.path, &source).unwrap();
        assert_eq!(
            git(&local, &["rev-parse", "HEAD"]).unwrap().trim(),
            local_head
        );
        assert!(git(&local, &["show-ref", "--verify", &source.branch_ref]).is_err());
        assert_eq!(
            git(&local, &["cat-file", "-t", &source.commit])
                .unwrap()
                .trim(),
            "commit"
        );
    }

    #[test]
    fn refuses_a_moved_branch_and_an_unexpected_bundle_head() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&cloud);
        repository(&local);
        let initial = BranchCommit::new("main", &commit(&cloud)).unwrap();
        let bundle = export(&cloud, &initial).unwrap();
        let moved = BranchCommit::new("main", &commit(&cloud)).unwrap();
        assert!(export(&cloud, &initial).is_err());
        assert!(import_objects(&local, &bundle.path, &moved).is_err());
        assert!(git(&local, &["cat-file", "-e", &initial.commit]).is_err());
    }
}
