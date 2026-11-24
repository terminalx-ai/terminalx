//! A bot's work in cloud workspaces (PRO-514).
//!
//! A bot has the same limits on a cloud VM as on this Mac. A session that
//! acts for a bot may start a session in a cloud workspace, prompt it and
//! resume its workspace, and each of those is held to the bot's access as it
//! is at that moment, by the rule its local sessions are held by
//! (`chat::bot_limit`, the limit behind `chat::mode_limit` and
//! `SessionManager::hold_to_bot`):
//!
//! - a new cloud session starts in a mode no wider than the limit, whatever
//!   mode was asked for;
//! - a cloud session a bot's session started is recorded here as that bot's
//!   ([`record`]), and a bot's session prompts no other ([`works_for`]);
//! - a prompt, and a resume, carry the limit to the window ([`HOLD_PARAM`]),
//!   which sets the tab's mode to it before the prompt reaches the agent.
//!
//! The workspace's runtime knows nothing of bots: it runs the agent in the
//! mode it is given, and takes a mode only from a person's own connection,
//! which is the window's. So the hold is made here, where the command
//! arrives and who sent it is known (`control::Caller`), and the window does
//! what it is told. The per-call gate of a local session (`access`) does not
//! reach a cloud VM: there the mode is the whole barrier.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::chat::ModeLimit;
use crate::store::bots as bot_store;
use crate::store::index;

/// The `cloud.*` commands that start or continue work, each held to the bot.
pub const HELD: &[&str] = &["sessions.create", "send", "resume"];
/// What the window is told of the hold. Written here only: one a caller
/// sent is dropped before the command goes on.
pub const HOLD_PARAM: &str = "botHold";
/// The modes the window is given the limit for, one by one. Any other mode
/// is held to the limit itself.
const MODES: &[&str] = &["plan", "manual", "default", "ask", "auto", "acceptEdits", "bypassPermissions", "bypass"];
/// The most cloud sessions remembered; the oldest go first.
const KEPT: usize = 2000;

/// One cloud session that works for a bot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    bot: String,
    /// `cloud:<org>:<workspace>`.
    workspace: String,
    /// `cloud:<org>:<workspace>:<session>`. Absent for the first session of
    /// a workspace the bot's session created: the workspace's launch starts
    /// it later, and its id is not known when the create answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<String>,
    created: String,
}

/// `cloud:<org>:<workspace>[:<session>]` as its workspace's key and its
/// session's id, read as the window reads it (`parseCloudWorkspaceKey`).
fn parse(key: &str) -> Option<(String, Option<&str>)> {
    let rest = key.strip_prefix("cloud:")?;
    if rest.contains('/') {
        return None;
    }
    let mut parts = rest.split(':');
    let (org, workspace, session) = (parts.next()?, parts.next()?, parts.next());
    if org.is_empty() || workspace.is_empty() || parts.next().is_some() {
        return None;
    }
    Some((format!("cloud:{org}:{workspace}"), session.filter(|session| !session.is_empty())))
}

/// The records this build can read. One it cannot is kept in the file and
/// stands for no session.
fn records() -> Result<Vec<Record>> {
    Ok(bot_store::cloud_sessions()?.into_iter().filter_map(|record| serde_json::from_value(record).ok()).collect())
}

/// Remember that the cloud session `session` (its full key), or the first
/// session of the new workspace `workspace` when `session` is `None`, works
/// for `bot`.
pub fn record(bot: &str, workspace: &str, session: Option<&str>) -> Result<()> {
    let (workspace, _) = parse(workspace).ok_or_else(|| anyhow::anyhow!("{workspace} is not a cloud workspace's key"))?;
    if let Some(session) = session {
        let named = parse(session).filter(|(of, id)| *of == workspace && id.is_some());
        anyhow::ensure!(named.is_some(), "{session} is not a session of {workspace}");
    }
    let record = Record { bot: bot.to_owned(), workspace, session: session.map(str::to_owned), created: index::now() };
    bot_store::change_cloud_sessions(|stored| {
        let same = |value: &Value| serde_json::from_value::<Record>(value.clone()).is_ok_and(|other| other.workspace == record.workspace && other.session == record.session);
        // A session works for one bot: the one whose session started it last.
        stored.retain(|value| !same(value));
        stored.push(serde_json::to_value(&record)?);
        if stored.len() > KEPT {
            stored.drain(..stored.len() - KEPT);
        }
        Ok(())
    })
}

/// Whether a cloud session works for a bot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Works {
    /// Recorded as the bot's.
    Session,
    /// In a workspace the bot's session created: the bot's only if it is
    /// that workspace's first session, which the window knows.
    Launch,
    No,
}

/// Whether the cloud session `target` (its full key) works for `bot`.
pub fn works_for(bot: &str, target: &str) -> Result<Works> {
    let Some((workspace, Some(_))) = parse(target) else { return Ok(Works::No) };
    let records = records()?;
    if records.iter().any(|record| record.bot == bot && record.session.as_deref() == Some(target)) {
        return Ok(Works::Session);
    }
    // Recorded as another bot's: never this one's, launch or not.
    if records.iter().any(|record| record.session.as_deref() == Some(target)) {
        return Ok(Works::No);
    }
    Ok(if records.iter().any(|record| record.bot == bot && record.workspace == workspace && record.session.is_none()) { Works::Launch } else { Works::No })
}

/// The sessions of `workspace` that work for `bot`, by their keys, and
/// whether the workspace's first session does.
pub fn sessions_in(bot: &str, workspace: &str) -> Result<(Vec<String>, bool)> {
    let Some((workspace, _)) = parse(workspace) else { return Ok((Vec::new(), false)) };
    let mine: Vec<Record> = records()?.into_iter().filter(|record| record.bot == bot && record.workspace == workspace).collect();
    let launch = mine.iter().any(|record| record.session.is_none());
    Ok((mine.into_iter().filter_map(|record| record.session).collect(), launch))
}

/// The organisation a cloud command of a session that works for bot `bot` is held to (PRO-483): the place the
/// session works in (`chat::session_place`), as `personal` or an organisation's id, or empty for none (a place the bot
/// no longer works in, a bot or session that cannot be read), which the window takes as no workspace at all.
pub fn hold_org(bot: &str, session: Option<&str>) -> String {
    let (Ok(Some(bot)), Some(entry)) = (bot_store::get(bot), session.and_then(|session| index::get(session).ok())) else { return String::new() };
    match super::chat::session_place(&bot, &entry) {
        super::memory::Place::Bot => String::new(),
        place => place.key().to_owned(),
    }
}

/// Whether the limit narrows nothing: full access, which runs as the
/// owner's own sessions do.
pub fn widest(limit: &ModeLimit) -> bool {
    limit.allows(index::DEFAULT_PERMISSION_MODE)
}

/// One limit as the window applies it: the mode each known mode is held to
/// ([`ModeLimit::clamp`], worked out here so the rule lives in one place),
/// and the limit itself for a mode it does not know.
fn rule(limit: &ModeLimit) -> Value {
    let modes: serde_json::Map<String, Value> = MODES.iter().map(|mode| ((*mode).to_owned(), json!(limit.clamp(mode)))).collect();
    json!({ "limit": limit.mode, "why": limit.why, "modes": modes })
}

/// The limit as the window is told it, for a tab whose agent runs in its
/// terminal and for one on native Codex (`ModeLimit::on`). `None` for a
/// limit that narrows nothing.
pub fn hold(limit: &ModeLimit) -> Option<Value> {
    if widest(limit) {
        return None;
    }
    Some(json!({
        "terminal": rule(&limit.clone().on(index::AgentTransport::Pty)),
        "nativeCodex": rule(&limit.clone().on(index::AgentTransport::ExperimentalCodexStdio)),
    }))
}

/// The mode a new cloud session of a bot starts in: the one asked for, or
/// the default launch mode as a local session takes it, no wider than the
/// limit. Always named: a launch that names none starts in bypass.
pub fn launch_mode(limit: &ModeLimit, asked: Option<&str>) -> String {
    limit.clamp(asked.map(str::trim).filter(|mode| !mode.is_empty()).unwrap_or(index::DEFAULT_PERMISSION_MODE))
}

#[cfg(test)]
#[path = "cloud_tests.rs"]
mod tests;
