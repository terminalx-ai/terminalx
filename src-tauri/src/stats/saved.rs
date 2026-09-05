//! The display cache is independent of the (potentially enormous) scanner cache.
//! One worker owns a generation; readers only take the short publication lock.
use super::{scan_snapshot, StatsUsageSnapshot, CACHE_SCHEMA};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

const DISPLAY_FILE: &str = "stats-usage-snapshot.json";
// Bump whenever provider aggregation, attribution, or pricing changes.
// App activity is read independently from its durable ledger on every response.
const DISPLAY_SCHEMA: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Scope {
    root: PathBuf,
    home: PathBuf,
    predecessor: Option<PathBuf>,
}

impl Scope {
    fn current() -> Result<Self> {
        Ok(Self {
            root: std::fs::canonicalize(crate::store::root()?)?,
            home: dirs::home_dir().context("no home directory")?,
            predecessor: super::predecessor_data_root(),
        })
    }

    fn id(&self) -> String {
        // An opaque identity for the IPC client; no source discovery or git calls.
        serde_json::to_string(self).expect("serializable scope")
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedSnapshot {
    schema_version: u32,
    scan_schema: u32,
    scope: Scope,
    snapshot: StatsUsageSnapshot,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsUsageState {
    pub scope: String,
    pub generation: u64,
    pub snapshot: Option<StatsUsageSnapshot>,
    pub activity: Option<super::AppStats>,
    pub refreshing: bool,
    pub error: Option<String>,
}

impl StatsUsageState {
    // A delayed provider scan or a pre-migration display cache must never replace
    // the independently committed lifetime counters with an older app summary.
    fn with_activity(mut self, activity: Result<super::AppStats>) -> Self {
        match activity {
            Ok(activity) => self.activity = Some(activity),
            Err(error) => {
                let message = format!("Activity history unavailable: {error:#}");
                self.error = Some(match self.error {
                    Some(previous) => format!("{previous}; {message}"),
                    None => message,
                });
            }
        }
        if let (Some(snapshot), Some(activity)) = (self.snapshot.as_mut(), self.activity.as_ref()) {
            snapshot.app = activity.clone();
        }
        self
    }
}

#[derive(Default)]
struct State {
    scope: Option<Scope>,
    view: StatsUsageState,
    closed: bool,
}

#[derive(Default)]
pub struct StatsUsageStore {
    state: Mutex<State>,
}

impl StatsUsageStore {
    pub fn read(&self) -> Result<StatsUsageState> {
        Ok(self.attach_activity(self.read_at(Scope::current()?)?, super::app_stats))
    }

    fn read_at(&self, scope: Scope) -> Result<StatsUsageState> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.scope.as_ref() != Some(&scope) {
            let (snapshot, error) = match load(&scope) {
                Ok(snapshot) => (snapshot, None),
                Err(error) => (None, Some(format!("Saved usage unavailable: {error:#}"))),
            };
            state.view = StatsUsageState {
                scope: scope.id(),
                generation: state.view.generation + 1,
                snapshot,
                activity: None,
                refreshing: false,
                error,
            };
            state.scope = Some(scope);
        }
        Ok(state.view.clone())
    }

    /// Starts a worker or joins the current generation without queuing a scan.
    /// The observed identity also coalesces requests arriving just after a scan
    /// completed, and rejects a refresh from a reader of a previous data scope.
    pub fn refresh(self: &Arc<Self>, scope: &str, generation: u64) -> Result<StatsUsageState> {
        let current = Scope::current()?;
        self.read_at(current.clone())?;
        let expected = current.clone();
        let view = self.start(current, scope, generation, move || {
            let candidate = scan_snapshot(&expected.root)?;
            anyhow::ensure!(
                Scope::current()? == expected,
                "Usage data scope changed during refresh"
            );
            Ok(candidate)
        })?;
        Ok(self.attach_activity(view, super::app_stats))
    }

    fn attach_activity(&self, mut view: StatsUsageState, activity: impl FnOnce() -> Result<super::AppStats>) -> StatsUsageState {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        // Read under the publication lock so an older concurrent response
        // cannot overwrite a newer last-known activity summary.
        let activity = activity();
        if state.view.scope == view.scope {
            view.activity = state.view.activity.clone();
            view = view.with_activity(activity);
            // Keep the latest known counters across failed reads and provider
            // publications; neither depends on a valid provider display cache.
            state.view.activity = view.activity.clone();
            view
        } else {
            view.with_activity(activity)
        }
    }

    fn start(
        self: &Arc<Self>,
        scope: Scope,
        observed_scope: &str,
        generation: u64,
        scan: impl FnOnce() -> Result<StatsUsageSnapshot> + Send + 'static,
    ) -> Result<StatsUsageState> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed
            || state.view.refreshing
            || state.view.scope != observed_scope
            || state.view.generation != generation
        {
            return Ok(state.view.clone());
        }
        state.view.generation += 1;
        state.view.refreshing = true;
        state.view.error = None;
        let generation = state.view.generation;
        let store = self.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("stats-refresh".into())
            .spawn(move || {
                // A parser panic must not leave the Refresh control spinning forever.
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(scan))
                    .unwrap_or_else(|_| Err(anyhow::anyhow!("Usage refresh worker panicked")));
                store.finish(scope, generation, result);
            })
        {
            state.view.refreshing = false;
            state.view.error = Some(error.to_string());
        }
        Ok(state.view.clone())
    }

    fn finish(&self, scope: Scope, generation: u64, result: Result<StatsUsageSnapshot>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed
            || state.scope.as_ref() != Some(&scope)
            || state.view.generation != generation
        {
            return;
        }
        let result = result.and_then(|mut snapshot| {
            snapshot.updated_at = super::now_ms();
            save(&scope, &snapshot)?;
            Ok(snapshot)
        });
        match result {
            Ok(snapshot) => {
                state.view.snapshot = Some(snapshot);
                state.view.error = None;
            }
            Err(error) => state.view.error = Some(format!("{error:#}")),
        }
        state.view.refreshing = false;
    }

    /// Publications persist synchronously under this lock. Acquiring it drains
    /// any pending write; unfinished scans cannot publish after orderly shutdown.
    pub fn shutdown(&self) {
        self.state.lock().unwrap_or_else(|e| e.into_inner()).closed = true;
    }
}

fn load(scope: &Scope) -> Result<Option<StatsUsageSnapshot>> {
    let path = scope.root.join(DISPLAY_FILE);
    let Some(saved) = crate::store::read_json::<SavedSnapshot>(&path)? else {
        return Ok(None);
    };
    anyhow::ensure!(
        saved.schema_version == DISPLAY_SCHEMA && saved.scan_schema == CACHE_SCHEMA,
        "Incompatible saved usage version; a complete refresh is required"
    );
    anyhow::ensure!(
        &saved.scope == scope,
        "Saved usage belongs to a different data scope"
    );
    anyhow::ensure!(
        saved.snapshot.updated_at > 0,
        "Saved usage has no successful update timestamp"
    );
    Ok(Some(saved.snapshot))
}

fn save(scope: &Scope, snapshot: &StatsUsageSnapshot) -> Result<()> {
    let saved = SavedSnapshot {
        schema_version: DISPLAY_SCHEMA,
        scan_schema: CACHE_SCHEMA,
        scope: scope.clone(),
        snapshot: snapshot.clone(),
    };
    crate::store::write_atomic(&scope.root.join(DISPLAY_FILE), &serde_json::to_vec(&saved)?)
        .context("persist complete usage snapshot")?;
    // The file has already been fsynced by write_atomic; persist the rename too.
    #[cfg(unix)]
    std::fs::File::open(&scope.root)?
        .sync_all()
        .context("sync usage snapshot directory")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn scope(root: &std::path::Path) -> Scope {
        Scope {
            root: root.into(),
            home: root.join("home"),
            predecessor: None,
        }
    }
    fn snapshot(tokens: u64) -> StatsUsageSnapshot {
        let mut snapshot =
            super::super::aggregate(&[], Default::default(), &Default::default(), "2026-08-01");
        snapshot.total_tokens = tokens;
        snapshot.updated_at = 1234;
        snapshot
    }
    fn settled(store: &StatsUsageStore, scope: &Scope) -> StatsUsageState {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let state = store.read_at(scope.clone()).unwrap();
            if !state.refreshing {
                return state;
            }
            assert!(Instant::now() < deadline, "refresh did not settle");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    #[test]
    fn lifetime_activity_updates_even_when_provider_refresh_fails_or_is_running() {
        let cached = StatsUsageState {
            snapshot: Some(snapshot(17)),
            refreshing: true,
            error: Some("provider scan failed".into()),
            ..Default::default()
        };
        let current = cached.with_activity(Ok(super::super::AppStats {
            agents_spawned: 42,
            prs_created: 9,
            accounting_error: Some("history recovery incomplete".into()),
            ..Default::default()
        }));
        assert_eq!(current.snapshot.as_ref().unwrap().app.agents_spawned, 42);
        assert_eq!(current.snapshot.as_ref().unwrap().total_tokens, 17);
        assert_eq!(current.snapshot.as_ref().unwrap().updated_at, 1234);
        assert!(current.refreshing);
        let failed = current.with_activity(Err(anyhow::anyhow!("unreadable ledger")));
        assert_eq!(failed.snapshot.unwrap().app.prs_created, 9);
        let error = failed.error.unwrap();
        assert!(error.contains("provider scan failed"));
        assert!(error.contains("unreadable ledger"));
    }

    #[test]
    fn missing_provider_cache_does_not_hide_activity_and_failed_reads_keep_known_totals() {
        let dir = tempfile::tempdir().unwrap();
        let store = StatsUsageStore::default();
        let scope = scope(dir.path());
        let empty = store.read_at(scope.clone()).unwrap();
        let current = store.attach_activity(empty, || Ok(super::super::AppStats {
            agents_spawned: 42,
            prs_created: 9,
            ..Default::default()
        }));
        assert!(current.snapshot.is_none());
        assert_eq!(current.activity.unwrap().agents_spawned, 42);
        let failed = store.attach_activity(store.read_at(scope).unwrap(), || Err(anyhow::anyhow!("unreadable ledger")));
        assert!(failed.snapshot.is_none());
        assert_eq!(failed.activity.unwrap().prs_created, 9);
        assert!(failed.error.unwrap().contains("unreadable ledger"));
    }

    #[test]
    fn saved_read_and_new_readers_do_not_wait_for_scan_and_coalesce() {
        let dir = tempfile::tempdir().unwrap();
        let scope = scope(dir.path());
        save(&scope, &snapshot(17)).unwrap();
        let store = Arc::new(StatsUsageStore::default());
        let first = store.read_at(scope.clone()).unwrap();
        let (release, blocked) = mpsc::channel();
        let busy = store
            .start(scope.clone(), &first.scope, first.generation, move || {
                blocked.recv().unwrap();
                Ok(snapshot(42))
            })
            .unwrap();
        assert!(busy.refreshing);
        for generation in [first.generation, busy.generation] {
            let joined = store
                .start(scope.clone(), &first.scope, generation, || {
                    panic!("duplicate scan")
                })
                .unwrap();
            assert_eq!(joined.generation, busy.generation);
            assert!(joined.refreshing);
            assert_eq!(joined.snapshot.unwrap().total_tokens, 17);
        }
        // A cached read completes while the scan is still blocked, including a
        // fresh store reloading the file rather than using frontend memory.
        assert_eq!(
            store
                .read_at(scope.clone())
                .unwrap()
                .snapshot
                .unwrap()
                .updated_at,
            1234
        );
        assert_eq!(
            StatsUsageStore::default()
                .read_at(scope.clone())
                .unwrap()
                .snapshot
                .unwrap()
                .total_tokens,
            17
        );
        release.send(()).unwrap();
        let completed = settled(&store, &scope);
        assert_eq!(completed.snapshot.unwrap().total_tokens, 42);
        assert_eq!(load(&scope).unwrap().unwrap().total_tokens, 42);
        // A delayed duplicate from before this generation completed also joins.
        let joined = store
            .start(scope.clone(), &first.scope, first.generation, || {
                panic!("late duplicate")
            })
            .unwrap();
        assert!(!joined.refreshing);
        assert_eq!(joined.generation, busy.generation);
    }

    #[test]
    fn both_provider_scans_wait_for_app_reads_before_persistence_and_publication() {
        use super::super::{scan_snapshot_with, AppStats, Provider, UsageScope};
        let dir = tempfile::tempdir().unwrap();
        let scope = scope(dir.path());
        save(&scope, &snapshot(17)).unwrap();
        let store = Arc::new(StatsUsageStore::default());
        let first = store.read_at(scope.clone()).unwrap();
        let root = scope.root.clone();
        let (ready, reached_app_reads) = mpsc::channel();
        let (release, app_reads) = mpsc::channel();
        store
            .start(scope.clone(), &first.scope, first.generation, move || {
                let fixtures =
                    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/stats/fixtures/parity");
                scan_snapshot_with(
                    &root,
                    || {
                        Ok(vec![
                            (fixtures.join("claude.jsonl"), Provider::Claude),
                            (fixtures.join("codex.jsonl"), Provider::Codex),
                        ])
                    },
                    || {
                        ready.send(()).unwrap();
                        app_reads.recv().unwrap();
                        Ok((
                            AppStats {
                                agents_spawned: 99,
                                ..Default::default()
                            },
                            UsageScope::from_paths(["/fixtures/terminalx-worktree".into()]),
                        ))
                    },
                )
            })
            .unwrap();
        reached_app_reads
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
        let waiting = store.read_at(scope.clone()).unwrap();
        assert!(waiting.refreshing);
        assert_eq!(waiting.snapshot.unwrap().total_tokens, 17);
        assert_eq!(load(&scope).unwrap().unwrap().updated_at, 1234);
        release.send(()).unwrap();
        let completed = settled(&store, &scope).snapshot.unwrap();
        assert_eq!(completed.app.agents_spawned, 99);
        let persisted = load(&scope).unwrap().unwrap();
        assert_eq!(
            serde_json::to_value(&completed).unwrap(),
            serde_json::to_value(&persisted).unwrap()
        );
    }

    #[test]
    fn failed_scan_and_failed_write_retain_data_and_timestamp_then_retry() {
        let dir = tempfile::tempdir().unwrap();
        let scope = scope(dir.path());
        save(&scope, &snapshot(17)).unwrap();
        let store = Arc::new(StatsUsageStore::default());
        let first = store.read_at(scope.clone()).unwrap();
        store
            .start(scope.clone(), &first.scope, first.generation, || {
                anyhow::bail!("source unavailable")
            })
            .unwrap();
        let failed = settled(&store, &scope);
        assert!(failed.error.unwrap().contains("source unavailable"));
        assert_eq!(failed.snapshot.unwrap().updated_at, 1234);

        // Deterministic write failure even when the test runs as root.
        let tmp = scope
            .root
            .join(DISPLAY_FILE)
            .with_extension(format!("tmp.{}", std::process::id()));
        fs::create_dir(&tmp).unwrap();
        store
            .start(scope.clone(), &first.scope, failed.generation, || {
                Ok(snapshot(99))
            })
            .unwrap();
        let failed = settled(&store, &scope);
        assert!(failed
            .error
            .unwrap()
            .contains("persist complete usage snapshot"));
        assert_eq!(failed.snapshot.unwrap().total_tokens, 17);
        assert_eq!(load(&scope).unwrap().unwrap().updated_at, 1234);
        fs::remove_dir(tmp).unwrap();
        store
            .start(scope.clone(), &first.scope, failed.generation, || {
                Ok(snapshot(42))
            })
            .unwrap();
        assert_eq!(settled(&store, &scope).snapshot.unwrap().total_tokens, 42);
        store.shutdown();
        let restarted = StatsUsageStore::default().read_at(scope).unwrap();
        assert_eq!(restarted.snapshot.unwrap().total_tokens, 42);
    }

    #[test]
    fn interrupted_write_corruption_versions_and_scope_are_explicitly_recovered() {
        let dir = tempfile::tempdir().unwrap();
        let scope = scope(dir.path());
        assert!(load(&scope).unwrap().is_none());
        save(&scope, &snapshot(17)).unwrap();
        let path = scope.root.join(DISPLAY_FILE);
        fs::write(path.with_extension("tmp.interrupted"), b"{\"snapshot\":").unwrap();
        assert_eq!(load(&scope).unwrap().unwrap().total_tokens, 17);
        let original = fs::read(&path).unwrap();
        for field in ["schemaVersion", "scanSchema"] {
            let mut invalid: serde_json::Value = serde_json::from_slice(&original).unwrap();
            invalid[field] = 999.into();
            fs::write(&path, serde_json::to_vec(&invalid).unwrap()).unwrap();
            let state = StatsUsageStore::default().read_at(scope.clone()).unwrap();
            assert!(state.snapshot.is_none());
            assert!(state.error.unwrap().contains("Incompatible"));
        }
        fs::write(&path, &original).unwrap();
        let unrelated = Scope {
            home: dir.path().join("other-user"),
            ..scope.clone()
        };
        assert!(load(&unrelated)
            .unwrap_err()
            .to_string()
            .contains("different data scope"));
        fs::write(&path, b"{broken").unwrap();
        let store = Arc::new(StatsUsageStore::default());
        let state = store.read_at(scope.clone()).unwrap();
        assert!(state.snapshot.is_none());
        assert!(state.error.is_some());
        store
            .start(scope.clone(), &state.scope, state.generation, || {
                Ok(snapshot(42))
            })
            .unwrap();
        assert_eq!(settled(&store, &scope).snapshot.unwrap().total_tokens, 42);
        assert_eq!(load(&scope).unwrap().unwrap().total_tokens, 42);
    }

    #[test]
    fn old_generation_cannot_overwrite_a_new_scope_or_a_later_visit_to_the_same_scope() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let scope_a = scope(a.path());
        let scope_b = scope(b.path());
        save(&scope_a, &snapshot(17)).unwrap();
        let store = Arc::new(StatsUsageStore::default());
        let first = store.read_at(scope_a.clone()).unwrap();
        // Hold an old candidate, change scope, then finish a new generation.
        store.read_at(scope_b).unwrap();
        let current = store.read_at(scope_a.clone()).unwrap();
        store
            .start(scope_a.clone(), &current.scope, current.generation, || {
                Ok(snapshot(42))
            })
            .unwrap();
        settled(&store, &scope_a);
        store.finish(scope_a.clone(), first.generation, Ok(snapshot(999)));
        assert_eq!(
            store
                .read_at(scope_a.clone())
                .unwrap()
                .snapshot
                .unwrap()
                .total_tokens,
            42
        );
        assert_eq!(load(&scope_a).unwrap().unwrap().total_tokens, 42);
    }

    #[test]
    fn shutdown_finishes_writes_and_prevents_unfinished_candidates_from_publishing() {
        let dir = tempfile::tempdir().unwrap();
        let scope = scope(dir.path());
        save(&scope, &snapshot(17)).unwrap();
        let store = StatsUsageStore::default();
        let state = store.read_at(scope.clone()).unwrap();
        store.shutdown();
        store.finish(scope.clone(), state.generation, Ok(snapshot(999)));
        assert_eq!(load(&scope).unwrap().unwrap().total_tokens, 17);
    }
    #[test]
    #[ignore = "large-history timing harness; run explicitly with --ignored --nocapture"]
    fn large_history_readiness() {
        use super::super::{discover_sources_at, scan_snapshot_with, AppStats, UsageScope};
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let scope = scope(dir.path());
        let claude = scope.home.join(".claude/projects");
        let codex = scope.home.join(".codex/sessions");
        fs::create_dir_all(&claude).unwrap();
        fs::create_dir_all(&codex).unwrap();
        let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let padding = "x".repeat(1024);
        let mut source_bytes = 0;
        for index in 0..1742 {
            let is_claude = index % 2 == 0;
            let path = if is_claude { &claude } else { &codex }.join(format!("{index}.jsonl"));
            let mut file = fs::File::create(&path).unwrap();
            if !is_claude {
                writeln!(file, "{}", serde_json::json!({"type":"session_meta","payload":{"id":format!("s{index}"),"cwd":"/work/repo"}})).unwrap();
                writeln!(
                    file,
                    "{}",
                    serde_json::json!({"type":"turn_context","payload":{"model":"gpt-5.6-sol"}})
                )
                .unwrap();
            }
            for event in 0..128 {
                let timestamp = format!("{day}T10:{:02}:{:02}.{index:06}Z", event / 60, event % 60);
                let row = if is_claude {
                    serde_json::json!({"type":"assistant","sessionId":format!("s{index}"),"timestamp":timestamp,
                        "cwd":"/work/repo","requestId":format!("r{index}-{event}"),"message":{"id":format!("m{index}-{event}"),
                        "content":padding,"model":"claude-opus-5","usage":{"input_tokens":100,"output_tokens":25,"cache_read_input_tokens":80}}})
                } else {
                    serde_json::json!({"timestamp":timestamp,"type":"event_msg","padding":padding,"payload":{"type":"token_count","info":{
                        "last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":25,"total_tokens":125},
                        "total_token_usage":{"input_tokens":(event+1)*100,"cached_input_tokens":(event+1)*80,"output_tokens":(event+1)*25,"total_tokens":(event+1)*125}}}})
                };
                writeln!(file, "{row}").unwrap();
            }
            source_bytes += file.metadata().unwrap().len();
        }
        let scan = || {
            scan_snapshot_with(
                &scope.root,
                || discover_sources_at(&scope.home, &scope.root, None),
                || {
                    Ok((
                        AppStats::default(),
                        UsageScope::from_paths(["/work/repo".into()]),
                    ))
                },
            )
        };
        let started = Instant::now();
        let snapshot = scan().unwrap();
        let cold = started.elapsed();
        assert!(snapshot
            .providers
            .iter()
            .filter(|p| p.enabled)
            .all(|p| p.has_data));
        assert_eq!(
            snapshot.providers.iter().map(|p| p.sessions).sum::<usize>(),
            1742
        );
        save(&scope, &snapshot).unwrap();
        let started = Instant::now();
        let store = StatsUsageStore::default();
        assert!(store.read_at(scope.clone()).unwrap().snapshot.is_some());
        let cached = started.elapsed();
        let started = Instant::now();
        assert_eq!(scan().unwrap().total_tokens, snapshot.total_tokens);
        let incremental = started.elapsed();
        eprintln!("1742 files / 222976 events / {:.1} MiB sources: cached restart read {:?}; cold scan {:?}; incremental scan {:?}; display {} bytes; projections {} bytes",
            source_bytes as f64 / 1048576.0, cached, cold, incremental,
            fs::metadata(scope.root.join(DISPLAY_FILE)).unwrap().len(),
            fs::metadata(scope.root.join(super::super::CACHE_FILE)).unwrap().len());
        // No hard wall-clock threshold in the regression suite; relative timing
        // and the blocked-worker test establish independence from scan duration.
        assert!(cached < cold);
    }
}
