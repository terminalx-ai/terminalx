//! Connecting to paired machines (PRO-345, docs/MACHINES.md "As built
//! (PRO-345)"): the Tauri face of `remote::machine_client`.
//!
//! - `machine_remote_attach` gives the machine's one connection id, made the
//!   first time; frames and states go through `cloud_remote` as a cloud
//!   workspace's do.
//! - `machines_connections` and the `machines_connection_changed` event give
//!   each machine's [`MachineConnectionState`].
//! - `machines_reconnect` is "Try again".
//! - `machines_remove` forgets a machine: its owner stops, its record and
//!   its credentials go. Its sessions stay on the machine.
//! - A wake (the wall clock jumping past the monotonic one) and a change of
//!   this computer's interface addresses nudge every owner; a change of the
//!   signed-in account tells each one, so a relay link closes on sign-out.

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use zeroize::Zeroizing;

use super::Machines;
use crate::account::AccountManager;
use crate::cloud_remote::CloudRemote;
use crate::machine_wire::MachineOs;
use crate::remote::machine_client::{
    interface_addresses, MachineConnectionState, MachineConnectionView, MachineEnv, OnState, Owners, RelayCredential, RouteUsed, Target, WakeDetector,
};

pub const CONNECTION_CHANGED_EVENT: &str = "machines_connection_changed";

/// How often the wake detector looks.
const WAKE_CHECK: Duration = Duration::from_secs(1);
/// How often the interface addresses are read.
const NETWORK_CHECK: Duration = Duration::from_secs(2);

/// One owner per paired machine.
pub struct MachineConnections {
    machines: Arc<Machines>,
    account: Arc<AccountManager>,
    owners: Owners,
    app: OnceLock<AppHandle>,
}

impl MachineConnections {
    pub fn new(machines: Arc<Machines>, account: Arc<AccountManager>) -> Arc<Self> {
        Arc::new(Self { machines, account, owners: Owners::default(), app: OnceLock::new() })
    }

    fn signed_in_user(&self) -> Option<String> {
        self.account.current_scope().map(|scope| scope.user_id)
    }

    /// Watch for wake, network changes and account changes, for the app's life.
    pub fn watch(self: &Arc<Self>, app: AppHandle) {
        let _ = self.app.set(app);
        let connections = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            let mut wake = WakeDetector::default();
            let mut addresses = tauri::async_runtime::spawn_blocking(interface_addresses).await.unwrap_or_default();
            let mut user = connections.upgrade().and_then(|connections| connections.signed_in_user());
            let mut ticks = 0u64;
            loop {
                tokio::time::sleep(WAKE_CHECK).await;
                let Some(connections) = connections.upgrade() else { return };
                ticks += 1;
                let mut nudge = wake.check();
                if nudge {
                    log::info!("machines: this computer woke; checking every machine connection");
                }
                if ticks.is_multiple_of(NETWORK_CHECK.as_secs()) {
                    let now = tauri::async_runtime::spawn_blocking(interface_addresses).await.unwrap_or_default();
                    if now != addresses {
                        log::info!("machines: the network changed; checking every machine connection");
                        addresses = now;
                        nudge = true;
                    }
                }
                if nudge {
                    connections.owners.nudge_all();
                }
                let signed_in = connections.signed_in_user();
                if signed_in != user {
                    user = signed_in;
                    for owner in connections.owners.all() {
                        owner.relay_rules_changed();
                    }
                }
            }
        });
    }

    fn emit(&self, view: &MachineConnectionView) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(CONNECTION_CHANGED_EVENT, view);
        }
    }

    /// The machine's one connection id. Refused with `machine_unknown` or
    /// `machine_token_missing`. Blocking reads happen before, off the runtime.
    async fn attach(self: &Arc<Self>, app: &AppHandle, remote: &Arc<CloudRemote>, machine_id: String, holder: String) -> Result<String, String> {
        let check = (self.machines.clone(), machine_id.clone());
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let (machines, machine_id) = check;
            if machines.store().map_err(super::err)?.get(&machine_id).map_err(super::err)?.is_none() {
                return Err("machine_unknown".into());
            }
            if machines.secrets.load_token(&machine_id).map_err(super::err)?.is_none() {
                return Err("machine_token_missing".into());
            }
            Ok(())
        })
        .await
        .map_err(super::err)??;
        let connections = self.clone();
        self.owners
            .attach(&machine_id, &holder, || {
                let env = Arc::new(StoreEnv { machine_id: machine_id.clone(), machines: connections.machines.clone(), account: connections.account.clone() });
                let weak = Arc::downgrade(&connections);
                let on_state: OnState = Arc::new(move |view: &MachineConnectionView| {
                    if let Some(connections) = weak.upgrade() {
                        connections.emit(view);
                    }
                });
                Ok(remote.start_machine(app, &machine_id, env, on_state))
            })
            .map_err(super::err)
    }

    /// The machine's route setting changed: a relay link it no longer allows
    /// is closed now, not when it happens to drop.
    pub fn route_changed(&self, machine_id: &str) {
        if let Some(owner) = self.owners.get(machine_id) {
            owner.relay_rules_changed();
        }
    }

    /// The paired machines (`machines_list`), for the CLI (`machine_control`).
    pub(crate) fn paired(&self) -> Result<Vec<super::store::PairedMachine>> {
        self.machines.list()
    }

    pub(crate) fn machines(&self) -> &Arc<Machines> {
        &self.machines
    }

    /// `terminalx machines remove`: as Settings → Machines → Remove.
    pub(crate) fn forget(&self, machine_id: &str) -> Result<bool> {
        self.remove(machine_id)
    }

    /// One view per paired machine, `idle` when not attached.
    pub(crate) fn views(&self) -> Result<Vec<MachineConnectionView>> {
        Ok(self
            .machines
            .list()?
            .into_iter()
            .map(|machine| MachineConnectionView {
                state: self.owners.get(&machine.machine_id).map(|owner| owner.state()).unwrap_or(MachineConnectionState::Idle),
                machine_id: machine.machine_id,
            })
            .collect())
    }
}

/// The record in `machines.json`, the Keychain and the account, for one machine.
struct StoreEnv {
    machine_id: String,
    machines: Arc<Machines>,
    account: Arc<AccountManager>,
}

impl StoreEnv {
    fn forget_relay(&self) -> Result<()> {
        self.machines.secrets.delete_relay_token(&self.machine_id)?;
        self.machines.store()?.update(&self.machine_id, |machine| machine.relay = None)?;
        Ok(())
    }
}

impl MachineEnv for StoreEnv {
    fn target(&self) -> Result<Target> {
        let record = self.machines.store()?.get(&self.machine_id)?.ok_or_else(|| anyhow!("machine_unknown"))?;
        let device_token = self.machines.secrets.load_token(&self.machine_id)?.ok_or_else(|| anyhow!("machine_token_missing"))?;
        let client_secret = self.machines.secrets.client_secret()?;
        let signed_in = self.signed_in_user();
        let relay = match (&record.relay, signed_in.as_deref()) {
            // Used only while the account that obtained it is signed in.
            (Some(info), Some(user)) if info.user_id == user => {
                self.machines.secrets.load_relay_token(&self.machine_id)?.map(|resume_token| RelayCredential { info: info.clone(), resume_token })
            }
            // Another account signed in: the credential is deleted.
            (Some(_), Some(_)) => {
                self.forget_relay()?;
                None
            }
            // Signed out: kept for when the same account signs in again.
            _ => None,
        };
        Ok(Target {
            machine_id: record.machine_id,
            public_key_b64: record.public_key_b64,
            direct_endpoints: record.direct_endpoints,
            route: record.route,
            last_route: record.last_route,
            last_seen_at: record.last_seen_at,
            device_token: Zeroizing::new(device_token.to_string()),
            client_secret,
            label: super::this_computer_label(),
            platform: std::env::consts::OS.to_string(),
            relay,
        })
    }

    fn signed_in_user(&self) -> Option<String> {
        self.account.current_scope().map(|scope| scope.user_id)
    }

    fn described(&self, described: &Value, route: &RouteUsed) {
        let changed = self.machines.store().and_then(|store| store.update(&self.machine_id, |machine| apply_described(machine, described, route, chrono::Utc::now().timestamp_millis())));
        if let Err(error) = changed {
            log::warn!("machines: keep what machine {} said of itself: {error:#}", self.machine_id);
        }
    }

    fn save_relay(&self, credential: &RelayCredential) -> Result<()> {
        // The token first, so a record never names a credential it lacks.
        self.machines.secrets.save_relay_token(&self.machine_id, &credential.resume_token)?;
        self.machines.store()?.update(&self.machine_id, |machine| machine.relay = Some(credential.info.clone()))?;
        Ok(())
    }

    fn save_token(&self, token: &str) -> Result<()> {
        self.machines.secrets.save_token(&self.machine_id, token)
    }

    fn drop_relay(&self) {
        if let Err(error) = self.forget_relay() {
            log::warn!("machines: forget the relay credential of machine {}: {error:#}", self.machine_id);
        }
    }

    fn recorded_version(&self) -> Option<String> {
        let record = self.machines.store().and_then(|store| store.get(&self.machine_id)).ok().flatten()?;
        Some(record.version).filter(|version| !version.trim().is_empty())
    }
}

/// A successful `machine.describe` on `route`: the name, os, version and
/// direct addresses it gave, when it was seen and how. An empty address
/// list keeps the last one, so a machine whose listener is off for a
/// moment is still found once it is back.
pub(crate) fn apply_described(machine: &mut super::store::PairedMachine, described: &Value, route: &RouteUsed, now: i64) {
    // A name given on this computer stays (PRO-350).
    if let Some(name) = described["name"].as_str().filter(|name| !name.is_empty() && !machine.named_here) {
        machine.name = name.chars().take(80).collect();
    }
    if let Some(family) = described["os"]["family"].as_str() {
        machine.os = MachineOs { family: family.to_string(), version: described["os"]["version"].as_str().map(str::to_string) };
    }
    if let Some(version) = described["version"].as_str() {
        machine.version = version.to_string();
    }
    let endpoints: Vec<String> = described["directEndpoints"]
        .as_array()
        .map(|endpoints| endpoints.iter().filter_map(Value::as_str).filter(|endpoint| endpoint.starts_with("ws://") && endpoint.len() <= 512).take(64).map(str::to_string).collect())
        .unwrap_or_default();
    if !endpoints.is_empty() {
        machine.direct_endpoints = endpoints;
    }
    // A desktop app, or headless (`hasWindow` in `PairedMachine`): kept with
    // the record's other fields, so Settings → Machines says "headless".
    if let Some(has_window) = described["hasWindow"].as_bool() {
        machine.other.insert("hasWindow".into(), Value::Bool(has_window));
    }
    machine.last_seen_at = Some(now);
    machine.last_route = Some(route.clone());
}

// ---------------------------------------------------------------- Tauri commands

/// The machine's connection id for `cloud_remote_send`, `cloud_remote_detach`
/// and `cloud_port_*`; its states and messages come as `cloud_remote_event`.
#[tauri::command]
pub async fn machine_remote_attach(
    app: AppHandle,
    webview: tauri::Webview,
    machine_id: String,
    remote: tauri::State<'_, Arc<CloudRemote>>,
    connections: tauri::State<'_, Arc<MachineConnections>>,
) -> Result<String, String> {
    crate::data_privacy::require_network().map_err(|error| error.to_string())?;
    let (connections, remote) = (connections.inner().clone(), remote.inner().clone());
    connections.attach(&app, &remote, machine_id, webview.label().to_string()).await
}

/// One `MachineConnectionView` per paired machine.
#[tauri::command]
pub async fn machines_connections(connections: tauri::State<'_, Arc<MachineConnections>>) -> Result<Vec<MachineConnectionView>, String> {
    let connections = connections.inner().clone();
    tauri::async_runtime::spawn_blocking(move || connections.views()).await.map_err(super::err)?.map_err(super::err)
}

/// "Try again": nudges the owner; after `accessRemoved` or `needsUpdate` it
/// tries once more. Nothing to do for a machine that is not attached.
#[tauri::command]
pub fn machines_reconnect(machine_id: String, connections: tauri::State<'_, Arc<MachineConnections>>) {
    if let Some(owner) = connections.owners.get(&machine_id) {
        owner.try_again();
    }
}

impl MachineConnections {
    /// Forget a machine: stop its connection, then delete its record, its
    /// device token and its relay credential. Nothing on the machine
    /// changes: its sessions keep running there, and it lists this computer
    /// until someone revokes it there. `false` when it was not paired.
    fn remove(&self, machine_id: &str) -> Result<bool> {
        self.owners.remove(machine_id);
        let removed = self.machines.store()?.remove(machine_id)?;
        self.machines.secrets.delete_token(machine_id)?;
        self.machines.secrets.delete_relay_token(machine_id)?;
        if removed.is_some() {
            self.emit(&MachineConnectionView { machine_id: machine_id.to_string(), state: MachineConnectionState::Idle });
        }
        Ok(removed.is_some())
    }
}

/// The longest name a person may give a machine here, as `machine.describe` keeps one.
const MAX_NAME_CHARS: usize = 80;

/// What `name` becomes: trimmed, and an error when nothing or too much is left.
fn given_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow!("A machine needs a name."));
    }
    if name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(anyhow!("A machine's name is at most {MAX_NAME_CHARS} characters, on one line."));
    }
    Ok(name.to_string())
}

impl MachineConnections {
    /// Rename a paired machine on this computer only; the machine is not told.
    fn rename(&self, machine_id: &str, name: &str) -> Result<super::store::PairedMachine> {
        let name = given_name(name)?;
        let renamed = self.machines.store()?.update(machine_id, |machine| {
            machine.name = name;
            machine.named_here = true;
        })?;
        renamed.ok_or_else(|| anyhow!("This machine is no longer paired with this computer."))
    }
}

/// A machine's page → Rename (PRO-350): the name this computer shows for it,
/// which the name the machine gives itself on connecting no longer replaces.
#[tauri::command]
pub async fn machines_rename(machine_id: String, name: String, connections: tauri::State<'_, Arc<MachineConnections>>) -> Result<super::store::PairedMachine, String> {
    let connections = connections.inner().clone();
    tauri::async_runtime::spawn_blocking(move || connections.rename(&machine_id, &name)).await.map_err(super::err)?.map_err(super::err)
}

/// Settings → Machines → Remove. Answers whether the machine was paired.
#[tauri::command]
pub async fn machines_remove(machine_id: String, connections: tauri::State<'_, Arc<MachineConnections>>) -> Result<bool, String> {
    let connections = connections.inner().clone();
    tauri::async_runtime::spawn_blocking(move || connections.remove(&machine_id)).await.map_err(super::err)?.map_err(super::err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::machine_client::RouteKind;
    use serde_json::json;

    #[test]
    fn a_name_given_here_survives_the_machines_own_and_is_checked() {
        let mut machine = crate::machines::store::tests_support::machine("m1");
        machine.name = "Build box".into();
        machine.named_here = true;
        let route = RouteUsed { kind: RouteKind::Lan, endpoint: Some("ws://192.168.1.20:6768/machine/1".into()) };
        apply_described(&mut machine, &json!({ "name": "dev-server" }), &route, 5);
        assert_eq!(machine.name, "Build box");
        machine.named_here = false;
        apply_described(&mut machine, &json!({ "name": "dev-server" }), &route, 6);
        assert_eq!(machine.name, "dev-server");
        assert_eq!(given_name("  Build box ").unwrap(), "Build box");
        assert!(given_name("   ").is_err());
        assert!(given_name(&"x".repeat(81)).is_err());
        assert!(given_name("two\nlines").is_err());
    }

    #[test]
    fn a_describe_brings_the_record_up_to_date_and_an_empty_address_list_keeps_the_last() {
        let mut machine = crate::machines::store::tests_support::machine("cs1uhCLEB_ttCYaQ");
        let route = RouteUsed { kind: RouteKind::Lan, endpoint: Some("ws://192.168.1.21:6768/machine/1".into()) };
        let described = json!({ "machineId": "cs1uhCLEB_ttCYaQ", "name": "Studio", "os": { "family": "macos", "version": "26.2" }, "version": "0.2.40", "hasWindow": false,
            "directEndpoints": ["ws://192.168.1.21:6768/machine/1", "http://not-a-machine", "ws://mac-mini.local:6768/machine/1"] });
        apply_described(&mut machine, &described, &route, 77);
        assert_eq!(machine.name, "Studio");
        assert_eq!(machine.os, MachineOs { family: "macos".into(), version: Some("26.2".into()) });
        assert_eq!(machine.version, "0.2.40");
        assert_eq!(machine.direct_endpoints, vec!["ws://192.168.1.21:6768/machine/1".to_string(), "ws://mac-mini.local:6768/machine/1".to_string()]);
        assert_eq!(machine.last_seen_at, Some(77));
        assert_eq!(serde_json::to_value(&machine).unwrap()["hasWindow"], json!(false), "headless, as the UI reads it");
        assert_eq!(machine.last_route, Some(route.clone()));
        apply_described(&mut machine, &json!({ "machineId": "cs1uhCLEB_ttCYaQ", "directEndpoints": [] }), &route, 78);
        assert_eq!(machine.direct_endpoints.len(), 2, "kept");
        assert_eq!(machine.name, "Studio");
    }
}
