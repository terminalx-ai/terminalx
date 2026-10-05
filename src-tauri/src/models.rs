//! The model list per harness, one source for ids, labels, efforts and
//! defaults.
//!
//! Claude and Codex are read from their CLIs: which models an account may
//! run, and what a family alias like `opus` runs today, is decided there and
//! not by us (see `harness::claude::models` and `harness::codex::models`).
//! Both are spliced in by the `list_models` command. The Claude entries here
//! are only what is offered when the CLI cannot be asked.

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
    /// A family alias (`opus`): a session on it follows the latest release
    /// instead of staying on one version.
    #[serde(default)]
    pub alias: bool,
    /// The full model id an alias runs now, as the CLI on this machine
    /// reports it. `None` for a pinned version, and for an alias when the CLI
    /// could not be asked: we do not guess.
    #[serde(default)]
    pub resolved: Option<String>,
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
        alias: false,
        resolved: None,
    }
}

/// What each Claude alias ran when this list was written, read from the CLI
/// itself (claude 2.1.288) rather than assumed. Used only when the CLI cannot
/// be asked: the versions are offered pinned under their own ids, which stay
/// true whatever the aliases move to, and the aliases are offered without a
/// version. A new release means changing the id here and adding its price in
/// `stats::pricing`; tests fail until both are done.
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

/// `opus` → `Opus`: how a family alias reads. The version it runs is kept
/// apart, in `resolved`.
pub fn family_label(alias: &str) -> String {
    let mut name = alias.to_string();
    if let Some(first) = name.get_mut(..1) {
        first.make_ascii_uppercase();
    }
    name
}

/// The Claude models to offer when the CLI cannot be asked: each alias with no
/// claim about what it runs, then the versions known when this was written,
/// pinned.
pub fn claude_fallback() -> Vec<Model> {
    let full = ["low", "medium", "high", "xhigh", "max"];
    let efforts = |alias: &str| -> (&[&str], Option<&str>) {
        if alias == "haiku" {
            (&[], None)
        } else {
            (&full, Some("high"))
        }
    };
    let mut out: Vec<Model> = CLAUDE_ALIASES
        .iter()
        .map(|(alias, _)| {
            let (efforts, default_effort) = efforts(alias);
            Model { alias: true, ..m("claude", alias, &family_label(alias), efforts, default_effort, *alias == "opus") }
        })
        .collect();
    out.extend(CLAUDE_ALIASES.iter().map(|(alias, runs)| {
        let (efforts, default_effort) = efforts(alias);
        m("claude", runs, &claude_label(runs).unwrap_or_else(|| runs.to_string()), efforts, default_effort, false)
    }));
    out
}

/// Every model we know statically, hidden harnesses included. Codex is absent
/// by design.
pub fn catalog() -> Vec<Model> {
    let mut out = claude_fallback();
    out.extend([
        m("cursor", "auto", "Auto", &[], None, true),
        m("cursor", "sonnet-4.5", "Sonnet 4.5", &[], None, false),
        m("cursor", "sonnet-4.5-thinking", "Sonnet 4.5 Thinking", &[], None, false),
        m("cursor", "opus-4.5", "Opus 4.5", &[], None, false),
        m("cursor", "gpt-5", "GPT-5", &[], None, false),
        m("opencode", "", "Default", &[], None, true),
        m("opencode", "anthropic/claude-sonnet-4-5", "Claude Sonnet 4.5", &[], None, false),
        m("opencode", "anthropic/claude-opus-4-5", "Claude Opus 4.5", &[], None, false),
        m("opencode", "openai/gpt-5", "GPT-5", &[], None, false),
    ]);
    out
}

/// The list the pickers see: Claude's models first, then the models this
/// account can actually run on Codex, then whatever else is static — minus the
/// harnesses the UI does not offer, which is decided in one place
/// (`harness::HIDDEN_HARNESSES`) rather than by leaving them out of the
/// catalogue. A tab already on a hidden harness keeps its stored model id; the
/// pickers just have nothing to offer it.
pub fn offered(claude: Vec<Model>, codex: Vec<Model>) -> Vec<Model> {
    let mut out = if claude.is_empty() { claude_fallback() } else { claude };
    out.extend(codex);
    out.extend(catalog().into_iter().filter(|m| m.harness != "claude"));
    out.retain(|m| crate::harness::visible(&m.harness));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_built_in_claude_list_offers_each_alias_and_each_version_pinned() {
        let claude = claude_fallback();
        let (aliases, pinned): (Vec<&Model>, Vec<&Model>) = claude.iter().partition(|m| m.alias);
        // The ids stored on existing tabs are still offered.
        assert_eq!(aliases.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["fable", "opus", "sonnet", "haiku"]);
        assert_eq!(aliases.iter().map(|m| m.label.as_str()).collect::<Vec<_>>(), vec!["Fable", "Opus", "Sonnet", "Haiku"]);
        // Without the CLI, an alias makes no claim about its version.
        assert!(aliases.iter().all(|m| m.resolved.is_none()));
        assert_eq!(claude.iter().filter(|m| m.is_default).map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["opus"]);
        // Each pinned entry is named after its own id, so the two cannot disagree.
        for (model, (alias, runs)) in pinned.iter().zip(CLAUDE_ALIASES) {
            assert_eq!(model.id, *runs);
            assert_eq!(Some(model.label.clone()), claude_label(runs));
            assert!(runs.contains(alias), "{runs} is not a {alias} model");
        }
        // What the menu reads today. A release changes this line and the table together.
        assert_eq!(pinned.iter().map(|m| m.label.as_str()).collect::<Vec<_>>(), vec!["Fable 5.1", "Opus 5.5", "Sonnet 5.5", "Haiku 4.5"]);
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
        let offered = offered(Vec::new(), vec![m("codex", "gpt-5.6-codex", "GPT-5.6 Codex", &[], None, true)]);
        assert!(offered.iter().all(|m| !hidden.contains(&m.harness.as_str())));
        // Claude first, then the account's Codex models.
        assert_eq!(offered.first().map(|m| m.harness.as_str()), Some("claude"));
        assert_eq!(offered.last().map(|m| m.harness.as_str()), Some("codex"));
    }
}
