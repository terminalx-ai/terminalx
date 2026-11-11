use super::*;
use crate::stats::pricing;
use std::collections::HashMap;

const CLAUDE: &str = include_str!("harness/claude/fixtures/interactive_session.jsonl");
const CODEX: &str = include_str!("harness/codex/fixtures/rollout.jsonl");
const HAIKU: &str = "claude-haiku-4-5-20251001";

/// Transcripts in a scratch folder, by conversation id.
#[derive(Default)]
struct Files {
    claude: HashMap<String, PathBuf>,
    codex: HashMap<String, PathBuf>,
}

impl Transcripts for Files {
    fn claude(&self, _cwd: &str, id: &str) -> Option<PathBuf> {
        self.claude.get(id).cloned()
    }
    fn codex(&self, id: &str) -> Option<PathBuf> {
        self.codex.get(id).cloned()
    }
}

fn tab(harness: &str, conversation: &str) -> TabEntry {
    let mut tab = crate::session_ops::new_tab_entry(&crate::session_ops::NewTab {
        transport: Default::default(),
        harness: harness.into(),
        model: String::new(),
        effort: None,
        permission_mode: None,
    });
    tab.provider_session_id = Some(conversation.into());
    tab
}

fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let path = dir.join(name);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, text).unwrap();
    path
}

/// An assistant record with one request's usage.
fn assistant(uuid: &str, message: &str, model: &str, usage: Value) -> String {
    json!({
        "type": "assistant", "uuid": uuid, "requestId": format!("req_{message}"), "sessionId": "s",
        "timestamp": "2026-11-11T10:00:00.000Z",
        "message": {"id": message, "model": model, "role": "assistant", "content": [{"type": "text", "text": "ok"}], "usage": usage}
    })
    .to_string()
        + "\n"
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

#[test]
fn claude_totals_are_the_sum_of_its_requests_counted_once_per_request() {
    let dir = tempfile::tempdir().unwrap();
    let files = Files { claude: HashMap::from([("c1".into(), write(dir.path(), "c1.jsonl", CLAUDE))]), ..Default::default() };
    let usage = read_tab("/w", &tab("claude", "c1"), &files).unwrap();
    // Two requests, each written twice (thinking, then text).
    assert_eq!(usage.models.len(), 1);
    let row = &usage.models[0];
    assert_eq!(row.model, HAIKU);
    assert_eq!((row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens), (20, 78, 70543, 18351));
    let expected = pricing::claude_request_cost(Some(HAIKU), 10, 40, 26138, 18267, 18267).unwrap()
        + pricing::claude_request_cost(Some(HAIKU), 10, 38, 44405, 84, 84).unwrap();
    assert!(close(row.cost_usd.unwrap(), expected), "{:?} != {expected}", row.cost_usd);
}

#[test]
fn codex_totals_are_the_sum_of_its_token_count_deltas() {
    let dir = tempfile::tempdir().unwrap();
    let files = Files { codex: HashMap::from([("x1".into(), write(dir.path(), "rollout-x1.jsonl", CODEX))]), ..Default::default() };
    let usage = read_tab("/w", &tab("codex", "x1"), &files).unwrap();
    assert_eq!(usage.models.len(), 1);
    let row = &usage.models[0];
    assert_eq!(row.model, "gpt-5.6-sol");
    // The three turns' requests, as the turn mapper counts them per turn.
    assert_eq!((row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens), (7402 + 973 + 8543, 5 + 305 + 253, 10880 + 54528 + 48128, 0));
    let requests = stats::codex_requests(&files.codex["x1"]).unwrap();
    let expected: f64 = requests.iter().map(|request| request.cost_usd.unwrap()).sum();
    assert!(close(row.cost_usd.unwrap(), expected));
}

#[test]
fn cache_reads_are_priced_at_the_cache_read_rate() {
    let dir = tempfile::tempdir().unwrap();
    let text = assistant("u1", "m1", "claude-opus-5-5", json!({"input_tokens": 0, "output_tokens": 0, "cache_read_input_tokens": 1_000_000, "cache_creation_input_tokens": 0}));
    let files = Files { claude: HashMap::from([("c".into(), write(dir.path(), "c.jsonl", &text))]), ..Default::default() };
    let usage = read_tab("/w", &tab("claude", "c"), &files).unwrap();
    // Opus 5.5 reads its cache at $0.20 a million, not its $4 input rate.
    assert!(close(usage.models[0].cost_usd.unwrap(), 0.2));
    assert_eq!(usage.models[0].cache_read_tokens, 1_000_000);
    assert_eq!(usage.models[0].input_tokens, 0);
}

#[test]
fn an_unpriced_model_keeps_its_tokens_and_has_no_cost() {
    let dir = tempfile::tempdir().unwrap();
    let text = assistant("u1", "m1", "claude-opus-5-5", json!({"input_tokens": 1_000_000, "output_tokens": 0}))
        + &assistant("u2", "m2", "claude-nobody-knows-9", json!({"input_tokens": 500, "output_tokens": 70}));
    let files = Files { claude: HashMap::from([("c".into(), write(dir.path(), "c.jsonl", &text))]), ..Default::default() };
    let usage = read_tab("/w", &tab("claude", "c"), &files).unwrap();
    let unknown = usage.models.iter().find(|row| row.model == "claude-nobody-knows-9").unwrap();
    assert_eq!((unknown.input_tokens, unknown.output_tokens, unknown.cost_usd), (500, 70, None));
    let sum = total(&usage.models);
    assert_eq!(sum.input_tokens, 1_000_500);
    assert!(close(sum.cost_usd.unwrap(), 4.0), "the priced model still counts");
    assert_eq!(sum.unpriced_models, ["claude-nobody-knows-9"]);
    // With nothing priced at all the cost is null, never zero.
    let only = total(usage.models.iter().filter(|row| row.cost_usd.is_none()));
    assert_eq!((only.input_tokens, only.cost_usd), (500, None));
    assert_eq!(serde_json::to_value(&only).unwrap()["costUsd"], Value::Null);
    // Nothing used costs nothing.
    assert_eq!(total(&[]).cost_usd, Some(0.0));
}

#[test]
fn a_request_on_an_unpriced_tier_leaves_its_model_without_a_cost() {
    let dir = tempfile::tempdir().unwrap();
    let text = assistant("u1", "m1", "claude-opus-5-5", json!({"input_tokens": 10, "output_tokens": 10}))
        + &assistant("u2", "m2", "claude-opus-5-5", json!({"input_tokens": 10, "output_tokens": 10, "service_tier": "priority"}));
    let files = Files { claude: HashMap::from([("c".into(), write(dir.path(), "c.jsonl", &text))]), ..Default::default() };
    let usage = read_tab("/w", &tab("claude", "c"), &files).unwrap();
    assert_eq!((usage.models[0].input_tokens, usage.models[0].cost_usd), (20, None));
}

#[test]
fn a_fork_does_not_count_the_records_it_copied_from_its_parent() {
    let dir = tempfile::tempdir().unwrap();
    let parent = assistant("p1", "m1", HAIKU, json!({"input_tokens": 100, "output_tokens": 10}));
    let fork = parent.clone() + &assistant("f1", "m2", HAIKU, json!({"input_tokens": 7, "output_tokens": 3}));
    let files = Files {
        claude: HashMap::from([("parent".into(), write(dir.path(), "parent.jsonl", &parent)), ("fork".into(), write(dir.path(), "fork.jsonl", &fork))]),
        ..Default::default()
    };
    let mut forked = tab("claude", "fork");
    forked.fork_from = Some("parent".into());
    let usage = read_tab("/w", &forked, &files).unwrap();
    assert_eq!((usage.models[0].input_tokens, usage.models[0].output_tokens), (7, 3));
    // The parent keeps its own.
    let usage = read_tab("/w", &tab("claude", "parent"), &files).unwrap();
    assert_eq!(usage.models[0].input_tokens, 100);
}

#[test]
fn subagents_and_earlier_conversations_of_the_tab_are_counted() {
    let dir = tempfile::tempdir().unwrap();
    let main = write(dir.path(), "now.jsonl", &assistant("a", "m1", HAIKU, json!({"input_tokens": 1, "output_tokens": 1})));
    write(dir.path(), "now/subagents/agent-1.jsonl", &assistant("b", "m2", "claude-sonnet-5-5", json!({"input_tokens": 2, "output_tokens": 2})));
    let codex = write(dir.path(), "rollout-before.jsonl", CODEX);
    let files = Files { claude: HashMap::from([("now".into(), main)]), codex: HashMap::from([("before".into(), codex)]) };
    let mut held = tab("claude", "now");
    held.follow.history.push(crate::store::index::PastConversation { harness: "codex".into(), provider_session_id: Some("before".into()), ..Default::default() });
    let usage = read_tab("/w", &held, &files).unwrap();
    let models: Vec<&str> = usage.models.iter().map(|row| row.model.as_str()).collect();
    assert_eq!(models.len(), 3);
    for model in [HAIKU, "claude-sonnet-5-5", "gpt-5.6-sol"] {
        assert!(models.contains(&model), "{model} missing from {models:?}");
    }
    // The costliest first: the Codex conversation's 130k prompt tokens.
    assert_eq!(models[0], "gpt-5.6-sol", "{:?}", usage.models);
}

#[test]
fn a_tab_with_no_readable_agent_carries_nothing() {
    assert_eq!(read_tab("/w", &tab("claude", "gone"), &Files::default()), None);
    assert_eq!(read_tab("/w", &tab("opencode", "o"), &Files::default()), None);
}

fn session(tabs: Vec<TabEntry>) -> SessionEntry {
    let mut session: SessionEntry = serde_json::from_value(json!({
        "id": "s1", "projectPath": "/w", "cwd": "/w", "title": "Two models", "created": "2026-11-11T10:00:00Z", "modified": "2026-11-11T10:00:00Z", "tabs": []
    }))
    .unwrap();
    session.tabs = tabs;
    session
}

#[test]
fn a_session_with_two_tabs_on_different_models_reports_both_and_their_sum() {
    let dir = tempfile::tempdir().unwrap();
    let files = Files {
        claude: HashMap::from([("c1".into(), write(dir.path(), "c1.jsonl", CLAUDE))]),
        codex: HashMap::from([("x1".into(), write(dir.path(), "rollout-x1.jsonl", CODEX))]),
    };
    let mut claude_tab = tab("claude", "c1");
    claude_tab.usage = read_tab("/w", &claude_tab, &files);
    let mut codex_tab = tab("codex", "x1");
    codex_tab.usage = read_tab("/w", &codex_tab, &files);
    let (claude_cost, codex_cost) = (claude_tab.usage.as_ref().unwrap().models[0].cost_usd.unwrap(), codex_tab.usage.as_ref().unwrap().models[0].cost_usd.unwrap());
    let entry = session(vec![claude_tab, codex_tab]);
    let report = session_json(&entry);
    assert_eq!(report["tabs"].as_array().unwrap().len(), 2);
    assert_eq!(report["models"].as_array().unwrap().len(), 2);
    assert_eq!(report["total"]["inputTokens"], json!(20 + 7402 + 973 + 8543));
    assert!(close(report["total"]["costUsd"].as_f64().unwrap(), claude_cost + codex_cost));
    assert!(close(estimated_cost(&entry).0.unwrap(), claude_cost + codex_cost));
    assert_eq!(with_cost(&entry)["estimatedCostUnpricedModels"], json!([]));
    assert!(close(with_cost(&entry)["estimatedCostUsd"].as_f64().unwrap(), claude_cost + codex_cost));
    for row in report["tabs"].as_array().unwrap() {
        assert!(row["total"]["costUsd"].as_f64().unwrap() > 0.0);
    }
}

#[test]
fn a_session_nothing_was_read_for_has_a_null_estimate() {
    let entry = session(vec![tab("claude", "c1")]);
    assert_eq!(with_cost(&entry)["estimatedCostUsd"], Value::Null);
    assert_eq!(with_cost(&entry)["estimatedCostUnpricedModels"], json!([]));
    assert_eq!(session_json(&entry)["tabs"], json!([]));
}

#[test]
fn stored_usage_round_trips_through_the_index_entry() {
    let mut entry = tab("claude", "c1");
    entry.usage = Some(TabUsage { models: vec![ModelUsage { model: "m".into(), input_tokens: 1, cost_usd: None, ..Default::default() }], updated: "t".into() });
    let wire = serde_json::to_value(&entry).unwrap();
    assert_eq!(wire["usage"]["models"][0]["costUsd"], Value::Null);
    let back: TabEntry = serde_json::from_value(wire).unwrap();
    assert_eq!(back.usage, entry.usage);
    // An entry written before it has none, and writes none.
    let plain = tab("claude", "c2");
    assert!(serde_json::to_value(&plain).unwrap().get("usage").is_none());
}

#[test]
fn a_partial_estimate_names_the_models_it_leaves_out() {
    let mut priced = tab("claude", "c1");
    priced.usage = Some(TabUsage { models: vec![ModelUsage { model: "claude-opus-5-5".into(), input_tokens: 10, cost_usd: Some(0.5), ..Default::default() }], updated: "t".into() });
    let mut unknown = tab("claude", "c2");
    unknown.usage = Some(TabUsage { models: vec![ModelUsage { model: "claude-new-9".into(), input_tokens: 10, cost_usd: None, ..Default::default() }], updated: "t".into() });
    let entry = with_cost(&session(vec![priced, unknown]));
    assert_eq!(entry["estimatedCostUsd"], json!(0.5));
    assert_eq!(entry["estimatedCostUnpricedModels"], json!(["claude-new-9"]));
}

#[test]
fn a_followed_transcript_is_parsed_on_from_where_the_last_read_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("rollout.jsonl");
    let lines: Vec<&str> = CODEX.lines().collect();
    let cut = lines.iter().position(|line| line.contains("11:51:40")).unwrap();
    // The first turns, and half of a line still being written.
    let mut start = lines[..cut].join("\n") + "\n";
    start.push_str(&lines[cut][..20]);
    std::fs::write(&path, &start).unwrap();
    let before = stats::codex_requests(&path).unwrap();
    let read_to = stats::followed_offset(&path).unwrap();
    assert_eq!(read_to as usize, start.len() - 20, "the unfinished line waits");
    std::fs::write(&path, CODEX).unwrap();
    let after = stats::codex_requests(&path).unwrap();
    assert!(after.len() > before.len());
    assert_eq!(after, stats::codex_requests_whole(&path).unwrap(), "the same as reading it whole");
    assert_eq!(stats::followed_offset(&path).unwrap() as usize, CODEX.len());
    // Rewritten from its start (a reset): read again from scratch.
    // Same length, so only its first bytes tell it apart; its first turn's reading is gone.
    let rewritten = CODEX.replacen("01a061f1-16d4", "11a061f1-16d4", 1).replace("\"type\": \"token_count\", \"info\": {\"total_token_usage\": {\"input_tokens\": 18282", "\"type\": \"token_cuont\", \"info\": {\"total_token_usage\": {\"input_tokens\": 18282");
    assert_eq!(rewritten.len(), CODEX.len());
    std::fs::write(&path, &rewritten).unwrap();
    let again = stats::codex_requests(&path).unwrap();
    assert_eq!(again, stats::codex_requests_whole(&path).unwrap());
    assert_ne!(again, after);
    // Claude: streamed blocks of one request split across reads are still one request.
    let claude = dir.path().join("c.jsonl");
    let records: Vec<&str> = CLAUDE.lines().collect();
    let half = records.len() / 2;
    std::fs::write(&claude, records[..half].join("\n") + "\n").unwrap();
    stats::claude_requests(&claude, &HashSet::new()).unwrap();
    std::fs::write(&claude, CLAUDE).unwrap();
    let requests = stats::claude_requests(&claude, &HashSet::new()).unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests.iter().map(|r| r.output).sum::<u64>(), 78);
}
