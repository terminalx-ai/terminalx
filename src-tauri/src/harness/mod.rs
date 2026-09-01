//! Agent harnesses. Each one lives in its own module with a `parser` (wire →
//! typed) and a `mapper` (typed → `AgentEvent`), and is driven through the
//! shared child host.

pub mod acp;
pub mod claude;
pub mod codex;
pub mod host;
pub mod opencode;

use serde::{Deserialize, Serialize};

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
