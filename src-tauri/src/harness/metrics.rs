//! Request-aware accounting shared by the transcript mappers. Occupancy is
//! still the last request; these counters describe all requests in a turn.
use super::tui::TurnMark;
use crate::events::{Payload, Usage};
use crate::stats::{self, pricing};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TurnUsage {
    requests: BTreeMap<String, ClaudeRequest>,
    total: Usage,
    previous: Option<stats::RawUsage>,
    /// The turn opened and has had no new counter reading yet. Its first
    /// reading is measured by its own `last` (Codex may start its total
    /// again for a turn), unless it repeats the last turn's total: Codex
    /// often opens a turn that way, and that is no request.
    #[serde(default)]
    opened: bool,
    model: Option<String>,
    unpriced_tier: bool,
    started: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ClaudeRequest {
    input: u64,
    output: u64,
    read: u64,
    write: u64,
    hour: u64,
    model: Option<String>,
    unpriced: bool,
}

fn number(value: &Value) -> u64 {
    value.as_u64().unwrap_or(0)
}
fn timestamp(record: &Value) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(record["timestamp"].as_str()?)
        .ok()
        .map(|ts| ts.timestamp_millis())
}

impl TurnUsage {
    /// Called only for records accepted by the mapper (never sidechains or
    /// skipped fork history). A turn start resets totals, not the model.
    pub fn record(&mut self, record: &Value, mark: Option<TurnMark>, out: &mut Vec<Payload>) {
        if mark == Some(TurnMark::Opened) {
            self.requests.clear();
            self.total = Usage::default();
            self.opened = true;
            self.started = timestamp(record);
        }
        let payload = &record["payload"];
        if record["type"] == "turn_context" {
            self.model = payload["model"]
                .as_str()
                .filter(|model| !model.is_empty())
                .map(str::to_owned);
            self.unpriced_tier = stats::nonstandard_tier(payload);
        }
        let mut changed = false;
        if record["type"] == "assistant"
            && record["isApiErrorMessage"] != true
            && record["message"]["model"] != "<synthetic>"
        {
            let usage = &record["message"]["usage"];
            if usage.is_object() {
                let key = match (
                    record["message"]["id"].as_str(),
                    record["requestId"].as_str(),
                    record["uuid"].as_str(),
                ) {
                    (Some(message), Some(request), _) => format!("{message}:{request}"),
                    (Some(message), None, _) => format!("msg:{message}"),
                    (_, _, Some(uuid)) => format!("uuid:{uuid}"),
                    _ => format!("anonymous:{}", self.requests.len()),
                };
                let request = self.requests.entry(key).or_default();
                request.input = request.input.max(number(&usage["input_tokens"]));
                request.output = request.output.max(number(&usage["output_tokens"]));
                request.read = request.read.max(number(&usage["cache_read_input_tokens"]));
                request.write = request
                    .write
                    .max(number(&usage["cache_creation_input_tokens"]));
                request.hour = request.hour.max(
                    number(&usage["cache_creation"]["ephemeral_1h_input_tokens"])
                        .min(request.write),
                );
                request.model = record["message"]["model"].as_str().map(str::to_owned);
                request.unpriced |= stats::nonstandard_tier(usage)
                    || stats::nonstandard_tier(&record["message"])
                    || stats::nonstandard_tier(record)
                    || (usage["cache_creation"].is_object()
                        && number(&usage["cache_creation"]["ephemeral_5m_input_tokens"])
                            .saturating_add(number(
                                &usage["cache_creation"]["ephemeral_1h_input_tokens"],
                            ))
                            != number(&usage["cache_creation_input_tokens"]));
                self.total = Usage {
                    input_tokens: Some(0),
                    output_tokens: Some(0),
                    cache_read_tokens: Some(0),
                    cache_write_tokens: Some(0),
                    cost_usd: Some(0.0),
                    model: request.model.clone(),
                    ..Default::default()
                };
                for request in self.requests.values() {
                    add(&mut self.total.input_tokens, request.input);
                    add(&mut self.total.output_tokens, request.output);
                    add(&mut self.total.cache_read_tokens, request.read);
                    add(&mut self.total.cache_write_tokens, request.write);
                    let cost = (!request.unpriced)
                        .then(|| {
                            pricing::claude_request_cost(
                                request.model.as_deref(),
                                request.input,
                                request.output,
                                request.read,
                                request.write,
                                request.hour,
                            )
                        })
                        .flatten();
                    self.total.cost_usd = self.total.cost_usd.zip(cost).map(|(a, b)| a + b);
                }
                changed = true;
            }
        }
        if record["type"] == "event_msg" && payload["type"] == "token_count" {
            let info = &payload["info"];
            let last = stats::raw_usage(&info["last_token_usage"]);
            let total = stats::raw_usage(&info["total_token_usage"]);
            let repeated = total.zip(self.previous).is_some_and(|(total, previous)| stats::same_counts(total, previous));
            // Only a reading with counts settles the turn's opening.
            if (last.is_some() || total.is_some()) && std::mem::take(&mut self.opened) && last.is_some() && total.is_some() && !repeated {
                self.previous = None;
            }
            if let Some(stats::Delta::Event(delta, next)) = stats::codex_delta(
                total,
                last,
                self.previous,
            ) {
                self.previous = next;
                let read = delta.cached_input.min(delta.input);
                let write = number(&info["last_token_usage"]["cache_write_input_tokens"])
                    .max(number(
                        &info["last_token_usage"]["cache_creation_input_tokens"],
                    ))
                    .max(number(&info["last_token_usage"]["cache_write_tokens"]));
                let first = self.total.input_tokens.is_none();
                add(
                    &mut self.total.input_tokens,
                    delta.input.saturating_sub(read).saturating_sub(write),
                );
                add(&mut self.total.output_tokens, delta.output);
                add(&mut self.total.cache_read_tokens, read);
                add(&mut self.total.cache_write_tokens, write);
                self.total.model.clone_from(&self.model);
                let priced = !self.unpriced_tier
                    && !stats::nonstandard_tier(payload)
                    && !stats::nonstandard_tier(info)
                    && write == 0
                    && last.is_some_and(|last| stats::same_counts(last, delta));
                let cost = priced
                    .then(|| {
                        pricing::codex_cost(self.model.as_deref(), delta.input, read, delta.output)
                    })
                    .flatten();
                self.total.cost_usd = if first {
                    cost
                } else {
                    self.total.cost_usd.zip(cost).map(|(a, b)| a + b)
                };
                changed = true;
            }
        }
        if mark.is_some_and(TurnMark::ends) {
            self.total.duration_ms = record["durationMs"]
                .as_u64()
                .or_else(|| payload["duration_ms"].as_u64())
                .or_else(|| {
                    timestamp(record)
                        .zip(self.started)
                        .and_then(|(end, start)| u64::try_from(end - start).ok())
                });
            changed = true;
        }
        if (changed
            || out
                .iter()
                .any(|payload| matches!(payload, Payload::UsageUpdate(_))))
            && self.total.input_tokens.is_some()
        {
            // Keep the existing occupancy reading, and replace only its token
            // counters with the total. Completion records get a final reading
            // before any closer, including the interrupted-turn payload.
            if let Some(Payload::UsageUpdate(usage)) = out
                .iter_mut()
                .find(|p| matches!(p, Payload::UsageUpdate(_)))
            {
                let (used, max) = (usage.context_used, usage.context_max);
                *usage = self.total.clone();
                usage.context_used = used;
                usage.context_max = max;
            } else {
                out.insert(0, Payload::UsageUpdate(self.total.clone()));
            }
        }
    }
}

fn add(value: &mut Option<u64>, amount: u64) {
    *value = Some(value.unwrap_or(0).saturating_add(amount));
}

/// The last mapped total is committed with the one authoritative turn closer,
/// whether it came from a hook, a watcher, an import or a process exit.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompletedUsage {
    usage: Option<Usage>,
}
impl CompletedUsage {
    pub fn apply(&mut self, payload: &mut Payload) {
        match payload {
            Payload::UsageUpdate(usage) if usage.input_tokens.is_some() => {
                let mut total = usage.clone();
                if let Some(previous) = &self.usage {
                    total.context_used = total.context_used.or(previous.context_used);
                    total.context_max = total.context_max.or(previous.context_max);
                }
                self.usage = Some(total);
            }
            Payload::TurnCompleted {
                usage, duration_ms, ..
            } => {
                if let Some(mut total) = self.usage.take() {
                    *duration_ms = total.duration_ms.take().or(*duration_ms);
                    // Other transports already supply their completion usage.
                    if usage.is_none() {
                        *usage = Some(total);
                    }
                }
            }
            Payload::ContextCompacted { post_tokens, .. } => {
                if let Some(usage) = &mut self.usage {
                    usage.context_used = *post_tokens;
                }
            }
            Payload::UsageUpdate(update) => {
                if let Some(usage) = &mut self.usage {
                    if update.context_used.is_some() {
                        usage.context_used = update.context_used;
                    }
                    if update.context_max.is_some() {
                        usage.context_max = update.context_max;
                    }
                }
            }
            Payload::UserMessage { queued: false, .. } => self.usage = None,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::TurnStatus;
    use crate::harness::{claude, codex, tui::Streamer};

    fn completed() -> Payload {
        Payload::TurnCompleted {
            status: TurnStatus::Ok,
            final_text: None,
            usage: None,
            duration_ms: None,
            head: None,
            auth_failed: false,
            detail: None,
        }
    }

    fn fixture(
        text: &str,
        decode: super::super::tui::Decoder,
        marker: super::super::tui::Marker,
    ) -> Vec<(Usage, u64)> {
        let mut stream = Streamer::at(0, decode).marking(Some(marker));
        let mut committed = CompletedUsage::default();
        let mut turns = Vec::new();
        // Split in arbitrary byte chunks, as the real tail does.
        for chunk in text.as_bytes().chunks(67) {
            for (payloads, mark, _, _) in stream.push_records(chunk) {
                for mut payload in payloads {
                    committed.apply(&mut payload);
                }
                if mark.is_some_and(TurnMark::ends) {
                    let mut end = completed();
                    committed.apply(&mut end);
                    if let Payload::TurnCompleted {
                        usage: Some(usage),
                        duration_ms: Some(duration),
                        ..
                    } = end
                    {
                        turns.push((usage, duration));
                    }
                }
            }
        }
        turns
    }

    #[test]
    fn recorded_claude_requests_are_not_counted_twice_for_thinking_and_text() {
        let turns = fixture(
            include_str!("claude/fixtures/interactive_session.jsonl"),
            claude::transcript::decode_line,
            claude::transcript::decode_marked,
        );
        assert_eq!(turns.len(), 2);
        for ((usage, duration), (input, output, read, write, ms)) in turns
            .iter()
            .zip([(10, 40, 26138, 18267, 1495), (10, 38, 44405, 84, 1419)])
        {
            assert_eq!(
                (
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.cache_read_tokens,
                    usage.cache_write_tokens,
                    *duration
                ),
                (Some(input), Some(output), Some(read), Some(write), ms)
            );
            assert_eq!(
                usage.cost_usd,
                pricing::claude_request_cost(
                    Some("claude-haiku-4-5-20251001"),
                    input,
                    output,
                    read,
                    write,
                    write
                )
            );
        }
    }

    #[test]
    fn recorded_codex_turns_sum_requests_and_keep_reasoning_inside_output() {
        let turns = fixture(
            include_str!("codex/fixtures/rollout.jsonl"),
            codex::rollout::decode_line,
            codex::rollout::decode_marked,
        );
        assert_eq!(turns.len(), 3);
        for ((usage, duration), (input, output, read, ms)) in turns.iter().zip([
            (7402, 5, 10880, 3435),
            (973, 305, 54528, 18326),
            (8543, 253, 48128, 15710),
        ]) {
            assert_eq!(
                (
                    usage.input_tokens,
                    usage.output_tokens,
                    usage.cache_read_tokens,
                    usage.cache_write_tokens,
                    *duration
                ),
                (Some(input), Some(output), Some(read), Some(0), ms)
            );
            assert!(usage.model.is_some());
        }
    }

    #[test]
    fn a_turn_opening_with_the_last_total_again_counts_only_its_own_requests() {
        let mut mapper = TurnUsage { model: Some("gpt-5.6-sol".into()), ..Default::default() };
        let reading = |total: (u64, u64), last: (u64, u64)| serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":{
            "total_token_usage":{"input_tokens":total.0,"output_tokens":total.1,"cached_input_tokens":0},
            "last_token_usage":{"input_tokens":last.0,"output_tokens":last.1,"cached_input_tokens":0}
        }}});
        let opened = serde_json::json!({"type":"turn_context","payload":{"model":"gpt-5.6-sol"}});
        mapper.record(&opened, Some(TurnMark::Opened), &mut Vec::new());
        mapper.record(&reading((100, 20), (100, 20)), None, &mut Vec::new());
        assert_eq!(mapper.total.input_tokens, Some(100));
        mapper.record(&opened, Some(TurnMark::Opened), &mut Vec::new());
        mapper.record(&reading((100, 20), (100, 20)), None, &mut Vec::new());
        assert_eq!(mapper.total.input_tokens, None, "the repeated total is no request of this turn");
        mapper.record(&reading((160, 30), (60, 10)), None, &mut Vec::new());
        assert_eq!((mapper.total.input_tokens, mapper.total.output_tokens), (Some(60), Some(10)));
        // A counter Codex started again for the turn still counts its first request.
        mapper.record(&opened, Some(TurnMark::Opened), &mut Vec::new());
        mapper.record(&reading((170, 5), (170, 5)), None, &mut Vec::new());
        assert_eq!(mapper.total.input_tokens, Some(170));
    }

    #[test]
    fn duplicate_codex_counters_resets_and_unknown_prices() {
        let mut mapper = TurnUsage {
            model: Some("unknown-model".into()),
            ..Default::default()
        };
        let record = |input, output, read| {
            serde_json::json!({"type":"event_msg","payload":{"type":"token_count","info":{
                "total_token_usage":{"input_tokens":input,"output_tokens":output,"cached_input_tokens":read},
                "last_token_usage":{"input_tokens":input,"output_tokens":output,"cached_input_tokens":read}
            }}})
        };
        for value in [record(100, 20, 80), record(100, 20, 80), record(50, 10, 40)] {
            mapper.record(&value, None, &mut Vec::new());
        }
        assert_eq!(mapper.total.input_tokens, Some(30));
        assert_eq!(mapper.total.output_tokens, Some(30));
        assert_eq!(mapper.total.cache_read_tokens, Some(120));
        assert_eq!(mapper.total.cost_usd, None);
    }

    #[test]
    fn repeated_counter_readings_keep_the_normalized_turn_total() {
        let fixture = include_str!("codex/fixtures/rollout.jsonl");
        let mut stream = Streamer::at(0, codex::rollout::decode_line)
            .marking(Some(codex::rollout::decode_marked));
        let mut pending = CompletedUsage::default();
        for line in fixture.lines().take_while(|line| !line.contains("18326")) {
            let repetitions = if line.contains("token_count") { 2 } else { 1 };
            for _ in 0..repetitions {
                for (payloads, mark, _, _) in stream.push_records(format!("{line}\n").as_bytes()) {
                    for mut payload in payloads {
                        pending.apply(&mut payload);
                    }
                    if mark.is_some_and(TurnMark::ends) {
                        pending.apply(&mut completed());
                    }
                }
            }
        }
        let mut end = completed();
        pending.apply(&mut end);
        assert!(matches!(
            end,
            Payload::TurnCompleted {
                usage: Some(Usage {
                    input_tokens: Some(973),
                    output_tokens: Some(305),
                    cache_read_tokens: Some(54528),
                    ..
                }),
                ..
            }
        ));
    }

    #[test]
    fn a_handover_preserves_request_deduplication_and_pending_completion() {
        let records: Vec<Value> = include_str!("claude/fixtures/interactive_session.jsonl")
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(|record| record["type"] == "assistant")
            .collect();
        let mut mapper = TurnUsage::default();
        mapper.record(&records[0], None, &mut Vec::new());
        let mut restored: TurnUsage =
            serde_json::from_str(&serde_json::to_string(&mapper).unwrap()).unwrap();
        restored.record(&records[1], None, &mut Vec::new());
        assert_eq!(
            restored.total, mapper.total,
            "another content block of that request is still the same usage"
        );
        restored.record(&records[2], None, &mut Vec::new());
        assert_eq!(restored.total.input_tokens, Some(20));
        assert_eq!(restored.total.output_tokens, Some(78));
        assert_eq!(restored.total.cache_read_tokens, Some(70543));
        assert_eq!(restored.total.cache_write_tokens, Some(18351));
        let mut pending = CompletedUsage::default();
        pending.apply(&mut Payload::UsageUpdate(restored.total.clone()));
        let mut pending: CompletedUsage =
            serde_json::from_str(&serde_json::to_string(&pending).unwrap()).unwrap();
        let mut end = completed();
        pending.apply(&mut end);
        assert!(
            matches!(end, Payload::TurnCompleted { usage: Some(usage), .. } if usage == restored.total)
        );
    }

    #[test]
    fn completion_keeps_compacted_occupancy_and_consumes_totals_once() {
        let mut committed = CompletedUsage::default();
        committed.apply(&mut Payload::UsageUpdate(Usage {
            input_tokens: Some(30),
            context_used: Some(10000),
            ..Default::default()
        }));
        committed.apply(&mut Payload::ContextCompacted {
            pre_tokens: Some(10000),
            post_tokens: Some(0),
        });
        let mut end = completed();
        committed.apply(&mut end);
        assert!(matches!(
            end,
            Payload::TurnCompleted {
                usage: Some(Usage {
                    context_used: Some(0),
                    input_tokens: Some(30),
                    ..
                }),
                ..
            }
        ));
        let mut end = completed();
        committed.apply(&mut end);
        assert!(matches!(end, Payload::TurnCompleted { usage: None, .. }));
    }
}
