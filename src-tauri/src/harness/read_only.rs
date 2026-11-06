//! A deliberately small shell language for Ask mode's discovery commands.
//! Unknown syntax and options ask. In particular, never split on shell
//! operators before respecting quotes, and never evaluate expansions.

use serde_json::Value;
use std::path::Path;

pub const SESSION_OPTION: &str = "terminalx:allow_session";

pub fn command<'a>(tool: &str, input: &'a Value) -> Option<&'a str> {
    if !matches!(
        tool,
        "Bash"
            | "shell"
            | "shell_command"
            | "exec_command"
            | "functions.exec_command"
            | "functions.shell_command"
    ) {
        return None;
    }
    // A different executable, environment or permission boundary is not the
    // same discovery command, even if its command text happens to be `pwd`.
    if input.get("shell").is_some()
        || input.get("env").is_some()
        || input
            .get("sandbox_permissions")
            .is_some_and(|v| v != "use_default")
    {
        return None;
    }
    if input.get("command").is_some() && input.get("cmd").is_some() {
        return None;
    }
    let command = input
        .get("command")
        .or_else(|| input.get("cmd"))?
        .as_str()?;
    (!command.trim().is_empty()).then_some(command)
}

/// Exact execution input and directory, with no prefix, glob or command-name
/// grants. A new explanation or output limit does not change the command.
pub fn session_key(tool: &str, input: &Value, cwd: Option<&str>) -> Option<String> {
    command(tool, input)?;
    Some(serde_json::json!([tool, execution_input(input), cwd?]).to_string())
}

/// Retain every execution argument when comparing approvals. Only explanatory
/// text and the limits on waiting for or displaying output are irrelevant.
pub fn execution_input(input: &Value) -> Value {
    let Some(mut execution) = input.as_object().cloned() else {
        return input.clone();
    };
    for field in [
        "description",
        "justification",
        "timeout",
        "timeout_ms",
        "max_output_tokens",
        "yield_time_ms",
    ] {
        execution.remove(field);
    }
    Value::Object(execution)
}

pub fn allows(tool: &str, input: &Value, cwd: Option<&str>) -> bool {
    if !input.as_object().is_some_and(|input| {
        input.keys().all(|key| {
            matches!(
                key.as_str(),
                "command"
                    | "cmd"
                    | "description"
                    | "justification"
                    | "timeout"
                    | "timeout_ms"
                    | "max_output_tokens"
                    | "yield_time_ms"
                    | "workdir"
                    | "cwd"
                    | "login"
                    | "sandbox_permissions"
            )
        })
    }) {
        return false;
    }
    let Some(command) = command(tool, input) else {
        return false;
    };
    let Some(commands) = parse(command) else {
        return false;
    };
    commands.iter().all(|words| safe_command(words))
        && (!commands.iter().any(|words| words[0] == "rg")
            || std::env::var_os("RIPGREP_CONFIG_PATH").is_none())
        && (!commands.iter().any(|words| words[0] == "git")
            || cwd.is_some_and(|cwd| git_config_is_read_only(Path::new(cwd))))
}

/// Recognise simple commands joined by ;, newline, &&, || or |. Reject all
/// redirections (including input/process substitutions), background jobs,
/// comments, variables, globs and shell control syntax. Quoted text stays a
/// single literal argument; substitutions inside double quotes still ask.
fn parse(source: &str) -> Option<Vec<Vec<String>>> {
    if source.len() > 64 * 1024 {
        return None;
    }
    let mut commands = Vec::new();
    let mut words = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut quote = None;
    let mut chars = source.chars().peekable();
    let mut needs_command = false;
    while let Some(c) = chars.next() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            } else if q == '"' && matches!(c, '$' | '`' | '\\') {
                return None;
            } else {
                word.push(c);
            }
            continue;
        }
        match c {
            '\'' | '"' => {
                quote = Some(c);
                started = true;
            }
            // Escaping is intentionally outside the accepted language.
            '$' | '`' | '\\' | '<' | '>' | '(' | ')' | '{' | '}' | '#' | '*' | '?' | '[' | ']'
            | '~' | '!' => return None,
            ';' | '\n' | '&' | '|' => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
                let doubled = matches!(c, '&' | '|') && chars.peek() == Some(&c);
                if doubled {
                    chars.next();
                }
                if c == '&' && !doubled {
                    return None;
                }
                if words.is_empty() {
                    if c == '\n' && !needs_command {
                        continue;
                    }
                    return None;
                }
                commands.push(std::mem::take(&mut words));
                needs_command = matches!(c, '&' | '|');
            }
            c if c.is_ascii_whitespace() && c != '\r' => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            c if c.is_control() => return None,
            _ => {
                word.push(c);
                started = true;
                needs_command = false;
            }
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        words.push(word);
    }
    if !words.is_empty() {
        commands.push(words);
    } else if needs_command {
        return None;
    }
    (!commands.is_empty()).then_some(commands)
}

fn safe_command(words: &[String]) -> bool {
    let args = &words[1..];
    match words[0].as_str() {
        "pwd" => args
            .iter()
            .all(|arg| matches!(arg.as_str(), "-L" | "-P" | "--")),
        "ls" => options(
            args,
            "aAbBcCdDfFgGhHiIklLmMnNopqQrRsStTuUvwx1@eO",
            &[],
            &[
                "--all",
                "--almost-all",
                "--directory",
                "--human-readable",
                "--recursive",
                "--long",
                "--numeric-uid-gid",
            ],
            &[],
        ),
        "cat" => options(
            args,
            "benstuvAET",
            &[],
            &[
                "--number",
                "--number-nonblank",
                "--squeeze-blank",
                "--show-all",
                "--show-ends",
                "--show-tabs",
                "--show-nonprinting",
            ],
            &[],
        ),
        "rg" => options(
            args,
            "nNiIlLqsvVwWxUFHaouhSc",
            &["e", "f", "g", "t", "T", "A", "B", "C", "m", "j"],
            &[
                "--files",
                "--hidden",
                "--no-ignore",
                "--no-ignore-vcs",
                "--ignore-case",
                "--smart-case",
                "--fixed-strings",
                "--line-number",
                "--no-line-number",
                "--files-with-matches",
                "--files-without-match",
                "--count",
                "--count-matches",
                "--only-matching",
                "--quiet",
                "--invert-match",
                "--word-regexp",
                "--line-regexp",
                "--multiline",
                "--multiline-dotall",
                "--no-heading",
                "--heading",
                "--with-filename",
                "--no-filename",
                "--json",
                "--stats",
                "--no-config",
            ],
            &[
                "--glob",
                "--iglob",
                "--type",
                "--type-not",
                "--regexp",
                "--file",
                "--after-context",
                "--before-context",
                "--context",
                "--max-count",
                "--max-depth",
                "--color",
                "--encoding",
                "--sort",
                "--sortr",
            ],
        ),
        "grep" => options(
            args,
            "EFGPRrHhInivwxlLcqsbazoU",
            &["e", "f", "A", "B", "C", "m", "d", "D"],
            &[
                "--extended-regexp",
                "--fixed-strings",
                "--perl-regexp",
                "--recursive",
                "--dereference-recursive",
                "--ignore-case",
                "--invert-match",
                "--word-regexp",
                "--line-regexp",
                "--line-number",
                "--with-filename",
                "--no-filename",
                "--files-with-matches",
                "--files-without-match",
                "--count",
                "--quiet",
                "--silent",
                "--only-matching",
            ],
            &[
                "--regexp",
                "--file",
                "--include",
                "--exclude",
                "--exclude-dir",
                "--after-context",
                "--before-context",
                "--context",
                "--max-count",
                "--color",
                "--binary-files",
            ],
        ),
        "git" => git_args(args),
        _ => false,
    }
}

/// Positive option lists prevent dangerous flags and their abbreviations
/// slipping through (rg --pre/--hostname-bin, git --output/--ext-diff, etc.).
fn options(
    args: &[String],
    flags: &str,
    values: &[&str],
    long_flags: &[&str],
    long_values: &[&str],
) -> bool {
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        if arg == "--" {
            return true;
        }
        if !arg.starts_with('-') || arg == "-" {
            continue;
        }
        if arg.starts_with("--") {
            let (name, value) = arg
                .split_once('=')
                .map_or((arg.as_str(), None), |(n, v)| (n, Some(v)));
            if long_flags.contains(&name) && value.is_none() {
                continue;
            }
            if !long_values.contains(&name) || (value.is_none() && args.next().is_none()) {
                return false;
            }
        } else {
            let mut short = arg[1..].char_indices().peekable();
            while let Some((_, c)) = short.next() {
                if values.iter().any(|value| value.starts_with(c)) {
                    if short.peek().is_none() && args.next().is_none() {
                        return false;
                    }
                    break;
                }
                if !flags.contains(c) {
                    return false;
                }
            }
        }
    }
    true
}

fn git_args(args: &[String]) -> bool {
    let args = args
        .strip_prefix(&["--no-pager".to_string()])
        .unwrap_or(args);
    let Some((subcommand, args)) = args.split_first() else {
        return false;
    };
    match subcommand.as_str() {
        "status" => options(
            args,
            "sbz",
            &["u"],
            &[
                "--short",
                "--branch",
                "--porcelain",
                "--show-stash",
                "--ignored",
                "--no-renames",
            ],
            &["--porcelain", "--untracked-files", "--ignore-submodules"],
        ),
        "diff" => options(
            args,
            "pUwbzR",
            &["U"],
            &[
                "--stat",
                "--shortstat",
                "--numstat",
                "--name-only",
                "--name-status",
                "--cached",
                "--staged",
                "--check",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--exit-code",
                "--quiet",
                "--ignore-space-at-eol",
                "--ignore-all-space",
                "--ignore-space-change",
            ],
            &["--unified", "--diff-filter", "--color"],
        ),
        "log" => {
            // Signature placeholders invoke gpg even without --show-signature.
            if args.iter().any(|arg| arg.contains("%G")) {
                return false;
            }
            let args: Vec<_> = args
                .iter()
                .filter(|arg| {
                    !arg.strip_prefix('-')
                        .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                })
                .cloned()
                .collect();
            options(
                &args,
                "puz",
                &["n"],
                &[
                    "--oneline",
                    "--all",
                    "--graph",
                    "--decorate",
                    "--no-decorate",
                    "--stat",
                    "--shortstat",
                    "--name-only",
                    "--name-status",
                    "--no-color",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--reverse",
                    "--first-parent",
                    "--no-merges",
                    "--merges",
                ],
                &[
                    "--max-count",
                    "--format",
                    "--pretty",
                    "--since",
                    "--until",
                    "--author",
                    "--grep",
                    "--decorate",
                ],
            )
        }
        _ => false,
    }
}

fn git_config_is_read_only(cwd: &Path) -> bool {
    // Listing config does not run fsmonitor, diff drivers, pagers or gpg.
    // If any are configured, leave the command to the approval card.
    if std::env::vars_os().any(|(key, _)| {
        let key = key.to_string_lossy();
        key.starts_with("GIT_TRACE")
            || matches!(key.as_ref(), "GIT_EXTERNAL_DIFF" | "GIT_PAGER" | "PAGER")
    }) {
        return false;
    }
    let Ok(output) = std::process::Command::new("git")
        .args(["--no-pager", "config", "--null", "--list"])
        .current_dir(cwd)
        .output()
    else {
        return false;
    };
    output.status.success() && git_config_entries_are_read_only(&output.stdout)
}

fn git_config_entries_are_read_only(config: &[u8]) -> bool {
    config.split(|b| *b == 0).all(|entry| {
        let key = entry.split(|b| *b == b'\n').next().unwrap_or_default();
        let key = String::from_utf8_lossy(key).to_ascii_lowercase();
        !(matches!(
            key.as_str(),
            "core.fsmonitor"
                | "core.pager"
                | "diff.external"
                | "log.showsignature"
                | "extensions.partialclone"
        ) || key.starts_with("pager.")
            || (key.starts_with("remote.") && key.ends_with(".promisor"))
            || (key.starts_with("diff.")
                && (key.ends_with(".command") || key.ends_with(".textconv"))))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn syntax_allows(source: &str) -> bool {
        parse(source).is_some_and(|commands| commands.iter().all(|words| safe_command(words)))
    }

    #[test]
    fn discovery_compounds_and_pipes_require_every_command_to_be_read_only() {
        for source in [
            "pwd; rg --files",
            "ls; cat Cargo.toml",
            "git status --short --branch && git diff --stat",
            "git log --oneline -5",
            "cat file | rg 'hello|world' | grep -n hello",
            "pwd\nls -la",
            "ls;",
            "rg -n 'foo; bar' src",
            "grep -e --output file",
            "rg --glob '*.rs' foo src",
        ] {
            assert!(syntax_allows(source), "{source}");
        }
        for source in [
            "pwd; rm file",
            "ls && touch file",
            "cat file | tee copy",
            "pwd || curl example.com",
            "git fetch",
            "git reset --hard",
            "git diff --output=result",
            "git log --show-signature",
            "git log --format=%G?",
            "git -c alias.status='!curl example.com' status",
            "rg --pre 'curl example.com' foo",
            "rg --hostname-bin=evil foo",
            "rg --pre=evil foo",
            "rg --pre-glob '*.rs' foo",
            "rg -n foo &",
            "sh -c pwd",
            "env cat file",
            "/tmp/ls",
            "LS=x ls",
        ] {
            assert!(!syntax_allows(source), "{source}");
        }
    }

    #[test]
    fn redirects_expansions_and_unrecognised_shell_syntax_ask() {
        for source in [
            "cat file > out",
            "ls >> out",
            "pwd 2>/dev/null",
            "cat < file",
            "cat <<EOF\nx\nEOF",
            "cat <<<hello",
            "cat <(curl example.com)",
            "cat $(touch file)",
            "ls `touch file`",
            "rg \"$(curl example.com)\"",
            "ls ${PATH}",
            "ls *(e:evil:)",
            "ls *.rs",
            "ls #comment\nrm file",
            "(pwd)",
            "{ pwd; }",
            "pwd & ls",
            "pwd |",
            "pwd &&",
            "pwd;;ls",
            "pwd\r; ls",
            "'pwd",
            "p\\wd",
            "ls ||| pwd",
            "",
        ] {
            assert!(!syntax_allows(source), "{source}");
        }
        assert!(syntax_allows("rg '$(literal)' file"));
        assert!(syntax_allows("cat 'a>b' | grep 'x;y'"));
    }

    #[test]
    fn wrappers_and_escalated_or_custom_shell_inputs_ask() {
        assert!(allows(
            "Bash",
            &serde_json::json!({"command":"pwd; rg --files"}),
            None
        ));
        for (tool, input) in [
            ("mcp__shell", serde_json::json!({"command":"pwd"})),
            (
                "exec_command",
                serde_json::json!({"cmd":"pwd", "shell":"evil"}),
            ),
            (
                "exec_command",
                serde_json::json!({"cmd":"pwd", "sandbox_permissions":"require_escalated"}),
            ),
            ("Bash", serde_json::json!({"command":"pwd", "env":{}})),
        ] {
            assert!(!allows(tool, &input, None));
        }
    }

    #[test]
    fn git_with_executable_helpers_configured_asks() {
        let dir = tempfile::tempdir().unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .arg(dir.path())
            .status()
            .unwrap()
            .success());
        // A repository-local helper must prevent automatic approval.
        let config = dir.path().join(".git/config");
        let original = std::fs::read_to_string(&config).unwrap();
        for entry in [
            "[core]\nfsmonitor = touch marker\n",
            "[diff \"custom\"]\ntextconv = curl example.com\n",
            "[log]\nshowSignature = true\n",
        ] {
            std::fs::write(&config, format!("{original}\n{entry}")).unwrap();
            assert!(!git_config_is_read_only(dir.path()));
            assert!(!dir.path().join("marker").exists());
        }
    }

    #[test]
    fn ordinary_git_config_allows_discovery_but_helpers_and_lazy_fetch_ask() {
        assert!(git_config_entries_are_read_only(b"core.repositoryformatversion\n0\0core.bare\nfalse\0user.name\nDeveloper\0remote.origin.url\nhttps://example.com/repo\0"));
        for key in [
            "core.fsmonitor",
            "core.pager",
            "pager.log",
            "diff.external",
            "diff.custom.textconv",
            "diff.custom.command",
            "log.showsignature",
            "extensions.partialclone",
            "remote.origin.promisor",
        ] {
            assert!(
                !git_config_entries_are_read_only(format!("{key}\nvalue\0").as_bytes()),
                "{key}"
            );
        }
        for input in [
            serde_json::json!({"command":"pwd", "cmd":"rm file"}),
            serde_json::json!({"command":"pwd", "dangerouslyDisableSandbox":true}),
        ] {
            assert!(!allows("Bash", &input, None));
        }
    }

    #[test]
    fn session_grants_ignore_explanations_but_keep_execution_context() {
        let input = serde_json::json!({"command":"touch note"});
        let key = session_key("Bash", &input, Some("/workspace/app"));
        assert_eq!(
            key,
            session_key(
                "Bash",
                &serde_json::json!({"command":"touch note", "description":"Create a note", "timeout":1000}),
                Some("/workspace/app")
            )
        );
        for (tool, input, cwd) in [
            (
                "Bash",
                serde_json::json!({"command":"touch other"}),
                "/workspace/app",
            ),
            (
                "Bash",
                serde_json::json!({"command":"touch note", "login":false}),
                "/workspace/app",
            ),
            ("Bash", input.clone(), "/workspace/other"),
            ("shell", input, "/workspace/app"),
        ] {
            assert_ne!(key, session_key(tool, &input, Some(cwd)));
        }
    }
}
