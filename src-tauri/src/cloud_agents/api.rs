//! The runtime's mailbox and checkpoint calls (contract §11.3, §12),
//! authenticated with the current runtime credential.

use std::sync::Arc;
use std::time::Duration;

use anyhow::anyhow;
use serde::Deserialize;
use serde_json::{json, Value};
use zeroize::Zeroizing;

const TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Actor {
    #[serde(default)]
    pub user_id: String,
    pub authority: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub command_id: String,
    pub client_command_id: String,
    pub tab_id: String,
    pub kind: String,
    #[serde(default)]
    pub sequence: u64,
    pub key_id: String,
    pub iv: String,
    pub ciphertext: String,
    pub actor: Actor,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub redelivery: bool,
    pub lease_token: String,
    #[serde(default)]
    pub runtime_generation: u64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Leased {
    #[serde(default)]
    pub leases: Vec<Lease>,
    #[serde(default)]
    pub outcome_unknown: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Ack {
    pub outcome: String,
    pub category: Option<String>,
    pub result_iv: Option<String>,
    pub result_ciphertext: Option<String>,
}

#[derive(Debug, PartialEq)]
pub enum AckOutcome {
    Settled,
    /// Final: the token is no longer this command's lease.
    StaleLease,
    /// The lease belonged to an older generation: lease again.
    StaleGeneration,
    NotFound,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Checkpoint {
    pub epoch: u64,
    pub version: u64,
    pub schema_version: u64,
    pub key_id: String,
    pub iv: String,
    pub ciphertext: String,
    pub sha256: String,
}

#[derive(Debug, PartialEq)]
pub enum PutOutcome {
    Stored,
    Stale,
    Conflict,
    TabLimit,
}

#[derive(Debug)]
pub enum CallError {
    /// 401: bad credential, fenced generation or a malformed body.
    Rejected,
    Transient(anyhow::Error),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected => write!(f, "the API rejected the runtime credential"),
            Self::Transient(error) => write!(f, "{error:#}"),
        }
    }
}

pub trait MailboxApi: Send + Sync {
    fn lease(&self, storage_incarnation_id: &str, limit: u32) -> Result<Leased, CallError>;
    fn ack(&self, command_id: &str, lease_token: &str, ack: &Ack) -> Result<AckOutcome, CallError>;
    fn put_checkpoint(&self, tab_id: &str, checkpoint: &Checkpoint) -> Result<PutOutcome, CallError>;
    fn delete_checkpoint(&self, tab_id: &str) -> Result<(), CallError>;
}

/// Where the runtime credential comes from: the bootstrap (read afresh per
/// call, it rotates) or a development link file.
pub type Credential = Arc<dyn Fn() -> Option<Zeroizing<String>> + Send + Sync>;

pub struct HttpMailboxApi {
    origin: String,
    credential: Credential,
    agent: ureq::Agent,
}

impl HttpMailboxApi {
    pub fn new(origin: &str, credential: Credential) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(TIMEOUT)
            .redirects(0)
            .user_agent(&format!("terminalx-serve/{}", crate::cloud_bootstrap::VERSION))
            .build();
        Self { origin: origin.trim_end_matches('/').to_string(), credential, agent }
    }

    fn call(&self, method: &str, path: &str, body: Option<Value>) -> Result<(u16, Value), CallError> {
        let credential = (self.credential)().ok_or(CallError::Rejected)?;
        let bearer = Zeroizing::new(format!("Bearer {}", credential.as_str()));
        let request = self
            .agent
            .request(method, &format!("{}{path}", self.origin))
            .set("authorization", &bearer)
            .set(crate::cloud_bootstrap::VERSION_HEADER, crate::cloud_bootstrap::VERSION);
        let response = match body {
            Some(body) => request.set("content-type", "application/json").send_json(body),
            None => request.call(),
        };
        let read = |response: ureq::Response| {
            let status = response.status();
            (status, response.into_json::<Value>().unwrap_or(Value::Null))
        };
        match response {
            Ok(response) => Ok(read(response)),
            Err(ureq::Error::Status(401, _)) => Err(CallError::Rejected),
            Err(ureq::Error::Status(status, response)) if (400..500).contains(&status) => Ok(read(response)),
            Err(ureq::Error::Status(status, _)) => Err(CallError::Transient(anyhow!("{path}: HTTP {status}"))),
            Err(ureq::Error::Transport(error)) => Err(CallError::Transient(anyhow!("{path}: {error}"))),
        }
    }
}

fn error_code(body: &Value) -> &str {
    body.get("error").and_then(Value::as_str).unwrap_or("")
}

impl MailboxApi for HttpMailboxApi {
    fn lease(&self, storage_incarnation_id: &str, limit: u32) -> Result<Leased, CallError> {
        let body = json!({ "v": 1, "storageIncarnationId": storage_incarnation_id, "limit": limit.clamp(1, 16) });
        match self.call("POST", "/v1/cloud-workspace-bootstrap/agent-commands/lease", Some(body))? {
            (200, body) => serde_json::from_value(body).map_err(|error| CallError::Transient(anyhow!("lease: unreadable response: {error}"))),
            (status, body) => Err(CallError::Transient(anyhow!("lease: HTTP {status} {}", error_code(&body)))),
        }
    }

    fn ack(&self, command_id: &str, lease_token: &str, ack: &Ack) -> Result<AckOutcome, CallError> {
        if command_id.is_empty() || !command_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
            return Err(CallError::Transient(anyhow!("invalid command id")));
        }
        let mut body = json!({ "v": 1, "leaseToken": lease_token, "outcome": ack.outcome });
        if let Some(category) = &ack.category {
            body["category"] = json!(category);
        }
        if let (Some(iv), Some(ciphertext)) = (&ack.result_iv, &ack.result_ciphertext) {
            body["resultIv"] = json!(iv);
            body["resultCiphertext"] = json!(ciphertext);
        }
        match self.call("POST", &format!("/v1/cloud-workspace-bootstrap/agent-commands/{command_id}/ack"), Some(body))? {
            (200, _) => Ok(AckOutcome::Settled),
            (404, _) => Ok(AckOutcome::NotFound),
            (409, body) => match body.get("code").and_then(Value::as_str) {
                Some("stale-generation") => Ok(AckOutcome::StaleGeneration),
                _ => Ok(AckOutcome::StaleLease),
            },
            (status, body) => Err(CallError::Transient(anyhow!("ack: HTTP {status} {}", error_code(&body)))),
        }
    }

    fn put_checkpoint(&self, tab_id: &str, checkpoint: &Checkpoint) -> Result<PutOutcome, CallError> {
        let body = json!({
            "v": 1,
            "epoch": checkpoint.epoch,
            "version": checkpoint.version,
            "schemaVersion": checkpoint.schema_version,
            "keyId": checkpoint.key_id,
            "iv": checkpoint.iv,
            "ciphertext": checkpoint.ciphertext,
            "sha256": checkpoint.sha256,
        });
        match self.call("PUT", &format!("/v1/cloud-workspace-bootstrap/transcript-checkpoints/{}", path_segment(tab_id)?), Some(body))? {
            (200, _) => Ok(PutOutcome::Stored),
            (409, body) => match error_code(&body) {
                "cloud_workspace_checkpoint_stale" => Ok(PutOutcome::Stale),
                "cloud_workspace_checkpoint_tab_limit" => Ok(PutOutcome::TabLimit),
                _ => Ok(PutOutcome::Conflict),
            },
            (status, body) => Err(CallError::Transient(anyhow!("checkpoint: HTTP {status} {}", error_code(&body)))),
        }
    }

    fn delete_checkpoint(&self, tab_id: &str) -> Result<(), CallError> {
        match self.call("DELETE", &format!("/v1/cloud-workspace-bootstrap/transcript-checkpoints/{}", path_segment(tab_id)?), None)? {
            (200 | 204 | 404, _) => Ok(()),
            (status, body) => Err(CallError::Transient(anyhow!("delete checkpoint: HTTP {status} {}", error_code(&body)))),
        }
    }
}

/// Tab ids are `[A-Za-z0-9._:-]{1,128}` on the server; anything else never
/// reaches a URL.
fn path_segment(tab_id: &str) -> Result<&str, CallError> {
    if valid_tab_id(tab_id) {
        Ok(tab_id)
    } else {
        Err(CallError::Transient(anyhow!("invalid tab id")))
    }
}

pub fn valid_tab_id(tab_id: &str) -> bool {
    (1..=128).contains(&tab_id.len()) && tab_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}
