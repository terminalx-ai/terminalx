//! Agent harnesses.
//!
//! Two shapes live side by side. A **PTY-first** harness (Claude Code, Codex)
//! *is* its tab: the real interactive CLI runs in a terminal pane, the chat is
//! a projection of the transcript it writes, and `tui` holds everything that
//! is the same for both. A **headless** harness (ACP, OpenCode) is a peer
//! driven over a pipe: each inbound line becomes a list of `Action`s the
//! session manager applies, which is what keeps them testable on fixtures.
//!
//! Only the PTY-first two are offered to the reader; see `HIDDEN_HARNESSES`.

pub mod acp;
pub mod by_hand;
pub mod claude;
pub mod codex;
pub mod host;
pub mod opencode;
pub mod settings;
pub mod tui;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::events::Payload;

/// What a headless harness asks the session manager to do with one inbound
/// line. Nothing here touches a process, so a whole exchange can be replayed.
pub enum Action {
    Write(String),
    Emit(Payload),
    /// The thread id the server minted; the manager records it as the
    /// tab's provider session id so resume works.
    ThreadReady(String),
    /// An HTTP request for a server-backed harness; the reply comes back
    /// to the engine as a line tagged `raccoon_http`.
    Http { tag: String, method: String, url: String, body: Option<Value> },
}

/// Which CLI a PTY-first tab is running. The two differ in their launch line,
/// their hook plumbing and their transcript, and in nothing else.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliKind {
    Claude,
    Codex,
}

/// The harness a tab runs on. Unknown names are carried verbatim.
pub enum HarnessId {
    Claude,
    Codex,
    /// An ACP speaker, by the binary that speaks it.
    Acp(String),
    OpenCode,
    Other(String),
}

impl HarnessId {
    pub fn parse(s: &str) -> Self {
        match s {
            "claude" => Self::Claude,
            "codex" => Self::Codex,
            "cursor" => Self::Acp("cursor-agent".into()),
            "opencode" => Self::OpenCode,
            other => Self::Other(other.to_string()),
        }
    }
}

/// The agents this build can drive but does not offer.
///
/// Cursor (ACP) and OpenCode still work — their engines, their model entries
/// and every tab already on disk are untouched, so an existing session opens
/// and runs exactly as before. They are simply not offered for new work:
/// with Claude Code and Codex both PTY-first, these two are the only agents
/// left that have to hand off to a terminal instead of being one, and that is
/// not a shape the app wants to grow. Hiding rather than deleting keeps the
/// headless path alive for the tabs that have it, and keeps the door open.
///
/// **This list is the whole switch.** Take an id out of it and that agent is
/// offered again — in the new-session picker, the new-tab menu, Settings →
/// Agents and the model picker alike. Nothing else knows about the decision.
pub const HIDDEN_HARNESSES: &[&str] = &["cursor", "opencode"];

/// Whether the UI offers this harness at all.
pub fn visible(harness: &str) -> bool {
    !HIDDEN_HARNESSES.contains(&harness)
}

/// Which agents this build knows how to drive, and what each can do.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessInfo {
    pub id: String,
    pub name: String,
    pub binary: String,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    pub install_hint: String,
    pub install_url: String,
    pub caps: Capabilities,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub images: bool,
    pub steer: bool,
    pub permission_modes: bool,
    pub effort: bool,
    pub slash_commands: bool,
    pub at_mentions: bool,
    pub fork: bool,
    pub resume: bool,
}

/// One agent CLI as this build knows it: what it is called, what it can do,
/// and how to tell that a process is it. `catalog` and `recognise` both read
/// this table and nothing else, so an agent added here is offered, driven and
/// recognised in a terminal by the same row.
struct Spec {
    id: &'static str,
    name: &'static str,
    binary: &'static str,
    /// Packages the CLI is published as. A CLI installed through a package
    /// manager runs as an interpreter with a script inside the package
    /// (`node …/node_modules/@openai/codex/bin/codex.js`), so the binary's
    /// name alone would miss it.
    packages: &'static [&'static str],
    /// How a run of the CLI is asked to have no screen of its own: a
    /// subcommand as its first word, or a flag anywhere after it
    /// (`codex exec`, `claude -p`). Such a run is a script's or another
    /// program's, and is nobody's session.
    headless: Headless,
    install_hint: &'static str,
    install_url: &'static str,
    caps: Capabilities,
}

struct Headless {
    commands: &'static [&'static str],
    flags: &'static [&'static str],
}

const REGISTRY: &[Spec] = &[
    Spec {
        id: "claude",
        name: "Claude Code",
        binary: "claude",
        packages: &["@anthropic-ai/claude-code"],
        headless: Headless { commands: &["mcp", "doctor", "update", "install", "config", "setup-token"], flags: &["-p", "--print"] },
        install_hint: "npm install -g @anthropic-ai/claude-code && claude auth login",
        install_url: "https://claude.com/product/claude-code",
        caps: Capabilities { images: true, steer: true, permission_modes: true, effort: true, slash_commands: true, at_mentions: true, fork: true, resume: true },
    },
    Spec {
        id: "codex",
        name: "Codex",
        binary: "codex",
        packages: &["@openai/codex"],
        headless: Headless { commands: &["exec", "e", "mcp", "mcp-server", "app-server", "login", "logout", "completion"], flags: &[] },
        install_hint: "npm install -g @openai/codex && codex login",
        install_url: "https://developers.openai.com/codex/cli",
        caps: Capabilities { images: true, steer: true, permission_modes: true, effort: true, slash_commands: false, at_mentions: false, fork: false, resume: true },
    },
    Spec {
        id: "cursor",
        name: "Cursor",
        binary: "cursor-agent",
        packages: &["cursor-agent"],
        headless: Headless { commands: &[], flags: &["-p", "--print"] },
        install_hint: "curl https://cursor.com/install -fsS | bash && agent login",
        install_url: "https://cursor.com/cli",
        caps: Capabilities { images: true, steer: false, permission_modes: true, effort: false, slash_commands: false, at_mentions: false, fork: false, resume: true },
    },
    Spec {
        id: "opencode",
        name: "OpenCode",
        binary: "opencode",
        packages: &["opencode-ai"],
        headless: Headless { commands: &["run", "serve"], flags: &[] },
        install_hint: "curl -fsSL https://opencode.ai/install | bash && opencode auth login",
        install_url: "https://opencode.ai",
        caps: Capabilities { images: true, steer: false, permission_modes: true, effort: false, slash_commands: false, at_mentions: false, fork: false, resume: true },
    },
];

pub fn catalog() -> Vec<HarnessInfo> {
    REGISTRY
        .iter()
        .map(|spec| {
            let path = crate::binpath::resolve(spec.binary);
            HarnessInfo {
                id: spec.id.into(),
                name: spec.name.into(),
                binary: spec.binary.into(),
                available: path.is_some(),
                path: path.map(|p| p.to_string_lossy().into_owned()),
                install_hint: spec.install_hint.into(),
                install_url: spec.install_url.into(),
                caps: spec.caps,
            }
        })
        .collect()
}

/// What an agent is called in a sentence the reader is shown.
pub fn display_name(harness: &str) -> &'static str {
    REGISTRY.iter().find(|spec| spec.id == harness).map_or("The agent", |spec| spec.name)
}

/// Programs that run a script named by their first argument that is not an
/// option. A CLI installed with a package manager is one of these running the
/// package's entry file.
const INTERPRETERS: &[&str] = &["node", "nodejs", "bun", "deno", "tsx"];

fn file_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// A program's name without the extension a script or a Windows binary has.
fn program_stem(path: &str) -> &str {
    let name = file_name(path);
    [".js", ".mjs", ".cjs", ".exe", ".cmd"].iter().find_map(|ext| name.strip_suffix(ext)).unwrap_or(name)
}

/// Which agent's CLI a process is, from its command line (#437).
///
/// One rule for every row of the registry: the program is the agent's binary
/// by name, wherever it lives (a version manager's shim, an alias the shell
/// expanded, an absolute path), or it is an interpreter running the agent's
/// binary or a file inside the agent's package (`npx`, a global `npm`
/// install). Which agent it is comes from the program and its script alone,
/// never from the rest of the arguments: `vim claude.md` and `grep codex`
/// are not agents.
///
/// The rest is read for one thing, which is whether the run was asked to
/// have no screen (`Spec::headless`). `claude -p` and `codex exec` are the
/// agent's binary and nobody's session, and they are started by programs
/// that do hold a terminal the way a session does: an editor's plugin,
/// `watch`, a spinner. A command line is only known as words, so a prompt
/// given as an argument with a bare `-p` in it reads as such a run too; the
/// tab then stays a terminal, which is the lesser mistake.
///
/// `argv` is the command line split into words, as far as that is known; a
/// path with a space in it is simply not recognised.
pub fn recognise<'a>(argv: impl IntoIterator<Item = &'a str>) -> Option<&'static str> {
    let mut argv = argv.into_iter();
    let program = argv.next()?;
    let script = INTERPRETERS.contains(&program_stem(program)).then(|| argv.find(|arg| !arg.starts_with('-'))).flatten();
    let spec = REGISTRY.iter().find(|spec| {
        let named = |word: &str| program_stem(word) == spec.binary;
        let packaged = |word: &str| spec.packages.iter().any(|package| word.contains(&format!("/{package}/")));
        named(program) || script.is_some_and(|script| named(script) || packaged(script))
    })?;
    // What is left of the command line is the CLI's own.
    let mut own = argv.peekable();
    let headless = own.peek().is_some_and(|first| spec.headless.commands.contains(first)) || own.any(|word| spec.headless.flags.contains(&word));
    (!headless).then_some(spec.id)
}

/// The agents the UI lists. `catalog` keeps the hidden ones so a tab already
/// running on one still has its name, its binary and its capabilities.
pub fn offered() -> Vec<HarnessInfo> {
    catalog().into_iter().filter(|h| visible(&h.id)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hidden_agents_are_kept_but_not_offered() {
        let all: Vec<String> = catalog().into_iter().map(|h| h.id).collect();
        for id in HIDDEN_HARNESSES {
            assert!(all.iter().any(|h| h == id), "{id} should still be in the catalog");
        }
        let offered: Vec<String> = offered().into_iter().map(|h| h.id).collect();
        assert_eq!(offered, ["claude", "codex"]);
    }

    fn words(command: &str) -> Option<&'static str> {
        recognise(command.split_whitespace())
    }

    #[test]
    fn every_registered_cli_is_recognised_by_its_binary_wherever_it_lives() {
        for spec in REGISTRY {
            assert_eq!(words(spec.binary), Some(spec.id));
            assert_eq!(words(&format!("/Users/me/.local/bin/{} --resume abc", spec.binary)), Some(spec.id));
            assert_eq!(words(&format!("/Users/me/.asdf/shims/{}", spec.binary)), Some(spec.id));
            assert!(!matches!(HarnessId::parse(spec.id), HarnessId::Other(_)), "{} is in the registry but is not a harness", spec.id);
        }
    }

    #[test]
    fn a_cli_run_by_an_interpreter_is_recognised_by_its_script_or_its_package() {
        assert_eq!(words("node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js --continue"), Some("claude"));
        assert_eq!(words("node --no-warnings /Users/me/.nvm/versions/node/v24.20.0/lib/node_modules/@openai/codex/bin/codex.js"), Some("codex"));
        // What `npx` leaves running: the package's own bin link.
        assert_eq!(words("node /Users/me/.npm/_npx/0ab1/node_modules/.bin/claude"), Some("claude"));
        assert_eq!(words("bun /Users/me/.bun/install/global/node_modules/opencode-ai/bin/opencode"), Some("opencode"));
        assert_eq!(words("node /Users/me/.local/share/cursor-agent/versions/1.2/index.js"), Some("cursor"));
    }

    /// The agent's binary run with no screen is a script's or another
    /// program's, and nobody's session, whatever holds the terminal around
    /// it: an editor's plugin runs `claude -p` with the terminal as a
    /// session has it.
    #[test]
    fn a_run_asked_to_have_no_screen_is_not_a_session() {
        for command in [
            "claude -p summarise",
            "claude --model opus --print hi",
            "/opt/homebrew/bin/claude mcp serve",
            "codex exec fix",
            "node /usr/local/lib/node_modules/@openai/codex/bin/codex.js exec fix",
            "/usr/local/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex e fix",
            "codex mcp-server",
            "cursor-agent -p hi",
            "opencode run hi",
        ] {
            assert_eq!(words(command), None, "{command}");
        }
        // A session, with whatever else it was given. A subcommand is the first word and nothing after it.
        for (command, harness) in [
            ("claude", "claude"),
            ("claude --resume 0a8b6f2e --fork-session", "claude"),
            ("claude fix the mcp config", "claude"),
            ("codex resume 01a0814c", "codex"),
            ("codex --model gpt-5 look at the exec path", "codex"),
            ("node /usr/local/lib/node_modules/@openai/codex/bin/codex.js", "codex"),
            ("opencode", "opencode"),
        ] {
            assert_eq!(words(command), Some(harness), "{command}");
        }
    }

    #[test]
    fn a_program_that_only_mentions_an_agent_is_not_one() {
        for command in ["vim claude.md", "grep -r codex .", "node server.js claude", "npm exec @anthropic-ai/claude-code", "node /usr/lib/node_modules/npm/bin/npx-cli.js @openai/codex", "cat /tmp/claude", "claude-squad", "zsh -l", "git log --author codex", ""] {
            assert_eq!(words(command), None, "{command}");
        }
    }
}
