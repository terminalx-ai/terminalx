//! The model list per harness, one source for ids, labels, efforts and
//! defaults. Ids are the aliases the CLI accepts, so sessions follow the
//! latest model of a family.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub label: String,
    pub harness: String,
    pub efforts: Vec<String>,
    pub default_effort: Option<String>,
    pub accepts_images: bool,
    pub is_default: bool,
}

fn m(harness: &str, id: &str, label: &str, efforts: &[&str], default_effort: Option<&str>, is_default: bool) -> Model {
    Model {
        id: id.into(),
        label: label.into(),
        harness: harness.into(),
        efforts: efforts.iter().map(|e| e.to_string()).collect(),
        default_effort: default_effort.map(String::from),
        accepts_images: true,
        is_default,
    }
}

pub fn catalog() -> Vec<Model> {
    let claude_efforts = ["low", "medium", "high", "xhigh", "max"];
    let codex_efforts = ["low", "medium", "high", "xhigh"];
    vec![
        m("claude", "fable", "Fable 5.1", &claude_efforts, Some("high"), false),
        m("claude", "opus", "Opus 5", &claude_efforts, Some("high"), true),
        m("claude", "sonnet", "Sonnet 5", &claude_efforts, Some("high"), false),
        m("claude", "haiku", "Haiku 4.5", &[], None, false),
        m("codex", "gpt-5.6", "GPT-5.6", &codex_efforts, Some("medium"), true),
        m("codex", "gpt-5.6-codex", "GPT-5.6 Codex", &codex_efforts, Some("medium"), false),
        m("codex", "gpt-5.5", "GPT-5.5", &codex_efforts, Some("medium"), false),
        m("cursor", "auto", "Auto", &[], None, true),
        m("opencode", "", "Default", &[], None, true),
    ]
}

#[allow(dead_code)]
pub fn default_for(harness: &str) -> Option<Model> {
    catalog().into_iter().find(|x| x.harness == harness && x.is_default)
}
