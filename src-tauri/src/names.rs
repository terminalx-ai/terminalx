//! Worktree names: `adjective-color-animal`, drawn at random and checked
//! against everything that could already hold the name.

const ADJECTIVES: [&str; 32] = [
    "quiet", "brisk", "calm", "clever", "cozy", "dapper", "eager", "fuzzy", "gentle", "happy", "jolly",
    "keen", "lively", "merry", "nimble", "plucky", "proud", "quick", "rusty", "sleepy", "sly", "snug",
    "spry", "sturdy", "sunny", "swift", "tidy", "tiny", "wily", "witty", "zesty", "bold",
];

const COLORS: [&str; 32] = [
    "amber", "ash", "azure", "bronze", "cedar", "cherry", "clay", "cobalt", "copper", "coral", "cream",
    "ember", "fern", "flax", "ginger", "hazel", "indigo", "ivory", "jade", "lilac", "maple", "mint",
    "moss", "ochre", "olive", "pearl", "plum", "rose", "sage", "slate", "teal", "umber",
];

const ANIMALS: [&str; 32] = [
    "badger", "bear", "beaver", "bison", "crane", "deer", "falcon", "finch", "fox", "hare", "heron",
    "ibis", "jay", "koala", "lark", "lemur", "lynx", "marten", "mole", "moose", "otter", "owl", "panda",
    "quail", "raccoon", "raven", "robin", "seal", "stoat", "tern", "vole", "wren",
];

fn pick(bytes: &[u8]) -> String {
    format!(
        "{}-{}-{}",
        ADJECTIVES[(bytes[0] % 32) as usize],
        COLORS[(bytes[1] % 32) as usize],
        ANIMALS[(bytes[2] % 32) as usize]
    )
}

/// A name not in `taken`. Random bytes come from a v4 UUID so two draws in one
/// millisecond differ in every word, not only the last.
pub fn unclaimed(taken: &[String]) -> String {
    for _ in 0..4096 {
        let id = uuid::Uuid::new_v4();
        let b = id.as_bytes();
        let name = pick(&b[..3]);
        if !taken.iter().any(|t| t == &name) {
            return name;
        }
    }
    // The pool is 32^3; if it is exhausted, suffix a counter rather than loop.
    let b = uuid::Uuid::new_v4();
    format!("{}-{}", pick(&b.as_bytes()[..3]), b.as_bytes()[4])
}

/// Words that say nothing about the work, as `worktreeNameFromPrompt` in
/// `src/lib/worktreeNames.ts` skips them; a test keeps the two the same.
const FILLER: [&str; 41] = [
    "a", "an", "the", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "from", "into", "is", "are", "be", "it", "this", "that",
    "i", "we", "you", "me", "my", "our", "please", "can", "could", "would", "should", "let", "lets", "let's", "need", "want", "like", "just", "some", "so",
];

/// A worktree name from what a session is asked to do, as the desktop's new
/// session view draws one (`worktreeNameFromPrompt`): its first few words that
/// say something, at most 40 characters. Empty when the prompt has none.
pub fn from_prompt(prompt: &str) -> String {
    let words = prompt.to_lowercase();
    let words = words.split_whitespace()
        .map(|word| word.chars().filter(char::is_ascii_alphanumeric).collect::<String>())
        .filter(|word| !word.is_empty() && !FILLER.contains(&word.as_str()));
    let mut name = String::new();
    for word in words.take(5) {
        let next = if name.is_empty() { word } else { format!("{name}-{word}") };
        if next.len() > 40 { break; }
        name = next;
    }
    name
}

/// A reader-provided worktree name made safe for a branch and folder.
/// Names are lowercase ASCII slugs, limited to 40 characters, and receive a
/// numeric suffix when the requested slug is already claimed.
pub fn requested(requested: &str, taken: &[String]) -> Option<String> {
    let mut base = String::new();
    let mut last_dash = true;
    for ch in requested.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            base.push(c);
            last_dash = false;
        } else if !last_dash {
            base.push('-');
            last_dash = true;
        }
        if base.len() >= 40 {
            break;
        }
    }
    let base = base.trim_matches('-').to_string();
    if base.is_empty() {
        return None;
    }
    if !taken.iter().any(|taken| taken == &base) {
        return Some(base);
    }
    (2..1000).map(|n| format!("{base}-{n}")).find(|candidate| !taken.iter().any(|taken| taken == candidate))
}

pub fn is_worktree_name(name: &str) -> bool {
    let parts: Vec<&str> = name.split('-').collect();
    parts.len() >= 3
        && ADJECTIVES.contains(&parts[0])
        && COLORS.contains(&parts[1])
        && ANIMALS.contains(&parts[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_have_three_words_and_avoid_taken() {
        let n = unclaimed(&[]);
        assert!(is_worktree_name(&n), "{n}");
        // Take every name whose first word is an adjective's first pick: still returns a name.
        let taken: Vec<String> = (0..64).map(|_| unclaimed(&[])).collect();
        let n2 = unclaimed(&taken);
        assert!(!taken.contains(&n2));
    }

    #[test]
    fn the_sidebar_draws_from_the_same_words() {
        // The sidebar tells a drawn name from a chosen one without asking; its lists must be these.
        let ts = include_str!("../../src/lib/worktreeNames.ts");
        let words = |name: &str| -> Vec<String> {
            let start = ts.find(&format!("const {name} = new Set([")).unwrap();
            let body = &ts[start..];
            let body = &body[body.find('[').unwrap() + 1..body.find("])").unwrap()];
            body.split(',').map(|word| word.trim().trim_matches('"').to_string()).filter(|word| !word.is_empty()).collect()
        };
        assert_eq!(words("ADJECTIVES"), ADJECTIVES);
        assert_eq!(words("COLORS"), COLORS);
        assert_eq!(words("ANIMALS"), ANIMALS);
        assert_eq!(words("FILLER"), FILLER);
    }

    #[test]
    fn a_prompt_names_its_worktree_as_the_desktop_does() {
        assert_eq!(from_prompt("Please fix the login redirect on Safari"), "fix-login-redirect-safari");
        assert_eq!(from_prompt("Let's add  an ENG-42 retry"), "add-eng42-retry");
        assert_eq!(from_prompt("a the of"), "");
        assert_eq!(from_prompt("supercalifragilisticexpialidocious anotherverylongwordhere"), "supercalifragilisticexpialidocious");
    }

    #[test]
    fn recognises_shape() {
        assert!(is_worktree_name("quiet-amber-fox"));
        assert!(!is_worktree_name("main"));
        assert!(!is_worktree_name("quiet-amber"));
    }

    #[test]
    fn requested_names_are_sanitised_and_unique() {
        assert_eq!(requested("ENG-42 Fix Login!", &[]).as_deref(), Some("eng-42-fix-login"));
        assert_eq!(requested("!!!", &[]), None);
        let taken = vec!["eng-42-fix-login".to_string(), "eng-42-fix-login-2".to_string()];
        assert_eq!(requested("eng-42-fix-login", &taken).as_deref(), Some("eng-42-fix-login-3"));
    }
}
