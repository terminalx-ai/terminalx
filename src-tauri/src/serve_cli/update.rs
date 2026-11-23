//! `terminalx-serve update`: install the newest signed runtime release next
//! to the running one and hand the running runtime over to it in place
//! (PRO-353), and the helper a machine's runtime runs for `machine.update`
//! (PRO-354, docs/MACHINES.md "Versions and updates").
//!
//! It checks exactly what `scripts/install/install.sh` checks, with the key
//! compiled in here ([`super::RUNTIME_SIGNING_KEY`]): `SHA256SUMS` must carry
//! a good SSH signature (`ssh-keygen -Y verify`), and the binary and
//! `terminalx-serve.json` must match it. A release without a signature, or
//! with a bad one, is refused, and nothing under `~/.terminalx` changes until
//! every check has passed.
//!
//! Then, in order ([`Update::run`]):
//!
//! 1. the new version goes in `versions/<version>`; `current` stays;
//! 2. **trial**: it is started on a scratch data directory and must answer
//!    as ready, with its version, within 60 s; one that does not is removed;
//! 3. the running runtime is **handed over** to it in place
//!    (`super::handover`, #765), stopping only the work named in `--stop`;
//! 4. **ready**: the runtime now answering must say the new version within
//!    90 s, and only then does `current` move to it;
//! 5. **rollback** otherwise: `current` stays, the service is restarted on the
//!    old version, and the record says `failed`, `rolledBack`;
//! 6. **clean up**: `current` and the two versions before it stay, in
//!    `versions/` and as installed runtimes in the data directory.
//!
//! Each step is written to the update record (`<data>/run/machine-update.json`,
//! `remote::machine_update`), which the runtime sends to `machine/3`
//! connections as `machine.updateChanged`.
//!
//! The installer's test settings work here too, each with a warning:
//! `TERMINALX_INSTALL_API_URL`, `TERMINALX_INSTALL_BASE_URL` and
//! `TERMINALX_INSTALL_ALLOWED_SIGNERS` (a file in `allowed_signers` form).

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use super::{RUNTIME_SIGNING_KEY, SIGNATURE_NAMESPACE, SIGNER_PRINCIPAL};
use crate::remote::machine_update::{self as record, Progress, Record};

const USAGE: &str = "\
Usage: terminalx-serve update [--check] [--data-dir <dir>]

Install the newest signed TerminalX runtime and hand the running one over to
it, keeping its agents and terminals running.
Its signature is checked against the TerminalX release key first; a release
that is not signed, or does not verify, is refused. The new version is first
started on its own to check that it runs; the running one moves to it only
then, and goes back to the old version if it does not come up. The two
versions before it stay in ~/.terminalx/versions.

  --check   Only say whether a newer signed runtime is available

The runtime itself runs `update --apply <version> --status <file> [--stop <id>]`
when another computer updates this machine.";

const DEFAULT_API_URL: &str = "https://api.github.com/repos/terminalx-ai/terminalx/releases?per_page=100";
const DEFAULT_BASE_URL: &str = "https://github.com/terminalx-ai/terminalx/releases/download";
const SUMS: &str = "SHA256SUMS";
const SIGNATURE: &str = "SHA256SUMS.sig";
const MANIFEST: &str = "terminalx-serve.json";
/// Largest download accepted: the runtime binary is well under this.
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;
/// A new version must answer on a scratch data directory within this.
const TRIAL_WITHIN: Duration = Duration::from_secs(60);
/// The runtime that took over must say the new version within this.
#[cfg(unix)]
const READY_WITHIN: Duration = Duration::from_secs(90);
/// Versions kept below `current` (so at most three in all).
const KEEP_BELOW_CURRENT: usize = 2;

/// Run `terminalx-serve update` with the arguments after its name.
pub fn run(args: &[String]) -> i32 {
    match update(args) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("terminalx-serve update: {error:#}");
            1
        }
    }
}

/// What the command line asks for.
#[derive(Debug, PartialEq)]
enum Mode {
    Newest,
    Check,
    /// The runtime's helper: this version, reported to `status`, stopping
    /// the blockers named.
    Apply { version: semver::Version, status: PathBuf, stop: Vec<String> },
    Help,
}

fn parse(rest: &[String]) -> Option<Mode> {
    match rest.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] => return Some(Mode::Newest),
        ["--check"] => return Some(Mode::Check),
        ["-h" | "--help" | "help"] => return Some(Mode::Help),
        _ => {}
    }
    let (mut version, mut status, mut stop) = (None, None, Vec::new());
    let mut args = rest.iter();
    while let Some(arg) = args.next() {
        let value = args.next().filter(|value| !value.is_empty())?;
        match arg.as_str() {
            "--apply" => version = Some(semver::Version::parse(value).ok()?),
            "--status" => status = Some(PathBuf::from(value)),
            "--stop" => stop.push(value.clone()),
            _ => return None,
        }
    }
    Some(Mode::Apply { version: version?, status: status?, stop })
}

fn update(args: &[String]) -> Result<i32> {
    let (flag, rest) = super::take_data_dir(args)?;
    let Some(mode) = parse(&rest) else {
        eprintln!("{USAGE}");
        return Ok(2);
    };
    if mode == Mode::Help {
        println!("{USAGE}");
        return Ok(0);
    }
    let data = super::resolve_data_dir(flag.as_deref())?;
    let root = super::install_root()?;
    if let Mode::Apply { version, status, stop } = mode {
        return Ok(apply_requested(&root, &data, &version, &status, &stop));
    }
    let installed = installed_version(&root)?;
    let source = Source::from_env();
    let asset = asset_name()?;
    let agent = crate::data_privacy::http_agent().timeout(std::time::Duration::from_secs(300)).build();
    let fetch = |url: &str| download(&agent, url);

    let releases = fetch(&source.api_url).with_context(|| format!("list releases from {}", source.api_url))?;
    let Some(newest) = newest_signed(&releases, asset)? else {
        bail!("no signed TerminalX runtime release with {asset} was found; try again later");
    };
    if newest.version <= installed {
        println!("terminalx-serve {installed} is installed, and it is the newest signed runtime.");
        // A runtime still running an older version (an update that had to
        // wait for its work) takes this one over now.
        #[cfg(unix)]
        {
            let current = root.join("current").join("terminalx-serve");
            let outcome = super::handover::hand_over(&data, &current, &installed.to_string())?;
            if outcome != super::handover::Outcome::Current && outcome != super::handover::Outcome::NotRunning {
                return Ok(if super::handover::report(&outcome, &installed.to_string()) { 0 } else { 1 });
            }
        }
        return Ok(0);
    }
    if mode == Mode::Check {
        println!("terminalx-serve {} is available ({}); {installed} is installed. Run `terminalx-serve update` to install it.", newest.version, newest.tag);
        return Ok(0);
    }
    let path = record::status_path(&data);
    if let Some(busy) = under_way(&path, &data) {
        bail!("{busy}");
    }
    println!("Updating terminalx-serve {installed} to {} ({})...", newest.version, newest.tag);
    let mut reporter = Reporter::open(&path, &data, &root);
    let ended = Update { root: &root, data: &data, source: &source, asset, fetch: &fetch, release: &newest, stop: &[], steps: &STEPS }.run(&mut reporter);
    Ok(if ended == Ended::Updated { 0 } else { 1 })
}

/// An update another process runs now, said for a person.
fn under_way(path: &Path, data: &Path) -> Option<String> {
    let mut record = record::read_record(path);
    let running = running_version(data).map_or_else(|| record::own_version().to_string(), |version| version.to_string());
    record::settle(&mut record, &running, record::now_ms(), record::helper_alive);
    record.progress.under_way().then(|| format!("an update of this machine is under way ({:?}); try again when it has finished", record.progress))
}

/// `update --apply`: the update `machine.update` asked for, reported to
/// `status`. The runtime decided it may run; this only refuses one already
/// run by another live helper.
fn apply_requested(root: &Path, data: &Path, version: &semver::Version, status: &Path, stop: &[String]) -> i32 {
    let mut reporter = Reporter::open(status, data, root);
    if let Some(pid) = record::read_record(status).helper_pid.filter(|pid| *pid != std::process::id() && record::helper_alive(*pid)) {
        eprintln!("terminalx-serve update: helper pid {pid} is updating this machine already");
        return 1;
    }
    let source = Source::from_env();
    let found = (|| -> Result<(Release, &'static str)> {
        let asset = asset_name()?;
        let agent = crate::data_privacy::http_agent().timeout(std::time::Duration::from_secs(300)).build();
        let releases = download(&agent, &source.api_url).with_context(|| format!("list releases from {}", source.api_url))?;
        let release = signed_releases(&releases, asset)?.into_iter().filter(|release| release.version == *version).max_by_key(|release| release.built);
        Ok((release.ok_or_else(|| anyhow!("there is no signed TerminalX runtime release {version} with {asset}"))?, asset))
    })();
    let (release, asset) = match found {
        Ok(found) => found,
        Err(error) => {
            reporter.failed(&version.to_string(), format!("The update to {version} could not start: {error:#}; nothing was changed."), false);
            return 1;
        }
    };
    let agent = crate::data_privacy::http_agent().timeout(std::time::Duration::from_secs(300)).build();
    let fetch = |url: &str| download(&agent, url);
    let ended = Update { root, data, source: &source, asset, fetch: &fetch, release: &release, stop, steps: &STEPS }.run(&mut reporter);
    i32::from(ended != Ended::Updated)
}

/// The version of the runtime answering for `data` now.
fn running_version(data: &Path) -> Option<semver::Version> {
    #[cfg(unix)]
    {
        crate::local_runtime::client::Client::connect(data).ok().and_then(|client| client.build().version.clone())
    }
    #[cfg(not(unix))]
    {
        let _ = data;
        None
    }
}

/// Writes each step to the update record, and says it.
struct Reporter {
    path: PathBuf,
    record: Record,
}

impl Reporter {
    /// The record at `path`, taken over by this process: `from` is what runs now.
    fn open(path: &Path, data: &Path, root: &Path) -> Self {
        let kept = record::read_record(path);
        let from = running_version(data).or_else(|| installed_version(root).ok()).map(|version| version.to_string()).or(kept.from.clone());
        let record = Record { progress: kept.progress, from, helper_pid: Some(std::process::id()), app_available: kept.app_available, app_checked_at: kept.app_checked_at };
        Self { path: path.to_path_buf(), record }
    }

    fn from(&self) -> String {
        self.record.from.clone().unwrap_or_else(|| record::own_version().to_string())
    }

    fn write(&self) {
        if let Err(error) = record::write_record(&self.path, &self.record) {
            eprintln!("terminalx-serve update: keep the update's progress in {}: {error:#}", self.path.display());
        }
    }

    /// A step under way.
    fn phase(&mut self, progress: Progress, said: &str) {
        println!("{said}");
        self.record.progress = progress;
        self.record.helper_pid = Some(std::process::id());
        self.write();
    }

    /// How it ended: nothing of this process runs it any more.
    fn ended(&mut self, progress: Progress) {
        self.record.progress = progress;
        self.record.helper_pid = None;
        self.write();
    }

    fn failed(&mut self, version: &str, message: String, rolled_back: bool) {
        eprintln!("terminalx-serve update: {message}");
        let running = self.from();
        self.ended(Progress::Failed { version: version.to_string(), at: record::now_ms(), message, running, rolled_back });
    }
}

/// How an update ended.
#[derive(Debug, PartialEq, Eq)]
enum Ended {
    Updated,
    Failed { rolled_back: bool },
}

/// The steps of an update that start or touch a runtime, in one place so a
/// test can have the new runtime fail after the handover ([`STEPS`] is what
/// every update runs).
struct Steps {
    /// Start the new binary on a scratch data directory: [`trial`].
    trial: fn(&Path, &semver::Version, &Path) -> Result<()>,
    /// Hand the running runtime over: `super::handover::begin`.
    #[cfg(unix)]
    begin: fn(&Path, &Path, &[String]) -> Result<super::handover::Handed>,
    /// The runtime that took over says the new version: [`ready`].
    #[cfg(unix)]
    ready: fn(&Path, &str, &semver::Version) -> Result<()>,
    /// Run the version `current` names again: [`restart`].
    #[cfg_attr(not(unix), allow(dead_code))]
    restart: fn(&Path, &Path) -> Result<()>,
}

const STEPS: Steps = Steps {
    trial,
    #[cfg(unix)]
    begin: super::handover::begin,
    #[cfg(unix)]
    ready,
    restart,
};

/// One update of the install at `root`, whose runtime keeps its data in `data`.
struct Update<'a> {
    root: &'a Path,
    data: &'a Path,
    source: &'a Source,
    asset: &'a str,
    fetch: &'a dyn Fn(&str) -> Result<Vec<u8>>,
    release: &'a Release,
    /// Blocker ids (`machine_update::Blocker::of`) agreed to stop.
    #[cfg_attr(not(unix), allow(dead_code))]
    stop: &'a [String],
    steps: &'a Steps,
}

impl Update<'_> {
    fn run(&self, reporter: &mut Reporter) -> Ended {
        let version = self.release.version.to_string();
        // Each phase says when it began.
        let phase = |name: fn(String, i64) -> Progress| name(version.clone(), record::now_ms());
        reporter.phase(phase(|version, since| Progress::Downloading { version, since }), &format!("Downloading terminalx-serve {version} ({})...", self.release.tag));
        let installed = {
            let mut verifying = || reporter.phase(phase(|version, since| Progress::Verifying { version, since }), "Checking its signature and hashes...");
            install(self.root, self.source, self.release, self.asset, self.fetch, &mut verifying)
        };
        let dest = match installed {
            Ok(dest) => dest,
            Err(error) => {
                reporter.failed(&version, format!("{error:#}"), false);
                return Ended::Failed { rolled_back: false };
            }
        };
        let binary = dest.join("terminalx-serve");
        let from = reporter.from();
        reporter.phase(phase(|version, since| Progress::Trial { version, since }), "Starting it on its own to check it runs...");
        if let Err(error) = (self.steps.trial)(&binary, &self.release.version, self.data) {
            remove_version(self.root, &dest);
            reporter.failed(&version, format!("TerminalX {version} did not start: {error:#}. Nothing was changed; {from} keeps running."), false);
            return Ended::Failed { rolled_back: false };
        }
        reporter.phase(phase(|version, since| Progress::HandingOver { version, since }), "Handing the running runtime over to it...");
        #[cfg(unix)]
        match (self.steps.begin)(self.data, &binary, self.stop).map_err(|error| format!("{error:#}")) {
            Err(error) | Ok(super::handover::Handed::Refused(error)) => {
                remove_version(self.root, &dest);
                reporter.failed(&version, format!("{error}. Nothing was changed; {from} keeps running."), false);
                return Ended::Failed { rolled_back: false };
            }
            Ok(super::handover::Handed::NotRunning) => println!("The runtime is not running; it starts as terminalx-serve {version}."),
            Ok(super::handover::Handed::Exec { epoch }) => {
                if let Err(error) = (self.steps.ready)(self.data, &epoch, &self.release.version) {
                    remove_version(self.root, &dest);
                    // Said first: restarting the service may end this process too.
                    let message = format!("TerminalX {version} did not come up after the handover ({error:#}). {from} was started again; its agents and terminals restarted.");
                    reporter.failed(&version, message, true);
                    if let Err(error) = (self.steps.restart)(self.root, self.data) {
                        reporter.failed(&version, format!("TerminalX {version} did not come up after the handover, and {from} could not be started again ({error:#}); start it with `terminalx-serve service install`."), true);
                    }
                    return Ended::Failed { rolled_back: true };
                }
                println!("The running runtime now is terminalx-serve {version}; its agents and terminals kept running.");
            }
        }
        if let Err(error) = swap_link(&self.root.join("current"), &Path::new("versions").join(&version)) {
            // It runs, but the service would start the old one next time.
            reporter.ended(Progress::Failed {
                version: version.clone(),
                at: record::now_ms(),
                message: format!("TerminalX {version} runs, but {} could not be pointed at it ({error:#}); run `terminalx-serve update` again.", self.root.join("current").display()),
                running: version.clone(),
                rolled_back: false,
            });
            return Ended::Failed { rolled_back: false };
        }
        reporter.phase(phase(|version, since| Progress::CleaningUp { version, since }), "Removing old versions...");
        match prune(self.root, self.data, running_version(self.data).as_ref()) {
            Ok(kept) => println!("Kept {}.", kept.iter().map(ToString::to_string).collect::<Vec<_>>().join(", ")),
            Err(error) => eprintln!("terminalx-serve update: remove old versions: {error:#}"),
        }
        reporter.ended(Progress::Updated { from, to: version, at: record::now_ms() });
        Ended::Updated
    }
}

/// Remove a version folder this update made, unless `current` names it.
fn remove_version(root: &Path, dest: &Path) {
    let named = std::fs::read_link(root.join("current")).ok().and_then(|target| crate::paths::canonicalize(root.join(target)).ok());
    if named.is_some() && named == crate::paths::canonicalize(dest).ok() {
        return;
    }
    if let Err(error) = std::fs::remove_dir_all(dest) {
        eprintln!("terminalx-serve update: remove {}: {error}", dest.display());
    }
}

/// Start `binary` on a scratch data directory and wait until it answers as
/// version `version`; stop it either way.
fn trial(binary: &Path, version: &semver::Version, data: &Path) -> Result<()> {
    #[cfg(not(unix))]
    let _ = version;
    // Its sockets go under `<scratch>/data/run/`, which must fit.
    let scratch = tempfile::Builder::new().prefix("trial-").tempdir_in(data.join("run")).ok().filter(|dir| super::check_socket_room(&dir.path().join("data")).is_ok());
    let scratch = match scratch {
        Some(scratch) => scratch,
        None => tempfile::Builder::new().prefix("tx-trial-").tempdir_in("/tmp").context("make a scratch data directory")?,
    };
    let home = scratch.path().join("data");
    let log_path = scratch.path().join("trial.log");
    let log = std::fs::File::create(&log_path)?;
    let mut child = Command::new(binary)
        .args(["--runtime-kind", "local", "--data-dir"])
        .arg(&home)
        .env_remove("TERMINALX_LOCAL_DESKTOP")
        .env_remove("TERMINALX_LOCAL_APPLICATION")
        .env_remove("TERMINALX_HOME")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .spawn()
        .with_context(|| format!("start {}", binary.display()))?;
    let deadline = Instant::now() + TRIAL_WITHIN;
    let outcome = loop {
        if let Some(status) = child.try_wait()? {
            break Err(anyhow!("it exited ({status}) before it answered{}", tail(&log_path)));
        }
        #[cfg(unix)]
        if let Ok(client) = crate::local_runtime::client::Client::connect(&home) {
            break match client.build().version.as_ref() {
                Some(said) if said == version => Ok(()),
                said => Err(anyhow!("it answered as version {}, not {version}", said.map_or_else(|| "unknown".to_string(), ToString::to_string))),
            };
        }
        if Instant::now() >= deadline {
            break Err(anyhow!("it did not answer within {} seconds{}", TRIAL_WITHIN.as_secs(), tail(&log_path)));
        }
        std::thread::sleep(Duration::from_millis(200));
    };
    stop_child(&mut child);
    outcome
}

/// The last lines of a log, for an error.
fn tail(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().filter(|line| !line.trim().is_empty()).collect();
    let last = lines[lines.len().saturating_sub(3)..].join(" / ");
    if last.is_empty() {
        String::new()
    } else {
        format!(": {}", last.chars().take(600).collect::<String>())
    }
}

/// End a trial runtime: asked first, then killed.
fn stop_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    if let Ok(pid) = libc::pid_t::try_from(child.id()) {
        // SAFETY: the pid is our own unreaped child's.
        unsafe { libc::kill(pid, libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// The runtime that took over from `epoch` answers, and says it is `version`.
#[cfg(unix)]
fn ready(data: &Path, epoch: &str, version: &semver::Version) -> Result<()> {
    crate::local_runtime::launch::taken_over(data, epoch, READY_WITHIN)?;
    let client = crate::local_runtime::client::Client::connect(data)?;
    match client.build().version.as_ref() {
        Some(said) if said == version => Ok(()),
        said => bail!("the runtime that took over says it is {}, not {version}", said.map_or_else(|| "unknown".to_string(), ToString::to_string)),
    }
}

/// Run the version `current` names again: by the service when one runs
/// this data directory, else directly.
fn restart(root: &Path, data: &Path) -> Result<()> {
    if super::service::restart_for(data)? {
        return Ok(());
    }
    #[cfg(unix)]
    {
        crate::local_runtime::launch::connect_or_start(&root.join("current").join("terminalx-serve"), data).map(drop)
    }
    #[cfg(not(unix))]
    {
        let _ = root;
        bail!("no service runs this data directory")
    }
}

/// Every version folder in `root/versions`, newest first.
pub fn versions_on_disk(root: &Path) -> Vec<semver::Version> {
    let mut versions: Vec<semver::Version> = std::fs::read_dir(root.join("versions"))
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| semver::Version::parse(entry.file_name().to_str()?).ok())
        .collect();
    versions.sort_by(|a, b| b.cmp(a));
    versions
}

/// Keep `current` and the [`KEEP_BELOW_CURRENT`] versions before it, and the
/// one `running` (never removed), in `root/versions`; and in `data/runtime`
/// only the installed runtimes of those and the one the running process
/// executes. Returns what was kept, newest first.
pub fn prune(root: &Path, data: &Path, running: Option<&semver::Version>) -> Result<Vec<semver::Version>> {
    #[cfg(not(unix))]
    let _ = data;
    let current = installed_version(root)?;
    let on_disk = versions_on_disk(root);
    let mut keep = vec![current.clone()];
    keep.extend(on_disk.iter().filter(|version| **version < current).take(KEEP_BELOW_CURRENT).cloned());
    if let Some(running) = running.filter(|running| !keep.contains(running) && on_disk.contains(running)) {
        keep.push(running.clone());
    }
    for version in on_disk.iter().filter(|version| !keep.contains(version)) {
        let folder = root.join("versions").join(version.to_string());
        std::fs::remove_dir_all(&folder).with_context(|| format!("remove {}", folder.display()))?;
    }
    #[cfg(unix)]
    {
        let mut digests = std::collections::HashSet::new();
        for version in &keep {
            if let Ok(mut binary) = std::fs::File::open(root.join("versions").join(version.to_string()).join("terminalx-serve")) {
                if let Ok(digest) = crate::local_runtime::launch::digest(&mut binary) {
                    digests.insert(digest);
                }
            }
        }
        let runtimes = data.join("runtime");
        if let Some(digest) = running_executable(data).and_then(|executable| installed_digest(&runtimes, &executable)) {
            digests.insert(digest);
        }
        for entry in std::fs::read_dir(&runtimes).into_iter().flatten().filter_map(|entry| entry.ok()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            let installed = name.len() == 64 && name.bytes().all(|byte| byte.is_ascii_hexdigit());
            if installed && !digests.contains(&name) && entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                std::fs::remove_dir_all(entry.path()).with_context(|| format!("remove {}", entry.path().display()))?;
            }
        }
    }
    keep.sort_by(|a, b| b.cmp(a));
    Ok(keep)
}

/// The installed runtime (`data/runtime/<digest>/`) `executable` is.
#[cfg(unix)]
fn installed_digest(runtimes: &Path, executable: &Path) -> Option<String> {
    let runtimes = crate::paths::canonicalize(runtimes).ok()?;
    let executable = crate::paths::canonicalize(executable).unwrap_or_else(|_| executable.to_path_buf());
    let inside = executable.strip_prefix(&runtimes).ok()?;
    inside.components().next().map(|digest| digest.as_os_str().to_string_lossy().into_owned())
}

/// The file the runtime answering for `data` executes.
#[cfg(unix)]
fn running_executable(data: &Path) -> Option<PathBuf> {
    let client = crate::local_runtime::client::Client::connect(data).ok()?;
    let pid = client.liveness(Duration::from_secs(5)).ok()?["pid"].as_i64()?;
    executable_of(i32::try_from(pid).ok()?)
}

#[cfg(target_os = "linux")]
fn executable_of(pid: i32) -> Option<PathBuf> {
    let link = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    let text = link.to_string_lossy().into_owned();
    Some(PathBuf::from(text.strip_suffix(" (deleted)").unwrap_or(text.as_str())))
}

#[cfg(target_os = "macos")]
fn executable_of(pid: i32) -> Option<PathBuf> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: the buffer is as long as the size passed.
    let length = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return None;
    }
    buffer.truncate(length as usize);
    Some(PathBuf::from(std::ffi::OsString::from(String::from_utf8(buffer).ok()?)))
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn executable_of(_pid: i32) -> Option<PathBuf> {
    None
}

/// The newest signed runtime release newer than `installed` (`machine/3`'s
/// `available`). Blocking: the network.
pub fn newer_release(installed: &semver::Version) -> Result<Option<semver::Version>> {
    let source = Source::from_env();
    let asset = asset_name()?;
    let agent = crate::data_privacy::http_agent().timeout(std::time::Duration::from_secs(60)).build();
    let releases = download(&agent, &source.api_url).with_context(|| format!("list releases from {}", source.api_url))?;
    Ok(newest_signed(&releases, asset)?.map(|release| release.version).filter(|version| version > installed))
}

/// Where releases come from and whose signature they need.
struct Source {
    api_url: String,
    base_url: String,
    /// `allowed_signers` text.
    signers: String,
}

impl Source {
    fn from_env() -> Self {
        let env = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        let api_url = env("TERMINALX_INSTALL_API_URL");
        let base_url = env("TERMINALX_INSTALL_BASE_URL");
        if api_url.is_some() || base_url.is_some() {
            eprintln!("warning: downloading from a test location; signatures are still checked");
        }
        let signers = match env("TERMINALX_INSTALL_ALLOWED_SIGNERS") {
            Some(path) => {
                eprintln!("warning: trusting the test signing key in {path} instead of the TerminalX release key");
                std::fs::read_to_string(&path).unwrap_or_default()
            }
            None => Self::release_signers(),
        };
        Self {
            api_url: api_url.unwrap_or_else(|| DEFAULT_API_URL.into()),
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.into()).trim_end_matches('/').into(),
            signers,
        }
    }

    fn release_signers() -> String {
        format!("{SIGNER_PRINCIPAL} namespaces=\"{SIGNATURE_NAMESPACE}\" {RUNTIME_SIGNING_KEY}\n")
    }

    fn url(&self, tag: &str, name: &str) -> String {
        format!("{}/{tag}/{name}", self.base_url)
    }
}

/// The release asset for this build's platform.
fn asset_name() -> Result<&'static str> {
    Ok(match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => "terminalx-serve-linux-x64",
        ("linux", "aarch64") => "terminalx-serve-linux-arm64",
        ("macos", "aarch64") => "terminalx-serve-macos-arm64",
        (os, arch) => bail!("there is no TerminalX runtime release for {os} on {arch}"),
    })
}

/// The version `current` points at (`versions/<version>`).
pub fn installed_version(root: &Path) -> Result<semver::Version> {
    let current = root.join("current");
    let target = std::fs::read_link(&current).map_err(|_| {
        anyhow!("{} is not a link to an installed version: this runtime was not installed by the TerminalX installer, so update it the way it was installed", current.display())
    })?;
    let name = target.file_name().and_then(|name| name.to_str()).unwrap_or_default();
    semver::Version::parse(name).map_err(|_| anyhow!("{} points at {}, which is not a version folder", current.display(), target.display()))
}

/// A signed runtime release.
#[derive(Debug, PartialEq, Eq)]
struct Release {
    tag: String,
    version: semver::Version,
    /// The commit time in the tag (`YYYYMMDDHHMMSS`), which orders builds.
    built: u64,
}

/// `runtime-v<version>-<14-digit time>-<7 hex>`, as `release-serve.yml` names
/// tags (the installer's `TAG_PATTERN`).
fn parse_tag(tag: &str) -> Option<Release> {
    let rest = tag.strip_prefix("runtime-v")?;
    let mut parts = rest.split('-');
    let (version, built, commit) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || built.len() != 14 || !built.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if commit.len() != 7 || !commit.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let version = semver::Version::parse(version).ok().filter(|version| version.pre.is_empty() && version.build.is_empty())?;
    Some(Release { tag: tag.into(), version, built: built.parse().ok()? })
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
}

/// Every release in a GitHub releases list that is signed and carries `asset`.
fn signed_releases(list: &[u8], asset: &str) -> Result<Vec<Release>> {
    let releases: Vec<GithubRelease> = serde_json::from_slice(list).context("the releases list is not readable")?;
    Ok(releases
        .into_iter()
        .filter(|release| !release.draft)
        .filter(|release| [asset, SUMS, SIGNATURE, MANIFEST].iter().all(|name| release.assets.iter().any(|carried| carried.name == *name)))
        .filter_map(|release| parse_tag(&release.tag_name))
        .collect())
}

/// The newest release in a GitHub releases list that is signed and carries
/// `asset`, by build time.
fn newest_signed(list: &[u8], asset: &str) -> Result<Option<Release>> {
    Ok(signed_releases(list, asset)?.into_iter().max_by_key(|release| (release.built, release.version.clone())))
}

/// The SHA-256 `SHA256SUMS` lists for `name`, in hex.
fn listed_hash(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, file) = line.split_once(char::is_whitespace)?;
        let file = file.trim_start().trim_start_matches('*');
        (file == name && hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())).then(|| hash.to_ascii_lowercase())
    })
}

/// Check `signature` over `sums` with `ssh-keygen -Y verify`, trusting only
/// `signers`.
fn verify_signature(sums: &[u8], signature: &[u8], signers: &str, scratch: &Path) -> Result<()> {
    let signers_path = scratch.join("allowed_signers");
    let signature_path = scratch.join(SIGNATURE);
    std::fs::write(&signers_path, signers)?;
    std::fs::write(&signature_path, signature)?;
    let mut child = Command::new("ssh-keygen")
        .args(["-Y", "verify", "-f"])
        .arg(&signers_path)
        .args(["-I", SIGNER_PRINCIPAL, "-n", SIGNATURE_NAMESPACE, "-s"])
        .arg(&signature_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("run ssh-keygen to check the release signature (install OpenSSH 8.1 or later)")?;
    std::io::Write::write_all(child.stdin.as_mut().expect("piped stdin"), sums)?;
    drop(child.stdin.take());
    let output = child.wait_with_output()?;
    if !output.status.success() {
        let said = String::from_utf8_lossy(&output.stderr);
        bail!("the signature does not verify against the TerminalX release key ({}); the release was refused and nothing was changed", said.trim());
    }
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn download(agent: &ureq::Agent, url: &str) -> Result<Vec<u8>> {
    let response = agent.get(url).call().map_err(|error| match error {
        ureq::Error::Status(status, _) => anyhow!("{url} answered {status}"),
        ureq::Error::Transport(error) => anyhow!("cannot download {url}: {error}"),
    })?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(response.into_reader(), MAX_DOWNLOAD + 1), &mut bytes)?;
    if bytes.len() as u64 > MAX_DOWNLOAD {
        bail!("{url} is larger than any runtime release");
    }
    Ok(bytes)
}

/// Download, check and install `release` under `root` as
/// `versions/<version>`; `current` is not moved (that waits for the new
/// runtime to be ready, [`Update::run`]). Returns the version folder.
/// Nothing in `root` changes unless every check passes. `verifying` is
/// called once everything is downloaded.
fn install(root: &Path, source: &Source, release: &Release, asset: &str, fetch: &dyn Fn(&str) -> Result<Vec<u8>>, verifying: &mut dyn FnMut()) -> Result<PathBuf> {
    let tag = &release.tag;
    let versions = root.join("versions");
    std::fs::create_dir_all(&versions).with_context(|| format!("create {}", versions.display()))?;
    let dest = versions.join(release.version.to_string());
    if installed_version(root).is_ok_and(|installed| installed == release.version) {
        bail!("terminalx-serve {} is the installed version already; nothing was changed", release.version);
    }
    let scratch = tempfile::Builder::new().prefix(".update.").tempdir_in(&versions).context("make a staging folder")?;

    let sums = fetch(&source.url(tag, SUMS)).with_context(|| format!("download {SUMS} of {tag}"))?;
    let signature = fetch(&source.url(tag, SIGNATURE)).map_err(|_| anyhow!("{tag} has no signature ({SIGNATURE}) and is refused; nothing was changed"))?;
    let manifest = fetch(&source.url(tag, MANIFEST)).with_context(|| format!("download {MANIFEST} of {tag}"))?;
    let binary = fetch(&source.url(tag, asset)).with_context(|| format!("download {asset} of {tag}"))?;

    verifying();
    verify_signature(&sums, &signature, &source.signers, scratch.path())?;
    let sums = String::from_utf8(sums).context("SHA256SUMS is not text")?;
    let checked = |name: &str, bytes: &[u8]| -> Result<()> {
        let expected = listed_hash(&sums, name).ok_or_else(|| anyhow!("{SUMS} of {tag} does not list {name}; nothing was changed"))?;
        let actual = sha256_hex(bytes);
        if actual != expected {
            bail!("{name} of {tag} does not match its signed SHA-256 (expected {expected}, got {actual}); it was refused and nothing was changed");
        }
        Ok(())
    };
    checked(MANIFEST, &manifest)?;
    let manifest: serde_json::Value = serde_json::from_slice(&manifest).context("terminalx-serve.json is not JSON")?;
    if manifest["version"].as_str() != Some(release.version.to_string().as_str()) {
        bail!("{tag} carries version {} in {MANIFEST}, which does not match its tag; nothing was changed", manifest["version"]);
    }
    checked(asset, &binary)?;

    let staged = scratch.path().join("terminalx-serve");
    {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o755);
        let mut file = options.open(&staged)?;
        std::io::Write::write_all(&mut file, &binary)?;
        file.sync_all()?;
    }
    let ran = run_fresh(Command::new(&staged).arg("--version").stdin(Stdio::null())).with_context(|| format!("run the downloaded runtime of {tag}"))?;
    let said = String::from_utf8_lossy(&ran.stdout).trim().to_string();
    let expected = format!("terminalx-serve {}", release.version);
    if !ran.status.success() || said != expected {
        bail!("the downloaded runtime says {said:?}, not {expected:?}; nothing was changed");
    }

    if dest.exists() {
        // Another build of a version `current` does not name (one an earlier
        // update left, or a rollback): replaced whole.
        std::fs::remove_dir_all(&dest).with_context(|| format!("replace {}", dest.display()))?;
    }
    std::fs::create_dir(&dest).with_context(|| format!("create {}", dest.display()))?;
    #[cfg(unix)]
    std::fs::set_permissions(&dest, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
    std::fs::rename(&staged, dest.join("terminalx-serve")).with_context(|| format!("move the runtime into {}", dest.display()))?;
    Ok(dest)
}

/// Point the symlink `link` at `target` in one rename.
#[cfg(unix)]
fn swap_link(link: &Path, target: &Path) -> Result<()> {
    let next = link.with_file_name(format!(".current.next.{}", std::process::id()));
    let _ = std::fs::remove_file(&next);
    std::os::unix::fs::symlink(target, &next).with_context(|| format!("create {}", next.display()))?;
    std::fs::rename(&next, link).inspect_err(|_| {
        let _ = std::fs::remove_file(&next);
    })
    .with_context(|| format!("swap {} to {}", link.display(), target.display()))
}

/// Point the directory junction `link` at `target`. A junction needs no
/// privilege, where a symlink needs an administrator or Developer Mode.
/// Windows will not rename one directory entry over another, so the old
/// junction is moved aside, the new one renamed in, and the old one put back
/// if that fails: `link` names the old version or the new one throughout,
/// apart from the instant between the two renames.
#[cfg(windows)]
fn swap_link(link: &Path, target: &Path) -> Result<()> {
    let next = link.with_file_name(format!(".current.next.{}", std::process::id()));
    let aside = link.with_file_name(format!(".current.old.{}", std::process::id()));
    let _ = std::fs::remove_dir(&next);
    let _ = std::fs::remove_dir(&aside);
    crate::win::fs::junction(&next, target).with_context(|| format!("create {}", next.display()))?;
    let had = crate::win::fs::is_reparse_point(link).unwrap_or(false);
    if had {
        std::fs::rename(link, &aside).with_context(|| format!("move {} aside", link.display()))?;
    }
    if let Err(error) = std::fs::rename(&next, link) {
        let _ = std::fs::remove_dir(&next);
        if had {
            let _ = std::fs::rename(&aside, link);
        }
        return Err(anyhow::Error::new(error).context(format!("swap {} to {}", link.display(), target.display())));
    }
    if had {
        // Only the junction itself: what it pointed at is kept.
        let _ = std::fs::remove_dir(&aside);
    }
    Ok(())
}

/// Run a binary this process has just written. Closing it is not enough on
/// Linux: a child another thread forked while the file was open for writing
/// holds that descriptor until it execs, and until then the kernel refuses
/// to run the file (`ETXTBSY`). That window is short, so the run is retried
/// for up to two seconds before the error stands. Once it has run, the
/// installed copy (the same file, renamed) starts without this.
fn run_fresh(command: &mut Command) -> std::io::Result<std::process::Output> {
    const TEXT_FILE_BUSY: i32 = 26; // ETXTBSY on Linux and macOS
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match command.output() {
            Err(error) if error.raw_os_error() == Some(TEXT_FILE_BUSY) && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            outcome => return outcome,
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const TAG: &str = "runtime-v9.9.9-20261116120000-abcdef1";
    const ASSET: &str = "terminalx-serve-linux-x64";

    #[test]
    fn tags_are_read_as_the_release_workflow_names_them() {
        let release = parse_tag(TAG).unwrap();
        assert_eq!((release.version.to_string(), release.built), ("9.9.9".into(), 20261116120000));
        for bad in ["runtime-v9.9.9-2026111612000-abcdef1", "runtime-v9.9-20261116120000-abcdef1", "runtime-v9.9.9-20261116120000-ABCDEF1", "v9.9.9", "runtime-v9.9.9-rc1-20261116120000-abcdef1"] {
            assert_eq!(parse_tag(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_newest_signed_release_with_this_asset_is_chosen() {
        let release = |tag: &str, assets: &[&str]| serde_json::json!({ "tag_name": tag, "draft": false, "assets": assets.iter().map(|name| serde_json::json!({ "name": name })).collect::<Vec<_>>() });
        let all = [ASSET, SUMS, SIGNATURE, MANIFEST];
        let list = serde_json::json!([
            release("runtime-v9.9.8-20261116130000-abcdef2", &[ASSET, SUMS, MANIFEST]),
            release("runtime-v9.9.9-20261116140000-abcdef3", &["terminalx-serve-linux-arm64", SUMS, SIGNATURE, MANIFEST]),
            release(TAG, &all),
            release("runtime-v9.9.7-20261115120000-abcdef4", &all),
            release("terminalx-v0.2.30", &all),
        ]);
        let newest = newest_signed(list.to_string().as_bytes(), ASSET).unwrap().unwrap();
        assert_eq!(newest.tag, TAG, "unsigned and other-platform releases are skipped");
        assert_eq!(newest_signed(b"[]", ASSET).unwrap(), None);
    }

    #[test]
    fn sums_are_read_in_either_mode() {
        let hash = "a".repeat(64);
        assert_eq!(listed_hash(&format!("{hash}  {ASSET}\n"), ASSET), Some(hash.clone()));
        assert_eq!(listed_hash(&format!("{hash} *{ASSET}\n"), ASSET), Some(hash.clone()));
        assert_eq!(listed_hash(&format!("{hash}  {ASSET}.old\n"), ASSET), None);
    }

    /// A release of a stand-in runtime signed with a throwaway key, served by
    /// `fetch`, and an install of 1.0.0 to update.
    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        files: HashMap<String, Vec<u8>>,
        source: Source,
        key: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().join("install");
            std::fs::create_dir_all(root.join("versions/1.0.0")).unwrap();
            std::fs::write(root.join("versions/1.0.0/terminalx-serve"), "old").unwrap();
            std::os::unix::fs::symlink("versions/1.0.0", root.join("current")).unwrap();
            let key = dir.path().join("key");
            let made = Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f"]).arg(&key).status().unwrap();
            assert!(made.success());
            let public = std::fs::read_to_string(key.with_extension("pub")).unwrap();
            let public = public.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
            let signers = format!("{SIGNER_PRINCIPAL} namespaces=\"{SIGNATURE_NAMESPACE}\" {public}\n");
            let source = Source { api_url: "test:list".into(), base_url: "test:".into(), signers };
            let mut fixture = Self { _dir: dir, root, files: HashMap::new(), source, key };
            fixture.publish(b"#!/bin/sh\necho 'terminalx-serve 9.9.9'\n", "9.9.9");
            fixture
        }

        fn publish(&mut self, binary: &[u8], manifest_version: &str) {
            let manifest = serde_json::json!({ "version": manifest_version }).to_string().into_bytes();
            let sums = format!("{}  {ASSET}\n{}  {MANIFEST}\n", sha256_hex(binary), sha256_hex(&manifest));
            self.files.insert(self.source.url(TAG, ASSET), binary.to_vec());
            self.files.insert(self.source.url(TAG, MANIFEST), manifest);
            self.sign(sums.as_bytes(), &self.key.clone());
        }

        fn sign(&mut self, sums: &[u8], key: &Path) {
            let scratch = tempfile::tempdir().unwrap();
            let file = scratch.path().join(SUMS);
            std::fs::write(&file, sums).unwrap();
            let signed = Command::new("ssh-keygen").args(["-q", "-Y", "sign", "-n", SIGNATURE_NAMESPACE, "-f"]).arg(key).arg(&file).status().unwrap();
            assert!(signed.success());
            self.files.insert(self.source.url(TAG, SUMS), sums.to_vec());
            self.files.insert(self.source.url(TAG, SIGNATURE), std::fs::read(scratch.path().join(format!("{SUMS}.sig"))).unwrap());
        }

        fn apply(&self) -> Result<PathBuf> {
            let files = self.files.clone();
            let fetch = move |url: &str| files.get(url).cloned().ok_or_else(|| anyhow!("{url} answered 404"));
            install(&self.root, &self.source, &parse_tag(TAG).unwrap(), ASSET, &fetch, &mut || {})
        }

        /// The whole update, as `update --apply 9.9.9` runs it, reported to
        /// the record of a data directory no runtime runs.
        fn update(&self) -> (Ended, Record) {
            self.update_with(&STEPS)
        }

        /// The whole update with `steps` starting and handing over runtimes.
        fn update_with(&self, steps: &Steps) -> (Ended, Record) {
            let files = self.files.clone();
            let fetch = move |url: &str| files.get(url).cloned().ok_or_else(|| anyhow!("{url} answered 404"));
            let data = self._dir.path().join("data");
            std::fs::create_dir_all(data.join("run")).unwrap();
            let path = record::status_path(&data);
            let mut reporter = Reporter::open(&path, &data, &self.root);
            let release = parse_tag(TAG).unwrap();
            let ended = Update { root: &self.root, data: &data, source: &self.source, asset: ASSET, fetch: &fetch, release: &release, stop: &[], steps }.run(&mut reporter);
            (ended, record::read_record(&path))
        }

        fn current(&self) -> PathBuf {
            std::fs::read_link(self.root.join("current")).unwrap()
        }

        /// Nothing changed: `current` and the version folders are as before.
        fn assert_unchanged(&self) {
            assert_eq!(self.current(), Path::new("versions/1.0.0"));
            let mut left: Vec<_> = std::fs::read_dir(self.root.join("versions")).unwrap().map(|entry| entry.unwrap().file_name()).collect();
            left.sort();
            assert_eq!(left, ["1.0.0"], "no staging folder or new version is left behind");
        }
    }

    #[test]
    fn a_signed_release_is_installed_beside_the_old_one() {
        let fixture = Fixture::new();
        assert_eq!(installed_version(&fixture.root).unwrap().to_string(), "1.0.0");
        let dest = fixture.apply().unwrap();
        assert_eq!(dest, fixture.root.join("versions/9.9.9"));
        assert_eq!(fixture.current(), Path::new("versions/1.0.0"), "current moves only once the new runtime is ready");
        assert_eq!(installed_version(&fixture.root).unwrap().to_string(), "1.0.0");
        assert!(fixture.root.join("versions/9.9.9/terminalx-serve").exists());
        assert!(fixture.root.join("versions/1.0.0/terminalx-serve").exists(), "the old version stays for a rollback");
        let names: Vec<_> = std::fs::read_dir(fixture.root.join("versions")).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
        assert!(names.iter().all(|name| !name.starts_with('.')), "the staging folder is removed: {names:?}");
    }

    #[test]
    fn a_release_signed_by_another_key_is_refused() {
        let mut fixture = Fixture::new();
        let other = fixture._dir.path().join("other");
        assert!(Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(&other).status().unwrap().success());
        let sums = fixture.files[&fixture.source.url(TAG, SUMS)].clone();
        fixture.sign(&sums, &other);
        let error = fixture.apply().unwrap_err();
        assert!(format!("{error:#}").contains("does not verify"), "{error:#}");
        fixture.assert_unchanged();
    }

    #[test]
    fn an_unsigned_release_is_refused() {
        let mut fixture = Fixture::new();
        fixture.files.remove(&fixture.source.url(TAG, SIGNATURE));
        assert!(format!("{:#}", fixture.apply().unwrap_err()).contains("has no signature"));
        fixture.assert_unchanged();
    }

    #[test]
    fn a_binary_that_does_not_match_its_signed_hash_is_refused() {
        let mut fixture = Fixture::new();
        fixture.files.insert(fixture.source.url(TAG, ASSET), b"#!/bin/sh\necho 'terminalx-serve 9.9.9' # changed\n".to_vec());
        assert!(format!("{:#}", fixture.apply().unwrap_err()).contains("does not match its signed SHA-256"));
        fixture.assert_unchanged();
    }

    #[test]
    fn a_runtime_that_is_not_the_version_it_claims_is_refused() {
        let mut fixture = Fixture::new();
        fixture.publish(b"#!/bin/sh\necho 'terminalx-serve 1.0.0'\n", "9.9.9");
        assert!(format!("{:#}", fixture.apply().unwrap_err()).contains("not \"terminalx-serve 9.9.9\""));
        fixture.assert_unchanged();
        fixture.publish(b"#!/bin/sh\necho 'terminalx-serve 9.9.9'\n", "9.9.8");
        assert!(format!("{:#}", fixture.apply().unwrap_err()).contains("does not match its tag"));
        fixture.assert_unchanged();
    }

    #[test]
    fn the_compiled_in_key_is_the_release_key() {
        assert_eq!(Source::release_signers().trim(), include_str!("../../../scripts/install/allowed_signers").lines().find(|line| !line.trim().is_empty() && !line.starts_with('#')).unwrap().trim());
    }

    /// PRO-354: a release that installs and verifies but does not start is
    /// removed in its trial; `current` and what runs stay as they were, and
    /// the record says so.
    #[test]
    fn a_release_that_fails_its_trial_changes_nothing_and_says_so() {
        let fixture = Fixture::new();
        let (ended, record) = fixture.update();
        assert_eq!(ended, Ended::Failed { rolled_back: false });
        fixture.assert_unchanged();
        match record.progress {
            Progress::Failed { version, running, rolled_back, message, .. } => {
                assert_eq!((version.as_str(), running.as_str(), rolled_back), ("9.9.9", "1.0.0", false));
                assert!(message.contains("did not start") && message.contains("1.0.0 keeps running"), "{message}");
            }
            other => panic!("expected failed, got {other:?}"),
        }
        assert_eq!(record.helper_pid, None, "nothing runs the update any more");
        assert_eq!(record.from.as_deref(), Some("1.0.0"));
    }

    /// The install root of a fixture whose data directory is `data`.
    fn root_of(data: &Path) -> PathBuf {
        data.parent().unwrap().join("install")
    }

    /// A release that passes its trial and is handed over to, as a runtime
    /// that execs it (`epoch` "before" goes); how it comes up is `ready`'s.
    fn handed_over(ready: fn(&Path, &str, &semver::Version) -> Result<()>) -> Steps {
        Steps {
            trial: |_, _, _| Ok(()),
            begin: |_, _, _| Ok(crate::serve_cli::handover::Handed::Exec { epoch: "before".into() }),
            ready,
            // What a service restart does here: says it ran the old version.
            restart: |root, data| {
                std::fs::write(data.join("restarted"), std::fs::read_link(root.join("current"))?.to_string_lossy().as_bytes())?;
                Ok(())
            },
        }
    }

    /// PRO-354: the runtime that took over does not say it is ready. `current`
    /// never moved, the new version is removed, the old one is started again,
    /// and the record says `failed`, `rolledBack`, running the old version.
    #[test]
    fn a_runtime_that_does_not_come_up_after_the_handover_is_rolled_back() {
        let fixture = Fixture::new();
        let steps = handed_over(|data, epoch, _| {
            assert_eq!(epoch, "before");
            assert_eq!(std::fs::read_link(root_of(data).join("current")).unwrap(), Path::new("versions/1.0.0"), "current has not moved before ready");
            bail!("the updated TerminalX runtime did not answer after the handover")
        });
        let (ended, record) = fixture.update_with(&steps);
        assert_eq!(ended, Ended::Failed { rolled_back: true });
        fixture.assert_unchanged();
        let data = fixture._dir.path().join("data");
        assert_eq!(std::fs::read_to_string(data.join("restarted")).unwrap(), "versions/1.0.0", "the old version was started again");
        match record.progress {
            Progress::Failed { version, running, rolled_back, message, .. } => {
                assert_eq!((version.as_str(), running.as_str(), rolled_back), ("9.9.9", "1.0.0", true));
                assert!(message.contains("did not come up after the handover") && message.contains("1.0.0 was started again"), "{message}");
            }
            other => panic!("expected failed, got {other:?}"),
        }
        assert_eq!(record.helper_pid, None);
    }

    /// The runtime that took over says the new version: only then does
    /// `current` move, and the update ends `updated`, nothing restarted.
    #[test]
    fn current_moves_once_the_runtime_that_took_over_is_ready() {
        let fixture = Fixture::new();
        let steps = handed_over(|data, _, version| {
            let root = root_of(data);
            assert_eq!(std::fs::read_link(root.join("current")).unwrap(), Path::new("versions/1.0.0"), "current has not moved before ready");
            assert!(root.join("versions").join(version.to_string()).join("terminalx-serve").exists());
            Ok(())
        });
        let (ended, record) = fixture.update_with(&steps);
        assert_eq!(ended, Ended::Updated);
        assert_eq!(fixture.current(), Path::new("versions/9.9.9"));
        assert!(!fixture._dir.path().join("data/restarted").exists(), "nothing was restarted");
        assert!(matches!(record.progress, Progress::Updated { ref from, ref to, .. } if from == "1.0.0" && to == "9.9.9"), "{record:?}");
        assert_eq!(versions_on_disk(&fixture.root).iter().map(ToString::to_string).collect::<Vec<_>>(), ["9.9.9", "1.0.0"]);
    }

    /// A release whose signature does not verify fails before anything is
    /// installed, and the record says that too.
    #[test]
    fn a_refused_release_is_reported_as_failed() {
        let mut fixture = Fixture::new();
        fixture.files.remove(&fixture.source.url(TAG, SIGNATURE));
        let (ended, record) = fixture.update();
        assert_eq!(ended, Ended::Failed { rolled_back: false });
        fixture.assert_unchanged();
        assert!(matches!(record.progress, Progress::Failed { ref message, rolled_back: false, .. } if message.contains("has no signature")), "{record:?}");
    }

    fn version_folders(root: &Path, versions: &[&str]) {
        for version in versions {
            let folder = root.join("versions").join(version);
            std::fs::create_dir_all(&folder).unwrap();
            std::fs::write(folder.join("terminalx-serve"), format!("runtime {version}")).unwrap();
        }
    }

    /// An installed runtime in `data/runtime/<digest>`, as a handover makes one.
    fn installed_copy(root: &Path, data: &Path, version: &str) -> PathBuf {
        let mut binary = std::fs::File::open(root.join("versions").join(version).join("terminalx-serve")).unwrap();
        let digest = crate::local_runtime::launch::digest(&mut binary).unwrap();
        let folder = data.join("runtime").join(digest);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::copy(root.join("versions").join(version).join("terminalx-serve"), folder.join("terminalx-serve")).unwrap();
        folder
    }

    /// Clean-up keeps `current` and the two versions before it, in
    /// `versions/` and as installed runtimes, and removes the rest.
    #[test]
    fn clean_up_keeps_current_and_the_two_before_it() {
        let dir = tempfile::tempdir().unwrap();
        let (root, data) = (dir.path().join("install"), dir.path().join("data"));
        version_folders(&root, &["1.0.0", "1.1.0", "1.2.0", "1.10.0", "2.0.0"]);
        std::os::unix::fs::symlink("versions/2.0.0", root.join("current")).unwrap();
        let copies: Vec<PathBuf> = ["1.0.0", "1.1.0", "1.2.0", "1.10.0", "2.0.0"].iter().map(|version| installed_copy(&root, &data, version)).collect();
        let stray = data.join("runtime").join("f".repeat(64));
        std::fs::create_dir_all(&stray).unwrap();
        std::fs::create_dir_all(root.join("versions/.update.half")).unwrap();

        let kept = prune(&root, &data, Some(&semver::Version::parse("2.0.0").unwrap())).unwrap();
        let named: Vec<String> = kept.iter().map(ToString::to_string).collect();
        assert_eq!(named, ["2.0.0", "1.10.0", "1.2.0"], "versions compare as versions, not as text");
        assert_eq!(versions_on_disk(&root).iter().map(ToString::to_string).collect::<Vec<_>>(), named, "no more than three versions stay");
        assert!(!copies[0].exists() && !copies[1].exists(), "the installed runtimes of removed versions go too");
        assert!(copies[2].exists() && copies[3].exists() && copies[4].exists());
        assert!(!stray.exists(), "an installed runtime of no kept version goes");
        assert!(root.join("versions/.update.half").exists(), "only version folders are touched");
    }

    /// The version that runs is never removed, even when it is not among
    /// the ones kept (an update the runtime has not taken yet).
    #[test]
    fn clean_up_never_removes_the_running_version() {
        let dir = tempfile::tempdir().unwrap();
        let (root, data) = (dir.path().join("install"), dir.path().join("data"));
        version_folders(&root, &["1.0.0", "1.1.0", "1.2.0", "2.0.0"]);
        std::os::unix::fs::symlink("versions/2.0.0", root.join("current")).unwrap();
        let running = semver::Version::parse("1.0.0").unwrap();
        let kept = prune(&root, &data, Some(&running)).unwrap();
        assert!(kept.contains(&running), "{kept:?}");
        assert!(root.join("versions/1.0.0/terminalx-serve").exists());
        assert!(root.join("versions/2.0.0/terminalx-serve").exists(), "current is never removed");
        assert!(!versions_on_disk(&root).is_empty());
    }

    #[test]
    fn the_helper_is_named_by_the_runtime_s_arguments() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        assert_eq!(parse(&args(&[])), Some(Mode::Newest));
        assert_eq!(parse(&args(&["--check"])), Some(Mode::Check));
        assert_eq!(
            parse(&args(&["--apply", "0.2.40", "--status", "/d/run/machine-update.json", "--stop", "tab:s/t", "--stop", "pane:s:1"])),
            Some(Mode::Apply { version: semver::Version::parse("0.2.40").unwrap(), status: PathBuf::from("/d/run/machine-update.json"), stop: vec!["tab:s/t".into(), "pane:s:1".into()] })
        );
        assert_eq!(parse(&args(&["--apply", "0.2.40"])), None, "the status file is required");
        assert_eq!(parse(&args(&["--apply", "latest", "--status", "f"])), None);
        assert_eq!(parse(&args(&["--frobnicate"])), None);
    }
}
