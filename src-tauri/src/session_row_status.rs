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
    /// Project -> workspace folders whose work state is wanted, and when last asked for.
    wanted_work: BTreeMap<String, BTreeMap<String, Instant>>,
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
    /// Workspace folder -> "uncommitted", "committed" or "none", read with `local`.
    work: HashMap<String, &'static str>,
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
    /// What a workspace holds: uncommitted changes, commits `default` lacks, or neither. None when unreadable.
    fn work(&self, cwd: &Path, default: Option<&str>) -> Option<&'static str>;
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
    fn work(&self, cwd: &Path, default: Option<&str>) -> Option<&'static str> { workspace_work(cwd, default) }
}

/// Bounded like the branch-tip read; it runs on the status thread, never on a request.
fn workspace_work(cwd: &Path, default: Option<&str>) -> Option<&'static str> {
    let bound = Duration::from_secs(10);
    let status = crate::git::run_bounded(cwd, &["status", "--porcelain", "--untracked-files=normal"], bound).ok()?;
    if !status.trim().is_empty() { return Some("uncommitted"); }
    let Some(default) = default else { return Some("none") };
    // Against what the remote has merged when it is known, else the local default branch.
    let ahead = [format!("refs/remotes/origin/{default}"), format!("refs/heads/{default}")].into_iter()
        .find_map(|base| crate::git::run_bounded(cwd, &["rev-list", "--count", &format!("{base}..HEAD")], bound).ok())?;
    Some(if ahead.trim().parse::<u64>().unwrap_or(0) > 0 { "committed" } else { "none" })
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
    /// `stored` is the index the caller just read (archived sessions included or
    /// not; they never carry a branch a live session is on). Other
    /// sessions on the requested branches are read from it, never returned:
    /// which of them carries the branch's PR decides what the requested ones show.
    pub(crate) fn row_statuses_among(&self, sessions: &[index::SessionEntry], stored: &[index::SessionEntry]) -> BTreeMap<String, Value> {
        let excluded: BTreeSet<_> = store::projects::list().map(|(projects, _)| projects.into_iter().filter(|p| p.archived || p.kind == store::projects::ProjectKind::Folder).map(|p| project_key(&p.path)).collect()).unwrap_or_default();
        let mut keys: HashMap<String, String> = HashMap::new();
        let mut key = |path: &str| keys.entry(path.to_string()).or_insert_with(|| project_key(path)).clone();
        let mine: Vec<(&index::SessionEntry, String)> = sessions.iter().map(|s| (s, key(&s.project_path))).collect();
        let others: Vec<(&index::SessionEntry, String)> = stored.iter().map(|s| (s, key(&s.project_path))).collect();
        let eligible = |s: &index::SessionEntry, key: &str| branch_eligible(s, key, &excluded);
        let (shared, peers) = branch_sharing(&mine, &others, &eligible);
        let mut projects: BTreeMap<String, Rows> = BTreeMap::new();
        let mut folders: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        for (session, key) in mine.iter().chain(&peers).filter(|(s, k)| eligible(s, k)) {
            if let Some(branch) = &session.branch { projects.entry(key.clone()).or_default().insert(session.id.clone(), branch.clone()); }
            if !shared.contains(&session.id) { folders.entry(key.clone()).or_default().insert(session.cwd.clone()); }
        }
        self.row_prs.refresh_with(projects, folders, LiveSource(self.clone()));
        mine.iter().map(|(session, key)| {
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
            let carries = eligible(session, key) && !shared.contains(&session.id);
            let read = || (session.branch.as_ref().map(|branch| self.row_prs.read(key, &session.id, branch)).unwrap_or(Value::Null), self.row_prs.read_work(key, &session.cwd));
            (session.id.clone(), row_input(session, tabs, shared.contains(&session.id), carries.then(read)))
        }).collect()
    }

    pub(crate) fn annotate_row_statuses(&self, sessions: &mut [index::SessionEntry]) {
        let stored = index::load().unwrap_or_default();
        self.annotate_row_statuses_among(sessions, &stored);
    }

    /// As [`Self::annotate_row_statuses`], with the index the caller just read.
    pub(crate) fn annotate_row_statuses_among(&self, sessions: &mut [index::SessionEntry], stored: &[index::SessionEntry]) {
        let facts = self.row_statuses_among(sessions, stored);
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
        // The branch's PR, whichever session on it found the association: the
        // carrier rule in `row_statuses` decides which one session shows it.
        let found: Vec<_> = p.observed.iter().filter(|(_, b)| *b == branch).filter_map(|(id, _)| p.associations.get(id)).collect();
        if found.is_empty() { return Value::Null; }
        let urls: Vec<&String> = found.into_iter().flatten().collect::<BTreeSet<_>>().into_iter().collect();
        if !p.checked_at.is_some_and(|at| at.elapsed() < FRESH_FOR) { return Value::Null; }
        // A missing association response is unknown, never evidence of no PR.
        let Some(prs) = p.prs.as_ref().filter(|prs| urls.iter().all(|url| prs.contains_key(*url))) else { return Value::Null; };
        let pr = urls.iter().filter_map(|url| prs.get(*url)).filter(|row| row.branch == branch)
            .max_by_key(|row| (row.pr.state == "OPEN", row.pr.number)).map(|row| &row.pr);
        json!({"branch":branch,"checked":true,"headMatches":pr.map(|pr| local.heads.get(branch) == Some(&pr.head)),"pr":pr})
    }

    fn read_work(&self, project: &str, cwd: &str) -> Value {
        let cache = self.0.lock().unwrap_or_else(|e| e.into_inner());
        cache.projects.get(project).filter(|p| p.local_at.elapsed() < LOCAL_FRESH).and_then(|p| p.work.get(cwd)).map_or(Value::Null, |work| json!(work))
    }

    fn refresh_with(self: &Arc<Self>, projects: BTreeMap<String, Rows>, folders: BTreeMap<String, BTreeSet<String>>, source: impl Source) {
        let now = Instant::now();
        let mut cache = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for (project, rows) in projects {
            let wanted = cache.wanted.entry(project).or_default();
            for (id, branch) in rows { wanted.insert(id, (branch, now)); }
        }
        for (project, cwds) in folders {
            let wanted = cache.wanted_work.entry(project).or_default();
            for cwd in cwds { wanted.insert(cwd, now); }
        }
        cache.wanted.retain(|_, rows| { rows.retain(|_, (_, seen)| now.duration_since(*seen) < Duration::from_secs(60)); !rows.is_empty() });
        cache.wanted_work.retain(|_, cwds| { cwds.retain(|_, seen| now.duration_since(*seen) < Duration::from_secs(60)); !cwds.is_empty() });
        if cache.busy || cache.next.is_some_and(|next| next > now) { return; }
        let mut wanted: BTreeMap<String, (Rows, Vec<String>)> = cache.wanted.iter().map(|(path, rows)| (path.clone(), (rows.iter().map(|(id, (branch, _))| (id.clone(), branch.clone())).collect::<Rows>(), Vec::new()))).collect();
        for (path, cwds) in &cache.wanted_work { wanted.entry(path.clone()).or_default().1 = cwds.keys().cloned().collect(); }
        cache.busy = true;
        cache.next = Some(now + LOCAL_INTERVAL);
        let owner = self.clone();
        let running = Running(owner.clone());
        drop(cache);
        let spawned = std::thread::Builder::new().name("session-row-status".into()).spawn(crate::github_process::queued(move || {
            let _running = running;
            let background = source.background();
            {
                let mut cache = owner.0.lock().unwrap_or_else(|e| e.into_inner());
                cache.background = background;
                cache.background_at = Some(Instant::now());
            }
            for (path, (rows, cwds)) in wanted {
                let now = Instant::now();
                let (previous, paused) = {
                    let cache = owner.0.lock().unwrap_or_else(|e| e.into_inner());
                    (cache.projects.get(&path).cloned(), cache.paused.is_some_and(|until| until > now))
                };
                let mut project = previous.unwrap_or_else(|| ProjectStatus { failures:0, due:now, checked_at:None, observed:Rows::new(), local:None, local_at:now, associations:HashMap::new(), prs:None, work:HashMap::new() });
                project.local = source.refs(Path::new(&path)).ok();
                let default = project.local.as_ref().and_then(|local| local.default.clone());
                project.work = cwds.into_iter().filter_map(|cwd| source.work(Path::new(&cwd), default.as_deref()).map(|work| (cwd, work))).collect();
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
        }));
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
    let fields = description.as_object_mut().unwrap();
    fields.remove("when");
    let shows_pr = fields.remove("showsPr").is_some_and(|value| value == true);
    let pr = if shows_pr { input["branchStatus"]["pr"]["number"].clone() } else { Value::Null };
    fields.insert("pr".into(), if pr.is_u64() { pr } else { Value::Null });
    description
}

/// Sessions on one branch share its PR and workspace: the most recently active
/// one carries them, the others show only their agent state. The same rule as
/// `sharedBranchSessions` in the portable status module, checked against the
/// same cases. Members are (id, project, branch, active at); returns the ids
/// that do not carry their branch.
pub(crate) fn shared_branch_sessions<'a>(members: impl IntoIterator<Item = (&'a str, &'a str, Option<&'a str>, &'a str)>) -> HashSet<String> {
    let at = |time: &str| chrono::DateTime::parse_from_rfc3339(time).map(|time| time.timestamp_millis()).unwrap_or(0);
    let members: Vec<_> = members.into_iter().filter_map(|(id, project, branch, time)| branch.filter(|b| !b.is_empty()).map(|branch| (id, project, branch, at(time)))).collect();
    let mut carriers: HashMap<(&str, &str), (&str, i64)> = HashMap::new();
    for &(id, project, branch, time) in &members {
        let held = carriers.entry((project, branch)).or_insert((id, time));
        if time > held.1 || (time == held.1 && id < held.0) { *held = (id, time); }
    }
    let carrying: HashSet<&str> = carriers.values().map(|(id, _)| *id).collect();
    members.into_iter().filter(|(id, ..)| !carrying.contains(id)).map(|(id, ..)| id.to_string()).collect()
}

/// A session whose branch facts mean anything: in a Git project that is not
/// archived, with its workspace still there.
fn branch_eligible(session: &index::SessionEntry, key: &str, excluded: &BTreeSet<String>) -> bool {
    !session.is_quick() && !session.worktree_removed && !excluded.contains(key)
}

/// Which requested sessions do not carry their branch, and the other live
/// sessions on those branches. Only live sessions take part in the choice:
/// whether archived sessions were asked for or not, every surface picks the
/// same carrier. An archived session carries a branch only when no live
/// session is on it (it is then chosen among the archived ones asked for).
fn branch_sharing<'a>(mine: &[(&'a index::SessionEntry, String)], stored: &[(&'a index::SessionEntry, String)], eligible: &dyn Fn(&index::SessionEntry, &str) -> bool) -> (HashSet<String>, Vec<(&'a index::SessionEntry, String)>) {
    let requested: HashSet<&str> = mine.iter().map(|(s, _)| s.id.as_str()).collect();
    let branches: HashSet<(&str, &str)> = mine.iter().filter(|(s, k)| eligible(s, k)).filter_map(|(s, k)| s.branch.as_deref().map(|b| (k.as_str(), b))).collect();
    let on_branch = |s: &index::SessionEntry, k: &str| eligible(s, k) && s.branch.as_deref().is_some_and(|b| branches.contains(&(k, b)));
    let peers: Vec<_> = stored.iter().filter(|(s, k)| !s.archived && !requested.contains(s.id.as_str()) && on_branch(s, k)).map(|(s, k)| (*s, k.clone())).collect();
    let live: Vec<_> = mine.iter().filter(|(s, k)| !s.archived && on_branch(s, k)).chain(&peers).map(|(s, k)| (*s, k.as_str(), active_at(s))).collect();
    let mut shared = shared_branch_sessions(live.iter().map(|(s, k, at)| (s.id.as_str(), *k, s.branch.as_deref(), at.as_str())));
    let lived: HashSet<(&str, &str)> = live.iter().filter_map(|(s, k, _)| s.branch.as_deref().map(|b| (*k, b))).collect();
    let archived: Vec<_> = mine.iter().filter(|(s, k)| s.archived && on_branch(s, k)).map(|(s, k)| (*s, k.as_str(), active_at(s))).collect();
    shared.extend(shared_branch_sessions(archived.iter().map(|(s, k, at)| (s.id.as_str(), *k, s.branch.as_deref(), at.as_str()))));
    shared.extend(archived.iter().filter(|(s, k, _)| s.branch.as_deref().is_some_and(|b| lived.contains(&(*k, b)))).map(|(s, ..)| s.id.clone()));
    (shared, peers)
}

/// The facts one row is decided from. A session that does not carry its branch
/// (`sharing`) shows only its agent state: no PR and no workspace facts, even
/// when they were read. `carried` is (branch status, work) for the carrier.
fn row_input(session: &index::SessionEntry, tabs: Vec<Value>, sharing: bool, carried: Option<(Value, Value)>) -> Value {
    let (branch_status, work) = carried.filter(|_| !sharing).unwrap_or((Value::Null, Value::Null));
    let started = started(session, &tabs);
    json!({"tabs":tabs,"branch":session.branch,"branchStatus":branch_status,"work":work,"started":started,"sharedBranch":sharing})
}

/// False only when nothing has ever been sent: no message, no agent conversation
/// on any tab, and no tab doing anything. A session from before message
/// tracking has a provider conversation even while its messages are being counted.
fn started(session: &index::SessionEntry, tabs: &[Value]) -> bool {
    session.unknown.get("hasMessages").is_some_and(|v| v == true)
        || session.unknown.get("lastMessageAt").is_some_and(|v| !v.is_null())
        || session.tabs.iter().any(|tab| tab.provider_session_id.as_deref().is_some_and(|id| !id.is_empty()) || tab.unknown.get("hasMessages").is_some_and(|v| v == true))
        || tabs.iter().any(|tab| tab["status"] != json!(TabStatus::Idle))
}

fn active_at(session: &index::SessionEntry) -> String {
    crate::store::message_activity::last_message_at(session)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(|| session.created.clone())
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
        fn work(&self, cwd: &Path, default: Option<&str>) -> Option<&'static str> {
            assert_eq!(default, Some("main"));
            match cwd.file_name()?.to_str()? { "dirty" => Some("uncommitted"), "ahead" => Some("committed"), "gone" => None, _ => Some("none") }
        }
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
    impl PrCache {
        fn refresh_rows(self: &Arc<Self>, projects: BTreeMap<String, Rows>, source: impl Source) { self.refresh_with(projects, BTreeMap::new(), source) }
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
        cache.refresh_rows(projects, fake.clone());
        for _ in 0..50 {
            cache.refresh_rows(rows(&["0"]), fake.clone());
            assert_eq!(cache.read("repo", "0", "branch-0"), Value::Null);
        }
        gate.wait(); await_poll(&cache);
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        assert_eq!(fake.scans.load(Ordering::SeqCst), 1);
        assert_eq!(selected(&cache, "0"), "ready_to_merge");
        assert_eq!(selected(&cache, "99"), "ready_to_merge");
        cache.refresh_rows(rows(&["0"]), Fake { gate:None, ..fake.clone() });
        await_poll(&cache);
        assert_eq!(fake.scans.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn a_slow_remote_poll_does_not_postpone_the_next_local_refresh() {
        let cache = Arc::new(PrCache::default());
        let gate = Arc::new(std::sync::Barrier::new(2));
        let fake = Fake { gate:Some(gate.clone()), ..Default::default() };
        cache.refresh_rows(rows(&["0"]), fake.clone());
        cache.0.lock().unwrap().next = Some(Instant::now() - LOCAL_INTERVAL);
        gate.wait(); await_poll(&cache);
        cache.refresh_rows(rows(&["0"]), Fake { gate:None, ..fake.clone() }); await_poll(&cache);
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
    fn local_changes_update_before_remote_poll_and_a_shared_branch_reads_one_pr() {
        let cache = Arc::new(PrCache::default()); let fake = Fake::default();
        let projects = [("repo".into(), [("0".into(), "branch-0".into()), ("unowned".into(), "branch-0".into()), ("default".into(), "main".into()), ("detached".into(), "HEAD".into())].into())].into();
        cache.refresh_rows(projects, fake.clone()); await_poll(&cache);
        assert_eq!(selected(&cache, "0"), "ready_to_merge");
        // The branch's PR, whoever found it: `row_statuses` shows it on one carrier only.
        assert_eq!(cache.read("repo", "unowned", "branch-0")["pr"]["number"], 1);
        assert_eq!(cache.read("repo", "default", "main"), Value::Null);
        assert_eq!(cache.read("repo", "detached", "HEAD"), Value::Null);
        assert_eq!(cache.read("repo", "0", "branch-1"), Value::Null);
        due(&cache, false);
        cache.refresh_rows(rows(&["0"]), Fake { head:"unpushed", ..fake.clone() }); await_poll(&cache);
        assert_eq!(selected(&cache, "0"), "open_pr");
        assert_eq!(fake.calls.load(Ordering::SeqCst), 1);
        due(&cache, true);
        cache.refresh_rows(rows(&["0"]), Fake { head:"unpushed", state:"MERGED", ..fake.clone() }); await_poll(&cache);
        assert_eq!(selected(&cache, "0"), "local_only");
        assert_eq!(fake.calls.load(Ordering::SeqCst), 2);
    }
    #[test]
    fn new_views_join_next_batch_stale_facts_expire_and_limits_pause_only_remote_work() {
        let cache = Arc::new(PrCache::default()); let fake = Fake::default();
        cache.refresh_rows(rows(&["0"]), fake.clone()); await_poll(&cache);
        cache.refresh_rows(rows(&["1"]), fake.clone());
        due(&cache, true);
        cache.refresh_rows(rows(&["0"]), fake.clone()); await_poll(&cache);
        assert_eq!(selected(&cache, "1"), "ready_to_merge");
        cache.0.lock().unwrap().projects.get_mut("repo").unwrap().local_at = Instant::now() - LOCAL_FRESH;
        assert_eq!(selected(&cache, "0"), "no_changes");
        cache.0.lock().unwrap().projects.get_mut("repo").unwrap().local_at = Instant::now();
        cache.0.lock().unwrap().projects.get_mut("repo").unwrap().checked_at = Some(Instant::now() - FRESH_FOR);
        assert_eq!(selected(&cache, "0"), "no_changes");
        due(&cache, true);
        cache.refresh_rows(rows(&["0"]), Fake { limited:true, ..fake.clone() }); await_poll(&cache);
        let calls = fake.calls.load(Ordering::SeqCst);
        due(&cache, true);
        cache.refresh_rows([("other".into(), [("2".into(), "branch-2".into())].into())].into(), fake.clone()); await_poll(&cache);
        assert_eq!(fake.calls.load(Ordering::SeqCst), calls);
        assert_eq!(fake.scans.load(Ordering::SeqCst), 4);
        assert_eq!(selected(&cache, "0"), "no_changes");
    }
    #[test]
    fn native_cli_agrees_with_every_shared_branch_case() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../../packages/portable/src/sharedBranchCases.json")).unwrap();
        for case in cases {
            let members: Vec<_> = case["members"].as_array().unwrap().iter().map(|m| (m["id"].as_str().unwrap(), m["project"].as_str().unwrap(), m["branch"].as_str(), m["activeAt"].as_str().unwrap())).collect();
            let mut shared: Vec<_> = shared_branch_sessions(members).into_iter().collect();
            shared.sort();
            assert_eq!(json!(shared), case["shared"], "{}", case["name"]);
        }
    }
    #[test]
    fn workspace_work_is_read_off_path_and_expires_with_local_facts() {
        let cache = Arc::new(PrCache::default());
        let folders = [("repo".into(), ["/w/dirty".into(), "/w/ahead".into(), "/w/clean".into(), "/w/gone".into()].into())].into();
        cache.refresh_with(rows(&["0"]), folders, Fake::default());
        await_poll(&cache);
        assert_eq!(cache.read_work("repo", "/w/dirty"), "uncommitted");
        assert_eq!(cache.read_work("repo", "/w/ahead"), "committed");
        assert_eq!(cache.read_work("repo", "/w/clean"), "none");
        // Unreadable is unknown, never "no changes".
        assert_eq!(cache.read_work("repo", "/w/gone"), Value::Null);
        assert_eq!(cache.read_work("other", "/w/dirty"), Value::Null);
        assert_eq!(select(&json!({"tabs":[],"work":cache.read_work("repo", "/w/ahead")}))["id"], "local_only");
        cache.0.lock().unwrap().projects.get_mut("repo").unwrap().local_at = Instant::now() - LOCAL_FRESH;
        assert_eq!(cache.read_work("repo", "/w/dirty"), Value::Null);
    }
    #[test]
    fn the_cli_description_carries_the_open_pr_number_only() {
        let pr = |state: &str| json!({"tabs":[],"branch":"f","branchStatus":{"branch":"f","checked":true,"headMatches":true,"pr":{"number":781,"state":state,"draft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","checks":"FAILURE","inMergeQueue":false}}});
        let failing = select(&pr("OPEN"));
        assert_eq!((failing["label"].as_str(), failing["pr"].as_u64()), (Some("Checks failing"), Some(781)));
        assert!(failing.get("showsPr").is_none() && failing.get("when").is_none());
        assert_eq!(select(&pr("MERGED"))["pr"], Value::Null);
        assert_eq!(select(&json!({"tabs":[{"status":"waiting","activity":"needs_answer"}]}))["label"], "Needs approval");
    }
    fn entry(id: &str, branch: &str, at: &str, archived: bool) -> index::SessionEntry {
        serde_json::from_value(json!({"id":id,"projectPath":"/r","cwd":format!("/r/{id}"),"branch":branch,"title":id,"created":at,"modified":at,
            "lastMessageAt":at,"hasMessages":true,"worktreeRemoved":false,"archived":archived,"pinned":false,
            "tabs":[{"id":"t","harness":"claude","model":"","permissionMode":"auto","status":"idle","created":at,"modified":at}]})).unwrap()
    }
    fn sharing(mine: &[&index::SessionEntry], stored: &[&index::SessionEntry]) -> Vec<String> {
        fn keyed<'a>(list: &[&'a index::SessionEntry]) -> Vec<(&'a index::SessionEntry, String)> { list.iter().map(|s| (*s, "/r".to_string())).collect() }
        let (shared, _) = branch_sharing(&keyed(mine), &keyed(stored), &|_: &index::SessionEntry, _: &str| true);
        let mut shared: Vec<_> = shared.into_iter().collect();
        shared.sort();
        shared
    }
    #[test]
    fn archived_sessions_never_carry_a_branch_a_live_session_is_on_whoever_asks() {
        let live = entry("live", "f", "2026-11-10T10:00:00Z", false);
        let reviewer = entry("reviewer", "f", "2026-11-11T10:00:00Z", true);
        let stored = [&live, &reviewer];
        // The phone and the default list ask for live sessions only; Show archived and `--worktree` ask for both.
        assert_eq!(sharing(&[&live], &stored), Vec::<String>::new());
        assert_eq!(sharing(&[&live, &reviewer], &stored), ["reviewer"]);
        assert_eq!(sharing(&[&reviewer], &stored), ["reviewer"]);
        // The choice is the index's, not the request's: a later live peer carries the branch even when not asked for.
        let newer = entry("newer", "f", "2026-11-11T12:00:00Z", false);
        assert_eq!(sharing(&[&live], &[&live, &newer]), ["live"]);
        // With no live session on the branch, the latest archived one asked for carries it.
        let older = entry("older", "f", "2026-11-09T10:00:00Z", true);
        assert_eq!(sharing(&[&reviewer, &older], &[&reviewer, &older]), ["older"]);
    }
    #[test]
    fn a_session_that_does_not_carry_its_branch_loses_its_pr_and_workspace_facts() {
        let session = entry("s", "f", "2026-11-10T10:00:00Z", false);
        let pr = json!({"branch":"f","checked":true,"headMatches":true,"pr":{"number":9,"state":"OPEN","draft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","checks":"FAILURE","inMergeQueue":false}});
        let idle = || vec![json!({"status":"idle","activity":null})];
        let carrier = row_input(&session, idle(), false, Some((pr.clone(), json!("uncommitted"))));
        assert_eq!((select(&carrier)["id"].as_str(), select(&carrier)["pr"].as_u64()), (Some("checks_failing"), Some(9)));
        let other = row_input(&session, idle(), true, Some((pr.clone(), json!("uncommitted"))));
        assert_eq!((&other["branchStatus"], &other["work"], &other["sharedBranch"]), (&Value::Null, &Value::Null, &json!(true)));
        assert_eq!(select(&other)["id"], "shares_branch");
        let asking = row_input(&session, vec![json!({"status":"waiting","activity":"review_plan"})], true, Some((pr, Value::Null)));
        assert_eq!(select(&asking)["label"], "Needs approval");
    }
    #[test]
    fn a_session_with_a_conversation_has_started_before_its_messages_are_counted() {
        let mut fresh = entry("s", "f", "2026-11-10T10:00:00Z", false);
        fresh.unknown.remove("hasMessages");
        fresh.unknown.remove("lastMessageAt");
        let idle = || vec![json!({"status":"idle"})];
        assert!(!started(&fresh, &idle()));
        assert!(started(&fresh, &[json!({"status":"in_progress"})]));
        let mut old = fresh.clone();
        old.tabs[0].provider_session_id = Some("conversation".into());
        assert!(started(&old, &idle()));
        assert!(started(&entry("m", "f", "2026-11-10T10:00:00Z", false), &idle()));
    }
    #[test]
    fn a_panicked_worker_restarts_and_a_poisoned_cache_does_not_disable_it() {
        let cache = Arc::new(PrCache::default());
        cache.refresh_rows(rows(&["0"]), Fake { panic:true, ..Default::default() }); await_poll(&cache);
        cache.refresh_rows(rows(&["0"]), Fake::default()); await_poll(&cache);
        assert_eq!(selected(&cache, "0"), "ready_to_merge");
        let other = cache.clone();
        assert!(std::thread::spawn(move || { let _held = other.0.lock().unwrap(); panic!("poison"); }).join().is_err());
        due(&cache, true);
        cache.refresh_rows(rows(&["0"]), Fake { state:"MERGED", ..Default::default() }); await_poll(&cache);
        assert_eq!(selected(&cache, "0"), "merged");
    }
}
