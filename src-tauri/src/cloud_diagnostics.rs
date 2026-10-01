//! Cloud diagnostics for organization administrators (PRO-38).
//!
//! Three parts:
//! - the typed `GET /v1/desktop/orgs/:orgId/cloud-diagnostics` answer (the
//!   request itself is [`crate::cloud_workspaces::CloudWorkspaceService::diagnostics`]);
//!   unknown fields are dropped on decode, so a newer server never widens
//!   what the app holds;
//! - a bounded in-memory log of the typed relay close reasons (4100-4104)
//!   the desktop cloud client met, never written to disk, each with the
//!   Organization its connection was made in;
//! - the opt-in export: an allowlist builder that copies chosen fields
//!   (identifiers, codes, counts, timings) and nothing else, then a final
//!   redaction pass over every string. Credentials, tokens, auth and pairing
//!   codes, tickets, repository or workspace names and any terminal or file
//!   content never reach it, because no input carries them and anything
//!   shaped unlike an identifier or a code is replaced. An export is for one
//!   Organization: closes met in another, or with none recorded, and a server
//!   answer for another are left out.

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::cloud_workspaces::CloudWorkspaceClientError;

pub const DEFAULT_WINDOW_DAYS: u8 = 7;
pub const MAX_WINDOW_DAYS: u8 = 30;
/// How many close events the desktop keeps in memory.
pub const CLOSE_LOG_CAPACITY: usize = 50;
const MAX_EXPORT_OPERATIONS: usize = 500;
const MAX_EXPORT_HISTORY: usize = 100;
const MAX_EXPORT_WORKSPACES: usize = 500;
const MAX_EXPORT_STAGES: usize = 32;
const MAX_EXPORT_CLOSE_REASONS: usize = 32;
const REDACTED: &str = "[redacted]";

// ------------------------------------------------------------ server answer

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDiagnostics {
    pub v: u32,
    pub organization_id: String,
    pub generated_at: i64,
    pub window: DiagnosticsWindow,
    #[serde(default)]
    pub retention: Option<DiagnosticsRetention>,
    #[serde(default)]
    pub stage_timings: StageTimings,
    #[serde(default)]
    pub operations: Vec<DiagnosticsOperation>,
    #[serde(default)]
    pub workspaces: Vec<DiagnosticsWorkspace>,
    #[serde(default)]
    pub close_reasons: Vec<CloseReason>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsWindow {
    pub from: i64,
    pub to: i64,
    #[serde(default)]
    pub max_operations: Option<u32>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsRetention {
    #[serde(default)]
    pub operation_history_days: Option<u32>,
    #[serde(default)]
    pub operation_log_days: Option<u32>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageTimings {
    #[serde(default)]
    pub create: Option<OperationTimings>,
    #[serde(default)]
    pub resume: Option<OperationTimings>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationTimings {
    #[serde(default)]
    pub samples: u32,
    #[serde(default)]
    pub total_ms: Percentiles,
    /// Keyed by stage name; ordered so the view and the export are stable.
    #[serde(default)]
    pub stages: BTreeMap<String, StageTiming>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Percentiles {
    #[serde(default)]
    pub p50: Option<f64>,
    #[serde(default)]
    pub p95: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageTiming {
    #[serde(default)]
    pub samples: u32,
    #[serde(default)]
    pub p50: Option<f64>,
    #[serde(default)]
    pub p95: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsOperation {
    pub operation_id: String,
    pub workspace_id: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub state: String,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub retry_action: Option<String>,
    /// Why TerminalX queued the operation itself (`idle`, `provider-stopped`,
    /// `attention-stopped`); none for one a person asked for.
    #[serde(default)]
    pub reason: Option<String>,
    /// For `attention-stopped`: the error code that left the workspace needing attention.
    #[serde(default)]
    pub reason_detail: Option<String>,
    #[serde(default)]
    pub attempt_count: Option<u32>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub restart_decision: Option<RestartDecision>,
    #[serde(default)]
    pub history: Vec<OperationHistoryEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartDecision {
    pub path: String,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub decided_at: Option<i64>,
    #[serde(default)]
    pub fenced_at: Option<i64>,
    #[serde(default)]
    pub replaced_runtime_generation: Option<u64>,
    #[serde(default)]
    pub fence: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationHistoryEntry {
    pub state: String,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub detail_code: Option<String>,
    pub at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsWorkspace {
    pub workspace_id: String,
    #[serde(default)]
    pub provider: Option<String>,
    pub state: String,
    #[serde(default)]
    pub runtime_generation: Option<u64>,
    #[serde(default)]
    pub last_activity_at: Option<i64>,
    #[serde(default)]
    pub activity_reported_at: Option<i64>,
    #[serde(default)]
    pub active_turns: Option<u32>,
    #[serde(default)]
    pub pending_approvals: Option<u32>,
    #[serde(default)]
    pub oom_relaunch_count: Option<u32>,
    #[serde(default)]
    pub connections: ConnectionCounts,
    #[serde(default)]
    pub last_operation_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionCounts {
    #[serde(default)]
    pub ready: u32,
    #[serde(default)]
    pub waiting_for_runtime: u32,
    #[serde(default)]
    pub expired: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseReason {
    pub code: u16,
    pub name: String,
    #[serde(default)]
    pub retry_action: Option<String>,
}

// ------------------------------------------------------- local close log

/// The typed close reasons of terminalx-saas `runtimeCloseReason.ts`.
pub fn close_reason_name(code: u16) -> Option<&'static str> {
    Some(match code {
        4100 => "runtime_unavailable",
        4101 => "stale_generation",
        4102 => "auth_expired",
        4103 => "update_required",
        4104 => "backpressure",
        _ => return None,
    })
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionClose {
    /// The Organization the connection was made in; none for a debug-build
    /// attach by pairing code. Decides who may see the entry and is itself
    /// never sent to the web view or written to an export.
    #[serde(skip)]
    pub organization_id: Option<String>,
    /// None for a debug-build attach by pairing code.
    pub workspace_id: Option<String>,
    pub code: u16,
    pub name: &'static str,
    pub at: i64,
}

/// The last [`CLOSE_LOG_CAPACITY`] typed relay closes, newest last. Memory
/// only: it is gone when the app quits and leaves only in an export. A 4101
/// is either the relay's close or the client's own check of the runtime
/// generation in `rpc.hello`; both mean the attachment was stale.
#[derive(Default)]
pub struct ConnectionCloseLog {
    entries: Mutex<VecDeque<ConnectionClose>>,
}

impl ConnectionCloseLog {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Codes outside 4100-4104 are not recorded.
    pub fn record(&self, organization_id: Option<&str>, workspace_id: Option<&str>, code: u16, at: i64) {
        let Some(name) = close_reason_name(code) else { return };
        let mut entries = self.entries.lock().unwrap();
        while entries.len() >= CLOSE_LOG_CAPACITY {
            entries.pop_front();
        }
        entries.push_back(ConnectionClose { organization_id: organization_id.map(str::to_string), workspace_id: workspace_id.map(str::to_string), code, name, at });
    }

    /// The closes met in `organization_id`, oldest first. There is no way to
    /// read the whole log: an entry of another Organization, or with none
    /// recorded, is never shown or exported.
    pub fn snapshot_for(&self, organization_id: &str) -> Vec<ConnectionClose> {
        self.entries.lock().unwrap().iter().filter(|close| close.organization_id.as_deref() == Some(organization_id)).cloned().collect()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.lock().unwrap().len()
    }
}

// ------------------------------------------------------------------ export

pub struct AppInfo {
    pub version: String,
    pub os: String,
    pub arch: String,
}

/// Everything the export builder may read. There is deliberately no field
/// for account, pairing, relay or session state.
pub struct ExportInputs<'a> {
    pub app: AppInfo,
    pub exported_at: i64,
    pub window_days: u8,
    /// The one Organization the export is for; none when it could not be
    /// determined (signed out), and then no close is exported.
    pub organization_id: Option<&'a str>,
    pub server: Result<&'a CloudDiagnostics, &'a CloudWorkspaceClientError>,
    pub closes: &'a [ConnectionClose],
}

/// What the export leaves out, written into the file so a reader knows.
pub const EXCLUDED: &[&str] = &[
    "api-keys-and-provider-credentials",
    "access-and-refresh-tokens",
    "auth-device-and-pairing-codes",
    "relay-and-attach-tickets",
    "runtime-credentials",
    "repository-names-and-paths",
    "workspace-names",
    "file-contents",
    "terminal-output-transcripts-and-prompts",
];

pub fn build_export(inputs: &ExportInputs<'_>) -> Value {
    let server = match inputs.server {
        // An answer for another Organization is not this export's to hold.
        Ok(diagnostics) if inputs.organization_id != Some(diagnostics.organization_id.as_str()) => json!({
            "available": false,
            "errorCode": "cloud_workspace_invalid_response",
            "status": Value::Null,
        }),
        Ok(diagnostics) => json!({ "available": true, "diagnostics": server_section(diagnostics) }),
        Err(error) => json!({
            "available": false,
            "errorCode": code(&error.code),
            "status": error.status,
        }),
    };
    // Checked again here, whatever the caller passed: only closes recorded
    // in the export's Organization.
    let closes: Vec<Value> = inputs
        .closes
        .iter()
        .rev()
        .filter(|close| inputs.organization_id.is_some() && close.organization_id.as_deref() == inputs.organization_id)
        .take(CLOSE_LOG_CAPACITY)
        .map(|close| {
            json!({
                "workspaceId": close.workspace_id.as_deref().map(id),
                "code": close.code,
                "name": close_reason_name(close.code),
                "at": close.at,
            })
        })
        .collect();
    let export = json!({
        "format": "terminalx-cloud-diagnostics",
        "v": 1,
        "exportedAt": inputs.exported_at,
        "windowDays": inputs.window_days.clamp(1, MAX_WINDOW_DAYS),
        "app": {
            "version": code(&inputs.app.version),
            "os": code(&inputs.app.os),
            "arch": code(&inputs.app.arch),
        },
        "server": server,
        "connections": { "closes": closes },
        "excluded": EXCLUDED,
    });
    redact(export)
}

fn server_section(diagnostics: &CloudDiagnostics) -> Value {
    let operations: Vec<Value> = diagnostics
        .operations
        .iter()
        .take(MAX_EXPORT_OPERATIONS)
        .map(|operation| {
            json!({
                "operationId": id(&operation.operation_id),
                "workspaceId": id(&operation.workspace_id),
                "provider": operation.provider.as_deref().map(code),
                "type": code(&operation.kind),
                "state": code(&operation.state),
                "stage": operation.stage.as_deref().map(code),
                "errorCode": operation.error_code.as_deref().map(code),
                "retryAction": operation.retry_action.as_deref().map(code),
                "reason": operation.reason.as_deref().map(code),
                "reasonDetail": operation.reason_detail.as_deref().map(code),
                "attemptCount": operation.attempt_count,
                "createdAt": operation.created_at,
                "updatedAt": operation.updated_at,
                "durationMs": operation.duration_ms,
                "restartDecision": operation.restart_decision.as_ref().map(|decision| json!({
                    "path": code(&decision.path),
                    "reason": decision.reason.as_deref().map(code),
                    "decidedAt": decision.decided_at,
                    "fencedAt": decision.fenced_at,
                    "replacedRuntimeGeneration": decision.replaced_runtime_generation,
                    "fence": decision.fence.as_deref().map(code),
                })),
                "history": operation.history.iter().take(MAX_EXPORT_HISTORY).map(|entry| json!({
                    "state": code(&entry.state),
                    "stage": entry.stage.as_deref().map(code),
                    "errorCode": entry.error_code.as_deref().map(code),
                    "detailCode": entry.detail_code.as_deref().map(code),
                    "at": entry.at,
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    let workspaces: Vec<Value> = diagnostics
        .workspaces
        .iter()
        .take(MAX_EXPORT_WORKSPACES)
        .map(|workspace| {
            json!({
                "workspaceId": id(&workspace.workspace_id),
                "provider": workspace.provider.as_deref().map(code),
                "state": code(&workspace.state),
                "runtimeGeneration": workspace.runtime_generation,
                "lastActivityAt": workspace.last_activity_at,
                "activityReportedAt": workspace.activity_reported_at,
                "activeTurns": workspace.active_turns,
                "pendingApprovals": workspace.pending_approvals,
                "oomRelaunchCount": workspace.oom_relaunch_count,
                "connections": {
                    "ready": workspace.connections.ready,
                    "waitingForRuntime": workspace.connections.waiting_for_runtime,
                    "expired": workspace.connections.expired,
                },
                "lastOperationId": workspace.last_operation_id.as_deref().map(id),
            })
        })
        .collect();
    let close_reasons: Vec<Value> = diagnostics
        .close_reasons
        .iter()
        .take(MAX_EXPORT_CLOSE_REASONS)
        .map(|reason| {
            json!({
                "code": reason.code,
                "name": code(&reason.name),
                "retryAction": reason.retry_action.as_deref().map(code),
            })
        })
        .collect();
    json!({
        "v": diagnostics.v,
        "generatedAt": diagnostics.generated_at,
        "window": {
            "from": diagnostics.window.from,
            "to": diagnostics.window.to,
            "maxOperations": diagnostics.window.max_operations,
            "truncated": diagnostics.window.truncated,
        },
        "retention": diagnostics.retention.as_ref().map(|retention| json!({
            "operationHistoryDays": retention.operation_history_days,
            "operationLogDays": retention.operation_log_days,
        })),
        "stageTimings": {
            "create": diagnostics.stage_timings.create.as_ref().map(timings),
            "resume": diagnostics.stage_timings.resume.as_ref().map(timings),
        },
        "operations": operations,
        "workspaces": workspaces,
        "closeReasons": close_reasons,
    })
}

fn timings(timings: &OperationTimings) -> Value {
    // A stage name that is not a code is dropped, not renamed: keys cannot
    // be redacted without colliding.
    let stages: Map<String, Value> = timings
        .stages
        .iter()
        .filter(|(name, _)| is_code(name))
        .take(MAX_EXPORT_STAGES)
        .map(|(name, stage)| (name.clone(), json!({ "samples": stage.samples, "p50": stage.p50, "p95": stage.p95 })))
        .collect();
    json!({
        "samples": timings.samples,
        "totalMs": { "p50": timings.total_ms.p50, "p95": timings.total_ms.p95 },
        "stages": stages,
    })
}

/// A machine code or a version: lowercase words and digits joined by `-`,
/// `_` or `.`.
fn is_code(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=64).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.'))
        && !looks_secret(value)
}

/// A server identifier (`cw_<uuid>`, `op_<uuid>`): lowercase, no dots.
fn is_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=128).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_'))
        && !looks_secret(value)
}

fn code(value: &str) -> String {
    if is_code(value) { value.to_string() } else { REDACTED.to_string() }
}

fn id(value: &str) -> String {
    if is_id(value) { value.to_string() } else { REDACTED.to_string() }
}

/// The longest run of letters and digits an identifier or code may have
/// between separators: a UUID group is 12, a code word rarely passes 16.
/// Longer runs are what random tokens, hashes and keys look like.
const MAX_RUN: usize = 20;

fn has_token_run(value: &str) -> bool {
    value.split(|c: char| !c.is_ascii_alphanumeric()).any(|run| run.len() > MAX_RUN)
}

/// Well-known credential prefixes that fit the lowercase code alphabet
/// (anything with an uppercase letter is refused by the alphabet already).
fn looks_secret(value: &str) -> bool {
    const PREFIXES: &[&str] = &["sk-", "sk_", "pk_", "rk_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "xox", "eyj", "lin_api_"];
    PREFIXES.iter().any(|prefix| value.starts_with(prefix)) || has_token_run(value)
}

/// The final pass: every string in the export is an identifier, a code, a
/// fixed label from this module, or `[redacted]`.
fn redact(value: Value) -> Value {
    match value {
        Value::String(text) if is_code(&text) || is_id(&text) || text == REDACTED || EXCLUDED.contains(&text.as_str()) => Value::String(text),
        Value::String(_) => Value::String(REDACTED.into()),
        Value::Array(items) => Value::Array(items.into_iter().map(redact).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(key, value)| (key, redact(value))).collect()),
        other => other,
    }
}

// ---------------------------------------------------------------- commands

pub mod commands {
    use std::path::PathBuf;

    use super::*;
    use crate::cloud_remote::CloudRemote;
    use crate::cloud_workspaces::RequestRisk;

    fn window(window_days: Option<u8>) -> u8 {
        window_days.unwrap_or(DEFAULT_WINDOW_DAYS).clamp(1, MAX_WINDOW_DAYS)
    }

    async fn fetch(state: &tauri::State<'_, crate::AppState>, org_id: Option<String>, window_days: u8) -> Result<CloudDiagnostics, CloudWorkspaceClientError> {
        let service = state.cloud_workspaces.clone();
        tauri::async_runtime::spawn_blocking(move || service.diagnostics(org_id.as_deref(), window_days))
            .await
            .map_err(|_| CloudWorkspaceClientError::task_failed(RequestRisk::Read))?
    }

    /// The Organization `org_id` names (the active one when none), if the
    /// account is a member of it. Off the async runtime: it may load the account.
    async fn organization(state: &tauri::State<'_, crate::AppState>, org_id: Option<String>) -> Option<String> {
        let service = state.cloud_workspaces.clone();
        tauri::async_runtime::spawn_blocking(move || service.organization_in(org_id.as_deref()).ok()).await.ok().flatten()
    }

    /// Owners and administrators of `org_id` (the active Organization when
    /// none) only; the server decides by the role in that Organization.
    #[tauri::command]
    pub async fn cloud_diagnostics(
        window_days: Option<u8>,
        state: tauri::State<'_, crate::AppState>,
        org_id: Option<String>,
    ) -> Result<CloudDiagnostics, CloudWorkspaceClientError> {
        fetch(&state, org_id, window(window_days)).await
    }

    /// The closes this Mac met in `org_id` (the active Organization when
    /// none). No network; signed out, or for an Organization the account is
    /// not a member of, there is nothing to show.
    #[tauri::command]
    pub async fn cloud_connection_diagnostics(
        state: tauri::State<'_, crate::AppState>,
        remote: tauri::State<'_, Arc<CloudRemote>>,
        org_id: Option<String>,
    ) -> Result<Vec<ConnectionClose>, String> {
        Ok(match organization(&state, org_id).await {
            Some(organization_id) => remote.close_log().snapshot_for(&organization_id),
            None => Vec::new(),
        })
    }

    /// Write the export to `path`, which the user chose in a save dialog.
    /// For a member, the file holds this Mac's closes in that Organization
    /// and the server's refusal code; signed out, only the refusal code.
    /// Everything in it is of the one Organization the export is for.
    /// Nothing is sent anywhere but the diagnostics request itself.
    #[tauri::command]
    pub async fn cloud_diagnostics_export(
        path: String,
        window_days: Option<u8>,
        app: tauri::AppHandle,
        state: tauri::State<'_, crate::AppState>,
        remote: tauri::State<'_, Arc<CloudRemote>>,
        org_id: Option<String>,
    ) -> Result<(), String> {
        let mut target = PathBuf::from(&path);
        if !target.is_absolute() {
            return Err("cloud_diagnostics_export_path_invalid".into());
        }
        // A dialog without an extension filter may hand back a bare name.
        if !target.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("json")) {
            target.as_mut_os_string().push(".json");
        }
        let window_days = window(window_days);
        let organization_id = organization(&state, org_id.clone()).await;
        // Signed out, the service answers `account_signed_out` without a request.
        let server = fetch(&state, org_id, window_days).await;
        let closes = organization_id.as_deref().map(|organization_id| remote.close_log().snapshot_for(organization_id)).unwrap_or_default();
        let export = build_export(&ExportInputs {
            app: AppInfo {
                version: app.package_info().version.to_string(),
                os: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
            },
            exported_at: chrono::Utc::now().timestamp_millis(),
            window_days,
            organization_id: organization_id.as_deref(),
            server: server.as_ref(),
            closes: &closes,
        });
        let text = serde_json::to_string_pretty(&export).map_err(|_| "cloud_diagnostics_export_failed".to_string())?;
        tauri::async_runtime::spawn_blocking(move || std::fs::write(target, text))
            .await
            .ok()
            .and_then(Result::ok)
            .ok_or_else(|| "cloud_diagnostics_export_write_failed".to_string())
    }
}


#[cfg(test)]
mod tests {
    use super::*;

    fn app() -> AppInfo {
        AppInfo { version: "0.2.2".into(), os: "macos".into(), arch: "aarch64".into() }
    }

    fn fixture() -> Value {
        json!({
            "v": 1,
            "organizationId": "org_1",
            "generatedAt": 1_790_000_000_000_i64,
            "window": { "from": 1_789_400_000_000_i64, "to": 1_790_000_000_000_i64, "maxOperations": 200, "truncated": false },
            "retention": { "operationHistoryDays": 90, "operationLogDays": 14 },
            "stageTimings": {
                "create": { "samples": 12, "totalMs": { "p50": 41000, "p95": 88000 },
                    "stages": { "preflight": { "samples": 12, "p50": 300, "p95": 900 }, "creating-machine": { "samples": 12, "p50": 20000, "p95": 50000 } } },
                "resume": { "samples": 0, "totalMs": { "p50": null, "p95": null }, "stages": {} }
            },
            "operations": [{
                "operationId": "op_7d2c9a4e-1b1f-4c55-9e0a-3f1c2b3a4d5e", "workspaceId": "cw_1", "provider": "local-docker",
                "type": "resume", "state": "failed", "stage": "connecting-relay",
                "errorCode": "cloud_provider_credential_invalid", "retryAction": "fix-provider-credentials",
                "reason": "attention-stopped", "reasonDetail": "cloud_provider_credential_invalid",
                "attemptCount": 2, "createdAt": 1, "updatedAt": 2, "durationMs": 1,
                "restartDecision": { "path": "fenced-restart", "reason": "warm-grace-expired", "decidedAt": 2, "fencedAt": 2, "replacedRuntimeGeneration": 3, "fence": "rotate" },
                "history": [{ "state": "running", "stage": "preflight", "errorCode": null, "detailCode": null, "at": 1 }]
            }],
            "workspaces": [{ "workspaceId": "cw_1", "provider": "local-docker", "state": "ready", "runtimeGeneration": 4,
                "lastActivityAt": 5, "activityReportedAt": 5, "activeTurns": 1, "pendingApprovals": 0, "oomRelaunchCount": 3, "connections": { "ready": 1, "waitingForRuntime": 0, "expired": 2 }, "lastOperationId": "op_7d2c9a4e-1b1f-4c55-9e0a-3f1c2b3a4d5e" }],
            "closeReasons": [{ "code": 4100, "name": "runtime_unavailable", "retryAction": "recheck-readiness" }]
        })
    }

    #[test]
    fn decodes_the_contract_and_ignores_unknown_fields() {
        let mut value = fixture();
        value["futureField"] = json!({ "anything": true });
        value["operations"][0]["futureField"] = json!(1);
        let decoded: CloudDiagnostics = serde_json::from_value(value).unwrap();
        assert_eq!(decoded.operations[0].kind, "resume");
        assert_eq!(decoded.stage_timings.create.as_ref().unwrap().total_ms.p95, Some(88000.0));
        assert_eq!(decoded.stage_timings.resume.as_ref().unwrap().total_ms.p50, None);
        assert_eq!(decoded.workspaces[0].connections.expired, 2);
        assert_eq!(decoded.operations[0].restart_decision.as_ref().unwrap().path, "fenced-restart");
    }

    #[test]
    fn close_log_keeps_only_typed_reasons_and_is_bounded() {
        let log = ConnectionCloseLog::default();
        log.record(Some("org_1"), Some("cw_1"), 1006, 1);
        log.record(Some("org_1"), Some("cw_1"), 4401, 1);
        assert_eq!(log.len(), 0);
        for index in 0..(CLOSE_LOG_CAPACITY as i64 + 7) {
            log.record(Some("org_1"), Some("cw_1"), 4100 + (index % 5) as u16, index);
        }
        let entries = log.snapshot_for("org_1");
        assert_eq!(entries.len(), CLOSE_LOG_CAPACITY);
        assert_eq!(entries.first().unwrap().at, 7);
        assert_eq!(entries.last().unwrap().at, CLOSE_LOG_CAPACITY as i64 + 6);
        assert_eq!(close_reason_name(4103), Some("update_required"));
    }

    #[test]
    fn export_keeps_the_diagnostic_fields() {
        let diagnostics: CloudDiagnostics = serde_json::from_value(fixture()).unwrap();
        let closes = [ConnectionClose { organization_id: Some("org_1".into()), workspace_id: Some("cw_1".into()), code: 4101, name: "stale_generation", at: 9 }];
        let export = build_export(&ExportInputs { app: app(), exported_at: 10, window_days: 7, organization_id: Some("org_1"), server: Ok(&diagnostics), closes: &closes });
        let server = &export["server"]["diagnostics"];
        assert_eq!(export["app"]["version"], "0.2.2");
        assert_eq!(server["operations"][0]["operationId"], "op_7d2c9a4e-1b1f-4c55-9e0a-3f1c2b3a4d5e");
        assert_eq!(server["operations"][0]["errorCode"], "cloud_provider_credential_invalid");
        assert_eq!(server["operations"][0]["restartDecision"]["reason"], "warm-grace-expired");
        assert_eq!(server["operations"][0]["reason"], "attention-stopped");
        assert_eq!(server["operations"][0]["reasonDetail"], "cloud_provider_credential_invalid");
        assert_eq!(server["stageTimings"]["create"]["stages"]["creating-machine"]["p95"], 50000.0);
        assert_eq!(server["workspaces"][0]["connections"]["expired"], 2);
        assert_eq!(server["workspaces"][0]["oomRelaunchCount"], 3);
        assert_eq!(server["operations"][0]["restartDecision"]["decidedAt"], 2);
        assert_eq!(export["connections"]["closes"][0]["name"], "stale_generation");
        assert!(server.get("organizationId").is_none());
    }

    #[test]
    fn a_refused_server_request_exports_only_its_code() {
        let error = CloudWorkspaceClientError::local("organization_admin_required", false);
        let export = build_export(&ExportInputs { app: app(), exported_at: 1, window_days: 99, organization_id: Some("org_1"), server: Err(&error), closes: &[] });
        assert_eq!(export["server"], json!({ "available": false, "errorCode": "organization_admin_required", "status": null }));
        assert_eq!(export["windowDays"], 30);
    }

    #[test]
    fn lowercase_credentials_in_code_fields_are_redacted() {
        let mut value = fixture();
        value["operations"][0]["errorCode"] = json!("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
        value["operations"][0]["history"][0]["detailCode"] = json!("sk-live-abc");
        value["operations"][0]["workspaceId"] = json!("eyjhbgcioijiuzi1nij9");
        // Lowercase token shapes with no known prefix: hex, base32, a hash.
        value["operations"][0]["retryAction"] = json!("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
        value["operations"][0]["operationId"] = json!("op_mfrggzdfmztwq2lknnwg23tpobyxe43u");
        value["workspaces"][0]["state"] = json!("canary-refresh-token-4e9f8a7b6c5d4e3f2a1b0c9d");
        let diagnostics: CloudDiagnostics = serde_json::from_value(value).unwrap();
        let export = build_export(&ExportInputs { app: app(), exported_at: 1, window_days: 7, organization_id: Some("org_1"), server: Ok(&diagnostics), closes: &[] });
        let operation = &export["server"]["diagnostics"]["operations"][0];
        assert_eq!(operation["errorCode"], REDACTED);
        assert_eq!(operation["history"][0]["detailCode"], REDACTED);
        assert_eq!(operation["workspaceId"], REDACTED);
        assert_eq!(operation["retryAction"], REDACTED);
        assert_eq!(operation["operationId"], REDACTED);
        assert_eq!(export["server"]["diagnostics"]["workspaces"][0]["state"], REDACTED);
        // Real identifiers and codes still pass.
        assert_eq!(operation["type"], "resume");
        assert_eq!(export["server"]["diagnostics"]["workspaces"][0]["workspaceId"], "cw_1");
        assert!(is_id("op_7d2c9a4e-1b1f-4c55-9e0a-3f1c2b3a4d5e"));
        assert!(is_code("cloud_workspace_credential_verification_unavailable"));
    }

    /// An export is for one Organization. Closes this Mac met in another, or
    /// with none recorded, and a server answer for another never reach it:
    /// neither their ids nor anything else of theirs.
    #[test]
    fn an_export_holds_nothing_of_another_organization() {
        const FOREIGN: &[&str] = &["org_b", "cw_b_1", "cw_b_2", "op_b_1", "beta-corp", "beta-secret-project", "cw_dev_1"];
        let log = ConnectionCloseLog::default();
        log.record(Some("org_a"), Some("cw_a_1"), 4101, 1);
        log.record(Some("org_b"), Some("cw_b_1"), 4102, 2);
        log.record(Some("org_b"), Some("beta-secret-project"), 4100, 3);
        log.record(Some("beta-corp"), Some("cw_b_2"), 4104, 4);
        // A dev attach: no Organization recorded, so it belongs to no export.
        log.record(None, Some("cw_dev_1"), 4101, 5);
        log.record(None, None, 4103, 6);
        log.record(Some("org_a"), Some("cw_a_2"), 4104, 7);

        // The log hands out one Organization's entries only.
        let own: Vec<_> = log.snapshot_for("org_a").into_iter().map(|close| close.workspace_id.unwrap()).collect();
        assert_eq!(own, ["cw_a_1", "cw_a_2"]);
        assert!(log.snapshot_for("org_c").is_empty());
        assert!(log.snapshot_for("").is_empty());
        // The Organization is never sent to the web view with an entry.
        assert!(serde_json::to_value(log.snapshot_for("org_b")).unwrap().to_string().find("org_b").is_none());

        // The builder checks again: handed every entry, it keeps org A's.
        let everything: Vec<ConnectionClose> = log.entries.lock().unwrap().iter().cloned().collect();
        assert_eq!(everything.len(), 7);
        let mut answer = fixture();
        answer["organizationId"] = json!("org_a");
        answer["operations"][0]["workspaceId"] = json!("cw_a_1");
        answer["workspaces"][0]["workspaceId"] = json!("cw_a_1");
        let own_answer: CloudDiagnostics = serde_json::from_value(answer).unwrap();
        let export = build_export(&ExportInputs { app: app(), exported_at: 1, window_days: 7, organization_id: Some("org_a"), server: Ok(&own_answer), closes: &everything });
        let text = serde_json::to_string(&export).unwrap();
        assert_eq!(export["server"]["available"], true);
        let closes: Vec<&str> = export["connections"]["closes"].as_array().unwrap().iter().map(|close| close["workspaceId"].as_str().unwrap()).collect();
        assert_eq!(closes, ["cw_a_2", "cw_a_1"]);
        for foreign in FOREIGN {
            assert!(!text.contains(foreign), "{foreign} of another organization leaked: {text}");
        }
        // Nor the export's own organization id: it is not a field of the file.
        assert!(!text.contains("org_a"));

        // A server answer for organization B, in an export for A, is refused whole.
        let mut answer = fixture();
        answer["organizationId"] = json!("org_b");
        answer["operations"][0]["operationId"] = json!("op_b_1");
        answer["operations"][0]["workspaceId"] = json!("cw_b_1");
        answer["workspaces"][0]["workspaceId"] = json!("cw_b_2");
        answer["workspaces"][0]["lastOperationId"] = json!("op_b_1");
        let foreign_answer: CloudDiagnostics = serde_json::from_value(answer).unwrap();
        let export = build_export(&ExportInputs { app: app(), exported_at: 1, window_days: 7, organization_id: Some("org_a"), server: Ok(&foreign_answer), closes: &everything });
        assert_eq!(export["server"], json!({ "available": false, "errorCode": "cloud_workspace_invalid_response", "status": null }));
        let text = serde_json::to_string(&export).unwrap();
        for foreign in FOREIGN {
            assert!(!text.contains(foreign), "{foreign} of another organization leaked: {text}");
        }

        // No Organization determined (signed out): no close and no answer at all.
        let export = build_export(&ExportInputs { app: app(), exported_at: 1, window_days: 7, organization_id: None, server: Ok(&own_answer), closes: &everything });
        assert_eq!(export["server"]["available"], false);
        assert!(export["connections"]["closes"].as_array().unwrap().is_empty());
    }

    /// Secret-shaped values, the lowercase ones included (they fit the code
    /// alphabet), are written into every string the builder can read: each
    /// string of the server answer, a stage name, the refusal code, the app
    /// details and the close log. None may reach the export, whole or in part.
    #[test]
    fn secret_shaped_values_in_every_exported_field_are_redacted() {
        const SECRETS: &[(&str, &str)] = &[
            ("github token", "ghp_0123456789abcdefghijklmnopqrstuvwxyz"),
            ("lowercase github token", "ghs_abcdefabcdef"),
            ("github fine-grained token", "github_pat_11abcdefg0123456789"),
            ("gitlab token", "glpat-abcdef012345"),
            ("api key", "sk-ant-api03-AbCdEf0123456789-xyz"),
            ("short lowercase api key", "sk-live-abc"),
            ("stripe keys", "sk_live_0123456789abcdef"),
            ("restricted key", "rk_live_abc"),
            ("publishable key", "pk_live_abc"),
            ("slack token", "xoxb-1234-abcd"),
            ("linear key", "lin_api_abcdef"),
            ("jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"),
            ("lowercased jwt", "eyjhbgcioijiuzi1nij9.eyjzdwiioiixin0"),
            ("bearer header", "Bearer 0123456789abcdef"),
            ("environment assignment", "DATABASE_URL=postgres://user:hunter2@db.internal/app"),
            ("lowercase environment value", "token=abc"),
            ("clone url with credentials", "https://x-access-token:ghs_abc@github.com/acme/private-api.git"),
            ("plain clone url", "https://github.com/acme/private-api.git"),
            ("ssh clone url", "git@github.com:acme/private-api.git"),
            ("email", "someone@acme.example"),
            ("sha-256", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"),
            ("lowercase base32 token", "op_mfrggzdfmztwq2lknnwg23tpobyxe43u"),
            ("attach ticket", "dGhpcy1pcy1hbi1hdHRhY2gtdGlja2V0LXZhbHVlLTAx_-x"),
            ("relay token", "relay_4e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b"),
            ("encrypted payload", "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0NTY3ODk="),
            ("private key", "-----BEGIN PRIVATE KEY-----"),
            ("local path", "/Users/someone/code/secret-repo"),
            ("repository name", "acme/private-api"),
            ("sentence", "provider said invalid token for account"),
            ("newline", "ready\nsecret-value"),
        ];
        // Strings the export is allowed to hold besides `[redacted]`.
        let allowed = |text: &str| {
            text == REDACTED
                || text == "terminalx-cloud-diagnostics"
                || EXCLUDED.contains(&text)
                || (4100..=4104).any(|code| close_reason_name(code) == Some(text))
        };
        fn poison(value: &mut Value, secret: &str, replaced: &mut usize) {
            match value {
                Value::String(text) => {
                    *text = secret.to_string();
                    *replaced += 1;
                }
                Value::Array(items) => items.iter_mut().for_each(|item| poison(item, secret, replaced)),
                Value::Object(map) => map.values_mut().for_each(|item| poison(item, secret, replaced)),
                _ => {}
            }
        }
        fn strings(value: &Value, out: &mut Vec<String>) {
            match value {
                Value::String(text) => out.push(text.clone()),
                Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
                Value::Object(map) => map.values().for_each(|item| strings(item, out)),
                _ => {}
            }
        }
        fn keys(value: &Value, out: &mut Vec<String>) {
            match value {
                Value::Array(items) => items.iter().for_each(|item| keys(item, out)),
                Value::Object(map) => map.iter().for_each(|(key, item)| {
                    out.push(key.clone());
                    keys(item, out);
                }),
                _ => {}
            }
        }
        let clean_keys = {
            let diagnostics: CloudDiagnostics = serde_json::from_value(fixture()).unwrap();
            let refusal = CloudWorkspaceClientError::local("organization_admin_required", false);
            let mut out = Vec::new();
            keys(&build_export(&ExportInputs { app: app(), exported_at: 1, window_days: 7, organization_id: Some("org_1"), server: Ok(&diagnostics), closes: &[] }), &mut out);
            keys(&build_export(&ExportInputs { app: app(), exported_at: 1, window_days: 7, organization_id: Some("org_1"), server: Err(&refusal), closes: &[] }), &mut out);
            out
        };

        for (name, secret) in SECRETS {
            let mut value = fixture();
            // The two optional codes the fixture leaves empty.
            value["operations"][0]["history"][0]["errorCode"] = json!("set");
            value["operations"][0]["history"][0]["detailCode"] = json!("set");
            let mut replaced = 0;
            poison(&mut value, secret, &mut replaced);
            // Every string the answer type holds: 1 organization id, 10 on the
            // operation, 3 on its restart decision, 4 on its history entry,
            // 4 on the workspace and 2 on the close reason.
            assert_eq!(replaced, 24, "{name}: the fixture no longer covers every string field");
            value["stageTimings"]["create"]["stages"][*secret] = json!({ "samples": 1, "p50": 1, "p95": 1 });
            value["stageTimings"]["resume"]["stages"][*secret] = json!({ "samples": 1, "p50": 1, "p95": 1 });
            let diagnostics: CloudDiagnostics = serde_json::from_value(value).unwrap();
            let closes = [
                ConnectionClose { organization_id: Some(secret.to_string()), workspace_id: Some(secret.to_string()), code: 4101, name: "stale_generation", at: 1 },
                ConnectionClose { organization_id: Some(secret.to_string()), workspace_id: None, code: 4104, name: "backpressure", at: 2 },
            ];
            let hostile_app = || AppInfo { version: secret.to_string(), os: secret.to_string(), arch: secret.to_string() };
            let mut refusal = CloudWorkspaceClientError::local("organization_admin_required", false);
            refusal.code = secret.to_string();

            for export in [
                // For the organization the poisoned answer names, so nothing is dropped as foreign.
                build_export(&ExportInputs { app: hostile_app(), exported_at: 1, window_days: 7, organization_id: Some(secret), server: Ok(&diagnostics), closes: &closes }),
                build_export(&ExportInputs { app: hostile_app(), exported_at: 1, window_days: 7, organization_id: Some(secret), server: Err(&refusal), closes: &closes }),
            ] {
                assert_eq!(export["connections"]["closes"].as_array().unwrap().len(), 2, "{name}: the closes were exercised");
                let text = serde_json::to_string_pretty(&export).unwrap();
                assert!(!text.contains(secret), "{name} leaked: {text}");
                // Not a piece of it either: every string left is `[redacted]`
                // or one of this module's fixed labels, and every key is one a
                // clean export has.
                let mut found = Vec::new();
                strings(&export, &mut found);
                for text in &found {
                    assert!(allowed(text), "{name}: unexpected string {text:?} in the export");
                }
                let mut exported_keys = Vec::new();
                keys(&export, &mut exported_keys);
                for key in &exported_keys {
                    assert!(clean_keys.contains(key), "{name}: unexpected key {key:?} in the export");
                }
            }
        }
    }

    /// The canary test: every secret or content category is seeded into every
    /// input the builder can see, as known fields and as unexpected extra
    /// fields, and none may appear in the serialized export.
    #[test]
    fn default_export_contains_no_canary() {
        const CANARIES: &[&str] = &[
            "CANARY-API-KEY-7f3a",
            "CANARY-AUTH-CODE-19bd",
            "CANARY-DEVICE-CODE-5c21",
            "CANARY-PAIRING-CODE-a0e4",
            "CANARY-TICKET-2b8c",
            "CANARY-ACCESS-TOKEN-61d0",
            "CANARY-REFRESH-TOKEN-4e9f",
            "CANARY-RUNTIME-CREDENTIAL-8d17",
            "CANARY-TERMINAL-OUTPUT-c3a2",
            "CANARY-FILE-CONTENT-77b5",
            "CANARY-PROMPT-0f6e",
            "CANARY-REPO-NAME-9a41",
            "CANARY-REPO-PATH-/Users/someone/code/secret-repo",
            "CANARY-WORKSPACE-NAME-e5d3",
        ];
        let secrets = || -> Value { CANARIES.iter().map(|canary| (canary.to_string(), json!(canary))).collect::<Map<_, _>>().into() };
        let canary = |index: usize| CANARIES[index % CANARIES.len()];

        let mut value = fixture();
        // Extra fields at every level of the payload.
        value["workspaceName"] = json!(canary(13));
        value["repository"] = json!(canary(11));
        value["credentials"] = secrets();
        value["window"]["ticket"] = json!(canary(4));
        value["stageTimings"]["create"]["logs"] = json!(canary(8));
        value["stageTimings"]["create"]["stages"]["preflight"]["output"] = json!(canary(9));
        value["stageTimings"]["create"]["stages"][canary(2)] = json!({ "samples": 1, "p50": 1, "p95": 1 });
        value["operations"][0]["prompt"] = json!(canary(10));
        value["operations"][0]["attachTicket"] = json!(canary(4));
        value["operations"][0]["restartDecision"]["runtimeCredential"] = json!(canary(7));
        value["operations"][0]["history"][0]["log"] = json!(canary(8));
        value["workspaces"][0]["name"] = json!(canary(13));
        value["workspaces"][0]["repositories"] = json!([canary(11), canary(12)]);
        value["workspaces"][0]["connections"]["resumeCredential"] = json!(canary(7));
        value["closeReasons"][0]["ticket"] = json!(canary(4));
        // And in every string the payload does carry.
        value["organizationId"] = json!(canary(0));
        value["operations"][0]["operationId"] = json!(canary(1));
        value["operations"][0]["workspaceId"] = json!(canary(13));
        value["operations"][0]["provider"] = json!(canary(0));
        value["operations"][0]["type"] = json!(canary(2));
        value["operations"][0]["state"] = json!(canary(3));
        value["operations"][0]["stage"] = json!(canary(4));
        value["operations"][0]["errorCode"] = json!(canary(5));
        value["operations"][0]["retryAction"] = json!(canary(6));
        value["operations"][0]["reason"] = json!(canary(7));
        value["operations"][0]["reasonDetail"] = json!(canary(8));
        value["operations"][0]["restartDecision"]["path"] = json!(canary(7));
        value["operations"][0]["restartDecision"]["reason"] = json!(canary(8));
        value["operations"][0]["restartDecision"]["fence"] = json!(canary(9));
        value["operations"][0]["history"][0]["state"] = json!(canary(10));
        value["operations"][0]["history"][0]["stage"] = json!(canary(11));
        value["operations"][0]["history"][0]["errorCode"] = json!(canary(12));
        value["operations"][0]["history"][0]["detailCode"] = json!(canary(13));
        value["workspaces"][0]["workspaceId"] = json!(canary(13));
        value["workspaces"][0]["provider"] = json!(canary(0));
        value["workspaces"][0]["state"] = json!(canary(9));
        value["workspaces"][0]["lastOperationId"] = json!(canary(1));
        value["closeReasons"][0]["name"] = json!(canary(4));
        value["closeReasons"][0]["retryAction"] = json!(canary(5));
        let diagnostics: CloudDiagnostics = serde_json::from_value(value).unwrap();

        let closes: Vec<ConnectionClose> = CANARIES
            .iter()
            .enumerate()
            .map(|(index, canary)| ConnectionClose { organization_id: Some(CANARIES[0].to_string()), workspace_id: Some(canary.to_string()), code: 4100 + (index % 5) as u16, name: "runtime_unavailable", at: index as i64 })
            .collect();
        let hostile_app = AppInfo { version: canary(0).into(), os: canary(3).into(), arch: canary(4).into() };
        // The export is for the organization the hostile answer names, so its
        // fields and the closes are all exercised, not dropped as foreign.
        let export = build_export(&ExportInputs { app: hostile_app, exported_at: 1, window_days: 7, organization_id: Some(CANARIES[0]), server: Ok(&diagnostics), closes: &closes });
        assert_eq!(export["server"]["available"], true);
        assert_eq!(export["connections"]["closes"].as_array().unwrap().len(), CANARIES.len());
        let text = serde_json::to_string(&export).unwrap();
        assert!(!text.contains("CANARY"), "a canary leaked: {text}");
        assert!(!text.to_ascii_lowercase().contains("canary"), "a canary leaked: {text}");

        // A refusal whose code was tampered with is redacted the same way.
        let mut error = CloudWorkspaceClientError::local("organization_admin_required", false);
        error.code = canary(6).into();
        let export = build_export(&ExportInputs { app: app(), exported_at: 1, window_days: 7, organization_id: Some(CANARIES[0]), server: Err(&error), closes: &closes });
        assert!(!serde_json::to_string(&export).unwrap().contains("CANARY"));
    }
}
