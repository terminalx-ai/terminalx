//! Paired machines for the `terminalx` CLI (PRO-356, docs/MACHINES.md
//! "As built (PRO-356)").
//!
//! `terminalx machines …` and every command given `--machine` (or a
//! `machine:` key) arrive here as `machine.<action>`. The CLI never opens a
//! network connection: the desktop carries each command over the one
//! connection it already holds to the machine (decision 2).
//!
//! - `list`, `status`, `add` and `remove` are answered here, from the paired
//!   machines and their connection owners, as Settings → Machines reads them.
//! - Every other action names one machine. It is resolved here first, and a
//!   machine that cannot answer is refused here with its own code, at once:
//!   an offline machine is `machine_offline`, never a timeout. Then the action
//!   is handed to the window (`machine_control_request`), which runs it over
//!   the machine's connection with the code the machine views use, and
//!   answers through `cloud_control_reply`.
//!
//! The pure parts (which machine a selector names, why a state refuses, a
//! machine's row) work on JSON so they are tested without a desktop.

// `terminalx-serve` builds without the desktop: it only routes `machine.*`
// to an attached window (`supported`, `timeout_for`).
#![cfg_attr(not(feature = "desktop"), allow(dead_code))]

use std::time::Duration;

use serde_json::{json, Value};

use crate::control::ControlError;

pub const REQUEST_EVENT: &str = "machine_control_request";

/// No paired machine has that id or name.
pub const UNKNOWN: &str = "machine_unknown";
/// Not connected now: no route answers, or the link was lost moments ago.
pub const OFFLINE: &str = "machine_offline";
/// One of the two computers must update before they work together.
pub const NEEDS_UPDATE: &str = "machine_needs_update";
/// The machine is replacing its runtime with a new version.
pub const UPDATING: &str = "machine_updating";
/// The machine refused this computer's credential.
pub const ACCESS_REMOVED: &str = "machine_access_removed";
/// The person at the machine pressed Disconnect.
pub const DISCONNECTED: &str = "machine_disconnected";
/// Data privacy mode is on: this computer operates no machine (PRO-357).
pub const DISABLED: &str = "machines_disabled";
/// The machine is connected, but its version does not serve this command.
/// The window sets it, from the namespaces the machine granted
/// (`src/lib/machineControl.ts`); named here so the codes stay one list.
#[cfg_attr(not(test), allow(dead_code))]
pub const UNSUPPORTED: &str = "machine_unsupported";

/// Answered here, without the window.
const NATIVE_ACTIONS: [&str; 4] = ["list", "status", "add", "remove"];
/// Run in the window over the machine's connection.
const WINDOW_ACTIONS: [&str; 15] = [
    "projects.list",
    "sessions.list",
    "sessions.create",
    "sessions.rename",
    "sessions.archive",
    "tabs.list",
    "send",
    "read",
    "wait",
    "permissions.list",
    "permissions.allow",
    "permissions.deny",
    "worktrees.list",
    "worktrees.delete",
    // `sessions list --all-machines`: every machine's sessions, connected or not.
    "sessions.listAll",
];

/// Whether `command` is a `machine.*` control command this build knows.
pub(crate) fn supported(command: &str) -> bool {
    command.strip_prefix("machine.").is_some_and(|action| NATIVE_ACTIONS.contains(&action) || WINDOW_ACTIONS.contains(&action))
}

/// A wait in the window is short, as a cloud wait is; the CLI asks again.
pub(crate) const WAIT_CHUNK_SECONDS: u64 = crate::cloud_control::WAIT_CHUNK_SECONDS;
/// Pairing waits for the person at the machine to press Allow (two minutes).
const ADD_TIMEOUT: Duration = Duration::from_secs(150);
/// A new session cuts a worktree on the machine and sends the first prompt.
const CREATE_TIMEOUT: Duration = Duration::from_secs(120);
/// Removing a worktree may run its archive script first.
const DELETE_TIMEOUT: Duration = Duration::from_secs(330);
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(50);

/// How long the desktop waits for `machine.<action>`.
pub(crate) fn timeout_for(action: &str, params: &Value) -> Duration {
    match action {
        "add" => ADD_TIMEOUT,
        "sessions.create" => CREATE_TIMEOUT,
        "worktrees.delete" => DELETE_TIMEOUT,
        "wait" => {
            let seconds = params.get("timeoutSeconds").and_then(Value::as_u64).unwrap_or(WAIT_CHUNK_SECONDS).min(WAIT_CHUNK_SECONDS);
            Duration::from_secs(seconds.saturating_add(20))
        }
        _ => DEFAULT_TIMEOUT,
    }
}

const LIST_RECOVERY: &str = "List them with terminalx machines list.";

/// The machine id a `machine:` key names (`machine:<m>`, `machine:<m>:<p>`, `machine:<m>:<p>:<s>`).
pub(crate) fn key_machine(key: &str) -> Option<&str> {
    key.strip_prefix("machine:").and_then(|rest| rest.split(':').next()).filter(|id| !id.is_empty())
}

/// Which paired machine `selector` names: its id, a `machine:` key, or its
/// name (any case). `machines` is `machines_list`'s rows. A name two
/// machines share names neither.
pub(crate) fn resolve<'a>(machines: &'a [Value], selector: &str) -> Result<&'a Value, ControlError> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err(ControlError::invalid("--machine needs a machine's name or id."));
    }
    let id = key_machine(selector).unwrap_or(selector);
    if let Some(machine) = machines.iter().find(|machine| machine["machineId"].as_str() == Some(id)) {
        return Ok(machine);
    }
    let named: Vec<&Value> = machines
        .iter()
        .filter(|machine| machine["name"].as_str().is_some_and(|name| name.trim().eq_ignore_ascii_case(selector)))
        .collect();
    match named.as_slice() {
        [machine] => Ok(machine),
        [] => Err(ControlError::new(UNKNOWN, format!("No paired machine is called {selector}."), Some(LIST_RECOVERY.into()))),
        _ => Err(ControlError::new(
            "ambiguous_selector",
            format!("{} paired machines are called {selector}.", named.len()),
            Some("Name it by its id, as terminalx machines list --json prints it.".into()),
        )),
    }
}

/// Why a machine in `state` (a serialized `MachineConnectionState`) cannot
/// take a command now, or `None` when it can, or may within moments (`idle`:
/// the window attaches it; `connecting`: its first round is under way).
pub(crate) fn refusal(name: &str, state: &Value, now_ms: i64) -> Option<ControlError> {
    let ago = |at: Option<i64>| {
        at.map(|at| {
            let seconds = ((now_ms - at).max(0) / 1000) as u64;
            match seconds {
                0..=59 => format!("{seconds} s ago"),
                60..=3599 => format!("{} min ago", seconds / 60),
                _ => format!("{} h ago", seconds / 3600),
            }
        })
    };
    let try_again = Some(format!("Check it with terminalx machines status \"{name}\", and run the command again once it is connected. Nothing was sent."));
    match state["state"].as_str().unwrap_or("idle") {
        "idle" | "connecting" | "direct" | "relay" => None,
        "reconnecting" => Some(ControlError::new(
            OFFLINE,
            format!("{name} is not connected: its link was lost {} and TerminalX is reconnecting.", ago(state["lostAt"].as_i64()).unwrap_or_else(|| "a moment ago".into())),
            try_again,
        )),
        "offline" => Some(ControlError::new(
            OFFLINE,
            match ago(state["lastSeenAt"].as_i64()) {
                Some(ago) => format!("{name} is offline: no route to it answers. It was last seen {ago}."),
                None => format!("{name} is offline: no route to it answers."),
            },
            try_again,
        )),
        "needsUpdate" => {
            let version = state["version"].as_str().map(|version| format!(" (it runs TerminalX {version})")).unwrap_or_default();
            Some(if state["side"].as_str() == Some("thisMac") {
                ControlError::new(NEEDS_UPDATE, format!("{name} runs a newer TerminalX than this computer{version}."), Some("Update TerminalX on this computer.".into()))
            } else {
                ControlError::new(NEEDS_UPDATE, format!("{name} needs a newer TerminalX to work with this computer{version}."), Some(format!("Update TerminalX on {name}, from its page in TerminalX or on the machine itself.")))
            })
        }
        "updating" => Some(ControlError::new(
            UPDATING,
            format!("{name} is updating to TerminalX {}.", state["version"].as_str().unwrap_or("a new version")),
            Some("Run the command again in a minute: it is back in under one.".into()),
        )),
        "accessRemoved" => Some(ControlError::new(
            ACCESS_REMOVED,
            format!("{name} no longer lets this computer operate it."),
            Some(format!("Pair again with a new code from {name}: terminalx machines add --code CODE.")),
        )),
        "disconnected" => Some(ControlError::new(
            DISCONNECTED,
            format!("The person at {name} disconnected this computer."),
            Some(format!("Ask them to let this computer back on {name}, then press Try again in TerminalX.")),
        )),
        other => Some(ControlError::new(OFFLINE, format!("{name} is not connected ({other})."), try_again)),
    }
}

/// A machine's row for `machines list` and `machines status`: its record
/// (`machines_list`) and its connection state, never a credential.
pub(crate) fn row(machine: &Value, state: &Value) -> Value {
    let id = machine["machineId"].as_str().unwrap_or_default();
    json!({
        "machineId": id,
        "key": format!("machine:{id}"),
        "name": machine["name"],
        "os": machine["os"],
        "version": machine["version"],
        "headless": machine.get("hasWindow").and_then(Value::as_bool).map(|window| !window),
        "state": state["state"].as_str().unwrap_or("idle"),
        "connection": state,
        "route": machine["route"],
        "lastRoute": machine.get("lastRoute").cloned().unwrap_or(Value::Null),
        "relay": machine.get("relay").is_some_and(|relay| !relay.is_null()),
        "pairedAt": machine["pairedAt"],
        "lastSeenAt": machine["lastSeenAt"],
    })
}

/// The route a pairing keeps: `relayAndNearby` unless `thisNetwork` is asked for.
pub(crate) fn pairing_route(params: &Value) -> Result<&'static str, ControlError> {
    match params.get("route").and_then(Value::as_str) {
        None | Some("relayAndNearby") => Ok("relayAndNearby"),
        Some("thisNetwork") => Ok("thisNetwork"),
        Some(other) => Err(ControlError::invalid(format!("Unknown route {other}: use relayAndNearby or thisNetwork."))),
    }
}

/// Only the fingerprint's letters and digits count: `cef4 2468…` is `CEF4·2468·…`.
fn fingerprint_digits(fingerprint: &str) -> String {
    fingerprint.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_uppercase()).collect()
}

/// `machines add` pairs in two steps, as the Add a machine dialog does: the
/// fingerprint is shown before anything reaches the machine, and the second
/// call names it with `--fingerprint`. The machine's approval asks the person
/// there to allow only a computer showing the same one.
pub(crate) fn fingerprint_gate(name: &str, fingerprint: &str, expires_at: i64, given: Option<&str>) -> Result<(), ControlError> {
    let Some(given) = given.map(str::trim).filter(|given| !given.is_empty()) else {
        let mut error = ControlError::new(
            "fingerprint_confirmation_required",
            format!("Pairing with {name} shows the fingerprint {fingerprint}. Nothing was sent to {name} yet."),
            Some(format!(
                "Run the same command with --fingerprint \"{fingerprint}\". {name} then asks its person to Allow this computer; they should allow it only if {name} shows {fingerprint} too."
            )),
        );
        error.details = Some(json!({ "machine": name, "fingerprint": fingerprint, "expiresAt": expires_at }));
        return Err(error);
    };
    if fingerprint_digits(given) != fingerprint_digits(fingerprint) {
        let mut error = ControlError::new(
            "pairing_fingerprint_mismatch",
            format!("This code gives the fingerprint {fingerprint}, not {given}. Nothing was sent to {name}."),
            Some("Check that the code is the one the machine shows now; run machines add without --fingerprint to see its fingerprint.".to_string()),
        );
        error.details = Some(json!({ "machine": name, "fingerprint": fingerprint }));
        return Err(error);
    }
    Ok(())
}

/// A pairing that did not pair, by `MachinePairingFailure`, as the CLI's error.
pub(crate) fn pairing_refusal(reason: &str, message: &str) -> ControlError {
    let recovery = match reason {
        "not-approved" => "Ask the person at the machine to press Allow, then run terminalx machines add again with a new code.",
        "code-inactive" => "Make a new code on the machine (Settings → Machines) and pair with it.",
        "another-computer" => "Another computer is waiting for approval there. Try again once it is answered.",
        "pairing-paused" => "Too many wrong attempts: wait a minute, then try again.",
        "unreachable" => "Check that the machine is on and reachable on this network or Tailscale, or sign both in to use the relay.",
        "invalid-code" => "Copy the whole code from the machine (it starts with txm2.).",
        "sign-in-required" => "Sign in to TerminalX on this Mac (the machine is reached through the relay), then pair again with a new code.",
        _ => "Try again with a new code.",
    };
    let mut error = ControlError::new(&format!("pairing_{}", reason.replace('-', "_")), message.to_string(), Some(crate::platform_profile::localize(recovery)));
    error.details = Some(json!({ "reason": reason }));
    error
}

/// The params the window gets: the machine as resolved here (the CLI may
/// have named it by its name), once every `machine:` key in them is checked
/// to be on that machine.
pub(crate) fn window_params(machine: &Value, mut params: Value) -> Result<Value, ControlError> {
    let id = machine["machineId"].as_str().unwrap_or_default().to_string();
    let name = machine["name"].as_str().unwrap_or_default().to_string();
    for field in ["target", "session", "project"] {
        if let Some(key) = params.get(field).and_then(Value::as_str) {
            if let Some(keyed) = key_machine(key) {
                if keyed != id {
                    return Err(ControlError::invalid(format!("{key} is on another machine than {name}.")));
                }
            }
        }
    }
    if let Some(sessions) = params.get("sessions").and_then(Value::as_array) {
        for key in sessions.iter().filter_map(Value::as_str) {
            if key_machine(key).is_some_and(|keyed| keyed != id) {
                return Err(ControlError::invalid(format!("{key} is on another machine than {name}.")));
            }
        }
    }
    params["machine"] = json!({ "machineId": id, "name": name });
    Ok(params)
}

#[cfg(feature = "desktop")]
pub(crate) use desktop::execute;

#[cfg(feature = "desktop")]
mod desktop {
    use std::sync::Arc;

    use serde_json::{json, Value};

    use super::*;
    use crate::machines::connect::MachineConnections;
    use crate::sink::EventSink;

    fn internal(error: impl std::fmt::Display) -> ControlError {
        ControlError::internal(error)
    }

    /// Every paired machine's record and state, as JSON.
    fn machines_and_states(connections: &MachineConnections) -> Result<Vec<(Value, Value)>, ControlError> {
        let machines = connections.paired().map_err(internal)?;
        let views = connections.views().map_err(internal)?;
        Ok(machines
            .into_iter()
            .map(|machine| {
                let state = views
                    .iter()
                    .find(|view| view.machine_id == machine.machine_id)
                    .and_then(|view| serde_json::to_value(&view.state).ok())
                    .unwrap_or_else(|| json!({ "state": "idle" }));
                (serde_json::to_value(&machine).unwrap_or(Value::Null), state)
            })
            .collect())
    }

    fn one<'a>(all: &'a [(Value, Value)], selector: &str) -> Result<&'a (Value, Value), ControlError> {
        let records: Vec<Value> = all.iter().map(|(machine, _)| machine.clone()).collect();
        let found = resolve(&records, selector)?;
        let id = found["machineId"].as_str();
        all.iter().find(|(machine, _)| machine["machineId"].as_str() == id).ok_or_else(|| ControlError::new(UNKNOWN, format!("No paired machine is called {selector}."), Some(LIST_RECOVERY.into())))
    }

    fn selector(params: &Value) -> Result<String, ControlError> {
        params
            .get("machine")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| ControlError::invalid("Name the machine with --machine NAME, or use a machine: key."))
    }

    /// Run `machine.<action>`.
    pub(crate) fn execute(connections: &Arc<MachineConnections>, sink: &dyn EventSink, action: &str, params: Value) -> Result<Value, ControlError> {
        // Machines are on for everyone (PRO-360); what a command can reach is the machines the person paired
        // in the app. Data privacy mode makes no machine connection (PRO-357), so it answers nothing here either.
        if crate::data_privacy::enabled() {
            return Err(ControlError::new(
                DISABLED,
                "Data privacy mode is on, so this computer operates no machine.",
                Some("Turn off data privacy mode in TerminalX to operate your machines.".into()),
            ));
        }
        match action {
            "list" => {
                let rows: Vec<Value> = machines_and_states(connections)?.iter().map(|(machine, state)| row(machine, state)).collect();
                Ok(json!({ "machines": rows }))
            }
            "status" => {
                let all = machines_and_states(connections)?;
                let (machine, state) = one(&all, &selector(&params)?)?;
                let mut status = row(machine, state);
                status["problem"] = match refusal(machine["name"].as_str().unwrap_or_default(), state, chrono::Utc::now().timestamp_millis()) {
                    Some(error) => json!({ "code": error.code, "message": error.message, "recovery": error.recovery }),
                    None => Value::Null,
                };
                Ok(status)
            }
            "add" => add(connections, sink, &params),
            "remove" => {
                let all = machines_and_states(connections)?;
                let (machine, _) = one(&all, &selector(&params)?)?;
                let name = machine["name"].as_str().unwrap_or_default();
                if params.get("confirmed").and_then(Value::as_bool) != Some(true) {
                    return Err(ControlError::new(
                        "confirmation_required",
                        format!("Removing {name} forgets it on this computer: its connection, its record and its credentials. Its sessions keep running there, and pairing again needs a new code from it."),
                        Some("Pass --yes to remove it.".into()),
                    ));
                }
                let id = machine["machineId"].as_str().unwrap_or_default().to_string();
                let removed = connections.forget(&id).map_err(internal)?;
                Ok(json!({ "machineId": id, "name": name, "removed": removed }))
            }
            "sessions.listAll" => crate::cloud_control::call_event(sink, REQUEST_EVENT, action, params.clone(), timeout_for(action, &params)),
            _ if WINDOW_ACTIONS.contains(&action) => {
                let all = machines_and_states(connections)?;
                let (machine, state) = one(&all, &selector(&params)?)?;
                if let Some(error) = refusal(machine["name"].as_str().unwrap_or_default(), state, chrono::Utc::now().timestamp_millis()) {
                    return Err(error);
                }
                let params = window_params(machine, params)?;
                crate::cloud_control::call_event(sink, REQUEST_EVENT, action, params.clone(), timeout_for(action, &params))
            }
            other => Err(ControlError::invalid(format!("Unknown machine command {other}."))),
        }
    }

    /// Pair with the machine of a code, as the Add a machine dialog does: the
    /// first call shows the fingerprint, and one naming it (`--fingerprint`)
    /// waits for the person at the machine to press Allow.
    fn add(connections: &Arc<MachineConnections>, sink: &dyn EventSink, params: &Value) -> Result<Value, ControlError> {
        let code = params.get("code").and_then(Value::as_str).map(str::trim).filter(|code| !code.is_empty()).ok_or_else(|| ControlError::invalid("--code needs the pairing code the machine shows."))?;
        let route = pairing_route(params)?;
        let machines = connections.machines().clone();
        let inspected = match machines.inspect(code) {
            Ok(inspected) => inspected,
            Err(error) => {
                let text = format!("{error:#}");
                return Err(pairing_refusal("invalid-code", text.strip_prefix("invalid-code: ").unwrap_or(&text)));
            }
        };
        let inspected = serde_json::to_value(&inspected).map_err(internal)?;
        if inspected["alreadyPaired"].as_bool() == Some(true) {
            let all = machines_and_states(connections)?;
            let id = inspected["machine"]["machineId"].as_str().unwrap_or_default();
            if let Some((machine, state)) = all.iter().find(|(machine, _)| machine["machineId"].as_str() == Some(id)) {
                let mut answer = row(machine, state);
                answer["alreadyPaired"] = json!(true);
                return Ok(answer);
            }
        }
        let name = inspected["machine"]["name"].as_str().unwrap_or("the machine");
        let fingerprint = inspected["fingerprint"].as_str().unwrap_or_default();
        fingerprint_gate(name, fingerprint, inspected["expiresAt"].as_i64().unwrap_or_default(), params.get("fingerprint").and_then(Value::as_str))?;
        let route = serde_json::from_value(json!(route)).map_err(internal)?;
        let result = tauri::async_runtime::block_on(machines.pair(code.to_string(), route)).map_err(internal)?;
        let result = serde_json::to_value(&result).map_err(internal)?;
        if result["paired"].as_bool() != Some(true) {
            return Err(pairing_refusal(result["reason"].as_str().unwrap_or("unknown"), result["message"].as_str().unwrap_or("The machine was not paired.")));
        }
        let machine = &result["machine"];
        // The window reads its machines again when it hears of one it does not know, and attaches it.
        let id = machine["machineId"].as_str().unwrap_or_default();
        sink.emit(crate::machines::connect::CONNECTION_CHANGED_EVENT, &json!({ "machineId": id, "state": { "state": "idle" } }));
        let mut answer = row(machine, &json!({ "state": "idle" }));
        answer["fingerprint"] = inspected["fingerprint"].clone();
        answer["alreadyPaired"] = json!(false);
        Ok(answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `machines list` and `machines status` print, which a Read and report bot may run unasked
    /// (`bots::access::TERMINALX_READS`, PRO-494): a machine's name, system, version, state and the route
    /// it was last reached by. Never its pinned host key, the addresses it offered, where its relay is or
    /// a credential: those stay in `machines.json` and the Keychain.
    #[test]
    fn a_row_carries_no_key_address_list_relay_or_credential() {
        let machine = json!({
            "machineId": "m1", "name": "Mac mini", "os": {"family": "macos"}, "version": "0.2.40",
            "publicKeyB64": "c2VjcmV0LWtleQ==", "directEndpoints": ["192.168.1.20:6768", "100.64.0.7:6768"], "route": "relayAndNearby",
            "pairedAt": 1, "lastSeenAt": 2, "lastRoute": {"kind": "lan", "endpoint": "192.168.1.20:6768"},
            "relay": {"directorUrl": "https://relay.example/d", "cellUrl": "https://cell.example/c", "assignmentEpoch": 3, "userId": "u1"},
            "token": "t0k3n", "secret": "s3cret",
        });
        let state = json!({"state": "direct", "route": {"kind": "lan", "endpoint": "192.168.1.20:6768"}, "since": 5, "rttMs": 3});
        let row = row(&machine, &state);
        let text = row.to_string();
        for hidden in ["c2VjcmV0LWtleQ==", "100.64.0.7", "relay.example", "cell.example", "u1", "t0k3n", "s3cret", "publicKey", "directEndpoints"] {
            assert!(!text.contains(hidden), "{hidden} in {text}");
        }
        assert_eq!(row["relay"], true);
        let mut keys: Vec<&str> = row.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["connection", "headless", "key", "lastRoute", "lastSeenAt", "machineId", "name", "os", "pairedAt", "relay", "route", "state", "version"]);
    }

    fn machines() -> Vec<Value> {
        vec![
            json!({ "machineId": "m1", "name": "Mac mini", "os": { "family": "macos" }, "version": "0.2.40", "route": "relayAndNearby", "pairedAt": 1, "lastSeenAt": 2 }),
            json!({ "machineId": "m2", "name": "build-box", "os": { "family": "linux" }, "version": "0.2.38", "route": "thisNetwork", "pairedAt": 1, "lastSeenAt": null, "hasWindow": false }),
            json!({ "machineId": "m3", "name": "Twin", "version": "0.2.40" }),
            json!({ "machineId": "m4", "name": "twin", "version": "0.2.40" }),
        ]
    }

    #[test]
    fn a_selector_names_a_machine_by_id_key_or_name() {
        let all = machines();
        assert_eq!(resolve(&all, "m2").unwrap()["name"], "build-box");
        assert_eq!(resolve(&all, "machine:m1").unwrap()["name"], "Mac mini");
        assert_eq!(resolve(&all, "machine:m1:p1:s1").unwrap()["name"], "Mac mini");
        assert_eq!(resolve(&all, "mac MINI").unwrap()["machineId"], "m1");
        assert_eq!(resolve(&all, "  Mac mini ").unwrap()["machineId"], "m1");
        // An unknown machine has its own code, and so does a name two machines share.
        assert_eq!(resolve(&all, "Studio").unwrap_err().code, UNKNOWN);
        assert_eq!(resolve(&all, "machine:nope").unwrap_err().code, UNKNOWN);
        assert_eq!(resolve(&all, "twin").unwrap_err().code, "ambiguous_selector");
        assert_eq!(resolve(&all, "m3").unwrap()["name"], "Twin");
        assert_eq!(resolve(&all, " ").unwrap_err().code, "invalid_arguments");
        assert_eq!(resolve(&[], "Mac mini").unwrap_err().code, UNKNOWN);
    }

    #[test]
    fn each_state_that_cannot_answer_has_its_own_code_and_none_waits() {
        let now = 1_000_000;
        for state in [json!({ "state": "idle" }), json!({ "state": "connecting", "trying": ["lan"] }), json!({ "state": "direct", "route": { "kind": "lan" }, "since": 1, "rttMs": 3 }), json!({ "state": "relay", "route": { "kind": "relay" }, "since": 1, "rttMs": null })] {
            assert!(refusal("Mac mini", &state, now).is_none(), "{state}");
        }
        let offline = refusal("Mac mini", &json!({ "state": "offline", "lastSeenAt": now - 120_000, "retryInMs": 10_000 }), now).unwrap();
        assert_eq!(offline.code, OFFLINE);
        assert!(offline.message.contains("last seen 2 min ago"), "{}", offline.message);
        assert!(offline.recovery.unwrap().contains("Nothing was sent"));
        let never = refusal("Mac mini", &json!({ "state": "offline", "lastSeenAt": null, "retryInMs": 10_000 }), now).unwrap();
        assert_eq!(never.message, "Mac mini is offline: no route to it answers.");
        let lost = refusal("Mac mini", &json!({ "state": "reconnecting", "lostAt": now - 5_000, "attempt": 2, "retryInMs": 500, "trying": [] }), now).unwrap();
        assert_eq!(lost.code, OFFLINE);
        assert!(lost.message.contains("5 s ago"));
        let older = refusal("Mac mini", &json!({ "state": "needsUpdate", "version": "0.2.10", "side": "machine" }), now).unwrap();
        assert_eq!(older.code, NEEDS_UPDATE);
        assert!(older.message.contains("0.2.10") && older.recovery.unwrap().contains("on Mac mini"));
        let newer = refusal("Mac mini", &json!({ "state": "needsUpdate", "version": null, "side": "thisMac" }), now).unwrap();
        assert_eq!(newer.recovery.as_deref(), Some("Update TerminalX on this computer."));
        assert_eq!(refusal("Mac mini", &json!({ "state": "updating", "version": "0.2.41", "since": 1 }), now).unwrap().code, UPDATING);
        assert_eq!(refusal("Mac mini", &json!({ "state": "accessRemoved" }), now).unwrap().code, ACCESS_REMOVED);
        assert_eq!(refusal("Mac mini", &json!({ "state": "disconnected" }), now).unwrap().code, DISCONNECTED);
        // The codes are distinct from one another and from a timeout.
        let codes = [UNKNOWN, OFFLINE, NEEDS_UPDATE, UPDATING, ACCESS_REMOVED, DISCONNECTED, DISABLED, UNSUPPORTED];
        assert_eq!(codes.iter().collect::<std::collections::HashSet<_>>().len(), codes.len());
        assert!(!codes.contains(&"timeout") && !codes.contains(&"cloud_unavailable"));
    }

    #[test]
    fn a_row_carries_the_record_and_state_but_no_credential() {
        let all = machines();
        let row = row(&all[1], &json!({ "state": "offline", "lastSeenAt": null, "retryInMs": 10_000 }));
        assert_eq!(row["key"], "machine:m2");
        assert_eq!(row["state"], "offline");
        assert_eq!(row["headless"], true);
        assert_eq!(row["relay"], false);
        assert_eq!(super::row(&all[0], &json!({ "state": "idle" }))["headless"], Value::Null);
        let with_relay = json!({ "machineId": "m5", "name": "R", "relay": { "relayDeviceId": "d", "userId": "u" }, "publicKeyB64": "secret-ish" });
        let row = super::row(&with_relay, &json!({ "state": "idle" }));
        assert_eq!(row["relay"], true);
        assert!(!row.to_string().contains("relayDeviceId") && !row.to_string().contains("publicKeyB64"));
    }

    #[test]
    fn a_target_must_be_on_the_machine_named() {
        let all = machines();
        let params = window_params(&all[0], json!({ "machine": "Mac mini", "target": "machine:m1:p:s", "sessions": ["machine:m1:p:s2", "s3"] })).unwrap();
        assert_eq!(params["machine"], json!({ "machineId": "m1", "name": "Mac mini" }));
        assert_eq!(window_params(&all[0], json!({ "target": "machine:m2:p:s" })).unwrap_err().code, "invalid_arguments");
        assert_eq!(window_params(&all[0], json!({ "project": "machine:m2:p" })).unwrap_err().code, "invalid_arguments");
        assert_eq!(window_params(&all[0], json!({ "sessions": ["machine:m1:p:s", "machine:m2:p:s"] })).unwrap_err().code, "invalid_arguments");
    }

    #[test]
    fn pairing_answers_name_the_route_and_each_failure() {
        assert_eq!(pairing_route(&json!({})).unwrap(), "relayAndNearby");
        assert_eq!(pairing_route(&json!({ "route": "thisNetwork" })).unwrap(), "thisNetwork");
        assert_eq!(pairing_route(&json!({ "route": "lan" })).unwrap_err().code, "invalid_arguments");
        let refused = pairing_refusal("not-approved", "The machine did not allow it.");
        assert_eq!(refused.code, "pairing_not_approved");
        assert_eq!(refused.details, Some(json!({ "reason": "not-approved" })));
        assert_eq!(pairing_refusal("code-inactive", "").code, "pairing_code_inactive");
    }

    #[test]
    fn every_machine_command_is_known_and_times_out_after_the_window() {
        for action in NATIVE_ACTIONS.iter().chain(WINDOW_ACTIONS.iter()) {
            assert!(supported(&format!("machine.{action}")), "{action}");
        }
        assert!(!supported("machine.exec") && !supported("machines.list") && !supported("cloud.send"));
        assert_eq!(timeout_for("wait", &json!({ "timeoutSeconds": 600 })), Duration::from_secs(WAIT_CHUNK_SECONDS + 20));
        assert_eq!(timeout_for("wait", &json!({ "timeoutSeconds": 5 })), Duration::from_secs(25));
        assert!(timeout_for("add", &json!({})) > Duration::from_secs(120));
        assert_eq!(key_machine("machine:m1:p:s"), Some("m1"));
        assert_eq!(key_machine("machine:"), None);
        assert_eq!(key_machine("cloud:o:w"), None);
    }

    #[test]
    fn machines_add_shows_the_fingerprint_before_it_pairs() {
        let shown = fingerprint_gate("Mac mini", "CEF4\u{00B7}2468\u{00B7}FE26\u{00B7}9E4B", 7, None).unwrap_err();
        assert_eq!(shown.code, "fingerprint_confirmation_required");
        assert_eq!(shown.details.as_ref().unwrap()["fingerprint"], "CEF4\u{00B7}2468\u{00B7}FE26\u{00B7}9E4B");
        assert!(fingerprint_gate("Mac mini", "CEF4\u{00B7}2468\u{00B7}FE26\u{00B7}9E4B", 7, Some("  ")).is_err());
        assert!(fingerprint_gate("Mac mini", "CEF4\u{00B7}2468\u{00B7}FE26\u{00B7}9E4B", 7, Some("cef4 2468 fe26 9e4b")).is_ok());
        assert!(fingerprint_gate("Mac mini", "CEF4\u{00B7}2468\u{00B7}FE26\u{00B7}9E4B", 7, Some("CEF4\u{00B7}2468\u{00B7}FE26\u{00B7}9E4B")).is_ok());
        assert_eq!(fingerprint_gate("Mac mini", "CEF4\u{00B7}2468\u{00B7}FE26\u{00B7}9E4B", 7, Some("CEF4-2468-FE26-0000")).unwrap_err().code, "pairing_fingerprint_mismatch");
    }

}
