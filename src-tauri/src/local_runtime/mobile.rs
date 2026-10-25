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

#[derive(Default)]
pub struct Registry(Mutex<State>, Mutex<Queue>, std::sync::atomic::AtomicBool, Mutex<HashSet<(String,String)>>);

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
}
#[derive(Default)]
struct Queue {
    items: VecDeque<Pending>,
    in_flight: usize,
    in_flight_bytes: usize,
}
impl Queue {
    fn accepts(&self, bytes: usize) -> bool {
        self.items.len() + self.in_flight < 64
            && self.items.iter().map(Pending::bytes).sum::<usize>() + self.in_flight_bytes + bytes <= 16 * 1024 * 1024
    }
}
struct InFlight<'a> { queue: &'a Mutex<Queue>, bytes: usize }
impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        let mut queue = self.queue.lock().unwrap();
        queue.in_flight -= 1;
        queue.in_flight_bytes -= self.bytes;
    }
}
impl Pending {
    fn bytes(&self) -> usize { self.agent.len() + self.display.len() + self.images.iter().map(|image| image.data.len()).sum::<usize>() }
    fn send(&self, manager: &crate::session::SessionManager) -> Result<crate::session::SendOutcome> {
        manager.send_mobile(&self.session, &self.tab, self.agent.clone(), self.display.clone(), self.images.clone(), self.permit.clone())
    }
}

impl Registry {
    // Lock hierarchy: sharing/admission (when needed), attachment, grant,
    // driver/revision, registry metadata. Never wait for authority under registry.
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

    pub(crate) fn desktop_input<T>(&self, pane: &str, write: impl FnOnce() -> Result<T>) -> Result<T> {
        self.prune();
        let state = self.0.lock().unwrap();
        if state.drivers.values().any(|driver| driver.pane == pane) {
            bail!("A mobile device is driving this terminal.");
        }
        // Claim/release and desktop input serialize at the owner, not at an
        // asynchronously projected boolean in the window.
        write()
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

    fn send(&self, manager: &crate::session::SessionManager, pending: Pending) -> Result<crate::session::SendOutcome> {
        if pending.bytes() > 8 * 1024 * 1024 { bail!("The mobile prompt is too large."); }
        match pending.send(manager) {
            Ok(outcome) => Ok(outcome),
            Err(error) if error.is::<Busy>() => {
                let mut queue = self.1.lock().unwrap();
                if !queue.accepts(pending.bytes()) {
                    bail!("The mobile follow-up queue is full.");
                }
                // A stop or revocation between the attempted write and this
                // insertion still cannot make the permit current again.
                if !pending.permit.valid() { bail!("The mobile grant changed before queueing."); }
                queue.items.push_back(pending);
                Ok(crate::session::SendOutcome { queued:true, events:Vec::new() })
            }
            Err(error) => Err(error),
        }
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
                (pending,InFlight { queue:&self.1,bytes })
            };
            if !pending.permit.valid() || pending.permit.check_mode(&pending.session, &pending.tab).is_err() { continue; }
            match pending.send(manager) {
                Ok(_) => {},
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
        let display = string("text")?.to_string();
        let prompt = string("prompt")?;
        let mirror: Option<AccountMirror> = crate::store::read_json(&crate::store::root()?.join("account.json"))?;
        let (user, name) = match mirror {
            Some(mirror) if actor.user_id.as_deref() == Some(&mirror.user_id) =>
                (mirror.user_id, if mirror.display_name.trim().is_empty() { mirror.email } else { mirror.display_name }),
            None if actor.user_id.is_none() => (grant.device.id.clone(), if grant.device.label.trim().is_empty() { "Paired mobile device".into() } else { grant.device.label.clone() }),
            _ => bail!("The mobile host identity changed."),
        };
        let envelope = serde_json::json!({"userId":user,"displayName":name,"authority":"host"});
        let pending = Pending { session:session.into(),tab:tab.into(),
            agent:format!("[TerminalX Effective User v1] {envelope}\n{prompt}"), display,
            images:serde_json::from_value(params.get("images").cloned().unwrap_or_else(|| serde_json::json!([])))?,permit };
        return Ok(serde_json::to_value(manager.mobile.send(manager,pending)?)?);
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
        let delivery = InFlight { queue:&queue,bytes:8*1024*1024 };
        assert!(!queue.lock().unwrap().accepts(1));
        drop(delivery);
        assert!(queue.lock().unwrap().accepts(8*1024*1024));
        assert!(!queue.lock().unwrap().accepts(8*1024*1024+1));
        assert_eq!(queue.lock().unwrap().in_flight,63);
    }
}

#[cfg(test)]
#[path = "mobile_lock_tests.rs"]
mod lock_tests;
