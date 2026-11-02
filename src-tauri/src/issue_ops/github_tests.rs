use std::collections::VecDeque;

use serde_json::{json, Value};

use super::*;

const REPO: &str = "acme/widgets";
const SANDBOX: &str = "527";

fn recording() -> Value {
    serde_json::from_str(include_str!("../fixtures/github_issue_ops.json")).unwrap()
}

/// Stands in for `gh api`: answers each call with the next recorded reply,
/// after checking it is the call that was recorded.
struct Replay {
    calls: VecDeque<Value>,
}

impl Replay {
    fn step(name: &str) -> Replay {
        Replay { calls: recording()["steps"][name].as_array().unwrap_or_else(|| panic!("no step {name}")).iter().cloned().collect() }
    }

    /// A recorded step, after the issue read each comment call now starts with.
    fn step_after_read(name: &str, number: i64) -> Replay {
        let mut replay = Replay::step(name);
        replay.calls.push_front(issue_read(number));
        replay
    }

    fn of(calls: Vec<Value>) -> Replay {
        Replay { calls: calls.into() }
    }

    fn api(&mut self) -> impl FnMut(&str, &str, Option<&Value>) -> OpResult<Value> + '_ {
        move |method, path, body| {
            let call = self.calls.pop_front().unwrap_or_else(|| panic!("unexpected {method} {path}"));
            assert_eq!((method, path), (call["method"].as_str().unwrap(), call["path"].as_str().unwrap()));
            assert_eq!(body, call.get("body"), "{method} {path}");
            match call.get("error") {
                Some(kind) => Err(IssueOpError::new(serde_json::from_value(kind.clone()).unwrap(), Provider::Github)),
                None => Ok(call["reply"].clone()),
            }
        }
    }

    fn done(&self) {
        assert!(self.calls.is_empty(), "calls not made: {:?}", self.calls);
    }
}

fn call(method: &str, path: &str, body: Option<Value>, reply: Value) -> Value {
    let mut call = json!({"method": method, "path": path, "reply": reply});
    if let Some(body) = body {
        call["body"] = body;
    }
    call
}

/// The recorded issue read, as issue `number`.
fn issue_read(number: i64) -> Value {
    let mut issue = reply("details", 0);
    issue["number"] = json!(number);
    call("GET", &format!("repos/acme/widgets/issues/{number}"), None, issue)
}

fn session() -> Mutex<Session> {
    Mutex::new(Session::default())
}

/// A recorded reply, by step and call.
fn reply(step: &str, index: usize) -> Value {
    recording()["steps"][step][index]["reply"].clone()
}

#[test]
fn details_read_the_recorded_issue_and_refuse_pull_requests() {
    let mut replay = Replay::step("details");
    let details = details_with(&mut replay.api(), REPO, SANDBOX).unwrap();
    replay.done();
    assert_eq!(details.issue.identifier, "#527");
    assert_eq!(details.issue.assignees.iter().map(|user| user.id.as_str()).collect::<Vec<_>>(), ["sam"]);
    assert_eq!(details.author.unwrap().login.as_deref(), Some("sam"));
    assert_eq!(details.issue.url, "https://github.com/acme/widgets/issues/527");

    for (step, write) in [("details_pr", false), ("title_pr", true)] {
        let mut replay = Replay::step(step);
        let error = if write { set_title_with(&mut replay.api(), REPO, "526", "never") } else { details_with(&mut replay.api(), REPO, "526") }.unwrap_err();
        replay.done();
        assert_eq!((error.kind, error.message.as_str()), (IssueOpErrorKind::NotFound, "That number is a pull request, not an issue."));
    }
    let mut replay = Replay::step("details_missing");
    assert_eq!(details_with(&mut replay.api(), REPO, "99999999").unwrap_err().kind, IssueOpErrorKind::NotFound);
}

#[test]
fn options_list_assignable_users_labels_and_close_reasons_and_are_kept_for_the_session() {
    let session = session();
    let mut replay = Replay::step("options");
    let options = options_with(&mut replay.api(), &session, REPO, false).unwrap();
    replay.done();
    assert_eq!(options.members.iter().map(|user| user.id.as_str()).collect::<Vec<_>>(), ["alex", "sam"]);
    assert_eq!(options.close_reasons, [CloseReason::Completed, CloseReason::NotPlanned]);
    assert_eq!(options.labels.len(), 25);
    let bug = options.labels.iter().find(|label| label.name == "bug").unwrap();
    assert_eq!((bug.id.as_str(), bug.color.as_str(), bug.description.as_deref()), ("bug", "D73A4A", Some("Something is broken")));
    assert!(options.states.is_empty() && options.priorities.is_empty());
    let mut labels = reply("options", 1);
    labels[0]["archived_at"] = json!("2026-10-01T00:00:00Z");
    assert_eq!(parse_options(&[], labels.as_array().unwrap()).labels.len(), 24);
    assert_eq!(options.capabilities, IssueCapabilities::of(Provider::Github));

    // Kept: a second ask makes no call, and the repository's case doesn't matter.
    let mut none = Replay::of(vec![]);
    assert_eq!(options_with(&mut none.api(), &session, "Acme/Widgets", false).unwrap(), options);
    // A refresh reads them again.
    let mut again = Replay::step("options");
    options_with(&mut again.api(), &session, REPO, true).unwrap();
    again.done();
}

#[test]
fn pages_are_followed_while_they_are_full() {
    let full: Vec<Value> = (0..100).map(|n| json!({"login": format!("user{n}")})).collect();
    let mut replay = Replay::of(vec![
        call("GET", "repos/acme/widgets/assignees?per_page=100&page=1", None, json!(full)),
        call("GET", "repos/acme/widgets/assignees?per_page=100&page=2", None, json!([{"login": "last"}])),
        call("GET", "repos/acme/widgets/labels?per_page=100&page=1", None, json!([])),
    ]);
    let options = options_with(&mut replay.api(), &session(), REPO, false).unwrap();
    replay.done();
    assert_eq!(options.members.len(), 101);
    assert_eq!(options.members[100].id, "last");
}

#[test]
fn comments_come_a_page_at_a_time_with_what_the_viewer_may_do() {
    let session = session();
    let mut replay = Replay::step_after_read("comments", 527);
    let page = comments_with(&mut replay.api(), &session, REPO, SANDBOX, None).unwrap();
    replay.done();
    assert_eq!(page.next_cursor, None);
    let comment = &page.comments[0];
    assert_eq!(comment.id, "6246849811");
    assert_eq!(comment.body, "[TerminalX test] IM-1 live check comment — will be deleted");
    assert_eq!(comment.author.as_ref().unwrap().avatar_url.as_deref(), Some("https://avatars.githubusercontent.com/u/12?v=4"));
    assert_eq!(comment.created_at, "2026-10-18T06:58:53Z");
    assert_eq!(comment.edited_at, None);
    assert_eq!(comment.url.as_deref(), Some("https://github.com/acme/widgets/issues/527#issuecomment-6246849811"));
    assert!(comment.viewer_can_edit && comment.viewer_can_delete);

    // The viewer and their access are kept; the next page is the comments alone.
    let mut later = Replay::of(vec![issue_read(527), call("GET", "repos/acme/widgets/issues/527/comments?per_page=50&page=2", None, json!([]))]);
    assert_eq!(comments_with(&mut later.api(), &session, REPO, SANDBOX, Some("2")).unwrap(), CommentsPage { comments: vec![], next_cursor: None });
    later.done();

    let full: Vec<Value> = (0..50).map(|_| reply("comments", 2)[0].clone()).collect();
    let mut full_page = Replay::of(vec![issue_read(527), call("GET", "repos/acme/widgets/issues/527/comments?per_page=50&page=3", None, json!(full))]);
    assert_eq!(comments_with(&mut full_page.api(), &session, REPO, SANDBOX, Some("3")).unwrap().next_cursor.as_deref(), Some("4"));

    for bad in ["0", "next", "-1"] {
        assert_eq!(comments_with(&mut Replay::of(vec![]).api(), &session, REPO, SANDBOX, Some(bad)).unwrap_err().kind, IssueOpErrorKind::Invalid);
    }
}

#[test]
fn only_the_author_or_someone_with_write_access_may_change_a_comment() {
    let comment = reply("comments", 2)[0].clone();
    let reader = Access { viewer: "alex".into(), moderates: false };
    let parsed = parse_comment(&comment, &reader).unwrap();
    assert!(!parsed.viewer_can_edit && !parsed.viewer_can_delete);
    let maintainer = Access { viewer: "alex".into(), moderates: true };
    assert!(parse_comment(&comment, &maintainer).unwrap().viewer_can_edit);
    let author = Access { viewer: "SAM".into(), moderates: false };
    assert!(parse_comment(&comment, &author).unwrap().viewer_can_delete);
}

#[test]
fn comments_are_added_edited_and_deleted_on_this_issue_only() {
    let mut replay = Replay::step("comment_add");
    let added = comment_add_with(&mut replay.api(), REPO, SANDBOX, "[TerminalX test] IM-1 live check comment — will be deleted").unwrap();
    replay.done();
    assert_eq!(added.id, "6246849811");
    assert!(added.viewer_can_edit && added.viewer_can_delete);

    let mut replay = Replay::step_after_read("comment_edit", 527);
    let edited = comment_edit_with(&mut replay.api(), REPO, SANDBOX, "6246849811", "[TerminalX test] IM-1 live check comment (edited) — will be deleted").unwrap();
    replay.done();
    assert!(edited.body.contains("(edited)"));
    assert_eq!(edited.edited_at.as_deref(), Some("2026-10-18T06:58:56Z"));

    // A comment on another issue is not touched.
    let mut replay = Replay::step_after_read("comment_edit_wrong_issue", 1);
    let error = comment_edit_with(&mut replay.api(), REPO, "1", "6246849811", "x").unwrap_err();
    replay.done();
    assert_eq!((error.kind, error.message.as_str()), (IssueOpErrorKind::NotFound, "That comment isn't on this issue."));

    let mut replay = Replay::step_after_read("comment_delete", 527);
    comment_delete_with(&mut replay.api(), REPO, SANDBOX, "6246849811").unwrap();
    replay.done();
    let mut replay = Replay::step_after_read("comment_delete_again", 527);
    assert_eq!(comment_delete_with(&mut replay.api(), REPO, SANDBOX, "6246849811").unwrap_err().kind, IssueOpErrorKind::NotFound);

    // A pull request's comments are neither listed nor changed.
    let pr = || Replay::of(vec![call("GET", "repos/acme/widgets/issues/526", None, reply("details_pr", 0))]);
    let refused = |result: OpResult<()>| assert_eq!(result.unwrap_err().message, "That number is a pull request, not an issue.");
    refused(comments_with(&mut pr().api(), &session(), REPO, "526", None).map(drop));
    refused(comment_add_with(&mut pr().api(), REPO, "526", "x").map(drop));
    refused(comment_edit_with(&mut pr().api(), REPO, "526", "6246849811", "x").map(drop));
    refused(comment_delete_with(&mut pr().api(), REPO, "526", "6246849811"));

    let none = || Replay::of(vec![]);
    assert_eq!(comment_add_with(&mut none().api(), REPO, SANDBOX, "  \n").unwrap_err().kind, IssueOpErrorKind::Invalid);
    assert_eq!(comment_edit_with(&mut none().api(), REPO, SANDBOX, "../labels", "x").unwrap_err().kind, IssueOpErrorKind::Invalid);
}

#[test]
fn state_closes_with_a_reason_and_reopens() {
    for (step, change, state, reason) in [
        ("close_not_planned", StateChange::Close { reason: CloseReason::NotPlanned }, "canceled", Some(CloseReason::NotPlanned)),
        ("close_completed", StateChange::Close { reason: CloseReason::Completed }, "completed", Some(CloseReason::Completed)),
        ("reopen", StateChange::Reopen, "open", None),
    ] {
        let mut replay = Replay::step(step);
        let details = set_state_with(&mut replay.api(), REPO, SANDBOX, &change).unwrap();
        replay.done();
        assert_eq!((details.issue.state_type.as_str(), details.close_reason), (state, reason), "{step}");
    }
}

#[test]
fn assignees_are_set_as_a_whole() {
    let mut replay = Replay::step("assignees_none");
    assert!(set_assignees_with(&mut replay.api(), REPO, SANDBOX, &[]).unwrap().issue.assignees.is_empty());
    replay.done();
    let mut replay = Replay::step("assignees_me");
    let details = set_assignees_with(&mut replay.api(), REPO, SANDBOX, &["@sam".into()]).unwrap();
    replay.done();
    assert_eq!(details.issue.assignees.iter().map(|user| user.id.as_str()).collect::<Vec<_>>(), ["sam"]);

    // Only the difference is sent: removals first, so ten never becomes eleven.
    let mut issue = reply("details", 0);
    issue["assignees"] = json!([{"login": "sam"}, {"login": "alex"}]);
    let mut after = issue.clone();
    after["assignees"] = json!([{"login": "alex"}, {"login": "robin"}]);
    let mut replay = Replay::of(vec![
        call("GET", "repos/acme/widgets/issues/527", None, issue.clone()),
        call("DELETE", "repos/acme/widgets/issues/527/assignees", Some(json!({"assignees": ["sam"]})), issue.clone()),
        call("POST", "repos/acme/widgets/issues/527/assignees", Some(json!({"assignees": ["robin"]})), after),
    ]);
    let details = set_assignees_with(&mut replay.api(), REPO, SANDBOX, &["Alex".into(), "robin".into(), "robin".into()]).unwrap();
    replay.done();
    assert_eq!(details.issue.assignees.len(), 2);
    // When adding fails, the removed logins are put back and the error stands.
    let mut replay = Replay::of(vec![
        call("GET", "repos/acme/widgets/issues/527", None, issue.clone()),
        call("DELETE", "repos/acme/widgets/issues/527/assignees", Some(json!({"assignees": ["sam"]})), issue.clone()),
        json!({"method": "POST", "path": "repos/acme/widgets/issues/527/assignees", "body": {"assignees": ["robin"]}, "error": "network"}),
        call("POST", "repos/acme/widgets/issues/527/assignees", Some(json!({"assignees": ["sam"]})), issue.clone()),
    ]);
    assert_eq!(set_assignees_with(&mut replay.api(), REPO, SANDBOX, &["alex".into(), "robin".into()]).unwrap_err().kind, IssueOpErrorKind::Network);
    replay.done();
    // Nothing to change: the read is the answer.
    let mut replay = Replay::of(vec![call("GET", "repos/acme/widgets/issues/527", None, issue)]);
    set_assignees_with(&mut replay.api(), REPO, SANDBOX, &["alex".into(), "sam".into()]).unwrap();
    replay.done();
}

#[test]
fn labels_are_set_as_the_repository_spells_them_and_never_created() {
    let session = session();
    let mut options = Replay::step("options");
    options_with(&mut options.api(), &session, REPO, false).unwrap();
    let mut replay = Replay::step("labels_set");
    let details = set_labels_with(&mut replay.api(), &session, REPO, SANDBOX, &["Documentation".into(), "question".into()]).unwrap();
    replay.done();
    assert_eq!(details.issue.labels.iter().map(|label| label.name.as_str()).collect::<Vec<_>>(), ["documentation", "question"]);

    // An unknown name reads the labels again, then is refused before any write.
    let mut replay = Replay::step("labels_unknown");
    let error = set_labels_with(&mut replay.api(), &session, REPO, SANDBOX, &["no-such-label-terminalx".into()]).unwrap_err();
    replay.done();
    assert_eq!((error.kind, error.message.as_str()), (IssueOpErrorKind::Invalid, "That label doesn't exist in this repository."));

    let mut replay = Replay::step("labels_clear");
    assert!(set_labels_with(&mut replay.api(), &session, REPO, SANDBOX, &[]).unwrap().issue.labels.is_empty());
    replay.done();
}

#[test]
fn title_and_description_are_written_and_a_stale_description_is_a_conflict() {
    let mut replay = Replay::step("title_set");
    assert!(set_title_with(&mut replay.api(), REPO, SANDBOX, "[TerminalX test] issue-management sandbox — ignore (title edit check)").unwrap().issue.title.ends_with("(title edit check)"));
    replay.done();
    let mut replay = Replay::step("title_restore");
    set_title_with(&mut replay.api(), REPO, SANDBOX, "[TerminalX test] issue-management sandbox — ignore").unwrap();
    replay.done();

    let original = reply("details", 0)["body"].as_str().unwrap().to_string();
    let mut replay = Replay::step("description_stale");
    let stale = DescriptionEdit { description: "should not land".into(), expected_updated_at: Some("2026-10-18T06:31:10Z".into()), expected_description: None };
    assert_eq!(set_description_with(&mut replay.api(), REPO, SANDBOX, &stale).unwrap_err().kind, IssueOpErrorKind::Conflict);
    replay.done();

    let read = reply("description_set", 0)["updated_at"].as_str().unwrap().to_string();
    let mut replay = Replay::step("description_set");
    // The same instant spelled another way is no conflict.
    let edit = DescriptionEdit { description: format!("{original}\n\n(description edit check)"), expected_updated_at: Some(read.replace('Z', "+00:00")), expected_description: None };
    let details = set_description_with(&mut replay.api(), REPO, SANDBOX, &edit).unwrap();
    replay.done();
    assert!(details.description.ends_with("(description edit check)"));
    assert_eq!(details.issue.body.as_deref(), Some(details.description.as_str()));

    let mut replay = Replay::step("description_restore");
    let restored = set_description_with(&mut replay.api(), REPO, SANDBOX, &DescriptionEdit { description: original.clone(), expected_updated_at: Some(details.issue.updated_at.clone()), expected_description: None }).unwrap();
    replay.done();
    assert_eq!(restored.description, original);

    // A comment since moves `updated_at` but not the description: with the
    // description the editor started from, that is no conflict.
    let commented_since = DescriptionEdit { description: "new".into(), expected_updated_at: Some("2026-10-18T06:31:10Z".into()), expected_description: Some(format!("{}\r\n", original.replace('\n', "\r\n"))) };
    let mut replay = Replay::of(vec![issue_read(527), call("PATCH", "repos/acme/widgets/issues/527", Some(json!({"body": "new"})), reply("description_set", 1))]);
    set_description_with(&mut replay.api(), REPO, SANDBOX, &commented_since).unwrap();
    replay.done();
    // Someone else's description edit is, whatever the time says.
    let rewritten = DescriptionEdit { description: "new".into(), expected_updated_at: Some(reply("details", 0)["updated_at"].as_str().unwrap().into()), expected_description: Some("What it said before".into()) };
    let mut replay = Replay::of(vec![issue_read(527)]);
    assert_eq!(set_description_with(&mut replay.api(), REPO, SANDBOX, &rewritten).unwrap_err().kind, IssueOpErrorKind::Conflict);
    replay.done();
}

#[test]
fn an_issue_is_created_with_assignees_and_labels() {
    let session = session();
    let mut options = Replay::step("options");
    options_with(&mut options.api(), &session, REPO, false).unwrap();
    let mut replay = Replay::step("create");
    let input = IssueCreate {
        title: "[TerminalX test] IM-1 create check — ignore".into(),
        description: "Created by the IM-1 live check; closed as not planned right away.".into(),
        assignees: vec!["sam".into()],
        labels: vec!["question".into()],
        ..IssueCreate::default()
    };
    let created = create_with(&mut replay.api(), &session, REPO, &input).unwrap();
    replay.done();
    assert_eq!((created.issue.identifier.as_str(), created.issue.state_type.as_str()), ("#530", "open"));
    assert_eq!(created.issue.assignees[0].id, "sam");
    assert_eq!(created.issue.labels[0].name, "question");
    let mut replay = Replay::step("create_close");
    assert_eq!(set_state_with(&mut replay.api(), REPO, "530", &StateChange::Close { reason: CloseReason::NotPlanned }).unwrap().close_reason, Some(CloseReason::NotPlanned));
    replay.done();

    let none = || Replay::of(vec![]);
    let linear_only = IssueCreate { title: "T".into(), priority: Some(2), ..IssueCreate::default() };
    assert_eq!(create_with(&mut none().api(), &session, REPO, &linear_only).unwrap_err().kind, IssueOpErrorKind::Unsupported);
    let crowded = IssueCreate { title: "T".into(), assignees: (0..11).map(|n| format!("user{n}")).collect(), ..IssueCreate::default() };
    assert_eq!(create_with(&mut none().api(), &session, REPO, &crowded).unwrap_err().kind, IssueOpErrorKind::Invalid);
}

/// What the project's remote still names: the repository before it was renamed to [`REPO`].
const OLD_NAME: &str = "acme/gadgets";
const ORIGIN: &str = "git@github.com:acme/gadgets.git";

/// `GET repos/{asked}`, as GitHub answers it once the redirect is followed:
/// the recorded repository, named `name`.
fn repository_read(asked: &str, name: &str) -> Value {
    let mut repository = reply("comments", 1);
    repository["full_name"] = json!(name);
    call("GET", &format!("repos/{asked}"), None, repository)
}

/// A write GitHub answers with a redirect, which `gh` doesn't follow.
fn redirected(method: &str, path: &str, body: Value) -> Value {
    json!({"method": method, "path": path, "body": body, "error": "moved"})
}

fn no_origin() -> Option<String> {
    panic!("the origin is read only when GitHub redirects a write")
}

fn steps(names: &[&str]) -> Vec<Value> {
    names.iter().flat_map(|name| recording()["steps"][name].as_array().unwrap().clone()).collect()
}

#[test]
fn a_write_to_a_renamed_repository_goes_to_its_current_name() {
    let session = session();
    let input = IssueCreate {
        title: "[TerminalX test] IM-1 create check — ignore".into(),
        description: "Created by the IM-1 live check; closed as not planned right away.".into(),
        assignees: vec!["sam".into()],
        labels: vec!["question".into()],
        ..IssueCreate::default()
    };
    // The old name is read once; the labels and the create go to the name GitHub answers with.
    let mut calls = vec![repository_read(OLD_NAME, REPO)];
    calls.extend(steps(&["options", "create"]));
    let mut replay = Replay::of(calls);
    let created = write_with(&mut replay.api(), &session, OLD_NAME, no_origin, |api, repo| create_with(api, &session, repo, &input)).unwrap();
    replay.done();
    assert_eq!((created.issue.identifier.as_str(), created.repo.as_deref()), ("#530", Some(REPO)));

    // Kept for the session, whatever the case: status, comment, assign and label go straight there.
    let mut replay = Replay::step("create_close");
    write_with(&mut replay.api(), &session, "Acme/Gadgets", no_origin, |api, repo| set_state_with(api, repo, "530", &StateChange::Close { reason: CloseReason::NotPlanned })).unwrap();
    replay.done();
    let mut replay = Replay::step("comment_add");
    write_with(&mut replay.api(), &session, OLD_NAME, no_origin, |api, repo| comment_add_with(api, repo, SANDBOX, "[TerminalX test] IM-1 live check comment — will be deleted")).unwrap();
    replay.done();
    let mut replay = Replay::step("assignees_me");
    write_with(&mut replay.api(), &session, OLD_NAME, no_origin, |api, repo| set_assignees_with(api, repo, SANDBOX, &["@sam".into()])).unwrap();
    replay.done();
    let mut replay = Replay::step("labels_set");
    write_with(&mut replay.api(), &session, OLD_NAME, no_origin, |api, repo| set_labels_with(api, &session, repo, SANDBOX, &["Documentation".into(), "question".into()])).unwrap();
    replay.done();

    // Any other failure is the write's own: no second read, and the name stays known.
    let mut replay = Replay::of(vec![json!({"method": "GET", "path": "repos/acme/widgets/issues/527", "error": "network"})]);
    assert_eq!(write_with(&mut replay.api(), &session, OLD_NAME, no_origin, |api, repo| set_title_with(api, repo, SANDBOX, "T")).unwrap_err().kind, IssueOpErrorKind::Network);
    replay.done();
    // A repository GitHub can't find stops the write before it is sent.
    let mut replay = Replay::of(vec![json!({"method": "GET", "path": "repos/acme/gone", "error": "not_found"})]);
    assert_eq!(write_with(&mut replay.api(), &session, "acme/gone", no_origin, |api, repo| set_title_with(api, repo, SANDBOX, "T")).unwrap_err().kind, IssueOpErrorKind::NotFound);
    replay.done();
}

#[test]
fn reading_the_comments_learns_the_current_name_too() {
    let session = session();
    // Reads go to the old name: `gh` follows the redirect for them.
    let mut replay = Replay::of(vec![
        call("GET", "repos/acme/gadgets/issues/527", None, reply("details", 0)),
        call("GET", "user", None, reply("comments", 0)),
        repository_read(OLD_NAME, REPO),
        call("GET", "repos/acme/gadgets/issues/527/comments?per_page=50&page=1", None, reply("comments", 2)),
    ]);
    comments_with(&mut replay.api(), &session, OLD_NAME, SANDBOX, None).unwrap();
    replay.done();
    let mut replay = Replay::step("title_set");
    write_with(&mut replay.api(), &session, OLD_NAME, no_origin, |api, repo| set_title_with(api, repo, SANDBOX, "[TerminalX test] issue-management sandbox — ignore (title edit check)")).unwrap();
    replay.done();
}

#[test]
fn a_write_github_still_redirects_says_where_the_repository_is_now() {
    let session = session();
    // Renamed again after its name was read: the write is refused, nothing changes.
    let renamed_again = || Replay::of(vec![repository_read(OLD_NAME, REPO), issue_read(527), redirected("PATCH", "repos/acme/widgets/issues/527", json!({"title": "T"})), repository_read(OLD_NAME, "acme/sprockets")]);
    let mut replay = renamed_again();
    let error = write_with(&mut replay.api(), &session, OLD_NAME, || Some(ORIGIN.into()), |api, repo| set_title_with(api, repo, SANDBOX, "T")).unwrap_err();
    replay.done();
    assert_eq!(error.kind, IssueOpErrorKind::Moved);
    assert_eq!(error.message, "GitHub now names this repository acme/sprockets, so nothing was changed. Point the project at it with git remote set-url origin git@github.com:acme/sprockets.git, then try again.");
    // Trying again goes to the name GitHub gave, with no read of it.
    let issue = reply("details", 0);
    let mut replay = Replay::of(vec![call("GET", "repos/acme/sprockets/issues/527", None, issue.clone()), call("PATCH", "repos/acme/sprockets/issues/527", Some(json!({"title": "T"})), issue)]);
    write_with(&mut replay.api(), &session, OLD_NAME, no_origin, |api, repo| set_title_with(api, repo, SANDBOX, "T")).unwrap();
    replay.done();

    // No command for an origin the name didn't come from, or none (a cloud project).
    for origin in [None, Some("git@github.com:someone/else.git"), Some("https://gitlab.com/acme/gadgets.git")] {
        let mut replay = renamed_again();
        let error = write_with(&mut replay.api(), &self::session(), OLD_NAME, || origin.map(String::from), |api, repo| set_title_with(api, repo, SANDBOX, "T")).unwrap_err();
        replay.done();
        assert_eq!(error.message, "GitHub now names this repository acme/sprockets, so nothing was changed. Try again.", "{origin:?}");
    }

    // Redirected while the repository's name stands: something else moved, like a transferred issue.
    let mut replay = Replay::of(vec![repository_read(REPO, REPO), issue_read(527), redirected("PATCH", "repos/acme/widgets/issues/527", json!({"title": "T"})), repository_read(REPO, REPO)]);
    let error = write_with(&mut replay.api(), &self::session(), REPO, no_origin, |api, repo| set_title_with(api, repo, SANDBOX, "T")).unwrap_err();
    replay.done();
    assert_eq!(error, IssueOpError::new(IssueOpErrorKind::Moved, Provider::Github));
}

/// This repository's name before it was renamed (#699). GitHub still
/// redirects it to the current one.
const LIVE_OLD_NAME: &str = "terminalx-ai/raccoon";

/// Live, opt-in (`TERMINALX_LIVE_ISSUE_SANDBOX=1 cargo test live_renamed -- --ignored --nocapture`):
/// a create sent to this repository by its old name, with the real `gh`
/// login. It sends no title, so GitHub refuses it once it reaches the
/// repository, and nothing is created.
#[test]
#[ignore]
fn live_renamed_repository_writes_reach_it() {
    if std::env::var("TERMINALX_LIVE_ISSUE_SANDBOX").as_deref() != Ok("1") {
        return;
    }
    let cwd = std::env::temp_dir();
    let untitled = json!({});
    // Sent to the old name: GitHub redirects it, and `gh` doesn't follow a write.
    let sent_as_before = gh_api(&cwd, "POST", &format!("repos/{LIVE_OLD_NAME}/issues"), Some(&untitled)).unwrap_err();
    assert_eq!(sent_as_before.kind, IssueOpErrorKind::Moved);
    // Sent to the current name, it reaches the repository.
    let mut written_to = String::new();
    let reached = write_with(&mut gh(&cwd), &session(), LIVE_OLD_NAME, || None, |api, repo| {
        written_to = repo.to_string();
        api("POST", &format!("repos/{repo}/issues"), Some(&untitled))
    })
    .unwrap_err();
    println!("{LIVE_OLD_NAME} is {written_to} now; the write reached it: {}", reached.message);
    assert!(!written_to.eq_ignore_ascii_case(LIVE_OLD_NAME));
    assert_eq!(reached.kind, IssueOpErrorKind::Invalid);
}

#[test]
fn the_recording_holds_no_personal_data_or_secret() {
    let text = include_str!("../fixtures/github_issue_ops.json");
    for secret in ["ghp_", "gho_", "github_pat_", "token", "email", "terminalx-ai"] {
        assert!(!text.contains(secret), "{secret}");
    }
}
