//! Finding the conversation of a CLI the app did not launch (#437).
//!
//! A CLI the app starts is told which conversation to open, or says which it
//! opened through the app's hooks. One the reader typed into a shell has
//! neither: the app only knows its process. Each CLI leaves its own trace of
//! which conversation a process is in, and reading that trace is all this
//! does. Nothing is written, and the process is never signalled or restarted.
//!
//! A CLI is looked at five times a second for as long as it runs, so what
//! each look costs is kept to what it has to: one small file for Claude
//! Code, and for Codex, whose answer takes listing a process's open files,
//! nothing at all until something says the answer may have changed.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use crate::foreground::Agent;
use crate::session::follow::{Glance, Located, Locator, LOCATE_KNOWN, LOCATE_UNKNOWN};

/// The CLIs as they are installed on this machine.
#[derive(Default)]
pub struct Installed {
    /// What each Codex was last found in, by its process.
    codex: Mutex<HashMap<u32, super::codex::by_hand::Seen>>,
}

impl Locator for Installed {
    fn locate(&self, agent: &Agent) -> Option<Located> {
        match agent.harness {
            "claude" => agent.pids.iter().find_map(|pid| super::claude::by_hand::locate(*pid)),
            "codex" => {
                let last = self.codex.lock().unwrap().get(&agent.pid).cloned();
                // Asked without the lock held: listing open files takes a
                // moment, and every other Codex would wait on it.
                let seen = super::codex::by_hand::look(&agent.pids, last)?;
                let found = seen.found.clone();
                let mut all = self.codex.lock().unwrap();
                all.retain(|pid, _| super::host::is_alive(*pid));
                all.insert(agent.pid, seen);
                Some(found)
            }
            _ => None,
        }
    }

    fn glance(&self, agent: &Agent) -> Glance {
        match agent.harness {
            "claude" => agent.pids.iter().find_map(|pid| super::claude::by_hand::glance(*pid)).unwrap_or_default(),
            // Codex says when a turn starts and ends in the rollout itself.
            _ => Glance::default(),
        }
    }

    fn locate_every(&self, _agent: &Agent, settled: bool) -> Duration {
        if settled {
            LOCATE_KNOWN
        } else {
            LOCATE_UNKNOWN
        }
    }

    fn at_once(&self, agent: &Agent) -> bool {
        // One small file. Codex's open files have to be listed.
        agent.harness == "claude"
    }
}
