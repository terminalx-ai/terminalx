//! Local app statistics and transcript-backed token analytics.
//!
//! The scanner never contacts a provider. It walks the histories the installed
//! CLIs already own and keeps a compact projection under `RACCOON_HOME`, keyed
//! by path, mtime and size so unchanged multi-gigabyte histories cost only a
//! metadata read on later visits.

mod pricing;
mod saved;
pub use saved::{StatsUsageState, StatsUsageStore};

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use chrono::{DateTime, Days, Local};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const CACHE_SCHEMA: u32 = 3;
const CACHE_FILE: &str = "stats-usage-cache.json";
const PR_FILE: &str = "stats-prs.json";
const OVERVIEW_DAYS: u64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsUsageSnapshot {
    pub app: AppStats,
    pub total_tokens: u64,
    pub estimated_cost_usd: Option<f64>,
    pub has_partial_cost: bool,
    pub active_days: usize,
    pub cache_share: Option<f64>,
    pub new_input_tokens: u64,
    pub output_tokens: u64,
    pub cache_tokens: u64,
    pub reasoning_tokens: u64,
    pub daily: Vec<UsageDay>,
    pub providers: Vec<ProviderUsage>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppStats {
    pub agents_spawned: usize,
    pub agent_time_ms: u64,
    pub prs_created: usize,
    pub tracking_since: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    pub day: String,
    pub total_tokens: u64,
    pub claude_tokens: u64,
    pub codex_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub id: String,
    pub label: String,
    pub enabled: bool,
    pub has_data: bool,
    pub last_model: Option<String>,
    pub last_project: Option<String>,
    pub total_tokens: u64,
    pub sessions: usize,
    pub activity_count: usize,
    pub activity_label: String,
    pub estimated_cost_usd: Option<f64>,
    pub has_partial_cost: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
enum Provider {
    Claude,
    Codex,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageEvent {
    provider: Provider,
    session_id: String,
    timestamp: String,
    timestamp_ms: i64,
    day: String,
    model: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    project: String,
    event_key: Option<String>,
    new_input_tokens: u64,
    output_tokens: u64,
    cache_read_tokens: u64,
    cache_write_tokens: u64,
    cache_tokens: u64,
    reasoning_tokens: u64,
    total_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedFile {
    path: PathBuf,
    provider: Provider,
    modified_nanos: u64,
    size: u64,
    events: Vec<UsageEvent>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanCache {
    schema_version: u32,
    files: Vec<CachedFile>,
}

impl Default for ScanCache {
    fn default() -> Self {
        Self {
            schema_version: CACHE_SCHEMA,
            files: Vec::new(),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrHistory {
    #[serde(default)]
    urls: Vec<String>,
}

/// Build a candidate; the lifecycle publishes it only after durable persistence.
fn scan_snapshot(store_root: &Path) -> Result<StatsUsageSnapshot> {
    scan_snapshot_with(
        store_root,
        || discover_sources(store_root),
        || Ok((app_stats()?, usage_scope()?)),
    )
}

fn scan_snapshot_with(
    store_root: &Path,
    sources: impl FnOnce() -> Result<Vec<(PathBuf, Provider)>>,
    inputs: impl FnOnce() -> Result<(AppStats, UsageScope)>,
) -> Result<StatsUsageSnapshot> {
    let cache_path = store_root.join(CACHE_FILE);
    let previous = match crate::store::read_json::<ScanCache>(&cache_path) {
        Ok(Some(cache)) if cache.schema_version == CACHE_SCHEMA => cache,
        Ok(_) => ScanCache::default(),
        Err(error) => {
            log::warn!("read stats usage cache: {error:#}");
            ScanCache::default()
        }
    };

    let files = sources()?;
    let mut previous_by_path: HashMap<PathBuf, CachedFile> = previous
        .files
        .into_iter()
        .map(|file| (file.path.clone(), file))
        .collect();
    let mut current = Vec::with_capacity(files.len());
    for (path, provider) in files {
        let metadata = match fs::metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("stat usage transcript {}", path.display()))
            }
        };
        let modified_nanos = modified_nanos(&metadata)?;
        let size = metadata.len();
        if let Some(cached) = previous_by_path.remove(&path).filter(|cached| {
            cached.provider == provider
                && cached.modified_nanos == modified_nanos
                && cached.size == size
        }) {
            current.push(cached);
            continue;
        }
        match parse_file(&path, provider) {
            Ok(events) => current.push(CachedFile {
                path,
                provider,
                modified_nanos,
                size,
                events,
            }),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("scan usage transcript {}", path.display()))
            }
        }
    }

    current.sort_by(|left, right| lexical_path_cmp(&left.path, &right.path));
    let (app, scope) = inputs()?;
    let snapshot = aggregate(&current, app, &scope, &overview_cutoff(Local::now()));
    let cache = ScanCache {
        schema_version: CACHE_SCHEMA,
        files: current,
    };
    let bytes = serde_json::to_vec(&cache)?;
    crate::store::write_atomic(&cache_path, &bytes).context("write stats scan cache")?;
    Ok(snapshot)
}

fn modified_nanos(metadata: &fs::Metadata) -> Result<u64> {
    Ok(metadata
        .modified()?
        .duration_since(UNIX_EPOCH)?
        .as_nanos()
        .min(u64::MAX as u128) as u64)
}

fn discover_sources(store_root: &Path) -> Result<Vec<(PathBuf, Provider)>> {
    let home = dirs::home_dir().context("no home directory")?;
    let predecessor_root = predecessor_data_root();
    discover_sources_at(&home, store_root, predecessor_root.as_deref())
}

fn discover_sources_at(
    home: &Path,
    store_root: &Path,
    predecessor_root: Option<&Path>,
) -> Result<Vec<(PathBuf, Provider)>> {
    let mut roots = vec![
        (home.join(".claude/projects"), Provider::Claude),
        (home.join(".claude/transcripts"), Provider::Claude),
        (home.join(".codex/sessions"), Provider::Codex),
        (store_root.join("codex/sessions"), Provider::Codex),
    ];
    add_managed_codex_roots(store_root, &mut roots)?;
    if let Some(root) = predecessor_root {
        roots.push((
            root.join("codex-runtime-home/home/sessions"),
            Provider::Codex,
        ));
        add_managed_codex_roots(root, &mut roots)?;
    }
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    for (root, provider) in roots {
        discover_jsonl(&root, provider, &mut files, &mut seen)?;
    }
    files.sort_by(|left, right| lexical_path_cmp(&left.0, &right.0));
    Ok(files)
}

fn lexical_path_cmp(left: &Path, right: &Path) -> std::cmp::Ordering {
    left.to_string_lossy().cmp(&right.to_string_lossy())
}

// Only a confirmed absence is an empty source. Permission/I/O failures abort
// the entire candidate, including when a directory entry disappears mid-walk.
fn optional_directory(path: &Path) -> Result<Option<fs::ReadDir>> {
    match fs::read_dir(path) {
        Ok(entries) => Ok(Some(entries)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => {
            Err(error).with_context(|| format!("read usage directory {}", path.display()))
        }
    }
}

fn add_managed_codex_roots(root: &Path, roots: &mut Vec<(PathBuf, Provider)>) -> Result<()> {
    if let Some(accounts) = optional_directory(&root.join("codex-accounts"))? {
        for account in accounts {
            let account = account?;
            if account.file_type()?.is_dir() {
                roots.push((account.path().join("home/sessions"), Provider::Codex));
            }
        }
    }
    Ok(())
}

fn discover_jsonl(
    root: &Path,
    provider: Provider,
    out: &mut Vec<(PathBuf, Provider)>,
    seen: &mut HashSet<PathBuf>,
) -> Result<()> {
    if let Some(entries) = optional_directory(root)? {
        for entry in entries {
            let entry = entry?;
            let path = entry.path();
            let kind = entry.file_type()?;
            if kind.is_dir() {
                discover_jsonl(&path, provider, out, seen)?;
            } else if kind.is_file()
                && path.extension().and_then(|extension| extension.to_str()) == Some("jsonl")
            {
                let identity = fs::canonicalize(&path)?;
                if seen.insert(identity.clone()) {
                    out.push((identity, provider));
                }
            }
        }
    }
    Ok(())
}

fn parse_file(path: &Path, provider: Provider) -> Result<Vec<UsageEvent>> {
    match provider {
        Provider::Claude => parse_claude(path),
        Provider::Codex => parse_codex(path),
    }
}

fn parse_claude(path: &Path) -> Result<Vec<UsageEvent>> {
    let file = File::open(path)?;
    let fallback_session = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown");
    let mut events = Vec::<UsageEvent>::new();
    let mut by_key = HashMap::<String, usize>::new();

    for line in BufReader::new(file).lines() {
        let line = line.with_context(|| format!("read usage transcript {}", path.display()))?;
        if !line.contains("assistant") || !line.contains("usage") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) else {
            continue;
        };
        let Some((timestamp_ms, day)) = time_parts(timestamp) else {
            continue;
        };
        let usage = &record["message"]["usage"];
        let input = number(&usage["input_tokens"]);
        let output = number(&usage["output_tokens"]);
        let cache_read = number(&usage["cache_read_input_tokens"]);
        let cache_write = number(&usage["cache_creation_input_tokens"]);
        if input
            .saturating_add(output)
            .saturating_add(cache_read)
            .saturating_add(cache_write)
            == 0
        {
            continue;
        }
        let session_id = record
            .get("sessionId")
            .or_else(|| record.get("session_id"))
            .and_then(Value::as_str)
            .unwrap_or(fallback_session)
            .to_string();
        let model = record["message"]["model"].as_str().map(str::to_string);
        let cwd = record.get("cwd").and_then(Value::as_str);
        let message_id = record["message"]["id"]
            .as_str()
            .filter(|value| !value.trim().is_empty());
        let request_id = record
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        let uuid = record
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty());
        let event_key = match (message_id, request_id, uuid) {
            (Some(message), Some(request), _) => Some(format!("{message}:{request}")),
            (Some(message), None, _) => Some(format!("msg:{message}")),
            (None, _, Some(uuid)) => Some(format!("uuid:{uuid}")),
            _ => None,
        };
        let event = UsageEvent {
            provider: Provider::Claude,
            session_id,
            timestamp: timestamp.to_string(),
            timestamp_ms,
            day,
            model,
            cwd: cwd.map(str::to_string),
            project: project_label(cwd),
            event_key: event_key.clone(),
            new_input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cache_read,
            cache_write_tokens: cache_write,
            cache_tokens: cache_read.saturating_add(cache_write),
            reasoning_tokens: 0,
            total_tokens: input
                .saturating_add(output)
                .saturating_add(cache_read)
                .saturating_add(cache_write),
        };

        if let Some(key) = event_key {
            if let Some(index) = by_key.get(&key).copied() {
                let prior = &mut events[index];
                prior.new_input_tokens = prior.new_input_tokens.max(event.new_input_tokens);
                prior.output_tokens = prior.output_tokens.max(event.output_tokens);
                prior.cache_read_tokens = prior.cache_read_tokens.max(event.cache_read_tokens);
                prior.cache_write_tokens = prior.cache_write_tokens.max(event.cache_write_tokens);
                prior.cache_tokens = prior
                    .cache_read_tokens
                    .saturating_add(prior.cache_write_tokens);
                prior.total_tokens = prior
                    .new_input_tokens
                    .saturating_add(prior.output_tokens)
                    .saturating_add(prior.cache_tokens);
                continue;
            }
            by_key.insert(key, events.len());
        }
        events.push(event);
    }
    Ok(events)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RawUsage {
    input: u64,
    cached_input: u64,
    output: u64,
    reasoning: u64,
    total: u64,
}

fn raw_usage(value: &Value) -> Option<RawUsage> {
    let record = value.as_object()?;
    let input = number(record.get("input_tokens").unwrap_or(&Value::Null));
    let cached_input = number(
        record
            .get("cached_input_tokens")
            .or_else(|| record.get("cache_read_input_tokens"))
            .unwrap_or(&Value::Null),
    );
    let output = number(record.get("output_tokens").unwrap_or(&Value::Null));
    let reasoning = number(
        record
            .get("reasoning_output_tokens")
            .unwrap_or(&Value::Null),
    );
    let total = number(record.get("total_tokens").unwrap_or(&Value::Null));
    Some(RawUsage {
        input,
        cached_input,
        output,
        reasoning,
        total: if total > 0 {
            total
        } else {
            input.saturating_add(output)
        },
    })
}

fn subtract(current: RawUsage, previous: RawUsage) -> RawUsage {
    RawUsage {
        input: current.input.saturating_sub(previous.input),
        cached_input: current.cached_input.saturating_sub(previous.cached_input),
        output: current.output.saturating_sub(previous.output),
        reasoning: current.reasoning.saturating_sub(previous.reasoning),
        total: current.total.saturating_sub(previous.total),
    }
}

fn add(left: RawUsage, right: RawUsage) -> RawUsage {
    RawUsage {
        input: left.input.saturating_add(right.input),
        cached_input: left.cached_input.saturating_add(right.cached_input),
        output: left.output.saturating_add(right.output),
        reasoning: left.reasoning.saturating_add(right.reasoning),
        total: left.total.saturating_add(right.total),
    }
}

fn same_counts(left: RawUsage, right: RawUsage) -> bool {
    left.input == right.input
        && left.cached_input == right.cached_input
        && left.output == right.output
        && left.reasoning == right.reasoning
}

fn monotonic(current: RawUsage, previous: RawUsage) -> bool {
    current.input >= previous.input
        && current.cached_input >= previous.cached_input
        && current.output >= previous.output
        && current.reasoning >= previous.reasoning
}

fn magnitude(usage: RawUsage) -> u128 {
    usage.input as u128
        + usage.cached_input as u128
        + usage.output as u128
        + usage.reasoning as u128
}

fn stale_regression(current: RawUsage, previous: RawUsage, last: RawUsage) -> bool {
    let current_total = magnitude(current);
    let previous_total = magnitude(previous);
    let last_total = magnitude(last);
    previous_total > 0
        && current_total > 0
        && last_total > 0
        && (current_total.saturating_mul(100) >= previous_total.saturating_mul(98)
            || current_total.saturating_add(last_total.saturating_mul(2)) >= previous_total)
}

enum Delta {
    Event(RawUsage, Option<RawUsage>),
    Baseline(RawUsage),
}

fn codex_delta(
    total: Option<RawUsage>,
    last: Option<RawUsage>,
    previous: Option<RawUsage>,
) -> Option<Delta> {
    match (total, last, previous) {
        (Some(total), Some(last), Some(previous)) => {
            if same_counts(total, previous)
                || (!monotonic(total, previous) && stale_regression(total, previous, last))
            {
                None
            } else {
                Some(Delta::Event(last, Some(total)))
            }
        }
        (Some(total), Some(last), None) => Some(Delta::Event(last, Some(total))),
        (Some(total), None, Some(previous)) if same_counts(total, previous) => None,
        (Some(total), None, Some(previous)) if !monotonic(total, previous) => {
            Some(Delta::Baseline(total))
        }
        (Some(total), None, Some(previous)) => {
            Some(Delta::Event(subtract(total, previous), Some(total)))
        }
        (Some(total), None, None) => Some(Delta::Event(total, Some(total))),
        (None, Some(last), Some(previous)) => Some(Delta::Event(last, Some(add(previous, last)))),
        (None, Some(last), None) => Some(Delta::Event(last, None)),
        (None, None, _) => None,
    }
}

fn extract_model(value: &Value) -> Option<String> {
    value
        .get("model")
        .or_else(|| value.get("model_name"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| value.get("info").and_then(extract_model))
        .or_else(|| value.get("metadata").and_then(extract_model))
}

fn usage_tuple(usage: Option<RawUsage>) -> String {
    usage
        .map(|usage| {
            format!(
                "{},{},{},{},{}",
                usage.input, usage.cached_input, usage.output, usage.reasoning, usage.total
            )
        })
        .unwrap_or_default()
}

fn parse_codex(path: &Path) -> Result<Vec<UsageEvent>> {
    let file = File::open(path)?;
    let mut session_id = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string();
    let mut session_cwd: Option<String> = None;
    let mut current_cwd: Option<String> = None;
    let mut current_model: Option<String> = None;
    let mut previous_totals: Option<RawUsage> = None;
    let mut events = Vec::new();

    for line in BufReader::new(file).lines() {
        let line = line.with_context(|| format!("read usage transcript {}", path.display()))?;
        let interesting = line.contains("\"type\":\"session_meta\"")
            || line.contains("\"type\":\"turn_context\"")
            || (line.contains("\"type\":\"event_msg\"")
                && line.contains("\"type\":\"token_count\""));
        if !interesting {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let payload = &record["payload"];
        match record.get("type").and_then(Value::as_str) {
            Some("session_meta") => {
                if let Some(id) = payload
                    .get("id")
                    .or_else(|| payload.get("session_id"))
                    .and_then(Value::as_str)
                {
                    session_id = id.to_string();
                }
                session_cwd = payload
                    .get("cwd")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if current_cwd.is_none() {
                    current_cwd.clone_from(&session_cwd);
                }
            }
            Some("turn_context") => {
                if let Some(cwd) = payload.get("cwd").and_then(Value::as_str) {
                    current_cwd = Some(cwd.to_string());
                }
                if let Some(model) = extract_model(payload) {
                    current_model = Some(model);
                }
            }
            Some("event_msg")
                if payload.get("type").and_then(Value::as_str) == Some("token_count") =>
            {
                let Some(timestamp) = record.get("timestamp").and_then(Value::as_str) else {
                    continue;
                };
                let Some((timestamp_ms, day)) = time_parts(timestamp) else {
                    continue;
                };
                let Some(info) = payload.get("info").and_then(Value::as_object) else {
                    continue;
                };
                let total = info.get("total_token_usage").and_then(raw_usage);
                let last = info.get("last_token_usage").and_then(raw_usage);
                let Some(resolved) = codex_delta(total, last, previous_totals) else {
                    continue;
                };
                let (mut delta, next) = match resolved {
                    Delta::Baseline(next) => {
                        previous_totals = Some(next);
                        continue;
                    }
                    Delta::Event(delta, next) => (delta, next),
                };
                delta.cached_input = delta.cached_input.min(delta.input);
                if delta.input == 0
                    && delta.cached_input == 0
                    && delta.output == 0
                    && delta.reasoning == 0
                    && delta.total == 0
                {
                    continue;
                }
                previous_totals = next;
                let model = extract_model(payload).or_else(|| current_model.clone());
                let cwd = current_cwd.clone().or_else(|| session_cwd.clone());
                let project = project_label(cwd.as_deref());
                events.push(UsageEvent {
                    provider: Provider::Codex,
                    session_id: session_id.clone(),
                    timestamp: timestamp.to_string(),
                    timestamp_ms,
                    day,
                    model: model.clone(),
                    cwd,
                    project,
                    event_key: Some(format!(
                        "{}|{}|{}",
                        timestamp,
                        usage_tuple(total),
                        usage_tuple(last)
                    )),
                    new_input_tokens: delta.input.saturating_sub(delta.cached_input),
                    output_tokens: delta.output,
                    cache_read_tokens: delta.cached_input,
                    cache_write_tokens: 0,
                    cache_tokens: delta.cached_input,
                    reasoning_tokens: delta.reasoning,
                    total_tokens: delta.total,
                });
            }
            _ => {}
        }
    }
    Ok(events)
}

fn number(value: &Value) -> u64 {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|number| number.try_into().ok()))
        .or_else(|| {
            value
                .as_f64()
                .filter(|number| number.is_finite() && *number >= 0.0)
                .map(|number| number as u64)
        })
        .or_else(|| value.as_str().and_then(|number| number.parse().ok()))
        .unwrap_or(0)
}

fn time_parts(timestamp: &str) -> Option<(i64, String)> {
    let parsed = DateTime::parse_from_rfc3339(timestamp).ok()?;
    let local = parsed.with_timezone(&Local);
    Some((
        parsed.timestamp_millis(),
        local.format("%Y-%m-%d").to_string(),
    ))
}

fn project_label(cwd: Option<&str>) -> String {
    let Some(cwd) = cwd else {
        return "Unknown location".into();
    };
    let parts: Vec<_> = cwd
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect();
    match parts.as_slice() {
        [] => cwd.to_string(),
        [only] => only.clone(),
        _ => parts[parts.len() - 2..].join("/"),
    }
}

#[derive(Debug, Default)]
struct UsageScope {
    roots: Vec<UsageScopeRoot>,
}

#[derive(Debug)]
struct UsageScopeRoot {
    match_path: String,
    identity: String,
}

impl UsageScope {
    fn from_paths(paths: impl IntoIterator<Item = PathBuf>) -> Self {
        let mut roots = HashMap::new();
        for path in paths {
            let raw = normalize_path(&path.to_string_lossy());
            if raw.is_empty() {
                continue;
            }
            let canonical = fs::canonicalize(&path)
                .map(|path| normalize_path(&path.to_string_lossy()))
                .unwrap_or_else(|_| raw.clone());
            roots.insert(raw, canonical.clone());
            roots.insert(canonical.clone(), canonical);
        }
        let mut roots = roots
            .into_iter()
            .map(|(match_path, identity)| UsageScopeRoot {
                match_path,
                identity,
            })
            .collect::<Vec<_>>();
        roots.sort_by_key(|root| std::cmp::Reverse(root.match_path.len()));
        Self { roots }
    }

    fn contains(&self, cwd: Option<&str>) -> bool {
        self.attribution(cwd).is_some()
    }

    fn attribution(&self, cwd: Option<&str>) -> Option<&str> {
        let cwd = cwd?;
        let cwd = normalize_path(cwd);
        self.roots.iter().find_map(|root| {
            (cwd == root.match_path
                || cwd
                    .strip_prefix(&root.match_path)
                    .is_some_and(|rest| rest.starts_with('/')))
            .then_some(root.identity.as_str())
        })
    }
}

fn normalize_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    if normalized.is_empty() && (path.starts_with('/') || path.starts_with('\\')) {
        "/".into()
    } else {
        normalized.to_string()
    }
}

fn predecessor_data_root() -> Option<PathBuf> {
    dirs::config_dir().map(|root| root.join("terminalx"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageScopeCache {
    #[serde(default)]
    daily_aggregates: Vec<UsageScopeRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageScopeRow {
    #[serde(default)]
    worktree_id: Option<String>,
}

fn usage_scope() -> Result<UsageScope> {
    let mut paths = Vec::new();
    let (projects, _) = crate::store::projects::list()?;
    for project in projects {
        let root = PathBuf::from(&project.path);
        paths.push(root.clone());
        match crate::git::list_worktrees(&root) {
            Ok(worktrees) => {
                paths.extend(worktrees.into_iter().map(|(path, _)| PathBuf::from(path)));
            }
            Err(_) if !root.try_exists()? => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("list usage worktrees for {}", root.display()))
            }
        }
    }
    paths.extend(
        crate::store::index::load()?
            .into_iter()
            .map(|session| PathBuf::from(session.cwd)),
    );
    if let Some(root) = predecessor_data_root() {
        for name in ["terminalx-claude-usage.json", "terminalx-codex-usage.json"] {
            read_usage_scope_cache(&root.join(name), &mut paths)?;
        }
    }
    Ok(UsageScope::from_paths(paths))
}

fn read_usage_scope_cache(path: &Path, paths: &mut Vec<PathBuf>) -> Result<()> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error).with_context(|| format!("read usage scope {}", path.display()))
        }
    };
    let cache: UsageScopeCache = serde_json::from_reader(file)
        .with_context(|| format!("parse usage scope {}", path.display()))?;
    paths.extend(cache.daily_aggregates.into_iter().filter_map(|entry| {
        entry
            .worktree_id
            .and_then(|id| id.split_once("::").map(|(_, path)| PathBuf::from(path)))
    }));
    Ok(())
}

fn overview_cutoff(reference: DateTime<Local>) -> String {
    reference
        .date_naive()
        .checked_sub_days(Days::new(OVERVIEW_DAYS - 1))
        .unwrap_or_else(|| reference.date_naive())
        .format("%Y-%m-%d")
        .to_string()
}

#[derive(Default)]
struct SessionEligibility {
    last_timestamp_ms: i64,
    last_day: String,
    has_scoped_location: bool,
}

#[derive(Default)]
struct CostBucket {
    new_input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

impl CostBucket {
    fn add(&mut self, event: &UsageEvent) {
        self.new_input = self.new_input.saturating_add(event.new_input_tokens);
        self.output = self.output.saturating_add(event.output_tokens);
        self.cache_read = self.cache_read.saturating_add(event.cache_read_tokens);
        self.cache_write = self.cache_write.saturating_add(event.cache_write_tokens);
    }
}

#[derive(Default)]
struct ProviderAccumulator {
    sessions: usize,
    activity_count: usize,
    new_input: u64,
    output: u64,
    cache: u64,
    reasoning: u64,
    total: u64,
    cost: f64,
    has_cost: bool,
    partial_cost: bool,
    model_tokens: BTreeMap<String, u64>,
    project_tokens: BTreeMap<String, u64>,
}

impl ProviderAccumulator {
    fn add(&mut self, event: &UsageEvent) {
        self.activity_count += 1;
        self.new_input = self.new_input.saturating_add(event.new_input_tokens);
        self.output = self.output.saturating_add(event.output_tokens);
        self.cache = self.cache.saturating_add(event.cache_tokens);
        self.reasoning = self.reasoning.saturating_add(event.reasoning_tokens);
        self.total = self.total.saturating_add(event.total_tokens);
        let model_weight = match event.provider {
            Provider::Claude => event.new_input_tokens.saturating_add(event.output_tokens),
            Provider::Codex => event.total_tokens,
        };
        let model = event.model.as_deref().unwrap_or("Unknown model");
        let model_total = self.model_tokens.entry(model.into()).or_default();
        *model_total = model_total.saturating_add(model_weight);
        let project_total = self
            .project_tokens
            .entry(event.project.clone())
            .or_default();
        *project_total = project_total.saturating_add(model_weight);
    }

    fn add_cost(&mut self, cost: Option<f64>) {
        match cost {
            Some(cost) => {
                self.cost += cost;
                self.has_cost = true;
            }
            None => self.partial_cost = true,
        }
    }

    fn provider(self, id: &str, label: &str, activity_label: &str) -> ProviderUsage {
        ProviderUsage {
            id: id.into(),
            label: label.into(),
            enabled: true,
            has_data: self.activity_count > 0 || self.sessions > 0,
            last_model: top_key(&self.model_tokens),
            last_project: top_key(&self.project_tokens),
            total_tokens: self.total,
            sessions: self.sessions,
            activity_count: self.activity_count,
            activity_label: activity_label.into(),
            estimated_cost_usd: self.has_cost.then_some(self.cost),
            has_partial_cost: self.partial_cost,
        }
    }
}

fn top_key(totals: &BTreeMap<String, u64>) -> Option<String> {
    totals
        .iter()
        .max_by_key(|(_, tokens)| *tokens)
        .map(|(key, _)| key.clone())
}

fn aggregate(
    files: &[CachedFile],
    app: AppStats,
    scope: &UsageScope,
    cutoff: &str,
) -> StatsUsageSnapshot {
    let mut claude = ProviderAccumulator::default();
    let mut codex = ProviderAccumulator::default();
    let mut seen = HashSet::<(Provider, String)>::new();
    let mut events = Vec::new();
    for file in files {
        for event in &file.events {
            if event
                .event_key
                .as_ref()
                .is_some_and(|key| !seen.insert((event.provider, key.clone())))
            {
                continue;
            }
            events.push(event);
        }
    }

    let mut sessions = HashMap::<(Provider, String), SessionEligibility>::new();
    for event in &events {
        let session = sessions
            .entry((event.provider, event.session_id.clone()))
            .or_default();
        session.has_scoped_location |= scope.contains(event.cwd.as_deref());
        if session.last_day.is_empty() || event.timestamp_ms > session.last_timestamp_ms {
            session.last_timestamp_ms = event.timestamp_ms;
            session.last_day.clone_from(&event.day);
        }
    }
    for ((provider, _), session) in sessions {
        if session.has_scoped_location && session.last_day.as_str() >= cutoff {
            match provider {
                Provider::Claude => claude.sessions += 1,
                Provider::Codex => codex.sessions += 1,
            }
        }
    }

    let mut daily = BTreeMap::<String, UsageDay>::new();
    let mut new_input_tokens = 0_u64;
    let mut output_tokens = 0_u64;
    let mut cache_tokens = 0_u64;
    let mut reasoning_tokens = 0_u64;
    let mut cost_buckets =
        BTreeMap::<(Provider, String, Option<String>, String), CostBucket>::new();
    for event in events {
        if event.day.as_str() < cutoff {
            continue;
        }
        let Some(location) = scope.attribution(event.cwd.as_deref()) else {
            continue;
        };
        match event.provider {
            Provider::Claude => claude.add(event),
            Provider::Codex => codex.add(event),
        }
        cost_buckets
            .entry((
                event.provider,
                event.day.clone(),
                event.model.clone(),
                location.into(),
            ))
            .or_default()
            .add(event);
        new_input_tokens = new_input_tokens.saturating_add(event.new_input_tokens);
        output_tokens = output_tokens.saturating_add(event.output_tokens);
        cache_tokens = cache_tokens.saturating_add(event.cache_tokens);
        reasoning_tokens = reasoning_tokens.saturating_add(event.reasoning_tokens);
        let day = daily.entry(event.day.clone()).or_insert_with(|| UsageDay {
            day: event.day.clone(),
            ..UsageDay::default()
        });
        day.total_tokens = day.total_tokens.saturating_add(event.total_tokens);
        match event.provider {
            Provider::Claude => {
                day.claude_tokens = day.claude_tokens.saturating_add(event.total_tokens)
            }
            Provider::Codex => {
                day.codex_tokens = day.codex_tokens.saturating_add(event.total_tokens)
            }
        }
    }

    for ((provider, _, model, _), bucket) in cost_buckets {
        let cost = match provider {
            Provider::Claude => pricing::claude_cost(
                model.as_deref(),
                bucket.new_input,
                bucket.output,
                bucket.cache_read,
                bucket.cache_write,
            ),
            Provider::Codex => pricing::codex_cost(
                model.as_deref(),
                bucket.new_input.saturating_add(bucket.cache_read),
                bucket.cache_read,
                bucket.output,
            ),
        };
        match provider {
            Provider::Claude => claude.add_cost(cost),
            Provider::Codex => codex.add_cost(cost),
        }
    }

    let claude = claude.provider("claude", "Claude", "turns");
    let codex = codex.provider("codex", "Codex", "events");
    let total_tokens = claude.total_tokens.saturating_add(codex.total_tokens);
    let known_cost =
        claude.estimated_cost_usd.unwrap_or(0.0) + codex.estimated_cost_usd.unwrap_or(0.0);
    let estimated_cost_usd = (claude.estimated_cost_usd.is_some()
        || codex.estimated_cost_usd.is_some())
    .then_some(known_cost);
    let cache_denominator = new_input_tokens.saturating_add(cache_tokens);
    let active_days = daily.values().filter(|day| day.total_tokens > 0).count();
    let providers = vec![
        claude,
        codex,
        off_provider("cursor", "Cursor Agent"),
        off_provider("opencode", "OpenCode"),
    ];
    StatsUsageSnapshot {
        app,
        total_tokens,
        estimated_cost_usd,
        has_partial_cost: providers
            .iter()
            .any(|provider| provider.has_data && provider.has_partial_cost),
        active_days,
        cache_share: (cache_denominator > 0)
            .then_some(cache_tokens as f64 / cache_denominator as f64),
        new_input_tokens,
        output_tokens,
        cache_tokens,
        reasoning_tokens,
        daily: daily.into_values().collect(),
        providers,
        updated_at: now_ms(),
    }
}

fn off_provider(id: &str, label: &str) -> ProviderUsage {
    ProviderUsage {
        id: id.into(),
        label: label.into(),
        enabled: false,
        has_data: false,
        last_model: None,
        last_project: None,
        total_tokens: 0,
        sessions: 0,
        activity_count: 0,
        activity_label: "events".into(),
        estimated_cost_usd: None,
        has_partial_cost: false,
    }
}

fn app_stats() -> Result<AppStats> {
    let sessions = crate::store::index::load()?;
    let agents_spawned = sessions.iter().map(|session| session.tabs.len()).sum();
    let tracking_since = sessions.iter().map(|session| session.created.clone()).min();
    let mut agent_time_ms = 0_u64;
    for session in &sessions {
        for tab in &session.tabs {
            for event in crate::store::read_lines::<crate::events::AgentEvent>(
                &crate::store::log_path(&session.id, &tab.id)?,
            )? {
                if let crate::events::Payload::TurnCompleted {
                    duration_ms: Some(duration),
                    ..
                } = event.payload
                {
                    agent_time_ms = agent_time_ms.saturating_add(duration);
                }
            }
        }
    }
    let prs_created = read_pr_history()?.urls.len();
    Ok(AppStats {
        agents_spawned,
        agent_time_ms,
        prs_created,
        tracking_since,
    })
}

static PR_LOCK: Mutex<()> = Mutex::new(());

fn read_pr_history() -> Result<PrHistory> {
    let path = crate::store::root()?.join(PR_FILE);
    Ok(crate::store::read_json(&path)?.unwrap_or_default())
}

/// Count a successful PR creation once, whatever app surface initiated it.
pub fn record_pr(url: &str) -> Result<()> {
    if url.trim().is_empty() {
        return Ok(());
    }
    let _guard = PR_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let path = crate::store::root()?.join(PR_FILE);
    let mut history: PrHistory = crate::store::read_json(&path)?.unwrap_or_default();
    if !history.urls.iter().any(|known| known == url) {
        history.urls.push(url.to_string());
        crate::store::write_json(&path, &history)?;
    }
    Ok(())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn test_event(
        provider: Provider,
        session_id: &str,
        day: &str,
        cwd: &str,
        total_tokens: u64,
    ) -> UsageEvent {
        UsageEvent {
            provider,
            session_id: session_id.into(),
            timestamp: format!("{day}T12:00:00Z"),
            timestamp_ms: DateTime::parse_from_rfc3339(&format!("{day}T12:00:00Z"))
                .unwrap()
                .timestamp_millis(),
            day: day.into(),
            model: Some("gpt-5.6-sol".into()),
            cwd: Some(cwd.into()),
            project: project_label(Some(cwd)),
            event_key: None,
            new_input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: total_tokens,
            cache_write_tokens: 0,
            cache_tokens: total_tokens,
            reasoning_tokens: 0,
            total_tokens,
        }
    }

    fn cached(events: Vec<UsageEvent>) -> CachedFile {
        CachedFile {
            path: "fixture.jsonl".into(),
            provider: events
                .first()
                .map(|event| event.provider)
                .unwrap_or(Provider::Codex),
            modified_nanos: 1,
            size: 1,
            events,
        }
    }

    #[test]
    fn terminalx_fixture_totals_match_hand_calculation() {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/stats/fixtures/parity");
        let files = [
            ("claude.jsonl", Provider::Claude),
            ("claude-fork.jsonl", Provider::Claude),
            ("codex.jsonl", Provider::Codex),
            ("codex-shell.jsonl", Provider::Codex),
        ]
        .into_iter()
        .map(|(name, provider)| {
            let path = fixtures.join(name);
            CachedFile {
                events: parse_file(&path, provider).unwrap(),
                path,
                provider,
                modified_nanos: 1,
                size: 1,
            }
        })
        .collect::<Vec<_>>();

        let reference = DateTime::parse_from_rfc3339("2026-09-03T12:00:00Z")
            .unwrap()
            .with_timezone(&Local);
        let scope = UsageScope::from_paths([PathBuf::from("/fixtures/terminalx-worktree")]);
        let snapshot = aggregate(
            &files,
            AppStats::default(),
            &scope,
            &overview_cutoff(reference),
        );

        // Claude: 2 input + 9 output + 20 cache read + 3 cache write = 34.
        // Codex: 100 input (80 cached) + 25 output = 125 total; reasoning is
        // already inside output. The old and off-worktree rows do not count.
        assert_eq!(snapshot.total_tokens, 159);
        assert_eq!(snapshot.providers[0].sessions, 1);
        assert_eq!(snapshot.providers[0].activity_count, 1);
        assert_eq!(snapshot.providers[1].sessions, 1);
        assert_eq!(snapshot.providers[1].activity_count, 1);
        assert_eq!(snapshot.active_days, 1);
        assert_eq!(snapshot.new_input_tokens, 22);
        assert_eq!(snapshot.output_tokens, 34);
        assert_eq!(snapshot.cache_tokens, 103);
        assert_eq!(snapshot.reasoning_tokens, 10);
        assert!((snapshot.estimated_cost_usd.unwrap() - 0.001_153_75).abs() < 0.000_000_01);
    }

    #[test]
    fn overview_scope_accepts_exact_and_descendant_paths_only() {
        let scope = UsageScope::from_paths([PathBuf::from("/work/repo")]);
        assert!(scope.contains(Some("/work/repo")));
        assert!(scope.contains(Some("/work/repo/feature/src")));
        assert!(!scope.contains(Some("/work/repository")));
        assert!(!scope.contains(Some("/work/other")));
    }

    #[cfg(unix)]
    #[test]
    fn canonical_path_aliases_share_one_scope_identity() {
        let dir = tempfile::tempdir().unwrap();
        let worktree = dir.path().join("worktree");
        let alias = dir.path().join("alias");
        fs::create_dir(&worktree).unwrap();
        std::os::unix::fs::symlink(&worktree, &alias).unwrap();
        let scope = UsageScope::from_paths([worktree.clone(), alias.clone()]);

        assert_eq!(
            scope.attribution(worktree.to_str()),
            scope.attribution(alias.to_str())
        );
    }

    #[test]
    fn recent_session_with_any_scoped_location_counts_once() {
        let scope = UsageScope::from_paths([PathBuf::from("/work/repo")]);
        let files = [cached(vec![
            test_event(
                Provider::Codex,
                "mixed-location",
                "2026-08-04",
                "/work/repo",
                100,
            ),
            test_event(
                Provider::Codex,
                "mixed-location",
                "2026-09-03",
                "/tmp/shell",
                200,
            ),
        ])];
        let snapshot = aggregate(&files, AppStats::default(), &scope, "2026-08-05");
        assert_eq!(snapshot.providers[1].sessions, 1);
        assert_eq!(snapshot.providers[1].activity_count, 0);
        assert_eq!(snapshot.total_tokens, 0);
    }

    #[test]
    fn pricing_tiers_apply_to_each_daily_model_location_bucket() {
        let scope = UsageScope::from_paths([PathBuf::from("/work/repo")]);
        let files = [cached(vec![
            test_event(Provider::Codex, "one", "2026-09-03", "/work/repo", 200_000),
            test_event(
                Provider::Codex,
                "two",
                "2026-09-03",
                "/work/repo/feature",
                200_000,
            ),
        ])];
        let snapshot = aggregate(&files, AppStats::default(), &scope, "2026-08-05");
        assert!((snapshot.estimated_cost_usd.unwrap() - 0.264).abs() < 0.000_001);
    }

    #[test]
    fn discovers_system_shared_and_account_codex_histories() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let store = root.path().join("store");
        let predecessor = root.path().join("predecessor");
        let paths = [
            home.join(".claude/projects/project.jsonl"),
            home.join(".claude/transcripts/transcript.jsonl"),
            home.join(".codex/sessions/system.jsonl"),
            store.join("codex/sessions/shared.jsonl"),
            store.join("codex-accounts/current/home/sessions/account.jsonl"),
            predecessor.join("codex-runtime-home/home/sessions/shared.jsonl"),
            predecessor.join("codex-accounts/existing/home/sessions/account.jsonl"),
        ];
        for path in paths {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            File::create(path).unwrap();
        }

        let sources = discover_sources_at(&home, &store, Some(&predecessor)).unwrap();
        assert_eq!(sources.len(), 7);
        assert_eq!(
            sources
                .iter()
                .filter(|(_, provider)| *provider == Provider::Claude)
                .count(),
            2
        );
        assert_eq!(
            sources
                .iter()
                .filter(|(_, provider)| *provider == Provider::Codex)
                .count(),
            5
        );
    }

    #[test]
    fn transcript_paths_use_string_lexical_order() {
        let root = tempfile::tempdir().unwrap();
        let projects = root.path().join(".claude/projects");
        let parent = projects.join("session.jsonl");
        let child = projects.join("session/subagents/agent.jsonl");
        fs::create_dir_all(child.parent().unwrap()).unwrap();
        File::create(&parent).unwrap();
        File::create(&child).unwrap();

        let sources = discover_sources_at(root.path(), root.path(), None).unwrap();
        assert_eq!(sources[0].0, fs::canonicalize(parent).unwrap());
        assert_eq!(sources[1].0, fs::canonicalize(child).unwrap());
    }

    #[test]
    fn claude_sidechain_turns_share_the_parent_session() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent.jsonl");
        let mut file = File::create(&path).unwrap();
        for (message, sidechain) in [("parent", false), ("child", true)] {
            writeln!(file, "{}", serde_json::json!({
                "type": "assistant", "sessionId": "shared", "timestamp": "2026-09-03T10:00:00Z",
                "cwd": "/work/repo", "isSidechain": sidechain, "agentId": "worker",
                "requestId": message, "message": { "id": message, "model": "claude-opus-5", "usage": {
                    "input_tokens": 1, "output_tokens": 1, "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0
                }}
            })).unwrap();
        }
        let scope = UsageScope::from_paths([PathBuf::from("/work/repo")]);
        let snapshot = aggregate(
            &[CachedFile {
                events: parse_claude(&path).unwrap(),
                path,
                provider: Provider::Claude,
                modified_nanos: 1,
                size: 1,
            }],
            AppStats::default(),
            &scope,
            "2026-08-05",
        );
        assert_eq!(snapshot.providers[0].sessions, 1);
        assert_eq!(snapshot.providers[0].activity_count, 2);
    }

    #[test]
    fn claude_repeated_stream_rows_count_the_largest_usage_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("session.jsonl");
        let mut file = File::create(&path).unwrap();
        for (index, output) in [4, 9].into_iter().enumerate() {
            writeln!(file, "{}", serde_json::json!({
                "type": "assistant", "sessionId": "s1", "timestamp": format!("2026-09-0{}T10:00:00Z", index + 2), "cwd": format!("/code/raccoon/{index}"),
                "requestId": "r1", "message": { "id": "m1", "model": "claude-opus-5", "usage": {
                    "input_tokens": 2, "output_tokens": output, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 3
                }}
            })).unwrap();
        }
        let events = parse_claude(&path).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].total_tokens, 34);
        assert_eq!(events[0].day, "2026-09-02");
        assert_eq!(events[0].cwd.as_deref(), Some("/code/raccoon/0"));
    }

    #[test]
    fn codex_uses_last_usage_and_keeps_reasoning_inside_output_total() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"session_meta","payload":{"id":"c1","cwd":"/code/raccoon"}})
        )
        .unwrap();
        writeln!(
            file,
            "{}",
            serde_json::json!({"type":"turn_context","payload":{"model":"gpt-5.6-sol"}})
        )
        .unwrap();
        writeln!(file, "{}", serde_json::json!({
            "timestamp":"2026-09-03T10:00:00Z", "type":"event_msg", "payload":{"type":"token_count","info":{
                "total_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":25,"reasoning_output_tokens":10,"total_tokens":125},
                "last_token_usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":25,"reasoning_output_tokens":10,"total_tokens":125}
            }}
        })).unwrap();
        let events = parse_codex(&path).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].new_input_tokens, 20);
        assert_eq!(events[0].cache_tokens, 80);
        assert_eq!(events[0].output_tokens, 25);
        assert_eq!(events[0].reasoning_tokens, 10);
        assert_eq!(events[0].total_tokens, 125);
    }

    #[test]
    fn copied_provider_events_are_deduplicated_across_files() {
        let event = UsageEvent {
            provider: Provider::Codex,
            session_id: "one".into(),
            timestamp: "2026-09-03T10:00:00Z".into(),
            timestamp_ms: 1,
            day: "2026-09-03".into(),
            model: Some("gpt-5.6-sol".into()),
            cwd: Some("/code/raccoon".into()),
            project: "code/raccoon".into(),
            event_key: Some("same".into()),
            new_input_tokens: 20,
            output_tokens: 5,
            cache_read_tokens: 80,
            cache_write_tokens: 0,
            cache_tokens: 80,
            reasoning_tokens: 2,
            total_tokens: 105,
        };
        let file = |name: &str| CachedFile {
            path: name.into(),
            provider: Provider::Codex,
            modified_nanos: 1,
            size: 1,
            events: vec![event.clone()],
        };
        let scope = UsageScope::from_paths([PathBuf::from("/code/raccoon")]);
        let snapshot = aggregate(
            &[file("a"), file("b")],
            AppStats::default(),
            &scope,
            "2026-08-05",
        );
        assert_eq!(snapshot.total_tokens, 105);
        assert_eq!(snapshot.providers[1].sessions, 1);
    }
    #[test]
    fn unchanged_projections_are_reaggregated_at_local_day_rollover() {
        let scope = UsageScope::from_paths([PathBuf::from("/work/repo")]);
        let files = [cached(vec![test_event(
            Provider::Codex,
            "boundary",
            "2026-08-05",
            "/work/repo",
            100,
        )])];
        let before = chrono::TimeZone::with_ymd_and_hms(&Local, 2026, 9, 3, 12, 0, 0)
            .single()
            .unwrap();
        let after = before + chrono::Duration::days(1);
        let first = aggregate(
            &files,
            AppStats::default(),
            &scope,
            &overview_cutoff(before),
        );
        let next = aggregate(&files, AppStats::default(), &scope, &overview_cutoff(after));
        assert_eq!(first.total_tokens, 100);
        assert_eq!(next.total_tokens, 0);
        assert_eq!(next.active_days, 0);
    }

    #[test]
    fn source_failures_are_not_confirmed_removals() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        assert!(optional_directory(&missing).unwrap().is_none());
        let blocked = dir.path().join("not-a-directory");
        fs::write(&blocked, b"blocked").unwrap();
        assert!(optional_directory(&blocked).is_err());
        let transcript = dir.path().join("invalid-utf8.jsonl");
        fs::write(&transcript, [0xff, 0xfe, b'\n']).unwrap();
        assert!(parse_claude(&transcript).is_err());
        assert!(parse_codex(&transcript).is_err());
        assert!(scan_snapshot_with(
            dir.path(),
            || Err(anyhow::anyhow!("discovery failed")),
            || Ok((AppStats::default(), UsageScope::default()))
        )
        .is_err());
        assert!(scan_snapshot_with(
            dir.path(),
            || Ok(vec![(transcript, Provider::Claude)]),
            || Ok((AppStats::default(), UsageScope::default()))
        )
        .is_err());
        assert!(!dir.path().join(CACHE_FILE).exists());
    }

    #[test]
    fn app_read_failure_does_not_publish_a_scan_cache_and_confirmed_removal_invalidates() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("claude.jsonl");
        fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("src/stats/fixtures/parity/claude.jsonl"),
            &transcript,
        )
        .unwrap();
        let sources = || Ok(vec![(transcript.clone(), Provider::Claude)]);
        assert!(
            scan_snapshot_with(dir.path(), sources, || Err(anyhow::anyhow!(
                "app read failed"
            )))
            .is_err()
        );
        assert!(!dir.path().join(CACHE_FILE).exists());
        scan_snapshot_with(dir.path(), sources, || {
            Ok((AppStats::default(), UsageScope::default()))
        })
        .unwrap();
        let before: ScanCache = crate::store::read_json(&dir.path().join(CACHE_FILE))
            .unwrap()
            .unwrap();
        assert_eq!(before.files.len(), 1);
        fs::remove_file(transcript).unwrap();
        scan_snapshot_with(
            dir.path(),
            || Ok(vec![]),
            || Ok((AppStats::default(), UsageScope::default())),
        )
        .unwrap();
        let after: ScanCache = crate::store::read_json(&dir.path().join(CACHE_FILE))
            .unwrap()
            .unwrap();
        assert!(after.files.is_empty());
    }
}
