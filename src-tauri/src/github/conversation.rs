//! The PR conversation, kept separate from inexpensive branch discovery.
use std::collections::{BTreeMap, BTreeSet};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const QUERY: &str = include_str!("conversation.graphql");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewer {
    pub login: String,
    pub kind: String,
    pub state: String,
    pub requested: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub id: String,
    pub kind: String,
    pub author: String,
    pub body: String,
    pub at: String,
    pub url: Option<String>,
    pub state: Option<String>,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub url: String,
    pub title: String,
    pub body: String,
    pub state: String,
    pub author: String,
    pub viewer: String,
    pub can_edit: bool,
    pub reviewers: Vec<Reviewer>,
    pub unresolved_threads: usize,
    pub activity: Vec<Activity>,
}

/// Parse once and use the same host/repository identity for reads and writes.
/// Full URL validation rejects query strings, credentials and path traversal.
pub struct Target {
    pub url: String,
    pub host: String,
    pub owner: String,
    pub name: String,
    pub number: String,
}

impl Target {
    pub fn new(url: &str) -> Result<Self> {
        let url = crate::pr_associations::identity(url)?;
        let parts: Vec<_> = url.trim_start_matches("https://").split('/').collect();
        if parts[1..3].iter().any(|part| matches!(*part, "." | "..") || !part.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))) {
            bail!("Invalid GitHub repository name.");
        }
        Ok(Self { host: parts[0].into(), owner: parts[1].into(), name: parts[2].into(), number: parts[4].into(), url })
    }
}

fn string(v: &Value, key: &str) -> String { v[key].as_str().unwrap_or_default().into() }
fn optional(v: &Value, key: &str) -> Option<String> { v[key].as_str().map(str::to_string) }

fn response(raw: &str) -> Result<Value> {
    let value: Value = serde_json::from_str(raw)?;
    if let Some(errors) = value["errors"].as_array().filter(|errors| !errors.is_empty()) {
        bail!("GitHub: {}", errors.iter().map(|error| error["message"].as_str().unwrap_or("GraphQL query failed")).collect::<Vec<_>>().join("; "));
    }
    Ok(value)
}

const CONNECTIONS: [(&str, &str, &str); 4] = [
    ("reviews", "reviews", "readReviews"),
    ("reviewRequests", "requests", "readRequests"),
    ("reviewThreads", "threads", "readThreads"),
    ("timelineItems", "timeline", "readTimeline"),
];

/// One query fetches all sections. Repeat only for connections with another
/// page; never silently turn a partial thread count into an exact count.
pub fn read_with(target: &Target, mut run: impl FnMut(&[&str]) -> Result<String>) -> Result<Conversation> {
    let mut cursors: [Option<String>; 4] = Default::default();
    let mut done = [false; 4];
    let mut combined = Value::Null;
    for _ in 0..100 {
        let mut args = vec!["api".into(), "graphql".into(), "--hostname".into(), target.host.clone(),
            "-f".into(), format!("query={QUERY}"), "-f".into(), format!("owner={}", target.owner),
            "-f".into(), format!("name={}", target.name), "-F".into(), format!("number={}", target.number)];
        for (i, (_, variable, include)) in CONNECTIONS.iter().enumerate() {
            args.extend(["-F".into(), format!("{include}={}", !done[i])]);
            if let Some(cursor) = &cursors[i] { args.extend(["-f".into(), format!("{variable}={cursor}")]); }
        }
        let page = response(&run(&args.iter().map(String::as_str).collect::<Vec<_>>())?)?;
        let pr = &page["data"]["repository"]["pullRequest"];
        if !pr.is_object() { bail!("GitHub did not return this pull request."); }
        if string(pr, "url").to_lowercase() != target.url { bail!("GitHub returned a different pull request."); }
        if combined.is_null() { combined = page.clone(); }
        else {
            for (i, (field, _, _)) in CONNECTIONS.iter().enumerate() {
                if !done[i] {
                    let nodes = pr[field]["nodes"].as_array().context("GitHub omitted conversation items")?;
                    combined["data"]["repository"]["pullRequest"][field]["nodes"].as_array_mut().context("GitHub omitted conversation items")?.extend(nodes.iter().cloned());
                }
            }
        }
        for (i, (field, _, _)) in CONNECTIONS.iter().enumerate() {
            if done[i] { continue; }
            pr[field]["nodes"].as_array().context("GitHub omitted conversation items")?;
            let info = &pr[field]["pageInfo"];
            if info["hasNextPage"].as_bool().context("GitHub omitted pagination")? {
                let next = info["endCursor"].as_str().context("GitHub omitted the next page cursor")?;
                if cursors[i].as_deref() == Some(next) { bail!("GitHub repeated a conversation page."); }
                cursors[i] = Some(next.into());
            } else { done[i] = true; }
        }
        if done.iter().all(|done| *done) { return parse(&combined); }
    }
    bail!("This conversation is too large to load completely.")
}

fn parse(value: &Value) -> Result<Conversation> {
    let pr = &value["data"]["repository"]["pullRequest"];
    let mut reviewers: BTreeMap<String, Reviewer> = BTreeMap::new();
    for review in pr["reviews"]["nodes"].as_array().context("GitHub omitted reviews")? {
        let login = string(&review["author"], "login");
        let state = string(review, "state");
        if login.is_empty() || state == "PENDING" || login.eq_ignore_ascii_case(&string(&pr["author"], "login")) { continue; }
        let kind = if review["author"]["__typename"] == "Bot" || login.ends_with("[bot]") { "bot" } else { "user" };
        let reviewer = reviewers.entry(login.to_lowercase()).or_insert(Reviewer { login, kind: kind.into(), state: "COMMENTED".into(), requested: false });
        // A comment after an approval/change request does not revoke that decision.
        if state != "COMMENTED" || !matches!(reviewer.state.as_str(), "APPROVED" | "CHANGES_REQUESTED") {
            reviewer.state = state;
        }
    }
    for request in pr["reviewRequests"]["nodes"].as_array().context("GitHub omitted review requests")? {
        let who = &request["requestedReviewer"];
        let team = who["__typename"] == "Team";
        let login = if team { format!("{}/{}", string(&who["organization"], "login"), string(who, "slug")) } else { string(who, "login") };
        if login.is_empty() { continue; }
        reviewers.insert(login.to_lowercase(), Reviewer { login, kind: if team { "team" } else if who["__typename"] == "Bot" { "bot" } else { "user" }.into(), state: "PENDING".into(), requested: true });
    }
    let unresolved_threads = pr["reviewThreads"]["nodes"].as_array().context("GitHub omitted review threads")?.iter()
        .filter(|thread| thread["isResolved"] == false).filter_map(|thread| thread["id"].as_str()).collect::<BTreeSet<_>>().len();
    let mut seen = BTreeSet::new();
    let activity = pr["timelineItems"]["nodes"].as_array().context("GitHub omitted activity")?.iter().filter_map(|node| {
        let kind = match node["__typename"].as_str()? {
            "IssueComment" => "comment", "PullRequestReview" if node["state"] != "PENDING" => "review",
            "PullRequestCommit" => "commit", "HeadRefForcePushedEvent" => "force_push", _ => return None,
        };
        let id = string(node, "id");
        if id.is_empty() || !seen.insert(id.clone()) { return None; }
        let commit = &node["commit"];
        let author = if kind == "commit" { commit["author"]["user"]["login"].as_str().or_else(|| commit["author"]["name"].as_str()) }
            else if kind == "force_push" { node["actor"]["login"].as_str() } else { node["author"]["login"].as_str() };
        Some(Activity { id, kind: kind.into(), author: author.unwrap_or("Deleted user").into(),
            body: if kind == "commit" { string(commit, "messageHeadline") } else { string(node, "body") },
            at: if kind == "commit" { string(commit, "committedDate") } else if kind == "review" { string(node, "submittedAt") } else { string(node, "createdAt") },
            url: if kind == "commit" { optional(commit, "url") } else { optional(node, "url") },
            state: optional(node, "state"), before: optional(&node["beforeCommit"], "oid"),
            after: if kind == "commit" { optional(commit, "oid") } else { optional(&node["afterCommit"], "oid") },
        })
    }).collect();
    Ok(Conversation { url: string(pr, "url"), title: string(pr, "title"), body: string(pr, "body"), state: string(pr, "state"),
        author: string(&pr["author"], "login"), viewer: string(&value["data"]["viewer"], "login"),
        can_edit: pr["viewerCanUpdate"] == true, reviewers: reviewers.into_values().collect(), unresolved_threads, activity })
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Action {
    Edit { title: String, body: String, #[serde(rename = "expectedTitle")] expected_title: String, #[serde(rename = "expectedBody")] expected_body: String },
    Request { login: String, team: bool },
    Remove { login: String, team: bool },
    Approve { viewer: String },
}

pub fn act_with(target: &Target, action: Action, mut run: impl FnMut(&[&str]) -> Result<String>) -> Result<()> {
    match action {
        Action::Edit { title, body, expected_title, expected_body } => {
            let title = title.trim();
            if title.is_empty() || title.len() > 1024 || body.len() > 65536 { bail!("Enter a title and a description of at most 64 KB."); }
            let current: Value = serde_json::from_str(&run(&["pr", "view", &target.url, "--json", "title,body"])?)?;
            if current["title"].as_str() != Some(&expected_title) || current["body"].as_str() != Some(&expected_body) {
                bail!("The title or description changed on GitHub. Copy your draft, cancel, then edit the latest version.");
            }
            run(&["pr", "edit", &target.url, "--title", title, "--body", &body])?;
        }
        Action::Approve { viewer } => {
            // Recheck the acting account immediately before writing: a local
            // gh token can also be an App token, or have changed since reading.
            let account: Value = serde_json::from_str(&run(&["api", "--hostname", &target.host, "user"])?)?;
            let login = string(&account, "login");
            if account["type"] != "User" || login.is_empty() || login.ends_with("[bot]") || !login.eq_ignore_ascii_case(&viewer) {
                bail!("Approve with the personal GitHub account shown in the confirmation. Refresh after switching accounts.");
            }
            run(&["pr", "review", &target.url, "--approve"])?;
        }
        Action::Request { ref login, team } | Action::Remove { ref login, team } => {
            let remove = matches!(action, Action::Remove { .. });
            let name = if team {
                let (organization, slug) = login.split_once('/').context("Expected an organization/team reviewer")?;
                if !organization.eq_ignore_ascii_case(&target.owner) { bail!("Reviewer team belongs to another organization"); }
                slug
            } else { login };
            // Enterprise Managed Users include an underscore before the enterprise shortcode.
            if name.is_empty() || name.len() > 100 || name.starts_with('-') || name.ends_with('-') || !name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')) { bail!("Invalid reviewer login."); }
            let endpoint = format!("repos/{}/{}/pulls/{}/requested_reviewers", target.owner, target.name, target.number);
            let field = format!("{}[]={name}", if team { "team_reviewers" } else { "reviewers" });
            run(&["api", "--hostname", &target.host, "--method", if remove { "DELETE" } else { "POST" }, &endpoint, "-f", &field])?;
        }
    }
    Ok(())
}

pub fn search_with(target: &Target, query: &str, mut run: impl FnMut(&[&str]) -> Result<String>) -> Result<Vec<String>> {
    let query = query.trim();
    if query.len() < 2 { return Ok(Vec::new()); }
    if query.len() > 100 { bail!("Search is too long."); }
    // Search within this repository, rather than the global user directory.
    const SEARCH: &str = "query($owner: String!, $name: String!, $search: String!) { repository(owner: $owner, name: $name) { assignableUsers(first: 10, query: $search) { nodes { login } } } }";
    let out = run(&["api", "graphql", "--hostname", &target.host, "-f", &format!("query={SEARCH}"), "-f", &format!("owner={}", target.owner), "-f", &format!("name={}", target.name), "-f", &format!("search={query}")])?;
    let value = response(&out)?;
    Ok(value["data"]["repository"]["assignableUsers"]["nodes"].as_array().context("GitHub omitted search results")?.iter().filter_map(|user| user["login"].as_str().filter(|login| !login.ends_with("[bot]")).map(str::to_string)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Recorded from terminalx-ai/terminalx#799 on 2026-11-07 using QUERY.
    // Logins, repository, IDs, URLs and prose are sanitized. Mutated copies cover absent actors, pagination and review states
    // without requiring network access or publishing test reviews/comments.
    const RECORDED: &str = include_str!("../fixtures/github_pr_conversation.json");
    fn fixture() -> Value { serde_json::from_str(RECORDED).unwrap() }
    fn target() -> Target { Target::new("https://github.com/acme/widgets/pull/799").unwrap() }

    #[test]
    fn recorded_graphql_conversation() {
        let mut calls = 0;
        let conversation = read_with(&target(), |args| {
            calls += 1;
            assert!(args.contains(&"graphql"));
            assert!(args.contains(&"readThreads=true"));
            Ok(RECORDED.into())
        }).unwrap();
        assert_eq!(calls, 1);
        assert_eq!(conversation.activity.len(), 11);
        assert_eq!(conversation.activity.iter().filter(|item| item.kind == "comment").count(), 3);
        assert_eq!(conversation.activity.iter().filter(|item| item.kind == "review").count(), 1);
        // The recorded review is the author's own comment, not an external reviewer.
        assert!(conversation.reviewers.is_empty());
        assert_eq!(conversation.viewer, conversation.author);
        assert!(!conversation.title.is_empty());
        assert_eq!(conversation.unresolved_threads, 0);
    }

    #[test]
    fn requests_override_old_reviews_and_comments_do_not_revoke_approval() {
        let mut value = fixture();
        let pr = &mut value["data"]["repository"]["pullRequest"];
        pr["reviews"]["nodes"] = json!([
            {"state":"APPROVED","author":{"login":"Ada"}},
            {"state":"COMMENTED","author":{"login":"Ada"}},
            {"state":"CHANGES_REQUESTED","author":{"login":"Ben"}},
            {"state":"COMMENTED","author":{"login":"Cy"}},
            {"state":"PENDING","author":{"login":"Dana"}},
            {"state":"COMMENTED","author":{"login":"author"}},
            {"state":"COMMENTED","author":{"login":"robot[bot]","__typename":"Bot"}},
            {"state":"APPROVED","author":null},
            {"state":"DISMISSED","author":{"login":"Eve"}}
        ]);
        pr["reviewRequests"]["nodes"] = json!([
            {"requestedReviewer":{"__typename":"User","login":"Ben"}},
            {"requestedReviewer":{"__typename":"User","login":"Fox"}},
            {"requestedReviewer":{"__typename":"Team","slug":"core","organization":{"login":"acme"}}},
            {"requestedReviewer":null}
        ]);
        pr["reviewThreads"]["nodes"] = json!([
            {"id":"one","isResolved":false}, {"id":"two","isResolved":true},
            {"id":"three","isResolved":false}, {"id":"one","isResolved":false}
        ]);
        let result = parse(&value).unwrap();
        let reviewer = |login: &str| result.reviewers.iter().find(|r| r.login == login).unwrap();
        assert_eq!(reviewer("Ada").state, "APPROVED");
        assert_eq!(reviewer("Ben").state, "PENDING");
        assert!(reviewer("Ben").requested);
        assert_eq!(reviewer("Cy").state, "COMMENTED");
        assert_eq!(reviewer("Eve").state, "DISMISSED");
        assert_eq!(reviewer("acme/core").kind, "team");
        assert_eq!(reviewer("robot[bot]").kind, "bot");
        assert_eq!(result.reviewers.len(), 7);
        assert_eq!(result.unresolved_threads, 2);
    }

    #[test]
    fn deleted_actors_force_pushes_and_pending_reviews() {
        let mut value = fixture();
        let nodes = value["data"]["repository"]["pullRequest"]["timelineItems"]["nodes"].as_array_mut().unwrap();
        nodes.push(json!({"__typename":"HeadRefForcePushedEvent","id":"force","actor":null,"createdAt":"2026-11-07T00:00:00Z","beforeCommit":null,"afterCommit":{"oid":"abcdef123"}}));
        nodes.push(json!({"__typename":"PullRequestReview","id":"draft","state":"PENDING"}));
        nodes.push(Value::Null);
        nodes.push(json!({"__typename":"FutureEvent","id":"future"}));
        let result = parse(&value).unwrap();
        assert_eq!(result.activity.len(), 12);
        let force = result.activity.last().unwrap();
        assert_eq!(force.kind, "force_push");
        assert_eq!(force.author, "Deleted user");
        assert_eq!(force.before, None);
        assert_eq!(force.after.as_deref(), Some("abcdef123"));
    }

    #[test]
    fn two_hundred_items_and_threads_are_paginated_without_duplicate_sections() {
        let mut first = fixture();
        let mut second = fixture();
        let sample = first["data"]["repository"]["pullRequest"]["timelineItems"]["nodes"][0].clone();
        for (page, start) in [(&mut first, 0), (&mut second, 100)] {
            let pr = &mut page["data"]["repository"]["pullRequest"];
            pr["timelineItems"]["nodes"] = (start..start + 100).map(|i| { let mut item = sample.clone(); item["id"] = json!(format!("item-{i}")); item }).collect();
            pr["reviewThreads"]["nodes"] = (start..start + 100).map(|i| json!({"id":format!("thread-{i}"),"isResolved":i % 2 == 0})).collect();
            for field in ["timelineItems", "reviewThreads"] {
                pr[field]["pageInfo"] = json!({"hasNextPage": start == 0, "endCursor": if start == 0 { "next" } else { "end" }});
            }
        }
        let mut calls = 0;
        let result = read_with(&target(), |args| {
            calls += 1;
            if calls == 1 { Ok(first.to_string()) } else {
                assert!(args.contains(&"timeline=next"));
                assert!(args.contains(&"threads=next"));
                assert!(args.contains(&"readReviews=false"));
                assert!(args.contains(&"readRequests=false"));
                Ok(second.to_string())
            }
        }).unwrap();
        assert_eq!(calls, 2);
        assert_eq!(result.activity.len(), 200);
        assert_eq!(result.unresolved_threads, 100);
        assert!(result.reviewers.is_empty());
    }

    #[test]
    fn partial_errors_missing_pages_and_wrong_identity_are_not_success() {
        assert!(read_with(&target(), |_| Ok(json!({"errors":[{"message":"Forbidden"}],"data":fixture()["data"]}).to_string())).unwrap_err().to_string().contains("Forbidden"));
        let mut missing = fixture();
        missing["data"]["repository"]["pullRequest"]["reviewThreads"] = Value::Null;
        assert!(read_with(&target(), |_| Ok(missing.to_string())).is_err());
        let mut repeated = fixture();
        repeated["data"]["repository"]["pullRequest"]["timelineItems"]["pageInfo"] = json!({"hasNextPage":true,"endCursor":"same"});
        assert!(read_with(&target(), |_| Ok(repeated.to_string())).unwrap_err().to_string().contains("repeated"));
        assert!(read_with(&Target::new("https://github.com/other/repo/pull/799").unwrap(), |_| Ok(RECORDED.into())).is_err());
    }

    #[test]
    fn edits_approvals_and_reviewer_actions_are_literal_and_host_scoped() {
        let target = Target::new("https://git.example.com/owner/repo/pull/42").unwrap();
        let mut calls = Vec::new();
        let mut run = |args: &[&str]| {
            calls.push(args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>());
            Ok(if args.starts_with(&["pr", "view"]) { json!({"title":"Before","body":"Original"}).to_string() }
                else if args.last() == Some(&"user") { json!({"type":"User","login":"ada"}).to_string() }
                else { String::new() })
        };
        act_with(&target, Action::Edit { title: " A title ".into(), body: "$(secret)\n`literal`".into(), expected_title: "Before".into(), expected_body: "Original".into() }, &mut run).unwrap();
        act_with(&target, Action::Approve { viewer: "ada".into() }, &mut run).unwrap();
        act_with(&target, Action::Request { login: "ada".into(), team: false }, &mut run).unwrap();
        act_with(&target, Action::Remove { login: "OWNER/core".into(), team: true }, &mut run).unwrap();
        assert_eq!(calls[0], ["pr", "view", &target.url, "--json", "title,body"]);
        assert_eq!(calls[1], ["pr", "edit", &target.url, "--title", "A title", "--body", "$(secret)\n`literal`"]);
        assert_eq!(calls[2], ["api", "--hostname", "git.example.com", "user"]);
        assert_eq!(calls[3], ["pr", "review", &target.url, "--approve"]);
        assert_eq!(calls[4], ["api", "--hostname", "git.example.com", "--method", "POST", "repos/owner/repo/pulls/42/requested_reviewers", "-f", "reviewers[]=ada"]);
        assert_eq!(calls[5].last().unwrap(), "team_reviewers[]=core");
        assert!(calls[5].iter().any(|arg| arg == "DELETE"));
        for login in ["--admin", "a/b", "a?b", "", "$(bad)"] {
            assert!(act_with(&target, Action::Request { login: login.into(), team: false }, |_| panic!("invalid request ran")).is_err());
        }
        assert!(act_with(&target, Action::Remove { login: "other/core".into(), team: true }, |_| panic!("wrong org ran")).is_err());
        for url in ["https://github.com/a/b/pull/0", "https://u:p@github.com/a/b/pull/1", "https://github.com/a%2fb/c/pull/1", "https://github.com/a/b/pull/1?x=1"] {
            assert!(Target::new(url).is_err(), "{url}");
        }
    }

    #[test]
    fn approval_requires_the_confirmed_personal_account() {
        for account in [json!({"type":"Bot","login":"app"}), json!({"type":"User","login":"app[bot]"}), json!({"type":"User","login":"someone-else"}), json!({})] {
            let mut calls = 0;
            let error = act_with(&target(), Action::Approve { viewer: "reviewer".into() }, |args| {
                calls += 1;
                assert_eq!(args, ["api", "--hostname", "github.com", "user"]);
                Ok(account.to_string())
            }).unwrap_err();
            assert!(error.to_string().contains("personal GitHub account"));
            assert_eq!(calls, 1);
        }
    }

    #[test]
    fn editing_refuses_a_concurrent_change_without_writing() {
        for current in [json!({"title":"Changed","body":"Original"}), json!({"title":"Before","body":"Changed"}), json!({})] {
            let mut calls = 0;
            let error = act_with(&target(), Action::Edit { title: "New".into(), body: "Draft".into(), expected_title: "Before".into(), expected_body: "Original".into() }, |args| {
                calls += 1;
                assert!(args.starts_with(&["pr", "view"]));
                Ok(current.to_string())
            }).unwrap_err();
            assert!(error.to_string().contains("changed on GitHub"));
            assert_eq!(calls, 1);
        }
    }

    #[test]
    fn reviewer_names_with_underscores_are_literal() {
        let login = "mona-cat_acme";
        for action in [Action::Request { login: login.into(), team: false }, Action::Remove { login: login.into(), team: false }] {
            act_with(&target(), action, |args| {
                assert_eq!(args.last(), Some(&"reviewers[]=mona-cat_acme"));
                Ok(String::new())
            }).unwrap();
        }
        act_with(&target(), Action::Remove { login: "acme/release_core".into(), team: true }, |args| {
            assert_eq!(args.last(), Some(&"team_reviewers[]=release_core"));
            Ok(String::new())
        }).unwrap();
    }

    #[test]
    fn user_search_is_bounded_and_encoded_by_gh() {
        let users = search_with(&target(), "ad & q=other", |args| {
            assert!(args.contains(&"search=ad & q=other"));
            assert!(args.contains(&"owner=acme"));
            assert!(args.contains(&"name=widgets"));
            assert!(args.iter().any(|arg| arg.contains("assignableUsers(first: 10")));
            Ok(json!({"data":{"repository":{"assignableUsers":{"nodes":[{"login":"ada"},{"login":"adam"}]}}}}).to_string())
        }).unwrap();
        assert_eq!(users, ["ada", "adam"]);
        assert!(search_with(&target(), "a", |_| panic!("short search ran")).unwrap().is_empty());
    }
}
