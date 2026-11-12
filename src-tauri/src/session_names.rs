//! Short names for sessions started from a long prompt (PRO-333).
//!
//! Pure and deterministic, no model call. `src/lib/sessionNames.ts` is the
//! same algorithm for the web side; keep the two in step.
//!
//! A prompt longer than a sentence gets a name of up to 6 words. A ticket or
//! PR reference found in it (PRO-123, #456) leads the name, followed by the
//! title written after it ("issue ENG-42: Fix login timeout") or else the
//! work's first clause. Without a reference the name is the first imperative
//! clause, with role preambles ("You are …", "Continue work from …") skipped
//! so it says what the work is.
//!
//! Which name a session takes ([`chosen_name`]): a reference-based name,
//! else the agent's own title (Claude's ai-title), else the clause.

const MAX_WORDS: usize = 6;
const ATTRIBUTION: &str = "[TerminalX Effective User v1] ";

/// Openers of a sentence that sets a role or context rather than the work.
const PREAMBLES: &[&str] = &[
    "you are", "you're", "you will be", "your role", "your job", "act as", "as the", "as a", "continue work from",
    "continue from", "continuing", "context", "background", "this is", "the goal", "goal", "why",
];
/// Politeness and framing words dropped from the front of the clause.
const LEADERS: &[&str] = &[
    "please", "can you", "could you", "would you", "i want you to", "i need you to", "i'd like you to", "help me", "we need to",
    "we should", "let's", "lets", "go ahead and", "now", "first", "then", "your task is to", "your task", "task",
];
const TRAILING_STOPWORDS: &[&str] = &["a", "an", "the", "of", "to", "and", "or", "for", "in", "on", "with", "by", "at", "from", "that", "so"];
const CLAUSE_ENDS: &[char] = &[',', ';', ':', '—', '–', '('];

/// The prompt without the attribution line a mobile or shared send puts first.
fn body(prompt: &str) -> &str {
    let prompt = prompt.trim();
    match prompt.strip_prefix(ATTRIBUTION).and_then(|rest| rest.split_once('\n')) {
        Some((_, text)) => text.trim(),
        None => prompt,
    }
}

/// Whether the prompt is longer than a sentence.
pub fn is_long_prompt(prompt: &str) -> bool {
    let text = body(prompt);
    sentences(text).len() > 1 || text.split_whitespace().count() > MAX_WORDS * 2
}

/// A ticket (`PRO-123`) or PR (`#456`) reference named in the prompt, the first one.
pub fn reference(prompt: &str) -> Option<String> {
    body(prompt).split_whitespace().find_map(|raw| {
        let token = clean_reference(raw);
        is_reference(token).then(|| token.to_string())
    })
}

fn clean_reference(raw: &str) -> &str {
    raw.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '#' && c != '-')
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

/// The name a session started from `prompt` takes, given the title its agent
/// wrote (if any): a reference-based name, else the agent's, else the clause.
pub fn chosen_name(prompt: &str, agent_title: Option<String>) -> Option<String> {
    if is_reference_name(prompt) {
        return generated_name(prompt);
    }
    agent_title.map(|title| title.trim().to_string()).filter(|title| !title.is_empty()).or_else(|| generated_name(prompt))
}

/// The name for a session started from `prompt`, or `None` when the prompt is
/// no longer than a sentence (it keeps its first line) or says nothing.
pub fn generated_name(prompt: &str) -> Option<String> {
    if !is_long_prompt(prompt) {
        return None;
    }
    let text = body(prompt);
    let reference = reference(text);
    let budget = MAX_WORDS - usize::from(reference.is_some());
    let mut words = reference.as_deref().map(|r| titled_words(text, r, budget)).unwrap_or_default();
    if words.is_empty() {
        words = clause_words(text, reference.as_deref(), budget);
    }
    let words = capitalize(&words.join(" "));
    match (reference, words.is_empty()) {
        (Some(reference), true) => Some(reference),
        (Some(reference), false) => Some(format!("{reference} {words}")),
        (None, true) => None,
        (None, false) => Some(words),
    }
}

/// A markdown line's text without its heading, list or quote marks. A `#`
/// joined to what follows (`#456`) is a reference and stays.
fn unmark(line: &str) -> &str {
    let mut line = line.trim();
    loop {
        let hashes = line.len() - line.trim_start_matches('#').len();
        let rest = &line[hashes..];
        if hashes > 0 && (rest.is_empty() || rest.starts_with(char::is_whitespace)) {
            line = rest.trim_start();
        } else if let Some(rest) = line.strip_prefix(['*', '-', '>', '+']) {
            line = rest.trim_start();
        } else {
            return line;
        }
    }
}

fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for line in text.lines().map(unmark) {
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

fn starts_with_any<'a>(lower: &str, list: &[&'a str]) -> Option<&'a str> {
    list.iter().copied().find(|p| lower.strip_prefix(p).is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric() || c == '\'')))
}

fn strip_lead(text: &str) -> &str {
    text.trim_start_matches(|c: char| !c.is_alphanumeric() && c != '#')
}

/// The title written after the reference: `ENG-42: Fix login timeout`.
fn titled_words(text: &str, reference: &str, budget: usize) -> Vec<String> {
    for line in text.lines() {
        let Some(at) = line.split_whitespace().position(|raw| clean_reference(raw) == reference) else { continue };
        let after: Vec<&str> = line.split_whitespace().skip(at).collect();
        let (first, rest) = (after[0], &after[1..]);
        let separated = first.ends_with([':', '—', '–'])
            || rest.first().is_some_and(|w| matches!(*w, "-" | "—" | "–" | ":"));
        if !separated {
            return Vec::new();
        }
        let title = rest.iter().skip_while(|w| matches!(**w, "-" | "—" | "–" | ":")).copied().collect::<Vec<_>>().join(" ");
        let title = sentences(&title).first().copied().unwrap_or("");
        return words_of(cut_clause(title), Some(reference), budget);
    }
    Vec::new()
}

fn cut_clause(text: &str) -> &str {
    &text[..text.find(CLAUSE_ENDS).unwrap_or(text.len())]
}

fn clause_words(text: &str, reference: Option<&str>, budget: usize) -> Vec<String> {
    let all = sentences(text);
    let work: Vec<&str> = all.iter().copied().filter(|s| starts_with_any(&strip_lead(s).to_lowercase(), PREAMBLES).is_none()).collect();
    // A heading or label of one word ("Goal") says less than the sentence after it.
    let chosen = work.iter().find(|s| s.split_whitespace().count() > 1).or(work.first()).or(all.first()).copied().unwrap_or("");
    let mut clause = strip_lead(chosen);
    while let Some(lead) = starts_with_any(&clause.to_lowercase(), LEADERS) {
        let Some(rest) = clause.get(lead.len()..) else { break };
        clause = strip_lead(rest);
    }
    words_of(cut_clause(clause), reference, budget)
}

fn words_of(clause: &str, reference: Option<&str>, budget: usize) -> Vec<String> {
    let mut words: Vec<String> = clause
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric() && c != '#' && c != '-' && c != '/').to_string())
        .filter(|w| w.chars().any(char::is_alphanumeric))
        // The reference leads the name already.
        .filter(|w| Some(w.as_str()) != reference)
        .collect();
    words.truncate(budget);
    while words.last().is_some_and(|w| TRAILING_STOPWORDS.contains(&w.to_lowercase().as_str())) {
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
        assert_eq!(generated_name("  "), None);
    }

    #[test]
    fn a_reference_leads_the_name() {
        assert_eq!(generated_name("Implement PRO-123: short generated names. Read the code first and then change it.").as_deref(), Some("PRO-123 Short generated names"));
        assert_eq!(generated_name("Review #456 and leave comments. Be thorough about the tests.").as_deref(), Some("#456 Review and leave comments"));
        let issue = "Work on Linear issue ENG-42: Fix login timeout\n\nUsers get logged out.\n\nIssue link: https://linear.app/acme/issue/ENG-42\nWhen done, summarise what changed.";
        assert_eq!(generated_name(issue).as_deref(), Some("ENG-42 Fix login timeout"));
        let pr = "Tidy it up.\n\nContinue work on pull request #12: Speed up the sidebar\nhttps://github.com/o/r/pull/12";
        assert_eq!(generated_name(pr).as_deref(), Some("#12 Speed up the sidebar"));
    }

    #[test]
    fn a_role_preamble_is_skipped() {
        let name = generated_name("You are the owner's chief of staff for the company. Please triage the support inbox every morning, then report.");
        assert_eq!(name.as_deref(), Some("Triage the support inbox every morning"));
        let name = generated_name("Continue work from the last session. Add dark mode to the settings page. Keep tests green.");
        assert_eq!(name.as_deref(), Some("Add dark mode to the settings"));
        let name = generated_name("## Goal\n\nMake the sidebar names readable at a glance.\n\n## Why\n\nThey all look alike.");
        assert_eq!(name.as_deref(), Some("Make the sidebar names readable"));
    }

    #[test]
    fn the_attribution_line_is_not_the_work() {
        let prompt = "[TerminalX Effective User v1] {\"authority\":\"host\",\"userId\":\"u\"}\nPlease fix sign in on the phone. It loops.";
        assert_eq!(generated_name(prompt).as_deref(), Some("Fix sign in on the phone"));
    }

    #[test]
    fn the_name_is_at_most_six_words_and_deterministic() {
        let prompt = "Refactor the session list rendering code so that it stops reallocating on every frame. More detail follows.";
        let name = generated_name(prompt).unwrap();
        assert_eq!(name, "Refactor the session list rendering code");
        assert_eq!(Some(name), generated_name(prompt));
    }

    #[test]
    fn a_lowercase_key_is_no_reference() {
        assert_eq!(reference("see pro-12 and utf-8 and ABC-x"), None);
        assert_eq!(reference("see (PRO-12), please").as_deref(), Some("PRO-12"));
    }

    #[test]
    fn a_reference_name_wins_over_the_agents_title_and_the_agents_over_the_clause() {
        let referenced = "Implement PRO-123: short names. Read the code first.";
        assert_eq!(chosen_name(referenced, Some("Session naming".into())).as_deref(), Some("PRO-123 Short names"));
        let plain = "You are a careful engineer. Speed up the sidebar. Measure first.";
        assert_eq!(chosen_name(plain, Some("Sidebar performance".into())).as_deref(), Some("Sidebar performance"));
        assert_eq!(chosen_name(plain, None).as_deref(), Some("Speed up the sidebar"));
        assert_eq!(chosen_name("Fix it", None), None);
        assert_eq!(chosen_name("Fix it", Some("Fix a bug".into())).as_deref(), Some("Fix a bug"));
    }
}
