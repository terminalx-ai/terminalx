//! Who may do what in a shared cloud workspace (`collab/1`, terminalx-saas
//! contract §21, PRO-30): the people the API says have access and their
//! roles, the per-tab driver lease that serializes competing agent input,
//! and attributed human notes.
//!
//! The API is the source of truth for roles. It lists them on every
//! `/refresh` (`collaboration.members`) and stamps the actor's role on every
//! mailbox lease; this module keeps the latest list and answers from it, so a
//! downgrade or revocation applies to the next call without waiting for the
//! connection to be closed.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::protocol::Authority;

/// A driver lease lapses this long after its holder last sent, unless the
/// tab's turn is still running.
pub const LEASE_IDLE_MS: u64 = 2 * 60 * 1000;
pub const MAX_NOTE_CHARS: usize = 4000;
/// Notes kept per tab, newest last.
const MAX_NOTES: usize = 500;
pub const MAX_MEMBERS: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    #[default]
    None,
    Viewer,
    Driver,
    Manager,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    pub role: Role,
    pub can_approve: bool,
}

impl Access {
    pub const NONE: Self = Self { role: Role::None, can_approve: false };
    pub const MANAGER: Self = Self { role: Role::Manager, can_approve: true };

    pub fn can_view(self) -> bool {
        self.role >= Role::Viewer
    }

    pub fn can_drive(self) -> bool {
        self.role >= Role::Driver
    }

    /// May decide what the agent does on its own: its model, effort and
    /// permission mode, the slash commands that change them, and a shell
    /// (PRO-88). A manager, or a driver who may approve permissions.
    pub fn can_configure(self) -> bool {
        self.role == Role::Manager || (self.can_drive() && self.can_approve)
    }

    /// The narrower of two views of the same person.
    pub fn meet(self, other: Self) -> Self {
        Self { role: self.role.min(other.role), can_approve: self.can_approve && other.can_approve }
    }
}

/// One entry of the refresh's `collaboration.members`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub user_id: String,
    pub role: Role,
    #[serde(default)]
    pub can_approve: bool,
}

/// `collaboration` as the refresh (or a development link file) carries it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Members {
    pub v: u8,
    pub members: Vec<Member>,
}

impl Members {
    /// The map the runtime answers from; `None` for a version it does not
    /// know (fail closed: participants get nothing).
    pub fn into_map(self) -> Option<HashMap<String, Access>> {
        if self.v != 1 || self.members.len() > MAX_MEMBERS {
            return None;
        }
        Some(
            self.members
                .into_iter()
                .filter(|member| member.role != Role::None && !member.user_id.is_empty())
                .map(|member| {
                    // Managers always approve (contract §21.1).
                    let can_approve = member.can_approve || member.role == Role::Manager;
                    (member.user_id, Access { role: member.role, can_approve })
                })
                .collect(),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabLease {
    pub tab_id: String,
    pub holder_id: String,
    pub acquired_at: u64,
    pub expires_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub tab_id: String,
    pub author_id: String,
    pub text: String,
    pub created_at: u64,
}

/// What changed, for the RPC layer to tell connections about.
#[derive(Debug, Clone)]
pub enum Change {
    Lease { tab_id: String, lease: Option<TabLease> },
    Note(Note),
}

/// Why a lease was not granted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseRefusal {
    Held(TabLease),
    Forbidden,
    /// Fair use (review N2): this person's own idle lease on the tab lapsed
    /// or was released moments ago; others get the first chance until then.
    Cooldown { until: u64 },
}

/// People whose access changed in one refresh.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Diff {
    /// Had access (viewer or more) and now have none.
    pub lost: Vec<String>,
    /// Still have access, but a narrower role or no longer approve.
    pub narrowed: Vec<String>,
    /// Any change at all (including widening), for `collab.you`.
    pub changed: Vec<String>,
}

pub struct Collaboration {
    /// `None` until the API has listed the members (an older API never
    /// does): participate attachments then have no access, as before PRO-30.
    members: Mutex<Option<HashMap<String, Access>>>,
    leases: Mutex<HashMap<String, TabLease>>,
    /// By tab: who last released their lease on it, and when (fair use).
    released: Mutex<HashMap<String, (String, u64)>>,
    notes: Mutex<Notes>,
    listener: OnceLock<Box<dyn Fn(Change) + Send + Sync>>,
}

impl Default for Collaboration {
    fn default() -> Self {
        Self::new()
    }
}

impl Collaboration {
    pub fn new() -> Self {
        Self {
            members: Mutex::new(None),
            leases: Mutex::new(HashMap::new()),
            released: Mutex::new(HashMap::new()),
            notes: Mutex::new(Notes::default()),
            listener: OnceLock::new(),
        }
    }

    /// Keep notes under `dir` (0700) instead of only in memory.
    pub fn store_notes_in(&self, dir: &Path) {
        if let Err(error) = crate::cloud_bootstrap::ensure_private_dir(dir) {
            log::warn!("notes stay in memory: {error:#}");
            return;
        }
        self.notes.lock().unwrap().dir = Some(dir.to_path_buf());
    }

    pub fn listen(&self, listener: Box<dyn Fn(Change) + Send + Sync>) {
        let _ = self.listener.set(listener);
    }

    fn emit(&self, change: Change) {
        if let Some(listener) = self.listener.get() {
            listener(change);
        }
    }

    /// Replace the member list; returns who lost or narrowed access.
    pub fn set_members(&self, next: HashMap<String, Access>) -> Diff {
        let mut members = self.members.lock().unwrap();
        let previous = members.clone().unwrap_or_default();
        let mut diff = Diff::default();
        let mut people: Vec<&String> = previous.keys().chain(next.keys()).collect();
        people.sort();
        people.dedup();
        for user in people {
            let before = previous.get(user).copied().unwrap_or(Access::NONE);
            let after = next.get(user).copied().unwrap_or(Access::NONE);
            if before == after {
                continue;
            }
            diff.changed.push(user.clone());
            if before.can_view() && !after.can_view() {
                diff.lost.push(user.clone());
            } else if after.role < before.role || (before.can_approve && !after.can_approve) {
                diff.narrowed.push(user.clone());
            }
        }
        *members = Some(next);
        drop(members);
        for user in diff.lost.iter().chain(&diff.narrowed) {
            if !self.access_of(Some(user)).can_drive() {
                self.release_all(user);
            }
        }
        diff
    }

    /// Whether the API has said who has access.
    pub fn known(&self) -> bool {
        self.members.lock().unwrap().is_some()
    }

    /// A person's access by the latest list.
    pub fn access_of(&self, user_id: Option<&str>) -> Access {
        let Some(user_id) = user_id else { return Access::NONE };
        self.members.lock().unwrap().as_ref().and_then(|members| members.get(user_id).copied()).unwrap_or(Access::NONE)
    }

    /// A connection's access: a `participate` attachment has the person's
    /// role. A `manage` attachment (an organization admin's desktop) manages
    /// only while the list still says its person is a manager: an admin
    /// demoted since has the role the list gives them now. Before the API has
    /// listed anyone, `manage` keeps its pre-PRO-30 meaning; after, a
    /// `manage` attachment without a person has no access (review N1).
    pub fn access_for(&self, authority: Authority, user_id: Option<&str>) -> Access {
        match (authority, user_id) {
            (Authority::Manage, Some(user)) if self.known() => match self.access_of(Some(user)) {
                access if access.role == Role::Manager => Access::MANAGER,
                access => access,
            },
            // A manage attachment saved before attachments named their person
            // (an older device record): once the API has listed who has
            // access, nobody can be matched to it, so it gets nothing.
            (Authority::Manage, None) if self.known() => Access::NONE,
            (Authority::Manage, _) => Access::MANAGER,
            (Authority::Participate, user) => self.access_of(user),
        }
    }

    /// A mailbox actor's access: the role the API stamped at lease time,
    /// narrowed by the runtime's latest list once it has one (whichever was
    /// revoked first wins). An API that stamps no role gives `manage`
    /// actors management and everyone else nothing, as before PRO-30.
    pub fn actor_access(&self, authority: &str, user_id: &str, stamped: Option<Access>) -> Access {
        let stamped = stamped.unwrap_or(if authority == "manage" { Access::MANAGER } else { Access::NONE });
        if !self.known() {
            return stamped;
        }
        // A manage attachment's person is listed as a manager; one the list
        // no longer has lost access.
        stamped.meet(self.access_of(Some(user_id)))
    }

    /// Live leases. `busy` is asked with no lock held: it may read the
    /// tabs, which read the leases.
    pub fn leases(&self, now: u64, busy: &dyn Fn(&str) -> bool) -> Vec<TabLease> {
        let all: Vec<TabLease> = self.leases.lock().unwrap().values().cloned().collect();
        let mut leases: Vec<TabLease> = all.into_iter().filter(|lease| lease.expires_at > now || busy(&lease.tab_id)).collect();
        leases.sort_by(|a, b| a.tab_id.cmp(&b.tab_id));
        leases
    }

    pub fn lease(&self, tab_id: &str, now: u64, busy: bool) -> Option<TabLease> {
        self.leases.lock().unwrap().get(tab_id).filter(|lease| busy || lease.expires_at > now).cloned()
    }

    /// Whether someone other than `user` holds a live lease on the tab.
    pub fn held_by_other(&self, tab_id: &str, user_id: &str, now: u64, busy: bool) -> Option<TabLease> {
        self.lease(tab_id, now, busy).filter(|lease| lease.holder_id != user_id)
    }

    /// Take or extend the tab's lease for `user`. Another person's live
    /// lease is refused unless `take_over`.
    pub fn claim(&self, tab_id: &str, user_id: &str, now: u64, busy: bool, take_over: bool) -> Result<TabLease, LeaseRefusal> {
        let mut leases = self.leases.lock().unwrap();
        let current = leases.get(tab_id).filter(|lease| busy || lease.expires_at > now).cloned();
        let lease = match current {
            Some(lease) if lease.holder_id != user_id && !take_over => return Err(LeaseRefusal::Held(lease)),
            Some(lease) if lease.holder_id == user_id => TabLease { expires_at: now + LEASE_IDLE_MS, ..lease },
            _ => TabLease { tab_id: tab_id.to_string(), holder_id: user_id.to_string(), acquired_at: now, expires_at: now + LEASE_IDLE_MS },
        };
        // An extension is announced too: clients show the expiry.
        let changed = leases.get(tab_id) != Some(&lease);
        leases.insert(tab_id.to_string(), lease.clone());
        drop(leases);
        if changed {
            self.emit(Change::Lease { tab_id: tab_id.to_string(), lease: Some(lease.clone()) });
        }
        Ok(lease)
    }

    /// `lease.acquire` (no input with it), with the fair-use rule (review
    /// N2): taking the wheel only holds an idle tab for [`LEASE_IDLE_MS`].
    /// Asking again while holding it does not extend it (only input the
    /// agent receives does), and after one's own idle lease lapsed or was
    /// released, the same person waits another [`LEASE_IDLE_MS`] before
    /// taking that tab again, so a driver cannot keep every tab to
    /// themselves by re-acquiring. A running turn is not idle.
    pub fn acquire_idle(&self, tab_id: &str, user_id: &str, now: u64, busy: bool) -> Result<TabLease, LeaseRefusal> {
        if !busy {
            let leases = self.leases.lock().unwrap();
            if let Some(lease) = leases.get(tab_id).filter(|lease| lease.holder_id == user_id) {
                if lease.expires_at > now {
                    return Ok(lease.clone());
                }
                let until = lease.expires_at + LEASE_IDLE_MS;
                if now < until {
                    return Err(LeaseRefusal::Cooldown { until });
                }
            }
            drop(leases);
            if let Some((holder, at)) = self.released.lock().unwrap().get(tab_id) {
                let until = at + LEASE_IDLE_MS;
                if holder == user_id && now < until {
                    return Err(LeaseRefusal::Cooldown { until });
                }
            }
        }
        self.claim(tab_id, user_id, now, busy, false)
    }

    /// Release the tab's lease if `user` holds it (or `force`).
    pub fn release(&self, tab_id: &str, user_id: &str, force: bool) -> bool {
        let mut leases = self.leases.lock().unwrap();
        if !leases.get(tab_id).is_some_and(|lease| force || lease.holder_id == user_id) {
            return false;
        }
        if let Some(lease) = leases.remove(tab_id) {
            self.released.lock().unwrap().insert(tab_id.to_string(), (lease.holder_id, crate::cloud_agents::now_ms()));
        }
        drop(leases);
        self.emit(Change::Lease { tab_id: tab_id.to_string(), lease: None });
        true
    }

    fn release_all(&self, user_id: &str) {
        let held: Vec<String> =
            self.leases.lock().unwrap().values().filter(|lease| lease.holder_id == user_id).map(|lease| lease.tab_id.clone()).collect();
        for tab_id in held {
            self.release(&tab_id, user_id, false);
        }
    }

    /// The holder's turn ended: the lease lapses after the idle period,
    /// counted from now. Announced, so clients show the new expiry.
    pub fn turn_settled(&self, tab_id: &str, now: u64) {
        let extended = {
            let mut leases = self.leases.lock().unwrap();
            match leases.get_mut(tab_id) {
                Some(lease) if lease.expires_at < now + LEASE_IDLE_MS => {
                    lease.expires_at = now + LEASE_IDLE_MS;
                    Some(lease.clone())
                }
                _ => None,
            }
        };
        if let Some(lease) = extended {
            self.emit(Change::Lease { tab_id: tab_id.to_string(), lease: Some(lease) });
        }
    }

    pub fn notes(&self, tab_id: &str, before_id: Option<&str>, limit: usize) -> (Vec<Note>, bool) {
        let mut notes = self.notes.lock().unwrap();
        let all = notes.load(tab_id);
        let end = match before_id {
            Some(before) => all.iter().position(|note| note.id == before).unwrap_or(all.len()),
            None => all.len(),
        };
        let start = end.saturating_sub(limit);
        (all[start..end].to_vec(), start > 0)
    }

    pub fn post_note(&self, tab_id: &str, author_id: &str, text: &str, now: u64) -> Result<Note> {
        let note = Note {
            id: format!("note_{}", uuid::Uuid::new_v4().simple()),
            tab_id: tab_id.to_string(),
            author_id: author_id.to_string(),
            text: text.to_string(),
            created_at: now,
        };
        self.notes.lock().unwrap().append(&note)?;
        self.emit(Change::Note(note.clone()));
        Ok(note)
    }

    /// A closed tab's notes go with it.
    pub fn forget_tab(&self, tab_id: &str) {
        self.notes.lock().unwrap().remove(tab_id);
        if self.leases.lock().unwrap().remove(tab_id).is_some() {
            self.emit(Change::Lease { tab_id: tab_id.to_string(), lease: None });
        }
    }
}

/// Notes per tab: JSON Lines under the state directory (owner-only), or
/// memory when there is none. Loaded lazily and trimmed to the newest
/// [`MAX_NOTES`].
#[derive(Default)]
struct Notes {
    dir: Option<PathBuf>,
    tabs: BTreeMap<String, Vec<Note>>,
}

impl Notes {
    fn path(&self, tab_id: &str) -> Option<PathBuf> {
        // Tab ids are validated by the caller; hash anyway so no id can name
        // a path.
        use sha2::{Digest, Sha256};
        let name: String = Sha256::digest(tab_id.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
        self.dir.as_ref().map(|dir| dir.join(format!("{name}.jsonl")))
    }

    fn load(&mut self, tab_id: &str) -> &Vec<Note> {
        if !self.tabs.contains_key(tab_id) {
            let notes = self
                .path(tab_id)
                .and_then(|path| fs::read_to_string(path).ok())
                .map(|text| {
                    text.lines().filter_map(|line| serde_json::from_str::<Note>(line).ok()).filter(|note| note.tab_id == tab_id).collect::<Vec<_>>()
                })
                .unwrap_or_default();
            self.tabs.insert(tab_id.to_string(), notes);
        }
        let notes = self.tabs.get_mut(tab_id).unwrap();
        if notes.len() > MAX_NOTES {
            let excess = notes.len() - MAX_NOTES;
            notes.drain(..excess);
        }
        notes
    }

    fn append(&mut self, note: &Note) -> Result<()> {
        self.load(&note.tab_id);
        let path = self.path(&note.tab_id);
        let notes = self.tabs.get_mut(&note.tab_id).unwrap();
        notes.push(note.clone());
        let Some(path) = path else { return Ok(()) };
        if notes.len() > MAX_NOTES {
            let excess = notes.len() - MAX_NOTES;
            notes.drain(..excess);
            let body: String = notes.iter().map(|note| format!("{}\n", serde_json::to_string(note).unwrap_or_default())).collect();
            return crate::cloud_bootstrap::write_durable(&path, body.as_bytes());
        }
        let mut options = fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).with_context(|| format!("open {}", path.display()))?;
        file.write_all(format!("{}\n", serde_json::to_string(note)?).as_bytes())?;
        file.sync_data()?;
        Ok(())
    }

    fn remove(&mut self, tab_id: &str) {
        self.tabs.remove(tab_id);
        if let Some(path) = self.path(tab_id) {
            let _ = fs::remove_file(path);
        }
    }
}

/// Parse a stamped mailbox actor's `role`/`canApprove` (absent from an API
/// before PRO-30).
pub fn stamped_access(role: Option<&str>, can_approve: Option<bool>) -> Option<Access> {
    let role = serde_json::from_value::<Role>(Value::String(role?.to_string())).ok()?;
    Some(Access { role, can_approve: can_approve.unwrap_or(false) || role == Role::Manager })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(entries: &[(&str, Role, bool)]) -> HashMap<String, Access> {
        entries.iter().map(|(user, role, can_approve)| (user.to_string(), Access { role: *role, can_approve: *can_approve })).collect()
    }

    #[test]
    fn a_demoted_admin_is_no_longer_a_manager() {
        let collab = Collaboration::new();
        collab.set_members(map(&[("admin", Role::Manager, true), ("creator", Role::Driver, true)]));
        assert_eq!(collab.access_for(Authority::Manage, Some("admin")), Access::MANAGER);
        // Demoted to member: not listed (or listed as the creator's driver).
        collab.set_members(map(&[("creator", Role::Driver, true)]));
        assert_eq!(collab.access_for(Authority::Manage, Some("admin")), Access::NONE);
        assert_eq!(collab.access_for(Authority::Manage, Some("creator")), Access { role: Role::Driver, can_approve: true });
    }

    #[test]
    fn unknown_members_give_participants_nothing() {
        let collab = Collaboration::new();
        assert_eq!(collab.access_for(Authority::Participate, Some("u1")), Access::NONE);
        assert_eq!(collab.access_for(Authority::Manage, Some("u1")), Access::MANAGER);
        // An API before PRO-30 stamps no role: authority decides.
        assert_eq!(collab.actor_access("manage", "u1", None), Access::MANAGER);
        assert_eq!(collab.actor_access("participate", "u1", None), Access::NONE);
    }

    #[test]
    fn members_parse_and_managers_always_approve() {
        let members: Members = serde_json::from_value(serde_json::json!({ "v": 1, "members": [
            { "userId": "a", "role": "manager", "canApprove": false },
            { "userId": "b", "role": "viewer", "canApprove": true },
            { "userId": "c", "role": "none" },
        ] }))
        .unwrap();
        let map = members.into_map().unwrap();
        assert_eq!(map["a"], Access::MANAGER);
        assert_eq!(map["b"], Access { role: Role::Viewer, can_approve: true });
        assert!(!map.contains_key("c"));
        let future: Members = serde_json::from_value(serde_json::json!({ "v": 2, "members": [] })).unwrap();
        assert!(future.into_map().is_none());
    }

    #[test]
    fn a_diff_names_who_lost_or_narrowed_access() {
        let collab = Collaboration::new();
        collab.set_members(map(&[("a", Role::Driver, true), ("b", Role::Driver, false), ("c", Role::Viewer, false)]));
        let diff = collab.set_members(map(&[("a", Role::Viewer, true), ("c", Role::Driver, false)]));
        assert_eq!(diff.lost, vec!["b".to_string()]);
        assert_eq!(diff.narrowed, vec!["a".to_string()]);
        assert_eq!(diff.changed, vec!["a".to_string(), "b".to_string(), "c".to_string()]);
    }

    #[test]
    fn the_stamped_role_is_narrowed_by_the_latest_list() {
        let collab = Collaboration::new();
        collab.set_members(map(&[("a", Role::Viewer, false)]));
        let stamped = Some(Access { role: Role::Driver, can_approve: true });
        assert_eq!(collab.actor_access("participate", "a", stamped), Access { role: Role::Viewer, can_approve: false });
        assert_eq!(collab.actor_access("participate", "gone", stamped), Access::NONE);
    }

    #[test]
    fn one_person_drives_a_tab_at_a_time() {
        let collab = Collaboration::new();
        let changes = std::sync::Arc::new(Mutex::new(Vec::new()));
        let seen = changes.clone();
        collab.listen(Box::new(move |change| seen.lock().unwrap().push(format!("{change:?}"))));
        let first = collab.claim("t", "a", 1000, false, false).unwrap();
        assert_eq!(first.expires_at, 1000 + LEASE_IDLE_MS);
        assert_eq!(collab.claim("t", "b", 2000, false, false), Err(LeaseRefusal::Held(first.clone())));
        // An extension is announced (clients show the expiry); the same
        // claim again is not.
        collab.claim("t", "a", 3000, false, false).unwrap();
        collab.claim("t", "a", 3000, false, false).unwrap();
        assert_eq!(changes.lock().unwrap().len(), 2);
        // A running turn keeps the lease past its idle expiry.
        let late = 3000 + LEASE_IDLE_MS + 1;
        assert!(collab.claim("t", "b", late, true, false).is_err());
        assert_eq!(collab.claim("t", "b", late, false, false).unwrap().holder_id, "b");
        assert_eq!(collab.claim("t", "a", late, false, true).unwrap().holder_id, "a");
        assert!(!collab.release("t", "b", false));
        assert!(collab.release("t", "a", false));
        assert!(collab.lease("t", late, false).is_none());
    }

    #[test]
    fn losing_the_driver_role_releases_leases() {
        let collab = Collaboration::new();
        collab.set_members(map(&[("a", Role::Driver, false)]));
        collab.claim("t", "a", 1, false, false).unwrap();
        collab.set_members(map(&[("a", Role::Viewer, false)]));
        assert!(collab.lease("t", 1, true).is_none());
    }

    #[test]
    fn notes_persist_owner_only_and_page_backwards() {
        let dir = tempfile::tempdir().unwrap();
        let collab = Collaboration::new();
        collab.store_notes_in(&dir.path().join("notes"));
        let ids: Vec<String> = (0..5).map(|n| collab.post_note("t", "a", &format!("n{n}"), n).unwrap().id).collect();
        let reopened = Collaboration::new();
        reopened.store_notes_in(&dir.path().join("notes"));
        let (page, more) = reopened.notes("t", None, 2);
        assert_eq!(page.iter().map(|note| note.text.as_str()).collect::<Vec<_>>(), ["n3", "n4"]);
        assert!(more);
        let (page, more) = reopened.notes("t", Some(&ids[3]), 10);
        assert_eq!(page.len(), 3);
        assert!(!more);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file = fs::read_dir(dir.path().join("notes")).unwrap().next().unwrap().unwrap().path();
            assert_eq!(fs::metadata(file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        reopened.forget_tab("t");
        assert!(reopened.notes("t", None, 10).0.is_empty());
    }

    /// Review N2: taking the wheel of idle tabs over and over is limited.
    #[test]
    fn an_idle_lease_is_not_kept_by_asking_again_and_lapses_to_others_first() {
        let collab = Collaboration::new();
        let first = collab.acquire_idle("t", "a", 1_000, false).unwrap();
        // Asking again while holding it does not extend it.
        assert_eq!(collab.acquire_idle("t", "a", 60_000, false).unwrap().expires_at, first.expires_at);
        // It lapsed: for one more lease period the same person cannot take it
        // back, and anyone else can.
        let lapsed = first.expires_at + 1;
        assert_eq!(collab.acquire_idle("t", "a", lapsed, false), Err(LeaseRefusal::Cooldown { until: first.expires_at + LEASE_IDLE_MS }));
        assert_eq!(collab.acquire_idle("t", "b", lapsed, false).unwrap().holder_id, "b");
        // After the cool-down, "a" may take a free tab again.
        let other = collab.acquire_idle("u", "a", 1_000, false).unwrap();
        assert!(collab.acquire_idle("u", "a", other.expires_at + LEASE_IDLE_MS, false).is_ok());
        // A running turn is not idle: the holder keeps it while it runs.
        assert!(collab.acquire_idle("u", "a", other.expires_at + 3 * LEASE_IDLE_MS, true).is_ok());
    }

    #[test]
    fn releasing_and_taking_the_wheel_again_waits_one_lease_period() {
        let collab = Collaboration::new();
        let now = crate::cloud_agents::now_ms();
        collab.acquire_idle("t", "a", now, false).unwrap();
        assert!(collab.release("t", "a", false));
        assert!(matches!(collab.acquire_idle("t", "a", now + 1, false), Err(LeaseRefusal::Cooldown { .. })));
        assert_eq!(collab.acquire_idle("t", "b", now + 1, false).unwrap().holder_id, "b");
        assert!(collab.release("t", "b", false));
        assert!(collab.acquire_idle("t", "a", now + LEASE_IDLE_MS + 5_000, false).is_ok());
    }
}
