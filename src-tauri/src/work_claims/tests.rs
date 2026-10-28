use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::*;
use crate::account::AccountContext;

fn context() -> AccountContext {
    AccountContext {
        access_token: "native-secret-token".into(),
        user_id: "user-1".into(),
        email: "me@example.com".into(),
        display_name: "Me".into(),
        profile_id: "profile-1".into(),
        organization_id: "org-1".into(),
        relay_entitled: true,
        generation: 3,
    }
}

type Requests = Arc<Mutex<Vec<String>>>;

/// Answer every request with `body` and keep each raw request.
fn serve(body: &'static str) -> (String, Requests) {
    serve_with("200 OK", "", body)
}

/// Answer every request with this status, extra headers and body.
fn serve_with(status: &'static str, headers: &'static str, body: &'static str) -> (String, Requests) {
    serve_observing(status, headers, body, |_| {})
}

fn serve_observing(status: &'static str, headers: &'static str, body: &'static str, mut before_response: impl FnMut(&str) + Send + 'static) -> (String, Requests) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests: Requests = Arc::default();
    let seen = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            stream.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 8192];
            loop {
                let read = stream.read(&mut buffer).unwrap_or(0);
                request.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&request);
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length").then(|| value.trim().parse::<usize>().ok()).flatten()
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length {
                        break;
                    }
                }
                if read == 0 {
                    break;
                }
            }
            seen.lock().unwrap().push(String::from_utf8_lossy(&request).into_owned());
            before_response(&String::from_utf8_lossy(&request));
            let response = format!("HTTP/1.1 {status}\r\ncontent-type: application/json\r\n{headers}content-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(response.as_bytes());
        }
    });
    (base, requests)
}

fn service(base: &str) -> WorkClaims {
    let account = Arc::new(AccountManager::default());
    account.set_context_for_test(Some(context()));
    account.use_secrets_for_test(Arc::new(crate::keychain::testing::MemorySecrets::default()));
    account.set_capability_for_test(CAPABILITY, true);
    WorkClaims::with_base(account, || Some("host-0123456789ab".into()), Url::parse(base).unwrap())
}

fn body(request: &str) -> Value {
    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
}

const SECRET: &str = "SECRET-PROMPT-TEXT";

fn linked_session(project: &std::path::Path) -> SessionEntry {
    let mut session: SessionEntry = serde_json::from_value(json!({
        "id": "s1", "projectPath": project, "cwd": project, "branch": "raccoon/441-work",
        "title": "#441 Show who is working", "created": index::now(), "modified": index::now(),
        "issue": {"provider": "github", "id": "441", "identifier": "#441", "title": "Show who is working", "url": "https://github.com/acme/widgets/issues/441"},
        "tabs": [{"id": "t1", "harness": "claude", "created": index::now(), "modified": index::now(), "status": "in_progress", "title": SECRET, "providerSessionId": SECRET}]
    }))
    .unwrap();
    session.unknown.insert("draft".into(), json!(SECRET));
    session
}

#[test]
fn publishes_only_the_shared_fields_of_each_linked_session() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    index::save(&[linked_session(project.path())]).unwrap();
    let (base, requests) = serve(r#"{"claims":1,"refreshAfterSeconds":120,"liveForSeconds":300}"#);
    let claims = service(&base);
    claims.publish(&Linker::default());
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("PUT /v1/desktop/work-claims/devices/host-0123456789ab "), "{}", requests[0]);
    assert!(requests[0].contains("authorization: Bearer native-secret-token"));
    let sent = body(&requests[0]);
    let keys: Vec<_> = sent.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["claims", "deviceLabel"]);
    assert_eq!(sent["claims"][0], json!({
        "sessionId": "s1", "scope": "github.com/acme/widgets", "repository": null,
        "issue": {"provider": "github", "id": "441", "identifier": "#441"},
        "title": "#441 Show who is working", "branch": "raccoon/441-work", "state": "working",
        "cloud": false, "shareWithTeam": true, "idleSeconds": 0
    }));
    // No prompt, transcript, draft or path leaves the machine.
    let text = sent.to_string();
    assert!(!text.contains(SECRET), "{text}");
    assert!(!text.contains(&project.path().to_string_lossy().into_owned()), "{text}");
}

#[test]
fn an_unchanged_set_waits_for_the_heartbeat_and_a_withdrawal_is_sent_at_once() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    index::save(&[linked_session(project.path())]).unwrap();
    let (base, requests) = serve(r#"{"claims":1,"refreshAfterSeconds":120}"#);
    let claims = service(&base);
    let linker = Linker::default();
    assert!(claims.publish(&linker));
    assert!(claims.publish(&linker));
    assert_eq!(requests.lock().unwrap().len(), 1, "nothing changed");
    // Archiving the session is publishing without its claim, as soon as the server takes another publish.
    index::update(|sessions| {
        sessions[0].archived = true;
        Ok(())
    })
    .unwrap();
    assert!(!claims.publish(&linker), "within the server's gap the change waits");
    assert_eq!(requests.lock().unwrap().len(), 1);
    claims.state.lock().unwrap().last_put = Instant::now().checked_sub(MIN_GAP);
    assert!(claims.publish(&linker));
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(body(&requests[1])["claims"], json!([]));
}

#[test]
fn the_persons_setting_and_a_private_session_are_respected() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let mut private = linked_session(project.path());
    private.id = "s2".into();
    private.issue_work.private = true;
    index::save(&[linked_session(project.path()), private]).unwrap();
    let mut settings = crate::store::settings::load();
    settings.work_status.share_with_team = false;
    crate::store::settings::save(&settings).unwrap();
    let (base, requests) = serve(r#"{"claims":1}"#);
    service(&base).publish(&Linker::default());
    let sent = body(&requests.lock().unwrap()[0]);
    assert_eq!(sent["claims"].as_array().unwrap().len(), 1);
    assert_eq!(sent["claims"][0]["sessionId"], "s1");
    assert_eq!(sent["claims"][0]["shareWithTeam"], false);
}

#[test]
fn signed_out_or_on_an_older_server_nothing_is_sent_and_only_this_machine_is_shown() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    index::save(&[linked_session(project.path())]).unwrap();
    let (base, requests) = serve(r#"{"claims":1}"#);
    let claims = service(&base);
    claims.account.set_capability_for_test(CAPABILITY, false);
    claims.publish(&Linker::default());
    let urls = vec!["https://github.com/acme/widgets/issues/441".to_string()];
    let answer = claims.list(&project.path().to_string_lossy(), "github", &urls);
    assert_eq!((answer.available, answer.reason.as_deref()), (false, Some("unsupported")));
    claims.account.set_context_for_test(None);
    claims.publish(&Linker::default());
    let answer = claims.list(&project.path().to_string_lossy(), "github", &urls);
    assert_eq!((answer.available, answer.reason.as_deref()), (false, Some("signed_out")));
    assert!(requests.lock().unwrap().is_empty());
}

#[test]
fn an_unreachable_service_reads_as_offline_and_is_retried_later() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    index::save(&[linked_session(project.path())]).unwrap();
    let claims = service("http://127.0.0.1:9");
    claims.publish(&Linker::default());
    {
        let state = claims.state.lock().unwrap();
        assert_eq!(state.failures, 1);
        assert!(state.retry_at.is_some() && state.sent.is_none());
    }
    let answer = claims.list(&project.path().to_string_lossy(), "linear", &["https://linear.app/acme/issue/ENG-42/x".into()]);
    assert_eq!((answer.available, answer.reason.as_deref()), (false, Some("offline")));
}

#[test]
fn a_server_that_asks_for_a_wait_is_left_alone_that_long() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    index::save(&[linked_session(project.path())]).unwrap();
    let (base, requests) = serve_with("429 Too Many Requests", "Retry-After: 120\r\n", r#"{"error":"work_claims_rate_limited"}"#);
    let claims = service(&base);
    claims.publish(&Linker::default());
    assert_eq!(requests.lock().unwrap().len(), 1);
    let state = claims.state.lock().unwrap();
    assert!(state.retry_at.unwrap() >= Instant::now() + Duration::from_secs(119));
    assert!(state.sent.is_none());
}

#[test]
fn lists_every_visible_claim_but_this_machines_own_local_ones() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let (base, requests) = serve(
        r##"{"now":1000,"liveForSeconds":300,"claims":[
        {"scope":"github.com/acme/widgets","issue":{"provider":"github","id":"441","identifier":"#441"},"person":{"name":"Me","you":true},"device":{"id":"host-0123456789ab","label":"This Mac"},"sessionId":"s1","title":"t","branch":null,"state":"working","cloud":false,"live":true,"since":1,"lastActiveAt":2,"refreshedAt":3},
        {"scope":"github.com/acme/widgets","issue":{"provider":"github","id":"441","identifier":"#441"},"person":{"name":"Me","you":true},"device":{"id":"host-0123456789ab","label":"This Mac"},"sessionId":"cloud:ws:c1","title":"t","branch":null,"state":"idle","cloud":true,"live":true,"since":1,"lastActiveAt":2,"refreshedAt":3},
        {"scope":"github.com/acme/widgets","issue":{"provider":"github","id":"441","identifier":"#441"},"person":{"name":"Me","you":true},"device":{"id":"other-machine-01","label":"Studio"},"sessionId":"s9","title":"t","branch":"b","state":"waiting","cloud":false,"live":false,"since":1,"lastActiveAt":2,"refreshedAt":3},
        {"scope":"github.com/acme/widgets","issue":{"provider":"github","id":"12","identifier":"#12"},"person":{"name":"Alice","you":false},"title":"t","branch":"alice/12","state":"a_new_state","live":true,"since":1,"lastActiveAt":2,"refreshedAt":3}
    ]}"##,
    );
    let claims = service(&base);
    let answer = claims.list(&project.path().to_string_lossy(), "github", &["https://github.com/Acme/Widgets/issues/441".into(), "https://github.com/acme/widgets/issues/12".into()]);
    let request = &requests.lock().unwrap()[0];
    assert!(request.starts_with("GET /v1/desktop/work-claims?provider=github&scope=github.com%2Facme%2Fwidgets "), "{request}");
    assert!(answer.available);
    assert_eq!(answer.now, 1000);
    let shown: Vec<_> = answer.claims.iter().map(|claim| (claim.person.name.as_str(), claim.session_id.as_deref(), claim.state.as_str())).collect();
    assert_eq!(shown, [("Me", Some("cloud:ws:c1"), "idle"), ("Me", Some("s9"), "waiting"), ("Alice", None, "a_new_state")]);
    // The token never reaches the webview.
    assert!(!serde_json::to_string(&answer).unwrap().contains("native-secret-token"));
}

#[test]
fn a_cloud_project_is_read_by_the_repository_its_key_names() {
    let _home = crate::store::temp_home();
    let (base, requests) = serve(r#"{"now":1000,"liveForSeconds":300,"claims":[]}"#);
    let claims = service(&base);
    // A cloud project (#433) has no checkout here, and its key is never read as one.
    assert_eq!(claims.remote("cloud:org_01H:github.com/Acme/Widgets").as_deref(), Some("github.com/acme/widgets"));
    assert_eq!(claims.remote("cloud:org_01H:blank/scratch"), None);
    let answer = claims.list("cloud:org_01H:github.com/acme/widgets", "github", &["https://github.com/acme/widgets/issues/441".into()]);
    assert!(answer.available);
    let request = &requests.lock().unwrap()[0];
    assert!(request.starts_with("GET /v1/desktop/work-claims?provider=github&scope=github.com%2Facme%2Fwidgets "), "{request}");
}

#[test]
fn signing_out_withdraws_this_devices_claims() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    index::save(&[linked_session(project.path())]).unwrap();
    let (base, requests) = serve(r#"{"claims":0}"#);
    let claims = service(&base);
    claims.publish(&Linker::default());
    claims.sign_out(|| ((), claims.account.end_session_generation_for_test()));
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].starts_with("DELETE /v1/desktop/work-claims/devices/host-0123456789ab "), "{}", requests[1]);
    assert!(claims.state.lock().unwrap().sent.is_none());
}

#[test]
fn the_organization_switch_is_asked_only_of_a_member_organization() {
    let (base, requests) = serve(r#"{"shareWorkStatus":false,"canManage":true,"personal":false,"linearWorkspaces":["acme"]}"#);
    let claims = service(&base);
    claims.account.set_memberships_for_test(&["org-1", "org-2"], true);
    let status = claims.set_organization("org-2", &OrganizationWorkStatusPatch { share_work_status: Some(false), linear_workspaces: None }).unwrap();
    assert_eq!(status, OrganizationWorkStatus { share_work_status: false, can_manage: true, personal: false, linear_workspaces: vec!["acme".into()] });
    // What is not changed is not sent.
    claims.set_organization("org-2", &OrganizationWorkStatusPatch { share_work_status: None, linear_workspaces: Some(vec!["acme".into()]) }).unwrap();
    let requests = requests.lock().unwrap();
    assert!(requests[0].starts_with("POST /v1/desktop/orgs/org-2/work-status "), "{}", requests[0]);
    assert_eq!(body(&requests[0]), json!({"shareWorkStatus": false}));
    assert_eq!(body(&requests[1]), json!({"linearWorkspaces": ["acme"]}));
    assert_eq!(claims.organization("org-9").unwrap_err().code, "cloud_organization_unavailable");
    assert_eq!(claims.organization("../x").unwrap_err().code, "invalid_request");
}

fn session_with(id: &str, issue: Option<IssueRef>) -> SessionEntry {
    let mut session: SessionEntry = serde_json::from_value(json!({"id": id, "projectPath": "/p", "cwd": "/p", "title": "t", "created": "c", "modified": "m"})).unwrap();
    session.issue = issue;
    session
}

fn issue(number: &str) -> IssueRef {
    IssueRef { provider: "github".into(), id: number.into(), identifier: format!("#{number}"), title: "T".into(), url: format!("https://github.com/acme/widgets/issues/{number}") }
}

#[test]
fn a_session_is_linked_and_unlinked_by_hand_and_an_unlinked_issue_stays_unlinked() {
    let _home = crate::store::temp_home();
    index::save(&[session_with("s1", Some(issue("441")))]).unwrap();
    let unlinked = unlink_issue("s1").unwrap();
    assert_eq!(unlinked.issue, None);
    assert_eq!(unlinked.issue_work.unlinked, ["https://github.com/acme/widgets/issues/441"]);
    // Linking is not activity.
    assert_eq!(unlinked.modified, "m");
    // The linker finding it again changes nothing.
    assert_eq!(write_link("s1", issue("441"), IssueLinkSource::Branch).unwrap(), None);
    // Another issue is linked automatically, and shown as such.
    let linked = write_link("s1", issue("7"), IssueLinkSource::Branch).unwrap().unwrap();
    assert_eq!((linked.issue.unwrap().id, linked.issue_work.link), ("7".to_string(), Some(IssueLinkSource::Branch)));
    // A link the session already has is never replaced by one found later.
    assert_eq!(write_link("s1", issue("8"), IssueLinkSource::Prompt).unwrap(), None);
    // By hand, the reader may link the one they unlinked.
    let manual = link_issue("s1", issue("441")).unwrap();
    assert_eq!((manual.issue.unwrap().id, manual.issue_work.link), ("441".to_string(), Some(IssueLinkSource::Manual)));
    assert!(manual.issue_work.unlinked.is_empty());
    assert!(link_issue("s1", IssueRef { url: "javascript:alert(1)".into(), ..issue("1") }).is_err());
    let private = set_private("s1", true).unwrap();
    assert!(private.issue_work.private);
    let stored = serde_json::to_value(index::get("s1").unwrap()).unwrap();
    assert_eq!(stored["issueWork"], json!({"link": "manual", "private": true}));
}

/// The trackers as a cloud session's branch needs them: Linear has ENG-42,
/// once it can say its teams.
#[derive(Default)]
struct Trackers {
    teams: std::cell::Cell<bool>,
}

impl Lookup for Trackers {
    fn github_repo(&self, _: &str) -> Option<String> {
        None
    }
    fn github_issue(&self, _: &str, _: &str) -> Result<Option<IssueRef>, String> {
        Ok(None)
    }
    fn github_issue_in(&self, _: &str, _: &str) -> Result<Option<IssueRef>, String> {
        Ok(None)
    }
    fn linear_issue(&self, identifier: &str) -> Result<Option<IssueRef>, String> {
        Ok((identifier == "ENG-42").then(|| IssueRef { provider: "linear".into(), id: "uuid-42".into(), identifier: "ENG-42".into(), title: "T".into(), url: "https://linear.app/acme/issue/ENG-42".into() }))
    }
    fn linear_teams(&self) -> Option<BTreeSet<String>> {
        self.teams.get().then(|| BTreeSet::from(["ENG".to_string()]))
    }
    fn branch_pulls(&self, _: &str, _: &[String]) -> Option<HashMap<String, BranchPull>> {
        Some(HashMap::new())
    }
    fn first_request(&self, _: &SessionEntry) -> Option<String> {
        None
    }
}

#[test]
fn a_cloud_session_settled_while_linear_could_not_say_its_teams_is_linked_once_it_can() {
    let _home = crate::store::temp_home();
    let claims = service("http://127.0.0.1:9");
    let cloud: CloudSession = serde_json::from_value(json!({
        "orgId": "org-1", "workspaceId": "w1", "sessionId": "c1", "createdBy": "user-1", "repository": "acme/widgets",
        "title": "t", "branch": "me/eng-42-login", "status": "in_progress", "modified": index::now(),
    }))
    .unwrap();
    claims.set_cloud(vec![cloud.clone()]);
    let found = |claims: &WorkClaims| claims.state.lock().unwrap().cloud_issues.get(&cloud.claim_id()).and_then(|known| known.issue.clone()).map(|issue| issue.identifier);
    let trackers = Trackers::default();
    let mut linker = Linker::default();
    // Settled without them, and kept while Linear still cannot say them.
    for _ in 0..2 {
        claims.link_pass(&mut linker, &trackers);
        assert_eq!(found(&claims), None);
    }
    // An hour on Linear can say them, and no local session is there to ask.
    trackers.teams.set(true);
    linker.age_teams();
    claims.link_pass(&mut linker, &trackers);
    assert_eq!(found(&claims).as_deref(), Some("ENG-42"));
}

#[test]
fn existing_reviewers_are_unlinked_and_never_published_even_after_the_pipeline_stops() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let author = linked_session(project.path());
    let mut reviewer = author.clone();
    reviewer.id = "reviewer-1".into();
    reviewer.issue_work.link = Some(IssueLinkSource::Branch);
    index::save(&[author.clone(), reviewer.clone()]).unwrap();
    let mut pipeline: crate::issue_pipeline::Pipeline = serde_json::from_str(include_str!("../fixtures/issue_pipeline.json")).unwrap();
    pipeline.author.session_id = author.id.clone();
    pipeline.stopped = true;
    crate::issue_pipeline::store::insert(&pipeline).unwrap();
    let (base, requests) = serve(r#"{"claims":1,"refreshAfterSeconds":120}"#);
    let claims = service(&base);
    let mut linker = Linker::default();
    // Publishing before the next linking pass must also exclude the stale link.
    assert!(claims.publish(&linker));
    let sent = body(&requests.lock().unwrap()[0]);
    assert_eq!(sent["claims"].as_array().unwrap().len(), 1);
    assert_eq!(sent["claims"][0]["sessionId"], author.id);
    claims.link_pass(&mut linker, &Trackers::default());
    let cleaned = index::get(&reviewer.id).unwrap();
    assert!(cleaned.issue.is_none());
    assert!(cleaned.issue_work.link.is_none());
    assert_eq!(cleaned.modified, reviewer.modified);
    assert!(cleaned.issue_work.unlinked.contains(&reviewer.issue.unwrap().url));
    assert_eq!(index::get(&author.id).unwrap().issue, author.issue);
    claims.link_pass(&mut linker, &Trackers::default());
    assert!(index::get(&reviewer.id).unwrap().issue.is_none());
}

#[test]
fn reviewer_identity_survives_pipeline_eviction_and_replacement_on_disk() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    let author = linked_session(project.path());
    let mut reviewer = author.clone();
    reviewer.id = "reviewer-1".into();
    reviewer.issue = None;
    reviewer.branch = Some("eng-42-review".into());
    index::save(&[author.clone(), reviewer.clone()]).unwrap();
    let mut pipeline: crate::issue_pipeline::Pipeline = serde_json::from_str(include_str!("../fixtures/issue_pipeline.json")).unwrap();
    pipeline.author.session_id = author.id.clone();
    pipeline.stopped = true;
    // An older file has no reviewer identity set yet.
    crate::store::write_json(&crate::store::root().unwrap().join("issue-pipelines.json"), &json!({"pipelines": [pipeline.clone()]})).unwrap();
    let claims = service("http://127.0.0.1:9");
    let trackers = Trackers { teams: std::cell::Cell::new(true) };
    let mut linker = Linker::default();
    claims.link_pass(&mut linker, &trackers);
    assert!(index::get(&reviewer.id).unwrap().issue.is_none());
    assert!(index::get(&reviewer.id).unwrap().issue_work.unlinked.is_empty());
    // Replacing the reviewer's deleted tab must not forget the old session.
    pipeline.reviewer.as_mut().unwrap().session_id = "replacement-reviewer".into();
    crate::issue_pipeline::store::commit(&mut pipeline).unwrap();
    let original = pipeline.id.clone();
    for n in 0..200 {
        pipeline.id = format!("later-{n}");
        pipeline.reviewer = None;
        crate::issue_pipeline::store::insert(&pipeline).unwrap();
    }
    assert!(crate::issue_pipeline::store::get(&original).is_err());
    let remembered = crate::issue_pipeline::store::reviewer_sessions().unwrap();
    assert!(remembered.contains(&reviewer.id));
    assert!(remembered.contains("replacement-reviewer"));
    assert!(!remembered.contains(&author.id));
    // A fresh linker reads identities from disk after history eviction.
    claims.link_pass(&mut Linker::default(), &trackers);
    assert!(index::get(&reviewer.id).unwrap().issue.is_none());
    assert_eq!(index::get(&author.id).unwrap().issue, author.issue);
}

#[test]
fn sign_out_drains_the_first_publish_and_blocks_queued_work_through_account_removal() {
    let _home = crate::store::temp_home();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (base, requests) = serve_observing("200 OK", "", r#"{"claims":0}"#, move |request| {
        if request.starts_with("PUT ") {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        }
    });
    let claims = Arc::new(service(&base));
    let publisher = claims.clone();
    let publishing = std::thread::spawn(move || publisher.publish(&Linker::default()));
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(claims.state.lock().unwrap().sent.is_none(), "first PUT is unanswered");
    let signing_out = claims.clone();
    let (ending_tx, ending_rx) = std::sync::mpsc::channel();
    let (end_tx, end_rx) = std::sync::mpsc::channel();
    let logout = std::thread::spawn(move || signing_out.sign_out(|| {
        ending_tx.send(()).unwrap();
        end_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        ((), signing_out.account.end_session_generation_for_test())
    }));
    let deadline = Instant::now() + Duration::from_secs(10);
    while claims.state.lock().unwrap().signing_out == 0 {
        assert!(Instant::now() < deadline);
        std::thread::yield_now();
    }
    // Refresh cannot lift the sign-out fence, even before withdrawal starts.
    let mut refreshed = context();
    refreshed.access_token = "refreshed-test-token".into();
    claims.account.set_context_for_test(Some(refreshed));
    claims.account.set_capability_for_test(CAPABILITY, true);
    claims.nudge();
    assert!(!claims.publish(&Linker::default()));
    assert_eq!(requests.lock().unwrap().len(), 1);
    release_tx.send(()).unwrap();
    assert!(publishing.join().unwrap());
    ending_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(!claims.publish(&Linker::default()), "withdrawal finished but account is still signed in");
    let mut replacement = context();
    replacement.generation += 1;
    replacement.user_id = "other-user".into();
    claims.account.set_context_for_test(Some(replacement));
    claims.account.set_capability_for_test(CAPABILITY, true);
    assert!(!claims.publish(&Linker::default()), "an account change cannot undo an in-progress sign-out");
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].starts_with("PUT "));
        assert!(requests[1].starts_with("DELETE "));
        assert!(requests[1].contains("Bearer refreshed-test-token"));
    }
    end_tx.send(()).unwrap();
    logout.join().unwrap();
    assert!(claims.publish(&Linker::default()));
    assert_eq!(requests.lock().unwrap().len(), 2);
    assert!(claims.state.lock().unwrap().sent.is_none());
}

#[test]
fn sign_out_without_sent_withdraws_and_failure_stays_fenced_until_new_sign_in() {
    let _home = crate::store::temp_home();
    let (base, requests) = serve_with("503 Service Unavailable", "", r#"{"error":"unavailable"}"#);
    let claims = service(&base);
    // Includes an unanswered/failed publish and its backoff, with no Sent entry.
    assert!(claims.publish(&Linker::default()));
    assert!(claims.state.lock().unwrap().retry_at.is_some());
    claims.sign_out(|| ((), claims.account.current_generation())); // Simulate account removal failing, retaining its session.
    assert!(requests.lock().unwrap()[1].starts_with("DELETE /v1/desktop/work-claims/devices/host-0123456789ab "));
    let mut refreshed = context();
    refreshed.access_token = "refreshed-test-token".into();
    claims.account.set_context_for_test(Some(refreshed.clone()));
    claims.account.set_capability_for_test(CAPABILITY, true);
    claims.nudge();
    assert!(claims.publish(&Linker::default()));
    assert_eq!(requests.lock().unwrap().len(), 2, "refresh must not resume publishing");
    assert!(claims.state.lock().unwrap().retry_at.is_none());
    // A later sign-in to the same user is allowed, without the old backoff/gap.
    refreshed.generation += 2;
    claims.account.set_context_for_test(Some(refreshed));
    claims.account.set_capability_for_test(CAPABILITY, true);
    assert!(claims.publish(&Linker::default()));
    assert_eq!(requests.lock().unwrap().len(), 3);
}

#[test]
fn sign_out_with_no_publish_still_withdraws_the_known_device() {
    let (base, requests) = serve(r#"{}"#);
    let claims = service(&base);
    claims.sign_out(|| ((), claims.account.end_session_generation_for_test()));
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].starts_with("DELETE /v1/desktop/work-claims/devices/host-0123456789ab "));
}

#[test]
fn a_timed_out_publish_and_withdrawal_do_not_prevent_local_sign_out() {
    let _home = crate::store::temp_home();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (base, _) = serve_observing("200 OK", "", r#"{}"#, move |request| {
        if request.starts_with("PUT ") {
            entered_tx.send(()).unwrap();
            // The test releases the server only AFTER local sign-out completes.
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        }
    });
    let mut claims = service(&base);
    claims.client = Client::new(Url::parse(&base).unwrap(), Duration::from_millis(100));
    claims.sign_out_client = Client::new(Url::parse(&base).unwrap(), Duration::from_millis(100));
    let claims = Arc::new(claims);
    let publisher = claims.clone();
    let publishing = std::thread::spawn(move || publisher.publish(&Linker::default()));
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let signing_out = claims.clone();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let logout = std::thread::spawn(move || {
        signing_out.sign_out(|| ((), signing_out.account.end_session_generation_for_test()));
        done_tx.send(()).unwrap();
    });
    done_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    release_tx.send(()).unwrap();
    publishing.join().unwrap();
    logout.join().unwrap();
    assert!(claims.account.context().is_none());
    assert!(claims.state.lock().unwrap().retry_at.is_none());
}


#[test]
fn a_sign_in_during_logout_is_not_fenced_when_the_old_logout_returns() {
    let _home = crate::store::temp_home();
    // Both signing back in as the same person and switching accounts must resume.
    for user_id in ["user-1", "other-user"] {
        let (base, requests) = serve(r#"{"claims":0}"#);
        let claims = Arc::new(service(&base));
        let signing_out = claims.clone();
        let (removed_tx, removed_rx) = std::sync::mpsc::channel();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel();
        let logout = std::thread::spawn(move || signing_out.sign_out(|| {
            let generation = signing_out.account.end_session_generation_for_test();
            removed_tx.send(generation).unwrap();
            // AccountManager emits signed-out status here, then waits on logout HTTP.
            finish_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            ((), generation)
        }));
        let removed_generation = removed_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let mut new_session = context();
        new_session.generation = removed_generation + 1;
        new_session.user_id = user_id.into();
        claims.account.set_context_for_test(Some(new_session));
        claims.account.set_capability_for_test(CAPABILITY, true);
        assert!(!claims.publish(&Linker::default()), "still fenced while logout is in progress");
        finish_tx.send(()).unwrap();
        logout.join().unwrap();
        claims.nudge();
        assert!(claims.publish(&Linker::default()));
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2, "new sign-in must publish after the old logout returns");
        assert!(requests[0].starts_with("DELETE "));
        assert!(requests[1].starts_with("PUT "));
    }
}

#[test]
fn capability_recovery_republishes_real_sessions_without_reviving_unsupported_claims() {
    let _home = crate::store::temp_home();
    let project = tempfile::tempdir().unwrap();
    index::save(&[linked_session(project.path())]).unwrap();
    let (base, requests) = serve(r#"{"claims":1,"refreshAfterSeconds":120}"#);
    let claims = service(&base);
    let linker = Linker::default();
    claims.account.set_capability_for_test(CAPABILITY, false);
    assert!(claims.publish(&linker));
    assert!(requests.lock().unwrap().is_empty());
    let answer = claims.list("unused", "github", &[]);
    assert_eq!(answer.reason.as_deref(), Some("unsupported"));
    assert!(!answer.available && answer.claims.is_empty());
    claims.account.set_capability_for_test(CAPABILITY, true);
    assert!(claims.publish(&linker));
    assert_eq!(requests.lock().unwrap().len(), 1);
    claims.account.set_capability_for_test(CAPABILITY, false);
    assert!(claims.publish(&linker));
    assert!(claims.state.lock().unwrap().sent.is_none());
    assert_eq!(requests.lock().unwrap().len(), 1);
    claims.account.set_capability_for_test(CAPABILITY, true);
    claims.state.lock().unwrap().last_put = Instant::now().checked_sub(MIN_GAP);
    assert!(claims.publish(&linker));
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(body(&requests[1])["claims"][0]["sessionId"], "s1");
    assert_eq!(body(&requests[0])["claims"][0]["issue"], body(&requests[1])["claims"][0]["issue"]);
}
