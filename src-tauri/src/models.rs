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

/// What each Claude alias ran when this list was written, read from the CLI
/// itself (claude 2.1.288) rather than assumed. The alias is what we store and
/// pass to `--model`, so a session follows the family; the label in `catalog`
/// is read off the version below, so the two cannot drift apart. A new release
/// means changing the id here and adding its price in `stats::pricing`; tests
/// fail until both are done.
pub const CLAUDE_ALIASES: &[(&str, &str)] = &[
    ("fable", "claude-fable-5-1"),
    ("opus", "claude-opus-5-5"),
    ("sonnet", "claude-sonnet-5-5"),
    ("haiku", "claude-haiku-4-5-20251001"),
];

/// `claude-opus-5-5` → `Opus 5.5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`:
/// how a full Claude model id reads in a menu. `None` for anything that is not
/// shaped like one.
pub fn claude_label(id: &str) -> Option<String> {
    let mut parts = id.strip_prefix("claude-")?.split('-');
    let family = parts.next().filter(|f| !f.is_empty() && f.chars().all(|c| c.is_ascii_alphabetic()))?;
    // A date stamp is not part of the version.
    let version: Vec<&str> = parts.take_while(|p| p.len() <= 2 && p.chars().all(|c| c.is_ascii_digit())).collect();
    if version.is_empty() {
        return None;
    }
    let mut name = family.to_string();
    name[..1].make_ascii_uppercase();
    Some(format!("{name} {}", version.join(".")))
}

/// Every model we know statically, hidden harnesses included. Codex is absent
/// by design.
pub fn catalog() -> Vec<Model> {
    let claude_efforts = ["low", "medium", "high", "xhigh", "max"];
    let claude = |alias: &str, efforts: &[&str], default_effort: Option<&str>, is_default: bool| {
        let runs = CLAUDE_ALIASES.iter().find(|(a, _)| *a == alias).map(|(_, id)| *id).unwrap_or(alias);
        let label = claude_label(runs).unwrap_or_else(|| alias.to_string());
        m("claude", alias, &label, efforts, default_effort, is_default)
    };
    vec![
        claude("fable", &claude_efforts, Some("high"), false),
        claude("opus", &claude_efforts, Some("high"), true),
        claude("sonnet", &claude_efforts, Some("high"), false),
        claude("haiku", &[], None, false),
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
    fn every_claude_label_names_the_version_its_alias_runs() {
        let claude: Vec<Model> = catalog().into_iter().filter(|m| m.harness == "claude").collect();
        // The picker and the alias table list the same models, in the same order.
        let offered: Vec<&str> = claude.iter().map(|m| m.id.as_str()).collect();
        let aliases: Vec<&str> = CLAUDE_ALIASES.iter().map(|(alias, _)| *alias).collect();
        assert_eq!(offered, aliases);
        for (model, (alias, runs)) in claude.iter().zip(CLAUDE_ALIASES) {
            assert_eq!(Some(model.label.clone()), claude_label(runs), "the label for `{alias}` should name {runs}");
            // The id stays the alias: tabs stored with it keep working.
            assert!(runs.contains(alias), "{runs} is not a {alias} model");
        }
        // What the menu reads today. A release changes this line and the table together.
        assert_eq!(claude.iter().map(|m| m.label.as_str()).collect::<Vec<_>>(), vec!["Fable 5.1", "Opus 5.5", "Sonnet 5.5", "Haiku 4.5"]);
    }

    #[test]
    fn a_full_claude_id_reads_as_family_and_version() {
        assert_eq!(claude_label("claude-opus-5-5").as_deref(), Some("Opus 5.5"));
        assert_eq!(claude_label("claude-opus-5").as_deref(), Some("Opus 5"));
        assert_eq!(claude_label("claude-haiku-4-5-20251001").as_deref(), Some("Haiku 4.5"));
        assert_eq!(claude_label("opus"), None);
        assert_eq!(claude_label("gpt-5.6-sol"), None);
    }

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
