//! Which slash commands a plain driver may send to an agent (PRO-88).
//!
//! A message that starts with `/` is typed into the agent's CLI as keys
//! (`harness::tui::body_bytes`), and the CLI runs it as a command: `/model`,
//! `/permissions`, `/login` and the rest change what the agent may do on its
//! own, which only a manager or someone who may approve permissions decides
//! (`Access::can_configure`). So for everyone else the runtime allows a short
//! list of harmless commands and the project's own, and refuses the rest
//! before anything is typed. The rule is applied wherever input reaches an
//! agent: the mailbox, a queued follow-up right before it is typed, and the
//! live `session.send`.
//!
//! The check reads the message the way the CLI could, not the way the app
//! means it: leading whitespace does not hide a command, and every line of a
//! multi-line message is looked at, since a CLI that does not take the
//! message as one paste runs each line.

use std::path::Path;

/// Sent as the receipt's category, and as `data.reason` of a refused
/// `session.send`.
pub const CATEGORY: &str = "slash-command-forbidden";

/// Commands that change nothing about what the agent may do: they start a
/// new conversation, shorten the current one, or show help.
const ALLOWED: [&str; 5] = ["clear", "reset", "new", "compact", "help"];

/// Built-in commands of the CLIs that change the model, effort, permission
/// mode, login state, MCP servers, settings or the directories and tools the
/// agent may use. A project command of the same name does not make one of
/// these allowed: the CLI runs its own. Not the rule itself (anything not
/// allowed is refused), only what a file in the repository cannot unlock.
const RESERVED: [&str; 32] = [
    "add-dir",
    "agents",
    "allowed-tools",
    "approvals",
    "bashes",
    "config",
    "effort",
    "exit",
    "fast",
    "hooks",
    "ide",
    "init",
    "install-github-app",
    "login",
    "logout",
    "mcp",
    "memory",
    "model",
    "output-style",
    "permissions",
    "plugin",
    "privacy-settings",
    "quit",
    "resume",
    "rewind",
    "sandbox",
    "settings",
    "status",
    "statusline",
    "terminal-setup",
    "upgrade",
    "vim",
];

/// Longest command quoted back in a refusal, in characters.
const MAX_QUOTED: usize = 40;

/// Why a message was not sent. `command` is quoted from the sender's own
/// message, shortened, for the receipt only they can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub command: String,
}

impl Refusal {
    pub fn message(&self) -> String {
        format!(
            "{} was not sent: only someone who can approve permissions may send it. Without that right you can send /clear, /compact, /help and this project's own commands.",
            self.command
        )
    }
}

/// Whether someone who may not configure the tab may send `text`. `project`
/// is where the session's agent runs, for the project's own commands.
pub fn check(text: &str, project: Option<&Path>) -> Result<(), Refusal> {
    let mut first = true;
    for line in text.split(['\n', '\r']) {
        let line = line.trim_start_matches(invisible);
        if line.is_empty() {
            continue;
        }
        let leading = std::mem::take(&mut first);
        if !line.starts_with('/') {
            continue;
        }
        let word = line.split(char::is_whitespace).next().unwrap_or(line);
        let name = &word[1..];
        // The first line is what the CLI's command palette sees, and it
        // completes what is typed to the nearest command: anything there
        // that is not exactly an allowed command is refused. Further lines
        // are refused only when they read as a command (`/name`), so a path
        // in pasted output does not stop a message.
        if !leading && !is_name(name) {
            continue;
        }
        // An allowed command is typed as keys, where a control character is
        // a key of its own (Ctrl+U would clear the line for what follows).
        let plain = !line.chars().any(char::is_control);
        if plain && is_name(name) && (ALLOWED.contains(&name) || is_project_command(name, project)) {
            continue;
        }
        return Err(Refusal { command: quoted(word) });
    }
    Ok(())
}

/// Whitespace and what a terminal or a CLI's own trimming would skip.
fn invisible(c: char) -> bool {
    c.is_whitespace() || c.is_control() || matches!(c, '\u{feff}' | '\u{200b}'..='\u{200f}' | '\u{2060}')
}

/// A command name as the CLIs write them: `name` or `namespace:name`.
fn is_name(name: &str) -> bool {
    name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && name.split(':').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
}

/// A command or skill the repository itself defines for Claude Code:
/// `.claude/commands/<name>.md` (`a:b` is `a/b.md`) or
/// `.claude/skills/<name>/SKILL.md`. `name` has passed [`is_name`], so it
/// cannot leave those directories.
fn is_project_command(name: &str, project: Option<&Path>) -> bool {
    let Some(project) = project else { return false };
    if RESERVED.contains(&name) {
        return false;
    }
    let claude = project.join(".claude");
    let command = name.split(':').fold(claude.join("commands"), |path, part| path.join(part)).with_extension("md");
    command.is_file() || claude.join("skills").join(name).join("SKILL.md").is_file()
}

fn quoted(word: &str) -> String {
    let clean: String = word.chars().filter(|c| !c.is_control()).take(MAX_QUOTED + 1).collect();
    if clean.chars().count() > MAX_QUOTED {
        format!("{}…", clean.chars().take(MAX_QUOTED).collect::<String>())
    } else {
        clean
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refused(text: &str) -> String {
        check(text, None).expect_err(text).command
    }

    #[test]
    fn harmless_commands_and_ordinary_messages_pass() {
        for text in ["fix the login", "/clear", "/compact keep the plan", "/help", "/new", "  /help  ", "see src/main.rs and a/b", "1/2 done", "/clear\nthen read the plan"] {
            assert_eq!(check(text, None), Ok(()), "{text:?}");
        }
    }

    #[test]
    fn commands_that_change_what_the_agent_may_do_are_refused() {
        for (text, command) in [
            ("/model opus", "/model"),
            ("/permissions", "/permissions"),
            ("/login", "/login"),
            ("/logout", "/logout"),
            ("/mcp", "/mcp"),
            ("/config", "/config"),
            ("/effort max", "/effort"),
            ("/approvals", "/approvals"),
            // Not a command anyone listed: refused all the same.
            ("/something-new", "/something-new"),
        ] {
            assert_eq!(refused(text), command, "{text:?}");
        }
    }

    #[test]
    fn whitespace_and_invisible_characters_do_not_hide_a_command() {
        for text in ["  /model opus", "\t/model", "\n\n/model opus", "\u{feff}/model", "\u{200b} /model", "\r\n /model"] {
            assert_eq!(refused(text), "/model", "{text:?}");
        }
    }

    #[test]
    fn every_line_of_a_message_is_checked() {
        assert_eq!(refused("please look at this\n/model opus\nthanks"), "/model");
        assert_eq!(refused("/clear\r\n/permissions"), "/permissions");
        assert_eq!(refused("hello\r/login"), "/login");
        // Paths in pasted output are not commands.
        assert_eq!(check("it failed:\n/usr/bin/env: no such file\n  /tmp/x.log has more", None), Ok(()));
    }

    #[test]
    fn the_first_line_must_be_exactly_an_allowed_command() {
        // The palette completes a prefix to the nearest command.
        assert_eq!(refused("/mod"), "/mod");
        assert_eq!(refused("/"), "/");
        assert_eq!(refused("/usr/bin/env is missing"), "/usr/bin/env");
        assert_eq!(refused("/Clear"), "/Clear");
        assert_eq!(refused("/clear:x"), "/clear:x");
    }

    #[test]
    fn a_key_hidden_in_an_allowed_command_is_refused() {
        // Typed as keys: Ctrl+U would clear `/help` and leave `/model`.
        assert_eq!(refused("/help \u{15}/model opus"), "/help");
        assert_eq!(refused("/help\u{15}/model"), "/help/model");
        assert_eq!(refused("/compact\tx\u{1b}"), "/compact");
        assert_eq!(refused("/mo\t"), "/mo");
    }

    #[test]
    fn a_long_command_is_quoted_short() {
        let command = refused(&format!("/{}", "x".repeat(500)));
        assert_eq!(command.chars().count(), MAX_QUOTED + 1);
        assert!(command.ends_with('…'));
    }

    #[test]
    fn the_projects_own_commands_pass_but_cannot_unlock_a_built_in() {
        let dir = tempfile::tempdir().unwrap();
        let claude = dir.path().join(".claude");
        std::fs::create_dir_all(claude.join("commands/frontend")).unwrap();
        std::fs::create_dir_all(claude.join("skills/release")).unwrap();
        std::fs::write(claude.join("commands/deploy.md"), "Deploy").unwrap();
        std::fs::write(claude.join("commands/frontend/lint.md"), "Lint").unwrap();
        std::fs::write(claude.join("commands/model.md"), "Not the built-in").unwrap();
        std::fs::write(claude.join("skills/release/SKILL.md"), "Release").unwrap();
        std::fs::write(dir.path().join("secret.md"), "outside").unwrap();
        let project = Some(dir.path());
        for text in ["/deploy staging", "/frontend:lint", "/release", "notes\n/deploy"] {
            assert_eq!(check(text, project), Ok(()), "{text:?}");
        }
        for text in ["/model", "/dep", "/missing", "/../secret", "/frontend", "/deploy.md"] {
            assert!(check(text, project).is_err(), "{text:?}");
        }
        // Another project (or none known) has no such command.
        assert!(check("/deploy", None).is_err());
    }
}
