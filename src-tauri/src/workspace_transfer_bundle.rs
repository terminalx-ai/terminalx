//! A cloud-to-local transfer bundle contains one
//! pinned branch and never supplies a destination path or updates a ref.

use anyhow::{bail, ensure, Context, Result};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

const BUNDLE_TIMEOUT: Duration = Duration::from_secs(60);
#[cfg(any(feature = "desktop", test))]
const MAX_CHECKOUT_BYTES: u64 = 512 * 1024 * 1024;
#[cfg(any(feature = "desktop", test))]
const MAX_CHECKOUT_ENTRIES: usize = 100_000;
pub(crate) const CHUNK_BYTES: u64 = 128 * 1024;
pub(crate) const MAX_BUNDLE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BranchCommit {
    branch_ref: String,
    commit: String,
}

impl BranchCommit {
    pub(crate) fn commit(&self) -> &str {
        &self.commit
    }

    pub(crate) fn branch(&self) -> &str {
        self.branch_ref
            .strip_prefix("refs/heads/")
            .expect("validated branch")
    }

    pub(crate) fn new(branch: &str, commit: &str) -> Result<Self> {
        ensure!(
            crate::remote::git::valid_ref_name(branch)
                && !branch.eq_ignore_ascii_case("HEAD")
                && !branch
                    .split_once('/')
                    .is_some_and(|(prefix, _)| prefix.eq_ignore_ascii_case("refs")),
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
    path: PathBuf,
    size: u64,
}

impl TransferBundle {
    pub(crate) fn size(&self) -> u64 {
        self.size
    }

    /// Read from the private, verified export. The attachment handler must
    /// authorize the current peer before returning each chunk.
    pub(crate) fn read_chunk(&self, offset: u64) -> Result<Vec<u8>> {
        ensure!(
            offset <= self.size,
            "transfer offset exceeds the bundle size"
        );
        let mut file = std::fs::File::open(&self.path)?;
        ensure!(
            file.metadata()?.len() == self.size,
            "the transfer bundle changed"
        );
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; (self.size - offset).min(CHUNK_BYTES) as usize];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }
}

fn git_command(repo: &Path, args: &[&str]) -> std::process::Command {
    let mut command = crate::git::git_in(repo, args);
    let bound = command
        .get_envs()
        .any(|(key, value)| key == "GIT_DIR" && value.is_some());
    if !bound {
        for key in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_COMMON_DIR",
            "GIT_INDEX_FILE",
        ] {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_LAZY_FETCH", "1")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
        .env_remove("GIT_QUARANTINE_PATH")
        .env("GIT_NO_REPLACE_OBJECTS", "1")
        .env("GIT_ALLOW_PROTOCOL", "file");
    command
}

pub(crate) fn git(repo: &Path, args: &[&str]) -> Result<String> {
    let mut command = git_command(repo, args);
    command.args(args);
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

#[derive(Debug, thiserror::Error)]
#[error("Cannot transfer {branch} because the cloud checkout has no usable upstream base.")]
pub(crate) struct NoTransferBase {
    branch: String,
}

pub(crate) fn check_branch_namespace(repo: &Path, expected: &BranchCommit) -> Result<()> {
    if expected.branch().contains('/') {
        let branch = expected.branch().to_lowercase();
        let remotes = git(repo, &["remote"])?;
        let conflicts = std::iter::once("origin")
            .chain(remotes.lines())
            .any(|remote| {
                branch
                    .strip_prefix(&remote.to_lowercase())
                    .is_some_and(|tail| tail.starts_with('/'))
            });
        ensure!(
            !conflicts,
            "The transfer branch name conflicts with a remote namespace"
        );
    }
    Ok(())
}

pub(crate) fn export(repo: &Path, expected: &BranchCommit) -> Result<Option<TransferBundle>> {
    check_branch_namespace(repo, expected)?;
    let head = git(repo, &["rev-parse", "--verify", &expected.branch_ref])?;
    ensure!(
        head.trim() == expected.commit,
        "cloud branch changed before export"
    );
    let boundary = ["@{upstream}", "refs/remotes/origin/HEAD"]
        .into_iter()
        .find_map(|reference| git(repo, &["merge-base", expected.commit(), reference]).ok());
    let Some(boundary) = boundary else {
        return Err(NoTransferBase {
            branch: expected.branch().into(),
        }
        .into());
    };
    let boundary = boundary.trim();
    if boundary == expected.commit() {
        return Ok(None);
    }
    let exclusion = format!("^{boundary}");
    let directory = tempfile::Builder::new()
        .prefix("terminalx-transfer-")
        .tempdir()?;
    let path = directory.path().join("workspace.bundle");
    let mut args = vec![
        "bundle",
        "create",
        path_argument(&path)?,
        &expected.branch_ref,
    ];
    args.push(&exclusion);
    git(repo, &args)?;
    check_head(repo, &path, expected)?;
    let size = std::fs::metadata(&path)?.len();
    Ok(Some(TransferBundle {
        _directory: directory,
        path,
        size,
    }))
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

#[cfg(any(feature = "desktop", test))]
#[derive(Debug, thiserror::Error)]
#[error("Fetch commit {commit} in your local clone before transferring {branch}.")]
pub(crate) struct MissingPrerequisite {
    pub(crate) commit: String,
    pub(crate) branch: String,
}

#[cfg(any(feature = "desktop", test))]
pub(crate) fn require_commit(repo: &Path, expected: &BranchCommit, commit: &str) -> Result<()> {
    ensure!(
        commit.len() == expected.commit().len()
            && commit.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "Invalid Git bundle prerequisite"
    );
    if git(repo, &["cat-file", "-e", &format!("{commit}^{{commit}}")]).is_err() {
        return Err(MissingPrerequisite {
            commit: commit.to_owned(),
            branch: expected.branch().to_owned(),
        }
        .into());
    }
    Ok(())
}

#[cfg(any(feature = "desktop", test))]
fn check_prerequisites(repo: &Path, bundle: &Path, expected: &BranchCommit) -> Result<Vec<String>> {
    use std::io::BufRead;
    let file = std::fs::File::open(bundle)?;
    let mut header = std::io::BufReader::new(file).take(64 * 1024);
    let mut line = Vec::new();
    header.read_until(b'\n', &mut line)?;
    ensure!(
        matches!(line.as_slice(), b"# v2 git bundle\n" | b"# v3 git bundle\n"),
        "Invalid Git bundle header"
    );
    let mut prerequisites = Vec::new();
    loop {
        line.clear();
        header.read_until(b'\n', &mut line)?;
        ensure!(
            line.ends_with(b"\n"),
            "The Git bundle header is incomplete or too large"
        );
        if line == b"\n" {
            ensure!(
                !prerequisites.is_empty(),
                "A transfer bundle must have an upstream prerequisite"
            );
            return Ok(prerequisites);
        }
        if let Some(prerequisite) = line.strip_prefix(b"-") {
            if prerequisites.len() >= 32 {
                return Err(TooManyPrerequisites.into());
            }
            let end = prerequisite
                .iter()
                .position(|byte| *byte == b' ')
                .context("Malformed bundle prerequisite")?;
            let commit = std::str::from_utf8(&prerequisite[..end])?;
            require_commit(repo, expected, commit)?;
            prerequisites.push(commit.to_owned());
        }
    }
}

#[cfg(any(feature = "desktop", test))]
#[derive(Debug, thiserror::Error)]
#[error("This Git bundle has more than 32 upstream prerequisites and cannot be transferred.")]
pub(crate) struct TooManyPrerequisites;

#[cfg(any(feature = "desktop", test))]
fn strict_fetch(repo: &Path, bundle: &Path, expected: &BranchCommit) -> Result<()> {
    let bundle = path_argument(bundle)?;
    git(
        repo,
        &[
            "-c",
            "fetch.fsckObjects=true",
            "-c",
            "transfer.fsckObjects=true",
            "-c",
            "fetch.unpackLimit=1",
            "fetch",
            "--no-write-fetch-head",
            "--no-tags",
            "--no-auto-maintenance",
            "--no-recurse-submodules",
            bundle,
            &expected.branch_ref,
        ],
    )?;
    require_commit(repo, expected, expected.commit())
}

#[cfg(any(feature = "desktop", test))]
pub(crate) struct ValidatedBundle<'a> {
    _quarantine: tempfile::TempDir,
    path: PathBuf,
    expected: &'a BranchCommit,
}

#[cfg(any(feature = "desktop", test))]
impl ValidatedBundle<'_> {
    pub(crate) fn promote(&self, destination: &Path) -> Result<()> {
        strict_fetch(destination, &self.path, self.expected)
    }
}

/// Validate the caller's private bundle snapshot before adding any objects
/// to the target repository. The alternates link is used only for reads.
#[cfg(any(feature = "desktop", test))]
pub(crate) fn validate_bundle<'a>(
    repo: &Path,
    bundle: &Path,
    expected: &'a BranchCommit,
) -> Result<ValidatedBundle<'a>> {
    let prerequisites = check_prerequisites(repo, bundle, expected)?;
    check_head(repo, bundle, expected)?;
    let format = if expected.commit().len() == 64 {
        "sha256"
    } else {
        "sha1"
    };
    let quarantine = tempfile::tempdir()?;
    git(
        quarantine.path(),
        &["init", "--bare", &format!("--object-format={format}")],
    )?;
    let raw = git(
        repo,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "objects",
        ],
    )?;
    let objects = crate::paths::canonicalize(raw.trim_end_matches(['\r', '\n']))?;
    let alternate = path_argument(&objects)?;
    ensure!(
        !alternate.contains(['\r', '\n']),
        "Unsupported Git object directory path"
    );
    std::fs::write(
        quarantine.path().join("objects/info/alternates"),
        format!("{alternate}\n"),
    )?;
    git(
        quarantine.path(),
        &["bundle", "verify", path_argument(bundle)?],
    )?;
    strict_fetch(quarantine.path(), bundle, expected)?;
    validate_checkout(quarantine.path(), expected)?;
    // Repack only the history reachable from the selected branch. Promoting
    // the original pack would also retain unrelated objects supplied with it.
    git(
        quarantine.path(),
        &["update-ref", &expected.branch_ref, expected.commit()],
    )?;
    let path = quarantine.path().join("validated.bundle");
    let exclusions: Vec<_> = prerequisites
        .iter()
        .map(|commit| format!("^{commit}"))
        .collect();
    let mut args = vec![
        "bundle",
        "create",
        path_argument(&path)?,
        &expected.branch_ref,
    ];
    args.extend(exclusions.iter().map(String::as_str));
    git(quarantine.path(), &args)?;
    ensure!(
        path.metadata()?.len() <= MAX_BUNDLE_BYTES,
        "The validated Git bundle is too large to transfer"
    );
    check_head(quarantine.path(), &path, expected)?;
    Ok(ValidatedBundle {
        _quarantine: quarantine,
        path,
        expected,
    })
}

#[cfg(test)]
fn import_objects(repo: &Path, bundle: &Path, expected: &BranchCommit) -> Result<()> {
    validate_bundle(repo, bundle, expected)?.promote(repo)
}

/// Bound the contents Git will materialize before creating a worktree.
#[cfg(any(feature = "desktop", test))]
pub(crate) fn validate_checkout(repo: &Path, expected: &BranchCommit) -> Result<()> {
    let args = ["ls-tree", "-r", "-l", "-z", expected.commit()];
    let command = git_command(repo, &args);
    let listing = crate::git::output_with_limit(command, &args, BUNDLE_TIMEOUT, 16 * 1024 * 1024)
        .map_err(|error| anyhow::anyhow!("transfer tree: {error}"))?;
    let links = validate_listing(&listing, MAX_CHECKOUT_BYTES, MAX_CHECKOUT_ENTRIES)?;
    validate_links(repo, links)
}

#[cfg(any(feature = "desktop", test))]
fn validate_listing(
    listing: &str,
    max_bytes: u64,
    max_entries: usize,
) -> Result<Vec<(&str, &str, usize)>> {
    let mut links = Vec::new();
    let mut size = 0u64;
    for (index, record) in listing.split_terminator('\0').enumerate() {
        ensure!(
            index < max_entries,
            "The Git checkout has too many entries to transfer"
        );
        let (metadata, path) = record.split_once('\t').context("Invalid Git tree entry")?;
        ensure!(
            path.len() <= 1024
                && path
                    .split('/')
                    .all(|part| !part.is_empty() && part.len() <= 255),
            "A Git checkout path is too long to transfer"
        );
        let mut fields = metadata.split_whitespace();
        let mode = fields.next().context("Missing Git tree mode")?;
        let object = fields.next().context("Missing Git tree object type")?;
        let oid = fields.next().context("Missing Git tree object ID")?;
        let bytes = fields.next().context("Missing Git tree object size")?;
        match (mode, object) {
            ("100644" | "100755" | "120000", "blob") => {
                let bytes: usize = bytes.parse()?;
                size = size
                    .checked_add(bytes as u64)
                    .context("The Git checkout is too large to transfer")?;
                ensure!(
                    size <= max_bytes,
                    "The Git checkout is too large to transfer"
                );
                if mode == "120000" {
                    ensure!(
                        links.len() < 256
                            && bytes <= 1024
                            && matches!(oid.len(), 40 | 64)
                            && oid.bytes().all(|byte| byte.is_ascii_hexdigit()),
                        "Too many or oversized symbolic links to transfer"
                    );
                    ensure!(
                        portable_link_path(path),
                        "A symbolic link has an unsupported path"
                    );
                    links.push((path, oid, bytes));
                }
            }
            ("160000", "commit") => return Err(TransferSubmodules.into()),
            _ => bail!("Unsupported Git tree entry"),
        }
    }
    Ok(links)
}

#[cfg(any(feature = "desktop", test))]
#[derive(Debug, thiserror::Error)]
#[error("This checkout contains Git submodules. Transfer supports the main repository only.")]
pub(crate) struct TransferSubmodules;

#[cfg(any(feature = "desktop", test))]
fn portable_link_path(path: &str) -> bool {
    !path.is_empty()
        && path.is_ascii()
        && !path.starts_with('/')
        && !path
            .bytes()
            .any(|byte| byte.is_ascii_control() || matches!(byte, b'\\' | b':' | b'~'))
        && path.split('/').all(|part| {
            if matches!(part, "" | "." | "..") {
                return true;
            }
            let device = part
                .split('.')
                .next()
                .unwrap_or_default()
                .trim_end()
                .to_ascii_uppercase();
            let numbered = device
                .as_bytes()
                .get(3)
                .is_some_and(|digit| matches!(digit, b'1'..=b'9'))
                && device.len() == 4
                && (device.starts_with("COM") || device.starts_with("LPT"));
            !part.eq_ignore_ascii_case(".git")
                && !part.ends_with(['.', ' '])
                && !matches!(
                    device.as_str(),
                    "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
                )
                && !numbered
        })
}

#[cfg(any(feature = "desktop", test))]
fn validate_links(repo: &Path, links: Vec<(&str, &str, usize)>) -> Result<()> {
    if links.is_empty() {
        return Ok(());
    }
    let args = ["cat-file", "--batch"];
    let mut command = git_command(repo, &args);
    command.args(args);
    let mut input = Vec::new();
    for (_, oid, _) in &links {
        input.extend_from_slice(oid.as_bytes());
        input.push(b'\n');
    }
    let response = crate::git::output_feeding(command, input, BUNDLE_TIMEOUT)
        .map_err(|error| anyhow::anyhow!("Could not inspect symbolic links: {error}"))?;
    let mut rest = response.as_str();
    let mut targets = std::collections::HashMap::new();
    for (path, oid, size) in links {
        let (header, data) = rest
            .split_once('\n')
            .context("Missing symbolic link object")?;
        ensure!(
            header == format!("{oid} blob {size}"),
            "Invalid symbolic link object"
        );
        let target = data.get(..size).context("Invalid symbolic link target")?;
        ensure!(
            portable_link_path(target),
            "A symbolic link target must stay inside the worktree"
        );
        ensure!(
            targets.insert(path.to_ascii_lowercase(), target).is_none(),
            "Symbolic link paths differ only by case"
        );
        rest = data
            .get(size..)
            .and_then(|tail| tail.strip_prefix('\n'))
            .context("Invalid symbolic link record")?;
    }
    ensure!(rest.is_empty(), "Unexpected symbolic link records");
    for (link, target) in &targets {
        resolve_link(link, target, &targets)?;
    }
    Ok(())
}

#[cfg(any(feature = "desktop", test))]
fn resolve_link<'a>(
    link: &'a str,
    target: &'a str,
    targets: &'a std::collections::HashMap<String, &'a str>,
) -> Result<()> {
    use std::collections::VecDeque;
    let mut stack: Vec<_> = link.split('/').collect();
    stack.pop();
    let mut pending: VecDeque<_> = target.split('/').collect();
    let mut followed = 0;
    while let Some(component) = pending.pop_front() {
        match component {
            "" | "." => {}
            ".." => {
                ensure!(
                    stack.pop().is_some(),
                    "A symbolic link target escapes the worktree"
                );
            }
            name => {
                stack.push(name);
                if let Some(target) = targets.get(&stack.join("/").to_ascii_lowercase()) {
                    followed += 1;
                    ensure!(followed <= 40, "Symbolic link chain is cyclic or too deep");
                    stack.pop();
                    for part in target.rsplit('/') {
                        pending.push_front(part);
                    }
                }
            }
        }
    }
    Ok(())
}

/// Install the pinned commit only after the caller has verified the imported
/// transcript and selected the destination. A concurrent branch creation
/// wins. An existing matching branch can be used on retry.
pub(crate) fn ensure_local_branch(repo: &Path, expected: &BranchCommit) -> Result<bool> {
    let commit = format!("{}^{{commit}}", expected.commit);
    let resolved = git(repo, &["rev-parse", "--verify", &commit])?;
    ensure!(
        resolved.trim() == expected.commit,
        "transfer object is not the pinned commit"
    );

    let absent = "0".repeat(expected.commit.len());
    let create = git(
        repo,
        &[
            "update-ref",
            &expected.branch_ref,
            &expected.commit,
            &absent,
        ],
    );
    if create.is_ok() {
        return Ok(true);
    }

    let existing = git(repo, &["rev-parse", "--verify", &expected.branch_ref]);
    if existing
        .as_ref()
        .is_ok_and(|head| head.trim() == expected.commit)
    {
        return Ok(false);
    }
    if existing.is_ok() {
        bail!("a local branch with this name already points to a different commit");
    }
    create.map(|_| true)
}

#[cfg(feature = "desktop")]
pub(crate) fn choose_local_branch(
    repo: &Path,
    expected: &BranchCommit,
    worktree_name: &str,
) -> Result<BranchCommit> {
    let attached = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(worktreepath)",
            &expected.branch_ref,
        ],
    )?;
    if attached.trim().is_empty() {
        Ok(expected.clone())
    } else {
        BranchCommit::new(worktree_name, expected.commit())
    }
}

#[cfg(feature = "desktop")]
pub(crate) fn checkout(repo: &Path, path: &Path, expected: &BranchCommit) -> Result<()> {
    ensure!(!path.exists(), "Transfer checkout path already exists");
    std::fs::create_dir_all(path.parent().context("No worktree directory")?)?;
    git(
        repo,
        &[
            "-c",
            "core.hooksPath=/dev/null",
            "worktree",
            "add",
            "--no-checkout",
            path_argument(path)?,
            expected.branch(),
        ],
    )?;
    let populate = (|| {
        let actual = git(path, &["rev-parse", "--verify", "HEAD"])?;
        ensure!(
            actual.trim() == expected.commit(),
            "The local branch moved during checkout"
        );
        let keys = git(path, &["config", "--name-only", "--null", "--list"])?;
        let mut filters: Vec<_> = keys
            .split_terminator('\0')
            .filter_map(|key| {
                let key = key.strip_prefix("filter.")?;
                let (driver, attribute) = key.rsplit_once('.')?;
                if !matches!(attribute, "smudge" | "process" | "required") {
                    return None;
                }
                Some(driver)
            })
            .collect();
        filters.sort_unstable();
        filters.dedup();
        let overrides: Vec<_> = filters
            .into_iter()
            .flat_map(|driver| {
                [
                    format!("filter.{driver}.smudge="),
                    format!("filter.{driver}.process="),
                    format!("filter.{driver}.required=false"),
                ]
            })
            .collect();
        let mut reset = vec!["-c", "core.hooksPath=/dev/null"];
        for option in &overrides {
            reset.extend(["-c", option.as_str()]);
        }
        reset.extend([
            "reset",
            "--hard",
            "--no-recurse-submodules",
            expected.commit(),
        ]);
        git(path, &reset)?;
        Ok(())
    })();
    if let Err(error) = populate {
        let cleanup = git(
            repo,
            &["worktree", "remove", "--force", path_argument(path)?],
        );
        return match cleanup {
            Ok(_) => Err(error),
            Err(cleanup) => Err(error.context(format!(
                "Could not remove the unfinished transfer checkout: {cleanup}"
            ))),
        };
    }
    Ok(())
}

#[cfg(feature = "desktop")]
pub(crate) fn rollback_branch(repo: &Path, expected: &BranchCommit) -> Result<()> {
    let attached = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(worktreepath)",
            &expected.branch_ref,
        ],
    )?;
    ensure!(
        attached.trim().is_empty(),
        "The transfer branch is checked out and was kept"
    );
    git(
        repo,
        &["update-ref", "-d", &expected.branch_ref, expected.commit()],
    )?;
    Ok(())
}

#[cfg(feature = "desktop")]
pub(crate) fn rollback_checkout(repo: &Path, path: &Path, expected: &BranchCommit) -> Result<()> {
    ensure!(
        crate::git::is_worktree_of(repo, path),
        "Transfer checkout ownership changed"
    );
    let actual = git(path, &["rev-parse", "--verify", "HEAD"])?;
    ensure!(
        actual.trim() == expected.commit(),
        "Transfer checkout has changed"
    );
    git(repo, &["worktree", "remove", path_argument(path)?])?;
    Ok(())
}

#[cfg(feature = "desktop")]
pub(crate) fn rollback_import_checkout(
    repo: &Path,
    path: &Path,
    pin: &BranchCommit,
    checkout_created: bool,
    branch_created: bool,
) -> Result<()> {
    if checkout_created {
        rollback_checkout(repo, path, pin)?;
    }
    if branch_created {
        ensure!(
            !path.exists(),
            "The unfinished checkout was kept with its branch."
        );
        rollback_branch(repo, pin)?;
    }
    Ok(())
}

#[derive(serde::Deserialize, serde::Serialize)]
// Transcript tags are lowercase. Message fields use the webview wire convention.
#[serde(
    tag = "role",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum TranscriptMessage {
    User { text: String },
    Assistant { text: String },
}

#[derive(Debug, thiserror::Error)]
#[error("This workspace is too large to transfer")]
pub(crate) struct TransferTooLarge;

#[derive(Default)]
struct TranscriptExport {
    bytes: Vec<u8>,
    assistant_seen: bool,
}

impl TranscriptExport {
    fn event(&mut self, event: &crate::events::AgentEvent, max_bytes: usize) -> Result<()> {
        use crate::events::Payload;
        let (text, user) = match &event.payload {
            Payload::UserMessage {
                text,
                queued: false,
                ..
            } => {
                self.assistant_seen = false;
                (text, true)
            }
            Payload::TurnStarted { .. } => {
                self.assistant_seen = false;
                return Ok(());
            }
            Payload::AssistantText { text, .. }
                if event.subagent.is_none() && !text.trim().is_empty() =>
            {
                self.assistant_seen = true;
                (text, false)
            }
            Payload::TurnCompleted {
                final_text: Some(text),
                ..
            } if !self.assistant_seen && event.subagent.is_none() => {
                self.assistant_seen = true;
                (text, false)
            }
            _ => return Ok(()),
        };
        let remaining = max_bytes.saturating_sub(self.bytes.len());
        if text.len() >= remaining {
            return Err(TransferTooLarge.into());
        }
        let message = if user {
            TranscriptMessage::User { text: text.clone() }
        } else {
            TranscriptMessage::Assistant { text: text.clone() }
        };
        let encoded = serde_json::to_vec(&message)?;
        if encoded.len().saturating_add(2) > remaining {
            return Err(TransferTooLarge.into());
        }
        self.bytes
            .push(if self.bytes.is_empty() { b'[' } else { b',' });
        self.bytes.extend_from_slice(&encoded);
        Ok(())
    }

    fn finish(mut self) -> Vec<u8> {
        if self.bytes.is_empty() {
            self.bytes.push(b'[');
        }
        self.bytes.push(b']');
        self.bytes
    }
}

pub(crate) fn transcript_file(path: &Path, max_bytes: usize) -> Result<Vec<u8>> {
    use std::io::BufRead;
    let mut export = TranscriptExport::default();
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(export.finish()),
        Err(error) => return Err(error.into()),
    };
    let mut reader = std::io::BufReader::new(file);
    let line_limit = max_bytes.max(1024 * 1024).saturating_mul(6);
    let mut line = Vec::new();
    loop {
        line.clear();
        if reader
            .by_ref()
            .take(line_limit as u64 + 1)
            .read_until(b'\n', &mut line)?
            == 0
        {
            break;
        }
        if line.len() > line_limit {
            return Err(TransferTooLarge.into());
        }
        if let Ok(event) = serde_json::from_slice::<crate::events::AgentEvent>(&line) {
            export.event(&event, max_bytes)?;
        }
    }
    Ok(export.finish())
}

#[cfg(feature = "desktop")]
pub(crate) fn save_transcript(
    session: &crate::store::index::SessionEntry,
    messages: Vec<TranscriptMessage>,
) -> Result<()> {
    use crate::events::AgentEvent;
    use serde_json::json;
    use std::io::Write;
    let tab = session.tabs.first().context("No local conversation")?;
    let mut log = Vec::new();
    let mut sequence = 0;
    let mut write_event = |payload| -> Result<()> {
        sequence += 1;
        let event: AgentEvent = serde_json::from_value(json!({
            "id": uuid::Uuid::new_v4().to_string(), "sessionId": session.id, "tabId": tab.id,
            "harness": tab.harness, "seq": sequence, "ts": session.created,
            "payload": payload,
        }))?;
        serde_json::to_writer(&mut log, &event)?;
        log.push(b'\n');
        Ok(())
    };
    let mut turn = false;
    for message in messages {
        match message {
            TranscriptMessage::User { text } => {
                if turn {
                    write_event(json!({ "type": "turn_completed", "status": "ok" }))?;
                }
                write_event(json!({ "type": "user_message", "text": text }))?;
            }
            TranscriptMessage::Assistant { text } => {
                write_event(json!({ "type": "assistant_text", "text": text }))?
            }
        }
        turn = true;
    }
    if turn {
        write_event(json!({ "type": "turn_completed", "status": "ok" }))?;
    }
    let path = crate::store::log_path(&session.id, &tab.id)?;
    let mut staged =
        tempfile::NamedTempFile::new_in(path.parent().context("No transcript directory")?)?;
    staged.write_all(&log)?;
    staged.as_file().sync_all()?;
    staged
        .persist_noclobber(path)
        .context("The local conversation already has a transcript")?;
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

    fn mark_upstream(repo: &Path, commit: &str) {
        git(repo, &["update-ref", "refs/remotes/origin/main", commit]).unwrap();
        git(
            repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        )
        .unwrap();
    }

    #[test]
    fn an_unpublished_branch_without_a_base_returns_a_typed_refusal() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        repository(&cloud);
        for _ in 0..3 {
            let pin = BranchCommit::new("main", &commit(&cloud)).unwrap();
            assert!(export(&cloud, &pin).err().unwrap().is::<NoTransferBase>());
        }
        assert!(BranchCommit::new("refs/heads/main", &"a".repeat(40)).is_err());
        let bad_namespace = BranchCommit::new("origin/topic", &"a".repeat(40)).unwrap();
        assert!(check_branch_namespace(&cloud, &bad_namespace).is_err());
        git(&cloud, &["remote", "add", "team/fork", "unused"]).unwrap();
        let nested = BranchCommit::new("Team/Fork/topic", &"a".repeat(40)).unwrap();
        assert!(check_branch_namespace(&cloud, &nested).is_err());
    }

    #[test]
    fn exports_from_a_cached_base_and_imports_objects_without_moving_a_local_ref() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&cloud);
        let base = commit(&cloud);
        mark_upstream(&cloud, &base);
        git(
            temp.path(),
            &[
                "clone",
                "-q",
                cloud.to_str().unwrap(),
                local.to_str().unwrap(),
            ],
        )
        .unwrap();
        git(&cloud, &["switch", "-c", "topic/one"]).unwrap();
        let source = BranchCommit::new("topic/one", &commit(&cloud)).unwrap();
        let local_head = git(&local, &["rev-parse", "HEAD"])
            .unwrap()
            .trim()
            .to_owned();
        let bundle = export(&cloud, &source).unwrap().unwrap();
        let mut received = Vec::new();
        while (received.len() as u64) < bundle.size() {
            let bytes = bundle.read_chunk(received.len() as u64).unwrap();
            assert!(!bytes.is_empty());
            assert!(bytes.len() as u64 <= CHUNK_BYTES);
            received.extend(bytes);
        }
        assert!(bundle.read_chunk(bundle.size()).unwrap().is_empty());
        assert!(bundle.read_chunk(bundle.size() + 1).is_err());
        let incoming = temp.path().join("incoming.bundle");
        std::fs::write(&incoming, received).unwrap();
        import_objects(&local, &incoming, &source).unwrap();
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

    #[cfg(feature = "desktop")]
    #[test]
    fn refuses_an_oversized_or_overpopulated_checkout() {
        let listing = "100644 blob abcd 8\tsource\0".repeat(2);
        assert!(validate_listing(&listing, 16, 2).is_ok());
        assert!(validate_listing(&listing, 15, 2).is_err());
        assert!(validate_listing(&listing, 16, 1).is_err());
        assert!(validate_listing("invalid\0", 16, 1).is_err());
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn rolls_back_a_new_checkout_and_ref_and_preserves_changes() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        let path = temp.path().join("transferred");
        repository(&local);
        let head = commit(&local);
        let selected = BranchCommit::new("topic", &head).unwrap();
        assert!(ensure_local_branch(&local, &selected).unwrap());
        checkout(&local, &path, &selected).unwrap();
        std::fs::write(path.join("other-work"), b"user data").unwrap();
        assert!(rollback_checkout(&local, &path, &selected).is_err());
        assert!(rollback_branch(&local, &selected).is_err());
        std::fs::remove_file(path.join("other-work")).unwrap();
        rollback_checkout(&local, &path, &selected).unwrap();
        rollback_branch(&local, &selected).unwrap();
        assert!(!path.exists());
        assert!(git(&local, &["rev-parse", "--verify", "refs/heads/topic"]).is_err());
        assert_eq!(git(&local, &["rev-parse", "HEAD"]).unwrap().trim(), head);
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn import_rollback_keeps_a_preexisting_branch() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("local");
        repository(&repo);
        let head = commit(&repo);
        git(&repo, &["branch", "preexisting"]).unwrap();
        let pin = BranchCommit::new("preexisting", &head).unwrap();
        let branch_created = ensure_local_branch(&repo, &pin).unwrap();
        assert!(!branch_created);
        let path = temp.path().join("failed-import");
        checkout(&repo, &path, &pin).unwrap();
        rollback_import_checkout(&repo, &path, &pin, true, branch_created).unwrap();
        assert!(!path.exists());
        assert_eq!(
            git(&repo, &["rev-parse", "preexisting"]).unwrap().trim(),
            head
        );
    }

    #[test]
    fn counts_only_exported_transcript_text() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("transcript.jsonl");
        let event = |payload| {
            serde_json::json!({
                "id": "event", "sessionId": "session", "tabId": "tab", "harness": "claude",
                "seq": 1, "ts": "2026-11-25T00:00:00Z", "payload": payload,
            })
        };
        let hidden = event(serde_json::json!({ "type": "reasoning", "text": "x".repeat(5000) }));
        let visible = event(serde_json::json!({ "type": "assistant_text", "text": "Answer" }));
        let mut bytes = vec![0xff, b'\n'];
        bytes.extend(format!("{hidden}\n{visible}\n").into_bytes());
        std::fs::write(&log, bytes).unwrap();
        let text = transcript_file(&log, 64).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&text).unwrap(),
            serde_json::json!([
                {"role":"assistant","text":"Answer"}
            ])
        );
        assert!(transcript_file(&log, 8)
            .unwrap_err()
            .is::<TransferTooLarge>());
    }

    #[test]
    fn an_actual_tree_counts_unpacked_blob_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        repository(&repo);
        std::fs::write(repo.join("compressible"), vec![b'x'; 8192]).unwrap();
        git(&repo, &["add", "--all"]).unwrap();
        let commit = commit(&repo);
        let listing = git(&repo, &["ls-tree", "-r", "-l", "-z", &commit]).unwrap();
        assert!(validate_listing(&listing, 8192, 1).is_ok());
        assert!(validate_listing(&listing, 8191, 1).is_err());
    }

    #[test]
    fn prerequisite_limit_has_a_typed_error() {
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        repository(&repo);
        let base = commit(&repo);
        let pinned = BranchCommit::new("main", &base).unwrap();
        let bundle = temp.path().join("overscoped.bundle");
        std::fs::write(
            &bundle,
            format!(
                "# v2 git bundle\n{}\n",
                format!("-{base} prerequisite\n").repeat(33)
            ),
        )
        .unwrap();
        let error = check_prerequisites(&repo, &bundle, &pinned).unwrap_err();
        assert!(error.is::<TooManyPrerequisites>());
    }

    #[test]
    fn an_oversized_record_cannot_be_silently_omitted() {
        use std::io::Write;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("transcript");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(br#"{ "payload": { "type" : "assistant_text", "text": ""#)
            .unwrap();
        file.set_len(6 * 1024 * 1024 + 10).unwrap();
        assert!(transcript_file(&path, 64)
            .unwrap_err()
            .is::<TransferTooLarge>());
    }

    #[test]
    fn promotion_drops_objects_unreachable_from_the_selected_commit() {
        use std::io::Write;
        use std::process::Stdio;

        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&cloud);
        let base = commit(&cloud);
        git(
            temp.path(),
            &[
                "clone",
                "-q",
                cloud.to_str().unwrap(),
                local.to_str().unwrap(),
            ],
        )
        .unwrap();
        let pinned = commit(&cloud);
        let file = cloud.join("unrelated");
        std::fs::write(&file, b"This object does not belong to the transfer").unwrap();
        let unrelated = git(&cloud, &["hash-object", "-w", file.to_str().unwrap()]).unwrap();
        let unrelated = unrelated.trim();

        let mut pack = git_command(&cloud, &["pack-objects"]);
        let mut pack = pack
            .args(["pack-objects", "--stdout", "--revs"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        writeln!(pack.stdin.take().unwrap(), "{pinned}\n^{base}\n{unrelated}").unwrap();
        let result = pack.wait_with_output().unwrap();
        assert!(result.status.success());
        let path = temp.path().join("with-unrelated.bundle");
        let mut bytes =
            format!("# v2 git bundle\n-{base} base\n{pinned} refs/heads/main\n\n").into_bytes();
        bytes.extend(result.stdout);
        std::fs::write(&path, bytes).unwrap();

        let expected = BranchCommit::new("main", &pinned).unwrap();
        let refs = git(&local, &["show-ref"]).unwrap();
        import_objects(&local, &path, &expected).unwrap();
        assert_eq!(git(&local, &["show-ref"]).unwrap(), refs);
        assert!(git(&local, &["cat-file", "-e", &pinned]).is_ok());
        assert!(git(&local, &["cat-file", "-e", unrelated]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn accepts_in_tree_symbolic_links_and_refuses_composed_escapes() {
        assert!(!portable_link_path("nested/COM1.txt"));
        assert!(!portable_link_path("nested/NUL"));
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        repository(&repo);
        std::fs::create_dir(repo.join("nested")).unwrap();
        std::fs::write(repo.join("inside"), b"text").unwrap();
        std::os::unix::fs::symlink("../inside", repo.join("nested/relative")).unwrap();
        std::os::unix::fs::symlink("nested/relative", repo.join("chain")).unwrap();
        std::os::unix::fs::symlink(".", repo.join("root-alias")).unwrap();
        git(&repo, &["add", "--all"]).unwrap();
        let pin = BranchCommit::new("main", &commit(&repo)).unwrap();
        validate_checkout(&repo, &pin).unwrap();
        std::os::unix::fs::symlink("root-alias/../outside", repo.join("escape")).unwrap();
        git(&repo, &["add", "--all"]).unwrap();
        let pin = BranchCommit::new("main", &commit(&repo)).unwrap();
        let error = validate_checkout(&repo, &pin).unwrap_err();
        assert!(
            error.to_string().contains("escapes the worktree"),
            "{error:#}"
        );
    }

    #[test]
    fn a_rejected_gitlink_or_multi_head_bundle_leaves_the_destination_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&cloud);
        let base = commit(&cloud);
        let root = BranchCommit::new("main", &base).unwrap();
        assert!(export(&cloud, &root).err().unwrap().is::<NoTransferBase>());
        mark_upstream(&cloud, &base);
        git(
            temp.path(),
            &[
                "clone",
                "-q",
                cloud.to_str().unwrap(),
                local.to_str().unwrap(),
            ],
        )
        .unwrap();
        git(
            &cloud,
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("160000,{base},outside"),
            ],
        )
        .unwrap();
        let head = commit(&cloud);
        let pin = BranchCommit::new("main", &head).unwrap();
        let bundle = export(&cloud, &pin).unwrap().unwrap();
        let objects_before = git(&local, &["count-objects", "-v"]).unwrap();
        let refs_before = git(&local, &["show-ref"]).unwrap();
        let error = validate_bundle(&local, &bundle.path, &pin).err().unwrap();
        assert!(error.to_string().contains("submodules"), "{error:#}");
        assert_eq!(
            git(&local, &["count-objects", "-v"]).unwrap(),
            objects_before
        );
        assert_eq!(git(&local, &["show-ref"]).unwrap(), refs_before);
        assert!(git(&local, &["cat-file", "-e", &head]).is_err());

        git(&cloud, &["branch", "second"]).unwrap();
        let multi = temp.path().join("multi.bundle");
        git(
            &cloud,
            &[
                "bundle",
                "create",
                multi.to_str().unwrap(),
                "main",
                "second",
                &format!("^{base}"),
            ],
        )
        .unwrap();
        assert!(validate_bundle(&local, &multi, &pin).is_err());
        assert_eq!(
            git(&local, &["count-objects", "-v"]).unwrap(),
            objects_before
        );
        assert_eq!(git(&local, &["show-ref"]).unwrap(), refs_before);
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn retry_uses_a_new_branch_and_keeps_the_original_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        repository(&project);
        let head = commit(&project);
        let original = BranchCommit::new("main", &head).unwrap();
        let retry = choose_local_branch(&project, &original, "transfer-retry").unwrap();
        assert_eq!(retry.branch(), "transfer-retry");
        assert!(ensure_local_branch(&project, &retry).unwrap());
        let checkout_path = dir.path().join("retry");
        checkout(&project, &checkout_path, &retry).unwrap();
        rollback_checkout(&project, &checkout_path, &retry).unwrap();
        rollback_branch(&project, &retry).unwrap();
        assert_eq!(
            git(&project, &["rev-parse", "refs/heads/main"])
                .unwrap()
                .trim(),
            head
        );
        assert!(git(
            &project,
            &["rev-parse", "--verify", "refs/heads/transfer-retry"]
        )
        .is_err());
    }

    #[test]
    fn exports_an_origin_delta_without_updating_the_remote_branch() {
        let temp = tempfile::tempdir().unwrap();
        let origin = temp.path().join("origin");
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&origin);
        let base = commit(&origin);
        let source = origin.to_str().unwrap();
        for checkout in [&cloud, &local] {
            git(
                temp.path(),
                &["clone", "-q", source, checkout.to_str().unwrap()],
            )
            .unwrap();
            git(checkout, &["config", "user.name", "Fixture"]).unwrap();
            git(checkout, &["config", "user.email", "fixture@example.test"]).unwrap();
        }
        let up_to_date = BranchCommit::new("main", &base).unwrap();
        assert!(export(&cloud, &up_to_date).unwrap().is_none());
        let head = commit(&cloud);
        let selected = BranchCommit::new("main", &head).unwrap();
        let bundle = export(&cloud, &selected).unwrap().unwrap();
        assert_eq!(git(&origin, &["rev-parse", "main"]).unwrap().trim(), base);
        import_objects(&local, &bundle.path, &selected).unwrap();
        assert_eq!(git(&local, &["rev-parse", "main"]).unwrap().trim(), base);
        let missing_base = temp.path().join("missing-base");
        repository(&missing_base);
        let error = validate_bundle(&missing_base, &bundle.path, &selected)
            .err()
            .unwrap();
        let missing = error.downcast_ref::<MissingPrerequisite>().unwrap();
        assert_eq!(missing.commit, base);
        assert_eq!(missing.branch, "main");
    }

    #[test]
    fn creates_only_the_pinned_local_branch_and_refuses_to_replace_it() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        repository(&local);
        let first = commit(&local);
        let second = commit(&local);
        let selected = BranchCommit::new("topic", &first).unwrap();
        assert!(ensure_local_branch(&local, &selected).unwrap());
        assert!(!ensure_local_branch(&local, &selected).unwrap());
        let conflicting = BranchCommit::new("topic", &second).unwrap();
        assert!(ensure_local_branch(&local, &conflicting).is_err());
        assert_eq!(git(&local, &["rev-parse", "topic"]).unwrap().trim(), first);
        assert_eq!(git(&local, &["rev-parse", "HEAD"]).unwrap().trim(), second);
    }

    #[test]
    fn bounds_each_chunk_and_rejects_a_changed_snapshot_length() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workspace.bundle");
        let mut bytes = vec![1; CHUNK_BYTES as usize];
        bytes.extend_from_slice(&[2, 3]);
        std::fs::write(&path, &bytes).unwrap();
        let bundle = TransferBundle {
            _directory: directory,
            path,
            size: bytes.len() as u64,
        };
        assert_eq!(
            bundle.read_chunk(0).unwrap(),
            &bytes[..CHUNK_BYTES as usize]
        );
        assert_eq!(bundle.read_chunk(CHUNK_BYTES).unwrap(), [2, 3]);
        std::fs::write(&bundle.path, [0]).unwrap();
        assert!(bundle.read_chunk(0).is_err());
    }

    #[test]
    fn refuses_a_moved_branch_and_an_unexpected_bundle_head() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&cloud);
        repository(&local);
        let base = commit(&cloud);
        mark_upstream(&cloud, &base);
        let initial = BranchCommit::new("main", &commit(&cloud)).unwrap();
        let bundle = export(&cloud, &initial).unwrap().unwrap();
        let moved = BranchCommit::new("main", &commit(&cloud)).unwrap();
        assert!(export(&cloud, &initial).is_err());
        assert!(import_objects(&local, &bundle.path, &moved).is_err());
        assert!(git(&local, &["cat-file", "-e", &initial.commit]).is_err());
    }
}
