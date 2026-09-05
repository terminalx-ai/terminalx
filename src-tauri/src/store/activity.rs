//! Installation-local activity. One owner serializes read/modify/write, including
//! recovery and shutdown. Completed work never depends on retained conversations
//! or the disposable provider cache. No detached snapshot writes can overtake quit.

mod recovery;
#[cfg(test)]
mod tests;

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::index::TabStatus;

const FILE: &str = "stats-activity.json";
const BACKUP: &str = "stats-activity.backup.json";
const MAX_EVENTS: usize = 1_000;
const SCHEMA: u32 = 1;
static OWNER: Mutex<Option<(PathBuf, Collector)>> = Mutex::new(None);

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
        }
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
    opened: Option<(i64, std::time::Instant)>,
}

struct Collector {
    root: PathBuf,
    // The OS releases this lease on a crash. A second runtime for the same
    // profile must report an error rather than overwrite this owner's totals.
    _lease: std::fs::File,
    data: Snapshot,
    mirrors: HashMap<String, Mirror>,
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
        let lease = options.open(root.join("stats-activity.lock"))?;
        lease
            .try_lock()
            .context("Activity history is already owned by another app runtime")?;
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
            mirrors: HashMap::new(),
            error: (!errors.is_empty()).then(|| errors.join("; ")),
            stopped: false,
            dirty: false,
        };
        // Persist the cutoff before recovery or any live work. A retry can never
        // import post-upgrade event logs on top of their live counters.
        collector.save()?;
        collector.recover();
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
            agents_spawned: self.data.agents_spawned,
            agent_time_ms: self.data.agent_time_ms,
            prs_created: self.data.prs.len(),
            tracking_since: self
                .data
                .first_activity_at
                .and_then(chrono::DateTime::from_timestamp_millis)
                .map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
            accounting_error: self.error.clone(),
        }
    }

    fn transition(
        &mut self,
        key: &str,
        state: TabStatus,
        source: Source,
        at: i64,
        clock: std::time::Instant,
    ) -> Result<bool> {
        if self.stopped {
            return Ok(false);
        }
        let unchanged = self
            .mirrors
            .get(key)
            .is_some_and(|previous| previous.state == state);
        let started = self.apply_transition(key, state, source, at, clock);
        if !unchanged || self.dirty {
            self.save()?;
        }
        Ok(started)
    }

    fn apply_transition(
        &mut self,
        key: &str,
        state: TabStatus,
        source: Source,
        at: i64,
        clock: std::time::Instant,
    ) -> bool {
        let previous = self.mirrors.get(key);
        if previous.is_some_and(|previous| previous.state == state) {
            return false;
        }
        let mut opened = None;
        let mut started = false;
        if state == TabStatus::InProgress {
            if source == Source::Live {
                self.data.agents_spawned += 1;
                self.data.remember(ActivityEvent {
                    id: uuid::Uuid::now_v7().to_string(),
                    at,
                    kind: "agent_start".into(),
                    key: key.into(),
                    duration_ms: 0,
                });
                opened = Some((at, clock));
                started = true;
            }
        } else if let Some((_, start_clock)) = previous.and_then(|previous| previous.opened) {
            let duration_ms = clock
                .saturating_duration_since(start_clock)
                .as_millis()
                .min(u64::MAX as u128) as u64;
            self.data.agent_time_ms = self.data.agent_time_ms.saturating_add(duration_ms);
            self.data.remember(ActivityEvent {
                id: uuid::Uuid::now_v7().to_string(),
                at,
                kind: "agent_stop".into(),
                key: key.into(),
                duration_ms,
            });
        }
        self.mirrors.insert(key.into(), Mirror { state, opened });
        started
    }

    fn record_pr(&mut self, url: &str, at: i64) -> Result<()> {
        let key = canonical_pr(url)?;
        if self.data.prs.insert(key.clone()) {
            self.data.remember(ActivityEvent {
                id: key.clone(),
                at,
                kind: "pr_created".into(),
                key,
                duration_ms: 0,
            });
        }
        // Also retries a failed save when the PR is rediscovered.
        self.save()
    }

    fn shutdown(&mut self, at: i64, clock: std::time::Instant) -> Result<()> {
        let keys: Vec<_> = self.mirrors.keys().cloned().collect();
        for key in keys {
            // Close all intervals in memory, then commit one final snapshot.
            self.apply_transition(&key, TabStatus::Idle, Source::Live, at, clock);
        }
        self.stopped = true;
        self.mirrors.clear();
        self.save()
    }
}

fn with_collector<T>(f: impl FnOnce(&mut Collector) -> Result<T>) -> Result<T> {
    let mut owner = OWNER.lock().unwrap_or_else(|error| error.into_inner());
    let root = super::root()?;
    if owner.as_ref().is_none_or(|(known, _)| *known != root) {
        *owner = Some((root.clone(), Collector::open(root, now_ms())?));
    }
    f(&mut owner.as_mut().expect("initialized activity owner").1)
}

pub fn summary() -> Result<Summary> {
    with_collector(|collector| Ok(collector.summary()))
}

/// Returns the post-increment lifetime count only for a new live work start.
/// Consumers such as #110 should observe this, never tab counts or token scans.
pub fn transition(key: &str, state: TabStatus, source: Source) -> Result<Option<usize>> {
    let (at, clock) = (now_ms(), std::time::Instant::now());
    with_collector(|collector| {
        let started = collector.transition(key, state, source, at, clock)?;
        Ok(started.then_some(collector.data.agents_spawned))
    })
}

pub fn record_pr(url: &str) -> Result<()> {
    with_collector(|collector| collector.record_pr(url, now_ms()))
}
pub fn shutdown() -> Result<()> {
    let (at, clock) = (now_ms(), std::time::Instant::now());
    with_collector(|collector| collector.shutdown(at, clock))
}

pub fn report_error(message: String) {
    let _ = with_collector(|collector| {
        collector.error = Some(message);
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
