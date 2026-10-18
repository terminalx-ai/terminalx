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
}
