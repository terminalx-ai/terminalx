//! Bots (PRO-459, PRO-466): AI employees with standing roles. A bot is data
//! (`bots.json`) and a home folder holding its role and memory; its chats
//! are ordinary sessions and its delegated work is orchestration runs, so
//! nothing here starts, schedules or permits anything. Pausing only records
//! the state for the parts that act on it.
//!
//! Everything is behind Settings → Experimental → Bots. With the switch off
//! every operation here refuses, and nothing about the app changes.

pub mod templates;

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::sink::EventSink;
use crate::store::bots as bot_store;

/// `reports_to` and `paused.by` name the person the bots belong to this way.
pub const OWNER: &str = "owner";
/// The place a bot works in when it works for its owner alone, with or without an organisation.
pub const PERSONAL: &str = "personal";
pub const OFF_MESSAGE: &str = "Bots are off. Turn them on in Settings → Experimental → Bots.";
const DEFAULT_HARNESS: &str = "claude";
const MAX_NAME_CHARS: usize = 80;
const MAX_SLUG_CHARS: usize = 40;
const MAX_ROLE_BYTES: usize = 256 * 1024;

/// What a bot may do without asking. Full access is the owner's decision
/// for a new bot (PRO-459): it runs as the owner's sessions do.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BotAccess {
    #[default]
    Full,
    /// Asks before anything that leaves this computer.
    AskOutward,
    /// Reads and reports only.
    ReadReport,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BotRunsOn {
    #[default]
    ThisMac,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotPause {
    pub at: String,
    /// [`OWNER`], or the id of the bot that paused it.
    pub by: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    pub id: String,
    /// Unique among the bots, from the name: how the CLI and a mention name it.
    pub slug: String,
    pub name: String,
    pub role_title: String,
    pub role_template_id: String,
    pub harness: String,
    /// Empty for the agent's own default model.
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default)]
    pub access: BotAccess,
    #[serde(default)]
    pub runs_on: BotRunsOn,
    /// [`OWNER`] or another bot's id.
    #[serde(default = "owner")]
    pub reports_to: String,
    #[serde(default = "personal")]
    pub works_in: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paused: Option<BotPause>,
    pub created: String,
    pub modified: String,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, Value>,
}

fn owner() -> String {
    OWNER.into()
}

fn personal() -> Vec<String> {
    vec![PERSONAL.into()]
}

/// A change to a bot. A field left out stays as it is; `effort` given as
/// `null` goes back to the agent's default.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BotPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub role_title: Option<String>,
    #[serde(default)]
    pub harness: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, deserialize_with = "given")]
    pub effort: Option<Option<String>>,
    #[serde(default)]
    pub access: Option<BotAccess>,
    #[serde(default)]
    pub runs_on: Option<BotRunsOn>,
    #[serde(default)]
    pub reports_to: Option<String>,
    #[serde(default)]
    pub works_in: Option<Vec<String>>,
}

/// A field that is present, even as `null`, is `Some`: absent is "leave it".
fn given<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

pub fn enabled() -> bool {
    crate::store::settings::load().experimental.bots
}

pub fn require_enabled() -> Result<()> {
    ensure!(enabled(), OFF_MESSAGE);
    Ok(())
}

/// `Atlas Prime` → `atlas-prime`. Letters and digits are kept, anything else
/// becomes one hyphen; a name with neither is `bot`.
pub fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            slug.push(c.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= MAX_SLUG_CHARS {
            break;
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() { "bot".into() } else { slug.into() }
}

/// `base`, or `base-2`, `base-3`… when another bot (not `except`) has it.
fn unique_slug(base: &str, bots: &[Bot], except: Option<&str>) -> String {
    let taken = |slug: &str| bots.iter().any(|bot| bot.slug == slug && Some(bot.id.as_str()) != except);
    if !taken(base) {
        return base.into();
    }
    (2..).map(|n| format!("{base}-{n}")).find(|slug| !taken(slug)).expect("an unused number exists")
}

fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    ensure!(!name.is_empty(), "A bot needs a name.");
    ensure!(name.chars().count() <= MAX_NAME_CHARS, "A bot's name is at most {MAX_NAME_CHARS} characters.");
    ensure!(!name.chars().any(char::is_control), "A bot's name is one line.");
    Ok(name.into())
}

/// What a new bot's `ROLE.md` holds: the template's standing instructions.
/// Its name and title are in its record, where a rename reaches them.
pub fn role_text(template: &templates::RoleTemplate) -> String {
    format!("{}\n", template.role.trim())
}

fn memory_text() -> String {
    format!("# Memory\n\nNotes kept across conversations. Longer notes go in `{}/`.\n", bot_store::MEMORY_DIR)
}

fn emit_changed(sink: &dyn EventSink) {
    if let Ok(bots) = bot_store::list() {
        sink.emit("bots_changed", &bots);
    }
}

pub fn list() -> Result<Vec<Bot>> {
    require_enabled()?;
    bot_store::list()
}

pub fn get(id: &str) -> Result<Bot> {
    require_enabled()?;
    bot_store::get(id)
}

pub fn role_templates() -> Result<Vec<templates::RoleTemplate>> {
    require_enabled()?;
    Ok(templates::all())
}

/// What a selector came to.
pub enum Named {
    One(Box<Bot>),
    /// Several bots share the name.
    Several,
    Nobody,
}

/// The bot a person names: by id, by slug, or by name in any letter case.
pub fn named(selector: &str) -> Result<Named> {
    require_enabled()?;
    let wanted = selector.trim();
    let bots = bot_store::list()?;
    if let Some(bot) = bots.iter().find(|bot| bot.id == wanted || bot.slug == wanted) {
        return Ok(Named::One(Box::new(bot.clone())));
    }
    let mut named = bots.into_iter().filter(|bot| bot.name.eq_ignore_ascii_case(wanted));
    Ok(match (named.next(), named.next()) {
        (Some(bot), None) => Named::One(Box::new(bot)),
        (Some(_), Some(_)) => Named::Several,
        _ => Named::Nobody,
    })
}

pub fn several_named(selector: &str) -> String {
    format!("More than one bot is named {}. Name it by its slug or id.", selector.trim())
}

pub fn nobody_named(selector: &str) -> String {
    format!("No bot matches {}.", selector.trim())
}

/// [`named`], or why there is no one bot to act on.
#[cfg(test)]
pub fn resolve(selector: &str) -> Result<Bot> {
    match named(selector)? {
        Named::One(bot) => Ok(*bot),
        Named::Several => bail!(several_named(selector)),
        Named::Nobody => bail!(nobody_named(selector)),
    }
}

/// Hire a bot: a role and a name are all it asks for (PRO-459). Everything
/// else starts on the defaults, and its home is made from the role template.
pub fn create(sink: &dyn EventSink, role_template_id: &str, name: &str) -> Result<Bot> {
    require_enabled()?;
    let template = templates::find(role_template_id).ok_or_else(|| {
        let known: Vec<&str> = templates::all().iter().map(|template| template.id).collect();
        anyhow!("No role template {role_template_id}. The roles are: {}.", known.join(", "))
    })?;
    let name = clean_name(name)?;
    let id = uuid::Uuid::now_v7().to_string();
    let now = crate::store::index::now();
    let home = bot_store::create_home(&id, &role_text(&template), &memory_text())?;
    let saved = bot_store::change(|bots| {
        let bot = Bot {
            slug: unique_slug(&slugify(&name), bots, None),
            id: id.clone(),
            name,
            role_title: template.title.into(),
            role_template_id: template.id.into(),
            harness: DEFAULT_HARNESS.into(),
            model: String::new(),
            effort: None,
            access: BotAccess::Full,
            runs_on: BotRunsOn::ThisMac,
            reports_to: owner(),
            works_in: personal(),
            paused: None,
            created: now.clone(),
            modified: now,
            unknown: BTreeMap::new(),
        };
        bots.push(bot.clone());
        Ok(bot)
    });
    let bot = match saved {
        Ok(bot) => bot,
        Err(error) => {
            bot_store::discard_home(&home);
            return Err(error);
        }
    };
    emit_changed(sink);
    Ok(bot)
}

pub fn update(sink: &dyn EventSink, id: &str, patch: BotPatch) -> Result<Bot> {
    require_enabled()?;
    let bot = bot_store::change(|bots| {
        let index = bots.iter().position(|bot| bot.id == id).ok_or_else(|| anyhow!("bot {id} not found"))?;
        let mut bot = bots[index].clone();
        if let Some(name) = &patch.name {
            let name = clean_name(name)?;
            if name != bot.name {
                bot.slug = unique_slug(&slugify(&name), bots, Some(id));
                bot.name = name;
            }
        }
        if let Some(title) = &patch.role_title {
            let title = title.trim();
            ensure!(!title.is_empty() && title.chars().count() <= MAX_NAME_CHARS && !title.chars().any(char::is_control), "A role title is one line of at most {MAX_NAME_CHARS} characters.");
            bot.role_title = title.into();
        }
        if let Some(harness) = &patch.harness {
            ensure!(crate::harness::binary_of(harness).is_some(), "Unknown agent {harness}.");
            if *harness != bot.harness {
                // A model and an effort belong to the agent they were chosen for.
                bot.model = String::new();
                bot.effort = None;
            }
            bot.harness = harness.clone();
        }
        if let Some(model) = &patch.model {
            bot.model = model.trim().into();
        }
        if let Some(effort) = &patch.effort {
            bot.effort = effort.as_deref().map(str::trim).filter(|effort| !effort.is_empty()).map(str::to_owned);
        }
        if let Some(access) = patch.access {
            bot.access = access;
        }
        if let Some(runs_on) = patch.runs_on {
            bot.runs_on = runs_on;
        }
        if let Some(reports_to) = &patch.reports_to {
            ensure!(reports_to != id, "A bot does not report to itself.");
            ensure!(reports_to == OWNER || bots.iter().any(|other| other.id == *reports_to), "A bot reports to you or to another bot; {reports_to} is neither.");
            ensure!(!reports_back(bots, reports_to, id), "Those two bots would report to each other.");
            bot.reports_to = reports_to.clone();
        }
        if let Some(works_in) = &patch.works_in {
            let mut places: Vec<String> = Vec::new();
            for place in works_in.iter().map(|place| place.trim()).filter(|place| !place.is_empty()) {
                if !places.iter().any(|known| known == place) {
                    places.push(place.into());
                }
            }
            ensure!(!places.is_empty(), "A bot works somewhere: `{PERSONAL}` when it works for you alone.");
            bot.works_in = places;
        }
        if bot != bots[index] {
            bot.modified = crate::store::index::now();
            bots[index] = bot.clone();
        }
        Ok(bot)
    })?;
    emit_changed(sink);
    Ok(bot)
}

/// Whether following `from`'s reporting line reaches `target`.
fn reports_back(bots: &[Bot], from: &str, target: &str) -> bool {
    let mut at = from;
    for _ in 0..bots.len() {
        if at == target {
            return true;
        }
        match bots.iter().find(|bot| bot.id == at) {
            Some(bot) => at = &bot.reports_to,
            None => return false,
        }
    }
    false
}

/// Delete a bot. Its home goes to the trash; bots that reported to it report to the owner.
pub fn delete(sink: &dyn EventSink, id: &str) -> Result<()> {
    require_enabled()?;
    bot_store::change(|bots| {
        ensure!(bots.iter().any(|bot| bot.id == id), "bot {id} not found");
        bot_store::trash_home(id)?;
        bots.retain(|bot| bot.id != id);
        let now = crate::store::index::now();
        for bot in bots.iter_mut().filter(|bot| bot.reports_to == id) {
            bot.reports_to = owner();
            bot.modified = now.clone();
        }
        Ok(())
    })?;
    emit_changed(sink);
    Ok(())
}

fn set_paused(bot: &mut Bot, pause: Option<&BotPause>) -> bool {
    match (bot.paused.is_some(), pause) {
        // Already paused: when and by whom it was first paused stands.
        (true, Some(_)) | (false, None) => false,
        (false, Some(pause)) => {
            bot.paused = Some(pause.clone());
            bot.modified = pause.at.clone();
            true
        }
        (true, None) => {
            bot.paused = None;
            bot.modified = crate::store::index::now();
            true
        }
    }
}

fn pause_one(sink: &dyn EventSink, id: &str, pause: Option<BotPause>) -> Result<Bot> {
    require_enabled()?;
    let bot = bot_store::change(|bots| {
        let bot = bots.iter_mut().find(|bot| bot.id == id).ok_or_else(|| anyhow!("bot {id} not found"))?;
        set_paused(bot, pause.as_ref());
        Ok(bot.clone())
    })?;
    emit_changed(sink);
    Ok(bot)
}

fn pause_every(sink: &dyn EventSink, pause: Option<BotPause>) -> Result<Vec<Bot>> {
    require_enabled()?;
    let bots = bot_store::change(|bots| {
        for bot in bots.iter_mut() {
            set_paused(bot, pause.as_ref());
        }
        Ok(bots.clone())
    })?;
    emit_changed(sink);
    Ok(bots)
}

fn pause_now(by: &str) -> BotPause {
    BotPause { at: crate::store::index::now(), by: by.into() }
}

/// Record that a bot is paused, when and by whom. Nothing is stopped here.
pub fn pause(sink: &dyn EventSink, id: &str, by: &str) -> Result<Bot> {
    pause_one(sink, id, Some(pause_now(by)))
}

pub fn resume(sink: &dyn EventSink, id: &str) -> Result<Bot> {
    pause_one(sink, id, None)
}

/// The one pause switch: every bot not already paused is paused now.
pub fn pause_all(sink: &dyn EventSink, by: &str) -> Result<Vec<Bot>> {
    pause_every(sink, Some(pause_now(by)))
}

pub fn resume_all(sink: &dyn EventSink) -> Result<Vec<Bot>> {
    pause_every(sink, None)
}

pub fn role_read(id: &str) -> Result<String> {
    require_enabled()?;
    bot_store::read_role(&bot_store::get(id)?.id)
}

/// Replace a bot's standing instructions.
pub fn role_write(sink: &dyn EventSink, id: &str, text: &str) -> Result<Bot> {
    require_enabled()?;
    ensure!(text.len() <= MAX_ROLE_BYTES, "A role is at most {} KB.", MAX_ROLE_BYTES / 1024);
    let bot = bot_store::change(|bots| {
        let bot = bots.iter_mut().find(|bot| bot.id == id).ok_or_else(|| anyhow!("bot {id} not found"))?;
        bot_store::write_role(&bot.id, text)?;
        bot.modified = crate::store::index::now();
        Ok(bot.clone())
    })?;
    emit_changed(sink);
    Ok(bot)
}

/// Where a bot's home folder is.
pub fn home(bot: &Bot) -> Result<std::path::PathBuf> {
    bot_store::home_dir(&bot.id)
}

/// The app's commands, as the runtime that owns the store answers them
/// (`runtime.session.bots`). A change made in the app is by the owner.
pub fn call(sink: &dyn EventSink, operation: &str, params: &Value) -> Result<Value> {
    let string = |key: &str| params[key].as_str().ok_or_else(|| anyhow!("{key} must be a string"));
    Ok(match operation {
        "list" => serde_json::to_value(list()?)?,
        "get" => serde_json::to_value(get(string("id")?)?)?,
        "templates" => serde_json::to_value(role_templates()?)?,
        "create" => serde_json::to_value(create(sink, string("roleTemplateId")?, string("name")?)?)?,
        "update" => serde_json::to_value(update(sink, string("id")?, serde_json::from_value(params["patch"].clone())?)?)?,
        "delete" => {
            delete(sink, string("id")?)?;
            Value::Null
        }
        "pause" => serde_json::to_value(pause(sink, string("id")?, OWNER)?)?,
        "resume" => serde_json::to_value(resume(sink, string("id")?)?)?,
        "pauseAll" => serde_json::to_value(pause_all(sink, OWNER)?)?,
        "resumeAll" => serde_json::to_value(resume_all(sink)?)?,
        "roleRead" => json!(role_read(string("id")?)?),
        "roleWrite" => serde_json::to_value(role_write(sink, string("id")?, string("text")?)?)?,
        other => bail!("Unknown bots operation {other}"),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::sink::BroadcastSink;

    /// A temporary store with the switch on, and a sink whose events are read back.
    fn bots_on() -> (crate::store::TempHome, Arc<BroadcastSink>, tokio::sync::broadcast::Receiver<crate::sink::Published>) {
        let home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.experimental.bots = true;
        crate::store::settings::save(&settings).unwrap();
        let sink = Arc::new(BroadcastSink::new(64));
        let events = sink.subscribe();
        (home, sink, events)
    }

    fn changes(events: &mut tokio::sync::broadcast::Receiver<crate::sink::Published>) -> usize {
        std::iter::from_fn(|| events.try_recv().ok()).filter(|published| &*published.event == "bots_changed").count()
    }

    #[test]
    fn everything_refuses_while_the_switch_is_off() {
        let _home = crate::store::temp_home();
        let sink = BroadcastSink::new(8);
        let mut events = sink.subscribe();
        assert!(!enabled());
        for operation in ["list", "get", "templates", "create", "update", "delete", "pause", "resume", "pauseAll", "resumeAll", "roleRead", "roleWrite"] {
            let refused = call(&sink, operation, &json!({"id": "x", "roleTemplateId": "cto", "name": "Atlas", "text": "", "patch": {}})).unwrap_err();
            assert_eq!(refused.to_string(), OFF_MESSAGE, "{operation}");
        }
        assert!(resolve("atlas").unwrap_err().to_string().contains("Bots are off"));
        assert_eq!(changes(&mut events), 0);
        assert!(!crate::store::root().unwrap().join("bots.json").exists());
        assert!(!crate::store::root().unwrap().join("bots").exists());
    }

    #[test]
    fn hiring_asks_for_a_role_and_a_name_and_defaults_the_rest() {
        let (_home, sink, mut events) = bots_on();
        let bot = create(sink.as_ref(), "cto", "  Atlas  ").unwrap();
        assert_eq!((bot.name.as_str(), bot.slug.as_str(), bot.role_title.as_str(), bot.role_template_id.as_str()), ("Atlas", "atlas", "CTO", "cto"));
        assert_eq!((bot.harness.as_str(), bot.model.as_str(), bot.effort.as_deref()), ("claude", "", None));
        assert_eq!((bot.access, bot.runs_on, bot.reports_to.as_str(), bot.paused.as_ref()), (BotAccess::Full, BotRunsOn::ThisMac, OWNER, None));
        assert_eq!(bot.works_in, [PERSONAL]);
        assert_eq!(bot.created, bot.modified);
        assert_eq!(changes(&mut events), 1);
        assert_eq!(list().unwrap(), vec![bot.clone()]);
        assert_eq!(get(&bot.id).unwrap(), bot);
        // As it is stored: the names later tickets read.
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(crate::store::root().unwrap().join("bots.json")).unwrap()).unwrap();
        assert_eq!(stored["bots"][0], json!({
            "id": bot.id, "slug": "atlas", "name": "Atlas", "roleTitle": "CTO", "roleTemplateId": "cto", "harness": "claude", "model": "",
            "access": "full", "runsOn": "thisMac", "reportsTo": "owner", "worksIn": ["personal"], "created": bot.created, "modified": bot.modified,
        }));

        // The role is found by its title too, and an unknown one names the roles there are.
        assert_eq!(create(sink.as_ref(), "Security auditor", "Sentry").unwrap().role_template_id, "security-auditor");
        let unknown = create(sink.as_ref(), "janitor", "Mop").unwrap_err().to_string();
        assert!(unknown.contains("No role template janitor") && unknown.contains("cto, chief-of-staff") && unknown.contains("watcher"), "{unknown}");
        for name in ["", "   ", "two\nlines", &"n".repeat(81)] {
            assert!(create(sink.as_ref(), "cto", name).is_err(), "{name:?}");
        }
        assert_eq!(list().unwrap().len(), 2);
        // A refused hire leaves no home behind.
        assert_eq!(std::fs::read_dir(crate::store::root().unwrap().join("bots")).unwrap().count(), 2);
    }

    #[test]
    fn a_home_is_made_from_the_role_template_at_hire() {
        let (_home, sink, _events) = bots_on();
        let bot = create(sink.as_ref(), "watcher", "Argus").unwrap();
        let home = home(&bot).unwrap();
        assert_eq!(home, crate::store::root().unwrap().join("bots").join(&bot.id));
        let role = std::fs::read_to_string(home.join("ROLE.md")).unwrap();
        let template = templates::find("watcher").unwrap();
        assert_eq!(role, format!("{}\n", template.role.trim()));
        assert!(role.starts_with("You keep watch") && role.ends_with("lead bot.\n"), "{role}");
        assert_eq!(role_read(&bot.id).unwrap(), role);
        assert_eq!(std::fs::read_to_string(home.join("MEMORY.md")).unwrap(), "# Memory\n\nNotes kept across conversations. Longer notes go in `memory/`.\n");
        assert!(home.join("memory").is_dir());
        assert_eq!(std::fs::read_dir(home.join("memory")).unwrap().count(), 0);
    }

    #[test]
    fn slugs_come_from_the_name_and_are_never_shared() {
        assert_eq!(slugify("Atlas"), "atlas");
        assert_eq!(slugify("  Atlas  Prime! "), "atlas-prime");
        assert_eq!(slugify("QA #2 (night)"), "qa-2-night");
        assert_eq!(slugify("Zoë"), "zo");
        assert_eq!(slugify("…"), "bot");
        assert!(slugify(&"long name ".repeat(20)).len() <= MAX_SLUG_CHARS);
        assert!(!slugify(&"ab ".repeat(30)).ends_with('-'));

        let (_home, sink, _events) = bots_on();
        let slugs: Vec<String> = ["Atlas", "atlas", "ATLAS!", "Iris", "…", "???"].iter().map(|name| create(sink.as_ref(), "cto", name).unwrap().slug).collect();
        assert_eq!(slugs, ["atlas", "atlas-2", "atlas-3", "iris", "bot", "bot-2"]);

        // A rename takes the new name's slug, keeps its own when the name comes to the same, and steps past another bot's.
        let bots = list().unwrap();
        let rename = |id: &str, name: &str| update(sink.as_ref(), id, BotPatch { name: Some(name.into()), ..Default::default() }).unwrap();
        assert_eq!(rename(&bots[3].id, "Kestrel").slug, "kestrel");
        assert_eq!(rename(&bots[1].id, "Atlas").slug, "atlas-2");
        assert_eq!(rename(&bots[2].id, "Kestrel").slug, "kestrel-2");
        assert_eq!(rename(&bots[0].id, "Atlas").slug, "atlas");
        let all = list().unwrap();
        let mut unique: Vec<&str> = all.iter().map(|bot| bot.slug.as_str()).collect();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), all.len());
    }

    #[test]
    fn a_bot_is_named_by_id_slug_or_name() {
        let (_home, sink, _events) = bots_on();
        let atlas = create(sink.as_ref(), "cto", "Atlas").unwrap();
        let twin = create(sink.as_ref(), "watcher", "atlas").unwrap();
        let iris = create(sink.as_ref(), "ux-designer", "Iris").unwrap();
        assert_eq!(resolve(&atlas.id).unwrap().id, atlas.id);
        assert_eq!(resolve("atlas").unwrap().id, atlas.id);
        assert_eq!(resolve("atlas-2").unwrap().id, twin.id);
        assert_eq!(resolve("IRIS").unwrap().id, iris.id);
        assert!(resolve("Atlas").unwrap_err().to_string().contains("More than one bot is named Atlas"));
        assert_eq!(resolve("argus").unwrap_err().to_string(), "No bot matches argus.");
    }

    #[test]
    fn an_update_changes_what_it_names_and_refuses_what_cannot_be() {
        let (_home, sink, mut events) = bots_on();
        let atlas = create(sink.as_ref(), "cto", "Atlas").unwrap();
        let iris = create(sink.as_ref(), "ux-designer", "Iris").unwrap();
        let patch = |value: Value| serde_json::from_value::<BotPatch>(value).unwrap();
        changes(&mut events);

        let changed = update(sink.as_ref(), &iris.id, patch(json!({
            "roleTitle": " Design lead ", "harness": "codex", "model": "gpt-6", "effort": "high", "access": "askOutward", "reportsTo": atlas.id, "worksIn": ["personal", " acme ", "personal", ""],
        }))).unwrap();
        assert_eq!((changed.role_title.as_str(), changed.harness.as_str(), changed.model.as_str(), changed.effort.as_deref()), ("Design lead", "codex", "gpt-6", Some("high")));
        assert_eq!((changed.access, changed.reports_to.as_str()), (BotAccess::AskOutward, atlas.id.as_str()));
        assert_eq!(changed.works_in, ["personal", "acme"]);
        assert_eq!((changed.name.as_str(), changed.slug.as_str(), changed.created.as_str()), ("Iris", "iris", iris.created.as_str()));
        assert_eq!(changes(&mut events), 1);

        // `effort: null` goes back to the agent's default; another agent drops the model and effort chosen for the last one.
        assert_eq!(update(sink.as_ref(), &iris.id, patch(json!({"effort": null}))).unwrap().effort, None);
        let moved = update(sink.as_ref(), &iris.id, patch(json!({"harness": "claude"}))).unwrap();
        assert_eq!((moved.model.as_str(), moved.effort.as_deref()), ("", None));
        // Nothing named, nothing changed: the bot is as it was, to the second.
        let same = update(sink.as_ref(), &iris.id, patch(json!({}))).unwrap();
        assert_eq!(same, moved);

        for (refused, said) in [
            (json!({"name": " "}), "needs a name"),
            (json!({"roleTitle": ""}), "role title"),
            (json!({"harness": "clippy"}), "Unknown agent clippy"),
            (json!({"reportsTo": iris.id}), "does not report to itself"),
            (json!({"reportsTo": "nobody"}), "nobody is neither"),
            (json!({"worksIn": []}), "works somewhere"),
        ] {
            let error = update(sink.as_ref(), &iris.id, patch(refused.clone())).unwrap_err().to_string();
            assert!(error.contains(said), "{refused}: {error}");
        }
        // Iris reports to Atlas, so Atlas cannot report to Iris.
        assert!(update(sink.as_ref(), &atlas.id, patch(json!({"reportsTo": iris.id}))).unwrap_err().to_string().contains("report to each other"));
        assert_eq!(update(sink.as_ref(), &iris.id, patch(json!({"reportsTo": "owner"}))).unwrap().reports_to, OWNER);
        assert!(update(sink.as_ref(), "missing", patch(json!({"name": "X"}))).is_err());
        for odd in [json!({"runsOn": "cloud"}), json!({"access": "root"}), json!({"budget": 5})] {
            assert!(serde_json::from_value::<BotPatch>(odd.clone()).is_err(), "{odd}");
        }
        assert_eq!(get(&iris.id).unwrap().access, BotAccess::AskOutward);
    }

    #[test]
    fn pausing_records_when_and_by_whom_and_resuming_clears_it() {
        let (_home, sink, mut events) = bots_on();
        let atlas = create(sink.as_ref(), "cto", "Atlas").unwrap();
        let iris = create(sink.as_ref(), "ux-designer", "Iris").unwrap();
        let argus = create(sink.as_ref(), "watcher", "Argus").unwrap();
        changes(&mut events);

        let paused = pause(sink.as_ref(), &iris.id, OWNER).unwrap();
        let first = paused.paused.clone().unwrap();
        assert_eq!(first.by, OWNER);
        assert!(chrono::DateTime::parse_from_rfc3339(&first.at).is_ok(), "{}", first.at);
        assert_eq!(serde_json::to_value(&paused).unwrap()["paused"], json!({"at": first.at, "by": "owner"}));
        // Pausing a paused bot keeps the first record, whoever asks.
        assert_eq!(pause(sink.as_ref(), &iris.id, &atlas.id).unwrap().paused, Some(first.clone()));

        // Pause all: the others are paused now, and the one already paused keeps its record.
        let all = pause_all(sink.as_ref(), OWNER).unwrap();
        assert_eq!(all.len(), 3);
        assert!(all.iter().all(|bot| bot.paused.is_some()));
        assert_eq!(all.iter().find(|bot| bot.id == iris.id).unwrap().paused, Some(first));
        assert_eq!(list().unwrap(), all);

        let resumed = resume(sink.as_ref(), &argus.id).unwrap();
        assert_eq!(resumed.paused, None);
        assert!(serde_json::to_value(&resumed).unwrap().get("paused").is_none());
        assert_eq!(resume(sink.as_ref(), &argus.id).unwrap(), resumed);
        assert_eq!(list().unwrap().iter().filter(|bot| bot.paused.is_some()).count(), 2);

        assert!(resume_all(sink.as_ref()).unwrap().iter().all(|bot| bot.paused.is_none()));
        assert!(list().unwrap().iter().all(|bot| bot.paused.is_none()));
        assert!(pause(sink.as_ref(), "missing", OWNER).is_err() && resume(sink.as_ref(), "missing").is_err());
        assert_eq!(changes(&mut events), 6);
    }

    #[test]
    fn deleting_a_bot_moves_its_home_to_the_trash() {
        let (_home, sink, mut events) = bots_on();
        let atlas = create(sink.as_ref(), "cto", "Atlas").unwrap();
        let iris = create(sink.as_ref(), "ux-designer", "Iris").unwrap();
        update(sink.as_ref(), &iris.id, BotPatch { reports_to: Some(atlas.id.clone()), ..Default::default() }).unwrap();
        role_write(sink.as_ref(), &atlas.id, "Lead the others.\n").unwrap();
        let home = home(&atlas).unwrap();
        std::fs::write(home.join("memory").join("decisions.md"), "Ship on Thursdays.").unwrap();
        changes(&mut events);

        delete(sink.as_ref(), &atlas.id).unwrap();
        assert_eq!(changes(&mut events), 1);
        assert!(!home.exists());
        let trashed = crate::store::root().unwrap().join("trash").join("bots").join(&atlas.id);
        assert_eq!(std::fs::read_to_string(trashed.join("ROLE.md")).unwrap(), "Lead the others.\n");
        assert!(trashed.join("MEMORY.md").is_file());
        assert_eq!(std::fs::read_to_string(trashed.join("memory").join("decisions.md")).unwrap(), "Ship on Thursdays.");
        // The bot that reported to it reports to the owner, and is the only one left.
        let left = list().unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!((left[0].id.as_str(), left[0].reports_to.as_str()), (iris.id.as_str(), OWNER));
        assert!(get(&atlas.id).is_err() && role_read(&atlas.id).is_err());
        assert!(delete(sink.as_ref(), &atlas.id).is_err());
        // Its slug is free again.
        assert_eq!(create(sink.as_ref(), "cto", "Atlas").unwrap().slug, "atlas");
    }

    #[test]
    fn a_role_is_read_and_replaced_through_its_bot() {
        let (_home, sink, mut events) = bots_on();
        let bot = create(sink.as_ref(), "docs-writer", "Quill").unwrap();
        changes(&mut events);
        let written = role_write(sink.as_ref(), &bot.id, "Keep the changelog current.\n").unwrap();
        assert_eq!(role_read(&bot.id).unwrap(), "Keep the changelog current.\n");
        assert!(written.modified >= bot.modified);
        assert_eq!(changes(&mut events), 1);
        assert!(role_write(sink.as_ref(), &bot.id, &"x".repeat(MAX_ROLE_BYTES + 1)).is_err());
        for id in ["missing", "../settings", ""] {
            assert!(role_read(id).is_err() && role_write(sink.as_ref(), id, "x").is_err(), "{id:?}");
        }
        assert_eq!(role_read(&bot.id).unwrap(), "Keep the changelog current.\n");
    }

    #[test]
    fn the_runtime_answers_the_apps_commands_and_bots_survive_a_restart() {
        let (_home, sink, mut events) = bots_on();
        let ask = |operation: &str, params: Value| call(sink.as_ref(), operation, &params).unwrap();
        assert_eq!(ask("list", json!({})), json!([]));
        assert_eq!(ask("templates", json!({})).as_array().unwrap().len(), 8);
        let bot = ask("create", json!({"roleTemplateId": "qa-engineer", "name": "Kestrel"}));
        let id = bot["id"].as_str().unwrap().to_owned();
        assert_eq!(ask("get", json!({"id": id})), bot);
        assert_eq!(ask("update", json!({"id": id, "patch": {"name": "Merlin"}}))["slug"], "merlin");
        assert_eq!(ask("pause", json!({"id": id}))["paused"]["by"], "owner");
        assert!(ask("resume", json!({"id": id})).get("paused").is_none());
        assert_eq!(ask("pauseAll", json!({}))[0]["paused"]["by"], "owner");
        assert_eq!(ask("roleWrite", json!({"id": id, "text": "Break it first."}))["id"], id.as_str());
        assert_eq!(ask("roleRead", json!({"id": id})), json!("Break it first."));
        // Every change was announced with the whole list.
        assert_eq!(changes(&mut events), 6);

        // What a restarted app reads is what was saved: the definitions and the home are on disk.
        let read_again: Vec<Bot> = serde_json::from_value(ask("list", json!({}))).unwrap();
        assert_eq!(read_again, crate::store::bots::list().unwrap());
        assert_eq!((read_again[0].name.as_str(), read_again[0].paused.is_some()), ("Merlin", true));

        assert_eq!(ask("resumeAll", json!({})).as_array().unwrap().len(), 1);
        assert_eq!(ask("delete", json!({"id": id})), Value::Null);
        assert_eq!(ask("list", json!({})), json!([]));
        assert!(call(sink.as_ref(), "hire", &json!({})).unwrap_err().to_string().contains("Unknown bots operation hire"));
        assert!(call(sink.as_ref(), "get", &json!({})).unwrap_err().to_string().contains("id must be a string"));
    }

    #[test]
    fn a_bot_saved_by_a_newer_app_keeps_its_unknown_fields() {
        let raw = json!({
            "id": "0198", "slug": "atlas", "name": "Atlas", "roleTitle": "CTO", "roleTemplateId": "cto", "harness": "claude", "model": "",
            "access": "readReport", "runsOn": "thisMac", "reportsTo": "owner", "worksIn": ["personal"], "paused": {"at": "2026-11-20T10:00:00Z", "by": "owner"},
            "created": "2026-11-20T09:00:00Z", "modified": "2026-11-20T10:00:00Z", "channels": ["slack"], "spend": {"usd": 4.2},
        });
        let bot: Bot = serde_json::from_value(raw.clone()).unwrap();
        assert_eq!(bot.access, BotAccess::ReadReport);
        assert_eq!(bot.unknown.keys().map(String::as_str).collect::<Vec<_>>(), ["channels", "spend"]);
        assert_eq!(serde_json::to_value(&bot).unwrap(), raw);
        // The least a record holds: everything else takes its default.
        let least: Bot = serde_json::from_value(json!({"id": "1", "slug": "a", "name": "A", "roleTitle": "CTO", "roleTemplateId": "cto", "harness": "claude", "created": "c", "modified": "m"})).unwrap();
        assert_eq!((least.access, least.runs_on, least.reports_to.as_str(), least.paused), (BotAccess::Full, BotRunsOn::ThisMac, OWNER, None));
        assert_eq!(least.works_in, [PERSONAL]);
    }
}
