//! Tokens and estimated cost per tab and per session (PRO-273).
//!
//! A tab's totals are read again from its agents' own transcripts at each
//! turn end, not added up turn by turn: a count kept by addition drifts when a
//! conversation is read from its start again (#437) or runs while the app is
//! closed, and the reader's acceptance is that the totals *are* the sum of the
//! agent's usage records. The records are counted and priced by the same code
//! as Stats & Usage (`stats::claude_requests`, `stats::codex_requests`), so a
//! request is never counted twice for its streamed content blocks and a Codex
//! cumulative counter is turned into its deltas once, the same way.
//!
//! Totals are kept per model: a tab can change model mid-conversation, and a
//! session's tabs can run different agents. A model the price table does not
//! know keeps its tokens and has no cost (`None`, never zero).
//!
//! The figure is what the tokens would cost at API list prices. On a
//! subscription login nothing is billed per token; the app labels it
//! "API-equivalent" there. Nothing here leaves the machine.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::harness::{claude, codex};
use crate::stats::{self, PricedRequest};
use crate::store::index::{self, SessionEntry, TabEntry};

/// One model's share of a tab's conversations.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    /// The model id the agent reported for these requests ("unknown" when it
    /// reported none).
    pub model: String,
    /// Uncached input; cache reads and writes are counted on their own.
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// API list price of these tokens, `None` when the model (or a service
    /// tier one of its requests ran on) has no price.
    pub cost_usd: Option<f64>,
}

/// What a tab's agents have used, kept on its index entry.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TabUsage {
    pub models: Vec<ModelUsage>,
    /// When the totals were read.
    pub updated: String,
}

/// Several models' usage summed.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// The priced models' cost. `None` when there are tokens and no model
    /// among them has a price.
    pub cost_usd: Option<f64>,
    /// Models whose tokens are counted above but whose cost is not.
    pub unpriced_models: Vec<String>,
}

const UNKNOWN_MODEL: &str = "unknown";

/// Fold requests into per-model rows. A model's cost is `None` as soon as one
/// of its requests cannot be priced: a partial figure for one model would
/// read as its whole cost.
fn add_requests(models: &mut BTreeMap<String, ModelUsage>, requests: Vec<PricedRequest>) {
    for request in requests {
        let name = request.model.filter(|model| !model.trim().is_empty()).unwrap_or_else(|| UNKNOWN_MODEL.into());
        let row = models.entry(name.clone()).or_insert_with(|| ModelUsage { model: name, cost_usd: Some(0.0), ..Default::default() });
        row.input_tokens = row.input_tokens.saturating_add(request.input);
        row.output_tokens = row.output_tokens.saturating_add(request.output);
        row.cache_read_tokens = row.cache_read_tokens.saturating_add(request.cache_read);
        row.cache_write_tokens = row.cache_write_tokens.saturating_add(request.cache_write);
        row.cost_usd = row.cost_usd.zip(request.cost_usd).map(|(sum, cost)| sum + cost);
    }
}

/// Merge rows of the same model, as a session does with its tabs'.
pub fn merge<'a>(rows: impl IntoIterator<Item = &'a ModelUsage>) -> Vec<ModelUsage> {
    let mut models = BTreeMap::<String, ModelUsage>::new();
    for row in rows {
        match models.get_mut(&row.model) {
            Some(merged) => {
                merged.input_tokens = merged.input_tokens.saturating_add(row.input_tokens);
                merged.output_tokens = merged.output_tokens.saturating_add(row.output_tokens);
                merged.cache_read_tokens = merged.cache_read_tokens.saturating_add(row.cache_read_tokens);
                merged.cache_write_tokens = merged.cache_write_tokens.saturating_add(row.cache_write_tokens);
                merged.cost_usd = merged.cost_usd.zip(row.cost_usd).map(|(a, b)| a + b);
            }
            None => {
                models.insert(row.model.clone(), row.clone());
            }
        }
    }
    let mut merged: Vec<_> = models.into_values().collect();
    // The costliest first, as the popover lists them; unpriced last.
    merged.sort_by(|a, b| b.cost_usd.unwrap_or(-1.0).total_cmp(&a.cost_usd.unwrap_or(-1.0)).then_with(|| a.model.cmp(&b.model)));
    merged
}

pub fn total<'a>(rows: impl IntoIterator<Item = &'a ModelUsage>) -> Totals {
    let mut totals = Totals::default();
    let (mut cost, mut priced, mut tokens) = (0.0, false, false);
    for row in rows {
        totals.input_tokens = totals.input_tokens.saturating_add(row.input_tokens);
        totals.output_tokens = totals.output_tokens.saturating_add(row.output_tokens);
        totals.cache_read_tokens = totals.cache_read_tokens.saturating_add(row.cache_read_tokens);
        totals.cache_write_tokens = totals.cache_write_tokens.saturating_add(row.cache_write_tokens);
        tokens |= row.input_tokens > 0 || row.output_tokens > 0 || row.cache_read_tokens > 0 || row.cache_write_tokens > 0;
        match row.cost_usd {
            Some(value) => {
                cost += value;
                priced = true;
            }
            None => {
                if !totals.unpriced_models.contains(&row.model) {
                    totals.unpriced_models.push(row.model.clone());
                }
            }
        }
    }
    // Nothing used costs nothing; tokens with no price at all have no cost.
    totals.cost_usd = (priced || !tokens).then_some(cost);
    totals
}

/// The transcript files of one Claude conversation: its own, and those of the
/// subagents it ran (`<id>/subagents/*.jsonl` beside it), whose requests are
/// spent on its behalf.
fn claude_files(transcript: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if transcript.is_file() {
        files.push(transcript.to_path_buf());
    }
    let subagents = transcript.with_extension("").join("subagents");
    let mut more: Vec<PathBuf> = std::fs::read_dir(&subagents)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "jsonl") && path.is_file())
        .collect();
    more.sort();
    files.extend(more);
    files
}

fn codex_rollout(id: &str) -> Option<PathBuf> {
    [codex::home::managed_root().ok(), codex::home::user_root()]
        .into_iter()
        .flatten()
        .find_map(|home| codex::home::find_rollout(&home, id))
}

/// Where a tab's agents keep their transcripts. Tests point it at fixtures.
pub trait Transcripts {
    fn claude(&self, cwd: &str, id: &str) -> Option<PathBuf>;
    fn codex(&self, id: &str) -> Option<PathBuf>;
}

/// The agents' own folders, as the app runs them.
pub struct AgentHomes;

impl Transcripts for AgentHomes {
    fn claude(&self, cwd: &str, id: &str) -> Option<PathBuf> {
        claude::transcript::locate(cwd, id)
    }
    fn codex(&self, id: &str) -> Option<PathBuf> {
        codex_rollout(id)
    }
}

fn uuids_in(files: &[PathBuf]) -> HashSet<String> {
    files
        .iter()
        .filter_map(|file| std::fs::read_to_string(file).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter_map(|record| record["uuid"].as_str().map(String::from))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// Read a tab's usage from every conversation it holds or has held. `None`
/// when none of them is an agent's whose usage can be read (a terminal, an
/// agent without usage records), so such a tab carries nothing rather than
/// zeros.
pub fn read_tab(cwd: &str, tab: &TabEntry, homes: &dyn Transcripts) -> Option<TabUsage> {
    let mut models = BTreeMap::new();
    let mut readable = false;
    for (harness, id, _) in tab.conversations() {
        match harness {
            "claude" => {
                let Some(transcript) = homes.claude(cwd, id) else { continue };
                readable = true;
                // A fork's file opens with its parent's records, uuids and
                // all: the parent counts them.
                let skip = match (tab.provider_session_id.as_deref() == Some(id), tab.fork_from.as_deref()) {
                    (true, Some(parent)) => homes.claude(cwd, parent).map(|path| uuids_in(&[path])).unwrap_or_default(),
                    _ => HashSet::new(),
                };
                for file in claude_files(&transcript) {
                    match stats::claude_requests(&file, &skip) {
                        Ok(requests) => add_requests(&mut models, requests),
                        Err(error) => log::warn!("session usage: read {}: {error:#}", file.display()),
                    }
                }
            }
            "codex" => {
                let Some(rollout) = homes.codex(id) else { continue };
                readable = true;
                match stats::codex_requests(&rollout) {
                    Ok(requests) => add_requests(&mut models, requests),
                    Err(error) => log::warn!("session usage: read {}: {error:#}", rollout.display()),
                }
            }
            _ => {}
        }
    }
    readable.then(|| TabUsage { models: merge(models.values()), updated: index::now() })
}

/// Read a tab's usage again and keep it on its entry. Returns the session as
/// it is now when the totals changed, for the windows to be told.
pub fn refresh_tab(session_id: &str, tab_id: &str) -> anyhow::Result<Option<SessionEntry>> {
    let session = index::get(session_id)?;
    let Some(tab) = session.tabs.iter().find(|tab| tab.id == tab_id) else { return Ok(None) };
    let Some(usage) = read_tab(&session.cwd, tab, &AgentHomes) else { return Ok(None) };
    store(session_id, tab_id, usage)
}

/// Read every tab of a session again (`sessions usage`, the header's
/// popover), outside the index lock. Returns the session, and whether any
/// tab's totals moved.
pub fn refresh_session(session_id: &str) -> anyhow::Result<(SessionEntry, bool)> {
    let session = index::get(session_id)?;
    let (mut latest, mut changed) = (session.clone(), false);
    for tab in &session.tabs {
        if let Some(usage) = read_tab(&session.cwd, tab, &AgentHomes) {
            if let Some(updated) = store(session_id, &tab.id, usage)? {
                latest = updated;
                changed = true;
            }
        }
    }
    Ok((latest, changed))
}

/// Tabs whose totals are being read, and whether another turn ended since
/// the read began.
static PENDING: std::sync::Mutex<BTreeMap<(String, String), bool>> = std::sync::Mutex::new(BTreeMap::new());

/// Read a tab's totals again off the caller's thread, after a turn end. Turn
/// ends that come while a read is under way (a conversation read from its
/// start ends many at once) make one more read, not one each. `changed` is
/// told the session when the totals moved.
pub fn schedule(session_id: &str, tab_id: &str, changed: impl Fn(SessionEntry) + Send + 'static) {
    let key = (session_id.to_string(), tab_id.to_string());
    {
        let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(again) = pending.get_mut(&key) {
            *again = true;
            return;
        }
        pending.insert(key.clone(), false);
    }
    std::thread::spawn(move || loop {
        match refresh_tab(&key.0, &key.1) {
            Ok(Some(entry)) => changed(entry),
            Ok(None) => {}
            Err(error) => log::warn!("session usage {}/{}: {error:#}", key.0, key.1),
        }
        let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
        if pending.get(&key) == Some(&true) {
            pending.insert(key.clone(), false);
            continue;
        }
        pending.remove(&key);
        break;
    });
}

fn store(session_id: &str, tab_id: &str, usage: TabUsage) -> anyhow::Result<Option<SessionEntry>> {
    index::update_session(session_id, |session| {
        let Some(tab) = session.tab_mut(tab_id) else { return Ok(None) };
        if tab.usage.as_ref().is_some_and(|kept| kept.models == usage.models) {
            return Ok(None);
        }
        // Not `modified`: totals read again are not the tab changing.
        tab.usage = Some(usage);
        Ok(Some(session.clone()))
    })
}

/// A session's estimated cost: its tabs' priced models summed (`None` when
/// it has tokens and none of them is priced, or nothing was read yet).
pub fn estimated_cost(session: &SessionEntry) -> Option<f64> {
    let rows: Vec<&ModelUsage> = session.tabs.iter().filter_map(|tab| tab.usage.as_ref()).flat_map(|usage| &usage.models).collect();
    if session.tabs.iter().all(|tab| tab.usage.is_none()) {
        return None;
    }
    total(rows).cost_usd
}

/// `sessions usage <session> --json`: each tab's models and total, the
/// session's models merged, and its total.
pub fn session_json(session: &SessionEntry) -> Value {
    let tabs: Vec<Value> = session
        .tabs
        .iter()
        .filter_map(|tab| {
            let usage = tab.usage.as_ref()?;
            Some(json!({
                "tabId": tab.id,
                "title": tab.title,
                "agent": tab.harness,
                "models": usage.models,
                "total": total(&usage.models),
                "updated": usage.updated,
            }))
        })
        .collect();
    let models = merge(session.tabs.iter().filter_map(|tab| tab.usage.as_ref()).flat_map(|usage| &usage.models));
    json!({
        "sessionId": session.id,
        "title": session.title,
        "tabs": tabs,
        "models": models,
        "total": total(&models),
        "estimate": true,
    })
}

/// Add `estimatedCostUsd` to a session entry as `sessions list` and
/// `sessions show` return it.
pub fn with_cost(session: &SessionEntry) -> Value {
    let mut value = serde_json::to_value(session).unwrap_or(Value::Null);
    if let Value::Object(map) = &mut value {
        map.insert("estimatedCostUsd".into(), json!(estimated_cost(session)));
    }
    value
}

#[cfg(test)]
#[path = "session_usage_tests.rs"]
mod tests;
