//! Export a pinned branch and one visible conversation to the requesting attachment.
use super::*;
use crate::workspace_transfer_bundle::{self as bundle, BranchCommit, TransferBundle, CHUNK_BYTES};
use base64::{engine::general_purpose::STANDARD, Engine as _};

const EXPORT_TTL: Duration = Duration::from_secs(180);
const MAX_EXPORTS: usize = 4;
const MAX_BUNDLE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct Export {
    id: String,
    request: uuid::Uuid,
    manifest: Value,
    session: String,
    tab: String,
    generation: u64,
    stamp: Option<collab::v2::Stamp>,
    expires: Instant,
    bundle: Option<TransferBundle>,
    transcript: Vec<u8>,
}

impl WorkspaceRpc {
    pub(super) fn is_cloud_transfer_runtime(&self) -> bool {
        !self.is_machine()
            && self
                .agents
                .get()
                .is_some_and(|agents| agents.identity.is_some())
    }

    fn transfer_authorize(&self, peer: &Peer) -> Result<(), RpcError> {
        if !self.is_cloud_transfer_runtime()
            || !self.collab.known()
            || peer.hung_up()
            || peer.user_id.is_none()
            || !self.may_use_ports(peer)
        {
            return Err(RpcError::forbidden(
                "Workspace export needs current management access",
            ));
        }
        Ok(())
    }

    pub(super) fn workspace_transfer(
        &self,
        peer: &Arc<Peer>,
        method: &str,
        params: &Value,
    ) -> Result<Value, RpcError> {
        self.transfer_authorize(peer)?;
        let session = required_str(params, "sessionId")?;
        let tab = self.visible_tab(peer, params)?;
        match method {
            "transfer.open" => {
                let request = uuid::Uuid::parse_str(required_str(params, "requestId")?)
                    .map_err(|_| RpcError::invalid("Invalid export request ID"))?;
                self.open_transfer(peer, session, &tab.tab_id, request)
            }
            "transfer.read" | "transfer.close" => {
                let token = required_str(params, "transferId")?;
                let _admission = self.collab.enter_admission();
                self.transfer_authorize(peer)?;
                self.visible_tab(peer, params)?;
                let stamp = self
                    .collab
                    .runtime_policy
                    .stamp_for_peer(peer.user_id.as_deref().unwrap_or(""), peer);
                let mut transfers = self.transfers.lock().unwrap();
                transfers.retain(|_, entry| entry.expires > Instant::now());
                let entry = transfers
                    .get(&peer.id())
                    .filter(|entry| {
                        entry.id == token
                            && entry.session == session
                            && entry.tab == tab.tab_id
                            && entry.generation == self.generation()
                            && entry.stamp == stamp
                    })
                    .ok_or_else(|| RpcError::not_found("This export has expired"))?;
                if method == "transfer.close" {
                    transfers.remove(&peer.id());
                    return Ok(json!({}));
                }
                let offset = params
                    .get("offset")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| RpcError::invalid("A transfer offset is required"))?;
                let bytes = match required_str(params, "part")? {
                    "bundle" => entry
                        .bundle
                        .as_ref()
                        .ok_or_else(|| RpcError::invalid("This export has no Git bundle"))?
                        .read_chunk(offset)
                        .map_err(RpcError::internal)?,
                    "transcript" => {
                        let start = usize::try_from(offset)
                            .ok()
                            .filter(|offset| *offset <= entry.transcript.len())
                            .ok_or_else(|| RpcError::invalid("Offset is outside the transcript"))?;
                        entry.transcript
                            [start..entry.transcript.len().min(start + CHUNK_BYTES as usize)]
                            .to_vec()
                    }
                    _ => return Err(RpcError::invalid("Unknown transfer part")),
                };
                Ok(json!({ "offset": offset, "data": STANDARD.encode(bytes) }))
            }
            _ => Err(RpcError::new("method_not_found", "Unknown transfer method")),
        }
    }

    fn open_transfer(
        &self,
        peer: &Arc<Peer>,
        session_id: &str,
        tab_id: &str,
        request: uuid::Uuid,
    ) -> Result<Value, RpcError> {
        let session = self.visible_session(peer, session_id)?;
        let tab = session
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| RpcError::not_found("No such conversation"))?;
        let (_, checkout) = self.session_checkout(&session)?;
        if session.worktree_removed
            || crate::paths::canonicalize(&session.cwd).ok().as_ref() != Some(&checkout)
        {
            return Err(RpcError::invalid("The session checkout is unavailable"));
        }
        let generation = self.generation();
        let permit = self
            .collab
            .runtime_policy
            .stamp_for_peer(peer.user_id.as_deref().unwrap_or(""), peer);
        let still_allowed = || {
            self.transfer_authorize(peer)?;
            if self.generation() != generation
                || self
                    .collab
                    .runtime_policy
                    .stamp_for_peer(peer.user_id.as_deref().unwrap_or(""), peer)
                    != permit
            {
                return Err(RpcError::forbidden("The workspace attachment changed"));
            }
            self.visible_session(peer, session_id)?
                .tabs
                .iter()
                .any(|tab| tab.id == tab_id)
                .then_some(())
                .ok_or_else(|| RpcError::not_found("No such conversation"))
        };
        let _preparing = self.transfer_preparing.try_lock().map_err(|_| {
            RpcError::new("backpressure", "Another workspace export is being prepared")
        })?;
        {
            let mut transfers = self.transfers.lock().unwrap();
            transfers.retain(|_, entry| entry.expires > Instant::now());
            if let Some(entry) = transfers
                .get(&peer.id())
                .filter(|entry| entry.request == request)
            {
                still_allowed()?;
                if entry.session != session_id
                    || entry.tab != tab_id
                    || entry.generation != generation
                    || entry.stamp != permit
                {
                    return Err(RpcError::forbidden("The workspace export scope changed"));
                }
                return Ok(entry.manifest.clone());
            }
            if transfers.len() >= MAX_EXPORTS && !transfers.contains_key(&peer.id()) {
                return Err(RpcError::new("backpressure", "Too many workspace exports"));
            }
        }
        let branch = bundle::git(&checkout, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .map_err(RpcError::internal)?;
        let head = bundle::git(&checkout, &["rev-parse", "--verify", "HEAD"])
            .map_err(RpcError::internal)?;
        let pin = BranchCommit::new(branch.trim(), head.trim()).map_err(RpcError::internal)?;
        let log = crate::store::log_path(session_id, tab_id).map_err(RpcError::internal)?;
        if log
            .metadata()
            .is_ok_and(|stat| stat.len() > MAX_TRANSCRIPT_BYTES as u64)
        {
            return Err(RpcError::invalid(
                "The conversation is too large to transfer",
            ));
        }
        let events = self
            .manager()?
            .load_events(session_id, tab_id)
            .map_err(RpcError::internal)?;
        let transcript = bundle::transcript(&events).map_err(RpcError::internal)?;
        if transcript.len() > MAX_TRANSCRIPT_BYTES {
            return Err(RpcError::invalid(
                "The conversation is too large to transfer",
            ));
        }
        still_allowed()?;
        let remotes = bundle::git(&checkout, &["remote"]).map_err(RpcError::internal)?;
        let bundle = if remotes.is_empty() {
            let snapshot = bundle::export(&checkout, &pin).map_err(RpcError::internal)?;
            if snapshot.size() > MAX_BUNDLE_BYTES {
                return Err(RpcError::invalid("The Git bundle is too large to transfer"));
            }
            Some(snapshot)
        } else if remotes.lines().any(|remote| remote == "origin") {
            let refspec = format!("{}:refs/heads/{}", pin.commit(), pin.branch());
            still_allowed()?;
            bundle::git(&checkout, &["push", "--porcelain", "origin", &refspec]).map_err(|_| {
                RpcError::new(
                    "transfer_push_failed",
                    "Could not push the selected branch to origin",
                )
            })?;
            None
        } else {
            return Err(RpcError::invalid("The checkout has remotes but no origin"));
        };
        let _admission = self.collab.enter_admission();
        still_allowed()?;
        let id = uuid::Uuid::new_v4().to_string();
        let result = json!({
            "transferId": id, "branch": pin.branch(), "commit": pin.commit(),
            "bundleBytes": bundle.as_ref().map(TransferBundle::size),
            "transcriptBytes": transcript.len(), "harness": tab.harness, "title": session.title,
        });
        self.transfers.lock().unwrap().insert(
            peer.id(),
            Export {
                id,
                request,
                manifest: result.clone(),
                session: session_id.into(),
                tab: tab_id.into(),
                generation,
                stamp: permit,
                expires: Instant::now() + EXPORT_TTL,
                bundle,
                transcript,
            },
        );
        Ok(result)
    }
}
