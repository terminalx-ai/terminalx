//! Installation-local activity. One owner serializes read/modify/write, including
//! recovery and shutdown. Completed work never depends on retained conversations
//! or the disposable provider cache. No detached snapshot writes can overtake quit.
//!
//! Only a runtime writes it (#767): the process that [`claim`]s the role. The
//! app and commands read published snapshots and keep the PRs they find aside
//! (`pending`) for the writer. While another process holds the lease, the
//! runtime keeps following its tabs and keeps their work aside too, takes the
//! lease as soon as it is let go, and then counts what it kept, once.

mod holder;
mod pending;
mod recovery;
#[cfg(test)]
pub(crate) mod tests;

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::index::TabStatus;
use holder::Holder;

const FILE: &str = "stats-activity.json";
const BACKUP: &str = "stats-activity.backup.json";
const LOCK: &str = "stats-activity.lock";
const MAX_EVENTS: usize = 1_000;
const SCHEMA: u32 = 1;
/// How soon a runtime notices that the lease's holder let go of it.
const LEASE_POLL: Duration = Duration::from_millis(500);

const START: &str = "agent_start";
const STOP: &str = "agent_stop";
const PR: &str = "pr_created";

/// Another process holds the writer lease. It keeps it; this process keeps
/// its work aside until the lease is let go.
#[derive(Debug)]
struct LeaseHeld;
impl std::fmt::Display for LeaseHeld {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Another process holds the activity history lease.")
    }
}
impl std::error::Error for LeaseHeld {}

/// Whether this process writes activity history. Only a runtime does.
static WRITER: AtomicBool = AtomicBool::new(false);
static OWNER: Mutex<Option<Owner>> = Mutex::new(None);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub agents_spawned: usize,
    pub agent_time_ms: u64,
    pub prs_created: usize,
    pub tracking_since: Option<String>,
    pub accounting_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityEvent {
    id: String,
    at: i64,
    kind: String,
    key: String,
    duration_ms: u64,
}

impl ActivityEvent {
    fn work(kind: &str, key: &str, at: i64, duration_ms: u64) -> Self {
        Self { id: uuid::Uuid::now_v7().to_string(), at, kind: kind.into(), key: key.into(), duration_ms }
    }

    /// A PR is identified by its canonical URL, wherever it was found.
    fn pr(key: String, at: i64) -> Self {
        Self { id: key.clone(), at, kind: PR.into(), key, duration_ms: 0 }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    schema_version: u32,
    generation: u64,
    agents_spawned: usize,
    agent_time_ms: u64,
    first_activity_at: Option<i64>,
    // Deduplication identities are never pruned with the diagnostic events.
    prs: BTreeSet<String>,
    recovered: BTreeSet<String>,
    recovery_version: u32,
    recovery_before: i64,
    events: VecDeque<ActivityEvent>,
    /// Records kept aside that are counted here but whose files may remain;
    /// a name leaves once its file is gone, so this stays small.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    imported: BTreeSet<String>,
}

impl Snapshot {
    fn empty(at: i64) -> Self {
        Self {
            schema_version: SCHEMA,
            generation: 0,
            agents_spawned: 0,
            agent_time_ms: 0,
            first_activity_at: None,
            prs: BTreeSet::new(),
            recovered: BTreeSet::new(),
            recovery_version: 0,
            recovery_before: at,
            events: VecDeque::new(),
            imported: BTreeSet::new(),
        }
    }

    fn summary(&self) -> Summary {
        Summary {
            agents_spawned: self.agents_spawned,
            agent_time_ms: self.agent_time_ms,
            prs_created: self.prs.len(),
            tracking_since: self
                .first_activity_at
                .and_then(chrono::DateTime::from_timestamp_millis)
                .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            accounting_error: None,
        }
    }

    /// Count a work start, a work stop or a PR; a PR counts once.
    fn count(&mut self, event: ActivityEvent) {
        match event.kind.as_str() {
            START => self.agents_spawned += 1,
            STOP => self.agent_time_ms = self.agent_time_ms.saturating_add(event.duration_ms),
            PR if self.prs.insert(event.key.clone()) => {}
            _ => return,
        }
        self.remember(event);
    }

    fn remember(&mut self, event: ActivityEvent) {
        self.first_activity_at = Some(
            self.first_activity_at
                .map_or(event.at, |at| at.min(event.at)),
        );
        self.events.push_back(event);
        while self.events.len() > MAX_EVENTS {
            self.events.pop_front();
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Live,
    Replay,
}

struct Mirror {
    state: TabStatus,
    opened: Option<(i64, Instant)>,
}

/// Each tab's last state, so every transition is counted once whether this
/// process writes history now or keeps its work aside. A takeover keeps them:
/// work that started while the lease was held elsewhere ends with its whole
/// duration, and an unchanged state after the takeover is not a new start.
#[derive(Default)]
struct Tabs(HashMap<String, Mirror>);

impl Tabs {
    fn unchanged(&self, key: &str, state: TabStatus) -> bool {
        self.0.get(key).is_some_and(|previous| previous.state == state)
    }

    /// The work a transition starts or stops, if any.
    fn step(
        &mut self,
        key: &str,
        state: TabStatus,
        source: Source,
        at: i64,
        clock: Instant,
    ) -> Option<ActivityEvent> {
        let previous = self.0.get(key);
        if previous.is_some_and(|previous| previous.state == state) {
            return None;
        }
        let mut opened = None;
        let mut event = None;
        if state == TabStatus::InProgress {
            if source == Source::Live {
                opened = Some((at, clock));
                event = Some(ActivityEvent::work(START, key, at, 0));
            }
        } else if let Some((_, start_clock)) = previous.and_then(|previous| previous.opened) {
            let duration_ms = clock
                .saturating_duration_since(start_clock)
                .as_millis()
                .min(u64::MAX as u128) as u64;
            event = Some(ActivityEvent::work(STOP, key, at, duration_ms));
        }
        self.0.insert(key.into(), Mirror { state, opened });
        event
    }

    /// Close every open interval, for shutdown.
    fn close(&mut self, at: i64, clock: Instant) -> Vec<ActivityEvent> {
        let keys: Vec<_> = self.0.keys().cloned().collect();
        let stops = keys
            .iter()
            .filter_map(|key| self.step(key, TabStatus::Idle, Source::Live, at, clock))
            .collect();
        self.0.clear();
        stops
    }
}

struct Collector {
    root: PathBuf,
    // The OS releases this lease on a crash. A second runtime for the same
    // profile must report an error rather than overwrite this owner's totals.
    _lease: std::fs::File,
    data: Snapshot,
    tabs: Tabs,
    error: Option<String>,
    stopped: bool,
    dirty: bool,
}

impl Drop for Collector {
    fn drop(&mut self) {
        // A concurrently forked child can briefly inherit the open descriptor
        // until exec. Explicit unlock releases the lease even in that window.
        let _ = self._lease.unlock();
    }
}

// Unlike read_json, an empty file is corruption, not a new installation.
fn read_snapshot(path: &Path) -> Result<Option<Snapshot>> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let data: Snapshot =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    if data.schema_version != SCHEMA {
        bail!("unsupported activity schema in {}", path.display());
    }
    Ok(Some(data))
}

impl Collector {
    fn open(root: PathBuf, at: i64) -> Result<Self> {
        let mut options = std::fs::OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let lease = options.open(root.join(LOCK))?;
        match lease.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => bail!(LeaseHeld),
            Err(std::fs::TryLockError::Error(error)) => {
                return Err(error).context("Could not lock activity history");
            }
        }
        let primary = read_snapshot(&root.join(FILE));
        let backup = read_snapshot(&root.join(BACKUP));
        let mut errors = Vec::new();
        let mut valid = Vec::new();
        let mut missing = 0;
        for result in [primary, backup] {
            match result {
                Ok(Some(data)) => valid.push(data),
                Ok(None) => missing += 1,
                Err(error) => errors.push(format!("{error:#}")),
            }
        }
        valid.sort_by_key(|data| data.generation);
        let data = match valid.pop() {
            Some(data) => {
                if missing > 0 {
                    errors.push(
                        "An activity snapshot is missing; retained the surviving snapshot.".into(),
                    );
                }
                data
            }
            None if errors.is_empty() => Snapshot::empty(at),
            None => bail!(
                "Activity history could not be loaded: {}. Existing files were preserved.",
                errors.join("; ")
            ),
        };
        let mut collector = Self {
            root,
            _lease: lease,
            data,
            tabs: Tabs::default(),
            error: (!errors.is_empty()).then(|| errors.join("; ")),
            stopped: false,
            dirty: false,
        };
        // Persist the cutoff before recovery or any live work. A retry can never
        // import post-upgrade event logs on top of their live counters.
        collector.save()?;
        collector.recover();
        collector.import_pending();
        Ok(collector)
    }

    fn save(&mut self) -> Result<()> {
        self.dirty = true;
        self.data.generation += 1;
        let result = (|| {
            let bytes = serde_json::to_vec(&self.data)?;
            super::write_atomic(&self.root.join(FILE), &bytes)?;
            // A second complete snapshot recovers a missing/corrupt primary.
            // Generations handle a crash between the two atomic replacements.
            super::write_atomic(&self.root.join(BACKUP), &bytes)
        })();
        if let Err(error) = &result {
            self.error = Some(format!("Save activity history: {error:#}"));
        } else {
            self.dirty = false;
        }
        result
    }

    fn summary(&self) -> Summary {
        Summary {
            accounting_error: self.error.clone(),
            ..self.data.summary()
        }
    }

    fn transition(
        &mut self,
        key: &str,
        state: TabStatus,
        source: Source,
        at: i64,
        clock: Instant,
    ) -> Result<bool> {
        if self.stopped {
            return Ok(false);
        }
        let unchanged = self.tabs.unchanged(key, state);
        let event = self.tabs.step(key, state, source, at, clock);
        let started = event.as_ref().is_some_and(|event| event.kind == START);
        if let Some(event) = event {
            self.data.count(event);
        }
        if !unchanged || self.dirty {
            self.save()?;
        }
        Ok(started)
    }

    fn record_pr(&mut self, url: &str, at: i64) -> Result<()> {
        if self.stopped {
            return Ok(());
        }
        self.data.count(ActivityEvent::pr(canonical_pr(url)?, at));
        // Also retries a failed save when the PR is rediscovered.
        self.save()
    }

    /// Count what was kept aside for this writer, each record once, and remove
    /// a record only after a saved snapshot counts it: a crash in between
    /// finds it again under `imported` and does not count it twice.
    fn import_pending(&mut self) {
        if self.stopped {
            return;
        }
        let inbox = match pending::list(&self.root) {
            Ok(inbox) => inbox,
            Err(error) => {
                self.error = Some(format!("Read activity kept aside: {error:#}"));
                return;
            }
        };
        if !inbox.unreadable.is_empty() {
            self.error = Some(format!(
                "Some activity kept aside could not be read and was left in place: {}",
                inbox.unreadable.join("; ")
            ));
        }
        let mut changed = false;
        for kept in &inbox.kept {
            if self.data.imported.insert(kept.name.clone()) {
                self.data.count(kept.event.clone());
                changed = true;
            }
        }
        let present: BTreeSet<&str> = inbox.kept.iter().map(|kept| kept.name.as_str()).collect();
        let before = self.data.imported.len();
        self.data.imported.retain(|name| present.contains(name.as_str()));
        changed |= self.data.imported.len() != before;
        if (changed && self.save().is_err()) || self.dirty {
            return;
        }
        for kept in inbox.kept {
            if std::fs::remove_file(&kept.path).is_ok() {
                // The next save forgets it; until then it is only a name.
                self.data.imported.remove(&kept.name);
            }
        }
    }

    fn shutdown(&mut self, at: i64, clock: Instant) -> Result<()> {
        // Close all intervals in memory, then commit one final snapshot.
        for event in self.tabs.close(at, clock) {
            self.data.count(event);
        }
        self.stopped = true;
        self.save()
    }
}

/// Why a runtime keeps its work aside instead of writing history.
enum Unavailable {
    /// Another process holds the lease. A waiter takes it once it is let go.
    Held(Holder),
    /// History could not be loaded. Retry (or a restart) opens it again.
    Failed(String),
}

/// A runtime that cannot write history yet. Tabs are still followed, and
/// their work and every PR are kept aside for when it can.
#[derive(Default)]
struct Aside {
    tabs: Tabs,
    why: Option<Unavailable>,
    error: Option<String>,
    failing: bool,
    stopped: bool,
}

impl Aside {
    fn transition(
        &mut self,
        root: &Path,
        key: &str,
        state: TabStatus,
        source: Source,
        at: i64,
        clock: Instant,
    ) -> Result<Option<usize>> {
        if self.stopped {
            return Ok(None);
        }
        let Some(event) = self.tabs.step(key, state, source, at, clock) else {
            return Ok(None);
        };
        let started = event.kind == START;
        self.failing = true;
        pending::keep(root, &event)?;
        self.failing = false;
        // The total with this start in it, so the star reminder's count and
        // the cloud's activity keep moving while the lease is held elsewhere.
        Ok(started
            .then(|| published(root).ok().flatten().map(|data| data.agents_spawned))
            .flatten())
    }

    fn record_pr(&mut self, root: &Path, url: &str, at: i64) -> Result<()> {
        if self.stopped {
            return Ok(());
        }
        self.failing = true;
        pending::keep_pr(root, url, at)?;
        self.failing = false;
        Ok(())
    }

    fn shutdown(&mut self, root: &Path, at: i64, clock: Instant) -> Result<()> {
        self.stopped = true;
        let mut result = Ok(());
        for event in self.tabs.close(at, clock) {
            if let Err(error) = pending::keep(root, &event) {
                result = Err(error);
            }
        }
        result
    }
}

enum Store {
    Writer(Collector),
    Aside(Aside),
}

/// The writer's side of activity history in this process.
struct Owner {
    root: PathBuf,
    store: Store,
    /// The failure last logged: one failure is one log line, until a write
    /// succeeds again.
    reported: Option<String>,
}

impl Owner {
    fn new(root: PathBuf) -> Self {
        let mut owner = Self { root, store: Store::Aside(Aside::default()), reported: None };
        owner.reopen(true);
        owner
    }

    /// Become the writer if this process can; otherwise say why once, and
    /// keep work aside. `find` looks up who holds the lease again, which the
    /// waiter's frequent attempts skip.
    fn reopen(&mut self, find: bool) {
        let Store::Aside(aside) = &mut self.store else { return };
        if aside.stopped {
            return;
        }
        match Collector::open(self.root.clone(), now_ms()) {
            Ok(mut collector) => {
                collector.tabs = std::mem::take(&mut aside.tabs);
                if collector.error.is_none() {
                    collector.error = aside.error.take();
                }
                if aside.why.is_some() {
                    log::info!("activity history: this runtime writes it again; work kept aside meanwhile is counted");
                }
                self.store = Store::Writer(collector);
            }
            Err(error) if error.is::<LeaseHeld>() => {
                let known = match &aside.why {
                    Some(Unavailable::Held(holder)) if !find => Some(holder.clone()),
                    _ => None,
                };
                let holder = known.unwrap_or_else(|| Holder::find(&self.root.join(LOCK)));
                let waiting = matches!(aside.why, Some(Unavailable::Held(_)));
                if !matches!(&aside.why, Some(Unavailable::Held(known)) if *known == holder) {
                    log::warn!("{}", holder.notice());
                }
                aside.why = Some(Unavailable::Held(holder));
                if !waiting {
                    wait_for_lease(self.root.clone());
                }
            }
            Err(error) => {
                let message = format!("{error:#}");
                if !matches!(&aside.why, Some(Unavailable::Failed(known)) if *known == message) {
                    log::error!("open activity history: {message}");
                }
                aside.why = Some(Unavailable::Failed(message));
            }
        }
    }

    /// Whether a waiter should keep trying for the lease.
    fn waiting(&self) -> bool {
        matches!(&self.store, Store::Aside(Aside { why: Some(Unavailable::Held(_)), stopped: false, .. }))
    }

    fn import(&mut self) {
        if let Store::Writer(collector) = &mut self.store {
            collector.import_pending();
        }
    }

    /// Report a failed write once; a write that succeeds ends the episode.
    fn settle<T: Default>(&mut self, result: Result<T>, context: &str) -> T {
        match result {
            Ok(value) => {
                let healthy = match &self.store {
                    Store::Writer(collector) => !collector.dirty,
                    Store::Aside(aside) => !aside.failing,
                };
                if healthy {
                    self.reported = None;
                }
                value
            }
            Err(error) => {
                let message = format!("{context}: {error:#}");
                if self.reported.as_ref() != Some(&message) {
                    log::error!("{message}");
                    self.reported = Some(message);
                }
                T::default()
            }
        }
    }

    fn summary(&mut self) -> Result<Summary> {
        self.reopen(true);
        self.import();
        match &self.store {
            Store::Writer(collector) => Ok(collector.summary()),
            Store::Aside(aside) => match &aside.why {
                Some(Unavailable::Held(holder)) => {
                    let mut summary = published(&self.root)?.map(|data| data.summary()).unwrap_or_default();
                    let notice = holder.notice();
                    summary.accounting_error =
                        Some(aside.error.as_ref().map_or(notice.clone(), |error| format!("{notice} {error}")));
                    Ok(summary)
                }
                Some(Unavailable::Failed(message)) => bail!("{message}"),
                None => bail!("Activity history is not open."),
            },
        }
    }

    fn transition(&mut self, key: &str, state: TabStatus, source: Source) -> Option<usize> {
        let (at, clock) = (now_ms(), Instant::now());
        self.import();
        let result = match &mut self.store {
            Store::Writer(collector) => collector
                .transition(key, state, source, at, clock)
                .map(|started| started.then_some(collector.data.agents_spawned)),
            Store::Aside(aside) => aside.transition(&self.root, key, state, source, at, clock),
        };
        self.settle(result, "record agent activity")
    }

    fn record_pr(&mut self, url: &str) -> Result<()> {
        // A URL that is no PR is the caller's to report; storage is ours.
        canonical_pr(url)?;
        self.import();
        let at = now_ms();
        let result = match &mut self.store {
            Store::Writer(collector) => collector.record_pr(url, at),
            Store::Aside(aside) => aside.record_pr(&self.root, url, at),
        };
        self.settle(result, "record a PR");
        Ok(())
    }
}

/// Retry the lease until its holder lets go, without waiting for a tab to
/// change. It stops once this process writes, stops, or follows another root.
fn wait_for_lease(root: PathBuf) {
    let waiting = std::thread::Builder::new().name("activity-lease".into()).spawn(move || loop {
        std::thread::sleep(LEASE_POLL);
        let mut owner = OWNER.lock().unwrap_or_else(|error| error.into_inner());
        match owner.as_mut() {
            Some(owner) if owner.root == root && owner.waiting() => owner.reopen(false),
            _ => return,
        }
    });
    if let Err(error) = waiting {
        log::error!("watch the activity history lease: {error}");
    }
}

fn root() -> Result<PathBuf> {
    Ok(std::fs::canonicalize(super::root()?)?)
}

fn writer() -> bool {
    WRITER.load(Ordering::SeqCst)
}

fn with_owner<T>(f: impl FnOnce(&mut Owner) -> Result<T>) -> Result<T> {
    let mut owner = OWNER.lock().unwrap_or_else(|error| error.into_inner());
    let root = root()?;
    if owner.as_ref().is_none_or(|known| known.root != root) {
        *owner = Some(Owner::new(root));
    }
    f(owner.as_mut().expect("initialized activity owner"))
}

/// The saved totals and the records kept aside for the writer, read without
/// the lease. None before anything was recorded.
fn published(root: &Path) -> Result<Option<Snapshot>> {
    // Kept records first: the writer saves the snapshot that counts a record
    // before it removes the record, so each is seen in one or the other.
    let kept = pending::list(root).map(|inbox| inbox.kept).unwrap_or_default();
    let mut errors = Vec::new();
    let saved = [FILE, BACKUP]
        .into_iter()
        .filter_map(|file| read_snapshot(&root.join(file)).unwrap_or_else(|error| {
            errors.push(error);
            None
        }))
        .max_by_key(|data| data.generation);
    let mut data = match (saved, errors.into_iter().next()) {
        (Some(data), _) => data,
        (None, Some(error)) => return Err(error),
        (None, None) if kept.is_empty() => return Ok(None),
        (None, None) => Snapshot::empty(now_ms()),
    };
    for kept in kept {
        if !data.imported.contains(&kept.name) {
            data.count(kept.event);
        }
    }
    Ok(Some(data))
}

/// Make this process the one writer of activity history, and open it now:
/// recover local history before hooks can publish live activity. Only a
/// runtime claims it (#767).
pub fn claim() {
    WRITER.store(true, Ordering::SeqCst);
    if let Err(error) = with_owner(|_| Ok(())) {
        log::error!("initialize activity history: {error:#}");
    }
}

/// A test's process role until the guard drops: a writer, as a runtime is,
/// or not, as the app is. Tests that use it hold `temp_home`, so one runs
/// at a time.
#[cfg(test)]
#[must_use]
pub(crate) struct RoleForTest(bool);

#[cfg(test)]
impl Drop for RoleForTest {
    fn drop(&mut self) {
        WRITER.store(self.0, Ordering::SeqCst);
    }
}

#[cfg(test)]
pub(crate) fn writer_for_test() -> RoleForTest {
    RoleForTest(WRITER.swap(true, Ordering::SeqCst))
}

#[cfg(test)]
pub(crate) fn app_for_test() -> RoleForTest {
    RoleForTest(WRITER.swap(false, Ordering::SeqCst))
}

/// Read only atomically published snapshots and what was kept aside for the
/// writer, without acquiring or changing the writer lease. The caller must
/// label these counters as saved, not current. None before anything was
/// recorded; an error when no snapshot can be read.
pub(crate) fn saved_summary(root: &Path) -> Result<Option<Summary>> {
    Ok(published(root)?.map(|data| data.summary()))
}

pub fn summary() -> Result<Summary> {
    if !writer() {
        return Ok(saved_summary(&root()?)?.unwrap_or_default());
    }
    with_owner(Owner::summary)
}

/// Returns the post-increment lifetime count only for a new live work start.
/// Consumers such as #110 should observe this, never tab counts or token scans.
/// A failure to record is reported here, once.
pub fn transition(key: &str, state: TabStatus, source: Source) -> Option<usize> {
    if !writer() {
        return None;
    }
    with_owner(|owner| Ok(owner.transition(key, state, source))).unwrap_or_else(|error| {
        log::error!("record agent activity: {error:#}");
        None
    })
}

/// Fails only for a URL that is not a PR. A process that does not write
/// history, or cannot yet, keeps the PR aside for the writer.
pub fn record_pr(url: &str) -> Result<()> {
    if !writer() {
        return pending::keep_pr(&root()?, url, now_ms());
    }
    with_owner(|owner| owner.record_pr(url))
}

pub fn shutdown() -> Result<()> {
    if !writer() {
        return Ok(());
    }
    let (at, clock) = (now_ms(), Instant::now());
    // Shutdown must not initialize an owner (or retry a competing lease).
    // Retain the stopped owner until process exit so late callbacks cannot
    // reopen the store and start writing after the final flush.
    let mut owner = OWNER.lock().unwrap_or_else(|error| error.into_inner());
    let Some(Owner { root, store, .. }) = owner.as_mut() else {
        return Ok(());
    };
    match store {
        Store::Writer(collector) if !collector.stopped || collector.dirty => {
            collector.shutdown(at, clock)
        }
        Store::Aside(aside) if !aside.stopped => aside.shutdown(root, at, clock),
        _ => Ok(()),
    }
}

pub fn report_error(message: String) {
    if !writer() {
        return;
    }
    let _ = with_owner(|owner| {
        match &mut owner.store {
            Store::Writer(collector) => collector.error = Some(message),
            Store::Aside(aside) => aside.error = Some(message),
        }
        Ok(())
    });
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn canonical_pr(raw: &str) -> Result<String> {
    let url = url::Url::parse(raw.trim()).context("invalid PR URL")?;
    let parts: Vec<_> = url.path().trim_matches('/').split('/').collect();
    let host = url.host_str().context("PR URL has no host")?;
    if !matches!(url.scheme(), "https" | "http") || parts.len() < 4 || parts[2] != "pull" {
        bail!("invalid PR URL: {raw}");
    }
    let number: u64 = parts[3].parse().context("invalid PR number")?;
    if number == 0 || parts[0].is_empty() || parts[1].is_empty() {
        bail!("invalid PR identity");
    }
    Ok(format!(
        "https://{}/{}/{}/pull/{number}",
        host.to_ascii_lowercase(),
        parts[0].to_ascii_lowercase(),
        parts[1].to_ascii_lowercase()
    ))
}
