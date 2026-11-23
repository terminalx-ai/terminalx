//! `terminalx-serve devices`: the computers that may operate this one, and
//! `devices revoke <id>`, which removes one. Its connections close at once
//! and its credential is refused after (docs/MACHINES.md, decision 9).
//!
//! The running runtime answers both, so the list says which computers are
//! connected now. With no runtime running, they read and change the
//! paired-computer registry in the data directory, which is all a runtime
//! would read when it starts.
//!
//! Paired phones are listed after them, and `revoke` removes one too
//! (PRO-359): a phone a server paired with `pair --phone`, or one a Mac's
//! window paired, since both keep them in the data directory's `devices.json`.

use std::path::Path;

use anyhow::{bail, Result};
use serde_json::json;

use super::control_client::{self, Runtime};
use crate::machine_host::registry::Registry;
use crate::machine_wire::{self, ComputerSummary};

const USAGE: &str = "\
Usage: terminalx-serve devices [--data-dir <dir>]
       terminalx-serve devices revoke <id> [--data-dir <dir>]

  devices         List the computers and phones that may operate this one
  revoke <id>     Remove one: its connections close and it must pair again";

/// Run `terminalx-serve devices` with the arguments after its name.
pub fn run(args: &[String]) -> i32 {
    match dispatch(args) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("terminalx-serve devices: {error:#}");
            1
        }
    }
}

fn dispatch(args: &[String]) -> Result<i32> {
    let (flag, rest) = super::take_data_dir(args)?;
    let rest: Vec<&str> = rest.iter().map(String::as_str).collect();
    match rest.as_slice() {
        ["-h" | "--help" | "help"] => {
            println!("{USAGE}");
            Ok(0)
        }
        [] | ["list"] => {
            let data = super::resolve_data_dir(flag.as_deref())?;
            let (hosting, computers) = list(&data)?;
            print!("{}", table(hosting, &computers));
            print!("{}", phone_table(&phones(&data)?));
            Ok(0)
        }
        ["revoke", id] => {
            let data = super::resolve_data_dir(flag.as_deref())?;
            revoke(&data, id)
        }
        _ => {
            eprintln!("{USAGE}");
            Ok(2)
        }
    }
}

/// Whether hosting is on (`None` without a runtime to ask), and the paired
/// computers.
fn list(data: &Path) -> Result<(Option<bool>, Vec<ComputerSummary>)> {
    if let Ok(runtime) = Runtime::connect(data) {
        let status = runtime.status()?;
        return Ok((Some(status.enabled), status.computers));
    }
    let computers = Registry::in_data_dir(data)
        .list()?
        .into_iter()
        .map(|computer| ComputerSummary {
            key_id: computer.client_public_key_b64.as_deref().and_then(machine_wire::key_id_of),
            // Without a runtime nothing is connected.
            route: None,
            id: computer.id,
            label: computer.label,
            platform: computer.platform,
            approved_at: computer.approved_at,
            last_seen_at: computer.last_seen_at,
            connected: false,
            disconnected_at: computer.disconnected_at,
        })
        .collect();
    Ok((None, computers))
}

/// A paired phone as `devices` lists it.
struct Phone {
    id: String,
    label: String,
    platform: String,
    last_seen_at: Option<String>,
    connected: bool,
}

/// The phones that paired here, and which the runtime serves now.
fn phones(data: &Path) -> Result<Vec<Phone>> {
    let connected = match Runtime::connect(data) {
        Ok(runtime) => runtime.status()?.phones.connected,
        Err(_) => Vec::new(),
    };
    Ok(crate::phone::registry::list_in(data)?
        .into_iter()
        // A code nobody used is no phone yet; session invitations are the window's.
        .filter(|device| device.last_seen_at.is_some() && device.scope != crate::local_runtime::mobile::model::DeviceScope::Session)
        .map(|device| Phone {
            connected: connected.contains(&device.id),
            id: device.id,
            label: device.label,
            platform: device.platform,
            last_seen_at: device.last_seen_at,
        })
        .collect())
}

fn revoke_phone(data: &Path, phone: &Phone) -> Result<i32> {
    let removed = if control_client::running(data) {
        let runtime = Runtime::connect(data)?;
        let attachment = runtime.attach()?;
        match attachment.call(machine_wire::PHONE_REVOKE, json!({ "id": phone.id })) {
            Ok(answer) => answer["revoked"].as_bool().unwrap_or(false),
            Err(error) if control_client::refusal_code(&error) == Some("window_takes_phones") => {
                eprintln!("TerminalX is open on this Mac and serves its phones: remove {} in Settings → Devices.", phone.label);
                return Ok(1);
            }
            Err(error) => return Err(error),
        }
    } else {
        crate::phone::registry::revoke_in(data, &phone.id)?.is_some()
    };
    if !removed {
        bail!("{} ({}) was not removed", phone.label, phone.id);
    }
    println!("Removed {} ({}). It must pair again to reach this computer.", phone.label, phone.id);
    Ok(0)
}

fn revoke(data: &Path, id: &str) -> Result<i32> {
    if let Some(phone) = phones(data)?.into_iter().find(|phone| phone.id == id) {
        return revoke_phone(data, &phone);
    }
    let (_, computers) = list(data)?;
    let Some(computer) = computers.iter().find(|computer| computer.id == id) else {
        eprintln!("No paired computer or phone has the id {id:?}. `terminalx-serve devices` lists them.");
        return Ok(1);
    };
    let removed = if control_client::running(data) {
        let runtime = Runtime::connect(data)?;
        let attachment = runtime.attach()?;
        let answer = attachment.call(machine_wire::REVOKE, json!({ "id": id }))?;
        answer["revoked"].as_bool().unwrap_or(false)
    } else {
        // No runtime to note it: the activity log is written here, as the
        // runtime would (PRO-357).
        let registry = Registry::in_data_dir(data);
        let removed = registry.remove(id)?;
        if removed {
            if let Some(dir) = registry.path().parent() {
                crate::machine_host::activity::Log::in_dir(dir).note(&crate::machine_host::activity::Entry::new(
                    crate::machine_host::activity::Kind::Revoked,
                    Some((id, &computer.label)),
                    None,
                ))?;
            }
        }
        removed
    };
    if !removed {
        bail!("{} ({id}) was not removed", computer.label);
    }
    println!("Removed {} ({id}). It may not operate this computer until it pairs again.", computer.label);
    Ok(0)
}

/// A paired computer's state in the list.
fn seen(computer: &ComputerSummary) -> String {
    if computer.connected {
        return "connected now".into();
    }
    match computer.last_seen_at {
        Some(at) => format!("last seen {}", when(at)),
        None => "never connected".into(),
    }
}

fn when(at_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(at_ms)
        .map(|at| at.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "at an unknown time".into())
}

/// The phones, after the computers. Nothing without any.
fn phone_table(phones: &[Phone]) -> String {
    if phones.is_empty() {
        return String::new();
    }
    let rows: Vec<[String; 4]> = phones
        .iter()
        .map(|phone| {
            let state = if phone.connected {
                "connected now".to_string()
            } else {
                match phone.last_seen_at.as_deref().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()) {
                    Some(at) => format!("last seen {}", when(at.timestamp_millis())),
                    None => "never connected".into(),
                }
            };
            [phone.id.clone(), phone.label.clone(), phone.platform.clone(), state]
        })
        .collect();
    let header = ["ID", "PHONE", "PLATFORM", "STATE"];
    columns(&header, &rows)
}

/// Rows under a header, each column as wide as its widest cell.
fn columns<const N: usize>(header: &[&str; N], rows: &[[String; N]]) -> String {
    let widths: Vec<usize> = (0..N)
        .map(|column| rows.iter().map(|row| row[column].chars().count()).chain([header[column].len()]).max().unwrap_or(0))
        .collect();
    let line = |cells: &[&str]| {
        let mut line = cells.iter().zip(&widths).map(|(cell, width)| format!("{cell:<width$}")).collect::<Vec<_>>().join("  ");
        line.truncate(line.trim_end().len());
        line.push('\n');
        line
    };
    let mut out = String::from("\n");
    out.push_str(&line(header));
    for row in rows {
        out.push_str(&line(&row.iter().map(String::as_str).collect::<Vec<_>>()));
    }
    out
}

/// The list as `devices` prints it.
fn table(hosting: Option<bool>, computers: &[ComputerSummary]) -> String {
    let mut out = String::new();
    out.push_str(match hosting {
        Some(true) => "Other computers may operate this one.\n",
        Some(false) => "Other computers may not operate this one now (`terminalx-serve pair` turns it on).\n",
        None => "The runtime is not running; these may operate this computer while it runs with hosting on.\n",
    });
    if computers.is_empty() {
        out.push_str("No computer is paired. `terminalx-serve pair` pairs one.\n");
        return out;
    }
    let rows: Vec<[String; 5]> = computers
        .iter()
        .map(|computer| [computer.id.clone(), computer.label.clone(), computer.platform.clone().unwrap_or_else(|| "-".into()), when(computer.approved_at), seen(computer)])
        .collect();
    out.push_str(&columns(&["ID", "NAME", "PLATFORM", "APPROVED", "STATE"], &rows));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine_host::registry::{token_hash, PairedComputer};

    fn computer(id: &str, label: &str, connected: bool) -> ComputerSummary {
        ComputerSummary { id: id.into(), label: label.into(), platform: Some("macos".into()), approved_at: 1_763_200_000_000, last_seen_at: None, connected, key_id: None, route: None, disconnected_at: None }
    }

    #[test]
    fn the_list_names_each_computer_and_whether_it_is_connected() {
        let printed = table(Some(true), &[computer("computer-0123456789abcdef", "Sam's MacBook Pro", true), computer("computer-2", "Studio", false)]);
        let lines: Vec<&str> = printed.lines().collect();
        assert_eq!(lines[0], "Other computers may operate this one.");
        assert!(lines[2].starts_with("ID  ") && lines[2].contains("NAME") && lines[2].ends_with("STATE"), "{printed}");
        assert!(lines[3].starts_with("computer-0123456789abcdef  Sam's MacBook Pro  macos") && lines[3].ends_with("connected now"), "{printed}");
        assert!(lines[4].ends_with("never connected"), "{printed}");
        assert!(table(Some(false), &[]).contains("No computer is paired"));
        assert!(table(None, &[]).starts_with("The runtime is not running"));
    }

    #[test]
    fn without_a_runtime_the_registry_is_listed_and_changed() {
        let data = tempfile::tempdir().unwrap();
        Registry::in_data_dir(data.path())
            .put(PairedComputer {
                id: "computer-a".into(),
                token_hash: token_hash("token-a-000000000000000000000000000"),
                label: "Sam's MacBook Pro".into(),
                platform: Some("macos".into()),
                client_public_key_b64: None,
                fingerprint: None,
                approved_at: 1,
                last_seen_at: Some(2),
                relay_device_id: None,
                next_token_hash: None,
                disconnected_at: None,
                other: Default::default(),
            })
            .unwrap();
        let (hosting, computers) = list(data.path()).unwrap();
        assert_eq!(hosting, None);
        assert_eq!(computers.len(), 1);
        assert_eq!(computers[0].label, "Sam's MacBook Pro");
        assert!(!computers[0].connected);
        assert_eq!(revoke(data.path(), "computer-b").unwrap(), 1, "an unknown id is refused");
        assert_eq!(revoke(data.path(), "computer-a").unwrap(), 0);
        let registry = Registry::in_data_dir(data.path());
        assert!(registry.list().unwrap().is_empty());
        let logged = crate::machine_host::activity::Log::in_dir(registry.path().parent().unwrap()).recent().unwrap();
        assert_eq!(logged.len(), 1, "a revoke with no runtime is in the activity log too");
        assert_eq!(logged[0].kind, crate::machine_host::activity::Kind::Revoked);
        assert_eq!(logged[0].computer.as_deref(), Some("Sam's MacBook Pro"));
    }

    #[test]
    fn paired_phones_are_listed_and_revoked_without_a_runtime() {
        use crate::local_runtime::mobile::model::{DeviceEntry, DeviceFile, DeviceProvenance, DeviceScope};
        let data = tempfile::tempdir().unwrap();
        let phone = |id: &str, seen: bool, scope: DeviceScope| DeviceEntry {
            id: id.into(),
            label: "Sam's iPhone".into(),
            platform: "ios".into(),
            token: crate::relay_e2ee::token_hash(id),
            scope,
            provenance: DeviceProvenance::Explicit,
            bound_user_id: None,
            binding_generation: 0,
            public_key: String::new(),
            created_at: "2026-11-17T09:00:00Z".into(),
            last_seen_at: seen.then(|| "2026-11-17T09:01:00Z".into()),
            revoked_at: None,
            installation_id: None,
            created_request_id: None,
            fingerprint: None,
            approved_at: None,
            connection: None,
            last_seen_transport: None,
        };
        let file = DeviceFile { devices: vec![phone("paired", true, DeviceScope::Driver), phone("unused-code", false, DeviceScope::Driver), phone("invited", true, DeviceScope::Session)] };
        crate::store::write_json(&data.path().join("devices.json"), &file).unwrap();

        let listed = phones(data.path()).unwrap();
        assert_eq!(listed.iter().map(|phone| phone.id.as_str()).collect::<Vec<_>>(), ["paired"], "only phones that paired, not unused codes or session invitations");
        let printed = phone_table(&listed);
        // Columns are padded to their widest cell or header, so compare cells, not spacing.
        let mut lines = printed.lines().filter(|line| !line.trim().is_empty());
        assert_eq!(lines.next().unwrap().split_whitespace().collect::<Vec<_>>(), ["ID", "PHONE", "PLATFORM", "STATE"], "{printed}");
        let row = lines.next().unwrap();
        assert!(row.starts_with("paired  Sam's iPhone  ios ") && row.contains(" last seen "), "{printed}");
        assert!(lines.next().is_none(), "{printed}");
        assert_eq!(revoke(data.path(), "paired").unwrap(), 0);
        assert!(phones(data.path()).unwrap().is_empty());
        assert_eq!(phone_table(&[]), "", "no phones, no table");
    }

    #[test]
    fn usage_errors_exit_two() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        assert_eq!(run(&args(&["revoke"])), 2);
        assert_eq!(run(&args(&["forget", "x"])), 2);
    }
}
