//! Presentation facts, separate from the four lifecycle states. All callers
//! share one owner cache; reading a row never waits on GitHub.
use super::*;
use std::collections::{BTreeMap, BTreeSet};
use serde_json::json;

#[derive(Default)]
pub(crate) struct PrCache(Mutex<Cache>);
#[derive(Default)]
struct Cache {
    projects: HashMap<String, ProjectStatus>,
    wanted: BTreeMap<String, BTreeMap<String, Instant>>,
    busy: bool,
    paused: Option<Instant>,
}
struct ProjectStatus {
    failures: u32,
    due: Instant,
    checked_at: Option<Instant>,
    branches: Vec<String>,
    prs: Option<HashMap<String, crate::github::BranchPr>>,
}

impl SessionManager {
    /// Only sessions the caller may see enter here. Project paths come from
    /// the session index, never from a phone or a remote request's parameters.
    pub(crate) fn row_statuses(&self, sessions: &[index::SessionEntry]) -> BTreeMap<String, Value> {
        let mut projects: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
        let paths: HashMap<_, _> = sessions.iter().map(|s| s.project_path.clone()).collect::<BTreeSet<_>>().into_iter().map(|path| {
            let key = project_key(&path);
            (path, key)
        }).collect();
        let excluded_projects: BTreeSet<_> = store::projects::list().map(|(projects, _)| projects.into_iter().filter(|p| p.archived || p.kind == store::projects::ProjectKind::Folder).map(|p| project_key(&p.path)).collect()).unwrap_or_default();
        for session in sessions.iter().filter(|s| !s.is_quick() && !s.worktree_removed && !excluded_projects.contains(&paths[&s.project_path])) {
            if let Some(branch) = &session.branch { projects.entry(paths[&session.project_path].clone()).or_default().insert(branch.clone()); }
        }
        self.row_prs.refresh(projects);
        sessions.iter().map(|session| {
            let tabs: Vec<_> = session.tabs.iter().map(|tab| {
                let runtime = self.tabs.lock().unwrap().get(&key_of(&session.id, &tab.id)).cloned();
                let (status, activity) = runtime.as_ref().map(|rt| {
                    let rt = rt.lock().unwrap();
                    (rt.status, activity(&rt))
                }).unwrap_or((tab.status, None));
                let activity = activity.or_else(|| (!matches!(status, TabStatus::InProgress | TabStatus::Waiting) && self.background_work(&session.id, &tab.id).is_some()).then_some("background"));
                json!({"status": status, "activity": activity})
            }).collect();
            let branch_status = if session.is_quick() || session.worktree_removed { Value::Null } else {
                session.branch.as_ref().map(|branch| self.row_prs.read(&paths[&session.project_path], branch)).unwrap_or(Value::Null)
            };
            (session.id.clone(), json!({"tabs":tabs,"branch":session.branch,"branchStatus":branch_status}))
        }).collect()
    }

    /// CLI and cloud session snapshots carry the same facts as desktop and phone.
    /// These are read-time annotations, never persisted into the session index.
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

impl PrCache {
    fn read(&self, project: &str, branch: &str) -> Value {
        let cache = self.0.lock().unwrap();
        let prs = cache.projects.get(project).filter(|p| p.branches.iter().any(|b| b == branch) && p.checked_at.is_some_and(|at| at.elapsed() < Duration::from_secs(90))).and_then(|p| p.prs.as_ref());
        json!({"branch":branch,"checked":prs.is_some(),"pr":prs.and_then(|prs| prs.get(branch))})
    }

    fn refresh(self: &Arc<Self>, projects: BTreeMap<String, BTreeSet<String>>) {
        self.refresh_with(projects, crate::github::rows::poll);
    }

    fn refresh_with(self: &Arc<Self>, projects: BTreeMap<String, BTreeSet<String>>, poll: impl Fn(&Path, &[String]) -> crate::github::rows::Poll + Send + 'static) {
        let now = Instant::now();
        let mut cache = self.0.lock().unwrap();
        for (project, branches) in projects {
            let wanted = cache.wanted.entry(project).or_default();
            for branch in branches { wanted.insert(branch, now); }
        }
        cache.wanted.retain(|_, branches| {
            branches.retain(|_, seen| now.duration_since(*seen) < Duration::from_secs(60));
            !branches.is_empty()
        });
        if cache.busy || cache.paused.is_some_and(|until| until > now) { return; }
        let due: Vec<_> = cache.wanted.iter().filter(|(path, _)| cache.projects.get(*path).is_none_or(|p| p.due <= now))
            .map(|(path, branches)| (path.clone(), branches.keys().cloned().collect::<Vec<_>>())).collect();
        if due.is_empty() { return; }
        cache.busy = true;
        let owner = self.clone();
        std::thread::spawn(move || {
            for (path, branches) in due {
                let poll = poll(Path::new(&path), &branches);
                let mut cache = owner.0.lock().unwrap();
                let now = Instant::now();
                let failures = if poll.prs.is_err() { cache.projects.get(&path).map_or(1, |p| p.failures.saturating_add(1)) } else { 0 };
                let wait = if failures > 0 {
                    poll.retry_after.max(Duration::from_secs(60 * 2_u64.pow(failures.min(6) - 1)))
                } else { poll.retry_after };
                if poll.limited { cache.paused = Some(now + wait); }
                cache.projects.insert(path, ProjectStatus { failures, due: now + wait, checked_at: poll.prs.as_ref().ok().map(|_| now), branches, prs: poll.prs.ok() });
                if poll.limited { break; }
            }
            owner.0.lock().unwrap().busy = false;
        });
    }
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

    #[test]
    fn native_cli_agrees_with_every_portable_case() {
        let cases: Vec<Value> = serde_json::from_str(include_str!("../../packages/portable/src/sessionStatusCases.json")).unwrap();
        for case in cases { assert_eq!(select(&case["input"])["id"], case["expected"], "{}", case["name"]); }
    }

    fn await_poll(cache: &PrCache) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while cache.0.lock().unwrap().busy {
            assert!(Instant::now() < deadline, "poll did not finish");
            std::thread::yield_now();
        }
    }

    #[test]
    fn rows_and_windows_share_one_project_query_and_changes_arrive_on_next_poll() {
        let cache = Arc::new(PrCache::default());
        let calls = Arc::new(AtomicUsize::new(0));
        let projects: BTreeMap<_, _> = [("repo".into(), (0..100).map(|n| format!("branch-{n}")).collect())].into();
        for state in ["OPEN", "MERGED"] {
            let count = calls.clone();
            let gate = Arc::new(std::sync::Barrier::new(2));
            let worker = gate.clone();
            cache.refresh_with(projects.clone(), move |_, branches| {
                assert_eq!(branches.len(), 100);
                count.fetch_add(1, Ordering::SeqCst);
                worker.wait();
                crate::github::rows::Poll { prs: Ok([("branch-0".into(), crate::github::BranchPr { state: state.into(), ..Default::default() })].into()), retry_after: Duration::from_secs(30), limited: false }
            });
            // A concurrent window cannot start a second request.
            cache.refresh_with(projects.clone(), |_, _| panic!("duplicate in-flight poll"));
            gate.wait();
            await_poll(&cache);
            assert_eq!(cache.read("repo", "branch-0")["pr"]["state"], state);
            assert_eq!(cache.read("repo", "branch-99")["checked"], true);
            assert_eq!(cache.read("repo", "new-branch")["checked"], false);
            cache.refresh_with(projects.clone(), |_, _| panic!("poll before interval"));
            cache.0.lock().unwrap().projects.get_mut("repo").unwrap().due = Instant::now();
        }
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn rate_limits_pause_other_projects_and_errors_never_mean_local_only() {
        let cache = Arc::new(PrCache::default());
        let projects = [("a".into(), ["branch".into()].into()), ("b".into(), ["branch".into()].into())].into();
        cache.refresh_with(projects, |path, _| {
            assert_eq!(path, Path::new("a"));
            crate::github::rows::Poll { prs: Err(anyhow::anyhow!("secondary rate limit")), retry_after: Duration::from_secs(120), limited: true }
        });
        await_poll(&cache);
        assert_eq!(cache.read("a", "branch")["checked"], false);
        cache.refresh_with([("b".into(), ["branch".into()].into())].into(), |_, _| panic!("ignored global backoff"));
    }

    #[test]
    fn different_views_contribute_to_the_next_batch_and_expired_data_is_unknown() {
        let cache = Arc::new(PrCache::default());
        let requested = |branch: &str| [("repo".into(), [branch.into()].into())].into();
        let answer = || crate::github::rows::Poll { prs: Ok(HashMap::new()), retry_after: Duration::from_secs(30), limited: false };
        cache.refresh_with(requested("first"), move |_, _| answer());
        await_poll(&cache);
        cache.refresh_with(requested("second"), |_, _| panic!("a new row cannot bypass the interval"));
        cache.0.lock().unwrap().projects.get_mut("repo").unwrap().due = Instant::now();
        cache.refresh_with(requested("first"), move |_, branches| {
            assert_eq!(branches, ["first", "second"]);
            answer()
        });
        await_poll(&cache);
        assert_eq!(cache.read("repo", "second")["checked"], true);
        cache.0.lock().unwrap().projects.get_mut("repo").unwrap().checked_at = Some(Instant::now() - Duration::from_secs(91));
        assert_eq!(cache.read("repo", "second")["checked"], false);
    }
}
