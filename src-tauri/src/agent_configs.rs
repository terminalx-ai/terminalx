//! Copy MCP servers, slash commands and skills between Claude Code and Codex
//! (PRO-153, Settings › General › Copy agent configs, design 09.05).
//!
//! What is compared, in the reader's own homes (`$CLAUDE_CONFIG_DIR` and
//! `$CODEX_HOME` move them, as they move the CLIs):
//!
//! | | Claude Code | Codex |
//! |---|---|---|
//! | MCP servers | `~/.claude.json` → `mcpServers` | `~/.codex/config.toml` → `[mcp_servers.*]` |
//! | Slash commands | `~/.claude/commands/<name>.md` | `~/.codex/prompts/<name>.md` |
//! | Skills | `~/.claude/skills/<name>/` | `~/.codex/skills/<name>/` |
//!
//! Each item is "Only in Claude Code", "Only in Codex", "Different" or
//! "Same". Copying converts the format: a server is read into one shape
//! ([`Transport`]) and written out in the other agent's; a command keeps the
//! frontmatter both agents read (`description`, `argument-hint`). What the
//! other side has no place for is named in a note, never silently dropped.
//!
//! This is the one place TerminalX writes into those homes, and only on the
//! reader's Apply, after a preview of the exact text. A write never deletes
//! anything: other servers, keys, comments and files stay as they are, and a
//! skill copied over another keeps the files only the target had. Every
//! existing file is copied aside first (`config.toml.bak-2026-11-19`, a skill
//! folder under `$TERMINALX_HOME/backups/skills`), and every config write is
//! parsed back and checked before it replaces the file. The managed Codex
//! home mirrors `mcp_servers` and links `prompts` and `skills`
//! (`harness::codex::home`), so a new tab sees the change.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;
use sha2::{Digest, Sha256};

const TEXT_LIMIT: u64 = 4 * 1024 * 1024;
const COMMAND_LIMIT: u64 = 256 * 1024;
const SKILL_FILE_LIMIT: usize = 2048;
const SKILL_BYTES_LIMIT: u64 = 32 * 1024 * 1024;
/// Frontmatter keys both agents read in a command file.
const SHARED_FRONTMATTER: &[&str] = &["description", "argument-hint"];

// ------------------------------------------------------------------ wire

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Mcp,
    Command,
    Skill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    OnlyClaude,
    Different,
    OnlyCodex,
    Same,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    ToCodex,
    ToClaude,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub kind: Kind,
    pub name: String,
    pub status: Status,
    /// Claude Code's version in one line, when it has one.
    pub claude_summary: Option<String>,
    pub codex_summary: Option<String>,
    /// Why this item cannot be copied to Codex, when it cannot.
    pub to_codex_blocked: Option<String>,
    pub to_claude_blocked: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
    pub claude_file: String,
    pub codex_file: String,
    pub items: Vec<Item>,
    /// A source that could not be read; its items are missing from the list.
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub kind: Kind,
    pub name: String,
    pub direction: Direction,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    /// The file or folder written, `~`-relative.
    pub path: String,
    /// Where the current one is copied first; none when it does not exist yet.
    pub backup: Option<String>,
    /// What is written: the added or replaced entries of a config file, a
    /// command file in full, or a skill's file list and `SKILL.md`.
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub kind: Kind,
    pub name: String,
    pub text: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub mcp: usize,
    pub command: usize,
    pub skill: usize,
}

impl Counts {
    fn bump(&mut self, kind: Kind) {
        match kind {
            Kind::Mcp => self.mcp += 1,
            Kind::Command => self.command += 1,
            Kind::Skill => self.skill += 1,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub files: Vec<PreviewFile>,
    pub notes: Vec<Note>,
    pub added: Counts,
    pub replaced: Counts,
    /// Stands for exactly these writes over exactly these files; Apply refuses
    /// another, so what is written is what was shown.
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Written {
    pub path: String,
    pub backup: Option<String>,
}

// ------------------------------------------------------------------ homes

/// Where each agent keeps what is compared, and where skill backups go.
#[derive(Debug, Clone)]
pub struct Homes {
    pub home: PathBuf,
    pub claude_json: PathBuf,
    pub claude_dir: PathBuf,
    pub codex_dir: PathBuf,
    pub backups: PathBuf,
}

impl Homes {
    pub fn current() -> Result<Self> {
        let home = dirs::home_dir().context("no home directory")?;
        let env_dir = |name: &str| std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from);
        let (claude_dir, claude_json) = match env_dir("CLAUDE_CONFIG_DIR") {
            Some(dir) => (dir.clone(), dir.join(".claude.json")),
            None => (home.join(".claude"), home.join(".claude.json")),
        };
        let codex_dir = crate::harness::codex::home::user_root().unwrap_or_else(|| home.join(".codex"));
        let backups = crate::store::root()?.join("backups");
        Ok(Homes { home, claude_json, claude_dir, codex_dir, backups })
    }

    fn codex_toml(&self) -> PathBuf {
        self.codex_dir.join("config.toml")
    }

    fn pretty(&self, path: &Path) -> String {
        match path.strip_prefix(&self.home) {
            Ok(rest) if !rest.as_os_str().is_empty() => {
                let rest = rest.to_string_lossy();
                // Shown as the rest of the app writes these paths: `~/.codex/config.toml`.
                #[cfg(windows)]
                let rest = rest.replace('\\', "/");
                format!("~/{rest}")
            }
            _ => path.to_string_lossy().into_owned(),
        }
    }

    fn commands_dir(&self, side: Direction) -> PathBuf {
        match side {
            Direction::ToClaude => self.claude_dir.join("commands"),
            Direction::ToCodex => self.codex_dir.join("prompts"),
        }
    }

    fn skills_dir(&self, side: Direction) -> PathBuf {
        match side {
            Direction::ToClaude => self.claude_dir.join("skills"),
            Direction::ToCodex => self.codex_dir.join("skills"),
        }
    }
}

// ------------------------------------------------------------------ servers

/// A value an agent passes to a server: as written, or read from the
/// environment the agent runs in.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Val {
    Literal(String),
    Env(String),
    /// `Authorization: Bearer ${VAR}`, which Codex spells `bearer_token_env_var`.
    Bearer(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Transport {
    Stdio { command: String, args: Vec<String>, env: BTreeMap<String, Val> },
    Http { url: String, headers: BTreeMap<String, Val> },
    Sse { url: String, headers: BTreeMap<String, Val> },
}

#[derive(Debug, Clone)]
struct Server {
    transport: Result<Transport, String>,
    /// Settings this side has that the other has no place for.
    stays: Vec<String>,
}

fn env_ref(value: &str) -> Option<&str> {
    let inner = value.strip_prefix("${")?.strip_suffix('}')?;
    let mut chars = inner.chars();
    let first = chars.next()?;
    ((first.is_ascii_alphabetic() || first == '_') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')).then_some(inner)
}

fn claude_val(key: &str, value: &str, header: bool) -> Val {
    if header && key.eq_ignore_ascii_case("authorization") {
        if let Some(var) = value.strip_prefix("Bearer ").and_then(env_ref) {
            return Val::Bearer(var.to_string());
        }
    }
    match env_ref(value) {
        Some(var) => Val::Env(var.to_string()),
        None => Val::Literal(value.to_string()),
    }
}

fn string_map(value: Option<&Value>, what: &str) -> Result<BTreeMap<String, String>, String> {
    let Some(value) = value else { return Ok(BTreeMap::new()) };
    let object = value.as_object().ok_or_else(|| format!("`{what}` is not an object"))?;
    object
        .iter()
        .map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())).ok_or_else(|| format!("`{what}.{k}` is not a string")))
        .collect()
}

fn parse_claude_server(value: &Value) -> Server {
    let mut stays = Vec::new();
    let transport = (|| -> Result<Transport, String> {
        let object = value.as_object().ok_or("not an object")?;
        let kind = object.get("type").and_then(Value::as_str).unwrap_or("stdio");
        let known: &[&str] = match kind {
            "stdio" => &["type", "command", "args", "env"],
            "http" | "sse" => &["type", "url", "headers"],
            other => return Err(format!("Claude Code's `{other}` transport has no Codex equivalent")),
        };
        for key in object.keys().filter(|k| !known.contains(&k.as_str())) {
            stays.push(format!("`{key}` stays in Claude Code only"));
        }
        let mut braces = |map: &BTreeMap<String, String>, what: &str| {
            for (k, v) in map {
                if v.contains("${") && env_ref(v).is_none() && !(what == "headers" && v.strip_prefix("Bearer ").and_then(env_ref).is_some()) {
                    stays.push(format!("`{what}.{k}` is copied as written; Codex does not expand ${{…}} inside a value"));
                }
            }
        };
        match kind {
            "stdio" => {
                let command = object.get("command").and_then(Value::as_str).ok_or("no `command`")?.to_string();
                let args = match object.get("args") {
                    None => Vec::new(),
                    Some(v) => v
                        .as_array()
                        .ok_or("`args` is not a list")?
                        .iter()
                        .map(|a| a.as_str().map(String::from).ok_or("`args` holds a non-string"))
                        .collect::<Result<_, _>>()?,
                };
                let env = string_map(object.get("env"), "env")?;
                braces(&env, "env");
                let env = env.iter().map(|(k, v)| (k.clone(), claude_val(k, v, false))).collect();
                Ok(Transport::Stdio { command, args, env })
            }
            _ => {
                let url = object.get("url").and_then(Value::as_str).ok_or("no `url`")?.to_string();
                let headers = string_map(object.get("headers"), "headers")?;
                braces(&headers, "headers");
                let headers = headers.iter().map(|(k, v)| (k.clone(), claude_val(k, v, true))).collect();
                Ok(if kind == "http" { Transport::Http { url, headers } } else { Transport::Sse { url, headers } })
            }
        }
    })();
    Server { transport, stays }
}

fn toml_strings(value: Option<&toml::Value>, what: &str) -> Result<Vec<String>, String> {
    let Some(value) = value else { return Ok(Vec::new()) };
    value
        .as_array()
        .ok_or_else(|| format!("`{what}` is not a list"))?
        .iter()
        .map(|v| match v {
            toml::Value::String(s) => Ok(s.clone()),
            // `env_vars = [{ name = "X" }]`, the long form.
            toml::Value::Table(t) => t.get("name").and_then(toml::Value::as_str).map(String::from).ok_or_else(|| format!("`{what}` holds an entry without a name")),
            _ => Err(format!("`{what}` holds a non-string")),
        })
        .collect()
}

fn toml_string_map(value: Option<&toml::Value>, what: &str) -> Result<BTreeMap<String, String>, String> {
    let Some(value) = value else { return Ok(BTreeMap::new()) };
    value
        .as_table()
        .ok_or_else(|| format!("`{what}` is not a table"))?
        .iter()
        .map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())).ok_or_else(|| format!("`{what}.{k}` is not a string")))
        .collect()
}

fn parse_codex_server(value: &toml::Value) -> Server {
    let mut stays = Vec::new();
    let transport = (|| -> Result<Transport, String> {
        let table = value.as_table().ok_or("not a table")?;
        if table.get("enabled").and_then(toml::Value::as_bool) == Some(false) {
            stays.push("turned off in Codex (`enabled = false`); Claude Code starts it".to_string());
        }
        if let Some(command) = table.get("command") {
            for key in table.keys().filter(|k| !["command", "args", "env", "env_vars", "enabled"].contains(&k.as_str())) {
                stays.push(format!("`{key}` stays in Codex only"));
            }
            let command = command.as_str().ok_or("`command` is not a string")?.to_string();
            let args = toml_strings(table.get("args"), "args")?;
            let mut env: BTreeMap<String, Val> = toml_string_map(table.get("env"), "env")?.into_iter().map(|(k, v)| (k, Val::Literal(v))).collect();
            for name in toml_strings(table.get("env_vars"), "env_vars")? {
                env.insert(name.clone(), Val::Env(name));
            }
            Ok(Transport::Stdio { command, args, env })
        } else if let Some(url) = table.get("url") {
            for key in table.keys().filter(|k| !["url", "bearer_token_env_var", "http_headers", "env_http_headers", "enabled"].contains(&k.as_str())) {
                stays.push(format!("`{key}` stays in Codex only"));
            }
            let url = url.as_str().ok_or("`url` is not a string")?.to_string();
            let mut headers: BTreeMap<String, Val> = toml_string_map(table.get("http_headers"), "http_headers")?.into_iter().map(|(k, v)| (k, Val::Literal(v))).collect();
            for (k, v) in toml_string_map(table.get("env_http_headers"), "env_http_headers")? {
                headers.insert(k, Val::Env(v));
            }
            if let Some(var) = table.get("bearer_token_env_var") {
                let var = var.as_str().ok_or("`bearer_token_env_var` is not a string")?;
                headers.insert("Authorization".into(), Val::Bearer(var.to_string()));
            }
            Ok(Transport::Http { url, headers })
        } else {
            Err("has neither `command` nor `url`".to_string())
        }
    })();
    Server { transport, stays }
}

fn summary(transport: &Result<Transport, String>) -> String {
    match transport {
        Ok(Transport::Stdio { command, args, .. }) => std::iter::once(command.as_str()).chain(args.iter().map(String::as_str)).collect::<Vec<_>>().join(" "),
        Ok(Transport::Http { url, .. }) => url.clone(),
        Ok(Transport::Sse { url, .. }) => format!("{url} · SSE"),
        Err(error) => format!("unreadable: {error}"),
    }
}

/// The header or env entries, compared with header names in any case.
fn same_transport(a: &Transport, b: &Transport) -> bool {
    let fold = |m: &BTreeMap<String, Val>| m.iter().map(|(k, v)| (k.to_ascii_lowercase(), v.clone())).collect::<BTreeMap<_, _>>();
    match (a, b) {
        (Transport::Http { url: ua, headers: ha }, Transport::Http { url: ub, headers: hb }) => ua == ub && fold(ha) == fold(hb),
        _ => a == b,
    }
}

/// `[mcp_servers.<name>]` as Codex reads it.
fn codex_table(transport: &Transport) -> Result<toml_edit::Table, String> {
    use toml_edit::{value, Array, InlineTable};
    let mut table = toml_edit::Table::new();
    match transport {
        Transport::Stdio { command, args, env } => {
            table["command"] = value(command.as_str());
            if !args.is_empty() {
                table["args"] = value(args.iter().map(String::as_str).collect::<Array>());
            }
            let mut literal = InlineTable::new();
            let mut passed = Array::new();
            for (key, val) in env {
                match val {
                    Val::Literal(s) => {
                        literal.insert(key.as_str(), s.as_str().into());
                    }
                    Val::Env(var) if var == key => passed.push(var.as_str()),
                    Val::Env(var) | Val::Bearer(var) => {
                        return Err(format!("`env.{key}` reads ${{{var}}}; Codex passes a variable only under its own name"));
                    }
                }
            }
            if !literal.is_empty() {
                table["env"] = value(literal);
            }
            if !passed.is_empty() {
                table["env_vars"] = value(passed);
            }
        }
        Transport::Http { url, headers } => {
            table["url"] = value(url.as_str());
            let mut literal = InlineTable::new();
            let mut from_env = InlineTable::new();
            for (key, val) in headers {
                match val {
                    Val::Bearer(var) => table["bearer_token_env_var"] = value(var.as_str()),
                    Val::Env(var) => {
                        from_env.insert(key.as_str(), var.as_str().into());
                    }
                    Val::Literal(s) => {
                        literal.insert(key.as_str(), s.as_str().into());
                    }
                }
            }
            if !literal.is_empty() {
                table["http_headers"] = value(literal);
            }
            if !from_env.is_empty() {
                table["env_http_headers"] = value(from_env);
            }
        }
        Transport::Sse { .. } => return Err("Codex has no SSE transport; it takes stdio and streamable HTTP servers".into()),
    }
    Ok(table)
}

/// A config file's new text, the preview snippet, and per replaced server the target's own keys it kept.
type Edited = (String, String, Vec<(String, Vec<String>)>);

/// Keys that say how a server is reached. Everything else on a server being
/// replaced is the target's own (`enabled`, timeouts, `oauth`…) and is kept.
const CODEX_TRANSPORT_KEYS: &[&str] = &["command", "args", "env", "env_vars", "url", "bearer_token_env_var", "http_headers", "env_http_headers"];
const CLAUDE_TRANSPORT_KEYS: &[&str] = &["type", "command", "args", "env", "url", "headers"];

/// The server as Claude Code's `mcpServers` holds it, keys in the order
/// `claude mcp add` writes them, then `kept` (the replaced entry's own
/// settings), indented to sit at `depth`.
fn claude_entry(transport: &Transport, depth: usize, kept: &[(String, Value)]) -> String {
    let render = |val: &Val| match val {
        Val::Literal(s) => s.clone(),
        Val::Env(var) => format!("${{{var}}}"),
        Val::Bearer(var) => format!("Bearer ${{{var}}}"),
    };
    let map = |m: &BTreeMap<String, Val>| Value::Object(m.iter().map(|(k, v)| (k.clone(), Value::String(render(v)))).collect());
    let mut pairs: Vec<(String, Value)> = Vec::new();
    match transport {
        Transport::Stdio { command, args, env } => {
            pairs.push(("type".into(), "stdio".into()));
            pairs.push(("command".into(), command.as_str().into()));
            pairs.push(("args".into(), Value::Array(args.iter().map(|a| Value::String(a.clone())).collect())));
            pairs.push(("env".into(), map(env)));
        }
        Transport::Http { url, headers } | Transport::Sse { url, headers } => {
            pairs.push(("type".into(), if matches!(transport, Transport::Http { .. }) { "http" } else { "sse" }.into()));
            pairs.push(("url".into(), url.as_str().into()));
            if !headers.is_empty() {
                pairs.push(("headers".into(), map(headers)));
            }
        }
    }
    pairs.extend(kept.iter().cloned());
    let pad = "  ".repeat(depth + 1);
    let body = pairs
        .iter()
        .map(|(k, v)| {
            let text = serde_json::to_string_pretty(v).expect("a JSON value serialises");
            format!("{pad}{}: {}", Value::String(k.clone()), indent_after_first(&text, &pad))
        })
        .collect::<Vec<_>>()
        .join(",\n");
    format!("{{\n{body}\n{}}}", "  ".repeat(depth))
}

fn indent_after_first(text: &str, pad: &str) -> String {
    let mut lines = text.lines();
    let mut out = lines.next().unwrap_or("").to_string();
    for line in lines {
        out.push('\n');
        out.push_str(pad);
        out.push_str(line);
    }
    out
}

// ------------------------------------------------------------------ commands

/// A command file's frontmatter, split into its top-level keys with their
/// lines as written, and the body after it.
fn split_frontmatter(text: &str) -> Option<(Vec<(String, String)>, &str)> {
    let rest = text.strip_prefix("---\n")?;
    let (front, body) = if let Some(end) = rest.find("\n---\n") {
        (&rest[..end + 1], &rest[end + 5..])
    } else if let Some(front) = rest.strip_suffix("\n---") {
        (&rest[..front.len() + 1], "")
    } else {
        ("", rest.strip_prefix("---\n")?)
    };
    let mut blocks: Vec<(String, String)> = Vec::new();
    for line in front.split_inclusive('\n') {
        let top = !line.starts_with([' ', '\t', '#', '-']) && line.contains(':');
        if top {
            blocks.push((line.split(':').next().unwrap_or("").trim().to_string(), line.to_string()));
        } else if let Some(last) = blocks.last_mut() {
            last.1.push_str(line);
        }
    }
    Some((blocks, body))
}

fn frontmatter_value(text: &str, key: &str) -> Option<String> {
    let (blocks, _) = split_frontmatter(text)?;
    let (_, block) = blocks.into_iter().find(|(k, _)| k == key)?;
    let parsed: serde_yaml::Mapping = serde_yaml::from_str(&block).ok()?;
    parsed.get(key)?.as_str().map(|s| s.trim().to_string())
}

/// The command as the other agent reads it, and what does not carry over.
fn convert_command(text: &str, to: Direction) -> (String, Vec<String>) {
    let text = text.replace("\r\n", "\n");
    let from = match to {
        Direction::ToCodex => "Claude Code",
        Direction::ToClaude => "Codex",
    };
    let mut notes = Vec::new();
    let (out, body) = match split_frontmatter(&text) {
        Some((blocks, body)) => {
            let (kept, dropped): (Vec<_>, Vec<_>) = blocks.into_iter().partition(|(k, _)| SHARED_FRONTMATTER.contains(&k.as_str()));
            for (key, _) in dropped {
                notes.push(format!("`{key}` stays in {from} only"));
            }
            let head = if kept.is_empty() { String::new() } else { format!("---\n{}---\n", kept.into_iter().map(|(_, b)| b).collect::<String>()) };
            (format!("{head}{body}"), body.to_string())
        }
        None => (text.clone(), text.clone()),
    };
    match to {
        Direction::ToCodex => {
            if body.contains("!`") {
                notes.push("Codex does not run !`…` lines; they are copied as text".into());
            }
            if body.split_whitespace().any(|w| w.len() > 1 && w.starts_with('@') && !w[1..].starts_with('@')) {
                notes.push("Codex does not read @file references; they are copied as text".into());
            }
        }
        Direction::ToClaude => {
            let named = body
                .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
                .filter(|w| w.len() > 1 && w.starts_with('$') && w[1..].starts_with(|c: char| c.is_ascii_uppercase()) && *w != "$ARGUMENTS")
                .collect::<BTreeSet<_>>();
            if !named.is_empty() {
                notes.push(format!("Claude Code does not fill named placeholders ({}); it fills $ARGUMENTS and $1…$9", named.into_iter().collect::<Vec<_>>().join(", ")));
            }
        }
    }
    (out, notes)
}

fn normalized(text: &str) -> String {
    text.replace("\r\n", "\n").trim_end().to_string()
}

fn command_summary(text: &str) -> String {
    let line = frontmatter_value(text, "description").filter(|d| !d.is_empty()).unwrap_or_else(|| {
        let body = split_frontmatter(text).map(|(_, b)| b.to_string()).unwrap_or_else(|| text.to_string());
        body.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").trim_start_matches('#').trim().to_string()
    });
    let mut out: String = line.chars().take(120).collect();
    if line.chars().count() > 120 {
        out.push('…');
    }
    out
}

fn same_command(claude: &str, codex: &str) -> bool {
    let (c, _) = convert_command(claude, Direction::ToCodex);
    let (x, _) = convert_command(codex, Direction::ToClaude);
    normalized(claude) == normalized(codex) || normalized(&c) == normalized(codex) || normalized(&x) == normalized(claude)
}

// ------------------------------------------------------------------ skills

#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillFile {
    rel: PathBuf,
    hash: [u8; 32],
    len: u64,
    executable: bool,
}

#[derive(Debug, Clone)]
struct Skill {
    dir: PathBuf,
    /// Where the listed folder is a link, what it links to.
    link: Option<PathBuf>,
    description: String,
    files: Result<Vec<SkillFile>, String>,
}

#[cfg(unix)]
fn is_executable(meta: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &fs::Metadata) -> bool {
    false
}

/// Every file in a skill folder. A link is followed only while it stays
/// inside the folder: one that points out of it (at `~/.ssh`, say) makes the
/// skill uncopyable rather than copying what it points at.
fn skill_files(dir: &Path) -> Result<Vec<SkillFile>, String> {
    fn walk(root: &Path, real_root: &Path, dir: &Path, seen: &mut HashSet<PathBuf>, out: &mut Vec<SkillFile>, bytes: &mut u64) -> Result<(), String> {
        let real = fs::canonicalize(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        if !seen.insert(real) {
            return Ok(());
        }
        let mut entries: Vec<_> = fs::read_dir(dir).map_err(|e| format!("{}: {e}", dir.display()))?.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let name = entry.file_name();
            if name == ".DS_Store" || name == ".git" {
                continue;
            }
            let path = entry.path();
            let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
            let link = fs::symlink_metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            if link.file_type().is_symlink() {
                let points_at = fs::canonicalize(&path).map_err(|_| format!("{} is a broken link", rel.display()))?;
                if !points_at.starts_with(real_root) {
                    return Err(format!("{} links outside the skill folder", rel.display()));
                }
            }
            let meta = fs::metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            if meta.is_dir() {
                walk(root, real_root, &path, seen, out, bytes)?;
            } else if meta.is_file() {
                if out.len() >= SKILL_FILE_LIMIT {
                    return Err(format!("more than {SKILL_FILE_LIMIT} files"));
                }
                *bytes += meta.len();
                if *bytes > SKILL_BYTES_LIMIT {
                    return Err(format!("larger than {} MB", SKILL_BYTES_LIMIT / 1024 / 1024));
                }
                let data = fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
                out.push(SkillFile {
                    rel,
                    hash: Sha256::digest(&data).into(),
                    len: meta.len(),
                    executable: is_executable(&meta),
                });
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    let real_root = fs::canonicalize(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    walk(dir, &real_root, dir, &mut HashSet::new(), &mut out, &mut 0)?;
    Ok(out)
}

fn read_skills(root: &Path) -> BTreeMap<String, Skill> {
    let mut out = BTreeMap::new();
    let Ok(entries) = fs::read_dir(root) else { return out };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let dir = entry.path();
        let skill_md = dir.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let link = fs::symlink_metadata(&dir).ok().filter(|m| m.file_type().is_symlink()).and_then(|_| fs::canonicalize(&dir).ok());
        let description = read_text(&skill_md, COMMAND_LIMIT).ok().and_then(|t| frontmatter_value(&t, "description")).unwrap_or_default();
        out.insert(name, Skill { files: skill_files(&dir), dir, link, description });
    }
    out
}

fn skill_summary(skill: &Skill) -> String {
    let count = skill.files.as_ref().map(Vec::len).unwrap_or(0);
    let lead = if skill.description.is_empty() { String::new() } else { format!("{} · ", skill.description.chars().take(100).collect::<String>()) };
    format!("{lead}{count} file{}", if count == 1 { "" } else { "s" })
}

// ------------------------------------------------------------------ reading

fn read_text(path: &Path, limit: u64) -> Result<String> {
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    if file.metadata()?.len() > limit {
        bail!("{} is larger than {} bytes", path.display(), limit);
    }
    let mut text = String::new();
    file.take(limit).read_to_string(&mut text).with_context(|| format!("read {}", path.display()))?;
    Ok(text)
}

/// A file's text, or none when it is not there.
fn read_optional(path: &Path) -> Result<Option<String>> {
    match fs::metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
        Ok(_) => read_text(path, TEXT_LIMIT).map(Some),
    }
}

#[derive(Default)]
struct Side {
    servers: BTreeMap<String, Server>,
    commands: BTreeMap<String, String>,
    skills: BTreeMap<String, Skill>,
}

fn read_commands(dir: &Path) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Ok(entries) = fs::read_dir(dir) else { return out };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).and_then(|n| n.strip_suffix(".md")) else { continue };
        if name.is_empty() || name.starts_with('.') || !path.is_file() {
            continue;
        }
        match read_text(&path, COMMAND_LIMIT) {
            Ok(text) => {
                out.insert(name.to_string(), text);
            }
            Err(error) => log::debug!("skipping command {}: {error:#}", path.display()),
        }
    }
    out
}

fn claude_servers_of(text: &str) -> Result<BTreeMap<String, Server>> {
    let root: Value = serde_json::from_str(text).context("not valid JSON")?;
    let Some(servers) = root.get("mcpServers") else { return Ok(BTreeMap::new()) };
    let servers = servers.as_object().context("`mcpServers` is not an object")?;
    Ok(servers.iter().map(|(k, v)| (k.clone(), parse_claude_server(v))).collect())
}

fn codex_servers_of(text: &str) -> Result<BTreeMap<String, Server>> {
    let root: toml::Table = toml::from_str(text).context("not valid TOML")?;
    let Some(servers) = root.get("mcp_servers") else { return Ok(BTreeMap::new()) };
    let servers = servers.as_table().context("`mcp_servers` is not a table")?;
    Ok(servers.iter().map(|(k, v)| (k.clone(), parse_codex_server(v))).collect())
}

fn read_sides(homes: &Homes, problems: &mut Vec<String>) -> (Side, Side) {
    let mut claude = Side::default();
    let mut codex = Side::default();
    match read_optional(&homes.claude_json).and_then(|t| t.map(|t| claude_servers_of(&t)).transpose()) {
        Ok(servers) => claude.servers = servers.unwrap_or_default(),
        Err(error) => problems.push(format!("{}: {error:#}", homes.pretty(&homes.claude_json))),
    }
    match read_optional(&homes.codex_toml()).and_then(|t| t.map(|t| codex_servers_of(&t)).transpose()) {
        Ok(servers) => codex.servers = servers.unwrap_or_default(),
        Err(error) => problems.push(format!("{}: {error:#}", homes.pretty(&homes.codex_toml()))),
    }
    claude.commands = read_commands(&homes.commands_dir(Direction::ToClaude));
    codex.commands = read_commands(&homes.commands_dir(Direction::ToCodex));
    claude.skills = read_skills(&homes.skills_dir(Direction::ToClaude));
    codex.skills = read_skills(&homes.skills_dir(Direction::ToCodex));
    (claude, codex)
}

/// Codex keys a server by a bare TOML key; anything else is quoted, which
/// `codex mcp` refuses.
fn codex_name_ok(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn file_name_ok(name: &str) -> bool {
    !name.is_empty() && !name.starts_with('.') && !name.contains(['/', '\\', '\0'])
}

// ------------------------------------------------------------------ compare

pub fn compare() -> Result<Comparison> {
    compare_in(&Homes::current()?)
}

pub fn compare_in(homes: &Homes) -> Result<Comparison> {
    let mut problems = Vec::new();
    let (claude, codex) = read_sides(homes, &mut problems);
    let mut items = Vec::new();

    let names = claude.servers.keys().chain(codex.servers.keys()).cloned().collect::<BTreeSet<_>>();
    for name in names {
        let (a, b) = (claude.servers.get(&name), codex.servers.get(&name));
        let status = status_of(a.is_some(), b.is_some(), || match (&a.unwrap().transport, &b.unwrap().transport) {
            (Ok(x), Ok(y)) => same_transport(x, y),
            _ => false,
        });
        let block = |server: Option<&Server>, to: Direction| -> Option<String> {
            let server = server?;
            let transport = match &server.transport {
                Ok(t) => t,
                Err(e) => return Some(e.clone()),
            };
            match to {
                Direction::ToCodex => {
                    if !codex_name_ok(&name) {
                        return Some("Codex server names use only letters, digits, - and _".into());
                    }
                    codex_table(transport).err()
                }
                Direction::ToClaude => None,
            }
        };
        items.push(Item {
            kind: Kind::Mcp,
            status,
            claude_summary: a.map(|s| summary(&s.transport)),
            codex_summary: b.map(|s| summary(&s.transport)),
            to_codex_blocked: if status == Status::Same { None } else { block(a, Direction::ToCodex) },
            to_claude_blocked: if status == Status::Same { None } else { block(b, Direction::ToClaude) },
            name,
        });
    }

    let names = claude.commands.keys().chain(codex.commands.keys()).cloned().collect::<BTreeSet<_>>();
    for name in names {
        let (a, b) = (claude.commands.get(&name), codex.commands.get(&name));
        let status = status_of(a.is_some(), b.is_some(), || same_command(a.unwrap(), b.unwrap()));
        items.push(Item {
            kind: Kind::Command,
            status,
            claude_summary: a.map(String::as_str).map(command_summary),
            codex_summary: b.map(String::as_str).map(command_summary),
            to_codex_blocked: None,
            to_claude_blocked: None,
            name,
        });
    }

    let names = claude.skills.keys().chain(codex.skills.keys()).cloned().collect::<BTreeSet<_>>();
    for name in names {
        let (a, b) = (claude.skills.get(&name), codex.skills.get(&name));
        let status = status_of(a.is_some(), b.is_some(), || {
            let (a, b) = (a.unwrap(), b.unwrap());
            matches!((&a.files, &b.files), (Ok(x), Ok(y)) if x == y)
        });
        let block = |from: Option<&Skill>, onto: Option<&Skill>| -> Option<String> {
            let from = from?;
            if let Err(error) = &from.files {
                return Some(format!("can't be copied: {error}"));
            }
            if let Some(Err(error)) = onto.map(|o| &o.files) {
                return Some(format!("the other side's folder can't be copied over: {error}"));
            }
            onto.and_then(|o| o.link.as_ref()).map(|target| format!("the other side links to {}; change that folder instead", homes.pretty(target)))
        };
        items.push(Item {
            kind: Kind::Skill,
            status,
            claude_summary: a.map(skill_summary),
            codex_summary: b.map(skill_summary),
            to_codex_blocked: if status == Status::Same { None } else { block(a, b) },
            to_claude_blocked: if status == Status::Same { None } else { block(b, a) },
            name,
        });
    }

    items.sort_by(|x, y| (x.kind, x.status, &x.name).cmp(&(y.kind, y.status, &y.name)));
    Ok(Comparison {
        claude_file: homes.pretty(&homes.claude_json),
        codex_file: homes.pretty(&homes.codex_toml()),
        items,
        problems,
    })
}

fn status_of(claude: bool, codex: bool, same: impl FnOnce() -> bool) -> Status {
    match (claude, codex) {
        (true, false) => Status::OnlyClaude,
        (false, true) => Status::OnlyCodex,
        _ if same() => Status::Same,
        _ => Status::Different,
    }
}

// ------------------------------------------------------------------ plan

#[derive(Debug, Clone)]
enum Write {
    File { path: PathBuf, before: Option<Vec<u8>>, bytes: Vec<u8> },
    Skill { source: PathBuf, target: PathBuf, files: Vec<SkillFile>, exists: bool },
}

impl Write {
    fn target(&self) -> &Path {
        match self {
            Write::File { path, .. } => path,
            Write::Skill { target, .. } => target,
        }
    }
}

struct Plan {
    writes: Vec<Write>,
    preview: Vec<PreviewFile>,
    notes: Vec<Note>,
    added: Counts,
    replaced: Counts,
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// `name.bak-<date>`, or `.bak-<date>.2` and on when that is taken.
fn backup_beside(path: &Path, date: &str) -> PathBuf {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    numbered(path.with_file_name(format!("{name}.bak-{date}")))
}

fn numbered(first: PathBuf) -> PathBuf {
    if fs::symlink_metadata(&first).is_err() {
        return first;
    }
    let base = first.to_string_lossy().into_owned();
    (2..).map(|n| PathBuf::from(format!("{base}.{n}"))).find(|p| fs::symlink_metadata(p).is_err()).expect("an unused name")
}

fn skill_backup(homes: &Homes, write: &Write, date: &str) -> Option<PathBuf> {
    let Write::Skill { target, exists: true, .. } = write else { return None };
    let agent = if target.starts_with(&homes.codex_dir) { "codex" } else { "claude" };
    let name = target.file_name()?.to_string_lossy().into_owned();
    Some(numbered(homes.backups.join("skills").join(agent).join(format!("{name}.bak-{date}"))))
}

fn backup_of(homes: &Homes, write: &Write, date: &str) -> Option<PathBuf> {
    match write {
        Write::File { path, before: Some(_), .. } => Some(backup_beside(path, date)),
        Write::File { before: None, .. } => None,
        Write::Skill { .. } => skill_backup(homes, write, date),
    }
}

fn plan(homes: &Homes, changes: &[Change]) -> Result<Plan> {
    let mut problems = Vec::new();
    let (claude, codex) = read_sides(homes, &mut problems);
    let mut changes = changes.to_vec();
    changes.sort();
    changes.dedup_by(|a, b| a.kind == b.kind && a.name == b.name);
    let mut out = Plan { writes: Vec::new(), preview: Vec::new(), notes: Vec::new(), added: Counts::default(), replaced: Counts::default() };
    let date = today();

    let mut to_codex: Vec<(String, Transport)> = Vec::new();
    let mut to_claude: Vec<(String, Transport)> = Vec::new();
    for change in &changes {
        let (from, onto) = match change.direction {
            Direction::ToCodex => (&claude, &codex),
            Direction::ToClaude => (&codex, &claude),
        };
        let note = |out: &mut Plan, text: String| out.notes.push(Note { kind: change.kind, name: change.name.clone(), text });
        let tally = |out: &mut Plan, replacing: bool| if replacing { out.replaced.bump(change.kind) } else { out.added.bump(change.kind) };
        match change.kind {
            Kind::Mcp => {
                let server = from.servers.get(&change.name).ok_or_else(|| anyhow!("MCP server `{}` is no longer there", change.name))?;
                let transport = server.transport.clone().map_err(|e| anyhow!("MCP server `{}`: {e}", change.name))?;
                if change.direction == Direction::ToCodex && !codex_name_ok(&change.name) {
                    bail!("MCP server `{}`: Codex server names use only letters, digits, - and _", change.name);
                }
                for text in &server.stays {
                    note(&mut out, text.clone());
                }
                tally(&mut out, onto.servers.contains_key(&change.name));
                match change.direction {
                    Direction::ToCodex => to_codex.push((change.name.clone(), transport)),
                    Direction::ToClaude => to_claude.push((change.name.clone(), transport)),
                }
            }
            Kind::Command => {
                if !file_name_ok(&change.name) {
                    bail!("`{}` is not a command file name", change.name);
                }
                let text = from.commands.get(&change.name).ok_or_else(|| anyhow!("command `{}` is no longer there", change.name))?;
                let (converted, notes) = convert_command(text, change.direction);
                for text in notes {
                    note(&mut out, text);
                }
                let path = homes.commands_dir(change.direction).join(format!("{}.md", change.name));
                let before = read_optional(&path)?.map(String::into_bytes);
                tally(&mut out, before.is_some());
                out.writes.push(Write::File { path, before, bytes: converted.into_bytes() });
            }
            Kind::Skill => {
                if !file_name_ok(&change.name) {
                    bail!("`{}` is not a skill folder name", change.name);
                }
                let skill = from.skills.get(&change.name).ok_or_else(|| anyhow!("skill `{}` is no longer there", change.name))?;
                let source_files = skill.files.clone().map_err(|e| anyhow!("skill `{}` can't be copied: {e}", change.name))?;
                let target = homes.skills_dir(change.direction).join(&change.name);
                // The folder on disk is checked whether or not it is a listed
                // skill: one without SKILL.md is still where every file lands.
                let found = fs::symlink_metadata(&target).ok();
                let exists = found.is_some();
                if found.is_some_and(|m| m.file_type().is_symlink()) {
                    let to = fs::read_link(&target).map(|to| homes.pretty(&target.parent().map_or(to.clone(), |p| p.join(&to)))).unwrap_or_default();
                    bail!("skill `{}` on the other side links to {to}; change that folder instead", change.name);
                }
                if exists && !target.is_dir() {
                    bail!("{} is a file, not a skill folder", homes.pretty(&target));
                }
                let had: Vec<SkillFile> = if exists {
                    skill_files(&target).map_err(|e| anyhow!("skill `{}` on the other side can't be copied over: {e}", change.name))?
                } else {
                    Vec::new()
                };
                // Only what differs is written; files only the target has stay.
                let files: Vec<SkillFile> = source_files.iter().filter(|f| !had.contains(f)).cloned().collect();
                for file in &files {
                    landing(&target, &file.rel).map_err(|e| anyhow!("skill `{}` can't be copied over: {e}", change.name))?;
                }
                let kept = had.iter().filter(|h| !source_files.iter().any(|f| f.rel == h.rel)).count();
                if kept > 0 {
                    note(&mut out, format!("{kept} file{} only the other side has stay{}", if kept == 1 { "" } else { "s" }, if kept == 1 { "s" } else { "" }));
                }
                if files.iter().any(|f| f.executable) {
                    note(&mut out, "copies executable files; read them before an agent runs this skill".into());
                }
                tally(&mut out, exists);
                out.writes.push(Write::Skill { source: skill.dir.clone(), target, files, exists });
            }
        }
    }

    if !to_codex.is_empty() {
        out.writes.push(codex_write(homes, &to_codex, &mut out.preview, &mut out.notes, &date)?);
    }
    if !to_claude.is_empty() {
        out.writes.push(claude_write(homes, &to_claude, &mut out.preview, &mut out.notes, &date)?);
    }
    for write in &out.writes {
        let backup = backup_of(homes, write, &date).map(|p| homes.pretty(&p));
        match write {
            Write::File { path, bytes, .. } if path != &homes.codex_toml() && path != &homes.claude_json => {
                out.preview.push(PreviewFile { path: homes.pretty(path), backup, text: String::from_utf8_lossy(bytes).into_owned() });
            }
            Write::Skill { source, target, files, .. } => {
                let mut text = String::new();
                if files.is_empty() {
                    text.push_str("(every file is already the same)\n");
                }
                for file in files {
                    text.push_str(&format!("{} · {}{}\n", file.rel.display(), size(file.len), if file.executable { " · executable" } else { "" }));
                }
                if files.iter().any(|f| f.rel == Path::new("SKILL.md")) {
                    if let Ok(skill_md) = read_text(&source.join("SKILL.md"), COMMAND_LIMIT) {
                        text.push_str("\n── SKILL.md ──\n");
                        text.push_str(&skill_md);
                    }
                }
                out.preview.push(PreviewFile { path: format!("{}/", homes.pretty(target)), backup, text });
            }
            _ => {}
        }
    }
    Ok(out)
}

fn size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
    }
}

/// `config.toml` with these servers added or replaced and everything else,
/// comments included, as it was. A replaced server keeps its own settings
/// (`enabled`, `cwd`, timeouts, tool lists); only how it is reached changes.
/// Also returns, per replaced server, the keys it kept.
fn codex_with(text: &str, servers: &[(String, Transport)]) -> Result<Edited> {
    let mut doc: toml_edit::DocumentMut = text.parse().context("~/.codex/config.toml is not valid TOML")?;
    let mut snippet = toml_edit::DocumentMut::new();
    let mut snippet_root = toml_edit::Table::new();
    snippet_root.set_implicit(true);
    let root = doc.as_table_mut();
    if !root.contains_key("mcp_servers") {
        let mut table = toml_edit::Table::new();
        table.set_implicit(true);
        root.insert("mcp_servers", toml_edit::Item::Table(table));
    }
    // `mcp_servers = { … }` takes inline tables only; so does a server that is one now.
    let inline_parent = root.get("mcp_servers").map(toml_edit::Item::is_inline_table).unwrap_or(false);
    let parent = root.get_mut("mcp_servers").and_then(|i| i.as_table_like_mut()).context("`mcp_servers` in config.toml is not a table")?;
    let dotted = parent.is_dotted();
    let mut kept_keys = Vec::new();
    for (name, transport) in servers {
        let mut table = codex_table(transport).map_err(|e| anyhow!("MCP server `{name}`: {e}"))?;
        let old = parent.get(name);
        if let Some(own) = old.and_then(toml_edit::Item::as_table_like) {
            let mut kept = Vec::new();
            for (key, item) in own.iter().filter(|(k, _)| !CODEX_TRANSPORT_KEYS.contains(k)) {
                table.insert(key, item.clone());
                kept.push(key.to_string());
            }
            if !kept.is_empty() {
                kept_keys.push((name.clone(), kept));
            }
        }
        let mut shown = table.clone();
        shown.set_implicit(false);
        snippet_root.insert(name, toml_edit::Item::Table(shown));
        if let Some(old) = old.and_then(toml_edit::Item::as_table) {
            // A replaced server keeps its place in the file and the comment above it.
            table.set_position(old.position());
            *table.decor_mut() = old.decor().clone();
        }
        let inline = inline_parent || old.map(toml_edit::Item::is_inline_table).unwrap_or(false);
        table.set_dotted(dotted);
        let item = if inline { toml_edit::Item::Value(toml_edit::Value::InlineTable(table.into_inline_table())) } else { toml_edit::Item::Table(table) };
        parent.insert(name, item);
    }
    snippet.as_table_mut().insert("mcp_servers", toml_edit::Item::Table(snippet_root));
    let written = doc.to_string();
    // Codex reads back exactly what was meant, and everything else is unchanged.
    let back = codex_servers_of(&written)?;
    for (name, transport) in servers {
        match back.get(name).map(|s| &s.transport) {
            Some(Ok(t)) if same_transport(t, transport) => {}
            _ => bail!("MCP server `{name}` did not read back from config.toml as written"),
        }
    }
    let before: toml::Table = toml::from_str(text).unwrap_or_default();
    let after: toml::Table = toml::from_str(&written)?;
    for (key, value) in &before {
        if key == "mcp_servers" {
            continue;
        }
        if after.get(key) != Some(value) {
            bail!("writing config.toml would change `{key}`");
        }
    }
    if let Some(toml::Value::Table(old)) = before.get("mcp_servers") {
        let new = after.get("mcp_servers").and_then(toml::Value::as_table).context("mcp_servers went missing")?;
        for (key, value) in old {
            if !servers.iter().any(|(n, _)| n == key) && new.get(key) != Some(value) {
                bail!("writing config.toml would change MCP server `{key}`");
            }
        }
    }
    Ok((written, snippet.to_string(), kept_keys))
}

fn kept_notes(notes: &mut Vec<Note>, kept: Vec<(String, Vec<String>)>, agent: &str, off: impl Fn(&str) -> bool) {
    for (name, keys) in kept {
        let list = keys.iter().map(|k| format!("`{k}`")).collect::<Vec<_>>().join(", ");
        notes.push(Note { kind: Kind::Mcp, name: name.clone(), text: format!("keeps {agent}'s own {list}") });
        if off(&name) {
            notes.push(Note { kind: Kind::Mcp, name, text: format!("stays turned off in {agent}") });
        }
    }
}

fn codex_write(homes: &Homes, servers: &[(String, Transport)], preview: &mut Vec<PreviewFile>, notes: &mut Vec<Note>, date: &str) -> Result<Write> {
    let path = homes.codex_toml();
    let before = read_optional(&path)?;
    let (written, snippet, kept) = codex_with(before.as_deref().unwrap_or(""), servers)?;
    let parsed: toml::Table = toml::from_str(&written)?;
    kept_notes(notes, kept, "Codex", |name| parsed.get("mcp_servers").and_then(|m| m.get(name)).and_then(|s| s.get("enabled")).and_then(toml::Value::as_bool) == Some(false));
    let backup = before.as_ref().map(|_| homes.pretty(&backup_beside(&path, date)));
    preview.push(PreviewFile { path: homes.pretty(&path), backup, text: snippet.trim_start().to_string() });
    Ok(Write::File { path, before: before.map(String::into_bytes), bytes: written.into_bytes() })
}

/// `~/.claude.json` with these servers added to (or replaced in)
/// `mcpServers`. Every other key keeps its place and its bytes: Claude Code
/// keeps a great deal more than servers in this file.
fn claude_with(text: &str, servers: &[(String, Transport)]) -> Result<Edited> {
    let source = if text.trim().is_empty() { "{}" } else { text };
    let mut root: IndexMap<String, Box<RawValue>> = serde_json::from_str(source).context("~/.claude.json is not a JSON object")?;
    let mut entries: IndexMap<String, Box<RawValue>> = match root.get("mcpServers") {
        Some(raw) => serde_json::from_str(raw.get()).context("`mcpServers` in ~/.claude.json is not an object")?,
        None => IndexMap::new(),
    };
    let mut snippet = Vec::new();
    let mut kept_keys = Vec::new();
    for (name, transport) in servers {
        // A replaced entry keeps its own settings (`oauth`, …); only how it is reached changes.
        let own: Vec<(String, Value)> = match entries.get(name) {
            Some(raw) => serde_json::from_str::<serde_json::Map<String, Value>>(raw.get())
                .map(|m| m.into_iter().filter(|(k, _)| !CLAUDE_TRANSPORT_KEYS.contains(&k.as_str())).collect())
                .unwrap_or_default(),
            None => Vec::new(),
        };
        if !own.is_empty() {
            kept_keys.push((name.clone(), own.iter().map(|(k, _)| k.clone()).collect()));
        }
        let entry = claude_entry(transport, 2, &own);
        snippet.push(format!("  {}: {}", Value::String(name.clone()), dedent_once(&entry)));
        entries.insert(name.clone(), RawValue::from_string(entry)?);
    }
    let servers_text = if entries.is_empty() {
        "{}".to_string()
    } else {
        format!("{{\n{}\n  }}", entries.iter().map(|(k, v)| format!("    {}: {}", Value::String(k.clone()), v.get())).collect::<Vec<_>>().join(",\n"))
    };
    root.insert("mcpServers".into(), RawValue::from_string(servers_text)?);
    let body = root.iter().map(|(k, v)| format!("  {}: {}", Value::String(k.clone()), v.get())).collect::<Vec<_>>().join(",\n");
    let mut written = format!("{{\n{body}\n}}");
    if text.ends_with('\n') {
        written.push('\n');
    }
    // Claude Code reads back exactly what was meant, and everything else is unchanged.
    let before: Value = serde_json::from_str(source)?;
    let after: Value = serde_json::from_str(&written).context("the new ~/.claude.json would not parse")?;
    for (key, value) in before.as_object().into_iter().flatten() {
        if key != "mcpServers" && after.get(key) != Some(value) {
            bail!("writing ~/.claude.json would change `{key}`");
        }
    }
    for (key, value) in before.get("mcpServers").and_then(Value::as_object).into_iter().flatten() {
        if !servers.iter().any(|(n, _)| n == key) && after["mcpServers"].get(key) != Some(value) {
            bail!("writing ~/.claude.json would change MCP server `{key}`");
        }
    }
    let back = claude_servers_of(&written)?;
    for (name, transport) in servers {
        match back.get(name).map(|s| &s.transport) {
            Some(Ok(t)) if same_transport(t, transport) => {}
            _ => bail!("MCP server `{name}` did not read back from ~/.claude.json as written"),
        }
    }
    Ok((written, format!("\"mcpServers\": {{\n{}\n}}", snippet.join(",\n")), kept_keys))
}

/// An entry rendered at depth 2, shown at depth 1 in the preview.
fn dedent_once(text: &str) -> String {
    text.lines().enumerate().map(|(i, l)| if i == 0 { l } else { l.strip_prefix("  ").unwrap_or(l) }).collect::<Vec<_>>().join("\n")
}

fn claude_write(homes: &Homes, servers: &[(String, Transport)], preview: &mut Vec<PreviewFile>, notes: &mut Vec<Note>, date: &str) -> Result<Write> {
    let path = homes.claude_json.clone();
    let before = read_optional(&path)?;
    let (written, snippet, kept) = claude_with(before.as_deref().unwrap_or(""), servers)?;
    kept_notes(notes, kept, "Claude Code", |_| false);
    let backup = before.as_ref().map(|_| homes.pretty(&backup_beside(&path, date)));
    preview.push(PreviewFile { path: homes.pretty(&path), backup, text: snippet });
    Ok(Write::File { path, before: before.map(String::into_bytes), bytes: written.into_bytes() })
}

fn token_of(writes: &[Write]) -> String {
    let mut hash = Sha256::new();
    for write in writes {
        hash.update(write.target().to_string_lossy().as_bytes());
        hash.update([0]);
        match write {
            Write::File { before, bytes, .. } => {
                hash.update(Sha256::digest(before.as_deref().unwrap_or(b"\0absent")));
                hash.update(Sha256::digest(bytes));
            }
            Write::Skill { source, files, exists, .. } => {
                hash.update(source.to_string_lossy().as_bytes());
                hash.update([*exists as u8]);
                for f in files {
                    hash.update(f.rel.to_string_lossy().as_bytes());
                    hash.update(f.hash);
                    hash.update([f.executable as u8]);
                }
            }
        }
    }
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

// ------------------------------------------------------------------ preview / apply

pub fn preview(changes: &[Change]) -> Result<Preview> {
    preview_in(&Homes::current()?, changes)
}

pub fn preview_in(homes: &Homes, changes: &[Change]) -> Result<Preview> {
    let plan = plan(homes, changes)?;
    let token = token_of(&plan.writes);
    Ok(Preview { files: plan.preview, notes: plan.notes, added: plan.added, replaced: plan.replaced, token })
}

pub fn apply(changes: &[Change], token: &str) -> Result<Vec<Written>> {
    apply_in(&Homes::current()?, changes, token)
}

pub fn apply_in(homes: &Homes, changes: &[Change], token: &str) -> Result<Vec<Written>> {
    let plan = plan(homes, changes).map_err(|e| anyhow!("Nothing was written: {e:#}"))?;
    if token_of(&plan.writes) != token {
        bail!("Nothing was written: these files changed since the preview. Look over the new preview and apply again.");
    }
    let date = today();
    let mut done: Vec<Written> = Vec::new();
    for write in &plan.writes {
        match apply_one(homes, write, &date) {
            Ok(written) => done.push(written),
            Err(stopped) => bail!("{}", stopped_message(homes, &done, &stopped)),
        }
    }
    Ok(done)
}

/// A write that stopped part way, with what it had already put on disk.
struct Stopped {
    error: anyhow::Error,
    /// What was being written.
    target: PathBuf,
    /// The backup made before the write began, which stays.
    backup: Option<PathBuf>,
    /// Skill files already copied into the target before the one that failed,
    /// relative to it. Each one is in place: `write_atomic` renames a whole
    /// file in, so the file that failed is the only one left as it was.
    copied: Vec<PathBuf>,
    /// The last of `copied` when its bytes landed but its mode was not set.
    mode_unset: Option<PathBuf>,
    /// How many files the skill copy meant to write.
    of: usize,
}

/// The error text for a stop: every file written before it, including those
/// of a skill copy that stopped part way, so "nothing" is only said when
/// nothing was.
fn stopped_message(homes: &Homes, done: &[Written], stopped: &Stopped) -> String {
    let mut wrote: Vec<String> = done.iter().map(|w| match &w.backup {
        Some(b) => format!("{} (backed up to {b})", w.path),
        None => w.path.clone(),
    }).collect();
    if !stopped.copied.is_empty() {
        let names = stopped.copied.iter().map(|rel| match &stopped.mode_unset {
            Some(unset) if unset == rel => format!("{} (its mode was not set)", rel.display()),
            _ => rel.display().to_string(),
        }).collect::<Vec<_>>().join(", ");
        let backup = stopped.backup.as_ref().map(|b| format!("; backed up to {}", homes.pretty(b))).unwrap_or_default();
        wrote.push(format!("{} of {} files into {} ({names}{backup})", stopped.copied.len(), stopped.of, homes.pretty(&stopped.target)));
    }
    let error = &stopped.error;
    if wrote.is_empty() {
        return match &stopped.backup {
            Some(b) => format!("Nothing was written: {error:#}. A backup was made at {} first.", homes.pretty(b)),
            None => format!("Nothing was written: {error:#}"),
        };
    }
    let note = match (&stopped.backup, stopped.copied.is_empty()) {
        (Some(b), true) => format!(" A backup was made at {} first.", homes.pretty(b)),
        _ => String::new(),
    };
    format!("Wrote {}, then stopped: {error:#}. Nothing after that was written.{note}", wrote.join(", "))
}

fn apply_one(homes: &Homes, write: &Write, date: &str) -> Result<Written, Stopped> {
    let backup = backup_of(homes, write, date);
    let of = match write {
        Write::Skill { files, .. } => files.len(),
        Write::File { .. } => 1,
    };
    let mut stopped = Stopped { error: anyhow!("stopped"), target: write.target().to_path_buf(), backup: None, copied: Vec::new(), mode_unset: None, of };
    if let Some(backup) = &backup {
        if let Err(e) = make_backup(write.target(), backup).with_context(|| format!("back up {}", homes.pretty(write.target()))) {
            // A backup cut short is not one to point at; nothing of the write has begun.
            stopped.error = e;
            return Err(stopped);
        }
        stopped.backup = Some(backup.clone());
    }
    let result = match write {
        Write::File { path, bytes, .. } => write_file(path, bytes),
        Write::Skill { source, target, files, .. } => copy_skill(homes, source, target, files, &mut stopped),
    };
    match result {
        Ok(()) => Ok(Written { path: homes.pretty(write.target()), backup: backup.map(|b| homes.pretty(&b)) }),
        Err(error) => {
            stopped.error = error;
            Err(stopped)
        }
    }
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let real = through_link(path)?;
    if let Some(parent) = real.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    crate::store::write_atomic(&real, bytes)
}

/// Copies each file in turn, recording each one in `progress` as soon as it
/// is in place, so a stop part way names what is already there.
fn copy_skill(homes: &Homes, source: &Path, target: &Path, files: &[SkillFile], progress: &mut Stopped) -> Result<()> {
    for file in files {
        // `plan` checked every landing already; checked again so a link
        // made since cannot carry a write out of the folder.
        let to = landing(target, &file.rel).map_err(|e| anyhow!("{e}"))?;
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
        }
        let from = source.join(&file.rel);
        let bytes = fs::read(&from).with_context(|| format!("read {}", from.display()))?;
        if Sha256::digest(&bytes).as_slice() != file.hash {
            bail!("{} changed since the preview", homes.pretty(&from));
        }
        // Named as the user knows it, not as `landing` resolved it.
        let shown = homes.pretty(&target.join(&file.rel));
        crate::store::write_atomic(&to, &bytes).with_context(|| format!("write {shown}"))?;
        progress.copied.push(file.rel.clone());
        // The source's mode, executable bits included, not write_atomic's owner-only default.
        if let Err(e) = fs::metadata(&from).and_then(|m| fs::set_permissions(&to, m.permissions())) {
            progress.mode_unset = Some(file.rel.clone());
            return Err(anyhow!(e).context(format!("set the mode of {shown}")));
        }
    }
    Ok(())
}

/// Where a write to `path` should land: the file a link points at, so a
/// `~/.codex/config.toml` kept in a dotfiles checkout stays a link.
fn through_link(path: &Path) -> Result<PathBuf> {
    let mut path = path.to_path_buf();
    for _ in 0..40 {
        match fs::symlink_metadata(&path) {
            Ok(meta) if meta.file_type().is_symlink() => {
                let to = fs::read_link(&path).with_context(|| format!("read link {}", path.display()))?;
                path = if to.is_absolute() { to } else { path.parent().map(|p| p.join(&to)).unwrap_or(to) };
            }
            _ => return Ok(path),
        }
    }
    bail!("{} is a loop of links", path.display())
}

/// Where a skill file `rel` is written inside `target`, following the links
/// already there. Refused when that lands outside the folder, on a folder, or
/// under a file: refusing in `plan` keeps a copy from stopping part way.
fn landing(target: &Path, rel: &Path) -> Result<PathBuf, String> {
    let shown = rel.display();
    if rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) {
        return Err(format!("{shown} is not a path inside the skill folder"));
    }
    let Ok(real_root) = fs::canonicalize(target) else {
        // A folder not made yet holds no links to follow.
        return Ok(target.join(rel));
    };
    let to = through_link(&target.join(rel)).map_err(|e| format!("{e:#}"))?;
    // The nearest part of the path that exists, and what is still to be made under it.
    let mut base = to.as_path();
    let mut rest = Vec::new();
    let real = loop {
        match fs::canonicalize(base) {
            Ok(real) => break real,
            Err(_) => {
                let name = base.file_name().ok_or_else(|| format!("{shown} leads out of the skill folder"))?;
                rest.push(name.to_os_string());
                base = base.parent().ok_or_else(|| format!("{shown} leads out of the skill folder"))?;
            }
        }
    };
    if !real.starts_with(&real_root) {
        return Err(format!("{shown} links outside the skill folder"));
    }
    if real.is_dir() && rest.is_empty() {
        return Err(format!("{shown} is a folder on the other side"));
    }
    if !real.is_dir() && !rest.is_empty() {
        return Err(format!("{} is a file on the other side", real.strip_prefix(&real_root).unwrap_or(&real).display()));
    }
    Ok(rest.into_iter().rev().fold(real, |path, name| path.join(name)))
}

fn make_backup(from: &Path, to: &Path) -> Result<()> {
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    if from.is_dir() {
        copy_dir(from, to)
    } else {
        fs::copy(from, to).map(|_| ()).map_err(Into::into)
    }
}

fn copy_dir(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)?.flatten() {
        let path = entry.path();
        let target = to.join(entry.file_name());
        let meta = fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() {
            // A link is kept as a link: what it points at is not the skill's to copy.
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(&path)?, &target)?;
        } else if meta.is_dir() {
            copy_dir(&path, &target)?;
        } else if meta.is_file() {
            fs::copy(&path, &target)?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "agent_configs_tests.rs"]
mod tests;
