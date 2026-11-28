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
                && !branch.split_once('/').is_some_and(|(prefix, _)| [
                    "refs", "remotes", "tags", "heads"
                ]
                .iter()
                .any(|reserved| prefix.eq_ignore_ascii_case(reserved))),
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
    let boundary = upstream_base(repo, expected);
    let exclusion = match &boundary {
        Some(boundary) if boundary == expected.commit() => return Ok(None),
        Some(boundary) => Some(format!("^{boundary}")),
        None => {
            // No remote base: the whole history moves as a root bundle. Its
            // size is bounded before Git writes anything.
            let usage = git(
                repo,
                &["rev-list", "--objects", "--disk-usage", &expected.branch_ref],
            )?;
            let bytes: u64 = usage.trim().parse().context("Invalid Git size estimate")?;
            if bytes > MAX_BUNDLE_BYTES {
                return Err(TransferTooLarge.into());
            }
            None
        }
    };
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
    args.extend(exclusion.as_deref());
    git(repo, &args)?;
    check_head(repo, &path, expected)?;
    let size = std::fs::metadata(&path)?.len();
    // The estimate bounds the work; the written file is what is sent.
    if size > MAX_BUNDLE_BYTES {
        return Err(TransferTooLarge.into());
    }
    Ok(Some(TransferBundle {
        _directory: directory,
        path,
        size,
    }))
}

/// The commit the branch shares with its upstream or the remote's default
/// branch. None when the checkout has no remote base at all.
fn upstream_base(repo: &Path, expected: &BranchCommit) -> Option<String> {
    let upstream = format!("{}@{{upstream}}", expected.branch());
    let boundary = [upstream.as_str(), "refs/remotes/origin/HEAD"]
        .into_iter()
        .find_map(|reference| git(repo, &["merge-base", expected.commit(), reference]).ok())?;
    Some(boundary.trim().to_owned())
}

/// What the move dialog shows before anything is exported.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct TransferPreview {
    /// Commits that move: those after the remote base, or the whole history.
    pub(crate) commits: u64,
    /// The branch has a remote base; without one it moves as a root bundle.
    pub(crate) has_remote_base: bool,
    /// Changed and untracked paths that stay in the cloud.
    pub(crate) uncommitted_files: u64,
}

pub(crate) fn preview(repo: &Path, expected: &BranchCommit) -> Result<TransferPreview> {
    let boundary = upstream_base(repo, expected);
    let range = match &boundary {
        Some(boundary) => format!("{boundary}..{}", expected.commit()),
        None => expected.commit().to_owned(),
    };
    let commits = git(repo, &["rev-list", "--count", &range])?
        .trim()
        .parse()
        .context("Invalid commit count")?;
    let status = git(
        repo,
        &["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"],
    )?;
    let uncommitted_files = status.split('\0').filter(|entry| !entry.is_empty()).count() as u64;
    Ok(TransferPreview {
        commits,
        has_remote_base: boundary.is_some(),
        uncommitted_files,
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
            // No prerequisites: a repository without a remote moves its whole
            // history. Only objects the destination lacks are promoted.
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
    path: Option<PathBuf>,
    expected: &'a BranchCommit,
}

#[cfg(any(feature = "desktop", test))]
impl ValidatedBundle<'_> {
    pub(crate) fn promote(&self, destination: &Path) -> Result<()> {
        match &self.path {
            Some(path) => strict_fetch(destination, path, self.expected),
            None => require_commit(destination, self.expected, self.expected.commit()),
        }
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
    for prerequisite in &prerequisites {
        ensure!(
            prerequisite != expected.commit()
                && git(
                    quarantine.path(),
                    &[
                        "merge-base",
                        "--is-ancestor",
                        prerequisite,
                        expected.commit()
                    ]
                )
                .is_ok(),
            "A Git bundle prerequisite is not an ancestor of the selected commit"
        );
    }
    validate_checkout(quarantine.path(), expected)?;
    let path = repack_validated(
        repo,
        quarantine.path(),
        expected,
        &prerequisites,
        MAX_BUNDLE_BYTES,
    )?;
    Ok(ValidatedBundle {
        _quarantine: quarantine,
        path,
        expected,
    })
}

/// Use the same revision set for the size preflight and the resulting pack.
#[cfg(any(feature = "desktop", test))]
fn repack_validated(
    repo: &Path,
    quarantine: &Path,
    expected: &BranchCommit,
    prerequisites: &[String],
    limit: u64,
) -> Result<Option<PathBuf>> {
    let refs = git(
        repo,
        &[
            "for-each-ref",
            "--format=%(objectname) %(*objectname)",
            "refs/heads",
            "refs/remotes",
            "refs/tags",
        ],
    )?;
    let mut exclusions = std::collections::BTreeSet::new();
    for oid in prerequisites
        .iter()
        .map(String::as_str)
        .chain(refs.split_whitespace())
    {
        ensure!(
            oid.len() == expected.commit().len()
                && oid.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Invalid destination ref object ID"
        );
        exclusions.insert(oid);
    }
    git(
        quarantine,
        &["update-ref", &expected.branch_ref, expected.commit()],
    )?;
    let mut revisions = format!("{}\n", expected.branch_ref).into_bytes();
    for excluded in exclusions {
        revisions.push(b'^');
        revisions.extend_from_slice(excluded.as_bytes());
        revisions.push(b'\n');
    }

    let usage_args = ["rev-list", "--objects", "--disk-usage", "--stdin"];
    let mut estimate = git_command(quarantine, &usage_args);
    estimate.args(usage_args);
    let usage = crate::git::output_feeding(estimate, revisions.clone(), BUNDLE_TIMEOUT)
        .map_err(|error| anyhow::anyhow!("Could not estimate Git bundle size: {error}"))?;
    let bytes: u64 = usage
        .trim()
        .parse()
        .context("Invalid Git bundle size estimate")?;
    ensure!(
        bytes <= limit,
        "The validated Git bundle is too large to transfer"
    );
    if bytes == 0 {
        require_commit(repo, expected, expected.commit())?;
        return Ok(None);
    }

    let path = quarantine.join("validated.bundle");
    let args = ["bundle", "create", path_argument(&path)?, "--stdin"];
    let mut repack = git_command(quarantine, &args);
    repack.args(args);
    crate::git::output_feeding(repack, revisions, BUNDLE_TIMEOUT)
        .map_err(|error| anyhow::anyhow!("Could not create the validated Git bundle: {error}"))?;
    ensure!(
        path.metadata()?.len() <= limit,
        "The validated Git bundle is too large to transfer"
    );
    check_head(quarantine, &path, expected)?;
    Ok(Some(path))
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
                        links.len() < 256,
                        "Transfer supports at most 256 symbolic links in one checkout"
                    );
                    ensure!(
                        bytes <= 1024,
                        "A symbolic link target exceeds the 1024-byte transfer limit"
                    );
                    ensure!(
                        matches!(oid.len(), 40 | 64)
                            && oid.bytes().all(|byte| byte.is_ascii_hexdigit()),
                        "Invalid symbolic link object ID"
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
        && !path.starts_with('/')
        && !path.chars().any(|character| {
            character.is_control()
                || matches!(character,
                '\\' | ':' | '~' | '\u{061c}' | '\u{200b}'..='\u{200f}'
                | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
        })
        && path.split('/').all(|part| {
            if matches!(part, "" | "." | "..") {
                return true;
            }
            let folded = crate::mirror_rules::fold(part);
            let device = folded
                .split('.')
                .next()
                .unwrap_or_default()
                .trim_end()
                .to_ascii_uppercase();
            let numbered = device
                .strip_prefix("COM")
                .or_else(|| device.strip_prefix("LPT"))
                .is_some_and(|number| {
                    matches!(
                        number,
                        "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                    )
                });
            folded != ".git"
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
    let response = crate::git::output_utf8_feeding(command, input, BUNDLE_TIMEOUT)
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
            targets
                .insert(crate::mirror_rules::fold(path), target)
                .is_none(),
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
                if let Some(target) = targets.get(&crate::mirror_rules::fold(&stack.join("/"))) {
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
    // A repository whose own HEAD is the unborn branch of this name (a fresh
    // `git init`) holds it too, though no ref exists yet.
    let unborn_head = git(repo, &["symbolic-ref", "--quiet", "HEAD"])
        .is_ok_and(|head| head.trim() == expected.branch_ref);
    if attached.trim().is_empty() && !unborn_head {
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
/// Names macOS leaves in a folder that is otherwise empty.
#[cfg(any(feature = "desktop", test))]
const FOLDER_LITTER: [&str; 1] = [".DS_Store"];

/// Whether `path` is a folder with nothing in it but Finder's own litter.
#[cfg(any(feature = "desktop", test))]
pub(crate) fn is_empty_folder(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok_and(|entries| {
        entries.filter_map(|entry| entry.ok()).all(|entry| {
            FOLDER_LITTER.iter().any(|name| entry.file_name() == *name)
        })
    })
}

/// The unborn branch a new destination repository starts on. Every real
/// branch, the moved one included, is then free for a worktree: starting on
/// the moved branch's own name (Git's default `main`) would leave it held by
/// the folder itself.
#[cfg(any(feature = "desktop", test))]
const EMPTY_FOLDER_BRANCH: &str = "terminalx-empty";

/// Make an empty folder a repository that can receive a whole-history move.
#[cfg(any(feature = "desktop", test))]
pub(crate) fn init_empty_destination(path: &Path, expected: &BranchCommit) -> Result<()> {
    ensure!(is_empty_folder(path), "The folder is not empty");
    let format = if expected.commit().len() == 64 {
        "--object-format=sha256"
    } else {
        "--object-format=sha1"
    };
    let initial = format!("--initial-branch={EMPTY_FOLDER_BRANCH}");
    git(path, &["init", "-q", format, &initial])?;
    Ok(())
}

/// Undo `init_empty_destination` after a failed first move: remove the
/// repository and the worktree folders it left (folders holding only
/// folders), so the folder is as it was. If any file appeared meanwhile,
/// everything is kept.
#[cfg(any(feature = "desktop", test))]
pub(crate) fn discard_empty_destination(path: &Path) -> Result<()> {
    fn only_directories(path: &Path) -> bool {
        std::fs::read_dir(path).is_ok_and(|entries| {
            entries.filter_map(|entry| entry.ok()).all(|entry| {
                entry.file_type().is_ok_and(|kind| kind.is_dir()) && only_directories(&entry.path())
            })
        })
    }
    let mut created = Vec::new();
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name();
        if FOLDER_LITTER.iter().any(|litter| name == *litter) {
            continue;
        }
        let directory = entry.file_type()?.is_dir();
        ensure!(
            name == ".git" || (directory && only_directories(&entry.path())),
            "The folder gained other files and was kept as a repository."
        );
        created.push(entry.path());
    }
    // The repository last, so a partial removal still reads as one.
    created.sort_by_key(|entry| entry.file_name() == Some(std::ffi::OsStr::new(".git")));
    for entry in created {
        std::fs::remove_dir_all(entry)?;
    }
    Ok(())
}

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

/// Read the remainder of one NDJSON record without allocating it or giving
/// the JSON decoder access to the next record.
struct RecordTail<'a, R> {
    reader: &'a mut R,
    done: bool,
}

impl<R: std::io::BufRead> std::io::Read for RecordTail<'_, R> {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.done || out.is_empty() {
            return Ok(0);
        }
        let available = self.reader.fill_buf()?;
        let available = &available[..available.len().min(out.len())];
        let size = if let Some(newline) = available.iter().position(|&byte| byte == b'\n') {
            self.done = true;
            newline + 1
        } else {
            available.len()
        };
        out[..size].copy_from_slice(&available[..size]);
        self.reader.consume(size);
        Ok(size)
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OversizedTranscriptRecord {
    subagent: Option<serde::de::IgnoredAny>,
    payload: OversizedTranscriptPayload,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OversizedTranscriptPayload {
    #[serde(rename = "type")]
    kind: TranscriptRecordKind,
    #[serde(default)]
    queued: bool,
    final_text: Option<serde::de::IgnoredAny>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum TranscriptRecordKind {
    UserMessage,
    AssistantText,
    TurnStarted,
    TurnCompleted,
    #[serde(other)]
    Other,
}

impl TranscriptExport {
    fn oversized_record(&mut self, record: OversizedTranscriptRecord) -> Result<()> {
        use TranscriptRecordKind::*;
        let payload = record.payload;
        let could_display = match payload.kind {
            UserMessage => !payload.queued,
            AssistantText => record.subagent.is_none(),
            TurnCompleted => {
                !self.assistant_seen && record.subagent.is_none() && payload.final_text.is_some()
            }
            TurnStarted => {
                self.assistant_seen = false;
                false
            }
            Other => false,
        };
        if could_display {
            return Err(TransferTooLarge.into());
        }
        Ok(())
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
            let tail = RecordTail {
                reader: &mut reader,
                done: line.ends_with(b"\n"),
            };
            let record = serde_json::from_reader(line.as_slice().chain(tail))
                .map_err(|_| TransferTooLarge)?;
            export.oversized_record(record)?;
            continue;
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
    fn rejects_reserved_or_remote_branch_names() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        repository(&cloud);
        assert!(BranchCommit::new("refs/heads/main", &"a".repeat(40)).is_err());
        let bad_namespace = BranchCommit::new("origin/topic", &"a".repeat(40)).unwrap();
        assert!(check_branch_namespace(&cloud, &bad_namespace).is_err());
        git(&cloud, &["remote", "add", "team/fork", "unused"]).unwrap();
        let nested = BranchCommit::new("Team/Fork/topic", &"a".repeat(40)).unwrap();
        assert!(check_branch_namespace(&cloud, &nested).is_err());
    }

    #[test]
    fn a_branch_without_a_remote_moves_its_whole_history_as_a_bundle() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        repository(&cloud);
        commit(&cloud);
        let pin = BranchCommit::new("main", &commit(&cloud)).unwrap();
        std::fs::write(cloud.join("draft.txt"), "stays in the cloud").unwrap();
        assert_eq!(
            preview(&cloud, &pin).unwrap(),
            TransferPreview { commits: 2, has_remote_base: false, uncommitted_files: 1 }
        );
        let bundle = export(&cloud, &pin).unwrap().expect("a root bundle");
        let mut received = Vec::new();
        while (received.len() as u64) < bundle.size() {
            received.extend(bundle.read_chunk(received.len() as u64).unwrap());
        }
        let incoming = temp.path().join("incoming.bundle");
        std::fs::write(&incoming, received).unwrap();
        // An unrelated local project receives the history without a ref moving.
        let local = temp.path().join("local");
        repository(&local);
        let local_head = commit(&local);
        import_objects(&local, &incoming, &pin).unwrap();
        assert_eq!(git(&local, &["rev-parse", "HEAD"]).unwrap().trim(), local_head);
        // The local project's own main is untouched; only the objects arrived.
        assert_eq!(git(&local, &["rev-parse", &pin.branch_ref]).unwrap().trim(), local_head);
        assert_eq!(git(&local, &["rev-list", "--count", pin.commit()]).unwrap().trim(), "2");
    }

    /// A cloud repository without a remote on `branch`, and its whole-history bundle.
    fn root_bundle(temp: &Path, branch: &str) -> (PathBuf, BranchCommit) {
        let cloud = temp.join("cloud");
        repository(&cloud);
        if branch != "main" {
            git(&cloud, &["switch", "-q", "-c", branch]).unwrap();
        }
        commit(&cloud);
        let pin = BranchCommit::new(branch, &commit(&cloud)).unwrap();
        let bundle = export(&cloud, &pin).unwrap().unwrap();
        let mut bytes = Vec::new();
        while (bytes.len() as u64) < bundle.size() {
            bytes.extend(bundle.read_chunk(bytes.len() as u64).unwrap());
        }
        let path = temp.join("incoming.bundle");
        std::fs::write(&path, bytes).unwrap();
        (path, pin)
    }

    /// The import command's Git steps for an empty folder, up to the checkout;
    /// `fail_after_checkout` stands for a later step (the session) failing.
    fn move_into_empty_folder(
        folder: &Path,
        bundle: &Path,
        pin: &BranchCommit,
        fail_after_checkout: bool,
    ) -> Result<(PathBuf, BranchCommit)> {
        init_empty_destination(folder, pin)?;
        let result = (|| {
            validate_bundle(folder, bundle, pin)?.promote(folder)?;
            let name = "transfer-test";
            let local = choose_local_branch(folder, pin, name)?;
            let created = ensure_local_branch(folder, &local)?;
            let path = folder.join(".raccoon/worktrees").join(name);
            checkout(folder, &path, &local)?;
            if fail_after_checkout {
                rollback_import_checkout(folder, &path, &local, true, created)?;
                bail!("the session could not be created");
            }
            Ok((path, local))
        })();
        if result.is_err() {
            discard_empty_destination(folder)?;
        }
        result
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn an_empty_folder_receives_a_branch_named_like_the_default_branch() {
        let temp = tempfile::tempdir().unwrap();
        let (bundle, pin) = root_bundle(temp.path(), "main");
        let folder = temp.path().join("empty");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join(".DS_Store"), "").unwrap();
        let (path, local) = move_into_empty_folder(&folder, &bundle, &pin, false).unwrap();
        assert_eq!(local.branch(), "main", "the moved branch keeps its name");
        assert_eq!(git(&path, &["rev-parse", "HEAD"]).unwrap().trim(), pin.commit());
        assert_eq!(git(&path, &["symbolic-ref", "--short", "HEAD"]).unwrap().trim(), "main");
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn an_empty_folder_receives_a_branch_with_another_name() {
        let temp = tempfile::tempdir().unwrap();
        let (bundle, pin) = root_bundle(temp.path(), "topic/one");
        let folder = temp.path().join("empty");
        std::fs::create_dir(&folder).unwrap();
        let (path, local) = move_into_empty_folder(&folder, &bundle, &pin, false).unwrap();
        assert_eq!(local.branch(), "topic/one");
        assert_eq!(git(&path, &["rev-parse", "HEAD"]).unwrap().trim(), pin.commit());
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn a_failed_first_move_leaves_the_empty_folder_empty() {
        for branch in ["main", "topic"] {
            let temp = tempfile::tempdir().unwrap();
            let (bundle, pin) = root_bundle(temp.path(), branch);
            let folder = temp.path().join("empty");
            std::fs::create_dir(&folder).unwrap();
            std::fs::write(folder.join(".DS_Store"), "").unwrap();
            assert!(move_into_empty_folder(&folder, &bundle, &pin, true).is_err());
            let left: Vec<_> = std::fs::read_dir(&folder).unwrap().map(|entry| entry.unwrap().file_name()).collect();
            assert_eq!(left, [std::ffi::OsString::from(".DS_Store")], "{branch}");
        }
    }

    #[cfg(feature = "desktop")]
    #[test]
    fn a_folder_with_other_files_is_neither_initialized_nor_discarded() {
        let temp = tempfile::tempdir().unwrap();
        let folder = temp.path().join("notes");
        std::fs::create_dir(&folder).unwrap();
        assert!(is_empty_folder(&folder));
        std::fs::write(folder.join(".DS_Store"), "").unwrap();
        assert!(is_empty_folder(&folder));
        std::fs::write(folder.join("todo.txt"), "keep").unwrap();
        assert!(!is_empty_folder(&folder));
        let pin = BranchCommit::new("main", &"a".repeat(40)).unwrap();
        assert!(init_empty_destination(&folder, &pin).is_err());
        assert!(!folder.join(".git").exists());
        git(&folder, &["init", "-q"]).unwrap();
        assert!(discard_empty_destination(&folder).is_err());
        assert!(folder.join(".git").exists() && folder.join("todo.txt").exists());
    }

    #[test]
    fn a_fresh_repository_on_the_unborn_branch_gets_a_new_branch_name() {
        let temp = tempfile::tempdir().unwrap();
        let (bundle, pin) = root_bundle(temp.path(), "main");
        let local = temp.path().join("fresh");
        repository(&local);
        import_objects(&local, &bundle, &pin).unwrap();
        let chosen = choose_local_branch(&local, &pin, "transfer-1").unwrap();
        assert_eq!(chosen.branch(), "transfer-1");
    }

    #[test]
    fn preview_counts_only_commits_after_the_remote_base() {
        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        repository(&cloud);
        let base = commit(&cloud);
        mark_upstream(&cloud, &base);
        commit(&cloud);
        let pin = BranchCommit::new("main", &commit(&cloud)).unwrap();
        assert_eq!(
            preview(&cloud, &pin).unwrap(),
            TransferPreview { commits: 2, has_remote_base: true, uncommitted_files: 0 }
        );
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
    fn skips_an_oversized_tool_record_and_reads_the_next_message() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("transcript.jsonl");
        let mut file = std::fs::File::create(&log).unwrap();
        // Put the discriminator after the large field, so finding it requires
        // scanning across the boundary with the structured JSON decoder.
        for kind in ["tool_call_completed", "assistant_text"] {
            file.set_len(0).unwrap();
            file.rewind().unwrap();
            file.write_all(br#"{"payload":{"text":""#).unwrap();
            let chunk = vec![b'x'; 1024 * 1024];
            for _ in 0..25 {
                file.write_all(&chunk).unwrap();
            }
            writeln!(file, "\",\"type\":\"{kind}\"}}}}").unwrap();
            writeln!(
                file,
                "{}",
                serde_json::json!({
                    "id": "next", "sessionId": "session", "tabId": "tab", "harness": "claude",
                    "seq": 2, "ts": "2026-11-25T00:00:00Z",
                    "payload": { "type": "assistant_text", "text": "Answer" },
                })
            )
            .unwrap();
            let exported = transcript_file(&log, 4 * 1024 * 1024);
            if kind == "tool_call_completed" {
                assert_eq!(
                    exported.unwrap(),
                    br#"[{"role":"assistant","text":"Answer"}]"#
                );
            } else {
                assert!(exported.unwrap_err().is::<TransferTooLarge>());
            }
        }
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
    fn root_prerequisite_does_not_repack_history_already_in_the_destination() {
        use std::io::Write;
        use std::process::Stdio;

        let temp = tempfile::tempdir().unwrap();
        let cloud = temp.path().join("cloud");
        let local = temp.path().join("local");
        repository(&cloud);
        let root = commit(&cloud);
        let mut noise = 17u32;
        let bytes: Vec<_> = (0..16384)
            .map(|_| {
                noise ^= noise << 13;
                noise ^= noise >> 17;
                noise ^= noise << 5;
                noise as u8
            })
            .collect();
        std::fs::write(cloud.join("local-history"), bytes).unwrap();
        git(&cloud, &["add", "--all"]).unwrap();
        let tip = commit(&cloud);
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
        // Only the remote-tracking ref retains the local tip.
        git(&local, &["reset", "--hard", &root]).unwrap();
        let pin = BranchCommit::new("main", &commit(&cloud)).unwrap();
        let mut command = git_command(&cloud, &["pack-objects"]);
        let mut pack = command
            .args(["pack-objects", "--stdout", "--revs"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        writeln!(pack.stdin.take().unwrap(), "{}\n^{tip}", pin.commit()).unwrap();
        let result = pack.wait_with_output().unwrap();
        assert!(result.status.success());
        let path = temp.path().join("root-prerequisite.bundle");
        let mut bytes = format!(
            "# v2 git bundle\n-{root} root\n{} refs/heads/main\n\n",
            pin.commit()
        )
        .into_bytes();
        bytes.extend(result.stdout);
        assert!(bytes.len() < 1024);
        std::fs::write(&path, bytes).unwrap();
        let original_usage: u64 = git(
            &cloud,
            &[
                "rev-list",
                "--objects",
                "--disk-usage",
                pin.commit(),
                &format!("^{root}"),
            ],
        )
        .unwrap()
        .trim()
        .parse()
        .unwrap();
        assert!(original_usage > 1024);
        let refs = git(&local, &["show-ref"]).unwrap();
        let objects = git(&local, &["count-objects", "-v"]).unwrap();
        let validated = validate_bundle(&local, &path, &pin).unwrap();
        let repacked = validated.path.as_ref().unwrap();
        assert!(repacked.metadata().unwrap().len() < 1024);
        std::fs::remove_file(repacked).unwrap();
        let quarantine = validated._quarantine.path();
        assert!(repack_validated(&local, quarantine, &pin, &[root], 1).is_err());
        assert!(
            !repacked.exists(),
            "preflight wrote a repack despite the size refusal"
        );
        assert_eq!(git(&local, &["show-ref"]).unwrap(), refs);
        assert_eq!(git(&local, &["count-objects", "-v"]).unwrap(), objects);

        validate_bundle(&local, &path, &pin)
            .unwrap()
            .promote(&local)
            .unwrap();
        git(
            &local,
            &["update-ref", "refs/remotes/origin/main", pin.commit()],
        )
        .unwrap();
        let already_local = validate_bundle(&local, &path, &pin).unwrap();
        assert!(already_local.path.is_none());
        already_local.promote(&local).unwrap();
    }

    #[test]
    fn rejects_an_unrelated_local_prerequisite_before_promoting() {
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
        let tree = git(&local, &["rev-parse", "HEAD^{tree}"]).unwrap();
        let unrelated = git(
            &local,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
                "commit-tree",
                tree.trim(),
                "-m",
                "unrelated root",
            ],
        )
        .unwrap();
        let unrelated = unrelated.trim();
        git(&local, &["update-ref", "refs/heads/unrelated", unrelated]).unwrap();

        let pin = BranchCommit::new("main", &commit(&cloud)).unwrap();
        let mut command = git_command(&cloud, &["pack-objects"]);
        let mut pack = command
            .args(["pack-objects", "--stdout", "--revs"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        writeln!(pack.stdin.take().unwrap(), "{}\n^{base}", pin.commit()).unwrap();
        let result = pack.wait_with_output().unwrap();
        assert!(result.status.success());
        let path = temp.path().join("unrelated-prerequisite.bundle");
        let mut bytes = format!(
            "# v2 git bundle\n-{unrelated} unrelated\n{} refs/heads/main\n\n",
            pin.commit()
        )
        .into_bytes();
        bytes.extend(result.stdout);
        std::fs::write(&path, bytes).unwrap();

        let refs = git(&local, &["show-ref"]).unwrap();
        let objects = git(&local, &["count-objects", "-v"]).unwrap();
        let error = import_objects(&local, &path, &pin).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("prerequisite is not an ancestor"),
            "{error:#}"
        );
        assert_eq!(git(&local, &["show-ref"]).unwrap(), refs);
        assert_eq!(git(&local, &["count-objects", "-v"]).unwrap(), objects);
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

    #[test]
    fn refuses_ambiguous_or_escaping_link_paths() {
        use std::collections::HashMap;

        for path in ["/absolute", "folder\\outside", "./.Git/config"] {
            assert!(!portable_link_path(path), "{path}");
        }

        let targets = HashMap::from([
            ("b".into(), "../.."),
            ("dir/up".into(), ".."),
            ("cycle-a".into(), "cycle-b/"),
            ("cycle-b".into(), "cycle-a"),
        ]);
        assert!(resolve_link("a", "b/", &targets).is_err());
        assert!(resolve_link("link", "DIR/up/../outside", &targets).is_err());
        assert!(resolve_link("cycle-a", "cycle-b/", &targets).is_err());

        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        repository(&repo);
        let file = repo.join("target");
        std::fs::write(&file, b".").unwrap();
        let oid = git(&repo, &["hash-object", "-w", file.to_str().unwrap()]).unwrap();
        let links = vec![("Link", oid.trim(), 1), ("link", oid.trim(), 1)];
        assert!(validate_links(&repo, links)
            .unwrap_err()
            .to_string()
            .contains("differ only by case"));

        for branch in ["heads/topic", "tags/topic", "REMOTES/topic"] {
            assert!(BranchCommit::new(branch, &"a".repeat(40)).is_err());
        }
    }

    #[test]
    fn explains_the_symbolic_link_count_limit() {
        let entry = format!("120000 blob {} 1\tlink\0", "a".repeat(40));
        let listing = entry.repeat(257);
        let error = validate_listing(&listing, 257, 257).unwrap_err();
        assert!(error.to_string().contains("at most 256 symbolic links"));
    }

    #[cfg(unix)]
    #[test]
    fn accepts_in_tree_symbolic_links_and_refuses_composed_escapes() {
        assert!(!portable_link_path("nested/COM1.txt"));
        assert!(!portable_link_path("nested/NUL"));
        assert!(!portable_link_path("nested/COM¹.txt"));
        assert!(!portable_link_path("nested/a\u{202e}"));
        assert!(!portable_link_path("nested/a\u{061c}"));
        assert!(portable_link_path("nested/café"));
        let temp = tempfile::tempdir().unwrap();
        let repo = temp.path().join("repo");
        repository(&repo);
        std::fs::create_dir(repo.join("nested")).unwrap();
        std::fs::write(repo.join("inside"), b"text").unwrap();
        std::os::unix::fs::symlink("../inside", repo.join("nested/relative")).unwrap();
        std::os::unix::fs::symlink("nested/relative", repo.join("chain")).unwrap();
        std::os::unix::fs::symlink("../inside", repo.join("nested/café")).unwrap();
        std::os::unix::fs::symlink("nested/cafe\u{301}", repo.join("unicode-link")).unwrap();
        std::os::unix::fs::symlink(".", repo.join("root-alias")).unwrap();
        git(&repo, &["add", "--all"]).unwrap();
        let pin = BranchCommit::new("main", &commit(&repo)).unwrap();
        validate_checkout(&repo, &pin).unwrap();
        std::os::unix::fs::symlink(".", repo.join("jalón")).unwrap();
        std::os::unix::fs::symlink("JALO\u{301}N/../outside", repo.join("escape")).unwrap();
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
        // Before any remote base exists, the whole history is the bundle.
        assert!(export(&cloud, &root).unwrap().is_some());
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
