use serde_json::{json, Value};

use super::*;

fn fixture(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn round_trip<T: Serialize + for<'de> Deserialize<'de> + PartialEq + std::fmt::Debug>(value: &T) -> Value {
    let wire = serde_json::to_value(value).unwrap();
    let back: T = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(&back, value);
    wire
}

#[test]
fn a_github_issue_keeps_every_assignee_and_its_close_reason() {
    let details = github::parse_issue(&fixture(include_str!("../fixtures/github_issue_details.json")), "acme/widgets").unwrap();
    assert_eq!(details.issue.assignees.iter().map(|user| user.id.as_str()).collect::<Vec<_>>(), ["sam", "alex", "robin"]);
    assert_eq!(details.issue.assignees[1].login.as_deref(), Some("alex"));
    assert_eq!(details.issue.assignee.as_ref().unwrap().name, "sam");
    assert_eq!(details.close_reason, Some(CloseReason::NotPlanned));
    assert_eq!((details.issue.state.as_str(), details.issue.state_type.as_str()), ("Closed", "canceled"));
    assert_eq!(details.issue.labels.iter().map(|label| label.id.as_deref()).collect::<Vec<_>>(), [Some("bug"), Some("raccoon")]);
    assert_eq!(details.author.as_ref().unwrap().id, "kim");
    assert_eq!(details.created_at, "2026-09-01T09:00:00Z");
    assert_eq!(details.description, "The session expires while a command is running.");
    assert_eq!(details.priority, None);
    assert_eq!(details.repo.as_deref(), Some("acme/widgets"));
    assert_eq!(details.capabilities, IssueCapabilities::of(Provider::Github));
    assert_eq!(details.issue.url, "https://github.com/acme/widgets/issues/41");
}

#[test]
fn a_linear_issue_carries_its_state_priority_and_author_without_its_comments() {
    let data = fixture(include_str!("../fixtures/linear_issue_details.json"));
    let details = linear::parse_issue(&data["data"]["issue"]).unwrap();
    assert_eq!(details.state_id.as_deref(), Some("state-started"));
    assert_eq!(details.state_color.as_deref(), Some("f2c94c"));
    assert_eq!(details.priority, Some(2));
    assert_eq!(details.issue.assignees, vec![IssueUser { id: "user-sam".into(), name: "Sam".into(), login: None, avatar_url: Some("https://example.com/sam.png".into()) }]);
    assert_eq!(details.author.as_ref().unwrap().name, "Kim");
    assert_eq!(details.issue.labels[0].id.as_deref(), Some("label-bug"));
    assert_eq!(details.description, "Users get logged out.");
    // The discussion is read through `issue_comments`; neither text carries it.
    assert_eq!(details.issue.body.as_deref(), Some("Users get logged out."));
    assert_eq!(details.capabilities.max_assignees, 1);
}

#[test]
fn details_keep_the_list_fields_flat_on_the_wire() {
    let details = github::parse_issue(&fixture(include_str!("../fixtures/github_issue_details.json")), "acme/widgets").unwrap();
    let wire = round_trip(&details);
    // Older callers read an `Issue` from `issue_details`; its fields sit at the top.
    for field in ["provider", "id", "identifier", "title", "stateType", "labels", "assignee", "updatedAt", "body"] {
        assert!(wire.get(field).is_some(), "{field}");
    }
    assert_eq!(wire["closeReason"], "not_planned");
    assert_eq!(wire["createdAt"], "2026-09-01T09:00:00Z");
    assert_eq!(wire["capabilities"], json!({"workflowStates": false, "closeReasons": true, "priority": false, "multiAssignee": true, "maxAssignees": 10}));
    assert!(wire.get("issue").is_none());
    let linear = linear::parse_issue(&fixture(include_str!("../fixtures/linear_issue_details.json"))["data"]["issue"]).unwrap();
    round_trip(&linear);
}

#[test]
fn the_contract_types_round_trip_in_camel_case() {
    let user = IssueUser { id: "sam".into(), name: "Sam".into(), login: Some("sam".into()), avatar_url: Some("https://a/b.png".into()) };
    let comment = IssueComment {
        id: "c1".into(),
        author: Some(user.clone()),
        body: "Looks good".into(),
        created_at: "2026-09-01T12:00:00Z".into(),
        edited_at: Some("2026-09-01T13:00:00Z".into()),
        url: Some("https://github.com/acme/widgets/issues/41#issuecomment-1".into()),
        viewer_can_edit: true,
        viewer_can_delete: false,
    };
    let page = round_trip(&CommentsPage { comments: vec![comment], next_cursor: Some("2".into()) });
    assert_eq!(page["nextCursor"], "2");
    assert_eq!(page["comments"][0]["viewerCanEdit"], true);
    assert_eq!(page["comments"][0]["author"]["avatarUrl"], "https://a/b.png");

    let options = round_trip(&IssueOptions {
        provider: Provider::Linear,
        states: vec![WorkflowState { id: "s1".into(), name: "Todo".into(), state_type: "unstarted".into(), color: "e2e2e2".into(), position: 1.5 }],
        close_reasons: vec![],
        members: vec![user],
        labels: vec![
            LabelOption { id: "g1".into(), name: "Area".into(), color: "".into(), description: None, group: None, group_id: None, is_group: true },
            LabelOption { id: "l1".into(), name: "Frontend".into(), color: "5e6ad2".into(), description: Some("UI".into()), group: Some("Area".into()), group_id: Some("g1".into()), is_group: false },
        ],
        priorities: linear_priorities(),
        capabilities: IssueCapabilities::of(Provider::Linear),
    });
    assert_eq!(options["provider"], "linear");
    assert_eq!(options["states"][0]["type"], "unstarted");
    assert_eq!(options["labels"][0]["isGroup"], true);
    assert_eq!(options["labels"][1]["groupId"], "g1");
    assert_eq!(options["priorities"][1], json!({"value": 1, "label": "Urgent"}));
    let github = round_trip(&IssueOptions {
        provider: Provider::Github,
        states: vec![],
        close_reasons: vec![CloseReason::Completed, CloseReason::NotPlanned],
        members: vec![],
        labels: vec![],
        priorities: vec![],
        capabilities: IssueCapabilities::of(Provider::Github),
    });
    assert_eq!(github["closeReasons"], json!(["completed", "not_planned"]));

    assert_eq!(round_trip(&StateChange::WorkflowState { state_id: "s1".into() }), json!({"kind": "workflow_state", "stateId": "s1"}));
    assert_eq!(round_trip(&StateChange::Close { reason: CloseReason::NotPlanned }), json!({"kind": "close", "reason": "not_planned"}));
    assert_eq!(round_trip(&StateChange::Reopen), json!({"kind": "reopen"}));
    assert_eq!(
        round_trip(&DescriptionEdit { description: "New".into(), expected_updated_at: Some("2026-09-02T10:00:00Z".into()), expected_description: Some("Old".into()) }),
        json!({"description": "New", "expectedUpdatedAt": "2026-09-02T10:00:00Z", "expectedDescription": "Old"})
    );
    assert_eq!(serde_json::from_value::<DescriptionEdit>(json!({"description": "New"})).unwrap(), DescriptionEdit { description: "New".into(), ..DescriptionEdit::default() });
    let create = round_trip(&IssueCreate { team_id: Some("team-eng".into()), title: "T".into(), description: "D".into(), assignees: vec!["u1".into()], labels: vec![], state_id: None, priority: Some(3) });
    assert_eq!(create["teamId"], "team-eng");
    assert_eq!(create["priority"], 3);
    // The UI may leave out everything but the title.
    let bare: IssueCreate = serde_json::from_value(json!({"title": "T"})).unwrap();
    assert_eq!(bare, IssueCreate { title: "T".into(), ..IssueCreate::default() });

    assert_eq!(round_trip(&IssueOpError::new(IssueOpErrorKind::NotSignedIn, Provider::Github))["kind"], "not_signed_in");
}

#[test]
fn every_error_kind_comes_from_a_recorded_failure() {
    let recorded = fixture(include_str!("../fixtures/issue_op_errors.json"));
    let kind = |name: &Value| -> IssueOpErrorKind { serde_json::from_value(name.clone()).unwrap() };
    let mut seen = std::collections::HashSet::new();
    for case in recorded["github"].as_array().unwrap() {
        assert_eq!(github::classify(case["printed"].as_str().unwrap()), kind(&case["kind"]), "{}", case["printed"]);
        seen.insert(("github", case["kind"].as_str().unwrap().to_string()));
    }
    for case in recorded["linear"].as_array().unwrap() {
        let status = case["status"].as_u64().unwrap() as u16;
        assert_eq!(linear::classify(status, &case["body"]), Some(kind(&case["kind"])), "{case}");
        seen.insert(("linear", case["kind"].as_str().unwrap().to_string()));
    }
    for provider in ["github", "linear"] {
        for name in ["not_signed_in", "missing_scope", "forbidden", "not_found", "conflict", "rate_limited", "network"] {
            assert!(seen.contains(&(provider, name.to_string())), "{provider} {name}");
        }
    }
    assert_eq!(linear::classify(200, &json!({"data": {"issue": null}})), None);
}

#[test]
fn error_messages_carry_no_secret_or_reply() {
    use IssueOpErrorKind::*;
    let kinds = [NotSignedIn, MissingScope, Forbidden, NotFound, Conflict, RateLimited, Network, Unsupported, Invalid, NotImplemented, Other];
    // A failure whose reply holds a token: what reaches the UI is the fixed message alone.
    let printed = "gh: Bad credentials (HTTP 401) token ghp_SECRETSECRETSECRET lin_api_SECRETSECRET";
    let error = IssueOpError::new(github::classify(printed), Provider::Github);
    assert_eq!(error.kind, NotSignedIn);
    for provider in [Provider::Github, Provider::Linear] {
        for kind in kinds {
            let text = message(kind, provider);
            assert!(!text.is_empty());
            for secret in ["ghp_", "gho_", "github_pat_", "lin_api_", "Bearer", "SECRET", "{", "HTTP "] {
                assert!(!text.contains(secret), "{kind:?} {provider:?}: {text}");
            }
            assert_eq!(IssueOpError::new(kind, provider).to_string(), text);
        }
    }
    assert!(!serde_json::to_string(&error).unwrap().contains("SECRET"));
}

#[test]
fn provider_rules_are_checked_before_any_call() {
    let github = Target::Github { cwd: std::env::temp_dir(), repo: "acme/widgets".into() };
    let linear = Target::Linear { key: "lin_api_unused".into() };
    let kind = |result: OpResult<IssueDetails>| result.unwrap_err().kind;
    assert_eq!(kind(set_priority(&github, "41", 2)), IssueOpErrorKind::Unsupported);
    assert_eq!(kind(set_priority(&linear, "ENG-42", 5)), IssueOpErrorKind::Invalid);
    assert_eq!(kind(set_state(&github, "41", &StateChange::WorkflowState { state_id: "s1".into() })), IssueOpErrorKind::Unsupported);
    assert_eq!(kind(set_state(&linear, "ENG-42", &StateChange::Reopen)), IssueOpErrorKind::Unsupported);
    let eleven: Vec<String> = (0..11).map(|n| format!("user{n}")).collect();
    assert_eq!(kind(set_assignees(&github, "41", &eleven)), IssueOpErrorKind::Invalid);
    assert_eq!(kind(set_assignees(&linear, "ENG-42", &eleven[..2])), IssueOpErrorKind::Invalid);
    assert_eq!(kind(set_title(&github, "41", "  ")), IssueOpErrorKind::Invalid);
    assert_eq!(kind(create(&linear, &IssueCreate::default())), IssueOpErrorKind::Invalid);
    assert_eq!(kind(github::details(&std::env::temp_dir(), "acme/widgets", "not-a-number")), IssueOpErrorKind::Invalid);
}
