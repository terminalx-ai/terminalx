//! Paired-device admission belongs to the process that writes the session.
//! This is authenticated desktop IPC, never a device-facing command surface.
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use super::{Attachment, Lifetime};

#[path = "../pairing/model.rs"]
pub mod model;
use model::{AccountMirror, DeviceEntry, DeviceFile, DeviceProvenance, DeviceScope};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Actor {
    pub epoch: String,
    pub lease: String,
    pub generation: u64,
    pub user_id: Option<String>,
}

struct Owner { actor: Actor, attachment: Arc<Attachment>, revoked: bool }

pub struct Grant {
    actor: Actor,
    attachment: Arc<Attachment>,
    pub device: DeviceEntry,
    active: Mutex<bool>,
    observations: super::mobile_output::Observations,
}

pub struct ReadGuard<'a> {
    _active: MutexGuard<'a, bool>,
    _attachment: MutexGuard<'a, Option<std::time::Instant>>,
}

impl Grant {
    pub fn enter(&self) -> Result<ReadGuard<'_>> {
        let attachment = self.attachment.enter()?;
        let active = self.active.lock().unwrap();
        if !*active { bail!("The paired-device grant was revoked."); }
        Ok(ReadGuard { _active:active, _attachment:attachment })
    }
    pub fn valid(&self) -> bool { self.enter().is_ok() }
    fn revoke(&self) {
        *self.active.lock().unwrap() = false;
        self.observations.clear();
    }
    pub fn driver(&self) -> Result<()> {
        if self.device.scope != DeviceScope::Driver { bail!("This paired device is read-only."); }
        Ok(())
    }
}

#[derive(Clone)]
pub struct WritePermit {
    pub grant: Arc<Grant>,
    revision: Arc<Mutex<u64>>,
    epoch: u64,
    mode: String,
}

pub struct WriteGuard<'a> {
    _grant: ReadGuard<'a>,
    _revision: MutexGuard<'a, u64>,
}

impl WritePermit {
    pub fn enter(&self) -> Result<WriteGuard<'_>> {
        self.grant.driver()?;
        let grant = self.grant.enter()?;
        let revision = self.revision.lock().unwrap();
        if *revision != self.epoch { bail!("The tab changed before paired-device input was delivered."); }
        Ok(WriteGuard { _grant:grant,_revision:revision })
    }
    pub fn valid(&self) -> bool { self.enter().is_ok() }
    pub fn check_mode(&self, session: &str, tab: &str) -> Result<()> {
        let entry = crate::store::index::get(session)?;
        if entry.tab(tab).is_none_or(|tab| tab.permission_mode != self.mode) {
            bail!("The permission mode changed before mobile input was delivered.");
        }
        Ok(())
    }
}

#[derive(Default)]
struct State {
    owners: HashMap<String, Owner>,
    connections: HashMap<String, Arc<Grant>>,
    revoked: HashSet<(String,String)>,
    revisions: HashMap<String,Arc<Mutex<u64>>>,
    drivers: HashMap<String, Arc<Driver>>,
}

/// The fifth field is each pane's input gate: see [`Registry::desktop_input`].
#[derive(Default)]
pub struct Registry(Mutex<State>, Mutex<Queue>, std::sync::atomic::AtomicBool, Mutex<HashSet<(String,String)>>, Mutex<HashMap<String,Arc<Mutex<()>>>>);

impl State {
    fn owner(&self, actor: &Actor) -> Result<()> {
        if self.owners.get(&actor.lease).is_none_or(|owner| owner.actor != *actor || owner.revoked) {
            bail!("The paired-device account or desktop attachment changed.");
        }
        Ok(())
    }
}

struct Driver {
    connection: String,
    grant: Arc<Grant>,
    active: Mutex<bool>,
    session: String,
    tab: String,
    pane: String,
    pid: u32,
}
impl Driver {
    fn valid(&self) -> bool {
        let Ok(_grant) = self.grant.enter() else { return false };
        *self.active.lock().unwrap()
    }
}

struct Pending {
    session: String,
    tab: String,
    agent: String,
    display: String,
    images: Vec<crate::session::ImageInput>,
    permit: WritePermit,
    /// The phone's id for this message (#675): sending it again finds this
    /// copy instead of adding a second one.
    message: Option<String>,
}

/// One phone message to one tab, by the id the phone gave it (#675).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct MessageKey { session: String, tab: String, id: String }

/// What a phone sending a message again finds of the copy it sent first
/// (#675). The phone learns of a send only from the reply, which a dropped
/// connection loses, and a queued copy outlives that reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Repeat {
    /// The agent has it. Nothing is sent.
    Delivered,
    /// Still waiting for the agent's turn. A copy queued under a connection
    /// is skipped once that connection closes, so it now waits under this
    /// one, in the same place in line.
    Requeued,
    /// Being typed to the agent right now: whether it arrives is not known yet.
    Delivering,
}

/// What a phone send came to.
enum Sent { Outcome(crate::session::SendOutcome), Repeat(Repeat) }

/// Where the first copy of a phone message is.
enum Earlier { Delivered, Delivering, Queued(usize) }

/// A phone message the agent has is remembered for a day, at most this many.
const DELIVERED_KEEP: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);
const DELIVERED_COUNT: usize = 1_000;

#[derive(Default)]
struct Queue {
    items: VecDeque<Pending>,
    in_flight: usize,
    in_flight_bytes: usize,
    /// Phone messages `drain` is delivering right now (#675).
    delivering: HashSet<MessageKey>,
    /// Phone messages the agent has, oldest first (#675).
    delivered: VecDeque<(MessageKey, std::time::Instant)>,
}
impl Queue {
    fn accepts(&self, bytes: usize) -> bool {
        self.items.len() + self.in_flight < 64
            && self.items.iter().map(Pending::bytes).sum::<usize>() + self.in_flight_bytes + bytes <= 16 * 1024 * 1024
    }

    fn earlier(&mut self, key: &MessageKey, now: std::time::Instant) -> Option<Earlier> {
        self.delivered.retain(|(_, at)| now.duration_since(*at) < DELIVERED_KEEP);
        if self.delivered.iter().any(|(delivered, _)| delivered == key) { return Some(Earlier::Delivered); }
        if self.delivering.contains(key) { return Some(Earlier::Delivering); }
        self.items.iter().position(|item| item.is(key)).map(Earlier::Queued)
    }

    fn record_delivered(&mut self, key: MessageKey, now: std::time::Instant) {
        self.delivered.push_back((key, now));
        while self.delivered.len() > DELIVERED_COUNT { self.delivered.pop_front(); }
    }
}
struct InFlight<'a> { queue: &'a Mutex<Queue>, bytes: usize, key: Option<MessageKey> }
impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let mut queue = self.queue.lock().unwrap();
        queue.in_flight -= 1;
        queue.in_flight_bytes -= self.bytes;
        if let Some(key) = &self.key { queue.delivering.remove(key); }
    }
}
impl Pending {
    fn bytes(&self) -> usize { self.agent.len() + self.display.len() + self.images.iter().map(|image| image.data.len()).sum::<usize>() }
    fn key(&self) -> Option<MessageKey> {
        self.message.as_ref().map(|id| MessageKey { session: self.session.clone(), tab: self.tab.clone(), id: id.clone() })
    }
    fn is(&self, key: &MessageKey) -> bool {
        self.message.as_deref() == Some(key.id.as_str()) && self.session == key.session && self.tab == key.tab
    }
    fn send(&self, manager: &crate::session::SessionManager) -> Result<crate::session::SendOutcome> {
        manager.send_mobile(&self.session, &self.tab, self.agent.clone(), self.display.clone(), self.images.clone(), self.permit.clone())
    }
}

impl Registry {
    // Lock hierarchy: pane gate (claims only), sharing/admission (when needed),
    // attachment, grant, driver/revision, registry metadata. Never wait for
    // authority under registry, and never write to a terminal under it.
    // An attachment serializes mutations for its lease; revalidate metadata after
    // acquiring it so a delayed old-generation request cannot affect a new owner.
    fn owner_attachment(&self, actor: &Actor) -> Result<Arc<Attachment>> {
        let attachment = {
            let state = self.0.lock().unwrap();
            state.owner(actor)?;
            state.owners[&actor.lease].attachment.clone()
        };
        #[cfg(test)]
        lock_tests::after_snapshot();
        Ok(attachment)
    }

    fn check_owner(&self, actor: &Actor) -> Result<()> {
        let attachment = self.owner_attachment(actor)?;
        let _attached = attachment.enter()?;
        self.0.lock().unwrap().owner(actor)
    }

    fn prune(&self) {
        let (owners, connections, drivers) = {
            let state = self.0.lock().unwrap();
            (state.owners.iter().map(|(key,owner)|(key.clone(),owner.attachment.clone())).collect::<Vec<_>>(),
             state.connections.iter().map(|(key,grant)|(key.clone(),grant.clone())).collect::<Vec<_>>(),
             state.drivers.iter().map(|(key,driver)|(key.clone(),driver.clone())).collect::<Vec<_>>())
        };
        let owners: Vec<_> = owners.into_iter().filter(|(_,attachment)| !attachment.valid()).collect();
        let connections: Vec<_> = connections.into_iter().filter(|(_,grant)| !grant.attachment.valid()).collect();
        let drivers: Vec<_> = drivers.into_iter().filter(|(_,driver)| !driver.valid()).collect();
        let mut state = self.0.lock().unwrap();
        // Invalid authority never revives. Pointer identity protects replacements
        // installed after this snapshot; no child lock is taken in this section.
        for (key,attachment) in owners {
            if state.owners.get(&key).is_some_and(|owner| Arc::ptr_eq(&owner.attachment,&attachment)) { state.owners.remove(&key); }
        }
        for (key,grant) in connections {
            if state.connections.get(&key).is_some_and(|current| Arc::ptr_eq(current,&grant)) { state.connections.remove(&key); }
        }
        for (key,driver) in drivers {
            if state.drivers.get(&key).is_some_and(|current| Arc::ptr_eq(current,&driver)) { state.drivers.remove(&key); }
        }
        let leases: HashSet<_> = state.owners.keys().cloned().collect();
        state.revoked.retain(|(lease,_)| leases.contains(lease));
    }

    fn drivers(&self) -> Vec<Arc<Driver>> {
        self.0.lock().unwrap().drivers.values().cloned().collect()
    }
    fn claim_driver(&self, connection: &str, permit: &WritePermit, session: &str, tab: &str, pane: &str, pid: u32) -> Result<Arc<Driver>> {
        self.prune();
        let gate = self.gate(pane);
        let _gate = gate.lock().unwrap();
        let _admitted = permit.enter()?;
        let mut state = self.0.lock().unwrap();
        state.owner(&permit.grant.actor)?;
        let key = format!("{session}/{tab}");
        if let Some(driver) = state.drivers.get(&key) {
            if driver.connection != connection || driver.pane != pane || driver.pid != pid {
                bail!("Another mobile client or terminal instance owns this driver lease.");
            }
            return Ok(driver.clone());
        }
        if state.drivers.len() >= 128 { bail!("Too many mobile driver leases."); }
        let driver = Arc::new(Driver { connection:connection.into(),grant:permit.grant.clone(),active:Mutex::new(true),
            session:session.into(),tab:tab.into(),pane:pane.into(),pid });
        state.drivers.insert(key,driver.clone());
        Ok(driver)
    }

    fn release_driver(&self, actor: &Actor, connection: &str, session: &str, tab: &str) -> Result<()> {
        let attachment = self.owner_attachment(actor)?;
        let _attached = attachment.enter()?;
        let key = format!("{session}/{tab}");
        let driver = {
            let state = self.0.lock().unwrap();
            state.owner(actor)?;
            state.drivers.get(&key).cloned()
        };
        if let Some(driver) = driver {
            if driver.connection != connection || driver.grant.actor != *actor { bail!("The driver lease belongs to another connection."); }
            *driver.active.lock().unwrap() = false;
            let mut state = self.0.lock().unwrap();
            if state.drivers.get(&key).is_some_and(|current| Arc::ptr_eq(current,&driver)) { state.drivers.remove(&key); }
        }
        Ok(())
    }

    /// One pane's gate, which a driver claim and desktop input to that pane
    /// both hold. Gates nobody holds are dropped as others are handed out.
    fn gate(&self, pane: &str) -> Arc<Mutex<()>> {
        let mut gates = self.4.lock().unwrap();
        gates.retain(|_, gate| Arc::strong_count(gate) > 1);
        gates.entry(pane.into()).or_default().clone()
    }

    pub(crate) fn desktop_input<T>(&self, pane: &str, write: impl FnOnce() -> Result<T>) -> Result<T> {
        self.prune();
        // Claim/release and desktop input serialize at the owner, not at an
        // asynchronously projected boolean in the window. They meet at the
        // pane's gate, not the registry: the write can wait on a program that
        // has stopped reading, and every hook, control request and the
        // owner's own loop need the registry meanwhile (#661).
        let gate = self.gate(pane);
        let _gate = gate.lock().unwrap();
        self.refuse_if_driven(pane)?;
        write()
    }

    /// Refuse desktop input to a pane a mobile device drives, before queueing
    /// it. Only a first answer: [`Self::desktop_input`] asks again at the write.
    pub(crate) fn check_desktop_input(&self, pane: &str) -> Result<()> {
        self.prune();
        self.refuse_if_driven(pane)
    }

    fn refuse_if_driven(&self, pane: &str) -> Result<()> {
        if self.0.lock().unwrap().drivers.values().any(|driver| driver.pane == pane) {
            bail!("A mobile device is driving this terminal.");
        }
        Ok(())
    }

    fn publish_drivers(&self, manager: &crate::session::SessionManager) {
        let current: HashSet<_> = self.drivers().iter().filter(|driver|driver.valid())
            .map(|driver|(driver.session.clone(),driver.tab.clone())).collect();
        let changes = {
            let mut previous = self.3.lock().unwrap();
            let changes: Vec<_> = current.difference(&previous).map(|key|(key.clone(),true))
                .chain(previous.difference(&current).map(|key|(key.clone(),false))).collect();
            *previous = current;
            changes
        };
        for ((session,tab),active) in changes { manager.mobile_driver_changed(&session,&tab,active); }
    }

    pub(crate) fn driven_tabs(&self) -> Vec<String> {
        let mut tabs: Vec<_> = self.drivers().iter().filter(|driver| driver.valid()).map(|driver| driver.tab.clone()).collect();
        tabs.sort(); tabs.dedup(); tabs
    }

    pub fn has_pending(&self) -> bool {
        let queue = self.1.lock().unwrap();
        !queue.items.is_empty() || queue.in_flight != 0
    }

    fn send(&self, manager: &crate::session::SessionManager, pending: Pending) -> Result<Sent> {
        if pending.bytes() > 8 * 1024 * 1024 { bail!("The mobile prompt is too large."); }
        let pending = match self.repeat(pending)? {
            Ok(repeat) => return Ok(Sent::Repeat(repeat)),
            Err(pending) => pending,
        };
        match pending.send(manager) {
            Ok(outcome) => {
                if let Some(key) = pending.key() { self.1.lock().unwrap().record_delivered(key, std::time::Instant::now()); }
                Ok(Sent::Outcome(outcome))
            }
            Err(error) if error.is::<Busy>() => {
                self.enqueue(pending)?;
                Ok(Sent::Outcome(crate::session::SendOutcome { queued:true, events:Vec::new(), in_input:false }))
            }
            Err(error) => Err(error),
        }
    }

    /// What became of the first copy of a phone message sent again (#675),
    /// or the message back when there is none and it is sent as new. A copy
    /// still queued takes this send's permit: the first one's connection is
    /// the one that dropped.
    fn repeat(&self, pending: Pending) -> Result<std::result::Result<Repeat, Pending>> {
        let Some(key) = pending.key() else { return Ok(Err(pending)) };
        let mut queue = self.1.lock().unwrap();
        match queue.earlier(&key, std::time::Instant::now()) {
            None => Ok(Err(pending)),
            Some(Earlier::Delivered) => Ok(Ok(Repeat::Delivered)),
            Some(Earlier::Delivering) => Ok(Ok(Repeat::Delivering)),
            Some(Earlier::Queued(index)) => {
                if !pending.permit.valid() { bail!("The mobile grant changed before queueing."); }
                queue.items[index] = pending;
                Ok(Ok(Repeat::Requeued))
            }
        }
    }

    fn enqueue(&self, pending: Pending) -> Result<()> {
        let mut queue = self.1.lock().unwrap();
        if !queue.accepts(pending.bytes()) {
            bail!("The mobile follow-up queue is full.");
        }
        // A stop or revocation between the attempted write and this
        // insertion still cannot make the permit current again.
        if !pending.permit.valid() { bail!("The mobile grant changed before queueing."); }
        queue.items.push_back(pending);
        Ok(())
    }

    pub(crate) fn drain(&self, manager: &crate::session::SessionManager) {
        use std::sync::atomic::Ordering;
        if self.2.swap(true, Ordering::SeqCst) { return; }
        struct Reset<'a>(&'a std::sync::atomic::AtomicBool);
        impl Drop for Reset<'_> { fn drop(&mut self) { self.0.store(false, Ordering::SeqCst); } }
        let _reset = Reset(&self.2);
        self.publish_drivers(manager);
        let count = self.1.lock().unwrap().items.len();
        for _ in 0..count {
            let (pending,_flight) = {
                let mut queue = self.1.lock().unwrap();
                let Some(pending) = queue.items.pop_front() else { break };
                let bytes = pending.bytes();
                queue.in_flight += 1;
                queue.in_flight_bytes += bytes;
                // Marked as it leaves the queue, under the same lock: a repeat
                // must never find it in neither place and send a second copy.
                let key = pending.key();
                if let Some(key) = &key { queue.delivering.insert(key.clone()); }
                (pending,InFlight { queue:&self.1,bytes,key })
            };
            if !pending.permit.valid() || pending.permit.check_mode(&pending.session, &pending.tab).is_err() { continue; }
            match pending.send(manager) {
                Ok(_) => if let Some(key) = pending.key() { self.1.lock().unwrap().record_delivered(key, std::time::Instant::now()); },
                // Only this pre-effect refusal is retryable. Never resend a
                // prompt after an uncertain transport/provider write.
                Err(error) if error.is::<Busy>() => self.1.lock().unwrap().items.push_back(pending),
                Err(error) => log::warn!("mobile follow-up delivery refused: {error:#}"),
            }
        }
    }

    pub fn register(&self, lifetime: &Lifetime, actor: Actor, connection: &str, device_id: &str) -> Result<()> {
        if connection.is_empty() || connection.len() > 128 || device_id.is_empty() || device_id.len() > 128 {
            bail!("Invalid paired-device connection.");
        }
        let attachment = lifetime.attachment(&actor.epoch,&actor.lease)?;
        let file: DeviceFile = crate::store::read_json(&crate::store::root()?.join("devices.json"))?.unwrap_or_default();
        let device = file.devices.into_iter().find(|device| device.id == device_id && device.revoked_at.is_none()).context("The device is no longer paired.")?;
        if device.scope == DeviceScope::Session { bail!("Session credentials require scoped session admission."); }
        let mirror: Option<AccountMirror> = crate::store::read_json(&crate::store::root()?.join("account.json"))?;
        match mirror {
            Some(mirror) => {
                if actor.user_id.as_deref() != Some(&mirror.user_id)
                    || device.bound_user_id.as_deref().is_some_and(|user| user != mirror.user_id)
                    || (device.provenance == DeviceProvenance::Automatic && device.binding_generation != mirror.binding_generation) {
                    bail!("The device does not belong to the current host account.");
                }
            }
            None if actor.user_id.is_none() && device.provenance == DeviceProvenance::Explicit && device.bound_user_id.is_none() => {}
            None => bail!("The paired-device host identity is unavailable."),
        }
        self.prune();
        let _attached = attachment.enter()?;
        let old = {
            let state = self.0.lock().unwrap();
            if let Some(owner) = state.owners.get(&actor.lease) {
                if actor.generation < owner.actor.generation || (actor.generation == owner.actor.generation && (actor != owner.actor || owner.revoked)) {
                    bail!("The paired-device account generation is stale.");
                }
                if actor.generation > owner.actor.generation {
                    state.connections.values().filter(|grant| grant.actor.lease == actor.lease).cloned().collect::<Vec<_>>()
                } else { Vec::new() }
            } else { Vec::new() }
        };
        for grant in old { grant.revoke(); }
        let previous = self.0.lock().unwrap().connections.get(connection).cloned();
        if let Some(previous) = previous {
            if previous.actor == actor && previous.device == device && *previous.active.lock().unwrap() { return Ok(()); }
            bail!("The paired-device connection cannot be rebound.");
        }
        let mut state = self.0.lock().unwrap();
        if state.revoked.contains(&(actor.lease.clone(),device_id.into())) { bail!("This device was revoked from the attachment."); }
        // A different attachment can register concurrently, so check again at
        // insertion. Same-lease mutations are serialized by _attached.
        if state.connections.contains_key(connection) { bail!("The paired-device connection cannot be rebound."); }
        if state.connections.len() >= 128 { bail!("Too many paired-device connections."); }
        state.owners.insert(actor.lease.clone(),Owner { actor:actor.clone(),attachment:attachment.clone(),revoked:false });
        state.connections.insert(connection.into(),Arc::new(Grant { actor,attachment:attachment.clone(),device,active:Mutex::new(true),observations:Default::default() }));
        Ok(())
    }

    fn fence_owner(&self, lifetime: &Lifetime, actor: &Actor) -> Result<()> {
        let attachment = lifetime.attachment(&actor.epoch, &actor.lease)?;
        self.prune();
        let _attached = attachment.enter()?;
        let grants = {
            let state = self.0.lock().unwrap();
            if let Some(owner) = state.owners.get(&actor.lease) {
                if owner.actor.generation > actor.generation || (owner.actor.generation == actor.generation && owner.actor != *actor) {
                    bail!("The paired-device account generation is stale.");
                }
                if owner.actor == *actor { return Ok(()); }
            }
            state.connections.values().filter(|grant| grant.actor.lease == actor.lease).cloned().collect::<Vec<_>>()
        };
        for grant in grants { grant.revoke(); }
        self.0.lock().unwrap().owners.insert(actor.lease.clone(), Owner { actor:actor.clone(), attachment:attachment.clone(), revoked:false });
        Ok(())
    }

    pub fn grant(&self, actor: &Actor, connection: &str) -> Result<Arc<Grant>> {
        let grant = {
            let state = self.0.lock().unwrap();
            state.owner(actor)?;
            state.connections.get(connection).filter(|grant| grant.actor == *actor).cloned()
                .context("The paired-device connection expired or was revoked.")?
        };
        #[cfg(test)]
        lock_tests::after_snapshot();
        let admitted = grant.enter()?;
        let state = self.0.lock().unwrap();
        state.owner(actor)?;
        if state.connections.get(connection).is_none_or(|current| !Arc::ptr_eq(current,&grant)) {
            bail!("The paired-device connection expired or was revoked.");
        }
        drop(state);
        drop(admitted);
        Ok(grant)
    }

    pub fn permit(&self, actor: &Actor, connection: &str, session: &str, tab: &str) -> Result<WritePermit> {
        let grant = self.grant(actor,connection)?;
        grant.driver()?;
        let entry = crate::store::index::get(session)?;
        let mode = entry.tab(tab).context("The tab does not belong to this session.")?.permission_mode.clone();
        let revision = self.0.lock().unwrap().revisions.entry(format!("{session}/{tab}")).or_default().clone();
        let epoch = *revision.lock().unwrap();
        Ok(WritePermit { grant,revision,epoch,mode })
    }

    /// Invoke before acquiring a tab's runtime lock. A writer holds its epoch
    /// through actual input; stop/mode changes cannot acknowledge past that write.
    pub fn invalidate_tab(&self, session: &str, tab: &str) {
        let revision = self.0.lock().unwrap().revisions.get(&format!("{session}/{tab}")).cloned();
        if let Some(revision) = revision { *revision.lock().unwrap() += 1; }
    }

    pub fn close(&self, actor: &Actor, connection: &str) -> Result<()> {
        let attachment = self.owner_attachment(actor)?;
        let _attached = attachment.enter()?;
        let grant = {
            let state = self.0.lock().unwrap();
            state.owner(actor)?;
            state.connections.get(connection).cloned()
        };
        if let Some(grant) = grant {
            if grant.actor != *actor { bail!("The connection belongs to another attachment."); }
            grant.revoke();
            let mut state = self.0.lock().unwrap();
            if state.connections.get(connection).is_some_and(|current| Arc::ptr_eq(current,&grant)) { state.connections.remove(connection); }
        }
        Ok(())
    }

    pub fn revoke_device(&self, actor: &Actor, device: &str) -> Result<()> {
        let attachment = self.owner_attachment(actor)?;
        let _attached = attachment.enter()?;
        let (grants,full) = {
            let mut state = self.0.lock().unwrap();
            state.owner(actor)?;
            let full = state.revoked.len() >= 4096;
            let grants = state.connections.values().filter(|grant| grant.actor.lease == actor.lease && (full || grant.device.id == device)).cloned().collect::<Vec<_>>();
            if full { state.owners.get_mut(&actor.lease).unwrap().revoked = true; }
            else { state.revoked.insert((actor.lease.clone(),device.into())); }
            (grants,full)
        };
        for grant in grants { grant.revoke(); }
        if full { bail!("The attachment's revocation capacity was reached; its device grants were closed."); }
        Ok(())
    }

    pub fn clear(&self, actor: &Actor) -> Result<()> {
        let attachment = self.owner_attachment(actor)?;
        let _attached = attachment.enter()?;
        let grants = {
            let mut state = self.0.lock().unwrap();
            state.owner(actor)?;
            state.owners.get_mut(&actor.lease).unwrap().revoked = true;
            state.connections.values().filter(|grant| grant.actor.lease == actor.lease).cloned().collect::<Vec<_>>()
        };
        for grant in grants { grant.revoke(); }
        Ok(())
    }

}

pub fn actor(params: &Value) -> Result<Actor> {
    serde_json::from_value(params["actor"].clone()).context("Invalid paired-device owner identity.")
}


/// Fixed native owner operations. A guest-facing router never forwards arbitrary
/// commands here; every connection is admitted from its persisted device record.
pub fn execute(manager: &crate::session::SessionManager, lifetime: &Lifetime, method: &str, params: Value) -> Result<Value> {
    let actor = actor(&params)?;
    let string = |key: &str| -> Result<&str> { params[key].as_str().with_context(|| format!("{key} must be a string")) };
    match method {
        "drain" => {
            // A native adapter may request a delivery pass. No device input is
            // supplied here, and every queued permit is rechecked by its writer.
            manager.mobile.check_owner(&actor)?;
            manager.mobile.drain(manager);
            return Ok(serde_json::json!({"pending":manager.mobile.has_pending()}));
        }
        "register" => { manager.mobile.register(lifetime, actor, string("connection")?, string("deviceId")?)?; return Ok(Value::Null); }
        "clear" => { manager.mobile.fence_owner(lifetime, &actor)?; manager.mobile.clear(&actor)?; return Ok(Value::Null); }
        "revoke" => { manager.mobile.fence_owner(lifetime, &actor)?; manager.mobile.revoke_device(&actor, string("deviceId")?)?; return Ok(Value::Null); }
        "close" => { manager.mobile.close(&actor, string("connection")?)?; return Ok(Value::Null); }
        _ => {}
    }
    let grant = manager.mobile.grant(&actor, string("connection")?)?;
    if method == "release" {
        manager.mobile.release_driver(&actor,string("connection")?,string("sessionId")?,string("tabId")?)?;
        manager.mobile.publish_drivers(manager);
        return Ok(serde_json::json!({"released":true}));
    }
    if method == "input" {
        let session = string("sessionId")?;
        let tab = string("tabId")?;
        let text = string("text")?;
        if text.is_empty() || text.len() > 64 * 1024 { bail!("Terminal input must contain 1 to 65536 bytes."); }
        let permit = manager.mobile.permit(&actor,string("connection")?,session,tab)?;
        let pane = manager.pane_of(session,tab).context("The terminal is unavailable.")?.pane_id;
        let pid = manager.terminals().pid(&pane).context("The terminal is not running.")?;
        let driver = manager.mobile.claim_driver(string("connection")?,&permit,session,tab,&pane,pid)?;
        let result = (|| {
            let _sharing = manager.sharing.lock().unwrap();
            let _admitted = permit.enter()?;
            let active = driver.active.lock().unwrap();
            if !*active { bail!("The mobile driver lease was released."); }
            permit.check_mode(session,tab)?;
            if manager.pane_of(session,tab).is_none_or(|current| current.pane_id != pane) { bail!("The terminal instance changed."); }
            manager.terminals().write_for_process(&pane,pid,text.as_bytes())
        })();
        if result.is_err() { *driver.active.lock().unwrap() = false; }
        manager.mobile.publish_drivers(manager);
        result?;
        return Ok(serde_json::json!({"accepted":true,"bytesWritten":text.len()}));
    }
    if method == "send" {
        let session = string("sessionId")?;
        let tab = string("tabId")?;
        let permit = manager.mobile.permit(&actor, string("connection")?, session, tab)?;
        let message = match params.get("clientMessageId") {
            None | Some(Value::Null) => None,
            Some(Value::String(id)) if !id.is_empty() && id.len() <= 128 => Some(id.clone()),
            Some(_) => bail!("Invalid mobile message id."),
        };
        let images = serde_json::from_value(params.get("images").cloned().unwrap_or_else(|| serde_json::json!([])))?;
        return phone_send(manager, &actor, &grant, (session, tab), permit, string("text")?.to_string(), string("prompt")?, images, message);
    }
    if let Some(result) = controls(manager, &actor, &grant, method, &params) {
        return result;
    }
    let _admitted = grant.enter()?;
    match method {
        "check" => Ok(Value::Null),
        "observe" => {
            if string("attachMode")? != "observe" || params["client"]["type"] != "mobile" || !params["capabilities"].is_object() {
                bail!("Terminal observation capabilities are invalid.");
            }
            grant.observations.subscribe(manager,string("sessionId")?,string("tabId")?)
        }
        "unobserve" => Ok(serde_json::json!({"removed":grant.observations.unsubscribe(string("subscriptionId")?)})),
        "output" => grant.observations.poll(),
        "reconcile" | "permission" | "terminalRead" => {
            let session = string("sessionId")?;
            let tab = string("tabId")?;
            let entry = crate::store::index::get(session)?;
            if entry.tab(tab).is_none() { bail!("The tab does not belong to this session."); }
            match method {
                "permission" => {
                    grant.driver()?;
                    manager.respond_permission(session, tab, string("requestId")?, string("optionId")?)?;
                    Ok(serde_json::json!({"status":"answered"}))
                }
                "reconcile" => {
                    manager.load_events(session, tab)?;
                    Ok(Value::Null)
                }
                _ => {
                    let pane = manager.pane_of(session, tab).map(|pane|pane.pane_id)
                        .unwrap_or_else(||entry.tab(tab).expect("validated tab").pane_id());
                    let bytes = manager.terminals().read_output(&pane).context("Terminal output is unavailable.")?;
                    Ok(serde_json::json!({"text":String::from_utf8_lossy(&bytes)}))
                }
            }
        }
        _ => bail!("Unsupported paired-device owner operation."),
    }
}


/// A phone's prompt to a tab, as the agent gets it: who it is from, then what
/// was typed. It goes through the queue, so a busy tab takes it after its turn.
#[allow(clippy::too_many_arguments)]
fn phone_send(manager: &crate::session::SessionManager, actor: &Actor, grant: &Grant, (session, tab): (&str, &str), permit: WritePermit,
    display: String, prompt: &str, images: Vec<crate::session::ImageInput>, message: Option<String>) -> Result<Value> {
    let mirror: Option<AccountMirror> = crate::store::read_json(&crate::store::root()?.join("account.json"))?;
    let (user, name) = match mirror {
        Some(mirror) if actor.user_id.as_deref() == Some(&mirror.user_id) =>
            (mirror.user_id, if mirror.display_name.trim().is_empty() { mirror.email } else { mirror.display_name }),
        None if actor.user_id.is_none() => (grant.device.id.clone(), if grant.device.label.trim().is_empty() { "Paired mobile device".into() } else { grant.device.label.clone() }),
        _ => bail!("The mobile host identity changed."),
    };
    let envelope = serde_json::json!({"userId":user,"displayName":name,"authority":"host"});
    let pending = Pending { session:session.into(), tab:tab.into(),
        agent:format!("[TerminalX Effective User v1] {envelope}\n{prompt}"), display, images, permit, message };
    Ok(match manager.mobile.send(manager,pending)? {
        Sent::Outcome(outcome) => serde_json::to_value(outcome)?,
        // Shaped as an outcome: `queued` reads as it always has.
        Sent::Repeat(repeat) => serde_json::json!({"queued":repeat != Repeat::Delivered,"events":[],"repeat":repeat}),
    })
}

/// The session controls a phone offers as the desktop does (`sessionControls`
/// in the phone protocol). Each is the desktop's own operation, after a
/// phone's device checks: a live grant for all of them, and a driver for any
/// change. Nothing of the device is held across the operation: Stop waits for
/// the agent's exit, and a mode, a tab or a send takes sharing and admission,
/// which come before a device's grant in the lock order. `None` for any other
/// method.
fn controls(manager: &crate::session::SessionManager, actor: &Actor, grant: &Grant, method: &str, params: &Value) -> Option<Result<Value>> {
    const CHANGES: &[&str] = &["stop", "interrupt", "setModel", "setEffort", "setMode", "resendUnsent", "continue"];
    const READS: &[&str] = &["tab", "models", "prepareContinuation"];
    if !CHANGES.contains(&method) && !READS.contains(&method) { return None; }
    Some((|| {
        let string = |key: &str| -> Result<&str> { params[key].as_str().with_context(|| format!("{key} must be a string")) };
        if CHANGES.contains(&method) { grant.driver()?; }
        drop(grant.enter()?);
        if method == "models" {
            return Ok(serde_json::to_value(crate::models::list(&manager.codex_models(), params["refresh"].as_bool().unwrap_or(false)))?);
        }
        let (session, tab) = (string("sessionId")?, string("tabId")?);
        let entry = crate::store::index::get(session)?;
        let current = entry.tab(tab).context("The tab does not belong to this session.")?;
        Ok(match method {
            "tab" => serde_json::json!({
                "harness": current.harness, "model": current.model, "effort": current.effort, "permissionMode": current.permission_mode,
                "requestedModel": current.requested_model, "requestedEffort": current.requested_effort,
                "requestedPermissionMode": current.requested_permission_mode, "status": manager.status_of(session, tab),
            }),
            "stop" => { manager.stop(session, tab)?; Value::Null }
            "interrupt" => serde_json::json!({ "interrupted": manager.interrupt(session, tab)? }),
            "setModel" => { manager.set_model(session, tab, string("model")?)?; Value::Null }
            "setEffort" => { manager.set_effort(session, tab, params["effort"].as_str())?; Value::Null }
            "setMode" => { manager.set_permission_mode(session, tab, string("mode")?)?; Value::Null }
            "resendUnsent" => {
                let (text, images) = manager.unsent_prompt(session, tab)?;
                let permit = manager.mobile.permit(actor, string("connection")?, session, tab)?;
                phone_send(manager, actor, grant, (session, tab), permit, text.clone(), &text, images, None)?
            }
            "prepareContinuation" => serde_json::to_value(crate::continuation::prepare(session, tab, manager.tracked_transcript(session, tab))?)?,
            // "Continue in new session": a new tab in this session with the
            // chosen agent and settings, handed the prompt the phone built from
            // `prepareContinuation`, delivered with a receipt as the desktop's.
            _ => {
                let settings: crate::session_ops::NewTab = serde_json::from_value(params["tab"].clone()).context("Invalid new tab settings.")?;
                let started = manager.add_tab(session, &settings)?;
                let delivered = manager.ensure_started(session, &started.id).and_then(|()| manager.send_confirmed(session, &started.id, string("prompt")?.to_owned()));
                match delivered {
                    Ok(outcome) => serde_json::json!({ "tab": started, "delivered": true, "inInput": outcome.in_input }),
                    // The tab is there either way: the phone opens it to check.
                    Err(error) => serde_json::json!({ "tab": started, "delivered": false, "error": format!("{error:#}") }),
                }
            }
        })
    })())
}

#[derive(Debug)]
pub struct Busy;
impl std::fmt::Display for Busy {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { out.write_str("The agent is busy; the mobile prompt must wait.") }
}
impl std::error::Error for Busy {}

#[cfg(test)]
mod queue_tests {
    use super::*;

    #[test]
    fn popped_delivery_keeps_its_queue_budget_until_the_writer_returns() {
        let queue = Mutex::new(Queue { in_flight:64,in_flight_bytes:16*1024*1024,..Queue::default() });
        let delivery = InFlight { queue:&queue,bytes:8*1024*1024,key:None };
        assert!(!queue.lock().unwrap().accepts(1));
        drop(delivery);
        assert!(queue.lock().unwrap().accepts(8*1024*1024));
        assert!(!queue.lock().unwrap().accepts(8*1024*1024+1));
        assert_eq!(queue.lock().unwrap().in_flight,63);
    }

    #[test]
    fn a_delivered_phone_message_is_remembered_for_a_day_at_most_a_thousand() {
        let key = |id: &str| MessageKey { session:"session".into(),tab:"tab".into(),id:id.into() };
        let mut queue = Queue::default();
        let now = std::time::Instant::now();
        queue.record_delivered(key("draft-1"),now);
        assert!(matches!(queue.earlier(&key("draft-1"),now),Some(Earlier::Delivered)));
        // Another tab's message under the same id is another message.
        assert!(queue.earlier(&MessageKey { tab:"other".into(),..key("draft-1") },now).is_none());
        assert!(queue.earlier(&key("draft-1"),now + DELIVERED_KEEP).is_none());

        for index in 0..=DELIVERED_COUNT { queue.record_delivered(key(&format!("id-{index}")),now); }
        assert_eq!(queue.delivered.len(),DELIVERED_COUNT);
        assert!(queue.earlier(&key("id-0"),now).is_none());
        assert!(matches!(queue.earlier(&key(&format!("id-{DELIVERED_COUNT}")),now),Some(Earlier::Delivered)));

        // `drain` marks a message as it takes it from the queue.
        queue.delivering.insert(key("draft-2"));
        assert!(matches!(queue.earlier(&key("draft-2"),now),Some(Earlier::Delivering)));
        // Its delivery over, whichever way it went, it is no longer being delivered.
        queue.in_flight = 1;
        let shared = Mutex::new(queue);
        drop(InFlight { queue:&shared,bytes:0,key:Some(key("draft-2")) });
        assert!(shared.lock().unwrap().earlier(&key("draft-2"),now).is_none());
    }

    #[test]
    fn a_repeat_reports_what_it_found_as_a_send_outcome() {
        let outcome = |repeat: Repeat| serde_json::json!({"queued":repeat != Repeat::Delivered,"events":[],"repeat":repeat});
        assert_eq!(outcome(Repeat::Requeued),serde_json::json!({"queued":true,"events":[],"repeat":"requeued"}));
        assert_eq!(outcome(Repeat::Delivered)["repeat"],"delivered");
        assert_eq!(outcome(Repeat::Delivering)["repeat"],"delivering");
        // A desktop that predates `repeat` reads it as the outcome it always got.
        let old: crate::session::SendOutcome = serde_json::from_value(outcome(Repeat::Requeued)).unwrap();
        assert!(old.queued);
    }
}

/// A phone message sent again after its reply was lost (#675), against real
/// grants and real connection closes. Runs in a child process, as the other
/// owner fixtures do, and never delivers: no provider is launched.
#[cfg(test)]
mod repeat_tests {
    use super::*;
    use crate::{harness::host::Host, pty, session::SessionManager, sink, store};
    use serde_json::json;
    use std::time::{Duration, Instant};

    const CHILD: &str = "TERMINALX_TEST_MOBILE_REPEAT_CHILD";

    #[test]
    fn a_message_sent_again_finds_its_first_copy_instead_of_queueing_another() {
        let dir = tempfile::tempdir().unwrap();
        let log = std::fs::File::create(dir.path().join("child.log")).unwrap();
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "local_runtime::mobile::repeat_tests::repeat_child", "--nocapture"])
            .env(CHILD, "1").env("TERMINALX_HOME", dir.path().join("store"))
            .env("CLAUDE_CONFIG_DIR", dir.path().join("claude"))
            .stdin(std::process::Stdio::null()).stdout(log.try_clone().unwrap()).stderr(log)
            .spawn().unwrap();
        let until = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() { break status; }
            if Instant::now() >= until {
                child.kill().unwrap(); child.wait().unwrap();
                panic!("mobile repeat fixture exceeded its deadline");
            }
            std::thread::sleep(Duration::from_millis(20));
        };
        let log = std::fs::read_to_string(dir.path().join("child.log")).unwrap();
        assert!(status.success(), "{log}");
        assert!(log.contains("1 passed"), "the fixture did not run: {log}");
    }

    #[test]
    fn repeat_child() {
        if std::env::var(CHILD).is_err() { return; }
        let _home = store::temp_home();
        let root = store::root().unwrap();
        let entry: store::index::SessionEntry = serde_json::from_value(json!({
            "id":"repeat","projectPath":root,"cwd":root,"title":"fixture",
            "created":store::index::now(),"modified":store::index::now(),
            "tabs":[{"id":"tab","harness":"claude","permissionMode":"manual","created":store::index::now()}]
        })).unwrap();
        store::index::save(&[entry]).unwrap();
        store::write_json(&root.join("devices.json"), &json!({"devices":[{
            "id":"driver","label":"Fixture","platform":"test","token":"fixture-hash",
            "scope":"driver","provenance":"explicit","bindingGeneration":0,"createdAt":store::index::now()
        }]})).unwrap();
        let manager = SessionManager::new(Arc::new(sink::BroadcastSink::new(256)),Arc::new(sink::NoObserver),
            Arc::new(Host::new()),Arc::new(pty::Terminals::new()),Arc::new(Default::default()),
            Arc::new(Default::default()),crate::hooks::prepare_control().unwrap());
        let lifetime = Lifetime::new(Duration::from_secs(60));
        let lease = lifetime.command("runtime.attach",json!({"protocol":1})).unwrap();
        let actor: Actor = serde_json::from_value(json!({"epoch":lease["epoch"],"lease":lease["lease"],"generation":1,"userId":null})).unwrap();
        for connection in ["earlier", "dropped", "replacement"] {
            manager.mobile.register(&lifetime,actor.clone(),connection,"driver").unwrap();
        }
        let registry = &manager.mobile;
        let pending = |connection: &str, id: Option<&str>| Pending {
            session:"repeat".into(),tab:"tab".into(),agent:"Ship it".into(),display:"Ship it".into(),images:Vec::new(),
            permit:registry.permit(&actor,connection,"repeat","tab").unwrap(),message:id.map(str::to_owned),
        };
        let queued = || registry.1.lock().unwrap().items.iter()
            .map(|item| (item.message.clone().unwrap_or_default(),item.permit.valid())).collect::<Vec<_>>();
        let repeat = |pending: Pending| registry.repeat(pending).unwrap().ok();

        // A copy queued under a connection that then closed is skipped by
        // `drain`, and nothing records it: sent again, it goes as new.
        registry.enqueue(pending("earlier",Some("draft-0"))).unwrap();
        registry.close(&actor,"earlier").unwrap();
        registry.drain(&manager);
        assert!(queued().is_empty());
        assert_eq!(repeat(pending("replacement",Some("draft-0"))),None);

        // The agent's turn is open: the first copy waits in line, under the
        // connection that then drops before the phone hears it was queued.
        registry.enqueue(pending("dropped",Some("draft-1"))).unwrap();
        registry.enqueue(pending("dropped",Some("draft-2"))).unwrap();
        registry.close(&actor,"dropped").unwrap();
        assert_eq!(queued(),vec![("draft-1".into(),false),("draft-2".into(),false)]);
        // Sent again over the connection that replaced it: that same copy,
        // now under a live permit and in the same place in line, not a second.
        assert_eq!(repeat(pending("replacement",Some("draft-1"))),Some(Repeat::Requeued));
        assert_eq!(queued(),vec![("draft-1".into(),true),("draft-2".into(),false)]);
        assert_eq!(repeat(pending("replacement",Some("draft-1"))),Some(Repeat::Requeued));
        assert_eq!(queued().len(),2);

        // Without an id, or with one never sent, a message is another message.
        assert_eq!(repeat(pending("replacement",None)),None);
        assert_eq!(repeat(pending("replacement",Some("draft-3"))),None);

        // Delivered, or being delivered: nothing is queued or sent.
        registry.1.lock().unwrap().record_delivered(MessageKey { session:"repeat".into(),tab:"tab".into(),id:"draft-4".into() },Instant::now());
        assert_eq!(repeat(pending("replacement",Some("draft-4"))),Some(Repeat::Delivered));
        registry.1.lock().unwrap().delivering.insert(MessageKey { session:"repeat".into(),tab:"tab".into(),id:"draft-5".into() });
        assert_eq!(repeat(pending("replacement",Some("draft-5"))),Some(Repeat::Delivering));
        assert_eq!(queued().len(),2);

        // A repeat whose own connection is gone cannot revive the copy.
        let stale = pending("replacement",Some("draft-1"));
        registry.close(&actor,"replacement").unwrap();
        assert!(registry.repeat(stale).is_err());

        registry.1.lock().unwrap().items.clear();
        lifetime.command("runtime.detach",lease).unwrap();
        assert!(manager.terminals().panes().is_empty(),"a repeat must not launch a provider");
    }
}

#[cfg(test)]
mod input_tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// A desktop write waiting on a program that stopped reading must not hold
    /// the registry: every hook and the owner's own loop would wait with it (#661).
    #[test]
    fn a_waiting_desktop_write_holds_only_its_own_pane() {
        let registry = Arc::new(Registry::default());
        let (entered, writing) = mpsc::channel();
        let (release, held) = mpsc::channel::<()>();
        let stuck = registry.clone();
        let first = std::thread::spawn(move || stuck.desktop_input("tab:stuck", || {
            entered.send(()).unwrap();
            // A regression must fail rather than hang the test runner.
            let _ = held.recv_timeout(Duration::from_secs(10));
            Ok(())
        }));
        writing.recv_timeout(Duration::from_secs(5)).unwrap();
        let (done, finished) = mpsc::channel();
        let other = registry.clone();
        std::thread::spawn(move || {
            let tabs = other.driven_tabs();
            let written = other.desktop_input("tab:other", || Ok(())).is_ok();
            done.send((tabs, written)).unwrap();
        });
        let (tabs, written) = finished.recv_timeout(Duration::from_secs(2)).expect("the registry waited for another pane's write");
        assert!(tabs.is_empty());
        assert!(written);
        // Input to the same pane still takes its turn after the first.
        let (queued, delivered) = mpsc::channel();
        let same = registry.clone();
        std::thread::spawn(move || queued.send(same.desktop_input("tab:stuck", || Ok(())).is_ok()).unwrap());
        assert!(delivered.recv_timeout(Duration::from_millis(300)).is_err(), "two writes to one pane overlapped");
        release.send(()).unwrap();
        first.join().unwrap().unwrap();
        assert!(delivered.recv_timeout(Duration::from_secs(5)).unwrap());
        assert!(registry.4.lock().unwrap().values().all(|gate| Arc::strong_count(gate) == 1));
    }
}

#[cfg(test)]
#[path = "mobile_lock_tests.rs"]
mod lock_tests;
