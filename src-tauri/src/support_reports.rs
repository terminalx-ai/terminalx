use std::io::Read;
use std::sync::{Arc, OnceLock};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use sha2::Sha256;

use serde_json::{json, Value};

use crate::account::{self, AccountManager, CloudScope};
use crate::cloud_remote::CloudRemote;
use crate::AppState;

type Proof = Hmac<Sha256>;

fn local_proof(revision: &str, scope: &CloudScope, local: &Value) -> Proof {
    static KEY: OnceLock<[u8; 32]> = OnceLock::new();
    let key = KEY.get_or_init(|| {
        let mut key = [0; 32];
        OsRng.fill_bytes(&mut key);
        key
    });
    let mut proof = Proof::new_from_slice(key).expect("HMAC key");
    let context = (
        &scope.user_id,
        &scope.profile_id,
        &scope.active_org_id,
        scope.multi_org,
        &scope.members,
    );
    proof.update(
        &serde_json::to_vec(&(revision, context, local)).expect("serialize support preview"),
    );
    proof
}

fn verify_local_proof(revision: &str, scope: &CloudScope, local: &Value, encoded: &str) -> bool {
    URL_SAFE_NO_PAD.decode(encoded).is_ok_and(|tag| {
        local_proof(revision, scope, local)
            .verify_slice(&tag)
            .is_ok()
    })
}

fn authorize_local(
    account: &AccountManager,
    revision: &str,
    local: &Value,
    proof: Option<&str>,
) -> Result<(), String> {
    if local["events"].as_array().is_some_and(Vec::is_empty) {
        return Ok(());
    }
    let scope = account
        .support_scope(revision)
        .ok_or("support_scope_changed")?;
    if !proof.is_some_and(|tag| verify_local_proof(revision, &scope, local, tag)) {
        return Err("support_scope_changed".into());
    }
    Ok(())
}

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
    proof: Option<&str>,
) -> Result<Value, String> {
    if crate::data_privacy::enabled() {
        return Err("privacy".into());
    }
    let session = account.context().ok_or("unauthorized")?;
    if AccountManager::context_revision(&session) != revision || !account.is_current(&session) {
        return Err("unauthorized".into());
    }
    if action == "submit" {
        authorize_local(account, revision, &request["local"], proof)?;
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
                    | "support_reports_unavailable"
                    | "support_attachment_empty"),
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
    tauri::async_runtime::spawn_blocking(move || {
        post(&account, "preview", &revision, request, None)
    })
    .await
    .map_err(|_| "unavailable".to_string())?
}

#[tauri::command]
pub async fn support_report_submit(
    state: tauri::State<'_, AppState>,
    revision: String,
    request: Value,
    proof: Option<String>,
) -> Result<Value, String> {
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || {
        post(&account, "submit", &revision, request, proof.as_deref())
    })
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
    let captured_at = chrono::Utc::now().timestamp_millis();
    let scope = revision
        .as_deref()
        .and_then(|revision| state.account.support_scope(revision));
    let snapshot = scope
        .as_ref()
        .filter(|_| selected)
        .map(|scope| remote.close_log().support_events(scope, from, to))
        .filter(|_| {
            revision
                .as_deref()
                .and_then(|revision| state.account.support_scope(revision))
                == scope
        });
    let (mut events, mut retained_since, status) = match snapshot {
        Some(snapshot) if snapshot.events.is_empty() => {
            (snapshot.events, Some(snapshot.retained_since), "empty")
        }
        Some(snapshot) => (snapshot.events, Some(snapshot.retained_since), "included"),
        None => (
            Vec::new(),
            None,
            if selected { "unavailable" } else { "omitted" },
        ),
    };
    events.sort_unstable_by_key(|(at, _)| std::cmp::Reverse(*at));
    let truncated = events.len() > 100;
    if let Some((at, _)) = events.get(100) {
        retained_since = retained_since.map(|since| since.max(at.saturating_add(1)));
    }
    let end = to.min(captured_at);
    let coverage = retained_since
        .map(|since| from.max(since))
        .filter(|start| *start <= end)
        .map(|start| json!({ "from": start, "to": end }));
    let local = json!({
        "status": status,
        "platform": match std::env::consts::OS {
            "macos" => "macos",
            "linux" => "linux",
            "windows" => "windows",
            _ => "unknown",
        },
        "appVersion": app.package_info().version.to_string(),
        "capturedAt": captured_at,
        "truncated": truncated,
        "coverage": coverage,
        "events": events.into_iter().take(100)
            .map(|(at, reason)| json!({ "at": at, "kind": "relay-closed", "classification": reason })).collect::<Vec<_>>(),
    });
    let proof = scope
        .zip(revision)
        .filter(|_| status == "included")
        .map(|(scope, revision)| {
            URL_SAFE_NO_PAD.encode(
                local_proof(&revision, &scope, &local)
                    .finalize()
                    .into_bytes(),
            )
        });
    json!({ "local": local, "proof": proof })
}

#[tauri::command]
pub async fn support_report_copy(
    state: tauri::State<'_, AppState>,
    revision: Option<String>,
    proof: Option<String>,
    draft: Value,
) -> Result<(), String> {
    let account = state.account.clone();
    tauri::async_runtime::spawn_blocking(move || {
        authorize_local(
            &account,
            revision.as_deref().unwrap_or_default(),
            &draft["local"],
            proof.as_deref(),
        )?;
        let text = serde_json::to_string_pretty(&json!({
            "v": 1, "from": draft["from"], "to": draft["to"],
            "problem": draft["problem"], "desktop": draft["local"]
        }))
        .map_err(|_| "unavailable")?;
        crate::commands::copy_text(text)
    })
    .await
    .map_err(|_| "unavailable".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_proof_refuses_membership_changes_and_edited_events() {
        let scope = CloudScope {
            user_id: "user".into(),
            profile_id: "profile".into(),
            active_org_id: "active".into(),
            multi_org: true,
            members: ["active".to_owned(), "other".to_owned()]
                .into_iter()
                .collect(),
        };
        let local = json!({"events": [{"at": 150, "kind": "relay-closed"}]});
        let tag = URL_SAFE_NO_PAD.encode(
            local_proof("revision", &scope, &local)
                .finalize()
                .into_bytes(),
        );
        assert!(verify_local_proof("revision", &scope, &local, &tag));
        let mut reduced = scope.clone();
        reduced.members.remove("other");
        assert!(!verify_local_proof("revision", &reduced, &local, &tag));
        assert!(!verify_local_proof(
            "revision",
            &scope,
            &json!({"events":[{"at": 999}]}),
            &tag
        ));
    }
}
