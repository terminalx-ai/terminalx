//! The model list per harness, one source for ids, labels, efforts and
//! defaults. Ids are the aliases the CLI accepts, so sessions follow the
//! latest model of a family.
//!
//! Codex is the exception: which models a ChatGPT account may run is decided
//! by the account, not by us, so those come from the CLI itself (see
//! `harness::codex::models`) and are spliced in by the `list_models` command.

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
    /// The model that replaces this one, when the provider says it is being
    /// retired. Still offered, but marked as on its way out.
    pub upgrade: Option<String>,
    /// The provider's own one-line description, when it gives one.
    pub description: Option<String>,
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
        upgrade: None,
        description: None,
    }
}

/// Every model we know statically. Codex is absent by design.
pub fn catalog() -> Vec<Model> {
    let claude_efforts = ["low", "medium", "high", "xhigh", "max"];
    vec![
        m("claude", "fable", "Fable 5.1", &claude_efforts, Some("high"), false),
        m("claude", "opus", "Opus 5", &claude_efforts, Some("high"), true),
        m("claude", "sonnet", "Sonnet 5", &claude_efforts, Some("high"), false),
        m("claude", "haiku", "Haiku 4.5", &[], None, false),
        m("cursor", "auto", "Auto", &[], None, true),
        m("cursor", "sonnet-4.5", "Sonnet 4.5", &[], None, false),
        m("cursor", "sonnet-4.5-thinking", "Sonnet 4.5 Thinking", &[], None, false),
        m("cursor", "opus-4.5", "Opus 4.5", &[], None, false),
        m("cursor", "gpt-5", "GPT-5", &[], None, false),
        m("opencode", "", "Default", &[], None, true),
        m("opencode", "anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5", &[], None, false),
        m("opencode", "anthropic/claude-opus-4-5", "Claude Opus 4.5", &[], None, false),
        m("opencode", "openai/gpt-5", "GPT-5", &[], None, false),
    ]
}
