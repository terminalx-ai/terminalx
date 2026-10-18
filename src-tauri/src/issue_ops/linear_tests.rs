use serde_json::{json, Value};

use super::*;
use crate::issue_ops::{CloseReason, IssueOpErrorKind};

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn writes() -> Value {
    fixture(include_str!("../fixtures/linear_issue_writes.json"))
}

const VIEWER: &str = "d6b0323d-9198-4b93-96c4-7515a5f47c6e";

#[test]
fn details_read_the_description_alone() {
    let details = parse_issue(&writes()["details"]["data"]["issue"]).unwrap();
    assert_eq!(details.issue.identifier, "ENG-101");
    assert_eq!(details.issue.body.as_deref(), Some(details.description.as_str()));
    assert_eq!((details.issue.state.as_str(), details.state_id.as_deref(), details.state_color.as_deref()), ("Backlog", Some("884bd5ca-47eb-4eed-96f8-d44a7183b391"), Some("bec2c8")));
    assert_eq!(details.priority, Some(0));
    assert_eq!(details.issue.assignees.iter().map(|user| (user.id.as_str(), user.name.as_str())).collect::<Vec<_>>(), [(VIEWER, "sam")]);
    assert_eq!(details.author.unwrap().id, VIEWER);
    assert_eq!(details.issue.team.unwrap().key, "ENG");
    assert_eq!(details.created_at, "2026-10-18T06:31:11.160Z");
}

#[test]
fn a_comments_page_is_oldest_first_and_only_the_viewers_own_are_editable() {
    let page = parse_comments_page(&fixture(include_str!("../fixtures/linear_issue_comments.json"))["data"], None);
    assert_eq!(page.next_cursor, None);
    let bodies: Vec<_> = page.comments.iter().map(|comment| comment.body.as_str()).collect();
    assert_eq!(bodies, ["Seen it on staging too.", "I can take this.", "Linked pull request opened."]);
    let [mine, theirs, bot] = &page.comments[..] else { panic!() };
    assert!(mine.viewer_can_edit && mine.viewer_can_delete);
    assert_eq!(mine.author.as_ref().unwrap().name, "sam");
    assert_eq!(mine.edited_at, None);
    assert!(!theirs.viewer_can_edit && !theirs.viewer_can_delete);
    assert_eq!(theirs.edited_at.as_deref(), Some("2026-09-12T12:00:00.000Z"));
    assert_eq!(theirs.author.as_ref().unwrap().avatar_url.as_deref(), Some("https://example.com/robin.png"));
    assert_eq!(bot.author.as_ref().unwrap().name, "GitHub");
    assert!(!bot.viewer_can_edit);
    assert_eq!(mine.url.as_deref(), Some("https://linear.app/acme/issue/ENG-5/fix-login-timeout#comment-0fd9dc42"));
}

fn comment_node(id: &str, at: &str) -> Value {
    json!({"id": id, "body": id, "createdAt": at, "user": {"id": VIEWER, "displayName": "sam"}})
}

fn answered(nodes: Vec<Value>) -> Value {
    json!({"viewer": {"id": VIEWER}, "issue": {"comments": {"nodes": nodes}}})
}

#[test]
fn comments_page_forward_from_the_last_one_shown() {
    let node = |n: usize| comment_node(&format!("c{n:02}"), &format!("2026-09-01T10:{n:02}:00.000Z"));
    // Linear answers `last:` oldest first; more than a page says another follows.
    let page = parse_comments_page(&answered((0..=COMMENTS_PAGE + 1).rev().map(node).collect()), None);
    assert_eq!(page.comments.len(), COMMENTS_PAGE);
    assert_eq!(page.comments[0].id, "c00");
    assert_eq!(page.comments.last().unwrap().id, "c49");
    assert_eq!(page.next_cursor.as_deref(), Some("2026-09-01T10:49:00.000Z|c49"));
    let next = comments_variables("ENG-5", page.next_cursor.as_deref());
    assert_eq!(next, json!({"id": "ENG-5", "last": COMMENTS_PAGE + 2, "filter": {"createdAt": {"gte": "2026-09-01T10:49:00.000Z"}}}));
    assert_eq!(comments_variables("ENG-5", None)["filter"], Value::Null);
    // The next answer starts with the cursor's own comment, which is not shown again.
    let last = parse_comments_page(&answered(vec![node(49), node(50), node(51)]), page.next_cursor.as_deref());
    assert_eq!(last.comments.iter().map(|comment| comment.id.as_str()).collect::<Vec<_>>(), ["c50", "c51"]);
    assert_eq!(last.next_cursor, None);
}

#[test]
fn comments_made_in_the_same_millisecond_are_neither_skipped_nor_repeated() {
    let at = "2026-09-01T10:00:00.000Z";
    // A page that ends between two comments of one millisecond.
    let mut nodes: Vec<Value> = (0..COMMENTS_PAGE - 1).map(|n| comment_node(&format!("a{n:02}"), &format!("2026-09-01T09:{n:02}:00.000Z"))).collect();
    nodes.extend([comment_node("tie-1", at), comment_node("tie-2", at), comment_node("tie-3", at)]);
    let first = parse_comments_page(&answered(nodes.iter().take(COMMENTS_PAGE + 2).cloned().collect()), None);
    assert_eq!(first.comments.last().unwrap().id, "tie-1");
    let cursor = first.next_cursor.unwrap();
    assert_eq!(cursor, format!("{at}|tie-1"));
    // `gte` brings back the whole millisecond; only the ones not yet shown are kept.
    let second = parse_comments_page(&answered(nodes[COMMENTS_PAGE - 1..].to_vec()), Some(&cursor));
    assert_eq!(second.comments.iter().map(|comment| comment.id.as_str()).collect::<Vec<_>>(), ["tie-2", "tie-3"]);
    assert_eq!(second.next_cursor, None);
    // A cursor of only a time (as before) still works.
    assert_eq!(parse_comments_page(&answered(vec![comment_node("later", "2026-09-02T00:00:00.000Z")]), Some(at)).comments.len(), 1);
}

#[test]
fn options_list_states_in_order_active_members_and_grouped_labels() {
    let options = parse_options(&fixture(include_str!("../fixtures/linear_issue_options.json"))["data"]);
    let states: Vec<_> = options.states.iter().map(|state| (state.name.as_str(), state.state_type.as_str())).collect();
    assert_eq!(
        states,
        [("Backlog", "backlog"), ("Todo", "unstarted"), ("In Progress", "started"), ("Done", "completed"), ("Canceled", "canceled"), ("Duplicate", "duplicate"), ("In Review", "started")]
    );
    assert_eq!(options.states[0].color, "bec2c8");
    assert_eq!(options.states[6].position, 1002.0);
    assert_eq!(options.members.iter().map(|member| member.name.as_str()).collect::<Vec<_>>(), ["robin", "sam"]);
    let labels: Vec<_> = options.labels.iter().map(|label| (label.name.as_str(), label.group.as_deref(), label.group_id.as_deref(), label.is_group)).collect();
    assert_eq!(
        labels,
        [("Area", None, None, true), ("Frontend", Some("Area"), Some("label-group-area"), false), ("Bug", None, None, false), ("Feature", None, None, false), ("Improvement", None, None, false)]
    );
    assert_eq!(options.labels[1].description.as_deref(), Some("UI work"));
    assert_eq!(options.labels[2].color, "EB5757");
    assert_eq!(options.priorities.iter().map(|priority| priority.value).collect::<Vec<_>>(), [0, 1, 2, 3, 4]);
    assert!(options.close_reasons.is_empty());
    assert_eq!(options.capabilities, IssueCapabilities::of(Provider::Linear));
}

#[test]
fn groups_that_share_a_name_keep_their_labels_apart() {
    let label = |id: &str, name: &str, group: Option<(&str, &str)>, is_group: bool| json!({"id": id, "name": name, "color": "#000000", "isGroup": is_group, "parent": group.map(|(id, name)| json!({"id": id, "name": name}))});
    let data = json!({"team": {}, "issueLabels": {"nodes": [
        label("x2", "Web", Some(("g2", "Area")), false),
        label("g1", "Area", None, true),
        label("x1", "Web", Some(("g1", "Area")), false),
        label("g2", "Area", None, true),
    ]}});
    let order: Vec<_> = parse_options(&data).labels.into_iter().map(|label| (label.id, label.group_id)).collect();
    assert_eq!(order, [("g1".into(), None), ("x1".into(), Some("g1".into())), ("g2".into(), None), ("x2".into(), Some("g2".into()))]);
}

#[test]
fn a_sub_team_takes_its_parent_teams_labels() {
    assert_eq!(label_teams(&json!({"id": "team-web", "ancestors": [{"id": "team-eng"}, {"id": "team-all"}]})), ["team-web", "team-eng", "team-all"]);
    assert_eq!(label_teams(&json!({"id": "team-eng", "ancestors": []})), ["team-eng"]);
}

#[test]
fn options_are_cached_per_key_and_team() {
    let options = parse_options(&fixture(include_str!("../fixtures/linear_issue_options.json"))["data"]);
    OPTIONS.lock().unwrap().get_or_insert_with(HashMap::new).insert(options_key("lin_api_cached", "team-cached"), options.clone());
    // Served without a request: the key is not a real one.
    assert_eq!(super::options("lin_api_cached", None, Some("team-cached"), false).unwrap(), options);
    assert_ne!(options_key("lin_api_cached", "team-cached"), options_key("lin_api_other", "team-cached"));
    assert_eq!(super::options("lin_api_cached", None, None, false).unwrap_err().kind, IssueOpErrorKind::Invalid);
}

#[test]
fn comment_writes_answer_with_the_comment() {
    let recorded = writes();
    let added = written_comment(&recorded["commentCreate"]["data"]["commentCreate"]).unwrap();
    assert_eq!(added.body, "[TerminalX test] identifier probe — will be deleted");
    assert!(added.viewer_can_edit && added.viewer_can_delete);
    assert_eq!(added.edited_at, None);
    assert_eq!(added.author.unwrap().id, VIEWER);
    let edited = written_comment(&recorded["commentUpdate"]["data"]["commentUpdate"]).unwrap();
    assert_eq!((edited.id.as_str(), edited.edited_at.as_deref()), (added.id.as_str(), Some("2026-10-18T06:54:59.528Z")));
    assert_eq!(succeeded(&recorded["commentDelete"]["data"]["commentDelete"]), Ok(()));
    assert_eq!(succeeded(&json!({"success": false})).unwrap_err().kind, IssueOpErrorKind::Other);
    assert_eq!(written_comment(&json!({"success": false})).unwrap_err().kind, IssueOpErrorKind::Other);
    assert_eq!(non_empty(" \n").unwrap_err().kind, IssueOpErrorKind::Invalid);
}

#[test]
fn issue_writes_answer_with_the_issue_as_linear_now_has_it() {
    let recorded = writes();
    let updated = written_issue(&recorded["issueUpdate"]["data"]["issueUpdate"]).unwrap();
    assert_eq!((updated.issue.state.as_str(), updated.issue.state_type.as_str()), ("Todo", "open"));
    assert_eq!(updated.state_id.as_deref(), Some("f093f06b-bdb5-4cc0-83a2-1ab468cf2210"));
    assert_eq!(updated.priority, Some(3));
    assert_eq!(updated.issue.labels.iter().map(|label| (label.id.as_deref(), label.name.as_str())).collect::<Vec<_>>(), [(Some("ccc19003-dd17-4f15-8a1c-791df99d854f"), "Bug")]);
    assert!(updated.issue.assignees.is_empty() && updated.issue.assignee.is_none());
    assert_eq!(updated.issue.updated_at, "2026-10-18T06:55:30.290Z");
    let created = written_issue(&recorded["issueCreate"]["data"]["issueCreate"]).unwrap();
    assert_eq!(created.issue.identifier, "ENG-102");
    assert_eq!((created.issue.state.as_str(), created.priority), ("Todo", Some(4)));
    assert_eq!(created.issue.assignees[0].id, VIEWER);
    assert_eq!(created.issue.labels[0].name, "Improvement");
    assert_eq!(written_issue(&json!({"success": false, "issue": null})).unwrap_err().kind, IssueOpErrorKind::Other);
}

#[test]
fn recorded_write_failures_map_to_their_kinds() {
    let recorded = writes();
    let kind = |name: &str| classify(200, &recorded[name]);
    assert_eq!(kind("commentDeleteGone"), Some(IssueOpErrorKind::NotFound));
    // A state or label that was removed since the picker loaded.
    assert_eq!(kind("issueUpdateStaleState"), Some(IssueOpErrorKind::Invalid));
    assert_eq!(kind("issueUpdateStaleLabel"), Some(IssueOpErrorKind::Invalid));
    for name in ["details", "commentCreate", "commentUpdate", "commentDelete", "issueUpdate", "issueCreate"] {
        assert_eq!(kind(name), None, "{name}");
    }
    // What reaches the UI is the fixed message, never the reply.
    let error = IssueOpError::new(kind("issueUpdateStaleState").unwrap(), Provider::Linear);
    assert!(!error.message.contains("validateAccess") && !error.message.contains("00000000"));
}

#[test]
fn a_description_edit_conflicts_only_when_the_issue_moved_on() {
    assert!(!changed_since("2026-10-18T06:31:11.160Z", "2026-10-18T06:31:11.160Z"));
    assert!(!changed_since("2026-10-18T06:31:11.160Z", "2026-10-18T06:31:11.16+00:00"));
    assert!(changed_since("2026-10-18T06:55:30.290Z", "2026-10-18T06:31:11.160Z"));
    assert!(changed_since("2026-10-18T06:55:30.290Z", "yesterday"));
}

#[test]
fn only_a_changed_description_conflicts_when_the_editor_says_what_it_started_from() {
    // A comment moved `updatedAt`; the description is as the editor saw it.
    let current = json!({"updatedAt": "2026-10-18T07:21:44.971Z", "description": "Steps\r\n1. Log in\n"});
    let started = |description: Option<&str>| DescriptionEdit { description: "New".into(), expected_updated_at: Some("2026-10-18T07:04:57.658Z".into()), expected_description: description.map(String::from) };
    assert!(!conflicts(&current, &started(Some("Steps\n1. Log in"))));
    assert!(conflicts(&current, &started(Some("Steps"))));
    assert!(conflicts(&current, &started(None)));
    assert!(!conflicts(&json!({"updatedAt": "2026-10-18T07:04:57.658Z"}), &started(None)));
    assert!(!conflicts(&current, &DescriptionEdit::default()));
    // A blank `expectedUpdatedAt` is no expectation, not a mismatch.
    assert!(!conflicts(&current, &DescriptionEdit { expected_updated_at: Some("  ".into()), ..DescriptionEdit::default() }));
    assert!(!conflicts(&json!({"description": null}), &DescriptionEdit { expected_description: Some("".into()), ..DescriptionEdit::default() }));
}

#[test]
fn a_comment_is_changed_only_on_its_own_issue() {
    let comment = json!({"issue": {"id": "6aecdaa3-5396-40c2-85a0-7e9d44871943", "identifier": "ENG-101"}});
    assert!(comment_belongs(&comment, "ENG-101"));
    assert!(comment_belongs(&comment, "eng-101"));
    assert!(comment_belongs(&comment, "6aecdaa3-5396-40c2-85a0-7e9d44871943"));
    assert!(!comment_belongs(&comment, "ENG-5"));
    assert!(!comment_belongs(&Value::Null, "ENG-101"));
}

#[test]
fn a_new_issue_needs_a_team_and_takes_one_assignee() {
    let input = IssueCreate {
        team_id: Some("team-eng".into()),
        title: " Fix it ".into(),
        description: "Steps".into(),
        assignees: vec!["user-sam".into()],
        labels: vec!["label-bug".into()],
        state_id: Some("state-todo".into()),
        priority: Some(2),
    };
    assert_eq!(
        create_input(&input).unwrap(),
        json!({"teamId": "team-eng", "title": "Fix it", "description": "Steps", "assigneeId": "user-sam", "labelIds": ["label-bug"], "stateId": "state-todo", "priority": 2})
    );
    let bare = IssueCreate { team_id: Some("team-eng".into()), title: "T".into(), ..IssueCreate::default() };
    assert_eq!(create_input(&bare).unwrap(), json!({"teamId": "team-eng", "title": "T", "description": ""}));
    let kind = |input: IssueCreate| create_input(&input).unwrap_err().kind;
    assert_eq!(kind(IssueCreate { team_id: None, ..input.clone() }), IssueOpErrorKind::Invalid);
    assert_eq!(kind(IssueCreate { assignees: vec!["a".into(), "b".into()], ..input.clone() }), IssueOpErrorKind::Invalid);
    assert_eq!(kind(IssueCreate { priority: Some(5), ..input }), IssueOpErrorKind::Invalid);
    assert_eq!(assignee(&[]).unwrap(), None);
    assert_eq!(set_state("lin_api_unused", "ENG-1", &StateChange::Close { reason: CloseReason::Completed }).unwrap_err().kind, IssueOpErrorKind::Unsupported);
}

/// Every operation against the real Linear, on the sandbox issue only:
/// `LINEAR_LIVE_ISSUE=PRO-101 cargo test live_ -- --ignored --nocapture`.
/// It refuses any issue whose title doesn't start with "[TerminalX test]",
/// and puts the issue back as it found it.
#[test]
#[ignore]
fn live_every_operation_on_the_sandbox_issue() {
    let Ok(id) = std::env::var("LINEAR_LIVE_ISSUE") else { return };
    let crate::issue_ops::Target::Linear { key } = crate::issue_ops::Target::resolve(std::path::Path::new("."), Provider::Linear).unwrap() else { unreachable!() };
    let key = key.as_str();
    let before = details(key, &id).unwrap();
    assert!(before.issue.title.starts_with("[TerminalX test]"), "not a sandbox issue");
    let team = before.issue.team.clone().unwrap().id;
    let step = |name: &str| println!("ok  {name}");

    let options = super::options(key, Some(&id), None, true).unwrap();
    assert!(!options.states.is_empty() && !options.members.is_empty());
    assert_eq!(super::options(key, None, Some(&team), false).unwrap(), options);
    step("options (read, cached, refreshed)");

    let added = comment_add(key, &id, "[TerminalX test] live check — will be deleted").unwrap();
    let edited = comment_edit(key, &id, &added.id, "[TerminalX test] live check, edited — will be deleted").unwrap();
    assert!(edited.edited_at.is_some());
    let mut seen = Vec::new();
    let mut cursor = None;
    loop {
        let page = comments(key, &id, cursor.as_deref()).unwrap();
        seen.extend(page.comments);
        cursor = page.next_cursor;
        if cursor.is_none() {
            break;
        }
    }
    let mine = seen.iter().find(|comment| comment.id == added.id).unwrap();
    assert!(mine.viewer_can_edit && mine.body.contains("edited"));
    let elsewhere = request(key, "query { issues(first: 1, filter: { title: { notStartsWith: \"[TerminalX test]\" } }) { nodes { identifier } } }", json!({})).unwrap()["issues"]["nodes"][0]["identifier"].as_str().unwrap().to_string();
    // Named with another issue, the comment is refused before anything is sent.
    assert_eq!(comment_delete(key, &elsewhere, &added.id).unwrap_err().kind, IssueOpErrorKind::NotFound);
    comment_delete(key, &id, &added.id).unwrap();
    assert_eq!(comment_delete(key, &id, &added.id).unwrap_err().kind, IssueOpErrorKind::NotFound);
    step("comments: add, edit, page, delete");

    let other = options.states.iter().find(|state| Some(&state.id) != before.state_id.as_ref() && state.state_type == "unstarted").unwrap();
    assert_eq!(set_state(key, &id, &StateChange::WorkflowState { state_id: other.id.clone() }).unwrap().state_id.as_ref(), Some(&other.id));
    assert_eq!(set_state(key, &id, &StateChange::WorkflowState { state_id: "00000000-0000-4000-8000-000000000000".into() }).unwrap_err().kind, IssueOpErrorKind::Invalid);
    step("state");

    let viewer = request(key, "query { viewer { id } }", json!({})).unwrap()["viewer"]["id"].as_str().unwrap().to_string();
    assert!(set_assignees(key, &id, &[]).unwrap().issue.assignees.is_empty());
    assert_eq!(set_assignees(key, &id, std::slice::from_ref(&viewer)).unwrap().issue.assignees[0].id, viewer);
    step("assignee: none, the viewer");

    let label = options.labels.iter().find(|label| !label.is_group).unwrap();
    assert_eq!(set_labels(key, &id, std::slice::from_ref(&label.id)).unwrap().issue.labels[0].id.as_ref(), Some(&label.id));
    assert_eq!(set_priority(key, &id, 3).unwrap().priority, Some(3));
    let title = format!("{} (edited)", before.issue.title);
    assert_eq!(set_title(key, &id, &title).unwrap().issue.title, title);
    step("labels, priority, title");

    let current = details(key, &id).unwrap();
    // A comment posted while the editor is open moves `updatedAt` (not always
    // at once), never the description.
    let interim = comment_add(key, &id, "[TerminalX test] live check — will be deleted").unwrap();
    let edit = DescriptionEdit {
        description: format!("{}\n\nEdited by a live check.", before.description),
        expected_updated_at: Some(current.issue.updated_at.clone()),
        expected_description: Some(current.description.clone()),
    };
    let after = set_description(key, &id, &edit).unwrap();
    assert!(after.description.ends_with("Edited by a live check."));
    comment_delete(key, &id, &interim.id).unwrap();
    // The editor started from `current`; the description has moved on since.
    assert_eq!(set_description(key, &id, &DescriptionEdit { description: "stale".into(), ..edit }).unwrap_err().kind, IssueOpErrorKind::Conflict);
    step("description: a comment meanwhile is no conflict, a changed description is");

    assert_eq!(details(key, "PRO-999999").unwrap_err().kind, IssueOpErrorKind::NotFound);
    assert_eq!(details("lin_api_not_a_real_key_0000000000000000000000", &id).unwrap_err().kind, IssueOpErrorKind::NotSignedIn);
    step("errors: not found, not signed in");

    if std::env::var("LINEAR_LIVE_CREATE").is_ok() {
        let created = create(key, &IssueCreate { team_id: Some(team.clone()), title: "[TerminalX test] create check — ignore".into(), description: "Created by a live check; canceled right away.".into(), assignees: vec![viewer.clone()], ..IssueCreate::default() }).unwrap();
        let canceled = options.states.iter().find(|state| state.state_type == "canceled").unwrap();
        assert_eq!(set_state(key, &created.issue.id, &StateChange::WorkflowState { state_id: canceled.id.clone() }).unwrap().issue.state_type, "canceled");
        step(&format!("create {}, canceled", created.issue.identifier));
    }

    // Put it back.
    set_state(key, &id, &StateChange::WorkflowState { state_id: before.state_id.clone().unwrap() }).unwrap();
    set_assignees(key, &id, &before.issue.assignees.iter().map(|user| user.id.clone()).collect::<Vec<_>>()).unwrap();
    set_labels(key, &id, &before.issue.labels.iter().filter_map(|label| label.id.clone()).collect::<Vec<_>>()).unwrap();
    set_priority(key, &id, before.priority.unwrap_or(0)).unwrap();
    set_title(key, &id, &before.issue.title).unwrap();
    let restored = set_description(key, &id, &DescriptionEdit { description: before.description.clone(), ..DescriptionEdit::default() }).unwrap();
    assert_eq!((restored.issue.title, restored.description, restored.state_id, restored.priority), (before.issue.title, before.description, before.state_id, before.priority));
    step("restored");
}
