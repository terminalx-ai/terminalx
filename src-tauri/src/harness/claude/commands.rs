//! The slash-command list, read off a throwaway child.
//!
//! `system/init` names commands only once a turn is under way and carries bare
//! names; the `initialize` control request answers before any turn with a
//! description and argument hint per command. So a child is spawned, asked
//! once, and killed: ~1.5s, no model call. Cached per directory.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    /// `builtin`, `plugin` or `user`, inferred from the name and description.
    pub source: String,
}

/// Commands the app already owns; letting them through would restart or
/// retitle a session behind the app's back.
const WITHHELD: &[&str] = &["clear", "exit", "quit", "model", "rename", "fast", "resume", "login", "logout"];

const CACHE_TTL: Duration = Duration::from_secs(600);
const MAX_CACHED_CWDS: usize = 64;

#[derive(Default)]
struct CommandCacheState {
    entries: HashMap<String, (Instant, Vec<SlashCommand>)>,
    /// Per-cwd single-flight mutexes so concurrent probes for the same cwd
    /// share one throwaway child instead of spawning duplicates (P-82).
    in_flight: HashMap<String, Arc<Mutex<()>>>,
}

impl CommandCacheState {
    fn get_fresh(&mut self, key: &str, now: Instant, ttl: Duration) -> Option<Vec<SlashCommand>> {
        self.evict_expired(now, ttl);
        self.entries.get(key).map(|(_, v)| v.clone())
    }

    fn evict_expired(&mut self, now: Instant, ttl: Duration) {
        self.entries.retain(|_, (at, _)| now.saturating_duration_since(*at) < ttl);
        self.in_flight.retain(|_, lock| Arc::strong_count(lock) > 1);
    }

    fn insert(&mut self, key: String, now: Instant, ttl: Duration, max_entries: usize, value: Vec<SlashCommand>) {
        self.evict_expired(now, ttl);
        if !self.entries.contains_key(&key) && self.entries.len() >= max_entries {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (at, _))| *at)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(key, (now, value));
    }

    fn flight_lock(&mut self, key: &str) -> Arc<Mutex<()>> {
        self.in_flight
            .entry(key.to_owned())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

fn cache() -> &'static Mutex<CommandCacheState> {
    static C: OnceLock<Mutex<CommandCacheState>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(CommandCacheState::default()))
}

fn list_with<F>(
    state: &Mutex<CommandCacheState>,
    cwd: &Path,
    ttl: Duration,
    max_entries: usize,
    probe_fn: F,
) -> Result<Vec<SlashCommand>>
where
    F: FnOnce(&Path) -> Result<Vec<SlashCommand>>,
{
    let key = cwd.to_string_lossy().into_owned();
    let flight = {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = guard.get_fresh(&key, Instant::now(), ttl) {
            return Ok(cached);
        }
        guard.flight_lock(&key)
    };

    let _flight_guard = flight.lock().unwrap_or_else(|e| e.into_inner());
    {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = guard.get_fresh(&key, Instant::now(), ttl) {
            return Ok(cached);
        }
    }

    let result = probe_fn(cwd);
    if let Ok(ref v) = result {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        guard.insert(key.clone(), Instant::now(), ttl, max_entries, v.clone());
    }
    drop(_flight_guard);
    // Clean up unused single-flight entry once no waiters hold the Arc.
    {
        let mut guard = state.lock().unwrap_or_else(|e| e.into_inner());
        if guard.in_flight.get(&key).is_some_and(|lock| Arc::strong_count(lock) == 2) {
            // Only `flight` (our local Arc) and the map entry remain.
            guard.in_flight.remove(&key);
        }
    }
    result
}

pub fn list(cwd: &Path) -> Result<Vec<SlashCommand>> {
    list_with(cache(), cwd, CACHE_TTL, MAX_CACHED_CWDS, probe)
}

pub fn parse_commands(reply: &Value) -> Vec<SlashCommand> {
    let mut out = Vec::new();
    if let Some(cmds) = reply.pointer("/response/response/commands").or_else(|| reply.pointer("/response/commands")).and_then(|c| c.as_array()) {
        for c in cmds {
            let name = c["name"].as_str().unwrap_or("").to_string();
            if name.is_empty() || WITHHELD.contains(&name.as_str()) {
                continue;
            }
            let description = c["description"].as_str().unwrap_or("").to_string();
            let source = if name.contains(':') {
                "plugin"
            } else if description.ends_with("(user)") || description.ends_with("(project)") {
                "user"
            } else {
                "builtin"
            };
            out.push(SlashCommand {
                name,
                description: description.trim_end_matches("(user)").trim_end_matches("(project)").trim().to_string(),
                argument_hint: c["argumentHint"].as_str().filter(|s| !s.is_empty()).map(String::from),
                source: source.into(),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn probe(cwd: &Path) -> Result<Vec<SlashCommand>> {
    // The reader's own setup is the point here: plugin and user commands come from it.
    // Restrict setting sources to `user` so untrusted repo `.claude/settings.json`
    // hooks, statusLine, apiKeyHelper, or MCP servers can never execute during a probe.
    Ok(parse_commands(&super::ask_initialize(cwd, &["--setting-sources", "user"])?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_withholds() {
        let v: Value = serde_json::from_str(r#"{"type":"control_response","response":{"subtype":"success","request_id":"x","response":{"commands":[{"name":"review","description":"Review a PR","argumentHint":"[pr]"},{"name":"clear","description":"Clear"},{"name":"acme:deploy","description":"Deploy"},{"name":"notes","description":"My notes (user)"}]}}}"#).unwrap();
        let c = parse_commands(&v);
        let names: Vec<_> = c.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["acme:deploy", "notes", "review"]);
        assert_eq!(c[0].source, "plugin");
        assert_eq!(c[1].source, "user");
        assert_eq!(c[1].description, "My notes");
        assert_eq!(c[2].argument_hint.as_deref(), Some("[pr]"));
    }

    #[test]
    fn single_flight_deduplicates_concurrent_probes_and_evicts_expired_and_excess() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Barrier;

        let state = Arc::new(Mutex::new(CommandCacheState::default()));
        let probes = Arc::new(AtomicUsize::new(0));
        let barrier = Arc::new(Barrier::new(3));
        let mut handles = Vec::new();
        for _ in 0..3 {
            let state = Arc::clone(&state);
            let probes = Arc::clone(&probes);
            let barrier = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                list_with(&state, Path::new("/repo/a"), Duration::from_secs(60), 2, |_| {
                    probes.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(Duration::from_millis(30));
                    Ok(vec![SlashCommand {
                        name: "review".into(),
                        description: "Review".into(),
                        argument_hint: None,
                        source: "builtin".into(),
                    }])
                })
                .unwrap()
            }));
        }
        for h in handles {
            assert_eq!(h.join().unwrap().len(), 1);
        }
        assert_eq!(probes.load(Ordering::SeqCst), 1, "concurrent callers must share one probe");

        // Capacity cap evicts oldest entry.
        let _ = list_with(&state, Path::new("/repo/b"), Duration::from_secs(60), 2, |_| Ok(vec![])).unwrap();
        let _ = list_with(&state, Path::new("/repo/c"), Duration::from_secs(60), 2, |_| Ok(vec![])).unwrap();
        assert_eq!(state.lock().unwrap().entries.len(), 2);

        // Expired TTL evicts stale entries and re-probes.
        std::thread::sleep(Duration::from_millis(10));
        let re_probed = AtomicUsize::new(0);
        let _ = list_with(&state, Path::new("/repo/c"), Duration::from_millis(1), 2, |_| {
            re_probed.fetch_add(1, Ordering::SeqCst);
            Ok(vec![])
        })
        .unwrap();
        assert_eq!(re_probed.load(Ordering::SeqCst), 1);
    }
}
