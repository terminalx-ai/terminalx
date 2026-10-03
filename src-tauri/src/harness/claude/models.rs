//! Which Claude models this account may run, and what each alias runs today.
//!
//! Both are the CLI's to say. `opus` meant Opus 5 one month and Opus 5.5 the
//! next, and a label we wrote down went stale without anything failing. The
//! `initialize` control request (see `super::ask_initialize`) answers with the
//! account's models: the family aliases, each with the full id it resolves to,
//! and the older versions still on offer.
//!
//! From that we offer two kinds of entry. An alias (`opus`) follows the latest
//! release and says which version that is now; a pinned version
//! (`claude-opus-5-5`) stays where it is. The CLI does not list the current
//! version under its own id, so that entry is added from the alias.
//!
//! The answer is cached for the process and re-read, at most every few
//! minutes, when a picker opens. Every failure — no `claude` on PATH, a hung
//! child, a shape we do not understand — falls back to the built-in list
//! (`models::claude_fallback`), which names no version for an alias.
//!
//! The list is this machine's. A cloud workspace's runtime asks its own CLI,
//! which may be older or newer than the desktop's.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::models::{claude_fallback, claude_label, family_label, Model};

/// A picker opening re-reads the list only when the last read is older than
/// this: each read spawns a CLI.
const FRESH_FOR: Duration = Duration::from_secs(300);

/// When the list was read, and what it was.
type Cached = Mutex<Option<(Instant, Vec<Model>)>>;

fn cache() -> &'static Cached {
    static C: OnceLock<Cached> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// The account's models, fetching once and then reusing the answer. `refresh`
/// asks again if the answer has aged. Never empty: a failure yields the
/// built-in list, with the reason logged.
pub fn get(refresh: bool) -> Vec<Model> {
    // Tests must not depend on a CLI being installed, or on what it says.
    if cfg!(test) {
        return claude_fallback();
    }
    if let Some((at, models)) = cache().lock().unwrap().clone() {
        if !refresh || at.elapsed() < FRESH_FOR {
            return models;
        }
    }
    // The lock is not held across the fetch: it spawns a child and waits.
    let models = match fetch() {
        Ok(models) if !models.is_empty() => models,
        Ok(_) => {
            log::warn!("claude named no usable models; using the built-in list");
            claude_fallback()
        }
        Err(e) => {
            log::warn!("could not read the Claude model list ({e:#}); using the built-in list");
            claude_fallback()
        }
    };
    *cache().lock().unwrap() = Some((Instant::now(), models.clone()));
    models
}

/// Asked from the home directory: the list depends on the account, not on a
/// project.
fn fetch() -> anyhow::Result<Vec<Model>> {
    let cwd = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    Ok(parse(&super::ask_initialize(&cwd)?))
}

/// An `initialize` reply onto our own model shape: aliases in the CLI's order,
/// then the pinned versions, current ones first.
pub fn parse(reply: &Value) -> Vec<Model> {
    let listed = reply.pointer("/response/response/models").or_else(|| reply.pointer("/response/models")).and_then(Value::as_array);
    let mut aliases: Vec<Model> = Vec::new();
    let mut pinned: Vec<Model> = Vec::new();
    // `default` is the CLI's own pick; it tells us which alias to tick.
    let mut default_runs: Option<String> = None;
    for entry in listed.into_iter().flatten() {
        let Some(id) = entry["value"].as_str().filter(|s| !s.is_empty()) else { continue };
        let resolved = entry["resolvedModel"].as_str().filter(|s| !s.is_empty());
        if id == "default" {
            default_runs = resolved.map(String::from);
            continue;
        }
        let efforts: Vec<String> = if entry["supportsEffort"].as_bool().unwrap_or(false) {
            entry["supportedEffortLevels"].as_array().into_iter().flatten().filter_map(|e| e.as_str().map(String::from)).collect()
        } else {
            Vec::new()
        };
        let model = Model {
            id: id.to_string(),
            label: String::new(),
            harness: "claude".into(),
            // The CLI names no default effort; `high` is what the app has always started on.
            default_effort: efforts.iter().any(|e| e == "high").then(|| "high".to_string()),
            efforts,
            accepts_images: true,
            is_default: false,
            upgrade: None,
            description: entry["description"].as_str().filter(|s| !s.is_empty()).map(String::from),
            alias: false,
            resolved: None,
        };
        // A pinned version resolves to itself; an alias to something else.
        match resolved.filter(|runs| *runs != id) {
            Some(runs) => aliases.push(Model { label: family_label(id), alias: true, resolved: Some(runs.to_string()), ..model }),
            None => pinned.push(Model { label: claude_label(id).or_else(|| entry["displayName"].as_str().map(String::from)).unwrap_or_else(|| id.to_string()), ..model }),
        }
    }
    // The version an alias runs now, offered under its own id so it can be held.
    let mut current: Vec<Model> = Vec::new();
    for alias in &aliases {
        let Some(runs) = alias.resolved.as_deref() else { continue };
        if pinned.iter().chain(current.iter()).any(|m| m.id == runs) {
            continue;
        }
        current.push(Model {
            id: runs.to_string(),
            label: claude_label(runs).unwrap_or_else(|| runs.to_string()),
            alias: false,
            resolved: None,
            ..alias.clone()
        });
    }
    let default = default_runs
        .and_then(|runs| aliases.iter().position(|m| m.resolved.as_deref() == Some(runs.as_str())))
        .or_else(|| aliases.iter().position(|m| m.id == "opus"))
        .unwrap_or(0);
    let mut out = aliases;
    out.extend(current);
    out.extend(pinned);
    if let Some(model) = out.get_mut(default) {
        model.is_default = true;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The `models` of a verbatim `initialize` reply from claude 2.1.288.
    const CAPTURE: &str = include_str!("fixtures/initialize_models.json");

    fn captured() -> Vec<Model> {
        parse(&serde_json::from_str::<Value>(CAPTURE).unwrap())
    }

    #[test]
    fn an_alias_says_which_version_it_runs() {
        let models = captured();
        let aliases: Vec<(&str, &str, Option<&str>)> = models.iter().filter(|m| m.alias).map(|m| (m.id.as_str(), m.label.as_str(), m.resolved.as_deref())).collect();
        assert_eq!(
            aliases,
            vec![
                ("opus", "Opus", Some("claude-opus-5-5")),
                ("fable", "Fable", Some("claude-fable-5-1")),
                ("sonnet", "Sonnet", Some("claude-sonnet-5-5")),
                ("haiku", "Haiku", Some("claude-haiku-4-5-20251001")),
            ]
        );
        assert!(models.iter().all(|m| m.harness == "claude" && m.id != "default"));
    }

    #[test]
    fn every_version_can_be_pinned_current_ones_first() {
        let models = captured();
        let pinned: Vec<(&str, &str)> = models.iter().filter(|m| !m.alias).map(|m| (m.id.as_str(), m.label.as_str())).collect();
        assert_eq!(
            pinned,
            vec![
                // Not listed by the CLI under their own ids; added from the aliases.
                ("claude-opus-5-5", "Opus 5.5"),
                ("claude-fable-5-1", "Fable 5.1"),
                ("claude-sonnet-5-5", "Sonnet 5.5"),
                ("claude-haiku-4-5-20251001", "Haiku 4.5"),
                ("claude-sonnet-5", "Sonnet 5"),
                ("claude-opus-5", "Opus 5"),
                ("claude-fable-5", "Fable 5"),
                ("claude-opus-4-8", "Opus 4.8"),
                ("claude-opus-4-7", "Opus 4.7"),
                ("claude-opus-4-6", "Opus 4.6"),
                ("claude-sonnet-4-6", "Sonnet 4.6"),
            ]
        );
        assert!(pinned.iter().all(|(id, _)| models.iter().filter(|m| m.id == *id).count() == 1));
        assert!(models.iter().filter(|m| !m.alias).all(|m| m.resolved.is_none()));
    }

    #[test]
    fn the_default_is_the_alias_the_cli_recommends() {
        let models = captured();
        assert_eq!(models.iter().filter(|m| m.is_default).map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["opus"]);
        // A CLI that recommends another family moves the tick with it.
        let raw = json!({"response": {"response": {"models": [
            {"value": "default", "resolvedModel": "claude-sonnet-5-5"},
            {"value": "opus", "resolvedModel": "claude-opus-5-5"},
            {"value": "sonnet", "resolvedModel": "claude-sonnet-5-5"}
        ]}}});
        assert_eq!(parse(&raw).iter().filter(|m| m.is_default).map(|m| m.id.clone()).collect::<Vec<_>>(), vec!["sonnet"]);
    }

    #[test]
    fn efforts_are_the_clis_own() {
        let models = captured();
        let by_id = |id: &str| models.iter().find(|m| m.id == id).unwrap();
        assert_eq!(by_id("opus").efforts, vec!["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(by_id("opus").default_effort.as_deref(), Some("high"));
        // The pinned current version takes what its alias takes.
        assert_eq!(by_id("claude-opus-5-5").efforts, by_id("opus").efforts);
        // 4.6 stops short of `xhigh`; Haiku has no effort at all.
        assert_eq!(by_id("claude-opus-4-6").efforts, vec!["low", "medium", "high", "max"]);
        assert!(by_id("haiku").efforts.is_empty() && by_id("haiku").default_effort.is_none());
    }

    #[test]
    fn an_older_cli_reports_older_versions() {
        // What a runtime with last season's CLI would say: the same alias, another model.
        let raw = json!({"response": {"response": {"models": [
            {"value": "opus", "resolvedModel": "claude-opus-5", "displayName": "Opus 5"}
        ]}}});
        let models = parse(&raw);
        assert_eq!(models[0].resolved.as_deref(), Some("claude-opus-5"));
        assert_eq!((models[1].id.as_str(), models[1].label.as_str()), ("claude-opus-5", "Opus 5"));
    }

    /// Against the CLI installed here: `cargo test asks_the_installed_cli -- --ignored --nocapture`.
    #[test]
    #[ignore = "spawns the installed claude CLI"]
    fn asks_the_installed_cli() {
        let models = fetch().expect("the CLI answers initialize");
        for m in &models {
            println!("{:28} {:12} alias={} resolved={:?} default={}", m.id, m.label, m.alias, m.resolved, m.is_default);
        }
        assert!(models.iter().any(|m| m.alias && m.resolved.is_some()));
    }

    #[test]
    fn a_shape_we_do_not_understand_maps_to_nothing() {
        assert!(parse(&json!({})).is_empty());
        assert!(parse(&json!({"response": {"response": {"models": "nonsense"}}})).is_empty());
        assert!(parse(&json!({"response": {"response": {"models": [{"displayName": "Nameless"}]}}})).is_empty());
    }
}
