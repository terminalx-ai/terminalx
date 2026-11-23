//! Moving a bot to another place, and back (PRO-482).
//!
//! A bot lives on one runtime: this Mac's, a cloud workspace's or a paired
//! machine's. Moving it carries everything that makes it the same bot to the
//! other runtime, as one bundle ([`Bundle`]):
//!
//! - its record (`bots.json`), with `runsOn` set to here on the receiving side;
//! - its home folder (role, memory, duty notes): `bots/<id>/`;
//! - its work items and questions: `bot-items/<id>/`;
//! - the history of its role and memory: `bot-changes/<id>/`;
//! - its suggestions: `bot-suggestions/<id>.json`;
//! - its duties (automations that name it) and its quiet hours.
//!
//! What stays: run logs, its sessions (a chat is the runtime's own), and the
//! owner's credentials (chat-app logins, channel sign-ins), which never leave
//! the computer they were given on.
//!
//! The runtime the bot leaves keeps its record with `runsOn` naming the new
//! place ([`move_out`]), so the app still shows it and can bring it back;
//! there its duties do not wake and a session of it only reads. The window
//! runs the move: it reads the bundle here ([`export`]), hands it to the other
//! runtime (`bots.import` over the workspace connection, [`import`]), and
//! marks the bot moved, or brings a bundle back the other way.

use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{change, duties, not_found, refused, require_enabled, Bot, BotRunsOn};
use crate::automations::Automation;
use crate::sink::EventSink;
use crate::store::automations as automation_store;
use crate::store::bots as bot_store;

pub const BUNDLE_VERSION: u32 = 1;
/// The most a bundle carries, its files' bytes before encoding. A bot's role
/// and memory are a few hundred KB at most; past this something else is in
/// its home, which the owner is asked to move by other means.
pub const MAX_BYTES: u64 = 24 * 1024 * 1024;
pub const MAX_FILES: usize = 5000;
/// The person a bot on a shared runtime (a cloud workspace) belongs to, as the
/// workspace's API names them: only their connection reads or answers it.
pub const OWNER_USER_KEY: &str = "ownerUser";

/// The folders and files of one bot under the store's root, by the name the bundle gives them.
const TREES: [(&str, &str); 3] = [("home", "bots"), ("items", "bot-items"), ("changes", "bot-changes")];
const SUGGESTIONS_DIR: &str = "bot-suggestions";

/// One file of a bundle: its path inside its tree, and its bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleFile {
    /// `home`, `items`, `changes` or `suggestions`.
    pub tree: String,
    pub path: String,
    /// Base64.
    pub data: String,
}

/// Everything a bot takes with it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub v: u32,
    pub bot: Bot,
    /// Its home folder's path where it was read: a duty that worked there works in the new home.
    pub home: String,
    #[serde(default)]
    pub files: Vec<BundleFile>,
    #[serde(default)]
    pub duties: Vec<Automation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duty_settings: Option<Value>,
}

/// What an import did: the bot, and what the owner should know.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub bot: Bot,
    pub duties: usize,
    pub notes: Vec<String>,
}

fn root() -> Result<PathBuf> {
    crate::store::root()
}

fn tree_dir(tree: &str, id: &str) -> Result<Option<PathBuf>> {
    // The id is checked as the store checks it, so it names no other folder.
    bot_store::home_dir(id)?;
    let root = root()?;
    Ok(match tree {
        "suggestions" => Some(root.join(SUGGESTIONS_DIR)),
        other => TREES.iter().find(|(name, _)| *name == other).map(|(_, dir)| root.join(dir).join(id)),
    })
}

/// A path inside a bundle: plain relative components only.
fn safe_relative(path: &str) -> Option<PathBuf> {
    if path.is_empty() || path.len() > 1024 || path.contains('\\') || path.contains('\0') {
        return None;
    }
    let relative = Path::new(path);
    relative.components().all(|component| matches!(component, Component::Normal(_))).then(|| relative.to_path_buf())
}

fn collect(tree: &str, dir: &Path, at: &Path, files: &mut Vec<BundleFile>, bytes: &mut u64) -> Result<()> {
    let entries = match std::fs::read_dir(at) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error).with_context(|| format!("read {}", at.display())),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        // A link is never followed: it could reach anything this user can read.
        let meta = std::fs::symlink_metadata(&path)?;
        if meta.is_dir() {
            collect(tree, dir, &path, files, bytes)?;
        } else if meta.is_file() {
            *bytes += meta.len();
            if *bytes > MAX_BYTES || files.len() >= MAX_FILES {
                return Err(refused(format!(
                    "This bot's folders hold more than {} MB or {MAX_FILES} files, more than a move carries. Move what is not its role, memory or notes out of {} first.",
                    MAX_BYTES / (1024 * 1024),
                    dir.display()
                )));
            }
            let relative = path.strip_prefix(dir)?.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
            let data = std::fs::read(&path).with_context(|| format!("read {}", path.display()))?;
            files.push(BundleFile { tree: tree.into(), path: relative, data: base64::engine::general_purpose::STANDARD.encode(data) });
        }
    }
    Ok(())
}

/// Read bot `id` as a bundle, to move it. Only a bot that lives here moves from here.
pub fn export(id: &str) -> Result<Bundle> {
    require_enabled()?;
    let bot = super::get(id)?;
    if !bot.runs_on.here() {
        return Err(refused(format!("{} does not live here: it runs on {}.", bot.name, bot.runs_on.label())));
    }
    let mut files = Vec::new();
    let mut bytes = 0;
    for (tree, _) in TREES {
        if let Some(dir) = tree_dir(tree, id)? {
            collect(tree, &dir, &dir, &mut files, &mut bytes)?;
        }
    }
    if let Some(dir) = tree_dir("suggestions", id)? {
        let file = dir.join(format!("{id}.json"));
        if std::fs::symlink_metadata(&file).is_ok_and(|meta| meta.is_file()) {
            let data = std::fs::read(&file).with_context(|| format!("read {}", file.display()))?;
            files.push(BundleFile { tree: "suggestions".into(), path: format!("{id}.json"), data: base64::engine::general_purpose::STANDARD.encode(data) });
        }
    }
    let home = bot_store::home_dir(id)?.to_string_lossy().into_owned();
    let settings = duties::settings(id);
    let duty_settings = (settings != duties::DutySettings::default()).then(|| serde_json::to_value(settings)).transpose()?;
    Ok(Bundle { v: BUNDLE_VERSION, bot, home, files, duties: duties::duties_of(id)?, duty_settings })
}

/// Mark bot `id` as living at `to` now: its record stays here, so the app
/// shows it and can bring it back, but nothing of it runs here. The window
/// does this before it hands the bundle over, so the bot never works in two
/// places, and undoes it ([`move_back`]) when the other side refuses.
pub fn move_out(sink: &dyn EventSink, id: &str, to: &str) -> Result<Bot> {
    require_enabled()?;
    let place = BotRunsOn::parse(to.into());
    if !matches!(place, BotRunsOn::Cloud(_) | BotRunsOn::Machine(_)) {
        return Err(refused(format!("{to} is not a place a bot moves to: name a cloud workspace (cloud:<org>:<workspace>) or a machine (machine:<id>).")));
    }
    change(sink, |bots| {
        let bot = bots.iter_mut().find(|bot| bot.id == id).ok_or_else(|| not_found(id))?;
        if !bot.runs_on.here() && bot.runs_on != place {
            return Err(refused(format!("{} already runs on {}. Bring it back first.", bot.name, bot.runs_on.label())));
        }
        bot.runs_on = place;
        bot.modified = crate::store::index::now();
        Ok(bot.clone())
    })
}

/// Undo [`move_out`] for a move that did not go through: the bot lives here again, as it was.
pub fn move_back(sink: &dyn EventSink, id: &str) -> Result<Bot> {
    require_enabled()?;
    change(sink, |bots| {
        let bot = bots.iter_mut().find(|bot| bot.id == id).ok_or_else(|| not_found(id))?;
        if !bot.runs_on.here() {
            bot.runs_on = BotRunsOn::ThisMac;
            bot.modified = crate::store::index::now();
        }
        Ok(bot.clone())
    })
}

/// Move what is here of bot `id` aside before a bundle replaces it, into the
/// trash, never deleted: a copy left from before a move may hold notes the
/// owner wrote since.
fn set_aside(id: &str) -> Result<PathBuf> {
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S").to_string();
    let trash = crate::store::ensure_dir(root()?.join("trash").join("bots-replaced").join(format!("{id}-{stamp}")))?;
    for (tree, _) in TREES {
        if let Some(dir) = tree_dir(tree, id)?.filter(|dir| dir.exists()) {
            std::fs::rename(&dir, trash.join(tree)).with_context(|| format!("move {} aside", dir.display()))?;
        }
    }
    if let Some(dir) = tree_dir("suggestions", id)? {
        let file = dir.join(format!("{id}.json"));
        if file.exists() {
            std::fs::rename(&file, trash.join("suggestions.json")).with_context(|| format!("move {} aside", file.display()))?;
        }
    }
    Ok(trash)
}

/// Every file of `bundle`, checked and decoded, with where it goes here:
/// nothing is written until the whole bundle is known to be good.
fn checked_files(bundle: &Bundle) -> Result<Vec<(PathBuf, Vec<u8>)>> {
    let id = &bundle.bot.id;
    if bundle.files.len() > MAX_FILES {
        return Err(refused(format!("The bundle carries more than {MAX_FILES} files.")));
    }
    let mut bytes = 0u64;
    let mut out = Vec::with_capacity(bundle.files.len());
    for file in &bundle.files {
        let relative = safe_relative(&file.path).ok_or_else(|| refused(format!("The bundle names a file outside the bot's folders: {}", file.path)))?;
        let dir = tree_dir(&file.tree, id)?.ok_or_else(|| refused(format!("The bundle names an unknown folder {}.", file.tree)))?;
        if file.tree == "suggestions" && file.path != format!("{id}.json") {
            return Err(refused("The bundle names another bot's suggestions."));
        }
        let data = base64::engine::general_purpose::STANDARD.decode(&file.data).map_err(|_| refused(format!("{} is not encoded as a bundle's file is.", file.path)))?;
        bytes += data.len() as u64;
        if bytes > MAX_BYTES {
            return Err(refused(format!("The bundle carries more than {} MB.", MAX_BYTES / (1024 * 1024))));
        }
        out.push((dir.join(&relative), data));
    }
    Ok(out)
}

fn write_files(id: &str, files: Vec<(PathBuf, Vec<u8>)>) -> Result<()> {
    for (path, data) in files {
        if let Some(parent) = path.parent() {
            crate::store::ensure_dir(parent.to_path_buf())?;
        }
        crate::store::write_atomic(&path, &data)?;
    }
    // A home with no role file still reads as a bot's home.
    crate::store::ensure_dir(bot_store::home_dir(id)?)?;
    Ok(())
}

/// The bundle's duties, each checked to be one of its bot's: a duty that
/// names another bot (or none) would run a prompt the sender wrote with
/// another bot's access. An id is taken once, and never one of another
/// duty or automation here.
fn checked_duties(bundle: &Bundle) -> Result<()> {
    let id = &bundle.bot.id;
    let mut seen = std::collections::BTreeSet::new();
    let here = automation_store::list()?;
    for duty in &bundle.duties {
        if duties::owner(duty).is_none_or(|owner| owner.id != *id) {
            return Err(refused(format!("The bundle carries “{}”, which is not one of {}'s duties.", duty.name, bundle.bot.name)));
        }
        if duty.id.is_empty() || !seen.insert(duty.id.as_str()) {
            return Err(refused(format!("The bundle carries the duty id {} twice.", duty.id)));
        }
        if let Some(other) = here.iter().find(|automation| automation.id == duty.id) {
            if duties::owner(other).is_none_or(|owner| owner.id != *id) {
                return Err(refused(format!("The duty id {} is taken here by something else.", duty.id)));
            }
        }
    }
    Ok(())
}

/// Put back what [`set_aside`] moved, after a write that failed partway.
fn restore_aside(id: &str, aside: &Path) {
    for (tree, _) in TREES {
        if let Ok(Some(dir)) = tree_dir(tree, id) {
            let _ = std::fs::remove_dir_all(&dir);
            if aside.join(tree).exists() {
                let _ = std::fs::rename(aside.join(tree), &dir);
            }
        }
    }
    if let Ok(Some(dir)) = tree_dir("suggestions", id) {
        let file = dir.join(format!("{id}.json"));
        let _ = std::fs::remove_file(&file);
        if aside.join("suggestions.json").exists() {
            let _ = std::fs::rename(aside.join("suggestions.json"), &file);
        }
    }
    let _ = std::fs::remove_dir(aside);
}

/// A duty as it runs here: in this runtime's home of the bot when it worked
/// in the home it was read from, with no session of the other runtime's.
fn place_duty(mut duty: Automation, from_home: &str, home: &Path) -> (Automation, Option<String>) {
    let mut note = None;
    if duty.project_path == from_home || duty.project_path.starts_with(&format!("{from_home}/")) {
        let rest = duty.project_path[from_home.len()..].trim_start_matches('/');
        duty.project_path = if rest.is_empty() { home.to_string_lossy().into_owned() } else { home.join(rest).to_string_lossy().into_owned() };
    } else if !Path::new(&duty.project_path).is_dir() {
        note = Some(format!("“{}” works in {}, which is not on this runtime: it fails until that project is here.", duty.name, duty.project_path));
    }
    duty.session_id = None;
    duty.last_outcome = None;
    (duty, note)
}

/// Take a moved bot in here. `owner_user` is the person whose connection
/// brought it, recorded on a shared runtime so only they read and answer it.
/// A bot already here is replaced only when it had moved away from here (a
/// bot brought back); one that lives here is never overwritten.
pub fn import(sink: &dyn EventSink, bundle: Bundle, owner_user: Option<&str>) -> Result<Imported> {
    if bundle.v != BUNDLE_VERSION {
        return Err(refused(format!("This bundle was made by another version of TerminalX (version {}); update TerminalX on both sides.", bundle.v)));
    }
    let id = bundle.bot.id.clone();
    bot_store::home_dir(&id).map_err(|_| refused("The bundle's bot has an id that names no folder."))?;
    // Everything is checked before anything here changes.
    if let Some(existing) = bot_store::get(&id)? {
        if existing.runs_on.here() {
            return Err(refused(format!("{} already lives here.", existing.name)));
        }
        if let (Some(had), Some(user)) = (existing.unknown.get(OWNER_USER_KEY).and_then(Value::as_str), owner_user) {
            if had != user {
                return Err(refused("Another person's bot has this id here."));
            }
        }
    }
    checked_duties(&bundle)?;
    let files = checked_files(&bundle)?;
    if !super::SUPPORTED {
        return Err(refused(super::UNSUPPORTED_MESSAGE));
    }
    // The bot's owner asked for it here, so Bots is on here: its duties run, and its owner can reach it.
    turn_on()?;
    let aside = set_aside(&id)?;
    if let Err(error) = write_files(&id, files) {
        restore_aside(&id, &aside);
        return Err(error);
    }
    if let Some(settings) = &bundle.duty_settings {
        if let Ok(settings) = serde_json::from_value::<duties::DutySettings>(settings.clone()) {
            duties::put_settings(&id, settings)?;
        }
    }
    // Its duties replace any of an earlier stay here.
    for old in duties::duties_of(&id)? {
        automation_store::remove(&old.id)?;
    }
    let home = bot_store::home_dir(&id)?;
    let mut notes = Vec::new();
    let count = bundle.duties.len();
    for duty in bundle.duties {
        let (duty, note) = place_duty(duty, &bundle.home, &home);
        notes.extend(note);
        automation_store::insert(duty)?;
    }
    duties::announce_changed(sink);
    let mut incoming = bundle.bot;
    incoming.runs_on = BotRunsOn::ThisMac;
    incoming.modified = crate::store::index::now();
    match owner_user {
        Some(user) => {
            incoming.unknown.insert(OWNER_USER_KEY.into(), json!(user));
        }
        None => {
            incoming.unknown.remove(OWNER_USER_KEY);
        }
    }
    let bot = change(sink, |bots| {
        // Its reporting line and askers name bots that may not be here: the line goes to the owner, the rest stay as data.
        if incoming.reports_to != super::OWNER && !bots.iter().any(|other| other.id == incoming.reports_to) {
            incoming.reports_to = super::OWNER.into();
        }
        incoming.slug = super::unique_slug(&incoming.slug, bots, Some(&incoming.id));
        match bots.iter_mut().find(|bot| bot.id == incoming.id) {
            Some(existing) => *existing = incoming.clone(),
            None => bots.push(incoming.clone()),
        }
        Ok(incoming.clone())
    })?;
    Ok(Imported { bot, duties: count, notes })
}

fn turn_on() -> Result<()> {
    if !super::SUPPORTED {
        return Err(refused(super::UNSUPPORTED_MESSAGE));
    }
    let mut settings = crate::store::settings::load();
    if !settings.experimental.bots {
        settings.experimental.bots = true;
        crate::store::settings::save(&settings)?;
    }
    Ok(())
}

/// Whether the person `user` (a workspace connection's user id) may read and
/// answer `bot` here. On a runtime of the owner's alone (no user named at the
/// import, as on a paired machine) any connection that reached it is theirs.
pub fn belongs_to(bot: &Bot, user: Option<&str>) -> bool {
    match bot.unknown.get(OWNER_USER_KEY).and_then(Value::as_str) {
        Some(owner) => user == Some(owner),
        None => true,
    }
}

/// The bundle as text for the wire, and back.
pub fn encode(bundle: &Bundle) -> Result<String> {
    Ok(base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(bundle)?))
}

pub fn decode(text: &str) -> Result<Bundle> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(text.trim()).map_err(|_| refused("The bundle is not encoded as a bot's bundle is."))?;
    serde_json::from_slice(&bytes).map_err(|error| refused(format!("The bundle cannot be read: {error}")))
}

/// The window's operations on the runtime's `bots` call, or `None` for another.
pub fn call(sink: &dyn EventSink, operation: &str, params: &Value) -> Option<Result<Value>> {
    if !matches!(operation, "moveExport" | "moveOut" | "moveBack" | "moveImport") {
        return None;
    }
    Some(window_call(sink, operation, params))
}

fn window_call(sink: &dyn EventSink, operation: &str, params: &Value) -> Result<Value> {
    let id = || params["id"].as_str().map(str::to_owned).ok_or_else(|| refused("id must be a string"));
    Ok(match operation {
        "moveExport" => json!({ "bundle": encode(&export(&id()?)?)? }),
        "moveOut" => serde_json::to_value(move_out(sink, &id()?, params["to"].as_str().ok_or_else(|| refused("to must be a string"))?)?)?,
        "moveBack" => serde_json::to_value(move_back(sink, &id()?)?)?,
        _ => {
            let bundle = decode(params["bundle"].as_str().ok_or_else(|| refused("bundle must be a string"))?)?;
            serde_json::to_value(import(sink, bundle, None)?)?
        }
    })
}

#[cfg(test)]
#[path = "moving_tests.rs"]
mod tests;
