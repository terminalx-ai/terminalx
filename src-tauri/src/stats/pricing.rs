//! Small, explicit token price table used only for local cost estimates.
//!
//! Prices are USD per million tokens. Subscription billing and provider
//! discounts are unknowable from transcripts, so callers always label these
//! values as estimates.

#[derive(Clone, Copy)]
struct ClaudePrice {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    long_context: Option<(u64, f64, f64, f64, f64)>,
}

#[derive(Clone, Copy)]
struct CodexPrice {
    input: f64,
    cached_input: f64,
    output: f64,
    long_context: Option<(u64, f64, f64, f64)>,
}

const CLAUDE_PRICES: &[(&str, ClaudePrice)] = &[
    (
        "claude-fable-5",
        ClaudePrice {
            input: 10.0,
            output: 50.0,
            cache_read: 1.0,
            cache_write: 12.5,
            long_context: None,
        },
    ),
    (
        "claude-opus-5",
        ClaudePrice {
            input: 5.0,
            output: 25.0,
            cache_read: 0.5,
            cache_write: 6.25,
            long_context: None,
        },
    ),
    (
        "claude-sonnet-5",
        ClaudePrice {
            input: 3.0,
            output: 15.0,
            cache_read: 0.3,
            cache_write: 3.75,
            long_context: None,
        },
    ),
    (
        "claude-opus-4-8",
        ClaudePrice {
            input: 5.0,
            output: 25.0,
            cache_read: 0.5,
            cache_write: 6.25,
            long_context: None,
        },
    ),
    (
        "claude-opus-4-7",
        ClaudePrice {
            input: 5.0,
            output: 25.0,
            cache_read: 0.5,
            cache_write: 6.25,
            long_context: None,
        },
    ),
    (
        "claude-opus-4-6",
        ClaudePrice {
            input: 5.0,
            output: 25.0,
            cache_read: 0.5,
            cache_write: 6.25,
            long_context: None,
        },
    ),
    (
        "claude-opus-4-5",
        ClaudePrice {
            input: 5.0,
            output: 25.0,
            cache_read: 0.5,
            cache_write: 6.25,
            long_context: None,
        },
    ),
    (
        "claude-opus-4-1",
        ClaudePrice {
            input: 15.0,
            output: 75.0,
            cache_read: 1.5,
            cache_write: 18.75,
            long_context: None,
        },
    ),
    (
        "claude-opus-4",
        ClaudePrice {
            input: 15.0,
            output: 75.0,
            cache_read: 1.5,
            cache_write: 18.75,
            long_context: None,
        },
    ),
    (
        "claude-sonnet-4-6",
        ClaudePrice {
            input: 3.0,
            output: 15.0,
            cache_read: 0.3,
            cache_write: 3.75,
            long_context: Some((200_000, 6.0, 22.5, 0.6, 7.5)),
        },
    ),
    (
        "claude-sonnet-4-5",
        ClaudePrice {
            input: 3.0,
            output: 15.0,
            cache_read: 0.3,
            cache_write: 3.75,
            long_context: Some((200_000, 6.0, 22.5, 0.6, 7.5)),
        },
    ),
    (
        "claude-sonnet-4",
        ClaudePrice {
            input: 3.0,
            output: 15.0,
            cache_read: 0.3,
            cache_write: 3.75,
            long_context: Some((200_000, 6.0, 22.5, 0.6, 7.5)),
        },
    ),
    (
        "claude-sonnet-3-7",
        ClaudePrice {
            input: 3.0,
            output: 15.0,
            cache_read: 0.3,
            cache_write: 3.75,
            long_context: None,
        },
    ),
    (
        "claude-sonnet-3-5",
        ClaudePrice {
            input: 3.0,
            output: 15.0,
            cache_read: 0.3,
            cache_write: 3.75,
            long_context: None,
        },
    ),
    (
        "claude-haiku-4-5",
        ClaudePrice {
            input: 1.0,
            output: 5.0,
            cache_read: 0.1,
            cache_write: 1.25,
            long_context: None,
        },
    ),
    (
        "claude-haiku-3-5",
        ClaudePrice {
            input: 0.8,
            output: 4.0,
            cache_read: 0.08,
            cache_write: 1.0,
            long_context: None,
        },
    ),
    (
        "claude-haiku-3",
        ClaudePrice {
            input: 0.25,
            output: 1.25,
            cache_read: 0.03,
            cache_write: 0.3,
            long_context: None,
        },
    ),
];

const CODEX_PRICES: &[(&str, CodexPrice)] = &[
    (
        "gpt-5",
        CodexPrice {
            input: 1.25,
            cached_input: 0.125,
            output: 10.0,
            long_context: None,
        },
    ),
    (
        "gpt-5.1",
        CodexPrice {
            input: 1.25,
            cached_input: 0.125,
            output: 10.0,
            long_context: None,
        },
    ),
    (
        "gpt-5.1-codex",
        CodexPrice {
            input: 1.25,
            cached_input: 0.125,
            output: 10.0,
            long_context: None,
        },
    ),
    (
        "gpt-5.1-codex-max",
        CodexPrice {
            input: 1.25,
            cached_input: 0.125,
            output: 10.0,
            long_context: None,
        },
    ),
    (
        "gpt-5.2",
        CodexPrice {
            input: 1.75,
            cached_input: 0.175,
            output: 14.0,
            long_context: None,
        },
    ),
    (
        "gpt-5.2-codex",
        CodexPrice {
            input: 1.75,
            cached_input: 0.175,
            output: 14.0,
            long_context: None,
        },
    ),
    (
        "gpt-5.3",
        CodexPrice {
            input: 1.75,
            cached_input: 0.175,
            output: 14.0,
            long_context: None,
        },
    ),
    (
        "gpt-5.3-codex",
        CodexPrice {
            input: 1.75,
            cached_input: 0.175,
            output: 14.0,
            long_context: None,
        },
    ),
    (
        "gpt-5.3-codex-spark",
        CodexPrice {
            input: 1.75,
            cached_input: 0.175,
            output: 14.0,
            long_context: None,
        },
    ),
    (
        "gpt-5.4-mini",
        CodexPrice {
            input: 0.75,
            cached_input: 0.075,
            output: 4.5,
            long_context: None,
        },
    ),
    (
        "gpt-5.4-nano",
        CodexPrice {
            input: 0.2,
            cached_input: 0.02,
            output: 1.25,
            long_context: None,
        },
    ),
    (
        "gpt-5.4-pro",
        CodexPrice {
            input: 30.0,
            cached_input: 30.0,
            output: 180.0,
            long_context: Some((272_000, 60.0, 60.0, 270.0)),
        },
    ),
    (
        "gpt-5.4",
        CodexPrice {
            input: 2.5,
            cached_input: 0.25,
            output: 15.0,
            long_context: Some((272_000, 5.0, 0.5, 22.5)),
        },
    ),
    (
        "gpt-5.5-pro",
        CodexPrice {
            input: 30.0,
            cached_input: 30.0,
            output: 180.0,
            long_context: Some((272_000, 60.0, 60.0, 270.0)),
        },
    ),
    (
        "gpt-5.5",
        CodexPrice {
            input: 5.0,
            cached_input: 0.5,
            output: 30.0,
            long_context: Some((272_000, 10.0, 1.0, 45.0)),
        },
    ),
    (
        "gpt-5.6-sol",
        CodexPrice {
            input: 5.0,
            cached_input: 0.5,
            output: 30.0,
            long_context: Some((272_000, 10.0, 1.0, 45.0)),
        },
    ),
    (
        "gpt-5.6-terra",
        CodexPrice {
            input: 2.5,
            cached_input: 0.25,
            output: 15.0,
            long_context: Some((272_000, 5.0, 0.5, 22.5)),
        },
    ),
    (
        "gpt-5.6-luna",
        CodexPrice {
            input: 1.0,
            cached_input: 0.1,
            output: 6.0,
            long_context: Some((272_000, 2.0, 0.2, 9.0)),
        },
    ),
];

fn tiered(tokens: u64, base: f64, threshold: Option<(u64, f64)>) -> f64 {
    match threshold {
        None => tokens as f64 * base,
        Some((limit, above)) => {
            let below = tokens.min(limit);
            let over = tokens.saturating_sub(limit);
            below as f64 * base + over as f64 * above
        }
    }
}

fn claude_key(model: &str) -> Option<&'static str> {
    let lower = model.trim().to_ascii_lowercase().replace('.', "-");
    let lower = lower
        .strip_prefix("anthropic/")
        .or_else(|| lower.strip_prefix("anthropic:"))
        .unwrap_or(&lower);
    if lower == "model_placeholder_m26" {
        return Some("claude-opus-4-6");
    }
    if lower == "model_placeholder_m35" {
        return Some("claude-sonnet-4-6");
    }
    if lower.contains("fable-5") {
        return Some("claude-fable-5");
    }
    if lower.contains("opus-5") {
        return Some("claude-opus-5");
    }
    if lower.contains("opus-4-8") {
        return Some("claude-opus-4-8");
    }
    if lower.contains("opus-4-7") {
        return Some("claude-opus-4-7");
    }
    if lower.contains("opus-4-6") {
        return Some("claude-opus-4-6");
    }
    if lower.contains("opus-4-5") {
        return Some("claude-opus-4-5");
    }
    if lower.contains("opus-4-1") {
        return Some("claude-opus-4-1");
    }
    if lower == "claude-opus-4"
        || lower == "claude-opus-4-thinking"
        || lower.starts_with("claude-opus-4-20")
        || lower.contains("opus-4@20")
    {
        return Some("claude-opus-4");
    }
    if lower.contains("opus-4") {
        return Some("claude-opus-4-8");
    }
    if lower.contains("sonnet-5") {
        return Some("claude-sonnet-5");
    }
    if lower.contains("sonnet-4-6") {
        return Some("claude-sonnet-4-6");
    }
    if lower.contains("sonnet-4-5") {
        return Some("claude-sonnet-4-5");
    }
    if lower.contains("sonnet-4") {
        return Some("claude-sonnet-4-6");
    }
    if lower.contains("sonnet-3-7") {
        return Some("claude-sonnet-3-7");
    }
    if lower.contains("sonnet-3-5") || lower.contains("3-5-sonnet") {
        return Some("claude-sonnet-3-5");
    }
    if lower.contains("haiku-4-5") {
        return Some("claude-haiku-4-5");
    }
    if lower.contains("haiku-3-5") || lower.contains("3-5-haiku") {
        return Some("claude-haiku-3-5");
    }
    if lower.contains("haiku-3") {
        return Some("claude-haiku-3");
    }
    None
}

fn strip_reasoning_suffix(mut model: String) -> Option<String> {
    const TIERS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "auto", "none"];
    if let Some(open) = model.rfind('(') {
        if model.ends_with(')') {
            let tier = model[open + 1..model.len() - 1].trim();
            if !TIERS.contains(&tier) {
                return None;
            }
            model.truncate(open);
        }
    }
    for _ in 0..4 {
        let Some(tier) = TIERS
            .iter()
            .find(|tier| model.ends_with(&format!("-{tier}")))
        else {
            break;
        };
        model.truncate(model.len() - tier.len() - 1);
    }
    Some(model)
}

fn codex_key(model: &str) -> Option<&'static str> {
    let normalized = strip_reasoning_suffix(model.trim().to_ascii_lowercase())?;
    if normalized == "gpt-5" || normalized == "gpt-5-codex" {
        return Some("gpt-5");
    }
    for key in [
        "gpt-5.1-codex-max",
        "gpt-5.1-codex",
        "gpt-5.1",
        "gpt-5.2-codex",
        "gpt-5.2",
        "gpt-5.3-codex-spark",
        "gpt-5.3-codex",
        "gpt-5.3",
        "gpt-5.4-mini",
        "gpt-5.4-nano",
        "gpt-5.4-pro",
        "gpt-5.4",
        "gpt-5.5-pro",
        "gpt-5.5",
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
    ] {
        if normalized == key || normalized.starts_with(&format!("{key}-")) {
            return Some(key);
        }
    }
    if normalized == "gpt-5.6" {
        return Some("gpt-5.6-sol");
    }
    None
}

pub fn claude_cost(
    model: Option<&str>,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
) -> Option<f64> {
    let key = claude_key(model?)?;
    let price = CLAUDE_PRICES
        .iter()
        .find(|(candidate, _)| *candidate == key)?
        .1;
    let long = price.long_context;
    Some(
        (tiered(
            input,
            price.input,
            long.map(|(limit, input, _, _, _)| (limit, input)),
        ) + tiered(
            output,
            price.output,
            long.map(|(limit, _, output, _, _)| (limit, output)),
        ) + tiered(
            cache_read,
            price.cache_read,
            long.map(|(limit, _, _, cache, _)| (limit, cache)),
        ) + tiered(
            cache_write,
            price.cache_write,
            long.map(|(limit, _, _, _, cache)| (limit, cache)),
        )) / 1_000_000.0,
    )
}

pub fn codex_cost(model: Option<&str>, input: u64, cached_input: u64, output: u64) -> Option<f64> {
    let key = codex_key(model?)?;
    let price = CODEX_PRICES
        .iter()
        .find(|(candidate, _)| *candidate == key)?
        .1;
    let cached = cached_input.min(input);
    let uncached = input.saturating_sub(cached);
    let long = price.long_context;
    Some(
        (tiered(
            uncached,
            price.input,
            long.map(|(limit, input, _, _)| (limit, input)),
        ) + tiered(
            cached,
            price.cached_input,
            long.map(|(limit, _, cached, _)| (limit, cached)),
        ) + tiered(
            output,
            price.output,
            long.map(|(limit, _, _, output)| (limit, output)),
        )) / 1_000_000.0,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_cache_is_not_charged_twice() {
        let cost = codex_cost(Some("gpt-5.6-sol-high"), 1_000_000, 900_000, 100_000).unwrap();
        assert!((cost - 4.264).abs() < 0.001);
    }

    #[test]
    fn current_claude_aliases_are_priced() {
        assert_eq!(
            claude_key("claude-opus-4.8-thinking"),
            Some("claude-opus-4-8")
        );
        assert!(claude_cost(Some("claude-fable-5"), 10, 10, 10, 10).is_some());
    }
}
