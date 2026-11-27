//! The relay session of a bootstrapped cloud workspace runtime
//! (`cloud_bootstrap`, PRO-42) as a [`RuntimeLink`].

use std::sync::Arc;

use anyhow::{anyhow, Result};

use super::host::{Attachment, RelaySession, Revocation, Revoked, RuntimeLink};
use crate::cloud_bootstrap::{Bootstrapped, CallError, HttpApi};

pub struct BootstrapLink {
    cloud: Arc<Bootstrapped>,
    api: HttpApi,
}

impl BootstrapLink {
    pub fn new(cloud: Arc<Bootstrapped>, origin: &str) -> Self {
        #[cfg(target_os = "linux")]
        if cloud.ssh_runtime.get().is_none() {
            use crate::workspace_ssh::{LoginShell, PRIVATE_SSHD};
            if let Some(reason) = LoginShell::current_account().hold_reason() {
                log::info!("workspace SSH held: {reason}");
            } else if let Some(root) = std::path::Path::new(PRIVATE_SSHD).ancestors().nth(4) {
                if let Ok(runtime) = crate::workspace_ssh_listener::Runtime::restore(root) {
                    let _ = cloud.ssh_runtime.set(Arc::new(runtime));
                }
            }
        }
        Self { cloud, api: HttpApi::new(origin) }
    }
}

impl RuntimeLink for BootstrapLink {
    fn host_secret(&self) -> [u8; 32] {
        self.cloud.key.secret()
    }

    fn session(&self) -> Result<RelaySession> {
        if self.cloud.is_rejected() {
            return Err(Revoked.into());
        }
        let session = self.cloud.session.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        #[allow(unused_mut)]
        let mut relay = relay_session(&session, crate::cloud_bootstrap::CAPABILITIES);
        #[cfg(target_os = "linux")]
        if let Some(runtime) = self.cloud.ssh_runtime.get() {
            relay.workspace_ssh = session.workspace_ssh.as_ref().map(|grants| super::host::WorkspaceSshRefresh {
                workspace_id: session.workspace_id.clone(),
                grants: grants.clone(),
                runtime: runtime.clone(),
            });
        }
        Ok(relay)
    }

    fn complete_attachment(&self, attachment_id: &str, pairing_code: &str) -> Result<()> {
        match self.cloud.complete_attachment(&self.api, attachment_id, pairing_code) {
            Ok(()) => Ok(()),
            Err(CallError::Rejected) => Err(anyhow!("the API refused the pairing code for attachment {attachment_id}")),
            Err(CallError::Transient(error)) => Err(error),
        }
    }

    fn complete_revocation(&self, attachment_id: &str) -> Result<()> {
        match self.cloud.complete_revocation(&self.api, attachment_id) {
            Ok(()) => Ok(()),
            Err(CallError::Rejected) => Err(anyhow!("the API refused to complete revocation {attachment_id}")),
            Err(CallError::Transient(error)) => Err(error),
        }
    }
}

/// Shared by the authenticated bootstrap link and refresh-path regressions.
pub(crate) fn relay_session(session: &crate::cloud_bootstrap::Session, requested_capabilities: &str) -> RelaySession {
    // An entry this runtime cannot read is skipped, not fatal: the others
    // are still answered.
    let attachments = session
        .attachments
        .iter()
        .filter_map(|value| serde_json::from_value::<Attachment>(value.clone()).map_err(|error| log::warn!("skipping an attachment: {error}")).ok())
        .collect();
    let revocations = session
        .revocations
        .iter()
        .filter_map(|value| serde_json::from_value::<Revocation>(value.clone()).map_err(|error| log::warn!("skipping a revocation: {error}")).ok())
        .collect();
    // Preserve the complete versioned payload until it is installed under
    // the registered host generation and common admission lock.
    let collaboration = session.collaboration.clone();
    RelaySession {
        relay_token: session.relay_token.clone(),
        director_url: session.director_url.clone(),
        attachments,
        revocations,
        collaboration,
        desktop_ready: session.desktop_ready,
        #[cfg(target_os = "linux")]
        workspace_ssh: None,
        collaboration_v2: requested_capabilities.split(',').any(|capability| capability == "collaboration-v2"),
    }
}
