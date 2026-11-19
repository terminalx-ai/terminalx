use std::io::Read;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::account::{self, AccountManager};
use crate::cloud_remote::CloudRemote;
use crate::AppState;

const MAX_PAYLOAD: u64 = 256 * 1024;

fn json_body(response: ureq::Response) -> Result<Value, String> {
    serde_json::from_reader(response.into_reader().take(MAX_PAYLOAD))
        .map_err(|_| "support_reports_unavailable".into())
}

fn post(
    account: &AccountManager,
    action: &str,
    revision: &str,
    request: Value,
) -> Result<Value, String> {
    if crate::data_privacy::enabled() {
        return Err("privacy".into());
    }
    let session = account.context().ok_or("unauthorized")?;
    if AccountManager::context_revision(&session) != revision || !account.is_current(&session) {
        return Err("unauthorized".into());
    }
    let endpoint = format!("{}/v1/support/{action}", account::api_base_url());
    let result = match account::cloud_agent()
        .post(&endpoint)
        .set("content-type", "application/json")
        .set("authorization", &format!("Bearer {}", session.access_token))
        .send_json(request)
    {
        Ok(response) => json_body(response),
        Err(ureq::Error::Status(status, response)) => {
            let payload = json_body(response).unwrap_or_default();
            let code = match payload["error"].as_str() {
                Some(
                    code @ ("support_report_not_found"
                    | "support_preview_expired"
                    | "support_report_retry_mismatch"
                    | "support_report_rate_limited"
                    | "support_report_too_large"
                    | "support_reports_unavailable"),
                ) => code,
                _ if status == 401 => "unauthorized",
                _ if status == 404 => "support_reports_unavailable",
                _ => "unavailable",
            };
            Err(code.into())
        }
        Err(_) => Err("unavailable".into()),
    };
    if !account.is_current(&session) {
        return Err("unauthorized".into());
    }
    result
}

#[tauri::command]
pub async fn support_report_preview(
    state: tauri::State<'_, AppState>,
    revision: String,
    request: Value,
) -> Result<Value, String> {
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || post(&account, "preview", &revision, request))
        .await
        .map_err(|_| "unavailable".to_string())?
}

#[tauri::command]
pub async fn support_report_submit(
    state: tauri::State<'_, AppState>,
    revision: String,
    request: Value,
) -> Result<Value, String> {
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || post(&account, "submit", &revision, request))
        .await
        .map_err(|_| "unavailable".to_string())?
}

#[tauri::command]
pub fn support_report_local(
    state: tauri::State<'_, AppState>,
    remote: tauri::State<'_, Arc<CloudRemote>>,
    app: tauri::AppHandle,
    revision: Option<String>,
    from: i64,
    to: i64,
    selected: bool,
) -> Value {
    let mut events = Vec::new();
    let status = if !selected {
        "omitted"
    } else if let Some((current, scope)) = state
        .account
        .current_revision()
        .zip(state.account.current_scope())
    {
        if revision.as_deref() == Some(current.1.as_str()) {
            events = remote.close_log().support_events(&scope, from, to);
            if state.account.current_revision().as_ref() != Some(&current) {
                events.clear();
                "unavailable"
            } else if events.is_empty() {
                "empty"
            } else {
                "included"
            }
        } else {
            "unavailable"
        }
    } else {
        "unavailable"
    };
    let truncated = events.len() > 100;
    events.sort_unstable_by_key(|(at, _)| std::cmp::Reverse(*at));
    json!({
        "status": status,
        "platform": match std::env::consts::OS {
            "macos" => "macos",
            "linux" => "linux",
            "windows" => "windows",
            _ => "unknown",
        },
        "appVersion": app.package_info().version.to_string(),
        "capturedAt": chrono::Utc::now().timestamp_millis(),
        "truncated": truncated,
        "events": events.into_iter().take(100)
            .map(|(at, reason)| json!({ "at": at, "kind": "relay-closed", "classification": reason })).collect::<Vec<_>>(),
    })
}
