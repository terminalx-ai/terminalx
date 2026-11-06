//! Account-bound inbox transport. Tokens stay native; stale account responses
//! and workspaces outside the current membership never reach the webview.
use std::io::{BufRead, BufReader, Read};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::account::{AccountContext, AccountManager};

static STREAM: Mutex<Option<String>> = Mutex::new(None);
const LIMIT: u64 = 512 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadMarker {
    pub org_id: String,
    pub workspace_id: String,
    pub session_id: String,
    pub tab_id: String,
    pub read_seq: u64,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128 && value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
}
fn valid_cursor(value: &str) -> bool {
    !value.is_empty() && value.len() <= 18 && value.bytes().all(|b| b.is_ascii_digit())
}
fn context(account: &AccountManager, owner: &str) -> Result<AccountContext, String> {
    let context = account.context().ok_or("account_signed_out")?;
    if account.current_account_key().as_deref() != Some(owner) { return Err("account_changed".into()); }
    Ok(context)
}
fn current(account: &AccountManager, asked: &AccountContext, owner: &str) -> bool {
    account.current_account_key().as_deref() == Some(owner) && account.scope_if_same_account(asked).is_some()
}
fn request(context: &AccountContext, method: &str, path: &str) -> ureq::Request {
    ureq::AgentBuilder::new().redirects(0).timeout(Duration::from_secs(65)).timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(if path == "/inbox/stream" { 5 } else { 30 })).timeout_write(Duration::from_secs(10)).build()
        .request(method, &format!("{}/v1/desktop{path}", crate::account::api_base_url()))
        .set("Authorization", &format!("Bearer {}", context.access_token))
}
fn error(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(status, _) => format!("desktop_inbox_http_{status}"),
        _ => "desktop_inbox_unavailable".into(),
    }
}
fn decode(response: ureq::Response) -> Result<Value, String> {
    let mut bytes = Vec::new();
    response.into_reader().take(LIMIT + 1).read_to_end(&mut bytes).map_err(|_| "desktop_inbox_unavailable")?;
    if bytes.len() as u64 > LIMIT { return Err("desktop_inbox_invalid_response".into()); }
    serde_json::from_slice(&bytes).map_err(|_| "desktop_inbox_invalid_response".into())
}
fn fence_batch(account: &AccountManager, asked: &AccountContext, owner: &str, mut batch: Value) -> Result<Value, String> {
    if !current(account, asked, owner) { return Err("account_changed".into()); }
    let scope = account.scope_if_same_account(asked).ok_or("account_changed")?;
    let cursor = batch.get("cursor").and_then(Value::as_str).ok_or("desktop_inbox_invalid_response")?;
    if !valid_cursor(cursor) { return Err("desktop_inbox_invalid_response".into()); }
    let events = batch.get_mut("events").and_then(Value::as_array_mut).ok_or("desktop_inbox_invalid_response")?;
    events.retain(|event| event.get("orgId").and_then(Value::as_str).is_some_and(|org| scope.allows(org)));
    Ok(batch)
}

#[tauri::command]
pub async fn desktop_inbox_stream(state: tauri::State<'_, crate::AppState>, owner: String, stream_id: String, cursor: String, channel: tauri::ipc::Channel<Value>) -> Result<(), String> {
    if !valid_cursor(&cursor) || !valid_id(&stream_id) { return Err("desktop_inbox_invalid_request".into()); }
    let account = state.account.clone();
    *STREAM.lock().unwrap() = Some(stream_id.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let asked = context(&account, &owner)?;
        let response = request(&asked, "GET", "/inbox/stream").set("Accept", "text/event-stream").set("Last-Event-ID", &cursor).call().map_err(error)?;
        if !response.header("Content-Type").unwrap_or("").starts_with("text/event-stream") { return Err("desktop_inbox_invalid_response".into()); }
        let mut reader = BufReader::new(response.into_reader());
        loop {
            if STREAM.lock().unwrap().as_deref() != Some(&stream_id) || !current(&account, &asked, &owner) { return Ok(()); }
            let mut line = String::new();
            let count = reader.by_ref().take(LIMIT + 1).read_line(&mut line).map_err(|_| "desktop_inbox_unavailable")?;
            if count == 0 { return Ok(()); }
            if count as u64 > LIMIT { return Err("desktop_inbox_invalid_response".into()); }
            if let Some(data) = line.strip_prefix("data:") {
                let batch: Value = serde_json::from_str(data.trim()).map_err(|_| "desktop_inbox_invalid_response")?;
                let batch = fence_batch(&account, &asked, &owner, batch)?;
                if STREAM.lock().unwrap().as_deref() != Some(&stream_id) { return Ok(()); }
                channel.send(batch).map_err(|_| "desktop_inbox_closed")?;
            }
        }
    }).await.map_err(|_| "desktop_inbox_task_failed".to_string())?
}

#[tauri::command]
pub fn desktop_inbox_stop(stream_id: String) {
    let mut active = STREAM.lock().unwrap();
    if active.as_deref() == Some(&stream_id) { *active = None; }
}

#[tauri::command]
pub async fn desktop_inbox_poll(state: tauri::State<'_, crate::AppState>, owner: String, cursor: String) -> Result<Value, String> {
    if !valid_cursor(&cursor) { return Err("desktop_inbox_invalid_request".into()); }
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let asked = context(&account, &owner)?;
        let value = decode(request(&asked, "GET", "/inbox").query("cursor", &cursor).query("wait", "1").call().map_err(error)?)?;
        fence_batch(&account, &asked, &owner, value)
    }).await.map_err(|_| "desktop_inbox_task_failed".to_string())?
}

#[tauri::command]
pub async fn desktop_inbox_receipt(state: tauri::State<'_, crate::AppState>, owner: String, device_id: String, cursor: String) -> Result<(), String> {
    if !valid_cursor(&cursor) || !valid_id(&device_id) { return Err("desktop_inbox_invalid_request".into()); }
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let asked = context(&account, &owner)?;
        request(&asked, "POST", "/inbox/receipts").send_json(json!({"deviceId": device_id, "cursor": cursor})).map_err(error)?;
        Ok(())
    }).await.map_err(|_| "desktop_inbox_task_failed".to_string())?
}

#[tauri::command]
pub async fn desktop_read_marker(state: tauri::State<'_, crate::AppState>, owner: String, marker: ReadMarker) -> Result<ReadMarker, String> {
    if ![&marker.org_id, &marker.workspace_id, &marker.session_id, &marker.tab_id].iter().all(|id| valid_id(id)) || marker.read_seq > 9_007_199_254_740_991 { return Err("desktop_inbox_invalid_request".into()); }
    let account: Arc<AccountManager> = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let asked = context(&account, &owner)?;
        let value = decode(request(&asked, "PUT", &format!("/orgs/{}/cloud-workspaces/{}/read-markers", marker.org_id, marker.workspace_id))
            .send_json(json!({"sessionId": marker.session_id, "tabId": marker.tab_id, "readSeq": marker.read_seq})).map_err(error)?)?;
        if !current(&account, &asked, &owner) { return Err("account_changed".into()); }
        serde_json::from_value(value).map_err(|_| "desktop_inbox_invalid_response".into())
    }).await.map_err(|_| "desktop_inbox_task_failed".to_string())?
}
