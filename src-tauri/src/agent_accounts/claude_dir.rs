//! An added Claude Code account's directory, used as `CLAUDE_CONFIG_DIR`.
//!
//! Its own: the login (the Keychain item Claude Code keys to the directory,
//! [`keychain_service`], or `.credentials.json`) and `.claude.json` (the
//! signed-in account, folder trust). Shared with the person's own directory
//! by symlink: [`SHARED`], so settings, memory, skills, commands, agents,
//! plugins and every conversation (`projects`) are one, and a conversation
//! begun on one account resumes on another. A link is made even when its
//! target does not exist yet, so the first write lands in the shared place.
//!
//! The person's user-scope MCP servers live in their `.claude.json`, so the
//! `mcpServers` there are mirrored into the account's file each time a tab
//! starts. Their OAuth logins are the account's own.
//!
//! Nothing here writes into the person's directory: it is read, and linked to.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::{Map, Value};

/// What an account directory shares with the person's own, by name.
pub const SHARED: &[&str] = &["settings.json", "CLAUDE.md", "skills", "commands", "agents", "plugins", "projects"];

/// The person's own Claude Code configuration: their directory, and the
/// `.claude.json` that goes with it (`~/.claude.json` beside `~/.claude`,
/// or inside a `CLAUDE_CONFIG_DIR`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Person {
    pub dir: PathBuf,
    pub claude_json: PathBuf,
}

impl Person {
    /// As Claude Code finds it for this app: `$CLAUDE_CONFIG_DIR` when the
    /// app was started with one, else `~/.claude`.
    pub fn current() -> Result<Self> {
        match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
            Some(dir) => Ok(Self::in_dir(PathBuf::from(dir))),
            None => Ok(Self::in_home(&dirs::home_dir().context("no home directory")?)),
        }
    }

    pub fn in_home(home: &Path) -> Self {
        Self { dir: home.join(".claude"), claude_json: home.join(".claude.json") }
    }

    pub fn in_dir(dir: PathBuf) -> Self {
        Self { claude_json: dir.join(".claude.json"), dir }
    }
}

/// The Keychain item Claude Code keeps an account directory's login in.
///
/// Probed against Claude Code 2.1.325: the service is
/// `Claude Code-credentials-<first 8 hex of sha256(dir)>`, the account the
/// user name, where `dir` is `CLAUDE_CONFIG_DIR` as given, NFC-normalised.
/// Without the variable the service has no suffix: that unsuffixed item is
/// the person's own and is never named here. A path that is not plain
/// ASCII is not hashed (its NFC form cannot be told here); the agent's own
/// logout removes its item then.
pub fn keychain_service(dir: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let text = dir.to_str().filter(|text| text.is_ascii() && !text.is_empty())?;
    let digest = format!("{:x}", Sha256::digest(text.as_bytes()));
    Some(format!("Claude Code-credentials-{}", &digest[..8]))
}

/// Build or refresh account directory `dir`: owner-only, the shared links,
/// and the person's MCP servers mirrored.
pub fn prepare(dir: &Path, person: &Person) -> Result<()> {
    super::create_private(dir)?;
    for name in SHARED {
        link(dir, &person.dir, name)?;
    }
    mirror_mcp_servers(dir, person)
}

/// Point `<dir>/<name>` at the person's. A link already there is left; a
/// link elsewhere is replaced; something real in its place (which only
/// Claude Code itself could have made) is replaced only while empty, and
/// otherwise kept as the account's own.
fn link(dir: &Path, person: &Path, name: &str) -> Result<()> {
    let target = dir.join(name);
    let source = person.join(name);
    match std::fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() || is_junction(&target) => {
            if std::fs::read_link(&target).is_ok_and(|current| current == source) {
                return Ok(());
            }
            // A link to a folder is removed as a folder on Windows.
            #[cfg(windows)]
            std::fs::remove_dir(&target).or_else(|_| std::fs::remove_file(&target)).with_context(|| format!("replace the account's {name} link"))?;
            #[cfg(not(windows))]
            std::fs::remove_file(&target).with_context(|| format!("replace the account's {name} link"))?;
        }
        Ok(meta) if meta.is_dir() => {
            if std::fs::remove_dir(&target).is_err() {
                log::warn!("claude account: {name} holds the account's own files; it is not shared");
                return Ok(());
            }
        }
        Ok(meta) if meta.len() == 0 => std::fs::remove_file(&target).with_context(|| format!("replace the account's empty {name}"))?,
        Ok(_) => {
            log::warn!("claude account: {name} holds the account's own file; it is not shared");
            return Ok(());
        }
        Err(_) => {}
    }
    #[cfg(windows)]
    if let Err(error) = symlink(&source, &target) {
        // A symlink needs an administrator or Developer Mode, and only a
        // folder has a link without one (a junction). A file left unshared
        // costs only the sharing: the account keeps its own.
        log::warn!("claude account: {name} is not shared with this account ({error}); turn on Developer Mode to share it");
        return Ok(());
    }
    #[cfg(windows)]
    return Ok(());
    #[cfg(not(windows))]
    symlink(&source, &target).with_context(|| format!("link {name} into the account's directory"))
}

/// Whether `path` is a directory junction, which a link made on Windows
/// without the right to make symlinks is.
fn is_junction(path: &Path) -> bool {
    #[cfg(windows)]
    {
        !std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) && crate::win::fs::is_reparse_point(path).unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        false
    }
}

#[cfg(unix)]
fn symlink(source: &Path, target: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, target)
}

/// A symlink where Windows allows one; for a folder, a junction otherwise.
#[cfg(windows)]
fn symlink(source: &Path, target: &Path) -> std::io::Result<()> {
    if source.is_dir() {
        std::os::windows::fs::symlink_dir(source, target).or_else(|_| crate::win::fs::junction(target, source))
    } else {
        std::os::windows::fs::symlink_file(source, target)
    }
}

#[cfg(not(any(unix, windows)))]
fn symlink(_source: &Path, _target: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "agent accounts need a unix or windows host"))
}

fn object_at(path: &Path) -> Result<Option<Map<String, Value>>> {
    match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(map)) => Ok(Some(map)),
            // Never the parser's error: the file may hold an MCP server's secret.
            _ => bail!("{} is not a Claude Code settings file", path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default()),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => bail!("could not read a Claude Code settings file"),
    }
}

/// Copy the person's `mcpServers` into the account's `.claude.json`, and
/// leave everything else in it alone. A person's file that cannot be read
/// changes nothing; an account file that is not JSON is not overwritten.
pub fn mirror_mcp_servers(dir: &Path, person: &Person) -> Result<()> {
    let Ok(theirs) = object_at(&person.claude_json) else {
        log::warn!("claude account: the person's .claude.json could not be read; MCP servers not mirrored");
        return Ok(());
    };
    let servers = theirs.and_then(|mut map| map.remove("mcpServers"));
    let path = dir.join(".claude.json");
    let mut mine = object_at(&path)?.unwrap_or_default();
    let before = mine.get("mcpServers").cloned();
    if before == servers && (servers.is_some() || path.exists()) {
        return Ok(());
    }
    match servers {
        Some(servers) => mine.insert("mcpServers".into(), servers),
        None => mine.remove("mcpServers"),
    };
    let bytes = serde_json::to_vec_pretty(&Value::Object(mine))?;
    crate::store::write_atomic(&path, &bytes).context("write the account's .claude.json")
}
