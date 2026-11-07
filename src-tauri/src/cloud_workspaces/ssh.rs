//! Account-fenced registration; private files never cross the HTTP boundary.
use super::{CloudWorkspaceClientError, CloudWorkspaceService, RequestRisk};
use serde_json::{json, Value};
use std::path::PathBuf;

impl CloudWorkspaceService {
    pub fn ssh_check_scope(
        &self,
        org: &str,
        workspace: &str,
        scope: &str,
    ) -> Result<String, CloudWorkspaceClientError> {
        self.run_in(Some(org), RequestRisk::Read, |_, context| {
            if crate::workspace_ssh::scope(&context.user_id, org, workspace) != scope {
                return Err(CloudWorkspaceClientError::local(
                    "ssh_account_changed",
                    false,
                ));
            }
            Ok(crate::account::AccountManager::context_revision(context))
        })
    }

    pub fn ssh_configure(
        &self,
        org: &str,
        workspace: &str,
        user: &str,
        host_key: &str,
        enabled: bool,
    ) -> Result<Value, CloudWorkspaceClientError> {
        if !super::valid_resource_id(workspace) {
            return Err(CloudWorkspaceClientError::local(
                "cloud_workspace_request_invalid",
                false,
            ));
        }
        self.run_in(Some(org), RequestRisk::Mutation, |client, context| {
            let home = dirs::home_dir()
                .ok_or_else(|| CloudWorkspaceClientError::local("ssh_home_unavailable", false))?;
            let ssh = home.join(".ssh");
            let scope = crate::workspace_ssh::scope(&context.user_id, org, workspace);
            let local = |_: anyhow::Error| {
                CloudWorkspaceClientError::local("ssh_configuration_failed", false)
            };
            if !enabled {
                crate::workspace_ssh::remove(&ssh, &scope).map_err(local)?;
                let _: Value = client.request_as(
                    "DELETE",
                    context,
                    &["cloud-workspaces", workspace, "ssh-key"],
                    None,
                    Some(json!({})),
                    None,
                    RequestRisk::Mutation,
                )?;
                return Ok(json!({ "enabled": false }));
            }
            // A fresh server check precedes local key generation/config writes.
            let shares = self.shares(Some(org), workspace)?;
            let allowed = shares.you.role == super::CollaborationRole::Manager
                || (shares.you.role == super::CollaborationRole::Driver && shares.you.can_approve);
            if !allowed {
                return Err(CloudWorkspaceClientError::local(
                    "cloud_workspace_share_forbidden",
                    false,
                ));
            }
            let configured = ssh_key_path().map_err(local)?;
            let generated = configured.is_empty();
            let identity = if generated {
                crate::store::root()
                    .map_err(local)?
                    .join("ssh")
                    .join(&scope)
                    .join("id_ed25519")
            } else {
                PathBuf::from(configured)
            };
            if !identity.is_absolute() {
                return Err(CloudWorkspaceClientError::local(
                    "ssh_path_must_be_absolute",
                    false,
                ));
            }
            let public = crate::workspace_ssh::public_key(&identity, generated).map_err(local)?;
            let _: Value = client.request_as(
                "PUT",
                context,
                &["cloud-workspaces", workspace, "ssh-key"],
                None,
                Some(json!({ "publicKey": public })),
                None,
                RequestRisk::Mutation,
            )?;
            if !self
                .account
                .is_current_in(context, self.context_in(Some(org))?.1)
            {
                return Err(super::context_changed_error(RequestRisk::Mutation));
            }
            let executable = std::env::current_exe()
                .map_err(|_| CloudWorkspaceClientError::local("ssh_configuration_failed", false))?;
            let command = crate::workspace_ssh::install(
                &ssh,
                &scope,
                org,
                workspace,
                user,
                &identity,
                &executable,
                host_key,
            )
            .map_err(local)?;
            Ok(json!({ "enabled": true, "command": command }))
        })
    }
}

pub fn ssh_key_path() -> anyhow::Result<String> {
    let path = crate::store::root()?.join("ssh-key-path.json");
    match std::fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.into()),
    }
}

pub fn set_ssh_key_path(path: &str) -> anyhow::Result<()> {
    if !path.is_empty() {
        if !PathBuf::from(path).is_absolute() {
            anyhow::bail!("Use an absolute SSH private key path");
        }
        crate::workspace_ssh::config_quote(path)?;
    }
    crate::workspace_ssh::atomic_write(
        &crate::store::root()?.join("ssh-key-path.json"),
        &serde_json::to_vec(path)?,
    )
}
