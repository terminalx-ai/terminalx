//! Finding the conversation of a CLI the app did not launch (#437).
//!
//! A CLI the app starts is told which conversation to open, or says which it
//! opened through the app's hooks. One the reader typed into a shell has
//! neither: the app only knows its process. Each CLI leaves its own trace of
//! which conversation a process is in, and reading that trace is all this
//! does. Nothing is written, and the process is never signalled or restarted.

use std::time::Duration;

use crate::foreground::Agent;
use crate::session::follow::{Activity, Located, Locator, LOCATE_KNOWN, LOCATE_UNKNOWN};

/// The CLIs as they are installed on this machine.
pub struct Installed;

impl Locator for Installed {
    fn locate(&self, agent: &Agent) -> Option<Located> {
        match agent.harness {
            "claude" => agent.pids.iter().find_map(|pid| super::claude::by_hand::locate(*pid)),
            "codex" => agent.pids.iter().rev().find_map(|pid| super::codex::by_hand::locate(*pid)),
            _ => None,
        }
    }

    fn activity(&self, agent: &Agent) -> Option<Activity> {
        match agent.harness {
            "claude" => agent.pids.iter().find_map(|pid| super::claude::by_hand::activity(*pid)),
            // Codex says when a turn starts and ends in the rollout itself.
            _ => None,
        }
    }

    fn locate_every(&self, agent: &Agent, settled: bool) -> Duration {
        match agent.harness {
            // One small file, read with the transcript.
            "claude" => Duration::ZERO,
            // The process's open files have to be listed.
            _ if settled => LOCATE_KNOWN,
            _ => LOCATE_UNKNOWN,
        }
    }
}
