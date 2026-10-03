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
//! The answer is cached for the process. A good answer is re-read once it has
//! aged, when a picker opens or a cloud client asks the runtime for its
//! agents. Every failure — no `claude` on PATH, a hung child, a shape we do
//! not understand — keeps the last good answer if there is one and otherwise
//! falls back to the built-in list (`models::claude_fallback`), which names no
//! version for an alias; a failure is asked again after a minute, by anyone.
//!
//! The child is run with `--safe-mode`. Without it, each read would start the
//! reader's MCP servers and run their SessionStart hooks (checked on claude
//! 2.1.288); with it neither happens and the model list is the same. A CLI
//! too old to know the flag fails the read, and gets the built-in list.
//!
//! The list is this machine's. A cloud workspace's runtime asks its own CLI,
//! which may be older or newer than the desktop's.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde_json::Value;

use crate::models::{claude_fallback, claude_label, family_label, Model};

/// A good answer is re-read, when asked to refresh, only once it is older than
/// this: each read spawns a CLI.
const FRESH_FOR: Duration = Duration::from_secs(900);
/// A failed read is tried again after this, whoever asks.
const RETRY_AFTER: Duration = Duration::from_secs(60);

struct Reading {
    at: Instant,
    /// False when the CLI could not be asked and `models` is a stand-in.
    ok: bool,
    /// Whether `models` is the CLI's own answer (possibly an older one).
    listed: bool,
    models: Vec<Model>,
}

type Probe = Box<dyn Fn() -> Result<Value> + Send + Sync>;

/// The process-lifetime cache, with the question it asks injected so the
/// caching can be tested without a CLI.
pub struct Cache {
    reading: Mutex<Option<Reading>>,
    /// Held across a read, so two askers share one child.
    reading_now: Mutex<()>,
    probe: Probe,
    fresh_for: Duration,
    retry_after: Duration,
}

impl Cache {
    fn new(probe: Probe) -> Self {
        Self { reading: Mutex::new(None), reading_now: Mutex::new(()), probe, fresh_for: FRESH_FOR, retry_after: RETRY_AFTER }
    }

    /// The cached models, unless it is time to ask again.
    fn current(&self, refresh: bool) -> Option<Vec<Model>> {
        let reading = self.reading.lock().unwrap();
        let r = reading.as_ref()?;
        let due = if r.ok { refresh && r.at.elapsed() >= self.fresh_for } else { r.at.elapsed() >= self.retry_after };
        (!due).then(|| r.models.clone())
    }

    /// The account's models. Never empty: with no good answer yet, a failure
    /// yields the built-in list, with the reason logged.
    pub fn get(&self, refresh: bool) -> Vec<Model> {
        if let Some(models) = self.current(refresh) {
            return models;
        }
        let _one_at_a_time = self.reading_now.lock().unwrap();
        // Whoever held the gate has just answered the same question.
        if let Some(models) = self.current(refresh) {
            return models;
        }
        // The cache lock is not held across the read: it spawns a child and waits.
        let read = (self.probe)().map(|reply| parse(&reply));
        let mut reading = self.reading.lock().unwrap();
        let next = match read {
            Ok(models) if !models.is_empty() => Reading { at: Instant::now(), ok: true, listed: true, models },
            failed => {
                match &failed {
                    Err(e) => log::warn!("could not read the Claude model list ({e:#})"),
                    _ => log::warn!("claude named no usable models"),
                }
                // An older real answer beats the stand-in; either way, ask again soon.
                match reading.take().filter(|r| r.listed) {
                    Some(last) => Reading { at: Instant::now(), ok: false, ..last },
                    None => Reading { at: Instant::now(), ok: false, listed: false, models: claude_fallback() },
                }
            }
        };
        let models = next.models.clone();
        *reading = Some(next);
        models
    }
}

/// The one cache for this process. In tests it has no CLI to ask, so it
/// answers with the built-in list.
fn shared() -> &'static Cache {
    static C: OnceLock<Cache> = OnceLock::new();
    C.get_or_init(|| Cache::new(if cfg!(test) { Box::new(|| Err(anyhow::anyhow!("tests do not run the CLI"))) } else { Box::new(ask) }))
}

/// See `Cache::get`.
pub fn get(refresh: bool) -> Vec<Model> {
    shared().get(refresh)
}

/// Asked from the home directory: the list depends on the account, not on a
/// project.
fn ask() -> Result<Value> {
    let cwd = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    super::ask_initialize(&cwd, &["--safe-mode"])
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
        // A pinned version is listed under its full id. Anything else is a
        // family alias, whether or not this CLI says what it resolves to: an
        // older one may name `opus` and nothing more.
        if id.starts_with("claude-") {
            pinned.push(Model { label: claude_label(id).or_else(|| entry["displayName"].as_str().map(String::from)).unwrap_or_else(|| id.to_string()), ..model });
        } else {
            aliases.push(Model { label: family_label(id), alias: true, resolved: resolved.filter(|runs| *runs != id).map(String::from), ..model });
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
    let mut out = aliases;
    out.extend(current);
    out.extend(pinned);
    // The CLI's own pick, as the alias that runs it; else Opus, as the app has
    // always started on; else whatever is first.
    let default = default_runs
        .and_then(|runs| out.iter().position(|m| m.alias && m.resolved.as_deref() == Some(runs.as_str())))
        .or_else(|| out.iter().position(|m| m.id == "opus"))
        .unwrap_or(0);
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
        let models = parse(&ask().expect("the CLI answers initialize"));
        for m in &models {
            println!("{:28} {:12} alias={} resolved={:?} default={}", m.id, m.label, m.alias, m.resolved, m.is_default);
        }
        assert!(models.iter().any(|m| m.alias && m.resolved.is_some()));
    }

    #[test]
    fn a_cli_that_does_not_say_what_an_alias_runs_still_lists_aliases() {
        // An older CLI: family names, no `resolvedModel`, Sonnet listed first.
        let raw = json!({"response": {"response": {"models": [
            {"value": "sonnet", "displayName": "Sonnet"},
            {"value": "opus", "displayName": "Opus"},
            {"value": "claude-opus-4-6", "displayName": "Opus 4.6"}
        ]}}});
        let models = parse(&raw);
        let seen: Vec<(&str, &str, bool, Option<&str>)> = models.iter().map(|m| (m.id.as_str(), m.label.as_str(), m.alias, m.resolved.as_deref())).collect();
        assert_eq!(seen, vec![("sonnet", "Sonnet", true, None), ("opus", "Opus", true, None), ("claude-opus-4-6", "Opus 4.6", false, None)]);
        // The tick stays on Opus, not on whichever came first.
        assert_eq!(models.iter().filter(|m| m.is_default).map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["opus"]);
    }

    fn reply(runs: &str) -> Value {
        json!({"response": {"response": {"models": [{"value": "opus", "resolvedModel": runs}]}}})
    }

    /// A cache whose CLI answers from a script, one entry per read, and counts the reads.
    fn scripted(answers: Vec<Result<Value, &'static str>>) -> (Cache, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let reads = std::sync::Arc::new(AtomicUsize::new(0));
        let (count, answers) = (reads.clone(), Mutex::new(answers.into_iter()));
        let probe: Probe = Box::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            answers.lock().unwrap().next().expect("an unexpected read").map_err(|e| anyhow::anyhow!(e))
        });
        (Cache::new(probe), reads)
    }

    fn opus_runs(models: &[Model]) -> Option<&str> {
        models.iter().find(|m| m.id == "opus").and_then(|m| m.resolved.as_deref())
    }

    #[test]
    fn a_good_answer_is_kept_until_it_ages_and_a_refresh_is_asked_for() {
        use std::sync::atomic::Ordering;
        let (mut cache, reads) = scripted(vec![Ok(reply("claude-opus-5")), Ok(reply("claude-opus-5-5"))]);
        assert_eq!(opus_runs(&cache.get(false)), Some("claude-opus-5"));
        // Fresh: neither a plain read nor a refresh spawns another CLI.
        assert_eq!(opus_runs(&cache.get(true)), Some("claude-opus-5"));
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        // Aged: a plain read still reuses it; a refresh asks again and sees the CLI's update.
        cache.fresh_for = Duration::ZERO;
        assert_eq!(opus_runs(&cache.get(false)), Some("claude-opus-5"));
        assert_eq!(opus_runs(&cache.get(true)), Some("claude-opus-5-5"));
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_failed_first_read_is_a_stand_in_that_is_soon_asked_again() {
        use std::sync::atomic::Ordering;
        let (mut cache, reads) = scripted(vec![Err("no claude on PATH"), Ok(reply("claude-opus-5-5"))]);
        let stand_in = cache.get(false);
        assert_eq!(stand_in.iter().map(|m| m.id.clone()).collect::<Vec<_>>(), claude_fallback().into_iter().map(|m| m.id).collect::<Vec<_>>());
        // Within the retry window nothing is spawned again.
        cache.get(true);
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        // After it, even a plain read (all the runtime used to send) gets the real list.
        cache.retry_after = Duration::ZERO;
        assert_eq!(opus_runs(&cache.get(false)), Some("claude-opus-5-5"));
        assert_eq!(reads.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_failed_refresh_keeps_the_last_real_answer() {
        use std::sync::atomic::Ordering;
        let (mut cache, reads) = scripted(vec![Ok(reply("claude-opus-5-5")), Err("hung"), Ok(json!({})), Ok(reply("claude-opus-6"))]);
        cache.fresh_for = Duration::ZERO;
        cache.retry_after = Duration::ZERO;
        cache.get(false);
        // A hung child, then an empty reply: the real list stays, not the stand-in.
        assert_eq!(opus_runs(&cache.get(true)), Some("claude-opus-5-5"));
        assert_eq!(opus_runs(&cache.get(false)), Some("claude-opus-5-5"));
        assert_eq!(opus_runs(&cache.get(false)), Some("claude-opus-6"));
        assert_eq!(reads.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn askers_at_the_same_moment_share_one_read() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let reads = std::sync::Arc::new(AtomicUsize::new(0));
        let count = reads.clone();
        let cache = std::sync::Arc::new(Cache::new(Box::new(move || {
            count.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(150));
            Ok(reply("claude-opus-5-5"))
        })));
        // A startup load and a picker opening, together.
        let askers: Vec<_> = [false, true, true].into_iter().map(|refresh| {
            let cache = cache.clone();
            std::thread::spawn(move || cache.get(refresh))
        }).collect();
        for asker in askers {
            assert_eq!(opus_runs(&asker.join().unwrap()), Some("claude-opus-5-5"));
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_shared_cache_runs_no_cli_under_test() {
        assert_eq!(get(false).len(), claude_fallback().len());
    }

    #[test]
    fn a_shape_we_do_not_understand_maps_to_nothing() {
        assert!(parse(&json!({})).is_empty());
        assert!(parse(&json!({"response": {"response": {"models": "nonsense"}}})).is_empty());
        assert!(parse(&json!({"response": {"response": {"models": [{"displayName": "Nameless"}]}}})).is_empty());
    }
}
