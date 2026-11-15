//! Machines (PRO-342, docs/MACHINES.md "As built (PRO-342)"): the window's
//! commands on both sides of a pairing by code.
//!
//! - On the machine, the runtime pairs (`crate::machine_host`); these
//!   commands ask it over the window's runtime IPC (`machine_wire`) and
//!   re-emit its `machine_host_changed` as [`HOST_CHANGED_EVENT`].
//! - On the operating computer, this module decodes a code, shows the
//!   fingerprint, pairs ([`pair`]) and keeps the machine ([`store`], with the
//!   device token in the Keychain, [`secrets`]), then connects to it
//!   ([`connect`], PRO-345).
//!
//! The shapes are `src/types/machines.ts`.

pub mod connect;
pub mod pair;
pub mod secrets;
pub mod store;

use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tokio::sync::watch;

use crate::machine_wire::{self as wire, MachineCode, MachineIdentity, Status};
use crate::sink::EventSink;
use self::secrets::MachineSecrets;
use self::store::{MachineRoute, MachineStore, PairedMachine};

/// Emitted with a [`MachineHostView`] whenever the runtime's status or the
/// two switches it shows change.
pub const HOST_CHANGED_EVENT: &str = "machines_host_changed";

/// `MachineHostView` in src/types/machines.ts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineHostView {
    /// `machines.allowOperating`.
    pub allow_operating: bool,
    /// `pairing.keepAwake`, shared with phones.
    pub keep_awake: bool,
    /// `None` while the runtime cannot be reached.
    pub status: Option<Status>,
}

/// `InspectedMachineCode`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedMachineCode {
    pub machine: MachineIdentity,
    pub fingerprint: String,
    pub expires_at: i64,
    pub direct_endpoints: Vec<String>,
    pub has_relay: bool,
    pub already_paired: bool,
}

/// `MachinePairResult`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum MachinePairResult {
    Paired { paired: bool, machine: PairedMachine },
    NotPaired { paired: bool, reason: &'static str, message: String },
}

impl MachinePairResult {
    fn failed(failure: pair::Failure) -> Self {
        Self::NotPaired { paired: false, reason: failure.reason, message: failure.message }
    }
}

pub struct Machines {
    secrets: MachineSecrets,
    /// `None`: `~/.raccoon`. Tests name a temp directory.
    store_dir: Option<std::path::PathBuf>,
    /// The pairing under way; true cancels it.
    pairing: Mutex<Option<watch::Sender<bool>>>,
    /// The runtime's last status, so a settings change re-emits it.
    last_status: Mutex<Option<Status>>,
    approval_wait: std::time::Duration,
}

impl Default for Machines {
    fn default() -> Self {
        Self::new(MachineSecrets::default(), None)
    }
}

impl Machines {
    fn new(secrets: MachineSecrets, store_dir: Option<std::path::PathBuf>) -> Self {
        Self { secrets, store_dir, pairing: Mutex::new(None), last_status: Mutex::new(None), approval_wait: pair::APPROVAL_WAIT }
    }

    #[cfg(test)]
    pub(crate) fn for_test(secrets: MachineSecrets, store_dir: std::path::PathBuf, approval_wait: std::time::Duration) -> Self {
        Self { approval_wait, ..Self::new(secrets, Some(store_dir)) }
    }

    #[cfg(test)]
    pub(crate) fn client_secret_for_test(&self) -> zeroize::Zeroizing<[u8; 32]> {
        self.secrets.client_secret().unwrap()
    }

    /// Name the Keychain service, and re-emit the runtime's status as a view.
    pub fn configure(self: &Arc<Self>, sink: Arc<dyn EventSink>, app_identifier: &str) -> Result<()> {
        self.secrets.configure(app_identifier)?;
        let (machines, events) = (Arc::downgrade(self), sink.clone());
        sink.listen(
            wire::CHANGED_EVENT,
            Box::new(move |payload| {
                let Some(machines) = machines.upgrade() else { return };
                let Ok(status) = serde_json::from_str::<Status>(payload) else { return };
                *machines.last_status.lock().unwrap() = Some(status.clone());
                events.emit(HOST_CHANGED_EVENT, &view(Some(status)));
            }),
        );
        let (machines, events) = (Arc::downgrade(self), sink.clone());
        sink.listen(
            "settings_file_changed",
            Box::new(move |_| {
                let Some(machines) = machines.upgrade() else { return };
                let status = machines.last_status.lock().unwrap().clone();
                events.emit(HOST_CHANGED_EVENT, &view(status));
            }),
        );
        Ok(())
    }

    fn store(&self) -> Result<MachineStore> {
        match &self.store_dir {
            Some(dir) => Ok(MachineStore::in_dir(dir)),
            None => MachineStore::default_location(),
        }
    }

    /// What the dialog shows before it connects. Blocking: reads the Keychain.
    pub fn inspect(&self, code: &str) -> Result<InspectedMachineCode> {
        let code = MachineCode::decode(code).map_err(|error| anyhow!("invalid-code: {error:#}"))?;
        let secret = self.secrets.client_secret()?;
        Ok(InspectedMachineCode {
            fingerprint: fingerprint(&code, &secret)?,
            already_paired: self.store()?.get(&code.machine.machine_id)?.is_some(),
            has_relay: code.relay.is_some(),
            expires_at: code.expires_at,
            direct_endpoints: code.direct_endpoints.clone(),
            machine: code.machine,
        })
    }

    /// Pair with the machine of `code`, then keep it.
    pub async fn pair(self: Arc<Self>, code: String, route: MachineRoute) -> Result<MachinePairResult> {
        let code = match MachineCode::decode(&code) {
            Ok(code) => code,
            Err(error) => return Ok(MachinePairResult::failed(pair::Failure { reason: "invalid-code", message: format!("This is not a machine pairing code ({error:#}).") })),
        };
        let (cancel, cancelled) = watch::channel(false);
        // A newer attempt replaces this one, which ends as cancelled.
        *self.pairing.lock().unwrap() = Some(cancel);
        let secrets = self.clone();
        let secret = tauri::async_runtime::spawn_blocking(move || secrets.secrets.client_secret()).await??;
        let label = this_computer_label();
        let me = pair::Me { client_secret: &secret, label: &label, platform: std::env::consts::OS };
        let outcome = pair::pair(&code, me, self.approval_wait, cancelled).await;
        let paired = match outcome? {
            Ok(paired) => paired,
            Err(failure) => return Ok(MachinePairResult::failed(failure)),
        };
        let identity = paired.described.filter(|described| described.machine_id == code.machine.machine_id).unwrap_or_else(|| code.machine.clone());
        let now = chrono::Utc::now().timestamp_millis();
        let machine = PairedMachine {
            machine_id: code.machine.machine_id.clone(),
            name: identity.name,
            os: identity.os,
            version: identity.version,
            public_key_b64: code.public_key_b64.clone(),
            direct_endpoints: code.direct_endpoints.clone(),
            route,
            paired_at: now,
            last_seen_at: Some(now),
            last_route: None,
            relay: None,
            other: Default::default(),
        };
        let keep = self.clone();
        let token = zeroize::Zeroizing::new(code.device_token.clone());
        let machine = tauri::async_runtime::spawn_blocking(move || -> Result<PairedMachine> {
            // The token first, so a record never names a machine without one.
            keep.secrets.save_token(&machine.machine_id, &token)?;
            keep.store()?.put(machine)
        })
        .await??;
        log::info!("machines: paired with machine {}", machine.machine_id);
        Ok(MachinePairResult::Paired { paired: true, machine })
    }

    pub fn cancel_pairing(&self) {
        if let Some(cancel) = self.pairing.lock().unwrap().take() {
            let _ = cancel.send(true);
        }
    }

    pub fn list(&self) -> Result<Vec<PairedMachine>> {
        self.store()?.list()
    }

    pub fn set_route(&self, machine_id: &str, route: MachineRoute) -> Result<PairedMachine> {
        self.store()?.set_route(machine_id, route)?.with_context(|| format!("no paired machine {machine_id}"))
    }
}

/// The fingerprint both screens show: the code's host key, this
/// installation's client key and the code's token.
pub(crate) fn fingerprint(code: &MachineCode, client_secret: &[u8; 32]) -> Result<String> {
    let host: [u8; 32] = STANDARD.decode(&code.public_key_b64)?.try_into().map_err(|_| anyhow!("the code's machine key is not 32 bytes"))?;
    let client = x25519_dalek::PublicKey::from(&x25519_dalek::StaticSecret::from(*client_secret));
    Ok(crate::pairing_fingerprint::fingerprint(&host, client.as_bytes(), &crate::machine_host::registry::token_hash(&code.device_token)))
}

/// This Mac's name as the machine's approval dialog shows it: 1 to 64
/// characters, control characters stripped.
fn this_computer_label() -> String {
    crate::machine_host::direct::computer_label(Some(&crate::machine_name::current().name))
}

fn view(status: Option<Status>) -> MachineHostView {
    let settings = crate::store::settings::load();
    MachineHostView { allow_operating: settings.machines.allow_operating, keep_awake: settings.pairing.keep_awake, status }
}

// ---------------------------------------------------------------- Tauri commands

type CmdResult<T> = Result<T, String>;

fn err(error: impl std::fmt::Display) -> String {
    format!("{error:#}")
}

fn runtime(state: &crate::AppState) -> Result<Arc<crate::local_runtime::desktop::Desktop>, String> {
    state.runtime().ok_or_else(|| "The local runtime is unavailable.".to_string())
}

/// The view, asking the runtime for its status now. Blocking.
fn host_view(machines: &Machines, runtime: Option<Arc<crate::local_runtime::desktop::Desktop>>) -> MachineHostView {
    let status = runtime.and_then(|runtime| match runtime.machine_host_status() {
        Ok(status) => status,
        Err(error) => {
            log::debug!("machines: the runtime's machine host status is unavailable: {error:#}");
            None
        }
    });
    if status.is_some() {
        *machines.last_status.lock().unwrap() = status.clone();
    }
    view(status)
}

/// A machine host command that names the window's attachment, then the view.
async fn host_command(
    state: tauri::State<'_, crate::AppState>,
    machines: tauri::State<'_, Arc<Machines>>,
    command: &'static str,
    params: serde_json::Value,
) -> CmdResult<MachineHostView> {
    let (runtime, machines) = (runtime(&state)?, machines.inner().clone());
    tauri::async_runtime::spawn_blocking(move || {
        runtime.machine_host(command, params).map_err(err)?;
        Ok(host_view(&machines, Some(runtime)))
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn machines_host_status(state: tauri::State<'_, crate::AppState>, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<MachineHostView> {
    let (runtime, machines) = (state.runtime(), machines.inner().clone());
    tauri::async_runtime::spawn_blocking(move || host_view(&machines, runtime)).await.map_err(err)
}

/// "Let other computers operate this Mac". The runtime watches the file.
#[tauri::command]
pub async fn machines_set_allow_operating(enabled: bool, state: tauri::State<'_, crate::AppState>, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<MachineHostView> {
    let (runtime, machines) = (state.runtime(), machines.inner().clone());
    tauri::async_runtime::spawn_blocking(move || {
        let mut settings = crate::store::settings::load();
        settings.machines.allow_operating = enabled;
        crate::store::settings::save(&settings).map_err(err)?;
        Ok(host_view(&machines, runtime))
    })
    .await
    .map_err(err)?
}

/// `{ code, expiresAt }`. Refused as `pairing_paused: …` or `not_enabled: …`.
#[tauri::command]
pub async fn machines_create_code(state: tauri::State<'_, crate::AppState>) -> CmdResult<wire::CreatedCode> {
    let runtime = runtime(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let created = runtime.machine_host(wire::CREATE_CODE, serde_json::json!({})).map_err(err)?;
        serde_json::from_value(created).map_err(err)
    })
    .await
    .map_err(err)?
}

#[tauri::command]
pub async fn machines_approve(request_id: String, state: tauri::State<'_, crate::AppState>, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<MachineHostView> {
    host_command(state, machines, wire::APPROVE, serde_json::json!({ "requestId": request_id })).await
}

#[tauri::command]
pub async fn machines_decline(request_id: String, state: tauri::State<'_, crate::AppState>, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<MachineHostView> {
    host_command(state, machines, wire::DECLINE, serde_json::json!({ "requestId": request_id })).await
}

/// Remove a paired computer: its connections close and its credential is refused.
#[tauri::command]
pub async fn machines_revoke(id: String, state: tauri::State<'_, crate::AppState>, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<MachineHostView> {
    host_command(state, machines, wire::REVOKE, serde_json::json!({ "id": id })).await
}

#[tauri::command]
pub async fn machines_inspect_code(code: String, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<InspectedMachineCode> {
    let machines = machines.inner().clone();
    tauri::async_runtime::spawn_blocking(move || machines.inspect(&code)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub async fn machines_pair(code: String, route: MachineRoute, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<MachinePairResult> {
    machines.inner().clone().pair(code, route).await.map_err(err)
}

#[tauri::command]
pub fn machines_cancel_pairing(machines: tauri::State<'_, Arc<Machines>>) {
    machines.cancel_pairing();
}

#[tauri::command]
pub async fn machines_list(machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<Vec<PairedMachine>> {
    let machines = machines.inner().clone();
    tauri::async_runtime::spawn_blocking(move || machines.list()).await.map_err(err)?.map_err(err)
}

#[tauri::command]
pub async fn machines_set_route(machine_id: String, route: MachineRoute, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<PairedMachine> {
    let machines = machines.inner().clone();
    tauri::async_runtime::spawn_blocking(move || machines.set_route(&machine_id, route)).await.map_err(err)?.map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pair_result_serialises_as_the_ui_reads_it() {
        let failed = MachinePairResult::failed(pair::Failure { reason: "not-approved", message: "no".into() });
        assert_eq!(serde_json::to_value(failed).unwrap(), serde_json::json!({ "paired": false, "reason": "not-approved", "message": "no" }));
    }

    #[test]
    fn the_view_names_both_switches() {
        let _home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.machines.allow_operating = true;
        settings.pairing.keep_awake = false;
        crate::store::settings::save(&settings).unwrap();
        let value = serde_json::to_value(view(None)).unwrap();
        assert_eq!(value, serde_json::json!({ "allowOperating": true, "keepAwake": false, "status": null }));
    }
}
