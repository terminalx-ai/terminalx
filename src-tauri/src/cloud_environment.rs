//! Environment templates at launch (terminalx-saas PRO-15, remote runtime
//! contract section 17).
//!
//! A workspace pinned to an Environment version boots from its image, with
//! every selected repository already checked out at
//! `/home/repos/<owner>/<name>`. The runtime declares `environment-template-v1`
//! on `/refresh` and receives `setup.environment`:
//!
//! `{"versionId":"…","repositories":[{"owner":"…","name":"…","path":"/home/repos/…","ref":"…"}]}`
//!
//! Launch never clones. An entry with a `ref` switches that checkout to the
//! branch, fetching the single ref first only when the image lacks it; an
//! entry without one stays on the built default branch. The outcome goes to
//! `/v1/cloud-workspace-bootstrap/progress` and then to
//! `environment-checkout.json` next to the bootstrap token, where the worker
//! and the local e2e read it. The record is written whatever the API answers:
//! it refuses a report once the operation has settled, and a checkout that is
//! switched again on every start would move a person's branch back. A
//! successful record for the same version is never applied again; a failed
//! one, or one for an earlier version, is retried on the next boot.
//!
//! A checkout the runtime cannot see at all (`unreachable`: the path does not
//! exist for this process, as under a unit with `ProtectHome=true`) is not a
//! failed clone. Nothing is reported for it, and it is tried again on the
//! next boot:
//!
//! `{"versionId":"…","repositories":[{"path":"…","ref":"…","fetched":false,"state":"switched"}],"durationMs":<n>}`

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const GIT_TIMEOUT: Duration = Duration::from_secs(10);
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
/// The whole checkout runs before any agent starts, so it is bounded: what
/// has not finished by then is reported as `timed-out`.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(120);
const REPOSITORY_ROOT: &str = "/home/repos/";
const MAX_REPOSITORIES: usize = 64;
/// The checkout's directory cannot be opened by this process.
const UNREACHABLE: &str = "unreachable";

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub version_id: String,
    pub repositories: Vec<Repository>,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Repository {
    pub path: String,
    #[serde(default, rename = "ref")]
    pub reference: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Checkout {
    pub path: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched: Option<bool>,
    pub state: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Record<'a> {
    version_id: &'a str,
    repositories: &'a [Checkout],
    duration_ms: u128,
}

/// The outcome of a checkout, reported before it is recorded.
pub struct Applied {
    /// The progress code to report; `None` when there is nothing to say
    /// (a checkout this process cannot see is neither ready nor failed).
    pub code: Option<&'static str>,
    record: Vec<u8>,
}

impl Applied {
    fn of(version_id: &str, repositories: &[Checkout], duration: Duration) -> Self {
        let record = Record { version_id, repositories, duration_ms: duration.as_millis() };
        Applied { code: progress_code(repositories), record: serde_json::to_vec(&record).unwrap_or_default() }
    }

    /// Report the outcome, when there is one to report, then record it
    /// whatever the API answered: a refused or lost report must not make the
    /// next start switch the checkout again.
    pub fn settle(&self, record_path: &Path, report: impl FnOnce(&'static str) -> Result<(), String>) {
        if let Some(code) = self.code {
            if let Err(error) = report(code) {
                log::warn!("report the environment checkout: {error}");
            }
        }
        self.commit(record_path);
    }

    /// Record the outcome, so a successful version is not applied again.
    pub fn commit(&self, record_path: &Path) {
        if let Err(error) = crate::cloud_bootstrap::write_durable(record_path, &self.record) {
            log::warn!("record the environment checkout at {}: {error:#}", record_path.display());
        }
    }
}

/// What the checkouts amount to: a failure when git failed anywhere,
/// nothing while any checkout is out of this process's sight, ready otherwise.
fn progress_code(repositories: &[Checkout]) -> Option<&'static str> {
    if repositories.iter().any(|item| !succeeded(item.state) && item.state != UNREACHABLE) {
        Some("repository-clone-failed")
    } else if repositories.iter().any(|item| item.state == UNREACHABLE) {
        None
    } else {
        Some("repository-ready")
    }
}

/// `setup.environment` of a refresh, kept unparsed until it is applied.
pub fn raw(setup: &serde_json::Value) -> Option<serde_json::Value> {
    setup.get("environment").cloned()
}

pub fn parse(environment: &serde_json::Value) -> Option<Environment> {
    match serde_json::from_value::<Environment>(environment.clone()) {
        Ok(environment) if environment.repositories.len() <= MAX_REPOSITORIES => Some(environment),
        Ok(_) => {
            log::warn!("the environment setup lists too many repositories; ignored");
            None
        }
        Err(error) => {
            log::warn!("unreadable environment setup: {error}");
            None
        }
    }
}

fn succeeded(state: &str) -> bool {
    matches!(state, "ready" | "switched")
}

/// Whether `environment` still has to be applied: no successful record of
/// this version exists at `record_path`.
pub fn pending(environment: &Environment, record_path: &Path) -> bool {
    let Some(record) = std::fs::read(record_path).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok()) else {
        return true;
    };
    let ok = record["repositories"].as_array().is_some_and(|items| items.iter().all(|item| item["state"].as_str().is_some_and(succeeded)));
    !(ok && record["versionId"] == environment.version_id.as_str())
}

/// Switch every checkout of `environment`, within [`TOTAL_TIMEOUT`].
pub fn apply(environment: &Environment) -> Applied {
    let started = Instant::now();
    let deadline = started + TOTAL_TIMEOUT;
    let repositories: Vec<Checkout> = environment.repositories.iter().map(|repository| checkout(repository, deadline)).collect();
    for item in repositories.iter().filter(|item| !succeeded(item.state)) {
        log::warn!("environment checkout {}: {}", item.path, item.state);
    }
    Applied::of(&environment.version_id, &repositories, started.elapsed())
}

fn checkout(repository: &Repository, deadline: Instant) -> Checkout {
    if !valid_repository_path(&repository.path) {
        return Checkout { path: repository.path.clone(), reference: repository.reference.clone(), fetched: None, state: "missing" };
    }
    switch_in(&repository.path, repository.reference.as_deref(), deadline)
}

fn switch_in(path: &str, reference: Option<&str>, deadline: Instant) -> Checkout {
    let result = |fetched: Option<bool>, state| Checkout { path: path.to_string(), reference: reference.map(str::to_string), fetched, state };
    let git = |args: &[&str], timeout: Duration| -> Option<bool> {
        let left = deadline.saturating_duration_since(Instant::now());
        (!left.is_zero()).then(|| git(path, args, timeout.min(left)))
    };
    if Instant::now() >= deadline {
        return result(None, "timed-out");
    }
    // Not there, or hidden from this process (a sandboxed unit): git never
    // ran, so this is not a failed checkout.
    if std::fs::read_dir(path).is_err() {
        return result(None, UNREACHABLE);
    }
    if !git(&["rev-parse", "HEAD"], GIT_TIMEOUT).unwrap_or(false) {
        return result(None, "missing");
    }
    let Some(reference) = reference else {
        return result(None, "ready");
    };
    if !valid_ref(reference) {
        return result(None, "invalid-ref");
    }
    let local = format!("refs/heads/{reference}");
    let tracking = format!("refs/remotes/origin/{reference}");
    let has = |name: &str| git(&["rev-parse", "--verify", "--quiet", name], GIT_TIMEOUT);
    let mut fetched = false;
    let (Some(has_local), Some(has_tracking)) = (has(&local), has(&tracking)) else { return result(None, "timed-out") };
    if !has_local && !has_tracking {
        fetched = true;
        match git(&["fetch", "origin", &format!("+{local}:{tracking}")], FETCH_TIMEOUT) {
            Some(true) => {}
            Some(false) => return result(Some(fetched), "fetch-failed"),
            None => return result(Some(fetched), "timed-out"),
        }
    }
    let switched = match has(&local) {
        Some(true) => git(&["switch", reference], GIT_TIMEOUT),
        Some(false) => git(&["switch", "--create", reference, "--track", &format!("origin/{reference}")], GIT_TIMEOUT),
        None => None,
    };
    match switched {
        Some(true) => result(Some(fetched), "switched"),
        Some(false) => result(Some(fetched), "switch-failed"),
        None => result(Some(fetched), "timed-out"),
    }
}

/// `/home/repos/<owner>/<name>`, with a GitHub-shaped owner and name.
fn valid_repository_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix(REPOSITORY_ROOT) else { return false };
    let mut parts = rest.split('/');
    let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else { return false };
    (1..=39).contains(&owner.len())
        && owner.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && (1..=100).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        && name != "."
        && name != ".."
}

/// The subset of `git check-ref-format --branch` names the server sends.
fn valid_ref(reference: &str) -> bool {
    (1..=200).contains(&reference.len())
        && reference.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-'))
        && !reference.starts_with('-')
        && !reference.ends_with('.')
        && reference.split('/').all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
        && !reference.contains("..")
}

/// Run git in `path` without a prompt. After `timeout` its whole process
/// group is killed, so a hung fetch leaves no transport or credential helper
/// behind.
fn git(path: &str, args: &[&str], timeout: Duration) -> bool {
    let mut command = Command::new("git");
    command.arg("-C").arg(path).args(args).env("GIT_TERMINAL_PROMPT", "0").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let Ok(mut child) = command.spawn() else { return false };
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                #[cfg(unix)]
                // SAFETY: signals the process group this function just created.
                unsafe {
                    libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    /// A bare remote with `main` and `feature/x`, cloned (main only) as the
    /// image's checkout, and a third branch only the remote has.
    fn fixture() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let (remote, seed) = (root.join("remote.git"), root.join("seed"));
        std::fs::create_dir_all(&seed).unwrap();
        run(root, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        run(&seed, &["init", "-q"]);
        std::fs::write(seed.join("README.md"), "x\n").unwrap();
        run(&seed, &["add", "."]);
        run(&seed, &["commit", "-qm", "init"]);
        run(&seed, &["push", "-q", remote.to_str().unwrap(), "main"]);
        run(&seed, &["push", "-q", remote.to_str().unwrap(), "main:feature/x"]);
        let checkout = root.join("checkout");
        run(root, &["clone", "-q", remote.to_str().unwrap(), checkout.to_str().unwrap()]);
        run(&seed, &["push", "-q", remote.to_str().unwrap(), "main:late"]);
        let path = checkout.to_str().unwrap().to_string();
        (dir, path)
    }

    fn later() -> Instant {
        Instant::now() + TOTAL_TIMEOUT
    }

    fn current_branch(path: &str) -> String {
        let output = Command::new("git").args(["-C", path, "branch", "--show-current"]).output().unwrap();
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn reads_the_environment_from_setup() {
        let setup = json!({ "version": 1, "credentials": [], "environment": {
            "versionId": "v1",
            "repositories": [{ "owner": "acme", "name": "widgets", "path": "/home/repos/acme/widgets", "ref": "feature/x" }]
        }});
        let environment = parse(&raw(&setup).unwrap()).unwrap();
        assert_eq!(environment.version_id, "v1");
        assert_eq!(environment.repositories[0].reference.as_deref(), Some("feature/x"));
        assert!(raw(&json!({ "version": 1, "credentials": [] })).is_none());
        assert!(parse(&json!({ "versionId": 1 })).is_none());
    }

    #[test]
    fn repository_paths_and_refs_are_checked_before_git_runs() {
        assert!(valid_repository_path("/home/repos/acme/widgets"));
        assert!(valid_repository_path("/home/repos/a-b/c.d_e"));
        for bad in ["/home/repos/acme", "/home/repos/acme/widgets/x", "/home/repos/../etc", "/home/repos/acme/..", "/tmp/acme/widgets", "/home/repos/ac me/w"] {
            assert!(!valid_repository_path(bad), "{bad}");
        }
        assert!(valid_ref("feature/fast-launch"));
        for bad in ["", "-x", "a..b", "/a", "a/", "a b", "a~1", "a.lock", "a/.b", "a//b", "x.", ".x", "a/b.lock/c"] {
            assert!(!valid_ref(bad), "{bad}");
        }
    }

    #[test]
    fn switches_to_a_branch_the_image_has_without_fetching() {
        let (_dir, path) = fixture();
        let item = switch_in(&path, Some("feature/x"), later());
        assert_eq!((item.state, item.fetched), ("switched", Some(false)));
        assert_eq!(current_branch(&path), "feature/x");
    }

    #[test]
    fn fetches_only_a_ref_the_image_lacks() {
        let (_dir, path) = fixture();
        let item = switch_in(&path, Some("late"), later());
        assert_eq!((item.state, item.fetched), ("switched", Some(true)));
        assert_eq!(current_branch(&path), "late");
        let missing = switch_in(&path, Some("nowhere"), later());
        assert_eq!((missing.state, missing.fetched), ("fetch-failed", Some(true)));
    }

    #[test]
    fn stays_on_the_default_branch_without_a_ref() {
        let (_dir, path) = fixture();
        let item = switch_in(&path, None, later());
        assert_eq!((item.state, item.fetched), ("ready", None));
        assert_eq!(current_branch(&path), "main");
    }

    #[test]
    fn a_passed_deadline_times_out_instead_of_running_git() {
        let (_dir, path) = fixture();
        let item = switch_in(&path, Some("feature/x"), Instant::now());
        assert_eq!(item.state, "timed-out");
        assert_eq!(current_branch(&path), "main");
    }

    #[test]
    fn only_a_successful_record_of_the_same_version_is_final() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("environment-checkout.json");
        let environment = |version: &str| Environment {
            version_id: version.into(),
            repositories: vec![Repository { path: "/home/repos/acme/not-there".into(), reference: Some("main".into()) }],
        };
        assert!(pending(&environment("v1"), &record));
        let failed = Applied::of("v1", &[Checkout { path: "/home/repos/acme/widgets".into(), reference: Some("main".into()), fetched: Some(false), state: "switch-failed" }], Duration::ZERO);
        assert_eq!(failed.code, Some("repository-clone-failed"));
        failed.commit(&record);
        let written: serde_json::Value = serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
        assert_eq!(written["versionId"], "v1");
        assert_eq!(written["repositories"][0], json!({ "path": "/home/repos/acme/widgets", "ref": "main", "fetched": false, "state": "switch-failed" }));
        assert!(pending(&environment("v1"), &record), "a failed checkout is retried");
        std::fs::write(&record, json!({ "versionId": "v1", "repositories": [{ "path": "x", "state": "switched" }] }).to_string()).unwrap();
        assert!(!pending(&environment("v1"), &record));
        assert!(pending(&environment("v2"), &record), "a new version is applied");
    }

    /// A unit with `ProtectHome=true` hides `/home/repos`: the runtime never
    /// ran git there, so it reports nothing instead of a failed clone.
    #[test]
    fn a_checkout_out_of_sight_is_not_reported_as_a_failed_clone() {
        let dir = tempfile::tempdir().unwrap();
        let record = dir.path().join("environment-checkout.json");
        let hidden = dir.path().join("hidden");
        let gone = switch_in(hidden.to_str().unwrap(), Some("main"), later());
        assert_eq!((gone.state, gone.fetched), (UNREACHABLE, None));
        // There, but not a checkout: git ran and failed, which is a failure.
        std::fs::create_dir(&hidden).unwrap();
        assert_eq!(switch_in(hidden.to_str().unwrap(), Some("main"), later()).state, "missing");

        let environment = Environment {
            version_id: "v1".into(),
            repositories: vec![Repository { path: "/home/repos/acme/not-visible-here".into(), reference: Some("main".into()) }],
        };
        let applied = apply(&environment);
        assert_eq!(applied.code, None);
        let mut reports = 0;
        applied.settle(&record, |_| {
            reports += 1;
            Ok(())
        });
        assert_eq!(reports, 0, "nothing is reported");
        let written: serde_json::Value = serde_json::from_slice(&std::fs::read(&record).unwrap()).unwrap();
        assert_eq!(written["repositories"][0], json!({ "path": "/home/repos/acme/not-visible-here", "ref": "main", "state": "unreachable" }));
        assert!(pending(&environment, &record), "tried again on the next boot");

        let item = |state| Checkout { path: "p".into(), reference: None, fetched: None, state };
        assert_eq!(progress_code(&[item("switched"), item("ready")]), Some("repository-ready"));
        assert_eq!(progress_code(&[item("switched"), item(UNREACHABLE)]), None);
        assert_eq!(progress_code(&[item(UNREACHABLE), item("fetch-failed")]), Some("repository-clone-failed"));
    }

    /// The API refuses a report once the operation has settled. The record
    /// is written all the same, so the next start does not switch the
    /// checkout again and move a person's branch back.
    #[test]
    fn a_successful_checkout_is_recorded_even_when_its_report_is_refused() {
        let (dir, path) = fixture();
        let record = dir.path().join("environment-checkout.json");
        let environment = Environment { version_id: "v1".into(), repositories: vec![Repository { path: path.clone(), reference: Some("feature/x".into()) }] };
        let applied = Applied::of("v1", &[switch_in(&path, Some("feature/x"), later())], Duration::ZERO);
        let mut reported = Vec::new();
        applied.settle(&record, |code| {
            reported.push(code);
            Err("rejected".into())
        });
        assert_eq!(reported, vec!["repository-ready"]);
        assert!(!pending(&environment, &record), "the refused report does not undo the record");
        // The person moves on; a restart leaves their branch alone.
        run(Path::new(&path), &["switch", "-q", "main"]);
        assert!(!pending(&environment, &record));
        assert_eq!(current_branch(&path), "main");
    }
}
