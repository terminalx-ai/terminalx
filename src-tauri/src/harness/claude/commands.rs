//! The slash-command list, read off a throwaway child.
//!
//! `system/init` names commands only once a turn is under way and carries bare
//! names; the `initialize` control request answers before any turn with a
//! description and argument hint per command. So a child is spawned, asked
//! once, and killed: ~1.5s, no model call. Cached per directory.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlashCommand {
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    /// `builtin`, `plugin` or `user`, inferred from the name and description.
    pub source: String,
}

/// Commands the app already owns; letting them through would restart or
/// retitle a session behind the app's back.
const WITHHELD: &[&str] = &["clear", "exit", "quit", "model", "rename", "fast", "resume", "login", "logout"];

type CommandCache = Mutex<HashMap<String, (Instant, Vec<SlashCommand>)>>;

fn cache() -> &'static CommandCache {
    static C: OnceLock<CommandCache> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn list(cwd: &Path) -> Result<Vec<SlashCommand>> {
    let key = cwd.to_string_lossy().into_owned();
    if let Some((at, v)) = cache().lock().unwrap().get(&key) {
        if at.elapsed() < Duration::from_secs(600) {
            return Ok(v.clone());
        }
    }
    let v = probe(cwd)?;
    cache().lock().unwrap().insert(key, (Instant::now(), v.clone()));
    Ok(v)
}

pub fn parse_commands(reply: &Value) -> Vec<SlashCommand> {
    let mut out = Vec::new();
    if let Some(cmds) = reply.pointer("/response/response/commands").or_else(|| reply.pointer("/response/commands")).and_then(|c| c.as_array()) {
        for c in cmds {
            let name = c["name"].as_str().unwrap_or("").to_string();
            if name.is_empty() || WITHHELD.contains(&name.as_str()) {
                continue;
            }
            let description = c["description"].as_str().unwrap_or("").to_string();
            let source = if name.contains(':') {
                "plugin"
            } else if description.ends_with("(user)") || description.ends_with("(project)") {
                "user"
            } else {
                "builtin"
            };
            out.push(SlashCommand {
                name,
                description: description.trim_end_matches("(user)").trim_end_matches("(project)").trim().to_string(),
                argument_hint: c["argumentHint"].as_str().filter(|s| !s.is_empty()).map(String::from),
                source: source.into(),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn probe(cwd: &Path) -> Result<Vec<SlashCommand>> {
    Ok(parse_commands(&super::ask_initialize(cwd)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_withholds() {
        let v: Value = serde_json::from_str(r#"{"type":"control_response","response":{"subtype":"success","request_id":"x","response":{"commands":[{"name":"review","description":"Review a PR","argumentHint":"[pr]"},{"name":"clear","description":"Clear"},{"name":"acme:deploy","description":"Deploy"},{"name":"notes","description":"My notes (user)"}]}}}"#).unwrap();
        let c = parse_commands(&v);
        let names: Vec<_> = c.iter().map(|x| x.name.as_str()).collect();
        assert_eq!(names, vec!["acme:deploy", "notes", "review"]);
        assert_eq!(c[0].source, "plugin");
        assert_eq!(c[1].source, "user");
        assert_eq!(c[1].description, "My notes");
        assert_eq!(c[2].argument_hint.as_deref(), Some("[pr]"));
    }
}
