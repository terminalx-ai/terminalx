//! Presentation facts, separate from lifecycle. Requests only read cached facts;
//! process scans, Git commands, association recovery and GitHub run off-path.
use super::*;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use serde_json::json;
use crate::github::rows::{RowPr, Poll, POLL_INTERVAL, FRESH_FOR};

const LOCAL_INTERVAL: Duration = Duration::from_secs(10);
const LOCAL_FRESH: Duration = Duration::from_secs(30);
type Rows = BTreeMap<String, String>; // session -> observed branch

#[derive(Default)]
pub(crate) struct PrCache(Mutex<Cache>);
#[derive(Default)]
struct Cache {
    projects: HashMap<String, ProjectStatus>,
    wanted: BTreeMap<String, BTreeMap<String, (String, Instant)>>,
    background: HashSet<String>,
    background_at: Option<Instant>,
    busy: bool,
    next: Option<Instant>,
    paused: Option<Instant>,
}
#[derive(Clone)]
struct ProjectStatus {
    failures: u32,
    due: Instant,
    checked_at: Option<Instant>,
    observed: Rows,
    local: Option<LocalRefs>,
    local_at: Instant,
    associations: HashMap<String, Vec<String>>,
    prs: Option<HashMap<String, RowPr>>,
}
#[derive(Clone, Default)]
struct LocalRefs { heads: HashMap<String, String>, default: Option<String> }
impl LocalRefs {
    fn eligible(&self, branch: &str) -> bool { self.default.as_deref() != Some(branch) && self.heads.contains_key(branch) }
}

trait Source: Send + 'static {
    fn background(&self) -> HashSet<String>;
    fn refs(&self, path: &Path) -> anyhow::Result<LocalRefs>;
    fn associations(&self, session: &str) -> anyhow::Result<Vec<String>>;
    fn poll(&self, path: &Path, urls: &[String]) -> Poll;
}
struct LiveSource(SessionManager);
impl Source for LiveSource {
    fn background(&self) -> HashSet<String> {
        let runtimes: Vec<_> = self.0.tabs.lock().unwrap().iter().map(|(key, rt)| (key.clone(), rt.clone())).collect();
        let jobs = runtimes.into_iter().filter_map(|(key, runtime)| {
            let (watch, leader) = {
                let rt = runtime.lock().unwrap();
                if matches!(rt.status, TabStatus::InProgress | TabStatus::Waiting) { return None; }
                let leader = match &rt.engine {
                    Engine::Cli(cli) => self.0.terminals.pid(&cli.pane_id),
                    Engine::None => None,
                    Engine::CodexStdio(_) | Engine::Acp(_) | Engine::OpenCode(_) => rt.child_pid,
                };
                (rt.background.clone(), leader)
            };
            // Transcript work also runs outside the tab lock and request path.
            let outstanding = watch.is_some_and(|watch| watch.lock().unwrap().outstanding(chrono::Utc::now()).is_some());
            Some((key, leader, outstanding))
        }).collect();
        background_jobs(jobs, crate::idle_agents::process_table)
    }
    fn refs(&self, path: &Path) -> anyhow::Result<LocalRefs> {
        let text = crate::git::run_bounded(path, &["for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)", "refs/heads/", "refs/remotes/origin/HEAD"], Duration::from_secs(10)).map_err(|error| anyhow::anyhow!("read local branch tips: {error:?}"))?;
        Ok(parse_refs(&text))
    }
    fn associations(&self, session: &str) -> anyhow::Result<Vec<String>> {
        Ok(crate::pr_associations::for_session(session, vec![])?.into_iter().map(|a| a.url).collect())
    }
    fn poll(&self, path: &Path, urls: &[String]) -> Poll { crate::github::rows::poll(path, urls) }
}

fn parse_refs(text: &str) -> LocalRefs {
    let mut refs = LocalRefs::default();
    for line in text.lines() {
        let fields: Vec<_> = line.split('\t').collect();
        if fields.len() < 2 { continue; }
        if let Some(branch) = fields[0].strip_prefix("refs/heads/") { refs.heads.insert(branch.into(), fields[1].into()); }
        if fields[0] == "refs/remotes/origin/HEAD" { refs.default = fields.get(2).and_then(|v| v.strip_prefix("refs/remotes/origin/")).map(str::to_string); }
    }
    if refs.default.is_none() { refs.default = ["main", "master"].into_iter().find(|branch| refs.heads.contains_key(*branch)).map(str::to_string); }
    refs
}

fn background_jobs(jobs: Vec<(String, Option<u32>, bool)>, scan: impl FnOnce() -> Option<String>) -> HashSet<String> {
    let table = jobs.iter().any(|(_, pid, known)| pid.is_some() && !known).then(scan).flatten();
    jobs.into_iter().filter_map(|(key, pid, known)| {
        (known || pid.zip(table.as_deref()).is_some_and(|(pid, table)| crate::idle_agents::strays(table, pid) > 0)).then_some(key)
    }).collect()
}

impl SessionManager {
    /// Only authorized session IDs enter here. Project paths come from the index.
    pub(crate) fn row_statuses(&self, sessions: &[index::SessionEntry]) -> BTreeMap<String, Value> {
        let mut projects: BTreeMap<String, Rows> = BTreeMap::new();
        let paths: HashMap<_, _> = sessions.iter().map(|s| s.project_path.clone()).collect::<BTreeSet<_>>().into_iter().map(|path| {
            let key = project_key(&path);
            (path, key)
        }).collect();
        let excluded: BTreeSet<_> = store::projects::list().map(|(projects, _)| projects.into_iter().filter(|p| p.archived || p.kind == store::projects::ProjectKind::Folder).map(|p| project_key(&p.path)).collect()).unwrap_or_default();
        for session in sessions.iter().filter(|s| !s.is_quick() && !s.worktree_removed && !excluded.contains(&paths[&s.project_path])) {
            if let Some(branch) = &session.branch { projects.entry(paths[&session.project_path].clone()).or_default().insert(session.id.clone(), branch.clone()); }
        }
        self.row_prs.refresh_with(projects, LiveSource(self.clone()));
        sessions.iter().map(|session| {
            let tabs: Vec<_> = session.tabs.iter().map(|tab| {
                let key = key_of(&session.id, &tab.id);
                let runtime = self.tabs.lock().unwrap().get(&key).cloned();
                let (status, activity) = runtime.as_ref().map(|rt| {
                    let rt = rt.lock().unwrap();
                    (rt.status, activity(&rt))
                }).unwrap_or((tab.status, None));
                let activity = activity.or_else(|| (!matches!(status, TabStatus::InProgress | TabStatus::Waiting) && self.row_prs.background(&key)).then_some("background"));
                json!({"status":status,"activity":activity})
            }).collect();
            let branch_status = if session.is_quick() || session.worktree_removed || excluded.contains(&paths[&session.project_path]) { Value::Null } else {
                session.branch.as_ref().map(|branch| self.row_prs.read(&paths[&session.project_path], &session.id, branch)).unwrap_or(Value::Null)
            };
            (session.id.clone(), json!({"tabs":tabs,"branch":session.branch,"branchStatus":branch_status}))
        }).collect()
    }

    pub(crate) fn annotate_row_statuses(&self, sessions: &mut [index::SessionEntry]) {
        let facts = self.row_statuses(sessions);
        for session in sessions {
            if let Some(input) = facts.get(&session.id) {
                session.unknown.insert("rowStatus".into(), input.clone());
                session.unknown.insert("detailedStatus".into(), select(input));
            }
        }
    }
}

fn project_key(path: &str) -> String {
    std::fs::canonicalize(path).unwrap_or_else(|_| PathBuf::from(path)).to_string_lossy().into_owned()
}

struct Running(Arc<PrCache>);
impl Drop for Running {
    fn drop(&mut self) {
        let mut cache = self.0.0.lock().unwrap_or_else(|e| e.into_inner());
        cache.busy = false;
        if std::thread::panicking() { cache.next = None; cache.background.clear(); cache.background_at = None; }
    }
}

impl PrCache {
    fn background(&self, key: &str) -> bool {
        let cache = self.0.lock().unwrap_or_else(|e| e.into_inner());
        cache.background_at.is_some_and(|at| at.elapsed() < LOCAL_FRESH) && cache.background.contains(key)
    }
    fn read(&self, project: &str, session: &str, branch: &str) -> Value {
        let cache = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let Some(p) = cache.projects.get(project).filter(|p| p.local_at.elapsed() < LOCAL_FRESH && p.observed.get(session).is_some_and(|b| b == branch)) else { return Value::Null; };
        let Some(local) = p.local.as_ref().filter(|local| local.eligible(branch)) else { return Value::Null; };
        let Some(urls) = p.associations.get(session) else { return Value::Null; };
        if !p.checked_at.is_some_and(|at| at.elapsed() < FRESH_FOR) { return Value::Null; }
        // A missing association response is unknown, never evidence of no PR.
        let Some(prs) = p.prs.as_ref().filter(|prs| urls.iter().all(|url| prs.contains_key(url))) else { return Value::Null; };
        let pr = urls.iter().filter_map(|url| prs.get(url)).filter(|row| row.branch == branch)
            .max_by_key(|row| (row.pr.state == "OPEN", row.pr.number)).map(|row| &row.pr);
        json!({"branch":branch,"checked":true,"headMatches":pr.map(|pr| local.heads.get(branch) == Some(&pr.head)),"pr":pr})
    }

    fn refresh_with(self: &Arc<Self>, projects: BTreeMap<String, Rows>, source: impl Source) {
        let now = Instant::now();
        let mut cache = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for (project, rows) in projects {
            let wanted = cache.wanted.entry(project).or_default();
            for (id, branch) in rows { wanted.insert(id, (branch, now)); }
        }
        cache.wanted.retain(|_, rows| { rows.retain(|_, (_, seen)| now.duration_since(*seen) < Duration::from_secs(60)); !rows.is_empty() });
        if cache.busy || cache.next.is_some_and(|next| next > now) { return; }
        let wanted: Vec<_> = cache.wanted.iter().map(|(path, rows)| (path.clone(), rows.iter().map(|(id, (branch, _))| (id.clone(), branch.clone())).collect::<Rows>())).collect();
        cache.busy = true;
        cache.next = Some(now + LOCAL_INTERVAL);
        let owner = self.clone();
        let running = Running(owner.clone());
        drop(cache);
        let spawned = std::thread::Builder::new().name("session-row-status".into()).spawn(move || {
            let _running = running;
            let background = source.background();
            {
                let mut cache = owner.0.lock().unwrap_or_else(|e| e.into_inner());
                cache.background = background;
                cache.background_at = Some(Instant::now());
            }
            for (path, rows) in wanted {
                let now = Instant::now();
                let (previous, paused) = {
                    let cache = owner.0.lock().unwrap_or_else(|e| e.into_inner());
                    (cache.projects.get(&path).cloned(), cache.paused.is_some_and(|until| until > now))
                };
                let mut project = previous.unwrap_or_else(|| ProjectStatus { failures:0, due:now, checked_at:None, observed:Rows::new(), local:None, local_at:now, associations:HashMap::new(), prs:None });
                project.local = source.refs(Path::new(&path)).ok();
                project.local_at = Instant::now();
                project.observed = rows;
                if !paused && project.due <= now {
                    project.associations = project.observed.iter().filter(|(_, branch)| project.local.as_ref().is_some_and(|local| local.eligible(branch)))
                        .filter_map(|(id, _)| source.associations(id).ok().map(|urls| (id.clone(), urls))).collect();
                    let urls: Vec<_> = project.associations.values().flatten().cloned().collect::<BTreeSet<_>>().into_iter().collect();
                    let poll = if urls.is_empty() { Poll { prs:Ok(HashMap::new()), retry_after:POLL_INTERVAL, limited:false } } else { source.poll(Path::new(&path), &urls) };
                    project.failures = if poll.prs.is_err() { project.failures.saturating_add(1) } else { 0 };
                    let wait = poll.retry_after.max(if project.failures > 0 { Duration::from_secs(120 * 2_u64.pow(project.failures.min(6) - 1)) } else { POLL_INTERVAL });
                    if poll.limited { owner.0.lock().unwrap_or_else(|e| e.into_inner()).paused = Some(Instant::now() + wait); }
                    project.due = Instant::now() + wait;
                    project.checked_at = poll.prs.as_ref().ok().map(|_| Instant::now());
                    project.prs = poll.prs.ok();
                }
                owner.0.lock().unwrap_or_else(|e| e.into_inner()).projects.insert(path, project);
            }
        });
        if let Err(error) = spawned { log::warn!("start session row status poll: {error}"); }
    }
}

pub(super) fn activity(rt: &TabRuntime) -> Option<&'static str> {
    // Multiple simultaneous asks are ranked by the portable decision table.
    let mut asks: Vec<_> = rt.pending.values().map(|ask| match ask.tool_name.as_str() {
        "AskUserQuestion" | "request_user_input" => "needs_answer",
        "ExitPlanMode" | "exit_plan_mode" => "review_plan",
        _ => "needs_permission",
    }).collect();
    asks.sort_by_key(|ask| rules().iter().position(|rule| rule["id"] == *ask));
    if let Some(ask) = asks.first() { return Some(ask); }
    if rt.stopping || rt.stop_in_flight { return Some("stopping"); }
    if rt.setup_failed || rt.recovery == Some(RecoveryKind::SignedOut) { return Some("setup_failed"); }
    if rt.stdio_starting { return Some("setting_up"); }
    if let Engine::CodexStdio(engine) = &rt.engine {
        if !engine.ready { return Some(if rt.recovery.is_some() || engine.exited || engine.blocked { "setup_failed" } else { "setting_up" }); }
    }
    if let Engine::Cli(cli) = &rt.engine {
        if cli.by_hand.is_none() && !cli.ready.arrived() && !cli.recorded {
            if rt.recovery.is_some() { return Some("setup_failed"); }
            return Some("setting_up");
        }
    }
    None
}

fn rules() -> &'static [Value] {
    static RULES: std::sync::OnceLock<Vec<Value>> = std::sync::OnceLock::new();
    RULES.get_or_init(|| serde_json::from_str(include_str!("../../packages/portable/src/sessionStatusRules.json")).expect("portable status rules"))
}

/// Evaluate the portable decision table for the native CLI. No Rust-specific
/// labels or precedence: both interpreters are checked against shared cases.
pub(crate) fn select(input: &Value) -> Value {
    let mut input = input.clone();
    if input["branchStatus"]["checked"] != true || input["branchStatus"]["branch"] != input["branch"] { input["branchStatus"] = Value::Null; }
    let rule = rules().iter().find(|rule| rule["when"].as_array().unwrap().iter().any(|all| all.as_array().unwrap().iter().all(|condition| {
        let mut found = Vec::new();
        values_at(&input, &condition["path"].as_str().unwrap().split('.').collect::<Vec<_>>(), &mut found);
        found.iter().any(|value| condition["values"].as_array().unwrap().iter().any(|pattern| matches(value, pattern)))
    }))).expect("fallback status");
    let mut description = rule.clone();
    description.as_object_mut().unwrap().remove("when");
    description
}

fn matches(value: &Value, pattern: &Value) -> bool {
    match pattern.as_object() {
        Some(fields) => value.is_object() && fields.iter().all(|(key, expected)| matches(&value[key], expected)),
        None => value == pattern,
    }
}

fn values_at<'a>(input: &'a Value, path: &[&str], found: &mut Vec<&'a Value>) {
    let Some((key, rest)) = path.split_first() else { found.push(input); return; };
    if *key == "*" {
        if let Some(items) = input.as_array() { for item in items { values_at(item, rest, found); } }
    } else if let Some(value) = input.get(*key) { values_at(value, rest, found); }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Clone)]
    struct Fake {
        calls: Arc<AtomicUsize>, scans: Arc<AtomicUsize>,
        head: &'static str, state: &'static str, limited: bool, panic: bool,
        gate: Option<Arc<std::sync::Barrier>>,
    }
    impl Default for Fake {
        fn default() -> Self { Self { calls:Arc::default(), scans:Arc::default(), head:"head", state:"OPEN", limited:false, panic:false, gate:None } }
    }
    fn url(n: usize) -> String { format!("https://github.com/o/r/pull/{}", n + 1) }
    impl Source for Fake {
        fn background(&self) -> HashSet<String> { self.scans.fetch_add(1, Ordering::SeqCst); HashSet::new() }
        fn refs(&self, _: &Path) -> anyhow::Result<LocalRefs> {
            Ok(LocalRefs { default:Some("main".into()), heads:(0..100).map(|n| (format!("branch-{n}"), self.head.into())).chain([("main".into(), self.head.into())]).collect() })
        }
        fn associations(&self, id: &str) -> anyhow::Result<Vec<String>> { Ok(id.parse::<usize>().ok().map(url).into_iter().collect()) }
        fn poll(&self, _: &Path, urls: &[String]) -> Poll {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(gate) = &self.gate { gate.wait(); }
            assert!(!self.panic, "injected poll panic");
            Poll { prs:if self.limited { Err(anyhow::anyhow!("limited")) } else { Ok(urls.iter().map(|url| {
                let number: u64 = url.rsplit('/').next().unwrap().parse().unwrap();
                (url.clone(), RowPr { branch:format!("branch-{}", number - 1), pr:crate::github::BranchPr { number, url:url.clone(), head:"head".into(), state:self.state.into(), mergeable:"MERGEABLE".into(), merge_state_status:"CLEAN".into(), checks:Some("SUCCESS".into()), ..Default::default() } })
            }).collect()) }, retry_after:POLL_INTERVAL, limited:self.limited }
        }
    }
    fn rows(ids: &[&str]) -> BTreeMap<String, Rows> {
        [("repo".into(), ids.iter().map(|id| (id.to_string(), format!("branch-{id}"))).collect())].into()
    }
    fn await_poll(cache: &PrCache) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while cache.0.lock().unwrap_or_else(|e| e.into_inner()).busy {
            assert!(Instant::now() < deadline, "poll did not finish");
            std::thread::sleep(Duration::from_millis(1));
        }
    }
    fn due(cache: &PrCache, remote: bool) {
        let mut held = cache.0.lock().unwrap_or_else(|e| e.into_inner());
        held.next = None;
        if remote { for p in held.projects.values_mut() { p.due = Instant::now(); } }
    }
    fn selected(cache: &PrCache, id: &str) -> Value {
        select(&json!({"tabs":[],"branch":format!("branch-{id}"),"branchStatus":cache.read("repo", id, &format!("branch-{id}"))}))["id"].clone()
    }

    #[test]
    fn native_cli_agrees_with_every_portable_case() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../../packages/portable/src/sessionStatusCases.json")).unwrap();
        for case in cases { assert_eq!(select(&case["input"])["id"], case["expected"], "{}", case["name"]); }
    }
    #[test]
    fn rows_share_one_background_scan_and_one_query_without_blocking_readers() {
        let cache = Arc::new(PrCache::default());
        let gate = Arc::new(std::sync::Barrier::new(2));
        let fake = Fake { gate:Some(gate.clone()), ..Default::default() };
        let projects = [("repo".into(), (0..100).map(|n| (n.to_string(), format!("branch-{n}"))).collect())].into();
        cache.refresh_with(projects, fake.clone());
        for _ in 0..50 {
            cache.refresh_with(rows(&["0"]), fake.clone());
            assert_eq!(cache.read("repo", "0", "branch-0"), Value::Null);
        }
        gate.wait(); await_poll(&cache);
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        assert_eq!(fake.scans.load(Ordering::SeqCst), 1);
        assert_eq!(selected(&cache, "0"), "ready_to_merge");
        assert_eq!(selected(&cache, "99"), "ready_to_merge");
        cache.refresh_with(rows(&["0"]), Fake { gate:None, ..fake.clone() });
        await_poll(&cache);
        assert_eq!(fake.scans.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn a_slow_remote_poll_does_not_postpone_the_next_local_refresh() {
        let cache = Arc::new(PrCache::default());
        let gate = Arc::new(std::sync::Barrier::new(2));
        let fake = Fake { gate:Some(gate.clone()), ..Default::default() };
        cache.refresh_with(rows(&["0"]), fake.clone());
        cache.0.lock().unwrap().next = Some(Instant::now() - LOCAL_INTERVAL);
        gate.wait(); await_poll(&cache);
        cache.refresh_with(rows(&["0"]), Fake { gate:None, ..fake.clone() }); await_poll(&cache);
        assert_eq!(fake.scans.load(Ordering::SeqCst), 2);
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn process_table_is_scanned_once_for_many_tabs_and_failure_is_not_background_work() {
        let jobs: Vec<_> = (1..=100).map(|n| (n.to_string(), Some(n), false)).collect();
        let scans = AtomicUsize::new(0);
        let found = background_jobs(jobs.clone(), || {
            scans.fetch_add(1, Ordering::SeqCst);
            Some((1..=100).map(|n| format!("{} 0 {n}\n", n + 1000)).collect())
        });
        assert_eq!(scans.load(Ordering::SeqCst), 1);
        assert_eq!(found.len(), 100);
        assert!(background_jobs(jobs, || None).is_empty());
        assert_eq!(background_jobs(vec![("watch".into(), None, true)], || panic!("no live process needs scanning")), ["watch".into()].into());
    }
    #[test]
    fn local_changes_update_before_remote_poll_and_shared_branch_does_not_imply_ownership() {
        let cache = Arc::new(PrCache::default()); let fake = Fake::default();
        let projects = [("repo".into(), [("0".into(), "branch-0".into()), ("unowned".into(), "branch-0".into()), ("default".into(), "main".into()), ("detached".into(), "HEAD".into())].into())].into();
        cache.refresh_with(projects, fake.clone()); await_poll(&cache);
        assert_eq!(selected(&cache, "0"), "ready_to_merge");
        assert_eq!(cache.read("repo", "unowned", "branch-0")["pr"], Value::Null);
        assert_eq!(cache.read("repo", "unowned", "branch-0")["checked"], true);
        assert_eq!(cache.read("repo", "default", "main"), Value::Null);
        assert_eq!(cache.read("repo", "detached", "HEAD"), Value::Null);
        assert_eq!(cache.read("repo", "0", "branch-1"), Value::Null);
        due(&cache, false);
        cache.refresh_with(rows(&["0"]), Fake { head:"unpushed", ..fake.clone() }); await_poll(&cache);
        assert_eq!(selected(&cache, "0"), "open_pr");
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        due(&cache, true);
        cache.refresh_with(rows(&["0"]), Fake { head:"unpushed", state:"MERGED", ..fake.clone() }); await_poll(&cache);
        assert_eq!(selected(&cache, "0"), "local_only");
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn new_views_join_next_batch_stale_facts_expire_and_limits_pause_only_remote_work() {
        let cache = Arc::new(PrCache::default()); let fake = Fake::default();
        cache.refresh_with(rows(&["0"]), fake.clone()); await_poll(&cache);
        cache.refresh_with(rows(&["1"]), fake.clone());
        due(&cache, true);
        cache.refresh_with(rows(&["0"]), fake.clone()); await_poll(&cache);
        assert_eq!(selected(&cache, "1"), "ready_to_merge");
        cache.0.lock().unwrap().projects.get_mut("repo").unwrap().local_at = Instant::now() - LOCAL_FRESH;
        assert_eq!(selected(&cache, "0"), "idle");
        cache.0.lock().unwrap().projects.get_mut("repo").unwrap().local_at = Instant::now();
        cache.0.lock().unwrap().projects.get_mut("repo").unwrap().checked_at = Some(Instant::now() - FRESH_FOR);
        assert_eq!(selected(&cache, "0"), "idle");
        due(&cache, true);
        cache.refresh_with(rows(&["0"]), Fake { limited:true, ..fake.clone() }); await_poll(&cache);
        let calls = fake.calls.load(Ordering::SeqCst);
        due(&cache, true);
        cache.refresh_with([("other".into(), [("2".into(), "branch-2".into())].into())].into(), fake.clone()); await_poll(&cache);
        assert_eq!(fake.calls.load(Ordering::SeqCst), calls);
        assert_eq!(fake.scans.load(Ordering::SeqCst), 4);
        assert_eq!(selected(&cache, "0"), "idle");
    }
    #[test]
    fn a_panicked_worker_restarts_and_a_poisoned_cache_does_not_disable_it() {
        let cache = Arc::new(PrCache::default());
        cache.refresh_with(rows(&["0"]), Fake { panic:true, ..Default::default() }); await_poll(&cache);
        cache.refresh_with(rows(&["0"]), Fake::default()); await_poll(&cache);
        assert_eq!(selected(&cache, "0"), "ready_to_merge");
        let other = cache.clone();
        assert!(std::thread::spawn(move || { let _held = other.0.lock().unwrap(); panic!("poison"); }).join().is_err());
        due(&cache, true);
        cache.refresh_with(rows(&["0"]), Fake { state:"MERGED", ..Default::default() }); await_poll(&cache);
        assert_eq!(selected(&cache, "0"), "merged");
    }
}
