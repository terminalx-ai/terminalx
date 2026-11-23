//! `bots/1` (PRO-482): the bots that live on this runtime, over a workspace
//! connection, for the person they belong to.
//!
//! - `bots.list`, `bots.home` and `bots.answer` are the phone's Bots calls
//!   (`bots::phone`), for a bot moved here by the person who asks: on a cloud
//!   workspace other members connect too, and see none of them.
//! - `bots.importPart` and `bots.import` take a bot moved here
//!   (`bots::moving`); `bots.export` and `bots.exportPart` read one out to move
//!   it back, and `bots.remove` lets it go once it is. A bundle travels in
//!   parts, as a frame holds at most `MAX_FRAME_BYTES`.
//!
//! A transfer is held in memory for its connection's device only, for
//! [`TRANSFER_TTL`], and at most [`MAX_TRANSFERS`] at once.

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::protocol::RpcError;
use crate::bots::{self, moving, BotError};
use crate::session::SessionManager;

/// The capability, spelled out in `protocol::CAPABILITIES`.
pub const BOTS: &str = "bots/1";
/// One part of a bundle, in characters of its encoding: well inside a frame,
/// with room for the frame's own encoding on the relay.
pub const PART_CHARS: usize = 256 * 1024;
const TRANSFER_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_TRANSFERS: usize = 8;
/// What a bundle's encoding may come to: four thirds of [`moving::MAX_BYTES`] and its JSON around it.
const MAX_ENCODED: usize = (moving::MAX_BYTES as usize) * 3 / 2;

struct Transfer {
    device: String,
    parts: Vec<Option<String>>,
    at: Instant,
}

static TRANSFERS: Mutex<BTreeMap<String, Transfer>> = Mutex::new(BTreeMap::new());

fn transfers() -> std::sync::MutexGuard<'static, BTreeMap<String, Transfer>> {
    let mut held = TRANSFERS.lock().unwrap_or_else(|error| error.into_inner());
    held.retain(|_, transfer| transfer.at.elapsed() < TRANSFER_TTL);
    held
}

fn rpc(error: anyhow::Error) -> RpcError {
    match bots::refusal(&error) {
        Some(BotError::Off) => RpcError::new("bots_off", error.to_string()),
        Some(BotError::NotFound(_)) => RpcError::not_found(error.to_string()),
        Some(BotError::Refused(message)) => RpcError::new("refused", message.clone()),
        None => RpcError::internal(error),
    }
}

fn string<'a>(params: &'a Value, key: &str) -> Result<&'a str, RpcError> {
    params[key].as_str().ok_or_else(|| RpcError::invalid(format!("{key} must be a string")))
}

fn transfer_id(params: &Value) -> Result<String, RpcError> {
    let id = string(params, "transfer")?;
    if id.is_empty() || id.len() > 64 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(RpcError::invalid("transfer must be a short id"));
    }
    Ok(id.into())
}

fn index(params: &Value, key: &str) -> Result<usize, RpcError> {
    params[key].as_u64().map(|value| value as usize).ok_or_else(|| RpcError::invalid(format!("{key} must be a number")))
}

/// Split an encoded bundle into a transfer `device` reads part by part.
fn hold_out(device: &str, encoded: String) -> Result<Value, RpcError> {
    let parts: Vec<Option<String>> = encoded.as_bytes().chunks(PART_CHARS).map(|chunk| Some(String::from_utf8_lossy(chunk).into_owned())).collect();
    let count = parts.len().max(1);
    let id = uuid::Uuid::new_v4().to_string();
    let mut held = transfers();
    if held.len() >= MAX_TRANSFERS {
        return Err(RpcError::new("busy", "Too many moves are under way here; try again in a few minutes."));
    }
    held.insert(id.clone(), Transfer { device: device.into(), parts, at: Instant::now() });
    Ok(json!({"transfer": id, "parts": count}))
}

/// One call. `user` and `device` are the connection's, as the runtime knows them.
pub fn call(manager: &SessionManager, method: &str, params: &Value, user: Option<&str>, device: &str) -> Result<Value, RpcError> {
    let sink = manager.sink();
    match method {
        "bots.list" => bots::phone::workspace_call(manager, "list", params, user).map_err(rpc),
        "bots.home" => bots::phone::workspace_call(manager, "home", params, user).map_err(rpc),
        "bots.answer" => bots::phone::workspace_call(manager, "answer", params, user).map_err(rpc),
        "bots.importPart" => {
            let id = transfer_id(params)?;
            let (at, count) = (index(params, "index")?, index(params, "parts")?);
            let data = string(params, "data")?;
            if count == 0 || count * PART_CHARS > MAX_ENCODED + PART_CHARS || at >= count || data.len() > PART_CHARS {
                return Err(RpcError::invalid("This part does not fit the move."));
            }
            let mut held = transfers();
            if !held.contains_key(&id) && held.len() >= MAX_TRANSFERS {
                return Err(RpcError::new("busy", "Too many moves are under way here; try again in a few minutes."));
            }
            let transfer = held.entry(id).or_insert_with(|| Transfer { device: device.into(), parts: vec![None; count], at: Instant::now() });
            if transfer.device != device || transfer.parts.len() != count {
                return Err(RpcError::forbidden("This move belongs to another connection."));
            }
            transfer.parts[at] = Some(data.into());
            transfer.at = Instant::now();
            Ok(json!({"received": transfer.parts.iter().filter(|part| part.is_some()).count()}))
        }
        "bots.import" => {
            let id = transfer_id(params)?;
            let encoded = {
                let mut held = transfers();
                let transfer = held.get(&id).ok_or_else(|| RpcError::not_found("No such move here; send its parts first."))?;
                if transfer.device != device {
                    return Err(RpcError::forbidden("This move belongs to another connection."));
                }
                if transfer.parts.iter().any(Option::is_none) {
                    return Err(RpcError::invalid("Not every part of the move has arrived."));
                }
                let transfer = held.remove(&id).expect("held above");
                transfer.parts.into_iter().flatten().collect::<String>()
            };
            let bundle = moving::decode(&encoded).map_err(rpc)?;
            let imported = moving::import(sink.as_ref(), bundle, user).map_err(rpc)?;
            bots::enforce::reconcile(manager, Some(&imported.bot.id));
            serde_json::to_value(imported).map_err(RpcError::internal)
        }
        "bots.export" => {
            let id = string(params, "id")?;
            let bot = bots::get(id).map_err(rpc)?;
            if !moving::belongs_to(&bot, user) {
                return Err(RpcError::not_found(format!("No bot of yours has the id {id} here.")));
            }
            let encoded = moving::encode(&moving::export(id).map_err(rpc)?).map_err(rpc)?;
            hold_out(device, encoded)
        }
        "bots.exportPart" => {
            let id = transfer_id(params)?;
            let at = index(params, "index")?;
            let held = transfers();
            let transfer = held.get(&id).filter(|transfer| transfer.device == device).ok_or_else(|| RpcError::not_found("No such move here."))?;
            let part = transfer.parts.get(at).cloned().flatten().ok_or_else(|| RpcError::invalid("No such part."))?;
            Ok(json!({"data": part}))
        }
        "bots.remove" => {
            let id = string(params, "id")?;
            let bot = bots::get(id).map_err(rpc)?;
            if !moving::belongs_to(&bot, user) {
                return Err(RpcError::not_found(format!("No bot of yours has the id {id} here.")));
            }
            bots::enforce::call(manager, "delete", &json!({"id": id})).map_err(rpc)?;
            Ok(Value::Null)
        }
        other => Err(RpcError::new("method_not_found", format!("{other} is not a workspace method"))),
    }
}

#[cfg(test)]
#[path = "bots_tests.rs"]
mod tests;
