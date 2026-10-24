//! Offline, opt-in dictation personalization. Independently implemented after
//! studying Juno's context and correction design; no Juno code or data copied.
//! Raw dictations and contextual text are deliberately never persisted here.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Mutex;

static LOCK: Mutex<()> = Mutex::new(());
const MAX_ENTRIES: usize = 1000;
const MAX_TERMS: usize = 64;
const MAX_PROMPT_BYTES: usize = 200;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub context: bool,
    pub project: bool,
    pub session: bool,
    pub terminal: bool,
    pub composer: bool,
    pub remote_context: bool,
    pub dictionary: bool,
    pub replacements: bool,
    pub snippets: bool,
    pub learn: bool,
    pub guards: bool,
    pub retakes: bool,
    pub normalize: bool,
    pub code: bool,
    pub fillers: bool,
    pub language: Option<String>,
    pub sensitive_targets: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Vocabulary,
    Replacement,
    Snippet,
    Learned,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entry {
    pub id: String,
    pub kind: Kind,
    #[serde(default)]
    pub heard: String,
    pub written: String,
    #[serde(default)]
    pub sounds_like: Vec<String>,
    #[serde(default)]
    pub project: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Personalization {
    #[serde(default)]
    pub revision: u64,
    pub options: Options,
    pub entries: Vec<Entry>,
}

/// Deliberately rejects whole input on a secret marker, before tokenization.
/// This is defense in depth: callers must never read ignored-file contents.
pub fn is_sensitive(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let compact: String = lower.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.contains("token=") || compact.contains("token:") {
        return true;
    }
    if [
        ".env",
        "private key",
        "password",
        "passphrase",
        "passcode",
        "one-time-code",
        "one time code",
        "passwd",
        "api_key",
        "apikey",
        "api-key",
        "access_token",
        "secret",
        "bearer ",
        "sk-",
        "ghp_",
        "github_pat_",
        "xoxb-",
        "xoxp-",
        "akia",
        "authorization:",
        "token=",
        "token:",
        "eyj",
        "://",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        return true;
    }
    text.split(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-' && c != '=' && c != '/')
        .any(|word| {
            let digits = word.chars().filter(char::is_ascii_digit).count();
            let longest = word
                .split(|c: char| !c.is_ascii_digit())
                .map(str::len)
                .max()
                .unwrap_or(0);
            longest >= 6
                || (word.len() >= 24 && digits >= 3)
                || (word.len() >= 40 && !word.contains('_') && !word.contains('/'))
        })
}

pub fn validate(data: &Personalization) -> Result<()> {
    if data.entries.len() > MAX_ENTRIES {
        bail!("At most {MAX_ENTRIES} personalization entries are allowed");
    }
    if let Some(language) = &data.options.language {
        if language.is_empty()
            || language.len() > 12
            || !language
                .chars()
                .all(|c| c.is_ascii_alphabetic() || c == '-')
        {
            bail!("Invalid language code");
        }
    }
    if data.options.sensitive_targets.len() > 100
        || data.options.sensitive_targets.iter().any(|s| {
            s.is_empty() || s.len() > 200 || (uuid::Uuid::parse_str(s).is_err() && is_sensitive(s))
        })
    {
        bail!("Invalid sensitive target list");
    }
    let mut ids = HashSet::new();
    for entry in &data.entries {
        if entry.id.is_empty()
            || entry.id.len() > 100
            || (uuid::Uuid::parse_str(&entry.id).is_err() && is_sensitive(&entry.id))
            || !ids.insert(&entry.id)
        {
            bail!("Entry IDs must be unique and bounded");
        }
        if entry.written.trim().is_empty()
            || (entry.kind != Kind::Vocabulary && entry.heard.trim().is_empty())
        {
            bail!("Entry text must not be empty");
        }
        if entry.sounds_like.len() > 10 {
            bail!("At most 10 pronunciation spellings are allowed");
        }
        let limit = if entry.kind == Kind::Snippet {
            4096
        } else {
            120
        };
        if entry.written.len() > limit
            || entry.heard.len() > 120
            || entry
                .sounds_like
                .iter()
                .any(|s| s.trim().is_empty() || s.len() > 120)
            || entry.project.as_ref().is_some_and(|p| {
                p.is_empty()
                    || p.len() > 512
                    || (uuid::Uuid::parse_str(p).is_err() && is_sensitive(p))
            })
        {
            bail!("Entry exceeds its size limit");
        }
        if std::iter::once(&entry.written)
            .chain(std::iter::once(&entry.heard))
            .chain(entry.sounds_like.iter())
            .any(|s| is_sensitive(s) || s.chars().any(|c| c.is_control() && c != '\n' && c != '\t'))
        {
            bail!("Potential secret or unsafe text cannot be stored");
        }
    }
    Ok(())
}

pub fn load() -> Result<Personalization> {
    let path = crate::store::root()?.join("transcription-personalization.json");
    load_path(&path)
}
fn load_path(path: &std::path::Path) -> Result<Personalization> {
    if std::fs::metadata(path).is_ok_and(|m| m.len() > 5_000_000) {
        bail!("Personalization file exceeds size limit");
    }
    let data = crate::store::read_json(path)?.unwrap_or_default();
    validate(&data)?;
    Ok(data)
}
fn save_unlocked(data: &Personalization) -> Result<()> {
    save_path(
        &crate::store::root()?.join("transcription-personalization.json"),
        data,
    )
}
fn save_path(path: &std::path::Path, data: &Personalization) -> Result<()> {
    validate(data)?;
    crate::store::write_json(path, data)
}
fn next_revision(revision: u64) -> Result<u64> {
    revision
        .checked_add(1)
        .ok_or_else(|| anyhow::anyhow!("Personalization revision exhausted"))
}
/// Reject stale whole-document edits instead of losing concurrently learned rows.
pub fn save_revision(data: &Personalization) -> Result<Personalization> {
    let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    save_revision_path(
        &crate::store::root()?.join("transcription-personalization.json"),
        data,
    )
}
fn save_revision_path(path: &std::path::Path, data: &Personalization) -> Result<Personalization> {
    let current = load_path(path)?;
    if data.revision != current.revision {
        bail!(
            "Personalization changed since this page loaded. Reload settings and retry your edit."
        );
    }
    let mut updated = data.clone();
    updated.revision = next_revision(current.revision)?;
    save_path(path, &updated)?;
    Ok(updated)
}
pub fn reset() -> Result<()> {
    let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let current = load()?;
    save_unlocked(&Personalization {
        revision: next_revision(current.revision)?,
        ..Default::default()
    })
}
fn scoped(entry: &Entry, project: Option<&str>) -> bool {
    entry.project.is_none() || entry.project.as_deref() == project
}

/// Ranked explicit vocabulary first, then identifier-like contextual words.
/// Input context is ephemeral, source-gated by the caller and capped here.
pub fn compile(data: &Personalization, project: Option<&str>, context: &[String]) -> Vec<String> {
    let mut candidates = Vec::new();
    for entry in &data.entries {
        if scoped(entry, project)
            && ((data.options.dictionary && entry.kind == Kind::Vocabulary)
                || (data.options.learn && entry.kind == Kind::Learned))
        {
            candidates.push((100_u8, entry.written.clone()));
        }
    }
    if data.options.context {
        for source in context.iter().take(128) {
            if source.len() > 16384 || is_sensitive(source) {
                continue;
            }
            for term in source
                .split(|c: char| !c.is_alphanumeric() && !"_./-@".contains(c))
                .take(512)
            {
                let proper = term.chars().skip(1).any(char::is_uppercase);
                let identifier = term.contains(['_', '/', '.']) || term.starts_with('@');
                if (proper || identifier)
                    && (3..=80).contains(&term.len())
                    && term.chars().any(char::is_alphabetic)
                {
                    candidates.push((if identifier { 80 } else { 50 }, term.to_string()));
                }
            }
        }
    }
    candidates.sort_by_key(|a| std::cmp::Reverse(a.0));
    let mut seen = HashSet::new();
    let mut bytes = 0;
    candidates
        .into_iter()
        .filter_map(|(_, term)| {
            if is_sensitive(&term)
                || term.len() > 120
                || !seen.insert(term.to_lowercase())
                || bytes + term.len() + 2 > MAX_PROMPT_BYTES
            {
                return None;
            }
            bytes += term.len() + 2;
            Some(term)
        })
        .take(MAX_TERMS)
        .collect()
}

fn word_boundary(c: Option<char>) -> bool {
    c.is_none_or(|c| !c.is_alphanumeric() && c != '_')
}
/// One pass against original text: inserted snippets never trigger replacements.
fn replace_entries(text: &str, pairs: &[(String, String)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let found = pairs.iter().find(|(heard, _)| {
            let end = i + heard.len();
            text.get(i..end)
                .is_some_and(|s| s.eq_ignore_ascii_case(heard))
                && word_boundary(text[..i].chars().next_back())
                && word_boundary(text.get(end..).and_then(|s| s.chars().next()))
        });
        if let Some((heard, written)) = found {
            out.push_str(written);
            i += heard.len();
        } else {
            let c = text[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

pub fn process(
    raw: &str,
    data: &Personalization,
    project: Option<&str>,
    terms: &[String],
) -> String {
    if raw.len() > 65536 {
        return raw.to_string();
    }
    let mut text = raw.to_string();
    if data.options.guards {
        // Only exact, long prompt echoes. Never blacklist common spoken phrases
        // without a runtime no-speech signal (the runtime does not expose one).
        let prompt = terms.join(", ");
        if terms.len() >= 3 && prompt.len() >= 40 {
            if text.trim() == prompt {
                return String::new();
            }
            if let Some(rest) = text.strip_prefix(&(prompt + ". ")) {
                text = rest.to_string();
            }
        }
    }
    if data.options.guards {
        text = collapse_loop(&text);
    }
    if data.options.retakes {
        text = retake(&text);
    }
    if data.options.normalize {
        text = normalize(&text);
    }
    if data.options.code {
        text = code(&text);
    }
    if data.options.fillers {
        // Only isolated hesitation tokens, not ordinary words such as "like".
        let re = regex::Regex::new(r"(?i)\b(?:umm+|uhh+|um|uh)\b[, ]*").unwrap();
        text = re.replace_all(&text, "").into_owned();
    }
    let mut pairs = Vec::new();
    // Project entries take precedence over global entries at equal length.
    let mut entries: Vec<_> = data.entries.iter().filter(|e| scoped(e, project)).collect();
    entries.sort_by_key(|e| e.project.is_none());
    for e in entries {
        let enabled = match e.kind {
            Kind::Vocabulary => data.options.dictionary,
            Kind::Replacement => data.options.replacements,
            Kind::Snippet => data.options.snippets,
            Kind::Learned => data.options.learn,
        };
        if !enabled || is_sensitive(&e.written) {
            continue;
        }
        if !e.heard.is_empty() {
            pairs.push((e.heard.clone(), e.written.clone()));
        }
        if e.kind == Kind::Vocabulary {
            pairs.push((e.written.clone(), e.written.clone()));
            for alias in &e.sounds_like {
                pairs.push((alias.clone(), e.written.clone()));
            }
        }
    }
    pairs.sort_by_key(|(heard, _)| std::cmp::Reverse(heard.len()));
    replace_entries(&text, &pairs)
}

/// Collapse only a whole-utterance exact loop, at least four repetitions of
/// six words. Short intentional repetitions remain intact.
fn collapse_loop(text: &str) -> String {
    let words: Vec<_> = text.split_whitespace().collect();
    if words.len() < 24 {
        return text.to_string();
    }
    for period in 6..=words.len() / 4 {
        if words.len().is_multiple_of(period)
            && words.chunks(period).all(|chunk| chunk == &words[..period])
        {
            return words[..period].join(" ");
        }
    }
    text.to_string()
}

fn retake(text: &str) -> String {
    // A clock time replacing a clock time has an explicit, bounded slot.
    // Requiring am/pm on both sides avoids interpreting ordinary prose as a
    // numeric correction. Do not touch multiple markers in one utterance.
    if text.to_ascii_lowercase().matches("scratch that").count() == 1 {
        let time = r"(?:(?:0?[1-9]|1[0-2])(?::[0-5][0-9])?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:am|pm)";
        let clock =
            regex::Regex::new(&format!(r"(?i)\b{time}[,.]?\s+scratch that\s+({time})\b")).unwrap();
        if clock.is_match(text) {
            return clock.replace(text, "$1").into_owned();
        }
    }
    // Require an exact marker and a single changed slot in a repeated phrase.
    let lower = text.to_ascii_lowercase();
    let Some(index) = lower.find(" scratch that ") else {
        return text.to_string();
    };
    if lower[index + 14..].contains("scratch that") {
        return text.to_string();
    }
    let before = text[..index].trim_end_matches(['.', ',', ';']).trim();
    let after = text[index + 14..].trim();
    let a: Vec<_> = before.split_whitespace().collect();
    let b: Vec<_> = after.split_whitespace().collect();
    if (2..=12).contains(&a.len())
        && a.len() == b.len()
        && a[0].eq_ignore_ascii_case(b[0])
        && a.iter()
            .zip(&b)
            .filter(|(x, y)| !x.eq_ignore_ascii_case(y))
            .count()
            == 1
    {
        return after.to_string();
    }
    text.to_string()
}
fn normalize(text: &str) -> String {
    let ext = regex::Regex::new(r"(?i)\b([A-Za-z][A-Za-z0-9_-]*) dot (tsx|ts|jsx|js|rs|py|json|md|toml|yaml|yml|html|css)\b").unwrap();
    let mut text = ext.replace_all(text, "$1.$2").into_owned();
    let pairs = [
        ("open parenthesis", "("),
        ("close parenthesis", ")"),
        ("double equals", "=="),
        ("arrow operator", "=>"),
    ]
    .map(|(a, b)| (a.to_string(), b.to_string()));
    text = replace_entries(&text, &pairs);
    let digits = regex::Regex::new(
        r"(?i)\bnumber (zero|one|two|three|four|five|six|seven|eight|nine|ten)\b",
    )
    .unwrap();
    digits
        .replace_all(&text, |c: &regex::Captures<'_>| {
            [
                "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
                "ten",
            ]
            .iter()
            .position(|n| n.eq_ignore_ascii_case(&c[1]))
            .unwrap()
            .to_string()
        })
        .into_owned()
}
fn code(text: &str) -> String {
    // Explicit closing marker avoids guessing how much prose is an identifier.
    let re = regex::Regex::new(
        r"(?i)\b(snake|camel|pascal|kebab) case ([a-z]+(?: [a-z]+){0,7}) end case\b",
    )
    .unwrap();
    let out = re.replace_all(text, |c: &regex::Captures<'_>| {
        let words: Vec<_> = c[2]
            .split_whitespace()
            .map(str::to_ascii_lowercase)
            .collect();
        match c[1].to_ascii_lowercase().as_str() {
            "snake" => words.join("_"),
            "kebab" => words.join("-"),
            style => words
                .iter()
                .enumerate()
                .map(|(i, w)| {
                    if style == "pascal" || i > 0 {
                        format!("{}{}", w[..1].to_ascii_uppercase(), &w[1..])
                    } else {
                        w.clone()
                    }
                })
                .collect(),
        }
    });
    let tag = regex::Regex::new(r"(?i)\bat file ([a-zA-Z0-9_./-]+\.[a-zA-Z]+)\b").unwrap();
    tag.replace_all(&out, "@$1").into_owned()
}

/// Learn only one bounded, whole-word substitution inside an anchored segment.
/// The caller supplies exactly the inserted segment and its edited counterpart.
pub fn correction(before: &str, after: &str) -> Option<(String, String)> {
    if before.len() > 4096 || after.len() > 4096 || is_sensitive(before) || is_sensitive(after) {
        return None;
    }
    let a: Vec<_> = before.split_whitespace().collect();
    let b: Vec<_> = after.split_whitespace().collect();
    if a.len() != b.len() || a.len() < 3 {
        return None;
    }
    let differences: Vec<_> = a
        .iter()
        .zip(&b)
        .enumerate()
        .filter(|(_, (x, y))| x != y)
        .collect();
    if differences.len() != 1 {
        return None;
    }
    let (_, (x, y)) = differences[0];
    let clean = |s: &str| {
        s.trim_matches(|c: char| !c.is_alphanumeric() && c != '_')
            .to_string()
    };
    let (x, y) = (clean(x), clean(y));
    if x.eq_ignore_ascii_case(&y)
        || !(2..=60).contains(&x.len())
        || !(2..=60).contains(&y.len())
        || !x.chars().all(|c| c.is_alphanumeric() || c == '_')
        || !y.chars().all(|c| c.is_alphanumeric() || c == '_')
        || !x.chars().any(char::is_alphabetic)
        || !y.chars().any(char::is_alphabetic)
    {
        return None;
    }
    Some((x, y))
}
pub fn learn(before: &str, after: &str, project: Option<&str>) -> Result<bool> {
    let _lock = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut data = load()?;
    if !data.options.learn {
        return Ok(false);
    }
    let Some((heard, written)) = correction(before, after) else {
        return Ok(false);
    };
    if data.entries.len() >= MAX_ENTRIES
        || data
            .entries
            .iter()
            .filter(|e| e.kind == Kind::Learned)
            .count()
            >= 200
        || data
            .entries
            .iter()
            .any(|e| scoped(e, project) && e.heard.eq_ignore_ascii_case(&heard))
    {
        return Ok(false);
    }
    data.entries.push(Entry {
        id: uuid::Uuid::new_v4().to_string(),
        kind: Kind::Learned,
        heard,
        written,
        sounds_like: Vec::new(),
        project: project.map(str::to_string),
    });
    data.revision = next_revision(data.revision)?;
    save_unlocked(&data)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clock_retakes_preserve_surrounding_prose_and_ambiguous_content() {
        assert_eq!(
            retake("Meet at three pm scratch that four pm"),
            "Meet at four pm"
        );
        assert_eq!(
            retake("Meet at 3pm, scratch that 4pm tomorrow"),
            "Meet at 4pm tomorrow"
        );
        assert_eq!(
            retake("Document what scratch that means"),
            "Document what scratch that means"
        );
        assert_eq!(
            retake("three scratch that four files"),
            "three scratch that four files"
        );
    }
    #[test]
    fn stale_edits_cannot_overwrite_newer_rows() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("personalization.json");
        let initial = save_revision_path(&path, &Personalization::default()).unwrap();
        assert_eq!(initial.revision, 1);
        let mut learned = initial.clone();
        learned.entries.push(Entry {
            id: "learned".into(),
            kind: Kind::Learned,
            heard: "parcel".into(),
            written: "Parakeet".into(),
            sounds_like: vec![],
            project: None,
        });
        let saved = save_revision_path(&path, &learned).unwrap();
        assert_eq!(saved.revision, 2);
        assert!(save_revision_path(&path, &initial).is_err());
        assert_eq!(load_path(&path).unwrap().entries[0].written, "Parakeet");
        let reset = Personalization {
            revision: saved.revision,
            ..Default::default()
        };
        let reset = save_revision_path(&path, &reset).unwrap();
        assert_eq!(reset.revision, 3);
        assert!(save_revision_path(&path, &saved).is_err());
        assert!(load_path(&path).unwrap().entries.is_empty());
    }
    #[test]
    fn private_persistence_validates_before_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("personalization.json");
        assert!(load_path(&path).unwrap().entries.is_empty());
        let mut data = Personalization::default();
        data.options.learn = true;
        data.options.sensitive_targets = vec![uuid::Uuid::new_v4().to_string()];
        data.entries.push(Entry {
            id: uuid::Uuid::new_v4().to_string(),
            kind: Kind::Vocabulary,
            heard: String::new(),
            written: "Parakeet".into(),
            sounds_like: vec!["para keet".into()],
            project: Some(uuid::Uuid::new_v4().to_string()),
        });
        save_path(&path, &data).unwrap();
        assert_eq!(load_path(&path).unwrap().entries[0].written, "Parakeet");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        data.entries[0].sounds_like = vec!["token=private-value".into()];
        assert!(save_path(&path, &data).is_err());
        assert_eq!(
            load_path(&path).unwrap().entries[0].sounds_like,
            ["para keet"]
        );
        std::fs::write(&path, "not json").unwrap();
        assert!(load_path(&path).is_err());
    }
    #[test]
    fn all_off_is_byte_identical() {
        let data = Personalization::default();
        for raw in [
            " um fix foo dot ts ",
            "change red scratch that change blue",
            "",
            "你好 🦀",
        ] {
            assert_eq!(process(raw, &data, None, &[]), raw);
        }
    }
    #[test]
    fn secrets_never_reach_prompt_or_store() {
        let mut data = Personalization::default();
        data.options.context = true;
        for value in [
            ".env API_KEY=abc",
            "Bearer abcdef",
            "github_pat_12345",
            "account 123456789",
            "sk-abcdef",
            "AWS_SECRET_ACCESS_KEY",
            "token = private-value",
            "eyJhbGciOiJIUzI1NiJ9.payload.signature",
            "https://user:pass@example.com",
        ] {
            assert!(compile(&data, None, &[value.into()]).is_empty());
            data.entries = vec![Entry {
                id: "1".into(),
                kind: Kind::Vocabulary,
                heard: String::new(),
                written: value.into(),
                sounds_like: vec![],
                project: None,
            }];
            assert!(validate(&data).is_err());
        }
    }
    #[test]
    fn bounded_ranked_context() {
        let mut data = Personalization::default();
        data.options.context = true;
        let context: Vec<_> = (0..1000).map(|i| format!("SomeIdentifier{i}.rs")).collect();
        let terms = compile(&data, None, &context);
        assert!(terms.len() <= 64);
        assert!(terms.join(", ").len() <= 200);
    }
    #[test]
    fn replacement_is_scoped_bounded_and_nonrecursive() {
        let mut data = Personalization::default();
        data.options.replacements = true;
        data.entries = vec![
            Entry {
                id: "1".into(),
                kind: Kind::Replacement,
                heard: "cat".into(),
                written: "dog".into(),
                sounds_like: vec![],
                project: Some("p".into()),
            },
            Entry {
                id: "2".into(),
                kind: Kind::Replacement,
                heard: "dog".into(),
                written: "bird".into(),
                sounds_like: vec![],
                project: None,
            },
        ];
        assert_eq!(
            process("cat cats dog", &data, Some("p"), &[]),
            "dog cats bird"
        );
        assert_eq!(process("cat", &data, None, &[]), "cat");
    }
    #[test]
    fn loop_guard_requires_long_exact_repetitions() {
        let phrase = "please open the transcription settings panel";
        assert_eq!(collapse_loop(&[phrase; 4].join(" ")), phrase);
        assert_eq!(collapse_loop("very very very very"), "very very very very");
    }
    #[test]
    fn prompt_echo_guard_is_explicit_and_conservative() {
        let mut data = Personalization::default();
        data.options.guards = true;
        let terms = vec![
            "TranscriptionPreferences".into(),
            "personalization.rs".into(),
            "TerminalX".into(),
        ];
        assert_eq!(process(&terms.join(", "), &data, None, &terms), "");
        assert_eq!(process("thank you", &data, None, &terms), "thank you");
    }
    #[test]
    fn conservative_retakes() {
        assert_eq!(retake("change red scratch that change blue"), "change blue");
        assert_eq!(
            retake("say scratch that literally"),
            "say scratch that literally"
        );
    }
    #[test]
    fn explicit_formatting() {
        assert_eq!(normalize("open App dot ts number three"), "open App.ts 3");
        assert_eq!(code("snake case user name end case"), "user_name");
        assert_eq!(code("camel case user name"), "camel case user name");
    }
    #[test]
    fn learns_only_real_single_word_substitution() {
        assert_eq!(
            correction("open the parcel file", "open the Parakeet file"),
            Some(("parcel".into(), "Parakeet".into()))
        );
        for (a, b) in [
            ("open the file", "Open the file"),
            ("open the file", "open the file!"),
            ("open the file", "delete all files"),
            ("foo", "bar"),
            ("token sk-abc here", "token corrected here"),
        ] {
            assert!(correction(a, b).is_none());
        }
    }
}
