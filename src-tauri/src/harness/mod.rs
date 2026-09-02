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
pub mod claude;
pub mod codex;
pub mod host;
pub mod opencode;
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

pub fn catalog() -> Vec<HarnessInfo> {
    let mut v = vec![
        HarnessInfo {
            id: "claude".into(),
            name: "Claude Code".into(),
            binary: "claude".into(),
            available: false,
            path: None,
            install_hint: "npm install -g @anthropic-ai/claude-code && claude auth login".into(),
            install_url: "https://claude.com/product/claude-code".into(),
            caps: Capabilities {
                images: true,
                steer: true,
                permission_modes: true,
                effort: true,
                slash_commands: true,
                at_mentions: true,
                fork: true,
                resume: true,
            },
        },
        HarnessInfo {
            id: "codex".into(),
            name: "Codex".into(),
            binary: "codex".into(),
            available: false,
            path: None,
            install_hint: "npm install -g @openai/codex && codex login".into(),
            install_url: "https://developers.openai.com/codex/cli".into(),
            caps: Capabilities {
                images: true,
                steer: true,
                permission_modes: true,
                effort: true,
                slash_commands: false,
                at_mentions: false,
                fork: false,
                resume: true,
            },
        },
        HarnessInfo {
            id: "cursor".into(),
            name: "Cursor".into(),
            binary: "cursor-agent".into(),
            available: false,
            path: None,
            install_hint: "curl https://cursor.com/install -fsS | bash && agent login".into(),
            install_url: "https://cursor.com/cli".into(),
            caps: Capabilities {
                images: true,
                steer: false,
                permission_modes: true,
                effort: false,
                slash_commands: false,
                at_mentions: false,
                fork: false,
                resume: true,
            },
        },
        HarnessInfo {
            id: "opencode".into(),
            name: "OpenCode".into(),
            binary: "opencode".into(),
            available: false,
            path: None,
            install_hint: "curl -fsSL https://opencode.ai/install | bash && opencode auth login".into(),
            install_url: "https://opencode.ai".into(),
            caps: Capabilities {
                images: true,
                steer: false,
                permission_modes: true,
                effort: false,
                slash_commands: false,
                at_mentions: false,
                fork: false,
                resume: true,
            },
        },
    ];
    for h in &mut v {
        if let Some(p) = crate::binpath::resolve(&h.binary) {
            h.available = true;
            h.path = Some(p.to_string_lossy().into_owned());
        }
    }
    v
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
}
