//! Short names for sessions started from a long prompt (PRO-333).
//!
//! Pure and deterministic, no model call. `src/lib/sessionNames.ts` is the
//! same algorithm for the web side; keep the two in step.
//!
//! A prompt longer than a sentence gets a short name (up to 6 words). A ticket or PR
//! reference found in it (PRO-123, #456) leads the name; otherwise the name is
//! the first imperative clause, with role preambles ("You are …", "Continue
//! work from …") skipped so it says what the work is.

const MAX_WORDS: usize = 6;

/// Openers of a sentence that sets a role or context rather than the work.
const PREAMBLES: &[&str] = &[
    "you are", "you're", "you will be", "your role", "your job", "act as", "as the", "as a", "continue work from",
    "continue from", "continuing", "context", "background", "this is", "the goal", "goal:",
];
/// Politeness and framing words dropped from the front of the clause.
const LEADERS: &[&str] = &[
    "please", "can you", "could you", "would you", "i want you to", "i need you to", "i'd like you to", "we need to",
    "we should", "let's", "lets", "go ahead and", "now", "first", "then", "your task is to", "your task:", "task:",
];
const TRAILING_STOPWORDS: &[&str] = &["a", "an", "the", "of", "to", "and", "or", "for", "in", "on", "with", "by", "at", "from", "that", "so"];

/// Whether the prompt is longer than a sentence.
pub fn is_long_prompt(prompt: &str) -> bool {
    let text = prompt.trim();
    sentences(text).len() > 1 || text.split_whitespace().count() > MAX_WORDS * 2
}

/// A ticket (`PRO-123`) or PR (`#456`) reference named in the prompt, the first one.
pub fn reference(prompt: &str) -> Option<String> {
    prompt.split_whitespace().find_map(|raw| {
        let token = raw.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '#' && c != '-');
        is_reference(token).then(|| token.to_string())
    })
}

fn is_reference(token: &str) -> bool {
    if let Some(digits) = token.strip_prefix('#') {
        return !digits.is_empty() && digits.len() <= 7 && digits.chars().all(|c| c.is_ascii_digit());
    }
    let Some((key, number)) = token.split_once('-') else { return false };
    (2..=10).contains(&key.len())
        && key.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        && key.starts_with(|c: char| c.is_ascii_uppercase())
        && !number.is_empty()
        && number.len() <= 7
        && number.chars().all(|c| c.is_ascii_digit())
}

/// Whether the name [`generated_name`] gives this prompt comes from a ticket or
/// PR reference. Such a name is kept over the agent's own title.
pub fn is_reference_name(prompt: &str) -> bool {
    is_long_prompt(prompt) && reference(prompt).is_some()
}

/// The name for a session started from `prompt`, or `None` when the prompt is
/// no longer than a sentence (it keeps its first line) or says nothing.
pub fn generated_name(prompt: &str) -> Option<String> {
    if !is_long_prompt(prompt) {
        return None;
    }
    let reference = reference(prompt);
    let budget = MAX_WORDS - usize::from(reference.is_some());
    let words = clause_words(prompt, reference.as_deref(), budget);
    let name = match (reference, words.is_empty()) {
        (Some(reference), true) => reference,
        (Some(reference), false) => format!("{reference} {}", words.join(" ")),
        (None, true) => return None,
        (None, false) => capitalize(&words.join(" ")),
    };
    Some(name)
}

fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut start = 0;
        let bytes = line.as_bytes();
        for (i, c) in line.char_indices() {
            let end = matches!(c, '.' | '!' | '?') && bytes.get(i + 1).is_none_or(|b| *b == b' ');
            if end {
                let piece = line[start..=i].trim();
                if !piece.is_empty() {
                    out.push(piece);
                }
                start = i + 1;
            }
        }
        let rest = line[start..].trim();
        if !rest.is_empty() {
            out.push(rest);
        }
    }
    out
}

fn starts_with_any(lower: &str, list: &[&str]) -> bool {
    list.iter().any(|p| lower.strip_prefix(p).is_some_and(|rest| rest.is_empty() || !rest.starts_with(|c: char| c.is_alphanumeric())))
}

fn clause_words(prompt: &str, reference: Option<&str>, budget: usize) -> Vec<String> {
    let all = sentences(prompt.trim());
    let chosen = all
        .iter()
        .find(|s| !starts_with_any(&s.to_lowercase(), PREAMBLES))
        .or_else(|| all.first())
        .copied()
        .unwrap_or("");
    let mut clause = chosen.trim_start_matches(|c: char| !c.is_alphanumeric() && c != '#').to_string();
    loop {
        let lower = clause.to_lowercase();
        let Some(lead) = LEADERS.iter().find(|l| starts_with_any(&lower, &[*l])) else { break };
        let Some(rest) = clause.get(lead.len()..) else { break };
        clause = rest.trim_start_matches(|c: char| !c.is_alphanumeric() && c != '#').to_string();
    }
    // The first clause only.
    let cut = clause.find([',', ';', ':', '—', '(']).unwrap_or(clause.len());
    let clause = &clause[..cut];
    let mut words: Vec<String> = clause
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric() && c != '#' && c != '-' && c != '/').to_string())
        .filter(|w| !w.is_empty())
        // The reference leads the name already.
        .filter(|w| Some(w.as_str()) != reference)
        .collect();
    words.truncate(budget);
    while words.len() > 1 && words.last().is_some_and(|w| TRAILING_STOPWORDS.contains(&w.to_lowercase().as_str())) {
        words.pop();
    }
    words
}

fn capitalize(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_prompt_is_not_renamed() {
        assert_eq!(generated_name("Fix the login bug"), None);
    }

    #[test]
    fn a_reference_leads_the_name() {
        let name = generated_name("Implement PRO-123: short generated names. Read the code first and then change it.").unwrap();
        assert!(name.starts_with("PRO-123 "), "{name}");
        assert!(name.split_whitespace().count() <= 6);
        assert_eq!(generated_name("Review #456 and leave comments. Be thorough about the tests.").unwrap().split(' ').next(), Some("#456"));
    }

    #[test]
    fn a_role_preamble_is_skipped() {
        let name = generated_name("You are the owner's chief of staff for the company. Please triage the support inbox every morning, then report.").unwrap();
        assert_eq!(name, "Triage the support inbox every morning");
        let name = generated_name("Continue work from the last session. Add dark mode to the settings page. Keep tests green.").unwrap();
        assert_eq!(name, "Add dark mode to the settings");
    }

    #[test]
    fn the_name_is_at_most_six_words_and_deterministic() {
        let prompt = "Refactor the session list rendering code so that it stops reallocating on every frame. More detail follows.";
        let name = generated_name(prompt).unwrap();
        assert!(name.split_whitespace().count() <= 6, "{name}");
        assert_eq!(Some(name), generated_name(prompt));
    }

    #[test]
    fn a_lowercase_key_is_no_reference() {
        assert_eq!(reference("see pro-12 and utf-8 and ABC-x"), None);
        assert_eq!(reference("see (PRO-12), please").as_deref(), Some("PRO-12"));
    }
}
