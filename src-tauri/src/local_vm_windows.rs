//! Local VM tasks on a Windows host: the operations the rest of the crate
//! reaches for, each refused with the same explanation until the Windows
//! host side of `local_vm` (Linux guests in Docker Desktop or Podman) is in
//! place. Nothing here pretends to have done anything: every call that would
//! change or report guest state fails before it starts.
use anyhow::{bail, Result};
use serde_json::Value;

use crate::computer_targets::Target;

const UNAVAILABLE: &str = "Local VM tasks are not available on Windows yet. Nothing was created, changed or started.";

pub mod journal {
    /// The Local VM protocol this build speaks; a Windows owner serves none.
    pub const PROTOCOL: u32 = 1;
}

pub mod provisioning {
    pub const PROTOCOL: u64 = 1;
}

pub mod setup {
    pub const PROTOCOL: u64 = 1;
}

pub mod host {
    pub fn root() -> anyhow::Result<std::path::PathBuf> {
        anyhow::bail!(super::UNAVAILABLE)
    }
}

pub mod admission {
    pub fn inspect(_root: &std::path::Path, _target: &crate::computer_targets::Target) -> anyhow::Result<serde_json::Value> {
        anyhow::bail!(super::UNAVAILABLE)
    }

    pub fn reconcile(_root: &std::path::Path, _target: &crate::computer_targets::Target, _marker_digest: &str, _confirm: bool) -> anyhow::Result<serde_json::Value> {
        anyhow::bail!(super::UNAVAILABLE)
    }
}

pub mod attachment {
    use super::*;

    /// What an attachment is bound to; none can exist on Windows yet.
    #[derive(serde::Deserialize)]
    pub struct Binding {}

    pub fn check(_target: &Target, _session_id: &str, _tab_id: &str, _conversation: Option<String>) -> Result<Value> {
        bail!(UNAVAILABLE)
    }

    pub fn inspect(_target: &Target) -> Result<Value> {
        bail!(UNAVAILABLE)
    }

    pub fn reconcile(_target: &Target, _binding: Binding, _confirm: bool) -> Result<Value> {
        bail!(UNAVAILABLE)
    }
}

pub mod linux_activation {
    /// Reached from `computer_targets::request`, which only the Local VM
    /// controller (not yet on Windows) calls.
    #[allow(dead_code)]
    pub(crate) fn request(_method: &str, _params: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        anyhow::bail!(super::UNAVAILABLE)
    }
}

pub mod linux_install {
    /// As `linux_activation::request`.
    #[allow(dead_code)]
    pub(crate) fn request(_method: &str, _params: serde_json::Value) -> anyhow::Result<serde_json::Value> {
        anyhow::bail!(super::UNAVAILABLE)
    }
}
