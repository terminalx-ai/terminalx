//! Process-local invitations and verified people for one local session.
//!
//! The caller holds the session manager's sharing lock through admission and
//! the write. Link edits, revocation and permission-mode changes use that same
//! lock, so an earlier check cannot authorize a later write.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

pub const MAX_GUESTS: usize = 32;
pub const LEASE_MS: i64 = 30_000;
pub const IDENTITY_MS: i64 = 60_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub user_id: String,
    pub display_name: String,
    pub email: String,
    #[serde(default)]
    pub email_verified: bool,
    #[serde(default)]
    pub organization_ids: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Viewer,
    #[default]
    Driver,
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Audience {
    #[default]
    Anyone,
    People,
    Organization,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NamedPerson {
    pub email: String,
    pub role: Role,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LinkSettings {
    pub audience: Audience,
    pub role: Role,
    pub people: Vec<NamedPerson>,
    pub expires_at: i64,
    pub approve_each_person: bool,
    pub can_approve: bool,
    pub maximum_people: usize,
    pub single_use: bool,
}

impl LinkSettings {
    pub fn validate(&mut self, now: i64) -> Result<()> {
        if self.expires_at <= now || self.expires_at > now + 24 * 60 * 60 * 1000 {
            bail!("Choose an expiry within the next 24 hours.");
        }
        if !(1..=MAX_GUESTS).contains(&self.maximum_people) || self.people.len() > 100 {
            bail!("A link may admit 1 to {MAX_GUESTS} people and list at most 100 accounts.");
        }
        let mut emails = HashSet::new();
        for entry in &mut self.people {
            entry.email = entry.email.trim().to_lowercase();
            if !entry.email.contains('@')
                || entry.email.len() > 254
                || !emails.insert(entry.email.clone())
            {
                bail!("Enter distinct email addresses.");
            }
        }
        if self.audience == Audience::People && self.people.is_empty() {
            bail!("Add at least one account.");
        }
        Ok(())
    }

    fn role_for(&self, person: &Person, org: &str) -> Option<Role> {
        match self.audience {
            Audience::Anyone => Some(self.role),
            Audience::People if person.email_verified => self
                .people
                .iter()
                .find(|entry| entry.email == person.email.trim().to_lowercase())
                .map(|entry| entry.role),
            Audience::Organization
                if !org.is_empty() && person.organization_ids.iter().any(|id| id == org) =>
            {
                Some(self.role)
            }
            _ => None,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: String,
    pub settings: LinkSettings,
    pub url: String,
    pub direct_only: bool,
    pub credential_expires_at: i64,
    #[serde(skip)]
    pub join_attempts: VecDeque<i64>,
    pub revoked: bool,
    #[serde(skip)]
    pub token_hash: String,
    #[serde(skip)]
    pub blocked: HashSet<String>,
    #[serde(skip)]
    pub approved: HashSet<String>,
    #[serde(skip)]
    pub used_by: Option<String>,
}

pub struct Guest {
    pub connection_id: String,
    pub link_id: String,
    pub person: Person,
    pub role: Role,
    pub can_approve: bool,
    pub admitted: bool,
    pub verified_until: i64,
    pub active: Arc<AtomicBool>,
    pub cancel: tokio::sync::mpsc::UnboundedSender<()>,
    pub viewing: Option<String>,
    pub typing: bool,
    pub last_write: i64,
    pub write_revision: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lease {
    pub tab_id: String,
    pub holder: Person,
    pub expires_at: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub author: Person,
    pub text: String,
    pub created_at: i64,
}

#[derive(Clone)]
pub struct WritePermit {
    pub connection_id: String,
    pub revision: u64,
    pub tab_epoch: u64,
}

#[derive(Clone)]
pub struct QueuedInput {
    pub connection_id: String,
    pub tab_id: String,
    pub text: String,
}

pub struct Share {
    pub organization_id: String,
    pub session_id: String,
    pub host_id: String,
    pub host: Person,
    pub links: BTreeMap<String, Link>,
    pub guests: HashMap<String, Guest>,
    pub leases: BTreeMap<String, Lease>,
    pub tab_epochs: HashMap<String, u64>,
    pub shell_tabs: BTreeMap<String, String>,
    pub queue: VecDeque<QueuedInput>,
    pub notes: VecDeque<Note>,
    pub activity: VecDeque<Value>,
}

#[derive(Default)]
pub struct Sharing {
    pub sessions: HashMap<String, Share>,
}

impl Share {
    pub fn new(host_id: String, organization_id: String, session_id: String) -> Self {
        Self {
            session_id,
            host: Person {
                user_id: host_id.clone(),
                display_name: "Host".into(),
                email: String::new(),
                email_verified: false,
                organization_ids: vec![],
            },
            host_id,
            organization_id,
            links: BTreeMap::new(),
            guests: HashMap::new(),
            leases: BTreeMap::new(),
            tab_epochs: HashMap::new(),
            shell_tabs: BTreeMap::new(),
            queue: VecDeque::new(),
            notes: VecDeque::new(),
            activity: VecDeque::new(),
        }
    }

    pub fn record(&mut self, actor: &str, action: &str, detail: Value, now: i64) {
        let event = json!({ "id": Uuid::now_v7(), "userId": actor, "action": action, "detail": detail, "createdAt": now });
        if !self.session_id.is_empty() {
            let persist = || -> Result<()> {
                let path =
                    crate::store::session_dir(&self.session_id)?.join("share-activity.jsonl");
                crate::store::append_line(&path, &serde_json::to_string(&event)?)
            };
            if let Err(error) = persist() {
                log::warn!("Could not record session sharing activity: {error}");
            }
        }
        self.activity.push_back(event);
        while self.activity.len() > 1000 {
            self.activity.pop_front();
        }
    }

    pub fn join(&mut self, mut guest: Guest, now: i64) -> Result<bool> {
        let link = self
            .links
            .get_mut(&guest.link_id)
            .ok_or_else(|| anyhow!("This link is no longer active."))?;
        if link.revoked
            || link.settings.expires_at <= now
            || link.blocked.contains(&guest.person.user_id)
            || link.settings.single_use && link.used_by.is_some()
        {
            bail!("This link is no longer active.");
        }
        // Restriction precedes approval: outsiders never appear as requests.
        let role = link
            .settings
            .role_for(&guest.person, &self.organization_id)
            .ok_or_else(|| anyhow!("Your account does not have access to this link."))?;
        if self.guests.len() >= MAX_GUESTS * 4 {
            bail!("This session has too many open connections.");
        }
        let people: HashSet<_> = self.guests.values().map(|g| &g.person.user_id).collect();
        let link_people: HashSet<_> = self
            .guests
            .values()
            .filter(|g| g.link_id == guest.link_id)
            .map(|g| &g.person.user_id)
            .collect();
        if !people.contains(&guest.person.user_id) && people.len() >= MAX_GUESTS
            || !link_people.contains(&guest.person.user_id)
                && link_people.len() >= link.settings.maximum_people
        {
            bail!("This session is full.");
        }
        guest.role = role;
        guest.can_approve = link.settings.can_approve;
        guest.admitted =
            !link.settings.approve_each_person || link.approved.contains(&guest.person.user_id);
        guest.active.store(guest.admitted, Ordering::SeqCst);
        let admitted = guest.admitted;
        let user = guest.person.user_id.clone();
        if admitted && link.settings.single_use {
            link.used_by = Some(user.clone());
        }
        self.guests.insert(guest.connection_id.clone(), guest);
        self.record(
            &user,
            if admitted { "joined" } else { "requested" },
            json!({}),
            now,
        );
        Ok(admitted)
    }

    pub fn approve(&mut self, link_id: &str, user: &str, allow: bool, now: i64) -> Result<()> {
        if !allow {
            return self.remove(link_id, user, now);
        }
        let link = self
            .links
            .get_mut(link_id)
            .ok_or_else(|| anyhow!("Link not found."))?;
        if link.revoked
            || link.settings.expires_at <= now
            || link.blocked.contains(user)
            || link.settings.single_use && link.used_by.as_deref().is_some_and(|id| id != user)
        {
            bail!("This link is no longer active.");
        }
        link.approved.insert(user.into());
        if link.settings.single_use {
            link.used_by = Some(user.into());
        }
        for guest in self
            .guests
            .values_mut()
            .filter(|g| g.link_id == link_id && g.person.user_id == user)
        {
            guest.admitted = true;
            guest.active.store(true, Ordering::SeqCst);
        }
        self.record(
            &self.host_id.clone(),
            "approved",
            json!({ "linkId": link_id, "userId": user }),
            now,
        );
        Ok(())
    }

    pub fn disconnect(&mut self, connection: &str, now: i64) {
        let Some(guest) = self.guests.remove(connection) else {
            return;
        };
        guest.active.store(false, Ordering::SeqCst);
        let _ = guest.cancel.send(());
        self.queue.retain(|input| input.connection_id != connection);
        if !self.guests.values().any(|g| {
            g.admitted && g.role == Role::Driver && g.person.user_id == guest.person.user_id
        }) {
            self.leases
                .retain(|_, lease| lease.holder.user_id != guest.person.user_id);
        }
        self.record(&guest.person.user_id, "left", json!({}), now);
    }

    pub fn remove(&mut self, link_id: &str, user: &str, now: i64) -> Result<()> {
        self.links
            .get_mut(link_id)
            .ok_or_else(|| anyhow!("Link not found."))?
            .blocked
            .insert(user.into());
        let connections: Vec<_> = self
            .guests
            .values()
            .filter(|g| g.link_id == link_id && g.person.user_id == user)
            .map(|g| g.connection_id.clone())
            .collect();
        for id in connections {
            self.disconnect(&id, now);
        }
        self.record(
            &self.host_id.clone(),
            "removed",
            json!({ "linkId": link_id, "userId": user }),
            now,
        );
        Ok(())
    }

    pub fn revoke(&mut self, link_id: &str, remove: bool, now: i64) -> Result<()> {
        self.links
            .get_mut(link_id)
            .ok_or_else(|| anyhow!("Link not found."))?
            .revoked = true;
        if remove {
            let ids: Vec<_> = self
                .guests
                .values()
                .filter(|g| g.link_id == link_id)
                .map(|g| g.connection_id.clone())
                .collect();
            for id in ids {
                self.disconnect(&id, now);
            }
        }
        self.record(
            &self.host_id.clone(),
            "link-revoked",
            json!({ "linkId": link_id, "removeGuests": remove }),
            now,
        );
        Ok(())
    }

    pub fn edit(&mut self, link_id: &str, mut settings: LinkSettings, now: i64) -> Result<()> {
        settings.validate(now)?;
        let link = self
            .links
            .get_mut(link_id)
            .ok_or_else(|| anyhow!("Link not found."))?;
        if link.revoked {
            bail!("This link was revoked.");
        }
        if settings.expires_at > link.credential_expires_at {
            bail!("A link can last at most 24 hours from creation. Choose an earlier expiry.");
        }
        if settings.single_use && link.used_by.is_none() {
            link.used_by = self
                .guests
                .values()
                .filter(|g| g.link_id == link_id && g.admitted)
                .map(|g| g.person.user_id.clone())
                .min();
        }
        link.settings = settings.clone();
        let mut remove = Vec::new();
        let mut demoted = HashSet::new();
        let mut admitted = HashSet::new();
        for guest in self.guests.values_mut().filter(|g| g.link_id == link_id) {
            let Some(role) = settings.role_for(&guest.person, &self.organization_id) else {
                remove.push(guest.connection_id.clone());
                continue;
            };
            if settings.single_use
                && link
                    .used_by
                    .as_deref()
                    .is_some_and(|user| user != guest.person.user_id)
            {
                remove.push(guest.connection_id.clone());
                continue;
            }
            if !admitted.contains(&guest.person.user_id)
                && admitted.len() >= settings.maximum_people
            {
                remove.push(guest.connection_id.clone());
                continue;
            }
            admitted.insert(guest.person.user_id.clone());
            if guest.role == Role::Driver && role == Role::Viewer {
                demoted.insert(guest.person.user_id.clone());
            }
            guest.write_revision += 1;
            guest.role = role;
            guest.can_approve = settings.can_approve;
            if !guest.admitted && !settings.approve_each_person {
                if settings.single_use {
                    link.used_by = Some(guest.person.user_id.clone());
                }
                guest.admitted = true;
                guest.active.store(true, Ordering::SeqCst);
            }
        }
        for id in remove {
            self.disconnect(&id, now);
        }
        self.leases
            .retain(|_, lease| !demoted.contains(&lease.holder.user_id));
        self.queue.retain(|input| {
            self.guests
                .get(&input.connection_id)
                .is_some_and(|g| g.role == Role::Driver)
        });
        self.record(
            &self.host_id.clone(),
            "settings-changed",
            json!({ "linkId": link_id, "settings": settings }),
            now,
        );
        Ok(())
    }

    pub fn admit(
        &mut self,
        connection: &str,
        tab_id: Option<&str>,
        write: bool,
        approve: bool,
        now: i64,
    ) -> Result<Person> {
        self.evaluate(connection, tab_id, write, approve, now, true)
    }

    pub fn write_permit(&self, connection: &str, tab: &str) -> Result<WritePermit> {
        let guest = self
            .guests
            .get(connection)
            .ok_or_else(|| anyhow!("Access ended."))?;
        Ok(WritePermit {
            connection_id: connection.into(),
            revision: guest.write_revision,
            tab_epoch: self.tab_epochs.get(tab).copied().unwrap_or(0),
        })
    }

    pub fn permit_current(&self, permit: &WritePermit, tab: &str, now: i64) -> bool {
        self.guests.get(&permit.connection_id).is_some_and(|g| {
            g.write_revision == permit.revision
                && g.admitted
                && g.role == Role::Driver
                && g.active.load(Ordering::SeqCst)
                && g.verified_until > now
        }) && self.tab_epochs.get(tab).copied().unwrap_or(0) == permit.tab_epoch
    }

    pub fn admit_at_writer(
        &mut self,
        permit: &WritePermit,
        tab_id: &str,
        now: i64,
    ) -> Result<Person> {
        if self
            .guests
            .get(&permit.connection_id)
            .is_none_or(|g| g.write_revision != permit.revision)
            || self.tab_epochs.get(tab_id).copied().unwrap_or(0) != permit.tab_epoch
        {
            bail!("Access changed before prompt delivery.");
        }
        self.evaluate(&permit.connection_id, Some(tab_id), true, false, now, false)
    }

    pub fn refresh_identity(&mut self, connection: &str, person: Person, now: i64) -> Result<()> {
        let guest = self
            .guests
            .get_mut(connection)
            .ok_or_else(|| anyhow!("Access ended."))?;
        if guest.person.user_id != person.user_id {
            bail!("Your account changed. Join again.");
        }
        let link = self
            .links
            .get(&guest.link_id)
            .ok_or_else(|| anyhow!("Access ended."))?;
        let role = link
            .settings
            .role_for(&person, &self.organization_id)
            .ok_or_else(|| anyhow!("Your account no longer has access to this link."))?;
        if role != guest.role {
            guest.write_revision += 1;
            if role == Role::Viewer {
                self.leases
                    .retain(|_, lease| lease.holder.user_id != person.user_id);
                self.queue.retain(|input| input.connection_id != connection);
            }
        }
        guest.person = person;
        guest.role = role;
        guest.verified_until = now + IDENTITY_MS;
        Ok(())
    }

    pub fn cancel_tab_inputs(&mut self, tab: &str) {
        *self.tab_epochs.entry(tab.into()).or_default() += 1;
        self.queue.retain(|input| input.tab_id != tab);
    }

    fn evaluate(
        &mut self,
        connection: &str,
        tab_id: Option<&str>,
        write: bool,
        approve: bool,
        now: i64,
        throttle: bool,
    ) -> Result<Person> {
        let guest = self
            .guests
            .get_mut(connection)
            .ok_or_else(|| anyhow!("Access ended."))?;
        if !guest.admitted || !guest.active.load(Ordering::SeqCst) || guest.verified_until <= now {
            bail!("Sign in again, or wait for the host to admit you.");
        }
        if write && guest.role != Role::Driver {
            bail!("Read only: you cannot drive this session.");
        }
        if approve && !guest.can_approve {
            bail!("Permission decisions stay with the host.");
        }
        if throttle && (write || approve) {
            if now - guest.last_write < 250 {
                bail!("Please wait before sending again.");
            }
            guest.last_write = now;
        }
        let person = guest.person.clone();
        if write {
            if let Some(tab_id) = tab_id {
                if let Some(lease) = self.leases.get(tab_id) {
                    if lease.expires_at > now && lease.holder.user_id != person.user_id {
                        bail!("{} is driving this tab.", lease.holder.display_name);
                    }
                }
                self.leases.insert(
                    tab_id.into(),
                    Lease {
                        tab_id: tab_id.into(),
                        holder: person.clone(),
                        expires_at: now + LEASE_MS,
                    },
                );
            }
        }
        Ok(person)
    }

    pub fn host_takeover(&mut self, tab: &str, now: i64) {
        self.cancel_tab_inputs(tab);
        self.leases.insert(
            tab.into(),
            Lease {
                tab_id: tab.into(),
                holder: self.host.clone(),
                expires_at: now + LEASE_MS,
            },
        );
        self.queue.retain(|input| input.tab_id != tab);
        self.record(
            &self.host_id.clone(),
            "host-takeover",
            json!({ "tabId": tab }),
            now,
        );
    }

    pub fn snapshot(&self, now: i64, host: bool) -> Value {
        let mut people = BTreeMap::<String, Value>::new();
        for guest in self.guests.values() {
            if !host && !guest.admitted {
                continue;
            }
            let entry = people.entry(guest.person.user_id.clone()).or_insert_with(|| json!({
                "person": guest.person, "role": if guest.admitted { guest.role } else { Role::Viewer }, "canApprove": guest.admitted && guest.can_approve,
                "admitted": guest.admitted, "connections": 0, "viewing": [], "typing": false,
                "linkIds": [], "pendingLinkIds": []
            }));
            entry["admitted"] = json!(entry["admitted"] == true || guest.admitted);
            entry["canApprove"] =
                json!(entry["canApprove"] == true || guest.admitted && guest.can_approve);
            if guest.admitted && guest.role == Role::Driver {
                entry["role"] = json!(Role::Driver);
            }
            entry["connections"] = json!(entry["connections"].as_u64().unwrap_or(0) + 1);
            if !guest.admitted
                && !entry["pendingLinkIds"]
                    .as_array()
                    .unwrap()
                    .contains(&json!(guest.link_id))
            {
                entry["pendingLinkIds"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(guest.link_id));
            }
            if guest.typing {
                entry["typing"] = json!(true);
            }
            if let Some(tab) = &guest.viewing {
                entry["viewing"].as_array_mut().unwrap().push(json!(tab));
            }
            if !entry["linkIds"]
                .as_array()
                .unwrap()
                .contains(&json!(guest.link_id))
            {
                entry["linkIds"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!(guest.link_id));
            }
        }
        json!({ "active": true, "links": if host { json!(self.links.values().collect::<Vec<_>>()) } else { Value::Null },
            "people": people.values().collect::<Vec<_>>(), "leases": self.leases.values().filter(|l| l.expires_at > now).collect::<Vec<_>>(),
            "notes": self.notes, "activity": self.activity,
            "queue": self.queue.iter().map(|q| json!({ "tabId": q.tab_id, "text": q.text,
                "author": self.guests.get(&q.connection_id).map(|g| &g.person) })).collect::<Vec<_>>() })
    }
}

pub fn scoped_method(method: &str) -> bool {
    matches!(
        method,
        "session.authenticate"
            | "session.status"
            | "session.tabs.list"
            | "session.tail"
            | "session.send"
            | "session.queue"
            | "session.steer"
            | "session.stop"
            | "presence.heartbeat"
            | "chat.post"
            | "chat.list"
            | "steerLease.release"
            | "terminal.read"
            | "permission.respond"
    )
}

#[cfg(test)]
pub(crate) mod tests;
