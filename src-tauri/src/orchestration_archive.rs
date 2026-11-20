//! Remote commit preservation, independent of session and worktree lifecycles.
//!
//! A receipt covers only `head`. Callers must stop writers and check that HEAD
//! still matches before archiving/deleting; uncommitted files are not covered.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{bail, ensure, Context, Result};

use crate::git;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct Preservation {
    pub head: String,
    /// The single, resolved push destination that was actually checked.
    pub remote: String,
    pub remote_ref: String,
    pub remote_commit: String,
    pub pushed: bool,
}

/// Preserve the checkout's exact HEAD on its configured push remote (origin
/// when no branch remote is configured). Never uses tracking refs as proof.
/// A backup may advance by fast-forward only, protected by an explicit lease.
/// Errors leave all local branches, files and commits intact and must prevent
/// archival/deletion. Python 3.9+ is required for the embedded release scanner;
/// missing/broken scanning fails closed before any push.
pub(crate) fn preserve_try(
    repository: &Path,
    checkout: &Path,
    run: &str,
    piece: &str,
    attempt: u32,
) -> Result<Preservation> {
    let _authority = crate::github_process::scope();
    let backup = backup_ref(run, piece, attempt)?;
    // A missing worktree .git file otherwise makes Git silently answer for
    // the enclosing repository, producing a receipt for the wrong HEAD.
    ensure!(git::is_worktree_of(repository, checkout), "Try checkout is not an intact worktree of the run repository; keep it and repair its Git metadata or correct its repository path.");
    ensure!(git::run(checkout, &["rev-parse", "--is-shallow-repository"])?.trim() == "false", "Cannot prove preservation from a shallow repository; fetch its full history and retry. Keep the checkout.");
    // Serialize probes across worktrees/processes. A crashed owner releases the
    // OS lock, so every remaining probe ref is stale when the next owner enters.
    let common = git::run(checkout, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    let probe_lock = std::fs::OpenOptions::new().create(true).truncate(false).read(true).write(true)
        .open(Path::new(common.trim()).join("terminalx-archive-probe.lock"))?;
    probe_lock.lock()?;
    clear_probe_refs(checkout)?;
    let head = head(checkout)?;
    let branch = git::current_branch(checkout);
    let remote = branch
        .as_deref()
        .and_then(|branch| git::push_remote(checkout, branch))
        // Detached tries have no branch configuration, but still honor the
        // repository's explicit default push destination.
        .or_else(|| {
            git::run(checkout, &["config", "--get", "remote.pushDefault"])
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| "origin".into());
    ensure!(
        remote != "." && !remote.starts_with('-'),
        "Try has no external push remote; configure one and retry. Keep the checkout."
    );
    git::configured_push_url(checkout, &remote).context(
        "Configure exactly one push destination before preserving this try; keep the checkout",
    )?;
    let destination = git::run(checkout, &["remote", "get-url", "--push", &remote])?
        .trim()
        .to_owned();
    ensure!(
        !destination.is_empty() && !destination.starts_with('-'),
        "Invalid archive push destination; keep the checkout and correct its remote."
    );
    let transport = ArchiveRemote::new(checkout, destination.clone())?;

    // Fetch into a private namespace, independent of refspecs, FETCH_HEAD and
    // stale tracking branches. A guard removes only these temporary refs.
    let refs = ProbeRefs {
        checkout,
        prefix: format!(
            "refs/raccoon/archive-probe/{}",
            uuid::Uuid::new_v4().simple()
        ),
    };
    transport
        .run(
            checkout,
            &[
                "fetch",
                "--no-tags",
                "--no-recurse-submodules",
                "--no-write-fetch-head",
                "--refmap=",
                "--",
                &transport.name,
                &format!("+refs/heads/*:{}/heads/*", refs.prefix),
                &format!("+refs/tags/*:{}/tags/*", refs.prefix),
            ],
        )
        .context("Could not refresh archive remote coverage; keep the try checkout and retry")?;
    let advertised = remote_refs(checkout, &transport)?;
    let mut covered = Vec::new();
    for (name, tip) in &advertised {
        // Only the exact, still-advertised tips fetched into our namespace
        // count. Concurrent remote changes cannot turn stale data into proof.
        let suffix = name.strip_prefix("refs/").context("Invalid remote ref")?;
        let fetched = git::run(
            checkout,
            &[
                "rev-parse",
                "--verify",
                &format!("{}/{suffix}", refs.prefix),
            ],
        )
        .ok();
        if fetched.as_deref().map(str::trim) != Some(tip.as_str()) {
            continue;
        }
        let commit = git::run(
            checkout,
            &[
                "--no-replace-objects",
                "rev-parse",
                "--verify",
                &format!("{tip}^{{commit}}"),
            ],
        );
        if let Ok(commit) = commit {
            let commit = commit.trim().to_owned();
            if name == &backup && ancestor(checkout, &head, &commit)? {
                check_head(checkout, &head)?;
                return Ok(Preservation {
                    head,
                    remote: destination,
                    remote_ref: name.clone(),
                    remote_commit: tip.clone(),
                    pushed: false,
                });
            }
            covered.push(commit);
        }
    }
    let previous = advertised.get(&backup).cloned().unwrap_or_default();
    if !previous.is_empty() {
        ensure!(ancestor(checkout, &previous, &head)?, "Archive ref {backup} contains different history; nothing was overwritten. Keep the checkout and resolve the archive ref collision.");
    }
    scan_unpublished(checkout, &head, &covered).context("Try backup secret scan failed; nothing was pushed. Keep the checkout, resolve the scan error and retry")?;
    check_head(checkout, &head)?;
    transport.run(checkout, &["-c", "push.followTags=false", "push", "--porcelain", "--recurse-submodules=no",
        &format!("--force-with-lease={backup}:{previous}"), "--", &transport.name, &format!("{head}:{backup}")])
        .context("Try backup push failed; keep the checkout and retry after resolving remote access or an archive ref race")?;
    let verified = remote_refs(checkout, &transport)?;
    ensure!(
        verified.get(&backup) == Some(&head),
        "Archive push could not be verified at the exact try HEAD; keep the checkout and retry."
    );
    check_head(checkout, &head)?;
    Ok(Preservation {
        remote: destination,
        remote_ref: backup,
        remote_commit: head.clone(),
        head,
        pushed: true,
    })
}

/// Revalidate a saved exact-tip receipt against the live remote without pushing.
pub(crate) fn verify_preservation(checkout: &Path, receipt: &Preservation) -> Result<()> {
    let _authority = crate::github_process::scope();
    check_head(checkout, &receipt.head)?;
    let remote = ArchiveRemote::new(checkout, receipt.remote.clone())?;
    ensure!(remote_refs(checkout, &remote)?.get(&receipt.remote_ref) == Some(&receipt.remote_commit), "Backup ref changed or disappeared; preserve the try again before cleanup");
    ensure!(ancestor(checkout, &receipt.head, &receipt.remote_commit)?, "Backup no longer covers the try");
    check_head(checkout, &receipt.head)
}

fn backup_ref(run: &str, piece: &str, attempt: u32) -> Result<String> {
    ensure!(!run.is_empty() && !piece.is_empty() && attempt > 0,
        "Archive requires nonempty run/piece IDs and a positive try number.");
    Ok(format!(
        "refs/heads/raccoon/archive/{}/{}-try{attempt}",
        ref_component(run), ref_component(piece)
    ))
}

fn ref_component(id: &str) -> String {
    // Retain existing readable refs. Reserve a namespace for hashed IDs so a
    // literal ID cannot alias an encoded one; bound even arbitrarily long IDs.
    if id.len() <= 128 && !id.starts_with("id-")
        && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_')) {
        return id.to_owned();
    }
    use sha2::{Digest, Sha256};
    format!("id-{:x}", Sha256::digest(id.as_bytes()))
}

fn head(checkout: &Path) -> Result<String> {
    Ok(git::run(
        checkout,
        &[
            "--no-replace-objects",
            "rev-parse",
            "--verify",
            "HEAD^{commit}",
        ],
    )
    .context("Try checkout has no readable HEAD; keep it and repair its Git metadata")?
    .trim()
    .to_owned())
}

fn check_head(checkout: &Path, expected: &str) -> Result<()> {
    ensure!(
        head(checkout)? == expected,
        "Try HEAD changed during preservation; stop its writers and retry. Keep the checkout."
    );
    Ok(())
}

fn ancestor(checkout: &Path, older: &str, newer: &str) -> Result<bool> {
    let output = git::inspect_output(
        checkout,
        &[
            "--no-replace-objects",
            "merge-base",
            "--is-ancestor",
            older,
            newer,
        ],
    )?;
    match output.status.code() {
        Some(0) => Ok(true), Some(1) => Ok(false),
        _ => bail!("Cannot establish archive ancestry; keep the checkout and fetch/repair missing Git objects."),
    }
}

// Explicit pushurl prevents pushInsteadOf from redirecting a URL passed on
// the command line a second time. Both directions must resolve identically.
// Configuration exists only in each Git process, never in the repository.
struct ArchiveRemote {
    name: String,
    url_config: String,
    push_config: String,
}

impl ArchiveRemote {
    fn new(checkout: &Path, destination: String) -> Result<Self> {
        let name = format!("raccoon-archive-{}", uuid::Uuid::new_v4().simple());
        let remote = Self {
            url_config: format!("remote.{name}.url={destination}"),
            push_config: format!("remote.{name}.pushurl={destination}"),
            name,
        };
        // `remote get-url` ignores command-scoped remotes on Apple Git.
        // ls-remote resolves the same command configuration as the transfer.
        let read = remote.run(checkout, &["ls-remote", "--get-url", &remote.name])?;
        ensure!(read.trim() == destination,
            "Archive remote URL rewrites do not resolve to one stable read/write destination; keep the checkout and correct the remote configuration.");
        Ok(remote)
    }

    fn run(&self, checkout: &Path, args: &[&str]) -> Result<String> {
        let mut configured = vec![
            "-c",
            self.url_config.as_str(),
            "-c",
            self.push_config.as_str(),
        ];
        configured.extend_from_slice(args);
        git::run(checkout, &configured)
    }
}

fn remote_refs(checkout: &Path, remote: &ArchiveRemote) -> Result<BTreeMap<String, String>> {
    let listing = remote
        .run(
            checkout,
            &[
                "ls-remote",
                "--refs",
                "--heads",
                "--tags",
                "--",
                &remote.name,
            ],
        )
        .context("Could not verify live archive remote refs; keep the checkout and retry")?;
    let mut refs = BTreeMap::new();
    for line in listing.lines() {
        let (oid, name) = line
            .split_once('\t')
            .context("Malformed remote ref advertisement")?;
        ensure!(
            matches!(oid.len(), 40 | 64)
                && oid.bytes().all(|c| c.is_ascii_hexdigit())
                && (name.starts_with("refs/heads/") || name.starts_with("refs/tags/")),
            "Invalid remote ref advertisement"
        );
        refs.insert(name.into(), oid.into());
    }
    Ok(refs)
}

fn clear_probe_refs(checkout: &Path) -> Result<()> {
    for name in git::run(checkout, &["for-each-ref", "--format=%(refname)", "refs/raccoon/archive-probe/"])?.lines() {
        git::run(checkout, &["update-ref", "-d", name])?;
    }
    Ok(())
}

struct ProbeRefs<'a> {
    checkout: &'a Path,
    prefix: String,
}
impl Drop for ProbeRefs<'_> {
    fn drop(&mut self) {
        if let Ok(names) = git::run(
            self.checkout,
            &[
                "for-each-ref",
                "--format=%(refname)",
                &format!("{}/", self.prefix),
            ],
        ) {
            for name in names.lines() {
                if let Err(error) = git::run(self.checkout, &["update-ref", "-d", name]) {
                    log::warn!("Remove archive probe ref {name}: {error:#}");
                }
            }
        }
    }
}

/// Reuse the release scanner's patterns and recursive binary/container
/// inspector, embedded at build time so installed runtimes need no source
/// checkout. Git object reads remain in Rust, with lazy fetch disabled.
fn scan_unpublished(checkout: &Path, head: &str, covered: &[String]) -> Result<()> {
    let temp = tempfile::tempdir()?;
    let package = temp.path().join("txrelease");
    std::fs::create_dir(&package)?;
    for (name, source) in [
        ("__init__.py", ""),
        ("credentials.py", include_str!("../../scripts/release/txrelease/credentials.py")),
        (
            "config.py",
            include_str!("../../scripts/release/txrelease/config.py"),
        ),
        (
            "proc.py",
            include_str!("../../scripts/release/txrelease/proc.py"),
        ),
        (
            "content.py",
            include_str!("../../scripts/release/txrelease/content.py"),
        ),
        (
            "secrets_scan.py",
            include_str!("../../scripts/release/txrelease/secrets_scan.py"),
        ),
    ] {
        std::fs::write(package.join(name), source)?;
    }
    let mut args = vec![
        "--no-replace-objects",
        "rev-list",
        "--objects",
        head,
        "--not",
    ];
    args.extend(covered.iter().map(String::as_str));
    args.push("--");
    let listing = git::run(checkout, &args)?;
    let mut total = 0usize;
    let mut objects = Vec::new();
    for line in listing.lines() {
        let oid = line
            .split_whitespace()
            .next()
            .context("Invalid Git object listing")?;
        let kind = git::run(checkout, &["--no-replace-objects", "cat-file", "-t", oid])?;
        if !matches!(kind.trim(), "blob" | "commit" | "tree" | "tag") {
            bail!("Unrecognized Git object; cannot scan backup safely");
        }
        let size: usize = git::run(checkout, &["--no-replace-objects", "cat-file", "-s", oid])?
            .trim()
            .parse()?;
        total = total
            .checked_add(size)
            .context("Archive scan size overflow")?;
        ensure!(size <= 64 << 20 && total <= 512 << 20, "Backup exceeds secret scan limits (64 MiB/object, 512 MiB total); preserve it manually with a full secret scan before retrying.");
        let output = git::inspect_output(
            checkout,
            &["--no-replace-objects", "cat-file", kind.trim(), oid],
        )?;
        ensure!(
            output.status.success() && output.stdout.len() == size,
            "Could not read complete backup object; repair missing objects and retry"
        );
        std::fs::write(temp.path().join(oid), output.stdout)?;
        objects.push(oid.to_owned());
    }
    std::fs::write(
        temp.path().join("objects.json"),
        serde_json::to_vec(&objects)?,
    )?;
    let script = r#"
import sys, json
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from txrelease.secrets_scan import Scanner, home_needles
root = Path(sys.argv[1])
from txrelease.credentials import local_secrets
from txrelease.proc import Runner
try:
    # Read values inside this process: never put credentials in argv, temporary
    # files, or output. Missing release setup is normal; unreadable setup is not.
    needles = local_secrets(Runner(), require_signing=False)
except (Exception, SystemExit):
    print('Could not load local secret scan credentials', file=sys.stderr)
    sys.exit(1)
scanner = Scanner({label: value.encode() for label, value in needles.items()})
for oid in json.loads((root / 'objects.json').read_text()):
    scanner.scan('git object ' + oid, (root / oid).read_bytes(), home_needles(Path.home()))
if scanner.findings:
    print(json.dumps(scanner.findings), file=sys.stderr)
    sys.exit(1)
"#;
    let mut command = crate::binpath::python3();
    // Finder's PATH may locate Python but omit tools its credential loader
    // invokes, such as Homebrew's gh. Use the same login PATH as other children.
    command.env("PATH", crate::binpath::login_path());
    command.args(["-I", "-c", script]).arg(temp.path());
    let output =
        git::output_within(command, std::time::Duration::from_secs(120)).map_err(|error| {
            anyhow::anyhow!(
                "Embedded release secret scanner requires Python 3.9+ and must pass: {error:?}"
            )
        })?;
    ensure!(
        output.trim().is_empty(),
        "Unexpected secret scanner output; keep the checkout and retry"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        local: tempfile::TempDir,
        remote: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let local = tempfile::tempdir().unwrap();
            let remote = tempfile::tempdir().unwrap();
            git::run(local.path(), &["init", "-q", "-b", "main"]).unwrap();
            git::run(local.path(), &["config", "user.email", "test@example.com"]).unwrap();
            git::run(local.path(), &["config", "user.name", "Archive test"]).unwrap();
            git::run(local.path(), &["config", "commit.gpgsign", "false"]).unwrap();
            git::run(remote.path(), &["init", "--bare", "-q"]).unwrap();
            git::run(
                local.path(),
                &["remote", "add", "origin", remote.path().to_str().unwrap()],
            )
            .unwrap();
            let fixture = Self { local, remote };
            fixture.commit("file.txt", "initial\n");
            fixture
        }

        fn commit(&self, name: &str, content: &str) -> String {
            std::fs::write(self.local.path().join(name), content).unwrap();
            git::run(self.local.path(), &["add", "--", name]).unwrap();
            git::run(self.local.path(), &["commit", "-qm", "test commit"]).unwrap();
            head(self.local.path()).unwrap()
        }

        fn preserve(&self) -> Result<Preservation> {
            preserve_try(self.local.path(), self.local.path(), "run-123", "worker", 2)
        }

        fn backup(&self) -> Option<String> {
            git::run(
                self.remote.path(),
                &[
                    "rev-parse",
                    "--verify",
                    "refs/heads/raccoon/archive/run-123/worker-try2",
                ],
            )
            .ok()
            .map(|s| s.trim().into())
        }

        fn assert_no_probe_refs(&self) {
            assert!(git::run(
                self.local.path(),
                &[
                    "for-each-ref",
                    "--format=%(refname)",
                    "refs/raccoon/archive-probe/"
                ]
            )
            .unwrap()
            .is_empty());
        }
    }

    #[test]
    fn archive_ref_names_are_safe_and_unambiguous() {
        assert_eq!(
            backup_ref("abc-123", "worker_1", 2).unwrap(),
            "refs/heads/raccoon/archive/abc-123/worker_1-try2"
        );
        let ids = ["../other", "a/b", "a..b", "a.lock", "a b", "作業", "a\nb", "a:b", "$(command)"];
        let mut refs = std::collections::HashSet::new();
        for id in ids.into_iter().chain(["x".repeat(1000).as_str()]) {
            let encoded = backup_ref("existing/run", id, 1).unwrap();
            assert!(git::run(Path::new("."), &["check-ref-format", &encoded]).is_ok());
            assert_eq!(encoded, backup_ref("existing/run", id, 1).unwrap());
            assert!(refs.insert(encoded));
            assert_ne!(ref_component(id), ref_component(&ref_component(id)));
        }
        assert!(backup_ref("", "piece", 1).is_err());
        assert!(backup_ref("run", "", 1).is_err());
        assert!(backup_ref("run", "piece", 0).is_err());
    }

    #[test]
    fn existing_runs_with_non_ref_piece_ids_can_preserve_and_retry() {
        for piece in ["piece.one", "piece/one", "piece one", "作業", "id-existing"] {
            let f = Fixture::new();
            let expected = f.commit("file.txt", "superseded work\n");
            let first = preserve_try(f.local.path(), f.local.path(), "existing/run", piece, 3).unwrap();
            assert!(first.pushed);
            assert_eq!(first.remote_ref, backup_ref("existing/run", piece, 3).unwrap());
            assert_eq!(first.head, expected);
            verify_preservation(f.local.path(), &first).unwrap();
            let again = preserve_try(f.local.path(), f.local.path(), "existing/run", piece, 3).unwrap();
            assert!(!again.pushed);
            assert_eq!(again.remote_ref, first.remote_ref);
        }
    }

    #[test]
    fn local_credentials_outside_patterns_block_archive_push() {
        use base64::Engine;
        let temp = tempfile::tempdir().unwrap();
        let key = base64::engine::general_purpose::STANDARD.encode("fixture-signing-material-".repeat(4));
        let key_path = temp.path().join("updater.key");
        std::fs::write(&key_path, &key).unwrap();
        for mode in ["key", "password"] {
            // Isolate credential environment in a child test process, never
            // mutate the shared test runner's environment or pass secrets in argv.
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "orchestration_archive::tests::local_credentials_scan_child", "--nocapture"])
                .env("ARCHIVE_SCAN_TEST_MODE", mode)
                .env("TERMINALX_UPDATER_KEY", &key_path)
                .env("TAURI_SIGNING_PRIVATE_KEY_PASSWORD", "fixture-password-outside-patterns")
                .output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stdout));
        }
    }

    #[test]
    fn local_credentials_scan_child() {
        let Ok(mode) = std::env::var("ARCHIVE_SCAN_TEST_MODE") else { return };
        let (secret, label) = if mode == "key" {
            (std::fs::read_to_string(std::env::var("TERMINALX_UPDATER_KEY").unwrap()).unwrap(), "updater signing key (file)")
        } else {
            (std::env::var("TAURI_SIGNING_PRIVATE_KEY_PASSWORD").unwrap(), "updater key password")
        };
        let f = Fixture::new();
        f.commit("file.txt", &secret);
        f.commit("file.txt", "secret removed from final version\n");
        let error = format!("{:#}", f.preserve().unwrap_err());
        assert!(error.contains(label), "missing credential finding");
        assert!(!error.contains(&secret), "credential leaked in scanner diagnostic");
        assert!(f.backup().is_none());
        f.assert_no_probe_refs();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finder_path_still_scans_and_preserves_unpublished_commits() {
        // A fresh process also gives binpath fresh caches, as at GUI launch.
        // Exercise the real scanner, credential loader and bare-remote push.
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "orchestration_archive::tests::unpublished_head_is_scanned_backed_up_and_idempotent",
                "--nocapture",
            ])
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    #[test]
    fn preservation_sweeps_crash_leftovers_but_keeps_unrelated_refs() {
        let f = Fixture::new();
        let tip = head(f.local.path()).unwrap();
        for name in ["refs/raccoon/archive-probe/abandoned/heads/main", "refs/raccoon/keep"] {
            git::run(f.local.path(), &["update-ref", name, &tip]).unwrap();
        }
        f.preserve().unwrap();
        f.assert_no_probe_refs();
        assert_eq!(git::run(f.local.path(), &["rev-parse", "refs/raccoon/keep"]).unwrap().trim(), tip);
    }

    #[test]
    fn unpublished_head_is_scanned_backed_up_and_idempotent() {
        let f = Fixture::new();
        let expected = f.commit("file.txt", "unpublished work\n");
        let first = f.preserve().unwrap();
        assert!(first.pushed);
        assert_eq!(first.head, expected);
        assert_eq!(first.remote_commit, expected);
        assert_eq!(f.backup(), Some(expected));
        let second = f.preserve().unwrap();
        assert!(!second.pushed);
        assert_eq!(second.head, first.head);
        assert_eq!(second.remote_ref, first.remote_ref);
        assert_eq!(
            git::run(f.local.path(), &["status", "--porcelain"]).unwrap(),
            ""
        );
        assert!(git::run(f.local.path(), &["rev-parse", "--verify", "@{upstream}"]).is_err());
        f.assert_no_probe_refs();
    }

    #[test]
    fn live_remote_descendant_still_gets_an_independent_archive_ref() {
        let f = Fixture::new();
        let original = head(f.local.path()).unwrap();
        let descendant = f.commit("file.txt", "remote descendant\n");
        git::run(
            f.local.path(),
            &["push", "origin", "HEAD:refs/heads/published"],
        )
        .unwrap();
        git::run(f.local.path(), &["reset", "--hard", &original]).unwrap();
        git::run(
            f.local.path(),
            &["update-ref", "-d", "refs/remotes/origin/published"],
        )
        .unwrap();
        let receipt = f.preserve().unwrap();
        assert!(receipt.pushed);
        assert_eq!(receipt.head, original);
        assert_eq!(receipt.remote_commit, original);
        assert_eq!(f.backup(), Some(original));
        git::run(f.remote.path(), &["update-ref", "-d", "refs/heads/published", &descendant]).unwrap();
        verify_preservation(f.local.path(), &receipt).unwrap();
    }

    #[test]
    fn stale_tracking_refs_and_local_branches_do_not_prove_preservation() {
        let f = Fixture::new();
        let expected = head(f.local.path()).unwrap();
        git::run(
            f.local.path(),
            &["push", "origin", "HEAD:refs/heads/vanished"],
        )
        .unwrap();
        git::run(
            f.remote.path(),
            &["update-ref", "-d", "refs/heads/vanished"],
        )
        .unwrap();
        git::run(f.local.path(), &["branch", "another-local-holder"]).unwrap();
        assert!(f.preserve().unwrap().pushed);
        assert_eq!(f.backup(), Some(expected));
    }

    #[test]
    fn backup_advances_only_by_fast_forward_and_receipt_tracks_new_head() {
        let f = Fixture::new();
        let old = f.preserve().unwrap();
        let new = f.commit("file.txt", "later work\n");
        let receipt = f.preserve().unwrap();
        assert!(receipt.pushed);
        assert_ne!(old.head, receipt.head);
        assert_eq!(receipt.head, new);
        assert_eq!(f.backup(), Some(new));
    }

    #[test]
    fn divergent_backup_is_never_overwritten_and_local_work_survives() {
        let f = Fixture::new();
        let base = head(f.local.path()).unwrap();
        let archived = f.commit("file.txt", "first history\n");
        f.preserve().unwrap();
        git::run(f.local.path(), &["reset", "--hard", &base]).unwrap();
        let current = f.commit("file.txt", "other history\n");
        let error = f.preserve().unwrap_err().to_string();
        assert!(error.contains("different history"), "{error}");
        assert_eq!(f.backup(), Some(archived));
        assert_eq!(head(f.local.path()).unwrap(), current);
        assert_eq!(
            std::fs::read_to_string(f.local.path().join("file.txt")).unwrap(),
            "other history\n"
        );
        f.assert_no_probe_refs();
    }

    #[test]
    fn scanner_refuses_secret_in_an_intermediate_commit_without_leaking_value() {
        let f = Fixture::new();
        // Construct fixture bytes without placing a credential pattern in the
        // source history that the release scanner itself must inspect.
        let token = format!("{}{}", "ghp_", "A".repeat(36));
        f.commit("file.txt", &token);
        let current = f.commit("file.txt", "secret removed from tip\n");
        let error = format!("{:#}", f.preserve().unwrap_err());
        assert!(error.contains("GitHub token pattern"), "{error}");
        assert!(!error.contains(&token));
        assert!(f.backup().is_none());
        assert_eq!(head(f.local.path()).unwrap(), current);
        f.assert_no_probe_refs();
    }

    #[test]
    fn scanner_inspects_compressed_binary_objects_before_push() {
        use std::io::Write;
        let f = Fixture::new();
        let token = format!("{}{}", "ghp_", "B".repeat(36));
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(token.as_bytes()).unwrap();
        std::fs::write(f.local.path().join("data.gz"), gzip.finish().unwrap()).unwrap();
        git::run(f.local.path(), &["add", "data.gz"]).unwrap();
        git::run(f.local.path(), &["commit", "-qm", "compressed fixture"]).unwrap();
        let error = format!("{:#}", f.preserve().unwrap_err());
        assert!(error.contains("GitHub token pattern"), "{error}");
        assert!(!error.contains(&token));
        assert!(f.backup().is_none());
    }

    #[test]
    fn configured_push_url_is_the_destination_checked_and_preserved() {
        let f = Fixture::new();
        let push_repo = tempfile::tempdir().unwrap();
        git::run(push_repo.path(), &["init", "--bare", "-q"]).unwrap();
        git::run(
            f.local.path(),
            &[
                "config",
                "remote.origin.pushurl",
                push_repo.path().to_str().unwrap(),
            ],
        )
        .unwrap();
        git::run(
            f.local.path(),
            &["push", "origin", "HEAD:refs/heads/published"],
        )
        .unwrap();
        // The fetch URL has no coverage. Only the push destination counts.
        let result = f.preserve().unwrap();
        assert!(result.pushed);
        assert_eq!(result.remote, push_repo.path().to_str().unwrap());
        assert!(f.backup().is_none());
        git::run(
            f.local.path(),
            &[
                "config",
                "--add",
                "remote.origin.pushurl",
                f.remote.path().to_str().unwrap(),
            ],
        )
        .unwrap();
        assert!(f.preserve().is_err());
    }

    #[test]
    fn explicit_push_url_cannot_be_redirected_again_by_push_instead_of() {
        let f = Fixture::new();
        let decoy = tempfile::tempdir().unwrap();
        git::run(decoy.path(), &["init", "--bare", "-q"]).unwrap();
        let intended = f.remote.path().to_str().unwrap();
        git::run(
            f.local.path(),
            &["config", "remote.origin.pushurl", intended],
        )
        .unwrap();
        let rewrite = format!("url.{}.pushInsteadOf", decoy.path().display());
        git::run(f.local.path(), &["config", &rewrite, intended]).unwrap();
        let receipt = f.preserve().unwrap();
        assert!(receipt.pushed);
        assert_eq!(f.backup(), Some(receipt.head));
        assert!(
            git::run(decoy.path(), &["for-each-ref", "--format=%(refname)"])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn linked_try_checkout_uses_its_head_and_leaves_repository_head_unchanged() {
        let f = Fixture::new();
        let main = head(f.local.path()).unwrap();
        let parent = tempfile::tempdir().unwrap();
        let checkout = parent.path().join("try");
        git::run(
            f.local.path(),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "try",
                checkout.to_str().unwrap(),
            ],
        )
        .unwrap();
        std::fs::write(checkout.join("try.txt"), "worker work\n").unwrap();
        git::run(&checkout, &["add", "try.txt"]).unwrap();
        git::run(&checkout, &["commit", "-qm", "worker commit"]).unwrap();
        let expected = head(&checkout).unwrap();
        let receipt = preserve_try(f.local.path(), &checkout, "run-123", "worker", 2).unwrap();
        assert_eq!(receipt.head, expected);
        assert_eq!(f.backup(), Some(expected));
        assert_eq!(head(f.local.path()).unwrap(), main);
    }

    #[test]
    fn missing_remote_wrong_repository_and_changed_head_fail_closed() {
        let f = Fixture::new();
        let other = Fixture::new();
        assert!(preserve_try(other.local.path(), f.local.path(), "run", "piece", 1).is_err());
        let old = head(f.local.path()).unwrap();
        f.commit("file.txt", "changed\n");
        assert!(check_head(f.local.path(), &old).is_err());
        git::run(f.local.path(), &["remote", "remove", "origin"]).unwrap();
        assert!(f.preserve().is_err());
        assert!(f.local.path().join("file.txt").exists());
        assert!(f.backup().is_none());
    }

    #[test]
    fn broken_nested_checkout_cannot_receive_a_receipt_for_its_parent_head() {
        let f = Fixture::new();
        let checkout = f.local.path().join(".raccoon/worktrees/try");
        git::run(
            f.local.path(),
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "try",
                checkout.to_str().unwrap(),
            ],
        )
        .unwrap();
        std::fs::write(checkout.join("unique.txt"), "only in the try\n").unwrap();
        git::run(&checkout, &["add", "unique.txt"]).unwrap();
        git::run(&checkout, &["commit", "-qm", "unique try commit"]).unwrap();
        let unique = head(&checkout).unwrap();
        std::fs::remove_file(checkout.join(".git")).unwrap();
        assert_eq!(head(&checkout).unwrap(), head(f.local.path()).unwrap());

        let error = preserve_try(f.local.path(), &checkout, "run-123", "worker", 2)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not an intact worktree"), "{error}");
        assert_eq!(
            git::run(f.local.path(), &["rev-parse", "try"])
                .unwrap()
                .trim(),
            unique
        );
        assert!(checkout.join("unique.txt").exists());
        assert!(f.backup().is_none());
    }

    #[test]
    fn scanner_checks_commit_messages_without_disclosing_credentials() {
        let f = Fixture::new();
        let token = format!("{}{}", "ghp_", "C".repeat(36));
        git::run(f.local.path(), &["commit", "--allow-empty", "-qm", &token]).unwrap();
        let expected = head(f.local.path()).unwrap();
        let error = format!(
            "{:#}",
            scan_unpublished(f.local.path(), &expected, &[]).unwrap_err()
        );
        assert!(error.contains("GitHub token pattern"), "{error}");
        assert!(!error.contains(&token));
        assert_eq!(head(f.local.path()).unwrap(), expected);
        assert!(f.backup().is_none());
    }

    #[test]
    fn scanner_excludes_only_objects_reachable_from_verified_remote_tips() {
        let f = Fixture::new();
        let token = format!("{}{}", "ghp_", "D".repeat(36));
        let published = f.commit("file.txt", &token);
        let current = f.commit("file.txt", "new clean work\n");
        // Directly exercise the scanner's exclusion boundary; the caller
        // obtains these tips only from its freshly fetched remote refs.
        scan_unpublished(f.local.path(), &current, &[published]).unwrap();
        assert!(scan_unpublished(f.local.path(), &current, &[]).is_err());
        assert!(f.backup().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejected_push_retains_local_commit_and_returns_actionable_error() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let hook = f.remote.path().join("hooks/pre-receive");
        std::fs::write(
            &hook,
            "#!/bin/sh\necho 'backup temporarily refused' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let current = head(f.local.path()).unwrap();
        let error = format!("{:#}", f.preserve().unwrap_err());
        assert!(error.contains("keep the checkout"), "{error}");
        assert!(error.contains("backup temporarily refused"), "{error}");
        assert_eq!(head(f.local.path()).unwrap(), current);
        assert!(f.backup().is_none());
        f.assert_no_probe_refs();
    }

    #[cfg(unix)]
    #[test]
    fn head_moving_during_push_does_not_receive_a_preservation_receipt() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let base = head(f.local.path()).unwrap();
        let original = f.commit("file.txt", "head captured before push\n");
        let hook = f.local.path().join(".git/hooks/pre-push");
        std::fs::write(&hook, "#!/bin/sh\ngit update-ref refs/heads/main HEAD~1\n").unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = format!("{:#}", f.preserve().unwrap_err());
        assert!(error.contains("HEAD changed"), "{error}");
        assert_eq!(f.backup(), Some(original));
        assert_eq!(head(f.local.path()).unwrap(), base);
        assert_eq!(
            std::fs::read_to_string(f.local.path().join("file.txt")).unwrap(),
            "head captured before push\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn backup_changed_during_push_is_protected_by_the_exact_lease() {
        use std::os::unix::fs::PermissionsExt;
        let f = Fixture::new();
        let base = f.preserve().unwrap().head;
        let other = f.commit("file.txt", "competing history\n");
        git::run(
            f.local.path(),
            &["push", "origin", "HEAD:refs/heads/competing"],
        )
        .unwrap();
        git::run(f.local.path(), &["reset", "--hard", &base]).unwrap();
        let current = f.commit("file.txt", "current try history\n");
        let hook = f.local.path().join(".git/hooks/pre-push");
        let quoted_remote = format!(
            "'{}'",
            f.remote.path().to_str().unwrap().replace('\'', "'\\''")
        );
        std::fs::write(&hook, format!("#!/bin/sh\ngit --git-dir={quoted_remote} update-ref refs/heads/raccoon/archive/run-123/worker-try2 {other}\n")).unwrap();
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(f.preserve().is_err());
        assert_eq!(f.backup(), Some(other));
        assert_eq!(head(f.local.path()).unwrap(), current);
        f.assert_no_probe_refs();
    }

    #[test]
    fn detached_checkout_with_only_a_remote_tag_still_gets_a_branch_backup() {
        let f = Fixture::new();
        let expected = head(f.local.path()).unwrap();
        git::run(f.local.path(), &["checkout", "--detach", "-q"]).unwrap();
        let receipt = f.preserve().unwrap();
        assert!(receipt.pushed);
        assert_eq!(receipt.head, expected);
        git::run(
            f.remote.path(),
            &["update-ref", "refs/tags/saved", &expected],
        )
        .unwrap();
        git::run(f.remote.path(), &["update-ref", "-d", &receipt.remote_ref]).unwrap();
        let receipt = f.preserve().unwrap();
        assert!(receipt.pushed);
        assert_eq!(receipt.remote_ref, "refs/heads/raccoon/archive/run-123/worker-try2");
        assert_eq!(f.backup(), Some(expected));
    }

    #[test]
    fn detached_checkout_honors_default_push_remote() {
        let f = Fixture::new();
        git::run(f.local.path(), &["remote", "rename", "origin", "archive"]).unwrap();
        git::run(f.local.path(), &["config", "remote.pushDefault", "archive"]).unwrap();
        git::run(f.local.path(), &["checkout", "--detach", "-q"]).unwrap();
        let receipt = f.preserve().unwrap();
        assert!(receipt.pushed);
        assert_eq!(f.backup(), Some(receipt.head));
    }
}
