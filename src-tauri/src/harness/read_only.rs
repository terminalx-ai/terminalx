//! A deliberately small shell language for Ask mode's discovery commands.
//! Unknown syntax and options ask. In particular, never split on shell
//! operators before respecting quotes, and never evaluate expansions.

use serde_json::Value;
use std::path::Path;

pub const SESSION_OPTION: &str = "terminalx:allow_session";

#[cfg(all(test, unix))]
#[path = "read_only_security_tests.rs"]
mod security_tests;

#[path = "read_only_exec.rs"]
mod exec;
use exec::Join;
pub use exec::{ran_result, Approved};

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
    let cwd = cwd.filter(|cwd| Path::new(cwd).is_absolute())?;
    Some(serde_json::json!([tool, execution_input(input), cwd]).to_string())
}

/// Only an explicit absolute execution directory counts as verified context.
/// Its normalized shell hooks (0.164) omit workdir, while payload.cwd names
/// the session directory. Neither omission nor a relative path is proof.
pub fn explicit_cwd(input: &Value) -> Option<&str> {
    if input.get("workdir").is_some()
        && input.get("cwd").is_some()
        && input["workdir"] != input["cwd"]
    {
        return None;
    }
    let cwd = input
        .get("workdir")
        .or_else(|| input.get("cwd"))?
        .as_str()?;
    Path::new(cwd).is_absolute().then_some(cwd)
}

/// A normalized Codex hook reports the session directory. It can propose
/// an approval scope only when no execution-directory argument was supplied;
/// the replacement command must enforce that scope before running anything.
pub fn reported_scope<'a>(input: &Value, reported: Option<&'a str>) -> Option<&'a str> {
    if input.get("workdir").is_some() || input.get("cwd").is_some() {
        return None;
    }
    reported.filter(|cwd| Path::new(cwd).is_absolute())
}

/// Session grants authorize the exact command in one directory. Rewrites
/// are essential: an unchanged allow would also run in an unreported workdir.
///
/// The person approved this command for their own shell, so it still runs
/// there with their startup setup (PRO-330). Only the directory check must
/// not depend on that setup. A shell resolves a function before any path,
/// quoted or not, so the check and the rejection are spelled with a
/// per-approval random absolute path that no startup file can predefine,
/// every word is quoted (no alias, global alias or keyword applies), and
/// the rejection runs in a fresh `/bin/sh -c`, which reads no startup file.
pub fn session_input(tool: &str, input: &Value, key: &str) -> Option<Value> {
    let scope: Value = serde_json::from_str(key).ok()?;
    let cwd = scope.get(2)?.as_str()?;
    if session_key(tool, input, Some(cwd))?.as_str() != key {
        return None;
    }
    let original = command(tool, input)?;
    let reject = format!(
        "printf '%s\\n' {} >&2; exit 125",
        quote("TerminalX blocked a session allowance outside its approved directory. Request a separate one-time approval for this workdir.")
    );
    // The subshell fails with 125 when the check fails, so `&&` never
    // reaches the command; it runs in the outer shell, where a `cd` in it
    // still moves the provider's working directory as it always did.
    let script = format!(
        "({} '.' '-ef' {} || {} '-c' {}) && 'eval' {}",
        quote(&unpredictable("/bin", "test")),
        quote(cwd),
        quote(&unpredictable("/bin", "sh")),
        quote(&reject),
        quote(original)
    );
    let mut updated = input.clone();
    let field = if input.get("command").is_some() {
        "command"
    } else {
        "cmd"
    };
    updated[field] = Value::String(script);
    Some(updated)
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

/// An automatic approval is never permission for the provider to run the
/// command, rewritten or not. Its shell has already loaded the user's
/// startup files, and what they define runs before anything typed into it:
/// a function named after the quoted absolute path of the first program, a
/// readonly exported loader variable no assignment prefix can mask, an
/// xtrace prompt or DEBUG trap (PRO-330). TerminalX runs the vetted programs
/// itself instead (`Approved::run`) and answers the hook with the result.
pub fn approved(tool: &str, input: &Value, cwd: Option<&str>) -> Option<Approved> {
    approved_in(tool, input, cwd, &Execution::owner())
}

/// Git propagates -c settings to its own subprocesses. In addition to
/// rejecting current gitlinks below, suppress helpers and recursive submodule
/// displays (including historical links).
const GIT_OPTIONS: [&str; 12] = [
    "--no-pager",
    "--no-optional-locks",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "submodule.recurse=false",
    "-c",
    "diff.submodule=short",
    "-c",
    "status.submoduleSummary=false",
    "-c",
    "log.showSignature=false",
];

fn approved_in(
    tool: &str,
    input: &Value,
    cwd: Option<&str>,
    execution: &Execution,
) -> Option<Approved> {
    // The executor uses Unix process groups and signals. Other platforms
    // continue to ask until they have an equivalent controlled executor.
    if !cfg!(unix) {
        return None;
    }
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
        return None;
    }
    let cwd = cwd.filter(|cwd| Path::new(cwd).is_absolute())?;
    let commands = parse(command(tool, input)?)?;
    // Inspect and run in this one directory, even if its path is replaced.
    let handle = exec::open_directory(Path::new(cwd))?;
    let mut lists = Vec::new();
    let mut pipeline = Vec::new();
    let mut join = Join::Then;
    for command in commands {
        if !safe_command(&command.words) {
            return None;
        }
        let name = &command.words[0];
        // Use the same trusted directories as agent launches, including known
        // developer install directories when Finder supplied a minimal PATH,
        // but never the shell fallback: it would run the user's startup files.
        let binary = crate::binpath::find(name)?;
        if !binary.is_absolute() {
            return None;
        }
        if name == "git" && !git_config_is_read_only(&binary, &handle, execution) {
            return None;
        }
        let mut argv = vec![std::ffi::OsString::from(binary)];
        if name == "rg" {
            argv.push("--no-config".into());
        }
        if name == "git" {
            argv.extend(GIT_OPTIONS.iter().map(Into::into));
        }
        argv.extend(command.words[1..].iter().map(Into::into));
        pipeline.push(argv);
        if command.next != "|" {
            lists.push((join, std::mem::take(&mut pipeline)));
            join = match command.next {
                "&&" => Join::And,
                "||" => Join::Or,
                _ => Join::Then,
            };
        }
    }
    if !pipeline.is_empty() {
        return None;
    }
    Some(Approved::new(cwd.into(), handle, lists, execution.env.clone(), input))
}

/// A path to `name` in `dir` that a startup file cannot have predefined as a
/// function: 48 random `.` or empty segments, all resolving to `dir`.
fn unpredictable(dir: &str, name: &str) -> String {
    let bits = uuid::Uuid::new_v4().as_u128();
    let mut path = String::from(dir);
    for bit in 0..48 {
        path.push_str(if (bits >> bit) & 1 == 1 { "/." } else { "/" });
    }
    path.push('/');
    path.push_str(name);
    path
}

struct Execution {
    env: Vec<(&'static str, String)>,
}

impl Execution {
    fn owner() -> Self {
        let mut env = vec![
            ("PATH", "/usr/bin:/bin".into()),
            ("LC_ALL", "C".into()),
            ("GIT_OPTIONAL_LOCKS", "0".into()),
        ];
        for key in ["HOME", "XDG_CONFIG_HOME"] {
            if let Ok(value) = std::env::var(key) {
                env.push((key, value));
            }
        }
        Self { env }
    }

    fn git(&self, binary: &Path) -> std::process::Command {
        let mut command = std::process::Command::new(binary);
        command
            .env_clear()
            .envs(self.env.iter().map(|(key, value)| (*key, value)));
        command.args(["--no-pager", "--no-optional-locks"]);
        command
    }
}

fn quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

struct ShellCommand {
    words: Vec<String>,
    next: &'static str,
}

/// Recognise simple commands joined by ;, newline, &&, || or |. Reject all
/// redirections (including input/process substitutions), background jobs,
/// comments, variables, globs and shell control syntax. Quoted text stays a
/// single literal argument; substitutions inside double quotes still ask.
fn parse(source: &str) -> Option<Vec<ShellCommand>> {
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
                let next = match c {
                    ';' | '\n' => ";",
                    '&' => "&&",
                    '|' if doubled => "||",
                    _ => "|",
                };
                commands.push(ShellCommand {
                    words: std::mem::take(&mut words),
                    next,
                });
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
        commands.push(ShellCommand { words, next: "" });
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
    OptionSpec {
        flags,
        values,
        long_flags,
        long_values,
        ..Default::default()
    }
    .accepts(args)
}

#[derive(Default)]
struct OptionSpec<'a> {
    flags: &'a str,
    values: &'a [&'a str],
    numeric_values: &'a str,
    optional_values: &'a str,
    optional_numeric_values: &'a str,
    long_flags: &'a [&'a str],
    long_values: &'a [&'a str],
    long_attached_values: &'a [&'a str],
    long_optional_values: &'a [&'a str],
}

impl OptionSpec<'_> {
    fn accepts(&self, args: &[String]) -> bool {
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
                if (self.long_flags.contains(&name) && value.is_none())
                    || self.long_optional_values.contains(&name)
                    || (self.long_attached_values.contains(&name) && value.is_some())
                {
                    continue;
                }
                if !self.long_values.contains(&name) || (value.is_none() && args.next().is_none()) {
                    return false;
                }
            } else {
                let mut short = arg[1..].char_indices().peekable();
                while let Some((_, c)) = short.next() {
                    // Optional short values must be attached. A bare -U or -u
                    // leaves the following option for the next iteration.
                    if self.optional_numeric_values.contains(c) {
                        if short.any(|(_, digit)| !digit.is_ascii_digit()) {
                            return false;
                        }
                        break;
                    }
                    if self.optional_values.contains(c) {
                        break;
                    }
                    if self.numeric_values.contains(c) {
                        let valid = if short.peek().is_some() {
                            short.all(|(_, digit)| digit.is_ascii_digit())
                        } else {
                            args.next().is_some_and(|value| {
                                !value.is_empty()
                                    && value.bytes().all(|digit| digit.is_ascii_digit())
                            })
                        };
                        if !valid {
                            return false;
                        }
                        break;
                    }
                    if self.values.iter().any(|value| value.starts_with(c)) {
                        if short.peek().is_none() && args.next().is_none() {
                            return false;
                        }
                        break;
                    }
                    if !self.flags.contains(c) {
                        return false;
                    }
                }
            }
        }
        true
    }
}

fn git_args(args: &[String]) -> bool {
    let args = args
        .strip_prefix(&["--no-pager".to_string()])
        .unwrap_or(args);
    let Some((subcommand, args)) = args.split_first() else {
        return false;
    };
    match subcommand.as_str() {
        "status" => OptionSpec {
            flags: "sbz",
            optional_values: "u",
            long_flags: &[
                "--short",
                "--branch",
                "--porcelain",
                "--show-stash",
                "--ignored",
                "--no-renames",
            ],
            long_optional_values: &[
                "--porcelain",
                "--ignored",
                "--untracked-files",
                "--ignore-submodules",
            ],
            ..Default::default()
        }
        .accepts(args),
        "diff" => OptionSpec {
            flags: "pwbzR",
            optional_numeric_values: "U",
            long_flags: &[
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
            long_optional_values: &["--unified", "--color"],
            long_attached_values: &["--diff-filter"],
            ..Default::default()
        }
        .accepts(args),
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
            OptionSpec {
                flags: "puz",
                numeric_values: "n",
                long_flags: &[
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
                long_attached_values: &[
                    "--max-count",
                    "--format",
                    "--since",
                    "--until",
                    "--author",
                    "--grep",
                ],
                long_optional_values: &["--pretty", "--decorate"],
                ..Default::default()
            }
            .accepts(&args)
        }
        _ => false,
    }
}

fn git_config_is_read_only(binary: &Path, directory: &std::fs::File, execution: &Execution) -> bool {
    // Listing config does not run fsmonitor, diff drivers, pagers or gpg.
    // If any are configured, leave the command to the approval card.
    // This is exactly the environment and directory of the programs TerminalX
    // runs, including HOME and XDG_CONFIG_HOME. Shell startup cannot select
    // another config.
    let mut config = execution.git(binary);
    config.args(["config", "--null", "--list"]);
    exec::enter(&mut config, directory);
    let Ok(output) = config.output()
    else {
        return false;
    };
    if !output.status.success() || !git_config_entries_are_read_only(&output.stdout) {
        return false;
    }
    // A parent status/diff can enter a submodule with a separate config.
    // Until each traversal can be inspected reliably, repos with gitlinks
    // ask. Inspect the whole index even when the command starts in a subdir.
    let mut index = execution.git(binary);
    index.args([
            "-c",
            "core.fsmonitor=false",
            "ls-files",
            "--stage",
            "--full-name",
            "-z",
            "--",
            ":(top)",
        ]);
    exec::enter(&mut index, directory);
    let Ok(index) = index.output() else {
        return false;
    };
    index.status.success()
        && !index
            .stdout
            .split(|b| *b == 0)
            .any(|entry| entry.starts_with(b"160000 "))
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
                | "format.pretty"
                | "diff.submodule"
                | "status.submodulesummary"
                | "submodule.recurse"
        ) || key.starts_with("pager.")
            || key.starts_with("pretty.")
            || (key.starts_with("remote.") && key.ends_with(".promisor"))
            || (key.starts_with("diff.")
                && (key.ends_with(".command") || key.ends_with(".textconv"))))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn syntax_allows(source: &str) -> bool {
        parse(source)
            .is_some_and(|commands| commands.iter().all(|command| safe_command(&command.words)))
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
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            approved(
                "Bash",
                &serde_json::json!({"command":"pwd; ls"}),
                dir.path().to_str()
            )
            .is_some(),
            cfg!(unix)
        );
        // An approval names a directory that exists, opened to pin it.
        assert!(approved("Bash", &serde_json::json!({"command":"pwd"}), Some("/nonexistent/terminalx")).is_none());
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
            assert!(approved(tool, &input, Some("/workspace/app")).is_none());
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
            assert!(!git_config_is_read_only(
                &which::which("git").unwrap(),
                &exec::open_directory(dir.path()).unwrap(),
                &Execution::owner()
            ));
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
            "format.pretty",
            "pretty.checksig",
            "diff.submodule",
            "status.submodulesummary",
            "submodule.recurse",
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
            assert!(approved("Bash", &input, Some("/workspace/app")).is_none());
        }
    }

    #[test]
    fn session_checks_are_spelled_so_startup_cannot_predefine_them() {
        let (a, b) = (unpredictable("/bin", "test"), unpredictable("/bin", "test"));
        assert_ne!(a, b);
        for path in [&a, &b] {
            assert!(path.starts_with("/bin/") && path.ends_with("/test"), "{path}");
            assert_eq!(std::fs::canonicalize(path).unwrap(), std::fs::canonicalize("/bin/test").unwrap());
        }
        let input = serde_json::json!({"command":"touch note"});
        let key = session_key("Bash", &input, Some("/workspace/app")).unwrap();
        let script = session_input("Bash", &input, &key).unwrap()["command"].as_str().unwrap().to_string();
        assert!(!script.contains("'/bin/test'") && !script.contains("'/bin/sh'"), "{script}");
        assert!(script.ends_with("&& 'eval' 'touch note'"), "{script}");
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

    #[test]
    fn missing_relative_and_conflicting_directories_never_authorize_a_command() {
        for input in [
            serde_json::json!({"command":"pwd"}),
            serde_json::json!({"command":"pwd", "workdir":"relative"}),
            serde_json::json!({"command":"pwd", "workdir":null}),
            serde_json::json!({"command":"pwd", "workdir":"/a", "cwd":"/b"}),
        ] {
            assert!(explicit_cwd(&input).is_none());
        }
        assert_eq!(
            explicit_cwd(&serde_json::json!({"command":"pwd", "workdir":"/b"})),
            Some("/b")
        );
        for cwd in [None, Some("relative")] {
            let input = serde_json::json!({"command":"pwd"});
            assert!(approved("Bash", &input, cwd).is_none());
            assert!(session_key("Bash", &input, cwd).is_none());
            assert!(reported_scope(&input, cwd).is_none());
        }
        let input = serde_json::json!({"command":"pwd"});
        assert_eq!(reported_scope(&input, Some("/session")), Some("/session"));
        for input in [
            serde_json::json!({"command":"pwd", "workdir":null}),
            serde_json::json!({"command":"pwd", "cwd":"relative"}),
            serde_json::json!({"command":"pwd", "workdir":"/a", "cwd":"/b"}),
        ] {
            assert!(reported_scope(&input, Some("/session")).is_none());
        }
    }
}
