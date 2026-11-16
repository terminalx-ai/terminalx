//! `terminalx-serve devices`: the computers that may operate this one, and
//! `devices revoke <id>`, which removes one. Its connections close at once
//! and its credential is refused after (docs/MACHINES.md, decision 9).
//!
//! The running runtime answers both, so the list says which computers are
//! connected now. With no runtime running, they read and change the
//! paired-computer registry in the data directory, which is all a runtime
//! would read when it starts.

use std::path::Path;

use anyhow::{bail, Result};
use serde_json::json;

use super::control_client::{self, Runtime};
use crate::machine_host::registry::Registry;
use crate::machine_wire::{self, ComputerSummary};

const USAGE: &str = "\
Usage: terminalx-serve devices [--data-dir <dir>]
       terminalx-serve devices revoke <id> [--data-dir <dir>]

  devices         List the computers that may operate this one
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
        })
        .collect();
    Ok((None, computers))
}

fn revoke(data: &Path, id: &str) -> Result<i32> {
    let (_, computers) = list(data)?;
    let Some(computer) = computers.iter().find(|computer| computer.id == id) else {
        eprintln!("No paired computer has the id {id:?}. `terminalx-serve devices` lists them.");
        return Ok(1);
    };
    let removed = if control_client::running(data) {
        let runtime = Runtime::connect(data)?;
        let attachment = runtime.attach()?;
        let answer = attachment.call(machine_wire::REVOKE, json!({ "id": id }))?;
        answer["revoked"].as_bool().unwrap_or(false)
    } else {
        Registry::in_data_dir(data).remove(id)?
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
    let header = ["ID", "NAME", "PLATFORM", "APPROVED", "STATE"];
    let widths: Vec<usize> = (0..header.len())
        .map(|column| rows.iter().map(|row| row[column].chars().count()).chain([header[column].len()]).max().unwrap_or(0))
        .collect();
    let line = |cells: &[&str]| {
        let mut line = cells.iter().zip(&widths).map(|(cell, width)| format!("{cell:<width$}")).collect::<Vec<_>>().join("  ");
        line.truncate(line.trim_end().len());
        line.push('\n');
        line
    };
    out.push('\n');
    out.push_str(&line(&header));
    for row in &rows {
        out.push_str(&line(&row.iter().map(String::as_str).collect::<Vec<_>>()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::machine_host::registry::{token_hash, PairedComputer};

    fn computer(id: &str, label: &str, connected: bool) -> ComputerSummary {
        ComputerSummary { id: id.into(), label: label.into(), platform: Some("macos".into()), approved_at: 1_763_200_000_000, last_seen_at: None, connected, key_id: None, route: None }
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
        assert!(Registry::in_data_dir(data.path()).list().unwrap().is_empty());
    }

    #[test]
    fn usage_errors_exit_two() {
        let args = |list: &[&str]| list.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        assert_eq!(run(&args(&["revoke"])), 2);
        assert_eq!(run(&args(&["forget", "x"])), 2);
    }
}
