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

pub mod account;
pub mod connect;
/// Compiled at the crate root as `machine_pair`, so headless builds have it too.
pub use crate::machine_pair as pair;
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

/// Emitted with `{ version }` when another computer asks this Mac's app to
/// update (`MACHINES_APP_UPDATE_REQUESTED_EVENT` in src/types/machines.ts):
/// the runtime's [`crate::remote::machine_update::REQUESTED_EVENT`], re-emitted.
pub const APP_UPDATE_REQUESTED_EVENT: &str = "machines_app_update_requested";

/// The control call the window's updater reports go to (PRO-354).
const APP_UPDATE_REPORT: &str = "runtime.machineUpdate.report";

/// `MachineHostView` in src/types/machines.ts.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineHostView {
    /// `machines.allowOperating`.
    pub allow_operating: bool,
    /// `pairing.keepAwake`, shared with phones.
    pub keep_awake: bool,
    /// `machines.listen` (PRO-487): where this Mac listens for computers and
    /// phones. `None`: never chosen, so every interface, as before the setting.
    pub listen: Option<crate::listen::Listen>,
    /// `machines.allowPublic`: callers from public addresses are answered.
    pub allow_public: bool,
    /// The addresses the window's own phone listener is bound to, while it
    /// holds the port (the runtime's are in `status.listen`).
    pub phone_listening: Vec<String>,
    /// `None` while the runtime cannot be reached.
    pub status: Option<Status>,
    /// The attached runtime cannot verify this window and was left running
    /// for what it serves: `runtime_restart_required:<epoch>: <message>`,
    /// shown with Restart runtime beside it (PRO-486).
    pub restart_required: Option<String>,
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
    Paired { paired: bool, machine: Box<PairedMachine> },
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
    /// The restart last offered for the attached runtime, as last read with
    /// what it would stop (PRO-486), so a runtime event re-emits it too.
    restart_required: Mutex<Option<String>>,
    approval_wait: std::time::Duration,
    /// The app's account, once it is up: pairing through the relay keeps
    /// its credential for the account signed in (PRO-487).
    account: std::sync::OnceLock<Arc<crate::account::AccountManager>>,
    /// The window's phone pairing, whose listener follows the listen setting.
    phones: std::sync::OnceLock<Arc<crate::pairing::PairingManager>>,
}

impl Default for Machines {
    fn default() -> Self {
        Self::new(MachineSecrets::default(), None)
    }
}

impl Machines {
    fn new(secrets: MachineSecrets, store_dir: Option<std::path::PathBuf>) -> Self {
        Self { secrets, store_dir, pairing: Mutex::new(None), last_status: Mutex::new(None), restart_required: Mutex::new(None), approval_wait: pair::APPROVAL_WAIT, account: std::sync::OnceLock::new(), phones: std::sync::OnceLock::new() }
    }

    /// The window's phone pairing, for the addresses its listener holds.
    pub fn set_phones(&self, pairing: Arc<crate::pairing::PairingManager>) {
        let _ = self.phones.set(pairing);
    }

    /// Whether someone is signed in to TerminalX in this app.
    fn signed_in(&self) -> bool {
        self.account.get().and_then(|account| account.current_scope()).is_some()
    }

    /// The account whose sign-in pairing through the relay uses.
    pub fn set_account(&self, account: Arc<crate::account::AccountManager>) {
        let _ = self.account.set(account);
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
                events.emit(HOST_CHANGED_EVENT, &view(&machines, Some(status)));
            }),
        );
        let events = sink.clone();
        sink.listen(
            crate::remote::machine_update::REQUESTED_EVENT,
            Box::new(move |payload| {
                let Ok(requested) = serde_json::from_str::<serde_json::Value>(payload) else { return };
                log::info!("machines: another computer asked this Mac to update to {}", requested["version"]);
                events.emit(APP_UPDATE_REQUESTED_EVENT, &serde_json::json!({ "version": requested["version"] }));
            }),
        );
        let (machines, events) = (Arc::downgrade(self), sink.clone());
        sink.listen(
            "settings_file_changed",
            Box::new(move |_| {
                let Some(machines) = machines.upgrade() else { return };
                let status = machines.last_status.lock().unwrap().clone();
                events.emit(HOST_CHANGED_EVENT, &view(&machines, status));
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
        let relay_user = self.account.get().and_then(|account| account.current_scope()).map(|scope| scope.user_id);
        let me = pair::Me { client_secret: &secret, label: &label, platform: std::env::consts::OS, relay_user: relay_user.as_deref() };
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
            // Paired through the relay: its credential came with the pairing.
            relay: paired.relay.as_ref().map(|credential| credential.info.clone()),
            named_here: false,
            other: Default::default(),
        };
        let keep = self.clone();
        let token = zeroize::Zeroizing::new(code.device_token.clone());
        let relay_token = paired.relay.map(|credential| credential.resume_token);
        let machine = tauri::async_runtime::spawn_blocking(move || -> Result<PairedMachine> {
            // The tokens first, so a record never names a machine, or a
            // relay credential, without one.
            keep.secrets.save_token(&machine.machine_id, &token)?;
            if let Some(relay_token) = &relay_token {
                keep.secrets.save_relay_token(&machine.machine_id, relay_token)?;
            }
            keep.store()?.put(machine)
        })
        .await??;
        log::info!("machines: paired with machine {}", machine.machine_id);
        Ok(MachinePairResult::Paired { paired: true, machine: Box::new(machine) })
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

fn view(machines: &Machines, status: Option<Status>) -> MachineHostView {
    let settings = crate::store::settings::load();
    let restart_required = machines.restart_required.lock().unwrap().clone();
    MachineHostView {
        allow_operating: settings.machines.allow_operating,
        keep_awake: settings.pairing.keep_awake,
        listen: settings.machines.listen,
        allow_public: settings.machines.allow_public == Some(true),
        phone_listening: machines.phones.get().map(|pairing| pairing.window_listening()).unwrap_or_default(),
        status,
        restart_required,
    }
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
    let status = runtime.as_ref().and_then(|runtime| match runtime.machine_host_status() {
        Ok(status) => status,
        Err(error) => {
            log::debug!("machines: the runtime's machine host status is unavailable: {error:#}");
            None
        }
    });
    if status.is_some() {
        *machines.last_status.lock().unwrap() = status.clone();
    }
    // What a restart would stop now, not when it was offered (PRO-486).
    #[cfg(all(unix, feature = "desktop"))]
    let restart_required = runtime.as_ref().and_then(|runtime| {
        crate::local_runtime::window_consent::offered_now_for(runtime.epoch(), || crate::local_runtime::window_consent::in_use(runtime))
    });
    #[cfg(not(all(unix, feature = "desktop")))]
    let restart_required: Option<String> = None;
    *machines.restart_required.lock().unwrap() = restart_required.map(|required| required.to_string());
    view(machines, status)
}

/// Send every window a fresh view, as after the restart offered for the
/// attached runtime changed (PRO-486). Blocking: runtime IPC.
#[cfg(all(target_os = "macos", feature = "desktop"))]
pub(crate) fn emit_host_view(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let machines = app.state::<Arc<Machines>>().inner().clone();
    let runtime = app.state::<crate::AppState>().runtime();
    let _ = app.emit(HOST_CHANGED_EVENT, &host_view(&machines, runtime));
}

/// A machine host command that names the window's attachment, then the view.
async fn host_command(
    state: tauri::State<'_, crate::AppState>,
    machines: tauri::State<'_, Arc<Machines>>,
    command: &'static str,
    params: serde_json::Value,
) -> CmdResult<MachineHostView> {
    let (runtime, machines) = (runtime(&state)?, machines.inner().clone());
    tauri::async_runtime::spawn_blocking(move || runtime.machine_host(command, params).map(drop).map_err(err)).await.map_err(err)??;
    // Read again: the command may have been answered by a fresh runtime
    // that replaced this one (PRO-486).
    let runtime = state.runtime();
    tauri::async_runtime::spawn_blocking(move || host_view(&machines, runtime)).await.map_err(err)
}

#[tauri::command]
pub async fn machines_host_status(state: tauri::State<'_, crate::AppState>, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<MachineHostView> {
    let (runtime, machines) = (state.runtime(), machines.inner().clone());
    tauri::async_runtime::spawn_blocking(move || host_view(&machines, runtime)).await.map_err(err)
}

/// "Let other computers operate this Mac". The runtime watches the file.
#[tauri::command]
pub async fn machines_set_allow_operating(enabled: bool, state: tauri::State<'_, crate::AppState>, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<MachineHostView> {
    let (runtime, machines, pairing) = (state.runtime(), machines.inner().clone(), state.pairing.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let mut settings = crate::store::settings::load();
        settings.machines.allow_operating = enabled;
        // Turned on for the first time on a Mac nothing relies on reaching
        // directly yet (PRO-487): no phone and no computer paired. Signed in,
        // it takes "Relay only", the default, which the relay then reaches.
        // Signed out it has no relay, so "Relay only" would leave it
        // unreachable: it takes "Local network" (private and Tailscale
        // addresses, never a public one) and the person can choose again.
        // A Mac with paired devices keeps what it has until the person
        // chooses. Whether the phone listener happens to be up says nothing
        // here: a signed-in window opens it with no phone paired.
        if enabled && settings.machines.listen.is_none() {
            let paired_computers = crate::store::root().ok().is_none_or(|data| crate::machine_host::registry::Registry::in_data_dir(&data).list().map_or(true, |computers| !computers.is_empty()));
            if let Some(first) = first_listen_choice(paired_computers || pairing.has_paired_phones(), machines.signed_in()) {
                settings.machines.listen = Some(first);
                settings.machines.allow_public = Some(false);
            }
        }
        crate::store::settings::save(&settings).map_err(err)?;
        pairing.machine_operating_changed();
        pairing.listen_setting_changed();
        Ok(host_view(&machines, runtime))
    })
    .await
    .map_err(err)?
}

/// The listen choice written when "Let other computers operate this Mac" is
/// turned on with none made yet (PRO-487): none while a device is paired
/// (it keeps what it relies on), "Relay only" when signed in, and "Local
/// network" when not, since nothing would reach a signed-out Mac through the
/// relay. Never "All interfaces".
fn first_listen_choice(devices_paired: bool, signed_in: bool) -> Option<crate::listen::Listen> {
    use crate::listen::Listen;
    if devices_paired {
        return None;
    }
    Some(if signed_in { Listen::Relay } else { Listen::Lan })
}

/// "Where this Mac listens" (PRO-487): `listen` is `relay`, `tailscale`,
/// `lan` or `all`. The runtime and the window's phone listener follow the
/// file.
#[tauri::command]
pub async fn machines_set_listen(listen: crate::listen::Listen, allow_public: bool, state: tauri::State<'_, crate::AppState>, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<MachineHostView> {
    let (runtime, machines, pairing) = (state.runtime(), machines.inner().clone(), state.pairing.clone());
    tauri::async_runtime::spawn_blocking(move || {
        crate::listen::choose(listen, allow_public).map_err(err)?;
        pairing.listen_setting_changed();
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

/// Remove a paired computer: its connections close and its credential is
/// refused. One allowed through the account (PRO-349) also has its grant
/// revoked, so the operating computer's account stops listing this Mac as
/// paired; that is best effort, and a failure is only logged.
#[tauri::command]
pub async fn machines_revoke(id: String, state: tauri::State<'_, crate::AppState>, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<MachineHostView> {
    let (runtime, machines, pairing) = (runtime(&state)?, machines.inner().clone(), state.pairing.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let answer = runtime.machine_host(wire::REVOKE, serde_json::json!({ "id": id })).map_err(err)?;
        if let Some(grant_request_id) = revoked_grant(&answer) {
            pairing.host_removed_computer(grant_request_id);
        }
        Ok(host_view(&machines, Some(runtime)))
    })
    .await
    .map_err(err)?
}

/// The account grant of the computer a [`wire::REVOKE`] removed, if it had one.
fn revoked_grant(answer: &serde_json::Value) -> Option<&str> {
    answer["revoked"].as_bool().filter(|revoked| *revoked)?;
    answer["grantRequestId"].as_str().filter(|grant| !grant.is_empty())
}

/// "Disconnect" (PRO-357): close a paired computer's connections now and
/// hold it off until the person lets it back. Its credential is kept.
#[tauri::command]
pub async fn machines_disconnect(id: String, state: tauri::State<'_, crate::AppState>, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<MachineHostView> {
    host_command(state, machines, wire::DISCONNECT, serde_json::json!({ "id": id })).await
}

/// Let a disconnected computer connect again. Only a person may (`consent`).
#[tauri::command]
pub async fn machines_let_back(id: String, state: tauri::State<'_, crate::AppState>, machines: tauri::State<'_, Arc<Machines>>) -> CmdResult<MachineHostView> {
    host_command(state, machines, wire::LET_BACK, serde_json::json!({ "id": id })).await
}

/// The activity log (PRO-357): the last 200 entries, newest first.
#[tauri::command]
pub async fn machines_activity(state: tauri::State<'_, crate::AppState>) -> CmdResult<Vec<crate::machine_host::activity::Entry>> {
    let runtime = runtime(&state)?;
    tauri::async_runtime::spawn_blocking(move || {
        let answer = runtime.machine_host(wire::ACTIVITY, serde_json::json!({})).map_err(err)?;
        serde_json::from_value(answer["entries"].clone()).map_err(err)
    })
    .await
    .map_err(err)?
}

/// The app's own updater run, as the window reports each step after
/// [`APP_UPDATE_REQUESTED_EVENT`] (`MachineAppUpdateReport`): forwarded to
/// the runtime, which tells the computer that asked (`machine.updateChanged`).
/// `available` is the version the app's updater offers, once it has checked.
#[tauri::command]
pub async fn machines_app_update_report(
    phase: String,
    step: Option<String>,
    message: Option<String>,
    available: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> CmdResult<()> {
    const PHASES: [&str; 6] = ["checking", "downloading", "installing", "restarting", "upToDate", "failed"];
    if !PHASES.contains(&phase.as_str()) {
        return Err(format!("unknown app update phase {phase:?}"));
    }
    let runtime = runtime(&state)?;
    let mut params = serde_json::json!({ "phase": phase, "step": step, "message": message });
    if let Some(available) = available {
        params["available"] = serde_json::json!(available);
    }
    tauri::async_runtime::spawn_blocking(move || runtime.machine_host(APP_UPDATE_REPORT, params).map(drop).map_err(err)).await.map_err(err)?
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
pub async fn machines_set_route(
    machine_id: String,
    route: MachineRoute,
    machines: tauri::State<'_, Arc<Machines>>,
    connections: tauri::State<'_, Arc<connect::MachineConnections>>,
) -> CmdResult<PairedMachine> {
    let machines = machines.inner().clone();
    let id = machine_id.clone();
    let updated = tauri::async_runtime::spawn_blocking(move || machines.set_route(&id, route)).await.map_err(err)?.map_err(err)?;
    // A relay link "Only this network" no longer allows closes now.
    connections.route_changed(&machine_id);
    Ok(updated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pair_result_serialises_as_the_ui_reads_it() {
        let failed = MachinePairResult::failed(pair::Failure { reason: "not-approved", message: "no".into() });
        assert_eq!(serde_json::to_value(failed).unwrap(), serde_json::json!({ "paired": false, "reason": "not-approved", "message": "no" }));
    }

    /// PRO-354: the runtime's request reaches the web views under the name
    /// src/types/machines.ts listens for.
    #[test]
    fn an_app_update_request_is_re_emitted_to_the_window() {
        let _home = crate::store::temp_home();
        let sink = Arc::new(crate::sink::BroadcastSink::new(16));
        let mut events = sink.subscribe();
        let machines = Arc::new(Machines::new(MachineSecrets::default(), None));
        machines.configure(sink.clone(), "ai.terminalx.test").unwrap();
        let emitter: Arc<dyn EventSink> = sink.clone();
        emitter.emit(crate::remote::machine_update::REQUESTED_EVENT, &serde_json::json!({ "version": "0.2.40" }));
        let mut seen = Vec::new();
        while let Ok(event) = events.try_recv() {
            seen.push((event.event.to_string(), event.payload.to_string()));
        }
        assert!(seen.iter().any(|(event, payload)| event == APP_UPDATE_REQUESTED_EVENT && payload == r#"{"version":"0.2.40"}"#), "{seen:?}");
    }

    #[test]
    fn only_a_removed_computer_with_a_grant_revokes_one() {
        use serde_json::json;
        assert_eq!(revoked_grant(&json!({ "revoked": true, "grantRequestId": "grant-1" })), Some("grant-1"));
        assert_eq!(revoked_grant(&json!({ "revoked": true, "grantRequestId": null })), None, "paired by code");
        assert_eq!(revoked_grant(&json!({ "revoked": true })), None, "a runtime before PRO-349");
        assert_eq!(revoked_grant(&json!({ "revoked": false, "grantRequestId": "grant-1" })), None);
    }

    /// PRO-487 review: the first choice depends on what relies on the Mac
    /// and on the relay, not on whether the phone listener happens to be up.
    #[test]
    fn turning_operating_on_chooses_relay_only_when_signed_in_and_nothing_is_paired() {
        use crate::listen::Listen;
        assert_eq!(first_listen_choice(false, true), Some(Listen::Relay));
        assert_eq!(first_listen_choice(false, false), Some(Listen::Lan), "signed out the relay cannot reach it");
        assert_eq!(first_listen_choice(true, true), None, "a paired phone or computer keeps what it relies on");
        assert_eq!(first_listen_choice(true, false), None);
    }

    #[test]
    fn the_view_names_both_switches() {
        let _home = crate::store::temp_home();
        let mut settings = crate::store::settings::load();
        settings.machines.allow_operating = true;
        settings.pairing.keep_awake = false;
        crate::store::settings::save(&settings).unwrap();
        let value = serde_json::to_value(view(&Machines::default(), None)).unwrap();
        assert_eq!(value, serde_json::json!({ "allowOperating": true, "keepAwake": false, "listen": null, "allowPublic": false, "phoneListening": [], "status": null, "restartRequired": null }));
    }
}
