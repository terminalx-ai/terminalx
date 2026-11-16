//! Put a newly installed runtime in place of the running one without stopping
//! anything it runs: `update` and a second run of the installer use this
//! instead of restarting the service, which would end every agent and terminal
//! (the unit's whole control group).
//!
//! It is the desktop's own update path (#765, `local_runtime::handover`): the
//! new binary is copied into the runtime's home as an installed runtime (a
//! private folder named for its digest), the runtime is asked what it could
//! not carry over (`runtime.handover.plan`), and then hands itself over in its
//! own process (`runtime.handover`). The pid stays, so the service manager
//! sees the same service, and the agents stay its children.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::local_runtime::client::Client;
use crate::remote::machine_update::Blocker;

/// Checking a binary new to this machine may take a while (macOS checks it).
const PLAN_WITHIN: Duration = Duration::from_secs(45);
const HANDOVER_WITHIN: Duration = Duration::from_secs(90);
/// How long a handover whose reply was lost may take to show its new epoch.
const LOST_REPLY_WITHIN: Duration = Duration::from_secs(15);

/// What happened to the running runtime.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No runtime runs for this data directory: the next start runs the new one.
    NotRunning,
    /// It already runs this version.
    Current,
    /// It now runs the new binary; nothing was stopped.
    HandedOver,
    /// It runs work a handover cannot carry (named here), so it was left as
    /// it is.
    Busy(Vec<String>),
}

/// Hand the runtime of `data` over to `binary` (version `version`).
pub fn hand_over(data: &Path, binary: &Path, version: &str) -> Result<Outcome> {
    let Ok(client) = Client::connect(data) else { return Ok(Outcome::NotRunning) };
    if client.build().version.as_ref().map(ToString::to_string).as_deref() == Some(version) {
        return Ok(Outcome::Current);
    }
    let installed = crate::local_runtime::launch::installed(binary, data).context("install the new runtime in the data directory")?;
    let epoch = client.epoch().to_string();
    let plan: Value = client
        .call_within("runtime.handover.plan", json!({ "epoch": epoch, "binary": installed }), PLAN_WITHIN)
        .context("ask the running runtime whether it can be handed over")?;
    let unadoptable = plan["unadoptable"].as_array().cloned().unwrap_or_default();
    if !unadoptable.is_empty() {
        let named = unadoptable
            .iter()
            .map(|work| work["title"].as_str().or(work["kind"].as_str()).unwrap_or("a piece of work").to_string())
            .collect();
        return Ok(Outcome::Busy(named));
    }
    let _: Value = client
        .call_within("runtime.handover", json!({ "epoch": epoch, "binary": installed, "stop": [] }), HANDOVER_WITHIN)
        .context("hand the running runtime over")?;
    crate::local_runtime::launch::taken_over(data, &epoch, HANDOVER_WITHIN)?;
    Ok(Outcome::HandedOver)
}

/// How [`begin`] left the running runtime (PRO-354).
#[derive(Debug, PartialEq, Eq)]
pub enum Handed {
    /// No runtime runs for this data directory.
    NotRunning,
    /// It refused, or runs work nobody agreed to stop: it runs on as it
    /// was, and nothing was stopped. Says why.
    Refused(String),
    /// It began the handover: the process of runtime `epoch` now execs the
    /// new binary. Whether it came up is the caller's to check.
    Exec { epoch: String },
}

/// Hand the runtime of `data` over to `binary`, stopping only the work
/// whose blocker ids (`remote::machine_update::Blocker::of`) are in `stop`:
/// `machine.update`'s handover, whatever the version the runtime says.
pub fn begin(data: &Path, binary: &Path, stop: &[String]) -> Result<Handed> {
    let Ok(client) = Client::connect(data) else { return Ok(Handed::NotRunning) };
    let installed = crate::local_runtime::launch::installed(binary, data).context("install the new runtime in the data directory")?;
    let epoch = client.epoch().to_string();
    let plan: Value = match client.call_within("runtime.handover.plan", json!({ "epoch": epoch, "binary": installed }), PLAN_WITHIN) {
        Ok(plan) => plan,
        Err(error) => return Ok(Handed::Refused(format!("The running runtime cannot be handed over: {error:#}"))),
    };
    let unadoptable = plan["unadoptable"].as_array().cloned().unwrap_or_default();
    let (agreed, unagreed): (Vec<Value>, Vec<Value>) = unadoptable.into_iter().partition(|work| stop.contains(&Blocker::of(work).id));
    if !unagreed.is_empty() {
        let named: Vec<String> = unagreed.iter().map(|work| Blocker::of(work).title).collect();
        return Ok(Handed::Refused(format!("The running runtime runs work an update cannot carry over, which nobody agreed to stop ({}); nothing was stopped", named.join("; "))));
    }
    match client.call_within::<Value>("runtime.handover", json!({ "epoch": epoch, "binary": installed, "stop": agreed }), HANDOVER_WITHIN) {
        Ok(_) => Ok(Handed::Exec { epoch }),
        // The reply may be lost to the exec itself: a runtime under a new
        // epoch says it began.
        Err(error) => match crate::local_runtime::launch::taken_over(data, &epoch, LOST_REPLY_WITHIN) {
            Ok(()) => Ok(Handed::Exec { epoch }),
            Err(_) => Ok(Handed::Refused(format!("The running runtime was not handed over: {error:#}"))),
        },
    }
}

/// Say what [`hand_over`] did, for a person who just installed `version`.
/// Whether the running runtime now runs it (or none runs).
pub fn report(outcome: &Outcome, version: &str) -> bool {
    match outcome {
        Outcome::NotRunning => {
            println!("The runtime is not running; it starts as terminalx-serve {version}.");
            true
        }
        Outcome::Current => {
            println!("The running runtime is terminalx-serve {version}.");
            true
        }
        Outcome::HandedOver => {
            println!("The running runtime now is terminalx-serve {version}; its agents and terminals kept running.");
            true
        }
        Outcome::Busy(named) => {
            eprintln!("The running runtime keeps its old version for now: it runs work an update cannot carry over without stopping it:");
            for work in named {
                eprintln!("  - {work}");
            }
            eprintln!("Run `terminalx-serve update` again when that work is done; terminalx-serve {version} is installed and starts with the service.");
            false
        }
    }
}
