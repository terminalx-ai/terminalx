//! Bots (PRO-459, PRO-466): AI employees with standing roles. A bot is data
//! (`bots.json`) and a home folder holding its role and memory; its chats
//! are ordinary sessions and its delegated work is orchestration runs, so
//! nothing here starts, schedules or permits anything. Pausing only records
//! the state for the parts that act on it.
//!
//! Everything is behind Settings → Experimental → Bots. With the switch off
//! every operation here refuses, and nothing about the app changes.

pub mod access;
pub mod chat;
pub mod enforce;
pub mod templates;

use std::collections::BTreeMap;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::sink::EventSink;
use crate::store::bots as bot_store;

/// `reports_to` and `paused.by` name the person the bots belong to this way.
pub const OWNER: &str = "owner";
/// The place a bot works in when it works for its owner alone, with or without an organisation.
pub const PERSONAL: &str = "personal";
pub const OFF_MESSAGE: &str = "Bots are off. Turn them on in Settings → Experimental → Bots.";
/// Words that name someone or everyone wherever a bot is named, so no bot's slug is one of them.
pub const RESERVED_SLUGS: [&str; 4] = [OWNER, PERSONAL, "all", "everyone"];
const DEFAULT_HARNESS: &str = "claude";
const MAX_NAME_CHARS: usize = 80;
const MAX_SLUG_CHARS: usize = 40;
const MAX_ROLE_BYTES: usize = 256 * 1024;

/// Why an operation refused. Anything else that fails is the app's problem,
/// not something the caller can fix by asking differently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BotError {
    /// Settings → Experimental → Bots is off.
    Off,
    /// The request itself: a name, a role, a value this build does not accept.
    Refused(String),
    /// No bot has that id (any more).
    NotFound(String),
}

impl std::fmt::Display for BotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Off => f.write_str(OFF_MESSAGE),
            Self::Refused(message) => f.write_str(message),
            Self::NotFound(id) => write!(f, "No bot has the id {id}."),
        }
    }
}

impl std::error::Error for BotError {}

fn refused(message: impl Into<String>) -> anyhow::Error {
    BotError::Refused(message.into()).into()
}

fn not_found(id: &str) -> anyhow::Error {
    BotError::NotFound(id.into()).into()
}

/// The refusal an error carries, if it is one.
pub fn refusal(error: &anyhow::Error) -> Option<&BotError> {
    error.downcast_ref::<BotError>()
}

macro_rules! refuse_unless {
    ($cond:expr, $($message:tt)+) => {
        if !$cond {
            return Err(refused(format!($($message)+)));
        }
    };
}

/// What a bot may do without asking. Full access is the owner's decision
/// for a new bot (PRO-459): it runs as the owner's sessions do.
///
/// A level a newer build wrote is kept as [`BotAccess::Other`] and written
/// back unchanged; this build acts on it as [`BotAccess::effective`] says,
/// never as full access.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum BotAccess {
    #[default]
    Full,
    /// Asks before anything that leaves this computer.
    AskOutward,
    /// Reads and reports only.
    ReadReport,
    Other(String),
}

impl BotAccess {
    pub fn as_str(&self) -> &str {
        match self {
            Self::Full => "full",
            Self::AskOutward => "askOutward",
            Self::ReadReport => "readReport",
            Self::Other(value) => value,
        }
    }

    fn parse(value: String) -> Self {
        match value.as_str() {
            "full" => Self::Full,
            "askOutward" => Self::AskOutward,
            "readReport" => Self::ReadReport,
            _ => Self::Other(value),
        }
    }

    /// The level this build acts on: one it does not know counts as the
    /// most restrictive one it knows.
    pub fn effective(&self) -> Self {
        match self {
            Self::Other(_) => Self::ReadReport,
            known => known.clone(),
        }
    }
}

/// Where a bot runs. Only this Mac for now; a place a newer build wrote (a
/// cloud workspace, another machine) is kept as [`BotRunsOn::Other`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum BotRunsOn {
    #[default]
    ThisMac,
    Other(String),
}

impl BotRunsOn {
    pub fn as_str(&self) -> &str {
        match self {
            Self::ThisMac => "thisMac",
            Self::Other(value) => value,
        }
    }

    fn parse(value: String) -> Self {
        if value == "thisMac" { Self::ThisMac } else { Self::Other(value) }
    }
}

macro_rules! string_serde {
    ($type:ty) => {
        impl Serialize for $type {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $type {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                String::deserialize(deserializer).map(Self::parse)
            }
        }
    };
}

string_serde!(BotAccess);
string_serde!(BotRunsOn);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotPause {
    pub at: String,
    /// [`OWNER`], or the id of the bot that paused it: `terminalx bots pause`
    /// run from a bot's own chat is that bot's (PRO-468), and that chat may
    /// not resume it.
    pub by: String,
    /// What a newer build records about a pause (its source, a reason) survives a save by this one.
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, Value>,
}

/// Someone besides the owner who may give a bot work (PRO-478), and what
/// they may do. The owner is never listed: they may always ask and approve.
///
/// `kind` and `may` a newer build wrote are kept as they are and written
/// back; this build grants nothing for them. A field a newer build left out
/// reads as empty, so one such entry never makes the whole bot unreadable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotAsker {
    /// [`ASKER_PERSON`] or [`ASKER_BOT`].
    #[serde(default)]
    pub kind: String,
    /// A person's account user id, or a bot's id.
    #[serde(default)]
    pub id: String,
    /// How a person is shown, as they were named when added. A bot is shown by its own name.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// [`MAY_ASK_APPROVE`], [`MAY_ASK`] or [`MAY_HAND_OFF`].
    #[serde(default)]
    pub may: String,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, Value>,
}

pub const ASKER_PERSON: &str = "person";
pub const ASKER_BOT: &str = "bot";
/// Asks for work and approves what the bot asks about: a person only.
pub const MAY_ASK_APPROVE: &str = "askApprove";
/// Asks for work; the owner still approves.
pub const MAY_ASK: &str = "ask";
/// Hands work over to the bot: another bot only.
pub const MAY_HAND_OFF: &str = "handOff";
const MAX_ASKERS: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bot {
    /// The one stable reference to a bot: never changes and is never reused.
    pub id: String,
    /// Unique among the bots, from the name: how the CLI and a mention name
    /// it. Not stable: it changes with a rename and may be reused after a
    /// delete. Never keep a slug to find the bot later; keep its id.
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
    /// Who besides the owner may give it work. Empty: the owner alone.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub who_can_ask: Vec<BotAsker>,
    pub created: String,
    pub modified: String,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, Value>,
}

/// Every bot as one save left them. `revision` grows by one with every save,
/// so of two lists the one with the higher revision is the newer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BotList {
    pub revision: u64,
    pub bots: Vec<Bot>,
    /// Records in `bots.json` this build cannot read. They are kept as they are, and listed by none.
    pub unreadable: usize,
}

impl From<&bot_store::Snapshot> for BotList {
    fn from(snapshot: &bot_store::Snapshot) -> Self {
        Self { revision: snapshot.revision, bots: snapshot.bots.clone(), unreadable: snapshot.unreadable.len() }
    }
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
    /// The whole list: an entry left out is removed.
    #[serde(default)]
    pub who_can_ask: Option<Vec<BotAsker>>,
    /// The bot's `modified` as the caller read it. A patch that replaces a
    /// whole list (`worksIn`, `whoCanAsk`) is refused when the bot has changed
    /// since, so it never puts back what someone else just removed.
    #[serde(default)]
    pub if_modified: Option<String>,
}

/// A field that is present, even as `null`, is `Some`: absent is "leave it".
fn given<'de, T: Deserialize<'de>, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

pub fn enabled() -> bool {
    crate::store::settings::load().experimental.bots
}

/// [`enabled`] for a path taken on every keystroke (the runtime's guard):
/// read again after any settings write in this process, and at least once a
/// second for a change another process made; a stat and a clone otherwise.
pub fn enabled_cached() -> bool {
    use std::time::{Duration, Instant};
    static CACHE: std::sync::Mutex<Option<(std::path::PathBuf, u64, Instant, bool)>> = std::sync::Mutex::new(None);
    let Ok(path) = crate::store::root() else { return enabled() };
    let writes = crate::store::settings::writes();
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((cached, at_writes, at, on)) = cache.as_ref() {
        if *cached == path && *at_writes == writes && at.elapsed() < Duration::from_secs(1) {
            return *on;
        }
    }
    let on = enabled();
    *cache = Some((path, writes, Instant::now(), on));
    on
}

pub fn require_enabled() -> Result<()> {
    if enabled() { Ok(()) } else { Err(BotError::Off.into()) }
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

/// `base`, or `base-2`, `base-3`… when another bot (not `except`) has it or the word is reserved.
fn unique_slug(base: &str, bots: &[Bot], except: Option<&str>) -> String {
    let taken = |slug: &str| RESERVED_SLUGS.contains(&slug) || bots.iter().any(|bot| bot.slug == slug && Some(bot.id.as_str()) != except);
    if !taken(base) {
        return base.into();
    }
    (2..).map(|n| format!("{base}-{n}")).find(|slug| !taken(slug)).expect("an unused number exists")
}

fn clean_name(name: &str) -> Result<String> {
    let name = name.trim();
    refuse_unless!(!name.is_empty(), "A bot needs a name.");
    refuse_unless!(name.chars().count() <= MAX_NAME_CHARS, "A bot's name is at most {MAX_NAME_CHARS} characters.");
    refuse_unless!(!name.chars().any(char::is_control), "A bot's name is one line.");
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

/// Change the bots and announce the saved list (`bots_changed`) while the
/// store is still locked, so announcements leave in the order of the saves.
fn change_listed<T>(sink: &dyn EventSink, f: impl FnOnce(&mut Vec<Bot>) -> Result<T>) -> Result<(T, BotList)> {
    let mut saved = None;
    let out = bot_store::change(f, |snapshot| {
        let mut list = BotList::from(snapshot);
        let now = chrono::Utc::now();
        list.bots.iter_mut().for_each(|bot| forget_stale_request(bot, now));
        sink.emit("bots_changed", &list);
        saved = Some(list);
    })?;
    Ok((out, saved.expect("a saved change is announced")))
}

fn change<T>(sink: &dyn EventSink, f: impl FnOnce(&mut Vec<Bot>) -> Result<T>) -> Result<T> {
    Ok(change_listed(sink, f)?.0)
}

#[cfg(test)]
pub fn list() -> Result<Vec<Bot>> {
    Ok(listing()?.bots)
}

/// The bots with the revision they were read at.
pub fn listing() -> Result<BotList> {
    require_enabled()?;
    let mut list = BotList::from(&bot_store::snapshot()?);
    let now = chrono::Utc::now();
    list.bots.iter_mut().for_each(|bot| forget_stale_request(bot, now));
    Ok(list)
}

pub fn get(id: &str) -> Result<Bot> {
    require_enabled()?;
    let mut bot = bot_store::get(id)?.ok_or_else(|| not_found(id))?;
    forget_stale_request(&mut bot, chrono::Utc::now());
    Ok(bot)
}

/// What the sessions working for bot `id` (its chats, and what they
/// started) spent today, at Stats' prices: shown, never a cap (PRO-459).
pub fn spent_today(id: &str) -> Result<f64> {
    require_enabled()?;
    get(id)?;
    let day = crate::stats::today();
    let sessions = crate::store::index::load()?;
    Ok(sessions
        .iter()
        .filter(|entry| chat::acting_bot(entry).as_deref() == Some(id))
        .flat_map(|entry| entry.tabs.iter().map(move |tab| (entry, tab)))
        .filter(|(_, tab)| !tab.is_terminal())
        .map(|(entry, tab)| crate::session_usage::spent_on_day(&entry.cwd, tab, &crate::session_usage::AgentHomes(tab), &day))
        .sum())
}

/// How long a resume asked for from the CLI waits for the owner's answer.
pub const RESUME_REQUEST_LASTS: chrono::Duration = chrono::Duration::hours(24);

/// A resume request older than [`RESUME_REQUEST_LASTS`] (or with no time
/// that can be read) is no longer shown: the agent that asked is long gone.
fn forget_stale_request(bot: &mut Bot, now: chrono::DateTime<chrono::Utc>) {
    let fresh = bot.unknown.get(RESUME_REQUEST_KEY).and_then(|request| request["at"].as_str())
        .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
        .is_some_and(|at| now - at.with_timezone(&chrono::Utc) < RESUME_REQUEST_LASTS);
    if !fresh {
        bot.unknown.remove(RESUME_REQUEST_KEY);
    }
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

/// The bot a person names: by id (always works), by slug, or by name in any letter case.
pub fn named(selector: &str) -> Result<Named> {
    require_enabled()?;
    let wanted = selector.trim();
    let bots = bot_store::list()?;
    if let Some(bot) = bots.iter().find(|bot| bot.id == wanted).or_else(|| bots.iter().find(|bot| bot.slug == wanted)) {
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
        Named::Several => Err(refused(several_named(selector))),
        Named::Nobody => Err(refused(nobody_named(selector))),
    }
}

/// Hire a bot: a role and a name are all it asks for (PRO-459). Everything
/// else starts on the defaults, and its home is made from the role template.
pub fn create(sink: &dyn EventSink, role_template_id: &str, name: &str) -> Result<Bot> {
    require_enabled()?;
    let template = templates::find(role_template_id).ok_or_else(|| {
        let known: Vec<&str> = templates::all().iter().map(|template| template.id).collect();
        refused(format!("No role template {role_template_id}. The roles are: {}.", known.join(", ")))
    })?;
    let name = clean_name(name)?;
    let id = uuid::Uuid::now_v7().to_string();
    let now = crate::store::index::now();
    let home = bot_store::create_home(&id, &role_text(&template), &memory_text())?;
    let saved = change(sink, |bots| {
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
            who_can_ask: Vec::new(),
            created: now.clone(),
            modified: now,
            unknown: BTreeMap::new(),
        };
        bots.push(bot.clone());
        Ok(bot)
    });
    if saved.is_err() {
        bot_store::discard_home(&home);
    }
    saved
}

pub fn update(sink: &dyn EventSink, id: &str, patch: BotPatch) -> Result<Bot> {
    update_as(sink, id, patch, true)
}

/// The field of an `update`'s parameters that says a person was shown to have
/// asked; the runtime's control route sets it, after removing any sent.
pub const BY_PERSON: &str = "byPerson";

/// What an update [`PERSON_REQUIRED`] for names: what [`gives_more`] finds.
pub const PERSON_REQUIRED: &str = "Giving a bot more (more access, another reporting line, an organisation to work in, someone new or more able in Who can ask, another agent or model, or a new name) needs you to confirm it in the TerminalX window.";

/// How much an entry of Who can ask may do; a value this build does not know is the most.
fn may_rank(may: &str) -> u8 {
    match may {
        MAY_ASK => 0,
        MAY_HAND_OFF => 1,
        MAY_ASK_APPROVE => 2,
        _ => 3,
    }
}

/// Whether `patch` gives `bot` more than it has, so only a person may make
/// it (PRO-468, PRO-478): more access, another reporting line, a place it
/// does not work in yet, an entry of Who can ask that is new or may do more,
/// another agent, model or effort, or another name. Taking any of them away
/// gives nothing, and needs no one.
pub fn gives_more(bot: &Bot, patch: &BotPatch) -> bool {
    let raises = patch.access.as_ref().is_some_and(|access| matches!(access, BotAccess::Other(_)) || access_rank(access) > access_rank(&bot.access));
    let reports_elsewhere = patch.reports_to.as_ref().is_some_and(|reports_to| *reports_to != bot.reports_to);
    let new_place = patch.works_in.as_ref().is_some_and(|places| places.iter().any(|place| !bot.works_in.contains(place)));
    let new_asker = patch.who_can_ask.as_ref().is_some_and(|askers| {
        askers.iter().any(|asker| !bot.who_can_ask.iter().any(|had| had.kind == asker.kind && had.id == asker.id && may_rank(&had.may) >= may_rank(&asker.may)))
    });
    let other_agent = patch.harness.as_ref().is_some_and(|harness| *harness != bot.harness)
        || patch.model.as_ref().is_some_and(|model| *model != bot.model)
        || patch.effort.as_ref().is_some_and(|effort| *effort != bot.effort);
    let renamed = patch.name.as_ref().is_some_and(|name| clean_name(name).map_or(true, |name| name != bot.name));
    raises || reports_elsewhere || new_place || new_asker || other_agent || renamed
}

/// How much an access level lets a bot do; a level this build does not know is the least.
pub fn access_rank(access: &BotAccess) -> u8 {
    match access.effective() {
        BotAccess::Full => 2,
        BotAccess::AskOutward => 1,
        BotAccess::ReadReport | BotAccess::Other(_) => 0,
    }
}

/// [`update`], where `by_person` says whether a person was shown to have
/// asked. Without that, an update that gives the bot more access or another
/// reporting line is refused, judged against the record under the store's
/// lock (PRO-468).
pub fn update_as(sink: &dyn EventSink, id: &str, patch: BotPatch, by_person: bool) -> Result<Bot> {
    require_enabled()?;
    change(sink, |bots| {
        let index = bots.iter().position(|bot| bot.id == id).ok_or_else(|| not_found(id))?;
        let mut bot = bots[index].clone();
        if !by_person {
            refuse_unless!(!gives_more(&bot, &patch), "{PERSON_REQUIRED}");
        }
        if patch.works_in.is_some() || patch.who_can_ask.is_some() {
            refuse_unless!(patch.if_modified.as_ref().is_none_or(|seen| *seen == bot.modified), "{} changed since this was read. The latest is shown now; make the change again.", bot.name);
        }
        if let Some(name) = &patch.name {
            let name = clean_name(name)?;
            if name != bot.name {
                bot.slug = unique_slug(&slugify(&name), bots, Some(id));
                bot.name = name;
            }
        }
        if let Some(title) = &patch.role_title {
            let title = title.trim();
            refuse_unless!(!title.is_empty() && title.chars().count() <= MAX_NAME_CHARS && !title.chars().any(char::is_control), "A role title is one line of at most {MAX_NAME_CHARS} characters.");
            bot.role_title = title.into();
        }
        if let Some(harness) = &patch.harness {
            refuse_unless!(crate::harness::binary_of(harness).is_some(), "Unknown agent {harness}.");
            refuse_unless!(chat::takes_bot_instructions(harness), "A bot runs on Claude Code or Codex for now: {harness} cannot be given its role and memory.");
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
        if let Some(access) = &patch.access {
            refuse_unless!(!matches!(access, BotAccess::Other(_)), "Unknown access {}. Use full, askOutward or readReport.", access.as_str());
            bot.access = access.clone();
        }
        if let Some(runs_on) = &patch.runs_on {
            refuse_unless!(!matches!(runs_on, BotRunsOn::Other(_)), "A bot runs on thisMac for now; {} is not offered.", runs_on.as_str());
            bot.runs_on = runs_on.clone();
        }
        if let Some(reports_to) = &patch.reports_to {
            refuse_unless!(reports_to != id, "A bot does not report to itself.");
            refuse_unless!(reports_to == OWNER || bots.iter().any(|other| other.id == *reports_to), "A bot reports to you or to another bot; {reports_to} is neither.");
            refuse_unless!(!reports_back(bots, reports_to, id), "Those two bots would report to each other.");
            bot.reports_to = reports_to.clone();
        }
        if let Some(works_in) = &patch.works_in {
            let mut places: Vec<String> = Vec::new();
            for place in works_in.iter().map(|place| place.trim()).filter(|place| !place.is_empty()) {
                if !places.iter().any(|known| known == place) {
                    places.push(place.into());
                }
            }
            refuse_unless!(!places.is_empty(), "A bot works somewhere: `{PERSONAL}` when it works for you alone.");
            bot.works_in = places;
        }
        if let Some(askers) = &patch.who_can_ask {
            bot.who_can_ask = clean_askers(askers, &bots[index], bots)?;
        }
        if bot != bots[index] {
            bot.modified = crate::store::index::now();
            bots[index] = bot.clone();
        }
        Ok(bot)
    })
}

/// `askers` as a bot's list keeps them: each person or bot once, never the
/// owner nor the bot itself, a bot that exists, and only what each may be
/// given. Only a person's words count as approval, so a bot never approves;
/// handing work over is between bots. An entry this build does not know is
/// accepted only as the bot already has it, unchanged.
fn clean_askers(askers: &[BotAsker], bot: &Bot, bots: &[Bot]) -> Result<Vec<BotAsker>> {
    refuse_unless!(askers.len() <= MAX_ASKERS, "At most {MAX_ASKERS} people and bots may ask a bot for work.");
    let mut kept: Vec<BotAsker> = Vec::new();
    for asker in askers {
        let id = asker.id.trim();
        if kept.iter().any(|other| other.kind == asker.kind && other.id == id) {
            continue;
        }
        if bot.who_can_ask.contains(asker) {
            kept.push(asker.clone());
            continue;
        }
        refuse_unless!(!id.is_empty() && id.chars().count() <= 200 && !id.chars().any(char::is_control), "Someone who may ask is named by an id of one line.");
        refuse_unless!(asker.name.chars().count() <= MAX_NAME_CHARS * 2 && !asker.name.chars().any(char::is_control), "A name is one line of at most {} characters.", MAX_NAME_CHARS * 2);
        refuse_unless!(id != OWNER, "You may always ask your bots; you are not listed.");
        match asker.kind.as_str() {
            ASKER_BOT => {
                refuse_unless!(id != bot.id, "A bot does not ask itself for work.");
                refuse_unless!(bots.iter().any(|other| other.id == id), "No bot has the id {id}.");
                refuse_unless!(asker.may == MAY_HAND_OFF || asker.may == MAY_ASK, "Another bot may ask or hand off work, never approve: only a person's words count as approval.");
            }
            ASKER_PERSON => {
                refuse_unless!(asker.may == MAY_ASK_APPROVE || asker.may == MAY_ASK, "A person may ask, or ask and approve.");
            }
            other => return Err(refused(format!("Unknown kind {other}. Use {ASKER_PERSON} or {ASKER_BOT}."))),
        }
        kept.push(BotAsker { id: id.into(), name: asker.name.trim().into(), ..asker.clone() });
    }
    Ok(kept)
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

/// Delete a bot. Its record is kept in its home as `bot.json`, the
/// definitions are saved without it, and only then does its home go to the
/// trash: a failure at any step leaves no listed bot without its home.
/// Bots that reported to it report to the owner.
pub fn delete(sink: &dyn EventSink, id: &str) -> Result<()> {
    require_enabled()?;
    let removed = change(sink, |bots| {
        let index = bots.iter().position(|bot| bot.id == id).ok_or_else(|| not_found(id))?;
        bot_store::keep_record(&bots[index])?;
        let removed = bots.remove(index);
        let now = crate::store::index::now();
        for bot in bots.iter_mut().filter(|bot| bot.reports_to == id) {
            bot.reports_to = owner();
            bot.modified = now.clone();
        }
        // Nor does it ask any bot for work any more.
        for bot in bots.iter_mut().filter(|bot| bot.who_can_ask.iter().any(|asker| asker.kind == ASKER_BOT && asker.id == id)) {
            bot.who_can_ask.retain(|asker| !(asker.kind == ASKER_BOT && asker.id == id));
            bot.modified = now.clone();
        }
        Ok(removed)
    })?;
    bot_store::trash_home(&removed.id).with_context(|| format!("{} is deleted, but its home folder could not be moved to the trash and is still in bots/", removed.name))?;
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
            bot.unknown.remove(RESUME_REQUEST_KEY);
            bot.modified = crate::store::index::now();
            true
        }
    }
}

/// A resume asked for from the `terminalx` CLI, which waits on the owner's
/// answer in the app (PRO-468): `{"at", "by"}` on the bot, where `by` is who
/// the request claims to come from. Only the window's own Resume applies it.
pub const RESUME_REQUEST_KEY: &str = "resumeRequest";

/// Ask the owner to resume `id`. A bot that is not paused has nothing to ask.
pub fn request_resume(sink: &dyn EventSink, id: &str, by: &str) -> Result<Bot> {
    require_enabled()?;
    change(sink, |bots| {
        let bot = bots.iter_mut().find(|bot| bot.id == id).ok_or_else(|| not_found(id))?;
        if bot.paused.is_some() {
            bot.unknown.insert(RESUME_REQUEST_KEY.into(), json!({"at": crate::store::index::now(), "by": by}));
        }
        Ok(bot.clone())
    })
}

/// The owner said no to a resume the CLI asked for: the bot stays paused.
pub fn dismiss_resume(sink: &dyn EventSink, id: &str) -> Result<Bot> {
    require_enabled()?;
    change(sink, |bots| {
        let bot = bots.iter_mut().find(|bot| bot.id == id).ok_or_else(|| not_found(id))?;
        bot.unknown.remove(RESUME_REQUEST_KEY);
        Ok(bot.clone())
    })
}

fn pause_one(sink: &dyn EventSink, id: &str, pause: Option<BotPause>) -> Result<Bot> {
    require_enabled()?;
    change(sink, |bots| {
        let bot = bots.iter_mut().find(|bot| bot.id == id).ok_or_else(|| not_found(id))?;
        set_paused(bot, pause.as_ref());
        Ok(bot.clone())
    })
}

fn pause_every(sink: &dyn EventSink, pause: Option<BotPause>) -> Result<BotList> {
    require_enabled()?;
    Ok(change_listed(sink, |bots| {
        for bot in bots.iter_mut() {
            set_paused(bot, pause.as_ref());
        }
        Ok(())
    })?
    .1)
}

fn pause_now(by: &str) -> BotPause {
    BotPause { at: crate::store::index::now(), by: by.into(), unknown: BTreeMap::new() }
}

/// Record that a bot is paused, when and by whom. Nothing is stopped here.
pub fn pause(sink: &dyn EventSink, id: &str, by: &str) -> Result<Bot> {
    pause_one(sink, id, Some(pause_now(by)))
}

pub fn resume(sink: &dyn EventSink, id: &str) -> Result<Bot> {
    pause_one(sink, id, None)
}

/// The one pause switch: every bot not already paused is paused now.
pub fn pause_all(sink: &dyn EventSink, by: &str) -> Result<BotList> {
    pause_every(sink, Some(pause_now(by)))
}

pub fn resume_all(sink: &dyn EventSink) -> Result<BotList> {
    pause_every(sink, None)
}

pub fn role_read(id: &str) -> Result<String> {
    let bot = get(id)?;
    bot_store::read_role(&bot.id)
}

/// Replace a bot's standing instructions.
pub fn role_write(sink: &dyn EventSink, id: &str, text: &str) -> Result<Bot> {
    require_enabled()?;
    refuse_unless!(text.len() <= MAX_ROLE_BYTES, "A role is at most {} KB.", MAX_ROLE_BYTES / 1024);
    change(sink, |bots| {
        let bot = bots.iter_mut().find(|bot| bot.id == id).ok_or_else(|| not_found(id))?;
        bot_store::write_role(&bot.id, text)?;
        bot.modified = crate::store::index::now();
        Ok(bot.clone())
    })
}

/// Where a bot's home folder is, or `None` for a record whose id could name none.
pub fn home(bot: &Bot) -> Option<std::path::PathBuf> {
    bot_store::home_dir(&bot.id).ok()
}

/// The app's commands, as the runtime that owns the store answers them
/// (`runtime.session.bots`). A change made in the app is by the owner.
pub fn call(sink: &dyn EventSink, operation: &str, params: &Value) -> Result<Value> {
    if let Some(answer) = chat::call(sink, operation, params) {
        return answer;
    }
    let string = |key: &str| params[key].as_str().ok_or_else(|| refused(format!("{key} must be a string")));
    Ok(match operation {
        "list" => serde_json::to_value(listing()?)?,
        "get" => serde_json::to_value(get(string("id")?)?)?,
        "templates" => serde_json::to_value(role_templates()?)?,
        // A hire makes the bot's home chat too (PRO-468).
        "create" => serde_json::to_value(chat::hire(sink, string("roleTemplateId")?, string("name")?)?)?,
        "update" => {
            let patch: BotPatch = serde_json::from_value(params["patch"].clone()).map_err(|error| refused(format!("Invalid change: {error}")))?;
            // Set by the runtime's control route, which alone takes requests from outside this process.
            let by_person = params[BY_PERSON].as_bool().unwrap_or(true);
            serde_json::to_value(update_as(sink, string("id")?, patch, by_person)?)?
        }
        "delete" => {
            delete(sink, string("id")?)?;
            Value::Null
        }
        // Every caller is the owner today; see `BotPause::by`.
        "pause" => serde_json::to_value(pause(sink, string("id")?, OWNER)?)?,
        "resume" => serde_json::to_value(resume(sink, string("id")?)?)?,
        "pauseAll" => serde_json::to_value(pause_all(sink, OWNER)?)?,
        "resumeAll" => serde_json::to_value(resume_all(sink)?)?,
        "dismissResume" => serde_json::to_value(dismiss_resume(sink, string("id")?)?)?,
        "roleRead" => json!(role_read(string("id")?)?),
        "spentToday" => json!({"usd": spent_today(string("id")?)?, "day": crate::stats::today()}),
        "roleWrite" => serde_json::to_value(role_write(sink, string("id")?, string("text")?)?)?,
        other => return Err(refused(format!("Unknown bots operation {other}"))),
    })
}

#[cfg(test)]
mod tests;
