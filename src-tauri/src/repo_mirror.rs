//! One-way, opt-in mirroring into a repository's main checkout (PRO-251).
//!
//! HEAD, the branch and the real index never move. Git checks and applies a
//! binary patch between snapshots made with private indexes. A durable journal
//! and pinned trees allow Stop after a crash; unexpected root edits pause the
//! mirror and also prevent cleanup. There is no reset, clean or force path.

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

const RECORD: &str = "terminalx-root-mirror.json";
const REFS: &str = "refs/terminalx/root-mirror";
const INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub root: PathBuf,
    pub source: Option<PathBuf>,
    pub active: bool,
    pub error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    source: PathBuf,
    head: String,
    branch: String,
    base: String,
    applied: String,
    /// Written before applying, so either side of an interrupted apply can be recovered.
    pending: Option<String>,
}

struct Mirror {
    generation: uuid::Uuid,
    root: PathBuf,
    common: PathBuf,
    journal: Journal,
    error: Option<String>,
    stopped: bool,
    // Held for the entire run, across all windows and app processes.
    lease: Option<File>,
}

type Mirrors = HashMap<PathBuf, Arc<Mutex<Mirror>>>;

fn mirrors() -> &'static Mutex<Mirrors> {
    static MIRRORS: OnceLock<Mutex<Mirrors>> = OnceLock::new();
    MIRRORS.get_or_init(Mutex::default)
}

fn running(root: &Path) -> Option<Arc<Mutex<Mirror>>> {
    mirrors().lock().unwrap_or_else(|e| e.into_inner()).get(root).cloned()
}

fn command(cwd: &Path) -> Command {
    let mut command = Command::new(crate::binpath::resolve("git").unwrap_or_else(|| "git".into()));
    for name in [
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
    ] {
        command.env_remove(name);
    }
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .env("PATH", crate::binpath::login_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("LC_ALL", "C")
        .args(["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"]);
    command
}

fn output(command: &mut Command) -> Result<Vec<u8>> {
    let output = command.output().context("run Git for repository mirroring")?;
    if !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr).trim());
    }
    Ok(output.stdout)
}

fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    Ok(String::from_utf8(output(command(cwd).args(args))?)?.trim_end().to_owned())
}

fn repository(project: &Path) -> Result<(PathBuf, PathBuf)> {
    let root = fs::canonicalize(project).context("The repository root is unavailable")?;
    let top = fs::canonicalize(git(&root, &["rev-parse", "--show-toplevel"])?)?;
    let common = fs::canonicalize(git(&root, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?)?;
    let own = fs::canonicalize(git(&root, &["rev-parse", "--absolute-git-dir"])?)?;
    if root != top || own != common {
        bail!("Mirroring needs the project's main checkout as the repository root.");
    }
    Ok((root, common))
}

fn source_check(root: &Path, common: &Path, source: &Path) -> Result<PathBuf> {
    let source = fs::canonicalize(source).context("The local workspace is unavailable")?;
    let top = fs::canonicalize(git(&source, &["rev-parse", "--show-toplevel"])?)?;
    let source_common = fs::canonicalize(git(&source, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?)?;
    if source == root || source != top || source_common != common {
        bail!("Choose a local worktree of this repository to mirror.");
    }
    Ok(source)
}

fn lease(common: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let file = options.open(common.join("terminalx-root-mirror.lock"))?;
    file.try_lock()
        .map_err(|_| anyhow::anyhow!("Another TerminalX window or process is mirroring this repository. Stop it there first."))?;
    Ok(file)
}

fn read(common: &Path) -> Result<Option<Journal>> {
    match fs::read(common.join(RECORD)) {
        Ok(bytes) => Ok(Some(
            serde_json::from_slice(&bytes).context("The mirror recovery record cannot be read; it has been kept")?,
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// Refuse Git states where a normal snapshot could silently omit work.
fn ordinary_checkout(cwd: &Path) -> Result<()> {
    let flags = git(cwd, &["ls-files", "-v", "-z"])?;
    if flags
        .split('\0')
        .any(|entry| entry.starts_with('S') || entry.as_bytes().first().is_some_and(u8::is_ascii_lowercase))
    {
        bail!("Mirroring does not support sparse checkouts or assume-unchanged files. Clear those flags first.");
    }
    let entries = git(cwd, &["ls-files", "--stage", "-z"])?;
    if entries.split('\0').any(|entry| entry.starts_with("160000 ")) {
        bail!("Mirroring does not support repositories with submodules.");
    }
    let own = PathBuf::from(git(cwd, &["rev-parse", "--absolute-git-dir"])?);
    if ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "index.lock"]
        .iter()
        .any(|name| own.join(name).exists())
    {
        bail!("Finish the Git operation in {} before mirroring.", cwd.display());
    }
    if !git(cwd, &["ls-files", "--unmerged"])?.is_empty() {
        bail!("Resolve the conflicts in {} before mirroring.", cwd.display());
    }
    Ok(())
}

/// All committed, staged, unstaged and non-ignored untracked files. The real
/// index is never used for writes, even when git add or write-tree fails.
fn snapshot(cwd: &Path, seed: &str) -> Result<String> {
    snapshot_pending(cwd, seed, None)
}

fn snapshot_pending(cwd: &Path, seed: &str, pending: Option<&str>) -> Result<String> {
    let directory = tempfile::tempdir()?;
    let index = directory.path().join("index");
    let run = |args: &[&str]| -> Result<String> {
        Ok(String::from_utf8(output(command(cwd).env("GIT_INDEX_FILE", &index).args(args))?)?
            .trim_end()
            .to_owned())
    };
    if seed == "INDEX" {
        let own = git(cwd, &["rev-parse", "--absolute-git-dir"])?;
        fs::copy(Path::new(&own).join("index"), &index)?;
    } else {
        run(&["read-tree", seed])?;
    }
    if let Some(pending) = pending {
        // Include both generations in the private index. New forced/ignored
        // files in an interrupted apply must not disappear from the check.
        let entries = output(command(cwd).args(["ls-tree", "-r", "-z", pending]))?;
        let mut input = tempfile::NamedTempFile::new()?;
        use std::io::Write;
        input.write_all(&entries)?;
        output(
            command(cwd)
                .env("GIT_INDEX_FILE", &index)
                .args(["update-index", "-z", "--index-info"])
                .stdin(input.reopen()?),
        )?;
    }
    run(&["add", "--all", "--", "."])?;
    let tree = run(&["write-tree"])?;
    // Untracked nested repositories can become gitlinks during git add.
    if git(cwd, &["ls-tree", "-r", &tree])?.lines().any(|line| line.starts_with("160000 ")) {
        bail!("Mirroring does not support nested repositories or submodules.");
    }
    Ok(tree)
}

fn head(cwd: &Path) -> Result<String> {
    git(cwd, &["rev-parse", "--verify", "HEAD"])
}
fn branch(cwd: &Path) -> Result<String> {
    git(cwd, &["rev-parse", "--symbolic-full-name", "HEAD"])
}

/// A process can die between writes in git apply. Accept only files that are
/// exactly one of the two recorded versions, never a third-party edit.
fn interrupted_apply(root: &Path, before: &str, pending: &str, actual: &str) -> Result<bool> {
    let entries = |tree: &str| -> Result<HashMap<Vec<u8>, Vec<u8>>> {
        let bytes = output(command(root).args(["ls-tree", "-r", "-z", tree]))?;
        bytes
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
            .map(|entry| {
                let tab = entry.iter().position(|byte| *byte == b'\t').context("Invalid mirror tree entry")?;
                Ok((entry[tab + 1..].to_vec(), entry[..tab].to_vec()))
            })
            .collect()
    };
    let before = entries(before)?;
    let pending = entries(pending)?;
    let actual = entries(actual)?;
    Ok(before
        .keys()
        .chain(pending.keys())
        .chain(actual.keys())
        .all(|path| actual.get(path) == before.get(path) || actual.get(path) == pending.get(path)))
}

impl Mirror {
    fn status(&self) -> Status {
        Status {
            root: self.root.clone(),
            source: (!self.stopped).then(|| self.journal.source.clone()),
            active: !self.stopped && self.error.is_none(),
            error: self.error.clone(),
        }
    }

    fn save(&self) -> Result<()> {
        // Trees named in the journal survive git gc, including a pending apply.
        // Pin by object id, so updating the refs cannot unpin the journal's
        // previous generation before its atomic replacement reaches disk.
        for tree in [Some(&self.journal.base), Some(&self.journal.applied), self.journal.pending.as_ref()]
            .into_iter()
            .flatten()
        {
            git(&self.root, &["update-ref", &format!("{REFS}/{tree}"), tree])?;
        }
        let mut temporary = tempfile::NamedTempFile::new_in(&self.common)?;
        use std::io::Write;
        temporary.write_all(&serde_json::to_vec(&self.journal)?)?;
        temporary.as_file().sync_all()?;
        temporary.persist(self.common.join(RECORD))?;
        #[cfg(unix)]
        File::open(&self.common)?.sync_all()?;
        Ok(())
    }

    fn check_root(&self, allow_clean: bool) -> Result<String> {
        ordinary_checkout(&self.root)?;
        if head(&self.root)? != self.journal.head || branch(&self.root)? != self.journal.branch {
            bail!("The repository root's HEAD or branch changed. Restore its original checkout before stopping; no files were overwritten.");
        }
        if !git(&self.root, &["diff", "--cached", "--name-only", "HEAD", "--"])?.is_empty() {
            bail!("The repository root has staged changes. Save or unstage them before stopping; no files were overwritten.");
        }
        let actual = snapshot_pending(&self.root, &self.journal.applied, self.journal.pending.as_deref())?;
        let recorded = actual == self.journal.applied || self.journal.pending.as_ref() == Some(&actual) || (allow_clean && actual == self.journal.base);
        let interrupted = !recorded
            && match &self.journal.pending {
                Some(pending) => interrupted_apply(&self.root, &self.journal.applied, pending, &actual)?,
                None => false,
            };
        if !recorded && !interrupted {
            bail!("The repository root was edited outside mirroring. Save the root's changes (for example, with Git stash), then retry Stop mirroring. The recovery record has been kept; no files were overwritten.");
        }
        Ok(actual)
    }

    fn apply(&mut self, target: &str) -> Result<()> {
        let allow_clean = target == self.journal.base;
        let actual = self.check_root(allow_clean)?;
        if actual == target {
            if self.journal.applied != actual || self.journal.pending.is_some() {
                self.journal.applied = actual;
                self.journal.pending = None;
                self.save()?;
            }
            return Ok(());
        }
        let patch = output(command(&self.root).args([
            "diff",
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--unified=2147483647",
            &actual,
            target,
            "--",
        ]))?;
        let mut file = tempfile::NamedTempFile::new()?;
        use std::io::Write;
        file.write_all(&patch)?;
        let apply = |check: bool| -> Result<()> {
            let mut command = command(&self.root);
            command.args(["apply", "--binary", "--whitespace=nowarn"]);
            if check {
                command.arg("--check");
            }
            output(command.arg("--").arg(file.path()))?;
            Ok(())
        };
        // git apply refuses collisions, including ignored files and symlink
        // parents, and checks the whole patch before writing any of it.
        apply(true)?;
        self.journal.applied = actual.clone();
        self.journal.pending = Some(target.to_owned());
        self.save()?;
        if self.check_root(allow_clean)? != actual {
            bail!("The repository root changed while preparing to mirror. No patch was applied; stop mirroring to recover.");
        }
        apply(false)?;
        self.journal.applied = target.to_owned();
        self.journal.pending = None;
        self.save()?;
        Ok(())
    }

    fn sync(&mut self) -> Result<()> {
        source_check(&self.root, &self.common, &self.journal.source)?;
        let source_git = PathBuf::from(git(&self.journal.source, &["rev-parse", "--absolute-git-dir"])?);
        // A routine add/commit in the workspace should defer one tick, not
        // permanently pause mirroring. The root's lock still fails closed.
        if source_git.join("index.lock").exists() {
            return Ok(());
        }
        ordinary_checkout(&self.journal.source)?;
        let target = snapshot(&self.journal.source, "INDEX")?;
        self.apply(&target)
    }

    fn stop(&mut self) -> Result<()> {
        self.apply(&self.journal.base.clone())?;
        // Do not declare success if a concurrent editor or Git command changed
        // the checkout while the reverse patch was being applied.
        self.check_root(true)?;
        fs::remove_file(self.common.join(RECORD))?;
        if let Ok(refs) = git(&self.root, &["for-each-ref", "--format=%(refname)", &format!("{REFS}/")]) {
            for reference in refs.lines() {
                // An orphaned safety ref is harmless; it must not prevent Stop.
                let _ = git(&self.root, &["update-ref", "-d", reference]);
            }
        }
        Ok(())
    }
}

pub fn status(project: &Path) -> Result<Status> {
    let (root, common) = repository(project)?;
    if let Some(mirror) = running(&root) {
        return Ok(mirror.lock().unwrap_or_else(|e| e.into_inner()).status());
    }
    let saved = read(&common)?;
    let error = saved.as_ref().map(|_| match lease(&common) {
        Ok(_) => "Mirroring was interrupted. Stop mirroring to restore the repository root before starting again.".to_owned(),
        Err(error) => error.to_string(),
    });
    Ok(Status {
        root,
        source: saved.map(|journal| journal.source),
        active: false,
        error,
    })
}

pub fn start(project: &Path, source: &Path, confirmed: bool) -> Result<Status> {
    if !confirmed {
        bail!("Confirm mirroring into the repository root before starting.");
    }
    let (root, common) = repository(project)?;
    let source = source_check(&root, &common, source)?;
    if running(&root).is_some() {
        bail!("This repository already has a mirror. Stop mirroring first.");
    }
    let lease = lease(&common)?;
    if read(&common)?.is_some() {
        bail!("A previous mirror needs cleanup. Stop mirroring before starting again.");
    }
    ordinary_checkout(&root)?;
    ordinary_checkout(&source)?;
    let dirty = git(&root, &["status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none"])?;
    if !dirty.is_empty() {
        bail!(
            "The repository root has uncommitted changes. Commit or stash them before mirroring:\n{}",
            dirty.chars().take(2000).collect::<String>()
        );
    }
    let head = head(&root)?;
    let base = git(&root, &["rev-parse", "HEAD^{tree}"])?;
    let mut mirror = Mirror {
        generation: uuid::Uuid::new_v4(),
        journal: Journal {
            source,
            head,
            branch: branch(&root)?,
            base: base.clone(),
            applied: base,
            pending: None,
        },
        root: root.clone(),
        common,
        error: None,
        stopped: false,
        lease: Some(lease),
    };
    // Persist before the first write. Even an initial failure remains visible
    // and stoppable rather than abandoning a possibly partial application.
    mirror.save()?;
    if let Err(error) = mirror.sync() {
        mirror.error = Some(format!("{error:#}"));
    }
    let status = mirror.status();
    let generation = mirror.generation;
    mirrors()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(root.clone(), Arc::new(Mutex::new(mirror)));
    std::thread::spawn(move || loop {
        std::thread::sleep(INTERVAL);
        let Some(mirror) = running(&root) else { break };
        let mut mirror = mirror.lock().unwrap_or_else(|e| e.into_inner());
        if mirror.generation != generation || mirror.stopped {
            break;
        }
        if mirror.error.is_none() {
            if let Err(error) = mirror.sync() {
                mirror.error = Some(format!("{error:#}"));
            }
        }
    });
    Ok(status)
}

pub fn stop(project: &Path) -> Result<Status> {
    let (root, common) = repository(project)?;
    let mirror = if let Some(mirror) = running(&root) {
        Some(mirror)
    } else {
        let lease = lease(&common)?;
        if let Some(journal) = read(&common)? {
            let mirror = Arc::new(Mutex::new(Mirror {
                generation: uuid::Uuid::new_v4(),
                root: root.clone(),
                common,
                journal,
                error: Some("Mirroring was interrupted".into()),
                stopped: false,
                lease: Some(lease),
            }));
            mirrors().lock().unwrap_or_else(|e| e.into_inner()).insert(root.clone(), mirror.clone());
            Some(mirror)
        } else {
            None
        }
    };
    if let Some(handle) = mirror {
        let mut mirror = handle.lock().unwrap_or_else(|e| e.into_inner());
        if !mirror.stopped {
            if let Err(error) = mirror.stop() {
                mirror.error = Some(format!("{error:#}"));
                return Err(error);
            }
            // A worker/second Stop that already obtained an Arc must not
            // write after Stop or remove a subsequently started mirror.
            mirror.stopped = true;
            mirror.error = None;
            mirror.lease.take();
            let mut mirrors = mirrors().lock().unwrap_or_else(|e| e.into_inner());
            if mirrors.get(&root).is_some_and(|current| Arc::ptr_eq(current, &handle)) {
                mirrors.remove(&root);
            }
        }
    }
    Ok(Status {
        root,
        source: None,
        active: false,
        error: None,
    })
}

#[cfg(test)]
#[path = "repo_mirror_tests.rs"]
mod tests;
