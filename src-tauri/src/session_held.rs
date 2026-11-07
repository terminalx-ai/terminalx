//! Reader-owned follow-ups. Nothing here reaches the CLI until a turn ends
//! or the reader chooses Send now. Mutations and delivery use send admission.
use super::*;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub items: Vec<Item>,
    pub paused: bool,
    #[serde(default)]
    pub sending: Option<String>,
    #[serde(default)]
    pub next: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub text: String,
    pub images: Vec<ImageRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Change {
    Enqueue { text: String, #[serde(default)] images: Vec<ImageInput>, #[serde(default)] send_now: bool },
    Edit { id: String, text: String },
    Delete { id: String },
    Move { id: String, before_id: Option<String> },
    Pause { paused: bool },
    SendNow { id: String },
}

impl Queue {
    pub fn replay(events: &[AgentEvent]) -> Self {
        let mut queue = Self::default();
        for event in events.iter().filter(|e| e.subagent.is_none()) {
            match &event.payload {
                Payload::HeldQueue { queue: saved } => queue = saved.clone(),
                // Admission excludes other senders until this delivery publishes
                // its prompt. A crash between that and the final queue snapshot
                // must not offer the already-published message a second time.
                Payload::UserMessage { text, images, .. } if queue.items.iter().any(|item|
                    Some(&item.id) == queue.sending.as_ref() && &item.text == text && item.images.len() == images.len()) => {
                    let id = queue.sending.take().unwrap();
                    queue.items.retain(|item| item.id != id);
                    queue.next = None;
                }
                _ => {}
            }
        }
        queue
    }

    pub fn restore(path: &Path) -> Result<Self> {
        let mut queue = Self::replay(&store::read_lines(path)?);
        let interrupted = queue.sending.take().is_some();
        if queue.next.take().is_some() || interrupted {
            queue.paused = true;
            queue.error = Some("Delivery was interrupted. Review the conversation, then resume the queue.".into());
        }
        Ok(queue)
    }

    fn position(&self, id: &str) -> Result<usize> {
        self.items.iter().position(|item| item.id == id).context("That follow-up has already left the queue.")
    }

    fn ready(&self, rt: &TabRuntime) -> bool {
        !self.items.is_empty() && (!self.paused || self.next.is_some()) && self.sending.is_none()
            && !rt.turn_open_for_prompts() && rt.pending.is_empty() && !rt.stopping && !rt.stop_in_flight
            && rt.recovery.is_none() && rt.restart_claim.is_none() && !rt.stdio_starting
            && !matches!(&rt.engine, Engine::Cli(cli) if !cli.held.is_empty() || cli.awaiting_delivery.is_some())
    }
}

impl SessionManager {
    /// Unlike transcript previews, a queue edit is acknowledged only after its
    /// durable record is written. A failed write leaves the old queue intact.
    pub(super) fn save_held(&self, rt: &mut TabRuntime, queue: Queue) -> Result<AgentEvent> {
        let event = AgentEvent {
            id: uuid::Uuid::now_v7().to_string(), session_id: rt.session_id.clone(), tab_id: rt.tab_id.clone(),
            harness: rt.harness.clone(), seq: rt.seq + 1, ts: index::now(), message_ts: None, subagent: None,
            payload: Payload::HeldQueue { queue: queue.clone() },
        };
        // Queue edits are durable before they are acknowledged, including a
        // claim made before typing. Roll back a partial append on disk-full.
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&rt.log_path)?;
        let before = file.metadata()?.len();
        let line = format!("{}\n", serde_json::to_string(&event)?);
        if let Err(error) = file.write_all(line.as_bytes()).and_then(|()| file.sync_data()) {
            let _ = file.set_len(before);
            return Err(error.into());
        }
        rt.seq = event.seq;
        rt.held_queue = queue;
        self.sink.emit("agent_event", &event);
        Ok(event)
    }

    pub fn change_held(&self, session: &str, tab: &str, change: Change) -> Result<SendOutcome> {
        self.accepting_work()?;
        let admission = crate::issue_pipeline::admission::lock_for(session, tab);
        let rt_arc = self.runtime(session, tab)?;
        let mut rt = rt_arc.lock().unwrap();
        if rt.stopping || rt.stop_in_flight { bail!("Wait for Stop to finish before changing the queue."); }
        let mut queue = rt.held_queue.clone();
        let mut interrupt = false;
        let mut deliver = false;
        match change {
            Change::Enqueue { text, images, send_now } => {
                if text.trim().is_empty() && images.is_empty() { bail!("Write a message or attach an image first."); }
                let (images, _) = Self::archive_images(session, &images)?;
                let id = uuid::Uuid::now_v7().to_string();
                queue.items.push(Item { id: id.clone(), text, images });
                deliver = true;
                if send_now { queue.next = Some(id); interrupt = rt.turn_open; }
            }
            Change::Edit { id, text } => {
                let pos = queue.position(&id)?;
                if text.trim().is_empty() && queue.items[pos].images.is_empty() { bail!("A follow-up needs text or an image."); }
                queue.items[pos].text = text;
            }
            Change::Delete { id } => {
                let pos = queue.position(&id)?;
                queue.items.remove(pos);
                if queue.next.as_deref() == Some(&id) { queue.next = None; }
            }
            Change::Move { id, before_id } => {
                let pos = queue.position(&id)?;
                if before_id.as_deref() != Some(&id) {
                    if let Some(before) = &before_id { queue.position(before)?; }
                    let item = queue.items.remove(pos);
                    let target = before_id.as_deref().map(|id| queue.position(id)).transpose()?.unwrap_or(queue.items.len());
                    queue.items.insert(target, item);
                }
            }
            Change::Pause { paused } => {
                queue.paused = paused;
                queue.error = None;
                if paused { queue.next = None; }
                deliver = !paused;
            }
            Change::SendNow { id } => {
                queue.position(&id)?;
                queue.next = Some(id);
                interrupt = rt.turn_open;
                deliver = true;
            }
        }
        let event = self.save_held(&mut rt, queue)?;
        drop(rt);
        // Keep admission until Escape is sent: an automatic dispatch cannot
        // overtake the selected item while the interrupted turn settles.
        if interrupt && !self.interrupt(session, tab)? {
            let mut rt = rt_arc.lock().unwrap();
            let mut queue = rt.held_queue.clone();
            queue.next = None;
            queue.paused = true;
            queue.error = Some("Could not interrupt the agent. The follow-up is still held.".into());
            let failed = self.save_held(&mut rt, queue)?;
            return Ok(SendOutcome { queued: true, events: vec![event, failed], in_input: false });
        }
        drop(admission);
        if deliver { self.schedule_held(&rt_arc.lock().unwrap()); }
        Ok(SendOutcome { queued: true, events: vec![event], in_input: false })
    }

    /// The host's normal send semantics, including takeover of a shared tab.
    fn send_held_admitted(&self, admission: &crate::issue_pipeline::admission::Admitted,
        session: &str, tab: &str, text: String, images: Vec<ImageInput>) -> Result<SendOutcome> {
        let mut sharing = self.sharing.lock().unwrap();
        let author = sharing.sessions.get_mut(session).map(|share| {
            share.host_takeover(tab, chrono::Utc::now().timestamp_millis());
            self.sink.emit("session_share_changed", &serde_json::json!({"sessionId": session, "state": share.snapshot(chrono::Utc::now().timestamp_millis(), true)}));
            share.host.clone()
        });
        let prompt = PromptText { mobile: None, agent: text.clone(), display: text, author, shared_connection: None };
        // As send_pressed does, hold sharing through admission for a shared tab.
        if prompt.author.is_none() { drop(sharing); }
        self.send_admitted(admission, session, tab, prompt, images, None, crate::recovery_log::Origin::Composer)
    }

    pub(super) fn schedule_held(&self, rt: &TabRuntime) {
        if !rt.held_queue.ready(rt) { return; }
        let (manager, session, tab) = (self.clone(), rt.session_id.clone(), rt.tab_id.clone());
        std::thread::spawn(move || {
            if let Err(error) = manager.deliver_held(&session, &tab) {
                log::warn!("deliver held follow-up {session}/{tab}: {error:#}");
            }
        });
    }

    pub(super) fn pause_held_for_stop(&self, rt: &mut TabRuntime) {
        if rt.held_queue.items.is_empty() { return; }
        let mut queue = rt.held_queue.clone();
        queue.paused = true;
        queue.next = None;
        if let Err(error) = self.save_held(rt, queue.clone()) {
            // A full disk must not prevent Stop. Keep the in-memory fence.
            rt.held_queue = queue;
            log::warn!("persist queue pause before Stop: {error:#}");
        }
    }

    pub(super) fn deliver_held(&self, session: &str, tab: &str) -> Result<()> {
        self.accepting_work()?;
        let admission = crate::issue_pipeline::admission::lock_for(session, tab);
        let rt_arc = self.runtime(session, tab)?;
        let mut rt = rt_arc.lock().unwrap();
        if !rt.held_queue.ready(&rt) { return Ok(()); }
        let mut queue = rt.held_queue.clone();
        let pos = queue.next.as_deref().map(|id| queue.position(id)).transpose()?.unwrap_or(0);
        let item = queue.items[pos].clone();
        queue.sending = Some(item.id.clone());
        self.save_held(&mut rt, queue)?;
        drop(rt);
        let outcome = item.images.iter().map(unsent::image_input).collect::<Result<Vec<_>>>()
            .and_then(|images| self.send_held_admitted(&admission, session, tab, item.text, images));
        let mut rt = rt_arc.lock().unwrap();
        let mut queue = rt.held_queue.clone();
        queue.sending = None;
        queue.next = None;
        match outcome {
            Ok(_) => { queue.items.retain(|held| held.id != item.id); queue.error = None; }
            Err(error) => { queue.paused = true; queue.error = Some(recovery::detail(&error.to_string()).unwrap_or_else(|| "Could not deliver the follow-up. It is still held.".into())); }
        }
        if let Err(error) = self.save_held(&mut rt, queue.clone()) {
            // The prompt may already be logged/typed. Keep its consumption in
            // memory even if the final snapshot cannot be written; replay also
            // consumes its user_message. Never let a later edit resurrect it.
            queue.paused = true;
            queue.error = Some("Could not save the queue after delivery. Review the conversation before resuming.".into());
            rt.held_queue = queue;
            return Err(error);
        }
        // A very short turn can finish before its send call returns. Its
        // boundary saw the claim; continue now that the claim has settled.
        if rt.status == TabStatus::Completed { self.schedule_held(&rt); }
        Ok(())
    }
}
