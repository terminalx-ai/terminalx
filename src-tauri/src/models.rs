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

/// Every model we know statically, hidden harnesses included. Codex is absent
/// by design.
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

/// The list the pickers see: Claude's statics first, the models this account
/// can actually run on Codex spliced in after them, then whatever else is
/// static — minus the harnesses the UI does not offer, which is decided in
/// one place (`harness::HIDDEN_HARNESSES`) rather than by leaving them out of
/// the catalogue. A tab already on a hidden harness keeps its stored model id;
/// the pickers just have nothing to offer it.
pub fn offered(codex: Vec<Model>) -> Vec<Model> {
    let statics = catalog();
    let mut out: Vec<Model> = statics.iter().filter(|m| m.harness == "claude").cloned().collect();
    out.extend(codex);
    out.extend(statics.into_iter().filter(|m| m.harness != "claude"));
    out.retain(|m| crate::harness::visible(&m.harness));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pickers_are_not_offered_a_hidden_harness() {
        let hidden = crate::harness::HIDDEN_HARNESSES;
        // The catalogue still carries them, so unhiding is one line.
        for h in hidden {
            assert!(catalog().iter().any(|m| &m.harness == h), "{h} models should still be in the catalog");
        }
        let offered = offered(vec![m("codex", "gpt-5.6-codex", "GPT-5.6 Codex", &[], None, true)]);
        assert!(offered.iter().all(|m| !hidden.contains(&m.harness.as_str())));
        // Claude first, then the account's Codex models.
        assert_eq!(offered.first().map(|m| m.harness.as_str()), Some("claude"));
        assert_eq!(offered.last().map(|m| m.harness.as_str()), Some("codex"));
    }
}
