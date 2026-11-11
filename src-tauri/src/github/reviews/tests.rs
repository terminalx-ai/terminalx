use super::*;
use serde_json::json;

// Recorded read-only from cli/cli#14920, 2026-11-07; prose/code redacted.
// Additional pages and mutation
// outcomes below are deterministic variants; no test authenticates to GitHub.
const RECORDING: &str = include_str!("../../fixtures/github_review_threads.json");
const URL: &str = "https://github.com/cli/cli/pull/14920";

#[test]
fn recorded_threads_keep_github_coordinates_and_deleted_authors() {
    let mut recording: Value = serde_json::from_str(RECORDING).unwrap();
    recording["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][0]["comments"]["nodes"][0]["author"] = Value::Null;
    let result = list_with(URL, &mut |args| {
        assert_eq!(&args[..4], &["api", "graphql", "--hostname", "github.com"]);
        assert!(args.contains(&"owner=cli"));
        assert!(args.contains(&"name=cli"));
        Ok(recording.to_string())
    }).unwrap();
    assert_eq!(result.threads.len(), 7);
    let raw = &recording["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"][0];
    assert_eq!(result.threads[0].line.map(u64::from), raw["line"].as_u64());
    assert_eq!(result.threads[0].original_line.map(u64::from), raw["originalLine"].as_u64());
    assert!(result.threads[0].comments[0].author.is_none());
}

#[test]
fn paginates_threads_and_each_threads_comments() {
    let mut page: Value = serde_json::from_str(RECORDING).unwrap();
    let connection = &mut page["data"]["repository"]["pullRequest"]["reviewThreads"];
    connection["nodes"].as_array_mut().unwrap().truncate(1);
    let mut next = connection["nodes"][0]["comments"]["nodes"][0].clone();
    next["id"] = json!("reply-on-second-page");
    connection["nodes"][0]["comments"]["pageInfo"] = json!({"hasNextPage":true,"endCursor":"comments-next"});
    connection["pageInfo"] = json!({"hasNextPage":true,"endCursor":"threads-next"});
    let mut last = page.clone();
    last["data"]["repository"]["pullRequest"]["reviewThreads"] = json!({"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}});
    let mut calls = 0;
    let result = list_with(URL, &mut |args| {
        calls += 1;
        Ok(match calls {
            1 => page.to_string(),
            2 => {
                assert!(args.contains(&"cursor=comments-next"));
                json!({"data":{"node":{"comments":{"nodes":[next],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}).to_string()
            }
            3 => { assert!(args.contains(&"cursor=threads-next")); last.to_string() }
            _ => panic!("unexpected retry"),
        })
    }).unwrap();
    assert_eq!(calls, 3);
    assert_eq!(result.threads.last().unwrap().comments.last().unwrap().id, "reply-on-second-page");
}

#[test]
fn rejects_graphql_errors_missing_pages_and_moving_head() {
    for response in [json!({"errors":[{"message":"Not authorized"}],"data":{}}), json!({"data":{"repository":null}})] {
        assert!(list_with(URL, &mut |_| Ok(response.to_string())).is_err());
    }
    let mut page: Value = serde_json::from_str(RECORDING).unwrap();
    page["data"]["repository"]["pullRequest"]["reviewThreads"]["pageInfo"] = json!({"hasNextPage":true,"endCursor":"next"});
    let mut calls = 0;
    let error = list_with(URL, &mut |_| {
        calls += 1;
        if calls == 2 { page["data"]["repository"]["pullRequest"]["headRefOid"] = json!("another-push"); }
        Ok(page.to_string())
    }).unwrap_err();
    assert!(error.to_string().contains("changed"));
    let mut seen = HashSet::new();
    let connection = json!({"pageInfo":{"hasNextPage":true,"endCursor":"same"}});
    assert!(next_cursor(&connection, &mut seen).unwrap().is_some());
    assert!(next_cursor(&connection, &mut seen).is_err());
    assert!(next_cursor(&json!({"pageInfo":{"hasNextPage":true}}), &mut seen).is_err());
}

fn owner(url: &str) -> Value { json!({"data":{"node":{"id":"thread-id","pullRequest":{"url":url}}}}) }

#[test]
fn mutations_are_scoped_to_pr_and_confirm_their_result() {
    for resolved in [true, false] {
        let mut calls = 0;
        resolve_with(URL, "thread-id", resolved, &mut |args| {
            calls += 1;
            if calls == 1 { return Ok(owner(URL).to_string()); }
            let name = if resolved { "resolveReviewThread" } else { "unresolveReviewThread" };
            assert!(args.iter().any(|arg| arg.starts_with("query=mutation") && arg.contains(name)));
            Ok(json!({"data":{name:{"thread":{"id":"thread-id","isResolved":resolved}}}}).to_string())
        }).unwrap();
        assert_eq!(calls, 2);
    }
    let mut calls = 0;
    assert!(resolve_with(URL, "thread-id", true, &mut |_| {
        calls += 1;
        Ok(owner("https://github.com/other/repo/pull/14920").to_string())
    }).is_err());
    assert_eq!(calls, 1);
}

#[test]
fn replies_are_literal_variables_and_never_retried() {
    let body = "@/etc/passwd\n$(echo nope) `code` \"quoted\"";
    let mut calls = 0;
    reply_with(URL, "thread-id", body, &mut |args| {
        calls += 1;
        if calls == 1 { return Ok(owner(URL).to_string()); }
        assert!(args.windows(2).any(|pair| pair == ["-f", &format!("body={body}")]));
        assert!(!args.contains(&"-F"));
        Ok(json!({"data":{"addPullRequestReviewThreadReply":{"comment":{"id":"reply"}}}}).to_string())
    }).unwrap();
    assert_eq!(calls, 2);
    calls = 0;
    assert!(reply_with(URL, "thread-id", body, &mut |_| {
        calls += 1;
        if calls == 1 { Ok(owner(URL).to_string()) } else { bail!("connection lost") }
    }).is_err());
    assert_eq!(calls, 2);
    assert!(reply_with(URL, "thread-id", " \n", &mut |_| panic!("empty reply must not reach GitHub")).is_err());
}

#[test]
fn enterprise_host_is_explicit_and_bad_urls_are_rejected() {
    let target = Target::new("https://github.example/Team/Repo/pull/42").unwrap();
    assert_eq!(target.host, "github.example");
    assert_eq!(target.owner, "team");
    for url in ["http://github.com/a/b/pull/1", "https://github.com/a/b/pull/1?x=1", "https://github.com/a/b%2Fc/pull/1"] {
        assert!(Target::new(url).is_err());
    }
}

#[test]
fn pr_patches_are_paginated_and_match_both_snapshot_revisions() {
    let state = json!({"url":URL,"headRefOid":"head-3","baseRefOid":"base"});
    let mut calls = 0;
    let files = files_with(URL, "head-3", "base", &mut |args| {
        calls += 1;
        if calls != 2 { return Ok(state.to_string()); }
        assert!(args.contains(&"--paginate") && args.contains(&"--slurp"));
        assert!(args.contains(&"repos/cli/cli/pulls/14920/files?per_page=100"));
        Ok(json!([[{"filename":"other.ts"}],[{"filename":"new.ts","previous_filename":"old.ts","patch":"@@ -1 +1 @@\n-old\n+new"}]]).to_string())
    }).unwrap();
    assert_eq!(calls, 3);
    assert_eq!(files.len(), 2);
    let file = &files[1];
    assert_eq!(file.path, "new.ts");
    assert_eq!(file.old_path.as_deref(), Some("old.ts"));
    assert!(file.patch.is_some());
    calls = 0;
    let error = files_with(URL, "head-3", "base", &mut |_| {
        calls += 1;
        Ok(match calls {
            1 => state.to_string(),
            2 => "[[]]".into(),
            _ => json!({"url":URL,"headRefOid":"head-4","baseRefOid":"base"}).to_string(),
        })
    }).unwrap_err();
    assert!(error.to_string().contains("changed"));
}

#[test]
fn missing_files_are_distinct_from_binary_files() {
    for files in [json!([[]]), json!([[{"filename":"binary.png"}]])] {
        let result = files_with(URL, "head", "base", &mut |args| {
            Ok(if args[0] == "api" { files.to_string() } else { json!({"url":URL,"headRefOid":"head","baseRefOid":"base"}).to_string() })
        }).unwrap();
        assert_eq!(result.len(), files[0].as_array().unwrap().len());
        assert!(result.iter().all(|file| file.patch.is_none()));
    }
}
