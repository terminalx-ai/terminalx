use std::cell::Cell;
use std::sync::Arc;

use super::*;
use crate::sink::EventSink;

#[derive(Clone)]
struct Host(Arc<crate::sink::BroadcastSink>);

impl AutomationHost for Host {
    fn sink(&self) -> Arc<dyn EventSink> {
        self.0.clone()
    }
    fn sessions(&self) -> Result<crate::session::SessionManager> {
        bail!("polling a source asks for no session manager")
    }
}

fn host() -> Host {
    Host(Arc::new(crate::sink::BroadcastSink::new(16)))
}

fn at(minutes: i64) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-11-20T09:00:00Z").unwrap().with_timezone(&Utc) + chrono::TimeDelta::minutes(minutes)
}

fn linear_source() -> AutomationEventSource {
    AutomationEventSource::LinearIssue(LinearIssueSource { team_id: "team-1".into(), labels: vec!["bot".into()], ..Default::default() })
}

fn pr_source(events: &[PullRequestEvent]) -> AutomationEventSource {
    AutomationEventSource::GithubPullRequest(PullRequestSource { repo: "acme/widgets".into(), events: events.to_vec(), ..Default::default() })
}

fn automation(source: AutomationEventSource) -> Automation {
    let value = serde_json::json!({
        "id": "auto-events", "name": "Events", "enabled": true, "projectPath": "/project", "harness": "codex",
        "prompt": "Work on {{title}}.", "workspace": "newWorktree",
        "schedule": { "kind": "preset", "preset": "daily", "hour": 9, "minute": 0, "weekdays": [], "timezone": "UTC", "dtstart": "2026-09-01T09:00:00Z" },
        "nextRunAt": "2026-11-20T09:05:00Z", "created": "2026-11-20T09:00:00Z", "modified": "2026-11-20T09:00:00Z",
        "eventTrigger": { "source": source, "pollIntervalMinutes": 5, "maxRunsPerTick": 3 },
    });
    let automation: Automation = serde_json::from_value(value).unwrap();
    automation_store::save(std::slice::from_ref(&automation)).unwrap();
    automation
}

fn issue(id: &str) -> crate::issues::Issue {
    serde_json::from_value(serde_json::json!({
        "provider": "linear", "id": id, "identifier": format!("ENG-{id}"), "number": 1, "title": format!("Issue {id}"),
        "url": format!("https://linear.app/acme/issue/ENG-{id}"), "state": "Todo", "stateType": "open", "labels": [],
        "updatedAt": "2026-11-20T09:00:00Z",
    }))
    .unwrap()
}

fn pr(number: i64, sha: &str) -> PullRequest {
    PullRequest {
        number,
        title: format!("Change {number}"),
        url: format!("https://github.com/acme/widgets/pull/{number}"),
        head: format!("feature-{number}"),
        head_sha: sha.into(),
        base: "main".into(),
        author: "octo".into(),
        labels: Vec::new(),
        draft: false,
        from_fork: false,
        // Opened well after every test's source started.
        created_at: "2026-11-21T00:00:00Z".into(),
        review_requests: Vec::new(),
        check_failed: false,
    }
}

fn pulls(list: Vec<PullRequest>) -> Snapshot {
    Snapshot::PullRequests { pulls: list, viewer: Some("me".into()) }
}

/// One tick with `snapshot` as the source's answer; returns what woke.
fn tick(automation: &Automation, minute: i64, snapshot: Snapshot) -> Vec<WakeSubject> {
    let mut woken = Vec::new();
    poll(&host(), automation, at(minute), |_, _, _| Ok(snapshot), |wake| {
        woken.push(wake.what.clone());
        fake_run(automation, wake)
    })
    .unwrap();
    woken
}

/// A run as the launch records it, still going.
fn fake_run(automation: &Automation, wake: &Wake) -> Result<AutomationRun> {
    let mut run = new_run(&automation.id, AutomationTrigger::PullRequest, None, AutomationRunStatus::Pending);
    run.unknown.insert(SUBJECT.into(), json!(wake.subject));
    automation_store::insert_run(run)
}

fn finish_runs(automation: &Automation) {
    for run in automation_store::list_runs(&automation.id).unwrap() {
        automation_store::replace_run(&automation.id, &run.run_id, |value| {
            value.status = AutomationRunStatus::Completed;
            Ok(())
        })
        .unwrap();
    }
}

#[test]
fn a_new_linear_issue_wakes_exactly_one_run_and_what_existed_wakes_none() {
    let _home = crate::store::temp_home();
    let automation = automation(linear_source());
    assert!(tick(&automation, 0, Snapshot::Linear(vec![issue("1"), issue("2")])).is_empty(), "switching on starts from now");
    // Inside the interval nothing is read.
    let read = Cell::new(false);
    poll(&host(), &automation, at(2), |_, _, _| { read.set(true); Ok(Snapshot::Linear(Vec::new())) }, |_| unreachable!()).unwrap();
    assert!(!read.get(), "one request per interval");

    let woken = tick(&automation, 5, Snapshot::Linear(vec![issue("3"), issue("1"), issue("2")]));
    assert_eq!(woken, vec![WakeSubject::Linear(Box::new(issue("3")))]);
    finish_runs(&automation);
    assert!(tick(&automation, 10, Snapshot::Linear(vec![issue("3"), issue("1")])).is_empty(), "an issue wakes once");
}

#[test]
fn the_seen_record_survives_a_restart_and_a_launch_that_died() {
    let _home = crate::store::temp_home();
    let automation = automation(linear_source());
    tick(&automation, 0, Snapshot::Linear(Vec::new()));
    // The launch fails after the record was written, as a crash would leave it.
    let result = poll(&host(), &automation, at(5), |_, _, _| Ok(Snapshot::Linear(vec![issue("9")])), |_| bail!("the app quit"));
    assert!(result.is_err());
    let stored = load_seen(&automation.id).unwrap().unwrap();
    assert!(stored.events.contains_key("linear:9"), "recorded before the run started");
    // A new process reads the record from disk and does not start it again.
    assert!(tick(&automation, 10, Snapshot::Linear(vec![issue("9")])).is_empty());
}

#[test]
fn a_new_pull_request_and_a_new_push_each_wake_one_run() {
    let _home = crate::store::temp_home();
    let automation = automation(pr_source(&[PullRequestEvent::Opened, PullRequestEvent::Pushed]));
    assert!(tick(&automation, 0, pulls(vec![pr(1, "aaa")])).is_empty(), "an open pull request is not new");
    assert!(tick(&automation, 5, pulls(vec![pr(1, "aaa")])).is_empty());

    let woken = tick(&automation, 10, pulls(vec![pr(1, "aaa"), pr(2, "bbb")]));
    assert_eq!(woken, vec![WakeSubject::PullRequest(Box::new(pr(2, "bbb")), PullRequestEvent::Opened)], "its first head is part of the opening");
    // A push while that run is going waits for it.
    assert!(tick(&automation, 15, pulls(vec![pr(2, "ccc")])).is_empty());
    finish_runs(&automation);
    let woken = tick(&automation, 20, pulls(vec![pr(2, "ccc")]));
    assert_eq!(woken, vec![WakeSubject::PullRequest(Box::new(pr(2, "ccc")), PullRequestEvent::Pushed)]);
    finish_runs(&automation);
    assert!(tick(&automation, 25, pulls(vec![pr(2, "ccc")])).is_empty(), "the same head never wakes twice");
    let woken = tick(&automation, 30, pulls(vec![pr(1, "ddd")]));
    assert_eq!(woken, vec![WakeSubject::PullRequest(Box::new(pr(1, "ddd")), PullRequestEvent::Pushed)]);
}

#[test]
fn only_the_events_asked_for_wake_and_reviews_and_checks_wake_again_when_they_happen_again() {
    let _home = crate::store::temp_home();
    let automation = automation(pr_source(&[PullRequestEvent::ReviewRequested, PullRequestEvent::CheckFailed]));
    tick(&automation, 0, pulls(Vec::new()));
    assert!(tick(&automation, 5, pulls(vec![pr(3, "aaa")])).is_empty(), "opened and pushed were not asked for");

    let mut asked = pr(3, "aaa");
    asked.review_requests = vec!["ME".into(), "a-team".into()];
    assert_eq!(tick(&automation, 10, pulls(vec![asked.clone()])), vec![WakeSubject::PullRequest(Box::new(asked.clone()), PullRequestEvent::ReviewRequested)]);
    finish_runs(&automation);
    assert!(tick(&automation, 15, pulls(vec![asked.clone()])).is_empty());
    // The request is dropped, then made again.
    tick(&automation, 20, pulls(vec![pr(3, "aaa")]));
    assert_eq!(tick(&automation, 25, pulls(vec![asked.clone()])).len(), 1);
    finish_runs(&automation);

    let mut failing = pr(3, "aaa");
    failing.check_failed = true;
    assert_eq!(tick(&automation, 30, pulls(vec![failing.clone()])), vec![WakeSubject::PullRequest(Box::new(failing.clone()), PullRequestEvent::CheckFailed)]);
    finish_runs(&automation);
    assert!(tick(&automation, 35, pulls(vec![failing])).is_empty(), "one failure per head");
    let mut again = pr(3, "bbb");
    again.check_failed = true;
    assert_eq!(tick(&automation, 40, pulls(vec![again])).len(), 1, "a new head that fails wakes again");
}

#[test]
fn switching_off_and_on_or_changing_the_source_starts_from_now() {
    let _home = crate::store::temp_home();
    let mut automation = automation(linear_source());
    tick(&automation, 0, Snapshot::Linear(Vec::new()));
    automation.enabled = false;
    poll(&host(), &automation, at(5), |_, _, _| unreachable!(), |_| unreachable!()).unwrap();
    automation.enabled = true;
    assert!(tick(&automation, 10, Snapshot::Linear(vec![issue("4")])).is_empty(), "made while it was off");
    assert_eq!(tick(&automation, 15, Snapshot::Linear(vec![issue("4"), issue("5")])).len(), 1);

    let mut changed = linear_source();
    if let AutomationEventSource::LinearIssue(source) = &mut changed {
        source.labels = vec!["other".into()];
    }
    automation.event_trigger.as_mut().unwrap().source = changed;
    assert!(tick(&automation, 20, Snapshot::Linear(vec![issue("6")])).is_empty(), "another filter starts afresh");

    // Editing only the report keeps the record.
    if let AutomationEventSource::LinearIssue(source) = &mut automation.event_trigger.as_mut().unwrap().source {
        source.report.comment = false;
    }
    assert_eq!(tick(&automation, 25, Snapshot::Linear(vec![issue("7"), issue("6")])).len(), 1);
}

#[test]
fn an_unreadable_source_says_why_backs_off_and_recovers() {
    let _home = crate::store::temp_home();
    let automation = automation(linear_source());
    // No key in Settings: the real read says so.
    let AutomationEventSource::LinearIssue(source) = linear_source() else { unreachable!() };
    assert_eq!(read_linear(&source, None).unwrap_err().message, NO_LINEAR_KEY);

    poll(&host(), &automation, at(0), |_, _, _| Err(SourceError::plain(NO_LINEAR_KEY)), |_| unreachable!()).unwrap();
    let status = public_state(&automation.id).unwrap();
    assert_eq!(status.last_poll_error.as_deref(), Some(NO_LINEAR_KEY));
    let runs = automation_store::list_runs(&automation.id).unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].status, AutomationRunStatus::SkippedUnavailable);
    assert_eq!(runs[0].trigger, AutomationTrigger::LinearIssue, "listed under its own source, not as a GitHub issue");

    // The second failure doubles the wait.
    poll(&host(), &automation, at(5), |_, _, _| Err(SourceError::plain(NO_LINEAR_KEY)), |_| unreachable!()).unwrap();
    assert_eq!(load_seen(&automation.id).unwrap().unwrap().retry_after.as_deref(), Some(stamp(at(15)).as_str()));
    poll(&host(), &automation, at(12), |_, _, _| unreachable!("backing off"), |_| unreachable!()).unwrap();
    assert_eq!(automation_store::list_runs(&automation.id).unwrap()[0].repeat_count, 2, "the same error is one row");

    tick(&automation, 15, Snapshot::Linear(vec![issue("1")]));
    let state = load_seen(&automation.id).unwrap().unwrap();
    assert_eq!((state.last_poll_error, state.failures, state.retry_after), (None, 0, None));
    assert!(state.events.contains_key("linear:1"), "the first good read only records");
}

#[test]
fn errors_read_as_signed_out_or_rate_limited() {
    let signed_out = anyhow::anyhow!("To get started with GitHub CLI, please run:  gh auth login");
    assert_eq!(gh_error(&signed_out), SourceError::plain(GH_SIGNED_OUT));
    let limited = gh_error(&anyhow::anyhow!("GraphQL: API rate limit exceeded for user ID 1."));
    assert!(limited.rate_limited);
    assert!(linear_error(&anyhow::anyhow!("Linear answered 429: RATELIMITED")).rate_limited);
    assert_eq!(backoff(5, 1, false), chrono::TimeDelta::minutes(5));
    assert_eq!(backoff(5, 1, true), chrono::TimeDelta::minutes(15));
    assert_eq!(backoff(5, 9, false), chrono::TimeDelta::minutes(60));
}

#[test]
fn a_linear_source_reads_with_its_team_and_filter() {
    let source = LinearIssueSource {
        team_id: "team-1".into(),
        state: Some("unstarted".into()),
        labels: vec![" bot ".into(), "".into()],
        assignee: Some("me".into()),
        text: Some("login".into()),
        ..Default::default()
    };
    let variables = crate::issues::linear_list_variables(&linear_filter(&source)).unwrap();
    let filter = &variables["filter"];
    assert_eq!(filter["team"], json!({"id": {"eq": "team-1"}}));
    assert_eq!(filter["state"], json!({"type": {"eq": "unstarted"}}));
    assert_eq!(filter["labels"], json!({"some": {"name": {"in": ["bot"]}}}));
    assert_eq!(filter["assignee"], json!({"isMe": {"eq": true}}));
    assert_eq!(filter["or"][0], json!({"title": {"containsIgnoreCase": "login"}}));
    assert_eq!(variables["sort"], json!([{"updatedAt": {"order": "Descending"}}]));

    let open = linear_filter(&LinearIssueSource { team_id: "team-1".into(), assignee: Some("user-7".into()), ..Default::default() });
    let variables = crate::issues::linear_list_variables(&open).unwrap();
    assert_eq!(variables["filter"]["state"], json!({"type": {"nin": ["completed", "canceled"]}}));
    assert_eq!(variables["filter"]["assignee"], json!({"id": {"eq": "user-7"}}));
}

#[test]
fn a_pull_request_source_filters_by_base_author_labels_and_draft() {
    let mut source = PullRequestSource { repo: "acme/widgets".into(), events: vec![PullRequestEvent::Opened], ..Default::default() };
    let mut candidate = pr(1, "aaa");
    candidate.labels = vec!["Ready".into(), "bot".into()];
    assert!(pull_request_matches(&source, &candidate));
    source.base = Some("main".into());
    source.author = Some("@OCTO".into());
    source.labels = vec!["ready".into()];
    source.draft = Some(false);
    assert!(pull_request_matches(&source, &candidate));
    candidate.draft = true;
    assert!(!pull_request_matches(&source, &candidate), "only ready ones");
    candidate.draft = false;
    candidate.base = "release".into();
    assert!(!pull_request_matches(&source, &candidate), "another base");
    candidate.base = "main".into();
    candidate.author = "someone".into();
    assert!(!pull_request_matches(&source, &candidate), "another author");
    candidate.author = "octo".into();
    source.labels.push("missing".into());
    assert!(!pull_request_matches(&source, &candidate), "every label");
    assert_eq!(
        gh_list_args(&source)[8..],
        ["--limit", "50", "--base", "main", "--author", "@OCTO", "--label", "ready", "--label", "missing"].map(String::from)
    );
}

#[test]
fn gh_pull_requests_parse_with_review_requests_and_failed_checks() {
    let value = json!([
        { "number": 7, "title": "Fix", "url": "u", "headRefName": "fix", "headRefOid": "abc", "baseRefName": "main",
          "author": {"login": "octo"}, "labels": [{"name": "bot"}], "isDraft": true,
          "reviewRequests": [{"__typename": "User", "login": "me"}, {"__typename": "Team", "slug": "core"}],
          "statusCheckRollup": [{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"}, {"__typename": "StatusContext", "state": "ERROR"}] },
        { "number": 8, "title": "Wip", "url": "u", "headRefName": "wip", "headRefOid": "def", "baseRefName": "main", "author": {"login": "x"},
          "labels": [], "isDraft": false, "reviewRequests": [],
          "statusCheckRollup": [{"__typename": "CheckRun", "status": "IN_PROGRESS", "conclusion": ""}, {"__typename": "CheckRun", "conclusion": "CANCELLED"}] },
    ]);
    let parsed = parse_pull_requests(&value);
    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].review_requests, vec!["me", "core"]);
    assert!(parsed[0].check_failed && parsed[0].draft);
    assert_eq!(parsed[0].labels, vec!["bot"]);
    assert!(!parsed[1].check_failed, "running and cancelled checks are not failures");
}

#[test]
fn the_run_is_given_the_pull_request_number_head_base_and_event() {
    let prompt = pull_request_prompt("Review #{{number}} ({{event}}) {{head}} -> {{base}}", &pr(12, "0123456789abcdef"), PullRequestEvent::Pushed);
    assert!(prompt.starts_with("Review #12 (pushed) feature-12 -> main"));
    assert!(prompt.contains("pull request #12 (new commits pushed): head `feature-12` at 0123456789ab into base `main`"));
}

#[test]
fn an_event_trigger_saves_validates_and_stays_off_the_issue_trigger() {
    let source = pr_source(&[PullRequestEvent::Opened]);
    let input = |trigger: Value| -> super::super::AutomationInput {
        serde_json::from_value(json!({
            "name": "Watch PRs", "projectPath": "/project", "harness": "claude", "prompt": "Review it.", "workspace": "newWorktree",
            "schedule": { "kind": "preset", "preset": "daily", "hour": 9, "minute": 0, "weekdays": [], "timezone": "UTC", "dtstart": "2026-09-01T09:00:00Z" },
            "eventTrigger": trigger,
        }))
        .unwrap()
    };
    let saved = super::super::definition_from_input(input(json!({"source": source, "pollIntervalMinutes": 2})), None, at(0)).unwrap();
    assert_eq!(saved.event_trigger.as_ref().unwrap().max_runs_per_tick, 3);
    assert_eq!(saved.next_run_at, stamp(at(2)));
    let json = serde_json::to_value(&saved).unwrap();
    assert_eq!(json["eventTrigger"]["source"]["kind"], "githubPullRequest");
    assert!(json.get("issueTrigger").is_none());

    let empty = json!({"source": {"kind": "githubPullRequest", "repo": "acme/widgets", "events": []}});
    assert!(super::super::definition_from_input(input(empty), None, at(0)).unwrap_err().to_string().contains("event"));
    let no_team = json!({"source": {"kind": "linearIssue", "teamId": " "}});
    assert!(super::super::definition_from_input(input(no_team), None, at(0)).unwrap_err().to_string().contains("Linear team"));
}

#[test]
fn linear_polls_only_read_issues_made_after_the_source_started() {
    let _home = crate::store::temp_home();
    let AutomationEventSource::LinearIssue(source) = linear_source() else { unreachable!() };
    assert!(linear_variables(&source, None).unwrap()["filter"].get("createdAt").is_none(), "the preview lists what matches now");
    let variables = linear_variables(&source, Some("2026-11-20T09:00:00.000Z")).unwrap();
    assert_eq!(variables["filter"]["createdAt"], json!({"gt": "2026-11-20T09:00:00.000Z"}));
    assert_eq!(variables["filter"]["team"], json!({"id": {"eq": "team-1"}}), "and the rest of the filter stays");

    // The read is given the moment the source started, kept across ticks.
    let automation = automation(linear_source());
    let seen = std::cell::RefCell::new(Vec::new());
    for minute in [0, 5] {
        poll(&host(), &automation, at(minute), |_, _, state| { seen.borrow_mut().push(state.started_at.clone()); Ok(Snapshot::Linear(Vec::new())) }, |_| unreachable!()).unwrap();
    }
    assert_eq!(*seen.borrow(), vec![Some(stamp(at(0))), Some(stamp(at(0)))]);
}

#[test]
fn a_pull_request_open_before_the_start_does_not_wake_when_it_first_shows_up() {
    let _home = crate::store::temp_home();
    let automation = automation(pr_source(&[PullRequestEvent::Opened, PullRequestEvent::Pushed]));
    // The first read lists one page; an older pull request is not on it.
    tick(&automation, 0, pulls(vec![pr(1, "aaa")]));
    let mut old = pr(2, "bbb");
    old.created_at = "2026-10-01T00:00:00Z".into();
    assert!(tick(&automation, 5, pulls(vec![pr(1, "aaa"), old.clone()])).is_empty(), "it existed before the trigger");
    old.head_sha = "ccc".into();
    assert_eq!(tick(&automation, 10, pulls(vec![old.clone()])), vec![WakeSubject::PullRequest(Box::new(old), PullRequestEvent::Pushed)], "its next push is new");
}

#[test]
fn pull_requests_from_forks_wake_only_when_asked_for() {
    let mut source = PullRequestSource { repo: "acme/widgets".into(), events: vec![PullRequestEvent::Opened], ..Default::default() };
    let mut fork = pr(4, "aaa");
    fork.from_fork = true;
    assert!(!pull_request_matches(&source, &fork), "anyone can open one");
    assert!(pull_request_matches(&source, &pr(5, "bbb")));
    source.from_forks = true;
    assert!(pull_request_matches(&source, &fork));
    let parsed = parse_pull_requests(&json!([{ "number": 1, "headRefOid": "a", "isCrossRepository": true, "createdAt": "2026-11-20T10:00:00Z" }]));
    assert!(parsed[0].from_fork);
    assert_eq!(parsed[0].created_at, "2026-11-20T10:00:00Z");
    assert!(gh_list_args(&source).iter().any(|arg| arg.contains("isCrossRepository") && arg.contains("createdAt")));
}

#[test]
fn a_run_is_reported_by_the_issue_it_worked_on_not_the_trigger_now() {
    let _home = crate::store::temp_home();
    // The automation now watches pull requests; its two older runs are an issue each.
    let automation = automation(pr_source(&[PullRequestEvent::Opened]));
    let mut linear = new_run(&automation.id, AutomationTrigger::LinearIssue, None, AutomationRunStatus::Running);
    linear.issue = Some(linear_ref(&issue("1")));
    let linear = automation_store::insert_run(linear).unwrap();
    let mut github = new_run(&automation.id, AutomationTrigger::Issue, None, AutomationRunStatus::Running);
    github.issue = Some(index::IssueRef { provider: "github".into(), id: "node-1".into(), identifier: "#1".into(), title: "Bug".into(), url: "u".into() });
    let github = automation_store::insert_run(github).unwrap();
    assert!(is_linear_run(&automation.id, &linear.run_id));
    assert!(!is_linear_run(&automation.id, &github.run_id), "a GitHub issue run keeps the GitHub report");
}
