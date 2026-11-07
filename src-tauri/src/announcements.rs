//! Public, version-targeted release information. No account token or device identifier is sent.
use std::io::Read;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Announcement {
    id: String,
    title: String,
    body: String,
    link: String,
    is_new: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    required_flag: Option<String>,
}

fn endpoint(base: &str, version: &str) -> Result<url::Url> {
    anyhow::ensure!(!version.is_empty() && version.len() <= 128, "invalid app version");
    let mut url = url::Url::parse(base)?.join("/announcements/current")?;
    url.query_pairs_mut().append_pair("appVersion", version);
    Ok(url)
}

pub fn current(version: &str) -> Result<Option<Announcement>> {
    let url = endpoint(&crate::account::api_base_url(), version)?;
    // Use the existing policy-aware transport (PRO-244), never a second HTTP client.
    let response = crate::account::cloud_agent().get(url.as_str()).call()?;
    let mut body = String::new();
    response.into_reader().take(16_385).read_to_string(&mut body)?;
    anyhow::ensure!(body.len() <= 16_384, "announcement response too large");
    serde_json::from_str(&body).context("invalid announcement response")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_encoded_as_one_public_query_parameter() {
        let url = endpoint("https://login.terminalx.ai", "0.2.25-beta.1+build&x=1").unwrap();
        assert_eq!(url.path(), "/announcements/current");
        assert_eq!(url.query_pairs().collect::<Vec<_>>(), vec![("appVersion".into(), "0.2.25-beta.1+build&x=1".into())]);
        assert!(endpoint("https://login.terminalx.ai", "").is_err());
        assert!(endpoint("https://login.terminalx.ai", &"1".repeat(129)).is_err());
    }

    #[test]
    fn public_contract_allows_no_announcement_and_optional_rollout_flag() {
        assert!(serde_json::from_str::<Option<Announcement>>("null").unwrap().is_none());
        let item: Announcement = serde_json::from_str(r#"{"id":"release","title":"Title","body":"Body","link":"https://terminalx.ai","isNew":true,"requiredFlag":"team.events.v1"}"#).unwrap();
        assert_eq!(item.required_flag.as_deref(), Some("team.events.v1"));
        assert_eq!(serde_json::to_value(item).unwrap()["isNew"], true);
    }
}
