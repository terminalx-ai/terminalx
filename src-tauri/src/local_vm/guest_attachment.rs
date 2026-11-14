//! Guest-owned macOS attachment lease. The host adapter retains the same identity.
//! A retained call intent fences every route until its exact receipt or a
//! later kernel boot proves release; disconnection never replays UI input.
use super::*;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    environment_id: String,
    generation: String,
    lease_id: String,
    session_id: String,
    tab_id: String,
    conversation: Option<String>,
}

impl Binding {
    fn validate(&self, identity: &Identity) -> Result<()> {
        for id in [
            &self.environment_id,
            &self.generation,
            &self.lease_id,
            &self.session_id,
            &self.tab_id,
        ] {
            super::super::journal::validate_id(id)?;
        }
        if self.environment_id != identity.environment_id
            || self.generation != identity.generation
            || self.conversation.as_ref().is_some_and(|s| s.len() > 512)
        {
            bail!("Attachment identity or conversation changed");
        }
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Lease {
    binding: Binding,
    acquired_at: String,
    boot_identity: String,
    released_at: Option<String>,
    release_proof: Option<Value>,
    calls: BTreeMap<String, Value>,
    #[serde(default)]
    connection_started: bool,
    #[serde(default)]
    connection_closed: bool,
}

pub(super) fn held(state: &State) -> bool {
    state
        .attachments
        .values()
        .any(|lease| lease.released_at.is_none())
}

fn bound<'a>(state: &'a State, binding: &Binding) -> Result<&'a Lease> {
    binding.validate(&state.identity)?;
    state
        .attachments
        .get(&binding.lease_id)
        .filter(|lease| lease.binding == *binding)
        .context("Exact attachment lease is unavailable")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Call {
    #[serde(flatten)]
    binding: Binding,
    idempotency_key: String,
    tool: String,
    arguments: Value,
}

impl Guest {
    pub(super) fn attachment_capabilities(&self) -> Result<Value> {
        if cfg!(target_os = "linux") {
            bail!("macOS attachment requires macOS");
        }
        let state = self.state.lock().unwrap();
        self.attachment_history_current(&state)?;
        require_queue_control(&state)?;
        if state.records.values().any(|r| !r.task.status.terminal())
            || self.setup_actor.busy()
            || !self.manager.terminals().owned_groups().is_empty()
        {
            bail!("Guest workflow holds desktop admission");
        }
        // Contract discovery is read-only. Actual MCP discovery must hold a
        // durable attachment lease, including its helper exit receipt.
        setup::desktop_mcp::Peer::artifact_present(&self.base)?;
        Ok(
            json!({"attachmentProtocol":1,"environmentId":state.identity.environment_id,"generation":state.identity.generation,
            "platform":"macos","runtimeSha256":self.runtime_sha256,"available":true}),
        )
    }

    pub(super) fn attachment_tools(&self, params: &Value) -> Result<Value> {
        let binding: Binding = serde_json::from_value(params.clone())?;
        let mut state = self.state.lock().unwrap();
        let lease = bound(&state, &binding)?;
        if lease.released_at.is_some() || boot_identity().as_deref() != Some(&lease.boot_identity) {
            bail!("Attachment is released or belongs to another boot");
        }
        self.attachment_history_current(&state)?;
        let mut peers = self.attachment_peers.lock().unwrap();
        if !peers.contains_key(&binding.lease_id) {
            if lease.connection_started || !lease.calls.is_empty() {
                bail!("Original MCP connection is unavailable; explicitly reconcile its retained lease");
            }
            let mut next = state.clone();
            next.attachments
                .get_mut(&binding.lease_id)
                .unwrap()
                .connection_started = true;
            self.save(&next)?;
            *state = next;
            let exits = Arc::new(AtomicBool::new(true));
            match setup::desktop_mcp::Peer::start(&self.base, exits.clone()) {
                Ok(peer) => {
                    peers.insert(binding.lease_id.clone(), peer);
                }
                Err(error) => {
                    if exits.load(Ordering::Acquire) {
                        let mut next = state.clone();
                        next.attachments
                            .get_mut(&binding.lease_id)
                            .unwrap()
                            .connection_closed = true;
                        self.save(&next)?;
                        *state = next;
                    }
                    return Err(error);
                }
            }
        }
        Ok(json!({"binding":binding,"tools":peers[&binding.lease_id].tools}))
    }

    pub(super) fn attachment_close(&self, params: &Value) -> Result<Value> {
        let binding: Binding = serde_json::from_value(params.clone())?;
        {
            let state = self.state.lock().unwrap();
            let lease = bound(&state, &binding)?;
            if lease
                .calls
                .values()
                .any(|call| call["status"] != "complete")
                || lease.connection_started
                    && !lease.connection_closed
                    && !self
                        .attachment_peers
                        .lock()
                        .unwrap()
                        .contains_key(&binding.lease_id)
            {
                bail!("Unknown call or connection requires explicit recovery; normal EOF cannot release it");
            }
        }
        let mut request = params.clone();
        request["confirm"] = json!(true);
        self.attachment_release(&request)
    }
    fn attachment_history_current(&self, state: &State) -> Result<()> {
        if self.stopped.load(Ordering::Acquire) || Identity::load(&self.base)? != state.identity {
            bail!(
                "Guest owner stopped or installation identity changed; attachment remains fenced"
            );
        }
        let retained: State = serde_json::from_slice(&read_bounded(
            &self.base.join("runtime").join(STATE),
            512 * 1024 * 1024,
        )?)?;
        if serde_json::to_value(&retained)? != serde_json::to_value(state)? {
            bail!("Retained attachment history changed; no effect or release was routed");
        }
        Ok(())
    }

    pub(super) fn attachment_acquire(&self, params: &Value) -> Result<Value> {
        if cfg!(target_os = "linux") {
            bail!("macOS attachment requires a macOS guest");
        }
        let binding: Binding = serde_json::from_value(params.clone())?;
        let mut state = self.state.lock().unwrap();
        binding.validate(&state.identity)?;
        if state.attachments.contains_key(&binding.lease_id) {
            return Ok(serde_json::to_value(bound(&state, &binding)?)?);
        }
        self.attachment_history_current(&state)?;
        require_queue_control(&state)?;
        if state.records.values().any(|r| !r.task.status.terminal())
            || self.setup_actor.busy()
            || !self.manager.terminals().owned_groups().is_empty()
        {
            bail!("Guest task or setup work owns admission");
        }
        let boot =
            boot_identity().context("Kernel boot identity is required for attachment recovery")?;
        let mut next = state.clone();
        next.attachments.insert(
            binding.lease_id.clone(),
            Lease {
                binding: binding.clone(),
                acquired_at: now(),
                boot_identity: boot,
                released_at: None,
                release_proof: None,
                calls: BTreeMap::new(),
                connection_started: false,
                connection_closed: false,
            },
        );
        if let Some(baseline) = next.provisioning_baseline.as_mut() {
            baseline.no_execution = false;
        }
        self.save(&next)?;
        *state = next;
        Ok(serde_json::to_value(bound(&state, &binding)?)?)
    }

    pub(super) fn attachment_read(&self, params: &Value) -> Result<Value> {
        let binding: Binding = serde_json::from_value(params.clone())?;
        let state = self.state.lock().unwrap();
        binding.validate(&state.identity)?;
        if !state.attachments.contains_key(&binding.lease_id) {
            return Ok(json!({"binding":binding,"missing":true,"releaseAvailable":true}));
        }
        let lease = bound(&state, &binding)?;
        let mut result = serde_json::to_value(lease)?;
        let known_calls = lease
            .calls
            .values()
            .all(|call| call["status"] == "complete");
        let connection_known = !lease.connection_started
            || lease.connection_closed
            || self
                .attachment_peers
                .lock()
                .unwrap()
                .contains_key(&binding.lease_id);
        result["releaseAvailable"] = json!(boot_identity()
            .is_some_and(|boot| boot != lease.boot_identity || known_calls && connection_known));
        Ok(result)
    }

    pub(super) fn attachment_call(&self, params: &Value) -> Result<Value> {
        let call: Call = serde_json::from_value(params.clone())?;
        // Receipt recovery is read-only, including after a connection/owner dies.
        let retained = {
            bound(&self.state.lock().unwrap(), &call.binding)?
                .calls
                .contains_key(&call.idempotency_key)
        };
        if !retained {
            self.attachment_tools(&serde_json::to_value(&call.binding)?)?;
        }
        self.attachment_call_using(params, |tool, arguments| {
            self.attachment_peers
                .lock()
                .unwrap()
                .get_mut(&call.binding.lease_id)
                .context("Original guest MCP connection is unavailable")?
                .call(tool, arguments)
        })
    }

    pub(super) fn attachment_call_using(
        &self,
        params: &Value,
        effect: impl FnOnce(&str, &Value) -> Result<Value>,
    ) -> Result<Value> {
        let call: Call = serde_json::from_value(params.clone())?;
        if call.idempotency_key.is_empty()
            || call.idempotency_key.len() > 200
            || serde_json::to_vec(params)?.len() > 1024 * 1024
        {
            bail!("A bounded attachment call and idempotency key are required");
        }
        super::super::desktop::check_capability_request(
            &json!({"method":"tools/call","params":{"name":call.tool,"arguments":call.arguments}}),
        )?;
        let input_digest = digest(&serde_json::to_vec(params)?);
        let mut state = self.state.lock().unwrap();
        let lease = bound(&state, &call.binding)?;
        if let Some(prior) = lease.calls.get(&call.idempotency_key) {
            if prior["inputDigest"] != input_digest {
                bail!("Attachment call key already names different input");
            }
            return Ok(prior.clone());
        }
        if state.manual_lease.is_some()
            || state
                .records
                .values()
                .any(|record| !record.task.status.terminal())
            || self.setup_actor.busy()
            || setup::holds_admission(&state, self.boot_identity.as_deref())
            || !self.manager.terminals().owned_groups().is_empty()
        {
            bail!("Conflicting guest workflow; no attached input was routed");
        }
        if lease.released_at.is_some()
            || boot_identity().as_deref() != Some(&lease.boot_identity)
            || lease
                .calls
                .values()
                .any(|call| call["status"] != "complete")
        {
            bail!("Attachment is released or has an unconfirmed call; input is not replayed");
        }
        self.attachment_history_current(&state)?;
        let mut next = state.clone();
        next.attachments.get_mut(&call.binding.lease_id).unwrap().calls.insert(call.idempotency_key.clone(),
            json!({"inputDigest":input_digest,"idempotencyKey":call.idempotency_key,"status":"outcomeUnknown","detail":"Intent retained before Driver delivery"}));
        self.save(&next)?;
        *state = next;
        let receipt = match effect(&call.tool, &call.arguments) {
            Ok(result) if serde_json::to_vec(&result)?.len() <= 8 * 1024 * 1024 => {
                json!({"inputDigest":input_digest,"idempotencyKey":call.idempotency_key,"status":"complete","result":result})
            }
            _ => {
                return Ok(
                    state.attachments[&call.binding.lease_id].calls[&call.idempotency_key].clone(),
                )
            }
        };
        self.attachment_history_current(&state)?;
        let mut next = state.clone();
        next.attachments
            .get_mut(&call.binding.lease_id)
            .unwrap()
            .calls
            .insert(call.idempotency_key.clone(), receipt.clone());
        self.save(&next)?;
        *state = next;
        Ok(receipt)
    }

    pub(super) fn attachment_release(&self, params: &Value) -> Result<Value> {
        let mut params = params.clone();
        if params
            .as_object_mut()
            .context("Attachment release request required")?
            .remove("confirm")
            != Some(json!(true))
        {
            bail!("Explicit attachment release confirmation is required");
        }
        let binding: Binding = serde_json::from_value(params)?;
        let mut state = self.state.lock().unwrap();
        binding.validate(&state.identity)?;
        self.attachment_history_current(&state)?;
        if !state.attachments.contains_key(&binding.lease_id) {
            let mut next = state.clone();
            next.attachments.insert(
                binding.lease_id.clone(),
                Lease {
                    binding: binding.clone(),
                    acquired_at: now(),
                    boot_identity: boot_identity().context("Current boot unavailable")?,
                    released_at: Some(now()),
                    release_proof: Some(
                        json!({"kind":"neverAcquiredTombstone","priorActionOutcomeUnknown":false}),
                    ),
                    calls: BTreeMap::new(),
                    connection_started: false,
                    connection_closed: true,
                },
            );
            self.save(&next)?;
            *state = next;
            return Ok(serde_json::to_value(bound(&state, &binding)?)?);
        }
        let lease = bound(&state, &binding)?;
        if lease.released_at.is_some() {
            return Ok(serde_json::to_value(lease)?);
        }
        self.attachment_history_current(&state)?;
        // Only actual current kernel evidence is used, never a client assertion.
        let boot = boot_identity().context("Current guest kernel identity is unavailable")?;
        let mut unknown = lease
            .calls
            .values()
            .any(|call| call["status"] != "complete");
        let mut connection_closed = lease.connection_closed;
        if let Some(mut peer) = self
            .attachment_peers
            .lock()
            .unwrap()
            .remove(&binding.lease_id)
        {
            connection_closed = peer.close();
        }
        unknown |= lease.connection_started && !connection_closed;
        if unknown && boot == lease.boot_identity {
            bail!("Driver outcome is unknown in this guest boot; ownership remains fenced");
        }
        let proof = json!({"kind":if unknown {"laterKernelBoot"} else {"allCallsReceipted"},"currentBootIdentity":boot,"priorActionOutcomeUnknown":unknown});
        let mut next = state.clone();
        let lease = next.attachments.get_mut(&binding.lease_id).unwrap();
        lease.released_at = Some(now());
        lease.connection_closed = connection_closed || boot != lease.boot_identity;
        lease.release_proof = Some(proof);
        self.save(&next)?;
        *state = next;
        Ok(serde_json::to_value(bound(&state, &binding)?)?)
    }
}
