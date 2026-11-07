//! The relay session of a bootstrapped cloud workspace runtime
//! (`cloud_bootstrap`, PRO-42) as a [`RuntimeLink`].

use std::sync::Arc;

use anyhow::{anyhow, Result};

use super::collab::Members;
use super::host::{Attachment, RelaySession, Revocation, Revoked, RuntimeLink};
use crate::cloud_bootstrap::{Bootstrapped, CallError, HttpApi};

pub struct BootstrapLink {
    cloud: Arc<Bootstrapped>,
    api: HttpApi,
}

impl BootstrapLink {
    pub fn new(cloud: Arc<Bootstrapped>, origin: &str) -> Self {
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
        // Cloud authority is always server-backed. Missing or malformed membership
        // cannot reuse legacy local manage authority or a previously granted role.
        let collaboration = Some(cloud_members(session.collaboration.as_ref()));
        Ok(RelaySession {
            relay_token: session.relay_token.clone(),
            director_url: session.director_url.clone(),
            attachments,
            revocations,
            collaboration,
        })
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


fn cloud_members(value: Option<&serde_json::Value>) -> Members {
    value.and_then(|value| serde_json::from_value::<Members>(value.clone()).ok()).unwrap_or(Members { v: 0, members: Vec::new() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::collab::{Access, Role};
    use serde_json::json;

    #[test]
    fn missing_malformed_and_unknown_cloud_membership_fail_closed() {
        for value in [None, Some(json!({})), Some(json!({ "v": 99, "members": [] }))] {
            assert!(cloud_members(value.as_ref()).into_map().is_none());
        }
        let legacy = json!({ "v": 1, "members": [{ "userId": "owner", "role": "manager" }] });
        assert_eq!(cloud_members(Some(&legacy)).into_map().unwrap()["owner"], Access::MANAGER);
        let explicit = json!({ "v": 2, "members": [{ "userId": "admin", "role": "manager", "canApprove": false }] });
        assert_eq!(cloud_members(Some(&explicit)).into_map().unwrap()["admin"], Access { role: Role::Manager, can_approve: false });
    }
}
