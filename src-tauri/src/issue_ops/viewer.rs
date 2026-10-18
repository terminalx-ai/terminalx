//! Who the reader is to the provider: the `gh` login on GitHub, the API key's
//! owner on Linear. "Assign to me" names them, and the "Assigned to me" list
//! tells by them which rows are still the reader's.

use std::path::Path;

use serde_json::{json, Value};

use super::{IssueOpError, IssueOpErrorKind, IssueUser, OpResult, Provider, Target};

pub fn viewer(target: &Target) -> OpResult<IssueUser> {
    match target {
        Target::Github { cwd, .. } => github(cwd),
        Target::Linear { key } => linear(key),
    }
}

fn github(cwd: &Path) -> OpResult<IssueUser> {
    parse_github(&super::github::gh_api(cwd, "GET", "user", None)?).ok_or_else(|| IssueOpError::new(IssueOpErrorKind::Other, Provider::Github))
}

fn linear(key: &str) -> OpResult<IssueUser> {
    let data = super::linear::request(key, "query { viewer { id name displayName avatarUrl } }", json!({}))?;
    parse_linear(&data["viewer"]).ok_or_else(|| IssueOpError::new(IssueOpErrorKind::Other, Provider::Linear))
}

/// `GET /user`.
pub fn parse_github(v: &Value) -> Option<IssueUser> {
    let login = v["login"].as_str()?;
    Some(IssueUser {
        id: login.into(),
        name: v["name"].as_str().filter(|name| !name.is_empty()).unwrap_or(login).into(),
        login: Some(login.into()),
        avatar_url: v["avatar_url"].as_str().map(String::from),
    })
}

/// `query { viewer { … } }`, at `data.viewer`.
pub fn parse_linear(v: &Value) -> Option<IssueUser> {
    let id = v["id"].as_str()?;
    Some(IssueUser {
        id: id.into(),
        name: v["displayName"].as_str().or_else(|| v["name"].as_str()).unwrap_or("").into(),
        login: None,
        avatar_url: v["avatarUrl"].as_str().map(String::from),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_viewer_is_named_the_way_set_assignees_takes_them() {
        let github = parse_github(&json!({"login": "sam", "name": "", "avatar_url": "https://avatars.githubusercontent.com/u/12?v=4", "id": 12})).unwrap();
        assert_eq!((github.id.as_str(), github.name.as_str(), github.login.as_deref()), ("sam", "sam", Some("sam")));
        assert_eq!(parse_github(&json!({"message": "Bad credentials"})), None);
        let linear = parse_linear(&json!({"id": "user-sam", "name": "sam", "displayName": "Sam", "avatarUrl": null})).unwrap();
        assert_eq!(linear, IssueUser { id: "user-sam".into(), name: "Sam".into(), login: None, avatar_url: None });
        assert_eq!(parse_linear(&Value::Null), None);
    }

    /// Live, opt-in (`TERMINALX_LIVE_ISSUE_SANDBOX=1 cargo test live_assignee -- --ignored --nocapture`):
    /// what the assignee picker asks of the real `gh` login and Linear key,
    /// on the two sandbox issues only and with nobody but the reader. Each
    /// write is read back through the list's own path (`gh issue view`, the
    /// list's Linear query), and the sandbox is left with the assignees it had.
    #[test]
    #[ignore]
    fn live_assignee_picker_on_the_sandbox_issues() {
        use crate::issue_ops::{details, options, set_assignees};
        if std::env::var("TERMINALX_LIVE_ISSUE_SANDBOX").as_deref() != Ok("1") {
            return;
        }
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        for (provider, id) in [(Provider::Github, "527"), (Provider::Linear, "PRO-101")] {
            let target = Target::resolve(&repo, provider).unwrap();
            let before = details(&target, id).unwrap();
            assert!(before.issue.title.starts_with("[TerminalX test]"), "only the sandbox issue");
            let me = viewer(&target).unwrap();
            let had: Vec<String> = before.issue.assignees.iter().map(|user| user.id.clone()).collect();
            assert!(had.iter().all(|user| *user == me.id), "the sandbox holds someone other than the reader; leaving it alone");
            println!("{provider:?} {}: viewer {:?}, assigned before: {}", before.issue.identifier, me.name, had.len());

            let offered = options(&target, Some(id), None, true).unwrap();
            assert!(offered.members.iter().any(|user| user.id == me.id), "the reader is offered");
            if provider == Provider::Github {
                assert!(!offered.members.iter().any(|user| user.id.eq_ignore_ascii_case("octocat")), "someone without access is not offered");
            }
            println!("{provider:?} options: {} people offered, the reader among them; capabilities {:?}", offered.members.len(), offered.capabilities);

            // What the list reads, separately from the operation's own answer.
            let listed = || -> Vec<String> {
                match &target {
                    Target::Github { cwd, .. } => crate::issues::github_details(cwd, id).unwrap().assignees,
                    Target::Linear { key } => crate::issues::linear_details(key, id).unwrap().assignees,
                }
                .into_iter()
                .map(|user| user.id)
                .collect()
            };
            let none = set_assignees(&target, id, &[]).unwrap();
            assert!(none.issue.assignees.is_empty());
            assert!(listed().is_empty());
            println!("{provider:?} unassign: answered 0 assignees; list read 0");
            let mine = set_assignees(&target, id, std::slice::from_ref(&me.id)).unwrap();
            assert_eq!(mine.issue.assignees.iter().map(|user| user.id.as_str()).collect::<Vec<_>>(), [me.id.as_str()]);
            assert_eq!(listed(), std::slice::from_ref(&me.id));
            println!("{provider:?} assign to me: answered [reader]; list read [reader]");
            // Reassigning to the same one person is a no-op write that still answers the issue.
            let again = set_assignees(&target, id, std::slice::from_ref(&me.id)).unwrap();
            assert_eq!(again.issue.assignees.len(), 1);
            println!("{provider:?} reassign (same person): answered 1 assignee");

            let restored = set_assignees(&target, id, &had).unwrap();
            assert_eq!(restored.issue.assignees.iter().map(|user| user.id.clone()).collect::<Vec<_>>(), had);
            println!("{provider:?} restored: {} assignee(s), as before", had.len());
        }
    }
}
