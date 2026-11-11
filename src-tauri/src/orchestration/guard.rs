//! The limits every worker of a run has, enforced outside its own judgment.
//!
//! A worker starts in bypass mode unless told otherwise, so no prompt stands
//! between it and a push. Three things do instead:
//!
//! 1. **Deny rules handed to the agent at launch.** Claude Code takes them in
//!    its `--settings` ([`claude_settings`]); Codex reads them from a rules
//!    file in the worker's own checkout ([`write_codex_rules`]). Both agents
//!    apply them in their bypass mode: checked on 2026-11-11 with Claude Code
//!    2.1.322 (`--dangerously-skip-permissions`) and Codex 0.166.0
//!    (`--dangerously-bypass-approvals-and-sandbox`), each asked to push to a
//!    scratch remote, each refused before git ran.
//! 2. **The app's own gate on every tool call** ([`refusal`]), which reads the
//!    command as a shell would, so `git -C elsewhere push` and
//!    `sh -c 'git push'` are refused where a prefix rule would let them by.
//! 3. **git itself** ([`git_config`], [`no_upstream`]): the worker's agent is
//!    launched with a git configuration that sends every push to an address
//!    no transport serves, and its branch has no upstream. A push made by a
//!    script the worker runs, where no rule ever sees the words `git push`,
//!    stops there.
//!
//! None of these is a sandbox. A worker set on pushing can still unset what it
//! was launched with; the limits are there so that a worker which is not
//! trying to get around them cannot push by accident, by habit, or because
//! text it read told it to.
//!
//! One table, [`RULES`], feeds all of them, and the brief states the same
//! limits ([`super::brief`]).

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use serde_json::{json, Value};

use crate::store::index::SessionEntry;

/// What a rule keeps a worker from doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Limit {
    Push,
    Merge,
    Deploy,
}

impl Limit {
    fn says(self) -> &'static str {
        match self {
            Limit::Push => "pushing",
            Limit::Merge => "merging",
            Limit::Deploy => "deploying or publishing",
        }
    }
}

/// A command a worker may not run: one of `programs`, with `words` as its
/// first arguments.
#[derive(Debug)]
pub struct Rule {
    pub programs: &'static [&'static str],
    pub words: &'static [&'static str],
    pub limit: Limit,
}

const fn rule(programs: &'static [&'static str], words: &'static [&'static str], limit: Limit) -> Rule {
    Rule { programs, words, limit }
}

pub const RULES: &[Rule] = &[
    rule(&["git"], &["push"], Limit::Push),
    rule(&["git"], &["send-pack"], Limit::Push),
    // It pushes the branch before it opens the pull request.
    rule(&["gh"], &["pr", "create"], Limit::Push),
    rule(&["gh"], &["repo", "sync"], Limit::Push),
    rule(&["git"], &["merge"], Limit::Merge),
    rule(&["gh"], &["pr", "merge"], Limit::Merge),
    rule(&["terminalx", "tnx"], &["pipelines", "merge"], Limit::Merge),
    // A pipeline pushes the branch, opens a pull request and may merge it: the app would
    // do for the worker what the worker may not do. The engine refuses one for a worker
    // as well (`issue_pipeline::engine`), and the control service refuses a worker every
    // pipeline command but `list` and `show`; these stop the command where it is typed.
    rule(&["terminalx", "tnx"], &["pipelines", "start"], Limit::Merge),
    rule(&["terminalx", "tnx"], &["pipelines", "attach"], Limit::Merge),
    rule(&["terminalx", "tnx"], &["pipelines", "stop"], Limit::Merge),
    rule(&["terminalx", "tnx"], &["pipelines", "resume"], Limit::Merge),
    rule(&["terminalx", "tnx"], &["pipelines", "advance"], Limit::Merge),
    rule(&["terminalx", "tnx"], &["pipelines", "review"], Limit::Merge),
    rule(&["terminalx", "tnx"], &["pipelines", "refresh"], Limit::Merge),
    rule(&["terminalx", "tnx"], &["pipelines", "auto-merge"], Limit::Merge),
    rule(&["terminalx", "tnx"], &["pipelines", "resolve-conflicts"], Limit::Merge),
    rule(&["gh"], &["workflow", "run"], Limit::Deploy),
    rule(&["gh"], &["release", "create"], Limit::Deploy),
    rule(&["npm", "pnpm", "yarn", "bun"], &["publish"], Limit::Deploy),
    rule(&["cargo"], &["publish"], Limit::Deploy),
    rule(&["gem"], &["push"], Limit::Deploy),
    rule(&["twine"], &["upload"], Limit::Deploy),
    rule(&["docker", "podman"], &["push"], Limit::Deploy),
    rule(&["vercel"], &["deploy"], Limit::Deploy),
    rule(&["vercel"], &["--prod"], Limit::Deploy),
    rule(&["netlify"], &["deploy"], Limit::Deploy),
    rule(&["fly", "flyctl"], &["deploy"], Limit::Deploy),
    rule(&["firebase"], &["deploy"], Limit::Deploy),
    rule(&["wrangler"], &["deploy"], Limit::Deploy),
    rule(&["wrangler"], &["publish"], Limit::Deploy),
    rule(&["serverless", "sls"], &["deploy"], Limit::Deploy),
    rule(&["kubectl"], &["apply"], Limit::Deploy),
    rule(&["terraform", "tofu"], &["apply"], Limit::Deploy),
    rule(&["helm"], &["install"], Limit::Deploy),
    rule(&["helm"], &["upgrade"], Limit::Deploy),
];

/// Tools of a connected server that push or merge without a shell, by the
/// end of their name (`mcp__github__merge_pull_request`).
const TOOL_SUFFIXES: &[(&str, Limit)] = &[("__merge_pull_request", Limit::Merge), ("__push_files", Limit::Push), ("__create_or_update_file", Limit::Push)];

/// The limits as a brief states them.
pub const STATED: &[&str] = &[
    "Work only in this worktree, on this branch. Commit here; do not switch branches.",
    "Do not push. The branch has no upstream, and the lead collects it from this repository.",
    "Do not merge: not into this branch, not into the lead's, not a pull request.",
    "Do not deploy, publish or release anything, and do not open a pull request.",
];

/// Leads whose `runs start` is creating workers right now. A worker's agent
/// may launch before its piece is written to the store; until then it is
/// known by who started it.
static STARTING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Held while a lead's workers are being created.
pub struct Starting(String);

pub fn starting(lead_session: &str) -> Starting {
    STARTING.lock().unwrap_or_else(|error| error.into_inner()).get_or_insert_with(HashSet::new).insert(lead_session.to_string());
    Starting(lead_session.to_string())
}

impl Drop for Starting {
    fn drop(&mut self) {
        if let Some(leads) = STARTING.lock().unwrap_or_else(|error| error.into_inner()).as_mut() {
            leads.remove(&self.0);
        }
    }
}

/// Whether a session is a run's worker, and so has the limits. Once a
/// worker, always one: stopping the run does not lift them from a session
/// someone resumes. The session's own entry says so; the runs say so too,
/// for a worker whose entry could not be marked. A runs file that cannot be
/// read lifts nothing: every session a lead started is then held to the limits.
pub fn limited(session: &SessionEntry) -> bool {
    if session.run_worker() {
        return true;
    }
    // A session a worker started is the worker's own hands: it has the worker's limits. It is
    // marked when it is made (`session_ops`); this covers one made before its parent was marked.
    if started_by_worker(session, 0) {
        return true;
    }
    let being_started = session.parent.as_ref().is_some_and(|parent| STARTING.lock().unwrap_or_else(|error| error.into_inner()).as_ref().is_some_and(|leads| leads.contains(&parent.session_id)));
    being_started
        || match super::store::for_worker(&session.id) {
            Ok(found) => found.is_some(),
            Err(error) => {
                log::warn!("read the runs to see whether {} is a worker: {error:#}", session.id);
                session.parent.is_some()
            }
        }
}

/// Whether some session up the chain of who started whom is a run's worker.
fn started_by_worker(session: &SessionEntry, depth: usize) -> bool {
    let Some(parent) = session.parent.as_ref().filter(|_| depth < 8).and_then(|parent| crate::store::index::get(&parent.session_id).ok()) else { return false };
    parent.run_worker() || super::store::for_worker(&parent.id).is_ok_and(|found| found.is_some()) || started_by_worker(&parent, depth + 1)
}

/// Where a push by a run's worker is sent instead of its remote. No such
/// transport exists, so git stops before it connects anywhere.
pub const REFUSED_URL: &str = "terminalx-refused://a-run-worker-does-not-push/";

/// The git configuration a worker's agent is launched with, as the file
/// `GIT_CONFIG_GLOBAL` names: the person's own, and after it every push sent
/// to [`REFUSED_URL`]. The deny rules match a command line; this holds for a
/// push however it comes about: a script the worker runs, a shell fed from
/// standard input, an alias. Fetching is untouched.
pub fn git_config(session_id: &str, cwd: &Path) -> anyhow::Result<std::path::PathBuf> {
    let mut out = String::from("# Written by TerminalX at each launch of this run worker. A worker of a run never pushes.\n");
    // What `git` would have read as the person's own configuration, kept as it is.
    let home = dirs::home_dir();
    let own: Vec<std::path::PathBuf> = match std::env::var_os("GIT_CONFIG_GLOBAL").filter(|path| !path.is_empty()) {
        Some(path) => vec![path.into()],
        None => {
            let xdg = std::env::var_os("XDG_CONFIG_HOME").filter(|path| !path.is_empty()).map(std::path::PathBuf::from).or_else(|| home.as_ref().map(|home| home.join(".config")));
            xdg.map(|xdg| xdg.join("git/config")).into_iter().chain(home.as_ref().map(|home| home.join(".gitconfig"))).collect()
        }
    };
    let quoted = |text: &str| format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""));
    for path in own.iter().filter(|path| path.is_file()) {
        out.push_str(&format!("[include]\n\tpath = {}\n", quoted(&path.to_string_lossy())));
    }
    // A push to a remote by its name.
    let remotes = crate::git::run(cwd, &["remote"]).unwrap_or_default();
    let mut explicit = Vec::new();
    for remote in remotes.lines().map(str::trim).filter(|remote| !remote.is_empty()) {
        out.push_str(&format!("[remote {}]\n\tpushurl = {REFUSED_URL}{remote}\n", quoted(remote)));
        // A remote with a push address of its own keeps pushing there as well: that address is rewritten.
        if let Ok(urls) = crate::git::run(cwd, &["config", "--get-all", &format!("remote.{remote}.pushurl")]) {
            explicit.extend(urls.lines().map(|url| url.trim().to_string()).filter(|url| !url.is_empty()));
        }
    }
    // A push to an address written out. The empty prefix is the start of every
    // address, so no form of one (a path, a URL of any scheme, `user@host:path`)
    // is left to a list to remember.
    out.push_str(&format!("[url {}]\n\tpushInsteadOf = \"\"\n", quoted(REFUSED_URL)));
    for url in explicit {
        out.push_str(&format!("\tinsteadOf = {}\n", quoted(&url)));
    }
    // Transports that run a command of the caller's choosing in place of a remote.
    out.push_str("[protocol \"ext\"]\n\tallow = never\n[protocol \"fd\"]\n\tallow = never\n");
    let dir = crate::store::ensure_dir(crate::store::root()?.join("run-workers"))?;
    let path = dir.join(format!("{session_id}.gitconfig"));
    crate::store::write_atomic(&path, out.as_bytes())?;
    Ok(path)
}

/// The rules as Claude Code's `permissions.deny` takes them.
pub fn claude_deny() -> Vec<String> {
    RULES.iter().flat_map(|rule| rule.programs.iter().map(|program| format!("Bash({program} {}:*)", rule.words.join(" ")))).collect()
}

/// Add the deny rules to a Claude launch's `--settings`, keeping any already there.
pub fn claude_settings(settings: &mut Value) {
    let mut deny: Vec<Value> = settings["permissions"]["deny"].as_array().cloned().unwrap_or_default();
    deny.extend(claude_deny().into_iter().map(Value::String).filter(|rule| !deny.contains(rule)).collect::<Vec<_>>());
    if !settings["permissions"].is_object() {
        settings["permissions"] = json!({});
    }
    settings["permissions"]["deny"] = Value::Array(deny);
}

/// The rules as a Codex rules file.
pub fn codex_rules() -> String {
    let mut out = String::from("# Written by TerminalX at each launch of this run worker. A worker of a run never\n# pushes, merges or deploys: the lead collects its branch from this repository.\n");
    for rule in RULES {
        for program in rule.programs {
            let pattern: Vec<String> = std::iter::once(*program).chain(rule.words.iter().copied()).map(|word| format!("{word:?}")).collect();
            out.push_str(&format!("prefix_rule(pattern=[{}], decision=\"forbidden\", justification=\"A worker of a TerminalX run does no {}. Report what is ready instead.\")\n", pattern.join(", "), rule.limit.says()));
        }
    }
    out
}

/// Where the rules file sits in a worker's checkout.
pub const CODEX_RULES_FILE: &str = ".codex/rules/terminalx-run.rules";

/// Write the rules where Codex reads a checkout's own, before it starts. The
/// file is the worker's launch configuration, not its work, so git is told to
/// leave it out of what the worker commits. Written again at every launch: a
/// worker that removed it has it back the next time its agent starts.
pub fn write_codex_rules(cwd: &Path) -> anyhow::Result<()> {
    let path = cwd.join(CODEX_RULES_FILE);
    std::fs::create_dir_all(path.parent().expect("the rules file has a directory"))?;
    crate::store::write_atomic(&path, codex_rules().as_bytes())?;
    let common = crate::git::run(cwd, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    let info = Path::new(common.trim()).join("info");
    let exclude = info.join("exclude");
    let line = format!("/{CODEX_RULES_FILE}");
    let mut existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if !existing.lines().any(|known| known.trim() == line) {
        std::fs::create_dir_all(&info)?;
        if !existing.is_empty() && !existing.ends_with('\n') {
            existing.push('\n');
        }
        existing.push_str(&line);
        existing.push('\n');
        std::fs::write(&exclude, existing)?;
    }
    Ok(())
}

/// Make sure a worker's branch pushes nowhere by itself. The worktree is
/// made with `--no-track`; this removes an upstream that configuration
/// (`branch.autoSetupMerge=always`) gave it all the same.
pub fn no_upstream(cwd: &Path, branch: &str) -> anyhow::Result<()> {
    for key in ["remote", "merge", "pushRemote"] {
        let name = format!("branch.{branch}.{key}");
        if crate::git::run(cwd, &["config", "--get", &name]).is_ok() {
            crate::git::run(cwd, &["config", "--unset-all", &name])?;
        }
    }
    Ok(())
}

/// Why a worker's tool call is refused, or `None` when it may go ahead.
/// `payload` is the agent's `PreToolUse` hook input.
pub fn refusal(payload: &Value) -> Option<String> {
    let tool = payload["tool_name"].as_str().unwrap_or_default();
    if let Some((_, limit)) = TOOL_SUFFIXES.iter().find(|(suffix, _)| tool.starts_with("mcp__") && tool.ends_with(suffix)) {
        return Some(said(*limit, tool));
    }
    let command = payload["tool_input"]["command"].as_str()?;
    let (rule, found) = refused(command)?;
    Some(said(rule.limit, &found))
}

fn said(limit: Limit, what: &str) -> String {
    format!("TerminalX refused `{what}`: a worker of a run does no {}. This is a fixed limit of the run, not a question to answer or work around. Commit your work on this branch and say in your report what is ready; the lead collects it.", limit.says())
}

/// What the agent's hook prints for a refused call. Claude Code and Codex
/// read the same shape from a `PreToolUse` hook.
pub fn refusal_output(reason: &str) -> Value {
    json!({ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason } })
}

/// The first rule a shell command breaks, with the command that breaks it.
pub fn refused(command: &str) -> Option<(&'static Rule, String)> {
    refused_at(command, 0)
}

/// Shells whose `-c` argument is a command of its own.
const SHELLS: &[&str] = &["sh", "bash", "zsh", "dash", "ksh", "fish"];
/// Words that run the command that follows them.
const WRAPPERS: &[&str] = &["env", "command", "exec", "sudo", "nohup", "time", "nice", "builtin", "noglob", "xargs", "timeout", "caffeinate"];
/// git's options that take a value of their own, before the subcommand.
const GIT_VALUE_OPTIONS: &[&str] = &["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"];

fn refused_at(command: &str, depth: usize) -> Option<(&'static Rule, String)> {
    // A command nested this deep is not one a person or an agent writes.
    if depth > 4 {
        return None;
    }
    simple_commands(command).iter().find_map(|words| refused_words(words, depth))
}

/// The rule one simple command breaks, as its words.
fn refused_words(mut words: &[String], depth: usize) -> Option<(&'static Rule, String)> {
    // `A=b git push`.
    while words.first().is_some_and(|word| is_assignment(word)) {
        words = &words[1..];
    }
    let (program, args) = words.split_first()?;
    let program = base(program);
    if WRAPPERS.contains(&program) {
        // `env A=b git push`, `sudo -u root git merge x`, `timeout -s KILL 30 npm publish`: which
        // of a wrapper's words are its own options, and which of those take a value, differs by
        // wrapper and by system. So every word after it that names a command a rule is about is
        // read as the start of that command. `sudo echo git push` is refused too: the price of
        // not guessing. One pass over the words: a wrapper inside a wrapper starts no pass of
        // its own, since this one reads what follows it too.
        return (0..args.len()).find_map(|at| refused_command(&args[at..], depth));
    }
    refused_command(words, depth)
}

/// The rule a program and its arguments break: a shell or `eval` by what it is given to
/// run, any other program by its first words.
fn refused_command(words: &[String], depth: usize) -> Option<(&'static Rule, String)> {
    let (program, args) = words.split_first()?;
    let program = base(program);
    if SHELLS.contains(&program) || program == "eval" {
        // `sh -c 'git push'`, `bash -lc "…"`, `eval "git push"`.
        let script = if program == "eval" { Some(args.join(" ")) } else { args.iter().position(|arg| arg.starts_with('-') && !arg.starts_with("--") && arg.contains('c')).and_then(|at| args.get(at + 1)).cloned() };
        return script.and_then(|script| refused_at(&script, depth + 1));
    }
    let args: Vec<&str> = if program == "git" { git_arguments(args) } else { args.iter().map(String::as_str).collect() };
    let plain: Vec<&str> = args.iter().copied().filter(|arg| !arg.starts_with('-')).collect();
    RULES.iter().filter(|rule| rule.programs.contains(&program)).find(|rule| args.starts_with(rule.words) || plain.starts_with(rule.words)).map(|rule| (rule, format!("{program} {}", rule.words.join(" "))))
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !name.starts_with(|c: char| c.is_ascii_digit()))
}

/// `/usr/bin/git` is `git`.
fn base(word: &str) -> &str {
    word.rsplit('/').next().unwrap_or(word)
}

/// git's arguments from its subcommand on: `-C dir -c a=b push` is `push`.
fn git_arguments(args: &[String]) -> Vec<&str> {
    let mut at = 0;
    while let Some(arg) = args.get(at) {
        if GIT_VALUE_OPTIONS.contains(&arg.as_str()) {
            at += 2;
        } else if arg.starts_with('-') {
            at += 1;
        } else {
            break;
        }
    }
    args.get(at..).unwrap_or_default().iter().map(String::as_str).collect()
}

/// A command line as the simple commands a shell would run from it, each as
/// its words with quotes removed. Text inside quotes stays one word, so a
/// commit message that mentions `git push` is not a push; a command
/// substitution inside double quotes or backticks is a command of its own.
fn simple_commands(command: &str) -> Vec<Vec<String>> {
    let mut commands = Vec::new();
    let mut words: Vec<String> = Vec::new();
    let mut word: Option<String> = None;
    let mut chars = command.chars().peekable();
    let end_word = |word: &mut Option<String>, words: &mut Vec<String>| {
        if let Some(done) = word.take() {
            words.push(done);
        }
    };
    let end_command = |word: &mut Option<String>, words: &mut Vec<String>, commands: &mut Vec<Vec<String>>| {
        if let Some(done) = word.take() {
            words.push(done);
        }
        if !words.is_empty() {
            commands.push(std::mem::take(words));
        }
    };
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                if let Some(next) = chars.next().filter(|next| *next != '\n') {
                    word.get_or_insert_with(String::new).push(next);
                }
            }
            '\'' => {
                let quoted = word.get_or_insert_with(String::new);
                for inner in chars.by_ref() {
                    if inner == '\'' {
                        break;
                    }
                    quoted.push(inner);
                }
            }
            '"' => {
                let mut text = String::new();
                while let Some(inner) = chars.next() {
                    match inner {
                        '"' => break,
                        '\\' => text.extend(chars.next()),
                        inner => text.push(inner),
                    }
                }
                // `"$(git push)"` runs it: what is substituted is read as commands too.
                commands.extend(substitutions(&text).iter().flat_map(|inner| simple_commands(inner)));
                word.get_or_insert_with(String::new).push_str(&text);
            }
            '`' => {
                let inner: String = chars.by_ref().take_while(|inner| *inner != '`').collect();
                commands.extend(simple_commands(&inner));
                word.get_or_insert_with(String::new);
            }
            '$' if chars.peek() == Some(&'(') => {
                chars.next();
                end_command(&mut word, &mut words, &mut commands);
            }
            ';' | '\n' | '|' | '&' | '(' | ')' | '{' | '}' => end_command(&mut word, &mut words, &mut commands),
            '#' if word.is_none() => {
                // A comment runs to the end of its line.
                while chars.peek().is_some_and(|next| *next != '\n') {
                    chars.next();
                }
            }
            c if c.is_whitespace() => end_word(&mut word, &mut words),
            c => word.get_or_insert_with(String::new).push(c),
        }
    }
    end_command(&mut word, &mut words, &mut commands);
    // `if`, `then`, `do` and the like introduce a command; they are not one.
    for words in &mut commands {
        while words.first().is_some_and(|first| matches!(first.as_str(), "if" | "then" | "else" | "elif" | "do" | "while" | "until" | "!")) {
            words.remove(0);
        }
    }
    commands.retain(|words| !words.is_empty());
    commands
}

/// The bodies of the `$(…)` and backtick substitutions in a double-quoted text.
fn substitutions(text: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("$(") {
        let body = &rest[at + 2..];
        let (mut depth, mut end) = (1, body.len());
        for (index, c) in body.char_indices() {
            match c {
                '(' => depth += 1,
                ')' => depth -= 1,
                _ => {}
            }
            if depth == 0 {
                end = index;
                break;
            }
        }
        found.push(body[..end].to_string());
        rest = &body[end..];
    }
    let mut parts = text.split('`');
    parts.next();
    while let (Some(body), Some(_)) = (parts.next(), parts.next()) {
        found.push(body.to_string());
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limit_of(command: &str) -> Option<Limit> {
        refused(command).map(|(rule, _)| rule.limit)
    }

    #[test]
    fn a_push_a_merge_and_a_deploy_are_refused_however_they_are_written() {
        for command in [
            "git push",
            "git push origin HEAD:refs/heads/main",
            "git push --force-with-lease",
            "git -C ../main push",
            "git -c credential.helper= --git-dir=/repo/.git push origin main",
            "/usr/bin/git push",
            "GIT_SSH_COMMAND=ssh git push",
            "env GIT_TRACE=1 git push -u origin work",
            "sudo -n git push",
            "cd ../lead && git push",
            "cargo test; git push",
            "cargo test || git push",
            "true | git push",
            "(git push)",
            "sh -c 'git push origin main'",
            "bash -lc \"cd /repo && git push\"",
            "eval \"git push\"",
            "echo \"$(git push 2>&1)\"",
            "echo `git push`",
            "if cargo test; then git push; fi",
            "timeout 30 git push",
            "sudo -u root git push",
            "env -u GIT_CONFIG_GLOBAL git push origin main",
            "timeout -s KILL 30 git push",
            "nice -n 5 xargs -I {} git push {}",
            "git send-pack origin main",
            "gh pr create --fill",
            "gh repo sync",
        ] {
            assert_eq!(limit_of(command), Some(Limit::Push), "{command}");
        }
        for command in [
            "git merge main", "git merge --no-ff origin/main", "gh pr merge 12 --squash", "gh pr merge --auto 12", "terminalx pipelines merge abc", "tnx pipelines merge abc",
            // A wrapper's own options, with or without a value, do not hide what it runs.
            "sudo -u root git merge x", "env -u X gh pr merge 1", "timeout -k 5 -s KILL 30 git merge main", "sudo -u root env A=b sh -c 'git merge x'",
            // A pipeline of its own would push and merge for it.
            "terminalx pipelines start 0198c", "tnx pipelines attach 0198c --auto-merge", "terminalx pipelines advance abc", "terminalx pipelines auto-merge abc on",
            "terminalx pipelines stop abc", "terminalx pipelines review abc", "terminalx pipelines refresh abc", "tnx pipelines resolve-conflicts abc on", "terminalx pipelines resume abc",
            // Wrappers within wrappers, however many: read in one pass.
            "env env env env env env env env env env env env env env env env env env env env env env env env git merge x",
        ] {
            assert_eq!(limit_of(command), Some(Limit::Merge), "{command}");
        }
        for command in ["npm publish", "pnpm publish --access public", "cargo publish", "vercel deploy", "vercel --prod", "vercel deploy --prod", "gh workflow run release.yml", "gh release create v1", "docker push org/image", "kubectl apply -f k8s/", "terraform apply -auto-approve", "fly deploy", "helm upgrade app ./chart", "timeout -s KILL 30 npm publish", "sudo -E -u deploy kubectl apply -f k8s/"] {
            assert_eq!(limit_of(command), Some(Limit::Deploy), "{command}");
        }
    }

    #[test]
    fn work_in_the_worktree_is_not_refused() {
        for command in [
            "git status",
            "git commit -m 'explain why git push is refused'",
            "git commit -m \"merge the two parsers; do not git push\"",
            "git log --oneline --merges",
            "git fetch origin",
            "git diff main...HEAD",
            "git stash push -m wip",
            "git rebase main",
            "git merge-base main HEAD",
            "git config push.default current",
            "echo git push",
            "echo 'run: git push' >> NOTES.md",
            "grep -rn \"git push\" docs/",
            "# git push\ncargo test",
            "cargo test push",
            "npm run publish:check",
            "npm install",
            "gh pr view 12",
            "gh pr list",
            "gh run list --workflow release.yml",
            "docker build -t image .",
            "kubectl get pods",
            "terraform plan",
            "vercel env ls",
            "helm template ./chart",
            "terminalx sessions report abc --json",
            "terminalx pipelines list --json",
            "terminalx pipelines show abc",
            "sudo -u root ls",
            "env -u X cargo test",
            "timeout -s KILL 30 cargo test push",
            "xargs -n 1 grep merge",
            "",
        ] {
            assert_eq!(limit_of(command), None, "{command}");
        }
    }

    #[test]
    fn a_tool_call_is_refused_with_a_reason_the_worker_can_act_on() {
        let reason = refusal(&json!({"tool_name": "Bash", "tool_input": {"command": "cd /repo && git push origin main"}})).unwrap();
        assert!(reason.contains("refused `git push`") && reason.contains("no pushing") && reason.contains("fixed limit"), "{reason}");
        // Codex names its shell tool differently; the command is in the same place.
        assert!(refusal(&json!({"tool_name": "exec_command", "tool_input": {"command": "gh pr merge 4"}})).unwrap().contains("no merging"));
        assert!(refusal(&json!({"tool_name": "mcp__github__merge_pull_request", "tool_input": {"pullNumber": 4}})).unwrap().contains("mcp__github__merge_pull_request"));
        assert!(refusal(&json!({"tool_name": "mcp__github__push_files", "tool_input": {}})).is_some());
        assert_eq!(refusal(&json!({"tool_name": "Bash", "tool_input": {"command": "cargo test"}})), None);
        assert_eq!(refusal(&json!({"tool_name": "Edit", "tool_input": {"file_path": "src/push.rs"}})), None);
        assert_eq!(refusal(&json!({"tool_name": "mcp__github__get_pull_request", "tool_input": {}})), None);
        let output = refusal_output(&reason);
        assert_eq!(output["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(output["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(output["hookSpecificOutput"]["permissionDecisionReason"], reason.as_str());
    }

    #[test]
    fn each_agent_is_handed_the_same_rules_in_its_own_form() {
        let deny = claude_deny();
        for rule in ["Bash(git push:*)", "Bash(git merge:*)", "Bash(gh pr merge:*)", "Bash(npm publish:*)", "Bash(tnx pipelines merge:*)"] {
            assert!(deny.iter().any(|known| known == rule), "{rule}");
        }
        assert_eq!(deny.len(), RULES.iter().map(|rule| rule.programs.len()).sum::<usize>());
        // The deny rules join a launch's settings; what is there stays, and nothing is added twice.
        let mut settings = json!({"hooks": {"Stop": []}, "permissions": {"deny": ["Read(./.env)"], "allow": ["Bash(ls:*)"]}});
        claude_settings(&mut settings);
        claude_settings(&mut settings);
        let listed = settings["permissions"]["deny"].as_array().unwrap();
        assert_eq!(listed.len(), deny.len() + 1);
        assert_eq!(listed[0], "Read(./.env)");
        assert_eq!(settings["permissions"]["allow"], json!(["Bash(ls:*)"]));
        assert!(settings["hooks"]["Stop"].is_array());
        let mut bare = json!({"hooks": {}});
        claude_settings(&mut bare);
        assert_eq!(bare["permissions"]["deny"].as_array().unwrap().len(), deny.len());

        let rules = codex_rules();
        assert!(rules.contains("prefix_rule(pattern=[\"git\", \"push\"], decision=\"forbidden\""), "{rules}");
        assert!(rules.contains("prefix_rule(pattern=[\"gh\", \"pr\", \"merge\"], decision=\"forbidden\""), "{rules}");
        assert_eq!(rules.lines().filter(|line| line.starts_with("prefix_rule(")).count(), deny.len());
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git").current_dir(dir).args(args).output().unwrap();
        assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn a_workers_checkout_gets_the_rules_file_out_of_its_commits_and_a_branch_with_no_upstream() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]);
        let worker = dir.path().join("worker");
        git(&repo, &["worktree", "add", "-q", "-b", "piece", worker.to_str().unwrap(), "main"]);

        write_codex_rules(&worker).unwrap();
        write_codex_rules(&worker).unwrap();
        assert_eq!(std::fs::read_to_string(worker.join(CODEX_RULES_FILE)).unwrap(), codex_rules());
        // Out of `git add -A`, and listed once however often the worker launches.
        assert_eq!(git(&worker, &["status", "--porcelain"]), "");
        let exclude = std::fs::read_to_string(repo.join(".git/info/exclude")).unwrap();
        assert_eq!(exclude.lines().filter(|line| *line == "/.codex/rules/terminalx-run.rules").count(), 1);

        // An upstream that configuration gave the branch is taken away again.
        git(&repo, &["remote", "add", "origin", repo.to_str().unwrap()]);
        git(&worker, &["config", "branch.piece.remote", "origin"]);
        git(&worker, &["config", "branch.piece.merge", "refs/heads/main"]);
        no_upstream(&worker, "piece").unwrap();
        assert!(std::process::Command::new("git").current_dir(&worker).args(["rev-parse", "--abbrev-ref", "piece@{upstream}"]).output().unwrap().status.code() != Some(0));
        no_upstream(&worker, "piece").unwrap();
    }

    #[test]
    fn a_workers_git_sends_every_push_nowhere_and_still_fetches() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let (remote, other, repo) = (dir.path().join("remote.git"), dir.path().join("other.git"), dir.path().join("repo"));
        for bare in [&remote, &other] {
            std::fs::create_dir(bare).unwrap();
            git(bare, &["init", "-q", "--bare", "-b", "main"]);
        }
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"]);
        git(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
        // A remote with a push address of its own, as a mirror has.
        git(&repo, &["remote", "add", "mirror", remote.to_str().unwrap()]);
        git(&repo, &["config", "remote.mirror.pushurl", other.to_str().unwrap()]);
        // The person's own configuration, which the worker's git still reads.
        let own = dir.path().join("own.gitconfig");
        std::fs::write(&own, "[user]\n\tname = The Person\n").unwrap();
        // Outside the worker, a push works: what refuses it below is the configuration.
        let as_person = |args: &[&str]| std::process::Command::new("git").current_dir(&repo).env("GIT_CONFIG_GLOBAL", &own).env("GIT_CONFIG_NOSYSTEM", "1").args(args).output().unwrap();
        assert!(as_person(&["push", "-q", "origin", "HEAD:refs/heads/by-person"]).status.success());

        std::env::set_var("GIT_CONFIG_GLOBAL", &own);
        let config = git_config("worker-1", &repo);
        std::env::remove_var("GIT_CONFIG_GLOBAL");
        let config = config.unwrap();
        assert!(config.ends_with("run-workers/worker-1.gitconfig"));
        let as_worker = |args: &[&str]| std::process::Command::new("git").current_dir(&repo).env("GIT_CONFIG_GLOBAL", &config).env("GIT_CONFIG_NOSYSTEM", "1").args(args).output().unwrap();
        let (remote_url, file_url) = (remote.to_str().unwrap().to_string(), format!("file://{}", remote.display()));
        for push in [
            vec!["push", "origin", "HEAD:refs/heads/by-worker"],
            vec!["push", "--no-verify", "--force", "origin", "HEAD:refs/heads/by-worker"],
            vec!["push", "mirror", "HEAD:refs/heads/by-worker"],
            vec!["push", &remote_url, "HEAD:refs/heads/by-worker"],
            vec!["push", &file_url, "HEAD:refs/heads/by-worker"],
            vec!["push", "../remote.git", "HEAD:refs/heads/by-worker"],
            vec!["push", "someone@example.invalid:team/repo.git", "HEAD:refs/heads/by-worker"],
            vec!["push", "unheard+of://example.invalid/repo", "HEAD:refs/heads/by-worker"],
            vec!["push", "ext::sh -c true", "HEAD:refs/heads/by-worker"],
            vec!["-c", "alias.send=push", "send", "origin", "HEAD:refs/heads/by-worker"],
        ] {
            let output = as_worker(&push);
            assert!(!output.status.success(), "git {push:?} went through");
            assert!(String::from_utf8_lossy(&output.stderr).contains("terminalx-refused"), "git {push:?}: {}", String::from_utf8_lossy(&output.stderr));
        }
        // A script that pushes is stopped the same way: no rule ever saw its command.
        let script = std::process::Command::new("sh").current_dir(&repo).env("GIT_CONFIG_GLOBAL", &config).env("GIT_CONFIG_NOSYSTEM", "1").args(["-c", "echo 'git push origin HEAD:refs/heads/by-script' | sh"]).output().unwrap();
        assert!(!script.status.success());
        for bare in [&remote, &other] {
            let branches = git(bare, &["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
            assert!(!branches.contains("by-worker") && !branches.contains("by-script"), "{branches}");
        }
        // Fetching still works, and the person's own configuration is still read.
        assert!(as_worker(&["fetch", "-q", "origin"]).status.success());
        assert_eq!(String::from_utf8_lossy(&as_worker(&["config", "user.name"]).stdout).trim(), "The Person");
    }

    #[test]
    fn a_session_is_limited_by_its_own_mark_by_its_run_or_while_its_lead_starts_workers() {
        let _home = crate::store::temp_home();
        let session = |id: &str, parent: Option<&str>| -> SessionEntry {
            let mut value = json!({"id": id, "title": id, "projectPath": "/repo", "cwd": "/repo", "created": "2026-11-11T00:00:00Z", "modified": "2026-11-11T00:00:00Z", "tabs": []});
            if let Some(parent) = parent {
                value["parent"] = json!({"sessionId": parent});
            }
            serde_json::from_value(value).unwrap()
        };
        assert!(!limited(&session("anyone", None)));
        assert!(!limited(&session("child", Some("lead"))), "a session a lead started by hand is not a run's worker");
        // Marked on its own entry: nothing else is read.
        let mut marked = session("worker", Some("lead"));
        marked.mark_run_worker();
        assert!(limited(&marked));
        let kept: SessionEntry = serde_json::from_value(serde_json::to_value(&marked).unwrap()).unwrap();
        assert!(kept.run_worker(), "the mark is written with the entry");
        // While its lead's workers are being created, before any piece names it.
        {
            let _starting = starting("lead");
            assert!(limited(&session("child", Some("lead"))));
            assert!(!limited(&session("child", Some("another-lead"))));
        }
        assert!(!limited(&session("child", Some("lead"))));
        // A session a worker starts, and one that session starts, have the worker's limits.
        crate::store::index::save(&[marked.clone(), session("child-of-worker", Some("worker")), session("grandchild", Some("child-of-worker"))]).unwrap();
        assert!(limited(&session("child-of-worker", Some("worker"))));
        assert!(limited(&session("grandchild", Some("child-of-worker"))));
        assert!(!limited(&session("child", Some("lead"))));
        // A runs file that cannot be read lifts nothing from a session a lead started.
        std::fs::write(crate::store::root().unwrap().join("orchestration-runs.json"), "{ not json").unwrap();
        assert!(limited(&session("child", Some("lead"))));
        assert!(!limited(&session("anyone", None)));
    }
}
