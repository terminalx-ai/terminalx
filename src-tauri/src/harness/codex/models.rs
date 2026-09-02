//! Which Codex models this account may actually run.
//!
//! The list is not ours to guess: it depends on the signed-in account, and
//! naming a model the account cannot use fails the turn outright with
//! `The '<id>' model is not supported when using Codex with a ChatGPT account`.
//! `codex app-server` answers `model/list` with the real set, so we ask it
//! through `appserver`, which runs a short-lived child and kills it as soon as
//! it has answered.
//!
//! The answer is cached for the life of the process (the account does not
//! change under us) and refreshed on demand when the model picker opens. Every
//! failure — no `codex` on PATH, a hung child, a shape we do not understand —
//! falls back to a built-in list rather than leaving the picker empty.

use std::sync::Mutex;

use anyhow::Result;
use serde_json::{json, Value};

use crate::models::Model;

/// The process-lifetime cache. One lives in `AppState` and is shared with the
/// session manager, so a tab starting and the picker opening agree on the list.
#[derive(Default)]
pub struct Cache {
    models: Mutex<Option<Vec<Model>>>,
}

impl Cache {
    /// The account's models, fetching once and then reusing the answer.
    /// `refresh` forces a fresh read. Never empty: a failure yields the
    /// built-in list, with the reason logged.
    pub fn get(&self, refresh: bool) -> Vec<Model> {
        if !refresh {
            let cached = self.models.lock().unwrap().clone();
            if let Some(models) = cached {
                return models;
            }
        }
        // The lock is not held across the fetch: it spawns a child and waits.
        let models = match fetch() {
            Ok(models) if !models.is_empty() => models,
            Ok(_) => {
                log::warn!("codex model/list named no usable models; using the built-in list");
                fallback()
            }
            Err(e) => {
                log::warn!("could not read the Codex model list ({e:#}); using the built-in list");
                fallback()
            }
        };
        *self.models.lock().unwrap() = Some(models.clone());
        models
    }

    /// The model to run instead of `wanted`, when `wanted` is not one this
    /// account has. `None` means `wanted` is fine (or empty, which lets Codex
    /// pick for itself).
    pub fn substitute_for(&self, wanted: &str) -> Option<Model> {
        if wanted.is_empty() {
            return None;
        }
        let models = self.get(false);
        if models.iter().any(|m| m.id == wanted) {
            return None;
        }
        models.iter().find(|m| m.is_default).or_else(|| models.first()).cloned()
    }
}

/// Ask a throwaway `codex app-server` for the list. The managed home is not
/// named: the list depends on the account, and the account is the one
/// `auth.json` names wherever Codex is run from.
fn fetch() -> Result<Vec<Model>> {
    Ok(parse(&super::appserver::ask(super::appserver::Where::default(), "model/list", json!({}))?))
}

/// A `model/list` result onto our own model shape. Hidden entries are the
/// CLI's own "do not offer this" flag, so they never reach the picker.
pub fn parse(result: &Value) -> Vec<Model> {
    let mut models: Vec<Model> = result["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| !m["hidden"].as_bool().unwrap_or(false))
        .filter_map(|m| {
            let id = m["id"].as_str().filter(|s| !s.is_empty())?.to_string();
            Some(Model {
                label: tidy_label(m["displayName"].as_str().unwrap_or(&id)),
                harness: "codex".into(),
                efforts: m["supportedReasoningEfforts"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|e| e["reasoningEffort"].as_str().or_else(|| e.as_str()).map(String::from))
                    .collect(),
                default_effort: m["defaultReasoningEffort"].as_str().map(String::from),
                accepts_images: m["inputModalities"].as_array().map(|a| a.iter().any(|x| x.as_str() == Some("image"))).unwrap_or(false),
                is_default: m["isDefault"].as_bool().unwrap_or(false),
                // A named replacement is how the CLI says "this one is going away".
                upgrade: m["upgrade"].as_str().filter(|s| !s.is_empty()).map(String::from),
                description: m["description"].as_str().filter(|s| !s.is_empty()).map(String::from),
                id,
            })
        })
        .collect();
    // Retiring models stay on the list — a session may still be on one — but
    // below the current ones. The sort is stable, so each group keeps the
    // CLI's own ordering.
    models.sort_by_key(|m| m.upgrade.is_some());
    models
}

/// `GPT-5.6-Sol` → `GPT-5.6 Sol`. The CLI hyphenates the variant onto the
/// version, which reads as one unbroken token in a menu; the hyphen inside the
/// version itself (`GPT-5.6`) has to stay.
pub fn tidy_label(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    chars
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let joins_a_word = *c == '-' && i > 0 && chars[i - 1].is_ascii_digit() && chars.get(i + 1).is_some_and(char::is_ascii_alphabetic);
            if joins_a_word {
                ' '
            } else {
                *c
            }
        })
        .collect()
}

/// What to offer when the CLI cannot be asked. Deliberately the models a
/// ChatGPT account could run when this was written — never a family alias like
/// `gpt-5.6`, which the API rejects outright.
pub fn fallback() -> Vec<Model> {
    let full = ["low", "medium", "high", "xhigh", "max"];
    let short = ["low", "medium", "high", "xhigh"];
    let m = |id: &str, label: &str, efforts: &[&str], default_effort: &str, is_default: bool| Model {
        id: id.into(),
        label: label.into(),
        harness: "codex".into(),
        efforts: efforts.iter().map(|e| e.to_string()).collect(),
        default_effort: Some(default_effort.into()),
        accepts_images: true,
        is_default,
        upgrade: None,
        description: None,
    };
    vec![
        m("gpt-5.6-sol", "GPT-5.6 Sol", &full, "low", true),
        m("gpt-5.6-terra", "GPT-5.6 Terra", &full, "medium", false),
        m("gpt-5.6-luna", "GPT-5.6 Luna", &full, "medium", false),
        m("gpt-5.5", "GPT-5.5", &short, "medium", false),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A verbatim `model/list` result from codex-cli 0.152.
    const CAPTURE: &str = include_str!("fixtures/model_list.json");

    fn captured() -> Vec<Model> {
        parse(&serde_json::from_str::<Value>(CAPTURE).unwrap())
    }

    #[test]
    fn maps_the_captured_list() {
        let models = captured();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        // Current models first, in the CLI's order; the two being retired last.
        assert_eq!(ids, vec!["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini"]);
        assert!(models.iter().all(|m| m.harness == "codex"));
    }

    #[test]
    fn sol_is_the_default_and_reaches_ultra() {
        let models = captured();
        let sol = models.iter().find(|m| m.id == "gpt-5.6-sol").unwrap();
        assert!(sol.is_default);
        assert!(models.iter().filter(|m| m.is_default).count() == 1);
        assert_eq!(sol.efforts, vec!["low", "medium", "high", "xhigh", "max", "ultra"]);
        assert_eq!(sol.default_effort.as_deref(), Some("low"));
        assert!(sol.accepts_images);
        assert_eq!(sol.upgrade, None);
        // gpt-5.5 stops short of the newer efforts.
        let older = models.iter().find(|m| m.id == "gpt-5.5").unwrap();
        assert_eq!(older.efforts, vec!["low", "medium", "high", "xhigh"]);
    }

    #[test]
    fn a_retiring_model_names_its_replacement() {
        let models = captured();
        let old = models.iter().find(|m| m.id == "gpt-5.4").unwrap();
        assert_eq!(old.upgrade.as_deref(), Some("gpt-5.6-terra"));
        assert_eq!(old.label, "GPT-5.4");
        // A text-only model is marked as such.
        let spark = models.iter().find(|m| m.id == "gpt-5.3-codex-spark").unwrap();
        assert!(!spark.accepts_images);
    }

    #[test]
    fn labels_lose_the_variant_hyphen_but_keep_the_version() {
        assert_eq!(tidy_label("GPT-5.6-Sol"), "GPT-5.6 Sol");
        assert_eq!(tidy_label("GPT-5.5"), "GPT-5.5");
        assert_eq!(tidy_label("GPT-5.4-Mini"), "GPT-5.4 Mini");
        assert_eq!(tidy_label("GPT-5.3-Codex-Spark"), "GPT-5.3 Codex-Spark");
        let models = captured();
        let labels: Vec<&str> = models.iter().map(|m| m.label.as_str()).collect();
        assert!(labels.contains(&"GPT-5.6 Sol") && labels.contains(&"GPT-5.6 Terra") && labels.contains(&"GPT-5.6 Luna"));
    }

    #[test]
    fn hidden_entries_and_nameless_ones_are_dropped() {
        let raw = json!({"data": [
            {"id": "gpt-shown", "displayName": "GPT-Shown", "hidden": false, "supportedReasoningEfforts": [{"reasoningEffort": "low"}], "inputModalities": ["text"]},
            {"id": "gpt-hidden", "displayName": "GPT-Hidden", "hidden": true, "supportedReasoningEfforts": [], "inputModalities": ["text"]},
            {"id": "", "displayName": "Nameless", "hidden": false}
        ]});
        let ids: Vec<String> = parse(&raw).into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["gpt-shown"]);
    }

    #[test]
    fn a_shape_we_do_not_understand_maps_to_nothing() {
        assert!(parse(&json!({})).is_empty());
        assert!(parse(&json!({"data": "nonsense"})).is_empty());
    }

    #[test]
    fn the_fallback_never_names_a_family_alias() {
        let models = fallback();
        assert!(models.iter().all(|m| m.id != "gpt-5.6" && m.id != "gpt-5.6-codex"));
        assert_eq!(models.iter().filter(|m| m.is_default).map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["gpt-5.6-sol"]);
        assert!(models.iter().all(|m| !m.efforts.is_empty() && m.default_effort.is_some()));
    }

    #[test]
    fn a_known_id_needs_no_substitute() {
        let cache = Cache { models: Mutex::new(Some(fallback())) };
        assert!(cache.substitute_for("gpt-5.6-sol").is_none());
        assert!(cache.substitute_for("").is_none());
        let sub = cache.substitute_for("gpt-5.6").expect("a stale id is substituted");
        assert_eq!(sub.id, "gpt-5.6-sol");
    }
}
